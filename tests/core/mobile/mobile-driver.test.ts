// The mobile driver against a REAL Appium/XCUITest session
// (docs/contracts/engine.md#mobile-driver) — the device-tier analog of
// tests/core/browser. Everything else about this driver is exercised offline
// through the __setMobileClientFactory fake-client seam; this suite is the only
// place a real Appium server, a real iOS Simulator, and a real app meet it, so it
// drives MobileDriver exactly as the runner does: launch → start → captureSnapshot
// → execute(ref) → captureSnapshot.
//
// Opt-in tier, never part of `npm test` or `npm run test:all`: `npm run test:mobile`.
// It is NOT loaded with tests/support/hermetic.ts — that bootstrap exports its
// --import through NODE_OPTIONS into every child node process, which here would
// include the Appium server we spawn, wrapping a third-party server's fetch in our
// test guard. This suite talks only to 127.0.0.1 and never needs model credentials.
//
// One-time setup on a new machine (Xcode + an iOS Simulator runtime required):
//   npm install
//   APPIUM_HOME="$HOME/.appium" npx appium driver install xcuitest
//
// Timing note: the first session ever created on a machine also builds
// WebDriverAgent (~1.5 min here), inside webdriverio's own session-create timeout.
// If that very first run times out, rerun — the build is cached from then on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MobileDriver } from "../../../src/core/drivers/mobile.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../fixtures/todo-app-swiftui");
// Off Appium's default 4723 so a server someone left running is never mistaken
// for ours (and never inherits our simulator).
const PORT = 4823;
const APPIUM_URL = `http://127.0.0.1:${PORT}`;
// Where the xcuitest driver lives. Appium 2+/3 otherwise treats a project-local
// `appium` dependency as its home and installs drivers INTO this repo's
// package.json + node_modules (138 MB of iOS-only driver for every `npm install`,
// on every platform), so the suite pins the shared per-user home instead.
const APPIUM_HOME = process.env.APPIUM_HOME || path.join(os.homedir(), ".appium");
const DEVICE = process.env.PLAYTEST_MOBILE_DEVICE || "iPhone 16";

const SEEDS = [
  { id: 1, title: "Buy milk", state: "active" },
  { id: 2, title: "Walk the dog", state: "active" },
  { id: 3, title: "Write the report", state: "completed" },
];
const ADDED_TITLE = "Ship the release";

let server: LegacyTestValue = null;
let driver: LegacyTestValue = null;
let runDir: LegacyTestValue = null;
let appPath = null;
let preexistingSims = new Set();
let step = 0;

/** captureSnapshot with the runner's monotonically increasing step numbering. */
const snapshot = () => driver.captureSnapshot(++step);
const stepFile = (n: LegacyTestValue, ext: LegacyTestValue) => path.join(runDir, "steps", `${String(n).padStart(3, "0")}.${ext}`);
/**
 * The [eN] ref of the line whose rendered name is exactly `name`, or null.
 * Rendered names are HUMAN text (the fixture's accessibility labels — "Buy
 * milk", "Add", "Delete Buy milk"), never the identifiers those elements also
 * carry; the identifier surfaces as the durable locator instead
 * (docs/contracts/engine.md#mobile-driver).
 */
const refFor = (name: LegacyTestValue, text: LegacyTestValue) => new RegExp(`\\[(e\\d+)\\] \\w+ "${name}"`).exec(text)?.[1] ?? null;
const iosPredicate = (q: LegacyTestValue) => `-ios predicate string:${q}`;
/** The rendered row line for a todo title, e.g. `[e3] button "Buy milk" (completed)`. */
const rowLine = (title: LegacyTestValue, state: LegacyTestValue) => new RegExp(`\\[e\\d+\\] button "${title}" \\(${state}\\)`);

/**
 * A todo's completion state, read through the driver's PUBLIC gate surface
 * (finalPageCheck — what a screen_shows gate uses). The snapshot text now shows
 * this state too (asserted directly in the toggle test); these predicates keep
 * the second, independent reading — they query the device by identifier rather
 * than parsing what we rendered, so a renderer bug cannot make them agree.
 * `source` picks which of the fixture's two state surfaces the assertion reads.
 */
async function todoState(id: LegacyTestValue, source = "row") {
  const attr = source === "row" ? `name == 'todo-row-${id}' AND value` : `name == 'todo-status-${id}' AND label`;
  for (const state of ["active", "completed"]) {
    if (await driver.finalPageCheck(iosPredicate(`${attr} == '${state}'`))) return state;
  }
  return null;
}

function bootedSimulators() {
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "booted"], { encoding: "utf8" });
    return new Set([...out.matchAll(/\(([0-9A-F-]{36})\) \(Booted\)/g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

/**
 * Fail fast with ONE actionable message. This tier is an explicit opt-in, so a
 * missing prerequisite is an error, never a silent skip.
 */
function preflight() {
  const need = (cond: LegacyTestValue, what: LegacyTestValue, fix: LegacyTestValue) => {
    if (!cond) throw new Error(`mobile tests need ${what} — ${fix}`);
  };
  need(process.platform === "darwin", "macOS with Xcode (iOS Simulator)", `this host is ${process.platform}; run this suite on a Mac`);
  let simctlOk = true;
  try {
    execFileSync("xcrun", ["simctl", "list", "devices", "available"], { stdio: "ignore" });
  } catch {
    simctlOk = false;
  }
  need(simctlOk, "a working Xcode command-line toolchain", "install Xcode and run: xcode-select --install");

  const require_ = createRequire(import.meta.url);
  let appiumEntry: LegacyTestValue = null;
  try {
    appiumEntry = path.join(path.dirname(require_.resolve("appium/package.json")), "index.js");
  } catch {}
  need(appiumEntry && fs.existsSync(appiumEntry), "the appium server (a devDependency)", "run: npm install");

  let installed = "";
  try {
    installed = execFileSync(process.execPath, [appiumEntry, "driver", "list", "--installed", "--json"], {
      encoding: "utf8",
      env: { ...process.env, APPIUM_HOME },
      timeout: 120_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  let hasXcuitest = false;
  try {
    hasXcuitest = Boolean(JSON.parse(installed).xcuitest);
  } catch {}
  need(hasXcuitest, `the appium xcuitest driver in APPIUM_HOME (${APPIUM_HOME})`,
    `run once: APPIUM_HOME="${APPIUM_HOME}" npx appium driver install xcuitest`);

  return appiumEntry;
}

async function waitForServer(timeoutMs: LegacyTestValue) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${APPIUM_URL}/status`);
      if (res.ok) return;
    } catch {}
    if (server?.exitCode != null) throw new Error(`the appium server exited (code ${server.exitCode}) before answering /status`);
    if (Date.now() > deadline) throw new Error(`the appium server did not answer ${APPIUM_URL}/status within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  const appiumEntry = preflight();
  // webdriverio is an optionalDependency the driver lazy-imports; a missing one
  // must read as this suite's setup problem, not a MODULE_NOT_FOUND mid-session.
  try {
    await import("webdriverio");
  } catch {
    throw new Error("mobile tests need the 'webdriverio' package — run: npm install");
  }

  // The fixture prints the absolute path of the built .app as its last stdout line.
  const built = execFileSync(path.join(FIXTURE_DIR, "build.sh"), { encoding: "utf8", timeout: 600_000 });
  appPath = built.trim().split("\n").pop()!.trim(); // SAFETY: fixture build prints the app path as its last line
  assert.ok(appPath && fs.existsSync(appPath), `the SwiftUI fixture build produced no .app:\n${built}`);

  preexistingSims = bootedSimulators();
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-mobile-"));

  server = spawn(process.execPath, [appiumEntry, "--port", String(PORT), "--address", "127.0.0.1", "--log-level", "error"], {
    env: { ...process.env, APPIUM_HOME },
    stdio: ["ignore", "ignore", "inherit"],
  });
  server.once("error", (e: LegacyTestValue) => {
    throw new Error(`could not spawn the appium server: ${e.message}`);
  });
  await waitForServer(120_000);

  driver = await MobileDriver.launch({
    env: { platform: "ios", app: appPath, device: DEVICE, appium_url: APPIUM_URL } as LegacyTestValue, // SAFETY: focused fixture supplies only launch-relevant environment fields
    runDir,
  });
});

after(async () => {
  if (driver) await driver.close().catch(() => {});
  if (server && server.exitCode == null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000).unref?.())]);
    if (server.exitCode == null) server.kill("SIGKILL");
  }
  // Shut down only the simulators this run booted.
  for (const udid of bootedSimulators()) {
    if (preexistingSims.has(udid)) continue;
    try {
      execFileSync("xcrun", ["simctl", "shutdown", udid as string], { stdio: "ignore" }); // SAFETY: simulator discovery returns UDID strings
    } catch {}
  }
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

// The tests below share ONE session on purpose — creating an XCUITest session is
// by far the most expensive thing here (tens of seconds) — so they run in order
// and each builds on the state the previous one left.

test("start() launches the app and the first snapshot carries the seed todos", async () => {
  const started = await driver.start();
  assert.equal(started.ok, true, started.error ?? "start failed");
  assert.equal(started.perf, null, "mobile v1 records no perf");
  assert.deepEqual(started.network.requests, [], "mobile v1 records no network");
  assert.ok(started.settle_ms >= 0);
  assert.ok(driver.viewport?.width > 0 && driver.viewport?.height > 0, "the device window size is pinned as the viewport");

  const snap = await snapshot();
  assert.match(snap.text, /^Screen: \S/, "the snapshot opens with a screen header");
  for (const seed of SEEDS) {
    // A row reads as its TITLE plus its state, not as `todo-row-<id>`: the
    // fixture sets both an identifier and a human label on every row, and the
    // label is what the actor must see.
    assert.ok(refFor(seed.title, snap.text), `the row for "${seed.title}" is missing from:\n${snap.text}`);
    assert.match(snap.text, rowLine(seed.title, seed.state), `"${seed.title}" does not render its state in:\n${snap.text}`);
    assert.ok(refFor(`Delete ${seed.title}`, snap.text), `the delete button for "${seed.title}" is missing from:\n${snap.text}`);
    assert.match(snap.text, new RegExp(`text: ${JSON.stringify(seed.title)}`), `"${seed.title}" is missing from:\n${snap.text}`);
    // Both of the fixture's state surfaces agree, and match the documented seeds.
    assert.equal(await todoState(seed.id, "row"), seed.state, `todo ${seed.id} row value`);
    assert.equal(await todoState(seed.id, "status"), seed.state, `todo ${seed.id} status text`);
  }
  // No identifier leaks into the text the actor reads — the mobile analog of
  // never rendering data-testid as a web accessible name.
  assert.doesNotMatch(snap.text, /"(todo-row-|todo-status-|delete-|app-title|remaining-count)/,
    `an accessibility identifier leaked into the rendered snapshot:\n${snap.text}`);
  assert.match(snap.text, /text: "Playtest Todos"/, "the title label renders its words");
  assert.match(snap.text, /text: "2 remaining"/, "the remaining count renders its words");
  // `todo-input` is the one element with NO human label (iOS reports label="" for
  // a TextField), so it legitimately falls back to its identifier.
  assert.ok(refFor("todo-input", snap.text) && refFor("Add", snap.text), "the input and Add button are addressable");

  // Refs are [eN]-shaped and numbered densely from e1 in document order
  // (mobile-snapshot.ts), which is what the actor's ref contract promises.
  const refs = [...snap.text.matchAll(/\[(e\d+)\]/g)].map((m) => m[1]);
  assert.ok(refs.length >= 8, `expected the seeded screen to surface refs:\n${snap.text}`);
  assert.deepEqual(refs, refs.map((_, i) => `e${i + 1}`));
  assert.equal(snap.refCount, refs.length);
  assert.equal(snap.truncated, false);
});

test("tapping a todo row toggles its completion state", async () => {
  const before_ = await snapshot();
  assert.match(before_.text, rowLine("Buy milk", "active"));
  const ref = refFor("Buy milk", before_.text);
  const tapped = await driver.execute({ type: "tap", ref });
  assert.equal(tapped.ok, true, tapped.error ?? "tap failed");
  // Rendered by label, resolved by identifier: the durable locator the baseline
  // replays is still the id, even though the actor read "Buy milk".
  assert.equal(tapped.resolution.locator, "~todo-row-1", "a unique accessibility id becomes the durable locator");

  const after_ = await snapshot();
  // The toggle is VISIBLE to the actor: the state moved in the rendered text, so
  // drift and effectToken see a real effect rather than a no-op. This was the
  // ax-tree-v6 gap — a real flip produced a byte-identical snapshot.
  assert.notEqual(after_.text, before_.text, `the toggle left the snapshot unchanged:\n${after_.text}`);
  assert.match(after_.text, rowLine("Buy milk", "completed"), `the tapped row does not read as completed:\n${after_.text}`);
  assert.doesNotMatch(after_.text, rowLine("Buy milk", "active"));
  assert.match(after_.text, rowLine("Walk the dog", "active"), "the untapped rows still read active");
  // The sibling status StaticText renders its words, not `todo-status-1`, and the
  // header count follows the same edit.
  assert.match(after_.text, /text: "completed"/, `the status text is not human-readable:\n${after_.text}`);
  assert.match(after_.text, /text: "1 remaining"/);
  // Independent confirmation from the device itself (see todoState).
  assert.equal(await todoState(1, "row"), "completed", "the tapped row flipped");
  assert.equal(await todoState(1, "status"), "completed", "the sibling status text agrees");
  assert.equal(await todoState(2, "row"), "active", "the untapped rows are unchanged");
});

test("typing into the input and tapping Add appends a row", async () => {
  const before_ = await snapshot();
  const typed = await driver.execute({ type: "type", ref: refFor("todo-input", before_.text), text: ADDED_TITLE });
  assert.equal(typed.ok, true, typed.error ?? "type failed");
  assert.equal(typed.resolution.locator, "~todo-input");

  const filled = await snapshot();
  assert.match(filled.text, new RegExp(`\\[e\\d+\\] textfield "todo-input" value=${JSON.stringify(ADDED_TITLE)}`),
    `the typed text is not in the field:\n${filled.text}`);

  // The fixture's return key only dismisses the keyboard; Add is the only way in.
  const added = await driver.execute({ type: "tap", ref: refFor("Add", filled.text) });
  assert.equal(added.ok, true, added.error ?? "add failed");

  const after_ = await snapshot();
  assert.ok(refFor(ADDED_TITLE, after_.text), `the new row is missing from:\n${after_.text}`);
  assert.match(after_.text, rowLine(ADDED_TITLE, "active"), "a new todo renders as active");
  assert.match(after_.text, new RegExp(`text: ${JSON.stringify(ADDED_TITLE)}`));
  assert.equal(await todoState(4, "row"), "active", "a new todo starts active");
  assert.match(after_.text, /\[e\d+\] textfield "todo-input" value="New todo"/, "the input is cleared back to its placeholder");
});

test("deleting one todo removes only that row, and identifiers stay id-based", async () => {
  const before_ = await snapshot();
  const survivors: LegacyTestValue = { 1: "Buy milk", 3: "Write the report", 4: ADDED_TITLE };
  const refsBefore: LegacyTestValue = Object.fromEntries(Object.entries(survivors).map(([id, title]) => [id, refFor(title, before_.text)]));

  const deleted = await driver.execute({ type: "tap", ref: refFor("Delete Walk the dog", before_.text) });
  assert.equal(deleted.ok, true, deleted.error ?? "delete failed");
  assert.equal(deleted.resolution.locator, "~delete-2");

  const after_ = await snapshot();
  assert.equal(refFor("Walk the dog", after_.text), null, `the deleted row survived:\n${after_.text}`);
  assert.equal(refFor("Delete Walk the dog", after_.text), null, "its delete button went with it");
  assert.doesNotMatch(after_.text, /text: "Walk the dog"/);
  for (const [id, title] of Object.entries(survivors)) {
    assert.ok(refFor(title, after_.text), `the row for "${title}" should have survived:\n${after_.text}`);
    assert.ok(refFor(`Delete ${title}`, after_.text), `the delete button for "${title}" should have survived`);
  }
  // Identifiers are id-based, not position-based: row 3 and row 4 moved UP a slot
  // (their volatile [eN] refs shrank) while their identifiers — and so their
  // durable locators — did not change. That is what makes an act-mode replay of
  // `~todo-row-3` still mean the same todo after an unrelated row disappears.
  for (const id of [3, 4]) {
    const now: LegacyTestValue = refFor(survivors[id], after_.text);
    assert.notEqual(now, refsBefore[id], `ref for todo-row-${id} should renumber after the delete`);
    assert.ok(Number(now.slice(1)) < Number(refsBefore[id].slice(1)), `todo-row-${id} moved up the screen`);
  }
});

test("an executed step carries the recording surface the trajectory contract needs", async () => {
  const snap = await snapshot();
  const acted = await driver.execute({ type: "tap", ref: refFor("Write the report", snap.text) });
  assert.equal(acted.ok, true, acted.error ?? "tap failed");

  // A durable, identifier-based locator — unchanged by the delete two rows above,
  // which is exactly what act mode replays.
  assert.equal(acted.resolution.locator, "~todo-row-3");
  // A bbox in device POINTS for the viewer's ghost cursor, inside the screen.
  const { x, y, w, h } = acted.resolution.bbox;
  for (const n of [x, y, w, h]) assert.ok(Number.isInteger(n), `bbox values are rounded integers, got ${n}`);
  assert.ok(w > 0 && h > 0, "the bbox has area");
  assert.ok(x >= 0 && y >= 0 && x + w <= driver.viewport.width && y + h <= driver.viewport.height, "the bbox sits on screen");
  // Mobile v1: no network capture, no perf (docs/contracts/engine.md#mobile-driver).
  assert.deepEqual(acted.network.requests, []);
  assert.deepEqual(acted.har_entries, []);
  assert.equal(acted.perf, null);
  assert.ok(acted.settle_ms >= 0);

  // The step artifacts are real files: a PNG screenshot plus the snapshot text.
  const after_ = await snapshot();
  const png = stepFile(step, "png");
  assert.ok(fs.existsSync(png), `no screenshot at ${png}`);
  assert.deepEqual([...fs.readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "the step screenshot is a PNG");
  assert.equal(fs.readFileSync(stepFile(step, "a11y.txt"), "utf8"), after_.text + "\n");
  assert.ok(fs.existsSync(stepFile(step, "pw-a11y.txt")), "the debug native page-source tree is written beside it");
  assert.equal(after_.screenshotHash, null, "visual regression is a web-only seam");
});
