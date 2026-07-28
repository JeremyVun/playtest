import { BundleProvider } from "@playtest/core/artifacts";
import { HttpResult, readJsonBody, readRawBody } from "../http.ts";
import { badRequest, forbidden, notFound, unauthenticated } from "../errors.ts";
import { issueRunnerToken, requireRunner } from "../auth/runner-tokens.ts";
import { requireRunnerCredential } from "../auth/runner-credentials.ts";
import { ulid } from "../ulid.ts";
import { audit } from "../audit.ts";
import { decryptSecret } from "../crypto/secrets.ts";
import { blobKey } from "../store/object-store.ts";
import { appendRunEvent, emitRunStatus } from "../events/run-events.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { claimSessions, fulfillSessionClaim, standaloneMintGrant, concludeMintDispatch } from "../dispatch/sessions.ts";
import { dispatchContinuation } from "../dispatch/dispatcher.ts";
import { diffSummaryForRun } from "./review.ts";
import { extractFindingFromReport } from "../findings/extractor.ts";
import { collectRunGradeIssues, ingestRunGradeFindings } from "../findings/run-grade.ts";
import { scheduleAutoDedupe } from "../findings/auto-dedupe.ts";
import { scheduleAutoResolve } from "../findings/auto-resolve.ts";
import { inClause } from "../db.ts";
import { personaPath } from "./personas.ts";
import {
  BUNDLE_LIMIT,
  LIVE_ENTRY_LIMIT,
  LIVE_LINE_LIMIT,
  LIVE_MANIFEST_LIMIT,
  LIVE_MAX_BATCH_LINES,
  LIVE_TRAJECTORY_BODY_LIMIT,
  dropStaging,
  wakeLive,
} from "../live/staging.ts";

export async function exchange(ctx: HostedDynamic) {
  const body = await readJsonBody(ctx.req);
  const dispatch = await resolveExchangeDispatch(ctx, body);
  const executorId = ulid();
  const versions = body.versions && typeof body.versions === "object" ? body.versions : {};
  const isolation = body.isolation === "container" ? "container" : "process";
  // A standalone mint dispatch (§3a forced refresh) exchanges like a group
  // dispatch but is scoped to one session claim, not a run group.
  if (dispatch.kind === "mint") return await mintExchange(ctx, { dispatch, executorId, versions, isolation });
  const group = await getGroup(ctx, dispatch.ref_id);
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `INSERT INTO executors (id, run_group_id, kind, versions, isolation, last_report_at)
         VALUES ($1, $2, 'group', $3, $4, now())`,
      [executorId, group.id, versions, isolation],
    );
    await tx.query(
      `UPDATE dispatches SET status = 'running', executor_id = $2 WHERE id = $1`,
      [dispatch.id, executorId],
    );
    await tx.query(`UPDATE run_groups SET status = 'running', updated_at = now() WHERE id = $1`, [group.id]);
    await emitPlatformEvent(tx, {
      projectId: group.project_id,
      type: "run.status",
      entity: { run_group_id: group.id },
      payload: { status: "running", executor_id: executorId },
    });
  });
  return {
    token: issueRunnerToken(ctx.runnerTokenKey, { executorId, runGroupId: group.id }),
    executor_id: executorId,
  };
}

/**
 * Exchange for a `mint` dispatch: register the executor, bind the pending
 * claim to it (first exchange wins — a second executor is refused), and issue
 * a bearer scoped to `mint:<claim_id>` so group routes reject it and the two
 * mint routes below accept nothing else.
 */
async function mintExchange(ctx: HostedDynamic, { dispatch, executorId, versions, isolation }: HostedDynamic) {
  const claimId = dispatch.ref_id;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(`SELECT * FROM session_claims WHERE id = $1`, [claimId]);
    const claim = rows[0];
    if (!claim || claim.status !== "pending" || new Date(claim.expires_at) < new Date()) {
      throw unauthenticated(`mint claim "${claimId}" is no longer pending`);
    }
    if (claim.executor_id) throw forbidden(`mint claim "${claimId}" already belongs to another executor`);
    // First exchange wins. The binding update carries the whole precondition the
    // read just checked (this replaces the Postgres row lock), so a second
    // executor loses here and is refused with the same error it gets today.
    const bound = await tx.query(
      `UPDATE session_claims SET executor_id = $2
        WHERE id = $1 AND status = 'pending' AND expires_at > $3 AND executor_id IS NULL`,
      [claimId, executorId, new Date()],
    );
    if (bound.rowCount === 0) {
      const { rows: after } = await tx.query(`SELECT * FROM session_claims WHERE id = $1`, [claimId]);
      if (after[0]?.executor_id) throw forbidden(`mint claim "${claimId}" already belongs to another executor`);
      throw unauthenticated(`mint claim "${claimId}" is no longer pending`);
    }
    await tx.query(
      `INSERT INTO executors (id, run_group_id, kind, versions, isolation, last_report_at)
         VALUES ($1, NULL, 'mint', $2, $3, now())`,
      [executorId, versions, isolation],
    );
    await tx.query(`UPDATE dispatches SET status = 'running', executor_id = $2 WHERE id = $1`, [dispatch.id, executorId]);
  });
  return {
    token: issueRunnerToken(ctx.runnerTokenKey, { executorId, runGroupId: `mint:${claimId}` }),
    executor_id: executorId,
  };
}

/** GET /runner/mints/:claim — the standalone mint grant (root secrets resolved here). */
export async function mintSpec(ctx: HostedDynamic) {
  const runner = requireRunner(ctx, `mint:${ctx.params.claim}`);
  return await standaloneMintGrant(ctx, { claimId: ctx.params.claim, executorId: runner.executor_id });
}

/**
 * POST /runner/mints/:claim/complete {storage_state} | {error} — fulfill (or
 * abandon) the claim exactly like the in-group fulfill, then conclude the mint
 * dispatch ledger row so the admin page and reconciler see it finished.
 */
export async function mintComplete(ctx: HostedDynamic) {
  const runner = requireRunner(ctx, `mint:${ctx.params.claim}`);
  const body = await readJsonBody(ctx.req, { limit: 8 * 1024 * 1024 });
  const result = await fulfillSessionClaim(ctx, {
    claimId: ctx.params.claim,
    executorId: runner.executor_id,
    storageState: body.storage_state ?? null,
    error: body.error ?? null,
    actor: { system: "runner" },
  });
  await concludeMintDispatch(ctx, ctx.params.claim, body.error ?? null);
  await ctx.db.query(`UPDATE executors SET concluded_at = now() WHERE id = $1`, [runner.executor_id]);
  return result;
}

export async function groupSpec(ctx: HostedDynamic) {
  const runner = requireRunner(ctx, ctx.params.g);
  const group = await getGroup(ctx, ctx.params.g);
  const [project, suite, snapshot] = await Promise.all([
    one(ctx, `SELECT * FROM projects WHERE id = $1`, [group.project_id], `no project "${group.project_id}"`),
    one(ctx, `SELECT * FROM suites WHERE id = $1`, [group.suite_id], `no suite "${group.suite_id}"`),
    one(ctx, `SELECT * FROM suite_snapshots WHERE id = $1`, [group.snapshot_id], `no snapshot "${group.snapshot_id}"`),
  ]);
  const target = await attemptTarget(ctx, group, runner.executor_id);
  const { rows } = await ctx.db.query(
    `SELECT id, case_id, story_id, run_id, mode FROM runs
      WHERE run_group_id = $1 AND status = 'queued'
      ORDER BY case_id`,
    [group.id],
  );
  return {
    run_group_id: group.id,
    // `models` is the project's actor/grader default policy; the workspace
    // fills it under the suite's own playtest.yaml keys (suite wins — see
    // docs/contracts/hosted.md, "Model selection").
    project: {
      id: project.id,
      key: project.key,
      name: project.name,
      models: project.models || {},
      parallel: project.parallel || { total: 1, record: 1 },
    },
    suite: { id: suite.id, slug: suite.slug, name: suite.name },
    snapshot_id: snapshot.id,
    cases: rows.map((r: HostedDynamic) => ({
      db_id: r.id,
      run_id: r.run_id,
      case_id: r.case_id,
      story_id: r.story_id,
      options: {
        mode: group.selection?.mode === "agent" ? "agent" : "auto",
        refresh: group.selection?.refresh === true,
        grade: true,
        limits: {
          ...(Number.isSafeInteger(group.selection?.max_steps) ? { max_steps: group.selection.max_steps } : {}),
          ...(Number.isSafeInteger(group.selection?.timeout_ms) ? { timeout_ms: group.selection.timeout_ms } : {}),
        },
      },
    })),
    // The suite's pinned playtest.yaml may replace this in the executor after
    // discovery. This value is the project fallback and preserves the old
    // serial hosted behavior for projects that have never changed the setting.
    parallel: project.parallel || { total: 1, record: 1 },
    // The ring THIS ATTEMPT snapshotted, never the ring's current state: an edit
    // between claim and exchange must not change what the offer promised. The
    // runner materializes `config` as `app.envs.<key>` and applies `base_url` as
    // core's runtime target, so hosted execution replaces the suite's authored
    // physical fields rather than merging with them.
    ring: {
      id: target.ring_id,
      key: target.ring_key,
      base_url: target.base_url ?? null,
      config: target.config || {},
      runner_labels: target.labels || [],
      // Secrets are deliberately NOT in the snapshot — they are resolved here,
      // after the claim and the credential exchange.
      resolved_secrets: await resolvedSecrets(ctx, group.project_id, target.config || {}),
    },
    application: {
      id: target.application_id,
      key: target.application_key,
      driver: target.driver,
      platform: target.platform ?? null,
    },
    sessions: { needed: sessionRefs(target.config || {}), current: {} },
    baselines: await currentBaselines(ctx, group.suite_id),
    uploads: {
      bundle_url_template: `${ctx.config.publicUrl}/api/v1/runner/runs/{run_db_id}/bundle`,
      // The live-staging surface and its caps, advertised rather than hardcoded
      // in the uploader: a runner sizes its batches by bytes under these
      // numbers, and a deployment may lower the run budget.
      live: {
        open_url_template: `${ctx.config.publicUrl}/api/v1/runner/groups/{run_group_id}/cases/{run_id}/open`,
        entry_url_template: `${ctx.config.publicUrl}/api/v1/runner/runs/{run_db_id}/live/{entry}`,
        trajectory_url_template: `${ctx.config.publicUrl}/api/v1/runner/runs/{run_db_id}/live/trajectory`,
        max_manifest_bytes: LIVE_MANIFEST_LIMIT,
        max_entry_bytes: LIVE_ENTRY_LIMIT,
        max_body_bytes: LIVE_TRAJECTORY_BODY_LIMIT,
        max_line_bytes: LIVE_LINE_LIMIT,
        max_batch_lines: LIVE_MAX_BATCH_LINES,
        run_budget_bytes: ctx.config.live.runBudgetBytes,
      },
    },
    budget: { max_runtime_s: 50 * 60, retry_remaining: group.selection?.retry_remaining ?? 1 },
    executor_id: runner.executor_id,
  };
}

/** Latest non-superseded baseline per story (delivered in the group spec §3). */
async function currentBaselines(ctx: HostedDynamic, suiteId: HostedDynamic) {
  // DISTINCT ON (story_id) … ORDER BY story_id, version DESC: the highest
  // version per story, still emitted in story_id order.
  const { rows } = await ctx.db.query(
    `SELECT id, story_id, version, trajectory_key, meta
       FROM (
         SELECT id, story_id, version, trajectory_key, meta,
                row_number() OVER (PARTITION BY story_id ORDER BY version DESC) AS rn
           FROM baselines
          WHERE suite_id = $1 AND superseded_by IS NULL
       )
      WHERE rn = 1
      ORDER BY story_id`,
    [suiteId],
  );
  return rows;
}

/**
 * Baseline trajectory bytes for workspace materialization. `trajectory_key` is
 * `<bundle object key>#<entry>` — the trajectory is read out of the sealed run
 * bundle through BundleProvider, never from an unpacked dir (working
 * agreement 3).
 */
export async function baselineTrajectory(ctx: HostedDynamic) {
  requireRunner(ctx);
  const row = await one(ctx, `SELECT * FROM baselines WHERE id = $1`, [ctx.params.id], `no baseline "${ctx.params.id}"`);
  const [key, entry = "trajectory.jsonl"] = String(row.trajectory_key).split("#");
  const buf = await ctx.store.get(key);
  const provider = new BundleProvider({ readRange: (s: HostedDynamic, e: HostedDynamic) => buf.subarray(s, e + 1), size: buf.length } as HostedDynamic);
  const text = provider.readText(entry);
  if (text === null) throw notFound(`baseline trajectory entry "${entry}" was not found in ${key}`);
  return new HttpResult({ buffer: Buffer.from(text), contentType: "application/x-ndjson" });
}

export async function snapshotTree(ctx: HostedDynamic) {
  requireRunner(ctx);
  const snap = await one(ctx, `SELECT * FROM suite_snapshots WHERE id = $1`, [ctx.params.id], `no snapshot "${ctx.params.id}"`);
  // Project personas are merged into the tree HERE, at read time, rather than
  // baked into the snapshot at commit time: a snapshot is immutable, so baking
  // would freeze a persona's prose as of the commit that happened to precede
  // it — an edit made on the Personas page would never reach the next run
  // without a pointless re-commit of every suite in the project. The
  // trade-off is real and worth stating plainly: a run is reproducible in its
  // stories (the pinned snapshot) but NOT in its project persona prose, which
  // can keep changing underneath old snapshots.
  //
  // The snapshot's own files win: a suite that commits its own
  // `personas/<slug>.yaml` shadows a project persona of the same slug, so a
  // suite can still pin/override persona prose when it needs to.
  const suite = await one(ctx, `SELECT project_id FROM suites WHERE id = $1`, [snap.suite_id], `no suite "${snap.suite_id}"`);
  const { rows: personaRows } = await ctx.db.query(
    `SELECT slug, blob_sha256 FROM personas WHERE project_id = $1`,
    [suite.project_id],
  );
  const personaEntries = Object.fromEntries(personaRows.map((r: HostedDynamic) => [personaPath(r.slug), r.blob_sha256]));
  return { id: snap.id, suite_id: snap.suite_id, seq: snap.seq, tree: { ...personaEntries, ...snap.tree } };
}

export async function blob(ctx: HostedDynamic) {
  requireRunner(ctx);
  const sha = ctx.params.sha256;
  if (!/^[0-9a-f]{64}$/.test(sha)) throw badRequest(`invalid blob sha256 "${sha}"`);
  return new HttpResult({ buffer: await ctx.store.get(blobKey(sha)), contentType: "application/octet-stream" });
}

/**
 * The target snapshot THIS attempt recorded — the one its offer already
 * advertised, so a ring edit between poll, claim and exchange cannot make the
 * offer and the group spec disagree.
 *
 * Located by the executor this bearer belongs to, which is exactly the attempt
 * that exchanged. The newest attempt is the fallback for the paths that reach
 * here without an executor binding yet — and for a bearer whose row a later
 * exchange re-stamped (exchange overwrites the attempt's executor_id), where
 * the fallback row IS its own attempt and carries the identical snapshot. The
 * executor match must stay a preference, never a WHERE filter, or that bearer
 * gets a 404 mid-group.
 */
async function attemptTarget(ctx: HostedDynamic, group: HostedDynamic, executorId: HostedDynamic = null) {
  const { rows } = await ctx.db.query(
    `SELECT target FROM dispatches
      WHERE kind = 'group' AND ref_id = $1
      ORDER BY (executor_id = $2) DESC, attempt DESC, requested_at DESC LIMIT 1`,
    [group.id, executorId],
  );
  const target = rows[0]?.target;
  if (!target) throw notFound(`run group "${group.id}" has no dispatch target snapshot`);
  return target;
}

export async function claim(ctx: HostedDynamic) {
  const runner = requireRunner(ctx);
  const group = await getGroup(ctx, runner.run_group_id);
  const body = await readJsonBody(ctx.req);
  const refs = Array.isArray(body.sessions) ? body.sessions : Array.isArray(body.refs) ? body.refs : [];
  // A runner token is scoped to one group: it may claim only the session refs
  // this attempt's ring declares. Without this, any executor in the project
  // could pull mint grants (root secrets) for unrelated providers.
  const target = await attemptTarget(ctx, group, runner.executor_id);
  const allowed = new Set(sessionRefs(target.config || {}));
  for (const ref of refs) {
    if (!allowed.has(ref)) {
      throw forbidden(`session ref "${ref}" is not declared by ring "${target.application_key}/${target.ring_key}"`);
    }
  }
  const claimArgs: HostedDynamic = {
    projectId: group.project_id,
    // Which ring is asking. A provider bound to a DIFFERENT ring is refused
    // here, so a ring can never borrow another ring's credentials.
    ringId: group.ring_id,
    actor: { system: "runner" },
    mintedByJob: runner.executor_id,
  };
  let sessions = await claimSessions(ctx, { ...claimArgs, refs });

  // §3a/§4a hold: refs stuck behind another executor's mint grant are re-checked
  // every second (≤ 25 s, the one waiting idiom) so the waiter picks the session
  // up the moment the winner fulfills — or takes over an expired grant. Refs this
  // executor holds a mint grant for are never re-claimed here (that would leak
  // extra grants); the executor mints and fulfills them.
  const wait = Math.min(Math.max(Number(body.wait || 0), 0), 25);
  const deadline = Date.now() + wait * 1000;
  const waiting = () => Object.keys(sessions).filter((ref) => sessions[ref]?.pending && sessions[ref]?.wait);
  while (wait > 0 && waiting().length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const again = await claimSessions(ctx, { ...claimArgs, refs: waiting() });
    sessions = { ...sessions, ...again };
  }
  return { sessions };
}

export async function fulfill(ctx: HostedDynamic) {
  const runner = requireRunner(ctx);
  const body = await readJsonBody(ctx.req, { limit: 8 * 1024 * 1024 });
  return await fulfillSessionClaim(ctx, {
    claimId: ctx.params.claim,
    executorId: runner.executor_id,
    storageState: body.storage_state ?? null,
    error: body.error ?? null,
    actor: { system: "runner" },
  });
}

export async function uploadBundle(ctx: HostedDynamic) {
  const runner = requireRunner(ctx);
  const run = await runByDbId(ctx, ctx.params.r);
  if (run.run_group_id !== runner.run_group_id) throw forbidden("runner token is not scoped to this run");
  const buf = await readRawBody(ctx.req, { limit: BUNDLE_LIMIT });
  const key = `runs/${run.run_group_id}/${run.id}.ptrun`;
  const stored = await ctx.store.put(key, buf);
  const artifact: HostedDynamic = {
    id: ulid(),
    run_id: run.id,
    kind: "bundle",
    key,
    sha256: stored.sha256,
    size: stored.size,
    tier: "full",
  };
  await ctx.db.query(
    `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (run_id, kind, tier)
       DO UPDATE SET key = EXCLUDED.key, sha256 = EXCLUDED.sha256, size = EXCLUDED.size, verified_at = now()
     RETURNING *`,
    [artifact.id, artifact.run_id, artifact.kind, artifact.key, artifact.sha256, artifact.size, artifact.tier],
  );
  await ctx.db.query(`UPDATE runs SET status = 'uploading', artifact_tier = 'full', updated_at = now() WHERE id = $1`, [run.id]);
  return { artifact };
}

export async function caseStart(ctx: HostedDynamic) {
  const runner = requireRunner(ctx, ctx.params.g);
  const group = await getGroup(ctx, ctx.params.g);
  const run = await runByCoreId(ctx, group.id, ctx.params.run_id);
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `UPDATE runs SET status = 'running', started_at = COALESCE(started_at, now()),
              executor_id = $2, updated_at = now()
        WHERE id = $1`,
      [run.id, runner.executor_id],
    );
    await appendRunEvent(tx, {
      runDbId: run.id,
      projectId: group.project_id,
      type: "case_start",
      payload: { case_id: run.case_id, run_id: run.run_id },
    });
    await emitRunStatus(tx, {
      projectId: group.project_id,
      runGroupId: group.id,
      runDbId: run.id,
      status: "running",
    });
  });
  return { ok: true };
}

// A progress snapshot is one small JSON object, not a report; anything bigger
// is a bug (or an unredacted transcript) and is refused at the door.
const PROGRESS_LIMIT = 32 * 1024;

/**
 * Throttled live-progress snapshot for a case in flight (§Runner protocol):
 * step counter, mode word, last action, cost so far. Telemetry, never
 * load-bearing — it lands only while the run is still moving, so a late tick
 * can never repaint a finished row as live, and a lost one costs nothing.
 * The runner redacts secret values before posting; this end only clamps shape.
 */
export async function caseProgress(ctx: HostedDynamic) {
  requireRunner(ctx, ctx.params.g);
  const group = await getGroup(ctx, ctx.params.g);
  const run = await runByCoreId(ctx, group.id, ctx.params.run_id);
  const body = await readJsonBody(ctx.req, { limit: PROGRESS_LIMIT });
  const progress = progressView(body);
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const updated = await tx.query(
      // `live_activity_at` too: a progress tick is the run showing activity, and
      // the live endpoint's `inactive_ms` is a fact about exactly that.
      `UPDATE runs SET progress = $2, live_activity_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('running','uploading')`,
      [run.id, progress],
    );
    if (updated.rowCount === 0) return;
    wakeLive(tx, run.id);
    await emitPlatformEvent(tx, {
      projectId: group.project_id,
      type: "run.event",
      entity: { run_id: run.id, run_group_id: group.id },
      payload: { type: "progress", case_id: run.case_id, ...progress },
    });
  });
  return { ok: true };
}

/** The stored progress shape: whitelisted fields, clamped lengths — the wire
    body is runner-authored and rides straight into a browser. */
function progressView(body: HostedDynamic) {
  const b = body && typeof body === "object" ? body : {};
  const int = (v: HostedDynamic) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const money = (v: HostedDynamic) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const str = (v: HostedDynamic, max: HostedDynamic) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
  const out: HostedDynamic = {
    step: int(b.step),
    max_steps: int(b.max_steps),
    doing: str(b.doing, 40),
    action: str(b.action, 200),
    cost_usd: money(b.cost_usd),
    model: str(b.model, 80),
  };
  if (b.tokens && typeof b.tokens === "object") {
    const tokens: HostedDynamic = { ctx: int(b.tokens.ctx), in: int(b.tokens.in), out: int(b.tokens.out) };
    if (tokens.ctx != null || tokens.in != null || tokens.out != null) out.tokens = tokens;
  }
  return out;
}

export async function caseReport(ctx: HostedDynamic) {
  const runner = requireRunner(ctx, ctx.params.g);
  const group = await getGroup(ctx, ctx.params.g);
  const run = await runByCoreId(ctx, group.id, ctx.params.run_id);
  const body = await readJsonBody(ctx.req, { limit: 16 * 1024 * 1024 });
  const status = normalizeStatus(body.status);
  const manifest = body.manifest && typeof body.manifest === "object" ? body.manifest : null;
  // The candidate.created payload carries the core diffTracks summary (§4).
  // Computed from the just-uploaded bundle BEFORE the report transaction so
  // object-store reads never hold row locks; a missing/lost bundle degrades to
  // a null summary, never a failed report.
  let diffSummary: HostedDynamic = null;
  if (body.candidate_written) {
    diffSummary = await diffSummaryForRun(ctx, run.id).then((d) => d?.summary ?? null).catch(() => null);
  }
  // Grader-found issues (grade.json bug_candidates + minor/major findings)
  // enter the findings intake path with the report — same outside-the-tx
  // bundle read as the diff summary. Verdictless runs carry no grade.
  const gradeIssues = ["pass", "fail", "explored"].includes(status)
    ? await collectRunGradeIssues(ctx, run.id, manifest)
    : null;
  // Staged live objects to delete once the report commits (see below).
  let stagedKeys: string[] = [];
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `UPDATE runs
          SET status = $2, manifest = $3, totals = $4, score = $5, gate = $6, pins = $7,
              duration_ms = $8, finished_at = now(), executor_id = $9, error = $10,
              healed = $11, changed = $12, progress = NULL, updated_at = now()
        WHERE id = $1`,
      [
        run.id,
        status,
        manifest,
        manifest?.totals ? manifest.totals : body.totals ? body.totals : null,
        Number.isInteger(body.score) ? body.score : manifest?.score ?? null,
        manifest?.result?.gate ? manifest.result.gate : manifest?.gate ? manifest.gate : null,
        manifest?.pins ? manifest.pins : null,
        manifest?.duration_ms ?? body.duration_ms ?? null,
        runner.executor_id,
        body.error ?? manifest?.error ?? null,
        manifest?.healed === true || body.healed === true,
        manifest?.changed === true || body.changed === true,
      ],
    );
    await appendRunEvent(tx, {
      runDbId: run.id,
      projectId: group.project_id,
      type: "case_report",
      payload: { case_id: run.case_id, run_id: run.run_id, status },
    });
    await emitRunStatus(tx, {
      projectId: group.project_id,
      runGroupId: group.id,
      runDbId: run.id,
      status,
    });
    await projectBaselineSideEffects(tx, { group, run, manifest, body, diffSummary, status });
    await emitPlatformEvent(tx, {
      projectId: group.project_id,
      type: "run.finished",
      entity: { run_id: run.id, run_group_id: group.id },
      payload: {
        run: { id: run.id, run_id: run.run_id, case_id: run.case_id, status, score: Number.isInteger(body.score) ? body.score : manifest?.score ?? null },
        run_group_id: group.id,
      },
    });
    if (status === "fail") {
      await emitPlatformEvent(tx, {
        projectId: group.project_id,
        type: "run.failed",
        entity: { run_id: run.id, run_group_id: group.id },
        payload: {
          run: { id: run.id, run_id: run.run_id, case_id: run.case_id, status, error: body.error ?? manifest?.result?.error ?? null },
          run_group_id: group.id,
        },
      });
    }
    await extractFindingFromReport(tx, { projectId: group.project_id, group, run, status, manifest, body });
    await ingestRunGradeFindings(tx, {
      projectId: group.project_id,
      run: { id: run.id, case_id: run.case_id, story_id: run.story_id },
      collected: gradeIssues,
    });
    // Live staging is dropped only when a VERIFIED sealed bundle exists for this
    // run — the artifacts row the bundle PUT wrote, not the report's own claim
    // about one. A terminal report WITHOUT a bundle (a failed upload reporting
    // `infra`, or a reconciler-failed run) keeps its staging through the
    // retention grace window: it is then the only evidence the run produced.
    // Ledger rows go in this transaction; their objects go after it commits.
    const sealed = await tx.query(`SELECT 1 FROM artifacts WHERE run_id = $1 AND kind = 'bundle' LIMIT 1`, [run.id]);
    if (sealed.rows.length) stagedKeys = await dropStaging(tx, run.id);
    // The run just went terminal, so every live holder must learn it is sealed
    // on the next wake rather than at the end of a full hold.
    wakeLive(tx, run.id);
  });
  // Post-commit and best-effort: an object left behind because a delete failed
  // has no ledger row any more, so the retention orphan sweep collects it. A
  // live cleanup failure must never affect the case report.
  for (const key of stagedKeys) {
    try {
      await ctx.store.delete(key);
    } catch (e: HostedDynamic) {
      ctx.log?.warn?.({ msg: "live staging object was not deleted at seal", key, err: e?.message || String(e) });
    }
  }
  // Post-commit, best-effort: this report may have filed unreviewed findings —
  // schedule the debounced semantic dedupe sweep over them.
  if (status === "fail" || gradeIssues) scheduleAutoDedupe(ctx, group.project_id);
  // Any verdict can retire findings — a run that failed at step 8 still proves
  // a step-3 gate check passes now — so the resolve sweep follows every
  // pass/fail report, not only passes. Own timer map and lease (a shared slot
  // would let one sweep silently drop the other).
  if (status === "pass" || status === "fail") scheduleAutoResolve(ctx, group.project_id);
  return { ok: true };
}

export async function complete(ctx: HostedDynamic) {
  const runner = requireRunner(ctx, ctx.params.g);
  const group = await getGroup(ctx, ctx.params.g);
  const body = await readJsonBody(ctx.req);
  let dispatchMore = false;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `UPDATE executors SET concluded_at = now(), last_report_at = now() WHERE id = $1`,
      [runner.executor_id],
    );
    await tx.query(
      `UPDATE dispatches SET status = 'concluded', concluded_at = now()
        WHERE executor_id = $1 AND status IN ('requested','scheduled','running')`,
      [runner.executor_id],
    );
    const remaining = await tx.query(
      `SELECT COUNT(*) AS n FROM runs
        WHERE run_group_id = $1 AND status IN ('queued','running','uploading')`,
      [group.id],
    );
    dispatchMore = body.partial === true && remaining.rows[0].n > 0;
    // A partial WITH an error is a crash, not runtime-budget chunking — bound it
    // to one continuation (same rule as the reconciler) or a start-of-group
    // failure would re-dispatch forever. Budget chunking (partial, no error)
    // makes progress every attempt and stays unbounded by design.
    if (dispatchMore && body.error) {
      const attempts = await tx.query(
        `SELECT COUNT(*) AS n FROM dispatches WHERE kind = 'group' AND ref_id = $1`,
        [group.id],
      );
      if (attempts.rows[0].n >= 2) {
        dispatchMore = false;
        await tx.query(
          `UPDATE runs
              SET status = 'infra', finished_at = COALESCE(finished_at, now()),
                  error = COALESCE(error, $2), updated_at = now()
            WHERE run_group_id = $1 AND status IN ('queued','running','uploading')`,
          [group.id, `executor failed repeatedly: ${String(body.error).split("\n")[0].slice(0, 300)}`],
        );
      }
    }
    if (!dispatchMore) {
      const summary = await exitSummary(tx, group.id);
      // A user cancel may land while the executor is still winding down; its
      // best-effort complete must not flip a canceled group back to done.
      await tx.query(
        `UPDATE run_groups SET status = $2, exit_summary = $3, updated_at = now()
          WHERE id = $1 AND status <> 'canceled'`,
        [group.id, summary.status, summary.exit_summary],
      );
      await audit(tx, {
        actor: { system: "runner" },
        action: "run_group.completed",
        entityType: "run_group",
        entityId: group.id,
        projectId: group.project_id,
        detail: summary.exit_summary,
      });
      await emitPlatformEvent(tx, {
        projectId: group.project_id,
        type: "run.status",
        entity: { run_group_id: group.id },
        payload: { status: summary.status, exit_summary: summary.exit_summary },
      });
    }
  });
  if (dispatchMore) await dispatchContinuation(ctx, group.id);
  return { ok: true, redispatched: dispatchMore };
}

/**
 * Claiming assigns; exchanging authorizes. There is exactly ONE way in: a
 * self-hosted runner presents its registration credential plus the dispatch it
 * CLAIMED on the board. The credential alone resolves no dispatch, so it can
 * never fetch a snapshot, a blob, a session grant, or post a report.
 */
async function resolveExchangeDispatch(ctx: HostedDynamic, body: HostedDynamic) {
  const runner = await requireRunnerCredential(ctx);
  if (!body.dispatch_id) {
    throw badRequest(`"dispatch_id" is required: exchange the claim this runner won on the pool board`);
  }
  const { rows } = await ctx.db.query(
    `SELECT * FROM dispatches
      WHERE id = $1 AND runner_id = $2 AND canceled_at IS NULL
        AND status IN ('requested','scheduled','running')`,
    [String(body.dispatch_id), runner.id],
  );
  if (!rows[0]) {
    throw forbidden(
      `runner "${runner.name}" does not hold an active claim on dispatch "${body.dispatch_id}" — ` +
        `claim it first with POST /api/v1/runner/pool/claims/${body.dispatch_id}`,
    );
  }
  return rows[0];
}

async function resolvedSecrets(ctx: HostedDynamic, projectId: HostedDynamic, ringConfig: HostedDynamic) {
  const names = new Set();
  collectSecretFileNames(ringConfig, names);
  for (const v of Object.values(ringConfig.secret_env || {}) as HostedDynamic) {
    if (typeof v === "string" && !v.startsWith("$session:")) names.add(v);
    if (v && typeof v === "object" && v.$secret_file) names.add(v.$secret_file);
  }
  if (!names.size) return {};
  const wanted = [...names];
  const { rows } = await ctx.db.query(
    `SELECT name, ciphertext FROM secrets WHERE project_id = $1 AND name IN (${inClause(wanted, 2)})`,
    [projectId, ...wanted],
  );
  const byName = new Map(rows.map((r: HostedDynamic) => [r.name, decryptSecret(ctx.config.kmsKey, r.ciphertext)]));
  const missing = [...names].filter((n) => !byName.has(n));
  if (missing.length) throw badRequest(`ring configuration references missing secrets: ${missing.join(", ")}`);
  return Object.fromEntries(byName);
}

function collectSecretFileNames(value: HostedDynamic, out: HostedDynamic) {
  if (Array.isArray(value)) return value.forEach((v) => collectSecretFileNames(v, out));
  if (!value || typeof value !== "object") return;
  if (typeof value.$secret_file === "string") out.add(value.$secret_file);
  for (const v of Object.values(value)) collectSecretFileNames(v, out);
}

function sessionRefs(ringConfig: HostedDynamic) {
  const refs = new Set();
  for (const v of Object.values(ringConfig.auth?.identities || {})) collectSessionRefs(v, refs);
  for (const v of Object.values(ringConfig.secret_env || {})) collectSessionRefs(v, refs);
  return [...refs].sort();
}

function collectSessionRefs(value: HostedDynamic, refs: HostedDynamic) {
  if (typeof value === "string" && value.startsWith("$session:")) refs.add(value.slice("$session:".length));
  if (value && typeof value === "object") {
    if (typeof value.$session === "string") refs.add(value.$session);
    for (const v of Object.values(value)) collectSessionRefs(v, refs);
  }
}

async function projectBaselineSideEffects(tx: HostedDynamic, { group, run, manifest, body, diffSummary = null, status = null }: HostedDynamic) {
  const artifactKey = body.bundle?.key || null;
  if (!manifest || !artifactKey) return;
  // A clean pass proves the current baseline still replays. Any pending heal
  // candidate for this story diffs against a baseline the app just matched, so
  // accepting it now would regress the baseline — supersede, exactly as a
  // fresh recording does, so review queues and needs-attention stop showing a
  // decision that no longer exists. The flags mirror what the run row stored.
  const healed = manifest?.healed === true || body.healed === true;
  const changed = manifest?.changed === true || body.changed === true;
  if (status === "pass" && !healed && !changed && !body.baseline_written && !body.candidate_written) {
    await supersedePendingCandidates(tx, { group, run });
  }
  if (body.baseline_written) {
    const version = await tx.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM baselines WHERE suite_id = $1 AND story_id = $2`,
      [group.suite_id, run.story_id],
    );
    const baselineId = ulid();
    await tx.query(
      `INSERT INTO baselines
         (id, project_id, suite_id, story_id, version, trajectory_key, meta, accepted_from_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        baselineId,
        group.project_id,
        group.suite_id,
        run.story_id,
        version.rows[0].version,
        `${artifactKey}#trajectory.jsonl`,
        body.baseline_written,
        run.id,
      ],
    );
    // Core accept semantics: a new baseline version supersedes the old (§1).
    await tx.query(
      `UPDATE baselines SET superseded_by = $3, updated_at = now()
        WHERE suite_id = $1 AND story_id = $2 AND superseded_by IS NULL AND id <> $3`,
      [group.suite_id, run.story_id, baselineId],
    );
    // A fresh recording makes older pending heal candidates stale review items —
    // the same supersede a reviewer's accept applies (§1 review).
    await supersedePendingCandidates(tx, { group, run, baselineId });
  }
  if (body.candidate_written) {
    const candidateId = ulid();
    await tx.query(
      `INSERT INTO candidates
         (id, project_id, suite_id, story_id, run_id, trajectory_key, meta, status, diff_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [
        candidateId,
        group.project_id,
        group.suite_id,
        run.story_id,
        run.id,
        `${artifactKey}#trajectory.jsonl`,
        body.candidate_written,
        diffSummary ?? null,
      ],
    );
    // §4: candidate.created carries {candidate, run, diff_summary} so the review
    // badge reacts without a bundle read of its own. The entity
    // carries the run ids so group dashboards can route it to their group.
    await emitPlatformEvent(tx, {
      projectId: group.project_id,
      type: "candidate.created",
      entity: { candidate_id: candidateId, story_id: run.story_id, run_id: run.id, run_group_id: group.id },
      payload: {
        candidate: { id: candidateId, story_id: run.story_id, case_id: run.case_id, run_id: run.id },
        run: { id: run.id, run_id: run.run_id, case_id: run.case_id },
        diff_summary: diffSummary,
      },
    });
  }
}

/** Flip every pending candidate for the run's story to superseded and emit
    candidate.superseded when any flipped, so review badges/queues re-count
    instead of showing pending rows that no longer exist. */
async function supersedePendingCandidates(tx: HostedDynamic, { group, run, baselineId = null }: HostedDynamic) {
  const superseded = await tx.query(
    `UPDATE candidates
        SET status = 'superseded', resolved_at = now(), updated_at = now()
      WHERE suite_id = $1 AND story_id = $2 AND status = 'pending'
      RETURNING id`,
    [group.suite_id, run.story_id],
  );
  if (superseded.rows.length) {
    await emitPlatformEvent(tx, {
      projectId: group.project_id,
      type: "candidate.superseded",
      entity: { story_id: run.story_id, run_group_id: group.id },
      payload: { candidate_ids: superseded.rows.map((r: HostedDynamic) => r.id), story_id: run.story_id, baseline_id: baselineId },
    });
  }
}

export async function exitSummary(q: HostedDynamic, groupId: HostedDynamic) {
  const { rows } = await q.query(`SELECT case_id, status, mode, run_id, error FROM runs WHERE run_group_id = $1 ORDER BY case_id`, [
    groupId,
  ]);
  const anyFail = rows.some((r: HostedDynamic) => r.status === "fail");
  const anyInfra = rows.some((r: HostedDynamic) => ["infra", "lost", "canceled"].includes(r.status));
  return {
    status: "done",
    exit_summary: {
      exit_code: anyFail ? 1 : anyInfra ? 2 : 0,
      cases: rows.map((r: HostedDynamic) => ({ id: r.case_id, status: r.status, mode: r.mode, run_id: r.run_id, error: r.error })),
    },
  };
}

function normalizeStatus(status: HostedDynamic) {
  if (["pass", "fail", "infra", "explored", "canceled", "lost"].includes(status)) return status;
  throw badRequest(`invalid case status "${status}"`);
}

async function getGroup(ctx: HostedDynamic, id: HostedDynamic) {
  return await one(ctx, `SELECT * FROM run_groups WHERE id = $1`, [id], `no run group "${id}"`);
}

async function runByCoreId(ctx: HostedDynamic, groupId: HostedDynamic, runId: HostedDynamic) {
  return await one(ctx, `SELECT * FROM runs WHERE run_group_id = $1 AND run_id = $2`, [groupId, runId], `no run "${runId}" in this group`);
}

async function runByDbId(ctx: HostedDynamic, id: HostedDynamic) {
  return await one(ctx, `SELECT * FROM runs WHERE id = $1`, [id], `no run "${id}"`);
}

async function one(ctx: HostedDynamic, sql: HostedDynamic, params: HostedDynamic, message: HostedDynamic) {
  const { rows } = await ctx.db.query(sql, params);
  if (!rows[0]) throw notFound(message);
  return rows[0];
}
