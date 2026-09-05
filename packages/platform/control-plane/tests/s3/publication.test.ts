import { test } from "node:test";
import assert from "node:assert/strict";
import { withS3App } from "./helpers.ts";
import { collectObjects, objectReferences } from "../../src/store/references.ts";
import { createTarget, loadSuiteDir, REPO_ROOT } from "../integration/helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { ulid } from "../../src/ulid.ts";
import { claimAndExchange } from "../integration/exec-helpers.ts";

const gate = () => { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; };
test("Postgres/S3 publication: GC waits for persona upload, protects current content and collects old orphans", async () => {
  await withS3App(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "publication", name: "Publication" })).body;
    const entered = gate(), hold = gate();
    const put = app.store.put.bind(app.store);
    app.store.put = async (...args: HostedDynamic[]) => { const result = await put(...args); entered.release(); await hold.wait; return result; };
    const publish = api.post(`/projects/${project.key}/personas`, { name: "Careful reader", description: "Checks the recorded evidence." });
    await entered.wait;
    let collected = false;
    const gc = collectObjects(app.ctx, { now: new Date(Date.now() + 2 * 86400000) }).then(value => { collected = true; return value; });
    await new Promise(r => setImmediate(r)); assert.equal(collected, false);
    hold.release();
    assert.equal((await publish).status, 201);
    await gc;
    app.store.put = put;
    const refs = await objectReferences(app.db);
    assert.equal(refs.size, 1);
    for (const key of refs) assert.equal(await app.store.has(key), true);
    await app.store.put("blobs/orphan", "collect later");
    assert.equal((await collectObjects(app.ctx)).blobs, 0);
    assert.equal((await collectObjects(app.ctx, { now: new Date(Date.now() + 2 * 86400000) })).blobs, 1);
    await assert.rejects(app.db.withTx(() => app.store.get([...refs][0])), /inside a database transaction/);
  });
});

test("Postgres/S3 bundles: equal-byte retry preserves identity; different bytes cannot overwrite accepted evidence", async () => {
  await withS3App(async ({ api, app, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "bundles", name: "Bundles" })).body;
    const { ring } = await createTarget(api, project);
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "Suite" })).body;
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)))).status, 200);
    const launched = await api.post(`/projects/${project.key}/run-groups`, { suite_id: suite.id, ring_id: ring.id, selection: { ids: ["add-todo"] } });
    const group = launched.body.run_group.id;
    const { headers } = await claimAndExchange(api, base, { project, groupId: group });
    const spec = await (await fetch(`${base}/api/v1/runner/groups/${group}`, { headers })).json();
    const run = spec.cases[0];
    assert.equal((await fetch(`${base}/api/v1/runner/groups/${group}/cases/${run.run_id}/start`, { method: "POST", headers, body: "{}" })).status, 200);
    const upload = async (bytes: string) => {
      const result = await fetch(`${base}/api/v1/runner/runs/${run.db_id}/bundle`, { method: "PUT", headers: { authorization: headers.authorization }, body: bytes });
      return { status: result.status, body: await result.json() };
    };
    const accepted = await upload("accepted bundle bytes");
    assert.equal(accepted.status, 200);
    const repeated = await upload("accepted bundle bytes");
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.artifact.id, accepted.body.artifact.id);
    assert.equal((await upload("conflicting bundle bytes")).status, 409);
    assert.equal((await app.store.get(accepted.body.artifact.key)).toString(), "accepted bundle bytes");
    const cleanup = await collectObjects(app.ctx, { now: new Date(Date.now() + 2 * 86400000) });
    assert.equal(cleanup.runs, 1);
    assert.equal(await app.store.has(accepted.body.artifact.key), true);
    await app.db.query("INSERT INTO baselines (id, project_id, suite_id, story_id, version, trajectory_key, meta) VALUES ($1,$2,$3,'add-todo',1,$4,'{}')", [ulid(), project.id, suite.id, accepted.body.artifact.key + "#trajectory.jsonl"]);
    await app.db.query("DELETE FROM artifacts WHERE run_id = $1", [run.db_id]);
    assert.equal((await collectObjects(app.ctx, { now: new Date(Date.now() + 2 * 86400000) })).runs, 0, "independent baseline pointers protect bytes without an artifact row");
    const unrelated = await app.store.put("blobs/" + "f".repeat(64), "unrelated");
    assert.equal((await fetch(`${base}/api/v1/runner/blobs/${unrelated.key.slice(6)}`, { headers })).status, 403);
  });
});
