// The case scheduler (docs/backlog/perf/BUILD_PLAN.md, T4.2).
//
// `schedulePool` is the one piece of the runner that is pure: no I/O, no clock
// of its own (the stagger is injected), no model. So the pipelining Phase 4
// introduces — a case hands its worker back as soon as it STOPS RECORDING and
// finishes its grade detached — is provable here with plain deferred promises
// instead of a browser and a gateway.
//
// The vocabulary used throughout: a task calls `permits.release()` at the
// moment its driver is closed and its environment is down. Everything after
// that is its "tail".
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveBudget, schedulePool } from "../../src/runner.ts";

type LegacyTestValue = any; // SAFETY: the scheduler seam is deliberately untyped

/** A promise plus its resolver — a fake clock the test drives by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let every already-resolved microtask (and timer-free await chain) settle. */
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const items = (n: number, record = true) =>
  Array.from({ length: n }, (_, index) => ({ index, record }));

// No stagger anywhere in this file: the 500 ms worker stagger is a rate-limit
// courtesy, not scheduling semantics, and a real timer would make these tests
// slow and flaky.
const NO_STAGGER = { stagger: 0 };

test("resolveBudget: the tail caps default to what could already have been grading", () => {
  assert.deepEqual(resolveBudget(4, 2), { total: 4, record: Infinity, grade: 4, cpu: 4 });
  assert.deepEqual(resolveBudget(true, 3), { total: 3, record: Infinity, grade: 3, cpu: 3 });
  assert.deepEqual(resolveBudget(null, 1), { total: 1, record: Infinity, grade: 1, cpu: 1 });
  // A lopsided pool (many cheap checks, few recordings) only ever grades its
  // recordings, so the grading headroom follows the record cap, not the pool.
  assert.deepEqual(resolveBudget({ total: 10, record: 2 }, 4), { total: 10, record: 2, grade: 2, cpu: 10 });
  // Explicit wins, and 0 is a meaningful grade cap: never detach.
  assert.deepEqual(resolveBudget({ total: 4, record: 4, grade: 1, cpu: 2 }, 4), { total: 4, record: 4, grade: 1, cpu: 2 });
  assert.deepEqual(resolveBudget({ total: 4, grade: 0 }, 4), { total: 4, record: Infinity, grade: 0, cpu: 4 });
});

test("a second recording starts while the first case is still grading", async () => {
  const recording: LegacyTestValue[] = [];
  const tails: LegacyTestValue[] = [];
  const started: number[] = [];
  const graded: number[] = [];

  const done = schedulePool(items(3), { total: 1, record: Infinity, grade: 1, cpu: 1 }, async (item: LegacyTestValue, permits: LegacyTestValue) => {
    started.push(item.index);
    const rec = deferred();
    const tail = deferred();
    recording[item.index] = rec;
    tails[item.index] = tail;
    await rec.promise;          // the "recording"
    permits.release();          // driver closed, environment down
    await permits.grade(async () => {
      await tail.promise;       // the "grade"
      graded.push(item.index);
    });
  }, NO_STAGGER);

  await settle();
  assert.deepEqual(started, [0], "one worker, so exactly one case is recording");

  // Case 0 stops recording but does NOT finish grading.
  recording[0].resolve();
  await settle();
  assert.deepEqual(started, [0, 1], "the freed worker started the next recording");
  assert.deepEqual(graded, [], "…while the first case is still in its grader call");

  // Case 1 also stops recording. The tail budget is 1 and case 0 still holds it,
  // so case 1 keeps its worker: no third recording starts yet.
  recording[1].resolve();
  await settle();
  assert.deepEqual(started, [0, 1], "the tail cap holds — case 2 waits");

  tails[0].resolve();
  await settle();
  assert.deepEqual(graded, [0]);
  assert.deepEqual(started, [0, 1, 2], "a freed tail slot let case 1 detach and case 2 begin");

  recording[2].resolve();
  tails[1].resolve();
  tails[2].resolve();
  await done;
  assert.deepEqual(graded.sort(), [0, 1, 2], "the pool outlives its workers and drains every tail");
});

test("grade: 0 restores the pre-Phase-4 shape — a case owns its worker to the end", async () => {
  const recording: LegacyTestValue[] = [];
  const tails: LegacyTestValue[] = [];
  const started: number[] = [];

  const done = schedulePool(items(2), { total: 1, record: Infinity, grade: 0, cpu: 1 }, async (item: LegacyTestValue, permits: LegacyTestValue) => {
    started.push(item.index);
    const rec = deferred();
    const tail = deferred();
    recording[item.index] = rec;
    tails[item.index] = tail;
    await rec.promise;
    permits.release();
    await tail.promise;
  }, NO_STAGGER);

  await settle();
  recording[0].resolve();
  await settle();
  assert.deepEqual(started, [0], "with no tail budget the release frees no worker");
  tails[0].resolve();
  await settle();
  assert.deepEqual(started, [0, 1]);
  recording[1].resolve();
  tails[1].resolve();
  await done;
});

test("the record cap counts recordings, not cases: a detached tail does not hold it", async () => {
  const recording: LegacyTestValue[] = [];
  const tails: LegacyTestValue[] = [];
  const started: number[] = [];

  // Two workers, but only ONE may record at a time.
  const done = schedulePool(items(3), { total: 2, record: 1, grade: 2, cpu: 2 }, async (item: LegacyTestValue, permits: LegacyTestValue) => {
    started.push(item.index);
    const rec = deferred();
    const tail = deferred();
    recording[item.index] = rec;
    tails[item.index] = tail;
    await rec.promise;
    permits.release();
    await permits.grade(() => tail.promise);
  }, NO_STAGGER);

  await settle();
  assert.deepEqual(started, [0], "the record cap is 1, so the second worker parks");
  recording[0].resolve();
  await settle();
  assert.deepEqual(started, [0, 1], "handing the record permit back admitted the next recording");
  recording[1].resolve();
  await settle();
  assert.deepEqual(started, [0, 1, 2]);
  for (const t of tails) t.resolve();
  for (const rec of recording) rec.resolve();
  await done;
});

test("the grader cap bounds concurrent grades even when every worker is free", async () => {
  const tails: LegacyTestValue[] = [];
  let grading = 0;
  let peak = 0;

  const done = schedulePool(items(4), { total: 4, record: Infinity, grade: 2, cpu: 4 }, async (item: LegacyTestValue, permits: LegacyTestValue) => {
    const tail = deferred();
    tails[item.index] = tail;
    permits.release();
    await permits.grade(async () => {
      peak = Math.max(peak, ++grading);
      await tail.promise;
      grading--;
    });
  }, NO_STAGGER);

  await settle();
  assert.equal(grading, 2, "two permits, two grades");
  assert.equal(peak, 2);
  tails[0].resolve();
  await settle();
  assert.equal(peak, 2, "a freed permit admits exactly one waiter");
  tails[1].resolve();
  tails[2].resolve();
  tails[3].resolve();
  await done;
  assert.equal(peak, 2, "the cap held for the whole suite");
  assert.equal(grading, 0, "no permit leaked");
});

test("the cpu permit bounds artifact generation independently of grading", async () => {
  const gates: LegacyTestValue[] = [];
  let inCpu = 0;
  let peakCpu = 0;

  const done = schedulePool(items(4), { total: 4, record: Infinity, grade: 4, cpu: 1 }, async (item: LegacyTestValue, permits: LegacyTestValue) => {
    const gate = deferred();
    gates[item.index] = gate;
    permits.release();
    await permits.cpu(async () => {
      peakCpu = Math.max(peakCpu, ++inCpu);
      await gate.promise;
      inCpu--;
    });
  }, NO_STAGGER);

  await settle();
  assert.equal(peakCpu, 1, "one ffmpeg at a time");
  for (const g of gates) g.resolve();
  await done;
  assert.equal(peakCpu, 1);
  assert.equal(inCpu, 0);
});

test("a case that fails in its tail leaks no permit and does not strand the suite", async () => {
  const started: number[] = [];
  const finished: number[] = [];

  await assert.rejects(
    schedulePool(items(4), { total: 2, record: 1, grade: 1, cpu: 1 }, async (item: LegacyTestValue, permits: LegacyTestValue) => {
      started.push(item.index);
      permits.release();
      // Case 1 dies AFTER releasing (a teardown throw in the detached tail);
      // case 2 dies BEFORE anything (a crash still holding both permits).
      if (item.index === 1) throw new Error("tail exploded");
      await permits.grade(async () => {
        if (item.index === 2) throw new Error("grade exploded");
        finished.push(item.index);
      });
    }, NO_STAGGER),
    /tail exploded|grade exploded/,
  );

  assert.deepEqual(started.sort(), [0, 1, 2, 3], "every case was dispatched despite two failures");
  assert.deepEqual(finished.sort(), [0, 3], "the survivors completed");
});

test("a task that never releases behaves exactly as it did before the split", async () => {
  const order: string[] = [];
  const gates: LegacyTestValue[] = [];
  const done = schedulePool(items(2), { total: 1, record: Infinity, grade: 2, cpu: 2 }, async (item: LegacyTestValue) => {
    order.push(`start ${item.index}`);
    const gate = deferred();
    gates[item.index] = gate;
    await gate.promise;
    order.push(`end ${item.index}`);
  }, NO_STAGGER);

  await settle();
  assert.deepEqual(order, ["start 0"]);
  gates[0].resolve();
  await settle();
  gates[1].resolve();
  await done;
  assert.deepEqual(order, ["start 0", "end 0", "start 1", "end 1"], "strictly serial, as before");
});
