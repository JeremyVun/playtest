// Seed the S0 database-neutral baseline fixture into a real SQLite database and
// prove the port reproduces every frozen projection in
// `tests/fixtures/storage-baseline/expected-projections.json` — row counts,
// foreign-key closure, canonical JSON bytes, epoch-millisecond timestamps, NULL
// columns, and the read projections that used to need Postgres-specific SQL.
//
// If SQLite disagrees with any of this, the port changed behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";
import { COLUMN_TYPES, TABLE_ORDER, TABLES, toBuffer } from "../fixtures/storage-baseline/fixture.ts";
import { PRIMARY_KEYS } from "../fixtures/storage-baseline/projections.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = JSON.parse(
  fs.readFileSync(path.resolve(HERE, "../fixtures/storage-baseline/expected-projections.json"), "utf8"),
);

const roots: HostedDynamic[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

/** Bind a neutral fixture value the way the SQLite schema wants it. */
function bind(value: HostedDynamic, type: HostedDynamic) {
  if (value === null) return null;
  if (type === "ts") return new Date(Date.parse(value));
  if (type === "bytes") return toBuffer(value);
  return value; // text/int/bigint/bool pass through; json and text[] are canonicalized by the adapter
}

/** A migrated database seeded with the whole baseline fixture. */
async function seeded(): Promise<HostedDynamic> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-baseline-"));
  roots.push(dir);
  const db: HostedDynamic = await connect({ databaseFile: path.join(dir, "playtest.sqlite") });
  await migrate(db);
  // The fixture owns schema_migrations too (it records the pre-port history), so
  // drop what the runner just wrote and let the fixture be the whole truth.
  await db.query("DELETE FROM schema_migrations");
  await db.withTx(async (tx: HostedDynamic) => {
    for (const table of TABLE_ORDER) {
      const types = COLUMN_TYPES[table];
      const columns = Object.keys(types);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      for (const row of TABLES[table]) {
        await tx.query(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
          columns.map((c) => bind(row[c], types[c])),
        );
      }
    }
  });
  return db;
}

test("the baseline fixture loads into SQLite with every relationship intact", async () => {
  const db = await seeded();

  const counts: HostedDynamic = {};
  for (const table of TABLE_ORDER) {
    counts[table] = (await db.query(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c;
  }
  assert.deepEqual(counts, EXPECTED.rowCounts);
  assert.equal(Object.values(counts as HostedDynamic).reduce((a: HostedDynamic, b: HostedDynamic) => a + b, 0), EXPECTED.totalRows);

  // The database itself agrees there are no dangling references.
  assert.deepEqual((await db.query("PRAGMA foreign_key_check")).rows, []);
  assert.deepEqual(EXPECTED.relationships.danglingForeignKeys, []);

  const rel = EXPECTED.relationships;
  for (const [projectId, expected] of Object.entries(rel.membershipsPerProject)) {
    const { rows } = await db.query("SELECT COUNT(*) AS c FROM memberships WHERE project_id = $1", [projectId]);
    assert.equal(rows[0].c, expected, `memberships for ${projectId}`);
  }
  for (const [groupId, expected] of Object.entries(rel.runsPerGroup)) {
    const { rows } = await db.query("SELECT COUNT(*) AS c FROM runs WHERE run_group_id = $1", [groupId]);
    assert.equal(rows[0].c, expected);
  }
  for (const [runId, expected] of Object.entries(rel.artifactsPerRun)) {
    const { rows } = await db.query("SELECT COUNT(*) AS c FROM artifacts WHERE run_id = $1", [runId]);
    assert.equal(rows[0].c, expected);
  }
  for (const [runId, expected] of Object.entries(rel.runEventsMaxSeq)) {
    const { rows } = await db.query("SELECT MAX(seq) AS m FROM run_events WHERE run_id = $1", [runId]);
    assert.equal(rows[0].m, expected, "run_events.seq stays application-computed and monotonic");
  }
  for (const [suiteId, expected] of Object.entries(rel.suiteSnapshotMaxSeq)) {
    const { rows } = await db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM suite_snapshots WHERE suite_id = $1", [suiteId]);
    assert.equal(rows[0].m, expected);
  }
  const evidenceMismatch = await db.query(`
    SELECT f.id FROM findings f
     WHERE f.evidence_count <> (SELECT COUNT(*) FROM finding_evidence e WHERE e.finding_id = f.id)`);
  assert.deepEqual(evidenceMismatch.rows, [], "evidence_count agrees with the evidence rows");
  assert.deepEqual(
    (await db.query("SELECT id FROM findings WHERE merged_into IS NOT NULL ORDER BY id")).rows.map((r: HostedDynamic) => r.id),
    [...rel.mergedFindings].sort(),
  );
  await db.end();
});

test("every JSON column round-trips as the frozen canonical JSON string", async () => {
  const db = await seeded();
  for (const [key, expected] of Object.entries(EXPECTED.canonicalJsonValues)) {
    const [table, pk, column]: HostedDynamic = key.split(":");
    const keyCols: HostedDynamic = PRIMARY_KEYS[table];
    const pkValues: HostedDynamic = pk.split("|");
    const where = keyCols.map((c: HostedDynamic, i: HostedDynamic) => `${c} = $${i + 1}`).join(" AND ");
    const { rows } = await db.query(
      `SELECT CAST(${column} AS TEXT) AS raw FROM ${table} WHERE ${where}`,
      pkValues,
    );
    assert.equal(rows.length, 1, key);
    assert.equal(rows[0].raw, expected, key);
  }
  await db.end();
});

test("every timestamp is stored as its frozen UTC epoch-millisecond integer", async () => {
  const db = await seeded();
  for (const [key, expected] of Object.entries(EXPECTED.timestampEpochs)) {
    if (expected === null) continue; // covered by the NULL round-trip test below
    const [table, pk, column]: HostedDynamic = key.split(":");
    const keyCols: HostedDynamic = PRIMARY_KEYS[table];
    const pkValues: HostedDynamic = pk.split("|");
    const where = keyCols.map((c: HostedDynamic, i: HostedDynamic) => `${c} = $${i + 1}`).join(" AND ");
    const { rows } = await db.query(
      `SELECT ${column} + 0 AS epoch, typeof(${column}) AS kind FROM ${table} WHERE ${where}`,
      pkValues,
    );
    assert.equal(rows.length, 1, key);
    assert.equal(rows[0].epoch, expected, key);
    assert.equal(rows[0].kind, "integer", `${key} is an INTEGER, not text or a float`);
  }
  await db.end();
});

test("nullable columns round-trip as SQL NULL, never \"\" or 0 or \"null\"", async () => {
  const db = await seeded();
  const nullColumns: HostedDynamic = Object.entries(EXPECTED.nullColumns).flatMap(([table, keys]: HostedDynamic) =>
    keys.map((k: HostedDynamic) => `${table}:${k}`),
  );
  assert.ok(nullColumns.length > 0);
  for (const key of nullColumns) {
    const [table, pk, column] = key.split(":");
    const keyCols = PRIMARY_KEYS[table];
    const pkValues = pk.split("|");
    const where = keyCols.map((c: HostedDynamic, i: HostedDynamic) => `${c} = $${i + 1}`).join(" AND ");
    const { rows } = await db.query(
      `SELECT ${column} IS NULL AS is_null, typeof(${column}) AS kind FROM ${table} WHERE ${where}`,
      pkValues,
    );
    assert.equal(rows.length, 1, key);
    assert.equal(rows[0].is_null, 1, key);
    assert.equal(rows[0].kind, "null", key);
  }
  await db.end();
});

test("the Postgres-specific read projections reproduce their frozen results", async () => {
  const db = await seeded();
  const q = EXPECTED.queries;
  const project = (await db.query("SELECT project_id FROM artifacts a JOIN runs r ON r.id = a.run_id JOIN run_groups g ON g.id = r.run_group_id LIMIT 1")).rows[0].project_id;

  // Storage usage by tier and kind. `SUM(a.size)::bigint` -> CAST(… AS INTEGER),
  // `COUNT(*)::int` -> no cast at all.
  const usage = await db.query(
    `SELECT a.tier, a.kind, CAST(SUM(a.size) AS INTEGER) AS bytes, COUNT(*) AS n
       FROM artifacts a
       JOIN runs r ON r.id = a.run_id
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1
      GROUP BY a.tier, a.kind`,
    [project],
  );
  const byTier: HostedDynamic = {};
  const byKind: HostedDynamic = {};
  let totalBytes = 0;
  let artifactCount = 0;
  for (const row of usage.rows) {
    byTier[row.tier] = (byTier[row.tier] || 0) + row.bytes;
    byKind[row.kind] = (byKind[row.kind] || 0) + row.bytes;
    totalBytes += row.bytes;
    artifactCount += row.n;
  }
  assert.equal(totalBytes, q.storageUsage.total_bytes);
  assert.equal(artifactCount, q.storageUsage.artifact_count);
  assert.deepEqual(byTier, q.storageUsage.by_tier);
  assert.deepEqual(byKind, q.storageUsage.by_kind);

  const tiers = await db.query("SELECT artifact_tier, COUNT(*) AS n FROM runs GROUP BY artifact_tier");
  assert.deepEqual(
    Object.fromEntries(tiers.rows.map((r: HostedDynamic) => [r.artifact_tier, r.n])),
    q.runsByArtifactTier,
  );

  // Aggregate FILTER is native in SQLite; no rewrite was needed.
  const health = await db.query(`
    SELECT COUNT(*) FILTER (WHERE status = 'pass') AS pass,
           COUNT(*) FILTER (WHERE status = 'fail') AS fail
      FROM runs`);
  const pending = await db.query("SELECT COUNT(*) AS n FROM candidates WHERE status = 'pending'");
  assert.deepEqual(
    { pass: health.rows[0].pass, fail: health.rows[0].fail, pending_candidates: pending.rows[0].n },
    q.healthCounts,
  );

  // `SUM((totals->>'cost_usd')::numeric)` -> CAST(json_extract(…) AS REAL).
  const spend = await db.query(`
    SELECT SUM(CAST(json_extract(totals, '$.cost_usd') AS REAL)) AS usd
      FROM runs
     WHERE json_extract(totals, '$.cost_usd') IS NOT NULL`);
  assert.equal(Number(spend.rows[0].usd.toFixed(4)), q.llmSpendUsd);

  // The default findings queue: open, unmerged, newest first.
  const queue = await db.query(`
    SELECT id, state, severity, evidence_count
      FROM findings
     WHERE merged_into IS NULL AND state IN ('new', 'reopened', 'accepted')
     ORDER BY last_seen DESC`);
  assert.deepEqual(queue.rows, q.findingsQueue);

  // Feed cursor order and tail: ULIDs sort lexicographically by time.
  const feed = await db.query("SELECT id FROM platform_events ORDER BY id ASC");
  assert.deepEqual(feed.rows.map((r: HostedDynamic) => r.id), q.feedCursorOrder);
  assert.equal(feed.rows.at(-1).id, q.feedTailCursor);

  const audit = await db.query("SELECT id FROM audit_log ORDER BY id DESC");
  assert.deepEqual(audit.rows.map((r: HostedDynamic) => r.id), q.auditDescOrder);

  // `DISTINCT ON (run_id, kind)` -> row_number() window filtered to rn = 1.
  const latest = await db.query(`
    WITH ranked AS (
      SELECT id, run_id, kind,
             row_number() OVER (PARTITION BY run_id, kind ORDER BY created_at DESC) AS rn
        FROM artifacts
    )
    SELECT run_id, kind, id FROM ranked WHERE rn = 1`);
  assert.deepEqual(
    Object.fromEntries(latest.rows.map((r: HostedDynamic) => [`${r.run_id}:${r.kind}`, r.id])),
    q.latestArtifactPerRunKind,
  );

  const baselines = await db.query(
    "SELECT suite_id, story_id, version, id FROM baselines WHERE superseded_by IS NULL",
  );
  assert.deepEqual(baselines.rows, q.currentBaselines);

  // changed.json: `(manifest->>'healed')::boolean IS TRUE` and the nested status.
  const changed = await db.query(`
    SELECT id FROM runs
     WHERE json_extract(manifest, '$.healed') IN (1, 'true')
       AND json_extract(manifest, '$.result.status') = 'pass'`);
  assert.deepEqual(changed.rows.map((r: HostedDynamic) => r.id), q.changedRuns);

  const claims = await db.query(
    "SELECT provider_id, identity FROM session_claims WHERE status = 'pending'",
  );
  assert.deepEqual(claims.rows.map((r: HostedDynamic) => `${r.provider_id}|${r.identity}`), q.pendingSessionClaims);

  const active = await db.query(
    "SELECT COUNT(*) AS n FROM dispatches WHERE status IN ('requested', 'scheduled', 'running')",
  );
  assert.equal(active.rows[0].n, q.activeDispatches);

  // NULLS LAST has no SQLite equivalent: without the explicit null ordering the
  // suite page's "last run" column silently reorders.
  const nullsLast = await db.query(
    "SELECT id FROM runs ORDER BY (started_at IS NULL), started_at DESC",
  );
  assert.equal(
    (await db.query("SELECT id FROM runs WHERE started_at IS NULL")).rows.some((r: HostedDynamic) => r.id === nullsLast.rows.at(-1).id),
    true,
    "rows with no start time sort last, as under Postgres NULLS LAST",
  );

  await db.end();
});
