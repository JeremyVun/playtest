import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testBuildDir = path.join(packageDir, ".test-build");
const action = process.argv[2];

if (path.dirname(testBuildDir) !== packageDir || path.basename(testBuildDir) !== ".test-build") {
  throw new Error(`refusing to prepare unexpected test build directory: ${testBuildDir}`);
}

if (action === "clean") {
  fs.rmSync(testBuildDir, { recursive: true, force: true });
} else if (action === "assets") {
  fs.cpSync(path.join(packageDir, "src", "vendor"), path.join(testBuildDir, "src", "vendor"), {
    recursive: true,
  });
} else {
  throw new Error('usage: node tests/prepare-test-build.ts <clean|assets>');
}
