// Hosted viewer load-pass pin: a scaled-down run of the viewer-load harness
// (src/platform/control-plane/tests/load/viewer-load.ts) asserting
// the hosted read path serves N concurrent viewer sessions with ZERO errors —
// every response 200 and parseable where JSON — under a deliberately tiny bundle
// LRU so evictions happen constantly mid-load. viewer-adapter.js exposes no cache
// introspection (bundleCache is module-private, by design), so eviction is pinned
// BEHAVIORALLY: the cap is 1 MiB, each seeded bundle is ~0.7 MiB, sessions rotate
// across 4 bundles > 2.8 MiB total, and every bundle-entry response is
// sha256-verified against the sealed bundle (verifyBytes) — a broken miss/reload
// path would surface as a byte-mismatch error, a broken byte accounting as a 5xx.
// The p95 bound is deliberately generous (< 2000 ms) — this pins "not pathological
// under concurrency", never a machine-speed number that would flake in CI.
//
// PLAYTEST_VIEW_CACHE_MB is a MODULE-LEVEL constant in viewer-adapter.js computed
// from process.env at import time, so it is set here BEFORE the first dynamic
// import of anything that transitively pulls the adapter in (same ESM-hoisting
// workaround documented by the load harness).
process.env.PLAYTEST_VIEW_CACHE_MB = "1";

const { test } = await import("node:test");
const assert: HostedDynamic = (await import("node:assert/strict")).default;
const { runViewerLoad } = await import("../load/viewer-load.ts");

const RUNS = 4; // M seeded bundles
const SESSIONS = 12; // N concurrent viewer sessions
const SECONDS = 3; // T
const BUNDLE_KB = 700; // ~0.7 MiB per bundle: any two exceed the 1 MiB cap → constant eviction
const P95_BOUND_MS = 2000; // generous by design; see header

test("phase7 viewer read path under load: zero errors, byte-correct across constant LRU eviction", async () => {
  const report: HostedDynamic = await runViewerLoad({
    runs: RUNS,
    sessions: SESSIONS,
    seconds: SECONDS,
    bundleKb: BUNDLE_KB,
    verifyBytes: true,
  });

  // The eviction premise must actually hold, or the whole test is theater.
  assert.equal(report.config.cacheMb, 1, "the tiny cache cap must be in effect for this test");
  assert.ok(
    report.config.bundleBytesTotal > 1 * 1024 * 1024,
    `seeded bundles (${report.config.bundleBytesTotal} bytes) must exceed the 1 MiB cap to force eviction`,
  );

  // Zero errors: every response was a 200, parseable where JSON, and every
  // bundle-entry byte-identical to the sealed bundle (cache-miss path correct).
  assert.equal(report.errorCount, 0, `read path errored under load: ${JSON.stringify(report.errors, null, 2)}`);

  // The load actually loaded: every route class was exercised, and every one of
  // the N sessions completed at least one full loop (6 requests per loop).
  assert.ok(report.totalRequests >= SESSIONS * 6, `only ${report.totalRequests} requests — sessions barely ran`);
  for (const [name, s] of Object.entries(report.classes) as HostedDynamic) {
    assert.ok(s.count > 0, `route class "${name}" was never hit`);
    assert.ok(
      s.p95 != null && s.p95 < P95_BOUND_MS,
      `${name} p95 ${s.p95?.toFixed(1)}ms exceeds the generous ${P95_BOUND_MS}ms bound — pathological under concurrency`,
    );
  }
});
