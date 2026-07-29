// Write-route rate limiting: the token bucket itself (injected clock,
// no timers) and the config validation for its env knobs.
import test from "node:test";
import assert from "node:assert/strict";
import { WriteRateLimiter, limiterKey } from "../../src/rate-limit.ts";
import { loadConfig } from "../../src/config.ts";

const BASE_ENV = { PLAYTEST_AUTH: "dev" };

test("token bucket: burst, exhaustion, refill, and Retry-After", () => {
  let t = 0;
  const limiter = new WriteRateLimiter({ perMinute: 60, burst: 3, now: () => t });
  assert.equal(limiter.enabled, true);

  // The burst is spendable immediately; the next write is refused.
  for (let i = 0; i < 3; i++) assert.equal(limiter.check("user:a").ok, true, `burst write ${i}`);
  const refused = limiter.check("user:a");
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterS >= 1, `retryAfterS=${refused.retryAfterS}`);

  // 60/min = 1 token per second: one second later exactly one write fits.
  t += 1000;
  assert.equal(limiter.check("user:a").ok, true);
  assert.equal(limiter.check("user:a").ok, false);

  // Other principals have their own bucket.
  assert.equal(limiter.check("user:b").ok, true);

  // A long idle refills back to the full burst, never beyond.
  t += 3600_000;
  for (let i = 0; i < 3; i++) assert.equal(limiter.check("user:a").ok, true, `refilled write ${i}`);
  assert.equal(limiter.check("user:a").ok, false);
});

test("perMinute 0 disables the limiter", () => {
  const limiter = new WriteRateLimiter({ perMinute: 0, burst: 1, now: () => 0 });
  assert.equal(limiter.enabled, false);
  for (let i = 0; i < 100; i++) assert.equal(limiter.check("user:a").ok, true);
});

test("idle buckets are swept; active ones survive", () => {
  let t = 0;
  const limiter = new WriteRateLimiter({ perMinute: 60, burst: 3, now: () => t });
  limiter.check("user:idle");
  t += 10 * 60_000; // far past refill + sweep interval
  limiter.check("user:busy"); // triggers the sweep
  assert.equal(limiter.buckets.has("user:idle"), false);
  assert.equal(limiter.buckets.has("user:busy"), true);
});

test("limiterKey prefers principal identity over IP", () => {
  assert.equal(limiterKey({ kind: "token", tokenId: "tk1" }, {} as HostedDynamic), "token:tk1");
  assert.equal(limiterKey({ kind: "user", userId: "u1" }, {} as HostedDynamic), "user:u1");
  assert.equal(limiterKey(null, { socket: { remoteAddress: "10.0.0.9" } } as HostedDynamic), "ip:10.0.0.9");
});

test("config validates the rate-limit and reconcile env knobs", () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.rateLimit.writesPerMinute, 240);
  assert.equal(config.rateLimit.writeBurst, 60);
  assert.equal(config.reconcile.intervalMs, 30_000);

  assert.equal(loadConfig({ ...BASE_ENV, PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "0" }).rateLimit.writesPerMinute, 0);
  assert.throws(
    () => loadConfig({ ...BASE_ENV, PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "lots" }),
    /PLAYTEST_RATE_LIMIT_WRITES_PER_MIN/,
  );
  assert.throws(
    () => loadConfig({ ...BASE_ENV, PLAYTEST_RATE_LIMIT_WRITE_BURST: "0" }),
    /PLAYTEST_RATE_LIMIT_WRITE_BURST/,
  );
  assert.throws(
    () => loadConfig({ ...BASE_ENV, PLAYTEST_RECONCILE_INTERVAL_S: "-1" }),
    /PLAYTEST_RECONCILE_INTERVAL_S/,
  );
});
