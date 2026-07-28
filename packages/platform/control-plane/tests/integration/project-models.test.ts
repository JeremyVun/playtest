// Project-level model defaults (migration 0007; docs/contracts/hosted.md,
// "Model selection"). The rules worth pinning are the ones a caller can't read
// off the column: merge-on-update never wipes the key you didn't send, a suite
// that chose always beats the project in the launch preview, and the runner
// spec carries the policy verbatim so the workspace can apply it. The engine's
// own per-key merge is core's contract, tested with core; here we test the
// hosted plumbing around it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget } from "./helpers.ts";

const JOURNEY_CASE = [
  "description: Add a todo.",
  "story: |",
  '  Add "milk" to the list.',
  "success:",
  "  - assert: ok",
  "",
].join("\n");

/** A committed suite with one runnable journey; `defaultsYaml` is its playtest.yaml. */
async function seedSuite(api: HostedDynamic, project: HostedDynamic, slug: HostedDynamic, defaultsYaml: HostedDynamic) {
  const suite = (await api.post(`/projects/${project}/suites`, { slug, name: slug.toUpperCase() })).body;
  const seed = await api.post(`/suites/${suite.id}/commit`, {
    changes: [
      { path: "playtest.yaml", content: defaultsYaml },
      { path: "stories/add-todo.yaml", content: JOURNEY_CASE },
    ],
    note: "seed",
  });
  assert.equal(seed.status, 200, JSON.stringify(seed.body));
  return suite;
}

// A stubbed GitHub so a launch can actually create a run group; the dispatch
// itself is somebody else's test.
const GITHUB_STUB = {
  enabled: true,
  dispatchWorkflow: async () => ({ workflow_run_id: "wr-1", workflow_run_url: "https://gha.invalid/1" }),
  cancelRun: async () => ({ ok: true }),
};

test("models: the catalog names the shipped tiers and the engine defaults", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const { status, body } = await api.get("/models");
    assert.equal(status, 200);
    // The tier list is suggestions, not validation — but it must at least carry
    // the tiers the docs name, and the engine defaults must be usable strings.
    for (const tier of ["sonnet", "haiku", "opus"]) assert.ok(body.tiers.includes(tier), `tier ${tier}`);
    assert.ok(body.tiers.includes(body.defaults.actor_model), "the default actor is a shipped tier");
    assert.ok(body.tiers.includes(body.defaults.grader_model), "the default grader is a shipped tier");
  });
});

test("models: project defaults set, merge per key, clear, and validate", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    assert.deepEqual((await api.get("/projects/p")).body.models, {}, "a new project has no policy");

    let r = await api.put("/projects/p/models", { actor_model: "sonnet", grader_model: "gpt5_5" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.models, { actor_model: "sonnet", grader_model: "gpt5_5" });

    // Merge-on-update: the key you didn't send keeps its stored value…
    r = await api.put("/projects/p/models", { actor_model: "opus" });
    assert.deepEqual(r.body.models, { actor_model: "opus", grader_model: "gpt5_5" });
    // …and null (or "") clears exactly the key it names.
    r = await api.put("/projects/p/models", { grader_model: null });
    assert.deepEqual(r.body.models, { actor_model: "opus" });

    // A fully-qualified gateway name is the documented pass-through, not an error.
    const qualified = "@bedrock-eus2/us.anthropic.claude-opus-4-8";
    r = await api.put("/projects/p/models", { actor_model: qualified });
    assert.equal(r.body.models.actor_model, qualified);

    // The list view carries the policy too — Suite settings' captions read it
    // from the project record the shell already loaded, not a second fetch.
    const listed = (await api.get("/projects")).body.items.find((p: HostedDynamic) => p.key === "p");
    assert.deepEqual(listed.models, { actor_model: qualified });

    for (const [bad, why] of [
      [{ report_model: "opus" }, "unknown key"],
      [{ actor_model: "two words" }, "whitespace inside a model name"],
      [{ actor_model: 42 }, "non-string"],
    ] as HostedDynamic) {
      assert.equal((await api.put("/projects/p/models", bad)).status, 400, why);
    }
    // A failed write never partially applies.
    assert.deepEqual((await api.get("/projects/p")).body.models, { actor_model: qualified });
  });
});

test("models: the launch preview says which model each role uses and whose choice it was", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    const { ring } = await createTarget(api, project, { key: "checkout", name: "Checkout", baseUrl: "http://checkout.example" });
    await api.put("/projects/p/models", { grader_model: "sonnet" });
    // The suite chose its actor; it says nothing about the grader.
    const suite = await seedSuite(api, "p", "checkout",
      "actor_model: opus\napp:\n  base_url: http://checkout.example\n");

    const { status, body } = await api.post("/projects/p/run-groups/preview", {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: {},
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.models.actor_model, { value: "opus", source: "suite" }, "the suite's choice wins");
    assert.deepEqual(body.models.grader_model, { value: "sonnet", source: "project" }, "the project fills the silent key");

    // With no policy anywhere, both fall through to engine defaults — and the
    // preview says so instead of leaving the source to guesswork.
    await api.put("/projects/p/models", { grader_model: null });
    const plain = await seedSuite(api, "p", "plain", "app:\n  base_url: http://plain.example\n");
    const fallthrough = (await api.post("/projects/p/run-groups/preview", {
      suite_id: plain.id,
      ring_id: ring.id,
      selection: {},
    })).body;
    assert.equal(fallthrough.models.actor_model.source, "default");
    assert.equal(fallthrough.models.grader_model.source, "default");
    assert.ok(fallthrough.models.actor_model.value, "the engine default is named, never blank");
  });
});

test("models: the runner spec carries the project's policy for the workspace to apply", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    const { ring } = await createTarget(api, project, { key: "checkout", name: "Checkout", baseUrl: "http://checkout.example" });
    await api.put("/projects/p/models", { actor_model: "sonnet", grader_model: "gpt5_5" });
    const suite = await seedSuite(api, "p", "checkout", "app:\n  base_url: http://checkout.example\n");

    const launched = await api.post("/projects/p/run-groups", {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: {},
    });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const groupId = launched.body.run_group.id;

    // Dev-auth insecure exchange (the local dispatch path).
    const exchanged = await fetch(`${base}/api/v1/runner/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_group_id: groupId, isolation: "process" }),
    }).then((r) => r.json());
    assert.ok(exchanged.token, JSON.stringify(exchanged));

    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, {
      headers: { authorization: `Bearer ${exchanged.token}` },
    }).then((r) => r.json());
    assert.deepEqual(spec.project.models, { actor_model: "sonnet", grader_model: "gpt5_5" });
  }, {}, { github: GITHUB_STUB });
});

test("models: consolidation_model is a project policy over a terra deployment default", async () => {
  const { consolidationModelFor } = await import("../../src/findings/consolidation.ts");
  await withApp(async ({ app, api }: HostedDynamic) => {
    await api.post("/projects", { key: "pcm", name: "PCM" });
    // The deployment default is the terra tier, and the catalog captions it so
    // the settings form can say what leaving the field blank means.
    const catalog = (await api.get("/models")).body;
    assert.equal(catalog.defaults.consolidation_model, "gpt5_6_terra");
    assert.ok(catalog.tiers.includes("gpt5_6_terra"), "the default is a shipped tier");

    const r = await api.put("/projects/pcm/models", { consolidation_model: "opus" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.models.consolidation_model, "opus");
    const row: HostedDynamic = (await app.db.query(`SELECT * FROM projects WHERE key = 'pcm'`)).rows[0];
    assert.equal(consolidationModelFor(app.ctx, row), "opus", "the project policy wins");

    await api.put("/projects/pcm/models", { consolidation_model: null });
    const cleared = (await app.db.query(`SELECT * FROM projects WHERE key = 'pcm'`)).rows[0];
    assert.equal(consolidationModelFor(app.ctx, cleared), "gpt5_6_terra", "clearing falls back to the deployment default");
  });
});
