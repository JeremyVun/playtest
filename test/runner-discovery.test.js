// Offline end-to-end self-test of discovery mode (docs/discovery-mode-plan.md
// §4). A `mode: discovery` suite always explores fresh: no baseline is read or
// written (even when a stray one sits next to the case), the deterministic
// gate never runs, and done/give_up/max_steps/timeout all land the terminal
// status "explored" (exit 0). Grading still runs; report questions come back
// answered in grade.json. Mirrors test/harness.test.js conventions: bundled
// todo app + rule-based mock LLM in-process on ephemeral ports, the real CLI
// driven as a child process. Nothing outside this file's temp dir is touched.
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
const CHILD_TIMEOUT_MS = 90_000;

let mock; // mock LLM, lives for the whole file
let app; // bundled todo app
let tmpRoot;
let runsRoot;
let studyDir; // discovery suite: a give_up case + a done case with report questions
let journeyDir; // plain journey suite run in the same selection
let strayDir; // discovery suite with a stray *.baseline.jsonl next to the case
let exploredRunDir; // an explored run dir kept for the accept/--failed tests

const children = new Set();

const REPORT_QUESTIONS = [
  "Where did the user look first, and what did they try before giving up?",
  "At which screen would this user have expected an export affordance?",
];

before(async () => {
  mock = await startMock();
  app = await startApp();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-discovery-"));
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });

  studyDir = path.join(tmpRoot, "study");
  fs.mkdirSync(studyDir, { recursive: true });
  fs.writeFileSync(path.join(studyDir, "playtest.yaml"), `mode: discovery\napp:\n  base_url: ${app.url}\n`);
  // No quoted directive: the mock actor gives up at step 1 (mock-llm decide()).
  fs.writeFileSync(
    path.join(studyDir, "export-data.yaml"),
    "story: |\n  Find a way to export your data out of this app, however seems natural.\n",
  );
  // Quoted directive: the mock actor finishes ("done"); the report questions
  // ride into the grader prompt and back out as grade.json report answers.
  fs.writeFileSync(
    path.join(studyDir, "add-milk.yaml"),
    [
      "story: |",
      '  Add "buy milk" to the list.',
      "report:",
      ...REPORT_QUESTIONS.map((q) => `  - ${q}`),
      "",
    ].join("\n"),
  );

  journeyDir = path.join(tmpRoot, "journey");
  fs.mkdirSync(journeyDir, { recursive: true });
  fs.writeFileSync(path.join(journeyDir, "playtest.yaml"), `app:\n  base_url: ${app.url}\n`);
  fs.writeFileSync(path.join(journeyDir, "sanity.yaml"), 'story: |\n  Add "sanity item" to the list.\n');

  strayDir = path.join(tmpRoot, "stray");
  fs.mkdirSync(strayDir, { recursive: true });
  fs.writeFileSync(path.join(strayDir, "playtest.yaml"), `mode: discovery\napp:\n  base_url: ${app.url}\n`);
  fs.writeFileSync(path.join(strayDir, "wander.yaml"), "story: |\n  Have a look around and see what this app is for.\n");
  // Unparseable on purpose: any attempt to read it would surface as infra via
  // the corrupt-baseline ladder, so "explored" proves it was never opened.
  fs.writeFileSync(path.join(strayDir, "wander.baseline.jsonl"), "not json\n");
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const server of [app, mock]) {
    if (server) await server.close().catch(() => {});
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- helpers (copied from test/harness.test.js; not shared on purpose:
// test files run as separate concurrent processes) ----------

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

/**
 * Clone of harness.test.js assertRunJsonShape widened to the discovery
 * vocabulary ("explored" status, "explore" mode). The journey original stays
 * frozen over there — do not merge the two.
 */
function assertRunJsonShape(out) {
  assert.equal(typeof out.run_id, "string");
  assert.equal(typeof out.runs_root, "string");
  assert.equal(typeof out.exit_code, "number");
  assert.ok(Array.isArray(out.cases), "cases must be an array");
  for (const c of out.cases) {
    assert.equal(typeof c.id, "string", `case id: ${JSON.stringify(c)}`);
    assert.ok(["pass", "fail", "infra", "explored"].includes(c.status), `status: ${c.status}`);
    assert.ok([null, "record", "act", "heal", "explore"].includes(c.mode), `mode: ${c.mode}`);
    assert.equal(typeof c.healed, "boolean", "healed");
    assert.equal(typeof c.changed, "boolean", "changed");
    assert.ok(c.run_dir === null || typeof c.run_dir === "string", "run_dir");
    for (const k of ["duration_ms", "steps", "cost_usd", "score", "duration_delta_ms", "score_delta"]) {
      assert.ok(isNumberOrNull(c[k]), `${k} must be number|null, got ${JSON.stringify(c[k])}`);
    }
    assert.ok(c.status_streak === null || typeof c.status_streak === "string", "status_streak");
    assert.ok(Array.isArray(c.gate_failures), "gate_failures must be an array");
  }
}

// These suites keep cases at the suite root (no stories/ dir), so baselines
// land in the suite's results/ dir (trajectory.js baselinePaths).
function candidatePaths(caseFile) {
  const base = path.join(path.dirname(caseFile), "results", path.basename(caseFile, ".yaml"));
  return {
    baseline: `${base}.baseline.jsonl`,
    baselineMeta: `${base}.baseline.json`,
    healed: `${base}.healed.jsonl`,
    healedMeta: `${base}.healed.json`,
  };
}

const readManifest = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
const readGrade = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, "grade.json"), "utf8"));

// ---------- the sequence (top-level tests run in order; later ones depend on
// state the earlier ones left behind) ----------

test("a study + a journey in one run: discovery explores (exit 0), gate skipped, nothing saved; the journey is untouched", async () => {
  const junitPath = path.join(tmpRoot, "junit.xml");
  const pre = { grade: mock.requestCount("grade"), verdict: mock.requestCount("verdict") };
  const res = await runCli([
    "run", studyDir, journeyDir, "--json", "--plain", "--runs-root", runsRoot, "--junit", junitPath,
  ]);
  assert.equal(res.code, 0, `explored runs must contribute exit 0${dump(res)}`);
  const out = parseRunJson(res);
  assertRunJsonShape(out);
  assert.equal(out.exit_code, 0);
  const byId = new Map(out.cases.map((c) => [c.id, c]));
  assert.deepEqual([...byId.keys()].sort(), ["add-milk", "export-data", "sanity"]);

  // discovery cases: explored, explore strategy, no gate, nothing saved
  for (const id of ["export-data", "add-milk"]) {
    const c = byId.get(id);
    assert.equal(c.status, "explored", `case ${id}${dump(res)}`);
    assert.equal(c.mode, "explore", `case ${id} runs the explore strategy`);
    assert.equal(c.changed, false, "explored runs are never pending changed journeys");
    assert.deepEqual(c.gate_failures, [], `no gate failures possible for ${id}`);
    const m = readManifest(c.run_dir);
    assert.equal(m.mode, "explore", "manifest.mode is the run strategy");
    assert.equal(m.case.mode, "discovery", "manifest.case.mode is the case kind");
    assert.ok(Array.isArray(m.case.report), "manifest.case carries report for re-grading");
    assert.equal(m.result.status, "explored");
    assert.equal(m.result.gate, null, "the deterministic gate must never run in discovery");
    assert.equal(m.healed, false);
    assert.equal(m.baseline, null);
    assert.equal(m.artifacts.baseline_copy, null);
    assert.equal(m.artifacts.grade, "grade.json", "discovery runs still grade");
    assert.ok(fs.existsSync(path.join(c.run_dir, "grade.json")), `grade.json written for ${id}`);
    const p = candidatePaths(path.join(studyDir, `${id}.yaml`));
    for (const f of Object.values(p)) assert.ok(!fs.existsSync(f), `discovery must not write ${f}`);
  }

  // end_reason mapping: give_up and done both land "explored"
  assert.equal(readManifest(byId.get("export-data").run_dir).result.end_reason, "give_up");
  assert.equal(readManifest(byId.get("add-milk").run_dir).result.end_reason, "done");

  // Pin the exact give_up reason: if the "## Your task" marker stopped being
  // last in the actor system prompt, EVERY mock run would give_up with this
  // same reason — the add-milk "done" assertion above catches that, and this
  // pin documents the deliberate give_up.
  const lastStep = fs
    .readFileSync(path.join(byId.get("export-data").run_dir, "trajectory.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.equal(lastStep.agent.action.type, "give_up");
  assert.equal(lastStep.agent.action.reason, "no recognizable directive (add/complete/delete/clear/filter) in the story");

  // grading ran for all three (journey record + 2 explores); no gate verdicts
  assert.equal(mock.requestCount("grade") - pre.grade, 3, "record and explore runs all grade");
  assert.equal(mock.requestCount("verdict") - pre.verdict, 0, "no assert: criteria in this selection");

  // report answers land in grade.json, one per question, verbatim, in order
  const grade = readGrade(byId.get("add-milk").run_dir);
  assert.ok(Array.isArray(grade.report), `grade.json must carry report answers, got ${JSON.stringify(grade)}`);
  assert.deepEqual(grade.report.map((r) => r.question), REPORT_QUESTIONS);
  for (const entry of grade.report) {
    assert.equal(typeof entry.answer, "string");
    assert.ok(entry.answer.length > 0, "answers must be non-empty");
    assert.ok(entry.evidence_steps.every((n) => Number.isInteger(n)), "evidence_steps are step numbers");
  }
  // a case without report questions keeps the journey grade shape
  assert.equal(readGrade(byId.get("export-data").run_dir).report, undefined);

  // the journey case in the same selection behaves exactly as before
  const j = byId.get("sanity");
  assert.equal(j.status, "pass", `journey case${dump(res)}`);
  assert.equal(j.mode, "record");
  const jm = readManifest(j.run_dir);
  assert.ok(jm.result.gate, "journey runs still gate");
  assert.equal(jm.result.gate.pass, true);
  assert.ok(fs.existsSync(candidatePaths(path.join(journeyDir, "sanity.yaml")).baseline),
    "journey record still blesses a baseline");

  // JUnit: explored runs are passing testcases — self-closing, counted in tests only
  const junit = fs.readFileSync(junitPath, "utf8");
  assert.match(junit, /<testsuites tests="3" failures="0" errors="0"/);
  assert.match(junit, /<testcase classname="\(root\)" name="export-data" time="[\d.]+"\/>/);
  assert.match(junit, /<testcase classname="\(root\)" name="add-milk" time="[\d.]+"\/>/);
});

test("a stray baseline next to a discovery case neither acts nor heals: still a fresh explore", async () => {
  const stray = path.join(strayDir, "wander.baseline.jsonl");
  const strayBytes = fs.readFileSync(stray);

  // list decides NEXT-RUN from the case mode BEFORE any baseline read — the
  // stray (corrupt) file would otherwise flip it to "check" or kill list.
  const listed = await runCli(["list", strayDir, "--json"]);
  assert.equal(listed.code, 0, dump(listed));
  const entries = JSON.parse(listed.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].next_run, "explore");
  const table = await runCli(["list", strayDir]);
  assert.equal(table.code, 0, dump(table));
  assert.match(table.stdout, /wander\s.*\bexplore\b/, `table NEXT-RUN says explore${dump(table)}`);

  const res = await runCli(["run", strayDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(res.code, 0, `an explored-only run exits 0${dump(res)}`);
  const out = parseRunJson(res);
  assertRunJsonShape(out);
  assert.equal(out.exit_code, 0);
  assert.equal(out.cases.length, 1);
  const c = out.cases[0];
  assert.equal(c.status, "explored", `stray baseline must not change the strategy${dump(res)}`);
  assert.equal(c.mode, "explore");
  const m = readManifest(c.run_dir);
  assert.equal(m.result.end_reason, "give_up"); // no quoted directive in the story
  assert.equal(m.baseline, null, "the stray baseline must not be referenced");
  assert.ok(!fs.existsSync(path.join(c.run_dir, "baseline.jsonl")), "no baseline copy in the run dir");
  assert.deepEqual(fs.readFileSync(stray), strayBytes, "the stray file is byte-identical after the run");
  assert.ok(!fs.existsSync(path.join(strayDir, "wander.healed.jsonl")), "no healed candidate");
  exploredRunDir = c.run_dir;
});

test("explored runs carry no trend: a repeat explore reports null deltas and no streak", async () => {
  const res = await runCli(["run", strayDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(res.code, 0, dump(res));
  const c = parseRunJson(res).cases[0];
  assert.equal(c.status, "explored");
  assert.equal(c.duration_delta_ms, null, "explored runs are excluded from trends");
  assert.equal(c.score_delta, null);
  assert.equal(c.status_streak, null);
});

test("explored runs cannot be accepted and are not failures", async () => {
  assert.ok(exploredRunDir, "earlier explore must have produced a run dir");
  const acc = await runCli(["accept", exploredRunDir]);
  assert.equal(acc.code, 2, `accept must refuse explored runs${dump(acc)}`);
  assert.match(acc.stderr, /refusing to accept .*"explored"/);

  const failed = await runCli(["view", runsRoot, "--json", "--failed"]);
  assert.equal(failed.code, 0, dump(failed));
  for (const e of JSON.parse(failed.stdout)) {
    assert.ok(e.status === "fail" || e.status === "infra", `--failed must exclude explored, got ${e.status}`);
  }

  const all = await runCli(["view", runsRoot, "--json"]);
  assert.equal(all.code, 0, dump(all));
  assert.ok(JSON.parse(all.stdout).some((e) => e.status === "explored"), "view --json lists explored runs");
});

test("mock-llm answers '## Report questions' grade prompts; plain grades keep the journey shape", async () => {
  const ask = async (userContent) => {
    const resp = await fetch(`${mock.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock",
        tool_choice: { type: "function", function: { name: "grade" } },
        messages: [
          { role: "system", content: "grader" },
          { role: "user", content: userContent },
        ],
      }),
    });
    const body = await resp.json();
    return JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);
  };

  // grader.js layout: numbered list under the heading, then an instruction
  // line, then the next ## section.
  const withQuestions = await ask([
    "## Story\n\nwhatever",
    "## Report questions",
    "",
    "1. Where did the user look first?",
    "2. What blocked them?",
    "",
    'Answer every question above in the grade\'s "report" array.',
    "## Final page snapshot\n\n(empty)",
  ].join("\n\n"));
  assert.deepEqual(withQuestions.report.map((r) => r.question), [
    "Where did the user look first?",
    "What blocked them?",
  ]);
  for (const r of withQuestions.report) {
    assert.equal(typeof r.answer, "string");
    assert.ok(r.evidence_steps.every((n) => Number.isInteger(n)));
  }

  const plain = await ask("## Story\n\nwhatever\n\n## Final page snapshot\n\n(empty)");
  assert.equal(plain.report, undefined, "journey grade shape unchanged");
});
