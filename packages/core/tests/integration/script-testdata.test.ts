// The test-data lifecycle (DESIGN §6,
// docs/contracts/scripts.md#test-data-lifecycle), proven against real
// executions: a mutating suite creates real rows in a loopback fixture, the
// harness counts them from the recorded traffic, and the declared cleanup runs
// over the same wire the script used.
//
// Three facts the exit gate asks for live here: created identifiers carry the
// run namespace, a simulated cleanup failure surfaces in the run result, and a
// suite that silts up its environment fails loudly rather than passing with a
// footnote.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DummyConfigError } from "../../src/config.ts";
import { isRunNamespace, resolveCleanupPolicy, runNamespace, runScript } from "../../src/public/api-suite-scripts.ts";
import { startScriptApi } from "../../../../tests/fixtures/script-api/server.ts";

const SUITES = fileURLToPath(new URL("../../../../tests/fixtures/script-suites/", import.meta.url));
const RULES = [
  { id: "health", statement: "GET /health answers { ok: true }" },
  { id: "items", statement: "GET /items answers an items array" },
  { id: "mutation", statement: "a created item reads back unchanged" },
];

let api: LegacyTestValue;
let outDir: LegacyTestValue;

const grant = () => ({ origin: api.origin, approved_by: "ada", approved_at: "2026-07-26T00:00:00.000Z" });

const run = (script: LegacyTestValue, { cleanup = null, params = {}, write = true, budget = 40 }: LegacyTestValue = {}) =>
  runScript({
    script: path.join(SUITES, script),
    target: { base_url: api.url, ...(write ? { write_grant: grant() } : {}), ...(cleanup ? { cleanup } : {}) },
    rules: RULES,
    params,
    budget,
    out_dir: outDir,
  });

beforeEach(async () => {
  api = await startScriptApi();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-testdata-"));
});

afterEach(async () => {
  await api.close();
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("a namespace is minted per run and no two runs can produce the same one", () => {
  const one = runNamespace();
  const two = runNamespace();
  assert.ok(isRunNamespace(one), one);
  assert.notEqual(one, two);
  // Same millisecond, different run: the random half is what makes this a non-event.
  const at = Date.now();
  const same = new Set(Array.from({ length: 200 }, () => runNamespace({ at })));
  assert.equal(same.size, 200);
  assert.equal(isRunNamespace("pt-hand-typed"), false);
});

test("created resources carry the run namespace, and the harness counts them from the traffic", async () => {
  const result = await run("namespaced.mjs", { params: { tidy: false } });

  assert.equal(result.exitCode, 0, JSON.stringify(result.report.soundness));
  const namespace = result.report.run.namespace;
  assert.ok(isRunNamespace(namespace), namespace);

  // The fixture's own record of what it was asked to create.
  const created = api.requests.filter((request: LegacyTestValue) => request.method === "POST" && request.path === "/items");
  assert.equal(created.length, 1);

  assert.deepEqual(
    { created: result.report.test_data.created, namespaced: result.report.test_data.namespaced, unnamespaced: result.report.test_data.unnamespaced },
    { created: 1, namespaced: 1, unnamespaced: 0 },
  );
  assert.equal(result.report.test_data.outstanding, 1);
  assert.deepEqual(result.report.test_data.by_collection, { "/items": 1 });

  // Two concurrent replays of the same suite create names that cannot collide.
  const second = await run("namespaced.mjs", { params: { tidy: false } });
  assert.notEqual(second.report.run.namespace, namespace);
});

test("a suite that deletes what it created leaves nothing outstanding", async () => {
  const result = await run("namespaced.mjs");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    { created: result.report.test_data.created, deleted: result.report.test_data.deleted, outstanding: result.report.test_data.outstanding },
    { created: 1, deleted: 1, outstanding: 0 },
  );
  assert.equal(result.report.cleanup.policy, "teardown");
  assert.equal(result.report.cleanup.ok, true);
});

test("a declared reset is run by the harness, over the same wire, after the script", async () => {
  const result = await run("namespaced.mjs", {
    params: { tidy: false },
    cleanup: { policy: "reset", reset: { method: "POST", path: "/admin/reset" } },
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.report.soundness));
  assert.equal(result.report.cleanup.policy, "reset");
  assert.equal(result.report.cleanup.attempted, true);
  assert.equal(result.report.cleanup.ok, true);
  assert.equal(result.report.cleanup.reset, "POST /admin/reset");

  // It happened, it happened last, and it is in the evidence like any request.
  const reset = api.requests.filter((request: LegacyTestValue) => request.path === "/admin/reset");
  assert.equal(reset.length, 1);
  assert.equal(api.requests.at(-1).path, "/admin/reset");
  assert.equal(result.harEntries.at(-1).request.url, `${api.url}/admin/reset`);
  // It is counted like any other request — the recorded trace is the budget —
  // but it is exempt from the ceiling: a suite that spent its whole allowance
  // must still be able to put the environment back.
  assert.equal(result.report.run.budget.used, 5);
  const spent = await run("namespaced.mjs", {
    params: { tidy: false },
    budget: 4,
    cleanup: { policy: "reset", reset: { method: "POST", path: "/admin/reset" } },
  });
  assert.equal(spent.report.cleanup.ok, true);
  assert.deepEqual(spent.report.guard, []);
});

test("a failed cleanup is reported, never silent — the run goes red and says why", async () => {
  await api.close();
  api = await startScriptApi({ resetFails: true });

  const result = await run("namespaced.mjs", {
    params: { tidy: false },
    cleanup: { policy: "reset", reset: { method: "POST", path: "/admin/reset" } },
  });

  // Every check passed; the run is still red, because a cleanup nobody notices
  // is how an environment silts up.
  assert.ok(result.report.checks.every((check: LegacyTestValue) => check.pass));
  assert.equal(result.report.verdict.report_pass, true);
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.soundness.ok, false);
  assert.equal(result.report.cleanup.ok, false);
  assert.match(result.report.cleanup.detail, /answered 503/);
  assert.ok(result.report.soundness.reasons.some((reason: LegacyTestValue) => /cleanup failed: the declared reset POST \/admin\/reset/.test(reason)));
});

test("best-effort teardown that stops keeping up fails the run at the accumulation cap", async () => {
  const under = await run("accumulates.mjs", { params: { create: 2 }, cleanup: { policy: "teardown", accumulation_cap: 2 } });
  assert.equal(under.exitCode, 0);
  assert.equal(under.report.test_data.over_cap, false);

  const over = await run("accumulates.mjs", { params: { create: 3 }, cleanup: { policy: "teardown", accumulation_cap: 2 } });
  assert.ok(over.report.checks.every((check: LegacyTestValue) => check.pass));
  assert.equal(over.exitCode, 2);
  assert.equal(over.report.test_data.over_cap, true);
  assert.equal(over.report.test_data.outstanding, 3);
  assert.ok(over.report.soundness.reasons.some((reason: LegacyTestValue) => /past this target's accumulation cap of 2/.test(reason)));
});

test("a read-only run has nothing to clean up, and says so rather than pretending a reset ran", async () => {
  const policy = resolveCleanupPolicy({ policy: "reset", reset: { method: "POST", path: "/admin/reset" } }, { write: false });
  assert.equal(policy.policy, "none");
  assert.equal(policy.reset, null);
});

test("a malformed cleanup declaration is user input, with an actionable message and no stack", () => {
  assert.throws(() => resolveCleanupPolicy("scrub", { where: "script run" }), (error) => {
    assert.ok(error instanceof DummyConfigError);
    assert.match(error.message, /target\.cleanup\.policy must be one of reset, teardown, none/);
    return true;
  });
  assert.throws(() => resolveCleanupPolicy({ policy: "reset" }), /needs the reset affordance the authorization declared/);
  assert.throws(() => resolveCleanupPolicy({ reset: { path: "admin/reset" } }), /must be a path on the target beginning with "\/"/);
  assert.throws(() => resolveCleanupPolicy({ policy: "teardown", accumulation_cap: -1 }), /non-negative integer/);
});
