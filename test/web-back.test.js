// Web `back` verb execution (docs/CONTRACTS.md §16). The flat-schema redesign
// added `back` to the web driver; this locks the executor coupling the schema
// alone can't catch — execute() must route `back` to #run and #perform() must
// run page.goBack(), or the actor emits a verb the validator accepts but the
// driver can't run. Launches the real pinned-chromium driver against the todo
// app (a back from a distinct URL is a real cross-document navigation).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { start as startApp } from "../src/todo-app/server.js";
import { WebDriver } from "../src/harness/drivers/web.js";

let app;
let runDir;

before(async () => {
  app = await startApp();
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-back-"));
});

after(async () => {
  if (app) await app.close().catch(() => {});
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

test("web `back` runs page.goBack(): ok, returns to the prior url, classified as a navigation", async () => {
  const driver = await WebDriver.launch({ baseUrl: app.url, runDir });
  try {
    const home = await driver.start(); // loads "/"
    assert.equal(home.ok, true);

    // A full document load to a distinct URL — the previous "/" becomes a
    // back-reachable history entry.
    const away = await driver.execute({ type: "navigate", url: "/?back-test=1" });
    assert.equal(away.ok, true);
    assert.match(away.url, /\?back-test=1$/);

    // Browser back: must succeed and return to the home url.
    const back = await driver.execute({ type: "back" });
    assert.equal(back.ok, true, back.error ?? "back failed");
    assert.equal(back.url, home.url, "back returns to the prior page");
    // `back` is perf-attributed as a navigation (nav block populated,
    // input-to-paint null) — locks the navigated-predicate edit.
    assert.notEqual(back.perf?.nav, null, "back is classified as a navigation");
    assert.equal(back.perf?.input_to_paint_ms, null);
  } finally {
    await driver.close();
  }
});
