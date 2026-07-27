// Deterministic fault injector for the hill-climb study
// (docs/backlog/hillclimb-evidence.md). Copies the clean reference app into a
// per-arm directory and applies each catalog fault as a real code mutation.
//
//   node studies/hillclimb/inject-faults.mjs \
//     --subject studies/hillclimb/subject --faults studies/hillclimb/faults.json \
//     --out studies/hillclimb/arms/naive [--only f-id,f-id] [--list]
//
// Mutations are explicit edits ({file, find, replace}) recorded in the
// catalog itself, so every seeded defect is reviewable as a diff. The
// injector is strict: each `find` must occur EXACTLY ONCE in its file, every
// changed file must be named by the applied faults, and the resulting tree
// hash is written to <out>/.fault-set.json for bench/preflight.mjs to verify
// before every round. Rerunning is idempotent (the copy is rebuilt fresh).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage: node studies/hillclimb/inject-faults.mjs --subject <dir> --faults <faults.json> --out <dir> [--only <id,id>] [--list]

Copies <subject> to <out> and applies the catalog's faults as code mutations.
--only injects a subset (for manifestation tests); --list prints fault ids and exits.`;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--list") args.list = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  return args;
}

export function walkFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

export function hashTree(dir, { exclude = [".fault-set.json"] } = {}) {
  const h = createHash("sha256");
  for (const rel of walkFiles(dir)) {
    if (exclude.includes(rel)) continue;
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(path.join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

export function applyFault(outDir, fault) {
  const touched = new Set();
  const edits = fault.injection?.edits ?? [];
  if (edits.length === 0) throw new Error(`${fault.id}: catalog entry has no injection.edits`);
  for (const [i, edit] of edits.entries()) {
    const file = path.join(outDir, edit.file);
    if (!existsSync(file)) throw new Error(`${fault.id} edits[${i}]: no such file ${edit.file}`);
    const src = readFileSync(file, "utf8");
    const first = src.indexOf(edit.find);
    if (first === -1) throw new Error(`${fault.id} edits[${i}]: find-text not present in ${edit.file}`);
    if (src.indexOf(edit.find, first + 1) !== -1) throw new Error(`${fault.id} edits[${i}]: find-text ambiguous (matches more than once) in ${edit.file}`);
    if (edit.find === edit.replace) throw new Error(`${fault.id} edits[${i}]: find and replace are identical`);
    writeFileSync(file, src.slice(0, first) + edit.replace + src.slice(first + edit.find.length));
    touched.add(edit.file);
  }
  return touched;
}

export function inject({ subjectDir, faultsFile, outDir, only = null }) {
  const catalog = JSON.parse(readFileSync(faultsFile, "utf8"));
  const wanted = only ? new Set(only) : null;
  const faults = catalog.faults.filter((f) => !wanted || wanted.has(f.id));
  if (wanted) {
    for (const id of wanted) {
      if (!catalog.faults.some((f) => f.id === id)) throw new Error(`--only names unknown fault ${id}`);
    }
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.dirname(outDir), { recursive: true });
  cpSync(subjectDir, outDir, { recursive: true });

  const cleanHash = hashTree(outDir);
  const touched = new Set();
  for (const fault of faults) {
    for (const file of applyFault(outDir, fault)) touched.add(file);
  }

  // Byte accounting: every changed file must be named by an applied fault's edits.
  const declared = new Set(faults.flatMap((f) => f.injection.edits.map((e) => e.file)));
  for (const rel of walkFiles(subjectDir)) {
    const before = readFileSync(path.join(subjectDir, rel));
    const after = readFileSync(path.join(outDir, rel));
    const changed = !before.equals(after);
    if (changed && !declared.has(rel)) throw new Error(`byte-accounting: ${rel} changed but no applied fault declares it`);
    if (!changed && touched.has(rel)) throw new Error(`byte-accounting: ${rel} declared touched but is byte-identical`);
  }

  const manifest = {
    ids: faults.map((f) => f.id).sort(),
    app_hash: hashTree(outDir),
    clean_hash: cleanHash,
    subject: path.relative(process.cwd(), subjectDir),
    injected_at: new Date().toISOString(),
  };
  writeFileSync(path.join(outDir, ".fault-set.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.list) {
    const catalog = JSON.parse(readFileSync(args.faults ?? "studies/hillclimb/faults.json", "utf8"));
    for (const f of catalog.faults) console.log(`${f.id}\t${f.level}\t${f.class}\t${f.surface}`);
    return;
  }
  for (const k of ["subject", "faults", "out"]) {
    if (!args[k]) {
      console.error(`missing --${k}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
  }
  const manifest = inject({
    subjectDir: args.subject,
    faultsFile: args.faults,
    outDir: args.out,
    only: args.only ? args.only.split(",").map((s) => s.trim()).filter(Boolean) : null,
  });
  console.log(`${args.out}: injected ${manifest.ids.length} faults (app_hash ${manifest.app_hash.slice(0, 12)}…)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`inject-faults: ${err.message}`);
    process.exit(1);
  });
}
