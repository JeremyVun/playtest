// Project concurrency defaults and the executor protocol that carries them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";

const GITHUB_STUB = {
  enabled: true,
  dispatchWorkflow: async () => ({ workflow_run_id: "wr-parallel", workflow_run_url: "https://gha.invalid/parallel" }),
  cancelRun: async () => ({ ok: true }),
};

const CASE = [
  "description: Add a todo.",
  "story: Add milk to the list.",
  "success:",
  "  - assert: ok",
  "",
].join("\n");

test("parallel: project settings validate, persist, and reach the runner", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    assert.deepEqual((await api.get("/projects/p")).body.parallel, { total: 1, record: 1 });

    for (const bad of [
      { total: 0, record: 1 },
      { total: 2, record: 3 },
      { total: 2.5, record: 1 },
      { total: 2, record: 1, extra: true },
    ]) {
      assert.equal((await api.put("/projects/p/parallel", bad)).status, 400, JSON.stringify(bad));
    }

    const saved = await api.put("/projects/p/parallel", { total: 6, record: 2 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.parallel, { total: 6, record: 2 });
    assert.deepEqual(
      (await api.get("/projects")).body.items.find((p: HostedDynamic) => p.key === "p").parallel,
      { total: 6, record: 2 },
    );

    const suite = (await api.post("/projects/p/suites", { slug: "checkout", name: "Checkout" })).body;
    const seeded = await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://checkout.example\n" },
        { path: "stories/add.yaml", content: CASE },
      ],
      note: "seed",
    });
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    const env = (await api.get("/projects/p/environments")).body.items[0];
    const launched = await api.post("/projects/p/run-groups", {
      suite_id: suite.id,
      environment_id: env.id,
      selection: {},
    });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));

    const groupId = launched.body.run_group.id;
    const exchange = await fetch(`${base}/api/v1/runner/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_group_id: groupId, isolation: "process" }),
    }).then((r) => r.json());
    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, {
      headers: { authorization: `Bearer ${exchange.token}` },
    }).then((r) => r.json());
    assert.deepEqual(spec.parallel, { total: 6, record: 2 });
    assert.deepEqual(spec.project.parallel, { total: 6, record: 2 });
  }, {}, { github: GITHUB_STUB });
});
