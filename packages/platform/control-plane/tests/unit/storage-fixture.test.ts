// Guards the S0 storage baseline fixture (docs/backlog/storage/S0-INVENTORY.md).
// Hermetic: no database, no network, no object store — the whole point of the
// fixture is that it is database-neutral, so this test only checks it against
// the migrations and against its own frozen projections.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COLUMN_TYPES, TABLES, TABLE_ORDER, canonicalJson, toBuffer, fixture } from "../fixtures/storage-baseline/fixture.ts";
import { buildProjections, FOREIGN_KEYS, PRIMARY_KEYS } from "../fixtures/storage-baseline/projections.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../../migrations");
const EXPECTED = path.resolve(HERE, "../fixtures/storage-baseline/expected-projections.json");

/**
 * Ephemeral runtime coordination, deliberately outside the data baseline: a
 * lease row describes which process is mid-cycle right now. It carries no user
 * or evidence data, nothing references it, and restoring one would only make the
 * next background cycle wait out a stale TTL. So it is not fixture-seeded and
 * not part of the migrate/backup projection contract.
 */
const EPHEMERAL_TABLES = new Set(["leases"]);

/** Tables the post-0009 schema actually has: everything created, minus everything dropped. */
function liveTables() {
  const live = new Set(["schema_migrations"]); // created by the migration runner, not a file
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    // In statement order: staged rebuilds (SQLite cannot alter a CHECK) both
    // rename originals aside before recreating them (0008) and rename a new
    // table over the original (0014) — only file order nets them out right.
    const statements = sql.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?(\w+)|DROP TABLE (?:IF EXISTS )?(\w+)|ALTER TABLE (\w+) RENAME TO (\w+)/gi,
    );
    for (const m of statements as HostedDynamic) {
      if (m[1]) live.add(m[1]);
      else if (m[2]) live.delete(m[2]);
      else {
        live.delete(m[3]);
        live.add(m[4]);
      }
    }
  }
  for (const t of EPHEMERAL_TABLES) live.delete(t);
  return live;
}

test("the fixture seeds every table in the post-0009 schema", () => {
  const live = liveTables();
  // The seven simplification tables must be gone from the schema and absent here.
  for (const dropped of [
    "plugins", "plugin_deliveries", "integrations", "insights",
    "authoring_sessions", "legal_holds", "retention_policies",
  ]) {
    assert.equal(live.has(dropped), false, `${dropped} should be dropped by 0009`);
    assert.equal(dropped in TABLES, false, `${dropped} must not appear in the fixture`);
  }
  assert.deepEqual([...live].sort(), [...TABLE_ORDER].sort());
  for (const table of TABLE_ORDER) {
    assert.ok(TABLES[table]?.length > 0, `${table} has no fixture rows`);
    assert.ok(COLUMN_TYPES[table], `${table} has no neutral column types`);
    assert.ok(PRIMARY_KEYS[table], `${table} has no declared primary key`);
  }
});

test("fixture rows are shaped by their declared neutral types", () => {
  for (const table of TABLE_ORDER) {
    const types = COLUMN_TYPES[table];
    for (const row of TABLES[table]) {
      assert.deepEqual(
        Object.keys(row).sort(),
        Object.keys(types).sort(),
        `${table} row ${JSON.stringify(row[PRIMARY_KEYS[table][0]])} column set`,
      );
      for (const [column, type] of Object.entries(types)) {
        const v = row[column];
        const where = `${table}.${column}`;
        if (v === null) continue;
        if (type === "text") assert.equal(typeof v, "string", where);
        else if (type === "int" || type === "bigint") assert.ok(Number.isInteger(v), where);
        else if (type === "float") assert.equal(typeof v, "number", where);
        else if (type === "bool") assert.equal(typeof v, "boolean", where);
        else if (type === "ts") {
          assert.match(v, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, where);
          assert.equal(new Date(Date.parse(v)).toISOString(), v, where);
        } else if (type === "json") assert.equal(typeof v, "object", where);
        else if (type === "text[]") assert.ok(Array.isArray(v), where);
        else if (type === "bytes") {
          assert.ok(Buffer.isBuffer(toBuffer(v)), where);
          assert.ok(toBuffer(v).length >= 28, `${where} shorter than iv+tag`);
        } else assert.fail(`unknown neutral type ${type} for ${where}`);
      }
    }
  }
});

test("primary keys are unique and every foreign key resolves", () => {
  for (const table of TABLE_ORDER) {
    const keys = TABLES[table].map((r: HostedDynamic) => PRIMARY_KEYS[table].map((c: HostedDynamic) => String(r[c])).join("|"));
    assert.equal(new Set(keys).size, keys.length, `${table} has duplicate primary keys`);
  }
  for (const [child, column, parent, parentColumn] of FOREIGN_KEYS) {
    const known = new Set(TABLES[parent].map((r: HostedDynamic) => r[parentColumn]));
    for (const row of TABLES[child]) {
      if (row[column] == null) continue;
      assert.ok(known.has(row[column]), `${child}.${column} -> ${parent}.${parentColumn} dangles`);
    }
  }
});

test("all artifact tiers, artifact kinds, and run states are represented", () => {
  const tiers = new Set(TABLES.artifacts.map((a: HostedDynamic) => a.tier));
  assert.deepEqual([...tiers].sort(), ["core", "full"]);
  const kinds = new Set(TABLES.artifacts.map((a: HostedDynamic) => a.kind));
  assert.deepEqual([...kinds].sort(), ["bundle", "clip", "clip_vtt", "index"]);
  const runTiers = new Set(TABLES.runs.map((r: HostedDynamic) => r.artifact_tier));
  assert.deepEqual([...runTiers].sort(), ["core", "full", "meta"]);
  // A meta-tier run must own no artifact rows; a core run must own no full ones.
  for (const run of TABLES.runs) {
    const owned = TABLES.artifacts.filter((a: HostedDynamic) => a.run_id === run.id);
    if (run.artifact_tier === "meta") assert.equal(owned.length, 0, "meta runs keep no artifacts");
    if (run.artifact_tier === "core") assert.ok(owned.every((a: HostedDynamic) => a.tier === "core"));
  }
  // Object roles cover suite blobs, bundles, sidecars, media, and an orphan.
  assert.deepEqual(
    [...new Set(fixture.objects.map((o: HostedDynamic) => o.role))].sort(),
    ["orphan", "run-bundle", "run-clip", "run-clip-vtt", "run-index", "suite-blob"],
  );
});

test("every artifact row matches the bytes of its object, and blobs are content-addressed", () => {
  const p = buildProjections();
  assert.equal(p.objects.artifactRowsMatchObjects, true);
  for (const snapshot of TABLES.suite_snapshots) {
    for (const [file, sha] of Object.entries(snapshot.tree)) {
      const key = `blobs/${sha}`;
      assert.ok(p.objects.hashes[key], `snapshot ${snapshot.id} references missing blob for ${file}`);
      assert.equal(p.objects.hashes[key].sha256, sha, "blob key is its own content hash");
    }
  }
});

test("the frozen expected projections still describe the fixture", () => {
  const expected = JSON.parse(fs.readFileSync(EXPECTED, "utf8"));
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildProjections())),
    expected,
    "run tests/fixtures/storage-baseline/build-expectations.mjs and review the diff",
  );
  assert.deepEqual(expected.relationships.danglingForeignKeys, []);
  assert.equal(expected.relationships.evidenceCountsMatchFindingColumn, true);
  assert.equal(expected.relationships.activeFindingFingerprintsAreUnique, true);
});

test("canonical JSON is stable, key-sorted, and whitespace-free", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.equal(canonicalJson({ a: 1, b: null }), '{"a":1,"b":null}');
  assert.equal(canonicalJson([]), "[]");
  // Reordering an object's keys must not change its canonical form.
  const env: HostedDynamic = TABLES.environments[0].config;
  const reordered = Object.fromEntries(Object.entries(env).reverse());
  assert.equal(canonicalJson(reordered), canonicalJson(env));
});
