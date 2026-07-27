// Write-route rate limiting
// (docs/contracts/hosted.md#http-conventions-and-authorization).
// A per-principal token bucket applied by server.js to POST/PUT/DELETE under
// /api/v1 — except the group-executor protocol (/api/v1/runner/*), whose bearer
// is already scoped to a single dispatch and whose call rate is the run's own
// pace. Reads are never limited: the long-poll feed and the viewer adapter must
// stay cheap to hammer.
//
// The bucket is in-process state. That is deliberate: the control plane is a
// single node:http process today; if it ever scales out, limits become
// per-instance (a documented, conservative degradation — never a correctness
// problem).
import type { IncomingMessage } from "node:http";
import type { Principal } from "./types.ts";

interface Bucket {
  tokens: number;
  last: number;
}

export class WriteRateLimiter {
  declare readonly perMinute: number;
  declare readonly burst: number;
  declare readonly now: () => number;
  declare readonly buckets: Map<string, Bucket>;
  declare sweepAt: number;
  /**
   * @param {{ perMinute: number, burst: number, now?: () => number }} opts
   *   perMinute <= 0 disables the limiter entirely.
   */
  constructor({ perMinute, burst, now = Date.now }: { perMinute: number; burst: number; now?: () => number }) {
    this.perMinute = perMinute;
    this.burst = Math.max(1, burst);
    this.now = now;
    this.buckets = new Map();
    this.sweepAt = now() + SWEEP_INTERVAL_MS;
  }

  get enabled() {
    return this.perMinute > 0;
  }

  /**
   * Try to spend one write for `key` ("user:…", "token:…", or "ip:…").
   * @returns {{ ok: true } | { ok: false, retryAfterS: number }}
   */
  check(key: string): { ok: true } | { ok: false; retryAfterS: number } {
    if (!this.enabled) return { ok: true };
    const t = this.now();
    const ratePerMs = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, last: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + (t - b.last) * ratePerMs);
      b.last = t;
    }
    if (t >= this.sweepAt || this.buckets.size > MAX_BUCKETS) this.#sweep(t);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) };
  }

  /**
   * Drop buckets idle long enough to have refilled — they hold no information.
   * A flood of distinct keys (many IPs/tokens) could otherwise grow the map
   * between scheduled sweeps, so a size cap forces a sweep early and, if still
   * over, evicts the oldest-touched entries. Eviction only resets a key to a
   * full burst — fail-open, matching the limiter's existing degradation.
   */
  #sweep(t: number): void {
    this.sweepAt = t + SWEEP_INTERVAL_MS;
    const idleMs = (this.burst / (this.perMinute / 60_000)) + SWEEP_INTERVAL_MS;
    for (const [key, b] of this.buckets) {
      if (t - b.last > idleMs) this.buckets.delete(key);
    }
    if (this.buckets.size > MAX_BUCKETS) {
      const excess = this.buckets.size - MAX_BUCKETS;
      let i = 0;
      for (const key of this.buckets.keys()) {
        if (i++ >= excess) break;
        this.buckets.delete(key); // Map iterates in insertion order → oldest first
      }
    }
  }
}

const SWEEP_INTERVAL_MS = 60_000;
// Hard ceiling on distinct tracked principals; ~a few MB at this size.
const MAX_BUCKETS = 100_000;

/** The limiter key for a request: the principal when known, else the peer IP. */
export function limiterKey(principal: Principal | null, req: IncomingMessage): string {
  if (principal?.kind === "token") return `token:${principal.tokenId}`;
  if (principal) return `user:${principal.userId ?? principal.subject}`;
  return `ip:${req.socket?.remoteAddress || "unknown"}`;
}
