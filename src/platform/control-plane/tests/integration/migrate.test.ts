import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../../src/migrate.ts";
import { withApp } from "./helpers.ts";

test("migrate: idempotent — re-running applies nothing", async () => {
  await withApp(async ({ app }: HostedDynamic) => {
    // createApp already migrated; a second run is a no-op.
    const ran = await migrate(app.db);
    assert.deepEqual(ran, []);
    // Core Phase 1 tables exist.
    const { rows } = await app.db.query(
      `SELECT name AS table_name FROM sqlite_master WHERE type = 'table' ORDER BY 1`,
    );
    const names = rows.map((r: HostedDynamic) => r.table_name);
    for (const t of ["projects", "suites", "suite_files", "suite_snapshots", "environments", "secrets", "audit_log", "users"]) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    // Phase 2 execution-plane tables (migration 0002).
    for (const t of ["runs", "run_groups", "dispatches", "run_events", "artifacts", "executors", "auth_providers", "session_artifacts", "baselines", "candidates", "platform_events"]) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    // Findings tables survive the simplification, and 0008 adds the durable
    // intake-key table while collapsing the bug-candidate lifecycle away.
    for (const t of ["findings", "finding_evidence", "finding_intake_keys"]) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    for (const t of ["bug_candidates", "bug_candidate_evidence", "bug_candidate_suppressions"]) {
      assert.ok(!names.includes(t), `expected table ${t} to be dropped by 0008`);
    }
    // The seven simplification tables are dropped by migration 0009 (P6).
    for (const t of [
      "authoring_sessions", "insights", "plugins", "plugin_deliveries",
      "integrations", "retention_policies", "legal_holds",
    ]) {
      assert.ok(!names.includes(t), `expected table ${t} to be dropped`);
    }
  });
});
