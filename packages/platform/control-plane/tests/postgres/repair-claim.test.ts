// The repair claim at the layer that owns it (src/findings/repair.ts), against
// a real Postgres. Every case below is a race or an expiry: the interleavings
// that only the mutating WHERE can arbitrate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectTestDb } from "./helpers.ts";
import { migrate } from "../../src/migrate.ts";
import { ulid } from "../../src/ulid.ts";
import {
  claimRepair,
  heartbeatRepair,
  releaseRepair,
  repairableSql,
  resetRepairOutcome,
} from "../../src/findings/repair.ts";

async function fixture() {
  const db: HostedDynamic = await connectTestDb();
  await migrate(db);
  const projectId = ulid();
  await db.query(`INSERT INTO projects (id, key, name) VALUES ($1, 'rp', 'Repair')`, [projectId]);
  const finding = async (over: HostedDynamic = {}) => {
    const id = ulid();
    await db.query(
      `INSERT INTO findings (id, project_id, fingerprint, title, severity, state)
         VALUES ($1, $2, $3, $4, 'major', $5)`,
      [id, projectId, `fp-${id}`, over.title ?? "the board never loads", over.state ?? "new"],
    );
    return id;
  };
  const read = async (id: string) => (await db.query(`SELECT * FROM findings WHERE id = $1`, [id])).rows[0];
  const expire = (id: string) =>
    db.query(`UPDATE findings SET repair_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
  return { db, projectId, finding, read, expire };
}

test("two daemons claiming one finding: exactly one wins, and the loser is told nothing changed", async () => {
  const { db, finding, read } = await fixture();
  const id = await finding();
  const [a, b] = await Promise.all([
    claimRepair(db, { findingId: id, owner: "hillclimb@a", ttlSeconds: 600 }),
    claimRepair(db, { findingId: id, owner: "hillclimb@b", ttlSeconds: 600 }),
  ]);
  const won = [a, b].filter(Boolean);
  assert.equal(won.length, 1, `exactly one claim may win, got ${JSON.stringify([a?.repair_owner, b?.repair_owner])}`);
  const row = await read(id);
  assert.equal(row.repair_generation, 1, "one claim, one generation bump");
  assert.equal(row.repair_owner, won[0]!.repair_owner);
  assert.ok(row.repair_expires_at instanceof Date);
  // A third daemon arriving late loses to the same live lease.
  assert.equal(await claimRepair(db, { findingId: id, owner: "hillclimb@c", ttlSeconds: 600 }), null);
  await db.end();
});

test("the holder may re-claim its own live lease, which is a restart and not a race", async () => {
  const { db, finding } = await fixture();
  const id = await finding();
  await claimRepair(db, { findingId: id, owner: "one", ttlSeconds: 600 });
  const again = await claimRepair(db, { findingId: id, owner: "one", ttlSeconds: 600 });
  assert.equal(again?.repair_generation, 2, "re-claiming bumps the generation, so the old beats go stale");
  await db.end();
});

test("a heartbeat needs the exact owner and generation, and a live lease", async () => {
  const { db, finding, expire } = await fixture();
  const id = await finding();
  const claim = await claimRepair(db, { findingId: id, owner: "one", ttlSeconds: 600 });
  const generation = claim!.repair_generation;

  assert.equal(await heartbeatRepair(db, { findingId: id, owner: "one", generation: generation - 1, ttlSeconds: 600 }), null,
    "a stale generation is a lost claim");
  assert.equal(await heartbeatRepair(db, { findingId: id, owner: "two", generation, ttlSeconds: 600 }), null,
    "another owner never extends this lease");

  const beat = await heartbeatRepair(db, { findingId: id, owner: "one", generation, ttlSeconds: 3600 });
  assert.ok(beat, "the holder at the current generation extends its own lease");
  assert.ok(new Date(beat!.repair_expires_at).getTime() > new Date(claim!.repair_expires_at).getTime());
  assert.equal(beat!.repair_generation, generation, "a heartbeat does not bump the generation");

  await expire(id);
  assert.equal(await heartbeatRepair(db, { findingId: id, owner: "one", generation, ttlSeconds: 600 }), null,
    "an expired lease cannot be heartbeated back to life");
  await db.end();
});

test("a release after expiry loses, and a fresh claim then wins at a higher generation", async () => {
  const { db, finding, expire, read } = await fixture();
  const id = await finding();
  const claim = await claimRepair(db, { findingId: id, owner: "one", ttlSeconds: 600 });
  await expire(id);

  assert.equal(
    await releaseRepair(db, { findingId: id, owner: "one", generation: claim!.repair_generation, outcome: "not_fixed" }),
    null,
    "the lease it is concluding is gone",
  );
  assert.equal((await read(id)).repair_outcome, "none", "a lost release writes no outcome");

  const next = await claimRepair(db, { findingId: id, owner: "two", ttlSeconds: 600 });
  assert.equal(next?.repair_owner, "two");
  assert.equal(next?.repair_generation, claim!.repair_generation + 1);
  await db.end();
});

test("a release clears the lease, records the outcome, and keeps the pull request as the external ref", async () => {
  const { db, finding, read } = await fixture();
  const id = await finding();
  const claim = await claimRepair(db, { findingId: id, owner: "one", ttlSeconds: 600 });
  const released = await releaseRepair(db, {
    findingId: id,
    owner: "one",
    generation: claim!.repair_generation,
    outcome: "suggested",
    externalRef: "https://github.com/acme/app/pull/7",
  });
  assert.ok(released);
  const row = await read(id);
  assert.equal(row.repair_owner, null);
  assert.equal(row.repair_expires_at, null);
  assert.equal(row.repair_outcome, "suggested");
  assert.equal(row.external_ref, "https://github.com/acme/app/pull/7");
  // A second release at the same generation is the same lease twice: it lost.
  assert.equal(
    await releaseRepair(db, { findingId: id, owner: "one", generation: claim!.repair_generation, outcome: "not_fixed" }),
    null,
  );
  assert.equal((await read(id)).repair_outcome, "suggested");
  await db.end();
});

test("a concluded finding leaves the queue until a reviewer resets the outcome", async () => {
  const { db, finding, read } = await fixture();
  const id = await finding();
  const claim = await claimRepair(db, { findingId: id, owner: "one", ttlSeconds: 600 });
  await releaseRepair(db, { findingId: id, owner: "one", generation: claim!.repair_generation, outcome: "not_fixed" });
  assert.equal(await claimRepair(db, { findingId: id, owner: "two", ttlSeconds: 600 }), null);

  await resetRepairOutcome(db, id);
  assert.equal((await read(id)).repair_outcome, "none");
  assert.ok(await claimRepair(db, { findingId: id, owner: "two", ttlSeconds: 600 }));
  await db.end();
});

test("the repairable queue offers exactly what a claim would accept", async () => {
  const { db, projectId, finding, expire } = await fixture();
  const free = await finding({ title: "free" });
  const reopened = await finding({ title: "reopened", state: "reopened" });
  const accepted = await finding({ title: "accepted", state: "accepted" });
  const resolved = await finding({ title: "resolved", state: "resolved" });
  const claimed = await finding({ title: "claimed" });
  const stale = await finding({ title: "stale" });
  const concluded = await finding({ title: "concluded" });
  const merged = await finding({ title: "merged" });

  await claimRepair(db, { findingId: claimed, owner: "one", ttlSeconds: 600 });
  await claimRepair(db, { findingId: stale, owner: "one", ttlSeconds: 600 });
  await expire(stale);
  const concludedClaim = await claimRepair(db, { findingId: concluded, owner: "one", ttlSeconds: 600 });
  await releaseRepair(db, { findingId: concluded, owner: "one", generation: concludedClaim!.repair_generation, outcome: "needs_owner" });
  await db.query(`UPDATE findings SET merged_into = $2 WHERE id = $1`, [merged, free]);

  const { rows } = await db.query(
    `SELECT f.id FROM findings f WHERE f.project_id = $1 AND ${repairableSql("f")} ORDER BY f.title`,
    [projectId],
  );
  assert.deepEqual(rows.map((r: HostedDynamic) => r.id).sort(), [free, reopened, stale].sort());
  assert.ok(!rows.some((r: HostedDynamic) => [accepted, resolved, claimed, concluded, merged].includes(r.id)));
  await db.end();
});
