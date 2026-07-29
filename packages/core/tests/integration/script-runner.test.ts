// Runner semantics for script executions
// (docs/contracts/scripts.md#runner-semantics): the three outputs, the separate
// defect channel, the coverage-obligation soundness rule, the two-column
// verdict, and the exit statuses. Every case runs a real script in a real
// subprocess against a loopback fixture. Offline, no browser, no model.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import { runScript, SCRIPT_REPORT_VERSION } from "../../src/public/api-suite-scripts.ts";
import { DummyConfigError } from "../../src/config.ts";
import { startScriptApi } from "../../../../tests/fixtures/script-api/server.ts";

const SUITES = fileURLToPath(new URL("../../../../tests/fixtures/script-suites/", import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../src/schemas/script-report.schema.json", import.meta.url)), "utf8"));
// @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
const validateReport = new Ajv({ strict: false, allErrors: true }).compile(SCHEMA);

const RULES: LegacyTestValue = {
  health: { id: "health", statement: "GET /health answers { ok: true }" },
  items: {
    id: "items",
    statement: "GET /items answers an items array",
    approved_skip_reasons: ["the fixture has no listing to walk"],
  },
};
const rulesFor = (...ids: LegacyTestValue[]) => ids.map((id) => RULES[id]);

let api: LegacyTestValue;
let outDir: LegacyTestValue;

beforeEach(async () => {
  api = await startScriptApi();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-runner-"));
});

afterEach(async () => {
  await api.close();
  fs.rmSync(outDir, { recursive: true, force: true });
});

const run = (script: LegacyTestValue, options: LegacyTestValue = {}) =>
  runScript({
    script: path.join(SUITES, script),
    target: { base_url: api.url },
    rules: options.rules ?? rulesFor("health", "items"),
    out_dir: outDir,
    budget: options.budget ?? 40,
    params: options.params ?? {},
    ...options,
  });

const outputs = () => fs.readdirSync(outDir).sort();
const readReport = () => JSON.parse(fs.readFileSync(path.join(outDir, "script-report.json"), "utf8"));

test("a sound passing suite writes exactly two files, exits 0, and validates against the schema", async () => {
  const result = await run("ok.mjs");

  assert.deepEqual(outputs(), ["har.json", "script-report.json"], "exactly three outputs: two files and an exit status");
  assert.equal(result.exitCode, 0);
  const report = readReport();
  assert.equal(report.script_report_version, SCRIPT_REPORT_VERSION);
  assert.ok(validateReport(report), `the report validates: ${JSON.stringify(validateReport.errors)}`);
  assert.deepEqual(report.verdict, {
    pass: true,
    report_pass: true,
    gate_pass: true,
    sound: true,
    failing_checks: [],
    exit_code: 0,
  });
  assert.equal(report.obligations.summary.unaccounted, 0);
  assert.equal(report.obligations.summary.covered, 3, "two rules and the Level 0 policy");
  assert.match(report.script.sha256, /^[0-9a-f]{64}$/, "the fingerprint an approval covers");

  // Evidence resolves into the sibling HAR by index.
  const har = JSON.parse(fs.readFileSync(path.join(outDir, "har.json"), "utf8"));
  assert.equal(har.log.version, "1.2");
  for (const check of report.checks) {
    assert.ok(check.evidence.har_entries.length, `check ${check.id} cites traffic`);
    for (const index of check.evidence.har_entries) assert.ok(har.log.entries[index], `entry ${index} resolves`);
  }
});

test("a failing check is a finding on a SOUND suite: exit 1, no defect", async () => {
  const result = await run("failing-check.mjs");

  assert.equal(result.exitCode, 1);
  const report = result.report;
  assert.deepEqual(report.defects, [], "a broken API is not a script defect");
  assert.equal(report.soundness.ok, true, "the suite is sound: the API is what failed");
  assert.equal(report.verdict.gate_pass, true, "the HAR column is clean");
  assert.equal(report.verdict.report_pass, false);
  assert.deepEqual(report.verdict.failing_checks, ["items-list-is-never-empty"]);
  const failing = report.checks.find((check: LegacyTestValue) => check.id === "items-list-is-never-empty");
  assert.equal(failing!.expected, "at least one item");
  assert.equal(failing!.observed, "0 items");
});

test("a thrown script error cannot masquerade as a check, and lands in the defect channel", async () => {
  const result = await run("throws.mjs");

  assert.equal(result.exitCode, 2, "a defective execution is unsound, not merely failing");
  const report = result.report;
  assert.equal(report.checks.length, 1, "the check made before the throw survives");
  assert.equal(report.checks[0]!.id, "health-ok");
  assert.equal(report.checks[0]!.pass, true);
  assert.ok(
    !report.checks.some((check: LegacyTestValue) => /threw on purpose/.test(check.title ?? "")),
    "the thrown error is not a check of any kind",
  );
  const defect = report.defects.find((entry: LegacyTestValue) => entry.kind === "threw");
  assert.ok(defect, `the throw is a defect: ${JSON.stringify(report.defects)}`);
  assert.match(defect.message, /the fixture threw on purpose/);
  assert.equal(report.soundness.ok, false);
  assert.match(report.soundness.reasons.join("\n"), /script defect \(threw\)/);
});

test("the script's own defect channel is distinct from a check failure", async () => {
  const result = await run("reported-defect.mjs");

  const report = result.report;
  assert.deepEqual(
    report.checks.map((check: LegacyTestValue) => [check.id, check.pass]),
    [["health-ok", true]],
    "the defect did not become a check",
  );
  const defect = report.defects.find((entry: LegacyTestValue) => entry.kind === "script_reported");
  assert.ok(defect, `the script's report of its own failure is a defect: ${JSON.stringify(report.defects)}`);
  assert.match(defect.message, /items rule was never reachable/);
  assert.equal(report.verdict.report_pass, false);
  assert.equal(result.exitCode, 2);
});

test("an undersized suite fails soundness however many checks it ran", async () => {
  const result = await run("undersized.mjs");

  const report = result.report;
  assert.equal(report.checks.length, 12, "twelve checks ran and all passed");
  assert.ok(report.checks.every((check: LegacyTestValue) => check.pass));
  assert.equal(report.verdict.report_pass, true, "the report column is clean");
  assert.equal(report.verdict.gate_pass, true, "the HAR column is clean");
  assert.equal(report.verdict.pass, false, "and the suite still fails: an obligation is unaccounted");
  assert.equal(result.exitCode, 2);
  const items = report.obligations.entries.find((entry: LegacyTestValue) => entry.id === "rule:items");
  assert.equal(items!.status, "unaccounted");
  assert.match(report.soundness.reasons.join("\n"), /obligation rule:items is unaccounted/);
  // Every report entry traces to an obligation in the manifest.
  const ids = new Set(report.obligations.entries.map((entry: LegacyTestValue) => entry.id));
  for (const check of report.checks) assert.ok(ids.has(check.obligation), `check ${check.id} traces to a manifest obligation`);
});

test("a skip counts only when its reason is one the obligation approves", async () => {
  const approved = await run("skips.mjs", { params: { reason: "the fixture has no listing to walk" } });
  assert.equal(approved.exitCode, 0, `an approved skip is sound: ${JSON.stringify(approved.report.soundness)}`);
  assert.equal(approved.report.obligations.entries.find((entry: LegacyTestValue) => entry.id === "rule:items")!.status, "skipped");
  assert.equal(approved.report.obligations.summary.unaccounted, 0);

  const invented = await run("skips.mjs", { params: { reason: "did not feel like it" } });
  assert.equal(invented.exitCode, 2, "an unapproved reason does not account for anything");
  const entry: LegacyTestValue = invented.report.obligations.entries.find((one: LegacyTestValue) => one.id === "rule:items");
  assert.equal(entry.status, "unaccounted");
  assert.match(entry.reason, /unapproved reason/);
});

test("a check citing traffic that never happened is a defect, not evidence", async () => {
  const result = await run("fabricated-evidence.mjs");

  const report = result.report;
  const defect = report.defects.find((entry: LegacyTestValue) => entry.kind === "evidence_unresolvable");
  assert.ok(defect, `the fabricated citation is detected: ${JSON.stringify(report.defects)}`);
  assert.match(defect.message, /41, 42/);
  assert.equal(defect.check, "items-audited");
  const fabricated = report.checks.find((check: LegacyTestValue) => check.id === "items-audited");
  assert.deepEqual(fabricated!.evidence.har_entries, [], "the unresolvable citation is dropped from the check");
  assert.equal(result.exitCode, 2);
});

test("two checks under one id is a defect: an obligation trace must be unambiguous", async () => {
  const result = await run("duplicate-ids.mjs", { rules: rulesFor("health") });

  const defect = result.report.defects.find((entry: LegacyTestValue) => entry.kind === "duplicate_check_id");
  assert.ok(defect, `the collision is detected: ${JSON.stringify(result.report.defects)}`);
  assert.match(defect.message, /health-ok/);
  assert.equal(result.exitCode, 2);
});

test("a record tracing to an obligation outside the manifest is a defect", async () => {
  const result = await run("unknown-obligation.mjs");

  const defect = result.report.defects.find((entry: LegacyTestValue) => entry.kind === "unknown_obligation");
  assert.ok(defect, `an invented obligation is detected: ${JSON.stringify(result.report.defects)}`);
  assert.match(defect.message, /rule:not-in-the-manifest/);
  assert.equal(result.exitCode, 2);
});

test("the HAR column can condemn traffic a clean report ignored", async () => {
  const result = await run("boom.mjs");

  const report = result.report;
  assert.equal(report.verdict.report_pass, true, "the script reported everything as fine");
  assert.equal(report.verdict.gate_pass, false, "the oracles over the HAR did not agree");
  const policy = report.gate.checks.find((check: LegacyTestValue) => check.policy === "no_server_error");
  assert.equal(policy!.applicable, true);
  assert.equal(policy!.pass, false);
  assert.match(policy!.detail, /server error/);
  assert.ok(policy!.har_entries.length, "the gate cites the offending HAR entry");
  assert.equal(report.verdict.pass, false);
  assert.equal(result.exitCode, 1, "a sound suite with a failing column exits 1");
});

test("a declared policy that matched no traffic fails and leaves its obligation unaccounted", async () => {
  const result = await run("ok.mjs", { policies: [{ policy: "no_server_error", scope: "DELETE /items/{id}" }] });

  const policy = result.report.gate.checks[0]!;
  assert.equal(policy!.applicable, false, "nothing matched the scope");
  assert.equal(policy!.pass, false, "a never-exercised policy has not held");
  const obligation = result.report.obligations.entries.find((entry: LegacyTestValue) => entry.source === "policy");
  assert.equal(obligation!.status, "unaccounted");
  assert.match(obligation!.reason ?? "", /matched no recorded request/);
  assert.equal(result.exitCode, 2);
});

test("a timeout kills the process, keeps the flushed HAR, and reports a defect", async () => {
  const result = await run("hangs.mjs", { timeout_ms: 700 });

  const defect = result.report.defects.find((entry: LegacyTestValue) => entry.kind === "timeout");
  assert.ok(defect, `the timeout is a defect: ${JSON.stringify(result.report.defects)}`);
  assert.match(defect.message, /700ms/);
  assert.equal(result.exitCode, 2);
  const har = JSON.parse(fs.readFileSync(path.join(outDir, "har.json"), "utf8"));
  assert.equal(har.log.entries.length, 1, "the traffic recorded before the kill survives");
  assert.ok(validateReport(result.report), `the report still validates: ${JSON.stringify(validateReport.errors)}`);
});

test("a module with no default-exported function is a contract violation", async () => {
  const result = await run("no-default-export.mjs");

  const defect = result.report.defects.find((entry: LegacyTestValue) => entry.kind === "contract_violation");
  assert.ok(defect, `the shape violation is reported: ${JSON.stringify(result.report.defects)}`);
  assert.match(defect.message, /export default async function/);
  assert.equal(result.exitCode, 2);
});

test("a process that dies without reporting is not trusted", async () => {
  const result = await run("exits-silently.mjs");

  const defect = result.report.defects.find((entry: LegacyTestValue) => entry.kind === "no_report");
  assert.ok(defect, `the silent exit is a defect: ${JSON.stringify(result.report.defects)}`);
  assert.equal(result.report.checks.length, 0, "nothing it claimed before dying is reported as a check");
  assert.equal(result.exitCode, 2);
});

test("configuration and user input fail as DummyConfigError with an actionable message", async () => {
  const cases: LegacyTestValue = [
    [{ script: path.join(SUITES, "missing.mjs") }, /no script at/],
    [{ target: { base_url: "ftp://nope" } }, /must be http\(s\)/],
    [{ target: { base_url: api.url, allowed_origins: ["https://api.example/v2"] } }, /allowed_origins/],
    [{ secrets: ["not a name"] }, /PLAYTEST_SECRET_<NAME>/],
    [{ params: { token: { $secret: "API_TOKEN" } } }, /params must not carry a secret reference/],
    [{ budget: 0 }, /budget must be a positive integer/],
    [{ policies: [{ policy: "not_a_policy" }] }, /unknown invariant policy/],
    [{ policies: [{ policy: "documented_status" }] }, /needs a resolved spec/],
    [{ rules: [], policies: [] }, /coverage-obligation manifest is empty/],
    [{ obligations: [{ id: "rule:a" }, { id: "rule:a" }] }, /duplicate obligation id/],
  ];
  for (const [overrides, expected] of cases) {
    await assert.rejects(
      () => run("ok.mjs", overrides),
      (error: LegacyTestValue) => {
        assert.ok(error instanceof DummyConfigError, `${expected} is a DummyConfigError, got ${error.name}: ${error.message}`);
        assert.match(error.message, expected);
        assert.ok(!/MODULE_NOT_FOUND|\n\s+at /.test(error.message), "no raw stack in a config error");
        return true;
      },
    );
  }
});

test("a script carrying a credential literal is refused before it executes", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "script-leak-"));
  try {
    process.env.PLAYTEST_SECRET_API_TOKEN = `Bearer ${api.token}`;
    const script = path.join(scratch, "pasted.mjs");
    fs.writeFileSync(
      script,
      `export default async function ({ client, check }) {\n` +
        `  const res = await client.get("/whoami", { headers: { authorization: "Bearer ${api.token}" } });\n` +
        `  check({ id: "x", obligation: "rule:health", pass: res.ok, evidence: { requests: [res.ref] } });\n` +
        `}\n`,
    );
    await assert.rejects(
      () =>
        runScript({
          script,
          target: { base_url: api.url },
          rules: rulesFor("health"),
          secrets: ["API_TOKEN"],
          out_dir: outDir,
        }),
      (error) => error instanceof DummyConfigError && /credential literal and will not be executed/.test(error.message),
    );
    assert.deepEqual(outputs(), [], "nothing ran, so nothing was written");
    assert.deepEqual(api.requests, [], "and the target was never touched");
  } finally {
    delete process.env.PLAYTEST_SECRET_API_TOKEN;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
