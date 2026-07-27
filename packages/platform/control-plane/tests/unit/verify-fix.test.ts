// The fix verifier (findings/verify-fix.ts): excerpt selection and budgets,
// model resolution, and the verdict envelope — the model call is injected, so
// no gateway, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyExcerpts, verifyFindingFixed, verifyModelFor } from "../../src/findings/verify-fix.ts";

function bundleOf(files: HostedDynamic) {
  return {
    provider: {
      stat: (f: HostedDynamic) => (f in files ? {} : null),
      readText: (f: HostedDynamic) => files[f],
    },
  };
}

test("verifyExcerpts reads cited steps and the final page, skipping absent and blank files", () => {
  const excerpts = verifyExcerpts(bundleOf({
    "steps/003.a11y.txt": "step three content",
    "steps/007.a11y.txt": "   ",
    "final.a11y.txt": "final page content",
  }), [3, 7, 12]);
  assert.deepEqual(excerpts.map((e) => e.label), ["step 3", "final page"]);
  assert.equal(excerpts[0].text, "step three content");
});

test("verifyExcerpts stays inside its budgets: per-step clip, step cap, total cap", () => {
  const files: HostedDynamic = { "final.a11y.txt": "z".repeat(50_000) };
  for (let n = 1; n <= 9; n++) files[`steps/00${n}.a11y.txt`] = "y".repeat(50_000);
  const excerpts = verifyExcerpts(bundleOf(files), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(excerpts.length <= 5, "at most MAX_STEPS cited steps plus the final page");
  const total = excerpts.reduce((s, e) => s + e.text.length, 0);
  assert.ok(total <= 26_000, `total ${total} within budget`);
  for (const e of excerpts) assert.ok(e.text.length <= 6000, `${e.label} within per-step clip`);
});

test("verifyFindingFixed returns the validated verdict and clips evidence; a failed call returns null", async () => {
  const finding = {
    title: "Grammatical error in the final summary",
    summary: { claim: { observed: "You're an not an Australian citizen" } },
    locus: { route: "/results" },
  };
  const excerpts = [{ label: "final page", text: "You're not an Australian citizen or permanent resident." }];

  let seen: HostedDynamic = null;
  const ok: HostedDynamic = await verifyFindingFixed({
    finding, excerpts, model: "m1",
    callModel: async ({ model, messages, tool, validate }: HostedDynamic) => {
      seen = { model, prompt: messages[1].content, toolName: tool.function.name };
      assert.equal(validate({ verdict: "maybe" }), "verdict must be one of fixed, not_fixed, indeterminate");
      assert.equal(validate({ verdict: "fixed" }), null);
      return { args: { verdict: "fixed", evidence: "x".repeat(500) }, tokens: {} };
    },
  });
  assert.equal(ok.verdict, "fixed");
  assert.equal(ok.evidence.length, 300, "evidence quote is clipped");
  assert.equal(seen.model, "m1");
  assert.equal(seen.toolName, "report_verification");
  assert.match(seen.prompt, /You're an not an Australian citizen/, "the claim is in the prompt");
  assert.match(seen.prompt, /permanent resident/, "the page content is in the prompt");

  const failed = await verifyFindingFixed({
    finding, excerpts, model: "m1",
    callModel: async () => { throw new Error("gateway down"); },
  });
  assert.equal(failed, null, "a failed call proves nothing");
});

test("verifyModelFor: project policy wins, else the deployment default", () => {
  const ctx = { config: { llm: { autoResolveModel: "tier_default" } } };
  assert.equal(verifyModelFor(ctx, { models: { auto_resolve_model: "pinned" } }), "pinned");
  assert.equal(verifyModelFor(ctx, { models: {} }), "tier_default");
  assert.equal(verifyModelFor(ctx, null), "tier_default");
});
