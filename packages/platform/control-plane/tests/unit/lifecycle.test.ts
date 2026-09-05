import { test } from "node:test";
import assert from "node:assert/strict";
import { Lifecycle } from "../../src/store/lifecycle.ts";

const gate = () => { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; };
test("publication readers overlap, collection waits, and a queued collector precedes new readers", async () => {
  const lock = new Lifecycle();
  const hold = gate();
  const entered = gate();
  const order: string[] = [];
  const publish = lock.read(async () => { order.push("publish"); entered.release(); await hold.wait; await lock.read(async () => { order.push("nested"); }); });
  await entered.wait;
  const collect = lock.delete(async () => { order.push("collect"); });
  const read = lock.read(async () => { order.push("read"); });
  assert.deepEqual(order, ["publish"]);
  hold.release();
  await Promise.all([publish, collect, read]);
  assert.deepEqual(order, ["publish", "nested", "collect", "read"]);
  await assert.rejects(lock.read(() => lock.delete(async () => {})), /cannot upgrade/);
});

test("a detached publication keeps collection excluded after its parent returns", async () => {
  const lock = new Lifecycle(); const hold = gate(); let child!: Promise<void>;
  await lock.read(async () => { child = lock.read(() => hold.wait); });
  let collected = false;
  const collector = lock.delete(async () => { collected = true; });
  await Promise.resolve(); assert.equal(collected, false);
  hold.release(); await child; await collector; assert.equal(collected, true);
});
