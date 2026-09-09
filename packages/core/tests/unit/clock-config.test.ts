// app.clock, the web driver's fixed page clock
// (docs/contracts/engine.md#discovery-and-configuration): load validation,
// the defaults/case/overlay precedence, the resolved-case echo, and the
// options createDriver hands the web driver. Offline — no browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases, DummyConfigError } from "../../src/config.ts";
import { createDriver } from "../../src/driver.ts";
import { WebDriver } from "../../src/drivers/web.ts";

let tmpRoot: LegacyTestValue;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-clock-config-"));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const STORY = "story: |\n  Read the departure board.\n";

let suiteSeq = 0;

function writeSuite(files: Record<string, string>) {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

async function expectConfigError(dir: string, opts: LegacyTestValue, ...patterns: RegExp[]) {
  await assert.rejects(discoverCases([dir], opts), (e: LegacyTestValue) => {
    assert.ok(e instanceof DummyConfigError, `expected DummyConfigError, got: ${e?.stack ?? e}`);
    for (const p of patterns) assert.match(e.message, p);
    return true;
  });
}

test("a case without app.clock echoes env.clock null (real time, as before)", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "board.yaml": STORY,
  });
  const [rc]: LegacyTestValue = await discoverCases([dir]);
  assert.equal(rc.env.clock, null);
});

test("app.clock resolves onto env.clock and the case wins over the defaults chain", async () => {
  const dir = writeSuite({
    "playtest.yaml":
      "app:\n  base_url: http://localhost:9\n  clock:\n    time: \"2026-08-31T22:44:00+10:00\"\n    timezone: Australia/Sydney\n",
    "inherits.yaml": STORY,
    "overrides.yaml":
      STORY + "app:\n  clock:\n    time: \"2026-01-01T09:00:00Z\"\n    timezone: Europe/London\n",
  });
  const cases: LegacyTestValue = await discoverCases([dir]);
  const byId = Object.fromEntries(cases.map((c: LegacyTestValue) => [c.id, c]));
  assert.deepEqual(byId.inherits.env.clock, { time: "2026-08-31T22:44:00+10:00", timezone: "Australia/Sydney" });
  assert.deepEqual(byId.overrides.env.clock, { time: "2026-01-01T09:00:00Z", timezone: "Europe/London" });
});

test("an app.envs overlay clock wins over both the defaults chain and the case", async () => {
  const dir = writeSuite({
    "playtest.yaml":
      "app:\n  base_url: http://localhost:9\n" +
      "  clock:\n    time: \"2026-08-31T22:44:00+10:00\"\n    timezone: Australia/Sydney\n" +
      "  envs:\n    stg:\n      clock:\n        time: \"2026-03-04T05:06:07Z\"\n        timezone: America/New_York\n",
    "board.yaml": STORY + "app:\n  clock:\n    time: \"2026-01-01T09:00:00Z\"\n    timezone: Europe/London\n",
  });
  const [rc]: LegacyTestValue = await discoverCases([dir], { env: "stg" });
  assert.deepEqual(rc.env.clock, { time: "2026-03-04T05:06:07Z", timezone: "America/New_York" });
});

test("app.clock on a mobile or api case is a configuration error naming the key", async () => {
  for (const driver of ["mobile", "api"]) {
    const dir = writeSuite({
      "playtest.yaml":
        `app:\n  driver: ${driver}\n  base_url: http://localhost:9\n` +
        (driver === "mobile" ? "  app: ./App.app\n" : "") +
        "  clock:\n    time: \"2026-08-31T22:44:00+10:00\"\n    timezone: Australia/Sydney\n",
      "board.yaml": STORY,
    });
    await expectConfigError(dir, undefined, /app\.clock is not valid for the /, new RegExp(driver), /valid: web/);
  }
});

test("a malformed instant is a load-time configuration error naming the file and the key", async () => {
  for (const time of ["yesterday", "2026-08-31 22:44", "2026-08-31T22:44:00", "2026-02-31T00:00:00Z"]) {
    const dir = writeSuite({
      "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
      "board.yaml": STORY + `app:\n  clock:\n    time: "${time}"\n    timezone: Australia/Sydney\n`,
    });
    await expectConfigError(dir, undefined, /board\.yaml/, /app\.clock\.time must be an RFC 3339 instant/);
  }
});

test("an unknown time zone is a load-time configuration error naming the key", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "board.yaml": STORY + 'app:\n  clock:\n    time: "2026-08-31T22:44:00+10:00"\n    timezone: Australia/Sidney\n',
  });
  await expectConfigError(dir, undefined, /board\.yaml/, /app\.clock\.timezone must be an IANA zone name/);
});

test("clock.timezone is required with clock.time, and unknown clock keys are rejected", async () => {
  const missing = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "board.yaml": STORY + 'app:\n  clock:\n    time: "2026-08-31T22:44:00+10:00"\n',
  });
  await expectConfigError(missing, undefined, /board\.yaml/, /timezone/);

  const unknown = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "board.yaml":
      STORY + 'app:\n  clock:\n    time: "2026-08-31T22:44:00+10:00"\n    timezone: Australia/Sydney\n    tz: UTC\n',
  });
  await expectConfigError(unknown, undefined, /board\.yaml/, /unknown key "app\.clock\.tz"/);
});

test("createDriver hands the resolved clock to the web driver", async () => {
  const clock = { time: "2026-08-31T22:44:00+10:00", timezone: "Australia/Sydney" };
  const launch = WebDriver.launch;
  let seen: LegacyTestValue;
  WebDriver.launch = async (opts: LegacyTestValue) => {
    seen = opts;
    return {} as WebDriver;
  };
  try {
    const rc: LegacyTestValue = { file: "board.yaml", env: { driver: "web", storage_state: null, clock } };
    await createDriver(rc, { baseUrl: "http://localhost:9", managed: false }, { runDir: tmpRoot });
  } finally {
    WebDriver.launch = launch;
  }
  assert.deepEqual(seen.clock, clock);
});
