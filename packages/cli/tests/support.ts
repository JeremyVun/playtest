import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

const manifest = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
) as { bin: { playtest: string } };

export const CLI = path.resolve(PACKAGE_ROOT, manifest.bin.playtest);
