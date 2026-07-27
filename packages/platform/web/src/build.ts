import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { LogLevel } from "esbuild";
import { runViewerAssetsDir } from "@playtest/run-viewer/assets";

function findPackageDir(start: string): string {
  let candidate = path.resolve(start);
  for (;;) {
    const manifest = path.join(candidate, "package.json");
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
      if (parsed.name === "@playtest/web") return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`cannot locate the @playtest/web package from ${start}`);
    }
    candidate = parent;
  }
}

const PACKAGE_DIR = findPackageDir(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIR = path.join(PACKAGE_DIR, "src");
const DEFAULT_BUILD_DIR = path.join(PACKAGE_DIR, "build");

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
    if (path.dirname(buildDir) !== PACKAGE_DIR || path.basename(buildDir) !== "build") {
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
  if (!fs.existsSync(path.join(runViewerAssetsDir, "index.html"))) {
    throw new Error(
      `run-viewer build is missing at ${runViewerAssetsDir}; run the ordered root build`,
    );
  }
  fs.cpSync(runViewerAssetsDir, path.join(buildDir, "viewer"), { recursive: true });

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
  await buildPlatformWeb();
}
