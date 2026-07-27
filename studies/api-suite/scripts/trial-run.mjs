#!/usr/bin/env node
// Execute one trial's suite through the S1 script runner, under the study's
// configuration (PREREGISTRATION.md §3, §7).
//
// This is what `$S0_TRIAL_DIR/run.sh` invokes. The trial agent runs `./run.sh`
// from inside its scratch directory and never reads a repository file: the
// generated wrapper carries the absolute path of this script and the target
// base URL, and everything else is derived from the handout beside it.
//
//   node studies/api-suite/scripts/trial-run.mjs [--dir <trial dir>] [--read-only]
//
// Configuration, all preregistered:
//
//   script            $S0_TRIAL_DIR/suite.mjs
//   target            base_url = $TRIAL_BASE_URL, no allowed_origins — the
//                     fixture's own origin and nothing else
//   write_grant       studies/api-suite/TARGET-AUTHORIZATION.md, naming the
//                     origin this run resolved (omitted in --read-only)
//   secrets           the study's three declared credentials — the admin
//                     principal and BOTH customer principals — resolved from
//                     $S0_SECRETS_FILE, the environment, or the fixture's
//                     published defaults, plus any other PLAYTEST_SECRET_<NAME>
//                     the environment already carries
//   spec              $S0_TRIAL_DIR/handout/openapi.json
//   rules             $S0_TRIAL_DIR/handout/INVARIANTS.md (absent in the
//                     proposal trial's phase 1)
//   budget            360 requests, wire-enforced (60 in --read-only)
//   timeout_ms        the study's per-execution ceiling
//   out_dir           $S0_TRIAL_DIR/run-out
//
// Exit status is the runner's: 0 pass · 1 sound with a failing column ·
// 2 unsound · 3 a harness or configuration failure (never a trial result).
//
// Environment:
//   S0_TRIAL_DIR      the scratch directory (default: --dir, else cwd)
//   TRIAL_BASE_URL    the target base URL (LEDGER_BASE_URL is also accepted)
//   S0_SECRETS_FILE   optional; NAME=value lines loaded into the environment
//   S0_MODE           "read-only" is the same as --read-only

import fs from "node:fs";
import path from "node:path";

import { runScript } from "../../../src/core/public/api-suite-scripts.js";
import { STUDY, STUDY_SECRETS, argOf, flagOf, loadRules, loadSecretsFile, loadSpec, resolveStudySecrets, secretNamesFrom, writeGrantFor } from "./lib/handout.mjs";

const die = (message) => {
  process.stderr.write(`trial-run: ${message}\n`);
  process.exit(3);
};

const trialDir = path.resolve(argOf("dir", process.env.S0_TRIAL_DIR ?? process.cwd()));
const readOnly = flagOf("read-only") || process.env.S0_MODE === "read-only";
const asJson = flagOf("json");

const baseUrl = argOf("base-url", process.env.TRIAL_BASE_URL ?? process.env.LEDGER_BASE_URL ?? "");
if (!baseUrl) {
  die("no target base URL. Set TRIAL_BASE_URL (or pass --base-url http://127.0.0.1:<port>).");
}

const scriptPath = path.resolve(argOf("script", path.join(trialDir, "suite.mjs")));
if (!fs.existsSync(scriptPath)) {
  die(
    `no suite at ${scriptPath}.\n` +
      "  Write suite.mjs in your scratch directory, default-exporting the entry function (handout/CLIENT.md §1).",
  );
}

const handoutDir = path.join(trialDir, "handout");
const specFile = path.join(handoutDir, "openapi.json");
if (!fs.existsSync(specFile)) die(`no OpenAPI document at ${specFile} — re-assemble the handout with make-handout.mjs`);

const outDir = path.resolve(argOf("out", path.join(trialDir, "run-out")));

let spec;
try {
  spec = loadSpec(specFile);
} catch (error) {
  die(String(error?.message ?? error));
}

// The proposal trial's phase 1 has no statements, so it has no rule
// obligations — only the policy set and the spec's operations.
const { rules, source: rulesSource } = readOnly ? { rules: [], source: null } : loadRules(path.join(handoutDir, "INVARIANTS.md"));

try {
  loadSecretsFile(process.env.S0_SECRETS_FILE ?? null);
} catch (error) {
  die(String(error?.message ?? error));
}
// The secrets file, where one exists, wins; anything it did not supply falls
// back to the environment and then to the fixture's published defaults. All
// three declared references exist after this, which is what keeps the
// authorization category reachable (lib/handout.mjs → STUDY_SECRETS).
resolveStudySecrets();
const secrets = secretNamesFrom();
const missing = STUDY_SECRETS.filter((secret) => !secrets.includes(secret.name)).map((secret) => secret.name);
if (missing.length) die(`the study's declared credential(s) ${missing.join(", ")} could not be resolved`);

const budget = Number(argOf("budget", readOnly ? STUDY.observationBudget : STUDY.budget));

let result;
try {
  result = await runScript({
    where: "S0 trial run",
    script: scriptPath,
    target: {
      base_url: baseUrl,
      // No allowed_origins: the fixture's own origin is the whole allowance.
      allowed_origins: [],
      // Read-only carries no grant at all, which is what makes the observation
      // pass's refusals real rather than advisory.
      ...(readOnly ? {} : { write_grant: writeGrantFor(baseUrl) }),
    },
    secrets,
    spec,
    rules,
    params: { seed: STUDY.seed },
    budget,
    timeout_ms: STUDY.timeoutMs,
    request_timeout_ms: STUDY.requestTimeoutMs,
    out_dir: outDir,
  });
} catch (error) {
  // DummyConfigError and friends: actionable, no stack.
  die(String(error?.message ?? error));
}

const { report } = result;
fs.writeFileSync(path.join(outDir, "stdout.log"), `${result.stdout}\n---- stderr ----\n${result.stderr}\n`);

if (asJson) {
  process.stdout.write(`${JSON.stringify({ exit_code: result.exitCode, verdict: report.verdict, obligations: report.obligations.summary }, null, 2)}\n`);
  process.exit(result.exitCode);
}

const failing = report.checks.filter((check) => !check.pass);
const line = (text) => process.stdout.write(`${text}\n`);

line("");
line(`mode          ${report.run.mode}${readOnly ? "  (observation pass — soundness is not the goal)" : ""}`);
line(`target        ${report.run.base_url}`);
line(`requests      ${report.run.budget.used} of ${report.run.budget.limit}   (${(report.run.duration_ms / 1000).toFixed(1)}s)`);
line(`checks        ${report.checks.length} — ${report.checks.length - failing.length} passing, ${failing.length} failing`);
line(
  `obligations   ${report.obligations.summary.covered} covered, ${report.obligations.summary.skipped} skipped, ` +
    `${report.obligations.summary.unsupported} unsupported, ${report.obligations.summary.unaccounted} UNACCOUNTED ` +
    `(of ${report.obligations.summary.total})`,
);
line(`gate          ${report.gate.pass ? "pass" : "FAIL"} — ${report.gate.checks.filter((check) => check.applicable).length} of ${report.gate.checks.length} policies applicable`);
line(`defects       ${report.defects.length}`);
if (rulesSource) line(`statements    ${rules.length} rule(s) from handout/${rulesSource}`);
line(`secrets       ${secrets.length ? secrets.join(", ") : "(none declared)"}`);

if (failing.length) {
  line("");
  line("failing checks");
  for (const check of failing.slice(0, 25)) {
    line(`  ✗ ${check.id} [${check.obligation}]`);
    line(`      ${check.title}`);
    if (check.expected !== undefined) line(`      expected: ${String(check.expected).slice(0, 200)}`);
    if (check.observed !== undefined) line(`      observed: ${String(check.observed).slice(0, 200)}`);
    line(`      evidence: har entries ${check.evidence.har_entries.join(", ") || "(none cited)"}`);
  }
  if (failing.length > 25) line(`  … and ${failing.length - 25} more`);
}

if (report.defects.length) {
  line("");
  line("defects (these make the run unsound — they are about the suite, not the API)");
  for (const defect of report.defects.slice(0, 25)) line(`  ! ${defect.kind}: ${defect.message}`);
  if (report.defects.length > 25) line(`  … and ${report.defects.length - 25} more`);
}

if (report.guard.length) {
  line("");
  line("guard refusals (refused at the wire; no request was made)");
  for (const event of report.guard.slice(0, 25)) line(`  ! ${event.code}: ${event.request}`);
  if (report.guard.length > 25) line(`  … and ${report.guard.length - 25} more`);
}

const unaccounted = report.obligations.entries.filter((entry) => entry.status === "unaccounted");
// The observation pass exists to look, not to prove: its obligations are
// expected to be unaccounted, so listing all of them would be noise pretending
// to be a to-do list.
if (readOnly) {
  line("");
  line(`(observation pass: ${unaccounted.length} obligation(s) unaccounted, as expected — soundness is not scored here)`);
} else {
  if (unaccounted.length) {
    line("");
    line("unaccounted obligations (cover each with an exercised check, or skip it with an approved reason)");
    for (const entry of unaccounted.slice(0, 40)) line(`  · ${entry.id}${entry.reason ? ` — ${entry.reason}` : ""}`);
    if (unaccounted.length > 40) line(`  … and ${unaccounted.length - 40} more`);
  }
  if (!report.soundness.ok) {
    line("");
    line(`UNSOUND — ${report.soundness.reasons.length} reason(s); the first few:`);
    for (const reason of report.soundness.reasons.slice(0, 5)) line(`  · ${reason}`);
  }
}

if (!report.gate.pass && report.soundness.ok) {
  line("");
  line("the HAR column failed. It is machinery you do not author — a policy the recorded traffic");
  line("violated, which may be a genuine finding about the API or a consequence of a request you");
  line("chose to make. Read gate.checks in the report; it is not a defect and it does not make the");
  line("run unsound. Your termination condition is soundness, not exit 0.");
  for (const check of report.gate.checks.filter((entry) => !entry.pass)) {
    line(`  ✗ ${check.policy}: ${check.detail}`);
    line(`      evidence: har entries ${check.har_entries.join(", ") || "(none)"}`);
  }
}

line("");
line(
  `verdict       ${report.verdict.pass ? "PASS" : report.verdict.sound ? "FAIL (sound)" : "UNSOUND"}` +
    `   exit ${result.exitCode}`,
);
line(`artifacts     ${path.relative(trialDir, path.join(outDir, "script-report.json"))}, ${path.relative(trialDir, path.join(outDir, "har.json"))}`);
line("");

process.exit(result.exitCode);
