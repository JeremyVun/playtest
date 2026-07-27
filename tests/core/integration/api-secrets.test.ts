// P2 exit gate: secrets never reach a persisted artifact, the acceptance leak
// scan gates what gets committed, and a baseline recorded with secret references
// still acts against an authenticated target from its committed form alone.
// See docs/contracts/engine.md#secrets-and-redaction.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCases } from "../../../src/core/config.ts";
import { runCase } from "../../../src/core/runner.ts";
import { newRunId, baselinePaths, readTrajectory, actionOf, storyHash, API_PROJECTION_MARKER } from "../../../src/core/trajectory.ts";
import { resetSecrets } from "../../../src/core/secrets.ts";
import { startAuthApi } from "../../fixtures/auth-api/server.ts";
import { startScriptedModel } from "../../support/scripted-model.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "src/cli/cli.ts");

// A throwaway credential shaped like a real one: long, mixed case, digits — so
// the leak scan's credential rule would fire on it if it ever landed in a
// committed artifact. Keep the Stripe-shaped value out of the source so push
// protection does not mistake this fixture for a real credential.
const TOKEN = ["sk", "live", "4kQ9zVn2XbR7tLpW8mHc3JdY"].join("_");
// A reference substitutes a whole value, so the secret IS the header value. The
// bare token is registered alongside it, because a server echoing the credential
// back echoes it without the scheme.
const AUTH_HEADER = `Bearer ${TOKEN}`;
const OWNER_EMAIL = "alice@example.com";

let tmpRoot: LegacyTestValue;
let api;
const servers: LegacyTestValue = [];

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-secrets-"));
});

after(async () => {
  for (const s of servers) await s.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetSecrets();
  delete process.env.PLAYTEST_SECRET_LEDGER_TOKEN;
  delete process.env.PLAYTEST_SECRET_OWNER_EMAIL;
  delete process.env.PLAYTEST_LLM_BASE_URL;
});

beforeEach(() => {
  resetSecrets();
});

async function authApi() {
  api = await startAuthApi({ token: TOKEN });
  servers.push(api);
  return api;
}

async function scripted(steps: LegacyTestValue) {
  const model = await startScriptedModel(steps);
  servers.push(model);
  return model;
}

/** Write a suite whose one story targets `baseUrl`. */
function writeSuite(name: LegacyTestValue, { baseUrl, defaults = "", story }: LegacyTestValue) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "playtest.yaml"),
    ["app:", "  driver: api", `  base_url: ${baseUrl}`, "  headers:", "    Authorization:", "      $secret: LEDGER_TOKEN", defaults, ""].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "stories", "journey.yaml"), story);
  return dir;
}

/** Every file under a directory, recursively. */
function filesUnder(dir: LegacyTestValue): string[] {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function runCli(args: LegacyTestValue) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a run using a secret reference leaks nothing, and its baseline acts against auth from the committed form alone", async () => {
  const target = await authApi();
  process.env.PLAYTEST_SECRET_LEDGER_TOKEN = AUTH_HEADER;
  process.env.PLAYTEST_SECRET_OWNER_EMAIL = OWNER_EMAIL;
  const model = await scripted([
    {
      thought: "create the item",
      action: {
        type: "request",
        method: "POST",
        path: "/items",
        headers: { "Idempotency-Key": "create-widget-1" },
        body: { name: "widget", owner_email: OWNER_EMAIL },
      },
      expectation: "a 201 with the created item",
    },
    { thought: "check who I am", action: { type: "request", method: "GET", path: "/whoami" }, expectation: "the API names my role" },
    { thought: "done", action: { type: "done", summary: "created the widget" }, expectation: "the item exists" },
  ]);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;

  const suite = writeSuite("leakproof", {
    baseUrl: target.url,
    // The owner email is application data: declared here, it commits as a
    // placeholder and is resolved again at act time.
    defaults: ["redact:", "  request:", "    - path: body.owner_email", "      secret: OWNER_EMAIL"].join("\n"),
    story: [
      "story: |",
      "  Create an item called \"widget\" through the API.",
      "success:",
      '  - api_called: "POST /items"',
      '  - response_status: "201"',
      "",
    ].join("\n"),
  });

  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const runsRoot = path.join(tmpRoot, "runs-record");
  const rec = await runCase(rc, { runsRoot, runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(rec.status, "pass", `record run should pass (error: ${rec.error ?? "none"})`);

  // --- exit gate 1: grep the WHOLE run directory plus the committed baseline.
  const paths = baselinePaths(rc.file);
  assert.ok(fs.existsSync(paths.traj), "a clean scan auto-accepts the first passing record");
  const persisted = [...filesUnder(rec.runDir), paths.traj, paths.meta];
  const leaked = persisted.filter((f) => fs.readFileSync(f).includes(TOKEN));
  assert.deepEqual(leaked.map((f) => path.relative(ROOT, f)), [], "no persisted artifact may contain the secret value");
  const emailLeaks = [paths.traj, paths.meta].filter((f) => fs.readFileSync(f, "utf8").includes(OWNER_EMAIL));
  assert.deepEqual(emailLeaks, [], "redaction-listed application data must not reach the committed baseline");

  // The scrub is not vacuous: /whoami echoed the token back, so har.json and the
  // step snapshot are places it genuinely appeared and had to be replaced.
  const har = fs.readFileSync(path.join(rec.runDir, "har.json"), "utf8");
  assert.match(har, /\[secret:LEDGER_TOKEN\]/, "har.json is scrubbed at write time");
  assert.match(har, /authorization/i, "har.json still records that an auth header was sent");
  const snapshot = fs.readFileSync(path.join(rec.runDir, "steps", "003.a11y.txt"), "utf8");
  assert.match(snapshot, /\[secret:LEDGER_TOKEN\]/, "an echoed credential is scrubbed from the step snapshot too");

  // --- the committed baseline is a redacted request program + projections.
  const envelopes = readTrajectory(paths.traj);
  const create: LegacyTestValue = envelopes.find((e) => actionOf(e)?.path === "/items");
  assert.deepEqual(create.agent.action.body.owner_email, { $secret: "OWNER_EMAIL" }, "redacted request fields commit as placeholders");
  assert.equal(create.agent.action.headers["Idempotency-Key"], "create-widget-1", "non-secret request values stay literal");
  assert.equal(create.agent.action.headers.Authorization, undefined, "configured headers never enter the recorded action");
  const withResponse: LegacyTestValue = envelopes.find((e) => typeof e.snapshot_text === "string" && e.snapshot_text.includes("Last response:"));
  assert.match(withResponse.snapshot_text, new RegExp(API_PROJECTION_MARKER.replace(/[()]/g, "\\$&")), "snapshot_text is the response projection");
  assert.ok(!withResponse.snapshot_text.includes("widget"), "no raw response value survives into the trajectory");
  assert.match(withResponse.snapshot_text, /"name":"string"/, "the projection carries key structure and types");

  // --- exit gate 3: act from the committed form alone, against a target that
  // requires auth, with NO model configured (so any drift fails the run instead
  // of quietly healing) and a fresh server instance on a different port.
  const clone = path.join(tmpRoot, "fresh-clone");
  fs.cpSync(suite, clone, { recursive: true });
  fs.rmSync(path.join(tmpRoot, "runs-record"), { recursive: true, force: true });
  const target2 = await authApi();
  delete process.env.PLAYTEST_LLM_BASE_URL;
  const [rc2] = await discoverCases([clone], { baseUrl: target2.url });
  const act = await runCase(rc2, { runsRoot: path.join(tmpRoot, "runs-act"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(act.status, "pass", `acting the committed baseline should pass (error: ${act.error ?? "none"})`);
  assert.equal(act.manifest.mode, "act", "the run replayed the saved path rather than re-recording");

  const created = target2.requests.find((r: LegacyTestValue) => r.method === "POST" && r.path === "/items");
  assert.ok(created, "the acted replay reached the create endpoint");
  assert.equal(created.headers.authorization, `Bearer ${TOKEN}`, "the configured secret header is re-resolved at act time");
  assert.equal(created.headers["idempotency-key"], "create-widget-1", "idempotency-key headers survive the round trip");
  assert.equal(created.body.owner_email, OWNER_EMAIL, "a redacted body field is resolved back to its value at act time");
  assert.equal(created.body.name, "widget", "the JSON-body create replays intact");
  // ...and the run-local HAR still shows only placeholders for both values.
  const actHar = fs.readFileSync(path.join(act.runDir, "har.json"), "utf8");
  assert.ok(!actHar.includes(TOKEN) && !actHar.includes(OWNER_EMAIL), "the acted run's har.json is scrubbed too");
});

test("a legacy baseline — raw snapshot bodies, literal request values, no templates — still acts", async () => {
  const target = await authApi();
  process.env.PLAYTEST_SECRET_LEDGER_TOKEN = AUTH_HEADER;
  const suite = writeSuite("legacy", {
    baseUrl: target.url,
    story: ["story: |", "  Create an item called \"widget\" through the API.", "success:", '  - api_called: "POST /items"', '  - response_status: "201"', ""].join("\n"),
  });
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const paths = baselinePaths(rc.file);
  fs.mkdirSync(path.dirname(paths.traj), { recursive: true });
  // Hand-written in the pre-P2 shape: snapshot_text is the raw response body and
  // the recorded action carries literal values with no { $secret: … } anywhere.
  const head = `API: ${target.url}\n(no OpenAPI spec — infer endpoints from the task; a request is one action)`;
  fs.writeFileSync(
    paths.traj,
    [
      JSON.stringify({
        step: 1,
        schema_version: 7,
        mode: "agent",
        agent: { thought: "create", action: { type: "request", method: "POST", path: "/items", headers: { "Idempotency-Key": "legacy-1" }, body: { name: "widget" } }, expectation: "201" },
        snapshot_text: head,
        resolution: { locator: "POST /items", bbox: null },
        result: { ok: true, error: null, settle_ms: 1, url: "/items" },
      }),
      // Step 2's pre-action snapshot is the raw body of an OLDER instance's
      // response: same shape, different values. Comparing raw text would read as
      // drift and — with no model to heal — fail the run; projecting both sides
      // is what keeps this baseline replayable.
      JSON.stringify({
        step: 2,
        schema_version: 7,
        mode: "agent",
        agent: { thought: "read them back", action: { type: "request", method: "GET", path: "/items" }, expectation: "the list" },
        snapshot_text: `${head}\n\nLast response: 201 application/json\n{\n "id": "itm_99",\n "name": "gadget",\n "owner_email": null,\n "created_at": "2020-05-05T00:00:00.000Z"\n}`,
        resolution: { locator: "GET /items", bbox: null },
        result: { ok: true, error: null, settle_ms: 1, url: "/items" },
      }),
      JSON.stringify({
        step: 3,
        schema_version: 7,
        mode: "agent",
        agent: { thought: "done", action: { type: "done", summary: "created" }, expectation: "it exists" },
        result: { ok: true, error: null, settle_ms: 0, url: "/items" },
      }),
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    paths.meta,
    JSON.stringify({ accepted_at: new Date().toISOString(), run_id: "legacy", story_hash: storyHash(rc.story, rc.persona), base_url: target.url }, null, 2),
  );

  delete process.env.PLAYTEST_LLM_BASE_URL; // no model: a drift or failure cannot be papered over by a heal
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs-legacy"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(res.status, "pass", `a legacy baseline must keep acting (error: ${res.error ?? "none"})`);
  assert.equal(res.manifest.mode, "act");
  assert.ok(target.requests.some((r: LegacyTestValue) => r.method === "POST" && r.path === "/items" && r.headers["idempotency-key"] === "legacy-1"));
});

test("the acceptance leak scan blocks a seeded email in a response projection until it is redacted", async () => {
  const target = await authApi();
  process.env.PLAYTEST_SECRET_LEDGER_TOKEN = AUTH_HEADER;
  const model = await scripted([
    { thought: "read the balances", action: { type: "request", method: "GET", path: "/balances" }, expectation: "a map of balances" },
    { thought: "done", action: { type: "done", summary: "read the balances" }, expectation: "the balances are visible" },
  ]);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;

  const story = ["story: |", "  Read the balances through the API.", "success:", '  - response_status: "200"', ""].join("\n");
  const suite = writeSuite("leaky", { baseUrl: target.url, story });
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const runsRoot = path.join(tmpRoot, "runs-leaky");
  const res = await runCase(rc, { runsRoot, runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(res.status, "pass", `the run itself passes (error: ${res.error ?? "none"})`);

  const paths = baselinePaths(rc.file);
  assert.ok(!fs.existsSync(paths.traj), "a scan with findings must NOT auto-accept a baseline");
  assert.ok(fs.existsSync(paths.healedTraj), "it leaves a pending candidate instead");
  const candidate = JSON.parse(fs.readFileSync(paths.healedMeta, "utf8"));
  assert.equal(candidate.candidate, true);
  const emailFinding = candidate.scan.findings.find((f: LegacyTestValue) => f.rule === "data");
  assert.ok(emailFinding, `expected an application-data finding, got ${JSON.stringify(candidate.scan.findings)}`);
  assert.match(emailFinding.detail, /alice@example\.com/);
  assert.equal(res.manifest.baseline_scan.blocked, true, "the manifest records why nothing was accepted");

  // Declaring the field redacted removes the leak, and the next recording
  // auto-accepts exactly as an unflagged run always has.
  fs.writeFileSync(
    path.join(suite, "stories", "journey.yaml"),
    `${story}redact:\n  projection:\n    - $.balances_by_email\n`,
  );
  const model2 = await scripted([
    { thought: "read the balances", action: { type: "request", method: "GET", path: "/balances" }, expectation: "a map of balances" },
    { thought: "done", action: { type: "done", summary: "read the balances" }, expectation: "the balances are visible" },
  ]);
  process.env.PLAYTEST_LLM_BASE_URL = model2.baseUrl;
  const [rc2] = await discoverCases([suite]);
  const res2 = await runCase(rc2, { runsRoot, runId: newRunId(), grade: false, refresh: true, onEvent: () => {} });
  assert.equal(res2.status, "pass");
  assert.ok(fs.existsSync(paths.traj), "a clean scan auto-accepts again");
  const text = fs.readFileSync(paths.traj, "utf8");
  assert.ok(!text.includes("alice@example.com"), "the redacted projection field is gone from the committed baseline");
  assert.match(text, /\[redacted\]/, "the redacted node is shape-normalized, not silently dropped");
});

test("an explicit `baseline accept` approves a flagged candidate and fingerprints what it approved", async () => {
  const target = await authApi();
  process.env.PLAYTEST_SECRET_LEDGER_TOKEN = AUTH_HEADER;
  const model = await scripted([
    { thought: "read the balances", action: { type: "request", method: "GET", path: "/balances" }, expectation: "a map of balances" },
    { thought: "done", action: { type: "done", summary: "read the balances" }, expectation: "the balances are visible" },
  ]);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;

  const suite = writeSuite("approve-me", {
    baseUrl: target.url,
    story: ["story: |", "  Read the balances through the API.", "success:", '  - response_status: "200"', ""].join("\n"),
  });
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs-approve"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(res.status, "pass");
  const paths = baselinePaths(rc.file);
  assert.ok(!fs.existsSync(paths.traj), "the scan blocked automatic acceptance");

  const cli: LegacyTestValue = await runCli(["baseline", "accept", res.runDir]);
  assert.equal(cli.code, 0, `baseline accept failed: ${cli.stdout}${cli.stderr}`);
  assert.match(cli.stdout, /leak scan: approving 2 finding\(s\)/, "the human is shown exactly what they are committing");
  assert.match(cli.stdout, /alice@example\.com/, "each finding names the value being committed");
  assert.ok(fs.existsSync(paths.traj), "an explicit accept promotes the pending candidate");
  const meta = JSON.parse(fs.readFileSync(paths.meta, "utf8"));
  assert.equal(typeof meta.scan_approved.fingerprint, "string");
  assert.equal(meta.scan_approved.findings, 2);
  assert.equal(meta.scan, undefined, "the pending reason is replaced by the approval");
  const crypto = await import("node:crypto");
  assert.equal(
    meta.scan_approved.fingerprint,
    crypto.createHash("sha256").update(fs.readFileSync(paths.traj, "utf8")).digest("hex"),
    "the approval fingerprints exactly the committed bytes, so any later change invalidates it",
  );
});
