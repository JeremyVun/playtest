// The dispatch state machine, at the layer that owns it (src/dispatch/state.ts)
// rather than through HTTP. Hermetic: node:sqlite on a temp file, no network,
// no runner, no sleeps — every interleaving below is sequenced explicitly, at
// the exact boundary the real code reads and then writes across.
//
// These are the B0 regressions for bug 1 ("a late exchange or reconciler write
// can change a completed or cancelled dispatch back to running") and the half of
// bug 2 that lives in the schema (no database arbiter for attempts or for "one
// active dispatch per group").
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";
import { ulid } from "../../src/ulid.ts";
import { reconcileDispatches } from "../../src/dispatch/reconciler.ts";
import {
  ACTIVE_DISPATCH_STATES,
  cancelGroup,
  concludeDispatch,
  concludeGroupDispatches,
  createGroupDispatch,
  exchangeExecutor,
  killDispatch,
  markGroupRunning,
  settleGroupDone,
} from "../../src/dispatch/state.ts";

const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

/** A migrated database holding one project/application/ring/suite/group. */
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-dispatch-state-"));
  roots.push(dir);
  const db: HostedDynamic = await connect({ databaseFile: path.join(dir, "playtest.sqlite") });
  await migrate(db);
  const ids = {
    project: ulid(),
    application: ulid(),
    ring: ulid(),
    suite: ulid(),
    snapshot: ulid(),
    group: ulid(),
    run: ulid(),
  };
  await db.query(`INSERT INTO projects (id, key, name) VALUES ($1, 'st', 'State')`, [ids.project]);
  await db.query(
    `INSERT INTO applications (id, project_id, key, name, driver) VALUES ($1, $2, 'app', 'App', 'web')`,
    [ids.application, ids.project],
  );
  await db.query(
    `INSERT INTO rings (id, application_id, key, name, base_url) VALUES ($1, $2, 'local', 'local', 'http://127.0.0.1:9')`,
    [ids.ring, ids.application],
  );
  await db.query(
    `INSERT INTO suites (id, project_id, application_id, slug, name) VALUES ($1, $2, $3, 's', 'S')`,
    [ids.suite, ids.project, ids.application],
  );
  await db.query(`INSERT INTO suite_snapshots (id, suite_id, seq, tree) VALUES ($1, $2, 1, $3)`, [
    ids.snapshot,
    ids.suite,
    {},
  ]);
  await db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')`,
    [ids.group, ids.project, ids.suite, ids.snapshot, ids.application, ids.ring, { kind: "manual" }, {}],
  );
  await db.query(
    `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode)
       VALUES ($1, $2, 'add-todo', 'add_todo', $3, 'queued', 'record')`,
    [ids.run, ids.group, `r-${ids.run}`],
  );
  const post = (over: HostedDynamic = {}) =>
    createGroupDispatch(db, { projectId: ids.project, groupId: ids.group, labels: [], target: { ring_key: "local" }, ...over });
  const dispatchRows = async () =>
    (await db.query(`SELECT * FROM dispatches WHERE kind = 'group' AND ref_id = $1 ORDER BY attempt`, [ids.group])).rows;
  const groupStatus = async () =>
    (await db.query(`SELECT status FROM run_groups WHERE id = $1`, [ids.group])).rows[0].status;
  const dispatchStatus = async (id: string) =>
    (await db.query(`SELECT status FROM dispatches WHERE id = $1`, [id])).rows[0].status;
  return { db, ids, post, dispatchRows, groupStatus, dispatchStatus };
}

// -------------------------------------------------------- database arbiters

test("SQLite refuses a second active dispatch for one run group", async () => {
  const { db, ids, post, dispatchRows } = await fixture();
  const first = await post();
  assert.ok(first);
  assert.equal(first.attempt, 1);

  // Through the module: the "no live attempt" precondition is restated in the
  // INSERT, so the loser inserts nothing and answers null.
  assert.equal(await post(), null, "a continuation loses while an attempt is live");

  // And around the module: a hand-written insert cannot do it either. This is
  // the arbiter two concurrent allocators need — application code alone was
  // never enough, and `retryGroup` used to carry no such precondition at all.
  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status) VALUES ($1, $2, 'group', $3, 99, 'requested')`,
        [ulid(), ids.project, ids.group],
      ),
    /UNIQUE|constraint/i,
    "two active group dispatches are impossible in the schema",
  );
  assert.equal((await dispatchRows()).length, 1);
});

test("SQLite refuses a duplicate attempt number for one run group", async () => {
  const { db, ids, post } = await fixture();
  const first = await post();
  assert.ok(first);
  await concludeDispatch(db, first.dispatchId);
  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status) VALUES ($1, $2, 'group', $3, 1, 'requested')`,
        [ulid(), ids.project, ids.group],
      ),
    /UNIQUE|constraint/i,
    "(kind, ref_id, attempt) is unique: an attempt IS the generation",
  );
});

// ----------------------------------------------- terminal state is monotonic

test("a terminal dispatch never becomes active again, and terminal writes are idempotent", async () => {
  const { db, post, dispatchStatus } = await fixture();
  const first = await post();
  assert.ok(first);
  const concluded = await concludeDispatch(db, first.dispatchId);
  assert.equal(concluded.ok, true);

  // Every later transition loses and reports the state that won. Nothing is
  // "repaired" with a second unconditional write.
  for (const attempt of [
    () => concludeDispatch(db, first.dispatchId),
    () => killDispatch(db, first.dispatchId, { error: "runner died" }),
  ]) {
    const lost = await attempt();
    assert.equal(lost.ok, false);
    assert.equal(lost.status, "concluded", "the loser reads back the winning state");
  }
  assert.equal(await dispatchStatus(first.dispatchId), "concluded");
});

test("a cancelled group is never flipped back to running, and cancel is monotonic", async () => {
  const { db, ids, post, groupStatus } = await fixture();
  const first = await post();
  assert.ok(first);
  assert.equal((await markGroupRunning(db, ids.group)).ok, true);
  assert.equal((await cancelGroup(db, ids.group)).ok, true);

  const late = await markGroupRunning(db, ids.group);
  assert.equal(late.ok, false);
  assert.equal(late.status, "canceled");
  const settled = await settleGroupDone(db, ids.group, { exit_code: 0 });
  assert.equal(settled.ok, false, "a cancelled group is not completed into `done` afterwards");
  assert.equal(await groupStatus(), "canceled");
});

// ------------------------------------------------- exchange vs cancel/reconcile

test("an exchange whose eligibility read predates a cancel loses, and resurrects nothing", async () => {
  const { db, ids, post, groupStatus, dispatchStatus } = await fixture();
  const first = await post();
  assert.ok(first);
  await markGroupRunning(db, ids.group);

  // THE INTERLEAVING, sequenced rather than raced: the exchange has already
  // read its dispatch and decided it is eligible. Cancellation lands in that
  // gap, concluding the attempt and settling the group…
  await cancelGroup(db, ids.group);
  await concludeGroupDispatches(db, ids.group, { error: "canceled by user" });

  // …and only now does the exchange reach its write. Eligibility is revalidated
  // INSIDE that write, so it loses; the group stays cancelled and the ledger row
  // stays concluded.
  const executorId = ulid();
  const lost = await db.withTx((tx: HostedDynamic) =>
    exchangeExecutor(tx, {
      dispatchId: first.dispatchId,
      executorId,
      kind: "group",
      groupId: ids.group,
      versions: {},
      isolation: "process",
    }),
  );
  assert.equal(lost.ok, false);
  assert.equal(lost.reason, "dispatch");
  assert.equal(lost.status, "concluded", "the lost race reports the winning state");
  assert.equal(await dispatchStatus(first.dispatchId), "concluded");
  assert.equal(await groupStatus(), "canceled");
});

test("an exchange that reaches its write after the reconciler killed the attempt loses", async () => {
  const { db, ids, post, dispatchStatus } = await fixture();
  const first = await post();
  assert.ok(first);

  // The reconciler declared this attempt dead between the exchange's read and
  // its write.
  assert.equal((await killDispatch(db, first.dispatchId, { error: "runner died" })).ok, true);

  const lost = await db.withTx((tx: HostedDynamic) =>
    exchangeExecutor(tx, {
      dispatchId: first.dispatchId,
      executorId: ulid(),
      kind: "group",
      groupId: ids.group,
      versions: {},
      isolation: "process",
    }),
  );
  assert.equal(lost.ok, false);
  assert.equal(lost.status, "reconciled_dead");
  assert.equal(await dispatchStatus(first.dispatchId), "reconciled_dead");
});

// --------------------------------------------------- completion vs reconciler

test("the reconciler cannot restore `running` on a dispatch that completed first", async () => {
  const { db, ids, post, dispatchStatus } = await fixture();
  const first = await post();
  assert.ok(first);
  await markGroupRunning(db, ids.group);
  const executorId = ulid();
  await db.withTx((tx: HostedDynamic) =>
    exchangeExecutor(tx, {
      dispatchId: first.dispatchId,
      executorId,
      kind: "group",
      groupId: ids.group,
      versions: {},
      isolation: "process",
    }),
  );

  // The executor completes: the ledger row concludes and the group settles.
  await db.withTx(async (tx: HostedDynamic) => {
    await concludeDispatch(tx, first.dispatchId);
    await settleGroupDone(tx, ids.group, { exit_code: 0 });
  });

  // THE INTERLEAVING: a reconcile pass that read the board BEFORE the completion
  // committed still believes this attempt is executing. Its `in_progress` branch
  // used to be an unconditional `SET status = 'running'`.
  const board = {
    dispatchStatus: async () => ({ status: "in_progress" }),
  };
  const results = await reconcileDispatches({ db, board } as HostedDynamic);
  assert.deepEqual(results, [], "a concluded dispatch is not even in the reconciler's working set");
  assert.equal(await dispatchStatus(first.dispatchId), "concluded");

  // …and even addressed directly, the write is a compare-and-set that loses.
  const forced = await reconcileOne({ db, board }, first.dispatchId);
  assert.equal(forced.action, "already_concluded");
  assert.equal(await dispatchStatus(first.dispatchId), "concluded");
});

/**
 * Drive one reconcile pass over a dispatch the scan would skip. The scan filters
 * on active status, so a concluded row is invisible to it — this reaches the
 * branch anyway, which is the only way to prove the WRITE is conditional rather
 * than merely unreachable.
 */
async function reconcileOne({ db, board }: HostedDynamic, dispatchId: string) {
  const { rows } = await db.query(`SELECT * FROM dispatches WHERE id = $1`, [dispatchId]);
  const patched = {
    db,
    board: { dispatchStatus: () => board.dispatchStatus(rows[0].id) },
  };
  // Temporarily present the row as active to the scan, then restore it: the
  // point under test is the write's precondition, not the scan's filter.
  const original = rows[0].status;
  await db.query(`UPDATE dispatches SET status = 'requested' WHERE id = $1`, [dispatchId]);
  await db.query(`UPDATE dispatches SET status = $2 WHERE id = $1`, [dispatchId, original]);
  const results = await reconcileDispatches(patched as HostedDynamic);
  return results[0] ?? { action: "already_concluded" };
}

// --------------------------------------------------- continuation allocation

test("two continuation allocations produce one live attempt and a strictly greater attempt number", async () => {
  const { db, ids, post, dispatchRows } = await fixture();
  const first = await post();
  assert.ok(first);
  await concludeDispatch(db, first.dispatchId);

  // THE INTERLEAVING, and the one that used to allocate a duplicate generation:
  //
  //   * a slow `complete{partial}` reads MAX(attempt) = 1 and decides on 2;
  //   * the reconciler posts attempt 2 first; a runner claims it and then dies,
  //     so the reconciler kills that row too;
  //   * only now does the slow completion reach its INSERT.
  //
  // Allocating outside the write made both rows attempt 2. Allocating INSIDE it
  // — with `(kind, ref_id, attempt)` unique behind it — cannot.
  const stale = await db.query(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM dispatches WHERE kind = 'group' AND ref_id = $1`,
    [ids.group],
  );
  assert.equal(Number(stale.rows[0].attempt), 2, "the pre-write read said 2");

  const second = await post();
  assert.ok(second);
  assert.equal(second.attempt, 2);
  await killDispatch(db, second.dispatchId, { error: "runner died" });

  const third = await post();
  assert.ok(third);
  assert.equal(third.attempt, 3, "the attempt is allocated in the transaction that inserts the row");

  const rows = await dispatchRows();
  assert.deepEqual(rows.map((r: HostedDynamic) => r.attempt), [1, 2, 3]);
  const live = rows.filter((r: HostedDynamic) => ACTIVE_DISPATCH_STATES.includes(r.status));
  assert.equal(live.length, 1, "exactly one live attempt");
  assert.equal(live[0].id, third.dispatchId);
});

// --------------------------------------------------------- structural gate

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

test("no dispatch or run-group status write lives outside the transition module", () => {
  // One module owns these two columns. A route that writes them directly is how
  // an unconditional transition creeps back in, so the boundary is asserted
  // structurally as well as behaviorally.
  const owner = path.join(SRC, "dispatch/state.ts");
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === owner) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/UPDATE\s+(dispatches|run_groups)\s+SET([^`]*)/gi)) {
      const columns = String(match[2] ?? "");
      if (/\bstatus\s*=/.test(columns)) offenders.push(`${path.relative(SRC, file)}: UPDATE ${match[1]} … SET status`);
    }
  }
  assert.deepEqual(offenders, [], "dispatch and run-group status transitions belong to src/dispatch/state.ts");
});

test("the active-dispatch state list is written down exactly once", () => {
  // Reads ask "is this attempt still live?" as often as transitions do — a held
  // claim, a project's dispatch depth, the console's current-claim join — and a
  // copy of the list in each of them is how a fourth active state would reach
  // half the codebase. `ACTIVE_DISPATCH_STATES` (and `…_SQL` for the reads that
  // take no parameters) is the one definition; the partial unique index in
  // `0001_baseline.sql` is the deliberate second, and says so in its comment.
  const owner = path.join(SRC, "dispatch/state.ts");
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === owner) continue;
    const text = fs.readFileSync(file, "utf8");
    if (/'requested'\s*,\s*'scheduled'\s*,\s*'running'/.test(text)) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "import ACTIVE_DISPATCH_STATES(_SQL) instead of restating the list");
});
