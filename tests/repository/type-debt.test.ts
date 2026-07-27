import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOTS = ["packages", "tests", "tools", "docs"];
const TEXT_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".md"]);
const DEBT_MARKER = "TODO" + "(ts)";

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "vendor") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(file));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(file))) out.push(file);
  }
  return out;
}

test("completed TypeScript migration debt labels do not return", () => {
  const hits = ROOTS.flatMap((root) => filesUnder(path.join(ROOT, root)))
    .filter((file) => fs.readFileSync(file, "utf8").includes(DEBT_MARKER))
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(hits, []);
});
