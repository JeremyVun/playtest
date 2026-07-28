// Post-claim mobile preflight and the runtime target it clears the way for.
//
// Two properties are load-bearing and both are asserted here rather than
// assumed: the failure a person sees on the run page carries a REMEDY and no
// physical fact, and the preflight creates no Appium session — so a one-case
// group creates exactly one, the case's own.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mobileRuntimeTarget, preflightMobile } from "../../src/mobile.ts";
import { requireMobileBinding, resolveHostedBudget } from "../../src/exec-group.ts";
import type { AppiumHandle } from "../../src/appium.ts";
import type { AppiumBackend, MobileBinding } from "../../src/runner-config.ts";

const APP = path.join(os.tmpdir(), "playtest-preflight-fixture.app");

const backend = (over: Partial<AppiumBackend> = {}): AppiumBackend => ({
  name: "local-ios",
  platform: "ios",
  mode: "managed",
  url: null,
  credentialFile: null,
  credentialEnv: null,
  ...over,
});

const binding = (over: Partial<MobileBinding> = {}): MobileBinding => ({
  projectKey: null,
  applicationKey: "todo-ios",
  ringKey: "local",
  platform: "ios",
  app: APP,
  backend: backend(),
  device: "iPhone 16",
  ...over,
});

const handle = (over: Partial<AppiumHandle> = {}): AppiumHandle => ({
  name: "local-ios",
  url: "http://127.0.0.1:4999",
  credentialEnv: {},
  died: () => null,
  close: async () => {},
  ...over,
});

/** Everything present and answering. */
const healthy = { exists: () => true, probeClient: async () => {}, statusOk: async () => true };

test("mobile preflight: everything present clears the way, and no step of it creates a session", async () => {
  const calls: string[] = [];
  const failure = await preflightMobile(binding(), handle(), {
    exists: () => (calls.push("exists"), true),
    // The client probe is an IMPORT probe and nothing more (core owns it):
    // creating a session installs and launches the app, so a viability session
    // would run the install/wipe/launch dance twice and collide with
    // preserve_session. The case's own launch is the final boundary.
    probeClient: async () => void calls.push("probeClient"),
    statusOk: async () => (calls.push("statusOk"), true),
    installedDrivers: async () => (calls.push("installedDrivers"), ["xcuitest"]),
  });
  assert.equal(failure, null);
  // The whole of preflight, enumerated: a stat, an import, an HTTP GET, and a
  // driver list. Nothing here can create an Appium session, which is why a
  // one-case group creates exactly one — the case's own.
  assert.deepEqual(calls, ["exists", "probeClient", "statusOk", "installedDrivers"]);
});

test("mobile preflight: a build that is not on this disk is one actionable error, with the path only in the local log", async () => {
  const failure = (await preflightMobile(binding(), handle(), { ...healthy, exists: () => false }))!;
  assert.ok(failure);
  assert.match(failure.error, /the app build this runner binds to "todo-ios\/local" is not on the runner's disk/);
  assert.match(failure.error, /targets\.todo-ios\.local\.app/, "the remedy names the config key to fix");
  assert.equal(failure.error.includes(APP), false, "a build path never crosses to the platform");
  assert.equal(failure.error.includes("iPhone 16"), false, "and neither does a device");
  assert.match(failure.detail, new RegExp(APP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the runner's own log is where the path belongs");
});

test("mobile preflight: an Appium that is not answering, and a driver that is not installed, each name their remedy", async () => {
  const silent = (await preflightMobile(binding(), handle(), { ...healthy, statusOk: async () => false }))!;
  assert.match(silent.error, /the Appium backend "local-ios" this runner is configured with is not answering/);
  assert.match(silent.error, /mobile\.backends\.local-ios/);
  assert.equal(silent.error.includes("127.0.0.1:4999"), false, "an Appium endpoint is a machine-local fact too");
  assert.match(silent.detail, /http:\/\/127\.0\.0\.1:4999\/status/);

  const noDriver = (await preflightMobile(binding(), handle(), { ...healthy, installedDrivers: async () => [] }))!;
  assert.equal(noDriver.error, `the Appium "xcuitest" driver is not installed on this runner — run: appium driver install xcuitest`);

  const android = (await preflightMobile(binding({ platform: "android" }), handle(), { ...healthy, installedDrivers: async () => ["xcuitest"] }))!;
  assert.match(android.error, /appium driver install uiautomator2/);
});

test("mobile preflight: a missing Appium client is reported as this runner's problem, not a MODULE_NOT_FOUND", async () => {
  const failure = (await preflightMobile(binding(), handle(), {
    ...healthy,
    probeClient: async () => {
      throw new Error("the mobile driver needs the Appium client. Run: npm i webdriverio\n  at deep/inside.ts:1:1");
    },
  }))!;
  assert.match(failure.error, /this runner cannot drive a mobile case: the mobile driver needs the Appium client/);
  assert.equal(failure.error.includes("deep/inside.ts"), false, "one actionable line, never a stack");
});

test("mobile runtime target: binding plus backend, with an omitted device left omitted", () => {
  assert.deepEqual(mobileRuntimeTarget(binding(), handle()), {
    app: APP,
    platform: "ios",
    appium_url: "http://127.0.0.1:4999",
    device: "iPhone 16",
  });
  // Core replaces the whole physical target, so an absent key means Appium's
  // default — never the device the suite happened to author.
  assert.deepEqual(mobileRuntimeTarget(binding({ device: null }), handle()), {
    app: APP,
    platform: "ios",
    appium_url: "http://127.0.0.1:4999",
  });
});

test("mobile execution: a group is serial per backend whatever the suite's parallel says", () => {
  assert.deepEqual(
    resolveHostedBudget([{ id: "a", parallel: { total: 6, record: 3 } }], { total: 6, record: 2 }, 4, { serial: true }),
    { total: 1, record: 1, grade: 1, cpu: 1 },
    "two concurrent cases cannot share a simulator",
  );
  assert.deepEqual(
    resolveHostedBudget([{ id: "a", parallel: { total: 6, record: 3 } }], { total: 6, record: 2 }, 4),
    { total: 6, record: 3, grade: 3, cpu: 6 },
    "web and API are unaffected",
  );
});

test("mobile execution: the binding is required, the platform must agree, and containers are refused", () => {
  const config = { path: "/tmp/runner.yaml", labels: null, backends: new Map(), bindings: [binding()] };
  const spec = {
    project: { key: "acme" },
    application: { key: "todo-ios", driver: "mobile", platform: "ios" },
    ring: { key: "local" },
  };
  assert.equal(requireMobileBinding(spec, { isolation: "process", config }).applicationKey, "todo-ios");
  assert.throws(
    () => requireMobileBinding(spec, { isolation: "container", config }),
    /this runner runs cases in containers, and a mobile case cannot/,
  );
  assert.throws(
    () => requireMobileBinding(spec, { isolation: "process", config: null }),
    /no configuration binding for the mobile target "todo-ios\/local"/,
  );
  assert.throws(
    () => requireMobileBinding({ ...spec, application: { ...spec.application, platform: "android" } }, { isolation: "process", config }),
    /binds the mobile target "todo-ios\/local" to ios, but that application is android/,
  );
});

test("mobile preflight: the real filesystem check is the default, so a fixture path decides it", async () => {
  fs.mkdirSync(APP, { recursive: true });
  try {
    assert.equal(await preflightMobile(binding(), handle(), { probeClient: async () => {}, statusOk: async () => true }), null);
  } finally {
    fs.rmSync(APP, { recursive: true, force: true });
  }
  const gone = await preflightMobile(binding(), handle(), { probeClient: async () => {}, statusOk: async () => true });
  assert.match(gone!.error, /is not on the runner's disk/);
});
