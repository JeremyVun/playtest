// Unit tests for the assistant's prompt composition and tool schemas. Pure
// functions — no DB, no LLM, always runs. Pins that the
// system prompt is skill-DERIVED, never a diverging copy (embeds
// skills/playtest-stories/SKILL.md verbatim — a distinctive phrase from the skill
// proves it's the real body, not a paraphrase), carries the suite's live context
// (slug, defaults YAML, resolved case lines, persona files), and states commit is
// human-only. Also pins STORY_DRAFT_TOOLS' public names and required parameters.
// (STUDY_REPORT_TOOL now lives with findings synthesis — see findings-synthesis.test.ts.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { storyAuthoringGuide } from "@playtest/core/suite";

import { composeSystemPrompt, STORY_DRAFT_TOOLS } from "../../src/authoring/assistant.ts";

async function skillBody() {
  return storyAuthoringGuide();
}

test("composeSystemPrompt: embeds the playtest-stories skill verbatim (single source, not a diverging copy)", async () => {
  const skill = await skillBody();
  const prompt = composeSystemPrompt({
    skill,
    suiteSlug: "todos",
    defaultsYaml: "app:\n  base_url: http://x\n",
    cases: [],
    personaFiles: [],
  });
  // The skill body must appear byte-for-byte, not summarized — composeSystemPrompt
  // splices it in as one element of the joined prompt lines.
  assert.ok(prompt.includes(skill), "the full skill body must be embedded verbatim");
  // A distinctive phrase from the skill's interview section (not something an
  // author would casually reproduce by paraphrasing) — proves this is really the
  // skill file's own words, catching the "diverging copy" regression this design
  // explicitly rejects.
  assert.match(prompt, /thought partner/);
});

test("composeSystemPrompt: carries the suite's live context — slug, defaults, cases, personas", async () => {
  const skill = await skillBody();
  const prompt = composeSystemPrompt({
    skill,
    suiteSlug: "checkout-suite",
    defaultsYaml: "app:\n  base_url: https://staging.example\n",
    cases: [
      { id: "add-todo", mode: "journey", persona: null, description: 'Add "milk" to the list' },
      { id: "export-study@tester", mode: "discovery", persona: "tester", description: null, story: "Find the export button." },
    ],
    personaFiles: ["personas/power-user.yaml"],
  });
  assert.match(prompt, /checkout-suite/);
  assert.match(prompt, /staging\.example/);
  assert.match(prompt, /add-todo \(journey\) — Add "milk" to the list/);
  assert.match(prompt, /export-study@tester \(discovery, persona tester\) — Find the export button\./);
  assert.match(prompt, /personas\/power-user\.yaml/);
});

test("composeSystemPrompt: an empty suite and no personas fall back to honest placeholders", async () => {
  const skill = await skillBody();
  const prompt = composeSystemPrompt({ skill, suiteSlug: "fresh", defaultsYaml: "", cases: [], personaFiles: [] });
  assert.match(prompt, /no stories yet — this suite is empty/);
  assert.match(prompt, /none beyond the built-ins tester \/ exploratory/);
  assert.match(prompt, /none committed yet/); // no playtest.yaml content yet
});

test("composeSystemPrompt: states the assistant can never save — the human saves through the ordinary form", async () => {
  const skill = await skillBody();
  const prompt = composeSystemPrompt({ skill, suiteSlug: "s", defaultsYaml: "", cases: [], personaFiles: [] });
  assert.match(prompt, /saves it themselves through the ordinary form/);
  assert.match(prompt, /You can never save or commit/);
  // One story per request unless a set is explicitly asked for — said out loud.
  assert.match(prompt, /Draft ONE story per request unless the person explicitly asks for a set/);
  assert.match(prompt, /more:true on every story except the last/);
});

test("composeSystemPrompt: names the story-type choice, stays black-box, and requires scannable replies", async () => {
  const skill = await skillBody();
  const prompt = composeSystemPrompt({ skill, suiteSlug: "s", defaultsYaml: "", cases: [], personaFiles: [] });
  assert.match(prompt, /Regression journey — a repeatable pass\/fail check/);
  assert.match(prompt, /Discovery story — an open-ended study/);
  assert.match(prompt, /works black-box/);
  assert.match(prompt, /Never offer to examine the site first/);
  assert.match(prompt, /each decision or\n  option on its own line/);
  assert.match(prompt, /blank line between distinct\n  paragraphs/);
});

test("composeSystemPrompt: environments ride as key + URL, and the target is stated as theirs — never secrets", async () => {
  const skill = await skillBody();
  const prompt = composeSystemPrompt({
    skill, suiteSlug: "s", defaultsYaml: "", cases: [], personaFiles: [],
    rings: [
      { key: "staging", base_url: "https://staging.example" },
      { key: "production", base_url: "https://app.example" },
      { key: "local", base_url: null },
    ],
  });
  assert.match(prompt, /- staging — https:\/\/staging\.example/);
  assert.match(prompt, /- production — https:\/\/app\.example/);
  // A URL-less environment is a mobile one; the prompt says who supplies the
  // build rather than inviting the model to author a path.
  assert.match(prompt, /- local — the claiming runner supplies the build/);
  // The physical target belongs to the environment, and the assistant is told
  // to draft logical overlays only.
  assert.match(prompt, /its URL replaces any\n`app\.base_url` a suite authors/);
  assert.match(prompt, /never a mobile build path, device or Appium endpoint/);
  assert.match(prompt, /never written into suite files/);
  // no rings → honest placeholder
  const empty = composeSystemPrompt({ skill, suiteSlug: "s", defaultsYaml: "", cases: [], personaFiles: [] });
  assert.match(empty, /none configured yet/);
});

test("STORY_DRAFT_TOOLS: exactly validate/lint plus the terminal propose_draft — no save_draft, no read_runs", () => {
  assert.equal(STORY_DRAFT_TOOLS.length, 3);
  for (const t of STORY_DRAFT_TOOLS) assert.equal(t.type, "function");
  const byName = Object.fromEntries(STORY_DRAFT_TOOLS.map((t: HostedDynamic) => [t.function.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["lint_case", "propose_draft", "validate_case"]);
  // No persistence/commit/diagnosis surface — the deliberate stateless limit.
  assert.ok(!byName.save_draft, "save_draft must not exist on the stateless surface");
  assert.ok(!byName.read_runs, "read_runs must not exist on the stateless surface");
  assert.deepEqual(byName.validate_case.function.parameters.required, ["yaml"]);
  assert.deepEqual(byName.lint_case.function.parameters.required, ["yaml"]);
  // propose_draft hands back {path, yaml} per story — draftStory reads
  // args.path/args.yaml/args.rationale, and args.more continues a requested set.
  assert.deepEqual(byName.propose_draft.function.parameters.required, ["path", "yaml"]);
  assert.deepEqual(
    Object.keys(byName.propose_draft.function.parameters.properties).sort(),
    ["more", "path", "rationale", "yaml"],
  );
});
