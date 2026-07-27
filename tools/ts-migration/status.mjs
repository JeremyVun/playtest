#!/usr/bin/env node
// Migration workbench for the TypeScript migration
// (docs/backlog/ts_migration/BUILD_PLAN.md).
//
// Usage:
//   node tools/ts-migration/status.mjs                    # progress + debt
//   node tools/ts-migration/status.mjs importers <file>…  # who references a module, by any mechanism
//   node tools/ts-migration/status.mjs closure <file>…    # is this slice import-closed?
//
// `importers` is the mandatory pre-rename step: it greps by bare filename so
// it catches dynamic imports, new URL() references, spawn paths in tests,
// package.json bin/exports values, and npm script globs — everything the
// typechecker cannot see. `closure` checks strategy rule 6 before a slice
// starts. Frozen studies are never scanned; fixtures modeling user code are
// reported separately so nobody "fixes" them.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const EMIT_DIRS = ["src/core/shared", "src/run-viewer/web", "src/platform/web"].map((dir) =>
  path.join(ROOT, dir),
);
const FIXTURE_DIR_NAMES = new Set(["fixtures", "vendor", "node_modules"]);
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts", ".json", ".md", ".sh", ".yaml", ".yml", ".html"]);

function walk(root, { includeFixtures = false } = {}) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const visit = (dir, inFixture) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fixture = inFixture || FIXTURE_DIR_NAMES.has(entry.name);
      if (fixture && !includeFixtures) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, fixture);
      else if (entry.isFile()) files.push({ file, fixture });
    }
  };
  visit(root, false);
  return files;
}

const rel = (file) => path.relative(ROOT, file);

// --- status ----------------------------------------------------------------

const AREAS = [
  "src/core",
  "src/cli",
  "src/run-viewer",
  "src/platform/control-plane",
  "src/platform/runner-agent",
  "src/platform/web",
  "tests",
];

function status() {
  console.log("conversion progress (first-party, fixtures and vendor excluded):\n");
  let totalJs = 0;
  for (const area of AREAS) {
    const files = walk(path.join(ROOT, area));
    const js = files.filter(({ file }) => /\.(js|mjs)$/.test(file)).length;
    const ts = files.filter(({ file }) => /\.(ts|mts)$/.test(file) && !file.endsWith(".d.ts")).length;
    totalJs += js;
    const done = js === 0 ? "  DONE" : "";
    console.log(`  ${area.padEnd(34)} js ${String(js).padStart(4)}   ts ${String(ts).padStart(4)}${done}`);
  }
  console.log(`\n  remaining .js/.mjs: ${totalJs}\n`);

  const debt = { "TODO(ts)": [], "@ts-expect-error": [], any: 0 };
  const forbidden = [];
  for (const area of AREAS) {
    for (const { file } of walk(path.join(ROOT, area))) {
      if (!/\.(ts|mts)$/.test(file)) continue;
      const source = fs.readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((text, index) => {
        const at = `${rel(file)}:${index + 1}`;
        if (text.includes("TODO(ts)")) debt["TODO(ts)"].push(at);
        if (text.includes("@ts-expect-error")) debt["@ts-expect-error"].push(at);
        if (/@ts-(ignore|nocheck)/.test(text)) forbidden.push(at);
      });
      debt.any += (source.match(/\bany\b/g) ?? []).length;
    }
  }
  console.log("debt in converted files:");
  console.log(`  TODO(ts) markers:  ${debt["TODO(ts)"].length}`);
  console.log(`  @ts-expect-error:  ${debt["@ts-expect-error"].length}`);
  console.log(`  \`any\` occurrences: ${debt.any} (indicative word count, includes comments)`);
  for (const list of [debt["TODO(ts)"], debt["@ts-expect-error"]]) {
    for (const at of list) console.log(`    ${at}`);
  }
  if (forbidden.length > 0) {
    console.log("\nFORBIDDEN suppressions (@ts-ignore / @ts-nocheck):");
    for (const at of forbidden) console.log(`  ${at}`);
    process.exit(1);
  }
}

// --- importers -------------------------------------------------------------

const IMPORTER_SCAN_ROOTS = ["src", "tests", "tools", "docs", "scripts", "skills"];

function importers(targets) {
  for (const target of targets) {
    const base = path.basename(target);
    const pattern = new RegExp(`(?<![\\w.-])${base.replace(/\./g, "\\.")}(?!\\w)`);
    console.log(`references to ${base}:`);
    const hits = [];
    const fixtureHits = [];
    const scan = (file, fixture) => {
      if (!TEXT_EXTENSIONS.has(path.extname(file))) return;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((text, index) => {
        if (!pattern.test(text)) return;
        const hit = `  ${rel(file)}:${index + 1}: ${text.trim().slice(0, 100)}`;
        (fixture ? fixtureHits : hits).push(hit);
      });
    };
    for (const root of IMPORTER_SCAN_ROOTS) {
      for (const { file, fixture } of walk(path.join(ROOT, root), { includeFixtures: true })) {
        if (file.startsWith(path.join(ROOT, "src", "platform", "web", "vendor"))) continue;
        scan(file, fixture);
      }
    }
    scan(path.join(ROOT, "package.json"), false);
    for (const hit of hits) console.log(hit);
    if (fixtureHits.length > 0) {
      console.log("  -- in fixtures/vendor (usually user-code models: do NOT rewrite blindly):");
      for (const hit of fixtureHits) console.log(hit);
    }
    if (hits.length === 0 && fixtureHits.length === 0) console.log("  (none found)");
    console.log("  note: studies/ is not scanned (out of scope; parts are frozen).");
    console.log("");
  }
}

// --- closure ---------------------------------------------------------------

const REFERENCE_PATTERNS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*[,)]/g,
  /\bnew\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url/g,
];

function closure(args) {
  const slice = new Set(args.map((file) => path.resolve(ROOT, file)));
  const blockers = [];
  for (const file of slice) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of REFERENCE_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
        const target = path.resolve(path.dirname(file), specifier.split(/[?#]/)[0]);
        if (!/\.(js|mjs)$/.test(target)) continue;
        if (slice.has(target)) continue;
        if (slice.has(target.replace(/\.js$/, ".ts")) || slice.has(target.replace(/\.mjs$/, ".mts"))) continue;
        if (!fs.existsSync(target)) continue; // already converted (or dangling; the repository test owns that)
        if (EMIT_DIRS.some((dir) => target.startsWith(dir + path.sep))) continue;
        blockers.push(`  ${rel(file)} -> ${specifier}`);
      }
    }
  }
  if (blockers.length === 0) {
    console.log("slice is import-closed: every relative dependency is converted, in the slice, or an emit-dir module");
  } else {
    console.log("slice is NOT import-closed; convert these dependencies in the same slice (strategy rule 6):");
    for (const blocker of [...new Set(blockers)].sort()) console.log(blocker);
    process.exit(1);
  }
}

// --- main ------------------------------------------------------------------

const [command, ...args] = process.argv.slice(2);
if (command === undefined) status();
else if (command === "importers" && args.length > 0) importers(args);
else if (command === "closure" && args.length > 0) closure(args);
else {
  console.error("usage: status.mjs | status.mjs importers <file>… | status.mjs closure <file>…");
  process.exit(2);
}
