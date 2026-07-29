// Project-scoped personas: CRUD over /projects/:p/personas and /personas/:id,
// the content-addressed blob each write produces, and the read-time merge into
// a snapshot's tree the runner-agent workspace materializes from
// (GET /runner/snapshots/:id/tree — see api/executor-api.js snapshotTree).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { claimAndExchange } from "./exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { blobKey } from "../../src/store/object-store.ts";

/**
 * A runner bearer for the snapshot/blob reads — a REAL one. Those routes are
 * behind `requireCurrentExecutor` (docs/contracts/hosted.md, "Current executor
 * fencing"), so the bearer has to belong to an executor that actually won a
 * claim and exchanged for it; a hand-issued token for an executor that never
 * existed is exactly what the fence is there to refuse.
 */
async function runnerAuth(api: HostedDynamic, base: HostedDynamic, project: HostedDynamic, suite: HostedDynamic, ring: HostedDynamic) {
  const launched = await api.post(`/projects/${project.key}/run-groups`, {
    suite_id: suite.id,
    ring_id: ring.id,
    selection: { ids: ["add-todo"] },
  });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  const { token } = await claimAndExchange(api, base, { project, groupId: launched.body.run_group.id });
  return { authorization: `Bearer ${token}` };
}

test("personas: fresh project lists only the three built-ins, with prose", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const list = await api.get("/projects/p/personas");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((i: HostedDynamic) => i.slug), ["tester", "exploratory", "adversarial"]);
    for (const item of list.body.items) {
      assert.equal(item.id, null);
      assert.equal(item.builtin, true);
      assert.equal(item.updated_at, null);
      assert.equal(item.name, item.slug);
      assert.ok(item.description.length > 0, `${item.slug} has prose`);
    }
  });
});

test("personas: create appears in the list (after the built-ins) and its bytes are a retrievable blob", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const create = await api.post("/projects/p/personas", {
      name: "Grumpy Tester",
      description: "Tries to break every form on the page.",
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.equal(create.body.slug, "grumpy-tester");
    assert.equal(create.body.name, "Grumpy Tester");
    assert.equal(create.body.builtin, false);
    assert.ok(create.body.id);
    assert.ok(create.body.updated_at);

    const list = await api.get("/projects/p/personas");
    assert.deepEqual(list.body.items.map((i: HostedDynamic) => i.slug), ["tester", "exploratory", "adversarial", "grumpy-tester"]);

    // The rendered YAML is a real content-addressed blob, fetchable exactly as
    // the runner-agent fetches any other suite-tree blob.
    const { rows } = await app.db.query(`SELECT blob_sha256 FROM personas WHERE id = $1`, [create.body.id]);
    const sha = rows[0].blob_sha256;
    assert.match(sha, /^[0-9a-f]{64}$/);
    const bytes = await app.store.get(blobKey(sha));
    const rendered = bytes.toString("utf8");
    assert.match(rendered, /name: Grumpy Tester/);
    assert.match(rendered, /description: Tries to break every form on the page\./);
  });
});

test("personas: duplicate slug in the same project is a friendly conflict", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const first: HostedDynamic = await api.post("/projects/p/personas", { name: "Grumpy", description: "d" });
    assert.equal(first.status, 201);
    const dup = await api.post("/projects/p/personas", { name: "Grumpy", description: "another one" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "conflict");
  });
});

test("personas: a slug colliding with a built-in name is refused", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const clash = await api.post("/projects/p/personas", {
      name: "Whatever",
      slug: "tester",
      description: "d",
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, "conflict");
    assert.match(clash.body.error.message, /built-in/);

    // Deriving into a built-in name (no explicit slug) is refused the same way.
    const derivedClash = await api.post("/projects/p/personas", { name: "Tester", description: "d" });
    assert.equal(derivedClash.status, 409);
  });
});

test("personas: update merges fields, is slug-immutable, and re-renders the blob", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const created = (await api.post("/projects/p/personas", { name: "Grumpy", description: "old prose" })).body;
    const before = (await app.db.query(`SELECT blob_sha256 FROM personas WHERE id = $1`, [created.id])).rows[0];

    const renamed = await api.put(`/personas/${created.id}`, { slug: "something-else" });
    assert.equal(renamed.status, 400);
    assert.match(renamed.body.error.message, /can't be renamed/);

    const updated = await api.put(`/personas/${created.id}`, { description: "new prose entirely" });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "Grumpy", "name is unchanged when omitted (merge-on-update)");
    assert.equal(updated.body.description, "new prose entirely");
    assert.equal(updated.body.slug, "grumpy");

    const after = (await app.db.query(`SELECT blob_sha256 FROM personas WHERE id = $1`, [created.id])).rows[0];
    assert.notEqual(after.blob_sha256, before.blob_sha256, "the stored blob sha changes with the rendered content");
    const bytes = await app.store.get(blobKey(after.blob_sha256));
    assert.match(bytes.toString("utf8"), /new prose entirely/);
  });
});

test("personas: delete removes it from the list", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const created = (await api.post("/projects/p/personas", { name: "Grumpy", description: "d" })).body;
    assert.equal((await api.del(`/personas/${created.id}`)).status, 204);
    const list = await api.get("/projects/p/personas");
    assert.deepEqual(list.body.items.map((i: HostedDynamic) => i.slug), ["tester", "exploratory", "adversarial"]);
  });
});

test("personas: a project persona shows up in the runner snapshot tree; a suite-committed file of the same slug wins", async () => {
  await withApp(async ({ api, app, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    const persona = (await api.post("/projects/p/personas", {
      name: "Grumpy Tester",
      description: "project-level prose",
    })).body;

    // A suite binds to an application at creation, so the target comes first.
    const { ring } = await createTarget(api, project);
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    // Real stories, because the bearer that reads the tree has to belong to a
    // real launched attempt now.
    assert.equal(
      (await api.postTar(`/suites/${suite.id}/import`, writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)))).status,
      200,
    );
    const commit = await api.post(`/suites/${suite.id}/commit`, {
      changes: [{ path: "playtest.yaml", content: "app:\n  base_url: http://x\n" }],
      note: "v1",
    });
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    const snapshotId = commit.body.snapshot.id;

    const { rows } = await app.db.query(`SELECT blob_sha256 FROM personas WHERE id = $1`, [persona.id]);

    const headers = await runnerAuth(api, base, project, suite, ring);
    const treeRes = await fetch(`${base}/api/v1/runner/snapshots/${snapshotId}/tree`, { headers });
    const tree = await treeRes.json();
    assert.equal(treeRes.status, 200);
    assert.equal(tree.tree["personas/grumpy-tester.yaml"], rows[0].blob_sha256);

    // Now the suite commits its OWN personas/grumpy-tester.yaml — same slug.
    // The snapshot's own file must win over the project persona.
    const commit2 = await api.post(`/suites/${suite.id}/commit`, {
      changes: [{ path: "personas/grumpy-tester.yaml", content: "name: Grumpy Tester\ndescription: suite-owned prose\n" }],
      note: "v2",
    });
    assert.equal(commit2.status, 200, JSON.stringify(commit2.body));
    const snapshot2Id = commit2.body.snapshot.id;
    const tree2Res = await fetch(`${base}/api/v1/runner/snapshots/${snapshot2Id}/tree`, { headers });
    const tree2 = await tree2Res.json();
    assert.notEqual(tree2.tree["personas/grumpy-tester.yaml"], rows[0].blob_sha256, "the suite's own file shadows the project persona");
  });
});
