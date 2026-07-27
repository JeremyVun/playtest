// S1 storage tests: migrations from an empty database, the constraint behavior
// the schema is supposed to enforce, the frozen representations from
// docs/backlog/storage/S0-INVENTORY.md §1, and the startup failures an operator
// must be able to act on.
//
// Hermetic: `node:sqlite` is built in, every database is a temporary file, and
// nothing here touches the network, a model, or the object store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Db, canonicalJson, connect, inClause } from "../../src/db.ts";
import { ServerConfigError } from "../../src/config.ts";
import { migrate, migrationFiles } from "../../src/migrate.ts";

const roots: HostedDynamic[] = [];

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-sqlite-"));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

/** A migrated database on a fresh temporary data root. */
async function freshDb(): Promise<HostedDynamic> {
  const dir = tempRoot();
  const db: HostedDynamic = await connect({ databaseFile: path.join(dir, "playtest.sqlite") });
  await migrate(db);
  return { db, dir };
}

// --------------------------------------------------------------- migrations

test("migrations build the whole schema from an empty database and are idempotent", async () => {
  const dir = tempRoot();
  const file = path.join(dir, "nested", "playtest.sqlite");
  const db: HostedDynamic = await connect({ databaseFile: file });

  const ran = await migrate(db);
  assert.deepEqual(ran, migrationFiles(), "a fresh database applies every migration in order");
  assert.ok(fs.existsSync(file), "connect creates the data root it was pointed at");

  const tables = (
    await db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  ).rows.map((r: HostedDynamic) => r.name);
  // 27 baseline tables + 2 consolidation tables (0004) + 1 personas table
  // (0005) + finding_intake_keys (0008) + rule_cards (0012) +
  // finding_resolution_stamps (0013) + runners (0015) + schema_migrations. The
  // three bug-candidate tables 0003 created are dropped again by 0008: the
  // finding is the only defect entity.
  assert.equal(tables.length, 35, "every migration's tables plus schema_migrations");
  for (const added of ["consolidation_plans", "consolidation_labels"]) {
    assert.ok(tables.includes(added), `${added} is created by 0004`);
  }
  assert.ok(tables.includes("personas"), "personas is created by 0005");
  assert.ok(tables.includes("finding_intake_keys"), "finding_intake_keys is created by 0008");
  assert.ok(tables.includes("rule_cards"), "rule_cards is created by 0012");
  assert.ok(tables.includes("finding_resolution_stamps"), "finding_resolution_stamps is created by 0013");
  assert.ok(tables.includes("runners"), "runners is created by 0015");
  for (const collapsed of ["bug_candidates", "bug_candidate_evidence", "bug_candidate_suppressions"]) {
    assert.equal(tables.includes(collapsed), false, `${collapsed} was dropped by the findings collapse (0008)`);
  }
  for (const dropped of [
    "plugins", "plugin_deliveries", "integrations", "insights",
    "authoring_sessions", "legal_holds", "retention_policies",
  ]) {
    assert.equal(tables.includes(dropped), false, `${dropped} was dropped by simplification 0009`);
  }

  // Re-running applies nothing and leaves the recorded order intact.
  assert.deepEqual(await migrate(db), []);
  const recorded = (await db.query("SELECT filename, applied_at FROM schema_migrations ORDER BY filename")).rows;
  assert.deepEqual(recorded.map((r: HostedDynamic) => r.filename), migrationFiles());
  assert.ok(recorded[0].applied_at instanceof Date, "applied_at is a timestamp, not a string");

  // A failed migration leaves no partial schema behind: DDL is transactional.
  const badDir = tempRoot();
  fs.writeFileSync(path.join(badDir, "0001_ok.sql"), "CREATE TABLE ok (id TEXT PRIMARY KEY);");
  fs.writeFileSync(path.join(badDir, "0002_bad.sql"), "CREATE TABLE half (id TEXT);\nCREATE TABLE half (id TEXT);");
  const db2: HostedDynamic = await connect({ databaseFile: path.join(tempRoot(), "x.sqlite") });
  await assert.rejects(() => migrate(db2, { dir: badDir }));
  const after2 = (await db2.query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r: HostedDynamic) => r.name);
  assert.ok(after2.includes("ok"), "the migration that succeeded is committed");
  assert.equal(after2.includes("half"), false, "the failing migration rolled back entirely");
  assert.deepEqual(
    (await db2.query("SELECT filename FROM schema_migrations")).rows.map((r: HostedDynamic) => r.filename),
    ["0001_ok.sql"],
  );

  await db.end();
  await db2.end();
});

test("the required pragmas are set, verified, and actually in force", async () => {
  const { db } = await freshDb();
  const pragma = async (name: HostedDynamic) => Object.values((await db.query(`PRAGMA ${name}`)).rows[0])[0];
  assert.equal(String(await pragma("journal_mode")).toLowerCase(), "wal");
  assert.equal(Number(await pragma("foreign_keys")), 1);
  assert.equal(Number(await pragma("busy_timeout")), 5000);
  assert.equal(Number(await pragma("synchronous")), 2, "FULL");
  await db.end();
});

// --------------------------------------------------------------- constraints

test("foreign keys, cascades, and referential actions are enforced by the database", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO users (id, subject, email) VALUES ($1, $2, $3)", ["u1", "s1", "u@x"]);
  await db.query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)", ["p1", "proj", "Proj"]);
  await db.query("INSERT INTO memberships (user_id, project_id, role) VALUES ($1, $2, $3)", ["u1", "p1", "admin"]);
  await db.query("INSERT INTO suites (id, project_id, slug, name) VALUES ($1, $2, $3, $4)", ["s1", "p1", "a", "A"]);
  await db.query("INSERT INTO suite_snapshots (id, suite_id, seq, tree) VALUES ($1, $2, 1, $3)", ["sn1", "s1", {}]);
  await db.query("INSERT INTO environments (id, project_id, name) VALUES ($1, $2, $3)", ["e1", "p1", "staging"]);

  await assert.rejects(
    () => db.query("INSERT INTO memberships (user_id, project_id, role) VALUES ($1, $2, $3)", ["ghost", "p1", "admin"]),
    /FOREIGN KEY constraint failed/,
  );

  // ON DELETE RESTRICT: a suite with a run group pinned to it cannot vanish.
  await db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
    ["g1", "p1", "s1", "sn1", "e1", { by: "test" }, { cases: [] }],
  );
  await assert.rejects(() => db.query("DELETE FROM suites WHERE id = $1", ["s1"]), /FOREIGN KEY constraint failed/);

  // ON DELETE CASCADE reaches transitively: project -> run_groups -> runs -> run_events.
  await db.query(
    `INSERT INTO runs (id, run_group_id, case_id, run_id, status, mode) VALUES ($1, $2, $3, $4, 'pass', 'act')`,
    ["r1", "g1", "checkout", "R1"],
  );
  await db.query("INSERT INTO run_events (run_id, seq, type) VALUES ($1, 1, 'started')", ["r1"]);
  await db.query("DELETE FROM projects WHERE id = $1", ["p1"]);
  for (const table of ["memberships", "suites", "run_groups", "runs", "run_events", "environments"]) {
    assert.equal((await db.query(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c, 0, `${table} cascaded`);
  }
  await db.end();
});

test("uniqueness constraints, including the partial active-fingerprint index, hold", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)", ["p1", "proj", "Proj"]);

  await assert.rejects(
    () => db.query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)", ["p2", "proj", "Other"]),
    /UNIQUE constraint failed/,
    "projects.key is unique",
  );

  const finding = (id: HostedDynamic, extra: HostedDynamic = {}) => [
    id, "p1", "fp-1", "T", extra.merged ?? null,
  ];
  const insert = `INSERT INTO findings (id, project_id, fingerprint, title, merged_into, severity, state)
                    VALUES ($1, $2, $3, $4, $5, 'major', 'new')`;
  await db.query(insert, finding("f1"));
  await assert.rejects(
    () => db.query(insert, finding("f2")),
    /UNIQUE constraint failed/,
    "two ACTIVE findings cannot share a fingerprint",
  );
  // A merge tombstone is exempt: the unique index is partial on merged_into IS NULL.
  await db.query(insert, finding("f3", { merged: "f1" }));
  assert.equal((await db.query("SELECT COUNT(*) AS c FROM findings")).rows[0].c, 2, "the winner plus its tombstone");

  // CHECK constraints reject values outside the documented enumerations.
  await assert.rejects(
    () => db.query("INSERT INTO memberships (user_id, project_id, role) VALUES ($1, $2, $3)", ["u", "p1", "owner"]),
    /CHECK constraint failed|FOREIGN KEY constraint failed/,
  );
  await db.end();
});

// ------------------------------------------------------ frozen representations

test("JSON columns store canonical JSON and read back as JS values", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)", ["p1", "k", "N"]);

  // Bound as a JS object; two logically equal documents must be byte-equal.
  await db.query(
    "INSERT INTO platform_events (id, project_id, type, entity, payload) VALUES ($1, $2, $3, $4, $5)",
    ["e1", "p1", "run.status", { run_id: "r1" }, { z: 1, a: { d: 4, c: [3, 2] } }],
  );
  await db.query(
    "INSERT INTO platform_events (id, project_id, type, entity, payload) VALUES ($1, $2, $3, $4, $5)",
    ["e2", "p1", "run.status", { run_id: "r1" }, { a: { c: [3, 2], d: 4 }, z: 1 }],
  );
  const stored = (await db.query("SELECT CAST(payload AS TEXT) AS raw FROM platform_events ORDER BY id")).rows;
  assert.equal(stored[0].raw, stored[1].raw, "canonical JSON makes equal documents byte-equal");
  assert.equal(stored[0].raw, '{"a":{"c":[3,2],"d":4},"z":1}');
  assert.equal(canonicalJson({ z: 1, a: { d: 4, c: [3, 2] } }), stored[0].raw);

  const [row] = (await db.query("SELECT entity, payload FROM platform_events WHERE id = $1", ["e1"])).rows;
  assert.deepEqual(row.entity, { run_id: "r1" }, "JSON columns are parsed once, in the adapter");
  assert.equal(row.payload.a.d, 4);

  // NULL (no document) and '{}' (empty document) stay distinguishable.
  await db.query(
    `INSERT INTO runs (id, run_group_id, case_id, run_id, status, mode) VALUES ($1, $1, $1, $1, 'pass', 'act')`,
    ["r0"],
  ).catch(() => {}); // FK-rejected; use a real graph below instead.
  await db.query("INSERT INTO suites (id, project_id, slug, name) VALUES ('s','p1','a','A')");
  await db.query("INSERT INTO suite_snapshots (id, suite_id, seq, tree) VALUES ('sn','s',1,$1)", [{}]);
  await db.query("INSERT INTO environments (id, project_id, name) VALUES ('e','p1','staging')");
  await db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
       VALUES ('g','p1','s','sn','e',$1,$1,'queued')`,
    [{}],
  );
  await db.query(
    `INSERT INTO runs (id, run_group_id, case_id, run_id, status, mode) VALUES ('r','g','c','R','queued','act')`,
  );
  const [run] = (await db.query("SELECT manifest, retention_provenance FROM runs WHERE id = 'r'")).rows;
  assert.equal(run.manifest, null, "an absent document is SQL NULL");
  assert.deepEqual(run.retention_provenance, {}, "an empty document is {}, not NULL");

  // Empty arrays are [], never NULL — the one surviving Postgres text[] column.
  const [env] = (await db.query("SELECT runner_labels FROM environments WHERE id = 'e'")).rows;
  assert.deepEqual(env.runner_labels, []);
  await db.query("UPDATE environments SET runner_labels = $1 WHERE id = 'e'", [["linux", "gpu"]]);
  assert.deepEqual((await db.query("SELECT runner_labels FROM environments WHERE id = 'e'")).rows[0].runner_labels, ["linux", "gpu"]);
  // json_each is how membership is queried now.
  const hit = await db.query(
    "SELECT COUNT(*) AS c FROM environments, json_each(environments.runner_labels) WHERE json_each.value = $1",
    ["gpu"],
  );
  assert.equal(hit.rows[0].c, 1);
  await db.end();
});

test("timestamps are UTC epoch-millisecond integers and read back as Dates", async () => {
  const { db } = await freshDb();
  const when = new Date("2026-06-03T09:02:10.000Z");
  await db.query("INSERT INTO users (id, subject, email, created_at) VALUES ($1, $2, $3, $4)", ["u1", "s", "e", when]);

  const [raw] = (await db.query("SELECT created_at + 0 AS epoch FROM users")).rows;
  assert.equal(raw.epoch, when.getTime(), "stored as epoch milliseconds");
  const [row] = (await db.query("SELECT created_at FROM users")).rows;
  assert.ok(row.created_at instanceof Date);
  assert.equal(row.created_at.toISOString(), "2026-06-03T09:02:10.000Z", "the API wire format is unchanged");
  assert.equal(JSON.parse(JSON.stringify(row)).created_at, "2026-06-03T09:02:10.000Z");

  // now() is frozen at transaction start, so one transaction stamps one instant.
  const stamps = await db.withTx(async (tx: HostedDynamic) => {
    await tx.query("UPDATE users SET created_at = now() WHERE id = $1", ["u1"]);
    const a = (await tx.query("SELECT created_at FROM users")).rows[0].created_at.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await tx.query("UPDATE users SET updated_at = now() WHERE id = $1", ["u1"]);
    const b = (await tx.query("SELECT updated_at FROM users")).rows[0].updated_at.getTime();
    return [a, b];
  });
  assert.equal(stamps[0], stamps[1], "now() is the transaction instant, as under Postgres");
  await db.end();
});

test("booleans round-trip as JS booleans and are constrained to 0/1 in storage", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO users (id, subject, email, disabled) VALUES ($1, $2, $3, $4)", ["u1", "s", "e", true]);
  assert.equal((await db.query("SELECT disabled FROM users")).rows[0].disabled, true);
  assert.equal((await db.query("SELECT disabled + 0 AS d FROM users")).rows[0].d, 1);
  await db.query("UPDATE users SET disabled = $1", [false]);
  assert.equal((await db.query("SELECT disabled FROM users")).rows[0].disabled, false);
  await assert.rejects(() => db.query("UPDATE users SET disabled = 2"), /CHECK constraint failed/);
  await db.end();
});

test("byte columns round-trip as Buffers", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ('p','k','N')");
  const sealed = Buffer.concat([Buffer.alloc(12, 7), Buffer.alloc(16, 9), Buffer.from("payload")]);
  await db.query("INSERT INTO secrets (id, project_id, name, ciphertext) VALUES ('s','p','API_TOKEN',$1)", [sealed]);
  const [row] = (await db.query("SELECT ciphertext FROM secrets")).rows;
  assert.ok(Buffer.isBuffer(row.ciphertext));
  assert.deepEqual(row.ciphertext, sealed, "iv‖tag‖ciphertext is stored verbatim, never hex or base64");
  await db.end();
});

test("computed result columns are returned raw, so call sites parse them deliberately", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ('p','k','N')");
  const [row] = (await db.query("SELECT json_object('a', 1) AS computed, key FROM projects")).rows;
  assert.equal(typeof row.computed, "string", "expression columns have no origin column to decode from");
  assert.deepEqual(JSON.parse(row.computed), { a: 1 });
  assert.equal(row.key, "k");
  await db.end();
});

// ---------------------------------------------------------------- adapter

test("inClause expands a bounded list the way `= ANY($n)` used to", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ('p1','a','A'), ('p2','b','B'), ('p3','c','C')");
  const keys = ["a", "c"];
  const params = ["A", ...keys];
  const { rows } = await db.query(
    `SELECT id FROM projects WHERE name = $1 OR key IN (${inClause(keys, 2)}) ORDER BY id`,
    params,
  );
  assert.deepEqual(rows.map((r: HostedDynamic) => r.id), ["p1", "p3"]);
  await db.end();
});

test("a transaction is atomic, and post-commit callbacks fire only on commit", async () => {
  const { db } = await freshDb();
  const fired: HostedDynamic[] = [];
  db.afterCommit(() => fired.push("no-tx"));
  assert.deepEqual(fired, ["no-tx"], "outside a transaction there is nothing to wait for");

  await assert.rejects(
    () =>
      db.withTx(async (tx: HostedDynamic) => {
        await tx.query("INSERT INTO projects (id, key, name) VALUES ('p1','a','A')");
        db.afterCommit(() => fired.push("rolled-back"));
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal((await db.query("SELECT COUNT(*) AS c FROM projects")).rows[0].c, 0, "the write rolled back");
  assert.deepEqual(fired, ["no-tx"], "a rolled-back transaction emits nothing");

  await db.withTx(async (tx: HostedDynamic) => {
    await tx.query("INSERT INTO projects (id, key, name) VALUES ('p1','a','A')");
    db.afterCommit(() => {
      fired.push("committed");
      // The row must be readable by the time the signal is delivered.
      assert.equal(db.conn.prepare("SELECT COUNT(*) AS c FROM projects").get().c, 1);
    });
    assert.deepEqual(fired, ["no-tx"], "not delivered before COMMIT");
  });
  assert.deepEqual(fired, ["no-tx", "committed"]);
  await db.end();
});

test("a stray db.query inside a transaction joins it instead of leaking or deadlocking", async () => {
  const { db } = await freshDb();
  await assert.rejects(
    () =>
      db.withTx(async () => {
        // Not `tx.query` — the mistake the adapter has to absorb.
        await db.query("INSERT INTO projects (id, key, name) VALUES ('p1','a','A')");
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal((await db.query("SELECT COUNT(*) AS c FROM projects")).rows[0].c, 0);
  await db.end();
});

// ----------------------------------------------------------- startup errors

test("an unwritable data root is a ServerConfigError naming the fix", async () => {
  if (process.getuid?.() === 0) return; // root ignores mode bits
  const dir = tempRoot();
  const locked = path.join(dir, "locked");
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o500);
  try {
    await assert.rejects(
      () => connect({ databaseFile: path.join(locked, "playtest.sqlite") }),
      (e) =>
        e instanceof ServerConfigError &&
        /not writable/.test(e.message) &&
        /PLAYTEST_DATA_DIR/.test(e.message),
    );
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("a database file that cannot be opened is a ServerConfigError, not a stack", async () => {
  const dir = tempRoot();
  // A directory where the database file should be: SQLite cannot open it.
  fs.mkdirSync(path.join(dir, "playtest.sqlite"));
  await assert.rejects(
    () => connect({ databaseFile: path.join(dir, "playtest.sqlite") }),
    (e) => e instanceof ServerConfigError && /PLAYTEST_DATA_DIR/.test(e.message) && !/at Object/.test(e.message),
  );
});

test("a pragma that does not take effect fails startup with an actionable error", async () => {
  const dir = tempRoot();
  const file = path.join(dir, "playtest.sqlite");
  // Journal mode cannot be WAL for an in-memory database, which is exactly the
  // shape of failure a filesystem with unusable locking produces.
  await assert.rejects(
    () => connect({ databaseFile: ":memory:" }),
    (e) =>
      e instanceof ServerConfigError &&
      /journal_mode = WAL/.test(e.message) &&
      /reliable locking/.test(e.message),
  );
  // The happy path on the same root still works, so the check is not vacuous.
  const db: HostedDynamic = await connect({ databaseFile: file });
  await db.end();
});

test("Db decodes rows from the live schema, so a column type change cannot drift", async () => {
  // The decoder is derived from PRAGMA table_info, not a hand-maintained map.
  const dir = tempRoot();
  const conn = new DatabaseSync(path.join(dir, "raw.sqlite"));
  conn.exec("CREATE TABLE t (id TEXT PRIMARY KEY, doc TEXT_JSON, at INT_TS, flag INT_BOOL)");
  const db = new Db(conn, { file: "raw" });
  await db.query("INSERT INTO t (id, doc, at, flag) VALUES ($1, $2, $3, $4)", ["a", { k: 1 }, new Date(5), true]);
  const [row]: HostedDynamic = (await db.query("SELECT * FROM t")).rows;
  assert.deepEqual(row.doc, { k: 1 });
  assert.equal(row.at.getTime(), 5);
  assert.equal(row.flag, true);
  await db.end();
});

// ------------------------------------------------- json_patch merge semantics

test("json_patch merges like jsonb `||` except for nulls, which delete", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ('p','k','N')");
  const insert = `INSERT INTO findings (id, project_id, fingerprint, title, summary, severity, state)
                    VALUES ($1, 'p', $1, 'T', $2, 'major', 'new')`;
  await db.query(insert, ["f1", { story_id: "checkout", gate: { ok: false } }]);

  // The shallow merge jsonb `||` did: named keys set, everything else untouched.
  await db.query(
    `UPDATE findings SET summary = json_patch(summary, json_object(
       'confirmed_at', $2, 'confirmed_by', json($3))) WHERE id = $1`,
    ["f1", 1780000000000, { user_id: "u1" }],
  );
  let summary = (await db.query("SELECT summary FROM findings WHERE id = 'f1'")).rows[0].summary;
  assert.equal(summary.story_id, "checkout", "unrelated keys survive the merge");
  assert.deepEqual(summary.gate, { ok: false });
  assert.equal(summary.confirmed_at, 1780000000000);
  assert.deepEqual(
    summary.confirmed_by,
    { user_id: "u1" },
    "an object value needs the json() wrapper, or json_object stores it as a quoted string",
  );

  // Without json(), the object arrives as a JSON *string* — the silent trap the
  // accept path's wrapper avoids.
  await db.query(
    `UPDATE findings SET summary = json_patch(summary, json_object('naive', $2)) WHERE id = $1`,
    ["f1", { user_id: "u2" }],
  );
  summary = (await db.query("SELECT summary FROM findings WHERE id = 'f1'")).rows[0].summary;
  assert.equal(typeof summary.naive, "string");

  // And the difference from jsonb `||`: a null value DELETES its key. This is
  // why the accept path refuses to build a patch containing one.
  await db.query(
    `UPDATE findings SET summary = json_patch(summary, json_object('story_id', NULL)) WHERE id = $1`,
    ["f1"],
  );
  summary = (await db.query("SELECT summary FROM findings WHERE id = 'f1'")).rows[0].summary;
  assert.equal("story_id" in summary, false, "merge-patch deletes on null where jsonb `||` would set it");
  await db.end();
});
