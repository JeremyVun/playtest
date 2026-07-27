// The worked example for passive cross-layer assertions, end to end: real
// Chromium, the real todo app, the committed suite at
// tests/fixtures/web-invariants (docs/contracts/engine.md#invariant-policies).
//
// The point of the phase is a failure no other web gate kind can see. So the
// two runs below differ ONLY in the API underneath: the same clicks, the same
// rendered page, the same element check, the same api_called — and one of them
// is red, because har.json says POST /api/todos answered a status the OpenAPI
// document does not declare.
//
// Browser tier, never the root gate: this needs a Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { start as startApp } from "../../fixtures/todo-app/server.ts";
import { discoverCases } from "../../../src/core/config.ts";
import { WebDriver } from "../../../src/core/drivers/web.ts";
import { evaluateGate } from "../../../src/core/gate.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.resolve(HERE, "../../fixtures/web-invariants");

let tmpRoot: LegacyTestValue;
const apps: LegacyTestValue = [];
let n = 0;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-web-inv-"));
});

after(async () => {
  for (const a of apps) await a.close().catch(() => {});
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Run the committed suite's journey against a fresh todo app and evaluate its
 * declared gate. The trajectory is assembled exactly as runner.js does it: the
 * harness's initial navigation as a bare { perf, network } entry owned by no
 * step, then one envelope per acted step carrying `network` and the
 * `artifacts.har_entries` slice that makes a violation step-linkable.
 */
async function journey({ apiFault = null }: LegacyTestValue = {}) {
  const app = await startApp({ apiFault });
  apps.push(app);
  const runDir = fs.mkdtempSync(path.join(tmpRoot, `run-${++n}-`));
  const [rc]: LegacyTestValue = await discoverCases([SUITE], { baseUrl: app.url });
  const driver: LegacyTestValue = await WebDriver.launch({ baseUrl: app.url, runDir, openapi: rc.env.openapi, caseFile: rc.file });
  try {
    const nav = await driver.start();
    assert.equal(nav.ok, true, nav.error ?? "the app did not open");
    const trajectory: LegacyTestValue = [{ perf: nav.perf, network: nav.network }];

    // Step 1: type the todo and submit. The form's submit handler POSTs, so the
    // create lands inside THIS step's HAR window — which is what the step
    // citation on the violation has to name.
    const snap = await driver.captureSnapshot(1);
    const ref = /\[(e\d+)\] textbox/.exec(snap.text)?.[1];
    assert.ok(ref, `no text field in the snapshot:\n${snap.text}`);
    const exec = await driver.execute({ type: "type", ref, text: "buy milk", submit: true }, { step: 1 });
    assert.equal(exec.ok, true, exec.error ?? "typing failed");
    trajectory.push({ step: 1, result: { ok: true }, network: exec.network, artifacts: { har_entries: exec.har_entries } });

    await driver.flushHar();
    const harEntries = JSON.parse(fs.readFileSync(path.join(runDir, "har.json"), "utf8")).log.entries;
    const gate = await evaluateGate(rc, {
      driver,
      spec: driver.spec,
      harEntries,
      trajectory,
      finalUrl: driver.location(),
      consoleErrorCount: driver.consoleErrors(),
      consoleErrorLog: driver.consoleErrorLog(),
      checkAssertion: null,
    });
    return { gate, harEntries };
  } finally {
    await driver.close();
  }
}

test("a healthy API under the UI: the committed web suite's Tier-1 policies hold over the page's own traffic", async () => {
  const { gate, harEntries }: { gate: { pass: boolean; checks: LegacyTestValue[]; advisory: LegacyTestValue[] }; harEntries: LegacyTestValue[] } = await journey();

  // The spec-driven policies really did see the browser's requests.
  assert.ok(
    harEntries.some((e: LegacyTestValue) => e.request.method === "POST" && e.request.url.endsWith("/api/todos")),
    "the page POSTed the new todo",
  );
  assert.equal(gate.pass, true, `gate should pass: ${JSON.stringify(gate.checks.filter((c) => !c.pass))}`);
  assert.equal(
    gate.checks.filter((c: LegacyTestValue) => c.kind === "invariant").every((c: LegacyTestValue) => c.applicable && c.pass),
    true,
    "all four Tier-1 policies were exercised by the page and held",
  );
  // Advisory, never gating: the story never deletes, so lifecycle reports.
  assert.equal(gate.advisory.length, 1);
  assert.equal(gate.advisory[0].applicable, false);
});

test("an API-layer violation invisible in the UI turns the same web journey red, cited against the step that caused it", async () => {
  const { gate } = await journey({ apiFault: "created-status" });

  // Same page, same clicks: every pre-P7 web check is still green.
  assert.equal(gate.checks.find((c: LegacyTestValue) => c.kind === "element_exists").pass, true, "the todo really is rendered");
  assert.equal(gate.checks.find((c: LegacyTestValue) => c.kind === "api_called").pass, true, "the request really was made");

  assert.equal(gate.pass, false, "and the run is red anyway — the API underneath broke its contract");
  const failed = gate.checks.filter((c: LegacyTestValue) => !c.pass);
  assert.deepEqual(failed.map((c: LegacyTestValue) => c.spec), ["invariant: documented_status"]);
  assert.match(failed[0].detail, /POST \/api\/todos answered 200, which the spec does not declare/);
  assert.deepEqual(failed[0].steps, [1], "the submit step is cited, not the initial page load");
});
