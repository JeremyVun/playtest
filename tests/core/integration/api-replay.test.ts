// P3 exit gate: an acted API journey is a parameterized program, not a replay of
// literal bytes. It replays deterministically against a FRESH instance whose ids
// differ end to end, with no model in the loop; match rules quiet volatile
// structure without ever masking a real change; and a changed status on an
// intermediate step is drift attributed to that step.
// See docs/contracts/engine.md#bindings and #match-rules.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCases } from "../../../src/core/config.ts";
import { runCase } from "../../../src/core/runner.ts";
import { newRunId, baselinePaths, readTrajectory, actionOf } from "../../../src/core/trajectory.ts";
import { resetSecrets } from "../../../src/core/secrets.ts";
import { startReplayApi } from "../../fixtures/replay-api/server.ts";
import { startScriptedModel } from "../../support/scripted-model.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const SPEC = path.join(FIXTURES, "replay-api/openapi.yaml");

// The ids the RECORDING instance mints. Every acting instance uses a different
// prefix, so a baseline that re-sent these literally would 404 immediately.
const ACCOUNT_A = "acc_A_1";

let tmpRoot: LegacyTestValue;
const servers: LegacyTestValue = [];

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-replay-"));
});

after(async () => {
  for (const s of servers) await s.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetSecrets();
  delete process.env.PLAYTEST_LLM_BASE_URL;
});

beforeEach(() => {
  resetSecrets();
});

async function api(options: LegacyTestValue) {
  const server = await startReplayApi(options);
  servers.push(server);
  return server;
}

async function scripted(steps: LegacyTestValue) {
  const model = await startScriptedModel(steps);
  servers.push(model);
  return model;
}

/** The recorded journey, written against the RECORDING instance's literal ids. */
const script = [
  { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201 with the new account" },
  { thought: "activate it", action: { type: "request", method: "POST", path: `/accounts/${ACCOUNT_A}/activate` }, expectation: "the account becomes active" },
  {
    thought: "post an entry",
    action: { type: "request", method: "POST", path: "/entries", headers: { "X-Account-Id": ACCOUNT_A }, body: { account_id: ACCOUNT_A, amount: 250 } },
    expectation: "a 201 with the entry",
  },
  { thought: "read the account back", action: { type: "request", method: "GET", path: `/accounts/${ACCOUNT_A}` }, expectation: "the balance reflects the entry" },
  { thought: "list its entries", action: { type: "request", method: "GET", path: `/entries?account=${ACCOUNT_A}` }, expectation: "one entry" },
  { thought: "done", action: { type: "done", summary: "opened, funded, and read the account" }, expectation: "the account holds 250" },
];

const STORY = [
  "story: |",
  '  Open an account for "ada", activate it, post an entry of 250, and read it back.',
  "success:",
  '  - api_called: "POST /accounts"',
  "  - response_matches:",
  '      op: "GET /accounts/{accountId}"',
  '      match: \'$.status == "active"\'',
  "      occurrence: last",
  "",
].join("\n");

/**
 * A suite pointed at `baseUrl`. `match` is the suite's declared match-rule block;
 * it is written at RECORD time so both sides of a later comparison agree.
 */
function writeSuite(name: LegacyTestValue, { baseUrl, match = ["match:", "  exclude:", "    - $.notices", "    - $.balance"] }: LegacyTestValue) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "playtest.yaml"),
    ["app:", "  driver: api", `  base_url: ${baseUrl}`, `  openapi: ${SPEC}`, ...match, ""].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "stories", "journey.yaml"), STORY);
  return dir;
}

/** Record the journey against a fresh "A" instance and return its suite + baseline. */
async function record(name: LegacyTestValue, options: LegacyTestValue = {}) {
  const target = await api({ prefix: "A", notices: 0 });
  const model = await scripted(script);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const suite = writeSuite(name, { baseUrl: target.url, ...options });
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, `${name}-record`), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(res.status, "pass", `the record run should pass (error: ${res.error ?? "none"})`);
  delete process.env.PLAYTEST_LLM_BASE_URL; // from here on, no model can paper over a drift
  return { suite, rc, target, res };
}

/** Act the suite's baseline against a freshly-minted instance. */
async function act(suite: LegacyTestValue, label: LegacyTestValue, options: LegacyTestValue) {
  const target = await api(options);
  const [rc]: LegacyTestValue = await discoverCases([suite], { baseUrl: target.url });
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, `act-${label}`), runId: newRunId(), grade: false, onEvent: () => {} });
  return { res, target };
}

test("an acted API journey replays against fresh instances with new ids, repeatedly, with zero heals", async () => {
  const { suite, rc } = await record("replays");

  // --- the committed baseline is a PROGRAM: no instance's ids survive in it.
  const paths = baselinePaths(rc.file);
  assert.ok(fs.existsSync(paths.traj), "a clean scan auto-accepts the first passing record");
  const committed = fs.readFileSync(paths.traj, "utf8");
  assert.match(committed, /\{\{id_1\}\}/, "the id is a substitution instead");

  const envelopes = readTrajectory(paths.traj);
  // The recorded PROGRAM — every action the replay re-sends — carries no id from
  // the instance it was recorded against. (The envelope's `network.requests`
  // still records the URLs that were actually fetched; that is a log of the
  // recording, not an input to the replay.)
  const program = JSON.stringify(envelopes.map((e) => actionOf(e)));
  assert.ok(!program.includes(ACCOUNT_A), `no literal id may survive into a recorded action: ${program}`);
  const activate: LegacyTestValue = envelopes.find((e) => actionOf(e)?.path?.includes("/activate"));
  assert.equal(actionOf<LegacyTestValue>(activate)!.path, "/accounts/{{id_1}}/activate", "a path segment binds"); // SAFETY: fixture lookup above proves the action exists
  assert.deepEqual(activate.bindings, [{ name: "id_1", from_step: 1, from: "$.id", into: ["path"] }], "every substitution cites its producer step and path");
  const entry: LegacyTestValue = envelopes.find((e) => actionOf(e)?.path === "/entries" && actionOf(e)?.method === "POST");
  assert.equal(actionOf<LegacyTestValue>(entry)!.body.account_id, "{{id_1}}", "a JSON body field binds"); // SAFETY: fixture lookup above proves the action exists
  assert.equal(actionOf<LegacyTestValue>(entry)!.headers["X-Account-Id"], "{{id_1}}", "a header value binds"); // SAFETY: fixture lookup above proves the action exists
  assert.deepEqual(entry.bindings[0].into.sort(), ["body.account_id", "headers.X-Account-Id"], "each substitution site is recorded");
  const list: LegacyTestValue = envelopes.find((e) => actionOf(e)?.path?.startsWith("/entries?"));
  assert.equal(actionOf<LegacyTestValue>(list)!.path, "/entries?account={{id_1}}", "a query value binds"); // SAFETY: fixture lookup above proves the action exists
  assert.equal(entry.expect.status, 201, "the exact status the step observed is recorded");
  // Client-authored and non-identifier values are NOT bound: over-eager binding
  // corrupts a replay silently, which is worse than a brittle one failing loudly.
  const create: LegacyTestValue = envelopes.find((e) => actionOf(e)?.method === "POST" && actionOf(e)?.path === "/accounts");
  assert.equal(actionOf<LegacyTestValue>(create)!.body.owner, "ada", "the client's own input stays literal"); // SAFETY: fixture lookup above proves the action exists
  assert.equal(create.bindings, undefined, "a step that binds nothing carries no bindings field");

  // --- act three times, each against a brand-new instance minting different
  // ids, a different volatile notice count, and later timestamps. No model is
  // configured, so a heal is impossible: green here means genuinely zero drift.
  for (const [i, prefix] of ["B", "C", "D"].entries()) {
    const { res, target } = await act(suite, `fresh-${prefix}`, { prefix, notices: i });
    assert.equal(res.status, "pass", `replay ${prefix} should pass (error: ${res.error ?? "none"})`);
    assert.equal(res.manifest.mode, "act", `replay ${prefix} replayed the saved path rather than re-recording`);
    assert.equal(res.manifest.healed ?? false, false, `replay ${prefix} healed nothing`);
    // ...and it genuinely used THIS instance's ids end to end.
    const activated = target.requests.find((r: LegacyTestValue) => r.path.endsWith("/activate"));
    assert.equal(activated.path, `/accounts/acc_${prefix}_1/activate`, "the path binding resolved to the fresh instance's id");
    const posted = target.requests.find((r: LegacyTestValue) => r.method === "POST" && r.path === "/entries");
    assert.equal(posted.body.account_id, `acc_${prefix}_1`, "the body binding resolved to the fresh instance's id");
    assert.equal(posted.headers["x-account-id"], `acc_${prefix}_1`, "the header binding resolved too");
    assert.equal(target.requests.find((r: LegacyTestValue) => r.method === "GET" && r.path === "/entries").query.account, `acc_${prefix}_1`);
    assert.ok(!target.requests.some((r: LegacyTestValue) => r.path.includes(ACCOUNT_A)), "no request carried the recording instance's id");
  }
});

test("a renamed response field still triggers drift — match rules cannot mask a real change", async () => {
  // The suite excludes $.balance outright, the strongest rule available. The
  // field is still renamed to available_balance, and the projection still moves.
  const { suite } = await record("renamed");
  const { res } = await act(suite, "renamed", { prefix: "R", rename: true });
  assert.equal(res.status, "fail", "a renamed response field must fail the replay, not pass quietly");
  assert.match(res.error ?? "", /acted step \d+ failed and no LLM is configured to heal/);
  const drifted: LegacyTestValue = res.manifest.result.end_reason;
  assert.equal(drifted, "error", "the replay stopped at the drift rather than running to completion");
  const envelopes = readTrajectory(path.join(res.runDir, "trajectory.jsonl"));
  const marker: LegacyTestValue = envelopes.find((e) => e.confusion?.type === "state_drift");
  assert.ok(marker, "the drift is recorded as a state-drift marker on the step that saw it");
  assert.match(marker.confusion.note, /the page changed under the recorded action|snapshot/);
});

test("a status change on an intermediate step attributes to that step, unless a normalization declares it equivalent", async () => {
  const { suite } = await record("status");

  // POST /entries answers 202 instead of 201. The change is on step 3; a
  // snapshot-only oracle would not notice until step 4 read the changed status
  // line, so the attribution is the point of the step-scoped expectation.
  const { res } = await act(suite, "status-202", { prefix: "S", entryStatus: 202 });
  assert.equal(res.status, "fail", "a within-class 201 -> 202 change is still a contract change");
  assert.match(res.error ?? "", /acted step 3 failed/, "the failure attributes to the step whose status changed");
  const envelopes = readTrajectory(path.join(res.runDir, "trajectory.jsonl"));
  const drifted: LegacyTestValue = envelopes.find((e) => e.confusion?.type === "state_drift");
  assert.equal(drifted.acted_from, 3, "the drift marker sits on the acted step itself");
  assert.match(drifted.confusion.note, /answered 202 where the baseline recorded 201/);
  assert.match(drifted.confusion.note, /match\.status_equivalent/, "the message names the normalization that would declare it intended");

  // Declaring the two statuses interchangeable — and only that — makes the same
  // replay green, both for the step-scoped check and the snapshot oracle.
  const yaml = path.join(suite, "playtest.yaml");
  fs.writeFileSync(yaml, `${fs.readFileSync(yaml, "utf8")}  status_equivalent:\n    - [201, 202]\n`);
  const declared = await act(suite, "status-declared", { prefix: "T", entryStatus: 202 });
  assert.equal(declared.res.status, "pass", `a declared equivalence replays green (error: ${declared.res.error ?? "none"})`);
  assert.equal(declared.res.manifest.mode, "act");
});

test("volatile response structure needs a match rule: without one the same replay drifts", async () => {
  // Same journey, same fresh-instance replay — but no exclude for the volatile
  // notices list. The rule is load-bearing, not decorative.
  const { suite } = await record("unruled", { match: [] });
  const { res } = await act(suite, "unruled", { prefix: "U", notices: 2 });
  assert.equal(res.status, "fail", "a list whose length differs per instance reads as drift with no rule");

  const { suite: ruled } = await record("ruled");
  const green = await act(ruled, "ruled", { prefix: "V", notices: 2 });
  assert.equal(green.res.status, "pass", `the same drift is quiet once excluded (error: ${green.res.error ?? "none"})`);
});

test("the enriched spec reaches the gate: a failing selector reports what the document declares", async () => {
  const target = await api({ prefix: "G" });
  const model = await scripted([
    { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "201" },
    { thought: "done", action: { type: "done", summary: "opened the account" }, expectation: "the account exists" },
  ]);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const dir = path.join(tmpRoot, "spec-gate");
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(path.join(dir, "playtest.yaml"), ["app:", "  driver: api", `  base_url: ${target.url}`, `  openapi: ${SPEC}`, ""].join("\n"));
  fs.writeFileSync(
    path.join(dir, "stories", "journey.yaml"),
    [
      "story: |",
      '  Open an account for "ada".',
      "success:",
      "  - response_status:",
      '      op: "POST /accounts"',
      '      status: "200"',
      "      occurrence: all",
      "  - response_status:",
      '      op: "DELETE /accounts/{accountId}"',
      '      status: "204"',
      "",
    ].join("\n"),
  );
  const [rc]: LegacyTestValue = await discoverCases([dir]);
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, "spec-gate-run"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(res.status, "fail");
  const checks = res.manifest.result.gate.checks;
  const wrongStatus = checks.find((c: LegacyTestValue) => c.spec.includes("POST /accounts"));
  assert.equal(wrongStatus.pass, false);
  assert.match(wrongStatus.detail, /answered 201 where 200 was expected/);
  assert.match(wrongStatus.detail, /the spec declares 201, 422 for POST \/accounts/, "declared statuses from the enriched document reach the gate");
  const unexercised = checks.find((c: LegacyTestValue) => c.spec.includes("DELETE"));
  assert.equal(unexercised.pass, false, "a selector matching zero requests fails — 'all' is never vacuously true");
  assert.match(unexercised.detail, /the spec declares no DELETE \/accounts\/\{accountId\}/);

  // The actor's snapshot carries the enriched operation lines, not bare summaries.
  const snapshot = fs.readFileSync(path.join(res.runDir, "steps", "001.a11y.txt"), "utf8");
  assert.match(snapshot, /\[e1\] POST \/accounts — Open an account \[body: owner\*\] → 201, 422/);
});
