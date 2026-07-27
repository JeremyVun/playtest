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
// Claiming assigns work. It grants nothing: the runner must still exchange its
// credential for a short-lived bearer scoped to that one group or mint claim
// before it can read a snapshot or post a report.
import { audit } from "../audit.ts";
import { readJsonBody } from "../http.ts";
import { conflict, forbidden, notFound } from "../errors.ts";
import { requireRunnerCredential, labelsMatch } from "../auth/runner-credentials.ts";
import { holdUntil } from "../events/hold.ts";
import { emitPlatformEvent } from "../events/outbox.ts";

/** Hold window cap, the same one the browser feed uses. */
const MAX_WAIT_S = 25;

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
  await ctx.db.query(
    `UPDATE runners SET last_seen_at = now(), labels = $2 WHERE id = $1`,
    [runner.id, labels],
  );

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
