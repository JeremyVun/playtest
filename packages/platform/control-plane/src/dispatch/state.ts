// The dispatch state machine (docs/contracts/hosted.md, "Dispatch state").
//
// ONE module owns dispatch creation, executor exchange, reconciliation,
// cancellation, and every terminal transition. Nothing outside it may write
// `dispatches.status`, `dispatches.executor_id`, or `run_groups.status`.
//
// Three rules hold the whole thing together:
//
//   1. **Every transition is a compare-and-set from named allowed states.** A
//      read followed by an unconditional write is not a transition: the gap
//      between them is exactly where a cancel, a completion, or a reconcile
//      pass lands. `rowCount === 0` means "I lost", and the loser reads back the
//      winning state rather than repairing it with a second write.
//   2. **Terminal is monotonic and idempotent.** `concluded` and
//      `reconciled_dead` are ends; a group's `done` and `canceled` are ends. The
//      one authorized reopen is the in-place retry, which is a person's decision
//      and carries its own precondition (`reopenGroupForRetry`).
//   3. **Attempt allocation and dispatch creation are one transaction.** The
//      attempt IS the generation, `(kind, ref_id, attempt)` is unique in SQLite,
//      and a partial unique index permits at most one active group dispatch —
//      so two concurrent continuations have a database arbiter and not just an
//      application-level `NOT EXISTS`.
import { inClause } from "../db.ts";
import { ulid } from "../ulid.ts";
import type { DbRow, QueryResult } from "../db.ts";

/** A `Db` or a `Tx` — everything here works against either. */
interface Queryable {
  query(text: string, params?: unknown[]): Promise<QueryResult> | QueryResult;
}

/**
 * A dispatch that may still execute. This list is the definition the partial
 * unique index in `0001_baseline.sql` restates; change one and change the other.
 */
export const ACTIVE_DISPATCH_STATES = ["requested", "scheduled", "running"] as const;
/**
 * The same list as a SQL literal, for the READ queries that merely ask "is this
 * attempt still live?" — a runner's held claim, a project's active-dispatch
 * count, the console's current-claim join. They are not transitions, so they take
 * no parameters and change no numbering; interpolating this constant is how they
 * stay one definition rather than seven copies that can drift apart.
 */
export const ACTIVE_DISPATCH_STATES_SQL = `(${ACTIVE_DISPATCH_STATES.map((s) => `'${s}'`).join(",")})`;
/**
 * A run group that may still accept execution. Its complement is terminal:
 * dispatch `concluded`/`reconciled_dead` and group `done`/`canceled` are ends,
 * and every transition below names the states it may leave, so a terminal row is
 * never a state any compare-and-set can move.
 */
export const ACTIVE_GROUP_STATES = ["queued", "running"] as const;

/** The outcome of one compare-and-set: did it land, and what does the row say now? */
export interface TransitionResult {
  ok: boolean;
  /** The row's status AFTER the attempt — the winner's state when `ok` is false. */
  status: string | null;
  row: DbRow | null;
}

async function readDispatch(q: Queryable, dispatchId: string): Promise<DbRow | null> {
  const { rows } = await q.query(`SELECT * FROM dispatches WHERE id = $1`, [dispatchId]);
  return rows[0] ?? null;
}

async function readGroup(q: Queryable, groupId: string): Promise<DbRow | null> {
  const { rows } = await q.query(`SELECT * FROM run_groups WHERE id = $1`, [groupId]);
  return rows[0] ?? null;
}

/**
 * The generic dispatch compare-and-set. `from` names the ONLY states this
 * transition may leave, so an already-terminal row is never rewritten and a
 * lost race answers with the state that won.
 */
export async function transitionDispatch(
  q: Queryable,
  {
    dispatchId,
    to,
    from,
    error = undefined,
    concluded = false,
    executorId = undefined,
  }: {
    dispatchId: string;
    to: string;
    from: readonly string[];
    error?: string | null;
    concluded?: boolean;
    executorId?: string | null;
  },
): Promise<TransitionResult> {
  const sets = [`status = $2`];
  const params: unknown[] = [dispatchId, to];
  if (concluded) sets.push(`concluded_at = now()`);
  if (error !== undefined) {
    params.push(error);
    sets.push(`error = $${params.length}`);
  }
  if (executorId !== undefined) {
    params.push(executorId);
    sets.push(`executor_id = $${params.length}`);
  }
  const start = params.length + 1;
  const updated = await q.query(
    `UPDATE dispatches SET ${sets.join(", ")}
      WHERE id = $1 AND status IN (${inClause(from, start)})`,
    [...params, ...from],
  );
  if (updated.rowCount) return { ok: true, status: to, row: await readDispatch(q, dispatchId) };
  const row = await readDispatch(q, dispatchId);
  return { ok: false, status: row?.status ?? null, row };
}

/**
 * The reconciler's "the board says this attempt is executing" write. It used to
 * be an unconditional `SET status = 'running'`, which could resurrect a dispatch
 * that had completed or been cancelled in the gap since the board was read.
 */
export function markDispatchRunning(q: Queryable, dispatchId: string): Promise<TransitionResult> {
  return transitionDispatch(q, { dispatchId, to: "running", from: ACTIVE_DISPATCH_STATES });
}

/** The executor finished (or a cancel/refusal ended the attempt cleanly). */
export function concludeDispatch(
  q: Queryable,
  dispatchId: string,
  { error = undefined }: { error?: string | null } = {},
): Promise<TransitionResult> {
  return transitionDispatch(q, {
    dispatchId,
    to: "concluded",
    from: ACTIVE_DISPATCH_STATES,
    concluded: true,
    error,
  });
}

/** The executor is gone: never claimed, never appeared, or stopped heartbeating. */
export function killDispatch(q: Queryable, dispatchId: string, { error }: { error: string }): Promise<TransitionResult> {
  return transitionDispatch(q, {
    dispatchId,
    to: "reconciled_dead",
    from: ACTIVE_DISPATCH_STATES,
    concluded: true,
    error,
  });
}

/** The group's still-live attempts, newest first. */
export async function activeGroupDispatches(q: Queryable, groupId: string): Promise<DbRow[]> {
  const { rows } = await q.query(
    `SELECT * FROM dispatches
      WHERE kind = 'group' AND ref_id = $1 AND status IN (${inClause(ACTIVE_DISPATCH_STATES, 2)})
      ORDER BY attempt DESC`,
    [groupId, ...ACTIVE_DISPATCH_STATES],
  );
  return rows;
}

/** Conclude every live attempt of a group. Returns the ids that were concluded. */
export async function concludeGroupDispatches(
  q: Queryable,
  groupId: string,
  { error }: { error: string },
): Promise<string[]> {
  const live = await activeGroupDispatches(q, groupId);
  const done: string[] = [];
  for (const d of live) {
    const moved = await concludeDispatch(q, d.id, { error });
    if (moved.ok) done.push(d.id);
  }
  return done;
}

/**
 * The winning claim on the board moves an attempt from `requested` to
 * `scheduled`. The whole precondition — still requested, still unclaimed, not
 * cancelled, the runner still live and in scope, the labels still a subset — is
 * restated in the mutating WHERE, so exactly one concurrent runner wins and the
 * loser is told what happened (`api/pool.ts` reads the row back to say why).
 */
export async function claimDispatchForRunner(
  q: Queryable,
  { dispatchId, runnerId }: { dispatchId: string; runnerId: string },
): Promise<DbRow | null> {
  const won = await q.query(
    `UPDATE dispatches
        SET status = 'scheduled', runner_id = $2, claimed_at = now(), heartbeat_at = now()
      WHERE id = $1
        AND status = 'requested'
        AND claimed_at IS NULL
        AND canceled_at IS NULL
        AND kind IN ('group','mint')
        -- The runner is still live AND still in scope for this project: its own
        -- project, or every project when it is site-scoped. "Live" is the same
        -- two facts the credential was authorized on — not revoked, not expired —
        -- restated here rather than trusted from that check, so a revocation OR
        -- an ephemeral registration's expiry landing in the gap loses the race
        -- rather than slipping through it. A credential that expires in that gap
        -- must win nothing: the claim it would make can never be exchanged, so
        -- the dispatch would sit scheduled under a runner that cannot come back
        -- for it.
        AND EXISTS (
              SELECT 1 FROM runners r
               WHERE r.id = $2 AND r.revoked_at IS NULL
                 AND (r.expires_at IS NULL OR r.expires_at > now())
                 AND (r.project_id IS NULL OR r.project_id = dispatches.project_id))
        AND NOT EXISTS (
              SELECT 1 FROM dispatches held
               WHERE held.runner_id = $2 AND held.status IN ${ACTIVE_DISPATCH_STATES_SQL})
        AND NOT EXISTS (
              SELECT 1 FROM json_each(COALESCE(dispatches.labels, '[]')) want
               WHERE want.value NOT IN (
                 SELECT value FROM json_each((SELECT COALESCE(labels, '[]') FROM runners WHERE id = $2))))
      RETURNING *`,
    [dispatchId, runnerId],
  );
  return won.rows[0] ?? null;
}

/**
 * Conclude the `mint` attempt behind a session claim. Addressed by claim rather
 * than by dispatch id — the fulfilling route knows the claim — and still a
 * compare-and-set from the active states.
 */
export async function concludeMintDispatchesFor(
  q: Queryable,
  claimId: string,
  { error = null }: { error?: string | null } = {},
): Promise<number> {
  const updated = await q.query(
    `UPDATE dispatches SET status = 'concluded', concluded_at = now(), error = $2
      WHERE kind = 'mint' AND ref_id = $1 AND status IN (${inClause(ACTIVE_DISPATCH_STATES, 3)})`,
    [claimId, error, ...ACTIVE_DISPATCH_STATES],
  );
  return updated.rowCount;
}

/**
 * A `media` attempt (on-demand clip generation) finished, with or without an
 * error. Media dispatches have their own trivially short lifecycle — created
 * `running`, concluded once — but they are dispatch rows, so their transition
 * lives here with every other one.
 */
export function concludeMediaDispatch(
  q: Queryable,
  dispatchId: string,
  { error = null }: { error?: string | null } = {},
): Promise<TransitionResult> {
  return transitionDispatch(q, {
    dispatchId,
    to: "concluded",
    from: ACTIVE_DISPATCH_STATES,
    concluded: true,
    error,
  });
}

/** The run-group compare-and-set. Same discipline, same loser behavior. */
export async function transitionGroup(
  q: Queryable,
  {
    groupId,
    to,
    from,
    exitSummary = undefined,
  }: { groupId: string; to: string; from: readonly string[]; exitSummary?: unknown },
): Promise<TransitionResult> {
  const sets = [`status = $2`, `updated_at = now()`];
  const params: unknown[] = [groupId, to];
  if (exitSummary !== undefined) {
    params.push(exitSummary);
    sets.push(`exit_summary = $${params.length}`);
  }
  const start = params.length + 1;
  const updated = await q.query(
    `UPDATE run_groups SET ${sets.join(", ")}
      WHERE id = $1 AND status IN (${inClause(from, start)})`,
    [...params, ...from],
  );
  if (updated.rowCount) return { ok: true, status: to, row: await readGroup(q, groupId) };
  const row = await readGroup(q, groupId);
  return { ok: false, status: row?.status ?? null, row };
}

/**
 * A group is executing. Reached from the winning claim and from the exchange,
 * and refused for a settled group: a cancel that landed first must never be
 * flipped back to `running` by a runner arriving a moment later.
 */
export function markGroupRunning(q: Queryable, groupId: string): Promise<TransitionResult> {
  return transitionGroup(q, { groupId, to: "running", from: ACTIVE_GROUP_STATES });
}

/** The group finished. Monotonic: a cancelled group stays cancelled. */
export function settleGroupDone(q: Queryable, groupId: string, exitSummary: unknown): Promise<TransitionResult> {
  return transitionGroup(q, { groupId, to: "done", from: ACTIVE_GROUP_STATES, exitSummary });
}

/** A person cancelled the group. Terminal, and never applied to a settled group. */
export function cancelGroup(q: Queryable, groupId: string): Promise<TransitionResult> {
  return transitionGroup(q, { groupId, to: "canceled", from: ACTIVE_GROUP_STATES });
}

/**
 * The ONE authorized reopen: `POST /run-groups/:g/retry` puts a finished group's
 * never-started stories back on the board. It is a person's decision, it is
 * refused for a cancelled group, and it carries its own precondition, so it is
 * not the race invariant 2 is about.
 */
export function reopenGroupForRetry(q: Queryable, groupId: string): Promise<TransitionResult> {
  return transitionGroup(q, { groupId, to: "queued", from: ["done"], exitSummary: null });
}

/**
 * Allocate the next attempt for a group and insert its dispatch — one
 * transaction, one statement, so the attempt a row carries is the attempt the
 * database agreed to. `requireIdle` is the continuation/retry rule: no attempt
 * for this group may already be live. The loser inserts nothing and answers
 * null; its caller decides what that means.
 *
 * Both preconditions are restated in the INSERT itself, and both are also
 * enforced by SQLite (`dispatches_ref_idx`, `dispatches_active_group_idx`), so
 * a future caller that forgets one still cannot create a second live attempt.
 */
export async function createGroupDispatch(
  q: Queryable,
  {
    projectId,
    groupId,
    labels,
    target,
    dispatchId = ulid(),
    requireIdle = true,
  }: {
    projectId: string;
    groupId: string;
    labels: unknown;
    target: unknown;
    dispatchId?: string;
    requireIdle?: boolean;
  },
): Promise<{ dispatchId: string; attempt: number } | null> {
  const idle = requireIdle
    ? `AND NOT EXISTS (SELECT 1 FROM dispatches
                        WHERE kind = 'group' AND ref_id = $3
                          AND status IN (${inClause(ACTIVE_DISPATCH_STATES, 6)}))`
    : "";
  const posted = await q.query(
    `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status, labels, target)
       SELECT $1, $2, 'group', $3,
              COALESCE((SELECT MAX(attempt) FROM dispatches WHERE kind = 'group' AND ref_id = $3), 0) + 1,
              'requested', $4, $5
        WHERE 1 = 1 ${idle}`,
    [dispatchId, projectId, groupId, labels, target, ...(requireIdle ? ACTIVE_DISPATCH_STATES : [])],
  );
  if (posted.rowCount === 0) return null;
  const { rows } = await q.query(`SELECT attempt FROM dispatches WHERE id = $1`, [dispatchId]);
  return { dispatchId, attempt: Number(rows[0]?.attempt) };
}

/**
 * Install a new current executor on a dispatch — the whole of it, atomically:
 * insert the executor row, write its IMMUTABLE `dispatch_id` link, advance the
 * dispatch to `running` with the current-executor pointer, and (for a group)
 * move the group to `running`.
 *
 * Eligibility is revalidated INSIDE this write, not read before it: the dispatch
 * must still be active and still claimed by nobody else, and the group-status
 * write carries the same precondition, so a cancel landing in the gap wins and
 * this exchange loses cleanly. A loss returns `{ ok: false, status }` naming the
 * state that won; nothing is repaired with a second write.
 */
export async function exchangeExecutor(
  q: Queryable,
  {
    dispatchId,
    executorId,
    kind,
    groupId = null,
    versions,
    isolation,
  }: {
    dispatchId: string;
    executorId: string;
    kind: "group" | "mint";
    groupId?: string | null;
    versions: unknown;
    isolation: string;
  },
): Promise<{ ok: true } | { ok: false; status: string | null; reason: "dispatch" | "group" }> {
  await q.query(
    `INSERT INTO executors (id, run_group_id, dispatch_id, kind, versions, isolation, last_report_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [executorId, groupId, dispatchId, kind, versions, isolation],
  );
  const moved = await transitionDispatch(q, {
    dispatchId,
    to: "running",
    from: ACTIVE_DISPATCH_STATES,
    executorId,
  });
  if (!moved.ok) return { ok: false, status: moved.status, reason: "dispatch" };
  if (kind === "group" && groupId) {
    const group = await markGroupRunning(q, groupId);
    if (!group.ok) return { ok: false, status: group.status, reason: "group" };
  }
  return { ok: true };
}
