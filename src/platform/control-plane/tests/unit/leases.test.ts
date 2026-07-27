// S2 lease semantics (docs/contracts/hosted.md, "Background cycles and leases"):
// one winner among concurrent claims, no overlap within a process, and recovery
// of a lease whose holder died. Hermetic: a temporary SQLite file, no clocks
// beyond the injectable `now`, no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { connect } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";
import { claimLease, readLease, releaseLease, renewLease, withLease, OWNER_ID } from "../../src/leases.ts";

const roots: HostedDynamic[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

async function freshDb(): Promise<HostedDynamic> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-lease-"));
  roots.push(dir);
  const db = await connect({ databaseFile: path.join(dir, "playtest.sqlite") });
  await migrate(db);
  return db;
}

test("two concurrent claims produce exactly one winner", async () => {
  const db = await freshDb();
  const results = await Promise.all([
    claimLease(db, "retention", { owner: "a", ttlMs: 60_000 }),
    claimLease(db, "retention", { owner: "b", ttlMs: 60_000 }),
    claimLease(db, "retention", { owner: "c", ttlMs: 60_000 }),
  ]);
  assert.equal(results.filter(Boolean).length, 1, `expected one winner, got ${JSON.stringify(results)}`);
  const row: HostedDynamic = await readLease(db, "retention");
  assert.ok(["a", "b", "c"].includes(row.owner));
  await db.end();
});

test("a second cycle in the same process is refused: the lease is not reentrant", async () => {
  const db = await freshDb();
  // Same owner id, which is what a second overlapping timer tick in one process
  // looks like. It must still lose — non-overlap is the point.
  assert.equal(await claimLease(db, "reconcile", { owner: OWNER_ID, ttlMs: 60_000 }), true);
  assert.equal(await claimLease(db, "reconcile", { owner: OWNER_ID, ttlMs: 60_000 }), false);
  await db.end();
});

test("two attempted worker cycles overlap in time and only one body runs", async () => {
  const db = await freshDb();
  let running = 0;
  let maxConcurrent = 0;
  const cycle = () =>
    withLease(db, "retention", { ttlMs: 60_000 }, async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 60));
      running -= 1;
      return "ran";
    });

  const [first, second] = await Promise.all([cycle(), cycle()]);
  const acquired: HostedDynamic = [first, second].filter((r) => r.acquired);
  assert.equal(acquired.length, 1, "exactly one cycle acquires the lease");
  assert.equal(acquired[0].result, "ran");
  assert.equal(maxConcurrent, 1, "the two cycle bodies never overlapped");

  // And the winner released, so the next scheduled cycle is not locked out.
  assert.equal(await readLease(db, "retention"), null);
  assert.equal((await withLease(db, "retention", {}, async () => "later")).acquired, true);
  await db.end();
});

test("a lease left behind by a dead process is reclaimed once it expires", async () => {
  const db = await freshDb();
  // Simulate process death mid-cycle: a lease row exists, its owner is a pid
  // that is gone, and nothing is renewing it.
  const t0 = Date.now();
  assert.equal(await claimLease(db, "retention", { owner: "dead-host:999999", ttlMs: 30_000, now: t0 }), true);

  // Before expiry the next cycle correctly refuses to steal it.
  assert.equal(await claimLease(db, "retention", { owner: "live", ttlMs: 30_000, now: t0 + 29_000 }), false);
  assert.equal((await readLease(db, "retention") as HostedDynamic).owner, "dead-host:999999");

  // After expiry it is reclaimed — this is the property an in-process flag
  // cannot provide.
  assert.equal(await claimLease(db, "retention", { owner: "live", ttlMs: 30_000, now: t0 + 30_001 }), true);
  const row: HostedDynamic = await readLease(db, "retention");
  assert.equal(row.owner, "live");
  assert.equal(row.expires_at.getTime(), t0 + 30_001 + 30_000);
  await db.end();
});

test("renew extends only the holder's own lease; a lost lease cannot be renewed", async () => {
  const db = await freshDb();
  const t0 = Date.now();
  await claimLease(db, "retention", { owner: "a", ttlMs: 10_000, now: t0 });
  assert.equal(await renewLease(db, "retention", { owner: "a", ttlMs: 10_000, now: t0 + 5_000 }), true);
  assert.equal((await readLease(db, "retention") as HostedDynamic).expires_at.getTime(), t0 + 15_000);
  // The renewal pushed expiry out, so a would-be taker at t0+11s still loses.
  assert.equal(await claimLease(db, "retention", { owner: "b", ttlMs: 10_000, now: t0 + 11_000 }), false);
  // Once b legitimately takes over, a's renewals are no-ops rather than theft.
  assert.equal(await claimLease(db, "retention", { owner: "b", ttlMs: 10_000, now: t0 + 16_000 }), true);
  assert.equal(await renewLease(db, "retention", { owner: "a", ttlMs: 10_000, now: t0 + 17_000 }), false);
  assert.equal((await readLease(db, "retention") as HostedDynamic).owner, "b");
  await db.end();
});

test("a cycle that throws still releases its lease", async () => {
  const db = await freshDb();
  await assert.rejects(
    withLease(db, "retention", { ttlMs: 60_000 }, async () => {
      throw new Error("cycle blew up");
    }),
    /cycle blew up/,
  );
  assert.equal(await readLease(db, "retention"), null, "a failed cycle must not wedge the schedule for a whole TTL");
  await db.end();
});

test("release only affects the caller's own lease", async () => {
  const db = await freshDb();
  await claimLease(db, "retention", { owner: "a", ttlMs: 60_000 });
  assert.equal(await releaseLease(db, "retention", { owner: "b" }), false);
  assert.ok(await readLease(db, "retention"));
  assert.equal(await releaseLease(db, "retention", { owner: "a" }), true);
  assert.equal(await readLease(db, "retention"), null);
  await db.end();
});

test("leases for different cycles are independent", async () => {
  const db = await freshDb();
  assert.equal(await claimLease(db, "retention", { owner: "a", ttlMs: 60_000 }), true);
  assert.equal(await claimLease(db, "reconcile", { owner: "a", ttlMs: 60_000 }), true);
  await db.end();
});
