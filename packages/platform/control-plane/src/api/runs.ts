import { audit, actorOf } from "../audit.ts";
import { HttpResult, readJsonBody } from "../http.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { requireAuth, guard, getProjectByKey, getSuite, parsePagination } from "./util.ts";
import {
  createRunGroup,
  previewRunGroup,
  getRunGroup,
  getRunGroupView,
  groupDispatchLabels,
  groupTarget,
  targetSnapshot,
  dispatchAttempt,
} from "../dispatch/dispatcher.ts";
import {
  ACTIVE_DISPATCH_STATES,
  cancelGroup as cancelGroupStatus,
  concludeGroupDispatches,
  createGroupDispatch,
  reopenGroupForRetry,
} from "../dispatch/state.ts";
import { applicationById, ringById } from "./applications.ts";
import { normalizeLabels } from "../auth/runner-credentials.ts";
import { normalizeClipRequest, startClip } from "../media/clip.ts";
import { ulid } from "../ulid.ts";
import { inClause } from "../db.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { holdUntil } from "../events/hold.ts";

export async function createGroup(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "editor");
  const body = await readJsonBody(ctx.req);
  if (!body.suite_id) throw badRequest(`"suite_id" is required`);
  if (!body.ring_id) throw badRequest(`"ring_id" is required`);
  const { suite, application, ring } = await resolveLaunchTarget(ctx, project, body);
  return await createRunGroup(ctx, {
    principal,
    project,
    suite,
    application,
    ring,
    selection: body.selection || {},
    note: body.note ?? null,
    runnerLabels: pinnedLabels(body),
  });
}

/**
 * The optional per-launch placement pin. Absent means "follow the ring";
 * present — including an explicit `[]`, which means "any runner in the project" —
 * overrides the ring's labels for this group alone.
 *
 * It carries no authorization of its own. Labels are routing, not authority: a
 * runner only ever reaches jobs in the project its credential is registered to,
 * so choosing which of that project's runners takes a run is the same decision
 * scope as launching the run at all (`editor`).
 */
function pinnedLabels(body: HostedDynamic): string[] | null {
  if (!("runner_labels" in body) || body.runner_labels == null) return null;
  return normalizeLabels(body.runner_labels, "runner_labels");
}

/**
 * POST /projects/:p/run-groups/preview [viewer] — read-only launch preview:
 * what a launch with this selection would run (personas fanned out, planned
 * modes) and an honest cost estimate from the suite's own run history
 * ("runs = stories × personas" with cost preview).
 */
export async function previewGroup(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const body = await readJsonBody(ctx.req);
  if (!body.suite_id) throw badRequest(`"suite_id" is required`);
  if (!body.ring_id) throw badRequest(`"ring_id" is required`);
  const { suite, application, ring } = await resolveLaunchTarget(ctx, project, body);
  return await previewRunGroup(ctx, {
    project,
    suite,
    application,
    ring,
    selection: body.selection || {},
    runnerLabels: pinnedLabels(body),
  });
}

/**
 * The (suite, ring) a launch or preview names, resolved to the application both
 * must agree on. A suite belongs to exactly one application and may launch only
 * against that application's rings, so a ring of another surface is a mistake
 * worth naming rather than a silent run against the wrong thing.
 */
async function resolveLaunchTarget(ctx: HostedDynamic, project: HostedDynamic, body: HostedDynamic) {
  const suite = await getSuite(ctx, body.suite_id);
  if (suite.project_id !== project.id) throw notFound(`no suite "${body.suite_id}" in project "${project.key}"`);
  const { ring, application } = await ringById(ctx, body.ring_id);
  if (application.project_id !== project.id) throw notFound(`no ring "${body.ring_id}" in project "${project.key}"`);
  if (ring.application_id !== suite.application_id) {
    const own = await applicationById(ctx, suite.application_id);
    throw badRequest(
      `ring "${application.key}/${ring.key}" belongs to another application — suite "${suite.slug}" runs ` +
        `against "${own.key}", so pick one of its rings`,
    );
  }
  return { suite, application, ring };
}

/**
 * GET /projects/:p/run-groups [viewer] — the Runs index.
 *
 * Every row carries `stats`: the per-story outcome counts, how far a live run
 * has got, its wall clock and its cost. The index used to render an outcome word
 * and nothing else, so "did last night pass, how long did it take, what did it
 * cost, how far is this one" all needed a click into the run and then a click
 * per story. These are aggregates over `runs`, computed in ONE grouped pass for
 * the whole page (the shape `projects.js health` already uses for Overview) —
 * never a fetch per row.
 *
 * `include=runs` adds each run's story rows so the index can expand a run in
 * place, which is what makes a story's replay one click from the rail. The rows
 * are capped (`RUN_ROWS_CAP`) so a project with 200-story suites cannot turn one
 * page into a megabyte; a group whose rows were cut still states its true story
 * count in `stats.total`, and the console says "+N more".
 *
 * `outcome=attention` keeps only runs a person still has to look at: one that
 * failed a check, or one that never produced a verdict, and whose failing story
 * hasn't since passed in a newer run of the same suite and ring.
 */
const RUN_ROWS_CAP = 2000;

export async function listGroups(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { limit } = parsePagination(ctx.query);
  const params = [project.id];
  let where = `WHERE project_id = $1`;
  if (ctx.query.get("status")) {
    params.push(ctx.query.get("status"));
    where += ` AND status = $${params.length}`;
  }
  if (ctx.query.get("suite")) {
    params.push(ctx.query.get("suite"));
    where += ` AND suite_id = $${params.length}`;
  }
  if (ctx.query.get("outcome") === "attention") {
    // A failed check, or no verdict at all. `explored` and `canceled` are not
    // attention: a discovery run has no pass/fail to give, and a cancellation is
    // something a person already decided — including a story that failed before
    // the person pulled the plug on its group. A failure is retired once a newer
    // run of the same story, on the same suite and ring, passes — a green
    // rerun is how a person resolves a red run, so the alert clears itself.
    where += ` AND run_groups.status <> 'canceled'
               AND EXISTS (SELECT 1 FROM runs r WHERE r.run_group_id = run_groups.id
                             AND r.status IN ('fail','infra','lost')
                             AND NOT EXISTS (
                               SELECT 1 FROM runs r2
                                 JOIN run_groups g2 ON g2.id = r2.run_group_id
                                WHERE g2.suite_id = run_groups.suite_id
                                  AND g2.ring_id = run_groups.ring_id
                                  AND g2.created_at > run_groups.created_at
                                  AND r2.case_id = r.case_id
                                  AND r2.status = 'pass'))`;
  }
  params.push(limit);
  const { rows } = await ctx.db.query(
    `SELECT * FROM run_groups ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  if (!rows.length) return { items: rows };
  const ids = rows.map((g: HostedDynamic) => g.id);
  const stats = await groupStats(ctx, ids);
  for (const g of rows) g.stats = stats.get(g.id) ?? emptyStats();
  if ((ctx.query.get("include") || "").split(",").includes("runs")) {
    const byGroup = await groupRunRows(ctx, ids);
    for (const g of rows) g.runs = byGroup.get(g.id) ?? [];
  }
  return { items: rows };
}

const emptyStats = () => ({
  total: 0, queued: 0, running: 0, done: 0,
  pass: 0, fail: 0, infra: 0, explored: 0, canceled: 0, lost: 0, changed: 0,
  cost_usd: 0, duration_ms: null, started_at: null, finished_at: null,
});

/** One grouped pass over `runs` for a page of run groups. */
async function groupStats(ctx: HostedDynamic, ids: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT run_group_id,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'queued') AS queued,
            COUNT(*) FILTER (WHERE status IN ('running','uploading')) AS running,
            COUNT(*) FILTER (WHERE status IN ('pass','fail','infra','explored','canceled','lost')) AS done,
            COUNT(*) FILTER (WHERE status = 'pass') AS pass,
            COUNT(*) FILTER (WHERE status = 'fail') AS fail,
            COUNT(*) FILTER (WHERE status = 'infra') AS infra,
            COUNT(*) FILTER (WHERE status = 'explored') AS explored,
            COUNT(*) FILTER (WHERE status = 'canceled') AS canceled,
            COUNT(*) FILTER (WHERE status = 'lost') AS lost,
            COUNT(*) FILTER (WHERE changed) AS changed,
            COALESCE(SUM(CAST(json_extract(totals, '$.cost_usd') AS REAL)), 0) AS cost_usd,
            SUM(duration_ms) AS work_ms,
            MIN(started_at) AS started_at,
            MAX(finished_at) AS finished_at
       FROM runs
      WHERE run_group_id IN (${inClause(ids, 1)})
      GROUP BY run_group_id`,
    ids,
  );
  const out = new Map();
  for (const r of rows) {
    // Aggregate expressions have no origin column, so the INT_TS decoder does
    // not fire on them (db.js #decoders) — these two arrive as epoch ms.
    const started: HostedDynamic = r.started_at == null ? null : new Date(Number(r.started_at));
    const finished: HostedDynamic = r.finished_at == null ? null : new Date(Number(r.finished_at));
    const settled = r.done === r.total && r.total > 0;
    out.set(r.run_group_id, {
      total: r.total,
      queued: r.queued,
      running: r.running,
      done: r.done,
      pass: r.pass,
      fail: r.fail,
      infra: r.infra,
      explored: r.explored,
      canceled: r.canceled,
      lost: r.lost,
      changed: r.changed,
      cost_usd: Number(r.cost_usd) || 0,
      // How long the run took, and only once nothing is still moving: while
      // stories are in flight, max(finished_at) is the last one that HAPPENED to
      // finish, and reporting that as the run's duration would tick backwards.
      //
      // Normally that is the span from the first story starting to the last one
      // finishing, which includes the gaps between them. When the run's row
      // timestamps are coarser than the work they bound — a replayed or
      // backdated group can have every story stamped the same millisecond — the
      // span collapses to zero, and "0ms" for a run that did minutes of work is
      // a lie the row tells. Both numbers are lower bounds on how long the run
      // took; report the larger one.
      duration_ms: settled ? longer(started && finished ? finished - started : null, num(r.work_ms)) : null,
      started_at: started,
      finished_at: settled ? finished : null,
    });
  }
  return out;
}

const num = (v: HostedDynamic) => (v == null ? null : Number(v));
/** The larger of two lower bounds, when either exists. */
const longer = (a: HostedDynamic, b: HostedDynamic) => (a == null && b == null ? null : Math.max(0, a ?? 0, b ?? 0));

/** The story rows for a page of run groups, newest group first, capped. */
async function groupRunRows(ctx: HostedDynamic, ids: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT id, run_group_id, case_id, story_id, status, mode, healed, changed, score,
            duration_ms, started_at, error, progress,
            CAST(json_extract(totals, '$.cost_usd') AS REAL) AS cost_usd,
            CAST(json_extract(totals, '$.steps') AS INTEGER) AS steps
       FROM runs
      WHERE run_group_id IN (${inClause(ids, 1)})
      ORDER BY run_group_id DESC, case_id
      LIMIT ${RUN_ROWS_CAP}`,
    ids,
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.run_group_id)) out.set(r.run_group_id, []);
    out.get(r.run_group_id).push({
      id: r.id,
      case_id: r.case_id,
      story_id: r.story_id,
      status: r.status,
      mode: r.mode,
      healed: r.healed,
      changed: r.changed,
      score: r.score,
      steps: r.steps,
      duration_ms: r.duration_ms,
      started_at: r.started_at,
      cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
      // Live telemetry for an in-flight story (cleared by its report), so the
      // index can render a moving row without fetching event history.
      progress: r.progress ?? null,
      error: r.error,
    });
  }
  return out;
}

/**
 * GET /run-groups/:id[?wait=true] [viewer] — the run group.
 *
 * `wait` is the automation long-poll (`hosted.md`, § Run groups and runs): a CI
 * job launches, then asks for the verdict and is held until there is one,
 * instead of asking again every few seconds. It is the same held read the event
 * feed and the claim board use — woken by the post-commit signal, re-scanned on
 * a bounded interval, correct from the committed row alone — so a group that
 * settles between two scans is answered at once and one that never settles is
 * answered at the deadline with whatever it is doing. Callers must therefore
 * still read `status`: an unsettled answer is normal, not an error.
 */
export async function getGroup(ctx: HostedDynamic) {
  const group = await getRunGroup(ctx, ctx.params.g);
  guard(ctx, group.project_id, "viewer");
  const wait = waitSeconds(ctx.query.get("wait"));
  if (wait > 0 && !SETTLED.has(group.status)) {
    await holdUntil(ctx, group.project_id, wait, async () => {
      const { rows } = await ctx.db.query(`SELECT status FROM run_groups WHERE id = $1`, [group.id]);
      // A held read ends on non-empty rows, so "still running" must read as
      // empty here — the group's own row is the truth either way.
      return SETTLED.has(rows[0]?.status) ? rows : [];
    });
  }
  return await getRunGroupView(ctx, group.id);
}

/** A run group nothing more will happen to. */
const SETTLED = new Set(["done", "canceled"]);

/** The hold window a caller asked for, capped at the feed's own maximum. */
function waitSeconds(raw: unknown): number {
  if (raw == null || raw === "" || raw === "false" || raw === "0") return 0;
  if (raw === "true") return MAX_WAIT_S;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_WAIT_S);
}

const MAX_WAIT_S = 25;

export async function cancelGroup(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const group = await getRunGroup(ctx, ctx.params.g);
  guard(ctx, group.project_id, "editor");
  const { rows } = await ctx.db.query(
    `SELECT * FROM dispatches
      WHERE kind = 'group' AND ref_id = $1 AND status IN (${inClause(ACTIVE_DISPATCH_STATES, 2)})
      ORDER BY attempt DESC`,
    [group.id, ...ACTIVE_DISPATCH_STATES],
  );
  // Nothing can be called: the mark on the claim IS the channel, and the runner
  // observes it at its next heartbeat.
  for (const d of rows) await ctx.board.cancelDispatch(d.id);
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    // Cancellation is terminal and monotonic: a group that already settled is
    // not re-settled, and an executor arriving a moment later is fenced by the
    // concluded dispatch rather than by a status string it might overwrite.
    await cancelGroupStatus(tx, group.id);
    await tx.query(
      `UPDATE runs
          SET status = 'canceled', finished_at = COALESCE(finished_at, now()), progress = NULL, updated_at = now()
        WHERE run_group_id = $1 AND status NOT IN ('pass','fail','infra','explored','canceled','lost')`,
      [group.id],
    );
    await concludeGroupDispatches(tx, group.id, { error: "canceled by user" });
    await audit(tx, {
      actor: actorOf(principal),
      action: "run_group.canceled",
      entityType: "run_group",
      entityId: group.id,
      projectId: group.project_id,
      detail: {},
    });
  });
  return await getRunGroupView(ctx, group.id);
}

/**
 * Retry a placement failure inside the existing run group. Only stories that
 * never started are reset: a product verdict or saved evidence is immutable
 * history, while an infra/lost row with no started_at is work the run never
 * performed. The group-status precondition and dispatch insert share one
 * transaction, so double-clicks produce one attempt and one 409.
 */
export async function retryGroup(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const group = await getRunGroup(ctx, ctx.params.g);
  guard(ctx, group.project_id, "editor");
  const { application, ring } = await groupTarget(ctx, group);
  // A retry is the same group, so it is placed the way the group was: a launch
  // that pinned its labels keeps them even if the ring changed since. Its TARGET
  // snapshot, though, is taken fresh — a retry runs against the ring as it is
  // now, which is the documented retry behavior.
  const labels = groupDispatchLabels(group, ring);
  const target = targetSnapshot(application, ring, labels);
  const dispatchId = ulid();
  let attempt = 0;
  let retried = 0;

  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const current = await tx.query(`SELECT status FROM run_groups WHERE id = $1`, [group.id]);
    if (current.rows[0]?.status !== "done") {
      throw conflict(`run "${group.id}" is already active or cannot be retried`);
    }
    const active = await tx.query(
      `SELECT COUNT(*) AS n FROM dispatches
        WHERE project_id = $1 AND status IN ('requested','scheduled','running')`,
      [group.project_id],
    );
    if (active.rows[0].n >= ctx.config.dispatch.maxActivePerProject) {
      throw conflict(`project already has ${active.rows[0].n} active dispatches`);
    }
    const retryable = await tx.query(
      `SELECT id FROM runs
        WHERE run_group_id = $1 AND status IN ('infra','lost') AND started_at IS NULL
        ORDER BY case_id`,
      [group.id],
    );
    retried = retryable.rows.length;
    if (!retried) {
      throw conflict("only stories that never started can be retried in place");
    }
    const ids = retryable.rows.map((r: HostedDynamic) => r.id);
    await tx.query(
      `UPDATE runs
          SET status = 'queued', healed = 0, changed = 0, manifest = NULL,
              totals = NULL, score = NULL, gate = NULL, pins = NULL,
              duration_ms = NULL, started_at = NULL, finished_at = NULL,
              executor_id = NULL, error = NULL, progress = NULL, updated_at = now()
        WHERE id IN (${inClause(ids, 1)})
          AND status IN ('infra','lost') AND started_at IS NULL`,
      ids,
    );
    // Allocation and insert in one transaction, and the "no live attempt"
    // precondition restated in the write: a double click produces one attempt.
    const posted = await createGroupDispatch(tx, {
      projectId: group.project_id,
      groupId: group.id,
      labels,
      target,
      dispatchId,
    });
    if (!posted) throw conflict(`run "${group.id}" is already active or cannot be retried`);
    attempt = posted.attempt;
    // The ONE authorized reopen of a settled group, and it is a person's
    // decision carrying its own precondition — never a race.
    await reopenGroupForRetry(tx, group.id);
    await audit(tx, {
      actor: actorOf(principal),
      action: "run_group.retried",
      entityType: "run_group",
      entityId: group.id,
      projectId: group.project_id,
      detail: { dispatch_id: dispatchId, attempt, stories: retried },
    });
    await emitPlatformEvent(tx, {
      projectId: group.project_id,
      type: "run.status",
      entity: { run_group_id: group.id },
      payload: { status: "queued", retry: true, cases: retried },
    });
  });

  await dispatchAttempt(ctx, {
    dispatchId,
    projectId: group.project_id,
    kind: "group",
    refId: group.id,
    attempt,
    labels,
  });
  return { run_group: await getRunGroupView(ctx, group.id), retried };
}

export async function listRuns(ctx: HostedDynamic) {
  const projectId = ctx.query.get("project");
  if (!projectId) throw badRequest(`"project" query param is required`);
  guard(ctx, projectId, "viewer");
  const { limit } = parsePagination(ctx.query);
  const params = [projectId];
  let where = `WHERE g.project_id = $1`;
  for (const [q, col] of [
    ["suite", "g.suite_id"],
    ["story", "r.story_id"],
    ["status", "r.status"],
  ]) {
    if (ctx.query.get(q)) {
      params.push(ctx.query.get(q));
      where += ` AND ${col} = $${params.length}`;
    }
  }
  if (ctx.query.get("changed")) {
    params.push(ctx.query.get("changed") === "true");
    where += ` AND r.changed = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await ctx.db.query(
    `SELECT r.* FROM runs r JOIN run_groups g ON g.id = r.run_group_id
      ${where} ORDER BY r.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return { items: rows };
}

export async function getRun(ctx: HostedDynamic) {
  const run = await runById(ctx, ctx.params.r);
  guard(ctx, run.project_id, "viewer");
  return run;
}

export async function feed(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  let after = ctx.query.get("after") || "";
  if (!after) {
    const tail = await ctx.db.query(`SELECT id FROM platform_events WHERE project_id = $1 ORDER BY id DESC LIMIT 1`, [
      project.id,
    ]);
    after = tail.rows[0]?.id || "00000000000000000000000000";
  }
  const wait = Math.min(Number(ctx.query.get("wait") || 0), 25);
  const types = new Set((ctx.query.get("types") || "").split(",").filter(Boolean));
  const load = async () => {
    const params = [project.id, after || "00000000000000000000000000"];
    let typeClause = "";
    if (types.size) {
      // One placeholder per type: SQLite has no array parameter, and the list is
      // a bounded, server-parsed set of event-type names.
      const list = [...types];
      typeClause = ` AND type IN (${inClause(list, params.length + 1)})`;
      params.push(...list);
    }
    const { rows } = await ctx.db.query(
      `SELECT id, ts, type, entity, payload FROM platform_events
        WHERE project_id = $1 AND id > $2 ${typeClause}
        ORDER BY id LIMIT 200`,
      params,
    );
    return rows;
  };
  let rows = await load();
  if (!rows.length && wait > 0) {
    rows = await holdUntil(ctx, project.id, wait, load);
  }
  const cursor = rows.at(-1)?.id ?? after;
  return { events: rows, cursor, items: rows, next_cursor: cursor };
}

export async function download(ctx: HostedDynamic) {
  const run = await runById(ctx, ctx.params.r);
  guard(ctx, run.project_id, "viewer");
  const artifact = await latestArtifact(ctx, run.id, "bundle");
  if (!artifact) throw notFound(`run "${run.id}" has no bundle artifact`);
  const buf = await ctx.store.get(artifact.key);
  return new HttpResult({
    buffer: buf,
    contentType: "application/vnd.playtest.run-bundle",
    headers: { "content-disposition": `attachment; filename="${run.run_id}-${run.case_id.replace(/[^a-z0-9_.-]/gi, "_")}.ptrun"` },
  });
}

export async function createClip(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const run = await runById(ctx, ctx.params.r);
  guard(ctx, run.project_id, "viewer");
  const request = normalizeClipRequest(await readJsonBody(ctx.req));
  const existing = await latestArtifact(ctx, run.id, "clip");
  if (existing) return { ready: true, url: `/api/v1/runs/${run.id}/clip`, artifact: artifactView(existing) };

  // Idempotent: repeated Export-clip clicks must start exactly one generation.
  // An in-flight `media` dispatch for this run means a worker is already
  // clipping — return its id instead of starting a duplicate.
  const inflight = await inflightClipDispatch(ctx, run.id);
  if (inflight) return new HttpResult({ status: 202, json: { ok: true, ready: false, dispatch_id: inflight.id } });

  const bundle = await latestArtifact(ctx, run.id, "bundle");
  if (!bundle) throw notFound(`run "${run.id}" has no bundle artifact`);
  if (run.artifact_tier !== "full" || bundle.tier !== "full") {
    throw badRequest(`run "${run.run_id}" has been pruned to ${run.artifact_tier}; on-demand clips need the full bundle`);
  }

  const dispatchId = ulid();
  await ctx.db.query(
    `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status)
       VALUES ($1, $2, 'media', $3,
               COALESCE((SELECT MAX(attempt) + 1 FROM dispatches WHERE kind = 'media' AND ref_id = $3), 1),
               'running')`,
    [dispatchId, run.project_id, run.id],
  );
  startClip(ctx, { run, project: { id: run.project_id }, actor: actorOf(principal), request, dispatchId });
  return new HttpResult({ status: 202, json: { ok: true, ready: false, dispatch_id: dispatchId } });
}

export async function downloadClip(ctx: HostedDynamic) {
  const run = await runById(ctx, ctx.params.r);
  guard(ctx, run.project_id, "viewer");
  const artifact = await latestArtifact(ctx, run.id, "clip");
  if (!artifact) throw notFound(`run "${run.id}" does not have a generated clip`);
  const buf = await ctx.store.get(artifact.key);
  return new HttpResult({
    buffer: buf,
    contentType: artifact.key.endsWith(".webm") ? "video/webm" : "video/mp4",
    headers: { "content-disposition": `attachment; filename="${run.run_id}-${run.case_id.replace(/[^a-z0-9_.-]/gi, "_")}.clip.mp4"` },
  });
}

export async function dispatchAdmin(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  const { rows } = await ctx.db.query(
    `SELECT d.*, e.versions, e.isolation, e.registered_at, e.last_report_at, e.concluded_at
       FROM dispatches d
       LEFT JOIN executors e ON e.id = d.executor_id
      WHERE d.project_id = $1
      ORDER BY d.requested_at DESC LIMIT 100`,
    [project.id],
  );
  return { items: rows };
}

async function runById(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT r.*, g.project_id, g.suite_id, g.application_id, g.ring_id,
            -- Where this run ran, by NAME as well as by id. The group projection
            -- already folds the pair in; a run read on its own had only opaque
            -- ids, so anything reading one run — a CLI, an API consumer, a
            -- notification — could not say "todo-ios/local" without two more
            -- requests. Keys are immutable, which is exactly why evidence cites
            -- them (docs/contracts/artifacts.md, "Writing and retention rewrites").
            app.key AS application_key, app.name AS application_name,
            app.driver AS application_driver, app.platform AS application_platform,
            ring.key AS ring_key, ring.name AS ring_name, ring.base_url AS ring_base_url,
            (SELECT json_object('key', a.key, 'sha256', a.sha256, 'size', a.size,
                                'tier', a.tier, 'created_at', a.created_at)
               FROM artifacts a
              WHERE a.run_id = r.id AND a.kind = 'bundle'
              ORDER BY a.created_at DESC LIMIT 1) AS artifact,
            (SELECT json_object('key', a.key, 'sha256', a.sha256, 'size', a.size,
                                'tier', a.tier, 'created_at', a.created_at)
               FROM artifacts a
              WHERE a.run_id = r.id AND a.kind = 'clip'
              ORDER BY a.created_at DESC LIMIT 1) AS clip,
            -- findings this run is already evidence in, so the run page can
            -- say "already triaged" instead of inviting a duplicate Promote.
            -- SQLite has no ORDER BY inside an aggregate, so the newest-first
            -- ordering lives in the subquery json_group_array consumes; over no
            -- rows it already yields []. A finding can hold several evidence
            -- rows from the same run (one per cited step), so group to one row
            -- per finding — the page counts findings, not evidence links.
            (SELECT json_group_array(json_object(
                      'id', id, 'title', title, 'state', state, 'severity', severity))
               FROM (SELECT f.id, f.title, f.state, f.severity
                       FROM finding_evidence e
                       JOIN findings f ON f.id = e.finding_id
                      WHERE e.run_id = r.id AND f.merged_into IS NULL
                      GROUP BY f.id
                      ORDER BY f.last_seen DESC)) AS findings,
            -- findings this run's report auto-resolved — the run page's calm
            -- "resolved N findings" chip, each linking to its finding.
            (SELECT json_group_array(json_object(
                      'id', f.id, 'title', f.title, 'severity', f.severity))
               FROM findings f
              WHERE f.resolved_by_run_id = r.id AND f.merged_into IS NULL
                AND f.state = 'resolved') AS resolved_findings
       FROM runs r JOIN run_groups g ON g.id = r.run_group_id
       JOIN applications app ON app.id = g.application_id
       JOIN rings ring ON ring.id = g.ring_id
      WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound(`no run "${id}"`);
  // `artifact`, `clip`, and `findings` are computed columns: they have no origin
  // table, so the adapter cannot decode them and hands back raw JSON text. Parse
  // here, and lift the embedded `created_at` epoch back to a Date so it
  // serializes as the same ISO string every other timestamp does.
  const run = rows[0];
  run.artifact = parseEmbeddedArtifact(run.artifact);
  run.clip = parseEmbeddedArtifact(run.clip);
  run.findings = run.findings ? JSON.parse(run.findings) : [];
  run.resolved_findings = run.resolved_findings ? JSON.parse(run.resolved_findings) : [];
  // The joined columns fold into the same two objects the group projection
  // serves, so one shape describes "where this ran" wherever it is read. A
  // mobile ring's `base_url` is null; nothing else about the device is here,
  // because nothing else about it is the platform's to hold.
  run.application = {
    id: run.application_id,
    key: run.application_key,
    name: run.application_name,
    driver: run.application_driver,
    platform: run.application_platform ?? null,
  };
  run.ring = { id: run.ring_id, key: run.ring_key, name: run.ring_name, base_url: run.ring_base_url ?? null };
  for (const key of ["application_key", "application_name", "application_driver", "application_platform", "ring_key", "ring_name", "ring_base_url"]) {
    delete run[key];
  }
  return run;
}

function parseEmbeddedArtifact(text: HostedDynamic) {
  if (text == null) return null;
  const a = JSON.parse(text);
  return { ...a, created_at: a.created_at == null ? null : new Date(a.created_at) };
}

async function inflightClipDispatch(ctx: HostedDynamic, runId: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT id FROM dispatches
      WHERE kind = 'media' AND ref_id = $1 AND status = 'running'
      ORDER BY attempt DESC LIMIT 1`,
    [runId],
  );
  return rows[0] || null;
}

async function latestArtifact(ctx: HostedDynamic, runId: HostedDynamic, kind: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT * FROM artifacts WHERE run_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1`,
    [runId, kind],
  );
  return rows[0] || null;
}

function artifactView(a: HostedDynamic) {
  return a ? { key: a.key, sha256: a.sha256, size: a.size, tier: a.tier, created_at: a.created_at } : null;
}
