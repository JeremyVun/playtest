import { audit } from "../audit.ts";
import { appendRunEvent, emitRunStatus } from "../events/run-events.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { dispatchContinuation } from "./dispatcher.ts";
import { terminateMintDispatch } from "./sessions.ts";
import { exitSummary } from "../api/executor-api.ts";
import { inClause } from "../db.ts";
import {
  ACTIVE_DISPATCH_STATES,
  concludeDispatch,
  killDispatch,
  markDispatchRunning,
  settleGroupDone,
} from "./state.ts";

const ACTIVE = ACTIVE_DISPATCH_STATES;

/**
 * Lease name for the reconciliation cycle (see `src/leases.ts`). The scheduled
 * tick in `app.ts` holds it; direct callers (tests, one-shot tooling) drive the
 * pass themselves and do not, exactly as before.
 */
export const RECONCILE_LEASE = "reconcile";

export async function reconcileDispatches(ctx: HostedDynamic, { limit = 50 } = {}) {
  const { rows } = await ctx.db.query(
    `SELECT * FROM dispatches
      WHERE kind IN ('group','mint') AND status IN (${inClause(ACTIVE, 1)})
      ORDER BY requested_at LIMIT $${ACTIVE.length + 1}`,
    [...ACTIVE, limit],
  );
  const results: HostedDynamic[] = [];
  for (const d of rows) results.push(await reconcileOne(ctx, d));
  // Older completion code could settle a group while leaving a pre-restart
  // story `running`. Those groups have no active dispatch left for the normal
  // scan above to inspect, so repair the impossible parent/child state
  // independently. This keeps the fix self-healing for rows already on disk.
  await repairSettledGroups(ctx, { limit });
  return results;
}

async function repairSettledGroups(ctx: HostedDynamic, { limit }: { limit: number }) {
  const { rows: groups } = await ctx.db.query(
    `SELECT DISTINCT g.id, g.project_id, g.status
       FROM run_groups g
       JOIN runs r ON r.run_group_id = g.id
      WHERE g.status IN ('done','canceled')
        AND r.status IN ('queued','running','uploading')
      ORDER BY g.updated_at, g.id
      LIMIT $1`,
    [limit],
  );
  for (const candidate of groups) {
    let count = 0;
    await ctx.db.withTx(async (tx: HostedDynamic) => {
      const group = (
        await tx.query(`SELECT * FROM run_groups WHERE id = $1 AND status IN ('done','canceled')`, [candidate.id])
      ).rows[0];
      if (!group) return;
      const { rows: runs } = await tx.query(
        `SELECT * FROM runs
          WHERE run_group_id = $1 AND status IN ('queued','running','uploading')
          ORDER BY case_id`,
        [group.id],
      );
      const status = group.status === "canceled" ? "canceled" : "infra";
      const reason =
        group.status === "canceled"
          ? "run group was canceled before this story completed"
          : "runner restarted before this story completed";
      for (const run of runs) {
        const updated = await tx.query(
          `UPDATE runs
              SET status = $2, finished_at = now(), error = $3,
                  progress = NULL, updated_at = now()
            WHERE id = $1 AND status IN ('queued','running','uploading')`,
          [run.id, status, reason],
        );
        if (updated.rowCount === 0) continue;
        count += 1;
        await appendRunEvent(tx, {
          runDbId: run.id,
          projectId: group.project_id,
          type: "case_report",
          payload: { case_id: run.case_id, status, error: reason },
        });
        await emitRunStatus(tx, {
          projectId: group.project_id,
          runGroupId: group.id,
          runDbId: run.id,
          status,
        });
      }
      if (!count) return;
      const summary = await exitSummary(tx, group.id);
      await tx.query(`UPDATE run_groups SET exit_summary = $2, updated_at = now() WHERE id = $1`, [
        group.id,
        summary.exit_summary,
      ]);
      await audit(tx, {
        actor: { system: "reconciler" },
        action: "run_group.repaired",
        entityType: "run_group",
        entityId: group.id,
        projectId: group.project_id,
        detail: { repaired_runs: count, status },
      });
      await emitPlatformEvent(tx, {
        projectId: group.project_id,
        type: "run.status",
        entity: { run_group_id: group.id },
        payload: { status: group.status, exit_summary: summary.exit_summary },
      });
    });
  }
}

async function reconcileOne(ctx: HostedDynamic, dispatch: HostedDynamic) {
  // The board entry, read by dispatch id: unclaimed and still inside its claim
  // window is `queued`, claimed and heartbeating is `in_progress`, and anything
  // else is a loss the board explains itself.
  const status = await ctx.board.dispatchStatus(dispatch.id);
  if (!status) return { dispatch_id: dispatch.id, action: "unknown_dispatch" };
  if (status.status === "queued") return { dispatch_id: dispatch.id, action: "queued" };
  if (status.status === "in_progress") {
    // A compare-and-set, not a stamp. The board was read before this write, and
    // a completion or a cancel landing in that gap is the winner: losing here is
    // harmless and reported as what actually happened.
    const moved = await markDispatchRunning(ctx.db, dispatch.id);
    return { dispatch_id: dispatch.id, action: moved.ok ? "running" : "already_concluded" };
  }
  if (status.status !== "completed") return { dispatch_id: dispatch.id, action: status.status || "unknown" };

  // The board says whether re-placing the remainder can help. Pull-based
  // placement has a loss shape a pushed job does not — nothing ever picked the
  // work up — and re-posting to a board no runner is watching would only fail
  // again, so it answers `redispatch: false` with a message naming the labels
  // nothing checked in to serve.
  return await markDead(ctx, dispatch, {
    reason: status.reason || `the executor concluded without completing this group (${status.conclusion || "unknown"})`,
    redispatch: status.redispatch !== false,
  });
}

/**
 * A dispatch's executor is gone (concluded without `complete`, never appeared,
 * or — under pull-based placement — never claimed or stopped heartbeating).
 * Mark it reconciled_dead, fail in-flight cases as infra, and re-dispatch the
 * queued remainder once (bounded). Returns the reconcile action result.
 */
async function markDead(ctx: HostedDynamic, dispatch: HostedDynamic, { reason, redispatch = true }: HostedDynamic) {
  if (dispatch.kind === "mint") return await markMintDead(ctx, dispatch, { reason });
  const group = await getGroup(ctx, dispatch.ref_id);

  let action = "dead";
  let shouldRedispatch = false;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    // Both preconditions are read AND acted on inside one transaction, and each
    // is restated in the write that depends on it — the discipline the claim
    // UPDATE, the mint bind and the fulfill all keep. The race this closes is a
    // laptop waking up: an executor everything here believes is gone is in fact
    // mid-`complete`, and a check that ran before the transaction would let this
    // pass flip a concluded dispatch to dead and stamp an uploading run infra.
    const completed = await tx.query(
      `SELECT 1 FROM run_groups WHERE id = $1 AND status IN ('done','canceled')`,
      [group.id],
    );
    if (completed.rows.length) {
      await concludeDispatch(tx, dispatch.id);
      action = "already_complete";
      return;
    }
    const killed = await killDispatch(tx, dispatch.id, { error: reason });
    // Losing this write means the executor concluded between the board read and
    // this statement: it was alive after all. Nothing else in this pass may run —
    // no run is failed as infra, and no continuation is posted, because the
    // executor's own `complete` has already decided both.
    if (!killed.ok) {
      action = "already_concluded";
      return;
    }
    const running = await tx.query(
      `SELECT * FROM runs
        WHERE run_group_id = $1 AND status IN ('running','uploading')
        ORDER BY case_id`,
      [group.id],
    );
    for (const run of running.rows) {
      await tx.query(
        `UPDATE runs SET status = 'infra', finished_at = now(), error = $2, progress = NULL, updated_at = now()
          WHERE id = $1`,
        [run.id, `runner died: ${dispatch.id}`],
      );
      await appendRunEvent(tx, {
        runDbId: run.id,
        projectId: group.project_id,
        type: "case_report",
        payload: { case_id: run.case_id, status: "infra", error: "runner died" },
      });
      await emitRunStatus(tx, {
        projectId: group.project_id,
        runGroupId: group.id,
        runDbId: run.id,
        status: "infra",
      });
    }
    const queued = await tx.query(
      `SELECT COUNT(*) AS n FROM runs WHERE run_group_id = $1 AND status = 'queued'`,
      [group.id],
    );
    const attempts = await tx.query(
      `SELECT COUNT(*) AS n FROM dispatches WHERE kind = 'group' AND ref_id = $1`,
      [group.id],
    );
    shouldRedispatch = redispatch && queued.rows[0].n > 0 && attempts.rows[0].n < 2;
    await audit(tx, {
      actor: { system: "reconciler" },
      action: "dispatch.dead",
      entityType: "dispatch",
      entityId: dispatch.id,
      projectId: group.project_id,
      detail: { reason, redispatch: shouldRedispatch },
    });
    await emitPlatformEvent(tx, {
      projectId: group.project_id,
      type: "dispatch.dead",
      entity: { dispatch_id: dispatch.id, run_group_id: group.id },
      payload: { redispatch: shouldRedispatch },
    });
    if (!shouldRedispatch) {
      const pending = await tx.query(
        `SELECT * FROM runs WHERE run_group_id = $1 AND status = 'queued'`,
        [group.id],
      );
      // An adapter that refused re-placement has already explained why in terms
      // a person can act on ("no runner with label X has checked in…"); that
      // belongs on the stories that never ran, not the anonymous default, which
      // would hide the remedy behind a log line.
      const startError = redispatch === false && reason ? reason : "runner died before case started";
      for (const run of pending.rows) {
        await tx.query(
          `UPDATE runs SET status = 'infra', finished_at = now(), error = $2, progress = NULL, updated_at = now()
            WHERE id = $1`,
          [run.id, startError],
        );
      }
      // Same exit_summary shape as the executor's `complete` — without it the
      // runs index paints a dead group as a neutral "done" chip, hiding the
      // failure at the triage entry point.
      const summary = await exitSummary(tx, group.id);
      await settleGroupDone(tx, group.id, summary.exit_summary);
    }
  });
  if (shouldRedispatch) {
    // The continuation restates "this group has no live attempt". Losing it is
    // not a failure: the executor's own `complete{partial}` posted one first, and
    // that attempt carries the same queued remainder. Two `requested` rows for
    // one group would be two runners executing the same cases.
    const posted = await dispatchContinuation(ctx, group.id);
    if (!posted) return { dispatch_id: dispatch.id, action: "already_dispatched" };
  }
  return { dispatch_id: dispatch.id, action: shouldRedispatch ? "redispatched" : action };
}

/**
 * A standalone mint dispatch died. If its claim was already fulfilled the mint
 * actually succeeded — just conclude the ledger row. Otherwise abandon the
 * pending claim (single-flight takeover: the next claim/forced refresh mints
 * afresh) and mark the dispatch reconciled_dead. No re-dispatch: a forced
 * refresh is a human action, not a run the platform owes a completion.
 */
async function markMintDead(ctx: HostedDynamic, dispatch: HostedDynamic, { reason }: HostedDynamic) {
  let action = "dead";
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    // The ONE terminal cleanup for a mint attempt (`dispatch/sessions.ts`),
    // shared with the exchange refusal: a fulfilled claim concludes, an
    // abandoned grant is deleted so the next claimer takes over, and the DELETE
    // restates `pending` so a mint that fulfils in the gap concludes instead of
    // dying.
    const ended = await terminateMintDispatch(tx, {
      dispatchId: dispatch.id,
      claimId: dispatch.ref_id,
      reason,
    });
    if (ended.outcome === "concluded") {
      action = "already_complete";
      return;
    }
    await audit(tx, {
      actor: { system: "reconciler" },
      action: "dispatch.dead",
      entityType: "dispatch",
      entityId: dispatch.id,
      projectId: dispatch.project_id,
      detail: { kind: "mint", claim_id: dispatch.ref_id, reason },
    });
  });
  return { dispatch_id: dispatch.id, action };
}

async function getGroup(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM run_groups WHERE id = $1`, [id]);
  return rows[0];
}
