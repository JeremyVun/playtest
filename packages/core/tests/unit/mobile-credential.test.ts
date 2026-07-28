// The external-Appium credential seam (docs/contracts/engine.md#mobile-driver).
//
// The property under test is a boundary, not a feature: a credential for an
// Appium somebody else runs must reach the WebDriver client and appear NOWHERE
// else — not in the resolved environment, not in the capabilities the driver
// pins, not in a manifest, not in an error. It is therefore a local-only driver
// input read from the process environment (a file path, or the value), and
// never a configuration key a runtime target or a recorded shape could carry.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MobileDriver, appiumCredentialOptions, capabilitiesFor, __setMobileClientFactory } from "../../src/drivers/mobile.ts";

const ENV_KEYS = ["PLAYTEST_APPIUM_CREDENTIAL", "PLAYTEST_APPIUM_CREDENTIAL_FILE"];

/** Run `body` with only these Appium credential variables set. */
async function withEnv(vars: Record<string, string>, body: () => Promise<void> | void) {
  const before = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of before) if (v !== undefined) process.env[k] = v;
  }
}

/** A WebDriver client that records how it was constructed and does nothing else. */
function recordingClient(seen: LegacyTestValue[]) {
  return async (opts: LegacyTestValue) => {
    seen.push(opts);
    return {
      getPageSource: async () => "<XCUIElementTypeApplication name='Todo'></XCUIElementTypeApplication>",
      getWindowSize: async () => ({ width: 390, height: 844 }),
      getAlertText: async () => { throw new Error("no alert"); },
      takeScreenshot: async () => null,
      deleteSession: async () => {},
    } as LegacyTestValue;
  };
}

test("mobile credential: a user:key value becomes WebDriver basic auth, a bare value a bearer token", () => {
  assert.deepEqual(appiumCredentialOptions({ PLAYTEST_APPIUM_CREDENTIAL: "alice:hunter2" }), { user: "alice", key: "hunter2" });
  assert.deepEqual(appiumCredentialOptions({ PLAYTEST_APPIUM_CREDENTIAL: "grid-token" }), {
    headers: { Authorization: "Bearer grid-token" },
  });
  assert.deepEqual(appiumCredentialOptions({}), {}, "no credential is the normal case — a managed Appium wants none");
  assert.deepEqual(appiumCredentialOptions({ PLAYTEST_APPIUM_CREDENTIAL: "   " }), {});
});

test("mobile credential: a file is read, is preferred over a value, and an unreadable one is simply no credential", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appium-cred-"));
  try {
    const file = path.join(dir, "grid.credential");
    fs.writeFileSync(file, "alice:hunter2\n");
    assert.deepEqual(appiumCredentialOptions({ PLAYTEST_APPIUM_CREDENTIAL_FILE: file }), { user: "alice", key: "hunter2" });
    assert.deepEqual(
      appiumCredentialOptions({ PLAYTEST_APPIUM_CREDENTIAL_FILE: file, PLAYTEST_APPIUM_CREDENTIAL: "other" }),
      { user: "alice", key: "hunter2" },
      "the file wins: it is the form that keeps the value out of every process environment",
    );
    assert.deepEqual(
      appiumCredentialOptions({ PLAYTEST_APPIUM_CREDENTIAL_FILE: path.join(dir, "gone") }),
      {},
      "a stale path must not block an Appium that wants no credential",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mobile credential: the client factory receives it, and nothing the driver records does", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appium-cred-run-"));
  const runDir = path.join(dir, "run");
  const file = path.join(dir, "grid.credential");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(file, "alice:hunter2\n");
  const seen: LegacyTestValue[] = [];
  __setMobileClientFactory(recordingClient(seen));
  t.after(() => {
    __setMobileClientFactory(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const env = { driver: "mobile", platform: "ios", app: "/builds/Todo.app", device: "iPhone 16", appium_url: "http://grid.example.com:4723" };
  let started: LegacyTestValue = null;
  await withEnv({ PLAYTEST_APPIUM_CREDENTIAL_FILE: file }, async () => {
    const driver = await MobileDriver.launch({ env: env as LegacyTestValue, runDir });
    started = await driver.start();
    assert.equal(started.ok, true, started.error ?? "start failed");
    await driver.close();
  });

  // One session for one case — the factory is entered exactly once.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].user, "alice", "the credential reaches the WebDriver client");
  assert.equal(seen[0].key, "hunter2");
  assert.equal(seen[0].hostname, "grid.example.com", "and the address is still the address");

  // …and appears in nothing the driver records or resolves. The capabilities are
  // the shape that rides manifest pins and error text.
  const caps = capabilitiesFor(env as LegacyTestValue);
  assert.equal(JSON.stringify(caps).includes("hunter2"), false);
  assert.equal(JSON.stringify(env).includes("hunter2"), false, "the resolved environment is credential-free by construction");
  assert.equal(JSON.stringify(started).includes("hunter2"), false, "and so is everything start() returns");
  for (const entry of fs.readdirSync(path.join(runDir, "steps"), { recursive: true }) as string[]) {
    const abs = path.join(runDir, "steps", String(entry));
    if (!fs.statSync(abs).isFile()) continue;
    assert.equal(fs.readFileSync(abs, "utf8").includes("hunter2"), false, `${entry} carries no credential`);
  }
});
