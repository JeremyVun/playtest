// Process-mode isolation and cancellation (B3, docs/contracts/hosted.md
// "Process-mode cancellation").
//
// Every case now runs in a child process speaking the case protocol
// (`case-runner-child.ts`). These tests drive the REAL parent — `runCaseIsolated`
// with process isolation — against fixture children that speak that same
// protocol, so what is under test is the production spawn, registry, signal and
// cleanup path, with the engine swapped for something a hermetic test can
// observe.
//
// The cancellation regression the plan owes ("run a deliberately blocking
// process-mode fixture, cancel it, and prove the work is actually terminated and
// cannot later report success") is the first test below. Nothing here sleeps on
// a guess: the fixture announces itself through a protocol event, and the proof
// that a process is gone is polled with a bounded deadline that FAILS rather
// than passing quietly.
//
// `applyProcessEnv` — the reference-counted overlay two concurrent
// process-isolated cases used to share — is gone with the change: each child now
// owns its own environment, which the fourth test states directly.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeCasePids, runCaseIsolated, stopActiveCases } from "../../src/case-runner.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/case-children");
const BLOCKING = path.join(FIXTURES, "blocking.ts");
const GRACEFUL = path.join(FIXTURES, "graceful.ts");
const ECHO = path.join(FIXTURES, "echo.ts");
const FAILING = path.join(FIXTURES, "failing.ts");

/** Is this pid still a process this machine knows about? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for `pid` to be gone, and FAIL loudly if it never is. */
async function untilGone(pid: number, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`${what} (pid ${pid}) was still alive ${timeoutMs}ms after the grace period`);
}

/** Start one process-isolated case and resolve once the fixture announces itself. */
function startCase(
  childEntry: string,
  { env = {}, graceMs = 200, runId = "run-1" }: LegacyTestValue = {},
): { run: Promise<LegacyTestValue>; ready: Promise<LegacyTestValue>; events: LegacyTestValue[] } {
  const events: LegacyTestValue[] = [];
  let announce: (value: LegacyTestValue) => void;
  const ready = new Promise<LegacyTestValue>((resolve) => (announce = resolve));
  const run = runCaseIsolated(
    { id: "checkout", file: "/workspace/suite/checkout.yaml" },
    {
      isolation: "process",
      childEntry,
      graceMs,
      runsRoot: "/workspace/runs",
      runId,
      mode: "auto",
      grade: false,
      env,
      onEvent: (ev: LegacyTestValue) => {
        events.push(ev);
        if (ev.type === "fixture_ready") announce(ev);
      },
    },
  );
  // The rejection is asserted by each test; nothing here may become an
  // unhandled rejection while the test is still setting up.
  run.catch(() => {});
  return { run, ready, events };
}

test("cancelling a process-mode case kills the child's whole process group and reports a cancellation", async () => {
  const secret = "hunter2-super-secret";
  const { run, ready } = startCase(BLOCKING, { env: { PLAYTEST_FIXTURE_SECRET: secret }, graceMs: 200 });
  const started = await ready;

  // The case is really executing, in a process of its own, with a descendant of
  // its own — the browser/ffmpeg shape that a kill by pid alone would orphan.
  assert.ok(alive(started.pid), "the case child is running");
  assert.ok(alive(started.grandchild), "the case child started a descendant");
  assert.deepEqual(activeCasePids(), [started.pid], "the executor tracks the case in flight");
  // Secrets reach the child through the spawn environment. Never argv, which
  // every process on this machine can read.
  assert.equal(started.secret, secret, "the group's environment reached the child");
  assert.equal(
    started.argv.some((a: string) => a.includes(secret)),
    false,
    "no secret is on the command line",
  );

  // The cancel: a heartbeat that answered `canceled`, a SIGTERM, or a stale-owner
  // refusal all arrive here. This fixture ignores the graceful signal, so only
  // the force-kill after the grace period can end it.
  assert.equal(stopActiveCases(), 1);
  await assert.rejects(run, /canceled/, "the case reports a cancellation, never a verdict");

  await untilGone(started.pid, "the case child");
  await untilGone(started.grandchild, "the case child's descendant");
  assert.deepEqual(activeCasePids(), [], "active-process state is cleaned up on the cancellation path");
});

test("a cancelled case is asked to stop first, and settles without waiting out the grace period", async () => {
  // A grace period long enough that the force-kill cannot be what ends this: if
  // the graceful signal were not sent, this test would hang for it. (The kill
  // timer is deliberately not unref'd, so a leaked one would also hold the test
  // process open — this covers the timer cleanup too.)
  const { run, ready } = startCase(GRACEFUL, { graceMs: 30_000 });
  const started = await ready;
  const at = Date.now();
  stopActiveCases();
  await assert.rejects(run, /canceled/);
  await untilGone(started.pid, "the case child");
  assert.ok(Date.now() - at < 10_000, "the child stopped on the graceful signal, not on the force-kill");
  assert.deepEqual(activeCasePids(), []);
});

test("process isolation runs the case in a child and hands back its result untranslated", async () => {
  process.env.PLAYTEST_FIXTURE_INHERITED = "from-the-agent";
  try {
    const events: LegacyTestValue[] = [];
    const result = await runCaseIsolated(
      { id: "checkout", file: "/workspace/suite/checkout.yaml" },
      {
        isolation: "process",
        childEntry: ECHO,
        runsRoot: "/workspace/runs",
        runId: "run-echo",
        mode: "auto",
        grade: true,
        env: { PLAYTEST_FIXTURE_SECRET: "s3cr3t-value" },
        onEvent: (ev: LegacyTestValue) => events.push(ev),
      },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.runId, "run-echo");
    assert.equal(result.echoed.file, "/workspace/suite/checkout.yaml", "no /ws translation on this machine");
    assert.equal(result.runDir, "/workspace/runs");
    assert.equal(result.env.secret, "s3cr3t-value", "the case env reached the child");
    assert.equal(result.env.inherited, "from-the-agent", "the agent's own environment still reaches it");
    assert.equal(
      result.argv.some((a: string) => a.includes("s3cr3t-value")),
      false,
      "no secret is on the command line",
    );
    assert.deepEqual(events.map((e) => e.type), ["step_start"], "progress events stream; stray output is ignored");
    assert.equal(process.env.PLAYTEST_FIXTURE_SECRET, undefined, "the case env never touched this long-lived agent");
    assert.deepEqual(activeCasePids(), [], "active-process state is cleaned up on the success path");
  } finally {
    delete process.env.PLAYTEST_FIXTURE_INHERITED;
  }
});

test("two concurrent process-isolated cases hold different values for the same variable", async () => {
  // The overlay this replaces was reference-counted across concurrent cases and
  // REFUSED this outright ("concurrent process-isolated cases requested
  // different values for …"), because one `process.env` was shared by all of
  // them. A child per case makes the question disappear.
  const one = runCaseIsolated(
    { id: "a" },
    { isolation: "process", childEntry: ECHO, runsRoot: "/w", runId: "a", env: { PLAYTEST_FIXTURE_SECRET: "one" } },
  );
  const two = runCaseIsolated(
    { id: "b" },
    { isolation: "process", childEntry: ECHO, runsRoot: "/w", runId: "b", env: { PLAYTEST_FIXTURE_SECRET: "two" } },
  );
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.env.secret, "one");
  assert.equal(b.env.secret, "two");
  assert.deepEqual(activeCasePids(), []);
});

test("a case child that dies on its own surfaces stderr's first line, and is not a cancellation", async () => {
  await assert.rejects(
    runCaseIsolated(
      { id: "c" },
      { isolation: "process", childEntry: FAILING, runsRoot: "/w", runId: "c" },
    ),
    (e: LegacyTestValue) => {
      assert.equal(e.message, "the case child could not start: no such module");
      assert.doesNotMatch(e.message, /canceled/);
      return true;
    },
  );
  assert.deepEqual(activeCasePids(), [], "active-process state is cleaned up on the failure path");
});
