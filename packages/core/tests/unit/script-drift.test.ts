// Drift as a revision (DESIGN N11, docs/contracts/scripts.md#replay-and-drift).
//
// The load-bearing distinction: the API broke (regression — red, loudly, and no
// revision offered) versus the contract moved (drift — a proposed revision a
// human approves). Nothing here consults a model; the classification is computed
// from two reports, two documents, and the recorded traffic.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRevisionPrompt,
  buildScriptDriftReport,
  diffOpenApiSurface,
  openApiSurface,
  parseRevisionReply,
  triageScriptReplay,
} from "../../src/public/api-suite-scripts.ts";

const BASE = "http://127.0.0.1:4181";

const widgetSpec = (nameField = "name", extraStatus: LegacyTestValue = null): LegacyTestValue => ({
  openapi: "3.0.0",
  paths: {
    "/widgets": {
      get: { responses: { 200: { content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { id: { type: "string" }, [nameField]: { type: "string" } } } } } } } } },
      post: { responses: { 201: { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, [nameField]: { type: "string" } } } } } }, ...(extraStatus ? { [extraStatus]: {} } : {}) } },
    },
    "/widgets/{widgetId}/publish": {
      post: { responses: { 200: {}, 409: {} } },
    },
  },
});

const entry = ({ method = "GET", path = "/widgets", status = 200 }: LegacyTestValue): LegacyTestValue => ({
  startedDateTime: "2026-07-26T00:00:00.000Z",
  time: 1,
  request: { method, url: `${BASE}${path}`, headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
  response: { status, statusText: "", headers: [], cookies: [], content: { size: 0, mimeType: "application/json" }, redirectURL: "", headersSize: -1, bodySize: -1 },
  cache: {},
  timings: { send: 0, wait: 1, receive: 0 },
});

const report = ({ checks = [], gate = [], defects = [] }: LegacyTestValue): LegacyTestValue => ({
  checks,
  defects,
  gate: { pass: gate.every((check: LegacyTestValue) => check.pass !== false), checks: gate },
});

test("the OpenAPI surface is the part of a document a suite can be broken by", () => {
  const surface = openApiSurface(widgetSpec());
  assert.deepEqual([...surface.keys()].sort(), ["GET /widgets", "POST /widgets", "POST /widgets/{}/publish"]);
  assert.deepEqual(surface.get("GET /widgets").fields, ["[].id", "[].name"]);
  assert.deepEqual(surface.get("POST /widgets/{}/publish").statuses, ["200", "409"]);
  // A placeholder's NAME is not part of the surface: `{widgetId}` and `{id}` are
  // the same hole, so renaming a path parameter is not drift.
  const renamedParam = JSON.parse(JSON.stringify(widgetSpec()));
  renamedParam.paths["/widgets/{id}/publish"] = renamedParam.paths["/widgets/{widgetId}/publish"];
  delete renamedParam.paths["/widgets/{widgetId}/publish"];
  assert.equal(diffOpenApiSurface(widgetSpec(), renamedParam).changed, false);
});

test("a field rename is read as a rename, not as one removal plus one addition", () => {
  const diff = diffOpenApiSurface(widgetSpec("name"), widgetSpec("label"));
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.touched, ["GET /widgets", "POST /widgets"]);
  const changed = diff.operations_changed.find((one: LegacyTestValue) => one.operation === "GET /widgets");
  assert.deepEqual(changed.fields_renamed, [{ from: "[].name", to: "[].label" }]);
  assert.deepEqual(changed.fields_removed, []);
  assert.deepEqual(changed.fields_added, []);
});

test("no contract change means regression, and no revision is proposed as a fix", () => {
  // The seeded-fault shape: republish answers 200 where the lifecycle rule says
  // 409. The document did not move, so the API broke its own promise.
  const triage = triageScriptReplay({
    approved: { spec: widgetSpec() },
    replay: {
      spec: widgetSpec(),
      harEntries: [entry({ method: "POST", path: "/widgets/w1/publish", status: 200 })],
      report: report({
        checks: [{ id: "republish-conflicts", obligation: "rule:lifecycle", pass: false, expected: "409", observed: "200", evidence: { har_entries: [0] } }],
      }),
    },
  });
  assert.equal(triage.classification, "regression");
  assert.equal(triage.revision.proposed, false);
  assert.match(triage.revision.reason, /revising the suite would delete the evidence/);
  assert.ok(triage.signals.some((signal: LegacyTestValue) => signal.kind === "rule_violated"));
});

test("an approved rule outranks a document edit: breaking one is a regression however much the spec moved", () => {
  const triage = triageScriptReplay({
    approved: { spec: widgetSpec("name") },
    replay: {
      spec: widgetSpec("label"),
      harEntries: [entry({ method: "POST", path: "/widgets", status: 201 })],
      report: report({
        checks: [{ id: "conserves", obligation: "rule:conservation", pass: false, expected: "1", observed: "2", evidence: { har_entries: [0] } }],
      }),
    },
  });
  assert.equal(triage.classification, "regression");
  assert.equal(triage.revision.proposed, false);
});

test("a failure explained by the document moving is contract drift, and proposes a revision", () => {
  const triage = triageScriptReplay({
    approved: { spec: widgetSpec("name") },
    replay: {
      spec: widgetSpec("label"),
      harEntries: [entry({ method: "GET", path: "/widgets", status: 200 })],
      report: report({
        checks: [{ id: "list-names-widgets", obligation: "operation:GET /widgets", pass: false, expected: '"name" present', observed: "undefined", evidence: { har_entries: [0] } }],
      }),
    },
  });
  assert.equal(triage.classification, "contract_drift");
  assert.equal(triage.revision.proposed, true);
  assert.ok(triage.signals.some((signal: LegacyTestValue) => signal.kind === "field_renamed" && signal.detail.includes("name → label")));
  assert.deepEqual(triage.failing.unexplained, []);
});

test("a failure OUTSIDE what moved keeps the run red rather than borrowing the drift as an excuse", () => {
  const triage = triageScriptReplay({
    approved: { spec: widgetSpec("name") },
    replay: {
      spec: widgetSpec("label"),
      harEntries: [entry({ method: "POST", path: "/widgets/w1/publish", status: 200 })],
      report: report({
        checks: [{ id: "publish-twice", obligation: "policy:documented_status", pass: false, expected: "409", observed: "200", evidence: { har_entries: [0] } }],
      }),
    },
  });
  assert.equal(triage.classification, "regression");
  assert.deepEqual(triage.failing.unexplained, ["publish-twice"]);
});

test("a 5xx and an unsound replay are regressions before anything else is considered", () => {
  const serverError = triageScriptReplay({
    approved: { spec: widgetSpec("name") },
    replay: { spec: widgetSpec("label"), harEntries: [], report: report({ gate: [{ policy: "no_server_error", pass: false, detail: "GET /widgets answered 500", har_entries: [] }] }) },
  });
  assert.equal(serverError.classification, "regression");
  assert.equal(serverError.signals[0].kind, "server_error");

  const unsound = triageScriptReplay({
    approved: { spec: widgetSpec("name") },
    replay: { spec: widgetSpec("label"), harEntries: [], report: report({ defects: [{ kind: "threw", message: "boom" }] }) },
  });
  assert.equal(unsound.classification, "regression");
  assert.equal(unsound.signals[0].kind, "script_defect");
});

test("the drift report is computed evidence with a null narrative until a model writes one", () => {
  const triage = triageScriptReplay({
    approved: { spec: widgetSpec("name") },
    replay: {
      spec: widgetSpec("label"),
      harEntries: [entry({})],
      report: report({ checks: [{ id: "list", obligation: "operation:GET /widgets", pass: false, evidence: { har_entries: [0] } }] }),
    },
  });
  const drift = buildScriptDriftReport({ triage, run_id: "R1", suite: "widgets", version: 3 });
  assert.equal(drift.schema_version, 1);
  assert.equal(drift.mode, "script_replay");
  assert.equal(drift.classification, "contract_drift");
  assert.equal(drift.narrative, null);
  assert.equal(drift.narrated_by, null);
  assert.equal(drift.revision.proposed, true);
});

test("a revision is proposed by prompt, not by execution: the prompt carries the whole job", () => {
  const triage = triageScriptReplay({
    approved: { spec: widgetSpec("name") },
    replay: {
      spec: widgetSpec("label"),
      harEntries: [entry({})],
      report: report({ checks: [{ id: "list", obligation: "operation:GET /widgets", pass: false, expected: "name", observed: "undefined", evidence: { har_entries: [0] } }] }),
    },
  });
  const prompt = buildRevisionPrompt({ script: "export default async () => {};", triage });
  assert.match(prompt, /field renamed: (\[\])?name → (\[\])?label/);
  assert.match(prompt, /list \(operation:GET \/widgets\) — expected name, observed undefined/);
  assert.match(prompt, /Do not delete a check because it fails/);
  // Nothing in the prompt is a target, a credential, or a request.
  assert.doesNotMatch(prompt, /127\.0\.0\.1|Authorization/);

  const parsed = parseRevisionReply(
    ['```json', '{"what_changed":"name → label","why_valid":"the document says so","consumer_impact":"clients read label"}', '```', '', '```js', 'export default async () => { /* v2 */ };', '```'].join("\n"),
  );
  assert.equal(parsed.script, "export default async () => { /* v2 */ };");
  assert.equal(parsed.narrative.what_changed, "name → label");
  assert.deepEqual(parseRevisionReply("no blocks here"), { script: null, narrative: null });
});
