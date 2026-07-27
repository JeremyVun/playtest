// Retention worker (docs/contracts/hosted.md#retention). It is a
// leader-elected cycle, not a queue: one cycle at a time prunes old events, tiers
// full bundles down to core with core `rewriteBundle`, deletes expired artifacts
// to meta, runs a small integrity sample, and garbage collects orphan run objects
// / unreferenced snapshot blobs.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BundleProvider, coreBundleKeepPath, rewriteBundle } from "../../../../core/public/artifacts.ts";
import { audit } from "../audit.ts";
import { ulid } from "../ulid.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { withLease } from "../leases.ts";
import type { Db, DbRow, Tx } from "../db.ts";
import type { AppContext, DynamicJson } from "../types.ts";

export interface RetentionDays {
  events_days: number;
  full_days: number | null;
  core_days: number | null;
}
interface RetentionPolicy extends RetentionDays {
  project_id: string;
  auto_resolve_pin_days: number;
}
interface RetentionError extends Error {
  details: Array<{ path: string; message: string }>;
}
type QueryTarget = Db | Tx;

export const DEFAULT_RETENTION = Object.freeze({ events_days: 14, full_days: 90, core_days: 365 });

const DAY_MS = 24 * 60 * 60 * 1000;

// Generous relative to a normal cycle, but bounded: bundle rewrites and integrity
// hashing are slow, and the renewal timer covers a cycle that legitimately runs
// longer. What this bounds is how long a *crashed* cycle blocks the next one.
const RETENTION_LEASE_TTL_MS = 5 * 60_000;

/** Lease name for the retention cycle (see `src/leases.ts`). */
export const RETENTION_LEASE = "retention";

/**
 * One retention cycle at a time, enforced by the `retention` lease.
 *
 * This replaces the Postgres transaction-scoped advisory lock and deliberately
 * does not reproduce its lifetime: that lock was released at COMMIT while the
 * cycle goes on deleting objects AFTER the transaction, so a second cycle could
 * start mid-cleanup (S0-INVENTORY §2.9). The lease is held across the whole
 * cycle, post-commit object I/O included, and — unlike the in-process flag S1
 * used — it survives a crash: a process that dies mid-cycle stops renewing, and
 * the next cycle claims the expired row.
 */
export async function runRetentionCycle(
  ctx: AppContext,
  { now = new Date(), integritySample = 20, retention }: {
    now?: Date;
    integritySample?: number;
    retention?: RetentionDays;
  } = {}
) {
  const policyDays = retention || ctx.config?.retention?.days || DEFAULT_RETENTION;
  const cleanupKeys: string[] = [];
  const summary = {
    skipped: false,
    events_pruned: 0,
    tiered_to_core: 0,
    tiered_to_meta: 0,
    snapshots_pruned: 0,
    integrity_checked: 0,
    integrity_failed: 0,
    orphan_objects_deleted: 0,
    blob_objects_deleted: 0,
  };

  const held = await withLease(ctx.db, RETENTION_LEASE, { ttlMs: RETENTION_LEASE_TTL_MS, log: ctx.log }, async () => {
    // Each step opens its own short transaction and does its object-store I/O
    // outside it. One transaction for the whole cycle would hold the single
    // SQLite write connection across bundle rewrites and integrity hashing —
    // seconds of blocked API writes. The unit that must be atomic is one run's
    // tier transition (artifact rows + run row + audit + event), and that still
    // is; the cycle as a whole was never atomic, since it deletes objects after
    // commit either way.
    const projects = await activeProjects(ctx.db);
    for (const { project_id } of projects) {
      const policy = {
        project_id,
        ...policyDays,
        auto_resolve_pin_days: ctx.config?.autoResolve?.pinDays ?? 90,
      };
      summary.events_pruned += await pruneEvents(ctx.db, policy, now);
      summary.tiered_to_core += await tierFullRuns(ctx, policy, now, cleanupKeys);
      summary.tiered_to_meta += await ctx.db.withTx((tx) => tierCoreRuns(tx, policy, now, cleanupKeys));
    }

    const snap = await ctx.db.withTx((tx) => pruneSnapshots(tx));
    summary.snapshots_pruned += snap.deleted;

    const integrity = await integritySweep(ctx, { now, limit: integritySample });
    summary.integrity_checked += integrity.checked;
    summary.integrity_failed += integrity.failed;

    cleanupKeys.push(...(await orphanRunObjects(ctx)));

    for (const key of unique(cleanupKeys)) {
      await ctx.store.delete(key);
      summary.orphan_objects_deleted += 1;
    }
    summary.blob_objects_deleted += await gcSnapshotBlobs(ctx);
  });
  if (!held.acquired) return { ...summary, skipped: true };
  return summary;
}

/**
 * Resolve the deployment-wide retention policy from operator env overrides.
 * `PLAYTEST_RETENTION_FULL_DAYS`/`..._CORE_DAYS` accept an integer number of days
 * or "forever" (kept indefinitely, encoded as null). Throws with `.details` on an
 * invalid value so config.js can surface a friendly ServerConfigError.
 */
export function resolveRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionDays {
  const eventsDays = envInt(env.PLAYTEST_RETENTION_EVENTS_DAYS, DEFAULT_RETENTION.events_days, "PLAYTEST_RETENTION_EVENTS_DAYS");
  const fullDays = envNullableInt(env.PLAYTEST_RETENTION_FULL_DAYS, DEFAULT_RETENTION.full_days, "PLAYTEST_RETENTION_FULL_DAYS");
  const coreDays = envNullableInt(env.PLAYTEST_RETENTION_CORE_DAYS, DEFAULT_RETENTION.core_days, "PLAYTEST_RETENTION_CORE_DAYS");
  const details: Array<{ path: string; message: string }> = [];
  if (eventsDays < 1) details.push({ path: "PLAYTEST_RETENTION_EVENTS_DAYS", message: "must be at least 1" });
  if (fullDays !== null && fullDays < 7) details.push({ path: "PLAYTEST_RETENTION_FULL_DAYS", message: "must be at least 7 or \"forever\"" });
  if (fullDays !== null && coreDays !== null && coreDays < fullDays) {
    details.push({ path: "PLAYTEST_RETENTION_CORE_DAYS", message: "must be >= full_days or \"forever\"" });
  }
  if (details.length) {
    const err: RetentionError = new Error("retention configuration did not validate") as RetentionError;
    err.details = details;
    throw err;
  }
  return { events_days: eventsDays, full_days: fullDays, core_days: coreDays };
}

async function activeProjects(q: QueryTarget): Promise<DbRow[]> {
  const { rows } = await q.query(`SELECT id AS project_id FROM projects WHERE NOT archived`);
  return rows;
}

// One statement, so it is atomic on its own — no transaction wrapper needed.
// SQLite's DELETE takes neither an alias nor USING, hence the IN (SELECT …).
async function pruneEvents(q: QueryTarget, policy: RetentionPolicy, now: Date): Promise<number> {
  const cutoff = daysBefore(now, policy.events_days);
  const { rowCount } = await q.query(
    `DELETE FROM run_events
      WHERE run_id IN (
              SELECT r.id FROM runs r
                JOIN run_groups g ON g.id = r.run_group_id
               WHERE g.project_id = $1
            )
        AND ts < $2`,
    [policy.project_id, cutoff],
  );
  return rowCount || 0;
}

/**
 * Tier full bundles down to core. The candidate scan and each bundle rewrite run
 * outside a transaction (object-store I/O); one short transaction per run then
 * commits that run's artifact swap, tier change, ref retargeting, audit and event
 * together — the unit that has to be atomic.
 */
async function tierFullRuns(
  ctx: AppContext,
  policy: RetentionPolicy,
  now: Date,
  cleanupKeys: string[]
): Promise<number> {
  if (policy.full_days === null) return 0;
  const cutoff = daysBefore(now, policy.full_days);
  const { rows } = await ctx.db.query(
    `SELECT r.*, g.project_id, a.id AS artifact_id, a.key AS artifact_key,
            a.sha256 AS artifact_sha256, a.size AS artifact_size
       FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
       JOIN artifacts a ON a.run_id = r.id AND a.kind = 'bundle' AND a.tier = 'full'
      WHERE g.project_id = $1
        AND r.artifact_tier = 'full'
        AND r.finished_at IS NOT NULL
        AND r.finished_at < $2
      ORDER BY r.finished_at
      LIMIT 100`,
    [policy.project_id, cutoff],
  );

  let count = 0;
  for (const run of rows) {
    const result = await rewriteToCore(ctx, run);
    cleanupKeys.push(run.artifact_key);
    await ctx.db.withTx(async (tx) => {
      await tx.query(
        `DELETE FROM artifacts WHERE id = $1`,
        [run.artifact_id],
      );
      await tx.query(
        `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
           VALUES ($1, $2, 'bundle', $3, $4, $5, 'core', $6)`,
        [ulid(), run.id, result.key, result.sha256, result.size, now],
      );
      await tx.query(
        `UPDATE runs
            SET artifact_tier = 'core',
                retention_pruned_at = $2,
                retention_provenance = $3,
                updated_at = now()
          WHERE id = $1`,
        [
          run.id,
          now,
          { from: "full", to: "core", policy_days: policy.full_days, dropped: result.dropped },
        ],
      );
      await retargetTrajectoryRefs(tx, {
        runId: run.id,
        oldKey: run.artifact_key,
        newKey: result.key,
      });
      await recordPrune(tx, {
        projectId: policy.project_id,
        runId: run.id,
        fromSha256: run.artifact_sha256,
        toSha256: result.sha256,
        dropped: result.dropped,
        tier: "core",
        policyDays: policy.full_days!, // SAFETY: The null-retention branch returns before this transaction callback is created.
      });
    });
    count += 1;
  }
  return count;
}

// The prefix test is `substr(x, 1, length(p)) = p`, not LIKE: a key containing
// `%` or `_` would be read as a wildcard pattern and match the wrong rows.
async function retargetTrajectoryRefs(
  tx: Tx,
  { runId, oldKey, newKey }: { runId: string; oldKey: string; newKey: string }
) {
  const oldPrefix = `${oldKey}#`;
  const newPrefix = `${newKey}#`;
  await tx.query(
    `UPDATE baselines
        SET trajectory_key = $2 || substr(trajectory_key, length($3) + 1)
      WHERE accepted_from_run_id = $1 AND substr(trajectory_key, 1, length($3)) = $3`,
    [runId, newPrefix, oldPrefix],
  );
  await tx.query(
    `UPDATE candidates
        SET trajectory_key = $2 || substr(trajectory_key, length($3) + 1)
      WHERE run_id = $1 AND substr(trajectory_key, 1, length($3)) = $3`,
    [runId, newPrefix, oldPrefix],
  );
}

// Pure database work (the objects are deleted post-commit from `cleanupKeys`),
// so this whole step runs in one transaction.
async function tierCoreRuns(
  tx: Tx,
  policy: RetentionPolicy,
  now: Date,
  cleanupKeys: string[]
): Promise<number> {
  if (policy.core_days === null) return 0;
  const cutoff = daysBefore(now, policy.core_days);
  const { rows } = await tx.query(
    `SELECT r.*, g.project_id
       FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1
        AND r.artifact_tier IN ('full','core')
        AND r.finished_at IS NOT NULL
        AND r.finished_at < $2
        AND (r.retention_pruned_at IS NULL OR r.retention_pruned_at < $3)
        AND NOT EXISTS (
          SELECT 1 FROM candidates c WHERE c.run_id = r.id AND c.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM baselines b WHERE b.accepted_from_run_id = r.id AND b.superseded_by IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM finding_evidence fe
            JOIN findings f ON f.id = fe.finding_id
           WHERE fe.run_id = r.id
             AND f.merged_into IS NULL
             AND (f.state IN ('new','accepted','reopened')
                  OR f.external_ref IS NOT NULL
                  -- An auto-resolved finding keeps its evidence for a grace
                  -- window: reopen restores state, not evidence, so a mistaken
                  -- auto-close must stay reversible with its proof intact.
                  OR (f.state = 'resolved' AND f.auto_resolved_at IS NOT NULL
                      AND f.auto_resolved_at > $4))
        )
      ORDER BY r.finished_at
      LIMIT 100`,
    [policy.project_id, cutoff, now, daysBefore(now, policy.auto_resolve_pin_days ?? 90)],
  );

  let count = 0;
  for (const run of rows) {
    const arts = await tx.query(`SELECT * FROM artifacts WHERE run_id = $1`, [run.id]);
    if (!arts.rows.length) continue;
    cleanupKeys.push(...arts.rows.map((a) => a.key));
    const bundle = arts.rows.find((a) => a.kind === "bundle");
    await tx.query(`DELETE FROM artifacts WHERE run_id = $1`, [run.id]);
    await tx.query(
      `UPDATE runs
          SET artifact_tier = 'meta',
              retention_pruned_at = $2,
              retention_provenance = $3,
              updated_at = now()
        WHERE id = $1`,
      [run.id, now, { from: run.artifact_tier, to: "meta", policy_days: policy.core_days }],
    );
    await recordPrune(tx, {
      projectId: policy.project_id,
      runId: run.id,
      fromSha256: bundle?.sha256 ?? null,
      toSha256: null,
      dropped: arts.rows.map((a) => a.key).sort(),
      tier: "meta",
      policyDays: policy.core_days,
    });
    count += 1;
  }
  return count;
}

async function rewriteToCore(ctx: AppContext, run: DbRow) {
  const original = await ctx.store.get(run.artifact_key);
  const provider = providerFromBuffer(original);
  const dropped = Object.keys(provider.entries)
    .filter((name) => name !== "ptrun.json" && !retentionCoreKeepPath(name))
    .sort();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-retention-"));
  try {
    const src = path.join(dir, "full.ptrun");
    const out = path.join(dir, "core.ptrun");
    await fsp.writeFile(src, original);
    const rewritten = rewriteBundle(src, out, retentionCoreKeepPath);
    const bytes = await fsp.readFile(out);
    const key = `runs/${run.run_group_id}/${run.id}.core.ptrun`;
    const stored = await ctx.store.put(key, bytes);
    return { key, sha256: stored.sha256, size: stored.size, dropped, index: rewritten.index };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function retentionCoreKeepPath(name: string): boolean {
  return coreBundleKeepPath(name) || name === "context.jsonl";
}

function providerFromBuffer(buf: Buffer): BundleProvider {
  return new BundleProvider({
    readRange: (start: number, end: number) => buf.subarray(start, end + 1),
    size: buf.length
  } as NonNullable<ConstructorParameters<typeof BundleProvider>[0]>); // SAFETY: BundleProvider receives size explicitly, so this callback does not need duplicate .size metadata.
}

async function recordPrune(
  tx: Tx,
  { projectId, runId, fromSha256, toSha256, dropped, tier, policyDays }: {
    projectId: string;
    runId: string;
    fromSha256: string | null;
    toSha256: string | null;
    dropped: string[];
    tier: string;
    policyDays: number;
  }
) {
  const detail = { run_id: runId, from_sha256: fromSha256, to_sha256: toSha256, dropped, tier, policy_days: policyDays };
  await audit(tx, {
    actor: { system: "retention" },
    action: "retention.pruned",
    entityType: "run",
    entityId: runId,
    projectId,
    detail,
  });
  await emitPlatformEvent(tx, {
    projectId,
    type: "retention.pruned",
    entity: { run_id: runId },
    payload: detail,
  });
}

/**
 * Re-hash the least recently verified artifacts. Reading and hashing objects is
 * the slow part, so it happens outside any transaction; the verified_at stamps
 * and integrity-failure audit rows are then written in one short transaction.
 */
async function integritySweep(
  ctx: AppContext,
  { now, limit }: { now: Date; limit: number }
): Promise<{ checked: number; failed: number }> {
  if (!limit) return { checked: 0, failed: 0 };
  const { rows } = await ctx.db.query(
    `SELECT a.*, g.project_id
       FROM artifacts a
       JOIN runs r ON r.id = a.run_id
       JOIN run_groups g ON g.id = r.run_group_id
      ORDER BY a.verified_at ASC
      LIMIT $1`,
    [limit],
  );
  let checked = 0;
  let failed = 0;
  const verified: string[] = [];
  const failures: Array<{ artifact: DbRow; detail: DynamicJson }> = [];
  for (const a of rows) {
    try {
      const buf = await ctx.store.get(a.key);
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      checked += 1;
      if (sha === a.sha256) {
        verified.push(a.id);
      } else {
        failed += 1;
        failures.push({ artifact: a, detail: { key: a.key, expected: a.sha256, actual: sha } });
      }
  } catch (e: any /* SAFETY: Object-store failures expose Error.message at this boundary. */) {
      failed += 1;
      failures.push({ artifact: a, detail: { key: a.key, error: e.message } });
    }
  }
  if (verified.length || failures.length) {
    await ctx.db.withTx(async (tx) => {
      for (const id of verified) {
        await tx.query(`UPDATE artifacts SET verified_at = $2 WHERE id = $1`, [id, now]);
      }
      for (const { artifact, detail } of failures) {
        await audit(tx, {
          actor: { system: "retention" },
          action: "storage.integrity_failed",
          entityType: "artifact",
          entityId: artifact.id,
          projectId: artifact.project_id,
          detail,
        });
      }
    });
  }
  return { checked, failed };
}

async function orphanRunObjects(ctx: AppContext): Promise<string[]> {
  const keys = await ctx.store.list("runs/");
  if (!keys.length) return [];
  const known = new Set<string>((await ctx.db.query(`SELECT key FROM artifacts`)).rows.map((r: DbRow) => r.key));
  return keys.filter((key: string) => !known.has(key));
}

async function pruneSnapshots(tx: Tx): Promise<{ deleted: number }> {
  const { rows: suites } = await tx.query(`SELECT id FROM suites`);
  let deleted = 0;
  for (const suite of suites) {
    const res = await tx.query(
      // No alias on the DELETE target: SQLite's DELETE accepts neither an alias
      // nor USING, so the correlated subquery references the bare table name.
      `DELETE FROM suite_snapshots
        WHERE suite_id = $1
          AND NOT EXISTS (SELECT 1 FROM run_groups g WHERE g.snapshot_id = suite_snapshots.id)
          AND id NOT IN (
            SELECT id FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 50
          )`,
      [suite.id],
    );
    deleted += res.rowCount || 0;
  }
  return { deleted };
}

async function gcSnapshotBlobs(ctx: AppContext): Promise<number> {
  const keys = await ctx.store.list("blobs/");
  if (!keys.length) return 0;
  const { rows } = await ctx.db.query(`SELECT tree FROM suite_snapshots`);
  const referenced = new Set<string>();
  for (const row of rows) {
    for (const sha of Object.values(row.tree || {})) referenced.add(`blobs/${sha}`);
  }
  let deleted = 0;
  for (const key of keys) {
    if (referenced.has(key)) continue;
    await ctx.store.delete(key);
    deleted += 1;
  }
  return deleted;
}

function envInt(raw: string | undefined, fallback: number, field: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) invalid(field, "must be an integer number of days");
  return n;
}

function envNullableInt(raw: string | undefined, fallback: number | null, field: string): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (/^(forever|never|none|null)$/i.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) invalid(field, "must be an integer number of days or \"forever\"");
  return n;
}

function invalid(field: string, message: string): never {
  const err: RetentionError = new Error("retention configuration did not validate") as RetentionError;
  err.details = [{ path: field, message }];
  throw err;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(new Date(now).getTime() - days * DAY_MS);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
