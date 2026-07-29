import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeBundle } from "@playtest/core/artifacts";
import { RunBundleCache } from "../../src/run-storage.ts";

test("run bundle cache evicts the least-recently-used bytes deterministically", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-run-cache-"));
  const run = path.join(root, "run");
  fs.mkdirSync(run);
  fs.writeFileSync(path.join(run, "manifest.json"), JSON.stringify({ run_id: "cache-fixture" }));
  const bundlePath = path.join(root, "run.ptrun");
  writeBundle(run, bundlePath);
  const bundle = fs.readFileSync(bundlePath);

  const cache = new RunBundleCache({ maxBytes: bundle.length * 2 });
  const loads = new Map<string, number>();
  const get = (key: string) => cache.provider(key, async () => {
    loads.set(key, (loads.get(key) ?? 0) + 1);
    return bundle;
  });

  try {
    const a = await get("a");
    const b = await get("b");
    assert.equal(await get("a"), a, "a hit refreshes its recency");

    await get("c");
    assert.equal(await get("a"), a, "the recently used entry survives");
    assert.notEqual(await get("b"), b, "the least-recently-used entry reloads");
    assert.deepEqual(Object.fromEntries(loads), { a: 1, b: 2, c: 1 });

    cache.clear();
    assert.notEqual(await get("a"), a, "clearing the app-owned cache releases every entry");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
