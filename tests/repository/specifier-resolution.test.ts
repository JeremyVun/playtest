import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every relative module reference in first-party code must resolve to a real
// file. The TypeScript migration renames files while many importers are still
// plain .js outside the typechecker's program, so a missed specifier rewrite
// is invisible until some test happens to execute that exact import. This
// test makes the whole import graph a deterministic gate.
//
// Resolution rule: the referenced path must exist, or — for browser-served
// emit directories where sources are .ts but specifiers stay .js — the .ts
// sibling of a .js specifier must exist.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_ROOTS = ["packages", "tests"].map((dir) => path.join(ROOT, dir));
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts"]);

// Directories whose contents are not first-party import-graph members:
// vendored code and fixtures that model user-authored files.
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "fixtures", "vendor", "build", ".test-build"]);

function sourceFiles(root: LegacyTestValue) {
  const files: LegacyTestValue = [];
  const visit = (dir: LegacyTestValue) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(file);
    }
  };
  visit(root);
  return files;
}

// A line containing this marker is skipped: for source-code-as-data strings
// in tests, where an import statement is fixture text, not a module edge.
const IGNORE_MARKER = "specifier-resolution-ignore";

const REFERENCE_PATTERNS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*[,)]/g,
  /\bnew\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url/g,
];

function relativeReferences(source: LegacyTestValue) {
  const references = [];
  const lines = source.split("\n");
  for (const pattern of REFERENCE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const line = source.slice(0, match.index).split("\n").length;
      if (lines[line - 1].includes(IGNORE_MARKER)) continue;
      references.push({ specifier, line });
    }
  }
  return references;
}

function existsAllowingTsSource(target: LegacyTestValue) {
  if (fs.existsSync(target)) return true;
  if (target.endsWith(".js") && fs.existsSync(target.slice(0, -3) + ".ts")) return true;
  if (target.endsWith(".mjs") && fs.existsSync(target.slice(0, -4) + ".mts")) return true;
  return false;
}

function resolves(file: LegacyTestValue, specifier: LegacyTestValue) {
  const bare = specifier.split(/[?#]/)[0];
  return existsAllowingTsSource(path.resolve(path.dirname(file), bare));
}

test("every relative module reference resolves to an existing file", () => {
  const violations = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const source = fs.readFileSync(file, "utf8");
      for (const { specifier, line } of relativeReferences(source)) {
        if (!resolves(file, specifier)) {
          violations.push(`${path.relative(ROOT, file)}:${line} -> ${specifier}`);
        }
      }
    }
  }
  assert.deepEqual(violations.sort(), []);
});
