// The performance sidecar (packages/core/src/perf.ts): a per-run `perf.jsonl`
// of timed spans, written for diagnosis only.
//
// Two properties matter and are asserted here:
//
//   1. it MEASURES — the spans a phase is accepted against actually appear, in
//      an order that matches how a step really runs (snapshot, then the actor
//      call, then the dispatch);
//   2. it CHANGES NOTHING — `trajectory.jsonl` is byte-identical with the
//      sidecar on and off, and PLAYTEST_PERF_SIDECAR=0 writes no file at all.
//
// Hermetic: the scripted in-memory web driver rides runCase's driverFactory
// seam and the scripted OpenAI gateway plays the actor and the grader — real
// runner, real writer, real artifacts, no browser and no model. A second case
// uses the REAL api driver against the local invariant-api fixture, so the
// driver-side spans (snapshot_write, action_perform, har_flush) are exercised
// by production driver code rather than a fake.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { discoverCases } from "../../src/config.ts";
import { runCase } from "../../src/runner.ts";
import { newRunId } from "../../src/trajectory.ts";
import { startInvariantApi } from "../../../../tests/fixtures/invariant-api/server.ts";
import { startScriptedModel } from "../../../../tests/support/scripted-model.ts";
import { ScriptedWebDriver } from "../../../../tests/support/scripted-web-driver.ts";

let tmpRoot: LegacyTestValue;
let baseUrl: LegacyTestValue; // a real origin for prepareEnv's reachability probe
const servers: LegacyTestValue = [];

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-perf-"));
  const probe = http.createServer((req, res) => res.end("ok")) as Omit<ReturnType<typeof http.createServer>, "address"> & { address(): { port: number } }; // SAFETY: a listening TCP server has an AddressInfo result
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => new Promise<LegacyTestValue>((r) => probe.close(r)) });
  baseUrl = `http://127.0.0.1:${probe.address().port}`;
});

after(async () => {
  for (const s of servers) await s.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PLAYTEST_LLM_BASE_URL;
  delete process.env.PLAYTEST_PERF_SIDECAR;
});

const SCREENS = {
  home: { text: "home screen\n[e1] button Next" },
  details: { text: "details screen\n[e2] button Continue" },
  receipt: { text: "receipt screen\nOrder placed", elements: ["#done"] },
};
const TRANSITIONS = { "home e1": "details", "details e2": "receipt" };
const SCRIPT = [
  { thought: "click next", action: { type: "click", ref: "e1" }, expectation: "the details screen" },
  { thought: "click continue", action: { type: "click", ref: "e2" }, expectation: "the receipt" },
  { thought: "finished", action: { type: "done", summary: "reached the receipt" }, expectation: "the journey is complete" },
];

/** A private suite dir, so each run records rather than replaying a sibling's baseline. */
function writeSuite(name: LegacyTestValue) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(path.join(dir, "playtest.yaml"), ["app:", `  base_url: ${baseUrl}`, ""].join("\n"));
  fs.writeFileSync(
    path.join(dir, "stories", "journey.yaml"),
    ["story: |", "  Walk the wizard to the receipt screen.", "success:", '  - element_exists: "#done"', ""].join("\n"),
  );
  return dir;
}

/** One scripted record run in its own suite. */
async function record(label: LegacyTestValue) {
  const suite = writeSuite(label);
  const model = await startScriptedModel(SCRIPT);
  servers.push(model);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const res = await runCase(rc, {
    runsRoot: path.join(tmpRoot, `runs-${label}`),
    runId: newRunId(),
    onEvent: () => {},
    driverFactory: async () => new ScriptedWebDriver({ start: "home", screens: SCREENS, transitions: TRANSITIONS }),
  });
  delete process.env.PLAYTEST_LLM_BASE_URL;
  return res;
}

const readSpans = (runDir: LegacyTestValue) =>
  fs.readFileSync(path.join(runDir, "perf.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));

// `ts` is the wall-clock dispatch stamp every envelope already carries, so two
// runs of the same journey differ there whatever the sidecar does. Neutralize
// exactly that field: what remains is a byte comparison of everything the
// harness actually authored.
const withoutStamps = (runDir: LegacyTestValue) =>
  fs.readFileSync(path.join(runDir, "trajectory.jsonl"), "utf8").replace(/"ts":\d+/g, '"ts":0');

test("the sidecar records the spans a phase is accepted against, in step order", async () => {
  const res = await record("spans");
  assert.equal(res.status, "pass", `the scripted record run passes (error: ${res.error ?? "none"})`);

  const spans = readSpans(res.runDir);
  const names = new Set(spans.map((s) => s.span));
  for (const required of [
    "snapshot", "actor_request", "action_dispatch", "effect_token",
    "driver_close", "env_teardown", "vtt", "slideshow", "grade_total", "case_total",
  ]) {
    assert.ok(names.has(required), `perf.jsonl carries a ${required} span (saw ${[...names].sort().join(", ")})`);
  }

  // Every row is the documented shape.
  for (const row of spans) {
    assert.equal(typeof row.t, "number");
    assert.equal(typeof row.ms, "number");
    assert.ok(row.ms >= 0, `${row.span} has a non-negative duration`);
    assert.ok(row.step === null || typeof row.step === "number");
  }

  // Spans are appended in the order they closed, so `t` never goes backwards.
  const stamps = spans.map((s) => s.t);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), "spans are written in closing order");

  // A recorded step really runs snapshot -> actor -> effect token -> dispatch.
  const orderFor = (step: LegacyTestValue, span: LegacyTestValue) =>
    spans.findIndex((s) => s.span === span && s.step === step);
  assert.ok(orderFor(1, "snapshot") < orderFor(1, "actor_request"), "the snapshot precedes the actor call");
  assert.ok(orderFor(1, "actor_request") < orderFor(1, "effect_token"), "the actor call precedes the effect token");
  assert.ok(orderFor(1, "effect_token") < orderFor(1, "action_dispatch"), "the effect token precedes the dispatch");

  // actor_request carries what a Phase 0 baseline needs to read: the token
  // split and how many extra model calls the turn actually paid for.
  const actor = spans.find((s) => s.span === "actor_request");
  assert.equal(actor.meta.tokens_in, 10, "the scripted gateway's prompt tokens are billed to the span");
  assert.equal(actor.meta.validation_retries, 0);
  assert.equal(actor.meta.http_retries, 0);

  // case_total closes last and encloses every other span.
  const last = spans[spans.length - 1];
  assert.equal(last.span, "case_total");
  assert.equal(last.step, null);
  assert.equal(last.meta.driver, "web");
  assert.equal(last.meta.start_mode, "record");
  assert.equal(last.meta.end_reason, "done");
  assert.equal(last.meta.steps, 3);
  for (const row of spans) assert.ok(row.ms <= last.ms + 1, `${row.span} fits inside case_total`);
});

test("PLAYTEST_PERF_SIDECAR=0 writes no sidecar, and the trajectory is byte-identical either way", async () => {
  const on = await record("flag-on");
  assert.ok(fs.existsSync(path.join(on.runDir, "perf.jsonl")), "the sidecar is on by default");

  process.env.PLAYTEST_PERF_SIDECAR = "0";
  let off: LegacyTestValue;
  try {
    off = await record("flag-off");
  } finally {
    delete process.env.PLAYTEST_PERF_SIDECAR;
  }
  assert.equal(off.status, "pass", `the disabled run still passes (error: ${off.error ?? "none"})`);
  assert.equal(
    fs.existsSync(path.join(off.runDir, "perf.jsonl")), false,
    "a disabled sidecar writes no file at all",
  );

  // The whole point of a sidecar: trajectory.jsonl is pinned by committed
  // baselines, so instrumentation must not move a single byte of it.
  assert.equal(withoutStamps(off.runDir), withoutStamps(on.runDir));
});

test("the api driver reports its own capture and request spans", async () => {
  const target = await startInvariantApi({});
  servers.push(target);
  const suite = path.join(tmpRoot, "api-suite");
  fs.mkdirSync(path.join(suite, "stories"), { recursive: true });
  fs.writeFileSync(path.join(suite, "playtest.yaml"), "app:\n  driver: api\n");
  fs.writeFileSync(
    path.join(suite, "stories", "ledger.yaml"),
    ["story: |", "  Open an account and read it back.", "success:", '  - response_status: "200"', ""].join("\n"),
  );
  const model = await startScriptedModel([
    { thought: "open an account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "perf" } }, expectation: "201" },
    { thought: "read it back", action: { type: "request", method: "GET", path: "/accounts/acc_A_1" }, expectation: "200" },
    { thought: "done", action: { type: "done", summary: "the account exists" }, expectation: "the journey is complete" },
  ]);
  servers.push(model);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const [rc]: LegacyTestValue = await discoverCases([suite], { baseUrl: target.url });
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs-api"), runId: newRunId(), grade: false, onEvent: () => {} });
  delete process.env.PLAYTEST_LLM_BASE_URL;

  assert.equal(res.status, "pass", `the api record run passes (error: ${res.error ?? "none"})`);
  const spans = readSpans(res.runDir);
  const names = new Set(spans.map((s) => s.span));
  for (const required of ["snapshot", "snapshot_write", "action_perform", "har_flush", "case_total"]) {
    assert.ok(names.has(required), `the api driver reports ${required} (saw ${[...names].sort().join(", ")})`);
  }
  const request = spans.find((s) => s.span === "action_perform");
  assert.equal(request.meta.method, "POST");
  assert.equal(request.meta.status, 201);
  assert.equal(request.meta.ok, true);
  assert.equal(spans.find((s) => s.span === "case_total").meta.driver, "api");
});
