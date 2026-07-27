// Web `back` verb execution (docs/contracts/engine.md#web-driver). The flat-schema redesign
// added `back` to the web driver; this locks the executor coupling the schema
// alone can't catch — execute() must route `back` to #run and #perform() must
// run page.goBack(), or the actor emits a verb the validator accepts but the
// driver can't run. Launches the real pinned-chromium driver against the todo
// app (a back from a distinct URL is a real cross-document navigation).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { start as startApp } from "../../fixtures/todo-app/server.ts";
import { WebDriver } from "../../../src/core/drivers/web.ts";

let app: LegacyTestValue;
let runDir: LegacyTestValue;

before(async () => {
  app = await startApp();
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-back-"));
});

after(async () => {
  if (app) await app.close().catch(() => {});
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

test("web `back` runs page.goBack(): ok, returns to the prior url, classified as a navigation", async () => {
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    const home = await driver.start(); // loads "/"
    assert.equal(home.ok, true);

    // A full document load to a distinct URL — the previous "/" becomes a
    // back-reachable history entry.
    const away = await driver.execute({ type: "navigate", url: "/?back-test=1" });
    assert.equal(away.ok, true);
    assert.match(away.url!, /\?back-test=1$/); // TODO(ts): successful navigation records its URL

    // Browser back: must succeed and return to the home url.
    const back = await driver.execute({ type: "back" });
    assert.equal(back.ok, true, back.error ?? "back failed");
    assert.equal(back.url, home.url, "back returns to the prior page");
    // `back` is perf-attributed as a navigation (nav block populated,
    // input-to-paint null) — locks the navigated-predicate edit.
    assert.notEqual(back.perf?.nav, null, "back is classified as a navigation");
    assert.equal(back.perf?.input_to_paint_ms, null);
  } finally {
    await driver.close();
  }
});

test("a custom radio fronted by a label records and replays a semantic role locator", async () => {
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  // The real-world design-system pattern (e.g. CommBank Lumen): the native
  // input is ZERO-SIZE, so both the replay visibility pre-check and
  // Playwright's click actionability reject it — the replay must redirect the
  // click to the visible label, exactly as the recorder did. (A 20px
  // opacity-0 input would pass isVisible and never exercise the redirection.)
  const markup = `
    <style>input[type=radio] { opacity: 0; width: 0; height: 0; }</style>
    <fieldset>
      <legend>Property type</legend>
      <label for="established"><input id="established" type="radio" name="property">Established dwelling</label>
      <label for="new"><input id="new" type="radio" name="property">New dwelling</label>
    </fieldset>`;
  try {
    await driver.start();
    await driver.page.setContent(markup);
    const snap = await driver.captureSnapshot(2);
    const ref = new RegExp(`\\[(e\\d+)\\] radio "Established dwelling"`).exec(snap.text)?.[1];
    assert.ok(ref, `custom radio was not surfaced through its label:\n${snap.text}`);

    const clicked: LegacyTestValue = await driver.execute({ type: "click", ref });
    assert.equal(clicked.ok, true, clicked.error ?? "custom radio click failed");
    assert.equal(clicked.resolution.locator, 'role=radio[name="Established dwelling"]');
    assert.equal(await driver.page.locator("#established").isChecked(), true);

    // The durable locator resolves the input rather than the temporary
    // ref-bearing label, and must remain executable after a fresh document.
    await driver.page.setContent(markup);
    const replayed = await driver.executeLocator({
      agent: { action: { type: "click", ref } },
      resolution: { locator: clicked.resolution.locator },
    });
    assert.equal(replayed.ok, true, replayed.error ?? "semantic radio replay failed");
    assert.equal(await driver.page.locator("#established").isChecked(), true);
    const finalState: LegacyTestValue = await driver.stopRecording();
    assert.match(finalState.text, /radio "Established dwelling" \(checked\)/,
      "post-action final evidence reflects the replayed click");
  } finally {
    await driver.close();
  }
});

test("landmarks are containers (a11y-text-v6): no ref, prose only, children keep theirs", async () => {
  // The v5 regression this pins: <header role="banner"> took a ref whose name
  // scooped up child labels (banner "Government Scheme Selector Close"),
  // shifting every ref after it whenever the serializer's landmark handling
  // changed. v6 demotes landmarks to prose (docs/contracts/engine.md#web-driver).
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    await driver.start();
    await driver.page.setContent(`
      <header role="banner"><span>Government Scheme Selector</span><button>Close</button></header>
      <main><h1>Are you applying alone?</h1></main>`);
    const snap = await driver.captureSnapshot(2);
    assert.doesNotMatch(snap.text, /\[e\d+\] (banner|main)\b/, "landmarks never receive refs");
    assert.match(snap.text, /text: "Government Scheme Selector"/, "landmark prose survives as a text line");
    assert.match(snap.text, /\[e1\] button "Close"/, "the first ref belongs to the first interactive child");
  } finally {
    await driver.close();
  }
});

// Ref'd scroll semantics (docs/contracts/engine.md#web-driver): the ref anchors
// the scroll; an inert chain (label-fronted radio card, heading) falls back to
// the page scroller instead of Element.scrollBy silently no-oping — the shape
// of the hobart run's 26 zero-movement scrolls against a below-fold option.
const TALL_CHOICE_PAGE = `
  <style>
    input[type=radio] { opacity: 0; width: 0; height: 0; }
    label { display: block; height: 66px; }
    h1 { height: 40px; }
  </style>
  <h1>Where are you looking to buy?</h1>
  <fieldset>
    <legend>State</legend>
    <label for="wa"><input id="wa" type="radio" name="state">Western Australia</label>
  </fieldset>
  <div style="height: 3000px"></div>
  <label for="tas"><input id="tas" type="radio" name="state">Tasmania</label>`;

test("a ref'd scroll on a non-scrollable option card still scrolls the page", async () => {
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    await driver.start();
    await driver.page.setContent(TALL_CHOICE_PAGE);
    const snap = await driver.captureSnapshot(2);
    const ref = /\[(e\d+)\] radio "Western Australia"/.exec(snap.text)?.[1];
    assert.ok(ref, `radio was not surfaced through its label:\n${snap.text}`);

    const scrolled = await driver.execute({ type: "scroll", ref, direction: "down" });
    assert.equal(scrolled.ok, true, scrolled.error ?? "ref'd scroll failed");
    assert.ok(await driver.page.evaluate(() => window.scrollY) > 0,
      "the page scrolled even though the ref chain is inert");
  } finally {
    await driver.close();
  }
});

test("a replayed ref'd scroll anchored to a hidden custom radio still scrolls", async () => {
  // The sydney run's step-19 heal: record anchored a scroll on a label-fronted
  // radio, so the durable locator resolves the ZERO-SIZE native input. Replay's
  // visibility pre-check must not reject it — the ref only anchors the nearest
  // scrollable ancestor, which the hidden input shares with its visible label.
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    await driver.start();
    await driver.page.setContent(TALL_CHOICE_PAGE);
    const snap = await driver.captureSnapshot(2);
    const ref = /\[(e\d+)\] radio "Western Australia"/.exec(snap.text)?.[1];
    assert.ok(ref, `radio was not surfaced through its label:\n${snap.text}`);
    const recorded: LegacyTestValue = await driver.execute({ type: "scroll", ref, direction: "down" });
    assert.equal(recorded.ok, true, recorded.error ?? "recorded scroll failed");
    assert.equal(recorded.resolution.locator, 'role=radio[name="Western Australia"]');

    await driver.page.setContent(TALL_CHOICE_PAGE);
    const replayed = await driver.executeLocator({
      agent: { action: { type: "scroll", ref, direction: "down" } },
      resolution: { locator: recorded.resolution.locator },
    });
    assert.equal(replayed.ok, true, replayed.error ?? "replayed ref'd scroll failed");
    assert.ok(await driver.page.evaluate(() => window.scrollY) > 0,
      "the replayed scroll moved the page from the hidden-input anchor");
  } finally {
    await driver.close();
  }
});

test("a ref'd scroll on a heading scrolls the page (not radio-specific)", async () => {
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    await driver.start();
    await driver.page.setContent(TALL_CHOICE_PAGE);
    const snap = await driver.captureSnapshot(2);
    const ref = /\[(e\d+)\] heading "Where are you looking to buy\?"/.exec(snap.text)?.[1];
    assert.ok(ref, `heading carries no ref:\n${snap.text}`);

    const scrolled = await driver.execute({ type: "scroll", ref, direction: "down" });
    assert.equal(scrolled.ok, true, scrolled.error ?? "heading-anchored scroll failed");
    assert.ok(await driver.page.evaluate(() => window.scrollY) > 0,
      "the page scrolled from a heading anchor");
  } finally {
    await driver.close();
  }
});

test("a ref inside a scrollable container scrolls the container, not the page", async () => {
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    await driver.start();
    await driver.page.setContent(`
      <div id="list" style="overflow: auto; height: 200px">
        <button id="first">First option</button>
        <div style="height: 2000px"></div>
        <button>Last option</button>
      </div>
      <div style="height: 3000px"></div>`);
    const snap = await driver.captureSnapshot(2);
    const ref = /\[(e\d+)\] button "First option"/.exec(snap.text)?.[1];
    assert.ok(ref, `button carries no ref:\n${snap.text}`);

    const scrolled = await driver.execute({ type: "scroll", ref, direction: "down" });
    assert.equal(scrolled.ok, true, scrolled.error ?? "container-anchored scroll failed");
    const { inner, page } = await driver.page.evaluate(() => ({
      inner: document.querySelector("#list")!.scrollTop, // TODO(ts): test markup always contains #list
      page: window.scrollY,
    }));
    assert.ok(inner > 0, "the enclosing scrollable container moved");
    assert.equal(page, 0, "the page itself did not move");
  } finally {
    await driver.close();
  }
});
