// Artifact profiles (docs/contracts/artifacts.md#artifact-profiles):
// `artifacts: core | debug`
// decides whether a run pays for the browser-forensics extras — the Playwright
// trace, MHTML, and the driver's native accessibility tree — that nothing in the
// harness, the gate, the grader, or the viewer reads back.
//
// Three things are asserted here, all offline: the config surface (default,
// inheritance, and the error a typo produces), the mobile driver's gate over a
// fake Appium client, and that a manifest never names a trace no run wrote. The
// web driver's half needs a real Chromium and lives in
// tests/browser/web-capture-artifacts.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases, DummyConfigError } from "../../src/config.ts";
import { buildManifest } from "../../src/runner.ts";
import { MobileDriver } from "../../src/drivers/mobile.ts";
import { parsePageSource, nativePageSourceTree } from "../../src/drivers/mobile-snapshot.ts";

let tmpRoot: LegacyTestValue;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-artifact-profile-"));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let suiteSeq = 0;

/** Write an inline suite from { "name.yaml": "content", … }; returns its dir. */
function writeSuite(files: Record<string, string>) {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const STORY = 'story: |\n  Add "buy milk" to the list.\n';

// ---------------------------------------------------------------- config

test("artifacts defaults to core, inherits from the suite, and a case may override it", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "plain.yaml": STORY,
  });
  const plain = await discoverCases([dir]);
  assert.equal(plain.length, 1);
  assert.equal(plain[0]!.artifacts, "core", "an unconfigured case records the core profile"); // SAFETY: length asserted above

  const inherited = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\nartifacts: debug\n",
    "a.yaml": STORY,
    "b.yaml": `${STORY}artifacts: core\n`,
  });
  const byId: LegacyTestValue = Object.fromEntries((await discoverCases([inherited])).map((c) => [c.id, c]));
  assert.equal(byId.a.artifacts, "debug", "a suite-wide default reaches every case below it");
  assert.equal(byId.b.artifacts, "core", "a case still wins over the suite default");
});

test("an unknown artifact profile is a config error naming the file and both profiles", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "typo.yaml": `${STORY}artifacts: verbose\n`,
  });
  await assert.rejects(discoverCases([dir]), (e: LegacyTestValue) => {
    assert.ok(e instanceof DummyConfigError, `expected DummyConfigError, got: ${e?.stack ?? e}`);
    assert.match(e.message, /typo\.yaml/, "the message names the file");
    assert.match(e.message, /artifacts/);
    assert.match(e.message, /core/);
    assert.match(e.message, /debug/);
    assert.doesNotMatch(e.message, /MODULE_NOT_FOUND|\bat \//, "no raw stack reaches the user");
    return true;
  });
});

// ---------------------------------------------------------------- mobile

const SCREEN = { w: 390, h: 844 };
const XML =
  `<XCUIElementTypeApplication name="Todos" label="Todos">` +
  `<XCUIElementTypeTextField name="todo-input" label="" value="New todo" x="16" y="60" width="317" height="35" visible="true"/>` +
  `<XCUIElementTypeButton name="todo-row-1" label="Buy milk" value="active" x="16" y="120" width="256" height="26" visible="true"/>` +
  `</XCUIElementTypeApplication>`;

/** The minimum of the Appium client surface MobileDriver touches. */
function fakeClient() {
  return {
    async getPageSource() { return XML; },
    async getWindowSize() { return { width: SCREEN.w, height: SCREEN.h }; },
    async takeScreenshot() { return Buffer.from("fake-png-bytes").toString("base64"); },
    async getAlertText(): Promise<string> { throw new Error("no such alert"); },
    async execute() { return null; },
    async back() {},
    async deleteSession() {},
    $() { return { elementId: "el-1", async isExisting() { return true; } }; },
    $$() { return []; },
  };
}

async function mobileCapture(t: LegacyTestValue, artifacts: LegacyTestValue) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-mobile-profile-"));
  fs.mkdirSync(path.join(runDir, "steps"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const driver = new MobileDriver({
    client: fakeClient() as LegacyTestValue, // SAFETY: the fake implements exactly the client surface this driver uses
    runDir,
    settle: { source_quiet_ms: 0, max_ms: 0, initial_quiet_ms: 0 } as LegacyTestValue,
    ...(artifacts ? { artifacts } : {}),
  });
  await driver.start();
  const snap = await driver.captureSnapshot(1);
  return { runDir, snap, driver, files: fs.readdirSync(path.join(runDir, "steps")).sort() };
}

test("mobile core profile writes no native page-source tree; the evidence is byte-identical to debug", async (t: LegacyTestValue) => {
  const core = await mobileCapture(t, "core");
  const debug = await mobileCapture(t, "debug");

  assert.deepEqual(core.files, ["001.a11y.txt", "001.png"], "core writes the a11y text and the still, nothing else");
  assert.deepEqual(debug.files, ["001.a11y.txt", "001.png", "001.pw-a11y.txt"], "debug adds the native tree");
  assert.equal(
    fs.readFileSync(path.join(debug.runDir, "steps", "001.pw-a11y.txt"), "utf8"),
    nativePageSourceTree(XML) + "\n",
  );

  // The profile changes what is written BESIDE the evidence, never the evidence:
  // the agent-facing snapshot is the same text, refs, and format either way, so
  // the ax-tree-v7 pin and every recorded baseline stay comparable across it.
  const expected = parsePageSource(XML, { screen: SCREEN }).text;
  assert.equal(core.snap.text, expected);
  assert.equal(core.snap.text, debug.snap.text);
  assert.equal(core.snap.refCount, debug.snap.refCount);
  assert.equal(
    fs.readFileSync(path.join(core.runDir, "steps", "001.a11y.txt"), "utf8"),
    fs.readFileSync(path.join(debug.runDir, "steps", "001.a11y.txt"), "utf8"),
  );
});

test("a directly constructed driver still records everything it always did", async (t: LegacyTestValue) => {
  // The config default is core, but a driver built outside a run (unit tests,
  // external callers) has no case to read it from — its own default is debug so
  // that path is unchanged by this phase.
  const legacy = await mobileCapture(t, null);
  assert.deepEqual(legacy.files, ["001.a11y.txt", "001.png", "001.pw-a11y.txt"]);
  assert.equal(legacy.driver.artifactProfile, "debug");
});

// -------------------------------------------------------------- manifest

function manifestFor({ driver, artifacts }: LegacyTestValue) {
  return buildManifest({
    rc: {
      id: "add-todo",
      file: "stories/add-todo.yaml",
      story: "Add a todo.",
      description: null,
      mode: "journey",
      persona: "tester",
      tags: [],
      success: [],
      observe: [],
      perf: {},
      report: [],
      vision: false,
      visual_regression: true,
      visual_regression_drift: 10,
      artifacts,
      limits: { max_steps: 10, timeout_ms: 1000 },
      actor_model: "m",
      grader_model: "m",
      env: { driver, base_url: "http://127.0.0.1:1" },
    },
    runId: "2026-07-28T0000-abcd",
    mode: "record",
    startedAt: new Date("2026-07-28T00:00:00Z"),
    videoStartedAt: null,
    llm: { baseUrl: "http://127.0.0.1:2" },
    env: { baseUrl: "http://127.0.0.1:1", managed: false },
    r: { envelopes: [], endReason: "done", runError: null },
    status: "pass",
    gate: { pass: true, checks: [] },
    consoleErrors: 0,
    baseline: null,
    willGrade: false,
  });
}

test("a manifest names trace.zip only for a web run that actually recorded one", () => {
  assert.equal(manifestFor({ driver: "web", artifacts: "debug" }).artifacts.trace, "trace.zip");
  assert.equal(manifestFor({ driver: "web", artifacts: "core" }).artifacts.trace, null);
  // The api and mobile drivers never had a Playwright trace to flush; the
  // manifest used to name one anyway.
  assert.equal(manifestFor({ driver: "api", artifacts: "debug" }).artifacts.trace, null);
  assert.equal(manifestFor({ driver: "mobile", artifacts: "debug" }).artifacts.trace, null);

  // The profile is recorded as provenance, so a reader can tell "recorded under
  // core" from "the trace was pruned".
  assert.equal(manifestFor({ driver: "web", artifacts: "core" }).case.artifacts, "core");
  assert.equal(manifestFor({ driver: "web", artifacts: "debug" }).case.artifacts, "debug");
});
