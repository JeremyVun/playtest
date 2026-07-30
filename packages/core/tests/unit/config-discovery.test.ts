// Phase 1 foundation of discovery mode (docs/discovery-mode-plan.md §2-3):
// schema validation of every loaded YAML doc, mode/report resolution, the
// cross-field rules, and the personas fan-out. Pure config — no LLM, no
// browser. Resolution is driven in-process via discoverCases; exit-code and
// stderr contracts go through the real CLI as a child process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCases, DummyConfigError } from "../../src/config.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmpRoot: LegacyTestValue;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-config-discovery-"));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- helpers ----------

const BASE = "app:\n  base_url: http://localhost:9\n";

let suiteSeq = 0;

/** Write an inline suite from { "name.yaml": "content", ... }; returns its dir. */
function writeSuite(files: Record<string, string>) {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

async function expectConfigError(dir: string, ...patterns: RegExp[]) {
  await assert.rejects(discoverCases([dir]), (e: LegacyTestValue) => {
    assert.ok(e instanceof DummyConfigError, `expected DummyConfigError, got: ${e?.stack ?? e}`);
    for (const p of patterns) assert.match(e.message, p);
    return true;
  });
}

// ---------- defaults ----------

test("the default models use the current model tiers", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "add-todo.yaml": 'story: |\n  Add a todo called "buy milk".\n',
  });
  const [rc]: LegacyTestValue = await discoverCases([dir]);
  assert.equal(rc.actor_model, "gpt5_4_mini");
  assert.equal(rc.grader_model, "gpt5_5");
});

// ---------- schema validation ----------

test("an unknown case-file key is rejected naming the file and the key", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "typo.yaml": "story: |\n  Placeholder journey.\nstorry: oops\n",
  });
  await expectConfigError(dir, /typo\.yaml/, /unknown key "storry"/);
});

test("an unknown nested key names its dotted path", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_urll: http://localhost:9\n",
    "ok.yaml": "story: |\n  Placeholder journey.\n",
  });
  await expectConfigError(dir, /playtest\.yaml/, /unknown key "app\.base_urll"/);
});

test("built-in assert is string-only; custom assertion keys accept JSON scalars", async () => {
  const custom = writeSuite({
    "playtest.yaml": BASE,
    "assertions/scalars/assertion.js": `export default {
  keys: () => ["custom_text", "custom_count", "custom_enabled"],
  gather: async () => ({}),
  verdict: () => ({ pass: true, detail: "ok" }),
};`,
    "custom.yaml": [
      "story: Exercise custom scalar values.",
      "success:",
      "  - custom_text: hello",
      "  - custom_count: 3",
      "  - custom_enabled: true",
      "",
    ].join("\n"),
  });
  const [resolved]: LegacyTestValue = await discoverCases([custom]);
  assert.deepEqual(resolved.success, [
    { custom_text: "hello" },
    { custom_count: 3 },
    { custom_enabled: true },
  ]);

  const builtin = writeSuite({
    "playtest.yaml": BASE,
    "bad.yaml": "story: Exercise the built-in assertion.\nsuccess:\n  - assert: true\n",
  });
  await expectConfigError(builtin, /bad\.yaml/, /assert/, /string/);
});

test("a defaults file rejects every case-only key", async () => {
  const caseOnly = {
    story: "story: |\n  Placeholder.\n",
    description: "description: One-line summary.\n",
    tags: "tags: [smoke]\n",
    success: "success:\n  - assert: anything\n",
    report: "report:\n  - Where did the user look first?\n",
  };
  for (const [key, yaml] of Object.entries(caseOnly)) {
    const dir = writeSuite({
      "playtest.yaml": BASE + yaml,
      "ok.yaml": "story: |\n  Placeholder journey.\n",
    });
    await expectConfigError(dir, /playtest\.yaml/, new RegExp(`unknown key "${key}"`));
  }
});

test("description: optional summary lands on the resolved case, null when absent", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "summarized.yaml": "story: |\n  Placeholder journey.\ndescription: Adds a todo and sees it listed.\n",
    "plain.yaml": "story: |\n  Placeholder journey.\n",
  });
  const byName: LegacyTestValue = Object.fromEntries((await discoverCases([dir])).map((c) => [c.name, c]));
  assert.equal(byName.summarized.description, "Adds a todo and sees it listed.");
  assert.equal(byName.plain.description, null);
});

test("runs_per_case (removed) is rejected as unknown in both file kinds", async () => {
  const inCase = writeSuite({
    "playtest.yaml": BASE,
    "repeat.yaml": "story: |\n  Placeholder journey.\nruns_per_case: 3\n",
  });
  await expectConfigError(inCase, /repeat\.yaml/, /unknown key "runs_per_case"/);
  const inDefaults = writeSuite({
    "playtest.yaml": BASE + "runs_per_case: 3\n",
    "ok.yaml": "story: |\n  Placeholder journey.\n",
  });
  await expectConfigError(inDefaults, /playtest\.yaml/, /unknown key "runs_per_case"/);
});

test("a bad mode value lists the allowed values", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: explore\n",
    "ok.yaml": "story: |\n  Placeholder journey.\n",
  });
  await expectConfigError(dir, /playtest\.yaml/, /"mode" must be one of journey\/discovery/);
});

test("nested limits spelling is accepted in both file kinds", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "limits:\n  max_steps: 7\n  timeout: 90s\n",
    "case.yaml": "story: |\n  Placeholder journey.\nlimits:\n  max_steps: 9\n",
  });
  const [c]: LegacyTestValue = await discoverCases([dir]);
  assert.equal(c.limits.max_steps, 9, "case-file limits.max_steps wins");
  assert.equal(c.limits.timeout_ms, 90_000, "defaults-file limits.timeout inherits");
});

// ---------- mode / report resolution ----------

test("mode defaults to journey; report defaults to []", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "plain.yaml": "story: |\n  Placeholder journey.\n",
  });
  const [c]: LegacyTestValue = await discoverCases([dir]);
  assert.equal(c.mode, "journey");
  assert.deepEqual(c.limits, { max_steps: 50, timeout_ms: 600_000 });
  assert.deepEqual(c.report, []);
  assert.ok(!("personas" in c), "personas never lands on a final ResolvedCase");
});

test("mode inherits from playtest.yaml; the case file wins nearest", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "explore.yaml": "story: |\n  Find the export.\n",
    "regression.yaml": "mode: journey\nstory: |\n  Placeholder journey.\nsuccess:\n  - url_matches: /done/*\n",
  });
  const cases: LegacyTestValue = await discoverCases([dir]);
  const byId: LegacyTestValue = Object.fromEntries(cases.map((c: LegacyTestValue) => [c.id, c]));
  assert.equal(byId["explore"].mode, "discovery");
  assert.equal(byId["regression"].mode, "journey");
  assert.deepEqual(byId["regression"].success, [{ url_matches: "/done/*" }]);
});

test("report resolves from the case file", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "study.yaml": "story: |\n  Explore.\nreport:\n  - Where did the user look first?\n  - What did they try before giving up?\n",
  });
  const [c]: LegacyTestValue = await discoverCases([dir]);
  assert.deepEqual(c.report, [
    "Where did the user look first?",
    "What did they try before giving up?",
  ]);
});

// ---------- cross-field rules ----------

test("a discovery case declaring success is a config error", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "gated.yaml": "story: |\n  Explore.\nsuccess:\n  - assert: anything\n",
  });
  await expectConfigError(dir, /gated\.yaml/, /discovery cases have no pass\/fail gate/);
});

test("a journey given a persona list uses the first persona (no fan-out, no error)", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "journey.yaml": "story: |\n  Placeholder journey.\npersona: [power-user, first-timer]\n",
  });
  const cases: LegacyTestValue = await discoverCases([dir]);
  assert.equal(cases.length, 1, "a journey does not fan out");
  assert.equal(cases[0].persona, "power-user", "uses the first persona in the list");
  assert.ok(!("personas" in cases[0]), "no fan-out list on a resolved journey case");
});

test("an empty persona list is a config error", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "empty.yaml": "story: |\n  Explore.\npersona: []\n",
  });
  await expectConfigError(dir, /empty\.yaml/, /persona.*at least 1 entry/);
});

test("the renamed personas: key gives a migration hint naming the file", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "old.yaml": "story: |\n  Explore.\npersonas: [power-user]\n",
  });
  await expectConfigError(dir, /old\.yaml/, /personas: is now persona:/);
});

test("a persona list in a defaults file is rejected (scalar only there)", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\npersona: [power-user, first-timer]\n",
    "ok.yaml": "story: |\n  Explore.\n",
  });
  await expectConfigError(dir, /playtest\.yaml/, /persona.*must be string/);
});

test("a mobile case without app.app is a config error naming the file", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  driver: mobile\n  platform: ios\n",
    "tap.yaml": "story: |\n  Tap around the native app.\n",
  });
  await expectConfigError(dir, /tap\.yaml/, /needs app\.app/);
});

test("an api case without base_url is a config error", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  driver: api\n",
    "call.yaml": "story: |\n  Create a todo over the API.\n",
  });
  await expectConfigError(dir, /call\.yaml/, /base_url/);
});

test("a web case with a mobile-only app key (platform) is rejected naming the file", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n  platform: ios\n",
    "leftover.yaml": "story: |\n  Placeholder journey.\n",
  });
  await expectConfigError(dir, /leftover\.yaml/, /app\.platform is not valid for the web driver/);
});

test("an api case with a web-only app key (storage_state) is rejected naming the file", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n  driver: api\n",
    "auth.yaml": "story: |\n  Call the API.\napp:\n  storage_state: ./state.json\n",
  });
  await expectConfigError(dir, /auth\.yaml/, /app\.storage_state is not valid for the api driver/);
});

// ---------- persona-list fan-out ----------

test("a persona list fans out into <id>@<ref> instances with persona overridden", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "export-data.yaml": [
      "story: |",
      "  Get your data out of the app however seems natural.",
      "tags: [study]",
      "persona: [power-user, first-timer]",
      "report:",
      "  - Where did the user look first?",
      "",
    ].join("\n"),
  });
  const cases: LegacyTestValue = await discoverCases([dir]);
  // fanned out, then sorted by id — YAML order [power-user, first-timer] does not survive
  assert.deepEqual(cases.map((c: LegacyTestValue) => c.id), ["export-data@first-timer", "export-data@power-user"]);
  for (const c of cases) {
    assert.equal(c.persona, c.id.split("@")[1], "singular persona is overridden per instance");
    assert.ok(!("personas" in c), "personas never lands on a final ResolvedCase");
    assert.equal(c.mode, "discovery");
    assert.deepEqual(c.report, ["Where did the user look first?"]);
  }
  // tag filtering happens before fan-out: all-or-nothing per case
  assert.deepEqual(await discoverCases([dir], { tags: ["other"] }), []);
  assert.equal((await discoverCases([dir], { tags: ["study"] })).length, 2);
});

test("a discovery case without personas resolves as a single instance", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "solo.yaml": "story: |\n  Look around.\npersona: exploratory\n",
  });
  const cases: LegacyTestValue = await discoverCases([dir]);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, "solo");
  assert.equal(cases[0].persona, "exploratory");
});

// ---------- compatibility: the test-owned fixture stays valid ----------

test("the test todo fixture resolves as journeys", async () => {
  const suite = path.join(ROOT, "tests", "fixtures", "todos");
  const cases = await discoverCases([suite]);
  assert.equal(cases.length, 3, suite);
  for (const c of cases) {
    assert.equal(c.mode, "journey", `${suite} ${c.id}`);
    assert.deepEqual(c.report, []);
    assert.ok(!("personas" in c));
  }
});

test("nested stories/stories/ keeps a distinct id, doesn't collide with stories/", async () => {
  // Only the first `stories/` segment is structural; a deeper one stays in the
  // id so two distinct files don't both resolve to "a" (and one baseline path).
  const dir = writeSuite({ "playtest.yaml": BASE });
  fs.mkdirSync(path.join(dir, "stories", "stories"), { recursive: true });
  const body = "story: |\n  Placeholder journey.\n";
  fs.writeFileSync(path.join(dir, "stories", "a.yaml"), body);
  fs.writeFileSync(path.join(dir, "stories", "stories", "a.yaml"), body);
  const cases: LegacyTestValue = await discoverCases([dir]);
  assert.deepEqual(cases.map((c: LegacyTestValue) => c.id).sort(), ["a", "stories/a"]);
});

test("a bare top-level key (null value) is treated as absent, not a type error", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "a.yaml": "story: do the thing\ntags:\nsuccess:\nreport:\nperf:\n",
  });
  const cases: LegacyTestValue = await discoverCases([dir]);
  assert.equal(cases.length, 1);
  assert.deepEqual(cases[0].tags, []);
  assert.deepEqual(cases[0].success, []);
  assert.deepEqual(cases[0].report, []);
});
