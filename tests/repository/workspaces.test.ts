import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACES = [
  "src/platform/control-plane",
  "src/platform/runner-agent",
  "src/platform/web",
];

const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

test("hosted components are private npm workspaces with one root lockfile", () => {
  const rootPackage = readJson("package.json");
  assert.deepEqual(rootPackage.workspaces, WORKSPACES);
  assert.equal(rootPackage.devDependencies.esbuild, undefined);

  for (const workspace of WORKSPACES) {
    const manifest = readJson(path.join(workspace, "package.json"));
    assert.equal(manifest.private, true, `${workspace} must not be published`);
    assert.equal(
      fs.existsSync(path.join(ROOT, workspace, "package-lock.json")),
      false,
      `${workspace} must use the root workspace lockfile`,
    );
  }

  const webPackage = readJson("src/platform/web/package.json");
  assert.equal(webPackage.devDependencies.esbuild, "^0.28.1");
  assert.equal(webPackage.scripts.build, "tsc -p tsconfig.json && node build.ts");

  for (const workspace of ["src/platform/control-plane", "src/platform/runner-agent"]) {
    assert.equal(readJson(path.join(workspace, "package.json")).dependencies.yaml, "^2.7.0");
  }

  const lock = readJson("package-lock.json");
  for (const workspace of WORKSPACES) {
    assert.ok(lock.packages[workspace], `${workspace} must be represented in the root lockfile`);
  }
});
