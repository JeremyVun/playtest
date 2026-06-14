// Offline end-to-end self-test of the playtest harness. Boots the bundled
// todo app and the rule-based
// mock LLM in-process on ephemeral ports, then drives the real CLI as a child
// process through record → act → heal → accept/reject, freezing the exit-code
// contract (0 pass / 1 gate failure / 2 infra) and the --json shape.
//
// No network beyond localhost, no API keys: the child env strips every key
// variable and points PLAYTEST_LLM_BASE_URL at the in-process mock. The
// committed example suite is copied (without baselines) into a temp dir;
// nothing under tests/ is ever mutated.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { start as startApp } from "../src/todo-app/server.js";
import { start as startMock } from "../src/harness/testing/mock-llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "harness", "cli.js");
const SUITE_SRC = path.join(ROOT, "tests");
const CHILD_TIMEOUT_MS = 90_000;

let mock; // mock LLM, lives for the whole file
let appA; // original UI — record + act passes
let appB; // variant "b" UI — heal pass; its port becomes the dead URL later
let appC; // original UI again — reject path + gate-failure case
let tmpRoot;
let suiteDir; // temp copy of the example suite (no baselines)
let runsRoot;
let healedPick; // { id, runDir, caseFile } chosen from the heal pass

const children = new Set();

before(async () => {
  mock = await startMock();
  appA = await startApp();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-selftest-"));
  suiteDir = path.join(tmpRoot, "suite");
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  // Copy the example suite EXCLUDING committed baselines and any stray healed
  // candidates — the repo's instrument state must stay untouched.
  fs.cpSync(SUITE_SRC, suiteDir, {
    recursive: true,
    filter: (src) => {
      // The viewer self-test (tests/viewer) brings its own compose-managed
      // environment — this e2e's subject is the todo suite only.
      if (src === path.join(SUITE_SRC, "viewer")) return false;
      const base = path.basename(src);
      return !base.includes(".baseline.") && !base.includes(".healed.");
    },
  });
  fs.chmodSync(path.join(suiteDir, "seed", "reset.sh"), 0o755); // init must stay executable
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const server of [appA, appB, appC, mock]) {
    if (server) await server.close().catch(() => {});
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- helpers ----------

function childEnv() {
  const env = { ...process.env };
  delete env.PLAYTEST_LLM_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PLAYTEST_LLM_CACHE; // opt-in caching off for offline tests — keeps the wire bytes golden
  delete env.PLAYTEST_BROWSER_CHANNEL; // measured runs must use pinned chromium
  delete env.TODO_APP_VARIANT; // fixtures get their variant as an explicit option
  env.PLAYTEST_LLM_BASE_URL = mock.url;
  return env;
}

/** Spawn `node src/harness/cli.js <args>`; resolves with { code, stdout, stderr }. */
function runCli(args, { timeoutMs = CHILD_TIMEOUT_MS } = {}) {
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
      if (timedOut) {
        reject(new Error(`playtest ${args.join(" ")} hung past ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

const dump = (res) => `\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`;

/** The one JSON object --json prints on stdout. */
function parseRunJson(res) {
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(line, `expected a JSON object on stdout${dump(res)}`);
  return JSON.parse(line);
}

const isNumberOrNull = (v) => v === null || typeof v === "number";

/** Presence + types of every load-bearing --json field (not exact values). */
function assertRunJsonShape(out) {
  assert.equal(typeof out.run_id, "string");
  assert.equal(typeof out.runs_root, "string");
  assert.equal(typeof out.exit_code, "number");
  assert.ok(Array.isArray(out.cases), "cases must be an array");
  for (const c of out.cases) {
    assert.equal(typeof c.id, "string", `case id: ${JSON.stringify(c)}`);
    assert.ok(["pass", "fail", "infra"].includes(c.status), `status: ${c.status}`);
    assert.ok([null, "record", "act", "heal"].includes(c.mode), `mode: ${c.mode}`);
    assert.equal(typeof c.healed, "boolean", "healed");
    assert.equal(typeof c.changed, "boolean", "changed");
    assert.ok(c.run_dir === null || typeof c.run_dir === "string", "run_dir");
    for (const k of ["duration_ms", "steps", "cost_usd", "score", "duration_delta_ms", "score_delta"]) {
      assert.ok(isNumberOrNull(c[k]), `${k} must be number|null, got ${JSON.stringify(c[k])}`);
    }
    assert.ok(c.status_streak === null || typeof c.status_streak === "string", "status_streak");
    assert.ok(Array.isArray(c.gate_failures), "gate_failures must be an array");
    for (const g of c.gate_failures) {
      assert.equal(typeof g.spec, "string", "gate_failures[].spec");
      assert.equal(typeof g.detail, "string", "gate_failures[].detail");
    }
  }
}

// Cases live under <suite>/stories/; the stories/ segment is dropped from the
// id (config.js), so reinsert it to find the file on disk.
const caseFileFor = (id) => path.join(suiteDir, path.dirname(id), "stories", `${path.basename(id)}.yaml`);
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// Baselines mirror the case under <suite>/results/ (trajectory.js baselinePaths):
// <suite>/stories/foo.yaml -> <suite>/results/foo.baseline.*
function candidatePaths(caseFile) {
  const base = caseFile
    .replace(`${path.sep}stories${path.sep}`, `${path.sep}results${path.sep}`)
    .replace(/\.yaml$/, "");
  return {
    baseline: `${base}.baseline.jsonl`,
    baselineMeta: `${base}.baseline.json`,
    healed: `${base}.healed.jsonl`,
    healedMeta: `${base}.healed.json`,
  };
}

const CASE_IDS = ["todos/add-todo", "todos/clear-completed", "todos/complete-todo"];

// ---------- the sequence (top-level tests run in order; later ones depend on
// state the earlier ones left behind) ----------

test("pass 1: first run records and blesses a baseline for every case (exit 0)", async () => {
  const res = await runCli(["run", suiteDir, "--json", "--plain", "--base-url", appA.url, "--runs-root", runsRoot]);
  assert.equal(res.code, 0, `record pass should exit 0${dump(res)}`);
  const out = parseRunJson(res);
  assertRunJsonShape(out);
  assert.equal(out.exit_code, 0);
  assert.deepEqual(out.cases.map((c) => c.id).sort(), CASE_IDS);
  for (const c of out.cases) {
    assert.equal(c.status, "pass", `case ${c.id} should pass`);
    assert.equal(c.mode, "record", `case ${c.id} should record`);
  }
  for (const id of CASE_IDS) {
    const p = candidatePaths(caseFileFor(id));
    assert.ok(fs.existsSync(p.baseline), `expected blessed baseline ${p.baseline}`);
    assert.ok(fs.existsSync(p.baselineMeta), `expected baseline meta ${p.baselineMeta}`);
  }
});

// NOTE: the original self-test spec said "zero requests hit the mock" on the act pass,
// but docs/playtest-design.md (the stable input, §"Run modes" and §"Cost")
// is explicit that an `assert:` success criterion "still makes one model check
// at the gate" even on acted runs — and runner.js/gate.js implement exactly
// that. The example suite has one assert per case, so the designed contract
// is: zero actor ("step") calls, zero grader ("grade") calls, one "verdict"
// call per assert criterion. That is what this test freezes.
test("pass 2: second run acts every case — no actor/grader calls, one verdict per assert gate (exit 0)", async () => {
  // one `- assert:` line per copied case file
  const expectedVerdicts = CASE_IDS
    .map((id) => fs.readFileSync(caseFileFor(id), "utf8"))
    .reduce((n, yaml) => n + (yaml.match(/^\s*-\s*assert:/gm) ?? []).length, 0);
  assert.ok(expectedVerdicts > 0, "the example suite is expected to carry assert criteria");

  const before = {
    total: mock.requestCount(),
    step: mock.requestCount("step"),
    grade: mock.requestCount("grade"),
    verdict: mock.requestCount("verdict"),
  };
  const res = await runCli(["run", suiteDir, "--json", "--plain", "--base-url", appA.url, "--runs-root", runsRoot]);
  assert.equal(mock.requestCount("step") - before.step, 0, "act pass must make zero actor model calls");
  assert.equal(mock.requestCount("grade") - before.grade, 0, "act pass must never grade");
  assert.equal(
    mock.requestCount("verdict") - before.verdict,
    expectedVerdicts,
    "act pass makes exactly one verdict call per assert: gate criterion",
  );
  assert.equal(
    mock.requestCount() - before.total,
    expectedVerdicts,
    "act pass must make no model calls beyond the assert gate checks",
  );
  assert.equal(res.code, 0, `act pass should exit 0${dump(res)}`);
  const out = parseRunJson(res);
  assertRunJsonShape(out);
  assert.equal(out.exit_code, 0);
  for (const c of out.cases) {
    assert.equal(c.status, "pass", `case ${c.id} should pass`);
    assert.equal(c.mode, "act", `case ${c.id} should act`);
    assert.equal(c.healed, false);
    assert.equal(c.changed, false);
  }
});

// CONTRACTS §12: NEXT-RUN says what the next run will do in plain verbs —
// check/record; the internal mode name "act" never leaks.
test("list --json next_run says check (baseline exists) / record", async () => {
  const listed = await runCli(["list", suiteDir, "--json"]);
  assert.equal(listed.code, 0, `list should exit 0${dump(listed)}`);
  const entries = JSON.parse(listed.stdout);
  assert.deepEqual(entries.map((e) => e.id).sort(), CASE_IDS);
  for (const e of entries) assert.equal(e.next_run, "check", `baselined case ${e.id}`);

  const fresh = path.join(tmpRoot, "list-fresh-suite");
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, "playtest.yaml"), "app:\n  base_url: http://localhost:9\n");
  fs.writeFileSync(path.join(fresh, "unrecorded.yaml"), "story: |\n  Placeholder journey.\n");
  const unrecorded = await runCli(["list", fresh, "--json"]);
  assert.equal(unrecorded.code, 0, `list should exit 0${dump(unrecorded)}`);
  assert.deepEqual(JSON.parse(unrecorded.stdout).map((e) => e.next_run), ["record"]);
});

test("pass 3: UI variant forces a heal; --fail-on-changed promotes it to exit 1", async () => {
  appB = await startApp({ variant: "b" }); // start before closing appA so ports cannot collide
  await appA.close();
  const res = await runCli([
    "run", suiteDir, "--json", "--plain",
    "--base-url", appB.url, "--runs-root", runsRoot, "--fail-on-changed",
  ]);
  assert.equal(res.code, 1, `changed journeys + --fail-on-changed should exit 1${dump(res)}`);
  const out = parseRunJson(res);
  assertRunJsonShape(out);
  assert.equal(out.exit_code, 1);
  const healedCases = out.cases.filter((c) => c.healed && c.changed);
  assert.ok(healedCases.length >= 1, `expected at least one healed+changed case${dump(res)}`);
  for (const c of healedCases) {
    assert.equal(c.status, "pass", `healed case ${c.id} should pass`);
    assert.equal(c.mode, "heal", `healed case ${c.id} should report mode heal`);
    const p = candidatePaths(caseFileFor(c.id));
    assert.ok(fs.existsSync(p.healed), `expected candidate ${p.healed}`);
    assert.ok(fs.existsSync(p.healedMeta), `expected candidate meta ${p.healedMeta}`);
  }
  const pick = healedCases.find((c) => c.id === "todos/add-todo") ?? healedCases[0];
  healedPick = { id: pick.id, runDir: pick.run_dir, caseFile: caseFileFor(pick.id) };
});

test("accept promotes the healed candidate to the saved path", async () => {
  assert.ok(healedPick, "heal pass must have produced a candidate");
  const p = candidatePaths(healedPick.caseFile);
  const baselineBefore = sha256(p.baseline);
  const res = await runCli(["accept", healedPick.runDir]);
  assert.equal(res.code, 0, `accept should exit 0${dump(res)}`);
  assert.match(res.stdout, /accepted/);
  assert.notEqual(sha256(p.baseline), baselineBefore, "accept must rewrite the baseline trajectory");
  assert.ok(!fs.existsSync(p.healed), "accept must remove the candidate trajectory");
  assert.ok(!fs.existsSync(p.healedMeta), "accept must remove the candidate meta");
});

test("reject dismisses a new candidate and leaves the baseline untouched", async () => {
  appC = await startApp(); // original UI: the variant-b baseline's locator now misses
  await appB.close();
  const p = candidatePaths(healedPick.caseFile);
  const baselineBefore = sha256(p.baseline);

  const res = await runCli([
    "run", healedPick.caseFile, "--json", "--plain",
    "--base-url", appC.url, "--runs-root", runsRoot,
  ]);
  assert.equal(res.code, 0, `heal-without-gate should exit 0${dump(res)}`);
  const out = parseRunJson(res);
  assertRunJsonShape(out);
  const c = out.cases.find((x) => x.healed && x.changed);
  assert.ok(c, `expected the run to heal and leave a candidate${dump(res)}`);
  assert.ok(fs.existsSync(p.healed), `expected candidate ${p.healed}`);

  const rej = await runCli(["reject", c.run_dir]);
  assert.equal(rej.code, 0, `reject should exit 0${dump(rej)}`);
  assert.match(rej.stdout, /rejected/);
  assert.ok(!fs.existsSync(p.healed), "reject must remove the candidate trajectory");
  assert.ok(!fs.existsSync(p.healedMeta), "reject must remove the candidate meta");
  assert.equal(sha256(p.baseline), baselineBefore, "reject must not touch the baseline");
});

test("a dead base-url is an infra failure (exit 2)", async () => {
  // appB is closed; its old ephemeral port is dead (appC was started before
  // the close, so it cannot have reused it).
  const res = await runCli([
    "run", healedPick.caseFile, "--json", "--plain",
    "--base-url", appB.url, "--runs-root", runsRoot,
  ]);
  assert.equal(res.code, 2, `dead base-url should exit 2${dump(res)}`);
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (line) {
    const out = JSON.parse(line);
    assertRunJsonShape(out);
    assert.equal(out.exit_code, 2);
    const infraCase = out.cases.find((c) => c.status === "infra");
    assert.ok(infraCase, "expected an infra case");
    // The manifest is the durable record of the infra cause: the fix-loop
    // skill (and the viewer) read result.error from it.
    const manifest = JSON.parse(fs.readFileSync(path.join(infraCase.run_dir, "manifest.json"), "utf8"));
    assert.equal(typeof manifest.result.error, "string", "infra manifest must carry result.error");
    assert.ok(manifest.result.error.length > 0, "result.error must name the cause");
  }
});

// "playtest" is a reserved case name: <slug>.yaml would BE the defaults file
// (CONTRACTS §12 reserves it alongside "suite"/"persona").
test('new rejects a case named "playtest" with a clean exit 2', async () => {
  const dir = path.join(tmpRoot, "reserved-name");
  const res = await runCli(["new", "playtest", dir]);
  assert.equal(res.code, 2, `reserved name should exit 2${dump(res)}`);
  assert.match(res.stderr, /collides with the playtest\.yaml defaults file/);
  assert.ok(!fs.existsSync(dir), "nothing may be scaffolded for a reserved name");
});

test("new scaffolds the case under the suite's stories/ dir, defaults at the suite root", async () => {
  const dir = path.join(tmpRoot, "scaffold-new");
  const res = await runCli(["new", "checkout-flow", dir]);
  assert.equal(res.code, 0, `new should exit 0${dump(res)}`);
  assert.ok(fs.existsSync(path.join(dir, "stories", "checkout-flow.yaml")), "case lands in stories/");
  assert.ok(!fs.existsSync(path.join(dir, "checkout-flow.yaml")), "case is not written at the suite root");
  assert.ok(fs.existsSync(path.join(dir, "playtest.yaml")), "defaults scaffolded at the suite root, not in stories/");
});

test("a failing success gate is exit 1 with gate_failures in --json", async () => {
  const gateSuite = path.join(tmpRoot, "gate-fail-suite");
  fs.mkdirSync(gateSuite, { recursive: true });
  fs.writeFileSync(path.join(gateSuite, "playtest.yaml"), `app:\n  base_url: ${appC.url}\n`);
  fs.writeFileSync(
    path.join(gateSuite, "broken-gate.yaml"),
    [
      "story: |",
      '  Add a todo called "doomed errand" so it shows up in your list.',
      "success:",
      '  - element_exists: "[data-testid=does-not-exist]"',
      "",
    ].join("\n"),
  );
  const res = await runCli(["run", gateSuite, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(res.code, 1, `gate failure should exit 1${dump(res)}`);
  const out = parseRunJson(res);
  assertRunJsonShape(out);
  assert.equal(out.exit_code, 1);
  assert.equal(out.cases.length, 1);
  assert.equal(out.cases[0].status, "fail");
  assert.ok(out.cases[0].gate_failures.length >= 1, "expected gate_failures to be non-empty");
  assert.ok(
    out.cases[0].gate_failures.some((g) => g.spec.includes("does-not-exist")),
    `expected the element_exists failure in ${JSON.stringify(out.cases[0].gate_failures)}`,
  );
});
