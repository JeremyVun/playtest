import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(ROOT, "src");
const CORE = path.join(SRC, "core");
const CLI = path.join(SRC, "cli");
const VIEWER = path.join(SRC, "run-viewer");
const PLATFORM = path.join(SRC, "platform");
const CORE_PUBLIC = path.join(CORE, "public");

function javascriptFiles(root: LegacyTestValue) {
  const files: LegacyTestValue = [];
  const visit = (dir: LegacyTestValue) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".ts"))) files.push(file);
    }
  };
  visit(root);
  return files;
}

function relativeImports(file: LegacyTestValue) {
  const source = fs.readFileSync(file, "utf8");
  const imports = [];
  const pattern = /(?:from\s*|import\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]!.startsWith(".")) { // TODO(ts): regex capture group is required by the pattern
      const matchIndex = match.index;
      const statementStart = Math.max(
        source.lastIndexOf("import", matchIndex),
        source.lastIndexOf("export", matchIndex),
      );
      const typeOnly = /^import\s+type\b/.test(source.slice(statementStart, matchIndex));
      imports.push({ specifier: match[1], target: path.resolve(path.dirname(file), match[1]!), typeOnly }); // TODO(ts): regex capture group is required by the pattern
    }
  }
  return imports;
}

function within(file: LegacyTestValue, root: LegacyTestValue) {
  return file === root || file.startsWith(root + path.sep);
}

function violations(files: LegacyTestValue, check: LegacyTestValue) {
  const found = [];
  for (const file of files) {
    for (const dependency of relativeImports(file)) {
      if (dependency.typeOnly) continue;
      const reason = check(file, dependency.target);
      if (reason) {
        found.push(`${path.relative(ROOT, file)} imports ${dependency.specifier}: ${reason}`);
      }
    }
  }
  return found;
}

test("source dependencies point inward toward core, never across experience layers", () => {
  const coreViolations = violations(javascriptFiles(CORE), (_file: LegacyTestValue, target: LegacyTestValue) => {
    if (within(target, CLI) || within(target, VIEWER) || within(target, PLATFORM)) {
      return "core must not depend on an experience layer";
    }
    return null;
  });

  const cliViolations = violations(javascriptFiles(CLI), (_file: LegacyTestValue, target: LegacyTestValue) => {
    if (within(target, PLATFORM)) return "CLI must not depend on the hosted platform";
    if (within(target, CORE) && !within(target, CORE_PUBLIC)) {
      return "CLI must consume a supported core entry point";
    }
    return null;
  });

  const viewerViolations = violations(javascriptFiles(VIEWER), (_file: LegacyTestValue, target: LegacyTestValue) => {
    if (within(target, CLI) || within(target, PLATFORM)) {
      return "run viewer must not depend on an experience layer";
    }
    if (within(target, CORE) && !within(target, CORE_PUBLIC)) {
      return "run viewer must consume a supported core entry point";
    }
    return null;
  });

  const platformProduction = [
    ...javascriptFiles(path.join(PLATFORM, "control-plane", "src")),
    ...javascriptFiles(path.join(PLATFORM, "runner-agent", "src")),
    ...javascriptFiles(path.join(PLATFORM, "web")),
  ];
  assert.ok(
    platformProduction.some((file: LegacyTestValue) => file.endsWith(".ts")),
    "the platform boundary scan must include TypeScript sources",
  );
  const platformViolations = violations(platformProduction, (_file: LegacyTestValue, target: LegacyTestValue) => {
    if (within(target, CLI)) return "hosted platform must not depend on the CLI";
    if (within(target, CORE) && !within(target, CORE_PUBLIC)) {
      return "hosted platform must consume a supported core entry point";
    }
    return null;
  });

  assert.deepEqual(
    [...coreViolations, ...cliViolations, ...viewerViolations, ...platformViolations],
    [],
  );
});

test("package exports expose the supported core and viewer entry points", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    "./core/analysis",
    "./core/api-suite-scripts",
    "./core/artifacts",
    "./core/findings",
    "./core/llm",
    "./core/media",
    "./core/reporting",
    "./core/run",
    "./core/suite",
    "./package.json",
    "./run-viewer/node",
  ]);
});

test("public facades expose only their intentional named surface", async () => {
  const [analysis, artifacts, media, reporting] = await Promise.all([
    import("../../src/core/public/analysis.ts"),
    import("../../src/core/public/artifacts.ts"),
    import("../../src/core/public/media.ts"),
    import("../../src/core/public/reporting.ts"),
  ]);

  assert.deepEqual(Object.keys(analysis).sort(), ["extractAnomalies", "movement"]);
  assert.deepEqual(Object.keys(media).sort(), ["clip"]);
  assert.deepEqual(Object.keys(reporting).sort(), [
    "PHASE_DOING", "caseLine", "healDigest", "junitXml", "modeDoing", "summary",
  ]);
  assert.deepEqual(Object.keys(artifacts).sort(), [
    "BundleProvider",
    "EXPORT_FORMAT",
    "LocalFsProvider",
    "acceptBaseline",
    "actionOf",
    "actionTrack",
    "baselinePaths",
    "coreBundleKeepPath",
    "describeFindings",
    "diffTracks",
    "exportSpec",
    "findManifests",
    "findRunsRoot",
    "firstLine",
    "freshRunId",
    "isBundlePath",
    "latestRun",
    "manifestToHistoryEntry",
    "newRunId",
    "promoteHealed",
    "readBaseline",
    "readJsonFile",
    "rejectHealed",
    "rewriteBundle",
    "scanHistory",
    "scanRun",
    "specFilename",
    "writeBundle",
  ]);
});

test("product, tests, and studies do not depend on standalone examples", () => {
  const dependencyExtensions = new Set([".js", ".mjs", ".json", ".sh", ".yaml", ".yml"]);
  const files = [path.join(ROOT, "package.json")];
  const visit = (dir: LegacyTestValue) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && dependencyExtensions.has(path.extname(entry.name))) files.push(file);
    }
  };
  for (const root of [SRC, path.join(ROOT, "scripts"), path.join(ROOT, "studies"), path.join(ROOT, "tests")]) {
    visit(root);
  }

  const examplesPath = ["exam", "ples/"].join("");
  const violations = files
    .filter((file) => fs.readFileSync(file, "utf8").includes(examplesPath))
    .map((file) => path.relative(ROOT, file))
    .sort();

  assert.deepEqual(
    violations,
    [],
    "standalone examples must not be build, product, test, or study dependencies",
  );
});
