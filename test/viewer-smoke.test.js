// Offline UI smoke for the viewer in pinned chromium (VERSION_1.1 item 5, UI
// half): a recorded run, a healed run, and a discovery run must each render
// their talk-path panels with real content — film strip, step captions, the
// diff tab, the report answers — and log no page errors and no console
// errors beyond the viewer's deliberate optional-artifact probes. This is the
// regression suite for the demo-path polish and the proof that discovery
// renders end to end.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { start as startApp } from "../src/todo-app/server.js";
import { start as startMock } from "../src/harness/testing/mock-llm.js";
import { serveRun } from "../src/harness/view-server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "harness", "cli.js");
const CHILD_TIMEOUT_MS = 90_000;

let mock;
let appA;
let appB;
let tmpRoot;
let runsRoot;
let server;
let base;
let browser;
let runsByMode; // mode -> /runs.json entry

const children = new Set();

before(async () => {
  mock = await startMock();
  appA = await startApp();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-uismoke-"));
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });

  const suiteDir = path.join(tmpRoot, "suite");
  fs.mkdirSync(suiteDir, { recursive: true });
  fs.writeFileSync(path.join(suiteDir, "playtest.yaml"), `app:\n  base_url: ${appA.url}\n`);
  fs.writeFileSync(path.join(suiteDir, "add-todo.yaml"), 'story: |\n  Add "buy milk" to the list.\n');

  const rec = await runCli(["run", suiteDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(rec.code, 0, `record pass should exit 0${dump(rec)}`);

  appB = await startApp({ variant: "b" }); // start before closing appA so ports cannot collide
  await appA.close();
  const heal = await runCli(["run", suiteDir, "--json", "--plain", "--base-url", appB.url, "--runs-root", runsRoot]);
  assert.equal(heal.code, 0, `heal pass should exit 0${dump(heal)}`);

  const studyDir = path.join(tmpRoot, "study");
  fs.mkdirSync(studyDir, { recursive: true });
  fs.writeFileSync(path.join(studyDir, "playtest.yaml"), `mode: discovery\napp:\n  base_url: ${appB.url}\n`);
  fs.writeFileSync(
    path.join(studyDir, "add-milk.yaml"),
    ["story: |", '  Add "buy milk" to the list.', "report:", "  - Where did the user look first?", ""].join("\n"),
  );
  const study = await runCli(["run", studyDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(study.code, 0, `discovery pass should exit 0${dump(study)}`);

  server = await serveRun(runsRoot, { port: 0, open: false });
  base = `http://127.0.0.1:${server.address().port}`;
  const runs = await (await fetch(`${base}/runs.json`)).json();
  runsByMode = Object.fromEntries(runs.map((r) => [r.mode, r]));
  for (const mode of ["record", "heal", "explore"]) assert.ok(runsByMode[mode], `expected a ${mode} run`);

  browser = await chromium.launch();
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  await browser?.close().catch(() => {});
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

// The viewer deliberately probes optional artifacts and decides modes by
// 404 (boot's single-run probe, the clip vtt sidecar, ungraded/baseline-less
// runs). Those failed loads surface as console errors in chromium; anything
// else failing is a real regression.
const PROBE_404S = [/\/run\/manifest\.json$/, /\/runs\.json$/, /baseline\.jsonl$/, /grade\.json$/, /har\.json$/, /video\.vtt$/, /video\.webm$/];

/** Open a viewer page and collect non-probe console errors + page errors. */
async function open(query) {
  const page = await browser.newPage();
  const errors = [];
  const notFound = new Set();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("response", (r) => {
    if (r.status() === 404) notFound.add(r.url());
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const url = msg.location()?.url ?? "";
    if (PROBE_404S.some((re) => re.test(url)) && notFound.has(url)) return;
    errors.push(`console: ${msg.text()} (${url})`);
  });
  await page.goto(base + "/" + query);
  const failUnexpected404 = () => {
    const bad = [...notFound].filter((u) => !PROBE_404S.some((re) => re.test(u)));
    assert.deepEqual(bad, [], "only the deliberate optional-artifact probes may 404");
  };
  return { page, errors, failUnexpected404 };
}

const text = (page, sel) => page.locator(sel).innerText();

test("recorded run: film strip + step thought captions render", async () => {
  const { page, errors, failUnexpected404 } = await open(`?run=${runsByMode.record.path}`);
  await page.waitForSelector("#strip .cell");
  const cells = await page.locator("#strip .cell").count();
  assert.ok(cells >= 3, `film strip should show the recorded steps, got ${cells}`);

  await page.locator("#strip .cell").first().click();
  const firstThought = await text(page, "#cap-thought");
  assert.ok(firstThought.trim().length > 10, `step caption should carry the agent thought, got "${firstThought}"`);
  await page.locator("#strip .cell").last().click();
  const lastThought = await text(page, "#cap-thought");
  assert.notEqual(lastThought, firstThought, "captions must follow the selected step");
  assert.ok((await text(page, "#cap-meta")).toLowerCase().includes("step"), "step meta line renders");

  assert.deepEqual(errors, [], "no console/page errors on the recorded run");
  failUnexpected404();
  await page.close();
});

test("healed run: diff tab renders the action-track comparison", async () => {
  const { page, errors, failUnexpected404 } = await open(`?run=${runsByMode.heal.path}`);
  await page.waitForSelector("#strip .cell");
  const diffTab = page.locator("#tab-diff");
  assert.ok(await diffTab.isVisible(), "diff tab must be offered when a baseline exists");
  await diffTab.click();
  await page.waitForSelector("#pane-diff:not([hidden])");
  const dcells = await page.locator("#diff-body .dcell").count();
  assert.ok(dcells >= 2, `diff should render track cells, got ${dcells}`);
  const head = await text(page, "#diff-body .diff-head");
  assert.match(head, /same/, "diff head summarizes the comparison");

  assert.deepEqual(errors, [], "no console/page errors on the healed run");
  failUnexpected404();
  await page.close();
});

test("changed review list: the healed journey is pending with its accept command", async () => {
  const { page, errors } = await open("?filter=changed");
  await page.waitForSelector("#picker:not([hidden])");
  const body = await text(page, "#picker");
  assert.match(body, /playtest accept /, "accept command is displayed");
  assert.deepEqual(errors, [], "no console/page errors on the review list");
  await page.close();
});

test("discovery run: the report answers panel renders", async () => {
  const { page, errors, failUnexpected404 } = await open(`?run=${runsByMode.explore.path}`);
  await page.waitForSelector("#strip .cell");
  await page.locator('button.itab[data-itab="run"]').click();
  await page.waitForSelector(".report-entry");
  const q = await text(page, ".report-entry .report-q");
  const a = await text(page, ".report-entry .report-a");
  assert.match(q, /Where did the user look first/, "report question renders");
  assert.ok(a.trim().length > 0, "report answer must not be blank");

  assert.deepEqual(errors, [], "no console/page errors on the discovery run");
  failUnexpected404();
  await page.close();
});
