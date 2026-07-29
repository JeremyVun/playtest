// OWED BY B3 (process-mode cancellation), and deliberately not written yet:
//
// "Run a deliberately blocking process-mode fixture, cancel it, and prove the
// work is actually terminated and cannot later report success."
//
// That regression cannot exist against this file's current subject. Process
// mode runs `runCase` inside the long-lived agent with no process boundary and
// no abort path, so there is nothing for a test to observe being killed: the
// only honest assertion today would be "cancellation changes bookkeeping",
// which is the bug. B3 must supply the seam first — a supervised child with an
// injectable spawn/entry point — and the test then has to prove, without
// sleeping on a guess:
//
//   1. the child's PROCESS GROUP is gone after the documented grace period
//      (spawn detached, SIGTERM the group, then force-kill it);
//   2. no post-cancellation case report, live upload, or bundle mutation is
//      accepted — the control-plane half of that is already enforced, because
//      cancelling concludes the dispatch and every executor route then answers
//      `executor_conflict` (docs/contracts/hosted.md, "Current executor
//      fencing"), so the runner-side assertion is that it stops trying;
//   3. the result is classified cancelled, never a product verdict;
//   4. listeners, timers, temp files and active-process state are cleaned up on
//      every exit path.
//
// The `applyProcessEnv` lease below is the overlay B3 retires: each child owns
// its own environment, so this test goes with the hack it pins.
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
