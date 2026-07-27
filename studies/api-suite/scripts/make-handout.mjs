#!/usr/bin/env node
// Assemble one trial's scratch directory (PREREGISTRATION.md §2).
//
// A trial agent gets exactly what this writes and nothing else — no repository,
// no fixture source, no study apparatus. The output is self-contained:
//
//   $S0_TRIAL_DIR/
//     BRIEF.md                  the authoring brief
//     PROPOSAL-BRIEF.md         the proposal trial's brief (--proposal only)
//     handout/openapi.json      the served OpenAPI document
//     handout/CLIENT.md         the script contract
//     handout/INVARIANTS.md     the invariant statements (omitted for phase 1
//                               of the proposal trial, and for --no-statements)
//     handout/obligations.json  the resolved obligation manifest — every id a
//                               check may name, derived exactly as the runner
//                               derives it
//     run.sh                    executable, self-contained
//     handout-manifest.json     what was assembled, with a sha256 per file
//
//   export LEDGER_BASE_URL=http://127.0.0.1:4180     # a live clean instance
//   export S0_TRIAL_DIR=/somewhere/outside/the/repo/t1
//   node studies/api-suite/scripts/make-handout.mjs
//   node studies/api-suite/scripts/make-handout.mjs --proposal      # phase 1
//   node studies/api-suite/scripts/make-handout.mjs --proposal --statements
//
// Other options: --base-url, --no-statements, --secrets-file <path>, and
// --invariants <file> (a development-round override for the statement set).
//
// The OpenAPI document is fetched live from `$LEDGER_BASE_URL/openapi.json`
// when a base URL is given — the document the trial actually talks to — and
// otherwise copied from `$LEDGER_FIXTURE_DIR/openapi.json`. The fixture is
// never named in this file: `studies/**` source may not mention the standalone
// examples tree (tests/repository/boundaries.test.js).

import fs from "node:fs";
import path from "node:path";

import {
  BRIEF_FILE,
  CLIENT_DOC_FILE,
  INVARIANTS_FILE,
  PROPOSAL_BRIEF_FILE,
  SCRIPTS_DIR,
  STUDY,
  argOf,
  flagOf,
  loadRules,
  loadSpec,
  sha256File,
  studyObligations,
} from "./lib/handout.mjs";

const die = (message) => {
  process.stderr.write(`make-handout: ${message}\n`);
  process.exit(2);
};

const trialDirArg = argOf("dir", process.env.S0_TRIAL_DIR ?? "");
if (!trialDirArg) die("no trial directory. Set S0_TRIAL_DIR, or pass --dir <path>.");
const trialDir = path.resolve(trialDirArg);

const proposal = flagOf("proposal");
const statements = flagOf("statements");
const noStatements = flagOf("no-statements") || (proposal && !statements);
const baseUrl = (argOf("base-url", process.env.LEDGER_BASE_URL ?? "") || "").replace(/\/+$/, "");
const fixtureDir = process.env.LEDGER_FIXTURE_DIR ? path.resolve(process.env.LEDGER_FIXTURE_DIR) : null;
const secretsFile = argOf("secrets-file", process.env.S0_SECRETS_FILE ?? "");
// A measured trial always gets the study's own statement set. The override
// exists for development rounds and harness dry runs, where the point is to
// exercise the machinery with a known rule vocabulary.
const invariantsFile = path.resolve(argOf("invariants", INVARIANTS_FILE));

const handoutDir = path.join(trialDir, "handout");
fs.mkdirSync(handoutDir, { recursive: true });

const written = [];
const write = (file, contents, mode) => {
  fs.writeFileSync(file, contents);
  if (mode !== undefined) fs.chmodSync(file, mode);
  written.push(file);
};

// ---- 1. the OpenAPI document -----------------------------------------------

let specSource;
const specFile = path.join(handoutDir, "openapi.json");
if (baseUrl) {
  let text;
  try {
    const response = await fetch(`${baseUrl}/openapi.json`);
    if (!response.ok) throw new Error(`GET ${baseUrl}/openapi.json answered ${response.status}`);
    text = await response.text();
  } catch (error) {
    die(
      `could not fetch the OpenAPI document from ${baseUrl}: ${String(error?.message ?? error)}\n` +
        "  Start a clean fixture instance first, or unset LEDGER_BASE_URL to copy it from LEDGER_FIXTURE_DIR.",
    );
  }
  // Normalized so the handout is byte-stable across fetches.
  write(specFile, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  specSource = `live: ${baseUrl}/openapi.json`;
} else if (fixtureDir && fs.existsSync(path.join(fixtureDir, "openapi.json"))) {
  write(specFile, `${JSON.stringify(JSON.parse(fs.readFileSync(path.join(fixtureDir, "openapi.json"), "utf8")), null, 2)}\n`);
  specSource = "$LEDGER_FIXTURE_DIR/openapi.json";
} else {
  die("no OpenAPI source. Set LEDGER_BASE_URL to a running instance, or LEDGER_FIXTURE_DIR to the fixture package root.");
}

// ---- 2. the contract, the statements, the brief -----------------------------

if (!fs.existsSync(CLIENT_DOC_FILE)) die(`the handout's client contract is missing: ${CLIENT_DOC_FILE}`);
write(path.join(handoutDir, "CLIENT.md"), fs.readFileSync(CLIENT_DOC_FILE));

let statementsIncluded = false;
if (!noStatements) {
  if (!fs.existsSync(invariantsFile)) {
    die(
      `no statement set at ${invariantsFile}.\n` +
        "  A statements-trial handout needs it (PREREGISTRATION.md §2.1). For the proposal trial's phase 1,\n" +
        "  pass --proposal (or --no-statements), which deliberately withholds it.",
    );
  }
  write(path.join(handoutDir, "INVARIANTS.md"), fs.readFileSync(invariantsFile));
  const sidecar = invariantsFile.replace(/\.md$/, ".rules.json");
  if (fs.existsSync(sidecar)) write(path.join(handoutDir, "INVARIANTS.rules.json"), fs.readFileSync(sidecar));
  statementsIncluded = true;
}

// BRIEF.md ships in both arms: the proposal brief's phase 2 is defined as
// "follow BRIEF.md end to end", so withholding it would break its own
// instructions. It carries no rule content.
write(path.join(trialDir, "BRIEF.md"), fs.readFileSync(BRIEF_FILE));
if (proposal) write(path.join(trialDir, "PROPOSAL-BRIEF.md"), fs.readFileSync(PROPOSAL_BRIEF_FILE));

// ---- 3. the resolved obligation manifest ------------------------------------

// Derived here with exactly the inputs trial-run.mjs will use, so the ids in
// the handout are the ids the run judges against. Without this file a trial
// would have to guess an id and spend an execution finding out.
const spec = loadSpec(specFile);
const { rules, source: rulesSource } = statementsIncluded ? loadRules(path.join(handoutDir, "INVARIANTS.md")) : { rules: [], source: null };
const obligations = studyObligations({ spec, rules });
write(
  path.join(handoutDir, "obligations.json"),
  `${JSON.stringify(
    {
      note: "Every obligation this run is judged against. A check's `obligation` must be one of these ids (handout/CLIENT.md §6).",
      total: obligations.length,
      obligations,
    },
    null,
    2,
  )}\n`,
);

// ---- 4. run.sh --------------------------------------------------------------

// Self-contained by construction: absolute paths to the interpreter and the
// wrapper, the base URL baked in, and no repository read on the trial's part.
// It carries no credential — only the path of a secrets file the wrapper reads
// in the parent process, outside the script sandbox.
const runner = path.join(SCRIPTS_DIR, "trial-run.mjs");
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const readOnlyDefault = proposal && !statements;
write(
  path.join(trialDir, "run.sh"),
  [
    "#!/bin/sh",
    "# Execute ./suite.mjs through the study's script runner.",
    "#",
    "#   ./run.sh              one execution against the target",
    "#   ./run.sh --read-only  observation pass: GET/HEAD only, smaller budget",
    "#",
    "# Artifacts land in ./run-out/ (script-report.json, har.json, stdout.log).",
    "# Exit 0 pass · 1 sound with a failing column · 2 unsound · 3 harness error.",
    "set -eu",
    'S0_TRIAL_DIR="$(cd "$(dirname "$0")" && pwd)"',
    `TRIAL_BASE_URL="\${TRIAL_BASE_URL:-${baseUrl || ""}}"`,
    "export S0_TRIAL_DIR TRIAL_BASE_URL",
    ...(secretsFile ? [`S0_SECRETS_FILE=${shellQuote(path.resolve(secretsFile))}`, "export S0_SECRETS_FILE"] : []),
    ...(readOnlyDefault ? ['S0_MODE="read-only"', "export S0_MODE"] : []),
    "",
    `exec ${shellQuote(process.execPath)} ${shellQuote(runner)} "$@"`,
    "",
  ].join("\n"),
  0o755,
);

// ---- 5. the manifest --------------------------------------------------------

const manifest = {
  generated_at: new Date().toISOString(),
  arm: proposal ? (statements ? "proposal-quality trial (phase 2)" : "proposal-quality trial (phase 1)") : "statements-trial",
  base_url: baseUrl || null,
  openapi_source: specSource,
  statements: statementsIncluded ? { source: rulesSource, rules: rules.length } : null,
  read_only_by_default: readOnlyDefault,
  budget: readOnlyDefault ? STUDY.observationBudget : STUDY.budget,
  timeout_ms: STUDY.timeoutMs,
  authoring_budget: STUDY.authoring,
  obligations: {
    total: obligations.length,
    policy: obligations.filter((entry) => entry.source === "policy").length,
    operation: obligations.filter((entry) => entry.source === "operation").length,
    rule: obligations.filter((entry) => entry.source === "rule").length,
  },
  files: written
    .map((file) => ({ path: path.relative(trialDir, file), sha256: sha256File(file), bytes: fs.statSync(file).size }))
    .sort((a, b) => a.path.localeCompare(b.path)),
};
const manifestFile = path.join(trialDir, "handout-manifest.json");
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(`handout assembled in ${trialDir}\n`);
process.stdout.write(`  arm          ${manifest.arm}\n`);
process.stdout.write(`  openapi      ${specSource}\n`);
process.stdout.write(`  statements   ${statementsIncluded ? `${rules.length} rule(s) from ${rulesSource}` : "withheld"}\n`);
process.stdout.write(
  `  obligations  ${manifest.obligations.total} (${manifest.obligations.policy} policy, ` +
    `${manifest.obligations.operation} operation, ${manifest.obligations.rule} rule)\n`,
);
process.stdout.write(`  budget       ${manifest.budget} requests${readOnlyDefault ? ", read-only by default" : ""}\n`);
for (const file of manifest.files) process.stdout.write(`  ${file.sha256.slice(0, 12)}  ${file.path}\n`);
process.stdout.write(`  ${sha256File(manifestFile).slice(0, 12)}  handout-manifest.json\n`);
