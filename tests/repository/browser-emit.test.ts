import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EMIT_DIRS = [
  "packages/run-viewer/build",
  "packages/platform/web/build",
  "packages/platform/web/.test-build",
];
const JAVASCRIPT_ALLOWLIST = [
  // Vendored browser dependency: frozen and intentionally excluded from TypeScript.
  "packages/platform/web/src/vendor/",
  // User-authored script fixtures pin plain-JavaScript plugin support.
  "packages/platform/runner-agent/tests/fixtures/script-attacks/",
  "tests/fixtures/authoring-api/drafts/",
  "tests/fixtures/script-suites/",
  // Hosted fixtures executed as external seed/build scripts.
  "packages/platform/control-plane/tests/fixtures/hosted-todos/seed/reset.mjs",
  "packages/platform/control-plane/tests/fixtures/storage-baseline/build-expectations.mjs",
];

test("browser emit directories contain no tracked generated JavaScript", () => {
  const tracked = execFileSync("git", ["ls-files", "--", ...EMIT_DIRS], {
    cwd: ROOT,
    encoding: "utf8",
  }).split("\n").filter(Boolean);

  const generated = tracked.filter((file) =>
    file.endsWith(".js"));

  assert.deepEqual(generated, []);
});

test("maintained first-party source and tests contain no JavaScript", () => {
  const tracked = execFileSync("git", ["ls-files", "--", "packages", "tests"], {
    cwd: ROOT,
    encoding: "utf8",
  }).split("\n").filter(Boolean);

  const unexpected = tracked.filter((file) =>
    /\.(?:m?js)$/.test(file)
    && !JAVASCRIPT_ALLOWLIST.some((allowed) =>
      allowed.endsWith("/") ? file.startsWith(allowed) : file === allowed));

  assert.deepEqual(unexpected, []);
});
