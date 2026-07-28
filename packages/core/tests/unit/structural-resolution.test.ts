// Structural resolution (docs/contracts/engine.md#resolution-modes): the mode a
// host uses when it validates, lists, lints, or exports a suite it is not about
// to run. Such a suite legitimately authors no physical target — the placer
// supplies it — so requiring `base_url`/`app.app` there would make "cannot save
// a suite without a URL" a permanent editing failure.
//
// The split is deliberately narrow: structural resolution drops exactly the two
// physical-completeness requirements and NOTHING else. Every case rule, every
// logical-configuration rule, and every schema rule still applies — a validation
// mode that stopped validating would be worse than no mode at all.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases, DummyConfigError } from "../../src/config.ts";
import { lintCase } from "../../src/lint.ts";
import { exportSpec } from "../../src/export-playwright.ts";

let tmpRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-structural-"));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let suiteSeq = 0;

function writeSuite(files: Record<string, string>): string {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

/** A web suite that names no target at all — the hosted authoring shape. */
const urllessWebSuite = (): string =>
  writeSuite({
    "playtest.yaml": "persona: tester\n",
    "stories/add-todo.yaml": 'story: |\n  Add a todo called "buy milk".\nsuccess:\n  - assert: the todo appears in the list\n',
  });

/** A mobile suite that names no build — the runner supplies it at placement. */
const applessMobileSuite = (): string =>
  writeSuite({
    "playtest.yaml": "app:\n  driver: mobile\n  platform: ios\n",
    "stories/add-todo.yaml": 'story: |\n  Add a todo called "buy milk".\nsuccess:\n  - screen_shows: buy milk\n',
  });

// ---------- gate 14, core side ----------

test("a URL-less web suite resolves structurally and is refused executably", async () => {
  const dir = urllessWebSuite();
  await assert.rejects(
    () => discoverCases([dir]),
    (e) => e instanceof DummyConfigError && /no app\.base_url configured/.test(e.message),
    "executable resolution must still demand a complete target",
  );
  const cases = await discoverCases([dir], { resolution: "structural" });
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.id, "add-todo");
  assert.equal(cases[0]!.env.driver, "web");
  assert.equal(cases[0]!.env.base_url, null);
});

test("an app-less mobile suite resolves structurally and is refused executably", async () => {
  const dir = applessMobileSuite();
  await assert.rejects(
    () => discoverCases([dir]),
    (e) => e instanceof DummyConfigError && /the mobile driver needs app\.app/.test(e.message),
  );
  const cases = await discoverCases([dir], { resolution: "structural" });
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.env.driver, "mobile");
  assert.equal(cases[0]!.env.app, null);
});

test("the runtime target completes a structurally-authored suite for execution", async () => {
  // The whole point of the split: the target the suite does not author arrives
  // at placement, and executable resolution is then satisfied.
  const web = await discoverCases([urllessWebSuite()], {
    runtimeTarget: { base_url: "http://ring.internal:4173" },
  });
  assert.equal(web[0]!.env.base_url, "http://ring.internal:4173");
  const mobile = await discoverCases([applessMobileSuite()], {
    runtimeTarget: { app: "/runner/builds/Todo.app", platform: "ios", appium_url: "http://127.0.0.1:4723" },
  });
  assert.equal(mobile[0]!.env.app, "/runner/builds/Todo.app");
});

// ---------- structural still validates ----------

test("structural resolution drops the target requirement and nothing else", async () => {
  // Schema validity, case-only keys, and the driver matrix are still enforced —
  // otherwise "validated" would mean nothing to the person editing the suite.
  for (const [files, pattern] of [
    [{ "playtest.yaml": "persona: tester\n", "stories/a.yaml": "success:\n  - assert: it works\n" }, /missing required "story"/],
    [
      { "playtest.yaml": "persona: tester\n", "stories/a.yaml": "story: |\n  Do it.\nmode: discovery\nsuccess:\n  - assert: x\n" },
      /discovery cases have no pass\/fail gate/,
    ],
    [
      {
        "playtest.yaml": "app:\n  driver: mobile\n  platform: ios\n",
        "stories/a.yaml": "story: |\n  Do it.\nsuccess:\n  - element_exists: \"#total\"\n",
      },
      /"element_exists" is not valid for the mobile driver/,
    ],
    [
      { "playtest.yaml": "persona: tester\n", "stories/a.yaml": "story: |\n  Do it.\napp:\n  device: iPhone 16\n" },
      /app\.device is not valid for the web driver/,
    ],
  ] as Array<[Record<string, string>, RegExp]>) {
    const dir = writeSuite(files);
    await assert.rejects(
      () => discoverCases([dir], { resolution: "structural" }),
      (e) => e instanceof DummyConfigError && pattern.test(e.message),
      `structural resolution must still enforce ${pattern}`,
    );
  }
});

test("an unknown resolution mode names both modes rather than guessing one", async () => {
  await assert.rejects(
    () => discoverCases([urllessWebSuite()], { resolution: "loose" as LegacyTestValue }),
    (e) => e instanceof DummyConfigError && /unknown resolution mode "loose"/.test(e.message),
  );
});

// ---------- the two consumers that needed care ----------

test("a structurally-resolved case lints with REAL findings, not silence", async () => {
  const dir = writeSuite({
    "playtest.yaml": "persona: tester\n",
    // A journey whose gate checks nothing: the finding lint exists to report.
    "stories/add-todo.yaml": "story: |\n  Add a todo.\n",
  });
  const [rc] = await discoverCases([dir], { resolution: "structural" });
  const warnings = lintCase(rc as LegacyTestValue);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message, /journey has no success criteria/);
});

test("exporting a URL-less case emits the environment override and no baked-in default", async () => {
  const [rc] = await discoverCases([urllessWebSuite()], { resolution: "structural" });
  const { code, notes } = exportSpec({
    caseCfg: rc as LegacyTestValue,
    envelopes: [],
    sourcePath: "stories/add-todo.yaml",
  });
  // No invented default, and in particular not the empty string: `page.goto("")`
  // is an invalid navigation, which is exactly the failure the guard replaces.
  assert.doesNotMatch(code, /PLAYTEST_BASE_URL \?\?/);
  assert.match(code, /const BASE_URL = requireBaseUrl\(\);/);
  assert.match(code, /function requireBaseUrl\(\): string \{/);
  assert.match(code, /throw new Error\(/);
  assert.match(code, /"PLAYTEST_BASE_URL is not set\./);
  assert.ok(
    notes.some((n) => /no default target/.test(n)),
    "the export must say out loud that the spec needs PLAYTEST_BASE_URL",
  );
});
