// Expected projections over the S0 storage baseline fixture, computed in plain
// JS — no database involved. `expected-projections.json` is the frozen output of
// this module (see `build-expectations.mjs`); a later phase seeds SQLite from
// `fixture.ts`, runs the equivalent SQL, and must reproduce these values exactly.
//
// Everything here is deliberately database-independent: row counts, foreign-key
// closure, canonical JSON strings, epoch-millisecond timestamps, and SHA-256
// object hashes. If SQLite disagrees with any of it, the port changed behavior.

import { COLUMN_TYPES, OBJECTS, TABLE_ORDER, TABLES, canonicalJson, sha256Hex, IDS } from "./fixture.ts";

/** Primary key columns per table, used to address rows in the projection maps. */
export const PRIMARY_KEYS: HostedDynamic = {
  schema_migrations: ["filename"],
  users: ["id"],
  projects: ["id"],
  memberships: ["user_id", "project_id"],
  sessions: ["id"],
  api_tokens: ["id"],
  suites: ["id"],
  suite_files: ["id"],
  suite_snapshots: ["id"],
  environments: ["id"],
  personas: ["id"],
  rule_cards: ["id"],
  secrets: ["id"],
  auth_providers: ["id"],
  session_artifacts: ["id"],
  session_claims: ["id"],
  run_groups: ["id"],
  executors: ["id"],
  runs: ["id"],
  dispatches: ["id"],
  runners: ["id"],
  run_events: ["run_id", "seq"],
  artifacts: ["id"],
  baselines: ["id"],
  candidates: ["id"],
  platform_events: ["id"],
  findings: ["id"],
  finding_evidence: ["id"],
  finding_resolution_stamps: ["finding_id", "suite_id", "environment_id", "case_id"],
  finding_intake_keys: ["id"],
  audit_log: ["id"],
  consolidation_plans: ["id"],
  consolidation_labels: ["id"],
  service_heartbeats: ["name"],
};

/** Foreign keys the loader must satisfy: child column -> parent table.column. */
export const FOREIGN_KEYS: HostedDynamic = [
  ["memberships", "user_id", "users", "id"],
  ["memberships", "project_id", "projects", "id"],
  ["sessions", "user_id", "users", "id"],
  ["api_tokens", "project_id", "projects", "id"],
  ["suites", "project_id", "projects", "id"],
  ["suite_files", "suite_id", "suites", "id"],
  ["suite_files", "updated_by", "users", "id"],
  ["suite_snapshots", "suite_id", "suites", "id"],
  ["suite_snapshots", "created_by", "users", "id"],
  ["environments", "project_id", "projects", "id"],
  ["environments", "suite_id", "suites", "id"],
  ["rule_cards", "project_id", "projects", "id"],
  ["rule_cards", "suite_id", "suites", "id"],
  ["rule_cards", "decided_by", "users", "id"],
  ["personas", "project_id", "projects", "id"],
  ["personas", "created_by", "users", "id"],
  ["secrets", "project_id", "projects", "id"],
  ["secrets", "created_by", "users", "id"],
  ["auth_providers", "project_id", "projects", "id"],
  ["auth_providers", "environment_id", "environments", "id"],
  ["auth_providers", "updated_by", "users", "id"],
  ["session_artifacts", "provider_id", "auth_providers", "id"],
  ["session_claims", "provider_id", "auth_providers", "id"],
  ["run_groups", "project_id", "projects", "id"],
  ["run_groups", "suite_id", "suites", "id"],
  ["run_groups", "snapshot_id", "suite_snapshots", "id"],
  ["run_groups", "environment_id", "environments", "id"],
  ["executors", "run_group_id", "run_groups", "id"],
  ["runs", "run_group_id", "run_groups", "id"],
  ["runs", "executor_id", "executors", "id"],
  ["dispatches", "project_id", "projects", "id"],
  ["dispatches", "executor_id", "executors", "id"],
  ["dispatches", "runner_id", "runners", "id"],
  ["runners", "project_id", "projects", "id"],
  ["runners", "created_by", "users", "id"],
  ["run_events", "run_id", "runs", "id"],
  ["artifacts", "run_id", "runs", "id"],
  ["baselines", "project_id", "projects", "id"],
  ["baselines", "suite_id", "suites", "id"],
  ["baselines", "accepted_by", "users", "id"],
  ["baselines", "accepted_from_run_id", "runs", "id"],
  ["candidates", "project_id", "projects", "id"],
  ["candidates", "suite_id", "suites", "id"],
  ["candidates", "run_id", "runs", "id"],
  ["candidates", "resolved_by", "users", "id"],
  ["platform_events", "project_id", "projects", "id"],
  ["findings", "project_id", "projects", "id"],
  ["findings", "merged_into", "findings", "id"],
  ["findings", "suggested_finding_id", "findings", "id"],
  ["findings", "first_run_id", "runs", "id"],
  ["finding_evidence", "finding_id", "findings", "id"],
  ["finding_evidence", "run_id", "runs", "id"],
  ["finding_intake_keys", "project_id", "projects", "id"],
  ["finding_intake_keys", "finding_id", "findings", "id"],
  ["finding_resolution_stamps", "finding_id", "findings", "id"],
  ["finding_resolution_stamps", "suite_id", "suites", "id"],
  ["finding_resolution_stamps", "environment_id", "environments", "id"],
  ["finding_resolution_stamps", "run_id", "runs", "id"],
  ["consolidation_plans", "project_id", "projects", "id"],
  ["consolidation_labels", "project_id", "projects", "id"],
  ["consolidation_labels", "plan_id", "consolidation_plans", "id"],
  ["consolidation_labels", "subject_finding_id", "findings", "id"],
  ["consolidation_labels", "finding_id", "findings", "id"],
];

const pkOf = (table: HostedDynamic, row: HostedDynamic) => PRIMARY_KEYS[table].map((c: HostedDynamic) => String(row[c])).join("|");
const epoch = (iso: HostedDynamic) => (iso == null ? null : Date.parse(iso));
const num = (n: HostedDynamic) => Math.round(n * 1e6) / 1e6;

export function buildProjections(): HostedDynamic {
  const rowCounts: HostedDynamic = {};
  const canonicalJsonValues: HostedDynamic = {};
  const timestampEpochs: HostedDynamic = {};
  const nullColumns: HostedDynamic = {};

  for (const table of TABLE_ORDER) {
    const rows = TABLES[table];
    rowCounts[table] = rows.length;
    const types = COLUMN_TYPES[table];
    for (const row of rows) {
      const pk = pkOf(table, row);
      for (const [column, type] of Object.entries(types)) {
        const value = row[column];
        if (type === "json") {
          canonicalJsonValues[`${table}:${pk}:${column}`] = value === null ? null : canonicalJson(value);
        } else if (type === "ts") {
          timestampEpochs[`${table}:${pk}:${column}`] = epoch(value);
        }
        if (value === null) (nullColumns[table] ||= []).push(`${pk}:${column}`);
      }
    }
    for (const list of Object.values(nullColumns) as HostedDynamic) list.sort();
  }

  // ---- relationships ------------------------------------------------------
  const index = Object.fromEntries(
    TABLE_ORDER.map((t: HostedDynamic) => [t, new Map(TABLES[t].map((r: HostedDynamic) => [pkOf(t, r), r]))]),
  );
  const parentIds = (table: HostedDynamic, column: HostedDynamic) => new Set(TABLES[table].map((r: HostedDynamic) => r[column]));
  const danglingForeignKeys: HostedDynamic[] = [];
  for (const [child, column, parent, parentColumn] of FOREIGN_KEYS) {
    const known = parentIds(parent, parentColumn);
    for (const row of TABLES[child]) {
      const v = row[column];
      if (v !== null && v !== undefined && !known.has(v)) {
        danglingForeignKeys.push(`${child}.${column}=${v}`);
      }
    }
  }

  // ---- artifact / object integrity ---------------------------------------
  const objectHashes: HostedDynamic = {};
  for (const o of OBJECTS) {
    objectHashes[o.key] = {
      sha256: sha256Hex(o.text),
      size: Buffer.byteLength(o.text, "utf8"),
      role: o.role,
    };
  }
  const referencedKeys = TABLES.artifacts.map((a: HostedDynamic) => a.key).sort();
  const blobKeys = [
    ...new Set(TABLES.suite_snapshots.flatMap((s: HostedDynamic) => Object.values(s.tree).map((sha) => `blobs/${sha}`))),
  ].sort();
  const orphanObjectKeys = OBJECTS.map((o: HostedDynamic) => o.key)
    .filter((k: HostedDynamic) => !referencedKeys.includes(k) && !blobKeys.includes(k))
    .sort();
  const artifactRowsMatchObjects = TABLES.artifacts.every(
    (a: HostedDynamic) => objectHashes[a.key] && objectHashes[a.key].sha256 === a.sha256 && objectHashes[a.key].size === a.size,
  );

  // ---- query-shaped projections (the SQL a port must reproduce) -----------
  const runsByGroup = (gid: HostedDynamic) => TABLES.runs.filter((r: HostedDynamic) => r.run_group_id === gid);
  const groupById = (gid: HostedDynamic) => TABLES.run_groups.find((g: HostedDynamic) => g.id === gid);
  const runProject = (r: HostedDynamic) => groupById(r.run_group_id).project_id;

  const storageByTier: HostedDynamic = {};
  const storageByKind: HostedDynamic = {};
  let storageTotalBytes = 0;
  for (const a of TABLES.artifacts) {
    if (runProject(TABLES.runs.find((r: HostedDynamic) => r.id === a.run_id)) !== IDS.projectMain) continue;
    storageByTier[a.tier] = (storageByTier[a.tier] || 0) + a.size;
    storageByKind[a.kind] = (storageByKind[a.kind] || 0) + a.size;
    storageTotalBytes += a.size;
  }

  const openStates = new Set(["new", "reopened", "accepted"]);
  const activeFindings = TABLES.findings.filter((f: HostedDynamic) => f.merged_into === null);
  const evidenceByFinding: HostedDynamic = {};
  for (const e of TABLES.finding_evidence) {
    evidenceByFinding[e.finding_id] = (evidenceByFinding[e.finding_id] || 0) + 1;
  }

  const spendUsd = num(
    TABLES.runs
      .filter((r: HostedDynamic) => r.totals && typeof r.totals.cost_usd === "number")
      .reduce((sum: HostedDynamic, r: HostedDynamic) => sum + r.totals.cost_usd, 0),
  );

  const latestArtifactPerRunKind: HostedDynamic = {};
  for (const a of [...TABLES.artifacts].sort((x, y) => (x.created_at < y.created_at ? 1 : -1))) {
    const k = `${a.run_id}:${a.kind}`;
    if (!(k in latestArtifactPerRunKind)) latestArtifactPerRunKind[k] = a.id;
  }

  return {
    // 1. Row counts, table by table.
    rowCounts,
    totalRows: Object.values(rowCounts as HostedDynamic).reduce((a: HostedDynamic, b: HostedDynamic) => a + b, 0),
    tables: [...TABLE_ORDER].sort(),

    // 2. Relationships.
    relationships: {
      danglingForeignKeys,
      membershipsPerProject: {
        [IDS.projectMain]: TABLES.memberships.filter((m: HostedDynamic) => m.project_id === IDS.projectMain).length,
        [IDS.projectArchived]: TABLES.memberships.filter((m: HostedDynamic) => m.project_id === IDS.projectArchived).length,
      },
      runsPerGroup: Object.fromEntries(TABLES.run_groups.map((g: HostedDynamic) => [g.id, runsByGroup(g.id).length])),
      artifactsPerRun: Object.fromEntries(
        TABLES.runs.map((r: HostedDynamic) => [r.id, TABLES.artifacts.filter((a: HostedDynamic) => a.run_id === r.id).length]),
      ),
      runEventsMaxSeq: Object.fromEntries(
        [...new Set(TABLES.run_events.map((e: HostedDynamic) => e.run_id))].map((rid) => [
          rid,
          Math.max(...TABLES.run_events.filter((e: HostedDynamic) => e.run_id === rid).map((e: HostedDynamic) => e.seq)),
        ]),
      ),
      suiteSnapshotMaxSeq: Object.fromEntries(
        TABLES.suites.map((s: HostedDynamic) => [
          s.id,
          Math.max(0, ...TABLES.suite_snapshots.filter((x: HostedDynamic) => x.suite_id === s.id).map((x: HostedDynamic) => x.seq)),
        ]),
      ),
      evidenceCountsMatchFindingColumn: TABLES.findings.every(
        (f: HostedDynamic) => f.evidence_count === (evidenceByFinding[f.id] || 0),
      ),
      mergedFindings: TABLES.findings.filter((f: HostedDynamic) => f.merged_into !== null).map((f: HostedDynamic) => f.id),
      activeFindingFingerprintsAreUnique:
        new Set(activeFindings.map((f: HostedDynamic) => `${f.project_id}|${f.fingerprint}`)).size === activeFindings.length,
    },

    // 3. Canonical JSON for every JSON column, keyed table:pk:column.
    canonicalJsonValues,

    // 4. Every timestamp as UTC epoch milliseconds (the frozen SQLite target).
    timestampEpochs,

    // 5. Columns that must round-trip as SQL NULL, not "" / 0 / "null".
    nullColumns,

    // 6. Object-store truth: key -> sha256/size, and what each key is for.
    objects: {
      hashes: objectHashes,
      referencedByArtifacts: referencedKeys,
      referencedBySnapshots: blobKeys,
      orphans: orphanObjectKeys,
      artifactRowsMatchObjects,
    },

    // 7. The read projections behind today's Postgres-specific SQL.
    queries: {
      // GET /projects/:p/storage — artifacts grouped by tier and kind.
      storageUsage: {
        total_bytes: storageTotalBytes,
        artifact_count: TABLES.artifacts.length,
        by_tier: storageByTier,
        by_kind: storageByKind,
      },
      // Retention tier census across runs (artifact_tier is the run-level tier).
      runsByArtifactTier: TABLES.runs.reduce((acc: HostedDynamic, r: HostedDynamic) => {
        acc[r.artifact_tier] = (acc[r.artifact_tier] || 0) + 1;
        return acc;
      }, {}),
      // GET /projects/:p/health — pass/fail over finished runs.
      healthCounts: {
        pass: TABLES.runs.filter((r: HostedDynamic) => r.status === "pass").length,
        fail: TABLES.runs.filter((r: HostedDynamic) => r.status === "fail").length,
        pending_candidates: TABLES.candidates.filter((c: HostedDynamic) => c.status === "pending").length,
      },
      // SUM((totals->>'cost_usd')::numeric) — the JSON-number aggregate.
      llmSpendUsd: spendUsd,
      // GET /projects/:p/findings — the default queue (open, unmerged).
      findingsQueue: activeFindings
        .filter((f: HostedDynamic) => openStates.has(f.state))
        .sort((a: HostedDynamic, b: HostedDynamic) => (a.last_seen < b.last_seen ? 1 : -1))
        .map((f: HostedDynamic) => ({ id: f.id, state: f.state, severity: f.severity, evidence_count: f.evidence_count })),
      // GET /projects/:p/feed — ULID cursor order.
      feedCursorOrder: [...TABLES.platform_events].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => e.id),
      feedTailCursor: [...TABLES.platform_events].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1).id,
      // GET /projects/:p/audit — keyset pagination descending by ULID.
      auditDescOrder: [...TABLES.audit_log].sort((a, b) => (a.id < b.id ? 1 : -1)).map((e) => e.id),
      // DISTINCT ON / row_number(): the newest artifact per (run, kind).
      latestArtifactPerRunKind,
      // The current baseline per (suite, story): superseded_by IS NULL.
      currentBaselines: TABLES.baselines
        .filter((b: HostedDynamic) => b.superseded_by === null)
        .map((b: HostedDynamic) => ({ suite_id: b.suite_id, story_id: b.story_id, version: b.version, id: b.id })),
      // changed.json: manifest->>'healed' is true AND result status is pass.
      changedRuns: TABLES.runs
        .filter((r: HostedDynamic) => r.manifest && r.manifest.healed === true && r.manifest.result?.status === "pass")
        .map((r: HostedDynamic) => r.id),
      // The single-flight partial index: one pending claim per (provider, identity).
      pendingSessionClaims: TABLES.session_claims
        .filter((c: HostedDynamic) => c.status === "pending")
        .map((c: HostedDynamic) => `${c.provider_id}|${c.identity}`),
      // Active dispatches per project (the per-project concurrency cap query).
      activeDispatches: TABLES.dispatches.filter((d: HostedDynamic) =>
        ["requested", "scheduled", "running"].includes(d.status),
      ).length,
    },
  };
}

export default buildProjections;
