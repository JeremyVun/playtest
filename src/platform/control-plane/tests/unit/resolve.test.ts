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

test("lintTree: never throws on an invalid tree (returns no findings)", async () => {
  const files = { "stories/bad.yaml": "story: x\nsucces: bad\n" };
  assert.deepEqual(await lintTree(files), []);
});
