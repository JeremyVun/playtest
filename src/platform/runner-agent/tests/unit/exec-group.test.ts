import test from "node:test";
import assert from "node:assert/strict";
import { applyLimitOverrides, resolveHostedBudget } from "../../src/exec-group.ts";

test("run-group limits override one resolved case without mutating suite defaults", () => {
  const resolved = { id: "checkout", limits: { max_steps: 50, timeout_ms: 240_000 } };
  const overridden = applyLimitOverrides(resolved, { max_steps: 80, timeout_ms: 360_000 });
  assert.deepEqual(overridden.limits, { max_steps: 80, timeout_ms: 360_000 });
  assert.deepEqual(resolved.limits, { max_steps: 50, timeout_ms: 240_000 });
  assert.equal(applyLimitOverrides(resolved), resolved);
});

test("hosted concurrency inherits the project policy and lets the suite replace it", () => {
  assert.deepEqual(
    resolveHostedBudget([{ id: "a", parallel: null }], { total: 6, record: 2 }),
    { total: 6, record: 2 },
  );
  assert.deepEqual(
    resolveHostedBudget([{ id: "a", parallel: { total: 3, record: 1 } }], { total: 6, record: 2 }),
    { total: 3, record: 1 },
    "the pinned suite setting wins",
  );
  assert.deepEqual(
    resolveHostedBudget([{ id: "a", parallel: true }], { total: 6, record: 2 }, 4),
    { total: 4, record: Infinity },
    "core's automatic pool remains available to imported suites",
  );
  assert.deepEqual(resolveHostedBudget([], null), { total: 1, record: 1 }, "hosted remains serial by default");
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
  const api = { json: async (m: string, p2: string, body: LegacyTestValue) => { posts.push(body); } };
  const { progressReporter } = await import("../../src/exec-group.ts");
  const p = progressReporter(api, "g1", "r1", (s: string) => s, { intervalMs: 30 });
  p.onEvent({ type: "case_start", mode: "act", maxSteps: 10, actorModel: null, graderModel: null });
  for (let step = 1; step <= 5; step++) p.onEvent({ type: "step_start", step, summary: `step ${step}` });
  await new Promise((r) => setTimeout(r, 100));
  p.stop();
  assert.ok(posts.length <= 3, `bursts coalesce (saw ${posts.length} posts)`);
  assert.equal(posts.at(-1).step, 5, "the last snapshot carries the latest state");
});
