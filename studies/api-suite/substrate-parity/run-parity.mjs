#!/usr/bin/env node
// Substrate parity: does the S1 script runner distort the P1 instrument?
//
// The BUILD_PLAN S1 exit gate asks for one thing that cannot be a unit test:
// the P1 agent-suite scenarios, ported to the script contract, executed through
// the new runner against the ledger fixture, with the bench scoring the
// resulting HAR the way it scored P1's. Same scenarios, same builds, same
// oracles — only the substrate underneath changed.
//
//   export LEDGER_FIXTURE=<ledger fixture>/server.js
//   export LEDGER_BENCH=<ledger fixture>/bench/bench.js
//   node studies/api-suite/substrate-parity/run-parity.mjs [--build <id>]…
//
// The fixture and bench paths come from the environment because a study source
// file may not name the standalone fixture tree (tests/repository/boundaries.test.js).
//
// Outputs, under ./out/:
//   comparators/agent-suite-<build>.har        the traffic the bench scores
//   comparators/agent-suite-<build>.meta.json  its bench sidecar
//   reports/<build>.script-report.json         the substrate's own report column
//   bench.json                                 the bench's full result
//   parity.json                                this run vs the recorded P1 result
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScript } from "@playtest/core/api-suite-scripts";
import { resetSecrets } from "@playtest/core/testing";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SUITE = path.join(HERE, "suite/index.mjs");
const OUT = path.join(HERE, "out");
// The recorded P1 comparator scores for the agent-suite arm: the number this
// run has to reproduce. Read from the frozen study, never modified.
const P1_SCORES = path.join(ROOT, "studies/api-probe/rounds/heldout-1/scores-comparators.json");

const FIXTURE = process.env.LEDGER_FIXTURE;
const BENCH = process.env.LEDGER_BENCH;
const PORT = Number(process.env.PARITY_PORT ?? 4187);
const SEED = process.env.LEDGER_SEED ?? "ledger-dev-seed";
const BUDGET = Number(process.env.PARITY_BUDGET ?? 360);
const SUITE_MAX = Number(process.env.PARITY_SUITE_MAX ?? 350);
const CUSTOMER_TOKEN = process.env.LEDGER_CUSTOMER_TOKEN ?? "Bearer customer-token-dev";
const ADMIN_TOKEN = process.env.LEDGER_ADMIN_TOKEN ?? "Bearer admin-token-dev";

// The P1 held-out round, in its order. `clean` is the false-positive control.
const DEFAULT_BUILDS = [
  "clean",
  "f-cursor-error-bare",
  "f-close-pending-inbound",
  "f-settle-failed-debit",
  "f-idempotency-day-expiry",
  "f-fee-double-charged",
];

if (!FIXTURE || !BENCH) {
  console.error("set LEDGER_FIXTURE to the ledger fixture's server.js and LEDGER_BENCH to its bench.js");
  process.exit(2);
}

const argBuilds = [];
for (let index = 0; index < process.argv.length; index++) {
  if (process.argv[index] === "--build") argBuilds.push(process.argv[index + 1]);
}
const builds = argBuilds.length ? argBuilds : DEFAULT_BUILDS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = `http://127.0.0.1:${PORT}`;

async function waitHealthy(tries = 80) {
  for (let index = 0; index < tries; index++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

function startFixture(build, logFile) {
  const env = { ...process.env, PORT: String(PORT) };
  if (build !== "clean") env.LEDGER_FAULTS = build;
  const child = spawn("node", [FIXTURE], { env, stdio: ["ignore", "pipe", "pipe"] });
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  return child;
}

/** Out-of-band seeded reset, exactly as the P1 comparator harness did. */
async function reset() {
  const response = await fetch(`${BASE}/admin/reset`, {
    method: "POST",
    headers: { authorization: ADMIN_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ seed: SEED }),
  });
  if (!response.ok) throw new Error(`seeded reset failed: ${response.status}`);
}

const RULES = [
  { id: "conservation", statement: "the ledger entries of a settled transfer sum to zero" },
  { id: "idempotency", statement: "one Idempotency-Key produces at most one ledger effect" },
  { id: "lifecycle", statement: "an operation illegal for an account's state is refused and writes nothing" },
  { id: "pagination", statement: "walking a cursor enumeration returns each id at most once and terminates" },
  { id: "errorshape", statement: "every refusal is a 4xx carrying the documented error envelope; no operation answers 5xx" },
  { id: "balance", statement: "an account's stored balance equals the sum of its ledger entries" },
  { id: "contract", statement: "a refusal the OpenAPI document documents actually happens" },
];

async function runBuild(build) {
  const outDir = path.join(OUT, "runs", build);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(OUT, "comparators"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "reports"), { recursive: true });

  const fixture = startFixture(build, path.join(outDir, "fixture.log"));
  try {
    if (!(await waitHealthy())) throw new Error(`the fixture never became healthy on ${BASE}`);
    await reset();

    process.env.PLAYTEST_SECRET_LEDGER_CUSTOMER_TOKEN = CUSTOMER_TOKEN;
    process.env.PLAYTEST_SECRET_LEDGER_ADMIN_TOKEN = ADMIN_TOKEN;
    const startedAt = Date.now();
    const result = await runScript({
      script: SUITE,
      target: {
        base_url: BASE,
        // The suite creates accounts, transfers and deposits: this is the
        // recorded target authorization for a disposable local fixture.
        write_grant: { origin: BASE, approved_by: "substrate-parity (local disposable fixture)", approved_at: new Date().toISOString() },
      },
      secrets: ["LEDGER_CUSTOMER_TOKEN", "LEDGER_ADMIN_TOKEN"],
      rules: RULES,
      params: { seed: SEED, maxRequests: SUITE_MAX },
      budget: BUDGET,
      timeout_ms: 600000,
      out_dir: outDir,
    });
    const wallMs = Date.now() - startedAt;

    const har = path.join(OUT, "comparators", `agent-suite-${build}.har`);
    fs.copyFileSync(path.join(outDir, "har.json"), har);
    fs.copyFileSync(path.join(outDir, "script-report.json"), path.join(OUT, "reports", `${build}.script-report.json`));
    fs.writeFileSync(
      `${har.replace(/\.har$/, "")}.meta.json`,
      JSON.stringify({ label: build, arm: "agent-suite-ported", wall_ms: wallMs, substrate: "playtest script runner (S1)" }, null, 2) + "\n",
    );
    fs.writeFileSync(path.join(outDir, "stdout.log"), `${result.stdout}\n---- stderr ----\n${result.stderr}\n`);

    const report = result.report;
    console.log(
      `${build.padEnd(26)} requests=${String(report.run.budget.used).padStart(3)} ` +
        `checks=${report.checks.length} failing=${report.verdict.failing_checks.length} ` +
        `defects=${report.defects.length} gate=${report.verdict.gate_pass ? "pass" : "FAIL"} ` +
        `sound=${report.soundness.ok} exit=${result.exitCode} ${(wallMs / 1000).toFixed(2)}s`,
    );
    if (report.defects.length) for (const defect of report.defects) console.log(`    defect(${defect.kind}) ${defect.message}`);
    return {
      build,
      requests: report.run.budget.used,
      checks: report.checks.length,
      failing: report.verdict.failing_checks,
      defects: report.defects.map((defect) => `${defect.kind}: ${defect.message}`),
      unaccounted: report.obligations.summary.unaccounted,
      sound: report.soundness.ok,
      exit_code: result.exitCode,
      wall_ms: wallMs,
    };
  } finally {
    fixture.kill("SIGTERM");
    await sleep(200);
    resetSecrets();
  }
}

function runBench(args_) {
  return new Promise((resolve) => {
    const args = [BENCH, "--json", ...args_];
    const child = spawn("node", args, { cwd: ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** The agent-suite arm's recorded P1 result, per label. */
function p1Reference() {
  const scores = JSON.parse(fs.readFileSync(P1_SCORES, "utf8"));
  const byLabel = {};
  for (const trace of scores.traces ?? []) {
    if (trace.arm !== "agent-suite") continue;
    byLabel[trace.label] = {
      detected: trace.detected,
      evidence_correct: trace.evidence_correct,
      false_positives: trace.false_positives,
      off_target_violations: trace.off_target_violations,
      requests: trace.requests,
      oracles: [...new Set((trace.violations ?? []).map((violation) => violation.oracle))].sort(),
    };
  }
  return byLabel;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`substrate parity — ${builds.length} build(s) through the S1 script runner\n`);

  const runs = [];
  for (const build of builds) runs.push(await runBuild(build));

  // The bench reads both columns: the HAR, and the S1 script report beside it.
  const args = [];
  for (const build of builds) {
    args.push("--report", `${build}=${path.join(OUT, "reports", `${build}.script-report.json`)}`);
  }
  for (const build of builds) args.push(`${build}=${path.join(OUT, "comparators", `agent-suite-${build}.har`)}`);
  const bench = await runBench(args);
  // Exit 1 is the bench's HEADLINE, not a failure: it means some labelled fault
  // went undetected, which is exactly what P1 recorded for two of these builds.
  // Only a usage/IO failure (2) or unparsable output is a problem here.
  let scored;
  try {
    scored = JSON.parse(bench.out);
  } catch {
    console.error(`bench failed (${bench.code}):\n${bench.err || bench.out}`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT, "bench.json"), JSON.stringify(scored, null, 2) + "\n");

  const reference = p1Reference();
  const rows = [];
  for (const trace of scored.traces ?? []) {
    const p1 = reference[trace.label] ?? null;
    const oracles = [...new Set((trace.violations ?? []).map((violation) => violation.oracle))].sort();
    rows.push({
      build: trace.label,
      requests: trace.requests,
      detected: trace.detected,
      evidence_correct: trace.evidence_correct,
      false_positives: trace.false_positives,
      off_target_violations: trace.off_target_violations,
      oracles,
      reported: trace.reported ?? null,
      reported_evidence_correct: trace.reported_evidence_correct ?? null,
      p1,
      matches_p1: p1
        ? p1.detected === trace.detected &&
          p1.evidence_correct === trace.evidence_correct &&
          p1.false_positives === trace.false_positives &&
          p1.off_target_violations === trace.off_target_violations &&
          JSON.stringify(p1.oracles) === JSON.stringify(oracles)
        : null,
    });
  }

  console.log("\nbuild                      requests  detected  evidence  fp  oracles                 vs P1");
  for (const row of rows) {
    console.log(
      `${row.build.padEnd(26)} ${String(row.requests).padStart(8)}  ${String(row.detected).padStart(8)}  ` +
        `${String(row.evidence_correct).padStart(8)}  ${String(row.false_positives).padStart(2)}  ` +
        `${(row.oracles.join(",") || "—").padEnd(22)}  ${row.p1 === null ? "n/a" : row.matches_p1 ? "MATCH" : "DIFFERS"}`,
    );
  }
  const compared = rows.filter((row) => row.p1 !== null);
  const mismatched = compared.filter((row) => !row.matches_p1);
  const parity = {
    generated_at: new Date().toISOString(),
    substrate: "playtest script runner (S1)",
    budget: BUDGET,
    suite_max_requests: SUITE_MAX,
    builds: rows,
    runs,
    compared: compared.length,
    mismatched: mismatched.map((row) => row.build),
    parity: mismatched.length === 0,
  };
  fs.writeFileSync(path.join(OUT, "parity.json"), JSON.stringify(parity, null, 2) + "\n");
  console.log(
    `\nparity: ${mismatched.length === 0 ? "MATCH" : `DIFFERS on ${mismatched.map((row) => row.build).join(", ")}`}` +
      ` (${compared.length} labelled build(s) compared against the recorded P1 agent-suite result)`,
  );
  process.exit(mismatched.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(2);
});
