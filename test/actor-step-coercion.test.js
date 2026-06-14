// Two actor-step paths the offline gate did not exercise before — both are
// load-bearing now that the cheap haiku actor is the default again:
//
//  1. The stringified-nested-arg coercion. Some gateways (and smaller models)
//     JSON-encode the step's `action` object as a STRING; coerceStringifiedArgs
//     un-stringifies it inside forcedToolCall (llm.js) so validation passes
//     WITHOUT burning the single retry. PLAYTEST_MOCK_STRINGIFY_ARGS=1
//     reproduces that gateway; a record run must still pass and make exactly one
//     "step" call per recorded step (a burned retry would double the calls).
//
//  2. The actor-error envelope path. A model that cannot produce a valid step
//     (PLAYTEST_MOCK_BAD_STEP=1 emits an un-coercible action) must yield a
//     terminal mode:"error" envelope, a failed run (end_reason "error"), and
//     accept must refuse it — a crashed run is never graded green or baselined.
//
// The mock LLM runs IN THIS PROCESS, so the PLAYTEST_MOCK_* flags are set on
// this process's env around each run, not in the child CLI's env.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { start as startApp } from "../src/todo-app/server.js";
import { start as startMock } from "../src/harness/testing/mock-llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "harness", "cli.js");

let mock;
let app;
let tmpRoot;
let caseFile;
let crashCaseFile;
let runsRoot;
const children = new Set();

before(async () => {
  mock = await startMock();
  app = await startApp();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-coercion-"));
  const suiteDir = path.join(tmpRoot, "suite");
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(path.join(suiteDir, "stories"), { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(suiteDir, "playtest.yaml"),
    `app:\n  base_url: ${app.url}\nactor_model: claude-haiku-4-5\ngrader_model: claude-sonnet-4-6\nmax_steps: 15\ntimeout: 60s\n`,
  );
  // A story the rule-based mock can drive to completion against the todo app;
  // the gate uses only deterministic checks (no assert -> no verdict call), so a
  // run's "step" calls are exactly its actor steps.
  fs.writeFileSync(
    path.join(suiteDir, "stories", "add-todo.yaml"),
    [
      "tags: [smoke]",
      'description: Add "buy milk" and see it appear.',
      "story: |",
      '  Use this todo app to add a todo called "buy milk" so it shows up in your list.',
      "success:",
      '  - element_exists: "[data-testid=todo-item]"',
      '  - api_called: "POST /api/todos"',
      "perf:",
      "  console_errors: 0",
      "",
    ].join("\n"),
  );
  caseFile = path.join(suiteDir, "stories", "add-todo.yaml");
  // A second, baseline-free case for the actor-error test: the coercion test
  // records add-todo, so re-using it would run the next test in act mode (which
  // replays locators and never calls the actor, so the bad-step flag wouldn't fire).
  fs.writeFileSync(
    path.join(suiteDir, "stories", "crash.yaml"),
    [
      "story: |",
      '  Add a todo called "crash test" so it shows up in your list.',
      "success:",
      '  - element_exists: "[data-testid=todo-item]"',
      "",
    ].join("\n"),
  );
  crashCaseFile = path.join(suiteDir, "stories", "crash.yaml");
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const server of [app, mock]) {
    if (server) await server.close().catch(() => {});
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function childEnv() {
  const env = { ...process.env };
  delete env.PLAYTEST_LLM_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PLAYTEST_LLM_CACHE; // opt-in caching off for offline tests — keeps the wire bytes golden
  delete env.PLAYTEST_BROWSER_CHANNEL; // measured runs use the pinned chromium
  env.PLAYTEST_LLM_BASE_URL = mock.url;
  return env;
}

function runCli(args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      children.delete(child);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      timedOut
        ? reject(new Error(`playtest ${args.join(" ")} hung\n${stdout}\n${stderr}`))
        : resolve({ code, stdout, stderr });
    });
  });
}

const runJson = (res) => JSON.parse(res.stdout.split("\n").find((l) => l.trim().startsWith("{")));
const readTrajectory = (dir) =>
  fs
    .readFileSync(path.join(dir, "trajectory.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("a stringified `action` is coerced through forcedToolCall: the run passes and burns no extra retry", async () => {
  const before = mock.requestCount("step");
  process.env.PLAYTEST_MOCK_STRINGIFY_ARGS = "1";
  let res;
  try {
    res = await runCli(["run", caseFile, "--json", "--plain", "--runs-root", runsRoot]);
  } finally {
    delete process.env.PLAYTEST_MOCK_STRINGIFY_ARGS;
  }
  assert.equal(res.code, 0, `coerced record run should pass\n${res.stdout}\n${res.stderr}`);
  const c = runJson(res).cases[0];
  assert.equal(c.status, "pass");
  const traj = readTrajectory(c.run_dir);
  assert.ok(!traj.some((e) => e.mode === "error"), "no step degraded to an actor error");
  // Exactly one "step" call per recorded step proves coercion (not the retry)
  // repaired every stringified action — a burned retry would double the count.
  assert.equal(
    mock.requestCount("step") - before,
    c.steps,
    "coercion, not the single retry, repaired every stringified action",
  );
});

test("a model that can't produce a valid step yields a mode:error envelope, a failed run, and accept refuses it", async () => {
  const before = mock.requestCount("step");
  process.env.PLAYTEST_MOCK_BAD_STEP = "1";
  let res;
  try {
    res = await runCli(["run", crashCaseFile, "--json", "--plain", "--runs-root", runsRoot]);
  } finally {
    delete process.env.PLAYTEST_MOCK_BAD_STEP;
  }
  assert.equal(res.code, 1, `an actor-error run is a failure (exit 1)\n${res.stdout}\n${res.stderr}`);
  const c = runJson(res).cases[0];
  assert.equal(c.status, "fail");
  // One step attempt + one retry, then the run records the error and stops.
  assert.equal(mock.requestCount("step") - before, 2, "the single retry is burned, then the error is recorded");

  const traj = readTrajectory(c.run_dir);
  const last = traj[traj.length - 1];
  assert.equal(last.mode, "error", "the terminal envelope marks the actor failure");
  assert.equal(last.result.ok, false);
  assert.equal(typeof last.error, "string");
  assert.ok(
    last.agent === undefined && last.resolution === undefined && last.tokens === undefined,
    "an actor-error envelope carries no agent/resolution/tokens",
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(c.run_dir, "manifest.json"), "utf8"));
  assert.equal(manifest.result.end_reason, "error");
  assert.equal(manifest.result.status, "fail");

  // A crashed run is never accepted as a baseline (accept refuses a non-pass run).
  const acc = await runCli(["accept", c.run_dir]);
  assert.equal(acc.code, 2, `accept must refuse a non-pass run\n${acc.stdout}\n${acc.stderr}`);
});
