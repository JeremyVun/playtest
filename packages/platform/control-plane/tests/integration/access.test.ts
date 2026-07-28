// Role enforcement, api tokens, secrets (write-only + encrypted), and environments —
// the access-control + settings surface of Phase 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptSecret } from "../../src/crypto/secrets.ts";
import { withApp } from "./helpers.ts";

test("tokens: a viewer token can read but not mutate; an editor token can commit", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
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
    await api.post("/projects", { key: "p", name: "P" });
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

test("environments: CRUD with discovery flag + runner labels", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const created = await api.post("/projects/p/environments", {
      name: "staging",
      config: { app: { base_url: "https://staging.example.com" }, auth: { default: "member" }, secret_env: {} },
      discovery_allowed: true,
      runner_labels: ["self-hosted", "playtest", "pool-checkout"],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.discovery_allowed, true);
    const id = created.body.id;

    const updated = await api.put(`/environments/${id}`, { config: created.body.config, discovery_allowed: false, runner_labels: ["self-hosted"] });
    assert.equal(updated.body.discovery_allowed, false);
    assert.deepEqual(updated.body.runner_labels, ["self-hosted"]);

    assert.equal((await api.del(`/environments/${id}`)).status, 204);
    // A new project is born with the `default` target (it holds no URL of its
    // own, so it resolves to each suite's base URL) — deleting `staging` leaves
    // that one, never an empty list nobody can launch against.
    assert.deepEqual((await api.get("/projects/p/environments")).body.items.map((e: HostedDynamic) => e.name), ["default"]);
  });
});

test("environments: a partial PUT merges — omitted fields keep their stored value", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const config = { app: { base_url: "https://staging.example.com" }, auth: { default: "member" }, secret_env: { TOKEN: "SEED_TOKEN" } };
    const { body: env } = await api.post("/projects/p/environments", {
      name: "staging", config, runner_labels: ["self-hosted", "playtest"],
    });

    // The data-loss case: flipping one flag must not wipe config or labels.
    const flipped = await api.put(`/environments/${env.id}`, { discovery_allowed: true });
    assert.equal(flipped.status, 200);
    assert.equal(flipped.body.discovery_allowed, true);
    assert.deepEqual(flipped.body.config, config);
    assert.deepEqual(flipped.body.runner_labels, ["self-hosted", "playtest"]);

    // And the merge persists — not just in the response view.
    const listed = (await api.get("/projects/p/environments")).body.items.find((e: HostedDynamic) => e.id === env.id);
    assert.deepEqual(listed.config, config);
    assert.deepEqual(listed.runner_labels, ["self-hosted", "playtest"]);

    // A rename attempt is an explicit error, never silently ignored.
    const renamed = await api.put(`/environments/${env.id}`, { name: "prod" });
    assert.equal(renamed.status, 400);
    assert.match(renamed.body.error.message, /can't be renamed/);

    // Re-sending the same name is fine (the web form always includes it).
    const same = await api.put(`/environments/${env.id}`, { name: "staging", discovery_allowed: false });
    assert.equal(same.status, 200);
    assert.equal(same.body.discovery_allowed, false);
  });
});

test("environments: rejects a non-object config field with a friendly error", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const res = await api.post("/projects/p/environments", { name: "bad", config: { app: "not-an-object" } });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /config\.app/);
  });
});
