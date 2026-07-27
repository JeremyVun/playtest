// Deterministic regression pins for defects found and fixed in the CLEAN
// reference during Phase 1 shakedown (see ledger/shakedown/). Standalone:
//   node --test studies/hillclimb/tests/*.test.js
// One test per fixed shakedown finding; climb-round regression stories live
// with their arms, not here.

import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const subjectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "subject");
const { start } = await import(pathToFileURL(path.join(subjectDir, "server.js")).href);

test("shakedown r1 toast fix: actionable toasts stay up >= 15s (ledger shakedown/round-01)", async () => {
  const app = await start({ port: 0 });
  try {
    const page = await (await fetch(app.url + "/product/monstera")).text();
    const m = page.match(/setTimeout\(function \(\) \{ el\.remove\(\); \}, (\d+)\)/);
    assert.ok(m, "toast auto-dismiss timeout present in shared client JS");
    assert.ok(Number(m[1]) >= 15000, `toast lifetime ${m[1]}ms must be >= 15000ms`);
  } finally {
    await app.close();
  }
});
