// Ops metrics: the queries behind
// GET /projects/:p/ops — dispatch depth, GHA queue-wait, reconciler liveness,
// and LLM spend. Everything here is a projection over existing ledgers; the
// liveness state is the service_heartbeats row each background loop stamps.
import type { AppContext, DynamicJson } from "./types.ts";

/** Upsert a background loop's liveness stamp. */
export async function beatHeartbeat(ctx: AppContext, name: string, detail: DynamicJson = {}) {
  await ctx.db.query(
    `INSERT INTO service_heartbeats (name, beat_at, detail)
     VALUES ($1, now(), $2)
     ON CONFLICT (name) DO UPDATE SET beat_at = now(), detail = EXCLUDED.detail`,
    // `detail` binds as a plain object: the adapter writes canonical JSON, so
    // pre-stringifying here would double-encode the column.
    [name, detail],
  );
}

const SPEND_WINDOW_DAYS = 30;

/** The ops overview for one project. */
export async function opsOverview(ctx: AppContext, projectId: string) {
  const [depth, queueWait, reconciler, spend] = await Promise.all([
    dispatchDepth(ctx, projectId),
    queueWaitStats(ctx, projectId),
    reconcilerStatus(ctx),
    llmSpend(ctx, projectId),
  ]);
  return { dispatches: depth, queue_wait: queueWait, reconciler, llm_spend: spend };
}

async function dispatchDepth(ctx: AppContext, projectId: string) {
  const { rows } = await ctx.db.query(
    // Timestamps are epoch milliseconds, so an age in seconds is plain integer
    // arithmetic; ROUND keeps the half-up rounding the old `::int` cast had.
    `SELECT status, COUNT(*) AS n,
            CAST(ROUND((now() - MIN(requested_at)) / 1000.0) AS INTEGER) AS oldest_s
       FROM dispatches
      WHERE project_id = $1 AND status IN ('requested','scheduled','running')
      GROUP BY status`,
    [projectId],
  );
  const active: Record<string, number> & { requested: number; scheduled: number; running: number } = {
    requested: 0,
    scheduled: 0,
    running: 0
  };
  let oldest: number | null = null;
  for (const r of rows) {
    active[r.status] = r.n;
    if (r.oldest_s != null) oldest = oldest == null ? r.oldest_s : Math.max(oldest, r.oldest_s);
  }
  return {
    active: { ...active, total: active.requested + active.scheduled + active.running },
    cap: ctx.config.dispatch.maxActivePerProject,
    oldest_active_s: oldest,
  };
}

/**
 * GHA queue-wait: dispatch requested → executor exchanged, over the last 50
 * group dispatches that got an executor. `requested_at` is the ledger insert
 * (adjacent to the workflow_dispatch POST), `executors.registered_at` is the
 * exchange — the closest durable pair we have to "queued" → "picked up".
 */
async function queueWaitStats(ctx: AppContext, projectId: string) {
  const { rows } = await ctx.db.query(
    `SELECT (e.registered_at - d.requested_at) / 1000.0 AS wait_s
       FROM dispatches d
       JOIN executors e ON e.id = d.executor_id
      WHERE d.project_id = $1 AND d.kind = 'group' AND e.registered_at >= d.requested_at
      ORDER BY d.requested_at DESC
      LIMIT 50`,
    [projectId],
  );
  const waits = rows.map((r) => Number(r.wait_s)).sort((a, b) => a - b);
  if (!waits.length) return { sample: 0, p50_s: null, p95_s: null, max_s: null };
  const at = (q: number) => waits[Math.min(waits.length - 1, Math.floor(q * waits.length))]!;
  return {
    sample: waits.length,
    p50_s: round1(at(0.5)),
    p95_s: round1(at(0.95)),
    max_s: round1(waits[waits.length - 1]!), // TODO(ts): The empty-list branch returned above.
  };
}

async function reconcilerStatus(ctx: AppContext) {
  const configured = ctx.config.reconcile.intervalMs > 0 && !!ctx.github?.enabled;
  const { rows } = await ctx.db.query(
    `SELECT (now() - beat_at) / 1000.0 AS lag_s, beat_at, detail
       FROM service_heartbeats WHERE name = 'reconciler'`,
  );
  const beat = rows[0] || null;
  return {
    configured,
    interval_s: Math.round(ctx.config.reconcile.intervalMs / 1000),
    last_beat_at: beat?.beat_at ?? null,
    lag_s: beat ? round1(Number(beat.lag_s)) : null,
    detail: beat?.detail ?? {},
  };
}

/**
 * LLM spend for the project over the last 30 days. Only run agents spend now:
 * inline story drafting (P2) is stateless and metered per request, not
 * persisted, and the standalone authoring_sessions table is gone (P6).
 */
async function llmSpend(ctx: AppContext, projectId: string) {
  // The window start is computed here rather than in SQL: SQLite has no interval
  // type, and a bound Date is the same instant the query would have derived.
  const since = new Date(Date.now() - SPEND_WINDOW_DAYS * 86_400_000);
  const runs = await ctx.db.query(
    `SELECT COALESCE(SUM(CAST(json_extract(r.totals, '$.cost_usd') AS REAL)), 0) AS usd
       FROM runs r JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1 AND json_extract(r.totals, '$.cost_usd') IS NOT NULL
        AND r.created_at > $2`,
    [projectId, since],
  );
  const runsUsd = Number(runs.rows[0]!.usd); // TODO(ts): The aggregate query always returns one row.
  return {
    window_days: SPEND_WINDOW_DAYS,
    runs_usd: round4(runsUsd),
    total_usd: round4(runsUsd),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
