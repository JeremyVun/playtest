// Role enforcement, api tokens, secrets (write-only + encrypted), and rings —
// the access-control + settings surface of Phase 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptSecret } from "../../src/crypto/secrets.ts";
import { withApp, createTarget } from "./helpers.ts";

test("tokens: a viewer token can read but not mutate; an editor token can commit", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    await createTarget(api, project);
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    // Seed defaults so a web case has a base_url (core requires it).
    await api.post(`/suites/${suite.id}/commit`, { changes: [{ path: "playtest.yaml", content: "app:\n  base_url: http://x\n" }], note: "defaults" });

    const viewer = (await api.post("/projects/p/tokens", { role: "viewer", name: "ci-read" })).body.token;
    const editor = (await api.post("/projects/p/tokens", { role: "editor", name: "ci-write" })).body.token;
    assert.ok(viewer.startsWith("pt_"));

    const asViewer = api.withToken(viewer);
    assert.equal((await asViewer.get(`/suites/${suite.id}/cases`)).status, 200);
    const denied = await asViewer.post(`/suites/${suite.id}/commit`, { changes: [{ path: "stories/a.yaml", content: "story: a\nsuccess:\n  - assert: ok\n" }], note: "x" });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "forbidden");

    const asEditor = api.withToken(editor);
    const ok = await asEditor.post(`/suites/${suite.id}/commit`, { changes: [{ path: "stories/a.yaml", content: "story: a\nsuccess:\n  - assert: ok\n" }], note: "x" });
    assert.equal(ok.status, 200);
  });
});

test("tokens: an editor token cannot touch developer-tier code files", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    await createTarget(api, project);
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    const editor = (await api.post("/projects/p/tokens", { role: "editor", name: "e" })).body.token;
    const res = await api.withToken(editor).put(`/suites/${suite.id}/files/hooks/before_each.js`, { content: "export default async () => {};\n" });
    assert.equal(res.status, 403); // code kinds need developer
  });
});

test("secrets: write-only listing; values encrypted at rest, never returned", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const created = await api.post("/projects/p/secrets", { name: "SEED_TOKEN", value: "super-secret-value" });
    assert.equal(created.status, 201);
    assert.equal(created.body.value, undefined); // never echoed

    const list = (await api.get("/projects/p/secrets")).body.items;
    assert.deepEqual(list.map((s: HostedDynamic) => s.name), ["SEED_TOKEN"]);
    assert.ok(!("ciphertext" in list[0]) && !("value" in list[0]));

    // The stored bytes are ciphertext, decryptable only with the KMS key.
    const { rows } = await app.db.query(`SELECT ciphertext FROM secrets WHERE name = 'SEED_TOKEN'`);
    assert.notEqual(rows[0].ciphertext.toString("utf8"), "super-secret-value");
    assert.equal(decryptSecret(app.config.kmsKey, rows[0].ciphertext), "super-secret-value");

    assert.equal((await api.del("/projects/p/secrets/SEED_TOKEN")).status, 204);
    assert.equal((await api.get("/projects/p/secrets")).body.items.length, 0);
  });
});

test("rings: CRUD with discovery flag + runner labels", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    // A new project starts with NO application: what a suite runs against is a
    // decision, so there is nothing to launch at until someone makes it.
    await api.post("/projects", { key: "p", name: "P" });
    assert.deepEqual((await api.get("/projects/p/applications")).body.items, []);

    const application = (await api.post("/projects/p/applications", { key: "todo-web", name: "Todo Web", driver: "web" })).body;
    const created = await api.post(`/applications/${application.id}/rings`, {
      key: "staging",
      name: "Staging",
      base_url: "https://staging.example.com",
      config: { auth: { default: "member" }, secret_env: {} },
      runner_labels: ["self-hosted", "playtest", "pool-checkout"],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;

    // An explicit value REPLACES (merge only covers what the caller omits).
    const updated = await api.put(`/rings/${id}`, { config: created.body.config, runner_labels: ["self-hosted"] });
    assert.deepEqual(updated.body.runner_labels, ["self-hosted"]);

    assert.equal((await api.del(`/rings/${id}`)).status, 204);
    // Deletion never cascades and never invents a replacement: the application
    // survives its last environment, holding none.
    assert.deepEqual((await api.get(`/applications/${application.id}/rings`)).body.items, []);
    assert.deepEqual((await api.get("/projects/p/applications")).body.items.map((a: HostedDynamic) => a.key), ["todo-web"]);
  });
});

test("rings: a partial PUT merges — omitted fields keep their stored value", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    const config = { auth: { default: "member" }, secret_env: { TOKEN: "SEED_TOKEN" } };
    const { ring } = await createTarget(api, project, {
      key: "todo-web",
      ringKey: "staging",
      baseUrl: "https://staging.example.com",
      runnerLabels: ["self-hosted", "playtest"],
      config,
    });

    // The data-loss case: a one-field PUT must not wipe config, URL or labels.
    const flipped = await api.put(`/rings/${ring.id}`, { name: "Staging EU" });
    assert.equal(flipped.status, 200);
    assert.equal(flipped.body.name, "Staging EU");
    assert.deepEqual(flipped.body.config, config);
    assert.equal(flipped.body.base_url, "https://staging.example.com");
    assert.deepEqual(flipped.body.runner_labels, ["self-hosted", "playtest"]);

    // And the merge persists — not just in the response view.
    const listed = (await api.get(`/applications/${ring.application_id}/rings`)).body.items.find((r: HostedDynamic) => r.id === ring.id);
    assert.deepEqual(listed.config, config);
    assert.equal(listed.base_url, "https://staging.example.com");
    assert.deepEqual(listed.runner_labels, ["self-hosted", "playtest"]);

    // A re-key attempt is an explicit error, never silently ignored: runner
    // configuration binds (application key, environment key).
    const rekeyed = await api.put(`/rings/${ring.id}`, { key: "prod" });
    assert.equal(rekeyed.status, 400);
    assert.match(rekeyed.body.error.message, /key is part of its identity/);

    // Re-sending the same key is fine, and an environment's NAME, unlike its
    // key, is editable.
    const same = await api.put(`/rings/${ring.id}`, { key: "staging", name: "Staging (EU)" });
    assert.equal(same.status, 200);
    assert.equal(same.body.name, "Staging (EU)");
  });
});

test("rings: rejects a non-object config field with a friendly error", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const application = (await api.post("/projects/p/applications", { key: "todo-web", name: "Todo Web", driver: "web" })).body;
    const res = await api.post(`/applications/${application.id}/rings`, {
      key: "bad",
      base_url: "https://staging.example.com",
      config: { app: "not-an-object" },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /config\.app/);
  });
});
