import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "vite";
import viteConfig from "../vite.config.js";

test("platform web build emits one debuggable application bundle", async (t) => {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-platform-web-"));
  const buildDir = path.join(tempRoot, "build");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  await build({
    ...viteConfig,
    configFile: false,
    logLevel: "silent",
    root: path.join(packageDir, "src"),
    build: {
      ...viteConfig.build,
      outDir: buildDir,
      emptyOutDir: false,
    },
  });

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
  assert.match(html, /<script type="module"[^>]* src="\/app\.js"><\/script>/);

  const bundle = fs.readFileSync(path.join(buildDir, "app.js"), "utf8");
  assert.ok(bundle.length > 100_000, "bundle should contain the application, not only its entry");
  assert.ok(bundle.length < 500_000, "unexpected bundle-size regression");
  assert.doesNotMatch(bundle, /\/api\/v1\/view\/shared\//);
  assert.match(bundle, /waiting for a runner to connect/);
  assert.doesNotMatch(bundle, /GitHub is scheduling/);
  assert.match(bundle, /Retry this run\?/);
  assert.match(bundle, /sourceMappingURL=app\.js\.map/);
  assert.doesNotMatch(bundle, /from\s*["']\.\/(?:lib|pages)\//);
});
