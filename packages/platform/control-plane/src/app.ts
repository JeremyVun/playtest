// Assemble the running application from a config: logger, db (migrated), object
// store, dev-user bootstrap, and the http server — but do NOT listen. Exported so
// the integration tests can spin a whole control plane on an ephemeral port and tear
// it down, exactly as the CLI self-tests drive the real harness in-process.
import { connect } from "./db.ts";
import { migrate } from "./migrate.ts";
import { makeLogger } from "./logging.ts";
import { makeObjectStore } from "./store/object-store.ts";
import { ensureUser } from "./auth/users.ts";
import { makeRunnerTokenKey } from "./auth/runner-tokens.ts";
import { GitHubDispatchClient } from "./dispatch/github.ts";
import { LocalDispatchClient } from "./dispatch/local.ts";
import { FeedWaker } from "./events/feed.ts";
import { createServer } from "./server.ts";
import { runRetentionCycle } from "./retention/worker.ts";
import { WriteRateLimiter } from "./rate-limit.ts";
import { reconcileDispatches, RECONCILE_LEASE } from "./dispatch/reconciler.ts";
import { beatHeartbeat } from "./ops.ts";
import { withLease } from "./leases.ts";
import { recomputeFindingKeys } from "./findings/intake.ts";
import type { AppContext, DispatchClient } from "./types.ts";
import type { ControlPlaneConfig } from "./config.ts";

export async function createApp(
  config: ControlPlaneConfig,
  { migrate: runMigrations = true, github = null }: { migrate?: boolean; github?: DispatchClient | null } = {}
) {
  const log = makeLogger(config);
  const db = await connect(config);
  if (runMigrations) {
    await migrate(db, { log: (m) => log.debug({ msg: m }) });
    // A bumped key/normalization algorithm version must not silently strand
    // older findings: every input is recorded on the row, so recompute stored
    // keys once at boot. A no-op when nothing is stale (DESIGN D4).
    const { updated } = await db.withTx((tx) => recomputeFindingKeys(tx));
    if (updated) log.info({ msg: "recomputed finding keys after an algorithm version bump", updated });
  }
  const store = makeObjectStore(config.objectStore);

  let devUserId: HostedDynamic = null;
  if (config.auth.mode === "dev") {
    devUserId = (await ensureUser(db, config.auth.devUser as HostedDynamic) as HostedDynamic).id;
  }

  // In-process post-commit wakeups for the §4a long-poll feed. Held requests
  // always retain the 1 s scan fallback, so a missed signal only costs latency.
  const feedWaker = await new FeedWaker({ log }).start();
  db.feedWaker = feedWaker;

  const ctx: AppContext = {
    db,
    store,
    config,
    log,
    devUserId,
    feedWaker,
    github: github || (config.dispatch.local ? new LocalDispatchClient(config, { log }) : new GitHubDispatchClient(config)),
    runnerTokenKey: makeRunnerTokenKey(config),
    writeLimiter: new WriteRateLimiter({
      perMinute: config.rateLimit.writesPerMinute,
      burst: config.rateLimit.writeBurst,
    }),
  };
  const server = createServer(ctx);
  let retentionTimer: HostedDynamic = null;
  // Dispatch reconciler (Phase 7): the liveness safety net finally runs in the
  // server, not just in tests. Skips quietly while GitHub dispatch is not
  // configured; stamps a heartbeat each pass so /projects/:p/ops can show lag.
  let reconcileTimer: HostedDynamic = null;
  if (config.reconcile.intervalMs > 0) {
    // The `reconcile` lease, not a boolean: it refuses an overlapping tick the
    // same way, and additionally recovers after a crash mid-cycle (the row
    // expires because nothing renews it). See src/leases.js.
    const leaseTtlMs = Math.max(60_000, config.reconcile.intervalMs * 4);
    const tick = async () => {
      if (!ctx.github?.enabled) return;
      try {
        const held = await withLease(db, RECONCILE_LEASE, { ttlMs: leaseTtlMs, log }, async () => {
          await reconcileDispatches(ctx);
          await beatHeartbeat(ctx, "reconciler", { interval_s: Math.round(config.reconcile.intervalMs / 1000) });
        });
        if (!held.acquired) log.debug({ msg: "reconcile cycle skipped: lease held" });
      } catch (e: HostedDynamic) {
        log.error({ msg: "reconcile cycle failed", err: e?.stack || String(e) });
      }
    };
    reconcileTimer = setInterval(tick, config.reconcile.intervalMs);
    reconcileTimer.unref?.();
  }
  if (config.retention.intervalMs > 0) {
    retentionTimer = setInterval(() => {
      runRetentionCycle(ctx).catch((e) => log.error({ msg: "retention cycle failed", err: e?.stack || String(e) }));
    }, config.retention.intervalMs);
    retentionTimer.unref?.();
  }

  return {
    ctx,
    server,
    db,
    store,
    config,
    log,
    /** Start listening; resolves with the bound address. */
    async listen(port = config.port, host = config.host) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      if (retentionTimer) clearInterval(retentionTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      await new Promise<void>((resolve) => server.close(resolve as HostedDynamic));
      await feedWaker.stop();
      await db.end();
    },
  };
}
