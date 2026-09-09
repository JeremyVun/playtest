import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases, DummyConfigError } from "../../src/config.ts";
import { resolveClock } from "../../src/config/resolve.ts";
import { buildManifest } from "../../src/runner.ts";
import { exportSpec } from "../../src/export-playwright.ts";

let tmpRoot: LegacyTestValue;
let suiteSeq = 0;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-clock-review-"));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const STORY = "story: |\n  Read the departure board.\n";
const CLOCK = { time: "2026-08-31T22:44:00+10:00", timezone: "Australia/Sydney" };
const CLOCK_YAML = `  clock:\n    time: "${CLOCK.time}"\n    timezone: ${CLOCK.timezone}\n`;

function writeSuite(files: Record<string, string>) {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

async function configError(dir: string, opts?: LegacyTestValue): Promise<string> {
  try {
    await discoverCases([dir], opts);
  } catch (e: LegacyTestValue) {
    assert.ok(e instanceof DummyConfigError, `expected DummyConfigError, got: ${e?.stack ?? e}`);
    return e.message;
  }
  assert.fail("expected a DummyConfigError");
}

test("a zone spelling Chromium rejects is refused at load, not at browser launch", () => {
  // Intl.DateTimeFormat accepts these case-insensitively; Chromium's timezoneId
  // does not, so admitting them turns a config error into a driver launch failure.
  for (const timezone of ["Australia/sydney", "utc", "europe/london"]) {
    assert.throws(
      () => resolveClock({ time: CLOCK.time, timezone }, "board.yaml"),
      DummyConfigError,
      `${JSON.stringify(timezone)} must be a load-time configuration error`,
    );
  }
});

test("a rolled-over hour is refused like a rolled-over day", () => {
  assert.throws(() => resolveClock({ time: "2026-08-31T24:00:00Z", timezone: "UTC" }, "board.yaml"), DummyConfigError);
});

test("schema errors name the missing clock field at every level it is valid", async () => {
  const timeOnly = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "board.yaml": STORY + `app:\n  clock:\n    time: "${CLOCK.time}"\n`,
  });
  assert.match(await configError(timeOnly), /board\.yaml: missing required "app\.clock\.timezone"/);

  const zoneOnly = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n  clock:\n    timezone: UTC\n",
    "board.yaml": STORY,
  });
  assert.match(await configError(zoneOnly), /playtest\.yaml: missing required "app\.clock\.time"/);

  // The owner ruled app.clock out of overlays on 2026-09-09, so an overlay
  // never reaches the clock's own field validation.
  const overlay = writeSuite({
    "playtest.yaml": `app:\n  base_url: http://localhost:9\n  envs:\n    stg:\n      clock:\n        time: "${CLOCK.time}"\n`,
    "board.yaml": STORY,
  });
  assert.match(await configError(overlay, { env: "stg" }), /unknown key "app\.envs\.stg\.clock"/);
});

test("clock: null in a case is refused exactly like viewport: null", async () => {
  const messages: string[] = [];
  for (const key of ["clock", "viewport"]) {
    const dir = writeSuite({
      "playtest.yaml": "app:\n  base_url: http://localhost:9\n  viewport:\n    width: 400\n" + CLOCK_YAML,
      "board.yaml": STORY + `app:\n  ${key}: null\n`,
    });
    messages.push((await configError(dir)).replace(dir, "").replace(key, "<key>"));
  }
  assert.equal(messages[0], messages[1]);
});

test("structural resolution validates and echoes the clock like executable resolution", async () => {
  const dir = writeSuite({ "playtest.yaml": "app:\n" + CLOCK_YAML, "board.yaml": STORY });
  const [rc]: LegacyTestValue = await discoverCases([dir], { resolution: "structural" });
  assert.deepEqual(rc.env.clock, CLOCK);

  const bad = writeSuite({ "playtest.yaml": "app:\n  clock:\n    time: yesterday\n    timezone: UTC\n", "board.yaml": STORY });
  assert.match(await configError(bad, { resolution: "structural" }), /app\.clock\.time must be an RFC 3339 instant/);
});

test("a mobile case reached through defaults names app.clock, and an overlay never carries one", async () => {
  const defaults = writeSuite({
    "playtest.yaml": "app:\n  driver: mobile\n  app: ./App.app\n" + CLOCK_YAML,
    "board.yaml": STORY,
  });
  assert.match(await configError(defaults), /app\.clock is not valid for the mobile driver \(valid: web\)/);

  const overlay = writeSuite({
    "playtest.yaml": `app:\n  driver: mobile\n  app: ./App.app\n  envs:\n    stg:\n      clock:\n        time: "${CLOCK.time}"\n        timezone: UTC\n`,
    "board.yaml": STORY,
  });
  assert.match(await configError(overlay, { env: "stg" }), /unknown key "app\.envs\.stg\.clock"/);
});

function manifestFor(clock: LegacyTestValue) {
  return buildManifest({
    rc: {
      id: "board",
      file: "board.yaml",
      story: "Read the departure board.",
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
      artifacts: "core",
      limits: { max_steps: 10, timeout_ms: 1000 },
      actor_model: "m",
      grader_model: "m",
      env: { driver: "web", base_url: "http://127.0.0.1:1", clock },
    },
    runId: "2026-09-09T0000-abcd",
    mode: "record",
    startedAt: new Date("2026-09-09T00:00:00Z"),
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

test("the manifest records env.clock only when declared and never as a pin", () => {
  const declared = manifestFor(CLOCK);
  assert.deepEqual(declared.env.clock, CLOCK);
  assert.equal("clock" in declared.pins, false);
  assert.equal("clock" in manifestFor(null).env, false);
});

test("an exported Playwright spec carries the clock the baseline was recorded under", () => {
  const { code } = exportSpec({
    caseCfg: { id: "board", file: "/suite/board.yaml", story: "Read.", mode: "journey", success: [], perf: {}, env: { driver: "web", base_url: "http://app.test", cookies: null, clock: CLOCK } } as LegacyTestValue,
    envelopes: [],
  });
  assert.match(code, /timezoneId: "Australia\/Sydney"/);
  assert.match(code, /clock\.setFixedTime\(/);
});
