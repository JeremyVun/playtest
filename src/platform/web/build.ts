import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { LogLevel } from "esbuild";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUILD_DIR = path.join(SOURCE_DIR, "build");

export async function buildPlatformWeb({
  buildDir = DEFAULT_BUILD_DIR,
  logLevel = "info",
}: {
  buildDir?: string;
  logLevel?: LogLevel;
} = {}) {
  const isDefaultBuild = buildDir === DEFAULT_BUILD_DIR;
  // The command-line build is the only directory this script replaces. Tests
  // may supply a new temporary directory, but never an existing custom target.
  if (isDefaultBuild) {
    if (path.dirname(buildDir) !== SOURCE_DIR || path.basename(buildDir) !== "build") {
      throw new Error(`refusing to clean unexpected platform web build directory: ${buildDir}`);
    }
    fs.rmSync(buildDir, { recursive: true, force: true });
  } else if (fs.existsSync(buildDir)) {
    throw new Error(`refusing to replace custom platform web build directory: ${buildDir}`);
  }
  fs.mkdirSync(buildDir, { recursive: true });

  for (const asset of ["index.html", "style.css"]) {
    fs.copyFileSync(path.join(SOURCE_DIR, asset), path.join(buildDir, asset));
  }

  await build({
    entryPoints: [path.join(SOURCE_DIR, "app.ts")],
    outfile: path.join(buildDir, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: "linked",
    legalComments: "eof",
    external: ["/api/v1/view/shared/movement.js"],
    logLevel,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPlatformWeb();
}
