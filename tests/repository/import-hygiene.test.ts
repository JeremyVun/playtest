import { test } from "node:test";
import assert from "node:assert/strict";

test("core library modules import without CLI side effects", async () => {
  const [{ runCase, runAll }, { discoverCases, parseDuration, resolveViewport }, { clip }, { lintCase }] =
    await Promise.all([
      import("@playtest/core/run"),
      import("@playtest/core/suite"),
      import("@playtest/core/media"),
      import("@playtest/core/suite"),
    ]);

  assert.equal(typeof runCase, "function");
  assert.equal(typeof runAll, "function");
  assert.equal(typeof discoverCases, "function");
  assert.equal(typeof parseDuration, "function");
  assert.equal(typeof resolveViewport, "function");
  assert.equal(typeof clip, "function");
  assert.equal(typeof lintCase, "function");
});
