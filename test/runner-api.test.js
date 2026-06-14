// API driver (fetch) self-test, against the REAL zero-dep todo-app — endpoints
// are the "elements", a request is the "action", the JSON response is what you
// "see". The mock-llm drives the actor over the API-surface snapshot; runCase
// exercises record → act + the deterministic api gate (api_called /
// response_status / response_matches) + the model-judged assert + driver:api
// pins. This is a true end-to-end run (no mocked transport).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import net from "node:net";

import { discoverCases, DummyConfigError } from "../src/harness/config.js";
import { runCase } from "../src/harness/runner.js";
import { newRunId, readTrajectory, actionOf, baselinePaths } from "../src/harness/trajectory.js";
import { start as startMock } from "../src/harness/testing/mock-llm.js";
import { start as startApp } from "../src/todo-app/server.js";

let mock;
let app;
let tmpRoot;

before(async () => {
  mock = await startMock();
  app = await startApp();
  process.env.PLAYTEST_LLM_BASE_URL = mock.url;
  delete process.env.PLAYTEST_LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-api-"));
});

after(async () => {
  if (mock) await mock.close();
  if (app) await app.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function apiSuite() {
  const dir = path.join(tmpRoot, "suite");
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(path.join(dir, "playtest.yaml"), "app:\n  driver: api\nactor_model: claude-haiku-4-5\ngrader_model: claude-sonnet-4-6\n");
  fs.writeFileSync(
    path.join(dir, "stories", "create-todo.yaml"),
    [
      "tags: [smoke]",
      "story: |",
      '  Add a todo called "buy milk" through the API and confirm it was created.',
      "success:",
      '  - api_called: "POST /api/todos"',
      '  - response_status: "201"',
      '  - response_matches: \'$.title == "buy milk"\'',
      '  - assert: \'the created todo has the title "buy milk"\'',
      "",
    ].join("\n"),
  );
  return dir;
}

test("config: api validation — wrong-driver criteria are rejected, base_url required", async () => {
  // element_exists is web-only on an api case
  const bad = path.join(tmpRoot, "bad");
  fs.mkdirSync(path.join(bad, "stories"), { recursive: true });
  fs.writeFileSync(path.join(bad, "playtest.yaml"), "app:\n  driver: api\n  base_url: http://localhost:1\n");
  fs.writeFileSync(path.join(bad, "stories", "x.yaml"), 'story: do a thing\nsuccess:\n  - element_exists: "#x"\n');
  await assert.rejects(() => discoverCases([bad]), /element_exists.*not valid for the api driver|api/i);

  // response_status on a web case is equally rejected
  const bad2 = path.join(tmpRoot, "bad2");
  fs.mkdirSync(path.join(bad2, "stories"), { recursive: true });
  fs.writeFileSync(path.join(bad2, "playtest.yaml"), "app:\n  base_url: http://localhost:1\n");
  fs.writeFileSync(path.join(bad2, "stories", "y.yaml"), 'story: do a thing\nsuccess:\n  - response_status: "200"\n');
  await assert.rejects(() => discoverCases([bad2]), /response_status.*not valid for the web driver|web/i);

  // base_url is genuinely REQUIRED for the api driver (it reaches an HTTP
  // origin): an api suite with no base_url anywhere — and no --base-url override
  // — is rejected at discovery naming the missing key. (The earlier sub-cases
  // all set base_url; without this one the test name "base_url required" was a
  // lie — nothing here actually exercised the missing-base_url path.)
  const noUrl = path.join(tmpRoot, "no-base-url");
  fs.mkdirSync(path.join(noUrl, "stories"), { recursive: true });
  fs.writeFileSync(path.join(noUrl, "playtest.yaml"), "app:\n  driver: api\n");
  fs.writeFileSync(path.join(noUrl, "stories", "z.yaml"), 'story: do a thing\nsuccess:\n  - response_status: "200"\n');
  await assert.rejects(
    () => discoverCases([noUrl]),
    (e) => e instanceof DummyConfigError && /base_url/.test(e.message),
  );
});

test("api record → act: request envelopes, deterministic + assert gate, driver:api pins", async () => {
  const [rc] = await discoverCases([apiSuite()], { baseUrl: app.url });
  assert.equal(rc.env.driver, "api");
  assert.equal(rc.env.base_url, app.url, "--base-url override flows to the api driver");

  // ---- record ----
  const rec = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(rec.status, "pass", `record should pass; error: ${rec.error ?? "(none)"}; checks: ${JSON.stringify(rec.manifest.result.gate?.checks)}`);
  assert.equal(rec.manifest.pins.driver, "api");
  assert.equal(rec.manifest.pins.settle.name, "settle-api-v1");
  assert.equal(rec.manifest.env.driver, "api");
  // every success kind passed (api_called + response_status + response_matches + assert)
  assert.ok(rec.manifest.result.gate.pass, `gate failed: ${JSON.stringify(rec.manifest.result.gate.checks.filter((c) => !c.pass))}`);
  const kinds = rec.manifest.result.gate.checks.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["api_called", "assert", "response_matches", "response_status"]);

  const envs = readTrajectory(path.join(rec.runDir, "trajectory.jsonl"));
  const req = envs.find((e) => actionOf(e)?.type === "request");
  assert.ok(req, "a request envelope was recorded (api verb)");
  assert.equal(req.resolution.locator, "POST /api/todos", "durable locator is METHOD /path");
  assert.equal(req.network.requests[0].status, 201, "native network.requests carries the status");
  assert.ok(!envs.some((e) => actionOf(e)?.type === "click"), "no web verbs leak into an api run");

  // response bodies live in har.json (the response_matches/assert data source), never the embedded trajectory
  const har = JSON.parse(fs.readFileSync(path.join(rec.runDir, "har.json"), "utf8"));
  const post = har.log.entries.find((e) => e.request.method === "POST");
  assert.match(post.response.body, /"title":\s*"buy milk"/);
  assert.ok(!("body" in req.network.requests[0]), "embedded network.requests stays body-free (baseline-stable)");

  // ---- act (baseline now exists → replay the request track) ----
  const act = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(act.status, "pass", `act should pass; error: ${act.error ?? "(none)"}`);
  assert.equal(act.manifest.mode, "act");
  const actEnvs = readTrajectory(path.join(act.runDir, "trajectory.jsonl"));
  assert.ok(actEnvs.some((e) => e.mode === "act" && actionOf(e)?.type === "request"), "acted the request straight from the baseline");
});

/** An ephemeral port that is guaranteed closed: bind it, read it, release it. */
async function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// INFRA path (mirrors harness.test.js "a dead base-url is an infra failure"):
// an api case pointed at a CLOSED port never reaches the gate — prepareEnv's
// health probe can't connect, so the case is status "infra" (exit 2) and the
// cause is durably recorded in manifest.result.error (the only place the viewer
// / fix-loop skill can read it back).
test("api against a closed port is an infra failure with a non-empty manifest result.error", async () => {
  const deadUrl = `http://127.0.0.1:${await closedPort()}`;
  const [rc] = await discoverCases([apiSuite()], { baseUrl: deadUrl });
  assert.equal(rc.env.driver, "api");
  assert.equal(rc.env.base_url, deadUrl);

  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(res.status, "infra", `closed port should be infra, got ${res.status} (error: ${res.error ?? "(none)"})`);
  const manifest = JSON.parse(fs.readFileSync(path.join(res.runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.result.status, "infra", "manifest records the infra status");
  assert.equal(typeof manifest.result.error, "string", "infra manifest must carry result.error");
  assert.ok(manifest.result.error.length > 0, "result.error must name the cause");
});

// A wait step rides the api act/replay track (the api-wait-replay fix): the api
// driver tags a wait with resolution.locator:null so actionTrack keeps it (just
// like web/mobile), and executeLocator replays it. The mock actor never emits a
// wait, so splice one into the blessed baseline, then act and assert the wait
// replayed (mode "act", acted_from the spliced baseline step).
test("api act: a wait step is retained on the replay track and is re-acted", async () => {
  const suite = path.join(tmpRoot, "wait-suite");
  fs.mkdirSync(path.join(suite, "stories"), { recursive: true });
  fs.writeFileSync(path.join(suite, "playtest.yaml"), "app:\n  driver: api\nactor_model: claude-haiku-4-5\ngrader_model: claude-sonnet-4-6\n");
  fs.writeFileSync(
    path.join(suite, "stories", "create-todo.yaml"),
    [
      "story: |",
      '  Add a todo called "buy milk" through the API and confirm it was created.',
      "success:",
      '  - api_called: "POST /api/todos"',
      "",
    ].join("\n"),
  );
  const [rc] = await discoverCases([suite], { baseUrl: app.url });

  // ---- record (blesses the baseline) ----
  const rec = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(rec.status, "pass", `record should pass; error: ${rec.error ?? "(none)"}`);
  const trajPath = baselinePaths(rc.file).traj;
  assert.ok(fs.existsSync(trajPath), "record must bless a baseline");

  // Splice a wait envelope BEFORE the request so the replay must re-act it.
  // resolution.locator:null is exactly what ApiDriver.execute returns for a
  // wait — actionTrack keeps it (truthy resolution + ok result), so it stays on
  // the replay track instead of being dropped.
  const envelopes = readTrajectory(trajPath);
  const reqIdx = envelopes.findIndex((e) => actionOf(e)?.type === "request");
  assert.ok(reqIdx >= 0, "the recorded baseline has a request to wait before");
  const waitEnvelope = {
    step: 0, // renumbered on replay; the baseline `step` is only used for acted_from
    schema_version: envelopes[reqIdx].schema_version,
    ts: envelopes[reqIdx].ts,
    mode: "agent",
    agent: { thought: "Pause so the write settles.", action: { type: "wait", seconds: 0.1 }, expectation: "nothing changes" },
    resolution: { locator: null, bbox: null },
    result: { ok: true, error: null, settle_ms: 100, url: null },
    perf: null,
    network: { requests: [] },
  };
  const spliced = [...envelopes.slice(0, reqIdx), waitEnvelope, ...envelopes.slice(reqIdx)];
  fs.writeFileSync(trajPath, spliced.map((e) => JSON.stringify(e)).join("\n") + "\n");

  // ---- act: the spliced baseline now drives replay ----
  const act = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(act.status, "pass", `act should pass; error: ${act.error ?? "(none)"}`);
  assert.equal(act.manifest.mode, "act");
  const actEnvs = readTrajectory(path.join(act.runDir, "trajectory.jsonl"));
  const actedWait = actEnvs.find((e) => e.mode === "act" && actionOf(e)?.type === "wait");
  assert.ok(actedWait, "the wait step was retained on the replay track and re-acted");
  assert.equal(actedWait.result.ok, true, "the replayed wait succeeded");
  assert.equal(typeof actedWait.acted_from, "number", "the acted wait points back at its baseline step");
  // The request still replays after the wait — the wait didn't displace it.
  assert.ok(actEnvs.some((e) => e.mode === "act" && actionOf(e)?.type === "request"), "the request replays after the wait");
});
