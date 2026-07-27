#!/usr/bin/env node
// Replay one suite artifact against every build of a round, and score it.
//
// One invocation = one arm (a trial's suite) against a whole round: the
// canonical clean build, every conforming-variant build, the jittered clean
// repeats, and every fault build — visited in a **seeded random order** written
// down before the first build runs (PREREGISTRATION.md §8).
//
//   node studies/api-suite/scripts/replay-round.mjs \
//     --suite trials/t1/suite/run.mjs \
//     --round studies/api-suite/rounds/heldout-1 \
//     --arm t1 --seed "$REPLAY_ORDER_SEED" \
//     --faults-from ~/round/faults.txt
//
// It owns the fixture lifecycle so no arm has to be trusted with isolation: a
// dedicated instance per build on a private port, `LEDGER_FAULTS` /
// `LEDGER_VARIANT` / `LEDGER_JITTER_MS` set per build, a seeded
// `POST /admin/reset` immediately before the suite starts, teardown after. The
// manifest is append-only, so an interrupted round resumes at the next unrun
// build instead of restarting.
//
// Per build it writes a bench-readable run directory:
//
//   <round>/builds/<id>/har.json            the recorded traffic
//   <round>/builds/<id>/script-report.json  the S1 report (--recorder runner)
//   <round>/builds/<id>/suite-report.json   a v0 report (--recorder proxy), if the arm wrote one
//   <round>/builds/<id>/bench-meta.json     { label, arm, wall_ms } — the bench sidecar
//   <round>/builds/<id>/suite.log           the suite's own stdout/stderr
//   <round>/builds/<id>/fixture.log         the fixture instance's output
//
// and finally scores every one of them with the bench in a single pass, so both
// columns and the funnel come out of one command.
//
// Environment. The fixture is never named in this file: `studies/**` source may
// not mention the standalone examples tree
// (`tests/repository/boundaries.test.js`), and neither may anything this script
// writes into a `.json` file — so no absolute paths go into the sidecars.
//
//   LEDGER_FIXTURE_DIR   required; the fixture package root
//   LEDGER_FIXTURE       the fixture entry script (default <dir>/server.js)
//   LEDGER_BENCH         the bench CLI          (default <dir>/bench/bench.js)
//   LEDGER_SEED          reset seed             (default ledger-dev-seed)
//   LEDGER_ADMIN_TOKEN   admin bearer token     (default admin-token-dev)
//   LEDGER_CUSTOMER_TOKEN, LEDGER_CUSTOMER_B_TOKEN
//                        the two customer principals' bearer tokens; both are
//                        declared to every replay, as they were to the trial
//   PLAYTEST_SECRET_*    an explicit override for any declared reference
//   HAR_PROXY            a wire-recording proxy, for --recorder proxy
//
// Two recorders, and the choice is about the ARM's shape, not the round's:
//
//   --recorder runner  (default) the S1 script substrate, in process, through
//                      `@playtest/core/api-suite-scripts` → `runScript`. This is the
//                      pinned interface for every S0 script-contract arm: the
//                      runner records the HAR, enforces the 360-request budget
//                      at the wire, injects credentials by name, and writes
//                      `script-report.json` (`script_report_version: 1`) — one
//                      of the two report shapes the bench reads.
//   --recorder proxy   the P1 agent-suite v0 shape, unchanged: the suite is a
//                      plain process talking to `$HAR_PROXY`, which counts
//                      requests at the wire, and writes a
//                      `playtest.suite-report/v0` report if it can. Kept for
//                      the legacy-shape arms — the P1 comparator and the probe
//                      artifacts — so the two studies stay comparable.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runScript } from "@playtest/core/api-suite-scripts";
import { STUDY, INVARIANTS_FILE, loadRules, loadSpec, resolveStudySecrets, secretNamesFrom, writeGrantFor } from "./lib/handout.mjs";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const list = (value) => String(value ?? "").split(/[,\s]+/).filter(Boolean);

const die = (message, code = 2) => {
  process.stderr.write(`replay-round: ${message}\n`);
  process.exit(code);
};

// ---- configuration ---------------------------------------------------------

const fixtureDir = process.env.LEDGER_FIXTURE_DIR;
if (!fixtureDir) {
  die(
    "LEDGER_FIXTURE_DIR is not set. It must point at the ledger fixture package root:\n" +
      '  export LEDGER_FIXTURE_DIR="$PWD/<the fixture directory named in studies/api-suite/README.md>"',
  );
}
const FIXTURE_DIR = path.resolve(fixtureDir);
const FIXTURE = path.resolve(process.env.LEDGER_FIXTURE ?? path.join(FIXTURE_DIR, "server.js"));
const BENCH = path.resolve(process.env.LEDGER_BENCH ?? path.join(FIXTURE_DIR, "bench", "bench.js"));
for (const [what, file] of [["fixture entry script", FIXTURE], ["bench CLI", BENCH]]) {
  if (!fs.existsSync(file)) die(`no such ${what}: ${file}`);
}

const suite = arg("suite");
const roundDir = arg("round");
if (!suite || !roundDir) {
  die("usage: replay-round.mjs --suite <entry> --round <dir> [--arm <name>] [--seed <n>] [--faults <ids>|--faults-from <file>]");
}
if (!fs.existsSync(suite)) die(`no such suite entry: ${suite}`);

const arm = arg("arm", "suite");
const seed = arg("seed", process.env.REPLAY_ORDER_SEED ?? "");
if (!seed) {
  die("--seed (or REPLAY_ORDER_SEED) is required: the replay order is randomized and the seed is preregistered");
}
const recorder = arg("recorder", "runner");
if (recorder !== "runner" && recorder !== "proxy") die(`unknown --recorder ${recorder} (expected "runner" or "proxy")`);
const fixturePort = Number(arg("port", "4184"));
const proxyPort = Number(arg("proxy-port", "4194"));
const maxRequests = arg("max-requests", "360");
const seedValue = process.env.LEDGER_SEED ?? "ledger-dev-seed";
const adminToken = process.env.LEDGER_ADMIN_TOKEN ?? "admin-token-dev";

// The runner's judgement inputs: the same spec and the same approved statements
// every trial authored against, so a replay is judged by the manifest the
// author was given. `--no-spec` drops the spec-driven policies and the
// operation obligations, which is only ever right for a legacy-shape arm.
const specFile = arg("spec", path.join(FIXTURE_DIR, "openapi.json"));
const statementsFile = arg("statements", INVARIANTS_FILE);
let runnerSpec = null;
let runnerRules = [];
if (recorder === "runner") {
  if (!flag("no-spec")) {
    if (!fs.existsSync(specFile)) die(`no OpenAPI document at ${specFile} (pass --spec <file> or --no-spec)`);
    try {
      runnerSpec = loadSpec(specFile);
    } catch (error) {
      die(String(error?.message ?? error));
    }
  }
  runnerRules = loadRules(statementsFile).rules;
}
// A replay declares exactly the credentials the trial authored against — the
// admin principal and both customer principals — so a suite that reached
// another principal's account while authoring can still reach it here
// (lib/handout.mjs → STUDY_SECRETS).
resolveStudySecrets();
const runnerSecrets = secretNamesFrom();

const cleanRepeats = Number(arg("clean-repeats", "3"));
const jitterRepeats = Number(arg("jitter-repeats", "10"));
const jitterMs = Number(arg("jitter-ms", "250"));
const variants = list(arg("variants", "terse-optionals,trailing-page,wide-ids"));
const combined = !flag("no-combined-variant");
const faultsFrom = arg("faults-from");
const faults = faultsFrom
  ? fs
      .readFileSync(faultsFrom, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  : list(arg("faults", ""));

// ---- the build plan --------------------------------------------------------

/** mulberry32 over an FNV-1a seed hash: the same deterministic PRNG the fixture uses. */
function makeRng(text) {
  let h = 0x811c9dc5;
  for (let index = 0; index < String(text).length; index++) {
    h ^= String(text).charCodeAt(index);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with a seeded PRNG. */
function shuffle(items, rng) {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const swap = Math.floor(rng() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

const builds = [];
for (let repeat = 1; repeat <= cleanRepeats; repeat++) {
  builds.push({ id: `clean-${repeat}`, label: "clean", faults: [], variants: [], jitterMs: 0 });
}
for (const variant of variants) {
  builds.push({ id: `clean.${variant}`, label: `clean.${variant}`, faults: [], variants: [variant], jitterMs: 0 });
}
if (combined && variants.length > 1) {
  builds.push({ id: "clean.all-variants", label: "clean.all-variants", faults: [], variants, jitterMs: 0 });
}
for (let repeat = 1; repeat <= jitterRepeats; repeat++) {
  builds.push({ id: `clean.jitter-${repeat}`, label: "clean.jitter", faults: [], variants: [], jitterMs });
}
for (const fault of faults) {
  builds.push({ id: fault, label: fault, faults: [fault], variants: [], jitterMs: 0 });
}

// The whole plan is shuffled together — fault builds interleaved with clean and
// variant builds — so a drifting environment cannot systematically favour one
// kind of build over another.
const ordered = shuffle(builds, makeRng(seed));

const buildsDir = path.join(roundDir, "builds");
fs.mkdirSync(buildsDir, { recursive: true });
const manifestFile = path.join(roundDir, "manifest.jsonl");
const orderFile = path.join(roundDir, `order.${arm}.json`);

// Recorded before the first build runs, and never rewritten: the order is part
// of the round's evidence. No filesystem paths go in here (see the header).
if (!fs.existsSync(orderFile)) {
  fs.writeFileSync(
    orderFile,
    `${JSON.stringify(
      {
        arm,
        seed,
        recorded_at: new Date().toISOString(),
        recorder,
        max_requests: Number(maxRequests),
        jitter_ms: jitterMs,
        order: ordered.map((build) => ({ id: build.id, label: build.label })),
      },
      null,
      2,
    )}\n`,
  );
}

const already = new Set(
  fs.existsSync(manifestFile)
    ? fs
        .readFileSync(manifestFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.arm === arm && row.status === "ok")
        .map((row) => row.id)
    : [],
);

if (flag("dry-run")) {
  process.stdout.write(`arm ${arm}, seed ${seed}, recorder ${recorder}\n`);
  for (const build of ordered) {
    process.stdout.write(
      `  ${already.has(build.id) ? "done" : "todo"}  ${build.id}  faults=${build.faults.join("|") || "-"}  ` +
        `variants=${build.variants.join("|") || "-"}  jitter=${build.jitterMs}\n`,
    );
  }
  process.exit(0);
}

// ---- fixture lifecycle -----------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealthy(url, tries = 100) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

function startFixture(build, logFile) {
  const env = { ...process.env, PORT: String(fixturePort), LEDGER_SEED: seedValue };
  if (build.faults.length) env.LEDGER_FAULTS = build.faults.join(",");
  else delete env.LEDGER_FAULTS;
  if (build.variants.length) env.LEDGER_VARIANT = build.variants.join(",");
  else delete env.LEDGER_VARIANT;
  env.LEDGER_JITTER_MS = String(build.jitterMs);

  const child = spawn(process.execPath, [FIXTURE], { env, stdio: ["ignore", "pipe", "pipe"] });
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  return child;
}

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, options);
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ code: -1, output: `${output}\nspawn failed: ${error.message}` }));
    child.on("close", (code) => resolve({ code, output }));
  });

async function seededReset(baseUrl) {
  const response = await fetch(`${baseUrl}/admin/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ seed: seedValue }),
  });
  if (!response.ok) throw new Error(`seeded reset failed with ${response.status}`);
}

/**
 * `--recorder runner`: the S1 script substrate, in process.
 *
 * The runner owns everything a replay must not be trusted with — the HAR, the
 * wire-enforced budget, the origin lock, credential injection by name, the gate
 * column, the obligation accounting — and writes `har.json` and
 * `script-report.json` into the build directory, which is exactly what the
 * bench auto-detects in a run directory.
 *
 * A thrown error here is a configuration or harness failure (the caller records
 * it as an infrastructure failure, §8.3). A suite that throws, hangs, or blows
 * its budget is NOT an error: it comes back as a report full of defects and a
 * non-zero exit, which is a trial result (§8.4).
 */
async function runWithRunner(buildDir, baseUrl) {
  const result = await runScript({
    where: `replay ${arm}`,
    script: path.resolve(suite),
    target: {
      base_url: baseUrl,
      allowed_origins: [],
      write_grant: writeGrantFor(baseUrl),
    },
    secrets: runnerSecrets,
    spec: runnerSpec,
    rules: runnerRules,
    params: { seed: seedValue },
    budget: Number(maxRequests),
    timeout_ms: STUDY.timeoutMs,
    request_timeout_ms: STUDY.requestTimeoutMs,
    out_dir: buildDir,
  });
  const report = result.report;
  return {
    code: result.exitCode,
    output:
      `${result.stdout}\n---- stderr ----\n${result.stderr}\n---- verdict ----\n` +
      `requests=${report.run.budget.used} checks=${report.checks.length} ` +
      `failing=${report.verdict.failing_checks.length} defects=${report.defects.length} ` +
      `unaccounted=${report.obligations.summary.unaccounted} gate=${report.verdict.gate_pass ? "pass" : "FAIL"} ` +
      `sound=${report.soundness.ok} exit=${result.exitCode}\n`,
  };
}

/**
 * `--recorder proxy`: the P1 agent-suite v0 shape. The suite talks to a
 * recording proxy that counts requests at the wire and stops forwarding at the
 * budget, so the budget is enforced rather than trusted.
 */
async function runWithProxy(buildDir, baseUrl, build) {
  const harProxy = process.env.HAR_PROXY;
  if (!harProxy || !fs.existsSync(harProxy)) {
    die(
      "HAR_PROXY must point at a wire-recording proxy for --recorder proxy.\n" +
        "  P1's recorder is the reference implementation; see studies/api-probe/comparators/.",
    );
  }
  const har = path.join(buildDir, "har.json");
  const proxy = spawn(
    process.execPath,
    [
      harProxy,
      "--target",
      baseUrl,
      "--port",
      String(proxyPort),
      "--out",
      har,
      "--label",
      build.label,
      "--max-requests",
      String(maxRequests),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proxy.stderr.pipe(fs.createWriteStream(path.join(buildDir, "proxy.log"), { flags: "a" }));
  if (!(await waitHealthy(`http://127.0.0.1:${proxyPort}/__proxy_health`, 60))) {
    proxy.kill("SIGTERM");
    return { code: -1, output: "the recording proxy did not come up" };
  }
  const outcome = await run(process.execPath, [path.resolve(suite)], {
    env: {
      ...process.env,
      BASE_URL: `http://127.0.0.1:${proxyPort}`,
      SEED: seedValue,
      MAX_REQUESTS: String(maxRequests),
      // A v0 suite writes its structured report here; one that cannot simply
      // does not, and the bench scores it on the oracle column alone.
      SUITE_REPORT_OUT: path.join(buildDir, "suite-report.json"),
    },
  });
  proxy.kill("SIGTERM");
  await sleep(500);
  return outcome;
}

// ---- the round -------------------------------------------------------------

const baseUrl = `http://127.0.0.1:${fixturePort}`;
const started = Date.now();
let failures = 0;

for (const build of ordered) {
  if (already.has(build.id)) {
    process.stdout.write(`skip  ${build.id} (already recorded for arm ${arm})\n`);
    continue;
  }
  const buildDir = path.join(buildsDir, `${arm}.${build.id}`);
  fs.mkdirSync(buildDir, { recursive: true });
  const fixture = startFixture(build, path.join(buildDir, "fixture.log"));

  let row;
  const buildStarted = Date.now();
  try {
    if (!(await waitHealthy(`${baseUrl}/health`))) throw new Error("the fixture did not become healthy");
    await seededReset(baseUrl);
    process.stdout.write(`run   ${build.id} …`);
    const outcome =
      recorder === "runner" ? await runWithRunner(buildDir, baseUrl) : await runWithProxy(buildDir, baseUrl, build);
    fs.writeFileSync(path.join(buildDir, "suite.log"), outcome.output);

    const har = path.join(buildDir, "har.json");
    if (!fs.existsSync(har)) throw new Error("no har.json was recorded — nothing to score");
    const requests = JSON.parse(fs.readFileSync(har, "utf8")).log?.entries?.length ?? null;
    const wallMs = Date.now() - buildStarted;

    // The bench sidecar. Deliberately carries no filesystem path.
    fs.writeFileSync(
      path.join(buildDir, "bench-meta.json"),
      `${JSON.stringify({ label: build.label, arm, id: `${arm}.${build.id}`, wall_ms: wallMs }, null, 2)}\n`,
    );
    row = {
      arm,
      id: build.id,
      label: build.label,
      status: "ok",
      exit: outcome.code,
      requests,
      wall_ms: wallMs,
      report:
        fs.existsSync(path.join(buildDir, "script-report.json")) || fs.existsSync(path.join(buildDir, "suite-report.json")),
      at: new Date().toISOString(),
    };
    process.stdout.write(` ${requests} requests, exit ${outcome.code}, ${(wallMs / 1000).toFixed(1)}s\n`);
  } catch (error) {
    failures += 1;
    // An infrastructure failure, per PREREGISTRATION.md §8.3: recorded with its
    // cause, never silently dropped. Re-run the build (the manifest resumes).
    row = {
      arm,
      id: build.id,
      label: build.label,
      status: "infra",
      cause: String(error.message ?? error),
      wall_ms: Date.now() - buildStarted,
      at: new Date().toISOString(),
    };
    process.stdout.write(`\nINFRA ${build.id}: ${row.cause}\n`);
  } finally {
    fixture.kill("SIGTERM");
    await sleep(300);
  }
  fs.appendFileSync(manifestFile, `${JSON.stringify(row)}\n`);
}

// ---- score -----------------------------------------------------------------

const scores = path.join(roundDir, `scores.${arm}.json`);
const scored = await run(process.execPath, [BENCH, "--out", scores, buildsDir], { cwd: process.cwd() });
fs.writeFileSync(path.join(roundDir, `scores.${arm}.txt`), scored.output);
process.stdout.write(`\n${scored.output}\n`);
process.stdout.write(
  `round ${path.basename(roundDir)} arm ${arm}: ${ordered.length} build(s), ${failures} infrastructure failure(s), ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s\n`,
);
process.stdout.write(`  order:   ${path.relative(process.cwd(), orderFile)}\n`);
process.stdout.write(`  builds:  ${path.relative(process.cwd(), manifestFile)}\n`);
process.stdout.write(`  scores:  ${path.relative(process.cwd(), scores)}\n`);
process.exit(failures > 0 ? 1 : scored.code === 0 ? 0 : 1);
