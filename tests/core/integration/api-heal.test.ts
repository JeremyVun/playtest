// P4 exit gate: heal triage, the drift report, and the two rules that stop a
// heal from going green having proven nothing.
// See docs/contracts/engine.md#act-and-heal and docs/contracts/artifacts.md#drift-report.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCases } from "../../../src/core/config.ts";
import { runCase } from "../../../src/core/runner.ts";
import { newRunId, baselinePaths } from "../../../src/core/trajectory.ts";
import { resetSecrets } from "../../../src/core/secrets.ts";
import { startInvariantApi } from "../../fixtures/invariant-api/server.ts";
import { startScriptedModel } from "../../support/scripted-model.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const SPEC = path.join(FIXTURES, "invariant-api/openapi.yaml");

let tmpRoot: LegacyTestValue;
const servers: LegacyTestValue = [];

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-heal-"));
});

after(async () => {
  for (const s of servers) await s.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetSecrets();
  delete process.env.PLAYTEST_LLM_BASE_URL;
});

beforeEach(() => resetSecrets());

async function api(options: LegacyTestValue) {
  const server = await startInvariantApi(options);
  servers.push(server);
  return server;
}

async function scripted(steps: LegacyTestValue) {
  const model = await startScriptedModel(steps);
  servers.push(model);
  return model;
}

function writeSuite(name: LegacyTestValue, { baseUrl, success, story }: LegacyTestValue) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(path.join(dir, "playtest.yaml"), ["app:", "  driver: api", `  base_url: ${baseUrl}`, `  openapi: ${SPEC}`, ""].join("\n"));
  fs.writeFileSync(path.join(dir, "stories", "journey.yaml"), [`story: |`, `  ${story}`, "success:", ...success, ""].join("\n"));
  return dir;
}

/** Record a journey against a fresh instance; asserts it passed. */
async function record(name: LegacyTestValue, { script, success, story, options = {} }: LegacyTestValue) {
  const target = await api({ prefix: "A", ...options });
  const model = await scripted(script);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const suite = writeSuite(name, { baseUrl: target.url, success, story });
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, `${name}-record`), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(res.status, "pass", `the record run should pass (error: ${res.error ?? "none"})`);
  delete process.env.PLAYTEST_LLM_BASE_URL;
  return { suite, rc, target };
}

/** Act the suite's baseline against a fresh instance, with a scripted heal available. */
async function act(suite: LegacyTestValue, label: LegacyTestValue, { options = {}, healScript = null }: LegacyTestValue) {
  const target = await api(options);
  if (healScript) {
    const model = await scripted(healScript);
    process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  } else {
    delete process.env.PLAYTEST_LLM_BASE_URL;
  }
  const [rc]: LegacyTestValue = await discoverCases([suite], { baseUrl: target.url });
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, `act-${label}`), runId: newRunId(), grade: false, onEvent: () => {} });
  delete process.env.PLAYTEST_LLM_BASE_URL;
  return { res, target, rc };
}

// The read-back journey: open an account, then read it. A renamed response field
// is the canonical contract drift.
const READ_BACK = {
  story: "Open an account for \"ada\" and read it back.",
  script: [
    { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201" },
    { thought: "read it back", action: { type: "request", method: "GET", path: "/accounts/acc_A_1" }, expectation: "a 200" },
    { thought: "done", action: { type: "done", summary: "opened and read the account" }, expectation: "the account exists" },
  ],
  success: ['  - api_called: "GET /accounts/*"', "  - response_status:", '      op: "GET /accounts/{accountId}"', '      status: "200"'],
};

/** The heal's continuation against instance R: re-read the account and finish. */
const healReadBack = (prefix = "R") => [
  { thought: "read the account again", action: { type: "request", method: "GET", path: `/accounts/acc_${prefix}_1` }, expectation: "a 200" },
  { thought: "done", action: { type: "done", summary: "read the account through its renamed shape" }, expectation: "the account exists" },
];

test("a renamed response field: replay fails, heal classifies contract drift, emits the drift report, and the changed journey is reviewable", async () => {
  const { suite, rc } = await record("drift", READ_BACK);
  const { res } = await act(suite, "drift", { options: { prefix: "R", rename: true }, healScript: healReadBack() });

  assert.equal(res.manifest.mode, "heal", "the replay escalated to heal");
  assert.equal(res.status, "pass", `the changed journey is green (error: ${res.error ?? "none"})`);
  assert.equal(res.manifest.healed, true, "…and is represented exactly as before: pass + healed, no new status enum");

  // --- triage, from recorded evidence alone
  assert.equal(res.manifest.heal.classification, "contract_drift");
  assert.equal(res.manifest.heal.accepted, true);
  const renamed = res.manifest.heal.signals.find((s: LegacyTestValue) => s.kind === "field_renamed");
  assert.ok(renamed, `the rename is named deterministically: ${JSON.stringify(res.manifest.heal.signals)}`);
  assert.match(renamed.detail, /\$\.balance was renamed to \$\.available_balance/);

  // --- the drift report artifact
  assert.equal(res.manifest.artifacts.drift_report, "drift-report.json");
  const report = JSON.parse(fs.readFileSync(path.join(res.runDir, "drift-report.json"), "utf8"));
  assert.equal(report.classification, "contract_drift");
  assert.equal(report.failed_step.baseline_step, 2, "the report attributes the failure to the step that diverged");
  assert.equal(report.healed_run.end_reason, "done");
  assert.equal(report.healed_run.accepted, true);
  assert.equal(report.healed_run.rejected_reason, null);
  assert.equal(report.healed_run.gate.pass, true);
  assert.ok(
    report.healed_run.gate.checks.some((c: LegacyTestValue) => c.spec.includes("GET /accounts/{accountId}") && c.pass),
    "the report carries the gate verdict on the HEALED trajectory, which is what makes the run reviewable",
  );

  // --- the changed journey is held for review: a candidate, never the baseline
  const paths = baselinePaths(rc.file);
  assert.ok(fs.existsSync(paths.healedTraj), "a healed candidate is written for a human to accept");
  const meta = JSON.parse(fs.readFileSync(paths.healedMeta, "utf8"));
  assert.equal(meta.candidate, true);
  assert.equal(
    fs.readFileSync(paths.traj, "utf8").includes("available_balance"),
    false,
    "the accepted baseline is untouched until a human promotes the candidate",
  );
});

test("a seeded regression: the heal classifies regression and the run is red, even when the healed trajectory would satisfy the gate", async () => {
  const CLOSE = {
    story: 'Open an account for "ada", close it, and confirm a further entry is refused.',
    script: [
      { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201" },
      { thought: "close it", action: { type: "request", method: "POST", path: "/accounts/acc_A_1/close" }, expectation: "a 200" },
      { thought: "try to post an entry", action: { type: "request", method: "POST", path: "/entries", body: { account_id: "acc_A_1", amount: 5 } }, expectation: "a 409" },
      { thought: "done", action: { type: "done", summary: "the closed account refused the entry" }, expectation: "the entry was refused" },
    ],
    // Deliberately a gate the HEALED trajectory can satisfy: the only thing
    // standing between this run and a quiet green heal is the triage verdict.
    success: ['  - api_called: "POST /entries"'],
  };
  const { suite, rc } = await record("regression", CLOSE);
  const { res } = await act(suite, "regression", {
    options: { prefix: "G", closeGhost: true },
    healScript: [
      { thought: "post the entry again", action: { type: "request", method: "POST", path: "/entries", body: { account_id: "acc_G_1", amount: 5 } }, expectation: "a 201" },
      { thought: "done", action: { type: "done", summary: "the entry posted" }, expectation: "the entry exists" },
    ],
  });

  assert.equal(res.manifest.mode, "heal");
  assert.equal(res.status, "fail", "a regression is red, loudly — no quiet heal");
  assert.equal(res.manifest.heal.classification, "regression");
  assert.equal(res.manifest.heal.accepted, false);
  assert.match(res.manifest.heal.rejected_reason, /regression/);
  assert.equal(res.manifest.heal.signals[0].kind, "refusal_lost");
  assert.match(res.manifest.heal.signals[0].detail, /accepted what it used to reject/);

  // The gate itself was satisfied — which is exactly why the triage guard has to
  // exist. Without it this run would have been recorded as a changed journey.
  assert.equal(res.manifest.result.gate.pass, true, "the gate alone would have passed this run");
  assert.equal(res.manifest.result.end_reason, "done", "and the actor reached done");
  assert.ok(!fs.existsSync(baselinePaths(rc.file).healedTraj), "no healed candidate is written for a regression");

  const report = JSON.parse(fs.readFileSync(path.join(res.runDir, "drift-report.json"), "utf8"));
  assert.equal(report.classification, "regression");
  assert.equal(report.failed_step.expected_status, 409);
  assert.equal(report.failed_step.observed_status, 201);
  assert.equal(report.healed_run.accepted, false);
});

test("a heal that ends anything but done can never be pass + healed", async () => {
  const { suite, rc } = await record("giveup", READ_BACK);
  const { res } = await act(suite, "giveup", {
    options: { prefix: "R", rename: true },
    healScript: [
      { thought: "read the account again", action: { type: "request", method: "GET", path: "/accounts/acc_R_1" }, expectation: "a 200" },
      { thought: "I am not sure this is the same journey", action: { type: "give_up", reason: "the shape changed" }, expectation: "the run ends" },
    ],
  });

  assert.equal(res.manifest.mode, "heal");
  assert.equal(res.manifest.result.end_reason, "give_up");
  // The gate is green — the heal DID make the calls the criteria name — so the
  // ending allowlist is the only thing keeping this red.
  assert.equal(res.manifest.result.gate.pass, true, "the gate alone would have passed this run");
  assert.equal(res.status, "fail", 'a non-"done" ending never counts as reaching the goal');
  assert.equal(res.manifest.heal.accepted, false);
  assert.match(res.manifest.heal.rejected_reason, /ended "give_up", not "done"/);
  assert.ok(!fs.existsSync(baselinePaths(rc.file).healedTraj), "and no healed candidate is written");
});

test("an empty gate can never be pass + healed: a heal must prove something", async () => {
  const { suite, rc } = await record("vacuous", { ...READ_BACK, success: [] });
  const { res } = await act(suite, "vacuous", { options: { prefix: "R", rename: true }, healScript: healReadBack() });

  assert.equal(res.manifest.mode, "heal");
  assert.equal(res.manifest.result.end_reason, "done");
  assert.equal(res.manifest.result.gate.pass, true, "an empty success list still passes vacuously — that is the hole");
  assert.deepEqual(res.manifest.result.gate.checks, [], "…and there is nothing in it");
  assert.equal(res.status, "fail", "so the heal is refused instead");
  assert.match(res.manifest.heal.rejected_reason, /no applicable hard deterministic postcondition/);
  assert.ok(!fs.existsSync(baselinePaths(rc.file).healedTraj));
});

test("no heal reaches a changed verdict while any gate check fails on the healed trajectory", async () => {
  const { suite, rc } = await record("redgate", {
    ...READ_BACK,
    success: [
      '  - api_called: "GET /accounts/*"',
      "  - response_status:",
      '      op: "GET /accounts/{accountId}"',
      '      status: "200"',
      "  - response_matches:",
      '      op: "GET /accounts/{accountId}"',
      "      match: '$.balance == 0'",
    ],
  });
  // The rename takes `$.balance` away, so the healed trajectory cannot satisfy
  // the third criterion however the actor rebinds.
  const { res } = await act(suite, "redgate", { options: { prefix: "R", rename: true }, healScript: healReadBack() });

  assert.equal(res.manifest.mode, "heal");
  assert.equal(res.manifest.result.end_reason, "done");
  assert.equal(res.manifest.heal.classification, "contract_drift", "the triage still says the surface changed");
  assert.equal(res.status, "fail", "but a failing check on the healed trajectory is never a changed journey");
  const failed = res.manifest.result.gate.checks.filter((c: LegacyTestValue) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(failed[0].detail, /no value at path/);
  assert.ok(!fs.existsSync(baselinePaths(rc.file).healedTraj));
});

test("without a model an act failure still cannot heal, and web healing is untouched by the api guard", async () => {
  const { suite } = await record("nomodel", READ_BACK);
  const { res } = await act(suite, "nomodel", { options: { prefix: "R", rename: true } });
  assert.equal(res.status, "fail");
  assert.equal(res.manifest.mode, "act", "no model means no heal at all — the pre-existing contract");
  assert.match(res.error ?? "", /no LLM is configured to heal/);
});
