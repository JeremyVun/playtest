// The committed API example suite (tests/fixtures/api-example): a real recorded
// baseline, checked in, plus one full heal → accept cycle. This is roadmap M2's
// exit criterion for the api driver, and the end-to-end proof that everything
// P2–P4 built composes: a redacted request program, semantic replay, Tier-1/2
// invariant policies, heal triage, and a reviewable changed journey.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCases } from "../../../src/core/config.ts";
import { runCase } from "../../../src/core/runner.ts";
import { newRunId, baselinePaths, promoteHealed } from "../../../src/core/trajectory.ts";
import { resetSecrets } from "../../../src/core/secrets.ts";
import { startInvariantApi } from "../../fixtures/invariant-api/server.ts";
import { startScriptedModel } from "../../support/scripted-model.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.resolve(HERE, "../../fixtures/api-example");

let tmpRoot: LegacyTestValue;
const servers: LegacyTestValue = [];
let n = 0;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-example-"));
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

/** Run the suite at `dir` against a fresh instance, optionally with a scripted heal. */
async function run(dir: LegacyTestValue, { options = {}, healScript = null }: LegacyTestValue = {}) {
  const target = await api(options);
  if (healScript) {
    const model = await startScriptedModel(healScript);
    servers.push(model);
    process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  } else {
    delete process.env.PLAYTEST_LLM_BASE_URL;
  }
  const [rc]: LegacyTestValue = await discoverCases([dir], { baseUrl: target.url });
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, `run-${++n}`), runId: newRunId(), grade: false, onEvent: () => {} });
  delete process.env.PLAYTEST_LLM_BASE_URL;
  return { res, rc, target };
}

/** A private copy of the committed suite, so the cycle test never dirties it. */
function copySuite(label: LegacyTestValue) {
  const dir = path.join(tmpRoot, label);
  fs.cpSync(SUITE, dir, { recursive: true });
  return dir;
}

test("the committed baseline replays green against a fresh instance, with no model and no heal", async () => {
  const before = fs.readdirSync(path.join(SUITE, "results")).map((f) => [f, fs.readFileSync(path.join(SUITE, "results", f), "utf8")]);
  assert.deepEqual(before.map(([f]) => f).sort(), ["ledger-journey.baseline.json", "ledger-journey.baseline.jsonl"], "the baseline is committed, both halves");

  const { res } = await run(SUITE, { options: { prefix: "B" } });
  assert.equal(res.status, "pass", `the committed baseline still acts (error: ${res.error ?? "none"})`);
  assert.equal(res.manifest.mode, "act", "replayed the committed path rather than re-recording");
  assert.equal(res.manifest.healed, false);

  const checks = res.manifest.result.gate.checks;
  assert.deepEqual(checks.filter((c: LegacyTestValue) => !c.pass), [], "every declared criterion and policy holds");
  assert.equal(checks.filter((c: LegacyTestValue) => c.kind === "invariant").length, 5, "five Tier-1/2 policies gate this journey");
  assert.equal(checks.every((c: LegacyTestValue) => c.applicable), true, "and every one of them was actually exercised");

  // The advisory policy reports without gating, exactly as declared.
  const advisory = res.manifest.result.gate.advisory;
  assert.equal(advisory.length, 1);
  assert.deepEqual([advisory[0].applicable, advisory[0].label], [false, "refusals use the error envelope"]);

  // Acting is read-only with respect to the suite: a check run must never
  // rewrite the baseline it is checking.
  const after = fs.readdirSync(path.join(SUITE, "results")).map((f) => [f, fs.readFileSync(path.join(SUITE, "results", f), "utf8")]);
  assert.deepEqual(after, before, "the committed suite is untouched by a passing check run");
});

test("the committed baseline carries no instance's ids: it is a program, not a recording", () => {
  const jsonl = fs.readFileSync(path.join(SUITE, "results", "ledger-journey.baseline.jsonl"), "utf8");
  const actions = jsonl
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .map((e) => e.agent?.action ?? e.action);
  const program = JSON.stringify(actions);
  assert.equal(program.includes("acc_A_"), false, `no recorded action may carry the recording instance's id: ${program}`);
  assert.match(program, /\{\{id_1\}\}/, "the id is a substitution citing its producer step");
  // And no response body was committed: the trajectory carries the projection.
  assert.match(jsonl, /Body shape \(api-projection-v1\)/);
});

test("one full heal → accept cycle: drift, a reviewable changed journey, promotion, and a green replay", async () => {
  const dir = copySuite("cycle");
  const caseFile = path.join(dir, "stories", "ledger-journey.yaml");

  // 1. The surface moves: the account view renames created_at to opened_at. It
  //    breaks no declared expectation, which is precisely what makes it an
  //    ACCEPTABLE contract drift rather than a regression.
  const healed = await run(dir, {
    options: { prefix: "R", renameTimestamp: true },
    healScript: [
      { thought: "post the seed entry", action: { type: "request", method: "POST", path: "/entries", headers: { "Idempotency-Key": "seed-1" }, body: { account_id: "acc_R_1", amount: 250 } }, expectation: "a 201" },
      { thought: "replay it with the same key", action: { type: "request", method: "POST", path: "/entries", headers: { "Idempotency-Key": "seed-1" }, body: { account_id: "acc_R_1", amount: 250 } }, expectation: "the same entry" },
      { thought: "read the account back", action: { type: "request", method: "GET", path: "/accounts/acc_R_1" }, expectation: "a balance of 250" },
      { thought: "done", action: { type: "done", summary: "funded the account once and confirmed the balance" }, expectation: "the balance is 250" },
    ],
  });
  assert.equal(healed.res.manifest.mode, "heal");
  assert.equal(healed.res.status, "pass", `the changed journey is green (error: ${healed.res.error ?? "none"})`);
  assert.equal(healed.res.manifest.healed, true);
  assert.equal(healed.res.manifest.heal.classification, "contract_drift");
  assert.equal(healed.res.manifest.heal.accepted, true);
  assert.ok(
    healed.res.manifest.heal.signals.some((s: LegacyTestValue) => s.kind === "field_renamed" && /created_at was renamed to \$\.opened_at/.test(s.detail)),
    `the rename is named from the two projections: ${JSON.stringify(healed.res.manifest.heal.signals)}`,
  );
  // Every policy still had to hold on the HEALED trajectory before it counted.
  const healedChecks = healed.res.manifest.result.gate.checks;
  assert.deepEqual(healedChecks.filter((c: LegacyTestValue) => !c.pass), []);
  assert.equal(healedChecks.filter((c: LegacyTestValue) => c.kind === "invariant" && c.applicable).length, 5);

  // 2. It is held for review, not silently adopted.
  const paths = baselinePaths(caseFile);
  assert.ok(fs.existsSync(paths.healedTraj), "a healed candidate awaits a human");
  assert.equal(JSON.parse(fs.readFileSync(paths.healedMeta, "utf8")).candidate, true);
  assert.equal(fs.readFileSync(paths.traj, "utf8").includes("opened_at"), false, "the accepted baseline has not moved yet");
  const report = JSON.parse(fs.readFileSync(path.join(healed.res.runDir, "drift-report.json"), "utf8"));
  assert.equal(report.healed_run.accepted, true);
  assert.equal(report.healed_run.gate.pass, true);

  // 3. The human accepts (`playtest baseline accept`).
  const meta = promoteHealed(caseFile);
  assert.equal(meta.candidate, undefined, "promotion clears the candidate flag");
  assert.ok(!fs.existsSync(paths.healedTraj), "and consumes the candidate");
  assert.equal(fs.readFileSync(paths.traj, "utf8").includes("opened_at"), true, "the new surface is now the baseline");

  // 4. The cycle closes: the promoted baseline replays green against the CHANGED
  //    API, deterministically, with no model configured at all.
  const replay = await run(dir, { options: { prefix: "S", renameTimestamp: true } });
  assert.equal(replay.res.status, "pass", `the promoted baseline replays (error: ${replay.res.error ?? "none"})`);
  assert.equal(replay.res.manifest.mode, "act");
  assert.equal(replay.res.manifest.healed, false, "zero heals: the journey is a regression test again");
  assert.deepEqual(replay.res.manifest.result.gate.checks.filter((c: LegacyTestValue) => !c.pass), []);
});
