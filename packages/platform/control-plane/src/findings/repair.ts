// The repair claim: a lease an external repair daemon takes on one finding
// while it attempts a fix (docs/contracts/hosted-findings.md, "Repair claims").
//
// Playtest arbitrates the lease and records what came of it. It never dispatches
// the work, never calls the daemon, and holds no attempt state: claim, heartbeat
// and release are the whole protocol, and the finding row is the whole ledger.
//
// Each transition is ONE UPDATE whose WHERE restates the entire precondition —
// eligibility for a claim, owner-and-generation for a heartbeat or release — so
// two daemons racing the same finding have a database arbiter and exactly one
// wins. Zero affected rows means this caller lost; `api/repair.ts` reads the row
// back to say why. This is `dispatch/state.ts`'s `claimDispatchForRunner` shape,
// not the `leases` table: a lease row would put eligibility in a second place.
import type { DbRow, QueryResult } from "../db.ts";

/** A `Db` or a `Tx` — everything here works against either. */
interface Queryable {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

/** What a released claim concluded. `none` means no repair has concluded yet. */
export const REPAIR_OUTCOMES = ["suggested", "not_fixed", "needs_owner"] as const;
export type RepairOutcome = (typeof REPAIR_OUTCOMES)[number];

/** Only these states are worth repairing: a machine claim, awaiting judgment. */
export const REPAIRABLE_STATES = ["new", "reopened"] as const;

const TTL_MIN_S = 30;
const TTL_MAX_S = 3600;

export function clampTtlSeconds(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return TTL_MIN_S;
  return Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, n));
}

/**
 * How often the holder must heartbeat. Ten beats inside one TTL leaves room for
 * a lost request or two; the floor keeps a short lease from becoming a spin.
 */
export function heartbeatIntervalSeconds(ttlSeconds: number): number {
  return Math.max(5, Math.floor(ttlSeconds / 10));
}

/** Is `f` (a finding row) currently leased by someone other than `owner`? */
export function heldByAnother(f: DbRow, owner: string, now = Date.now()): boolean {
  if (!f.repair_owner || f.repair_owner === owner) return false;
  return f.repair_expires_at != null && new Date(f.repair_expires_at).getTime() > now;
}

const LIVE_CLAIM = `f.repair_owner IS NOT NULL AND f.repair_expires_at IS NOT NULL AND f.repair_expires_at > now()`;

/**
 * The eligibility rule, as SQL over an alias. `repairable=1` on the findings
 * list and the claim's own WHERE must agree, so they share this text.
 */
export function repairableSql(alias = "f"): string {
  return [
    `${alias}.merged_into IS NULL`,
    `${alias}.state IN ('new','reopened')`,
    `${alias}.repair_outcome = 'none'`,
    `(${alias}.repair_expires_at IS NULL OR ${alias}.repair_expires_at < now())`,
  ].join(" AND ");
}

/**
 * Take (or renew) the lease. An expired lease belongs to whoever asks next; a
 * live one only to its holder, who may re-claim it — that is a restart, not a
 * race. Every claim bumps the generation, so a heartbeat from a previous holder
 * is already stale when it arrives.
 */
export async function claimRepair(
  q: Queryable,
  { findingId, owner, ttlSeconds }: { findingId: string; owner: string; ttlSeconds: number },
): Promise<DbRow | null> {
  const { rows } = await q.query(
    `UPDATE findings f
        SET repair_owner = $2,
            repair_generation = f.repair_generation + 1,
            repair_expires_at = now() + make_interval(secs => $3::double precision),
            updated_at = now()
      WHERE f.id = $1
        AND f.merged_into IS NULL
        AND f.state IN ('new','reopened')
        AND f.repair_outcome = 'none'
        AND (f.repair_owner IS NULL
             OR f.repair_owner = $2
             OR f.repair_expires_at IS NULL
             OR f.repair_expires_at <= now())
      RETURNING f.*`,
    [findingId, owner, ttlSeconds],
  );
  return rows[0] ?? null;
}

/** Extend the lease. Only the live holder at the exact generation may. */
export async function heartbeatRepair(
  q: Queryable,
  { findingId, owner, generation, ttlSeconds }: { findingId: string; owner: string; generation: number; ttlSeconds: number },
): Promise<DbRow | null> {
  const { rows } = await q.query(
    `UPDATE findings f
        SET repair_expires_at = now() + make_interval(secs => $4::double precision),
            updated_at = now()
      WHERE f.id = $1
        AND f.merged_into IS NULL
        AND f.repair_owner = $2
        AND f.repair_generation = $3
        AND ${LIVE_CLAIM}
      RETURNING f.*`,
    [findingId, owner, generation, ttlSeconds],
  );
  return rows[0] ?? null;
}

/**
 * Conclude the lease. The outcome stays on the finding until a reviewer resets
 * it or the finding reopens, so a concluded finding leaves the repair queue
 * rather than being retried forever. An external ref written here is the
 * daemon's pull request: auto-resolution treats a live ref as suggest-only, so
 * the pull request is never contradicted silently.
 */
export async function releaseRepair(
  q: Queryable,
  { findingId, owner, generation, outcome, externalRef = null }:
    { findingId: string; owner: string; generation: number; outcome: RepairOutcome; externalRef?: string | null },
): Promise<DbRow | null> {
  const { rows } = await q.query(
    `UPDATE findings f
        SET repair_owner = NULL,
            repair_expires_at = NULL,
            repair_outcome = $4,
            external_ref = COALESCE($5, f.external_ref),
            updated_at = now()
      WHERE f.id = $1
        AND f.merged_into IS NULL
        AND f.repair_owner = $2
        AND f.repair_generation = $3
        AND ${LIVE_CLAIM}
      RETURNING f.*`,
    [findingId, owner, generation, outcome, externalRef],
  );
  return rows[0] ?? null;
}

/** A reviewer putting a concluded finding back in the repair queue. */
export async function resetRepairOutcome(q: Queryable, findingId: string): Promise<DbRow | null> {
  const { rows } = await q.query(
    `UPDATE findings f
        SET repair_outcome = 'none',
            updated_at = now()
      WHERE f.id = $1 AND f.merged_into IS NULL
      RETURNING f.*`,
    [findingId],
  );
  return rows[0] ?? null;
}
