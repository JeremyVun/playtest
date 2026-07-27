import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { localRunnerInvocation } from "../../src/dispatch/local.ts";

test("local dispatch starts the runner module directly, not an npm bin shim", () => {
  const invocation = localRunnerInvocation(["--help"], {});

  assert.equal(invocation.command, process.execPath);
  const [entry] = invocation.args;
  assert.ok(entry);
  assert.match(entry, /runner-agent\/src\/exec-group\.ts$/);
  assert.deepEqual(invocation.args.slice(1), ["--help"]);

  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: runner-agent exec/);
});

test("local dispatch preserves an explicit runner executable override", () => {
  assert.deepEqual(
    localRunnerInvocation(["exec", "--group", "g1"], {
      PLAYTEST_RUNNER_AGENT_BIN: "/opt/playtest/runner",
    }),
    {
      command: "/opt/playtest/runner",
      args: ["exec", "--group", "g1"],
    },
  );
});
