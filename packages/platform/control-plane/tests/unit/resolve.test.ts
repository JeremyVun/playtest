import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCases, validateTree, lintTree } from "../../src/suites/resolve.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const TODOS = path.resolve(here, "../../../../../tests/fixtures/todos");

/** Load a suite dir into a { path: content } map (skipping run output). */
function loadSuite(dir: HostedDynamic) {
  const files: HostedDynamic = {};
  const walk = (d: HostedDynamic, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "results" || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else files[r] = fs.readFileSync(path.join(d, e.name), "utf8");
    }
  };
  walk(dir);
  return files;
}

test("resolveCases: mirrors the CLI's resolved cases for the todo fixture", async () => {
  const cases: HostedDynamic = await resolveCases(loadSuite(TODOS));
  assert.deepEqual(cases.map((c: HostedDynamic) => c.id), ["add-todo", "clear-completed", "complete-todo"]);
  const add: HostedDynamic = cases[0];
  assert.equal(add.path, "stories/add-todo.yaml"); // id drops stories/, path keeps it
  assert.equal(add.driver, "web");
  assert.equal(add.next_run, "record"); // no baselines in a fresh tree
  assert.deepEqual(add.tags, ["smoke"]);
});

test("validateTree: ok for a valid tree, returns the resolved cases", async () => {
  const res: HostedDynamic = await validateTree(loadSuite(TODOS));
  assert.equal(res.ok, true);
  assert.equal(res.cases.length, 3);
});

test("validateTree: surfaces the verbatim core message with a suite-relative path", async () => {
  const files = loadSuite(TODOS);
  files["stories/add-todo.yaml"] = files["stories/add-todo.yaml"].replace("success:", "succes:");
  const res: HostedDynamic = await validateTree(files);
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].path, "stories/add-todo.yaml");
  assert.match(res.errors[0].message, /unknown key "succes"/);
  // No temp path leaks into the message.
  assert.doesNotMatch(res.errors[0].message, /\/(var|tmp|private)\//);
});

test("validateTree: `only` scopes validation to named case files", async () => {
  const files = loadSuite(TODOS);
  const res: HostedDynamic = await validateTree(files, { only: ["stories/add-todo.yaml"] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.cases.map((c: HostedDynamic) => c.id), ["add-todo"]);
});

test("lintTree: flags a journey with no success criteria", async () => {
  const files = {
    "playtest.yaml": "app:\n  base_url: http://x\n",
    "stories/empty.yaml": "story: do a thing\nsuccess: []\n",
  };
  const findings = await lintTree(files);
  assert.ok(findings.some((f) => /no success criteria/.test(f.message)));
});

test("lintTree: a tree that cannot be resolved at all yields no findings instead of throwing", async () => {
  // Unresolvable for a STRUCTURAL reason — an unknown key. There is genuinely
  // nothing to lint, and validateTree is what reports it; lint never fails a
  // request. This catch must stay narrow (see the next test).
  const files = { "stories/bad.yaml": "story: x\nsucces: bad\n" };
  assert.deepEqual(await lintTree(files), []);
});

test("lintTree: a suite authoring no target still lints, with real findings", async () => {
  // The swallow above used to hide this case: hosted suites author no base_url
  // (the ring supplies it at launch), so under executable resolution every one
  // of them fell into the catch and silently reported zero findings. Structural
  // resolution is what makes lint mean something for a hosted suite (gate 14).
  const files = { "stories/empty.yaml": "story: do a thing\nsuccess: []\n" };
  const findings: HostedDynamic = await lintTree(files);
  assert.ok(
    findings.some((f: HostedDynamic) => /no success criteria/.test(f.message)),
    "a target-free suite is linted, not skipped",
  );
});

test("resolveCases and validateTree accept a suite with no physical target", async () => {
  // Gate 14's editing half: commit, listing, preview and authoring all read
  // through these two, and a hosted suite legitimately declares no URL.
  const files = { "stories/a.yaml": "story: do a thing\nsuccess:\n  - url_matches: /a\n" };
  const cases: HostedDynamic = await resolveCases(files);
  assert.deepEqual(cases.map((c: HostedDynamic) => c.id), ["a"]);
  const res: HostedDynamic = await validateTree(files);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});
