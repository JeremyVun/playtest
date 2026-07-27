// The runner claim board: check in, claim, heartbeat. Every request here is a
// self-hosted runner dialling OUT with its registration credential; the control
// plane never connects to a runner (docs/contracts/hosted.md, "Runner pool").
//
// The three routes are deliberately small, because the board is not a queue —
// it is a view over `dispatches` rows that are already the ledger:
//
//   GET  /runner/pool/claims?wait=true   the oldest unclaimed, label-eligible
//                                        entry in this runner's project, held on
//                                        the feed's discipline (post-commit wake,
//                                        bounded rescan, correctness from the row)
//   POST /runner/pool/claims/:dispatch   BEGIN IMMEDIATE, precondition restated
//                                        in the mutating WHERE: exactly one winner
//   POST /runner/pool/claims/:d/heartbeat coarse liveness + the cancel signal
//
// A fourth route stands slightly apart: `POST /runner/pool/register-oidc` is how
// a CI job JOINS the pool for the length of one pipeline run, presenting a
// GitHub OIDC token rather than a credential it was given in advance.
//
// Claiming assigns work. It grants nothing: the runner must still exchange its
// credential for a short-lived bearer scoped to that one group or mint claim
// before it can read a snapshot or post a report.
import { audit } from "../audit.ts";
import { created, readJsonBody } from "../http.ts";
import { AppError, badRequest, conflict, forbidden, notFound } from "../errors.ts";
import {
  newRunnerCredential,
  normalizeLabels,
  requireRunnerCredential,
  labelsMatch,
} from "../auth/runner-credentials.ts";
import { verifyGithubOidc } from "../auth/github-oidc.ts";
import { runnerView as registryRunnerView, emitRunnerStatus } from "./runners.ts";
import { ulid } from "../ulid.ts";
import { randomBytes } from "node:crypto";
import { holdUntil } from "../events/hold.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { checkInWindowMs } from "../dispatch/pool.ts";

/** Hold window cap, the same one the browser feed uses. */
const MAX_WAIT_S = 25;

/**
 * How many live ephemeral runners one verified workflow run may register. A
 * pipeline needs one; a handful of parallel jobs in the same run need a few. The
 * cap exists because an OIDC token is replayable for its own short lifetime, so
 * a leaked one must not be able to fill the table.
 */
const MAX_EPHEMERAL_PER_RUN = 8;

/**
 * POST /runner/pool/register-oidc — join the pool for one CI job.
 *
 * The GitHub OIDC token IS the registration badge: it is signed by GitHub,
 * scoped to one workflow run, and validated by the same verifier the
 * GitHub-dispatch exchange uses (`auth/github-oidc.ts`) against the deployment's
 * pinned issuer, audience, repository, workflow file and ref. No long-lived
 * secret lands in repository settings, and the credential this mints expires
 * with the job rather than outliving it in someone's settings page.
 *
 * Three properties make it safe to expose unauthenticated:
 *
 *   1. **It refuses to run unpinned.** Without `PLAYTEST_POOL_OIDC_REPOSITORY`
 *      the route is `503 not_configured`, because an unpinned check would accept
 *      a token from any repository on GitHub. Naming which repository may
 *      register is a deliberate deployment decision, exactly like naming the
 *      repository GitHub dispatch places workflows into.
 *   2. **The registration is ephemeral.** It expires (`pool.oidc.ttlMs`), it is
 *      never listed as a standing runner, and its verified provenance is stored
 *      beside it, so a reviewer can see which build produced a runner.
 *   3. **It grants no more than a registration.** The credential still has to
 *      claim a dispatch and then exchange for a scoped bearer, and it can only
 *      ever reach jobs in the one project this call names.
 */
export async function registerViaOidc(ctx: HostedDynamic) {
  const pool = ctx.config.dispatch.pool;
  if (!pool.enabled) {
    throw new AppError(
      "not_configured",
      `this deployment does not place runs on a self-hosted runner pool, so there is no board for a CI ` +
        `runner to join — it needs PLAYTEST_DISPATCH=pool`,
    );
  }
  if (!pool.oidc.repository) {
    throw new AppError(
      "not_configured",
      `ephemeral CI runner registration is not enabled: set PLAYTEST_POOL_OIDC_REPOSITORY to the ` +
        `repository whose workflows may register runners (e.g. acme/storefront). Until it names one, a ` +
        `GitHub OIDC token from ANY repository would be accepted, so this route stays closed.`,
    );
  }

  const body = await readJsonBody(ctx.req);
  const projectKey = String(body.project || "").trim();
  if (!projectKey) {
    throw badRequest(`"project" is required: name the project this CI runner registers in`);
  }
  const labels = normalizeLabels(body.labels);
  // Verified BEFORE the project is looked up, so an unauthenticated caller
  // cannot use this route to probe which project keys exist.
  const claims = await verifyGithubOidc(pool.oidc, body.github_oidc_token);

  const { rows: projects } = await ctx.db.query(`SELECT * FROM projects WHERE key = $1`, [projectKey]);
  const project = projects[0];
  if (!project) throw notFound(`no project "${projectKey}"`);

  const runId = String(claims.run_id || "");
  const runAttempt = String(claims.run_attempt || "1");
  if (!runId) throw badRequest("GitHub OIDC token has no run_id claim, so this registration cannot be bounded");

  const now = Date.now();
  const expiresAt = new Date(now + pool.oidc.ttlMs);
  const { rows: live } = await ctx.db.query(
    `SELECT COUNT(*) AS n FROM runners
      WHERE project_id = $1 AND ephemeral = 1 AND revoked_at IS NULL AND expires_at > $2
        AND json_extract(source, '$.run_id') = $3`,
    [project.id, new Date(now), runId],
  );
  if (live[0].n >= MAX_EPHEMERAL_PER_RUN) {
    throw conflict(
      `workflow run ${runId} already has ${live[0].n} live ephemeral runners in project "${project.key}" ` +
        `(the cap is ${MAX_EPHEMERAL_PER_RUN}) — register one runner per job, not one per step`,
    );
  }

  // The name comes from the VERIFIED token, never from the request: a CI job
  // must not be able to register under a standing runner's name, and run history
  // reads better when the runner says which build it was.
  const name = `ci-${runId}.${runAttempt}-${randomBytes(3).toString("hex")}`;
  const source = {
    repository: claims.repository ?? null,
    workflow_ref: claims.job_workflow_ref ?? claims.workflow_ref ?? null,
    ref: claims.ref ?? null,
    sha: claims.sha ?? null,
    run_id: runId,
    run_attempt: runAttempt,
  };
  const id = ulid();
  const { plaintext, hash } = newRunnerCredential();

  const row = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `INSERT INTO runners (id, project_id, name, labels, credential_hash, ephemeral, expires_at, source)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7) RETURNING *`,
      [id, project.id, name, labels, hash, expiresAt, source],
    );
    await audit(tx, {
      // No user is behind this: the actor is the verified workflow run itself.
      actor: { system: "github_oidc" },
      action: "runner.registered",
      entityType: "runner",
      entityId: id,
      projectId: project.id,
      detail: { name, labels, ephemeral: true, expires_at: expiresAt.toISOString(), source },
    });
    return rows[0];
  });

  // The one time the credential is ever revealed — the same rule registration in
  // the console follows, for the same reason: only a hash is stored.
  return created({ ...registryRunnerView(row), credential: plaintext });
}

/**
 * GET /runner/pool/claims?wait=true[&labels=a,b] — check in and long-poll.
 *
 * Answers with the oldest unclaimed dispatch (kind `group` OR `mint` — session
 * minting places through the same path and must be served) whose label set is a
 * subset of this runner's, scoped to the runner's own project. Empty job labels
 * match any runner in the project.
 *
 * This route only OFFERS. Claiming is the POST below, so two runners waking on
 * the same signal both see the offer and exactly one of them wins the race.
 */
export async function pollClaims(ctx: HostedDynamic) {
  const runner = await requireRunnerCredential(ctx);
  const labels = advertisedLabels(ctx, runner);
  await checkIn(ctx, runner, labels);

  // One runner executes one group at a time (v1). A runner that already holds a
  // claim is told which one instead of being offered more work — that is also
  // how an agent restarted mid-group finds what it was doing.
  const current = await activeClaim(ctx, runner.id);
  if (current) {
    return { runner: runnerView(runner, labels), claim: null, current: offerView(current) };
  }

  const load = async () => {
    const { rows } = await ctx.db.query(
      // Oldest first, and label matching is subset semantics restated in SQL:
      // no label this job wants may be missing from what the runner advertises.
      // json_each over the stored arrays keeps the match in the same read that
      // orders the board, so a poll is one query however long the board is.
      `SELECT d.id, d.kind, d.ref_id, d.attempt, d.labels, d.requested_at, d.project_id
         FROM dispatches d
        WHERE d.project_id = $1
          AND d.kind IN ('group','mint')
          AND d.status = 'requested'
          AND d.claimed_at IS NULL
          AND d.canceled_at IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM json_each(COALESCE(d.labels, '[]')) want
                 WHERE want.value NOT IN (SELECT value FROM json_each($2)))
        ORDER BY d.requested_at, d.id
        LIMIT 1`,
      [runner.project_id, labels],
    );
    return rows;
  };

  let rows = await load();
  const wait = waitSeconds(ctx.query.get("wait"));
  if (!rows.length && wait > 0) rows = await holdUntil(ctx, runner.project_id, wait, load);
  const offer = rows[0];
  return { runner: runnerView(runner, labels), claim: offer ? offerView(offer) : null, current: null };
}

/**
 * Record a check-in, and tell the project when one CHANGES what a reader sees.
 *
 * Every poll and every heartbeat lands here, which is far too often to put on
 * the event feed: a fleet of ten idle runners would emit an event every two and
 * a half seconds forever, and a console watching the feed would repaint for
 * nothing each time. What a reader actually sees move is the EDGE — a runner
 * that was absent (never seen, or silent past the window the platform itself
 * stops believing in) is now here. That is rare, so it rides the feed; staying
 * online is silence, and going offline is arithmetic on `last_seen_at` the
 * console can do without asking. Re-advertised labels are the same kind of
 * edge, so they emit too.
 *
 * @returns whether this check-in was the runner coming back.
 */
async function checkIn(ctx: HostedDynamic, runner: HostedDynamic, labels: string[]) {
  const windowMs = checkInWindowMs(ctx.config.dispatch.pool);
  const last = runner.last_seen_at ? new Date(runner.last_seen_at).getTime() : 0;
  const returning = !(Date.now() - last < windowMs);
  const relabelled = JSON.stringify(runner.labels || []) !== JSON.stringify(labels);
  if (!returning && !relabelled) {
    await ctx.db.query(`UPDATE runners SET last_seen_at = now() WHERE id = $1`, [runner.id]);
    return false;
  }
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`UPDATE runners SET last_seen_at = now(), labels = $2 WHERE id = $1`, [runner.id, labels]);
    await emitRunnerStatus(tx, runner, { state: "online", labels });
  });
  return returning;
}

/** The dispatch this runner is already executing, if any. */
async function activeClaim(ctx: HostedDynamic, runnerId: string) {
  const { rows } = await ctx.db.query(
    `SELECT * FROM dispatches
      WHERE runner_id = $1 AND status IN ('requested','scheduled','running')
      ORDER BY claimed_at LIMIT 1`,
    [runnerId],
  );
  return rows[0] ?? null;
}

/**
 * POST /runner/pool/claims/:dispatch — claim it.
 *
 * One `BEGIN IMMEDIATE` transaction whose mutating UPDATE restates the entire
 * precondition — still `requested`, still unclaimed, not canceled, the runner
 * still live and still in this project, the labels still a subset. Exactly one
 * concurrent runner wins (transaction guarantee #2); the loser is told what
 * happened and goes back to polling.
 *
 * The winning claim moves the dispatch to `scheduled` and emits the same
 * `run.status` provisioning event GitHub dispatch emits when it places a group.
 */
export async function claimDispatch(ctx: HostedDynamic) {
  const runner = await requireRunnerCredential(ctx);
  const dispatchId = ctx.params.dispatch;

  const claimed = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(`SELECT * FROM dispatches WHERE id = $1 AND project_id = $2`, [
      dispatchId,
      runner.project_id,
    ]);
    const dispatch = rows[0];
    if (!dispatch) throw notFound(`no dispatch "${dispatchId}" on this project's claim board`);
    if (!labelsMatch(dispatch.labels || [], runner.labels || [])) {
      throw conflict(
        `dispatch "${dispatchId}" needs the labels ${(dispatch.labels || []).map((l: string) => `"${l}"`).join(", ")}, ` +
          `which runner "${runner.name}" does not advertise`,
      );
    }
    const held = await activeClaim(ctx, runner.id);
    if (held && held.id !== dispatchId) {
      throw conflict(
        `runner "${runner.name}" is already executing dispatch "${held.id}" — a runner takes one group at a time`,
      );
    }
    // Idempotent for the winner: re-claiming what it already holds is not a race.
    if (held && held.id === dispatchId) return held;
    const won = await tx.query(
      `UPDATE dispatches
          SET status = 'scheduled', runner_id = $2, claimed_at = now(), heartbeat_at = now()
        WHERE id = $1
          AND status = 'requested'
          AND claimed_at IS NULL
          AND canceled_at IS NULL
          AND kind IN ('group','mint')
          AND project_id = (SELECT project_id FROM runners WHERE id = $2 AND revoked_at IS NULL)
          AND NOT EXISTS (
                SELECT 1 FROM dispatches held
                 WHERE held.runner_id = $2 AND held.status IN ('requested','scheduled','running'))
          AND NOT EXISTS (
                SELECT 1 FROM json_each(COALESCE(dispatches.labels, '[]')) want
                 WHERE want.value NOT IN (
                   SELECT value FROM json_each((SELECT COALESCE(labels, '[]') FROM runners WHERE id = $2))))
        RETURNING *`,
      [dispatchId, runner.id],
    );
    if (!won.rows[0]) throw claimLost(ctx, dispatch, runner);
    const row = won.rows[0];
    await tx.query(`UPDATE runners SET last_seen_at = now() WHERE id = $1`, [runner.id]);
    if (row.kind === "group") {
      await tx.query(`UPDATE run_groups SET status = 'running', updated_at = now() WHERE id = $1`, [row.ref_id]);
      await emitPlatformEvent(tx, {
        projectId: row.project_id,
        type: "run.status",
        entity: { run_group_id: row.ref_id },
        payload: { status: "provisioning", dispatch_id: row.id, workflow_run_url: null, runner: { id: runner.id, name: runner.name } },
      });
    }
    // The fleet moved: this runner is busy now, and the console's Runners
    // section links the claim to the run it is executing.
    await emitRunnerStatus(tx, runner, {
      state: "claimed",
      dispatch_id: row.id,
      kind: row.kind,
      run_group_id: row.kind === "group" ? row.ref_id : null,
    });
    await audit(tx, {
      actor: { system: "runner" },
      action: "runner.claimed",
      entityType: "dispatch",
      entityId: row.id,
      projectId: row.project_id,
      detail: { runner_id: runner.id, runner: runner.name, kind: row.kind, ref_id: row.ref_id, labels: row.labels || [] },
    });
    return row;
  });

  return {
    claimed: true,
    ...offerView(claimed),
    // How often to check in: comfortably inside the window the reconciler
    // declares this runner gone, so a slow group is never mistaken for a dead one.
    heartbeat_interval_s: Math.max(5, Math.round(ctx.config.dispatch.pool.heartbeatTimeoutMs / 1000 / 4)),
  };
}

/**
 * POST /runner/pool/claims/:dispatch/heartbeat — coarse group-level liveness
 * between claim and completion (case-level telemetry stays the progress route).
 * It exists so the reconciler can tell "slow" from "gone" before the first case
 * starts and after the last one ends, and so a cancel reaches a runner the
 * control plane cannot call.
 */
export async function heartbeatClaim(ctx: HostedDynamic) {
  const runner = await requireRunnerCredential(ctx);
  await readJsonBody(ctx.req); // drained; the heartbeat carries no state today
  const { rows } = await ctx.db.query(
    `SELECT d.*, g.status AS group_status FROM dispatches d
       LEFT JOIN run_groups g ON d.kind = 'group' AND g.id = d.ref_id
      WHERE d.id = $1 AND d.project_id = $2`,
    [ctx.params.dispatch, runner.project_id],
  );
  const dispatch = rows[0];
  if (!dispatch) throw notFound(`no dispatch "${ctx.params.dispatch}" on this project's claim board`);
  if (dispatch.runner_id !== runner.id) {
    throw forbidden(`dispatch "${dispatch.id}" is not claimed by runner "${runner.name}"`);
  }
  const canceled = dispatch.canceled_at != null || dispatch.group_status === "canceled";
  await ctx.db.query(`UPDATE dispatches SET heartbeat_at = now() WHERE id = $1`, [dispatch.id]);
  await ctx.db.query(`UPDATE runners SET last_seen_at = now() WHERE id = $1`, [runner.id]);
  // `canceled: true` is the runner's cue to run the same teardown the local
  // adapter's child runs on SIGTERM. Case reports for finished cases are still
  // accepted afterwards; the group's own status is what a reader sees.
  return { ok: true, canceled, status: dispatch.status };
}

/** Why this runner lost, read after the failed UPDATE inside the same transaction. */
function claimLost(ctx: HostedDynamic, before: HostedDynamic, runner: HostedDynamic) {
  if (before.claimed_at || before.status !== "requested") {
    return conflict(`dispatch "${before.id}" was already claimed by another runner`);
  }
  if (before.canceled_at) return conflict(`dispatch "${before.id}" was canceled before it was claimed`);
  return conflict(
    `dispatch "${before.id}" is no longer claimable by runner "${runner.name}" — it was taken, canceled, ` +
      `or the runner was revoked while claiming`,
  );
}

/** Who the presenting credential is, and what it advertises right now. */
const runnerView = (runner: HostedDynamic, labels: string[]) => ({
  id: runner.id,
  name: runner.name,
  labels,
  project_id: runner.project_id,
  project_key: runner.project_key ?? null,
});

/** The board entry a runner acts on: what to execute and how to exchange for it. */
const offerView = (d: HostedDynamic) => ({
  dispatch_id: d.id,
  kind: d.kind,
  ref_id: d.ref_id,
  run_group_id: d.kind === "group" ? d.ref_id : null,
  mint_claim_id: d.kind === "mint" ? d.ref_id : null,
  attempt: d.attempt ?? null,
  labels: d.labels || [],
  requested_at: d.requested_at ?? null,
  claimed_at: d.claimed_at ?? null,
});

/** The runner's advertised labels for this check-in: `?labels=` when present. */
function advertisedLabels(ctx: HostedDynamic, runner: HostedDynamic): string[] {
  const raw = ctx.query.get("labels");
  if (raw == null) return runner.labels || [];
  // Labels are untrusted routing input and confer no authority — the credential
  // is the boundary — so a runner may re-advertise its own at check-in. It can
  // only ever reach jobs in the project its credential is registered to.
  return [...new Set(String(raw).split(",").map((l) => l.trim()).filter(Boolean))];
}

function waitSeconds(raw: unknown): number {
  if (raw == null || raw === "" || raw === "false" || raw === "0") return 0;
  if (raw === "true") return MAX_WAIT_S;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_WAIT_S);
}
