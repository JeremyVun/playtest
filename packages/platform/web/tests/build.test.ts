import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPlatformWeb } from "../src/build.js";

test("platform web build emits one debuggable application bundle", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-platform-web-"));
  const buildDir = path.join(tempRoot, "build");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  await buildPlatformWeb({ buildDir, logLevel: "silent" });

  assert.deepEqual(fs.readdirSync(buildDir).sort(), [
    "app.js",
    "app.js.map",
    "index.html",
    "style.css",
    "viewer",
  ]);
  assert.deepEqual(fs.readdirSync(path.join(buildDir, "viewer")).sort(), [
    "app.js",
    "app.js.map",
    "index.html",
    "style.css",
  ]);

  const html = fs.readFileSync(path.join(buildDir, "index.html"), "utf8");
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);

  const bundle = fs.readFileSync(path.join(buildDir, "app.js"), "utf8");
  assert.ok(bundle.length > 100_000, "bundle should contain the application, not only its entry");
  assert.ok(bundle.length < 500_000, "unexpected bundle-size regression");
  assert.doesNotMatch(bundle, /\/api\/v1\/view\/shared\//);
  assert.match(bundle, /sourceMappingURL=app\.js\.map/);
  assert.doesNotMatch(bundle, /from\s*["']\.\/(?:lib|pages)\//);
});
