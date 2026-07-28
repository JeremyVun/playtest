// Pins the friendly refusal when the platform LLM gateway isn't configured
// (authoring/assistant.js requireAssistantConfigured, called by the story-draft
// endpoint), and the matching `capabilities.llm` on /me that lets the console
// disable the affordance BEFORE anyone types a goal. A separate file (node:test
// runs each test file as its own process): requireAssistantConfigured reads
// process.env.PLAYTEST_LLM_BASE_URL directly (core llm.ts's convention, not
// ctx.config), so this needs the var genuinely ABSENT for the whole process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget } from "./helpers.ts";

delete process.env.PLAYTEST_LLM_BASE_URL;

test("story-draft: with no PLAYTEST_LLM_BASE_URL configured it answers 503 not_configured", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    await createTarget(api, project);
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    const seed = await api.post(`/suites/${suite.id}/commit`, {
      changes: [{ path: "playtest.yaml", content: "app:\n  base_url: http://x\n" }],
      note: "seed",
    });
    assert.equal(seed.status, 200, JSON.stringify(seed.body));

    const res = await api.post(`/suites/${suite.id}/story-draft`, { goal: "add a signup story" });
    // Not a 500: the request was well-formed and authorized and nothing crashed
    // — the capability was simply never switched on for this deployment.
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "not_configured");
    assert.match(res.body.error.message, /PLAYTEST_LLM_BASE_URL/);
  });
});

test("/me advertises capabilities.llm: false so the console never offers a dead button", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const me = await api.get("/me");
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.capabilities.llm, false);
    // Auto-dedupe rides the same gateway: no gateway, no automatic sweeps,
    // and the console keeps the manual "Find duplicates" affordance.
    assert.equal(me.body.capabilities.auto_dedupe, false);
  });
});
