import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { LogLevel } from "esbuild";

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const DEFAULT_BUILD_DIR = path.resolve(SOURCE_DIR, "../../build");

export async function buildRunViewer({
  buildDir = DEFAULT_BUILD_DIR,
  logLevel = "info",
}: {
  buildDir?: string;
  logLevel?: LogLevel;
} = {}) {
  const isDefaultBuild = path.resolve(buildDir) === DEFAULT_BUILD_DIR;
  if (isDefaultBuild) {
    if (path.basename(buildDir) !== "build" || path.dirname(buildDir) !== path.resolve(SOURCE_DIR, "../..")) {
      throw new Error(`refusing to clean unexpected run-viewer build directory: ${buildDir}`);
    }
    fs.rmSync(buildDir, { recursive: true, force: true });
  } else if (fs.existsSync(buildDir)) {
    throw new Error(`refusing to replace custom run-viewer build directory: ${buildDir}`);
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
    logLevel,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRunViewer();
}
