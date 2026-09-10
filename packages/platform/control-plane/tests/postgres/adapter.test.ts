import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { connect } from "../../src/db.ts";
import { migrate, migrationFiles } from "../../src/migrate.ts";
import { ulid } from "../../src/ulid.ts";
import { testDatabase, connectTestDb } from "./helpers.ts";

test("Postgres migrations build the effective schema and reject edited or unknown history", async () => {
  const db = await connectTestDb();
  assert.deepEqual(await migrate(db), migrationFiles());
  assert.deepEqual(await migrate(db), []);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows[0]?.n, 39);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'rings' AND column_name = 'discovery_allowed'")).rows[0]?.n, 0);
  await db.query("UPDATE schema_migrations SET sha256 = 'edited'");
  await assert.rejects(() => migrate(db), /was edited/);
  await db.query("INSERT INTO schema_migrations (filename, sha256) VALUES ('9999_unknown.sql', 'unknown')");
  await assert.rejects(() => migrate(db), /absent from this release/);
});

test("a failed migration rolls back DDL and its ledger row together", async () => {
  const db = await connectTestDb();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pt-migrations-"));
  try {
    await fs.writeFile(path.join(dir, "0001_ok.sql"), "CREATE TABLE ok (id text PRIMARY KEY)");
    await fs.writeFile(path.join(dir, "0002_bad.sql"), "CREATE TABLE half (id text); CREATE TABLE half (id text)");
    await assert.rejects(() => migrate(db, { dir }));
    assert.deepEqual((await db.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename), ["0001_ok.sql"]);
    assert.equal((await db.query("SELECT to_regclass('public.half') AS relation")).rows[0]?.relation, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("writer ownership refuses a second process and returns after the owner closes", async () => {
  const fixture = await testDatabase();
  const first = await connect(fixture);
  await assert.rejects(() => connect(fixture), /Another Playtest writer/);
  await first.end();
  const replacement = await connect(fixture);
  assert.equal((await replacement.query("SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user")).rows[0]?.rolsuper, false);
  await replacement.end();
});

test("nested transactions share the FIFO, rollback emits no wake, and loose queries wait", async () => {
  const db = await connectTestDb();
  await db.exec("CREATE TABLE values_test (value text)");
  const signals: string[] = [];
  let release!: () => void;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const tx = db.withTx(async (outer) => {
    await outer.query("INSERT INTO values_test VALUES ('rollback')");
    await db.withTx(async (inner) => {
      assert.equal(inner, outer);
      await db.query("INSERT INTO values_test VALUES ('nested')");
      db.afterCommit(() => signals.push("bad"));
    });
    entered();
    await pause;
    throw new Error("rollback");
  });
  await started;
  const query = db.query("SELECT value FROM values_test");
  release();
  await assert.rejects(tx, /rollback/);
  assert.deepEqual((await query).rows, []);
  assert.equal(signals.length, 0);
  await db.withTx(async (tx) => {
    await tx.query("INSERT INTO values_test VALUES ('committed')");
    db.afterCommit(() => signals.push("ok"));
  });
  assert.deepEqual(signals, ["ok"]);
});

test("expected conflicts use ON CONFLICT; swallowed SQL errors cannot commit or emit", async () => {
  const db = await connectTestDb();
  await db.exec("CREATE TABLE unique_test (id text PRIMARY KEY)");
  await db.query("INSERT INTO unique_test VALUES ('one')");
  await db.withTx(async (tx) => {
    assert.equal((await tx.query("INSERT INTO unique_test VALUES ('one') ON CONFLICT DO NOTHING")).rowCount, 0);
    await tx.query("INSERT INTO unique_test VALUES ('two')");
  });
  let signaled = false;
  await assert.rejects(() => db.withTx(async (tx) => {
    await tx.query("INSERT INTO unique_test VALUES ('three')");
    await tx.query("INSERT INTO unique_test VALUES ('one')").catch(() => {});
    db.afterCommit(() => { signaled = true; });
  }), /rolled back/);
  assert.equal(signaled, false);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM unique_test")).rows[0]?.n, 2);
});

test("connection loss before commit fails closed and never emits a committed signal", async () => {
  const fixture = await testDatabase();
  const db = await connect(fixture);
  const killer = new pg.Client({ connectionString: fixture.databaseUrl });
  await killer.connect();
  let signaled = false;
  try {
    const pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    await assert.rejects(() => db.withTx(async () => {
      db.afterCommit(() => { signaled = true; });
      await killer.query("SELECT pg_terminate_backend($1)", [pid]);
    }));
    assert.equal(signaled, false);
    await assert.rejects(() => db.query("SELECT 1"));
  } finally { await killer.end(); await db.end(); }
});

test("JSON arrays/nulls, numeric bounds and millisecond timestamp comparisons retain their meanings", async () => {
  const db = await connectTestDb();
  await db.exec("CREATE TABLE typed (doc jsonb, at timestamptz(3) DEFAULT now())");
  await db.query("INSERT INTO typed (doc) VALUES ($1)", [[null, { present: null }, [1, 2]]]);
  const row = (await db.query("SELECT * FROM typed")).rows[0]!;
  assert.deepEqual(row.doc, [null, { present: null }, [1, 2]]);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM typed WHERE at = $1", [row.at])).rows[0]?.n, 1);
  assert.equal((await db.query("SELECT 42::bigint AS n")).rows[0]?.n, 42);
  await assert.rejects(() => db.query("SELECT 9007199254740992::bigint"), /safe range/);
  await assert.rejects(() => db.query("SELECT $1::text", ["used", "extra"]));
});

test("persisted event cursors seed ordering after a restart with a backwards clock", async () => {
  const db = await connectTestDb();
  await migrate(db);
  await db.query("INSERT INTO projects (id, key, name) VALUES ('p', 'p', 'P')");
  const prior = ulid(Date.now() + 60_000);
  await db.query("INSERT INTO platform_events (id, project_id, type, entity) VALUES ($1, 'p', 'run.status', '{}')", [prior]);
  const cursor = (await db.query("SELECT MAX(id) AS id FROM platform_events")).rows[0]?.id;
  const moduleUrl = new URL("../../src/ulid.ts", import.meta.url).href;
  const next = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { seedUlid, ulid } from ${JSON.stringify(moduleUrl)}; seedUlid(process.argv[1]); console.log(ulid(0));`, cursor,
  ], { encoding: "utf8" }).trim();
  assert.ok(next > prior);
});
