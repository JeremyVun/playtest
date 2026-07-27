// Pins viewer-adapter.js `runEntry`'s run-path resolution:
// a bundle-entry request is resolved by <run_id>/<case_id> PREFIX match against
// every `runs` row sharing that run_id (core run ids are timestamp+random and
// essentially never collide in practice, but two DIFFERENT run_group_id rows
// CAN legitimately share one — e.g. a re-dispatch or an operator-imported
// run_id), ordered newest-first so a collision resolves to the newest row
// (viewer-adapter.js runEntry: `ORDER BY r.created_at DESC` then the first
// prefix match wins) — never the oldest, and never ambiguous. Also pins that
// the entry path stays traversal-safe once a run row resolves.
//
// The resolution logic lives inline in `runEntry` (not a separately exported
// helper) and needs a real `runs` row + bundle artifact to exercise, so this
// is a small integration test rather than a true unit test — see
// the task brief's own fallback for "if the resolution helpers aren't
// exported."
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withApp } from "./helpers.ts";
import { writeBundle } from "@playtest/core/artifacts";
import { setUpProject } from "./exec-helpers.ts";
import { ulid } from "../../src/ulid.ts";

/** Build a tiny real .ptrun bundle (manifest.json + trajectory.jsonl) on disk
 * and return its bytes. */
async function buildBundle(tmpDir: HostedDynamic, marker: HostedDynamic) {
  const runDir = path.join(tmpDir, `run-${marker}`);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ marker, run_id: "collision-run", case: { id: "add-todo" } }));
  await fsp.writeFile(path.join(runDir, "trajectory.jsonl"), JSON.stringify({ marker }) + "\n");
  const outPath = path.join(tmpDir, `${marker}.ptrun`);
  writeBundle(runDir, outPath);
  return fsp.readFile(outPath);
}

test("bundle-entry resolution: <run_id>/<case_id> prefix match picks the NEWEST colliding run", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-adapter-paths-"));
  try {
    await withApp(async ({ base, api, app }: HostedDynamic) => {
      const { project, suite, env } = await setUpProject(api, {
        key: "adapter-paths",
        todoAppUrl: "http://127.0.0.1:1", // never dialed — no run actually executes in this test
        authStubUrl: "http://127.0.0.1:1",
      });
      const snapshot = await app.db.query(`SELECT id FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 1`, [suite.id]);
      assert.ok(snapshot.rows[0], "the imported suite must have a committed snapshot");
      const snapshotId = snapshot.rows[0].id;

      const runId = "collision-run"; // same core run_id, deliberately, across two different groups
      const caseId = "add-todo";
      const older = await makeRun(app, { project, suite, env, snapshotId, runId, caseId, ageMinutes: 60 });
      const newer = await makeRun(app, { project, suite, env, snapshotId, runId, caseId, ageMinutes: 0 });

      await attachBundle(app, older.runDbId, await buildBundle(tmpDir, "old"));
      await attachBundle(app, newer.runDbId, await buildBundle(tmpDir, "new"));

      const url = `${base}/api/v1/projects/${project.key}/view/run/${runId}/${caseId}/manifest.json`;
      const res = await fetch(url);
      assert.equal(res.status, 200, url);
      const manifest = await res.json();
      assert.equal(manifest.marker, "new", "a run_id collision must resolve to the NEWEST row, never the oldest");

      // ---- traversal stays rejected once a run row resolves ----
      const traversal = `${base}/api/v1/projects/${project.key}/view/run/${runId}/${caseId}/${encodeURIComponent("../")}${encodeURIComponent("../")}etc/passwd`;
      assert.equal((await fetch(traversal)).status, 404, "path traversal must not escape the resolved bundle");

      // ---- an entry name that never existed in either bundle still 404s ----
      assert.equal(
        (await fetch(`${base}/api/v1/projects/${project.key}/view/run/${runId}/${caseId}/nope.json`)).status,
        404,
      );
    });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

async function makeRun(app: HostedDynamic, { project, suite, env, snapshotId, runId, caseId, ageMinutes }: HostedDynamic) {
  const groupId = ulid();
  const runDbId = ulid();
  await app.db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}', '{}', 'done', $6, now())`,
    [groupId, project.id, suite.id, snapshotId, env.id, new Date(Date.now() - ageMinutes * 60_000)],
  );
  await app.db.query(
    `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, created_at, updated_at)
       VALUES ($1, $2, $3, $3, $4, 'pass', 'record', $5, now())`,
    [runDbId, groupId, caseId, runId, new Date(Date.now() - ageMinutes * 60_000)],
  );
  return { groupId, runDbId };
}

async function attachBundle(app: HostedDynamic, runDbId: HostedDynamic, bytes: HostedDynamic) {
  const stored = await app.store.put(`runs/collision/${runDbId}.ptrun`, bytes);
  await app.db.query(
    `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
       VALUES ($1, $2, 'bundle', $3, $4, $5, 'full', now())`,
    [ulid(), runDbId, `runs/collision/${runDbId}.ptrun`, stored.sha256, stored.size],
  );
}
