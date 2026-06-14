// Mobile driver (Appium) self-test, offline: a FAKE webdriverio client simulates
// a tiny native iOS todo app (the test seam __setMobileClientFactory), the
// mock-llm drives the actor over the AX-tree snapshot, and runCase exercises the
// full record → act → heal loop + the screen_shows gate + the driver: mobile
// pins — proving the seam works on a non-web transport with NO real device.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parsePageSource } from "../src/harness/drivers/mobile-snapshot.js";
import { __setMobileClientFactory } from "../src/harness/drivers/mobile.js";
import { discoverCases } from "../src/harness/config.js";
import { runCase } from "../src/harness/runner.js";
import { newRunId, readTrajectory, actionOf } from "../src/harness/trajectory.js";
import { start as startMock } from "../src/harness/testing/mock-llm.js";

// ---------- a fake iOS app behind the webdriverio surface the driver uses ----------

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function makeFakeApp() {
  const state = { input: "", todos: [] };
  const pageSource = () => {
    const rows = state.todos
      .map((t, i) => `<XCUIElementTypeCell name="${xmlEscape(t)}" label="${xmlEscape(t)}" x="20" y="${100 + i * 44}" width="340" height="40" visible="true"/>`)
      .join("");
    return (
      `<?xml version="1.0"?>` +
      `<XCUIElementTypeApplication name="Todos">` +
      `<XCUIElementTypeStaticText name="Todos" label="Todos" x="20" y="10" width="200" height="30" visible="true"/>` +
      `<XCUIElementTypeTextField name="What needs doing?" value="${xmlEscape(state.input)}" x="20" y="50" width="280" height="40" visible="true"/>` +
      `<XCUIElementTypeButton name="Add" label="Add" x="300" y="50" width="60" height="40" visible="true"/>` +
      rows +
      `</XCUIElementTypeApplication>`
    );
  };
  // name out of "~name" or an //...[@name="name"] predicate
  const nameOf = (sel) => {
    if (sel.startsWith("~")) return sel.slice(1);
    return sel.match(/@name=(?:"([^"]*)"|'([^']*)')/)?.[1] ?? sel.match(/@label="([^"]*)"/)?.[1] ?? null;
  };
  const kindOf = (name) =>
    name === "Add" ? "add" : name === "What needs doing?" ? "field" : state.todos.includes(name) ? "cell" : null;

  const element = (name) => ({
    elementId: `el:${name}`,
    async isExisting() {
      return kindOf(name) != null;
    },
    async isDisplayed() {
      return kindOf(name) != null;
    },
    async click() {
      if (kindOf(name) === "add" && state.input.trim()) {
        state.todos.push(state.input.trim());
        state.input = "";
      }
    },
    async setValue(text) {
      if (kindOf(name) === "field") state.input = String(text);
    },
    async clearValue() {
      if (kindOf(name) === "field") state.input = "";
    },
    async getLocation() {
      return { x: 300, y: 50 };
    },
    async getSize() {
      return { width: 60, height: 40 };
    },
  });

  let sessions = 0;
  return {
    sessions: () => sessions,
    state,
    async getPageSource() {
      return pageSource();
    },
    async takeScreenshot() {
      // a 1x1 PNG so the driver writes a real steps/NNN.png artifact
      return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    },
    async $(sel) {
      sessions++;
      return element(nameOf(sel));
    },
    async $$(sel) {
      const name = nameOf(sel);
      return kindOf(name) != null ? [element(name)] : [];
    },
    async back() {},
    async execute() {},
    async deleteSession() {},
  };
}

// ---------- snapshot walker (pure) ----------

test("parsePageSource: iOS AX tree → [eN] text + durable accessibility-id locators + bbox", () => {
  const xml =
    `<XCUIElementTypeApplication name="Todos">` +
    `<XCUIElementTypeTextField name="What needs doing?" value="milk" x="20" y="50" width="280" height="40" visible="true"/>` +
    `<XCUIElementTypeButton name="Add" x="300" y="50" width="60" height="40" visible="true"/>` +
    `<XCUIElementTypeCell name="buy milk" x="20" y="100" width="340" height="40" visible="true"/>` +
    `<XCUIElementTypeStaticText name="1 item left" x="20" y="150" width="200" height="20" visible="true"/>` +
    `</XCUIElementTypeApplication>`;
  const snap = parsePageSource(xml);
  assert.match(snap.text, /^Screen: Todos/);
  assert.equal(snap.title, "Todos");
  assert.equal(snap.refCount, 3); // field, button, cell (StaticText is text:, not interactive)
  assert.match(snap.text, /\[e1\] textfield "What needs doing\?" value="milk"/);
  assert.match(snap.text, /\[e2\] button "Add"/);
  assert.match(snap.text, /\[e3\] cell "buy milk"/);
  assert.match(snap.text, /text: "1 item left"/);
  const field = snap.elements[0];
  assert.equal(field.locator, "~What needs doing?"); // accessibility id, the durable handle
  assert.deepEqual(field.bbox, { x: 20, y: 50, w: 280, h: 40 });
  assert.equal(field.typable, true);
  assert.equal(snap.elements[2].locator, "~buy milk");
});

test("parsePageSource: Android bounds + content-desc, and never throws on junk", () => {
  const xml =
    `<android.widget.FrameLayout>` +
    `<android.widget.Button content-desc="Add" bounds="[300,50][360,90]"/>` +
    `<android.widget.EditText resource-id="com.x:id/new" text="" bounds="[20,50][280,90]"/>` +
    `</android.widget.FrameLayout>`;
  const snap = parsePageSource(xml);
  assert.equal(snap.elements.find((e) => e.role === "button").bbox.w, 60);
  assert.doesNotThrow(() => parsePageSource("<not really <xml"));
  assert.doesNotThrow(() => parsePageSource(null));
});

// ---------- offline record → act e2e against the fake app ----------

let mock;
let tmpRoot;

before(async () => {
  mock = await startMock();
  process.env.PLAYTEST_LLM_BASE_URL = mock.url;
  delete process.env.PLAYTEST_LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // Every session.launch gets a fresh app (record and act are separate launches).
  __setMobileClientFactory(async () => makeFakeApp());
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-mobile-"));
});

after(async () => {
  __setMobileClientFactory(null);
  if (mock) await mock.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mobileSuite() {
  const dir = path.join(tmpRoot, `suite-${Math.abs(hash(tmpRoot + Date.now() + Math.random()))}`);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "playtest.yaml"),
    "app:\n  driver: mobile\n  platform: ios\n  app: ./build/Todos.app\nactor_model: claude-haiku-4-5\ngrader_model: claude-sonnet-4-6\n",
  );
  fs.writeFileSync(
    path.join(dir, "stories", "add-todo.yaml"),
    [
      "tags: [smoke]",
      "story: |",
      '  You keep forgetting to buy milk. Add a todo called "buy milk" and',
      "  confirm it shows up in your list.",
      "success:",
      '  - screen_shows: "~buy milk"',
      '  - assert: "the list shows a todo called buy milk"',
      "",
    ].join("\n"),
  );
  return dir;
}
// Date-free, random-free is not required in tests, but keep suite dirs distinct.
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

test("mobile record → act: tap/type envelopes, screen_shows gate, driver:mobile pins", async () => {
  const suite = mobileSuite();
  const [rc] = await discoverCases([suite]);
  assert.equal(rc.env.driver, "mobile", "config carries app.driver through to env.driver");

  // ---- record ----
  const rec = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: true, onEvent: () => {} });
  assert.equal(rec.status, "pass", `record should pass; error: ${rec.error ?? "(none)"}`);
  assert.equal(rec.manifest.mode, "record");
  assert.equal(rec.manifest.pins.driver, "mobile", "driver pin recorded");
  assert.equal(rec.manifest.env.driver, "mobile");
  assert.equal(rec.manifest.pins.settle.name, "settle-mobile-v1");
  assert.ok(rec.manifest.result.gate.pass, "screen_shows + assert gate passed");

  const envs = readTrajectory(path.join(rec.runDir, "trajectory.jsonl"));
  const verbs = envs.map((e) => actionOf(e)?.type);
  assert.ok(verbs.includes("type"), "typed the title");
  assert.ok(verbs.includes("tap"), "tapped Add (mobile verb, not click)");
  assert.ok(!verbs.includes("click"), "no web verbs leak into a mobile run");
  // a real durable accessibility-id locator + bbox rode the tap envelope
  const tap = envs.find((e) => actionOf(e)?.type === "tap");
  assert.equal(tap.resolution.locator, "~Add");
  assert.ok(tap.resolution.bbox && typeof tap.resolution.bbox.w === "number", "bbox for the ghost cursor");
  // artifacts the viewer reads: AX text always, a screenshot when capture worked
  const a11y = fs.readFileSync(path.join(rec.runDir, "steps", "001.a11y.txt"), "utf8");
  assert.match(a11y, /^Screen: Todos/);
  assert.ok(fs.existsSync(path.join(rec.runDir, "steps", "001.png")), "screen capture written for the film strip");

  // ---- act (a baseline now exists → replay from the saved locators) ----
  const act = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: false, onEvent: () => {} });
  assert.equal(act.status, "pass", `act should pass; error: ${act.error ?? "(none)"}`);
  assert.equal(act.manifest.mode, "act");
  const actEnvs = readTrajectory(path.join(act.runDir, "trajectory.jsonl"));
  assert.ok(actEnvs.some((e) => e.mode === "act" && e.acted_from != null), "acted straight from the baseline track");
});

// A FAIL path: the run completes (the actor adds the todo) but the screen_shows
// gate queries an element the fake app will never expose, so finalPageCheck
// returns false and the gate fails — proving the mobile driver's gate seam
// reports a real product FAIL (status "fail", not infra) with a useful detail,
// distinct from the happy path above.
test("mobile gate FAIL: a screen_shows query that matches nothing fails the gate with a detail", async () => {
  const dir = path.join(tmpRoot, `gatefail-${Math.abs(hash(tmpRoot + Date.now() + Math.random()))}`);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "playtest.yaml"),
    "app:\n  driver: mobile\n  platform: ios\n  app: ./build/Todos.app\nactor_model: claude-haiku-4-5\ngrader_model: claude-sonnet-4-6\n",
  );
  fs.writeFileSync(
    path.join(dir, "stories", "missing.yaml"),
    [
      "story: |",
      '  Add a todo called "buy milk" and confirm it shows up in your list.',
      "success:",
      '  - screen_shows: "~no-such-element"',
      "",
    ].join("\n"),
  );
  const [rc] = await discoverCases([dir]);
  assert.equal(rc.env.driver, "mobile");

  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: true, onEvent: () => {} });
  // The run itself completed cleanly — this is a product FAIL, never infra.
  assert.equal(res.status, "fail", `expected gate FAIL, got ${res.status} (error: ${res.error ?? "(none)"})`);
  assert.equal(res.manifest.mode, "record");
  const gate = res.manifest.result.gate;
  assert.equal(gate.pass, false, "gate must not pass when the queried screen element is absent");
  const check = gate.checks.find((c) => c.kind === "screen_shows");
  assert.ok(check, "a screen_shows check is recorded");
  assert.equal(check.pass, false);
  assert.match(check.detail, /no screen element matches ~no-such-element/);
  // No baseline is blessed for a failing record run.
});
