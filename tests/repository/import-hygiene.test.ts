import { test } from "node:test";
import assert from "node:assert/strict";

test("core library modules import without CLI side effects", async () => {
  const [{ runCase, runAll }, { discoverCases, parseDuration, resolveViewport }, { clip }, { lintCase }] =
    await Promise.all([
      import("../../src/core/runner.ts"),
      import("../../src/core/config.ts"),
      import("../../src/core/clip.ts"),
      import("../../src/core/lint.ts"),
    ]);

  assert.equal(typeof runCase, "function");
  assert.equal(typeof runAll, "function");
  assert.equal(typeof discoverCases, "function");
  assert.equal(typeof parseDuration, "function");
  assert.equal(typeof resolveViewport, "function");
  assert.equal(typeof clip, "function");
  assert.equal(typeof lintCase, "function");
});
