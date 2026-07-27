// API driver configuration and infrastructure-failure coverage. Actor-driven
// record/replay belonged to the removed deterministic mock-model fixture.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import net from "node:net";

import { discoverCases, DummyConfigError } from "../../src/config.ts";
import { runCase } from "../../src/runner.ts";
import { newRunId } from "../../src/trajectory.ts";

let tmpRoot: LegacyTestValue;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-api-"));
});

after(() => {
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

/** An ephemeral port that is guaranteed closed: bind it, read it, release it. */
async function closedPort() {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port }: LegacyTestValue = srv.address();
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
  const [rc]: LegacyTestValue = await discoverCases([apiSuite()], { baseUrl: deadUrl });
  assert.equal(rc.env.driver, "api");
  assert.equal(rc.env.base_url, deadUrl);

  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(res.status, "infra", `closed port should be infra, got ${res.status} (error: ${res.error ?? "(none)"})`);
  const manifest = JSON.parse(fs.readFileSync(path.join(res.runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.result.status, "infra", "manifest records the infra status");
  assert.equal(typeof manifest.result.error, "string", "infra manifest must carry result.error");
  assert.ok(manifest.result.error.length > 0, "result.error must name the cause");
});
