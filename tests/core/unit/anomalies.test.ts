// Pure deterministic anomaly extractor (src/core/anomalies.ts, DESIGN D2).
// Every supported signal type, the deliberate exclusions, and the "emits
// nothing" cases. Some fixtures are the FROZEN P0 corpus runs so the extractor
// stays consistent with the recorded evidence shapes it must consume.
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractAnomalies, formatSignals } from "../../../src/core/anomalies.ts";
import { FIXTURES } from "../findings/corpus.ts";

const byId: LegacyTestValue = Object.fromEntries(FIXTURES.map((f) => [f.id, f]));
const runEnvelopes = (fixtureId: string, runIdx = 0): LegacyTestValue => byId[fixtureId].runs[runIdx].envelopes;
const types = (signals: LegacyTestValue[]) => signals.map((s: LegacyTestValue) => s.type);

test("http_5xx: a 500 response is surfaced factually", () => {
  // F1 run 1 step 2: DELETE /api/cart/items/8842 → 500, plus a console log of it.
  const signals: LegacyTestValue = extractAnomalies(runEnvelopes("exact-recurrence-noisy-ids"));
  assert.ok(types(signals).includes("http_5xx"), "500 emits http_5xx");
  const http: LegacyTestValue = signals.find((s: LegacyTestValue) => s.type === "http_5xx");
  assert.equal(http.step, 2);
  assert.equal(http.locus.status_class, "5xx");
  assert.match(http.detail, /DELETE \/api\/cart\/items/);
});

test("console_exception: a captured console/page error is surfaced", () => {
  const signals: LegacyTestValue = extractAnomalies(runEnvelopes("exact-recurrence-noisy-ids"));
  assert.ok(types(signals).includes("console_exception"));
});

test("http_4xx: an intended 404 is STILL emitted factually (exclusion is grader-side)", () => {
  // F10 is intended behavior, seeded:false. The extractor has no classification
  // logic, so the deterministic 404 signal is emitted anyway; the grader rejects
  // it as intended. This is exactly the P1 exit-gate distinction.
  const signals: LegacyTestValue = extractAnomalies(runEnvelopes("intended-404-not-a-bug"));
  const t = types(signals);
  assert.ok(t.includes("http_4xx"), "the deliberate 404 still emits http_4xx");
  assert.ok(t.includes("no_effect"), "the correctly-disabled control still emits no_effect");
  const http: LegacyTestValue = signals.find((s: LegacyTestValue) => s.type === "http_4xx");
  assert.equal(http.locus.status_class, "4xx");
});

test("no_effect: a harness no_effect confusion marker is surfaced", () => {
  // F6 step 2 carries confusion.type === "no_effect".
  const signals: LegacyTestValue = extractAnomalies(runEnvelopes("expectation-vs-observed"));
  assert.ok(types(signals).includes("no_effect"));
  assert.equal(signals.find((s: LegacyTestValue) => s.type === "no_effect").step, 2);
});

test("clean run emits NOTHING", () => {
  // F11: checkout succeeds (POST /api/orders 201), only an actor confusion RAISE
  // (not a harness confusion marker), no network error, no console error.
  assert.deepEqual(extractAnomalies(runEnvelopes("ux-friction-stays-grader-finding")), []);
  assert.equal(formatSignals([]), "");
});

test("failed_action: an action_failed confusion marker is surfaced", () => {
  const env = [{ step: 1, result: { ok: false, error: "element not found" }, confusion: { type: "action_failed", note: "element not found" } }];
  assert.deepEqual(types(extractAnomalies(env)), ["failed_action"]);
});

test("failed_action: an errored step with no confusion marker still surfaces", () => {
  const env = [{ step: 1, result: { ok: false, error: "navigation timeout" } }];
  const signals: LegacyTestValue = extractAnomalies(env);
  assert.deepEqual(types(signals), ["failed_action"]);
  assert.match(signals[0].detail, /navigation timeout/);
});

test("repeated_action: a repeated_action confusion marker is surfaced", () => {
  const env = [{ step: 3, result: { ok: true }, confusion: { type: "repeated_action", note: "same action twice" } }];
  assert.deepEqual(types(extractAnomalies(env)), ["repeated_action"]);
});

test("state_drift is EXCLUDED (a skipped step, not an app malfunction)", () => {
  const env = [{ step: 2, result: { ok: false, error: null }, confusion: { type: "state_drift", note: "page drifted" } }];
  assert.deepEqual(extractAnomalies(env), []);
});

test("a request pending at settle (status 0) is not an error", () => {
  const env = [{ step: 1, result: { ok: true }, network: { requests: [{ method: "GET", path: "/slow", status: 0 }] } }];
  assert.deepEqual(extractAnomalies(env), []);
});

test("perf_budget: a recorded metric over the case budget is surfaced", () => {
  const env = [{ step: 1, result: { ok: true }, perf: { nav: { lcp_ms: 4200 } } }];
  const signals: LegacyTestValue = extractAnomalies(env, { perf: { lcp_ms: "< 2500" } });
  assert.deepEqual(types(signals), ["perf_budget"]);
  assert.match(signals[0].detail, /lcp_ms 4200 violates < 2500/);
});

test("perf_budget: a metric within budget emits nothing; absent budget emits nothing", () => {
  const env = [{ step: 1, result: { ok: true }, perf: { nav: { lcp_ms: 1200 } } }];
  assert.deepEqual(extractAnomalies(env, { perf: { lcp_ms: "< 2500" } }), []);
  assert.deepEqual(extractAnomalies(env), []);
});

test("extractor is pure: identical input ⇒ identical output", () => {
  const env = runEnvelopes("loose-key-two-stories");
  assert.deepEqual(extractAnomalies(env), extractAnomalies(env));
});

test("formatSignals renders one compact line per signal", () => {
  const text = formatSignals([
    { type: "http_5xx", step: 2, detail: "DELETE /x → 500" },
    { type: "no_effect", step: 3, detail: "no change" },
  ]);
  assert.equal(text, "step 2: http_5xx — DELETE /x → 500\nstep 3: no_effect — no change");
});
