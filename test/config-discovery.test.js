// Phase 1 foundation of discovery mode (docs/discovery-mode-plan.md §2-3):
// schema validation of every loaded YAML doc, mode/report resolution, the
// cross-field rules, and the personas fan-out. Pure config — no LLM, no
// browser. Resolution is driven in-process via discoverCases; exit-code and
// stderr contracts go through the real CLI as a child process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCases, DummyConfigError } from "../src/harness/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "harness", "cli.js");
const CHILD_TIMEOUT_MS = 30_000;

let tmpRoot;
const children = new Set();

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-config-discovery-"));
});

after(() => {
  for (const child of children) child.kill("SIGKILL");
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- helpers ----------

const BASE = "app:\n  base_url: http://localhost:9\n";

let suiteSeq = 0;

/** Write an inline suite from { "name.yaml": "content", ... }; returns its dir. */
function writeSuite(files) {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

async function expectConfigError(dir, ...patterns) {
  await assert.rejects(discoverCases([dir]), (e) => {
    assert.ok(e instanceof DummyConfigError, `expected DummyConfigError, got: ${e?.stack ?? e}`);
    for (const p of patterns) assert.match(e.message, p);
    return true;
  });
}

function childEnv() {
  const env = { ...process.env };
  delete env.PLAYTEST_LLM_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PLAYTEST_LLM_CACHE; // opt-in caching off for offline tests — keeps the wire bytes golden
  return env;
}

/** Spawn `node src/harness/cli.js <args>`; resolves with { code, stdout, stderr }. */
function runCli(args, { timeoutMs = CHILD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      children.delete(child);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (timedOut) {
        reject(new Error(`playtest ${args.join(" ")} hung past ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

const dump = (res) => `\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`;

// ---------- defaults ----------

test("the default actor_model is the pinned cheap model (claude-haiku-4-5)", async () => {
  // The cheap default is load-bearing: journeys pin a small actor on purpose
  // (the app is the variable, not the agent). Catch a silent flip to a pricier model.
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "add-todo.yaml": 'story: |\n  Add a todo called "buy milk".\n',
  });
  const [rc] = await discoverCases([dir]);
  assert.equal(rc.actor_model, "claude-haiku-4-5");
  assert.equal(rc.grader_model, "claude-sonnet-4-6");
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

test("a defaults file rejects every case-only key", async () => {
  const caseOnly = {
    story: "story: |\n  Placeholder.\n",
    description: "description: One-line summary.\n",
    tags: "tags: [smoke]\n",
    success: "success:\n  - assert: anything\n",
    personas: "personas: [power-user]\n",
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
  const byName = Object.fromEntries((await discoverCases([dir])).map((c) => [c.name, c]));
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
  const [c] = await discoverCases([dir]);
  assert.equal(c.limits.max_steps, 9, "case-file limits.max_steps wins");
  assert.equal(c.limits.timeout_ms, 90_000, "defaults-file limits.timeout inherits");
});

// ---------- mode / report resolution ----------

test("mode defaults to journey; report defaults to []", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "plain.yaml": "story: |\n  Placeholder journey.\n",
  });
  const [c] = await discoverCases([dir]);
  assert.equal(c.mode, "journey");
  assert.deepEqual(c.report, []);
  assert.ok(!("personas" in c), "personas never lands on a final ResolvedCase");
});

test("mode inherits from playtest.yaml; the case file wins nearest", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "explore.yaml": "story: |\n  Find the export.\n",
    "regression.yaml": "mode: journey\nstory: |\n  Placeholder journey.\nsuccess:\n  - url_matches: /done/*\n",
  });
  const cases = await discoverCases([dir]);
  const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
  assert.equal(byId["explore"].mode, "discovery");
  assert.equal(byId["regression"].mode, "journey");
  assert.deepEqual(byId["regression"].success, [{ url_matches: "/done/*" }]);
});

test("report resolves from the case file", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "study.yaml": "story: |\n  Explore.\nreport:\n  - Where did the user look first?\n  - What did they try before giving up?\n",
  });
  const [c] = await discoverCases([dir]);
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

test("personas in a journey-mode case is a config error", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "journey.yaml": "story: |\n  Placeholder journey.\npersonas: [power-user]\n",
  });
  await expectConfigError(dir, /journey\.yaml/, /"personas" is discovery-only/);
});

test("an empty personas array is a config error", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "empty.yaml": "story: |\n  Explore.\npersonas: []\n",
  });
  await expectConfigError(dir, /empty\.yaml/, /personas/);
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

// ---------- personas fan-out ----------

test("personas fan out into <id>@<ref> instances with persona overridden", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "export-data.yaml": [
      "story: |",
      "  Get your data out of the app however seems natural.",
      "tags: [study]",
      "persona: tester",
      "personas: [power-user, first-timer]",
      "report:",
      "  - Where did the user look first?",
      "",
    ].join("\n"),
  });
  const cases = await discoverCases([dir]);
  // fanned out, then sorted by id — YAML order [power-user, first-timer] does not survive
  assert.deepEqual(cases.map((c) => c.id), ["export-data@first-timer", "export-data@power-user"]);
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
  const cases = await discoverCases([dir]);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, "solo");
  assert.equal(cases[0].persona, "exploratory");
});

// ---------- end-to-end through the CLI ----------

test("cli: a schema error exits 2 and names the file and key on stderr", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "typo.yaml": 'story: |\n  Placeholder journey.\nsuccess:\n  - element_exits: "[data-testid=x]"\n',
  });
  const res = await runCli(["list", dir, "--json"]);
  assert.equal(res.code, 2, `config errors must exit 2${dump(res)}`);
  assert.match(res.stderr, /typo\.yaml/);
  assert.match(res.stderr, /element_exits/);
});

test("cli: list --json shows fan-out ids with per-instance personas", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE + "mode: discovery\n",
    "export-data.yaml": "story: |\n  Get your data out.\npersonas: [power-user, first-timer]\n",
  });
  const res = await runCli(["list", dir, "--json"]);
  assert.equal(res.code, 0, `list should exit 0${dump(res)}`);
  const entries = JSON.parse(res.stdout);
  assert.deepEqual(
    entries.map((e) => [e.id, e.persona]),
    [
      ["export-data@first-timer", "first-timer"],
      ["export-data@power-user", "power-user"],
    ],
  );
});

// ---------- compatibility: the shipped suites stay valid ----------

test("the repo's tests/ and src/demo suites still resolve, all journey", async () => {
  // tests/ = 3 todo cases + 7 viewer self-test cases; src/demo = 3 todo cases.
  for (const [suite, count] of [[path.join(ROOT, "tests"), 10], [path.join(ROOT, "src", "demo"), 3]]) {
    const cases = await discoverCases([suite]);
    assert.equal(cases.length, count, suite);
    for (const c of cases) {
      assert.equal(c.mode, "journey", `${suite} ${c.id}`);
      assert.deepEqual(c.report, []);
      assert.ok(!("personas" in c));
    }
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
  const cases = await discoverCases([dir]);
  assert.deepEqual(cases.map((c) => c.id).sort(), ["a", "stories/a"]);
});

test("a bare top-level key (null value) is treated as absent, not a type error", async () => {
  const dir = writeSuite({
    "playtest.yaml": BASE,
    "a.yaml": "story: do the thing\ntags:\nsuccess:\nreport:\nperf:\n",
  });
  const cases = await discoverCases([dir]);
  assert.equal(cases.length, 1);
  assert.deepEqual(cases[0].tags, []);
  assert.deepEqual(cases[0].success, []);
  assert.deepEqual(cases[0].report, []);
});
