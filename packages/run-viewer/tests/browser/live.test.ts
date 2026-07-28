// The viewer's live mode, in a real browser against the real local host
// (docs/contracts/interfaces.md#live-runs). Run directories here grow the way a
// recording run writes them — artifacts, then the trajectory line that names
// them, with the engine's events beside both — so what the page observes is the
// protocol, not a mock of it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { serveRun } from "../../src/node/index.ts";

type LegacyTestValue = any; // SAFETY: run artifacts and page evaluations are dynamic

let tmpRoot: string;
let runsRoot: string;
let server: LegacyTestValue;
let base: string;
let browser: LegacyTestValue;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-live-ui-"));
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  server = await serveRun(runsRoot, { port: 0, open: false });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// The viewer probes optional artifacts and decides modes by 404 — including the
// live probe itself, whose absence must leave it exactly as it is today.
const PROBE_404S = [/grade\.json$/, /har\.json$/, /baseline\.jsonl$/, /video\.vtt$/, /video\.webm$/, /\/live\?/, /\/run\/manifest\.json$/, /\/runs\.json$/];

let seq = 0;

/** A run directory mid-recording: the placeholder manifest plus `case_start`. */
function openRun(label: string, { maxSteps = 20 }: LegacyTestValue = {}) {
  const runId = `2026-07-28T10${String(seq++).padStart(2, "0")}-l0${String(seq).padStart(2, "0")}`;
  const caseId = `todos/${label}`;
  const dir = path.join(runsRoot, runId, ...caseId.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  const run = {
    dir,
    runId,
    caseId,
    rel: [runId, ...caseId.split("/")].join("/"),
    manifest: {
      schema_version: 1,
      run_id: runId,
      case: { id: caseId, file: `${tmpRoot}/suite/${label}.yaml`, story: "Add milk to the list.", description: "Add one todo.", tags: [] },
      mode: "record",
      started_at: new Date().toISOString(),
      duration_ms: null,
      healed: false,
      pins: {},
      totals: { steps: 0 },
      // The placeholder's terminal-looking status, by design.
      result: { status: "interrupted", end_reason: null, error: null, gate: { pass: false, checks: [] } },
      artifacts: {},
    } as LegacyTestValue,
  };
  writeManifest(run, {});
  event(run, { type: "case_start", mode: "record", maxSteps, actorModel: "gpt5_4_mini", graderModel: "gpt5_5", runDir: dir });
  return run;
}

const writeManifest = (run: LegacyTestValue, patch: LegacyTestValue) =>
  fs.writeFileSync(path.join(run.dir, "manifest.json"), JSON.stringify({ ...run.manifest, ...patch }, null, 2) + "\n");

const event = (run: LegacyTestValue, payload: LegacyTestValue) =>
  fs.appendFileSync(path.join(run.dir, "events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), caseId: run.caseId, ...payload }) + "\n");

/** One landed step: the engine appends the envelope after its artifacts exist. */
function envelope(run: LegacyTestValue, step: number) {
  const env = {
    step,
    schema_version: 8,
    ts: Date.now(),
    mode: "agent",
    agent: { thought: `Thinking about step ${step}.`, action: { type: "click", ref: `e${step}` }, expectation: `step ${step} lands` },
    resolution: { locator: `role=button[name="Row ${step}"]` },
    result: { ok: true, settle_ms: 600 },
    artifacts: {},
  };
  fs.appendFileSync(path.join(run.dir, "trajectory.jsonl"), JSON.stringify(env) + "\n");
  event(run, { type: "step_result", step, costSoFar: 0.01 * step, tokens: { in: 1000 * step, out: 100 * step } });
}

const startStep = (run: LegacyTestValue, step: number) => event(run, { type: "step_start", step, summary: `click Row ${step}` });

/** Open a viewer page, collecting anything the page logs that is not a probe. */
async function open(run: LegacyTestValue) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  const notFound = new Set<string>();
  page.on("pageerror", (e: LegacyTestValue) => errors.push(`pageerror: ${e}`));
  page.on("response", (r: LegacyTestValue) => { if (r.status() === 404) notFound.add(r.url()); });
  page.on("console", (msg: LegacyTestValue) => {
    if (msg.type() !== "error") return;
    const url = msg.location()?.url ?? "";
    if (PROBE_404S.some((re) => re.test(url)) && notFound.has(url)) return;
    errors.push(`console: ${msg.text()} (${url})`);
  });
  await page.goto(`${base}/?run=${encodeURIComponent(run.rel)}`);
  return { page, errors };
}

const cells = (page: LegacyTestValue) => page.locator("#strip .cell:not(.pending)").count();
const badges = (page: LegacyTestValue) => page.locator("#run-badges").innerText();

test("live mode: the badge, the tail, and appends that land in place", async () => {
  const run = openRun("append");
  envelope(run, 1);
  envelope(run, 2);
  startStep(run, 3);

  const { page, errors } = await open(run);
  await page.waitForSelector("#strip .cell");
  // The placeholder manifest says `interrupted`; liveness is never inferred
  // from manifest contents, so the header must show the live badge instead.
  assert.match(await badges(page), /live/i, "an open run wears the ● live badge");
  assert.doesNotMatch(await badges(page), /interrupted/i, "…never the placeholder's terminal-looking status");
  assert.equal(await cells(page), 2);
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 2 \/ 2/i, "live mode opens on the tail");

  // Geometry before and after an append: nothing may shift.
  const geom = () => page.evaluate(() => {
    const r = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return [b.top, b.left, b.width, b.height].map(Math.round); }; // SAFETY: the viewer shell always carries these ids
    return { tabs: r("#stage-tabs"), strip: r("#strip-zone"), stage: r("#stage"), inspector: r("#inspector") };
  });
  const before = await geom();

  envelope(run, 3);
  startStep(run, 4);
  await page.waitForFunction(() => document.querySelectorAll("#strip .cell:not(.pending)").length === 3);
  assert.deepEqual(await geom(), before, "an append shifts no layout");
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 3 \/ 3/i, "follow mode tracks the newest step");

  // Ordering is sacred: appended envelopes render exactly as a full load would.
  const numbers = await page.locator("#strip .cell:not(.pending) .cell-line .n").allInnerTexts();
  assert.deepEqual(numbers, ["01", "02", "03"]);

  assert.deepEqual(errors, [], "no console/page errors in live mode");
  await page.close();
});

test("follow mode: an explicit selection disengages it, the follow control hands it back", async () => {
  const run = openRun("follow");
  for (const step of [1, 2, 3]) envelope(run, step);
  startStep(run, 4);

  const { page, errors } = await open(run);
  await page.waitForSelector("#strip .cell");
  const follow = page.locator("#live-follow");
  assert.ok(await follow.isVisible(), "the follow control is offered on an open run");
  assert.equal(await follow.getAttribute("aria-pressed"), "true", "follow is on by default");

  // An explicit selection takes the view off the tail, with a panel open.
  await page.locator('button.itab[data-itab="run"]').click();
  await page.locator("#strip .cell").first().click();
  assert.equal(await follow.getAttribute("aria-pressed"), "false", "selecting a step disengages follow");

  envelope(run, 4);
  startStep(run, 5);
  await page.waitForFunction(() => document.querySelectorAll("#strip .cell:not(.pending)").length === 4);
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 1 \//i, "the reader's selection survives the append");
  assert.ok(await page.locator("#ipane-run").isVisible(), "…and so does the panel they opened");

  await follow.click();
  assert.equal(await follow.getAttribute("aria-pressed"), "true");
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 4 \//i, "re-engaging jumps back to the tail");

  envelope(run, 5);
  await page.waitForFunction(() => document.querySelectorAll("#strip .cell:not(.pending)").length === 5);
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 5 \//i, "…and keeps tracking it");

  assert.deepEqual(errors, []);
  await page.close();
});

test("pending row: progress decorates the in-flight edge and never renders a step", async () => {
  const run = openRun("pending");
  envelope(run, 1);
  startStep(run, 2);

  const { page, errors } = await open(run);
  await page.waitForSelector("#live-pending");
  const pending = page.locator("#live-pending .t");
  assert.equal(await pending.innerText(), "recording step 2 of 20", "the row names the stage and the in-flight step");
  assert.equal(await cells(page), 1, "the pending row is not a step and never becomes one");

  // Progress may legitimately run ahead of `lines`; once the line lands, the
  // row must not repeat a step that is already on screen.
  envelope(run, 2);
  await page.waitForFunction(() => document.querySelectorAll("#strip .cell:not(.pending)").length === 2);
  await page.waitForFunction(() => document.querySelector("#live-pending .t")?.textContent === "recording");
  assert.equal(await pending.innerText(), "recording", "no phantom step while the trajectory has caught up");

  // Stages past recording: an early `done`, the gate, and the grading tail.
  event(run, { type: "phase", phase: "gate" });
  await page.waitForFunction(() => document.querySelector("#live-pending .t")?.textContent === "evaluating gate");
  event(run, { type: "grading" });
  await page.waitForFunction(() => document.querySelector("#live-pending .t")?.textContent === "grading");
  assert.equal(await cells(page), 2, "the tail adds no phantom in-flight step");

  assert.deepEqual(errors, []);
  await page.close();
});

test("inactivity: sustained silence reads as a fact, never as an abandonment claim", async () => {
  const run = openRun("quiet");
  envelope(run, 1);
  startStep(run, 2);

  const { page, errors } = await open(run);
  await page.waitForSelector("#strip .cell");
  assert.doesNotMatch(await badges(page), /no activity/i, "a run that just wrote is not called quiet");

  const old = new Date(Date.now() - 200_000);
  fs.utimesSync(path.join(run.dir, "events.jsonl"), old, old);
  // innerText applies the chips' CSS uppercasing, hence the case-insensitive match.
  await page.waitForFunction(() => /no activity for/i.test(document.querySelector("#run-badges")?.textContent ?? ""), null, { timeout: 30_000 });
  assert.match(await badges(page), /no activity for 3m/i);
  assert.match(await badges(page), /live/i, "inactivity never ends live mode — the run may just be thinking");

  assert.deepEqual(errors, []);
  await page.close();
});

test("reset: a cursor the host cannot honor reloads the run, still live and still following", async () => {
  // rewriteLast() annotates the already-written terminal envelope in place — the
  // one exception to append-only — so the host refuses the cursor rather than
  // serving a fragment. The viewer's answer is one full reload.
  const run = openRun("reset");
  envelope(run, 1);
  envelope(run, 2);
  startStep(run, 3);

  const { page, errors } = await open(run);
  await page.waitForSelector("#live-pending");
  assert.equal(await cells(page), 2);
  assert.equal(await page.locator("#strip .cell.c-warn").count(), 0);

  const file = path.join(run.dir, "trajectory.jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  lines[lines.length - 1] = JSON.stringify({
    ...JSON.parse(lines[lines.length - 1] as string), // SAFETY: the fixture wrote these lines
    confusion: { type: "state_drift", note: "the page moved under the recorded action" },
  });
  fs.writeFileSync(file, lines.join("\n") + "\n");

  await page.waitForFunction(() => document.querySelectorAll("#strip .cell.c-warn").length === 1, null, { timeout: 30_000 });
  assert.equal(await cells(page), 2, "the reload re-reads the run whole — no duplicates, no gaps");
  assert.match(await badges(page), /live/i, "a reset never ends live mode");
  assert.equal(await page.locator("#live-follow").getAttribute("aria-pressed"), "true", "…and the reader's follow choice survives it");

  envelope(run, 3);
  await page.waitForFunction(() => document.querySelectorAll("#strip .cell:not(.pending)").length === 3);
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 3 \/ 3/i, "the loop resumed from the reloaded cursor");

  assert.deepEqual(errors, []);
  await page.close();
});

test("seal: open:false discards the preview and lands the sealed run in place", async () => {
  const run = openRun("seal");
  for (const step of [1, 2]) envelope(run, step);
  startStep(run, 3);

  const { page, errors } = await open(run);
  await page.waitForSelector("#live-pending");
  await page.locator('button.itab[data-itab="run"]').click();
  assert.match(await page.locator("#ipane-run").innerText(), /not evaluated yet/i, "an open run's gate is not a verdict it has not been given");

  // The finishing tail: the last envelope, the grade, the final manifest, then
  // the terminal event that ends the conversation.
  envelope(run, 3);
  fs.writeFileSync(path.join(run.dir, "grade.json"), JSON.stringify({
    score: 91, model: "gpt5_5", completion: "full", wasted_steps: 0,
    summary: "The shopper added the item without detours.", findings: [],
  }));
  writeManifest(run, {
    duration_ms: 41_000,
    totals: { steps: 3 },
    result: { status: "pass", end_reason: "done", error: null, gate: { pass: true, checks: [{ spec: "the todo appears", kind: "assert", pass: true, severity: "hard", detail: "It does." }] } },
    artifacts: { trajectory: "trajectory.jsonl", grade: "grade.json", video: null, har: null, baseline_copy: null },
  });
  event(run, { type: "case_end", status: "pass" });

  await page.waitForSelector(".grade-top", { timeout: 30_000 });
  const sealed = await badges(page);
  assert.match(sealed, /pass/i, "the verdict lands");
  assert.doesNotMatch(sealed, /live/i, "the badge flips");
  assert.doesNotMatch(sealed, /no activity/i);
  assert.equal(await page.locator("#live-pending").count(), 0, "the pending row is gone");
  assert.ok(await page.locator("#live-follow").isHidden(), "so is the follow control");
  assert.match(await page.locator("#ipane-run").innerText(), /gate pass/i, "the real gate replaces the live placeholder");
  assert.equal(await cells(page), 3, "every step is present exactly once after the reload");
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 3 \/ 3/i, "the reload lands on the step the reader was watching");

  // Polling stops: the conversation is over.
  const seen: string[] = [];
  page.on("request", (r: LegacyTestValue) => { if (r.url().includes("/live?")) seen.push(r.url()); });
  await new Promise((r) => setTimeout(r, 3000));
  assert.deepEqual(seen, [], "no live request survives the seal");

  assert.deepEqual(errors, []);
  await page.close();
});

test("a sealed run never learns live mode exists", async () => {
  const run = openRun("sealed");
  for (const step of [1, 2]) envelope(run, step);
  writeManifest(run, { duration_ms: 900, totals: { steps: 2 }, result: { status: "pass", end_reason: "done", error: null, gate: { pass: true, checks: [] } } });
  event(run, { type: "case_end", status: "pass" });

  const { page, errors } = await open(run);
  await page.waitForSelector("#strip .cell");
  const probes: string[] = [];
  page.on("request", (r: LegacyTestValue) => { if (r.url().includes("/live?")) probes.push(r.url()); });

  assert.match(await badges(page), /pass/i);
  assert.doesNotMatch(await badges(page), /live/i, "no badge");
  assert.ok(await page.locator("#live-follow").isHidden(), "no follow control");
  assert.equal(await page.locator("#live-pending").count(), 0, "no pending row");
  assert.match(await page.locator("#ipane-run").innerText(), /gate pass/i, "the sealed gate renders normally");
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 1 \//i, "a sealed run still opens on step 1");

  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(probes, [], "the single probe at load is the only one, and it is not repeated");

  assert.deepEqual(errors, []);
  await page.close();
});
