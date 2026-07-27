// Phase 7 integration: write-route rate limiting end to end (429 envelope +
// Retry-After, reads unaffected, runner routes exempt by path) and the
// /projects/:p/ops dashboard payload (dispatch depth, reconciler heartbeat,
// LLM spend shape).
import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { beatHeartbeat } from "../../src/ops.ts";

test("write routes rate-limit per principal with a friendly 429", async () => {
  await withApp(
    async ({ api }: HostedDynamic) => {
      // Burst of 3: the project create plus two more writes pass, then 429.
      const first: HostedDynamic = await api.post("/projects", { key: "rl", name: "Rate Limit" });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal((await api.post("/projects", { key: "rl2", name: "Two" })).status, 201);
      assert.equal((await api.post("/projects", { key: "rl3", name: "Three" })).status, 201);

      const refused = await api.post("/projects", { key: "rl4", name: "Four" });
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, "rate_limited");
      assert.match(refused.body.error.message, /retry in \d+s/);
      assert.ok(Number(refused.headers.get("retry-after")) >= 1);

      // Reads are never limited.
      for (let i = 0; i < 10; i++) {
        assert.equal((await api.get("/projects")).status, 200);
      }
    },
    { PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "60", PLAYTEST_RATE_LIMIT_WRITE_BURST: "3" },
  );
});

test("ops overview reports depth, reconciler heartbeat, and spend", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "ops", name: "Ops" })).body;

    let ops = await api.get(`/projects/${project.key}/ops`);
    assert.equal(ops.status, 200, JSON.stringify(ops.body));
    assert.deepEqual(ops.body.dispatches.active, { requested: 0, scheduled: 0, running: 0, total: 0 });
    assert.equal(typeof ops.body.dispatches.cap, "number");
    assert.equal(ops.body.queue_wait.sample, 0);
    // Test harness runs with the reconciler interval at 0 and no GitHub app.
    assert.equal(ops.body.reconciler.configured, false);
    assert.equal(ops.body.reconciler.last_beat_at, null);
    assert.equal(ops.body.llm_spend.total_usd, 0);
    assert.equal(ops.body.llm_spend.window_days, 30);

    // A heartbeat makes lag measurable.
    await beatHeartbeat(app.ctx, "reconciler", { interval_s: 30 });
    ops = await api.get(`/projects/${project.key}/ops`);
    assert.ok(ops.body.reconciler.last_beat_at, "beat recorded");
    assert.ok(ops.body.reconciler.lag_s >= 0 && ops.body.reconciler.lag_s < 60, `lag ${ops.body.reconciler.lag_s}`);
    assert.deepEqual(ops.body.reconciler.detail, { interval_s: 30 });

    // Depth counts active ledger rows (insert one directly — no GHA here).
    await app.db.query(
      `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status)
       VALUES ('d-ops-1', $1, 'group', 'rg-x', 1, 'running')`,
      [project.id],
    );
    ops = await api.get(`/projects/${project.key}/ops`);
    assert.equal(ops.body.dispatches.active.running, 1);
    assert.equal(ops.body.dispatches.active.total, 1);
    assert.ok(ops.body.dispatches.oldest_active_s >= 0);

    // Viewer role can NOT read ops (developer bar) — pin via an API token.
    const token = (await api.post(`/projects/${project.key}/tokens`, { name: "v", role: "viewer" })).body;
    const viewerApi = api.withToken(token.token);
    assert.equal((await viewerApi.get(`/projects/${project.key}/ops`)).status, 403);
  });
});
