// Current-executor fencing (docs/contracts/hosted.md, "Current executor
// fencing"). ONE guard stands in front of every executor-facing read and write.
//
// The bearer format does not change: it already carries `executor_id`, and that
// is all this needs. Every exchange inserts a fresh `executors` row and points
// `dispatches.executor_id` at it inside one compare-and-set, so "who owns this
// attempt right now?" is an identity question the database answers — the token's
// executor either IS the dispatch's current executor or it is stale. Executor
// ids are ULIDs and never recur, so this is identity equality and never an
// ordering comparison on a clock, a sortable id, or anything a runner supplied.
//
// A refusal is always the same code (`executor_conflict`, 409) with a
// machine-readable `details.reason`, so a runner can act on it without parsing
// prose: stop executing, stop uploading, return to the board.
import { AppError, forbidden, notFound } from "../errors.ts";
import { requireRunner } from "./runner-tokens.ts";
import { ACTIVE_DISPATCH_STATES, ACTIVE_GROUP_STATES } from "../dispatch/state.ts";
import { inClause } from "../db.ts";
import type { DbRow } from "../db.ts";

/** The machine-readable half of every stale-ownership refusal. */
export type ExecutorConflictReason =
  /** The bearer names an executor row that does not exist. */
  | "unknown_executor"
  /** A mint bearer on a group route, or a group bearer on a mint route. */
  | "scope_mismatch"
  /** A later exchange installed a new current executor; this bearer is stale. */
  | "executor_replaced"
  /** The addressed dispatch has concluded, died, or been cancelled. */
  | "dispatch_not_active"
  /** The run group has settled (done or cancelled); nothing more may be written. */
  | "group_settled"
  /** The run is claimed by a different executor. */
  | "run_not_owned";

export function executorConflict(
  reason: ExecutorConflictReason,
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError("executor_conflict", message, { details: { reason, ...details } });
}

export interface CurrentExecutor {
  executorId: string;
  executor: DbRow;
  dispatch: DbRow;
  /** Null for a mint-scoped executor. */
  group: DbRow | null;
  /** This attempt's non-secret target snapshot, read from its own ledger row. */
  target: DbRow | null;
}

/** A group-scoped executor always resolves its run group. */
export interface GroupExecutor extends CurrentExecutor {
  group: DbRow;
}

export interface ExecutorGuardOptions {
  /** The group this route addresses. Defaults to the bearer's own scope. */
  groupId?: string | null;
  /** The mint claim this route addresses. Mutually exclusive with `groupId`. */
  mintClaimId?: string | null;
  /**
   * Dispatch states this operation is meaningful in. `complete` widens it to
   * include `concluded` so a completion the owner retries is idempotent rather
   * than a conflict; nothing widens it to `reconciled_dead`, because the
   * reconciler has already decided that attempt's outcome.
   */
  dispatchStates?: readonly string[];
  /** Group states this operation is meaningful in. */
  groupStates?: readonly string[];
}

/**
 * Resolve the executor row, its immutable dispatch, and the group together, and
 * verify — in this order, so the message a runner sees names the first thing
 * that is actually wrong:
 *
 *   1. the token's executor row exists;
 *   2. it links to a dispatch, and that dispatch is the one being addressed;
 *   3. mint-scoped and group-scoped executors have not crossed routes;
 *   4. the dispatch is in a state this operation means something in — which,
 *      given `dispatches_active_group_idx`, is also what makes it the group's
 *      SINGLE active dispatch;
 *   5. the dispatch's current-executor pointer still equals this executor; and
 *   6. the group has not settled underneath it.
 */
export async function requireCurrentExecutor(
  ctx: HostedDynamic,
  {
    groupId = null,
    mintClaimId = null,
    dispatchStates = ACTIVE_DISPATCH_STATES,
    groupStates = ACTIVE_GROUP_STATES,
  }: ExecutorGuardOptions = {},
): Promise<CurrentExecutor> {
  const scope = mintClaimId ? `mint:${mintClaimId}` : groupId;
  const payload = requireRunner(ctx, scope);
  const executorId = String(payload.executor_id);

  const { rows: executors } = await ctx.db.query(`SELECT * FROM executors WHERE id = $1`, [executorId]);
  const executor = executors[0];
  if (!executor) {
    throw executorConflict("unknown_executor", `this runner bearer names an executor that no longer exists`, {
      executor_id: executorId,
    });
  }

  const wantedKind = mintClaimId ? "mint" : "group";
  // Scope separation is checked on BOTH halves: the bearer's audience (above,
  // through `requireRunner`) and the executor row's own kind. A mint executor
  // must never reach a group route even if it somehow presented a group scope.
  if (executor.kind !== wantedKind) {
    throw executorConflict("scope_mismatch", `this bearer is scoped to ${executor.kind} work, not ${wantedKind} work`, {
      executor_id: executorId,
    });
  }

  if (!executor.dispatch_id) {
    throw executorConflict("executor_replaced", `this runner bearer is not linked to a dispatch attempt`, {
      executor_id: executorId,
    });
  }
  const { rows: dispatches } = await ctx.db.query(`SELECT * FROM dispatches WHERE id = $1`, [executor.dispatch_id]);
  const dispatch = dispatches[0];
  if (!dispatch) {
    throw executorConflict("executor_replaced", `the dispatch attempt this bearer belongs to no longer exists`, {
      executor_id: executorId,
      dispatch_id: executor.dispatch_id,
    });
  }

  const ref = mintClaimId ?? groupId ?? (executor.run_group_id as string | null);
  if (dispatch.kind !== wantedKind || (ref && dispatch.ref_id !== ref)) {
    throw executorConflict("scope_mismatch", `this bearer does not belong to the work it is addressing`, {
      executor_id: executorId,
      dispatch_id: dispatch.id,
    });
  }

  if (!dispatchStates.includes(String(dispatch.status))) {
    throw executorConflict(
      "dispatch_not_active",
      `attempt ${dispatch.attempt} of this work is "${dispatch.status}" and accepts no further executor calls`,
      { dispatch_id: dispatch.id, attempt: dispatch.attempt, state: dispatch.status },
    );
  }

  // THE fence. Identity equality against the current-executor pointer the
  // exchange compare-and-set advanced — never an ordering comparison.
  if (dispatch.executor_id !== executorId) {
    throw executorConflict("executor_replaced", `a newer executor owns attempt ${dispatch.attempt} of this work`, {
      executor_id: executorId,
      dispatch_id: dispatch.id,
      attempt: dispatch.attempt,
    });
  }

  let group: DbRow | null = null;
  if (wantedKind === "group") {
    const { rows } = await ctx.db.query(`SELECT * FROM run_groups WHERE id = $1`, [dispatch.ref_id]);
    group = rows[0] ?? null;
    if (!group) throw notFound(`no run group "${dispatch.ref_id}"`);
    if (!groupStates.includes(String(group.status))) {
      throw executorConflict("group_settled", `this run group is "${group.status}" and accepts no further executor calls`, {
        run_group_id: group.id,
        state: group.status,
      });
    }
  }

  return { executorId, executor, dispatch, group, target: dispatch.target ?? null };
}

/**
 * Re-assert, INSIDE a write transaction, the ownership facts
 * `requireCurrentExecutor` checked outside it: the dispatch still exists in a
 * state this operation means something in, its current-executor pointer still
 * names this executor, and the group (for group work) has not settled. The gap
 * between the route guard and the write transaction is exactly where a
 * replacement exchange, a cancel, or a reconcile can land; every exchange
 * commits through `withTx` (`BEGIN IMMEDIATE`), so once this read holds the
 * write lock nothing can change the pointer again before the commit.
 *
 * Routes that widen the guard's state lists (completion) pass the same lists
 * here, so the owner's idempotent retry stays a retry and not a conflict.
 */
export async function reassertCurrentExecutor(
  tx: HostedDynamic,
  current: CurrentExecutor,
  {
    dispatchStates = ACTIVE_DISPATCH_STATES,
    groupStates = ACTIVE_GROUP_STATES,
  }: Pick<ExecutorGuardOptions, "dispatchStates" | "groupStates"> = {},
): Promise<void> {
  const { rows } = await tx.query(`SELECT * FROM dispatches WHERE id = $1`, [current.dispatch.id]);
  const dispatch = rows[0];
  if (!dispatch) {
    throw executorConflict("executor_replaced", `the dispatch attempt this bearer belongs to no longer exists`, {
      executor_id: current.executorId,
      dispatch_id: current.dispatch.id,
    });
  }
  if (!dispatchStates.includes(String(dispatch.status))) {
    throw executorConflict(
      "dispatch_not_active",
      `attempt ${dispatch.attempt} of this work is "${dispatch.status}" and accepts no further executor calls`,
      { dispatch_id: dispatch.id, attempt: dispatch.attempt, state: dispatch.status },
    );
  }
  if (dispatch.executor_id !== current.executorId) {
    throw executorConflict("executor_replaced", `a newer executor owns attempt ${dispatch.attempt} of this work`, {
      executor_id: current.executorId,
      dispatch_id: dispatch.id,
      attempt: dispatch.attempt,
    });
  }
  if (current.group) {
    const group = (await tx.query(`SELECT status FROM run_groups WHERE id = $1`, [current.group.id])).rows[0];
    if (!group || !groupStates.includes(String(group.status))) {
      throw executorConflict(
        "group_settled",
        `this run group is "${group?.status ?? "gone"}" and accepts no further executor calls`,
        { run_group_id: current.group.id, state: group?.status ?? null },
      );
    }
  }
}

/**
 * The guard every group-scoped executor route uses. `groupId` is the group named
 * in the path; routes addressed by run id alone omit it and take the bearer's
 * own scope.
 */
export async function requireGroupExecutor(
  ctx: HostedDynamic,
  options: Omit<ExecutorGuardOptions, "mintClaimId"> = {},
): Promise<GroupExecutor> {
  const current = await requireCurrentExecutor(ctx, options);
  return current as GroupExecutor; // SAFETY: a group-scoped guard always resolves its group or throws.
}

/**
 * The guard both standalone-mint routes use. Mint completion widens
 * `dispatchStates` the way a group's completion does, so the current executor's
 * retried delivery is idempotent rather than a conflict.
 */
export function requireMintExecutor(
  ctx: HostedDynamic,
  mintClaimId: string,
  options: Omit<ExecutorGuardOptions, "groupId" | "mintClaimId"> = {},
): Promise<CurrentExecutor> {
  return requireCurrentExecutor(ctx, { ...options, mintClaimId });
}

/**
 * The run this executor may advance or finish. `runs.executor_id` is stamped by
 * the case-start compare-and-set; a run nobody has started yet is still
 * claimable (an executor may report `infra` for a case it never got to start).
 */
export function requireRunOwner(current: CurrentExecutor, run: DbRow): DbRow {
  // A bearer for another group is a SCOPE failure, not a stale one: it never
  // owned this run and never will, so it keeps the 403 it has always had.
  if (current.group && run.run_group_id !== current.group.id) {
    throw forbidden("runner token is not scoped to this run");
  }
  if (run.executor_id == null && run.status === "queued") return run;
  if (run.executor_id !== current.executorId) {
    throw executorConflict("run_not_owned", `story "${run.case_id}" is owned by another executor`, {
      run_id: run.id,
      case_id: run.case_id,
      state: run.status,
    });
  }
  return run;
}

/**
 * Claim a queued case for the current executor, or confirm this executor
 * already owns it. A compare-and-set, never an unconditional stamp: a stale
 * bearer cannot flip a finished run back to `running`, and the owner's own
 * retry is idempotent.
 */
export async function claimCaseForExecutor(
  tx: HostedDynamic,
  { runDbId, executorId }: { runDbId: string; executorId: string },
): Promise<boolean> {
  const resumable = ["running", "uploading"];
  const claimed = await tx.query(
    `UPDATE runs
        SET status = 'running', started_at = COALESCE(started_at, now()),
            executor_id = $2, updated_at = now()
      WHERE id = $1
        AND (status = 'queued'
             OR (executor_id = $2 AND status IN (${inClause(resumable, 3)})))`,
    [runDbId, executorId, ...resumable],
  );
  return claimed.rowCount > 0;
}
