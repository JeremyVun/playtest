import assert from "node:assert/strict";
import test from "node:test";
import {
  areaForFile,
  countLines,
  importedSpecifiers,
  renderMermaid,
} from "./lib.mjs";
import { htmlReport } from "./html-report.mjs";

test("counts code, comment, mixed, and blank TypeScript lines", () => {
  assert.deepEqual(
    countLines(`// comment
const one = 1; // mixed
/*
 * block
 */

const url = "https://example.com";
`, "slash"),
    { code: 2, comment: 4, blank: 1, total: 7 },
  );
});

test("renders collapsed Mermaid edges with import counts", () => {
  const graph = {
    edges: [
      { from: "packages/a/src/one.ts", to: "packages/b/src/two.ts" },
      { from: "packages/a/src/three.ts", to: "packages/b/src/two.ts" },
      { from: "packages/a/src/one.ts", to: "external:node:fs" },
    ],
    workspaces: {
      "@example/a": "packages/a",
      "@example/b": "packages/b",
    },
  };
  const diagram = renderMermaid(graph);
  assert.ok(diagram.includes("@example/a"));
  assert.ok(diagram.includes("@example/b"));
  assert.ok(diagram.includes("|2 imports|"));
  assert.ok(!diagram.includes("node:fs"));
});

test("finds module syntax without treating comments as imports", () => {
  assert.deepEqual(
    importedSpecifiers(`
      // import "ignored";
      import type { One } from "./one.ts";
      export { Two } from "./two.ts";
      const three = await import("./three.ts");
      const four = require("./four.cjs");
    `).sort(),
    ["./four.cjs", "./one.ts", "./three.ts", "./two.ts"],
  );
});

test("separates production, test, and vendored package lines", () => {
  assert.equal(areaForFile("packages/core/src/run.ts"), "packages/core/src");
  assert.equal(areaForFile("packages/core/tests/run.test.ts"), "packages/core/tests");
  assert.equal(
    areaForFile("packages/platform/web/src/vendor/library.js"),
    "packages/platform/web/vendor",
  );
});

test("requires a scope for file-level diagrams", () => {
  assert.throws(
    () => renderMermaid({ edges: [], workspaces: {} }, { level: "file" }),
    /require --scope/,
  );
});

test("renders a self-contained HTML report", () => {
  const stats = {
    totals: { files: 1, code: 10, comment: 2, blank: 1, total: 13 },
    areas: [{ name: "packages/example/src", files: 1, code: 10, comment: 2, blank: 1, total: 13 }],
    languages: [{ name: "TypeScript", files: 1, code: 10, comment: 2, blank: 1, total: 13 }],
    files: [{
      path: "packages/example/src/index.ts",
      area: "packages/example/src",
      language: "TypeScript",
      code: 10,
      comment: 2,
      blank: 1,
      total: 13,
    }],
  };
  const graph = {
    modules: ["packages/example/src/index.ts"],
    edges: [],
    cycles: [],
    unresolved: [],
    workspaces: { "@example/package": "packages/example" },
  };
  const report = htmlReport(stats, graph);
  assert.match(report, /^<!doctype html>/);
  assert.match(report, /<svg class="dependency-graph"/);
  assert.ok(report.includes("packages/example/src/index.ts"));
  assert.doesNotMatch(report, /<script[^>]+src=/);
  assert.doesNotMatch(report, /<link[^>]+href=/);
});
