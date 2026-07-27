import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACES = [
  "packages/core",
  "packages/cli",
  "packages/run-viewer",
  "packages/platform/control-plane",
  "packages/platform/runner-agent",
  "packages/platform/web",
];
const NAMES = [
  "@playtest/core",
  "@playtest/cli",
  "@playtest/run-viewer",
  "@playtest/control-plane",
  "@playtest/runner-agent",
  "@playtest/web",
];

const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

test("the private root orchestrates exactly six private workspaces", () => {
  const root = readJson("package.json");
  assert.equal(root.name, "playtest-monorepo");
  assert.equal(root.private, true);
  assert.deepEqual(root.workspaces, [
    "packages/core",
    "packages/cli",
    "packages/run-viewer",
    "packages/platform/*",
  ]);
  for (const forbidden of ["bin", "exports", "dependencies", "optionalDependencies"]) {
    assert.equal(root[forbidden], undefined, `root must not own ${forbidden}`);
  }

  const manifests = WORKSPACES.map((workspace) => readJson(`${workspace}/package.json`));
  assert.deepEqual(manifests.map((manifest) => manifest.name), NAMES);
  for (const [index, manifest] of manifests.entries()) {
    assert.equal(manifest.private, true, `${WORKSPACES[index]} must be private`);
    assert.equal(manifest.engines.node, ">=24.18.0");
    assert.equal(
      fs.existsSync(path.join(ROOT, WORKSPACES[index]!, "package-lock.json")),
      false,
      `${WORKSPACES[index]} must use the root lockfile`,
    );
  }
});

test("one root lockfile links every first-party workspace", () => {
  const nested = fs
    .readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "package-lock.json")
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`));
  assert.deepEqual(nested, [path.join(ROOT, "package-lock.json")]);

  const lock = readJson("package-lock.json");
  for (const workspace of WORKSPACES) {
    assert.ok(lock.packages[workspace], `${workspace} must appear in the root lockfile`);
  }
});
