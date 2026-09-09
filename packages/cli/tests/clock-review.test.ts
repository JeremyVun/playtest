import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI, REPO_ROOT } from "./support.ts";

const STORY = "story: Read the departure board.\n";

function listSuite(playtestYaml: string, caseYaml = STORY) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-cli-clock-"));
  try {
    fs.writeFileSync(path.join(root, "playtest.yaml"), playtestYaml);
    fs.writeFileSync(path.join(root, "board.yaml"), caseYaml);
    const result = spawnSync(process.execPath, [CLI, "list", root, "--json"], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined, result.error?.message as string); // SAFETY: message is read only when spawn reports an Error
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("app.clock configuration errors exit 2 through the CLI and name the field", () => {
  const timeOnly = listSuite('app:\n  base_url: http://localhost:9\n  clock:\n    time: "2026-08-31T22:44:00+10:00"\n');
  assert.equal(timeOnly.status, 2, timeOnly.stderr);
  assert.match(timeOnly.stderr, /^playtest: .*missing required "app\.clock\.timezone"/m);

  const zone = listSuite('app:\n  base_url: http://localhost:9\n  clock:\n    time: "2026-08-31T22:44:00+10:00"\n    timezone: Australia/Sidney\n');
  assert.equal(zone.status, 2, zone.stderr);
  assert.match(zone.stderr, /app\.clock\.timezone must be an IANA zone name/);

  const mobile = listSuite('app:\n  driver: mobile\n  app: ./App.app\n  clock:\n    time: "2026-08-31T22:44:00+10:00"\n    timezone: Australia/Sydney\n');
  assert.equal(mobile.status, 2, mobile.stderr);
  assert.match(mobile.stderr, /app\.clock is not valid for the mobile driver/);
  for (const result of [timeOnly, zone, mobile]) assert.doesNotMatch(result.stderr, /at .*\.ts:\d+/);
});
