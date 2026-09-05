import { test } from "node:test";
import assert from "node:assert/strict";
import { jobArguments, jobProfile, runnerOwner } from "../../src/container-profile.ts";
import { resolveApiPath } from "../../src/api-client.ts";
import { deploymentBudget } from "../../src/exec-group.ts";

const env = { PLAYTEST_JOB_IMAGE: "playtest-job:release123", PLAYTEST_JOB_NETWORK: "targets", PLAYTEST_RUNNER_OWNER: runnerOwner("credential-a") };
test("job profile requires matching named inputs and bounds the isolated job", () => {
  const args = jobArguments("executor", env);
  for (const [key, value] of [["--user", "1000:1000"], ["--network", "targets"], ["--memory", "2g"], ["--memory-swap", "2g"], ["--pids-limit", "512"], ["--shm-size", "512m"], ["--cap-drop", "ALL"]]) assert.equal(args[args.indexOf(key!) + 1], value);
  assert.ok(args.includes(`playtest.runner=${env.PLAYTEST_RUNNER_OWNER}`));
  assert.notEqual(runnerOwner("credential-b"), env.PLAYTEST_RUNNER_OWNER);
  assert.throws(() => jobProfile({ ...env, PLAYTEST_JOB_UID: "0" }), /non-root/);
  assert.throws(() => jobProfile({ ...env, PLAYTEST_JOB_IMAGE: "job:latest" }), /matching release/);
  assert.throws(() => jobProfile({ ...env, PLAYTEST_JOB_NETWORK: "" }), /NETWORK/);
});
test("runner API paths cannot carry credentials to another origin or leave the API", () => {
  assert.equal(resolveApiPath("http://control-plane:4177", "/runner/x"), "http://control-plane:4177/api/v1/runner/x");
  assert.equal(resolveApiPath("http://control-plane:4177", "/api/v1/runner/x"), "http://control-plane:4177/api/v1/runner/x");
  for (const path of ["https://evil.test/api/v1/x", "//evil.test/x", "/../../auth/login", "/x\\evil", "http://u:p@control-plane:4177/api/v1/x"]) assert.throws(() => resolveApiPath("http://control-plane:4177", path));
  assert.throws(() => resolveApiPath("http://control-plane:4177/api", "/runner/x"));
});
test("deployment concurrency starts serial and validates explicit ceilings", () => {
  assert.deepEqual(deploymentBudget({}), { total: 1, record: 1 });
  assert.deepEqual(deploymentBudget({ PLAYTEST_RUNNER_MAX_TOTAL: "2", PLAYTEST_RUNNER_MAX_RECORD: "5" }), { total: 2, record: 2 });
  assert.throws(() => deploymentBudget({ PLAYTEST_RUNNER_MAX_TOTAL: "0" }), /MAX_TOTAL/);
});
