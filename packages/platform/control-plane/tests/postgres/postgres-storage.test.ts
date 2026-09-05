import assert from "node:assert/strict";
import { test } from "node:test";
import { inClause } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";
import { connectTestDb } from "./helpers.ts";

async function freshDb(): Promise<HostedDynamic> {
  const db = await connectTestDb();
  await migrate(db);
  return { db };
}

test("foreign keys, cascades, and referential actions are enforced by the database", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO users (id, subject, email) VALUES ($1, $2, $3)", ["u1", "s1", "u@x"]);
  await db.query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)", ["p1", "proj", "Proj"]);
  await db.query("INSERT INTO memberships (user_id, project_id, role) VALUES ($1, $2, $3)", ["u1", "p1", "admin"]);
  await db.query("INSERT INTO applications (id, project_id, key, name, driver) VALUES ($1, $2, $3, $4, 'web')", ["a1", "p1", "todo", "Todo"]);
  await db.query("INSERT INTO rings (id, application_id, key, name, base_url) VALUES ($1, $2, $3, $4, $5)", ["ri1", "a1", "local", "Local", "http://127.0.0.1:4173"]);
  await db.query("INSERT INTO suites (id, project_id, application_id, slug, name) VALUES ($1, $2, $3, $4, $5)", ["s1", "p1", "a1", "a", "A"]);
  await db.query("INSERT INTO suite_snapshots (id, suite_id, seq, tree) VALUES ($1, $2, 1, $3)", ["sn1", "s1", {}]);

  await assert.rejects(
    () => db.query("INSERT INTO memberships (user_id, project_id, role) VALUES ($1, $2, $3)", ["ghost", "p1", "admin"]),
    /violates.*foreign key constraint/,
  );

  // ON DELETE RESTRICT: a suite with a run group pinned to it cannot vanish.
  await db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')`,
    ["g1", "p1", "s1", "sn1", "a1", "ri1", { by: "test" }, { cases: [] }],
  );
  await assert.rejects(() => db.query("DELETE FROM suites WHERE id = $1", ["s1"]), /violates.*foreign key constraint/);
  // Nothing about applications and rings cascades: the model refuses to delete
  // what something still points at, and the constraint backs the API's refusal.
  await assert.rejects(() => db.query("DELETE FROM rings WHERE id = $1", ["ri1"]), /violates.*foreign key constraint/);
  await assert.rejects(() => db.query("DELETE FROM applications WHERE id = $1", ["a1"]), /violates.*foreign key constraint/);
  // A ring-bound auth provider is RESTRICT, never SET NULL: promoting it to
  // project-wide would move secrets policy without anyone deciding it.
  await db.query(
    "INSERT INTO auth_providers (id, project_id, ring_id, name, kind) VALUES ($1, $2, $3, $4, 'script')",
    ["ap1", "p1", "ri1", "sso"],
  );
  await assert.rejects(() => db.query("DELETE FROM rings WHERE id = $1", ["ri1"]), /violates.*foreign key constraint/);

  // ON DELETE CASCADE reaches transitively: project -> run_groups -> runs -> run_events.
  await db.query(
    `INSERT INTO runs (id, run_group_id, case_id, run_id, status, mode) VALUES ($1, $2, $3, $4, 'pass', 'act')`,
    ["r1", "g1", "checkout", "R1"],
  );
  await db.query("INSERT INTO run_events (run_id, seq, type) VALUES ($1, 1, 'started')", ["r1"]);
  // Deleting a project is the one operation that removes everything, and it
  // spells the RESTRICT chain out rather than relying on a cascade that is not
  // there (src/api/projects.ts deleteProject).
  await db.query("DELETE FROM run_groups WHERE project_id = $1", ["p1"]);
  await db.query("DELETE FROM auth_providers WHERE project_id = $1", ["p1"]);
  await db.query("DELETE FROM suites WHERE project_id = $1", ["p1"]);
  await db.query("DELETE FROM rings WHERE application_id IN (SELECT id FROM applications WHERE project_id = $1)", ["p1"]);
  await db.query("DELETE FROM applications WHERE project_id = $1", ["p1"]);
  await db.query("DELETE FROM projects WHERE id = $1", ["p1"]);
  for (const table of ["memberships", "suites", "run_groups", "runs", "run_events", "applications", "rings"]) {
    assert.equal((await db.query(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c, 0, `${table} is gone`);
  }
  await db.end();
});


test("uniqueness constraints, including the partial active-fingerprint index, hold", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)", ["p1", "proj", "Proj"]);
  await assert.rejects(
    () => db.query(
      "INSERT INTO applications (id, project_id, key, name, driver) VALUES ($1, $2, $3, $4, $5)",
      ["a-bad", "p1", "todo", "Todo", "desktop"],
    ),
    /violates check constraint|is of type boolean/,
    "an application is one of the three drivers core can execute",
  );
  await assert.rejects(
    () => db.query(
      "INSERT INTO applications (id, project_id, key, name, driver, platform) VALUES ($1, $2, $3, $4, 'mobile', NULL)",
      ["a-bad2", "p1", "todo-ios", "Todo iOS"],
    ),
    /violates check constraint|is of type boolean/,
    "a mobile application must name its platform — core picks XCUITest or UiAutomator2 from it",
  );
  await assert.rejects(
    () => db.query(
      "INSERT INTO applications (id, project_id, key, name, driver, platform) VALUES ($1, $2, $3, $4, 'web', 'ios')",
      ["a-bad3", "p1", "todo-web", "Todo Web"],
    ),
    /violates check constraint|is of type boolean/,
    "and only a mobile application may name one",
  );
  await db.query("INSERT INTO applications (id, project_id, key, name, driver) VALUES ('a1','p1','todo','Todo','web')");
  await assert.rejects(
    () => db.query("INSERT INTO applications (id, project_id, key, name, driver) VALUES ('a2','p1','todo','Other','api')"),
    /duplicate key value violates unique constraint/,
    "an application key is unique in its project",
  );
  await db.query("INSERT INTO rings (id, application_id, key, name) VALUES ('r1','a1','local','Local')");
  await assert.rejects(
    () => db.query("INSERT INTO rings (id, application_id, key, name) VALUES ('r2','a1','local','Again')"),
    /duplicate key value violates unique constraint/,
    "a ring key is unique within its application",
  );

  await assert.rejects(
    () => db.query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)", ["p2", "proj", "Other"]),
    /duplicate key value violates unique constraint/,
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
    /duplicate key value violates unique constraint/,
    "two ACTIVE findings cannot share a fingerprint",
  );
  // A merge tombstone is exempt: the unique index is partial on merged_into IS NULL.
  await db.query(insert, finding("f3", { merged: "f1" }));
  assert.equal((await db.query("SELECT COUNT(*) AS c FROM findings")).rows[0].c, 2, "the winner plus its tombstone");

  // CHECK constraints reject values outside the documented enumerations.
  await assert.rejects(
    () => db.query("INSERT INTO memberships (user_id, project_id, role) VALUES ($1, $2, $3)", ["u", "p1", "owner"]),
    /violates.*constraint/,
  );
  await db.end();
});


test("JSON columns store canonical JSON and read back as JS values", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)", ["p1", "k", "N"]);
  assert.deepEqual(
    (await db.query("SELECT parallel FROM projects WHERE id = 'p1'")).rows[0].parallel,
    { record: 3, total: 10 },
    "new project rows use the hosted concurrency default",
  );

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
  assert.deepEqual(JSON.parse(stored[0].raw), { a: { c: [3, 2], d: 4 }, z: 1 });


  const [row] = (await db.query("SELECT entity, payload FROM platform_events WHERE id = $1", ["e1"])).rows;
  assert.deepEqual(row.entity, { run_id: "r1" }, "JSON columns are parsed once, in the adapter");
  assert.equal(row.payload.a.d, 4);

  // NULL (no document) and '{}' (empty document) stay distinguishable.
  await db.query(
    `INSERT INTO runs (id, run_group_id, case_id, run_id, status, mode) VALUES ($1, $1, $1, $1, 'pass', 'act')`,
    ["r0"],
  ).catch(() => {}); // FK-rejected; use a real graph below instead.
  await db.query("INSERT INTO applications (id, project_id, key, name, driver) VALUES ('a','p1','todo','Todo','web')");
  await db.query("INSERT INTO suites (id, project_id, application_id, slug, name) VALUES ('s','p1','a','a','A')");
  await db.query("INSERT INTO suite_snapshots (id, suite_id, seq, tree) VALUES ('sn','s',1,$1)", [{}]);
  await db.query("INSERT INTO rings (id, application_id, key, name, base_url) VALUES ('e','a','staging','Staging','https://staging.test')");
  await db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
       VALUES ('g','p1','s','sn','a','e',$1,$1,'queued')`,
    [{}],
  );
  await db.query(
    `INSERT INTO runs (id, run_group_id, case_id, run_id, status, mode) VALUES ('r','g','c','R','queued','act')`,
  );
  const [run] = (await db.query("SELECT manifest, retention_provenance FROM runs WHERE id = 'r'")).rows;
  assert.equal(run.manifest, null, "an absent document is SQL NULL");
  assert.deepEqual(run.retention_provenance, {}, "an empty document is {}, not NULL");

  // Empty arrays are [], never NULL — the one surviving Postgres text[] column.
  const [ring] = (await db.query("SELECT runner_labels FROM rings WHERE id = 'e'")).rows;
  assert.deepEqual(ring.runner_labels, []);
  await db.query("UPDATE rings SET runner_labels = $1 WHERE id = 'e'", [["linux", "gpu"]]);
  assert.deepEqual((await db.query("SELECT runner_labels FROM rings WHERE id = 'e'")).rows[0].runner_labels, ["linux", "gpu"]);
  // json_each is how membership is queried now.
  const hit = await db.query(
    "SELECT COUNT(*) AS c FROM rings, jsonb_array_elements_text(rings.runner_labels) AS labels(value) WHERE labels.value = $1",
    ["gpu"],
  );
  assert.equal(hit.rows[0].c, 1);
  await db.end();
});


test("timestamps retain UTC milliseconds and read back as Dates", async () => {
  const { db } = await freshDb();
  const when = new Date("2026-06-03T09:02:10.000Z");
  await db.query("INSERT INTO users (id, subject, email, created_at) VALUES ($1, $2, $3, $4)", ["u1", "s", "e", when]);

  const [raw] = (await db.query("SELECT EXTRACT(EPOCH FROM created_at) * 1000 AS epoch FROM users")).rows;
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


test("booleans round-trip and reject numeric SQL assignments", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO users (id, subject, email, disabled) VALUES ($1, $2, $3, $4)", ["u1", "s", "e", true]);
  assert.equal((await db.query("SELECT disabled FROM users")).rows[0].disabled, true);
  assert.equal((await db.query("SELECT disabled::integer AS d FROM users")).rows[0].d, 1);
  await db.query("UPDATE users SET disabled = $1", [false]);
  assert.equal((await db.query("SELECT disabled FROM users")).rows[0].disabled, false);
  await assert.rejects(() => db.query("UPDATE users SET disabled = 2"), /violates check constraint|is of type boolean/);
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


test("computed JSON results decode like persisted JSON columns", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ('p','k','N')");
  const [row] = (await db.query("SELECT jsonb_build_object('a', 1) AS computed, key FROM projects")).rows;
  assert.deepEqual(row.computed, { a: 1 });
  assert.equal(row.key, "k");
  await db.end();
});


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
    const inserted = tx.query("INSERT INTO projects (id, key, name) VALUES ('p1','a','A')");
    assert.ok(inserted instanceof Promise, "transaction queries expose the asynchronous database contract");
    await inserted;
    db.afterCommit(() => {
      fired.push("committed");
      // The row must be readable by the time the signal is delivered.
      assert.equal(db.als.getStore(), undefined);
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


test("json_patch merges like jsonb `||` except for nulls, which delete", async () => {
  const { db } = await freshDb();
  await db.query("INSERT INTO projects (id, key, name) VALUES ('p','k','N')");
  const insert = `INSERT INTO findings (id, project_id, fingerprint, title, summary, severity, state)
                    VALUES ($1, 'p', $1, 'T', $2, 'major', 'new')`;
  await db.query(insert, ["f1", { story_id: "checkout", gate: { ok: false } }]);

  // The shallow merge jsonb `||` did: named keys set, everything else untouched.
  await db.query(
    `UPDATE findings SET summary = jsonb_merge_patch(summary, jsonb_build_object(
       'confirmed_at', $2::bigint, 'confirmed_by', $3::jsonb)) WHERE id = $1`,
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
    `UPDATE findings SET summary = jsonb_merge_patch(summary, jsonb_build_object('naive', $2::text)) WHERE id = $1`,
    ["f1", { user_id: "u2" }],
  );
  summary = (await db.query("SELECT summary FROM findings WHERE id = 'f1'")).rows[0].summary;
  assert.equal(typeof summary.naive, "string");

  // And the difference from jsonb `||`: a null value DELETES its key. This is
  // why the accept path refuses to build a patch containing one.
  await db.query(
    `UPDATE findings SET summary = jsonb_merge_patch(summary, jsonb_build_object('story_id', NULL)) WHERE id = $1`,
    ["f1"],
  );
  summary = (await db.query("SELECT summary FROM findings WHERE id = 'f1'")).rows[0].summary;
  assert.equal("story_id" in summary, false, "merge-patch deletes on null where jsonb `||` would set it");
  await db.end();
});
