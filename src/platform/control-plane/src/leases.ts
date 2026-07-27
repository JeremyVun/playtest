// One application-level lease for every background cycle (retention,
// reconciliation). This is the replacement for the PostgreSQL advisory lock, and
// for the in-process boolean S1 left behind — see
// docs/contracts/hosted.md, "Background cycles and leases".
//
// Two properties, one mechanism:
//
//   * **No overlap.** A claim is a conditional UPDATE inside `BEGIN IMMEDIATE`,
//     so the read of `expires_at` and the write of the new owner cannot
//     interleave with another claim. A live lease is never stolen — not even by
//     a second cycle in the same process, because the claim never treats "same
//     owner" as reentrant. That is deliberate: the overlapping-timer case is
//     exactly what must be refused.
//   * **Crash recovery.** The holder renews while it works. A process that dies
//     mid-cycle renews nothing, so the row expires and the next cycle claims it.
//     A process-memory flag cannot do this; the row can.
//
// The lease is advisory scheduling, not a correctness barrier. Each step of a
// cycle is already individually safe (short transactions restating their
// preconditions). The lease exists so two cycles do not duplicate slow object
// work, and so one crashed cycle does not wedge the schedule forever.
import os from "node:os";
import { ulid } from "./ulid.ts";
import type { Db, DbRow } from "./db.ts";
import type { Logger } from "./types.ts";

interface LeaseOptions {
  owner?: string;
  ttlMs?: number;
  now?: number;
}

/** Identifies this process for the lifetime of the process. */
export const OWNER_ID = `${os.hostname()}:${process.pid}:${ulid()}`;

/** Default lease lifetime; renewed at a third of this while a cycle runs. */
export const DEFAULT_TTL_MS = 60_000;

/**
 * Claim `name` if it is unheld or expired. One statement, so the whole
 * read-then-decide is the `BEGIN IMMEDIATE` transaction's write lock.
 *
 * The upsert's `WHERE leases.expires_at <= $now` is the condition: SQLite
 * reports zero changes when a `DO UPDATE` predicate is false, which is the
 * "somebody else holds it" answer.
 *
 * @returns {Promise<boolean>} true when this owner now holds the lease
 */
export async function claimLease(
  db: Db,
  name: string,
  { owner = OWNER_ID, ttlMs = DEFAULT_TTL_MS, now = Date.now() }: LeaseOptions = {}
): Promise<boolean> {
  return await db.withTx(async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO leases (name, owner, acquired_at, renewed_at, expires_at)
            VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT(name) DO UPDATE
              SET owner = excluded.owner,
                  acquired_at = excluded.acquired_at,
                  renewed_at = excluded.renewed_at,
                  expires_at = excluded.expires_at
            WHERE leases.expires_at <= $3`,
      [name, owner, now, now + ttlMs],
    );
    return rowCount > 0;
  });
}

/**
 * Extend a lease this owner still holds. Returns false if it was already lost
 * (expired and taken over) — the caller should stop, not fight for it back.
 */
export async function renewLease(
  db: Db,
  name: string,
  { owner = OWNER_ID, ttlMs = DEFAULT_TTL_MS, now = Date.now() }: LeaseOptions = {}
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE leases SET renewed_at = $3, expires_at = $4 WHERE name = $1 AND owner = $2`,
    [name, owner, now, now + ttlMs],
  );
  return rowCount > 0;
}

/** Release a lease this owner holds. A lease held by someone else is left alone. */
export async function releaseLease(db: Db, name: string, { owner = OWNER_ID }: LeaseOptions = {}): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM leases WHERE name = $1 AND owner = $2`, [name, owner]);
  return rowCount > 0;
}

/** Current lease row, or null. Exposed for ops surfaces and tests. */
export async function readLease(db: Db, name: string): Promise<DbRow | null> {
  const { rows } = await db.query(`SELECT * FROM leases WHERE name = $1`, [name]);
  return rows[0] || null;
}

/**
 * Run `fn()` while holding `name`. Returns `{ acquired: false }` without calling
 * `fn` when another live holder has it.
 *
 * The renewal timer is unref'd and cleared in `finally`, so a cycle that throws
 * still releases the lease immediately rather than making the next one wait out
 * the TTL.
 */
export async function withLease<Result>(
  db: Db,
  name: string,
  { owner = OWNER_ID, ttlMs = DEFAULT_TTL_MS, log = null }: LeaseOptions & { log?: Logger | null } = {},
  fn: () => Result | Promise<Result>
): Promise<{ acquired: false } | { acquired: true; result: Result }> {
  if (!(await claimLease(db, name, { owner, ttlMs }))) return { acquired: false };
  const renew = setInterval(() => {
    renewLease(db, name, { owner, ttlMs }).catch((e: any /* TODO(ts): Lease failures expose Error.stack at this boundary. */) =>
      log?.error?.({ msg: `lease renewal failed for ${name}`, err: e?.stack || String(e) }),
    );
  }, Math.max(1000, Math.floor(ttlMs / 3)));
  renew.unref?.();
  try {
    return { acquired: true, result: await fn() };
  } finally {
    clearInterval(renew);
    await releaseLease(db, name, { owner }).catch(() => {
      /* the lease expires on its own; never mask the cycle's own outcome */
    });
  }
}
