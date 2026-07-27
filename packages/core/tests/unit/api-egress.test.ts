// The api driver egress guard (docs/contracts/engine.md#api-driver): requests
// may reach base_url's origin plus app.allowed_origins, nothing else. The
// refusal must happen before ANY network I/O — fetch is instrumented here and
// the tests assert it was never entered for a refused request. Offline.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ApiDriver } from "../../src/drivers/api.ts";
import { DummyConfigError, normalizeAllowedOrigins } from "../../src/config.ts";

const BASE = "http://127.0.0.1:4999";
let runDir: string;
let fetchCalls: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-egress-"));
  fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(runDir, { recursive: true, force: true });
});

const launch = (env = {}) => ApiDriver.launch({ env: { base_url: BASE, ...env }, runDir });
const harEntries = () => {
  const file = path.join(runDir, "har.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).log?.entries ?? [];
};

test("a cross-origin absolute action.path is refused with zero I/O and no HAR entry", async () => {
  const driver = await launch();
  const res: LegacyTestValue = await driver.execute({ type: "request", method: "GET", path: "https://evil.example/steal" });
  assert.equal(res.ok, false, "the step fails");
  assert.match(res.error, /https:\/\/evil\.example/, "the refusal names the refused origin");
  assert.match(res.error, /allowed_origins/, "the refusal names the recovery knob");
  assert.deepEqual(fetchCalls, [], "fetch was never entered");
  await driver.close();
  assert.deepEqual(harEntries(), [], "no HAR entry for a refused request");
});

test("non-http(s) resolutions are always refused (no admissible origin)", async () => {
  const driver = await launch();
  for (const p of ["file:///etc/passwd", "data:text/plain,x"]) {
    const res = await driver.execute({ type: "request", method: "GET", path: p });
    assert.equal(res.ok, false, `${p} is refused`);
  }
  assert.deepEqual(fetchCalls, [], "fetch was never entered");
  await driver.close();
});

test("same-origin requests pass: relative and absolute forms", async () => {
  const driver = await launch();
  const rel = await driver.execute({ type: "request", method: "GET", path: "/accounts" });
  assert.equal(rel.ok, true);
  const abs = await driver.execute({ type: "request", method: "GET", path: `${BASE}/accounts` });
  assert.equal(abs.ok, true);
  assert.deepEqual(fetchCalls, [`${BASE}/accounts`, `${BASE}/accounts`]);
  await driver.close();
});

test("an allow-listed origin passes; its neighbors still refuse", async () => {
  const driver = await launch({ allowed_origins: ["https://api.example"] });
  const ok = await driver.execute({ type: "request", method: "GET", path: "https://api.example/v1/things" });
  assert.equal(ok.ok, true, "allow-listed origin is admitted");
  // Same host, different port/scheme = different origin: still refused.
  const badPort = await driver.execute({ type: "request", method: "GET", path: "https://api.example:8443/v1/things" });
  assert.equal(badPort.ok, false);
  const badScheme = await driver.execute({ type: "request", method: "GET", path: "http://api.example/v1/things" });
  assert.equal(badScheme.ok, false);
  assert.deepEqual(fetchCalls, ["https://api.example/v1/things"], "only the admitted request reached fetch");
  await driver.close();
});

test("normalizeAllowedOrigins: bare origins pass, dedupe, trailing slash tolerated", () => {
  assert.deepEqual(
    normalizeAllowedOrigins(["https://api.example", "https://api.example/", "http://x.test:8080"], "f.yaml"),
    ["https://api.example", "http://x.test:8080"],
  );
  assert.equal(normalizeAllowedOrigins(null, "f.yaml"), null);
  assert.equal(normalizeAllowedOrigins(undefined, "f.yaml"), null);
  assert.equal(normalizeAllowedOrigins([], "f.yaml"), null);
  // A single string is accepted as a one-entry list.
  assert.deepEqual(normalizeAllowedOrigins("https://api.example", "f.yaml"), ["https://api.example"]);
});

test("normalizeAllowedOrigins: path/query/credentials/scheme violations are config errors naming the file", () => {
  const cases = [
    "https://api.example/v2", // path implies a scoping the guard does not perform
    "https://api.example/?q=1",
    "https://user:pw@api.example",
    "ftp://api.example",
    "not a url",
  ];
  for (const entry of cases) {
    assert.throws(
      () => normalizeAllowedOrigins([entry], "suite/playtest.yaml"),
      (e) => e instanceof DummyConfigError && /suite\/playtest\.yaml/.test(e.message),
      `${entry} throws DummyConfigError naming the file`,
    );
  }
});
