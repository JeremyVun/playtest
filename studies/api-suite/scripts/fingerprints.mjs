#!/usr/bin/env node
// Fingerprint the S0 substrate (PREREGISTRATION.md §3).
//
// "Exactly one execution substrate is selected and fingerprinted here before
// the first measured trial." This script produces that fingerprint: the
// checkout's commit, a sha256 of every file that can change a measured verdict,
// and one digest over the whole set. Its output is deterministic and sorted, so
// two runs on the same tree are byte-identical and a diff means the substrate
// moved.
//
//   export LEDGER_FIXTURE_DIR="$PWD/<the fixture named in studies/api-suite/README.md>"
//   node studies/api-suite/scripts/fingerprints.mjs            # paste-ready
//   node studies/api-suite/scripts/fingerprints.mjs --json     # machine-readable
//   node studies/api-suite/scripts/fingerprints.mjs --files    # digests only
//
// What it cannot know it does not invent: the actor model id, the decoding
// configuration, the retry policy, and the sealed-set commitment are printed as
// PLACEHOLDER rows for the orchestrator to fill at the freeze commit.
//
// The fixture is never named here: `studies/**` source may not mention the
// standalone examples tree (tests/repository/boundaries.test.js), so its files
// are located through $LEDGER_FIXTURE_DIR and reported under that name.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { INVARIANTS_FILE, REPO_ROOT, STUDY, STUDY_DIR, flagOf, sha256, sha256File } from "./lib/handout.mjs";

const FIXTURE_LABEL = "$LEDGER_FIXTURE_DIR";
const asJson = flagOf("json");
const filesOnly = flagOf("files");

const fixtureDir = process.env.LEDGER_FIXTURE_DIR ? path.resolve(process.env.LEDGER_FIXTURE_DIR) : null;

// ---- the file set -----------------------------------------------------------

const items = [];
const seen = new Set();
const add = (group, label, file) => {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return;
  const real = fs.realpathSync(file);
  if (seen.has(real)) return;
  seen.add(real);
  items.push({ group, path: label, sha256: sha256File(real), bytes: fs.statSync(real).size });
};

const listing = (dir, filter) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => filter(name))
        .sort()
        .map((name) => path.join(dir, name))
    : [];

const repoLabel = (file) => path.relative(REPO_ROOT, file);
const fixtureLabel = (file) => `${FIXTURE_LABEL}/${path.relative(fixtureDir, file)}`;

/**
 * The engine substrate: everything the supported facade reaches, transitively.
 * Following the facade's own imports rather than a hand-kept list is what keeps
 * this honest when the runner grows a dependency — the gate's invariant
 * policies and the spec loader are as much a part of a measured verdict as the
 * runner itself.
 */
function engineFiles(entry) {
  const found = [];
  const queue = [path.resolve(entry)];
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file) || !fs.existsSync(file)) continue;
    visited.add(file);
    found.push(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
      queue.push(path.resolve(path.dirname(file), match[1]));
    }
  }
  return found.sort();
}

const facade = path.join(REPO_ROOT, "packages/core/src/public/api-suite-scripts.ts");
for (const file of engineFiles(facade)) add("engine", repoLabel(file), file);
// child.js is spawned, not imported, so the import walk cannot see it.
for (const file of listing(path.join(REPO_ROOT, "packages/core/src/api-suite-scripts"), (name) => name.endsWith(".ts"))) {
  add("engine", repoLabel(file), file);
}
add("engine", "packages/core/src/schemas/script-report.schema.json", path.join(REPO_ROOT, "packages/core/src/schemas/script-report.schema.json"));
add("contract", "docs/contracts/scripts.md", path.join(REPO_ROOT, "docs/contracts/scripts.md"));

// PREREGISTRATION.md is deliberately NOT in the set. It is the document that
// records this fingerprint, so including it would make the recorded substrate
// digest wrong the instant it was pasted in, and re-running this script on the
// frozen tree could never reproduce it. The preregistration is pinned the only
// way a self-referential file can be: by the freeze commit's own SHA, recorded
// in §3 and in the tuning log.
for (const name of ["BRIEF.md", "PROPOSAL-BRIEF.md", "TARGET-AUTHORIZATION.md"]) {
  add("study", repoLabel(path.join(STUDY_DIR, name)), path.join(STUDY_DIR, name));
}
add("study", repoLabel(path.join(STUDY_DIR, "handout-src/CLIENT.md")), path.join(STUDY_DIR, "handout-src/CLIENT.md"));
add("statements", repoLabel(INVARIANTS_FILE), INVARIANTS_FILE);
add("statements", repoLabel(INVARIANTS_FILE.replace(/\.md$/, ".rules.json")), INVARIANTS_FILE.replace(/\.md$/, ".rules.json"));
for (const file of listing(path.join(STUDY_DIR, "scripts"), (name) => name.endsWith(".mjs"))) add("harness", repoLabel(file), file);
for (const file of listing(path.join(STUDY_DIR, "scripts/lib"), (name) => name.endsWith(".mjs"))) add("harness", repoLabel(file), file);

if (fixtureDir) {
  for (const name of ["server.js", "package.json", "openapi.json"]) add("fixture", fixtureLabel(path.join(fixtureDir, name)), path.join(fixtureDir, name));
  for (const file of listing(path.join(fixtureDir, "src"), (name) => name.endsWith(".js"))) add("fixture", fixtureLabel(file), file);
  for (const name of ["bench.js", "pins.js", "oracle-pins.json"]) add("bench", fixtureLabel(path.join(fixtureDir, "bench", name)), path.join(fixtureDir, "bench", name));
  for (const file of listing(path.join(fixtureDir, "bench/lib"), (name) => name.endsWith(".js"))) add("bench", fixtureLabel(file), file);
}

items.sort((a, b) => a.path.localeCompare(b.path));

// One digest over the whole substrate: the single line a reader can compare.
const digestBody = items.map((item) => `${item.sha256}  ${item.path}`).join("\n");
const substrateDigest = sha256(`${digestBody}\n`);

// ---- the checkout -----------------------------------------------------------

const git = (args, fallback) => {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
};
const commit = git(["rev-parse", "HEAD"], "(not a git checkout)");
const dirty = git(["status", "--porcelain"], "").length > 0;
const fixtureCommit = fixtureDir ? git(["log", "-1", "--format=%H", "--", path.relative(REPO_ROOT, fixtureDir)], "(unknown)") : null;

const pins = (group) => items.filter((item) => item.group === group);
const groupDigest = (group) => sha256(`${pins(group).map((item) => `${item.sha256}  ${item.path}`).join("\n")}\n`);

// ---- output -----------------------------------------------------------------

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        commit,
        dirty,
        fixture_commit: fixtureCommit,
        fixture_dir_set: Boolean(fixtureDir),
        substrate_digest: substrateDigest,
        group_digests: Object.fromEntries([...new Set(items.map((item) => item.group))].sort().map((group) => [group, groupDigest(group)])),
        configuration: {
          replay_budget: STUDY.budget,
          observation_budget: STUDY.observationBudget,
          timeout_ms: STUDY.timeoutMs,
          request_timeout_ms: STUDY.requestTimeoutMs,
          ledger_seed: STUDY.seed,
          replay_order_seed: process.env.REPLAY_ORDER_SEED ?? null,
          authoring: STUDY.authoring,
        },
        placeholders: ["actor model id and wire model", "decoding configuration", "retry policy", "sealed-set commitment"],
        files: items,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (filesOnly) {
  process.stdout.write(`${digestBody}\n`);
  process.exit(0);
}

const out = (text = "") => process.stdout.write(`${text}\n`);
const one = (group) => (pins(group).length === 1 ? pins(group)[0] : null);

out("--- paste into PREREGISTRATION.md §3 ---");
out("");
out(`checkout:           ${commit}${dirty ? "  (DIRTY — the freeze must be taken on a clean tree)" : ""}`);
out(`substrate digest:   ${substrateDigest}`);
out(`generated:          ${new Date().toISOString()} (this line is the only non-deterministic one)`);
out("");
out("| Component | Pin |");
out("|---|---|");
out(`| Runner (subprocess, timeout, outputs) | \`packages/core/src/api-suite-scripts/runner.ts\` @ \`${commit.slice(0, 7)}\` · sha256 \`${(items.find((item) => item.path.endsWith("api-suite-scripts/runner.ts"))?.sha256 ?? "—").slice(0, 16)}…\` |`);
out(`| Injected client (origin lock, budget, HAR, read-only) | \`packages/core/src/api-suite-scripts/{client,proxy,har}.ts\` · engine digest \`${groupDigest("engine").slice(0, 16)}…\` |`);
out(`| Suite report schema | S1's \`script_report_version: 1\` — \`packages/core/src/schemas/script-report.schema.json\` sha256 \`${(items.find((item) => item.path.endsWith("script-report.schema.json"))?.sha256 ?? "—").slice(0, 16)}…\` |`);
out(`| Script contract | \`docs/contracts/scripts.md\` sha256 \`${(items.find((item) => item.path.endsWith("contracts/scripts.md"))?.sha256 ?? "—").slice(0, 16)}…\` |`);
out(`| Authoring brief / handout template | \`studies/api-suite/BRIEF.md\` + \`handout-src/CLIENT.md\` · study digest \`${groupDigest("study").slice(0, 16)}…\` |`);
out(`| Proposal-trial prompt | \`studies/api-suite/PROPOSAL-BRIEF.md\` sha256 \`${(items.find((item) => item.path.endsWith("PROPOSAL-BRIEF.md"))?.sha256 ?? "—").slice(0, 16)}…\` |`);
out(`| Invariant statements (§2.1) | ${one("statements") ? `\`${one("statements").path}\` sha256 \`${one("statements").sha256}\`` : pins("statements").length ? `statements digest \`${groupDigest("statements")}\`` : "**PLACEHOLDER — INVARIANTS.md is not in the tree yet**"} |`);
out("| Actor model id and wire model | **PLACEHOLDER — the orchestrator fills this (e.g. `gpt5_5` → `gpt-5.5` via the local gateway)** |");
out("| Decoding configuration | **PLACEHOLDER — temperature / top-p / reasoning effort / max tokens** |");
out("| Retry policy | **PLACEHOLDER — client timeout, retries, backoff, what counts as retryable** |");
out(`| Trial harness | \`studies/api-suite/scripts/{make-handout,trial-run,replay-round,fingerprints}.mjs\` · harness digest \`${groupDigest("harness").slice(0, 16)}…\` |`);
out(`| Fixture | ${fixtureDir ? `\`${FIXTURE_LABEL}\` tree @ \`${String(fixtureCommit).slice(0, 7)}\` · fixture digest \`${groupDigest("fixture").slice(0, 16)}…\`` : "**LEDGER_FIXTURE_DIR is not set — re-run with it exported**"}; \`LEDGER_SEED=${STUDY.seed}\` |`);
out(`| Bench pins | ${fixtureDir ? `bench digest \`${groupDigest("bench").slice(0, 16)}…\` (verify with \`verify-instrument.mjs\`)` : "**LEDGER_FIXTURE_DIR is not set**"} |`);
out("| Recorder | runner-written HAR (`packages/core/src/api-suite-scripts/har.ts`); no external proxy |");
out("| Probe rematch instrument | P1 tree at `9059797`, plus the re-freeze SHA if a tuning round happens (§9.3) |");
out(`| Replay-order seed | ${process.env.REPLAY_ORDER_SEED ? `\`${process.env.REPLAY_ORDER_SEED}\`` : "**PLACEHOLDER — `$REPLAY_ORDER_SEED`, generated at freeze**"} |`);
out(`| Sealed set | **PLACEHOLDER — §4.2 commitment** |`);
out("");
out("Execution configuration (§7):");
out("");
out(`  replay budget         ${STUDY.budget} requests, wire-enforced`);
out(`  observation budget    ${STUDY.observationBudget} requests, read-only (§7.3)`);
out(`  execution timeout     ${STUDY.timeoutMs} ms per execution (§7.2)`);
out(`  per-request timeout   ${STUDY.requestTimeoutMs} ms`);
out(`  authoring             ≤ ${STUDY.authoring.executions} executions, ≤ ${STUDY.authoring.wallClockHours} h, ≤ ${STUDY.authoring.requests} requests`);
out(`  ledger seed           ${STUDY.seed}`);
out("");
out(`Substrate files (${items.length}), sorted; sha256 then path:`);
out("");
for (const item of items) out(`  ${item.sha256}  ${item.path}`);
out("");
out(`  substrate digest    ${substrateDigest}`);
out("     = sha256 over the lines above, each \"<sha256>  <path>\", newline-terminated");
out("");
out("----------------------------------------");
