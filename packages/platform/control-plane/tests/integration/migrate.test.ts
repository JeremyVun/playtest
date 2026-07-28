import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../../src/migrate.ts";
import { withApp } from "./helpers.ts";

test("migrate: idempotent — re-running applies nothing", async () => {
  await withApp(async ({ app }: HostedDynamic) => {
    // createApp already migrated; a second run is a no-op.
    const ran = await migrate(app.db);
    assert.deepEqual(ran, []);
    const { rows } = await app.db.query(
      `SELECT name AS table_name FROM sqlite_master WHERE type = 'table' ORDER BY 1`,
    );
    const names = rows.map((r: HostedDynamic) => r.table_name);
    // The suite of record and the surfaces it runs against.
    for (const t of ["projects", "applications", "rings", "suites", "suite_files", "suite_snapshots", "secrets", "audit_log", "users"]) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    // The execution plane.
    for (const t of ["runs", "run_groups", "dispatches", "run_events", "artifacts", "executors", "runners", "auth_providers", "session_artifacts", "baselines", "candidates", "platform_events"]) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    for (const t of ["findings", "finding_evidence", "finding_intake_keys", "finding_resolution_stamps"]) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    // Vocabulary the baseline retired: environments and everything the earlier
    // lineage created and dropped again. None of it comes back on a fresh root.
    for (const t of [
      "environments", "bug_candidates", "bug_candidate_evidence", "bug_candidate_suppressions",
      "authoring_sessions", "insights", "plugins", "plugin_deliveries",
      "integrations", "retention_policies", "legal_holds",
    ]) {
      assert.ok(!names.includes(t), `expected table ${t} to be absent`);
    }
  });
});
