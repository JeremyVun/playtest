import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyLimitOverrides, claimGroupSessions, resolveHostedBudget } from "../../src/exec-group.ts";
import { RunnerApiError } from "../../src/api-client.ts";

test("run-group limits override one resolved case without mutating suite defaults", () => {
  const resolved = { id: "checkout", limits: { max_steps: 50, timeout_ms: 600_000 } };
  const overridden = applyLimitOverrides(resolved, { max_steps: 80, timeout_ms: 360_000 });
  assert.deepEqual(overridden.limits, { max_steps: 80, timeout_ms: 360_000 });
  assert.deepEqual(resolved.limits, { max_steps: 50, timeout_ms: 600_000 });
  assert.equal(applyLimitOverrides(resolved), resolved);
});

test("hosted concurrency inherits the project policy and lets the suite replace it", () => {
  assert.deepEqual(
    resolveHostedBudget([{ id: "a", parallel: null }], { total: 6, record: 2 }),
    { total: 6, record: 2, grade: 2, cpu: 6 },
  );
  assert.deepEqual(
    resolveHostedBudget([{ id: "a", parallel: { total: 3, record: 1 } }], { total: 6, record: 2 }),
    { total: 3, record: 1, grade: 1, cpu: 3 },
    "the pinned suite setting wins",
  );
  assert.deepEqual(
    resolveHostedBudget([{ id: "a", parallel: true }], { total: 6, record: 2 }, 4),
    { total: 4, record: Infinity, grade: 4, cpu: 4 },
    "core's automatic pool remains available to imported suites",
  );
  assert.deepEqual(
    resolveHostedBudget([], null),
    { total: 1, record: 1, grade: 1, cpu: 1 },
    "a legacy spec with no project policy stays serial",
  );
  // The tail permits are carried but never exercised here:
  // the hosted executor runs each case through runCaseIsolated without passing
  // them down, so a hosted group keeps its strictly serial case boundary.
});

test("progressReporter folds engine events into throttled, redacted snapshots", async () => {
  const posts: LegacyTestValue[] = [];
  const api = { json: async (method: string, path: string, body: LegacyTestValue) => { posts.push({ method, path, body }); } };
  let now = 1_000_000;
  const redactor = (s: string) => s.replaceAll("hunter2-secret", "[redacted]");
  const { progressReporter } = await import("../../src/exec-group.ts");
  const p = progressReporter(api, "g1", "r1", redactor, { intervalMs: 0, now: () => now });

  p.onEvent({ type: "case_start", mode: "record", maxSteps: 40, actorModel: "claude-sonnet-5", graderModel: "claude-haiku-4-5" });
  p.onEvent({ type: "step_start", step: 3, summary: 'typed "hunter2-secret" into the password field' });
  p.onEvent({ type: "step_result", costSoFar: 0.12, tokens: { ctx: 3400, in: 17700, out: 1300 } });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(posts.length >= 1, "a snapshot was posted");
  const snap = posts.at(-1);
  assert.equal(snap.path, "/runner/groups/g1/cases/r1/progress");
  assert.equal(snap.body.step, 3);
  assert.equal(snap.body.max_steps, 40);
  assert.equal(snap.body.doing, "recording");
  assert.ok(!snap.body.action.includes("hunter2-secret"), "free text is redacted before it leaves the process");
  assert.ok(snap.body.action.includes("[redacted]"));
  assert.equal(snap.body.cost_usd, 0.12);
  assert.deepEqual(snap.body.tokens, { ctx: 3400, in: 17700, out: 1300 });
  assert.equal(snap.body.model, "claude-sonnet-5");

  // Post-actor phases clear the stale action, name the phase, and swap the
  // model chip to the model actually doing the work.
  p.onEvent({ type: "phase", phase: "grading" });
  await new Promise((r) => setTimeout(r, 5));
  const graded = posts.at(-1);
  assert.equal(graded.body.doing, "grading");
  assert.equal(graded.body.action, null);
  assert.equal(graded.body.model, "claude-haiku-4-5");

  // Stopped means stopped: a late event posts nothing.
  p.stop();
  const before = posts.length;
  p.onEvent({ type: "step_start", step: 4, summary: "late" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(posts.length, before, "no post after stop");
});

test("progressReporter coalesces events inside the throttle window", async () => {
  const posts: LegacyTestValue[] = [];
  const api = { json: async (_m: string, _p2: string, body: LegacyTestValue) => { posts.push(body); } };
  const { progressReporter } = await import("../../src/exec-group.ts");
  const p = progressReporter(api, "g1", "r1", (s: string) => s, { intervalMs: 30 });
  p.onEvent({ type: "case_start", mode: "act", maxSteps: 10, actorModel: null, graderModel: null });
  for (let step = 1; step <= 5; step++) p.onEvent({ type: "step_start", step, summary: `step ${step}` });
  await new Promise((r) => setTimeout(r, 100));
  p.stop();
  assert.ok(posts.length <= 3, `bursts coalesce (saw ${posts.length} posts)`);
  assert.equal(posts.at(-1).step, 5, "the last snapshot carries the latest state");
});

// ------------------------------------ in-group mints: script vs delivery (B4)
//
// The in-group half of the same boundary `exec-mint.ts` keeps for a standalone
// mint: the customer's script runs exactly once, and only the FULFILLMENT
// request is retried. A transport failure after a successful mint used to be
// posted on the claim as if the script had failed.

/** A grant whose script records every invocation and prints a session. */
function countingGrant(workDir: string, claimId: string) {
  const counter = path.join(workDir, `${claimId}.invocations`);
  return {
    counter,
    mint: {
      claim_id: claimId,
      provider: "sso",
      identity: "member",
      code: `
        import { appendFileSync } from "node:fs";
        appendFileSync(process.env.COUNTER_FILE, "x");
        process.stdout.write(JSON.stringify({ cookies: [{ name: "sid", value: "minted-once" }], origins: [] }));
      `,
      identity_config: {},
      env: { COUNTER_FILE: counter },
      timeout_s: 10,
    },
  };
}

const invocations = (counter: string) => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0);
const spec = { sessions: { needed: ["sso/member"] } };

test("an in-group mint retries only its fulfillment, and runs the script exactly once", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-group-mint-"));
  try {
    const { mint, counter } = countingGrant(workDir, "claim-in-group");
    const posts: LegacyTestValue[] = [];
    let failures = 2;
    const api = {
      json: async (_method: string, route: string, body: LegacyTestValue) => {
        posts.push({ route, body });
        if (route === "/runner/sessions/claim") return { sessions: { "sso/member": { pending: true, mint } } };
        if (failures-- > 0) throw new RunnerApiError(500, { error: { code: "internal", message: "gateway blip" } });
        return { session: { id: "sess-1", storage_state: { cookies: [], origins: [] } } };
      },
    };

    const out = await claimGroupSessions(api, spec, { isolation: "process", workDir, sleep: async () => {} });

    assert.equal(out.sessions["sso/member"].id, "sess-1");
    assert.deepEqual(out.failed, {}, "a delivered mint fails nothing");
    assert.equal(invocations(counter), 1, "the customer's script ran exactly once");
    const fulfills = posts.filter((p) => p.route.endsWith("/fulfill"));
    assert.equal(fulfills.length, 3, "only the fulfillment request was retried");
    assert.equal(fulfills.every((p) => p.body.error === undefined), true, "no script error was ever posted");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("an in-group mint whose fulfillment cannot be delivered is not reported as a script failure", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-group-mint-"));
  try {
    const { mint, counter } = countingGrant(workDir, "claim-undeliverable");
    const posts: LegacyTestValue[] = [];
    const api = {
      json: async (_method: string, route: string, body: LegacyTestValue) => {
        posts.push({ route, body });
        if (route === "/runner/sessions/claim") return { sessions: { "sso/member": { pending: true, mint } } };
        throw new RunnerApiError(500, { error: { code: "internal", message: "gateway blip" } });
      },
    };

    const out = await claimGroupSessions(api, spec, { isolation: "process", workDir, sleep: async () => {} });

    assert.match(out.failed["sso/member"] ?? "", /could not be delivered/);
    assert.equal(invocations(counter), 1);
    assert.equal(
      posts.filter((p) => p.route.endsWith("/fulfill")).every((p) => p.body.error === undefined),
      true,
      "the claim never carries a script error the script did not produce",
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("an in-group mint script that really fails is posted on the claim, scrubbed", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-group-mint-"));
  try {
    const mint = {
      claim_id: "claim-script-failed",
      provider: "sso",
      identity: "member",
      code: `console.error("idp rejected ROOT_PW=" + process.env.ROOT_PW); process.exit(1);`,
      identity_config: {},
      env: { ROOT_PW: "hunter2-super-secret" },
      timeout_s: 10,
    };
    const posts: LegacyTestValue[] = [];
    const api = {
      json: async (_method: string, route: string, body: LegacyTestValue) => {
        posts.push({ route, body });
        if (route === "/runner/sessions/claim") return { sessions: { "sso/member": { pending: true, mint } } };
        return {};
      },
    };

    const out = await claimGroupSessions(api, spec, { isolation: "process", workDir, sleep: async () => {} });

    const failure = out.failed["sso/member"] ?? "";
    assert.match(failure, /idp rejected/);
    assert.equal(failure.includes("hunter2-super-secret"), false, "the grant's secret is scrubbed");
    const fulfills = posts.filter((p) => p.route.endsWith("/fulfill"));
    assert.equal(fulfills.length, 1, "a failed script is reported once, not retried");
    assert.ok(fulfills[0].body.error, "the failure is posted on the claim so the next claimer takes over");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("a stale-owner refusal during fulfillment ends the attempt instead of failing one identity", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-group-mint-"));
  try {
    const { mint, counter } = countingGrant(workDir, "claim-fenced");
    const api = {
      json: async (_method: string, route: string) => {
        if (route === "/runner/sessions/claim") return { sessions: { "sso/member": { pending: true, mint } } };
        throw new RunnerApiError(409, {
          error: { code: "executor_conflict", message: "a newer executor owns this work", details: { reason: "executor_replaced" } },
        });
      },
    };
    await assert.rejects(
      claimGroupSessions(api, spec, { isolation: "process", workDir, sleep: async () => {} }),
      /newer executor/,
    );
    assert.equal(invocations(counter), 1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
