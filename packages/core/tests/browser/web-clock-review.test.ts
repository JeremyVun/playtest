import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { resolveClock } from "../../src/config/resolve.ts";
import { WebDriver } from "../../src/drivers/web.ts";

const CLOCK = { time: "2026-08-31T22:44:00+10:00", timezone: "Australia/Sydney" };
const FIXED_ISO = "2026-08-31T12:44:00.000Z";
const DELAY_MS = 300;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Board</title>
<p id="now"></p><button id="go" disabled>Go</button><p id="frames">0</p><p id="fetched"></p>
<script>
  document.getElementById("now").textContent = new Date().toLocaleString("en-AU");
  document.body.dataset.t = new Date().toISOString();
  setTimeout(() => {
    document.getElementById("go").disabled = false;
    const p = document.createElement("p"); p.id = "added"; p.textContent = "added"; document.body.appendChild(p);
  }, ${DELAY_MS});
  let frames = 0;
  const frame = () => { frames += 1; document.getElementById("frames").textContent = String(frames); if (frames < 10) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const p0 = performance.now();
  setTimeout(() => { window.perfElapsed = performance.now() - p0; }, 100);
  fetch("/data", { signal: AbortSignal.timeout(5000) }).then((r) => r.text())
    .then((t) => { document.getElementById("fetched").textContent = t; })
    .catch((e) => { document.getElementById("fetched").textContent = "ERR " + e.name; });
</script>`;

let server: LegacyTestValue;
let baseUrl: LegacyTestValue;
let runDir: LegacyTestValue;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/data") {
      setTimeout(() => res.end("data"), 100);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-web-clock-review-"));
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

test("Playwright waits, timers, frames, performance.now and fetch timeouts all progress under the fixed clock", async () => {
  const driver = await WebDriver.launch({ baseUrl, runDir, clock: CLOCK });
  try {
    const started = Date.now();
    assert.equal((await driver.start()).ok, true);
    await driver.page.waitForSelector("#added", { timeout: 5000 });
    await driver.page.locator("#go").click({ timeout: 5000 });
    await driver.page.waitForFunction(() => (window as LegacyTestValue).perfElapsed > 0, null, { timeout: 5000 });
    await driver.page.locator("#frames").filter({ hasText: "10" }).waitFor({ timeout: 5000 });
    await driver.page.locator("#fetched").filter({ hasText: "data" }).waitFor({ timeout: 5000 });
    assert.ok(Date.now() - started < 10_000, "no wait may run to the settle cap");
  } finally {
    await driver.close();
  }
});

test("popups, later documents, iframes and the post-run check context all read the fixed instant", async () => {
  const driver = await WebDriver.launch({ baseUrl, runDir, clock: CLOCK });
  try {
    await driver.start();
    const popup = await driver.page.evaluate(() => new ((window.open("about:blank") as LegacyTestValue).Date)().toISOString());
    assert.equal(popup, FIXED_ISO);

    await driver.page.goto(`${baseUrl}/second`);
    assert.equal(await driver.page.evaluate(() => new Date().toISOString()), FIXED_ISO);

    const iframe = await driver.page.evaluate(() => new Promise((resolve) => {
      window.addEventListener("message", (e) => resolve(e.data), { once: true });
      const f = document.createElement("iframe");
      f.srcdoc = "<script>parent.postMessage(new Date().toISOString(), '*')</script>";
      document.body.appendChild(f);
    }));
    assert.equal(iframe, FIXED_ISO);

    await driver.stopRecording();
    assert.equal(await driver.finalPageCheck(`[data-t="${FIXED_ISO}"]`), true);
  } finally {
    await driver.close();
  }
});

test("a web worker reads the fixed instant too", async () => {
  const driver = await WebDriver.launch({ baseUrl, runDir, clock: CLOCK });
  try {
    await driver.start();
    const worker = await driver.page.evaluate(() => new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob(["postMessage(new Date().toISOString())"], { type: "text/javascript" }));
      new Worker(url).onmessage = (e) => resolve(e.data);
    }));
    assert.equal(worker, FIXED_ISO);
  } finally {
    await driver.close();
  }
});

test("navigation timing survives the fixed clock", async () => {
  const driver = await WebDriver.launch({ baseUrl, runDir, clock: CLOCK });
  try {
    const result = await driver.start();
    assert.equal(typeof (result.perf?.nav as LegacyTestValue)?.ttfb_ms, "number");
    assert.equal(await driver.page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
    assert.equal(await driver.page.evaluate(() => typeof performance.timing), "object");
  } finally {
    await driver.close();
  }
});

test("two launches snapshot identical text for a page that prints the date", async () => {
  const texts: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const driver = await WebDriver.launch({ baseUrl, runDir: fs.mkdtempSync(path.join(runDir, "run-")), clock: CLOCK });
    try {
      await driver.start();
      texts.push((await driver.captureSnapshot(1)).text);
    } finally {
      await driver.close();
    }
  }
  assert.equal(texts[0], texts[1]);
  assert.match(texts[0]!, /31\/08\/2026, 10:44:00 pm/);
});

test("every zone load validation admits opens a browser context", async () => {
  for (const timezone of ["Australia/sydney", "utc"]) {
    const clock = resolveClock({ time: CLOCK.time, timezone }, "board.yaml");
    const driver = await WebDriver.launch({ baseUrl, runDir, clock });
    await driver.close();
  }
});
