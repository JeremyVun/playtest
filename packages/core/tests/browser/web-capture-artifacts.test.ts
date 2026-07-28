// The capture persistence barrier (BUILD_PLAN T2.2). captureSnapshot() now runs
// the title, screenshot (+dHash/downscale), MHTML and native-AX reads
// CONCURRENTLY and writes their artifacts through fs.promises. That is only safe
// if the returned snapshot is still a coherent, fully-persisted step: the runner
// writes the envelope — and the actor's vision prompt reads the PNG — the moment
// this promise resolves, so nothing may still be in flight.
//
// Run against a page that mutates the whole time (rows appended, text rewritten,
// a caret blinking), because that is where a concurrent capture could tear.
// Asserts NON-REGRESSION, not perfect atomicity: the serial code already
// tolerated instant skew between the a11y read and the screenshot. The debug
// writes are far quicker than the screenshot they now run behind, so their
// presence here cannot by itself distinguish "barrier held" from "barrier
// missed but the disk won the race" — the second test does that directly, since
// only an AWAITED PNG write can report that it failed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { start as startApp } from "../../../../tests/fixtures/todo-app/server.ts";
import { WebDriver } from "../../src/drivers/web.ts";

let app: LegacyTestValue;
let runDir: LegacyTestValue;

before(async () => {
  app = await startApp();
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-capture-"));
});

after(async () => {
  if (app) await app.close().catch(() => {});
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

// Appends a row and rewrites the counter every 16 ms, and blinks a caret — a
// page that is never quiet, so every capture races live DOM churn.
const CHURN = `
  <h1>Churn</h1>
  <p id="counter">0</p>
  <ul id="rows"></ul>
  <span id="caret">|</span>
  <style>@keyframes blink { 50% { opacity: 0 } } #caret { animation: blink .2s infinite }</style>
  <script>
    let n = 0;
    setInterval(() => {
      n++;
      document.getElementById("counter").textContent = String(n);
      const li = document.createElement("li");
      li.innerHTML = '<button>Row ' + n + '</button>';
      document.getElementById("rows").appendChild(li);
    }, 16);
  </script>`;

test("captureSnapshot: every step artifact is on disk, and the a11y text is the capture that was returned", async () => {
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    await driver.start();
    await driver.page.setContent(CHURN);

    for (const step of [1, 2, 3, 4, 5]) {
      const snap = await driver.captureSnapshot(step);
      const nnn = String(step).padStart(3, "0");
      const stepFile = (ext: string) => path.join(runDir, "steps", `${nnn}.${ext}`);

      // The barrier: nothing may still be flushing when captureSnapshot resolves.
      for (const ext of ["a11y.txt", "png", "mhtml", "pw-a11y.txt"]) {
        const file = stepFile(ext);
        assert.ok(fs.existsSync(file), `step ${step}: ${ext} was not on disk when captureSnapshot returned`);
        assert.ok(fs.statSync(file).size > 0, `step ${step}: ${ext} is empty`);
      }

      // Coherence: the text the runner puts in the envelope and the text on disk
      // are the same single capture, not two reads of a moving page.
      assert.equal(fs.readFileSync(stepFile("a11y.txt"), "utf8"), snap.text + "\n", `step ${step}: the a11y artifact disagrees with the returned snapshot`);

      // The PNG is a complete image (the vision prompt and the video both read
      // it), and the returned bytes carry the perceptual hash.
      const png = fs.readFileSync(stepFile("png"));
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `step ${step}: PNG header`);
      assert.deepEqual([...png.subarray(png.length - 8, png.length - 4)], [0x49, 0x45, 0x4e, 0x44], `step ${step}: PNG is truncated (no IEND chunk)`);
      assert.ok(snap.screenshot && snap.screenshot.length > 0, `step ${step}: no screenshot returned`);
      assert.match(String(snap.screenshotHash), /^[0-9a-f]{16}$/, `step ${step}: no dHash`);

      // Every ref the actor is offered came from this one snapshot pass and is
      // still addressable — a torn capture would advertise refs the page never
      // got stamped with.
      const refs = [...snap.text.matchAll(/^\[(e\d+)\]/gm)].map((m) => m[1]);
      assert.ok(refs.length > 0, `step ${step}: no refs in the snapshot text`);
      const missing: string[] = [];
      for (const ref of refs) {
        if ((await driver.page.locator(`[data-dummy-ref="${ref}"]`).count()) === 0) missing.push(String(ref));
      }
      assert.deepEqual(missing, [], `step ${step}: refs in the snapshot text are not in the page`);
    }
  } finally {
    await driver.close();
  }
});

// A step whose debug artifacts fail to write must not take the run down, and
// must not leave the envelope claiming a screenshot that isn't there.
// Artifact profiles (BUILD_PLAN T3.1, docs/contracts/artifacts.md#artifact-profiles).
// The listing is the contract: `debug` is exactly the set this driver has always
// written, and `core` is that set minus the three browser-forensics extras
// nothing reads back. Asserted as SET EQUALITY rather than as presence checks,
// because the failure this guards against is a gate that drops one artifact too
// many — or an envelope that keeps naming one that is gone.
const DEBUG_STEP_FILES = ["001.a11y.txt", "001.mhtml", "001.png", "001.pw-a11y.txt"];
const CORE_STEP_FILES = ["001.a11y.txt", "001.png"];

async function profileRun(artifacts: LegacyTestValue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `playtest-profile-${artifacts}-`));
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir: dir, ...(artifacts ? { artifacts } : {}) });
  let snap: LegacyTestValue;
  try {
    await driver.start();
    snap = await driver.captureSnapshot(1);
    await driver.stopRecording();
  } finally {
    await driver.close();
  }
  return {
    dir,
    snap,
    steps: fs.readdirSync(path.join(dir, "steps")).sort(),
    top: fs.readdirSync(dir).sort(),
  };
}

test("artifact profiles: core drops the trace, MHTML and native AX tree; debug is unchanged", async () => {
  const debug = await profileRun("debug");
  const core = await profileRun("core");
  try {
    assert.deepEqual(debug.steps, DEBUG_STEP_FILES, "the debug profile writes exactly the historical step set");
    assert.deepEqual(core.steps, CORE_STEP_FILES, "the core profile writes only the evidence");

    // Run-dir level: trace.zip is never started under core, so close() has
    // nothing to flush; final.mhtml is the debug companion of final.a11y.txt,
    // which is terminal-state evidence and rides under BOTH profiles.
    assert.ok(debug.top.includes("trace.zip"), "the debug profile still flushes the Playwright trace");
    assert.ok(debug.top.includes("final.mhtml"), "the debug profile still captures the final MHTML");
    assert.deepEqual(core.top.filter((f: string) => f === "trace.zip" || f === "final.mhtml"), [], "a core run writes neither");
    for (const run of [debug, core]) {
      assert.ok(run.top.includes("final.a11y.txt"), "the terminal-state evidence the gate and grader read is always written");
    }

    // The profile changes what is written beside the evidence, never the
    // evidence: the actor sees the same page and the pixel oracle still fires.
    assert.equal(core.snap.text, debug.snap.text, "the agent-facing snapshot is identical across profiles");
    assert.match(String(core.snap.screenshotHash), /^[0-9a-f]{16}$/, "visual regression still has its dHash");
    assert.equal(
      fs.readFileSync(path.join(core.dir, "steps", "001.a11y.txt"), "utf8"),
      core.snap.text + "\n",
    );

    // A driver constructed without a profile keeps recording what it always did.
    const legacy = await profileRun(null);
    try {
      assert.deepEqual(legacy.steps, DEBUG_STEP_FILES);
      assert.equal(legacy.snap.text, debug.snap.text);
    } finally {
      fs.rmSync(legacy.dir, { recursive: true, force: true });
    }
  } finally {
    for (const run of [debug, core]) fs.rmSync(run.dir, { recursive: true, force: true });
  }
});

test("captureSnapshot: a failed PNG write is reported as no screenshot, not as a crash", async () => {
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    await driver.start();
    await driver.page.setContent(CHURN);
    // A directory where the PNG wants to be: the write fails, everything else
    // still lands.
    fs.mkdirSync(path.join(runDir, "steps", "042.png"), { recursive: true });

    const snap = await driver.captureSnapshot(42);
    assert.equal(snap.screenshot, null, "a screenshot that could not be persisted is not advertised");
    assert.match(String(snap.screenshotHash), /^[0-9a-f]{16}$/, "the perceptual hash still comes from the in-memory bytes");
    assert.ok(fs.existsSync(path.join(runDir, "steps", "042.a11y.txt")), "the agent-facing text is still written");
  } finally {
    await driver.close();
  }
});
