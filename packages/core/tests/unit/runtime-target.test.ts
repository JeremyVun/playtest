// The runtime target (docs/contracts/engine.md#runtime-target): the one
// resolution input a PLACING host owns. It lands after the complete authored
// merge — defaults chain, case file, --env overlay — and it is a whole-target
// REPLACEMENT discriminated by driver, not a patch: a field it omits is
// cleared, not inherited, so a suite can never redirect a placed run at
// something the placer did not choose.
//
// Pure config: no browser, no device, no model. Resolution runs in-process
// through discoverCases, exactly as the CLI and any host call it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases, DummyConfigError, normalizeRuntimeTarget } from "../../src/config.ts";
import type { RuntimeTarget } from "../../src/types.ts";

let tmpRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-runtime-target-"));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let suiteSeq = 0;

/** Write an inline suite from { "name.yaml": "content", ... }; returns its dir. */
function writeSuite(files: Record<string, string>): string {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

const STORY = "story: |\n  Add a todo.\n";

/** The single resolved case's env, resolved with whatever options are given. */
async function envOf(dir: string, opts: Parameters<typeof discoverCases>[1] = {}): Promise<LegacyTestValue> {
  const [rc] = await discoverCases([dir], opts);
  assert.ok(rc, "expected exactly one resolved case");
  return rc.env as LegacyTestValue;
}

const RING: RuntimeTarget = { base_url: "http://ring.internal:4173" };

// ---------- whole-target replacement at every authoring level ----------

test("the override replaces a base_url authored in the defaults chain", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://authored.example\n",
    "add-todo.yaml": STORY,
  });
  assert.equal((await envOf(dir)).base_url, "http://authored.example");
  assert.equal((await envOf(dir, { runtimeTarget: RING })).base_url, RING.base_url);
});

test("the override replaces a base_url authored in the selected --env overlay", async () => {
  const dir = writeSuite({
    "playtest.yaml":
      "app:\n  base_url: http://authored.example\n  envs:\n    staging:\n      base_url: http://staging.example\n",
    "add-todo.yaml": STORY,
  });
  assert.equal((await envOf(dir, { env: "staging" })).base_url, "http://staging.example");
  const env = await envOf(dir, { env: "staging", runtimeTarget: RING });
  assert.equal(env.base_url, RING.base_url);
  // the overlay is still SELECTED (its logical keys and its name survive) — only
  // the physical field was replaced.
  assert.equal(env.env_name, "staging");
});

test("the override replaces a base_url authored in the case file itself", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://authored.example\n",
    "add-todo.yaml": `${STORY}app:\n  base_url: http://case.example\n`,
  });
  assert.equal((await envOf(dir)).base_url, "http://case.example");
  assert.equal((await envOf(dir, { runtimeTarget: RING })).base_url, RING.base_url);
});

// ---------- clearing, not inheriting ----------

test("a physical field the override omits is CLEARED, never inherited", async () => {
  const dir = writeSuite({
    "playtest.yaml":
      "app:\n  driver: mobile\n  platform: ios\n  app: ./Authored.app\n  device: iPhone 15\n  appium_url: http://127.0.0.1:4723\n",
    "add-todo.yaml": STORY,
  });
  const authored = await envOf(dir);
  assert.equal(authored.device, "iPhone 15");
  assert.equal(authored.appium_url, "http://127.0.0.1:4723");

  // A binding that names only the build and the platform means "the driver's
  // own default device", not "the device the suite happened to author".
  const env = await envOf(dir, {
    runtimeTarget: { app: "/runner/builds/Todo.app", platform: "ios" },
  });
  assert.equal(env.app, "/runner/builds/Todo.app");
  assert.equal(env.platform, "ios");
  assert.equal(env.device, null);
  assert.equal(env.appium_url, null);
  assert.equal(env.base_url, null);
});

test("physical fields that do not belong to the driver are cleared outright", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://authored.example\n",
    "add-todo.yaml": STORY,
  });
  // A caller that hands a web case mobile fields gets them dropped, not applied
  // and not errored: the target is discriminated by the case's own driver.
  const env = await envOf(dir, {
    runtimeTarget: {
      base_url: "http://ring.internal:4173",
      app: "/runner/builds/Todo.app",
      platform: "ios",
      device: "iPhone 16",
      appium_url: "http://127.0.0.1:4723",
    },
  });
  assert.equal(env.base_url, "http://ring.internal:4173");
  assert.equal(env.app, null);
  assert.equal(env.platform, null);
  assert.equal(env.device, null);
  assert.equal(env.appium_url, null);
});

test("an authored compose block is cleared, so the ring's URL is the only target", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:4173\n  compose: ./docker-compose.yml\n",
    "add-todo.yaml": STORY,
  });
  assert.ok((await envOf(dir)).compose, "the authored compose block should resolve without an override");
  const env = await envOf(dir, { runtimeTarget: RING });
  assert.equal(env.compose, null);
  assert.equal(env.base_url, RING.base_url);
});

test("an empty override is still an override: it clears the whole target", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://authored.example\n",
    "add-todo.yaml": STORY,
  });
  // Loudly, not silently: executable resolution then refuses the case for the
  // same reason it refuses any URL-less web suite.
  await assert.rejects(
    () => discoverCases([dir], { runtimeTarget: {} }),
    (e) => e instanceof DummyConfigError && /no app\.base_url configured/.test(e.message),
  );
});

// ---------- logical keys are none of the target's business ----------

test("logical configuration is untouched by the override", async () => {
  const dir = writeSuite({
    "playtest.yaml":
      "app:\n" +
      "  base_url: http://authored.example\n" +
      "  init: ./seed.js\n" +
      "  cookies:\n" +
      "    sid: abc\n" +
      "  settle:\n" +
      "    dom_quiet_ms: 120\n" +
      "  viewport:\n" +
      "    width: 900\n" +
      "  auth: member\n" +
      "  auth_states:\n" +
      "    member: ./states/member.json\n",
    "add-todo.yaml": STORY,
  });
  const before = await envOf(dir);
  const after = await envOf(dir, { runtimeTarget: RING });
  for (const key of ["init", "cookies", "settle", "viewport", "auth", "storage_state", "driver"]) {
    assert.deepEqual(after[key], before[key], `logical key ${key} must survive the override`);
  }
  assert.equal(after.base_url, RING.base_url);
});

// ---------- absent means byte-for-byte today ----------

test("no override resolves byte-for-byte identically to today", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://authored.example\n  compose: ./docker-compose.yml\n",
    "add-todo.yaml": STORY,
  });
  const plain = await envOf(dir);
  assert.deepEqual(await envOf(dir, { runtimeTarget: null }), plain);
  assert.deepEqual(await envOf(dir, {}), plain);
  assert.equal(plain.base_url, "http://authored.example");
  assert.ok(plain.compose, "compose must survive when nothing overrides the target");
});

// ---------- --base-url is the same setting ----------

test("a base URL and a runtime target together are a config error, not a precedence puzzle", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://authored.example\n",
    "add-todo.yaml": STORY,
  });
  await assert.rejects(
    () => discoverCases([dir], { baseUrl: "http://flag.example", runtimeTarget: RING }),
    (e) =>
      e instanceof DummyConfigError &&
      /--base-url is the one-field form of runtimeTarget\.base_url/.test(e.message) &&
      /pass exactly one/.test(e.message),
  );
  // Either alone still works.
  assert.equal((await envOf(dir, { baseUrl: "http://flag.example" })).base_url, "http://flag.example");
  assert.equal((await envOf(dir, { runtimeTarget: RING })).base_url, RING.base_url);
});

// ---------- caller-shape errors are actionable, never a raw TypeError ----------

test("a malformed override names the offending key", async () => {
  assert.equal(normalizeRuntimeTarget(null), null);
  assert.equal(normalizeRuntimeTarget(undefined), null);
  for (const [value, pattern] of [
    [{ ring_key: "local" }, /unknown key ring_key/],
    [{ base_url: 42 }, /runtimeTarget\.base_url must be a non-empty string/],
    [{ app: "  " }, /runtimeTarget\.app must be a non-empty string/],
    [{ platform: "web" }, /runtimeTarget\.platform must be one of ios\/android/],
    ["http://nope", /runtimeTarget must be an object/],
  ] as Array<[unknown, RegExp]>) {
    assert.throws(
      () => normalizeRuntimeTarget(value),
      (e) => e instanceof DummyConfigError && pattern.test(e.message),
      `expected ${JSON.stringify(value)} to be refused by ${pattern}`,
    );
  }
  // An explicit null clears the field, exactly like omitting it.
  assert.deepEqual(normalizeRuntimeTarget({ base_url: "http://x.test", device: null }), {
    base_url: "http://x.test",
    app: undefined,
    platform: undefined,
    device: undefined,
    appium_url: undefined,
  });
});
