// Long-poll wakeups. The `platform_events` table is the truth; this is only the
// signal that lets a held request return promptly instead of waiting out the
// handler's 1 s scan fallback.
//
// Under SQLite the control plane is a single process (docs/contracts/hosted.md,
// "Deployment topology"), so an in-process emitter is sufficient: no broker, no
// second connection. The one guarantee carried over from the LISTEN/NOTIFY era
// is that a wakeup is delivered only after the emitting transaction COMMITs, so
// a woken client can never fail to read the event that woke it and a rolled-back
// transaction wakes nobody. `Db#afterCommit` provides that; see `outbox.ts`.
//
// This class is an accelerator and nothing more. It holds no state a consumer
// depends on: a signal delivered to nobody (no waiter yet, process restarting,
// server shutting down) is simply lost, and the held read's 1 s scan recovers
// every committed row from the client's cursor. Correctness lives in
// `platform_events` and the cursor; never move it in here.
import type { Logger } from "../types.ts";

export const FEED_CHANNEL = "playtest_events";

export class FeedWaker {
  #waiters = new Map<string, Set<() => void>>(); // projectId -> Set<resolve>
  #stopped = false;
  declare readonly log: Logger | null;
  declare connected: boolean;

  constructor({ log = null }: { log?: Logger | null } = {}) {
    this.log = log;
    this.connected = true;
  }

  /** Kept async so callers read the same as the LISTEN-connection era. */
  async start(): Promise<this> {
    return this;
  }

  /**
   * Resolve when a platform event lands for `projectId` or after `ms` —
   * whichever comes first. Never rejects.
   */
  wait(projectId: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.#stopped) return resolve();
      const key = String(projectId);
      let set = this.#waiters.get(key);
      if (!set) this.#waiters.set(key, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (!set.size) this.#waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      set.add(done);
    });
  }

  /** Wake everyone holding for `projectId`. Called post-commit only. */
  notify(projectId: string): void {
    const set = this.#waiters.get(String(projectId));
    if (!set) return;
    for (const done of [...set]) done();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.connected = false;
    for (const set of [...this.#waiters.values()]) for (const done of [...set]) done();
    this.#waiters.clear();
  }
}
