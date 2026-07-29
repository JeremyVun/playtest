// Passive cross-layer assertions: the Tier-1/2 invariant policies evaluating
// over a WEB run's recorded HAR (docs/contracts/engine.md#invariant-policies).
//
// The question this makes gateable is "the UI looked fine, but did the API
// underneath behave?" — so the fault under test is deliberately one no other
// gate kind can see: the page renders identically, the element check passes,
// api_called passes, and only the OpenAPI document knows the status was wrong.
//
// Hermetic: no browser. A web run reaching the gate is exactly two things — the
// trajectory (step envelopes carrying `network` and `artifacts.har_entries`)
// and the parsed `har.json` entries — and both are built here in the shape the
// web driver records them. tests/core/browser/web-invariants.test.ts drives the
// same committed suite against a real Chromium and a real todo app.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { DummyConfigError, discoverCases } from "../../src/config.ts";
import { evaluateGate } from "../../src/gate.ts";
import { loadOpenApi } from "../../src/openapi.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.resolve(HERE, "../../../../tests/fixtures/web-invariants");
const TODOS = path.resolve(HERE, "../../../../tests/fixtures/todos");
const BASE = "http://127.0.0.1:4173";

const SPEC = loadOpenApi(path.join(SUITE, "openapi.yaml"));

/** A recorded HAR entry in the shape the web driver writes into har.json. */
function entry(method: LegacyTestValue, url: LegacyTestValue, status: LegacyTestValue, { body = null, mime = "application/json", sent = null }: LegacyTestValue = {}) {
  return {
    request: { method, url: `${BASE}${url}`, headers: {}, body: sent === null ? null : JSON.stringify(sent) },
    response: { status, mimeType: mime, headers: {}, body: body === null ? null : JSON.stringify(body) },
  };
}

/**
 * One web run: the harness's initial navigation (owned by no step), then one
 * step envelope per acted step. Returns the two gate inputs — trajectory and
 * har entries — with `artifacts.har_entries` indexing into the latter exactly
 * as the driver records it.
 */
function webRun(steps: LegacyTestValue) {
  const harEntries = [];
  const trajectory = [];
  for (const { step, requests } of steps) {
    const indices = [];
    const network = [];
    for (const e of requests) {
      indices.push(harEntries.length);
      harEntries.push(e);
      network.push({
        method: e.request.method,
        url: e.request.url,
        path: new URL(e.request.url).pathname,
        status: e.response.status,
        mime_type: e.response.mimeType,
        failed: false,
      });
    }
    // step null = the harness-side initial page load, which is not an envelope:
    // the runner prepends it as a bare { perf, network } entry with no step and
    // no artifacts, so its requests belong to no step.
    trajectory.push(step === null ? { perf: null, network: { requests: network } } : { step, network: { requests: network }, artifacts: { har_entries: indices } });
  }
  return { trajectory, harEntries };
}

/** The add-todo journey as a browser produces it. `apiFault` seeds the defect. */
function addTodoRun({ apiFault = null }: LegacyTestValue = {}) {
  const created = { id: 1, title: "buy milk", completed: false };
  return webRun([
    // The harness opens the page; the app bootstraps its list.
    { step: null, requests: [entry("GET", "/", 200, { mime: "text/html" }), entry("GET", "/api/todos", 200, { body: [] })] },
    // Step 1 types into the field: no traffic at all.
    { step: 1, requests: [] },
    // Step 2 submits. THIS is the step the violation must be cited against.
    {
      step: 2,
      requests: [
        entry("POST", "/api/todos", apiFault === "created-status" ? 200 : 201, { body: created, sent: { title: "buy milk" } }),
        entry("GET", "/api/todos", 200, { body: [created] }),
      ],
    },
  ]);
}

const gateCtx = (run: LegacyTestValue) => ({
  ...run,
  // `id` matters: these checks run on the WEB driver, and the no-exemption rule
  // below is only meaningfully pinned if a driver-conditional carve-out would
  // show up here. A stub with no id cannot catch one.
  driver: { id: "web", finalPageCheck: async () => true },
  spec: SPEC,
  consoleErrorCount: 0,
  finalUrl: `${BASE}/`,
  checkAssertion: null,
});

const only = (checks: LegacyTestValue, kindOrLabel: LegacyTestValue) => checks.find((c: LegacyTestValue) => c.label === kindOrLabel || c.spec === kindOrLabel);

type GateFixture = { pass: boolean; hardPass: boolean; checks: LegacyTestValue[]; advisory?: LegacyTestValue[] };

async function suiteCase() {
  const [rc] = await discoverCases([SUITE], { baseUrl: BASE });
  return rc!; // SAFETY: the committed suite always discovers exactly one case
}

// Some rules (the passivity refusal below) are DISCOVERY rules, so they need a
// case file on disk. A scratch copy of the committed suite keeps the committed
// one pristine.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-web-inv-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function writeCase(name: LegacyTestValue, doc: LegacyTestValue, { spec = true }: LegacyTestValue = {}) {
  const root = path.join(scratch, name);
  fs.mkdirSync(path.join(root, "stories"), { recursive: true });
  if (spec) fs.copyFileSync(path.join(SUITE, "openapi.yaml"), path.join(root, "openapi.yaml"));
  fs.writeFileSync(path.join(root, "playtest.yaml"), YAML.stringify({ app: { driver: "web", base_url: BASE, ...(spec ? { openapi: "./openapi.yaml" } : {}) } }));
  const file = path.join(root, "stories", `${name}.yaml`);
  fs.writeFileSync(file, YAML.stringify(doc));
  return file;
}

test("the committed web suite resolves: invariant policies and an app.openapi are valid on the web driver", async () => {
  const rc = await suiteCase();
  assert.equal(rc.env.driver, "web");
  assert.match(rc.env.openapi!, /web-invariants[/\\]openapi\.yaml$/, "the spec resolves relative to the suite"); // SAFETY: this committed suite declares OpenAPI
  assert.equal(rc.success.filter((c: LegacyTestValue) => c.invariant).length, 4, "four Tier-1 policies gate this web journey");
  assert.equal(rc.observe.length, 1, "and one advisory Tier-2 policy rides along");
});

test("a healthy API under a healthy UI: every policy holds and is exercised", async () => {
  const rc = await suiteCase();
  const gate: GateFixture = await evaluateGate(rc, gateCtx(addTodoRun()));

  assert.equal(gate.pass, true, `gate should pass: ${JSON.stringify(gate.checks.filter((c) => !c.pass))}`);
  assert.equal(gate.checks.filter((c: LegacyTestValue) => c.kind === "invariant").length, 4);
  assert.equal(
    gate.checks.filter((c: LegacyTestValue) => c.kind === "invariant").every((c: LegacyTestValue) => c.applicable),
    true,
    "the page's own traffic exercised all four — a web run is never vacuously applicable",
  );
  // The advisory policy the story never exercised reports; it does not gate.
  assert.equal(gate.advisory!.length, 1);
  assert.equal(gate.advisory![0]!.applicable, false);
  assert.match(gate.advisory![0]!.detail, /never completed a DELETE \/api\/todos/);
});

test("an API-layer violation visible only in the HAR fails the web gate, cited against the step that caused it", async () => {
  const rc = await suiteCase();
  const gate = await evaluateGate(rc, gateCtx(addTodoRun({ apiFault: "created-status" })));

  assert.equal(gate.pass, false, "an undeclared status underneath a working UI is a red run");
  assert.equal(gate.hardPass, false, "and it blocks baseline acceptance — invariant checks are hard");

  // Everything a web gate could see before P7 is still green: this failure is
  // invisible without the HAR.
  assert.equal(only(gate.checks, "the todo is on the page").pass, true);
  assert.equal(only(gate.checks, "adding it went through the API").pass, true);

  const failed: LegacyTestValue[] = gate.checks.filter((c: LegacyTestValue) => !c.pass);
  assert.equal(failed.length, 1, `exactly one policy flips: ${JSON.stringify(failed.map((c) => c.spec))}`);
  assert.equal(failed[0].spec, "invariant: documented_status");
  assert.equal(failed[0].applicable, true, "it was exercised and it failed — not a gap in the story");
  assert.match(failed[0].detail, /POST \/api\/todos answered 200, which the spec does not declare/);
  assert.match(failed[0].detail, /declared: 201, 400/);

  // Step-linked evidence: the click that submitted the form, not the page load.
  assert.deepEqual(failed[0].steps, [2], "the violation cites the step whose action produced the request");
});

test("step attribution comes from artifacts.har_entries, so a request no step owns cites no step", async () => {
  const rc = await suiteCase();
  // The bootstrap list load happens during the harness's initial navigation,
  // which is no envelope's step. A violation there is real and must still be
  // reported — with no step citation rather than a fabricated one.
  const run = webRun([
    { step: null, requests: [entry("GET", "/", 200, { mime: "text/html" }), entry("GET", "/api/todos", 503, { body: { error: "down" } })] },
    { step: 1, requests: [] },
  ]);
  const gate = await evaluateGate(rc, gateCtx(run));
  const failed = gate.checks.find((c: LegacyTestValue) => c.spec === "invariant: no_server_error");
  assert.equal(failed!.pass, false);
  assert.match(failed!.detail, /1 server error/);
  assert.equal("steps" in failed!, false, "no step owns the initial page load, so none is cited");
});

test("a `success:` policy the page never exercised FAILS on web too — there is no web exemption", async () => {
  // Same rule as the api driver: a declared invariant that was never exercised
  // has not held. Making it vacuously pass on web would hide the failure on the
  // driver where the trace is hardest to reason about.
  const rc = await suiteCase();
  const withErrorShape = {
    ...rc,
    success: [{ invariant: { policy: "error_shape", require: ["$.error"] } }],
    observe: [],
  };
  const gate = await evaluateGate(withErrorShape, gateCtx(addTodoRun()));
  assert.equal(gate.pass, false);
  assert.equal(gate.checks[0]!.applicable, false);
  assert.equal(gate.checks[0]!.pass, false, "not exercised is a FAILURE under success:, on every driver");
  assert.match(gate.checks[0]!.detail, /produced no 4xx response/);
  assert.match(gate.checks[0]!.detail, /move this policy under observe:/);
});

test("a web case declaring no API invariant is untouched: same verdicts, no step citations", async () => {
  const [rc]: LegacyTestValue = await discoverCases([path.join(TODOS, "stories", "add-todo.yaml")], { baseUrl: BASE });
  const gate = await evaluateGate(rc, { ...gateCtx(addTodoRun()), checkAssertion: async () => ({ pass: true, detail: "ok" }) });
  assert.equal(gate.pass, true);
  assert.equal(gate.checks.length, 4);
  assert.equal(gate.checks.some((c: LegacyTestValue) => "steps" in c), false, "steps is an invariant-violation field, not a new field on every check");
  assert.equal(gate.advisory, undefined);
});

test("web evaluation is passive: the gate's own read-only observation is refused at discovery", async () => {
  // `invariant.observe` issues a synthetic request from the harness. A browser
  // page's requests carry session state that request would not reproduce, so
  // the answer would be about a different caller. api-only, named at discovery
  // rather than surfacing as a mystery "not applicable" at the end of a run.
  const file = writeCase("observe", {
    story: "add a todo",
    success: [
      {
        invariant: {
          policy: "round_trip",
          create: "POST /api/todos",
          read: "GET /api/todos/{todoId}",
          fields: ["$.title"],
          read_from: { todoId: "$.id" },
          observe: true,
        },
      },
    ],
  });
  await assert.rejects(
    () => discoverCases([file], { baseUrl: BASE }),
    (e: LegacyTestValue) => {
      assert.ok(e instanceof DummyConfigError, `expected a config error, got ${e}`);
      assert.match(e.message, /"invariant\.observe"/);
      assert.match(e.message, /api-only \(this case runs the web driver\)/);
      assert.match(e.message, /put the read-back in the story instead/);
      return true;
    },
  );
});

test("a Tier-1 spec policy without app.openapi is still refused at discovery on web", async () => {
  const file = writeCase("nospec", { story: "add a todo", success: [{ invariant: { policy: "documented_status" } }] }, { spec: false });
  await assert.rejects(
    () => discoverCases([file], { baseUrl: BASE }),
    (e: LegacyTestValue) => {
      assert.match(e.message, /"documented_status" invariant policy is driven by the OpenAPI document/);
      return true;
    },
  );
});
