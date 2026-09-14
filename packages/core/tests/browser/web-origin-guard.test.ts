// The web driver's origin confinement against real Chromium
// (docs/contracts/engine.md#origin-confinement): a page that loads an
// off-origin image, fetches an off-origin URL and links off-origin must reach
// none of them, must say so in the run's events, and must keep running. The
// off-origin server counts what actually arrived, so the assertions prove the
// bytes never left the browser rather than that an event was written.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { WebDriver } from "../../src/drivers/web.ts";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

let app: LegacyTestValue;
let off: LegacyTestValue;
let baseUrl: string;
let offUrl: string;
let runDir: string;
let offHits: string[];
let events: Array<Record<string, unknown>>;

const page = (): string => `<!doctype html><meta charset="utf-8"><title>Board</title>
<h1>Departure board</h1>
<p id="img">pending</p><p id="fetched">pending</p>
<img src="${offUrl}/pixel.png" onload="img.textContent='loaded'" onerror="img.textContent='blocked'">
<a id="away" href="${offUrl}/away">Leave the site</a>
<a id="hop" href="/hop">Hop away</a>
<script>
  fetch("${offUrl}/track", { method: "POST", body: "who" })
    .then(() => { fetched.textContent = "sent"; })
    .catch(() => { fetched.textContent = "blocked"; });
</script>`;

before(async () => {
  off = http.createServer((req, res) => {
    offHits.push(`${req.method} ${req.url}`);
    if (req.url === "/pixel.png") {
      res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
      res.end(PIXEL);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" });
    res.end("<!doctype html><title>Elsewhere</title><h1>Off-origin site</h1>");
  });
  await new Promise<void>((resolve) => off.listen(0, "127.0.0.1", resolve));
  offUrl = `http://127.0.0.1:${off.address().port}`;

  app = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/pixel.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(PIXEL);
      return;
    }
    if (url === "/hop") {
      res.writeHead(302, { location: `${offUrl}/landed` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(url === "/second" ? "<!doctype html><title>Second</title><h1>Second stop</h1>" : page());
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${app.address().port}`;

  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-web-origin-guard-"));
});

after(async () => {
  if (app) await new Promise((resolve) => app.close(resolve));
  if (off) await new Promise((resolve) => off.close(resolve));
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

beforeEach(() => {
  offHits = [];
  events = [];
});

const launch = (allowedOrigins: string[] | null = null) =>
  WebDriver.launch({
    baseUrl,
    runDir,
    allowedOrigins,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });

const blocked = () => events.filter((e) => e.type === "request_blocked");

test("an off-origin image, fetch and link are all blocked and the run carries on", async () => {
  const driver = await launch();
  try {
    assert.equal((await driver.start()).ok, true, "the on-origin page still loads");
    await driver.page.waitForFunction(
      () => document.querySelector("#img")!.textContent !== "pending" && document.querySelector("#fetched")!.textContent !== "pending",
    );
    assert.equal(await driver.page.locator("#img").textContent(), "blocked");
    assert.equal(await driver.page.locator("#fetched").textContent(), "blocked");

    const types = blocked().map((e) => e.resource_type);
    assert.ok(types.includes("image"), `an image block was recorded (${JSON.stringify(blocked())})`);
    assert.ok(
      types.some((t) => t === "fetch" || t === "xhr"),
      `a fetch block was recorded (${JSON.stringify(blocked())})`,
    );
    for (const e of blocked()) assert.ok(String(e.url).startsWith(offUrl), `${e.url} is the off-origin URL`);
    assert.deepEqual(
      blocked().map((e) => e.method).sort(),
      ["GET", "POST"],
      "the method rides the event, so a write attempt is legible",
    );

    // Clicking the off-origin link is a blocked document request: the step
    // fails, the site is never reached, and the actor is put back on the page.
    const snap = await driver.captureSnapshot(1);
    const ref = /\[(e\d+)\] link "Leave the site"/.exec(snap.text)?.[1];
    assert.ok(ref, `the off-origin link is in the snapshot:\n${snap.text}`);
    const click = await driver.execute({ type: "click", ref });
    assert.equal(click.ok, false, "the blocked link navigation fails its step");
    assert.match(String(click.error), /refused: outside the target origin/);
    assert.ok(driver.page.url().startsWith(baseUrl), `the actor is back on ${baseUrl} (${driver.page.url()})`);
    assert.ok(
      blocked().some((e) => e.url === `${offUrl}/away` && e.resource_type === "document"),
      `the link navigation was blocked (${JSON.stringify(blocked())})`,
    );

    // The case keeps going: a later on-origin step still succeeds.
    const next = await driver.execute({ type: "navigate", url: "/second" });
    assert.equal(next.ok, true, next.error ?? "");
    assert.match((await driver.captureSnapshot(3)).text, /Second stop/);

    assert.deepEqual(offHits, [], "nothing reached the off-origin server");
  } finally {
    await driver.close();
  }
});

test("the navigate verb refuses an off-origin target as a step failure the actor can read", async () => {
  const driver = await launch();
  try {
    await driver.start();
    events.length = 0; // the page's own off-origin subresources are step-1 noise here
    const res = await driver.execute({ type: "navigate", url: `${offUrl}/away` });
    assert.equal(res.ok, false, "the step fails");
    assert.match(String(res.error), new RegExp(offUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the refusal names the target");
    assert.match(String(res.error), /allowed_origins/, "the refusal names the recovery knob");
    assert.equal(blocked().length, 1, "the refusal is recorded once");
    assert.equal(blocked()[0]!.resource_type, "document");
    assert.ok(driver.page.url().startsWith(baseUrl), "the page never moved");

    const js = await driver.execute({ type: "navigate", url: "javascript:document.title='pwned'" });
    assert.equal(js.ok, false, "a javascript: navigation is refused");
    assert.notEqual(await driver.page.title(), "pwned");

    assert.deepEqual(offHits, [], "nothing reached the off-origin server");
  } finally {
    await driver.close();
  }
});

test("a redirect that leaves the origin fails its step and puts the page back", async () => {
  const driver = await launch();
  try {
    await driver.start();
    events.length = 0;
    const res = await driver.execute({ type: "navigate", url: "/hop" });
    assert.equal(res.ok, false, "the redirected navigation fails its step");
    assert.match(String(res.error), new RegExp(`${offUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/landed`));
    const hops = blocked().filter((e) => String(e.url) === `${offUrl}/landed`);
    assert.equal(hops.length, 1, `the redirect target was recorded (${JSON.stringify(blocked())})`);
    assert.ok(driver.page.url().startsWith(baseUrl), `the page is back on-origin (${driver.page.url()})`);
    // Playwright cannot route a redirect hop, so the one uncredentialed GET the
    // browser follows is the guard's known residue; nothing else follows it and
    // the off-origin document never reaches the actor.
    assert.deepEqual(offHits, ["GET /landed"], "only the unroutable hop reached the off-origin server");
  } finally {
    await driver.close();
  }
});

test("an on-origin run records no request_blocked events", async () => {
  const driver = await launch([offUrl]);
  try {
    await driver.start();
    const res = await driver.execute({ type: "navigate", url: "/second" });
    assert.equal(res.ok, true, res.error ?? "");
    assert.deepEqual(blocked(), [], "a run that never leaves its allowed origins records nothing");
  } finally {
    await driver.close();
  }
});

test("app.allowed_origins admits the origins it names, and only those", async () => {
  const driver = await launch([offUrl]);
  try {
    await driver.start();
    await driver.page.waitForFunction(
      () => document.querySelector("#img")!.textContent !== "pending" && document.querySelector("#fetched")!.textContent !== "pending",
    );
    assert.equal(await driver.page.locator("#img").textContent(), "loaded");
    assert.equal(await driver.page.locator("#fetched").textContent(), "sent");
    assert.deepEqual(offHits.sort(), ["GET /pixel.png", "POST /track"], "the declared origin was reached");

    const allowed = await driver.execute({ type: "navigate", url: `${offUrl}/away` });
    assert.equal(allowed.ok, true, allowed.error ?? "");

    events.length = 0;
    const elsewhere = await driver.execute({ type: "navigate", url: "http://127.0.0.1:1/nowhere" });
    assert.equal(elsewhere.ok, false, "an origin the case did not name is still refused");
    assert.deepEqual(blocked().map((e) => e.url), ["http://127.0.0.1:1/nowhere"]);
  } finally {
    await driver.close();
  }
});
