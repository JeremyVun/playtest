// Offline contract test for the view-server's JSON routes and file serving
// (VERSION_1.1 item 5, contract half). Generates one record run, one
// variant-flip heal run, and one discovery (explore) run with the real CLI
// against the bundled todo app + mock LLM, then freezes the shapes of
// /runs.json, /changed.json, /history.json?case= and /run/<path> — presence
// and types of the load-bearing fields, the same discipline the harness
// self-test applies to --json. This is the contract a standalone viewer or a
// future backend data source must keep (docs/CONTRACTS.md §13).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { start as startApp } from "../src/todo-app/server.js";
import { start as startMock } from "../src/harness/testing/mock-llm.js";
import { serveRun } from "../src/harness/view-server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "harness", "cli.js");
const CHILD_TIMEOUT_MS = 90_000;

let mock;
let appA; // original UI — record pass
let appB; // variant "b" UI — heal pass + discovery pass
let tmpRoot;
let runsRoot;
let healRunDir; // root-relative path of the healed run (from --json run_dir)
let server; // runs-root server, lives for the whole file
let base; // http://127.0.0.1:<port>

const children = new Set();

const REPORT_QUESTIONS = [
  "Where did the user look first?",
  "At which screen would this user have expected the capability?",
];

before(async () => {
  mock = await startMock();
  appA = await startApp();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-viewsrv-"));
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });

  const suiteDir = path.join(tmpRoot, "suite");
  fs.mkdirSync(suiteDir, { recursive: true });
  fs.writeFileSync(path.join(suiteDir, "playtest.yaml"), `app:\n  base_url: ${appA.url}\n`);
  // Quoted directive: the rule-based mock actor records it (type, click, done).
  fs.writeFileSync(path.join(suiteDir, "add-todo.yaml"), 'story: |\n  Add "buy milk" to the list.\n');

  const studyDir = path.join(tmpRoot, "study");
  fs.mkdirSync(studyDir, { recursive: true });
  fs.writeFileSync(
    path.join(studyDir, "add-milk.yaml"),
    ["story: |", '  Add "buy milk" to the list.', "report:", ...REPORT_QUESTIONS.map((q) => `  - ${q}`), ""].join("\n"),
  );

  // record (appA) -> heal (appB, variant b renames the Add control) -> explore
  const rec = await runCli(["run", suiteDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(rec.code, 0, `record pass should exit 0${dump(rec)}`);

  appB = await startApp({ variant: "b" }); // start before closing appA so ports cannot collide
  await appA.close();
  const heal = await runCli(["run", suiteDir, "--json", "--plain", "--base-url", appB.url, "--runs-root", runsRoot]);
  assert.equal(heal.code, 0, `heal pass should exit 0${dump(heal)}`);
  const healed = parseRunJson(heal).cases.find((c) => c.healed && c.changed);
  assert.ok(healed, `expected a healed+changed case${dump(heal)}`);
  healRunDir = path.relative(runsRoot, healed.run_dir).split(path.sep).join("/");

  fs.writeFileSync(path.join(studyDir, "playtest.yaml"), `mode: discovery\napp:\n  base_url: ${appB.url}\n`);
  const study = await runCli(["run", studyDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(study.code, 0, `discovery pass should exit 0${dump(study)}`);

  server = await serveRun(runsRoot, { port: 0, open: false });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  server?.close();
  for (const s of [appA, appB, mock]) {
    if (s) await s.close().catch(() => {});
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
  delete env.PLAYTEST_BROWSER_CHANNEL; // measured runs must use pinned chromium
  delete env.TODO_APP_VARIANT; // fixtures get their variant as an explicit option
  env.PLAYTEST_LLM_BASE_URL = mock.url;
  return env;
}

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

function parseRunJson(res) {
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(line, `expected a JSON object on stdout${dump(res)}`);
  return JSON.parse(line);
}

const isNumberOrNull = (v) => v === null || typeof v === "number";

async function getJson(url) {
  const r = await fetch(url);
  assert.equal(r.status, 200, `${url} should be 200`);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  return r.json();
}

// ---------- /runs.json ----------

test("/runs.json: entry shape, all three run kinds, newest first", async () => {
  const runs = await getJson(`${base}/runs.json`);
  assert.ok(Array.isArray(runs) && runs.length === 3, `expected 3 runs, got ${runs.length}`);
  for (const r of runs) {
    assert.equal(typeof r.run_id, "string", "run_id");
    assert.equal(typeof r.case_id, "string", "case_id");
    assert.equal(typeof r.path, "string", "path");
    assert.ok(["pass", "fail", "infra", "explored"].includes(r.status), `status: ${r.status}`);
    assert.ok(["record", "act", "heal", "explore"].includes(r.mode), `mode: ${r.mode}`);
    assert.equal(typeof r.healed, "boolean", "healed");
    assert.equal(typeof r.started_at, "string", "started_at");
    assert.ok(isNumberOrNull(r.duration_ms), "duration_ms");
  }
  assert.deepEqual(runs.map((r) => r.mode).sort(), ["explore", "heal", "record"]);
  const starts = runs.map((r) => r.started_at);
  assert.deepEqual(starts, [...starts].sort().reverse(), "newest first by started_at");
  // every advertised path must serve its manifest
  for (const r of runs) {
    const m = await getJson(`${base}/run/${r.path}/manifest.json`);
    assert.equal(m.run_id, r.run_id, `path ${r.path} serves its own manifest`);
  }
});

// ---------- /changed.json ----------

test("/changed.json: the healed pass is listed as a pending changed journey", async () => {
  const entries = await getJson(`${base}/changed.json`);
  assert.ok(Array.isArray(entries) && entries.length === 1, `expected 1 changed entry, got ${entries.length}`);
  const e = entries[0];
  assert.equal(typeof e.case_id, "string", "case_id");
  assert.equal(typeof e.run_id, "string", "run_id");
  assert.equal(typeof e.started_at, "string", "started_at");
  assert.ok(isNumberOrNull(e.score), "score");
  assert.equal(e.path, healRunDir, "path is the healed run, root-relative");
  assert.equal(typeof e.run_dir_rel, "string", "run_dir_rel");
  assert.equal(e.pending, true, "un-accepted heal candidate is pending");
});

// ---------- /history.json ----------

test("/history.json?case=: per-case history shape, oldest first; [] without a case", async () => {
  const caseId = (await getJson(`${base}/changed.json`))[0].case_id;
  const hist = await getJson(`${base}/history.json?case=${encodeURIComponent(caseId)}`);
  assert.ok(Array.isArray(hist) && hist.length === 2, `record + heal for ${caseId}, got ${hist.length}`);
  for (const h of hist) {
    assert.equal(typeof h.run_id, "string", "run_id");
    assert.equal(typeof h.started_at, "string", "started_at");
    assert.ok(["pass", "fail", "infra", "explored"].includes(h.status), `status: ${h.status}`);
    assert.ok(["record", "act", "heal", "explore"].includes(h.mode), `mode: ${h.mode}`);
    assert.equal(typeof h.healed, "boolean", "healed");
    for (const k of ["duration_ms", "steps", "score", "lcp_ms", "cost_usd"]) {
      assert.ok(isNumberOrNull(h[k]), `${k} must be number|null, got ${JSON.stringify(h[k])}`);
    }
    assert.equal(typeof h.path, "string", "path");
  }
  const starts = hist.map((h) => h.started_at);
  assert.deepEqual(starts, [...starts].sort(), "oldest first by started_at");

  assert.deepEqual(await getJson(`${base}/history.json`), [], "no case param -> []");
});

// ---------- /run/<path> file serving ----------

test("/run/<path>: MIME types, missing files, traversal, method guard", async () => {
  const png = await fetch(`${base}/run/${healRunDir}/steps/001.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");

  const traj = await fetch(`${base}/run/${healRunDir}/trajectory.jsonl`);
  assert.equal(traj.status, 200);

  assert.equal((await fetch(`${base}/run/${healRunDir}/nope.json`)).status, 404, "missing file");
  assert.equal((await fetch(`${base}/run/${encodeURIComponent("../")}suite/add-todo.yaml`)).status, 404, "traversal stays inside the root");
  assert.equal((await fetch(`${base}/runs.json`, { method: "POST" })).status, 405, "GET/HEAD only");
});

// ---------- single-run mode ----------

test("single-run mode: /runs.json 404s, /changed.json still resolves the run", async () => {
  const single = await serveRun(path.join(runsRoot, healRunDir), { port: 0, open: false });
  try {
    const sbase = `http://127.0.0.1:${single.address().port}`;
    assert.equal((await fetch(`${sbase}/runs.json`)).status, 404, "no picker data in single-run mode");
    const entries = await getJson(`${sbase}/changed.json`);
    assert.ok(Array.isArray(entries) && entries.length === 1, "the healed run's changed entry");
    assert.equal(entries[0].pending, true);
    const m = await getJson(`${sbase}/run/manifest.json`);
    assert.equal(typeof m.run_id, "string", "single-run /run/ serves the run dir itself");
  } finally {
    single.close();
  }
});
