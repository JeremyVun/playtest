// The mobile driver's retained settle source (docs/backlog/perf/BUILD_PLAN.md,
// T1.1): `#settle()` finishes holding the very page source it just proved
// stable, and the `captureSnapshot()` that follows reuses it instead of asking
// the device for the same screen a second time.
//
// Appium round-trips dominate a mobile step, so what is asserted here is COUNTS
// as much as content: how many `getPageSource()` calls a launch and a step cost,
// which of them disappear, and — the part that must never be optimized away —
// that the alert probe and the screenshot still go to the device on every
// capture. A system alert is drawn by another process and is absent from page
// source (mobile-snapshot.ts), so cached alert state would be a wrong answer,
// not a cheap one.
//
// Hermetic: a fake WebDriver client stands in for Appium, so this is the offline
// counterpart of tests/mobile/mobile-driver.test.ts (real simulator, opt-in).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MobileDriver } from "../../src/drivers/mobile.ts";
import { parsePageSource, nativePageSourceTree } from "../../src/drivers/mobile-snapshot.ts";

const SCREEN = { w: 390, h: 844 };

const screenXml = (rows: string) =>
  `<XCUIElementTypeApplication name="Todos" label="Todos">` +
  `<XCUIElementTypeTextField name="todo-input" label="" value="New todo" x="16" y="60" width="317" height="35" visible="true"/>` +
  rows +
  `</XCUIElementTypeApplication>`;

const row = (id: number, title: string, state: string, y: number) =>
  `<XCUIElementTypeButton name="todo-row-${id}" label="${title}" value="${state}" x="16" y="${y}" width="256" height="26" visible="true"/>`;

const SCREEN_A = screenXml(row(1, "Buy milk", "active", 120));
const SCREEN_B = screenXml(row(1, "Buy milk", "completed", 120));
const PNG = Buffer.from("fake-png-bytes").toString("base64");

/** The text the driver must render for a source — the byte-for-byte oracle. */
const textFor = (xml: string) => parsePageSource(xml, { screen: SCREEN }).text;

/**
 * A fake Appium client: enough of the WebDriver surface for MobileDriver, with a
 * counter on every round-trip so a test can assert what the device was asked.
 */
class FakeClient {
  source = SCREEN_A;
  alert: { text: string; buttons: string[] } | null = null;
  /** Applied by the next tap, so an action can move the screen under the driver. */
  onTap: (() => void) | null = null;
  counts = { getPageSource: 0, takeScreenshot: 0, getAlertText: 0, click: 0 };
  /** Every `execute()` command name, in order — the gesture-memo oracle. */
  executed: string[] = [];
  /** Commands this "platform" does not implement (Appium rejects them). */
  unsupported = new Set<string>();

  async getPageSource() {
    this.counts.getPageSource += 1;
    return this.source;
  }

  async getWindowSize() {
    return { width: SCREEN.w, height: SCREEN.h };
  }

  async takeScreenshot() {
    this.counts.takeScreenshot += 1;
    return PNG;
  }

  async getAlertText() {
    this.counts.getAlertText += 1;
    if (!this.alert) throw new Error("no such alert"); // what Appium does with no alert up
    return this.alert.text;
  }

  async execute(command: string, args?: { action?: string }) {
    this.executed.push(command);
    if (this.unsupported.has(command)) throw new Error(`Unknown mobile command "${command}"`);
    if (command === "mobile: alert" && args?.action === "getButtons") return this.alert?.buttons ?? [];
    return null;
  }

  async back() {}

  async deleteSession() {}

  $(_locator: string) {
    const client = this;
    return {
      elementId: "el-1",
      async isExisting() {
        return true;
      },
      async click() {
        client.counts.click += 1;
        client.onTap?.();
      },
      async clearValue() {},
      async setValue() {},
      async getLocation() {
        return { x: 16, y: 120 };
      },
      async getSize() {
        return { width: 256, height: 26 };
      },
    };
  }

  $$(_query: string) {
    return [];
  }
}

/**
 * A driver over a fake client in a scratch run dir.
 *
 * `max_ms: 0` makes every settle exactly ONE poll, so each `getPageSource()` in
 * the counts below is attributable to a named read rather than to how long a
 * quiet window happened to run. `quietSettle` covers the multi-poll shape.
 */
function makeDriver(t: LegacyTestValue, settle: LegacyTestValue = { source_quiet_ms: 0, max_ms: 0, initial_quiet_ms: 0 }) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-mobile-reuse-"));
  fs.mkdirSync(path.join(runDir, "steps")); // MobileDriver.launch's job; the constructor is the seam here
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const client = new FakeClient();
  const driver = new MobileDriver({ client: client as LegacyTestValue, runDir, settle }); // SAFETY: the fake implements exactly the client surface this driver uses
  return { client, driver, runDir };
}

test("start() seeds settle with the page source it already fetched", async (t: LegacyTestValue) => {
  const { client, driver } = makeDriver(t);

  const started = await driver.start();
  assert.equal(started.ok, true, started.error ?? "start failed");
  // The launch probe IS the first settle poll: one source read for the whole
  // startup, where the probe and the settle used to read the same screen twice.
  assert.equal(client.counts.getPageSource, 1, "startup reads the page source exactly once");
  assert.deepEqual(driver.viewport, { width: SCREEN.w, height: SCREEN.h });
});

test("the capture after a settle reuses that source: no page-source read, byte-identical text", async (t: LegacyTestValue) => {
  const { client, driver, runDir } = makeDriver(t);
  await driver.start();
  const afterStart = client.counts.getPageSource;

  const snap = await driver.captureSnapshot(1);
  assert.equal(client.counts.getPageSource, afterStart, "a settled screen is not fetched again");
  // Reuse is invisible in the output: the same text, refs, and format as a parse
  // of the same source. The snapshot pin (ax-tree-v7) does not move.
  assert.equal(snap.text, textFor(SCREEN_A));
  assert.equal(snap.refCount, parsePageSource(SCREEN_A, { screen: SCREEN }).refCount);
  assert.equal(snap.truncated, false);

  // Only the source is reused. The two reads that cannot be cached still ran.
  assert.equal(client.counts.getAlertText, 1, "the alert probe stays live on every capture");
  assert.equal(client.counts.takeScreenshot, 1, "the screenshot stays live on every capture");

  // The step artifacts are written from the reused source, including the debug
  // native tree — which is now derived from the SAME walk as the snapshot above
  // (T2.1) rather than from a second pass over the XML, and must be unchanged.
  assert.equal(fs.readFileSync(path.join(runDir, "steps", "001.a11y.txt"), "utf8"), snap.text + "\n");
  assert.ok(fs.existsSync(path.join(runDir, "steps", "001.png")));
  assert.equal(fs.readFileSync(path.join(runDir, "steps", "001.pw-a11y.txt"), "utf8"), nativePageSourceTree(SCREEN_A) + "\n", "the shared walk renders the same native tree as an independent walk");
});

// The platform gesture command (see MobileDriver#swipe): try both, then remember
// which one the session answered to. On UiAutomator2 the first choice is always
// rejected, and paying that round-trip on every swipe is pure waste.
test("the swipe command a session answered to is used first from then on", async (t: LegacyTestValue) => {
  const { client, driver } = makeDriver(t);
  await driver.start();
  client.unsupported.add("mobile: swipe"); // an Android/UiAutomator2 session

  const gestures = () => client.executed.filter((c) => c.startsWith("mobile: swipe") || c.startsWith("mobile: scrollGesture"));
  const first = await driver.execute({ type: "swipe", direction: "up" } as LegacyTestValue); // SAFETY: focused action literal
  assert.equal(first.ok, true, first.error ?? "swipe failed");
  // Unchanged first-attempt semantics: `mobile: swipe`, then the fallback.
  assert.deepEqual(gestures(), ["mobile: swipe", "mobile: scrollGesture"]);

  client.executed.length = 0;
  const second = await driver.execute({ type: "swipe", direction: "up" } as LegacyTestValue); // SAFETY: focused action literal
  assert.equal(second.ok, true, second.error ?? "swipe failed");
  assert.deepEqual(gestures(), ["mobile: scrollGesture"], "the rejected command is not tried again");

  // A scroll goes through the same gesture path and inherits the memo.
  client.executed.length = 0;
  await driver.execute({ type: "scroll", direction: "down" } as LegacyTestValue); // SAFETY: focused action literal
  assert.deepEqual(gestures(), ["mobile: scrollGesture"]);
});

test("an iOS session that answers the first gesture command never tries the fallback", async (t: LegacyTestValue) => {
  const { client, driver } = makeDriver(t);
  await driver.start();
  for (const step of [1, 2]) {
    client.executed.length = 0;
    const res = await driver.execute({ type: "swipe", direction: "up" } as LegacyTestValue); // SAFETY: focused action literal
    assert.equal(res.ok, true, res.error ?? `swipe ${step} failed`);
    assert.deepEqual(client.executed.filter((c) => c.startsWith("mobile: ")), ["mobile: swipe"]);
  }
});

test("the retained source is good for exactly one capture", async (t: LegacyTestValue) => {
  const { client, driver } = makeDriver(t);
  await driver.start();
  await driver.captureSnapshot(1);
  const afterFirst = client.counts.getPageSource;

  // A second capture with no action between is a fresh question about a screen
  // that may have moved on its own, so it goes back to the device.
  const again = await driver.captureSnapshot(2);
  assert.equal(client.counts.getPageSource, afterFirst + 1, "a consumed entry is not served twice");
  assert.equal(again.text, textFor(SCREEN_A));
});

test("an action invalidates the retained source: the next capture sees the post-action screen", async (t: LegacyTestValue) => {
  const { client, driver } = makeDriver(t);
  await driver.start();
  const first = await driver.captureSnapshot(1);
  const ref = /\[(e\d+)\] button "Buy milk"/.exec(first.text)?.[1];
  assert.ok(ref, `no row to tap in:\n${first.text}`);

  client.onTap = () => {
    client.source = SCREEN_B;
  };
  const before = client.counts.getPageSource;
  const tapped = await driver.execute({ type: "tap", ref } as LegacyTestValue); // SAFETY: focused action literal
  assert.equal(tapped.ok, true, tapped.error ?? "tap failed");
  const snap = await driver.captureSnapshot(2);

  // The pre-action source is never served: the tap bumps the driver's operation
  // counter, so only the settle that followed the tap can be reused.
  assert.equal(snap.text, textFor(SCREEN_B), "the capture reflects the tapped state");
  assert.notEqual(snap.text, first.text);
  // One source read for the whole action: settle's, which the capture then
  // reuses. Before T1.1 this pair cost two.
  assert.equal(client.counts.getPageSource - before, 1, "an action costs one page-source read, not two");
});

test("a ref that resolves to nothing touches no device command, so the retained source survives", async (t: LegacyTestValue) => {
  const { client, driver } = makeDriver(t);
  await driver.start();
  const failed = await driver.execute({ type: "tap", ref: "e99" } as LegacyTestValue); // SAFETY: focused action literal
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /unknown ref/);

  const before = client.counts.getPageSource;
  const snap = await driver.captureSnapshot(1);
  assert.equal(client.counts.getPageSource, before, "nothing moved the screen, so the settled source still holds");
  assert.equal(snap.text, textFor(SCREEN_A));
});

test("an alert raised after settle is still reported, because the probe is never cached", async (t: LegacyTestValue) => {
  const { client, driver } = makeDriver(t);
  await driver.start();
  const beforeSource = client.counts.getPageSource;

  // A system alert appears between settle and capture. It is drawn by another
  // process and is absent from the (reused) page source — only the live probe
  // can see it, and its buttons are the actor's only affordances.
  client.alert = { text: "Allow notifications?", buttons: ["Don't Allow", "Allow"] };
  const snap = await driver.captureSnapshot(1);

  assert.equal(client.counts.getPageSource, beforeSource, "the underlying screen is still reused");
  assert.match(snap.text, /^Screen: System dialog/);
  assert.match(snap.text, /text: "Allow notifications\?"/);
  assert.match(snap.text, /\[e1\] button "Don't Allow"/);
  assert.match(snap.text, /\[e2\] button "Allow"/);
  assert.equal(snap.refCount, 2);
});

test("a settle that polls more than once retains the parse behind its final digest", async (t: LegacyTestValue) => {
  // A real quiet window: the last poll re-reads an unchanged source and does not
  // reparse it, so the retained entry has to be the parse from the poll that
  // last saw a change.
  const { client, driver } = makeDriver(t, { source_quiet_ms: 0, max_ms: 5000, initial_quiet_ms: 0 });
  await driver.start();
  assert.ok(client.counts.getPageSource >= 2, "a quiet window really polled more than once");
  const afterStart = client.counts.getPageSource;

  const snap = await driver.captureSnapshot(1);
  assert.equal(client.counts.getPageSource, afterStart, "the settled source is still reused");
  assert.equal(snap.text, textFor(SCREEN_A));
});
