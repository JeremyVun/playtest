// Review queue (docs/contracts/hosted.md#bundles-viewer-and-review): pending changed
// journeys, accept/reject with core baseline-review semantics
// (docs/contracts/interfaces.md#baseline-review-and-grading) ported verbatim to
// bundle + DB state, and baseline version history. Kept out of viewer-adapter.js
// deliberately: the adapter is strictly read-only (like core view-server), while
// accept/reject mutate baselines.
//
// "An agent never accepts its own change" is enforced here structurally: only
// these reviewer-role handlers write candidate resolutions; the group executor
// only ever reports candidates.
import path from "node:path";
import { HttpResult, readJsonBody } from "../http.ts";
import { AppError, badRequest, conflict, notFound } from "../errors.ts";
import { audit, actorOf } from "../audit.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { ulid } from "../ulid.ts";
import { requireAuth, guard, getProjectByKey, getSuite, parsePagination } from "./util.ts";
import { loadRunBundle } from "./viewer-adapter.ts";
import { actionTrack, diffTracks, actionOf, BundleProvider, exportSpec } from "../../../../core/public/artifacts.ts";
import { resolveCases, resolveCaseByStory } from "../suites/resolve.ts";

/**
 * GET /projects/:p/candidates?status=pending — the review queue. Each item is
 * the candidate + its run's context + the core diffTracks summary (baseline vs
 * healed action track, read from the candidate run's own sealed bundle — the
 * same pair the viewer's diff tab renders).
 */
export async function listCandidates(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { limit } = parsePagination(ctx.query);
  const params = [project.id];
  let where = `WHERE c.project_id = $1`;
  if (ctx.query.get("status")) {
    params.push(ctx.query.get("status"));
    where += ` AND c.status = $${params.length}`;
  }
  // ?run_id= scopes to one platform run — the run page derives its pending
  // banner AND its sign-off receipt (who resolved, when) from these rows.
  if (ctx.query.get("run_id")) {
    params.push(ctx.query.get("run_id"));
    where += ` AND c.run_id = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await ctx.db.query(
    `SELECT c.*, r.run_id AS core_run_id, r.case_id, r.score, r.started_at, r.duration_ms,
            r.run_group_id, json_extract(r.manifest, '$.case.story') AS story, s.slug AS suite_slug,
            u.name AS resolved_by_name
       FROM candidates c
       JOIN runs r ON r.id = c.run_id
       JOIN suites s ON s.id = c.suite_id
       LEFT JOIN users u ON u.id = c.resolved_by
      ${where}
      ORDER BY c.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const items: HostedDynamic[] = [];
  for (const row of rows) {
    // The diff summary (the queue's "7 same · 1 removed · 2 added" line) is
    // persisted on the row at creation (migration 0004); only legacy pending
    // rows fall back to a live compute from the candidate's own bundle.
    // Resolved rows render dimmed without one — no bundle reads for history.
    let summary = row.diff_summary ?? null;
    if (!summary && row.status === "pending") summary = (await candidateDiff(ctx, row))?.summary ?? null;
    items.push(candidateView(row, summary ? { diff_summary: summary } : {}));
  }
  return { items };
}

/** GET /candidates/:c — one candidate with the full diff ops for inline review. */
export async function getCandidate(ctx: HostedDynamic) {
  const row = await candidateById(ctx, ctx.params.c);
  guard(ctx, row.project_id, "viewer");
  const diff = await candidateDiff(ctx, row);
  return candidateView(row, {
    diff_summary: row.diff_summary ?? diff?.summary ?? null,
    // Light projection of the ops — enough for the review queue's inline
    // "what changed" rows; the full-fidelity diff is the viewer's diff tab.
    diff_ops: diff?.ops.map((o) => ({ op: o.op, a: opStep(o.a), b: opStep(o.b) })) ?? null,
    heal: await healRationale(ctx, row),
  });
}

/**
 * Why the heal was judged safe: the replay step that broke (with its error),
 * and the agent's first healing step with its stated reasoning — read from the
 * candidate run's own sealed bundle. Reviewers kept asking the queue "why is
 * this change OK?" and had to reconstruct it from the raw diff.
 */
async function healRationale(ctx: HostedDynamic, row: HostedDynamic) {
  try {
    const bundle = await loadRunBundle(ctx, row.run_id);
    if (!bundle) return null;
    const trajText = bundle.provider.readText("trajectory.jsonl");
    if (trajText === null) return null;
    const baseText = bundle.provider.readText("baseline.jsonl");
    const steps = parseJsonl(trajText);
    const baseline = baseText === null ? [] : parseJsonl(baseText);
    const baseByStep = new Map(baseline.map((e) => [e.step, e]));
    const failIdx = steps.findIndex((e) => e.mode === "act" && e.result?.ok === false);
    if (failIdx < 0) return null;
    const failed = steps[failIdx];
    const healStep = steps.slice(failIdx + 1).find((e) => e.mode === "agent");
    const baseEnv = failed.acted_from != null ? baseByStep.get(failed.acted_from) : null;
    return {
      failed_step: failed.step ?? null,
      error: failed.result?.error ?? null,
      old: opStep(baseEnv),
      new: opStep(healStep),
      thought: healStep?.agent?.thought ?? null,
    };
  } catch {
    return null; // a lost/pruned bundle degrades the rationale, never the queue
  }
}

/**
 * POST /candidates/:c/accept {note?} [reviewer] — core baseline accept, checked in
 * the same order, against bundle + DB state: manifest exists → trajectory
 * exists → run passed → the story still exists in the suite → the candidate is
 * still pending. Accept promotes the candidate to the next baseline version,
 * supersedes the previous baseline AND any other pending candidates for the
 * story (concurrent accepts resolve as a supersede, never a double-promote).
 */
export async function acceptCandidate(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const row = await candidateById(ctx, ctx.params.c);
  guard(ctx, row.project_id, "reviewer");
  const body = await readJsonBody(ctx.req);
  const note = body.note ?? null;

  // Safety checks (core cli.ts acceptRun order), each refusing with a message
  // that names what is missing — never a bare 500.
  const run = await runFor(ctx, row.run_id);
  const bundle = await loadRunBundle(ctx, row.run_id);
  if (!run.manifest || !bundle || bundle.provider.stat("manifest.json") === null) {
    throw badRequest(`refusing to accept: run "${run.run_id}" has no manifest (bundle missing or incomplete)`);
  }
  if (bundle.provider.stat("trajectory.jsonl") === null) {
    throw badRequest(`refusing to accept: run "${run.run_id}" has no trajectory.jsonl in its bundle`);
  }
  const result = run.manifest.result ?? {};
  if (result.status !== "pass") {
    throw badRequest(
      `refusing to accept: run "${run.run_id}" did not pass ` +
        `(status ${result.status ?? "unknown"}${result.end_reason ? `, end_reason ${result.end_reason}` : ""})`,
    );
  }
  await requireStoryStillExists(ctx, row);

  let accepted: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    // `BEGIN IMMEDIATE` holds the write lock for the whole body, so this read is
    // already serialized against other reviewers; the resolving UPDATE below
    // re-asserts `status = 'pending'` so exactly one accept can ever promote.
    const current = await tx.query(`SELECT * FROM candidates WHERE id = $1`, [row.id]);
    const c = current.rows[0];
    if (!c || c.status !== "pending") await refuseResolved(tx, row.id);

    // Promote: candidate meta is the healed .healed.json verbatim; dropping the
    // `candidate` flag is exactly core promoteHealed.
    const meta: HostedDynamic = { ...c.meta };
    delete meta.candidate;
    const version = (
      await tx.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM baselines WHERE suite_id = $1 AND story_id = $2`,
        [c.suite_id, c.story_id],
      )
    ).rows[0].v;
    const baselineId = ulid();
    await tx.query(
      `INSERT INTO baselines
         (id, project_id, suite_id, story_id, version, trajectory_key, meta, accepted_by, accepted_from_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        baselineId,
        c.project_id,
        c.suite_id,
        c.story_id,
        version,
        c.trajectory_key,
        meta,
        principal.kind === "user" ? principal.userId : null,
        c.run_id,
      ],
    );
    await tx.query(
      `UPDATE baselines SET superseded_by = $3, updated_at = now()
        WHERE suite_id = $1 AND story_id = $2 AND superseded_by IS NULL AND id <> $3`,
      [c.suite_id, c.story_id, baselineId],
    );
    const resolved = await tx.query(
      `UPDATE candidates
          SET status = 'accepted', resolved_by = $2, resolved_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [c.id, principal.kind === "user" ? principal.userId : null],
    );
    if (resolved.rowCount === 0) await refuseResolved(tx, c.id);
    // Other pending candidates for the story are now stale history, exactly like
    // the CLI's supersede note when accepting over an older pending candidate.
    await tx.query(
      `UPDATE candidates
          SET status = 'superseded', resolved_at = now(), updated_at = now()
        WHERE suite_id = $1 AND story_id = $2 AND status = 'pending' AND id <> $3`,
      [c.suite_id, c.story_id, c.id],
    );
    await audit(tx, {
      actor: actorOf(principal),
      action: "candidate.accepted",
      entityType: "candidate",
      entityId: c.id,
      projectId: c.project_id,
      detail: { story_id: c.story_id, baseline_id: baselineId, version, note },
    });
    await emitPlatformEvent(tx, {
      projectId: c.project_id,
      type: "candidate.accepted",
      entity: { candidate_id: c.id, story_id: c.story_id },
      payload: { candidate: { id: c.id, story_id: c.story_id, run_id: c.run_id }, baseline_id: baselineId, version, actor: actorOf(principal) },
    });
    accepted = { candidate_id: c.id, baseline_id: baselineId, version };
  });
  return accepted;
}

/** POST /candidates/:c/reject {note?} [reviewer] — flips status only (core reject). */
export async function rejectCandidate(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const row = await candidateById(ctx, ctx.params.c);
  guard(ctx, row.project_id, "reviewer");
  const body = await readJsonBody(ctx.req);
  let rejected: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const current = await tx.query(`SELECT * FROM candidates WHERE id = $1`, [row.id]);
    const c = current.rows[0];
    if (!c || c.status !== "pending") await refuseResolved(tx, row.id);
    const resolved = await tx.query(
      `UPDATE candidates
          SET status = 'rejected', resolved_by = $2, resolved_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [c.id, principal.kind === "user" ? principal.userId : null],
    );
    if (resolved.rowCount === 0) await refuseResolved(tx, c.id);
    await audit(tx, {
      actor: actorOf(principal),
      action: "candidate.rejected",
      entityType: "candidate",
      entityId: c.id,
      projectId: c.project_id,
      detail: { story_id: c.story_id, note: body.note ?? null },
    });
    await emitPlatformEvent(tx, {
      projectId: c.project_id,
      type: "candidate.rejected",
      entity: { candidate_id: c.id, story_id: c.story_id },
      payload: { candidate: { id: c.id, story_id: c.story_id, run_id: c.run_id }, actor: actorOf(principal) },
    });
    rejected = { candidate_id: c.id, status: "rejected" };
  });
  return rejected;
}

// ---------- shared with the executor's candidate.created event ----------

/**
 * diffTracks summary for a healed run's bundle: baseline.jsonl vs
 * trajectory.jsonl action tracks — the exact pair the viewer's diff tab
 * renders. Null when the bundle (or its baseline copy) is unavailable.
 */
export async function diffSummaryForRun(ctx: HostedDynamic, runDbId: HostedDynamic) {
  const bundle = await loadRunBundle(ctx, runDbId);
  if (!bundle) return null;
  const baseText = bundle.provider.readText("baseline.jsonl");
  const trajText = bundle.provider.readText("trajectory.jsonl");
  if (baseText === null || trajText === null) return null;
  return diffTracks(actionTrack(parseJsonl(baseText)), actionTrack(parseJsonl(trajText)));
}

async function candidateDiff(ctx: HostedDynamic, row: HostedDynamic) {
  try {
    return await diffSummaryForRun(ctx, row.run_id);
  } catch {
    return null; // a lost/pruned bundle degrades the summary, never the queue
  }
}

// ---------- helpers ----------

function candidateView(row: HostedDynamic, extra = {}) {
  return {
    id: row.id,
    project_id: row.project_id,
    suite_id: row.suite_id,
    suite_slug: row.suite_slug,
    story_id: row.story_id,
    run_id: row.run_id,
    run_group_id: row.run_group_id ?? null,
    core_run_id: row.core_run_id,
    case_id: row.case_id,
    story: row.story ?? null,
    status: row.status,
    score: row.score ?? null,
    started_at: row.started_at ?? null,
    resolved_by: row.resolved_by ?? null,
    resolved_by_name: row.resolved_by_name ?? null,
    resolved_at: row.resolved_at ?? null,
    created_at: row.created_at,
    meta: row.meta,
    ...extra,
  };
}

/** The compact step shape the review UI renders diff rows from. */
function opStep(env: HostedDynamic) {
  if (!env) return null;
  const a = actionOf(env);
  return {
    step: env.step ?? null,
    type: a?.type ?? null,
    locator: env.resolution?.locator ?? null,
    url: a?.url ?? null,
    text: a?.text ?? a?.value ?? null,
  };
}

/**
 * The loser of a resolution race. Called both from the pre-read and when the
 * conditional `status = 'pending'` UPDATE affects no row — a concurrent
 * reviewer got here first, so surface who/what, not an error page (UX: "a
 * concurrent resolution shows the supersede note"). Always throws.
 */
async function refuseResolved(tx: HostedDynamic, candidateId: HostedDynamic) {
  const c = (await tx.query(`SELECT status, resolved_by, resolved_at FROM candidates WHERE id = $1`, [candidateId])).rows[0];
  throw conflict(`this changed journey was already ${c?.status ?? "resolved"}`, {
    status: c?.status ?? null,
    resolved_by: c?.resolved_by ?? null,
    resolved_at: c?.resolved_at ?? null,
  });
}

async function candidateById(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT c.*, r.run_id AS core_run_id, r.case_id, r.score, r.started_at,
            r.run_group_id, json_extract(r.manifest, '$.case.story') AS story, s.slug AS suite_slug,
            u.name AS resolved_by_name
       FROM candidates c
       JOIN runs r ON r.id = c.run_id
       JOIN suites s ON s.id = c.suite_id
       LEFT JOIN users u ON u.id = c.resolved_by
      WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound(`no candidate "${id}"`);
  return rows[0];
}

async function runFor(ctx: HostedDynamic, runDbId: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM runs WHERE id = $1`, [runDbId]);
  if (!rows[0]) throw notFound(`no run "${runDbId}"`);
  return rows[0];
}

/**
 * Core accept's "the case file still exists on disk", hosted: the suite's
 * current working files must still resolve a case for this story. Guards
 * against accepting a baseline for a story that was deleted since the run.
 */
async function requireStoryStillExists(ctx: HostedDynamic, candidate: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT path, content FROM suite_files WHERE suite_id = $1`, [
    candidate.suite_id,
  ]);
  const files = Object.fromEntries(rows.map((f: HostedDynamic) => [f.path, f.content]));
  let cases;
  try {
    cases = await resolveCases(files);
  } catch (e: HostedDynamic) {
    throw new AppError("conflict", `refusing to accept: the suite no longer validates (${e.message})`, { status: 409 });
  }
  if (!cases.some((c) => (c.story_id || c.id) === candidate.story_id)) {
    throw badRequest(
      `refusing to accept: story "${candidate.story_id}" no longer exists in suite "${candidate.suite_slug ?? candidate.suite_id}"`,
    );
  }
}

function parseJsonl(text: HostedDynamic) {
  const out: HostedDynamic[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

// ---------- one-way Playwright export ----------

/**
 * GET /suites/:s/playwright-export?story=<story_id> — the story's ACCEPTED
 * baseline rendered as a standalone @playwright/test spec, as a download.
 *
 * The same pure core generator the CLI uses (`playtest export`), over the same
 * two inputs: the suite's current resolved case and the accepted baseline's
 * trajectory. Read-only — nothing about the baseline changes, and Playtest never
 * reads the emitted file back (docs/contracts/interfaces.md#playwright-export).
 */
export async function exportPlaywright(ctx: HostedDynamic) {
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "viewer");
  const storyId = ctx.query.get("story");
  if (!storyId) throw badRequest("playwright-export needs ?story=<story_id>");

  const { rows: fileRows } = await ctx.db.query(`SELECT path, content FROM suite_files WHERE suite_id = $1`, [suite.id]);
  const files = Object.fromEntries(fileRows.map((f: HostedDynamic) => [f.path, f.content]));
  let caseCfg;
  try {
    caseCfg = await resolveCaseByStory(files, storyId);
  } catch (e: HostedDynamic) {
    throw new AppError("conflict", `cannot export: the suite no longer validates (${e.message})`, { status: 409 });
  }
  if (!caseCfg) throw notFound(`no story "${storyId}" in this suite`);
  if (caseCfg.mode === "discovery") {
    throw badRequest(`cannot export "${storyId}": discovery studies explore rather than replay a saved path`);
  }
  const driver = caseCfg.env?.driver ?? "web";
  if (driver !== "web") {
    throw badRequest(`cannot export "${storyId}": export supports web stories; this one uses driver "${driver}"`);
  }

  // The live accepted baseline: highest version that nothing has superseded.
  const { rows } = await ctx.db.query(
    `SELECT id, version, trajectory_key, meta, accepted_from_run_id
       FROM baselines
      WHERE suite_id = $1 AND story_id = $2 AND superseded_by IS NULL
      ORDER BY version DESC LIMIT 1`,
    [suite.id, storyId],
  );
  if (!rows[0]) throw notFound(`no accepted saved path for story "${storyId}" — run it first`);

  const envelopes = parseJsonl(await baselineTrajectoryText(ctx, rows[0].trajectory_key));
  const meta = typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : (rows[0].meta ?? {});
  const { filename, code, notes } = exportSpec({
    caseCfg,
    envelopes,
    meta,
    sourcePath: caseCfg.path ?? storyId,
  });

  return new HttpResult({
    buffer: Buffer.from(code, "utf8"),
    contentType: "text/plain; charset=utf-8",
    headers: {
      "content-disposition": `attachment; filename="${path.basename(filename)}"`,
      // Surfaced so the UI can tell the user what could not be asserted without
      // re-parsing the file it just downloaded.
      "x-playtest-export-notes": Buffer.from(JSON.stringify(notes), "utf8").toString("base64"),
    },
  });
}

/** Trajectory bytes for a `<bundle key>#<entry>` baseline pointer (see executor-api). */
async function baselineTrajectoryText(ctx: HostedDynamic, trajectoryKey: HostedDynamic) {
  const [key, entry = "trajectory.jsonl"] = String(trajectoryKey).split("#");
  const buf = await ctx.store.get(key);
  const provider = new BundleProvider({ readRange: (s: HostedDynamic, e: HostedDynamic) => buf.subarray(s, e + 1), size: buf.length } as HostedDynamic);
  const text = provider.readText(entry);
  if (text === null) throw notFound(`baseline trajectory entry "${entry}" was not found in ${key}`);
  return text;
}
