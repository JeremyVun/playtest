// DELETE /projects/:p — admin-only permanent teardown, including projects with
// run history (run_groups pin suites via ON DELETE RESTRICT and must go first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTarget, withApp } from "./helpers.ts";

test("projects: admin can delete an empty project; key is free to reuse", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const created = await api.post("/projects", { key: "goner", name: "Goner" });
    assert.equal(created.status, 201);
    assert.equal((await api.del("/projects/goner")).status, 204);
    assert.equal((await api.get("/projects/goner")).status, 404);
    // Key free again.
    assert.equal((await api.post("/projects", { key: "goner", name: "Goner 2" })).status, 201);
  });
});

test("projects: delete cascades suites, applications, rings, and run history", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "wipe", name: "Wipe" })).body;
    const { application, ring } = await createTarget(api, project, { ringKey: "staging" });
    const suite = (await api.post("/projects/wipe/suites", { slug: "s", name: "S" })).body;
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [{ path: "playtest.yaml", content: "app:\n  base_url: http://x\n" }],
      note: "defaults",
    });

    // Insert a run_group that would block a naïve project delete: it pins the
    // suite, the application and the ring, all ON DELETE RESTRICT.
    await app.db.query(
      `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
       VALUES ($1, $2, $3, (SELECT id FROM suite_snapshots WHERE suite_id = $3 LIMIT 1), $4, $5, '{}', '{}', 'done')`,
      ["rg-wipe-1", project.id, suite.id, application.id, ring.id],
    );

    assert.equal((await api.del("/projects/wipe")).status, 204);
    assert.equal((await api.get("/projects/wipe")).status, 404);
    const left = await app.db.query(
      `SELECT
         (SELECT COUNT(*) FROM suites WHERE project_id = $1) AS suites,
         (SELECT COUNT(*) FROM applications WHERE project_id = $1) AS applications,
         (SELECT COUNT(*) FROM rings WHERE application_id = $2) AS rings,
         (SELECT COUNT(*) FROM run_groups WHERE project_id = $1) AS groups,
         (SELECT COUNT(*) FROM memberships WHERE project_id = $1) AS members`,
      [project.id, application.id],
    );
    assert.deepEqual(left.rows[0], { suites: 0, applications: 0, rings: 0, groups: 0, members: 0 });
  });
});

test("projects: only an admin may delete", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const editor = (await api.post("/projects/p/tokens", { role: "editor", name: "e" })).body.token;
    const developer = (await api.post("/projects/p/tokens", { role: "developer", name: "d" })).body.token;
    assert.equal((await api.withToken(editor).del("/projects/p")).status, 403);
    assert.equal((await api.withToken(developer).del("/projects/p")).status, 403);

    const admin = (await api.post("/projects/p/tokens", { role: "admin", name: "a" })).body.token;
    assert.equal((await api.withToken(admin).del("/projects/p")).status, 204);
  });
});
