import test from "node:test";
import assert from "node:assert/strict";
import { applyProcessEnv } from "../../src/case-runner.ts";

test("process isolation keeps a shared env overlay until the last concurrent case releases it", () => {
  const key = `PLAYTEST_RUNNER_LEASE_TEST_${process.pid}`;
  delete process.env[key];
  const releaseA = applyProcessEnv({ [key]: "shared" });
  const releaseB = applyProcessEnv({ [key]: "shared" });
  assert.equal(process.env[key], "shared");

  releaseA();
  assert.equal(process.env[key], "shared", "the sibling still owns the overlay");
  releaseA();
  assert.equal(process.env[key], "shared", "release is idempotent");
  releaseB();
  assert.equal(process.env[key], undefined);
});

test("process isolation refuses conflicting concurrent env overlays without disturbing the owner", () => {
  const key = `PLAYTEST_RUNNER_LEASE_CONFLICT_${process.pid}`;
  delete process.env[key];
  const release = applyProcessEnv({ [key]: "first" });
  assert.throws(
    () => applyProcessEnv({ [key]: "second" }),
    new RegExp(`different values for ${key}`),
  );
  assert.equal(process.env[key], "first");
  release();
  assert.equal(process.env[key], undefined);
});
