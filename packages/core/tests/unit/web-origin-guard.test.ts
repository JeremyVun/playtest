// The web driver's origin confinement (docs/contracts/engine.md#origin-confinement):
// origin normalization, what the admission predicate lets through, and that
// app.allowed_origins is now a valid web key that reaches the driver. Offline —
// no browser; the enforcement itself is proved in tests/browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases, DummyConfigError } from "../../src/config.ts";
import { createDriver } from "../../src/driver.ts";
import { allowedOriginSet, originAdmitted, WebDriver } from "../../src/drivers/web.ts";

let tmpRoot: LegacyTestValue;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-web-origin-"));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const STORY = "story: |\n  Read the departure board.\n";

let suiteSeq = 0;

function writeSuite(files: Record<string, string>) {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test("the allowed set is base_url's origin plus the declared entries, deduped", () => {
  const set = allowedOriginSet("https://app.example/dashboard?tab=1#x", [
    "https://cdn.example",
    "https://cdn.example",
    "http://app.example",
  ]);
  assert.deepEqual([...set], ["https://app.example", "https://cdn.example", "http://app.example"]);
});

test("an unparseable base_url or entry leaves the set narrower, never wider", () => {
  assert.deepEqual([...allowedOriginSet("not a url", null)], []);
  assert.deepEqual([...allowedOriginSet("https://app.example", ["not a url"])], ["https://app.example"]);
});

test("a default port normalizes away and an explicit different port is a different origin", () => {
  const set = allowedOriginSet("https://app.example:443", null);
  assert.deepEqual([...set], ["https://app.example"]);
  assert.equal(originAdmitted("https://app.example/x", set), true);
  assert.equal(originAdmitted("https://app.example:8443/x", set), false);
});

test("admission is exact on scheme, host and port", () => {
  const set = allowedOriginSet("http://127.0.0.1:4173", ["https://cdn.example"]);
  assert.equal(originAdmitted("http://127.0.0.1:4173/deep/path?q=1", set), true);
  assert.equal(originAdmitted("https://cdn.example/font.woff2", set), true);
  assert.equal(originAdmitted("https://127.0.0.1:4173/x", set), false, "another scheme is another origin");
  assert.equal(originAdmitted("http://127.0.0.1:4174/x", set), false, "another port is another origin");
  assert.equal(originAdmitted("http://localhost:4173/x", set), false, "another host is another origin");
  assert.equal(originAdmitted("http://cdn.example.evil/x", set), false, "a suffix is not a match");
});

test("about: and data: are admitted; every other non-http(s) scheme is refused", () => {
  const set = allowedOriginSet("http://127.0.0.1:4173", null);
  assert.equal(originAdmitted("about:blank", set), true);
  assert.equal(originAdmitted("data:text/html,hello", set), true);
  assert.equal(originAdmitted("javascript:alert(1)", set), false);
  assert.equal(originAdmitted("file:///etc/passwd", set), false);
  assert.equal(originAdmitted("chrome://settings", set), false);
  assert.equal(originAdmitted("ftp://files.example/x", set), false);
  assert.equal(originAdmitted("", set), false);
});

test("app.allowed_origins resolves on a web case and keeps its bare-origin rule", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n  allowed_origins:\n    - https://cdn.example\n",
    "board.yaml": STORY,
  });
  const [rc]: LegacyTestValue = await discoverCases([dir]);
  assert.deepEqual(rc.env.allowed_origins, ["https://cdn.example"]);

  const bad = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n  allowed_origins:\n    - https://cdn.example/assets\n",
    "board.yaml": STORY,
  });
  await assert.rejects(discoverCases([bad]), (e: LegacyTestValue) => {
    assert.ok(e instanceof DummyConfigError, `expected DummyConfigError, got: ${e?.stack ?? e}`);
    assert.match(e.message, /app\.allowed_origins entry .* must be a bare origin/);
    return true;
  });
});

test("a web case without app.allowed_origins resolves to null (base_url's origin only)", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "board.yaml": STORY,
  });
  const [rc]: LegacyTestValue = await discoverCases([dir]);
  assert.equal(rc.env.allowed_origins, null);
});

test("createDriver hands the resolved origins and the event sink to the web driver", async () => {
  const launch = WebDriver.launch;
  let seen: LegacyTestValue;
  WebDriver.launch = async (opts: LegacyTestValue) => {
    seen = opts;
    return {} as WebDriver;
  };
  try {
    const rc: LegacyTestValue = {
      file: "board.yaml",
      env: { driver: "web", storage_state: null, allowed_origins: ["https://cdn.example"] },
    };
    const events: LegacyTestValue[] = [];
    await createDriver(rc, { baseUrl: "http://localhost:9", managed: false }, {
      runDir: tmpRoot,
      onEvent: (type: string, payload: Record<string, unknown>) => events.push({ type, ...payload }),
    });
    assert.deepEqual(seen.allowedOrigins, ["https://cdn.example"]);
    seen.onEvent("request_blocked", { url: "https://evil.example/x" });
    assert.deepEqual(events, [{ type: "request_blocked", url: "https://evil.example/x" }]);
  } finally {
    WebDriver.launch = launch;
  }
});
