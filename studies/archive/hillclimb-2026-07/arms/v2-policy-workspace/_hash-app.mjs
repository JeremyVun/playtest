// Run: node studies/hillclimb/arms/v2-policy-workspace/_hash-app.mjs
// Recomputes v2-policy app_hash (inject-faults hashTree) and node --checks sources.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const workspace = fileURLToPath(new URL(".", import.meta.url));
const appDir = fileURLToPath(new URL("../v2-policy", import.meta.url));

function walkTree(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTree(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

function hashDir(dir) {
  const exclude = new Set([".fault-set.json"]);
  const hash = createHash("sha256");
  for (const rel of walkTree(dir)) {
    if (exclude.has(rel)) continue;
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(dir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

for (const f of ["server.js", "pages.js", "data.js"]) {
  const r = spawnSync(process.execPath, ["--check", join(appDir, f)], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`node --check ${f} failed:\n${r.stderr || r.stdout}`);
    process.exit(r.status || 1);
  }
  console.log(`node --check ${f}: ok`);
}

const app_hash = hashDir(appDir);
console.log("app_hash:", app_hash);
console.log("app_hash_prefix:", app_hash.slice(0, 12));

const faultPath = join(appDir, ".fault-set.json");
const prev = JSON.parse(readFileSync(faultPath, "utf8"));
prev.app_hash = app_hash;
writeFileSync(faultPath, JSON.stringify(prev, null, 2) + "\n");
writeFileSync(join(workspace, "_hash-out.txt"), app_hash + "\n");
console.log("updated", faultPath);
