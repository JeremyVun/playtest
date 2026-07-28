import test from "node:test";
import assert from "node:assert/strict";
import { issueRunnerToken, verifyRunnerToken } from "../../src/auth/runner-tokens.ts";

test("runner tokens are signed and scoped", () => {
  const key = Buffer.alloc(32, 7);
  const token = issueRunnerToken(key, { executorId: "exe_1", runGroupId: "grp_1", ttlSeconds: 60 });
  assert.match(token, /^pr_/);
  assert.deepEqual(verifyRunnerToken(key, token), {
    executor_id: "exe_1",
    run_group_id: "grp_1",
    exp: verifyRunnerToken(key, token).exp,
  });
  assert.throws(() => verifyRunnerToken(Buffer.alloc(32, 8), token), /invalid/);
});
