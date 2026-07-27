import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACES = {
  "@playtest/core": "packages/core",
  "@playtest/cli": "packages/cli",
  "@playtest/run-viewer": "packages/run-viewer",
  "@playtest/control-plane": "packages/platform/control-plane",
  "@playtest/runner-agent": "packages/platform/runner-agent",
  "@playtest/web": "packages/platform/web",
} as const;
const ALLOWED_PRODUCTION_EDGES: Record<string, string[]> = {
  "@playtest/core": [],
  "@playtest/cli": ["@playtest/core", "@playtest/run-viewer"],
  "@playtest/run-viewer": ["@playtest/core"],
  "@playtest/control-plane": ["@playtest/core", "@playtest/web"],
  "@playtest/runner-agent": ["@playtest/core"],
  "@playtest/web": ["@playtest/core", "@playtest/run-viewer"],
};
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const EXCLUDED = new Set(["node_modules", "build", ".test-build", "vendor", "fixtures"]);

const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

function sourceFiles(root: string) {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || EXCLUDED.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(file);
    }
  };
  visit(root);
  return files;
}

function imports(file: string) {
  const source = fs.readFileSync(file, "utf8");
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^;]*?\sfrom\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"'\n]+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const before = match.index === 0 ? "" : source[match.index - 1];
      if (before === "`" || before === "'" || before === '"' || before === "/") continue;
      found.push(match[1]!);
    }
  }
  return [...new Set(found)];
}

function packageName(specifier: string) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0]!;
}

test("relative imports never cross workspace boundaries, including type-only imports", () => {
  const roots = Object.fromEntries(
    Object.entries(WORKSPACES).map(([name, dir]) => [name, path.join(ROOT, dir)]),
  );
  const violations: string[] = [];
  for (const [owner, workspace] of Object.entries(roots)) {
    for (const file of sourceFiles(workspace)) {
      for (const specifier of imports(file).filter((value) => value.startsWith("."))) {
        const target = path.resolve(path.dirname(file), specifier);
        const targetOwner = Object.entries(roots).find(
          ([, root]) => target === root || target.startsWith(root + path.sep),
        )?.[0];
        if (targetOwner && targetOwner !== owner) {
          violations.push(`${path.relative(ROOT, file)} -> ${specifier} (${targetOwner})`);
        }
      }
    }
  }
  assert.deepEqual(violations.sort(), []);
});

test("every package import is declared by the importing workspace", () => {
  const violations: string[] = [];
  for (const [owner, workspace] of Object.entries(WORKSPACES)) {
    const manifest = readJson(`${workspace}/package.json`);
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    for (const file of sourceFiles(path.join(ROOT, workspace))) {
      for (const specifier of imports(file)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        const dependency = packageName(specifier);
        if (!declared.has(dependency)) {
          violations.push(`${owner}: ${path.relative(ROOT, file)} imports undeclared ${dependency}`);
        }
      }
    }
  }
  assert.deepEqual(violations.sort(), []);
});

test("the first-party production graph has only approved edges and no cycles", () => {
  const graph: Record<string, Set<string>> = {};
  const violations: string[] = [];
  for (const [owner, workspace] of Object.entries(WORKSPACES)) {
    graph[owner] = new Set();
    for (const file of sourceFiles(path.join(ROOT, workspace, "src"))) {
      for (const specifier of imports(file)) {
        const dependency = packageName(specifier);
        if (!(dependency in WORKSPACES)) continue;
        graph[owner].add(dependency);
        if (!ALLOWED_PRODUCTION_EDGES[owner]!.includes(dependency)) {
          violations.push(`${owner} -> ${dependency} from ${path.relative(ROOT, file)}`);
        }
      }
    }
  }
  assert.deepEqual(violations.sort(), []);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string, stack: string[]) => {
    if (visiting.has(name)) throw new Error(`workspace cycle: ${[...stack, name].join(" -> ")}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph[name] ?? []) visit(dependency, [...stack, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(graph)) visit(name, []);
});

test("package exports expose only intentional entry points", () => {
  assert.deepEqual(Object.keys(readJson("packages/core/package.json").exports).sort(), [
    "./analysis",
    "./api-suite-scripts",
    "./artifacts",
    "./browser/movement",
    "./browser/timing",
    "./findings",
    "./llm",
    "./media",
    "./package.json",
    "./reporting",
    "./run",
    "./suite",
    "./testing",
  ]);
  assert.deepEqual(Object.keys(readJson("packages/run-viewer/package.json").exports).sort(), [
    "./assets",
    "./browser",
    "./node",
    "./package.json",
  ]);
  assert.deepEqual(Object.keys(readJson("packages/platform/web/package.json").exports).sort(), [
    "./assets",
    "./package.json",
  ]);
  for (const workspace of [
    "packages/cli",
    "packages/platform/control-plane",
    "packages/platform/runner-agent",
  ]) {
    assert.equal(readJson(`${workspace}/package.json`).exports, undefined);
  }
});

test("production resource locators stay inside their owning workspace", () => {
  const violations: string[] = [];
  const pattern = /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g;
  for (const workspace of Object.values(WORKSPACES)) {
    const root = path.join(ROOT, workspace);
    for (const file of sourceFiles(path.join(root, "src"))) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const target = path.resolve(path.dirname(file), match[1]!);
        if (target !== root && !target.startsWith(root + path.sep)) {
          violations.push(`${path.relative(ROOT, file)} resolves ${match[1]} outside its package`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("product and repository tests do not depend on standalone examples", () => {
  const roots = [
    ...Object.values(WORKSPACES).map((workspace) => path.join(ROOT, workspace)),
    path.join(ROOT, "tests"),
    path.join(ROOT, "scripts"),
  ];
  const examplesPath = ["exam", "ples/"].join("");
  const violations = roots
    .flatMap(sourceFiles)
    .filter((file) => fs.readFileSync(file, "utf8").includes(examplesPath))
    .map((file) => path.relative(ROOT, file))
    .sort();
  assert.deepEqual(violations, []);
});
