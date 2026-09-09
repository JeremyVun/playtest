// app.clock against real Chromium (docs/contracts/engine.md#web-driver): the
// page must read one fixed instant in the configured zone every time it looks,
// while its timers keep firing. The zone is read WITHOUT an explicit timeZone
// option, so the assertion proves the context's timezoneId took effect.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { WebDriver } from "../../src/drivers/web.ts";

const CLOCK = { time: "2026-08-31T22:44:00+10:00", timezone: "Australia/Sydney" };
const EXPECTED_ISO = "2026-08-31T12:44:00.000Z";
const SECOND_READING_DELAY_MS = 400;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Departure board</title>
<p id="first"></p><p id="second"></p><p id="ticks">0</p>
<script>
  const reading = () => {
    const now = new Date();
    return now.toISOString() + " | " + now.toLocaleString("en-AU") + " | " +
      Intl.DateTimeFormat().resolvedOptions().timeZone;
  };
  let ticks = 0;
  setInterval(() => { ticks += 1; document.getElementById("ticks").textContent = String(ticks); }, 25);
  document.getElementById("first").textContent = reading();
  setTimeout(() => { document.getElementById("second").textContent = reading(); }, ${SECOND_READING_DELAY_MS});
</script>`;

let server: LegacyTestValue;
let baseUrl: LegacyTestValue;
let runDir: LegacyTestValue;

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-web-clock-"));
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

test("app.clock fixes every reading of the page clock while its timers keep running", async () => {
  const driver = await WebDriver.launch({ baseUrl, runDir, clock: CLOCK });
  try {
    assert.equal((await driver.start()).ok, true);
    const second = driver.page.locator("#second");
    await second.waitFor({ state: "attached" });
    await driver.page.waitForFunction(() => document.querySelector("#second")!.textContent !== "");

    const first = await driver.page.locator("#first").textContent();
    const later = await second.textContent();
    const expected = `${EXPECTED_ISO} | 31/08/2026, 10:44:00 pm | ${CLOCK.timezone}`;
    assert.equal(first, expected);
    assert.equal(later, expected, "a reading taken later in the page's life must be the same instant");

    // A third reading from outside the page's own script: Date.now() stays fixed
    // for every later call, not just the two the page happened to take.
    assert.equal(await driver.page.evaluate(() => new Date(Date.now()).toISOString()), EXPECTED_ISO);

    const ticks = Number(await driver.page.locator("#ticks").textContent());
    assert.ok(ticks > 0, `setInterval must keep firing under a fixed clock (ticks=${ticks})`);
  } finally {
    await driver.close();
  }
});

test("without app.clock the page reads real time, as before", async () => {
  const driver = await WebDriver.launch({ baseUrl, runDir });
  try {
    await driver.start();
    const iso = await driver.page.evaluate(() => new Date().toISOString());
    assert.ok(Math.abs(Date.parse(iso) - Date.now()) < 60_000, `expected real time, got ${iso}`);
  } finally {
    await driver.close();
  }
});
