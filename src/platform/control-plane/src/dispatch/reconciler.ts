import { audit } from "../audit.ts";
import { appendRunEvent, emitRunStatus } from "../events/run-events.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { dispatchContinuation } from "./dispatcher.ts";
import { exitSummary } from "../api/executor-api.ts";
import { inClause } from "../db.ts";

const ACTIVE = ["requested", "scheduled", "running"];

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
  return results;
}

async function reconcileOne(ctx: HostedDynamic, dispatch: HostedDynamic) {
  // GitHub's workflow_dispatch returns 204 with no run id, so a fresh dispatch has
  // workflow_run_id NULL until either the executor's OIDC exchange backfills it or
  // this correlation pass finds the run by the dispatch id embedded in its run name.
  if (!dispatch.workflow_run_id) return await correlateOne(ctx, dispatch);
  const status = await ctx.github.getRunStatus(dispatch.workflow_run_id);
  if (!status) return { dispatch_id: dispatch.id, action: "waiting_for_workflow_id" };
  if (status.status === "queued") return { dispatch_id: dispatch.id, action: "queued" };
  if (status.status === "in_progress") {
    await ctx.db.query(`UPDATE dispatches SET status = 'running', workflow_run_url = COALESCE($2, workflow_run_url) WHERE id = $1`, [
      dispatch.id,
      status.url,
    ]);
    return { dispatch_id: dispatch.id, action: "running" };
  }
  if (status.status !== "completed") return { dispatch_id: dispatch.id, action: status.status || "unknown" };

  return await markDead(ctx, dispatch, {
    url: status.url,
    reason: `workflow concluded without group completion (${status.conclusion || "unknown"})`,
  });
}

/**
 * A dispatch's workflow is gone (concluded without `complete`, or never appeared).
 * Mark it reconciled_dead, fail in-flight cases as infra, and re-dispatch the
 * queued remainder once (bounded). Returns the reconcile action result.
 */
async function markDead(ctx: HostedDynamic, dispatch: HostedDynamic, { url, reason }: HostedDynamic) {
  if (dispatch.kind === "mint") return await markMintDead(ctx, dispatch, { url, reason });
  const group = await getGroup(ctx, dispatch.ref_id);
  const completed = await ctx.db.query(
    `SELECT 1 FROM run_groups WHERE id = $1 AND status IN ('done','canceled')`,
    [group.id],
  );
  if (completed.rows.length) {
    await ctx.db.query(`UPDATE dispatches SET status = 'concluded', concluded_at = now() WHERE id = $1`, [
      dispatch.id,
    ]);
    return { dispatch_id: dispatch.id, action: "already_complete" };
  }

  let shouldRedispatch = false;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `UPDATE dispatches
          SET status = 'reconciled_dead', concluded_at = now(), error = $2
        WHERE id = $1`,
      [dispatch.id, reason],
    );
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
        [run.id, `runner died: ${url || dispatch.workflow_run_url || dispatch.workflow_run_id || dispatch.id}`],
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
    shouldRedispatch = queued.rows[0].n > 0 && attempts.rows[0].n < 2;
    await audit(tx, {
      actor: { system: "reconciler" },
      action: "dispatch.dead",
      entityType: "dispatch",
      entityId: dispatch.id,
      projectId: group.project_id,
      detail: { workflow_run_id: dispatch.workflow_run_id, workflow_run_url: url, reason, redispatch: shouldRedispatch },
    });
    await emitPlatformEvent(tx, {
      projectId: group.project_id,
      type: "dispatch.dead",
      entity: { dispatch_id: dispatch.id, run_group_id: group.id },
      payload: { workflow_run_url: url, redispatch: shouldRedispatch },
    });
    if (!shouldRedispatch) {
      const pending = await tx.query(
        `SELECT * FROM runs WHERE run_group_id = $1 AND status = 'queued'`,
        [group.id],
      );
      for (const run of pending.rows) {
        await tx.query(
          `UPDATE runs SET status = 'infra', finished_at = now(), error = 'runner died before case started', progress = NULL, updated_at = now()
            WHERE id = $1`,
          [run.id],
        );
      }
      // Same exit_summary shape as the executor's `complete` — without it the
      // runs index paints a dead group as a neutral "done" chip, hiding the
      // failure at the triage entry point.
      const summary = await exitSummary(tx, group.id);
      await tx.query(
        `UPDATE run_groups SET status = 'done', exit_summary = $2, updated_at = now() WHERE id = $1`,
        [group.id, summary.exit_summary],
      );
    }
  });
  if (shouldRedispatch) await dispatchContinuation(ctx, group.id);
  return { dispatch_id: dispatch.id, action: shouldRedispatch ? "redispatched" : "dead" };
}

/**
 * A standalone mint dispatch died. If its claim was already fulfilled the mint
 * actually succeeded — just conclude the ledger row. Otherwise abandon the
 * pending claim (single-flight takeover: the next claim/forced refresh mints
 * afresh) and mark the dispatch reconciled_dead. No re-dispatch: a forced
 * refresh is a human action, not a run the platform owes a completion.
 */
async function markMintDead(ctx: HostedDynamic, dispatch: HostedDynamic, { url, reason }: HostedDynamic) {
  let action = "dead";
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(`SELECT * FROM session_claims WHERE id = $1`, [dispatch.ref_id]);
    const claim = rows[0];
    if (claim?.status === "fulfilled") {
      await tx.query(`UPDATE dispatches SET status = 'concluded', concluded_at = now() WHERE id = $1`, [dispatch.id]);
      action = "already_complete";
      return;
    }
    if (claim) {
      // Abandoning the grant re-asserts `pending` in the DELETE (this is what the
      // Postgres row lock bought): a mint that fulfils between the read and the
      // write keeps its claim row, and the dispatch concludes rather than dying.
      const abandoned = await tx.query(`DELETE FROM session_claims WHERE id = $1 AND status = 'pending'`, [claim.id]);
      if (abandoned.rowCount === 0) {
        await tx.query(`UPDATE dispatches SET status = 'concluded', concluded_at = now() WHERE id = $1`, [dispatch.id]);
        action = "already_complete";
        return;
      }
    }
    await tx.query(
      `UPDATE dispatches SET status = 'reconciled_dead', concluded_at = now(), error = $2 WHERE id = $1`,
      [dispatch.id, reason],
    );
    await audit(tx, {
      actor: { system: "reconciler" },
      action: "dispatch.dead",
      entityType: "dispatch",
      entityId: dispatch.id,
      projectId: dispatch.project_id,
      detail: { kind: "mint", claim_id: dispatch.ref_id, workflow_run_id: dispatch.workflow_run_id, workflow_run_url: url, reason },
    });
  });
  return { dispatch_id: dispatch.id, action };
}

/**
 * Correlate an uncorrelated dispatch (workflow_run_id NULL). Found ⇒ backfill and
 * let the next cycle read its status. Not found ⇒ wait until the correlation
 * deadline, then — only when no executor ever exchanged — declare it dead exactly
 * like a concluded-without-complete workflow (cases → infra, bounded re-dispatch).
 * An exchanged executor keeps its dispatch alive regardless: `complete` concludes it.
 */
async function correlateOne(ctx: HostedDynamic, dispatch: HostedDynamic) {
  const found = ctx.github.findDispatchRun
    ? await ctx.github.findDispatchRun(dispatch.id, { since: dispatch.requested_at })
    : null;
  if (found) {
    await ctx.db.query(
      `UPDATE dispatches SET workflow_run_id = $2, workflow_run_url = COALESCE($3, workflow_run_url)
        WHERE id = $1 AND workflow_run_id IS NULL`,
      [dispatch.id, found.id, found.url],
    );
    return { dispatch_id: dispatch.id, action: "correlated", workflow_run_id: found.id };
  }
  if (dispatch.executor_id) return { dispatch_id: dispatch.id, action: "running_uncorrelated" };
  const age = Date.now() - new Date(dispatch.requested_at).getTime();
  if (age < ctx.config.dispatch.correlateDeadlineMs) {
    return { dispatch_id: dispatch.id, action: "awaiting_correlation" };
  }
  return await markDead(ctx, dispatch, {
    url: dispatch.workflow_run_url,
    reason: "no workflow run appeared for this dispatch before the correlation deadline",
  });
}

async function getGroup(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM run_groups WHERE id = $1`, [id]);
  return rows[0];
}
