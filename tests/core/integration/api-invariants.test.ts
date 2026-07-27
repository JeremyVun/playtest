// P4 exit gate: the Tier-1/2 invariant policies against a real recorded run,
// the advisory `observe:` sibling, and the observe phase's quarantine.
// See docs/contracts/engine.md#invariant-policies.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCases, DummyConfigError } from "../../../src/core/config.ts";
import { runCase } from "../../../src/core/runner.ts";
import { newRunId } from "../../../src/core/trajectory.ts";
import { resetSecrets } from "../../../src/core/secrets.ts";
import { startInvariantApi } from "../../fixtures/invariant-api/server.ts";
import { startScriptedModel } from "../../support/scripted-model.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const SPEC = path.join(FIXTURES, "invariant-api/openapi.yaml");
const ACC = "acc_A_1";

let tmpRoot: LegacyTestValue;
const servers: LegacyTestValue = [];
let suiteN = 0;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-invariants-"));
});

after(async () => {
  for (const s of servers) await s.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetSecrets();
  delete process.env.PLAYTEST_LLM_BASE_URL;
});

beforeEach(() => resetSecrets());

/**
 * Record one journey and return its run result plus the server's own request
 * log — the only trustworthy witness for "the gate issued no mutation".
 */
async function recordRun({ script, success = [], observe = [], options = {}, spec = true }: LegacyTestValue) {
  const target = await startInvariantApi({ prefix: "A", ...options });
  servers.push(target);
  const model = await startScriptedModel(script);
  servers.push(model);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const dir = path.join(tmpRoot, `suite-${++suiteN}`);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "playtest.yaml"),
    ["app:", "  driver: api", `  base_url: ${target.url}`, ...(spec ? [`  openapi: ${SPEC}`] : []), ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "stories", "journey.yaml"),
    ["story: |", "  Exercise the ledger.", ...(success.length ? ["success:", ...success] : []), ...(observe.length ? ["observe:", ...observe] : []), ""].join("\n"),
  );
  const [rc]: LegacyTestValue = await discoverCases([dir]);
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, `run-${suiteN}`), runId: newRunId(), grade: false, onEvent: () => {} });
  delete process.env.PLAYTEST_LLM_BASE_URL;
  return { res, target, dir, rc };
}

const checkFor = (res: LegacyTestValue, fragment: LegacyTestValue) => res.manifest.result.gate.checks.find((c: LegacyTestValue) => c.spec.includes(fragment));

// A journey that touches most of the surface: an idempotent repeat, a paginated
// enumeration, a refusal, an auth response, and a read-back.
const LEDGER_SCRIPT = [
  { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201" },
  {
    thought: "post an entry",
    action: { type: "request", method: "POST", path: "/entries", headers: { "Idempotency-Key": "k-1" }, body: { account_id: ACC, amount: 5 } },
    expectation: "a 201",
  },
  {
    thought: "retry the same entry with the same key",
    action: { type: "request", method: "POST", path: "/entries", headers: { "Idempotency-Key": "k-1" }, body: { account_id: ACC, amount: 5 } },
    expectation: "the same entry",
  },
  { thought: "post a second entry", action: { type: "request", method: "POST", path: "/entries", body: { account_id: ACC, amount: 7 } }, expectation: "a 201" },
  { thought: "walk page one", action: { type: "request", method: "GET", path: `/entries?account=${ACC}` }, expectation: "the first page" },
  { thought: "walk page two", action: { type: "request", method: "GET", path: `/entries?account=${ACC}&cursor=1` }, expectation: "the second page" },
  { thought: "provoke a refusal", action: { type: "request", method: "POST", path: "/accounts", body: {} }, expectation: "a 422" },
  { thought: "peek at the operator metrics", action: { type: "request", method: "GET", path: "/admin/metrics" }, expectation: "a 401" },
  { thought: "read the account back", action: { type: "request", method: "GET", path: `/accounts/${ACC}` }, expectation: "a 200" },
  { thought: "done", action: { type: "done", summary: "walked the ledger" }, expectation: "the ledger is consistent" },
];

const ALL_POLICIES = [
  "  - invariant: { policy: no_server_error }",
  "  - invariant: { policy: documented_status }",
  "  - invariant: { policy: response_schema }",
  "  - invariant: { policy: content_type }",
  '  - invariant: { policy: round_trip, create: "POST /accounts", read: "GET /accounts/{accountId}", fields: ["$.owner"] }',
  '  - invariant: { policy: idempotency, op: "POST /entries", key_header: "Idempotency-Key", ignore: ["$.created_at"] }',
  '  - invariant: { policy: pagination, op: "GET /entries", identity: "$.entries[*].id", cursor: "$.next_cursor" }',
  '  - invariant: { policy: error_shape, require: ["$.error.code", "$.error.message"] }',
];

test("a healthy run satisfies every declared Tier-1/2 policy, and the gate issues no mutating request", async () => {
  const { res, target } = await recordRun({ script: LEDGER_SCRIPT, success: ALL_POLICIES, options: { pageSize: 1 } });
  const failed = res.manifest.result.gate.checks.filter((c: LegacyTestValue) => !c.pass);
  assert.deepEqual(failed.map((c: LegacyTestValue) => `${c.spec} :: ${c.detail}`), [], "every policy holds against a healthy ledger");
  assert.equal(res.status, "pass");
  assert.equal(res.manifest.result.gate.checks.every((c: LegacyTestValue) => c.applicable === true), true, "each policy reports applicability alongside pass");

  // The story made exactly five mutating requests. If the gate had issued one of
  // its own — a second DELETE, an idempotency repeat — this count would move.
  const mutations: LegacyTestValue[] = target.requests.filter((r: LegacyTestValue) => r.method !== "GET");
  assert.equal(mutations.length, 5, `the gate issued no mutating request: ${JSON.stringify(mutations.map((r) => `${r.method} ${r.path}`))}`);
});

test("each Tier-2 policy fails on its own violation, with a detail that names the fix", async () => {
  // Every fault below is enabled at once; each policy still attributes its own.
  const { res } = await recordRun({
    script: LEDGER_SCRIPT,
    success: ALL_POLICIES,
    options: { pageSize: 1, paginationDup: true, idempotencyDouble: true, errorShapeDrift: true, ownerDrift: true },
  });
  assert.equal(res.status, "fail");

  assert.equal(checkFor(res, "round_trip").pass, false);
  assert.match(checkFor(res, "round_trip").detail, /\$\.owner was written as "ada" but read back as "ADA"/);

  const idem = checkFor(res, "idempotency");
  assert.equal(idem.pass, false);
  assert.match(idem.detail, /reached a different normalized state/);

  const page = checkFor(res, "pagination");
  assert.equal(page.pass, false);
  assert.match(page.detail, /appeared on page 1 and again on page 2/);
  assert.match(page.detail, /declare consistency: eventual/);

  const shape = checkFor(res, "error_shape");
  assert.equal(shape.pass, false);
  assert.match(shape.detail, /missing \$\.error\.code from the declared error envelope/);
});

test("a Tier-1 violation is caught from the spec alone: an undocumented status and a 5xx", async () => {
  const script = [
    { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201" },
    { thought: "read it back", action: { type: "request", method: "GET", path: `/accounts/${ACC}` }, expectation: "a 200" },
    { thought: "done", action: { type: "done", summary: "opened the account" }, expectation: "it exists" },
  ];
  const { res } = await recordRun({
    script,
    success: ["  - invariant: { policy: documented_status }", "  - invariant: { policy: no_server_error }"],
    options: { undocumentedStatus: true, serverError: true },
  });
  assert.equal(res.status, "fail");
  assert.match(checkFor(res, "documented_status").detail, /answered 202, which the spec does not declare for POST \/accounts \(declared: 201, 422\)/);
  assert.match(checkFor(res, "no_server_error").detail, /1 server error\(s\), e\.g\. GET \/accounts\/acc_A_1 → 500/);
});

test("a declared soft delete does not fail the lifecycle policy, but an undeclared survivor does", async () => {
  const script = [
    { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201" },
    { thought: "delete it", action: { type: "request", method: "DELETE", path: `/accounts/${ACC}` }, expectation: "a 204" },
    { thought: "read it back", action: { type: "request", method: "GET", path: `/accounts/${ACC}` }, expectation: "it is gone" },
    { thought: "done", action: { type: "done", summary: "deleted the account" }, expectation: "it is gone" },
  ];
  const LIFECYCLE = '{ policy: lifecycle, delete: "DELETE /accounts/{accountId}", read: "GET /accounts/{accountId}"';

  // Undeclared: the API soft-deletes but the case says nothing, so a 200 read-back
  // after the delete is a violation.
  const strict = await recordRun({ script, success: [`  - invariant: ${LIFECYCLE} }`], options: { softDelete: true } });
  assert.equal(checkFor(strict.res, "lifecycle").pass, false);
  assert.match(checkFor(strict.res, "lifecycle").detail, /not one of the declared 404, 410/);
  assert.match(checkFor(strict.res, "lifecycle").detail, /soft-delete, tombstones, and retention are legitimate/);

  // Declared: the same API, the same trace, with the exception written down.
  const declared = await recordRun({
    script,
    success: [`  - invariant: ${LIFECYCLE}, after: [200], state: '$.status == "deleted"' }`],
    options: { softDelete: true },
  });
  assert.equal(checkFor(declared.res, "lifecycle").pass, true, `a declared soft delete holds: ${checkFor(declared.res, "lifecycle").detail}`);
  assert.equal(declared.res.status, "pass");

  // And the declaration is not a blank cheque: an API that reports a delete and
  // changes nothing still fails, even with the soft-delete exception declared.
  const ghost = await recordRun({
    script,
    success: [`  - invariant: ${LIFECYCLE}, after: [200], state: '$.status == "deleted"' }`],
    options: { deleteGhost: true },
  });
  assert.equal(checkFor(ghost.res, "lifecycle").pass, false);
  assert.match(checkFor(ghost.res, "lifecycle").detail, /survived the delete but/);
});

test("a success policy with no qualifying trace fails with actionable detail; the same policy under observe: only reports", async () => {
  const script = [
    { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201" },
    { thought: "done", action: { type: "done", summary: "opened the account" }, expectation: "it exists" },
  ];
  const POLICY = '{ policy: idempotency, op: "POST /entries", key_header: "Idempotency-Key" }';

  const gated = await recordRun({ script, success: [`  - invariant: ${POLICY}`] });
  assert.equal(gated.res.status, "fail", "a declared invariant the story never exercised has not held");
  const check = checkFor(gated.res, "idempotency");
  assert.deepEqual([check.applicable, check.pass], [false, false]);
  assert.match(check.detail, /never repeats POST \/entries with the same Idempotency-Key/);
  assert.match(check.detail, /repeat the call in the story, or move this policy under observe:/, "the detail names both ways out");

  const advised = await recordRun({
    script,
    success: ['  - api_called: "POST /accounts"'],
    observe: [`  - invariant: ${POLICY}`],
  });
  assert.equal(advised.res.status, "pass", "an advisory policy never gates");
  assert.equal(advised.res.manifest.result.gate.checks.some((c: LegacyTestValue) => c.kind === "invariant"), false);
  const advisory = advised.res.manifest.result.gate.advisory;
  assert.equal(advisory.length, 1);
  assert.deepEqual([advisory[0].applicable, advisory[0].severity, advisory[0].kind], [false, "advisory", "invariant"]);
  assert.match(advisory[0].detail, /never repeats POST \/entries/);
  assert.ok(advised.res.manifest.case.observe, "the case's advisory policies ride into the manifest for the viewer");
});

test("a round-trip policy may read back with its own GET; that request is quarantined from every other check", async () => {
  const script = [
    { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201" },
    { thought: "done", action: { type: "done", summary: "opened the account" }, expectation: "it exists" },
  ];
  const { res, target } = await recordRun({
    script,
    success: [
      '  - invariant: { policy: round_trip, create: "POST /accounts", read: "GET /accounts/{accountId}", fields: ["$.owner"], observe: true, read_from: { accountId: "$.id" } }',
      // The control: the story itself never called GET /accounts/*, so if the
      // observation leaked into ordinary gate traffic this would pass.
      '  - api_called: "GET /accounts/*"',
    ],
  });

  const roundTrip = checkFor(res, "round_trip");
  assert.deepEqual([roundTrip.applicable, roundTrip.pass], [true, true]);
  assert.match(roundTrip.detail, /read back by observation/);

  const called = checkFor(res, "api_called");
  assert.equal(called.pass, false, "an observation GET must never satisfy api_called");
  assert.equal(res.status, "fail", "…so the run stays honest about what the story actually did");

  // The observation really happened, against the real server, and it was a GET.
  const reads = target.requests.filter((r: LegacyTestValue) => r.path === `/accounts/${ACC}`);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].method, "GET");
  assert.equal(target.requests.filter((r: LegacyTestValue) => r.method !== "GET").length, 1, "the observe phase issued no mutation");

  // It is recorded, tagged, and kept out of the trajectory.
  const har = JSON.parse(fs.readFileSync(path.join(res.runDir, "har.json"), "utf8")).log.entries;
  const observation = har.filter((e: LegacyTestValue) => e._observation);
  assert.equal(observation.length, 1, "the observation is recorded in its own tagged HAR section");
  assert.equal(observation[0].request.method, "GET");
  const trajectory = fs.readFileSync(path.join(res.runDir, "trajectory.jsonl"), "utf8");
  assert.equal(trajectory.includes(`/accounts/${ACC}`), false, "and never enters the replayable trajectory");
  assert.equal(res.manifest.totals.executed_steps, 1, "nor the run's metrics");
});

test("policy configuration errors name the case file at discovery, before any run", async () => {
  const write = (body: LegacyTestValue) => {
    const dir = path.join(tmpRoot, `bad-${++suiteN}`);
    fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
    fs.writeFileSync(path.join(dir, "playtest.yaml"), ["app:", "  driver: api", "  base_url: http://127.0.0.1:1", ""].join("\n"));
    fs.writeFileSync(path.join(dir, "stories", "journey.yaml"), body);
    return dir;
  };

  await assert.rejects(
    discoverCases([write(["story: x", "success:", "  - invariant: { policy: documented_status }", ""].join("\n"))]),
    (e) => e instanceof DummyConfigError && /driven by the OpenAPI document — set app\.openapi/.test(e.message),
    "a Tier-1 policy with no spec is named at discovery, not as a mystery not-applicable at the end of a run",
  );

  await assert.rejects(
    discoverCases([write(["story: x", "success:", '  - invariant: { policy: pagination, op: "GET /e" }', ""].join("\n"))]),
    (e) => e instanceof DummyConfigError && /needs "identity"/.test(e.message),
  );

  // Invariant policies are valid on web too — they read the HAR the page
  // produced (docs/contracts/engine.md#invariant-policies; the web side is
  // proven in tests/core/integration/web-invariants.test.ts). Mobile has no
  // network capture at all, so there is no trace to evaluate and the kind stays
  // a config error there rather than failing every run as not-exercised.
  const mobileDir = path.join(tmpRoot, `mobile-${++suiteN}`);
  fs.mkdirSync(path.join(mobileDir, "stories"), { recursive: true });
  fs.writeFileSync(
    path.join(mobileDir, "playtest.yaml"),
    ["app:", "  driver: mobile", "  platform: ios", "  app: ./App.app", "  base_url: http://127.0.0.1:1", ""].join("\n"),
  );
  fs.writeFileSync(path.join(mobileDir, "stories", "journey.yaml"), ["story: x", "success:", "  - invariant: { policy: no_server_error }", ""].join("\n"));
  await assert.rejects(
    discoverCases([mobileDir]),
    (e) => e instanceof DummyConfigError && /"invariant" is not valid for the mobile driver \(valid: api\/web\)/.test(e.message),
    "invariant policies need a recorded request trace, which mobile has not got",
  );
});
