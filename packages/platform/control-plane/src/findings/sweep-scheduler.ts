// Debounced, lease-guarded per-project sweep scheduling — the one shape
// auto-dedupe and auto-resolve share. Each sweep creates its OWN scheduler
// (separate lease names and timer maps: a pending resolve timer must never
// cancel a pending dedupe timer), and shutdown has one cancel path across all
// of them (`cancelProjectSweeps`, called by `app.close()`), so no callback can
// fire against a closed database.
//
// Timers are keyed by the shared Db instance, not by ctx: route handlers
// receive per-request ctx objects, and a timer parked on one of those would
// neither debounce across requests nor be visible to shutdown/tests. One Db,
// one timer map per scheduler — and one app in tests never sees another
// app's timers.
import { withLease } from "../leases.ts";

interface ProjectSweepScheduler {
  /** The pending timers for this app — exposed for shutdown and tests. */
  timers(ctx: HostedDynamic): Map<string, NodeJS.Timeout>;
  /**
   * Debounce a sweep for `projectId`: repeated calls while a run group reports
   * collapse into one lease-guarded `sweep(ctx)` after `debounceMs`.
   * Fire-and-forget — a sweep failure is logged, never surfaced to the report
   * that scheduled it.
   */
  schedule(
    ctx: HostedDynamic,
    projectId: string,
    options: { debounceMs: number; sweep: () => Promise<void> },
  ): boolean;
  /** Clear every pending timer this app scheduled. */
  cancelAll(ctx: HostedDynamic): void;
}

const ALL_SCHEDULERS: ProjectSweepScheduler[] = [];

/** `name` is the lease prefix and log label, e.g. `"auto-dedupe"`. */
export function createProjectSweepScheduler(name: string): ProjectSweepScheduler {
  const byDb = new WeakMap<object, Map<string, NodeJS.Timeout>>();
  const scheduler: ProjectSweepScheduler = {
    timers(ctx: HostedDynamic) {
      let m = byDb.get(ctx.db);
      if (!m) {
        m = new Map();
        byDb.set(ctx.db, m);
      }
      return m;
    },
    schedule(ctx: HostedDynamic, projectId: string, { debounceMs, sweep }) {
      const timers = scheduler.timers(ctx);
      clearTimeout(timers.get(projectId));
      const timer = setTimeout(() => {
        timers.delete(projectId);
        withLease(ctx.db, `${name}:${projectId}`, { log: ctx.log }, sweep).catch((err: HostedDynamic) => {
          ctx.log?.warn?.({ msg: `${name} sweep failed`, projectId, err: String(err?.stack || err) });
        });
      }, debounceMs);
      timer.unref?.();
      timers.set(projectId, timer);
      return true;
    },
    cancelAll(ctx: HostedDynamic) {
      const timers = byDb.get(ctx.db);
      if (!timers) return;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
  ALL_SCHEDULERS.push(scheduler);
  return scheduler;
}

/** Cancel this app's pending sweeps across every scheduler (`app.close()`). */
export function cancelProjectSweeps(ctx: HostedDynamic): void {
  for (const scheduler of ALL_SCHEDULERS) scheduler.cancelAll(ctx);
}
