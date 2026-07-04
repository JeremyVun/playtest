#!/usr/bin/env node
// `playtest` command wiring. See docs/CONTRACTS.md §12.
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { discoverCases, DummyConfigError } from "./config.js";
import { lintCase } from "./lint.js";
import { fileURLToPath } from "node:url";
import {
  freshRunId,
  readBaseline,
  baselinePaths,
  acceptBaseline,
  promoteHealed,
  rejectHealed,
  firstLine,
} from "./trajectory.js";
import { runAll, willRecord } from "./runner.js";
import { caseLine, summary, healDigest } from "./report.js";
import { LiveReporter, GradeSpinner } from "./live.js";
import { gradeRun } from "./grader.js";
import { llmConfig, missingLlmConfigMessage } from "./llm.js";
import { serveRun, listRuns, changed as changedJourneys } from "./view-server.js";
import { LocalFsProvider } from "./storage-provider.js";
import { findRunsRoot, latestRun, scanHistory } from "./runs-root.js";
import { movement } from "../shared/movement.js";
import { promptChangedReview, promptEnv } from "./prompt.js";
import { preflightFor } from "./preflight.js";
import { demo } from "./demo.js";
import { clip, resolveClipRuns, clipBaseName } from "./clip.js";
import { newCase, newPersona, installSkill } from "./new.js";
import { listPersonas } from "./actor.js";

const pkgVersion = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
).version;

const program = new Command();
program
  .name("playtest")
  .description("Run user journey tests: an AI agent records a working path through your app, and later runs check it still works.")
  .version(pkgVersion, "-v, --version", "output the version number");

program.addHelpText(
  "after",
  `
Workflow:
  playtest [paths...]        run user journey tests (default: .)
  playtest demo              watch record → act → heal on the bundled todo app
  playtest new <name>        add a test case (creates config on first use)
  playtest view              open the GUI for runs and changed journeys
  playtest clip <run|case>   cut a subtitled clip from a run's screencast
  playtest refresh <paths>   create fresh saved paths
  playtest list              list discovered suites and cases
  playtest lint              check cases for quality issues (offline, no model)

A suite whose playtest.yaml sets "mode: discovery" runs as a study: cases end "explored" instead of pass/fail, and playtest view shows the evidence.

Advanced hidden commands also exist: run, accept, reject, grade — each supports --help.`,
);

const collect = (v, all) => [...all, v];

const NO_SUITES_HINT = "No Playtest suites found. Create one with: playtest new <case-name>";

// Empty-selection message body (no "playtest:" prefix): when a --id/--tag filter
// excluded everything, name the filter (a bare "no cases matched" hid which one);
// null when no filter is set, so callers fall back to NO_SUITES_HINT. Shared by
// run/refresh (via die, which adds the prefix) and list/lint (which bake it).
const filterMismatchHint = (opts) =>
  opts.id.length
    ? `no cases matched --id ${opts.id.join(", ")}`
    : opts.tag.length
      ? `no cases matched --tag ${opts.tag.join(", ")}`
      : null;
const emptySelectionHint = (opts) => {
  const m = filterMismatchHint(opts);
  return m ? `playtest: ${m}` : NO_SUITES_HINT;
};

// Exit codes: 0 pass, 1 gate failure, 2 infra/config (see docs/playtest-design.md).
function die(message) {
  console.error(`playtest: ${message}`);
  process.exit(2);
}

// Never surface a raw stack to the user: a DummyConfigError shows its full
// (already-friendly, multi-line) message; any other error shows its first line.
// PLAYTEST_DEBUG=1 keeps the full stack when diagnosing an unexpected throw.
const run = (fn) => (...args) =>
  Promise.resolve(fn(...args)).catch((e) =>
    die(e instanceof DummyConfigError ? e.message : process.env.PLAYTEST_DEBUG ? (e.stack ?? e.message) : firstLine(e)),
  );

// Fail fast (exit 2) with a friendly, actionable message when a run that needs a
// model has none configured — so a missing/empty key never surfaces as a cryptic
// per-check 401 from the gateway mid-run. The keyless path (act mode against a
// saved baseline with grading off) does NOT need a model and is left untouched.
function requireModel() {
  if (!llmConfig().available) die(missingLlmConfigMessage());
}

function readManifest(runDir) {
  const file = path.join(path.resolve(runDir), "manifest.json");
  if (!fs.existsSync(file)) throw new DummyConfigError(`${runDir} is not a run directory (no manifest.json)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The pending healed candidate's meta for a case, or null. */
function readCandidate(caseFile) {
  const p = baselinePaths(caseFile);
  try {
    if (fs.existsSync(p.healedTraj) && fs.existsSync(p.healedMeta)) {
      return JSON.parse(fs.readFileSync(p.healedMeta, "utf8"));
    }
  } catch {}
  return null;
}

// Does the pending candidate come from THIS run directory? run_dir is the
// authoritative match; run_id is only the fallback for old candidate metas
// that lack run_dir.
function candidateMatchesRun(candidate, runDir, runId) {
  if (!candidate) return false;
  return candidate.run_dir ? path.resolve(candidate.run_dir) === path.resolve(runDir) : candidate.run_id === runId;
}

// Copy-paste safety for printed commands: quote a path for POSIX shells when
// it contains anything outside the safe set ('\'' escapes embedded quotes).
// The viewer keeps an inline copy (no bundler).
const shellQuote = (s) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);

// A concurrency flag value must be a positive integer (or the bare `--parallel`
// sentinel `true`). A non-numeric string like "abc" coerces to NaN, which — left
// unchecked — poisons the record cap and deadlocks the worker pool (a NaN record
// budget makes `recordsInFlight < record` always false, so every record parks
// forever; see resolveBudget/schedulePool). Reject at parse time with a friendly
// DummyConfigError (exit 2 via run()) instead. `undefined` (flag absent) passes
// through unchanged; `true` (bare `--parallel`) is the default-pool sentinel.
const parseCount = (v, label) => {
  if (v === undefined || v === true) return v;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw new DummyConfigError(`${label} must be a positive integer (got ${JSON.stringify(v)})`);
  return n;
};

const parseParallel = (v) => (v === undefined ? null : v === true ? true : Number(v));

// --port accepts a non-negative integer < 65536 (0 = ephemeral). A typo like
// "80a0" coerces to NaN, which server.listen throws a raw RangeError on — turn it
// into a friendly config error instead (exit 2 via run()).
const parsePort = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535)
    throw new DummyConfigError(`--port must be an integer between 0 and 65535 (got ${JSON.stringify(v)})`);
  return n;
};

// Effective run-wide concurrency. The CLI flags win when EITHER is passed:
// --parallel sets the pool (bare => true/default pool, n => that many), and
// --parallel-record caps how many cases may RECORD at once (checks fill the
// rest). A lone --parallel-record means "default pool, capped" => { total:true,
// record:n }; --parallel with no record cap stays the scalar form (no cap),
// byte-identical to the old single-pool behavior. With neither flag, fall back
// to the playtest.yaml `parallel` default — run-wide, so take the first
// configured value in case-id order (a run usually shares one top-level
// playtest.yaml). null everywhere => runAll auto-selects. Both flags are validated
// (parseCount) so a typo'd non-integer is a friendly error, never a silent NaN.
const resolveParallel = (flag, record, cases) => {
  const validRecord = parseCount(record, "--parallel-record");
  const validFlag = parseCount(flag, "--parallel");
  const rec = validRecord === undefined ? null : validRecord;
  if (validFlag === undefined || rec !== null) {
    const total = parseParallel(validFlag); // null (flag absent) | true | n
    if (rec === null) return total; // --parallel alone: scalar/true, no record cap
    // Same cross-field rule the playtest.yaml object form enforces (config.js):
    // a record cap above the total pool is nonsensical, so reject it here too
    // rather than let the two configuration surfaces disagree.
    if (typeof total === "number" && rec > total) {
      throw new DummyConfigError(`--parallel-record (${rec}) cannot exceed --parallel (${total})`);
    }
    return { total: total === null ? true : total, record: rec };
  }
  return cases.find((c) => c.parallel !== null)?.parallel ?? null;
};

// Trend context: the runs root is scanned
// once before runAll; each finished case is compared against its prior runs.
const makeTrendFor = (history) => (result) =>
  computeTrend(history.get(result.manifest?.case?.id) ?? [], result);

/**
 * Movement of one result vs the case's prior runs (scanHistory entries,
 * oldest first). The comparability rules — pin set included — live in the
 * shared module (src/shared/movement.js); this maps a runner result onto its
 * inputs and keeps only the fields the CLI surfaces.
 * @returns {{ duration_delta_ms: number|null, score_delta: number|null,
 *   status_streak: string|null }|null} null when nothing compares
 */
function computeTrend(prior, result) {
  const m = result.manifest;
  if (!m) return null;
  const mv = movement(prior, {
    run_id: m.run_id,
    started_at: m.started_at,
    status: result.status,
    healed: m.healed ?? false,
    duration_ms: m.duration_ms ?? null,
    steps: m.totals?.steps ?? null,
    score: result.score ?? null,
    pins: m.pins ?? null,
  });
  if (!mv) return null;
  return { duration_delta_ms: mv.duration.prev, score_delta: mv.scoreVsLastGraded, status_streak: mv.statusStreak };
}

// Reporter seam: live region on an
// interactive terminal, today's plain lines otherwise, silence under --json
// (warnings still reach stderr there). Trend text is content, not decoration —
// the plain reporter carries it too.
function makeReporter(opts, trendFor = () => null, cases = []) {
  // EXPLORED is wider than the journey labels: widen the status column up
  // front when the selection includes discovery cases.
  const labelWidth = cases.some((c) => c.mode === "discovery") ? "EXPLORED".length : 5;
  if (opts.json) {
    return {
      onEvent: (ev) => {
        if (ev.type === "warn") console.error(ev.message);
      },
      done: () => {},
    };
  }
  if (process.stdout.isTTY && !opts.plain && opts.tui !== false && !opts.ci) return new LiveReporter({ trendFor, labelWidth });
  return {
    onEvent: (ev) => {
      if (ev.type === "case_end") console.log(caseLine(ev.result, trendFor(ev.result), labelWidth));
      else if (ev.type === "warn") console.error(ev.message);
    },
    done: (results) => {
      // The heal digest (grouped, aligned) prints after all result lines — the
      // same durable end-of-run block the live reporter emits; "" if none healed.
      const digest = healDigest(results);
      if (digest) process.stdout.write(digest);
      console.log(summary(results));
    },
  };
}

// "Environment: ..." header line — only when every selected case resolves to
// the same env config; a mixed selection prints nothing.
// Preflight each distinct driver the selection resolves to, once. Keyed off
// the resolved cases (not a hardcoded "web") so a mobile/api-only run checks its
// own toolchain and an unused Chromium is never installed. See preflight.js.
async function preflightDrivers(cases, opts) {
  for (const driver of [...new Set(cases.map((c) => c.env.driver ?? "web"))]) {
    await preflightFor(driver, opts);
  }
}

function environmentLine(cases, envName = null) {
  const sig = (c) => JSON.stringify(c.env);
  if (!cases.length || !cases.every((c) => sig(c) === sig(cases[0]))) return null;
  const env = cases[0].env;
  if (env.driver === "mobile") {
    const app = env.app ? ` — ${path.relative(process.cwd(), env.app)}` : "";
    return `Environment: ${env.platform ?? "device"}${app}`;
  }
  if (env.compose) {
    const rel = path.relative(process.cwd(), env.compose);
    return `Environment: ${rel.startsWith(".") ? rel : `./${rel}`}`;
  }
  const suffix = envName ? ` (env: ${envName})` : "";
  return `Environment: ${env.base_url}${suffix}`;
}

// "Driver: ..." header line — the transport the selection resolves to, plus any
// active scoring mode. Driver shown whenever the selection is uniform (mobile
// adds its platform); the vision / visual-regression chips appear ONLY when that
// mode is on AND every selected case shares it, so a plain journey run prints
// just the driver and the web golden control stays byte-identical.
function driverLine(cases) {
  if (!cases.length || !cases.every((c) => c.env.driver === cases[0].env.driver)) return null;
  const env = cases[0].env;
  let driver = env.driver;
  if (driver === "mobile" && env.platform) driver += ` (${env.platform})`;
  const all = (pick) => cases.every(pick);
  const chips = [];
  if (all((c) => c.vision)) chips.push("vision enabled");
  if (all((c) => c.visual_regression)) {
    const drift = cases[0].visual_regression_drift;
    chips.push(all((c) => c.visual_regression_drift === drift) ? `visual-regression (drift ${drift})` : "visual-regression");
  }
  return `Driver: ${[driver, ...chips].join(" · ")}`;
}

// discoverCases with the interactive --env picker fallback. When discovery
// throws the missing-base_url error AND envs are declared (err.availableEnvs)
// AND no --env was passed AND the session is interactive, prompt for one and
// re-discover with the choice; otherwise the error propagates (→ exit 2). The
// chosen env name is returned alongside the cases for the header line.
async function discoverWithEnv(paths, opts) {
  let env = opts.env ?? null;
  const discover = () => discoverCases(paths, { tags: opts.tag, ids: opts.id, baseUrl: opts.baseUrl ?? null, env });
  const interactive = process.stdout.isTTY && process.stdin.isTTY && !opts.ci && !opts.json;
  try {
    return { cases: await discover(), env };
  } catch (e) {
    if (env !== null || !interactive || !(e instanceof DummyConfigError) || !e.availableEnvs?.length) throw e;
    env = await promptEnv(e.availableEnvs);
    return { cases: await discover(), env };
  }
}

// Custom assertions loaded across the discovered cases (deduped by name). Each
// resolved case carries its suite's registry on rc._assertions; a suite with no
// assertions/ dir contributes nothing, so the line only appears when assertions exist.
function assertionsLine(cases) {
  const names = new Set();
  for (const c of cases) for (const a of c._assertions?.assertions ?? []) names.add(a.name);
  if (!names.size) return null;
  return `Loaded assertions: [${[...names].sort().join(", ")}]`;
}

async function prepareRun(paths, opts, { label, afterValidation = null, afterDiscovery = null, showAssertions = false }) {
  // Validate concurrency flags up front so a typo (e.g. --parallel-record abc)
  // fails fast with a friendly error, before discovery or a Chromium preflight.
  parseCount(opts.parallel, "--parallel");
  parseCount(opts.parallelRecord, "--parallel-record");
  await afterValidation?.();
  const { cases, env: selectedEnv } = await discoverWithEnv(paths, opts);
  if (!cases.length) {
    // Suites were found but a filter excluded everything: the onboarding hint
    // would mislead, so name the filter instead (filterMismatchHint).
    const m = filterMismatchHint(opts);
    if (m) die(m); // die adds the "playtest:" prefix + exit 2
    console.error(NO_SUITES_HINT);
    process.exit(2);
  }
  await afterDiscovery?.(cases);
  // Driver-aware preflight, AFTER discovery so only the drivers actually
  // selected are checked (an api/mobile-only run never prompts for an unused
  // Chromium). web → pinned chromium only, no fallback for measured runs.
  await preflightDrivers(cases, opts);
  const runId = freshRunId(opts.runsRoot);
  const runsDir = path.join(opts.runsRoot, runId);
  if (!opts.json) {
    // The run id is the basename of runsDir, so don't print it twice; the
    // output path carries it. e.g. "run · 3 cases → runs/2026-…-b621".
    console.log(`${label} · ${cases.length} ${cases.length === 1 ? "case" : "cases"} → ${runsDir}`);
    const envLine = environmentLine(cases, selectedEnv);
    if (envLine) console.log(envLine);
    const drvLine = driverLine(cases);
    if (drvLine) console.log(drvLine);
    if (showAssertions) {
      const assertLine = assertionsLine(cases);
      if (assertLine) console.log(assertLine);
    }
    console.log("");
  }
  return { cases, runId, runsDir };
}

// End-of-run next actions. Deliberately
// dumb lines; promptChanged below is the interactive layer.
function printNextActions(results, runsDir) {
  const changed = results.some((res) => res.status === "pass" && res.manifest?.healed);
  const failed = results.some((res) => res.status === "fail");
  const line = (label, rest) => console.log(label.padEnd(18) + rest);
  console.log("");
  line("View results:", "playtest view");
  if (changed) line("Review changes:", "playtest view --changed");
  if (failed) line("Open failed runs:", "playtest view --failed");
  line("CI artifacts:", runsDir);
}

// A changed journey from THIS run: a passing healed result whose candidate
// files still exist and still point at this rundir (a sibling repeat run or
// a parallel job for the same case may already have superseded them).
function isPendingChanged(res) {
  if (res.status !== "pass" || !res.manifest?.healed || !res.runDir) return false;
  const caseFile = res.manifest.case?.file;
  return typeof caseFile === "string" && candidateMatchesRun(readCandidate(caseFile), res.runDir, res.manifest.run_id);
}
const pendingChanged = (results) => results.filter(isPendingChanged);

// The --json machine summary: one object on stdout, mirrors internal naming
// (mode stays record/act/heal/explore; changed marks a pending candidate).
// Trend fields are null when the case has no prior runs in the runs root.
function jsonSummary(results, { runId, runsRoot, exitCode, trendFor }) {
  return {
    run_id: runId,
    runs_root: path.resolve(runsRoot),
    exit_code: exitCode,
    cases: results.map((res) => {
      const m = res.manifest ?? {};
      const trend = trendFor(res);
      return {
        id: m.case?.id ?? null,
        status: res.status,
        mode: m.mode ?? null,
        healed: m.healed ?? false,
        changed: isPendingChanged(res),
        run_dir: res.runDir,
        duration_ms: m.duration_ms ?? null,
        steps: m.totals?.steps ?? null,
        cost_usd: m.totals?.cost_usd ?? null,
        score: res.score ?? null,
        duration_delta_ms: trend?.duration_delta_ms ?? null,
        score_delta: trend?.score_delta ?? null,
        status_streak: trend?.status_streak ?? null,
        gate_failures: (m.result?.gate?.checks ?? [])
          .filter((c) => !c.pass)
          .map((c) => ({ spec: c.spec, detail: c.detail, severity: c.severity ?? "hard" })),
      };
    }),
  };
}

// --fail-on-changed: a CI gate that treats unreviewed changed journeys as a
// failure. Listed on stderr under --json so stdout stays one JSON object.
function printChangedGate(pending, { toStderr = false } = {}) {
  const log = toStderr ? console.error : console.log;
  log(`\nfail-on-changed: ${pending.length} changed journey(s) need review`);
  for (const res of pending) {
    log(`  ${res.manifest.case.id}  playtest accept ${shellQuote(path.relative(process.cwd(), res.runDir))}`);
  }
}

/**
 * Interactive review of pending changed journeys, then the resume lines.
 * Exit code is already set by runAll; opening the viewer just keeps serving.
 * @param {object[]} pending pendingChanged() results
 * @param {{ runsRoot: string, yes?: boolean, ci?: boolean, json?: boolean }} opts
 */
async function promptChanged(pending, opts) {
  const interactive =
    process.stdout.isTTY && process.stdin.isTTY && !opts.ci && !opts.yes && !opts.json;
  if (interactive) {
    try {
      await promptChangedReview(pending.length, {
        openReview: async () => {
          await serveRun(opts.runsRoot, { port: 0, open: true, query: "?filter=changed" });
        },
        acceptAll: async () => {
          for (const res of pending) {
            // One bad accept must not kill the others or override the run's exit code.
            try {
              acceptRun(res.runDir);
            } catch (e) {
              console.error(`playtest: ${e instanceof DummyConfigError ? e.message : (e.stack ?? e.message)}`);
            }
          }
        },
      });
    } catch {} // stdin closed mid-prompt: treat as declined
  }
  const line = (label, rest) => console.log(label.padEnd(20) + rest);
  console.log("");
  line("Review later with:", "playtest view --changed");
  pending.forEach((res, i) =>
    line(i === 0 ? "Accept later with:" : "", `playtest accept ${shellQuote(path.relative(process.cwd(), res.runDir))}`),
  );
}

function printPersonas() {
  const personas = listPersonas(process.cwd());
  const rows = personas.map((p) => [p.name, p.file ? path.relative(process.cwd(), p.file) : "(built-in)"]);
  const width = Math.max("PERSONA".length, ...rows.map((r) => r[0].length));
  console.log(`${"PERSONA".padEnd(width)}  SOURCE`);
  for (const [name, source] of rows) console.log(`${name.padEnd(width)}  ${source}`);
}
// The default command: `playtest test-stories/` === `playtest run test-stories/`. Exact
// subcommand names win, so `playtest view` never falls through to here.
program
  .command("run", { isDefault: true, hidden: true })
  .description("run the cases discovered under the given paths")
  .argument("[paths...]", "case files and/or directories", ["."])
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--id <id>", "only the case with this id (repeatable; <id> runs every persona of a study)", collect, [])
  .option("--mode <mode>", "auto (follow saved paths, else record) | agent (force fresh record)", "auto")
  .option("--base-url <url>", "override app.base_url (forces external mode)")
  .option("--env <name>", "select a named environment from app.envs")
  .option("--parallel [n]", "run cases in parallel (default pool when n omitted)")
  .option("--parallel-record <n>", "cap how many cases may record at once (checks fill the rest of the pool)")
  .option("--junit <path>", "write a JUnit XML report")
  .option("--no-grade", "skip the grader")
  .option("--headed", "show the browser", false)
  .option("--runs-root <dir>", "where run directories are written", "runs")
  .option("--yes", "skip interactive prompts", false)
  .option("--ci", "non-interactive CI mode: plain output, no prompts", false)
  .option("--plain", "plain line-per-case output (no live status region)", false)
  .option("--no-tui", "same as --plain")
  .option("--json", "print one machine-readable JSON summary on stdout", false)
  .option("--fail-on-changed", "exit 1 when this run leaves changed journeys awaiting review", false)
  .action(run(async (paths, opts) => {
    if (!["auto", "agent"].includes(opts.mode)) die(`invalid --mode ${opts.mode} (auto|agent)`);
    const { cases, runId, runsDir } = await prepareRun(paths, opts, {
      label: "run",
      showAssertions: true,
      afterDiscovery: (selected) => {
        // Preflight the model when the run will need one: grading (default on),
        // --mode agent, or ANY selected case that must record (a fresh case with no
        // saved baseline). This must run AFTER discovery so willRecord can see the
        // real baselines — otherwise `--no-grade` on a never-recorded case would skip
        // the preflight and surface a cryptic per-step 401 mid-record. The one truly
        // keyless path is --no-grade acting against saved baselines (nothing records).
        if (opts.grade || opts.mode === "agent" || selected.some((rc) => willRecord(rc, { mode: opts.mode, refresh: false }))) {
          requireModel();
        }
      },
    });
      const trendFor = makeTrendFor(scanHistory(opts.runsRoot)); // before this run writes manifests
      const { exitCode, results } = await runAll(cases, {
        mode: opts.mode,
        runsRoot: opts.runsRoot,
        runId,
        grade: opts.grade,
        headed: opts.headed,
        parallel: resolveParallel(opts.parallel, opts.parallelRecord, cases),
        junit: opts.junit ?? null,
        refresh: false,
        reporter: makeReporter(opts, trendFor, cases),
      });
      const pending = pendingChanged(results);
      // exit-code contract: 0 pass/explored/interrupted, 1 gate failure, 2 infra.
      // (a real Ctrl-C exits 130 via the re-raised SIGINT before this is reached.)
      // --fail-on-changed promotes unreviewed changed journeys to 1, but never
      // downgrades a 2.
      const gateChanged = opts.failOnChanged && pending.length > 0;
      process.exitCode = gateChanged && exitCode !== 2 ? 1 : exitCode;
      if (opts.json) {
        console.log(JSON.stringify(jsonSummary(results, { runId, runsRoot: opts.runsRoot, exitCode: process.exitCode, trendFor })));
        if (gateChanged) printChangedGate(pending, { toStderr: true });
        return;
      }
      printNextActions(results, runsDir);
      if (gateChanged) printChangedGate(pending);
      if (pending.length) await promptChanged(pending, opts);
    }));

// `demo` (demo.js): the three-act tour against the bundled todo app. Runs on
// a temp copy of src/demo/; nothing is written inside the package or the cwd.
program
    .command("demo")
    .description("three-act demo against the bundled todo app: record → act → heal (no keys, no setup)")
    .option("--keep", "keep the demo's temp directory (suite copy + runs) and print its path", false)
  .option("--headed", "show the browser", false)
  .action(run(async (opts) => demo(opts)));

const create = program
  .command("new")
  .description("create a test case or persona")
  .addHelpText("after", "\nExamples:\n  playtest new add-item ./checkout\n  playtest new case persona\n  playtest new persona curious-newcomer");
create
  .command("case", { isDefault: true })
  .description("create a case file (scaffolds a playtest.yaml when no ancestor has one)")
  .argument("<name>")
  .argument("[dir]", "target directory (default: the nearest suite; else ./test-stories)")
  .option("--force", "overwrite an existing case file", false)
  .option("--driver <driver>", "transport: web | mobile | api (scaffolds a matching case + defaults)", "web")
  .action(run(async (name, dir, opts) => newCase(name, dir, opts)));
create
  .command("persona")
  .description("create a persona in ./personas/")
  .argument("<name>")
  .option("--force", "overwrite an existing persona", false)
  .action(run(async (name, opts) => newPersona(name, opts)));
// Reserved name: without this stub, isDefault routing would reinterpret the
// removed suite-creation form as a case named "suite" and silently scaffold it.
create
  .command("suite", { hidden: true })
  .argument("[args...]")
  .allowExcessArguments(true)
  .action(run(async () => {
    throw new DummyConfigError(
      'suites are not created explicitly — playtest new <name> [dir] scaffolds playtest.yaml on first use (a case named "suite" needs: playtest new case suite)',
    );
  }));

/**
 * `view --json`: the picker / review listing as a plain array — reuses the
 * view-server scanners so entries match /runs.json and /changed.json exactly.
 * --changed → changed-journey entries; --failed → fail/infra runs only;
 * --case filters by case id; --latest narrows to the single most recent run.
 */
function viewJson(root, opts) {
  const provider = new LocalFsProvider(root);
  if (opts.changed) {
    const entries = changedJourneys(provider, path.resolve(root), fs.existsSync(path.join(root, "manifest.json")));
    return opts.case ? entries.filter((e) => e.case_id === opts.case) : entries;
  }
  let entries = listRuns(provider);
  if (opts.failed) entries = entries.filter((e) => e.status === "fail" || e.status === "infra");
  if (opts.case) entries = entries.filter((e) => e.case_id === opts.case);
  return opts.latest ? entries.slice(0, 1) : entries; // listRuns sorts newest first
}

program
  .command("view")
  .description("open the GUI to inspect runs and review changed journeys")
  .argument("[run_or_root]", "a run directory or a runs root (default: the nearest runs/ dir)")
  .option("--runs-root <dir>", "runs root to browse (same as the positional argument)")
  .option("--latest", "open the most recent run instead of the picker", false)
  .option("--changed", "open the review list of changed journeys", false)
  .option("--failed", "show only failed and infra runs", false)
  .option("--case <id>", "show only this case (with --latest: open its most recent run)")
  .option("--json", "print the run list as a JSON array on stdout (no server)", false)
  .option("--port <n>", "port (0 = ephemeral)", "0")
  .option("--no-open", "do not open a browser")
  .action(run(async (dir, opts) => {
    if (opts.changed && opts.failed) die("--changed and --failed are mutually exclusive");
    if (opts.latest && (opts.changed || opts.failed)) die("--latest opens a single run; --changed/--failed filter the picker");
    const port = parsePort(opts.port);
    const root = findRunsRoot(dir ?? opts.runsRoot ?? null);
    if (opts.json) {
      // No server, no browser: --port/--no-open are ignored under --json.
      console.log(JSON.stringify(viewJson(root, opts)));
      return;
    }
    if (opts.latest) {
      const hit = latestRun(root, opts.case ?? null);
      if (!hit) die(`no runs${opts.case ? ` of case ${opts.case}` : ""} found under ${root}`);
      return serveRun(hit.dir, { port, open: opts.open });
    }
    const q = new URLSearchParams();
    if (opts.changed) q.set("filter", "changed");
    if (opts.failed) q.set("filter", "failed");
    if (opts.case) q.set("case", opts.case);
    await serveRun(root, { port, open: opts.open, query: q.size ? `?${q}` : "" });
  }));

// `install-skill` (new.js): the packaged agent skills, installed into the project
// (real files under .agents/skills/, symlinked into .claude/skills/) so they
// version with the installed harness's --json contract.
program
  .command("install-skill")
  .description("install the playtest agent skills into .agents/skills/ (symlinked into .claude/skills/)")
  .option("--force", "overwrite a locally modified skill file", false)
  .action(run(async (opts) => installSkill(opts)));

// `clip` (clip.js): a slideshow video.mp4 + WebVTT sidecar stitched from a run's
// per-step stills (a legacy run carrying a real video.webm still emits a .webm
// pair); --burn makes the self-contained variant (H.264 MP4, GitHub-renderable)
// via system ffmpeg (optional dependency).
program
  .command("clip")
  .description("cut a subtitled clip from a run (slideshow .mp4 + WebVTT sidecar; legacy screencast runs emit a .webm pair)")
  .argument("<target>", "a run dir, a parent dir of many runs (clips every one), a suite dir / case file (latest run of each case — same path you pass to run), or a case id")
  .option("--captions <style>", "caption source: action (Click “Checkout”) | thought (agent narration)", "action")
  .option("--burn", "burn captions + status watermark into a single MP4 (H.264, plays in a GitHub PR; needs system ffmpeg)", false)
  .option("--out <dir>", "output DIRECTORY for the clip(s): <caseId>.mp4 with --burn, else <caseId>.mp4 + <caseId>.vtt (default: in each run dir)")
  .option("--runs-root <dir>", "runs root to resolve a suite/case target against (default: nearest runs/)")
  .option("--tag <tag>", "when the target is a suite, only cases with this tag (repeatable)", collect, [])
  .option("--id <id>", "when the target is a suite, only the case with this id (repeatable)", collect, [])
  .action(run(async (target, opts) => clip(target, opts)));

// `refresh` re-records and accepts passing runs.
program
  .command("refresh")
  .description("create fresh saved paths from scratch (re-record and save passing runs)")
  .argument("<paths...>", "case files and/or directories")
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--id <id>", "only the case with this id (repeatable; <id> runs every persona of a study)", collect, [])
  .option("--base-url <url>", "override app.base_url (forces external mode)")
  .option("--env <name>", "select a named environment from app.envs")
  .option("--parallel [n]", "run cases in parallel (default pool when n omitted)")
  .option("--parallel-record <n>", "cap how many cases may record at once (checks fill the rest of the pool)")
  .option("--headed", "show the browser", false)
  .option("--runs-root <dir>", "where run directories are written", "runs")
  .option("--ci", "non-interactive CI mode: plain output", false)
  .option("--plain", "plain line-per-case output (no live status region)", false)
  .option("--no-tui", "same as --plain")
  .action(run(async (paths, opts) => {
    const { cases, runId } = await prepareRun(paths, opts, {
      label: "refresh",
      afterValidation: () => requireModel(), // refresh always re-records and grades — a model is mandatory
    });
    const { exitCode } = await runAll(cases, {
      mode: "agent",
      runsRoot: opts.runsRoot,
      runId,
      grade: true,
      headed: opts.headed,
      parallel: resolveParallel(opts.parallel, opts.parallelRecord, cases),
      junit: null,
      refresh: true,
      reporter: makeReporter(opts, makeTrendFor(scanHistory(opts.runsRoot)), cases),
    });
    process.exitCode = exitCode;
  }));

program
  .command("list")
  .description("list discovered suites and cases")
  .argument("[paths...]", "case files and/or directories", ["."])
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--id <id>", "only the case with this id (repeatable; <id> lists every persona of a study)", collect, [])
  .option("--json", "print the list as a JSON array", false)
  .action(run(async (paths, opts) => {
    const cases = await discoverCases(paths, { tags: opts.tag, ids: opts.id });
    // With a filter, an empty result means "nothing matched", not "no suites" —
    // the onboarding hint would mislead. list always exits 0.
    const emptyHint = emptySelectionHint(opts);
    if (opts.json) {
      if (!cases.length) console.error(emptyHint); // stdout stays valid JSON
      console.log(JSON.stringify(cases.map((c) => ({
        id: c.id,
        tags: c.tags,
        persona: c.persona,
        // discovery decides first: a stray baseline file must not flip it
        next_run: c.mode === "discovery" ? "explore" : readBaseline(c.file) ? "check" : "record",
      }))));
      return;
    }
    if (!cases.length) {
      console.log(emptyHint);
      return;
    }
    const rows = cases.map((c) => [
      c.id,
      c.tags.join(",") || "-",
      c.persona || "-",
      c.mode === "discovery" ? "explore" : readBaseline(c.file) ? "check" : "record",
    ]);
    const widths = [0, 1, 2].map((i) => Math.max("ID TAGS PERSONA".split(" ")[i].length, ...rows.map((r) => r[i].length)));
    const line = (r) => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("  ");
    console.log(line(["ID", "TAGS", "PERSONA", "NEXT-RUN"]));
    for (const r of rows) console.log(line(r));
  }));

program
  // Static quality lint: reuses discoverCases (so schema/config errors still
  // exit 2 via run()), then flags content the schema can't — empty/duplicate
  // asserts, a journey with no gate, an assert that should be a deterministic
  // kind. Warnings are advisory: lint always exits 0 (see lint.js, §12).
  .command("lint")
  .description("check discovered cases for quality issues (offline, no model)")
  .argument("[paths...]", "case files and/or directories", ["."])
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--id <id>", "only the case with this id (repeatable; <id> lints every persona of a study)", collect, [])
  .option("--json", "print findings as a JSON array", false)
  .action(run(async (paths, opts) => {
    const cases = await discoverCases(paths, { tags: opts.tag, ids: opts.id });
    const findings = cases
      .map((c) => ({ id: c.id, file: c.file, warnings: lintCase(c) }))
      .filter((f) => f.warnings.length);
    if (opts.json) {
      if (!cases.length) console.error(emptySelectionHint(opts)); // stdout stays valid JSON
      console.log(JSON.stringify(findings.flatMap((f) =>
        f.warnings.map((w) => ({ id: f.id, file: f.file, level: w.level, message: w.message })))));
      return;
    }
    if (!cases.length) {
      console.log(emptySelectionHint(opts));
      return;
    }
    if (!findings.length) {
      console.log(`playtest: ${cases.length} case${cases.length === 1 ? "" : "s"} checked, no issues found`);
      return;
    }
    for (const f of findings) {
      for (const w of f.warnings) console.log(`playtest: ${f.id}: ${w.message}`);
    }
  }));

program
  .command("personas")
  .description("List available personas (built-in and custom)")
  .action(run(async () => printPersonas()));

// `accept` core, also run by the end-of-run "Accept all?" prompt. Throws
// DummyConfigError on bad input (the command wrapper turns that into exit 2).
function acceptRun(runDir) {
  const dir = path.resolve(runDir);
  const manifest = readManifest(runDir);
  // Acceptance safety: accepting rewrites a versioned baseline, so refuse
  // bad inputs outright — there is deliberately no --force
  if (!fs.existsSync(path.join(dir, "trajectory.jsonl"))) {
    throw new DummyConfigError(`${runDir} has no trajectory.jsonl; nothing to accept`);
  }
  if (manifest.result?.status !== "pass") {
    throw new DummyConfigError(
      `refusing to accept ${runDir}: run status is "${manifest.result?.status ?? "unknown"}"` +
        ` (end_reason: ${manifest.result?.end_reason ?? "unknown"}); only passing runs can become the saved path`,
    );
  }
  const caseFile = manifest.case?.file;
  if (typeof caseFile !== "string") {
    throw new DummyConfigError(`${runDir} records no case file (manifest.case.file is ${JSON.stringify(caseFile)})`);
  }
  if (!fs.existsSync(caseFile)) {
    throw new DummyConfigError(`case file recorded in the manifest no longer exists: ${caseFile}`);
  }
  const p = baselinePaths(caseFile);
  const candidate = readCandidate(caseFile);
  let meta;
  if (candidateMatchesRun(candidate, dir, manifest.run_id)) {
    // This run produced the pending healed candidate: promote it (§3),
    // keeping its healed_from_run_id provenance.
    meta = promoteHealed(caseFile);
  } else {
    if (candidate) {
      // Accepting a named run is deliberate: supersede the pending candidate,
      // but say so rather than dropping it silently.
      console.log(
        `note: pending changed journey from run ${candidate.run_id ?? "(unknown)"}` +
          ` (${candidate.run_dir ?? "?"}) is superseded by this accept`,
      );
    }
    meta = acceptBaseline(caseFile, dir);
    fs.rmSync(p.healedTraj, { force: true });
    fs.rmSync(p.healedMeta, { force: true });
  }
  console.log(`accepted ${manifest.case.id} — new saved path from run ${meta.run_id}\n  ${p.traj}`);
}

// Resolve a `clip`-style target (run dir / suite / case file / runs tree / case
// id) to its run dirs and accept each. A single resolved run re-throws on any
// acceptance-safety failure (today's exit-2 behaviour). A multi-run target
// mirrors `clip`: a run that fails a safety check is skipped + reported, never
// aborting the batch, then a summary line is printed.
async function acceptTarget(target, opts) {
  const { runDirs, multi } = await resolveClipRuns(target, {
    runsRoot: opts.runsRoot ?? null,
    tags: opts.tag ?? [],
    ids: opts.id ?? [],
  });
  if (!multi) {
    acceptRun(runDirs[0]);
    return;
  }
  let made = 0;
  for (const runDir of runDirs) {
    try {
      acceptRun(runDir);
      made++;
    } catch (e) {
      if (!(e instanceof DummyConfigError)) throw e;
      console.log(`skipped ${clipBaseName(runDir)}: ${firstLine(e)}`);
    }
  }
  console.log(`accepted ${made}/${runDirs.length} run(s)`);
}

program
  .command("accept", { hidden: true })
  .description("accept a run's trajectory as its case's new saved path (baseline)")
  .argument("<target>", "a run dir, a suite dir / case file (latest run of each case — same path you pass to run), a runs tree, or a case id")
  .option("--runs-root <dir>", "runs root to resolve a suite/case target against (default: nearest runs/)")
  .option("--tag <tag>", "when the target is a suite, only cases with this tag (repeatable)", collect, [])
  .option("--id <id>", "when the target is a suite, only the case with this id (repeatable)", collect, [])
  .action(run(async (target, opts) => acceptTarget(target, opts)));

program
  .command("reject", { hidden: true })
  .description("dismiss this run's pending changed journey (run artifacts are kept)")
  .argument("<runDir>")
  .action(run(async (runDir) => {
    const manifest = readManifest(runDir);
    const caseFile = manifest.case?.file;
    if (typeof caseFile !== "string") {
      die(`${runDir} records no case file (manifest.case.file is ${JSON.stringify(caseFile)})`);
    }
    const p = baselinePaths(caseFile);
    if (!fs.existsSync(p.healedTraj)) {
      die(`no pending changed journey for ${manifest.case.id} (expected ${p.healedTraj})`);
    }
    const candidate = readCandidate(caseFile);
    if (!candidateMatchesRun(candidate, runDir, manifest.run_id)) {
      die(
        `the pending changed journey for ${manifest.case.id} came from run ${candidate?.run_id ?? "(unknown)"}` +
        ` (${candidate?.run_dir ?? "?"}), not ${path.resolve(runDir)}; pass that run directory to reject it`,
      );
    }
    rejectHealed(caseFile);
    console.log(`rejected ${manifest.case.id} — pending changed journey from run ${manifest.run_id} dismissed (run artifacts kept)`);
  }));

// (Re)grade one run dir: grader LLM call → write grade.json + update manifest →
// print the score lines. A live spinner runs on an interactive terminal (same
// TTY guard the run reporter uses; piped/CI stays silent until the result
// lines). The shared `ac` lets one Ctrl-C abort the whole batch — the spinner's
// SIGINT handler aborts the grader's LLM call so a 429 storm can't outlive it.
// `id` names the run in the spinner's id column (the case id), mirroring the run
// line; the mode word stays "grading". The spinner also shows "fetching step N"
// while the grader pulls a step's snapshot (onFetch) and the shared retry
// countdown on an LLM backoff (onRetry).
async function gradeOneRun(runDir, { ac = null, id = null } = {}) {
  const manifest = readManifest(runDir);
  const rc = { ...manifest.case, grader_model: manifest.pins?.grader_model ?? "sonnet" };
  const spinner = ac ? new GradeSpinner("grading", { id: id ?? manifest.case?.id ?? clipBaseName(runDir), model: rc.grader_model, onAbort: () => ac.abort() }) : null;
  let grade;
  try {
    grade = await gradeRun(path.resolve(runDir), rc, {
      signal: ac?.signal ?? null,
      onRetry: spinner ? (r) => spinner.onRetry(r) : null,
      onFetch: spinner ? (ev) => spinner.onFetch(ev) : null,
    });
  } finally {
    spinner?.stop();
  }
  manifest.artifacts.grade = "grade.json";
  fs.writeFileSync(path.join(path.resolve(runDir), "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { grade, id: manifest.case?.id ?? clipBaseName(runDir) };
}

// Resolve a `clip`-style target to its run dirs and (re)grade each. A SINGLE
// resolved run keeps today's behaviour exactly (one grade, bare spinner, errors
// re-thrown → exit 2). A MULTI-run target mirrors `clip`/`accept`: a run that
// fails a config safety check is skipped + reported, then `graded N/M run(s)` is
// printed. One AbortController spans the batch so a single Ctrl-C stops it.
async function gradeTarget(target, opts) {
  requireModel();
  const { runDirs, multi } = await resolveClipRuns(target, {
    runsRoot: opts.runsRoot ?? null,
    tags: opts.tag ?? [],
    ids: opts.id ?? [],
  });
  const ac = process.stdout.isTTY ? new AbortController() : null;
  if (!multi) {
    const { grade } = await gradeOneRun(runDirs[0], { ac });
    console.log(`score ${grade.score}/100 · completion ${grade.completion}`);
    console.log(grade.summary);
    return;
  }
  let made = 0;
  for (const runDir of runDirs) {
    try {
      const { grade, id } = await gradeOneRun(runDir, { ac, id: clipBaseName(runDir) });
      made++;
      console.log(`${id}: score ${grade.score}/100 · completion ${grade.completion}`);
    } catch (e) {
      if (!(e instanceof DummyConfigError)) throw e; // an aborted/LLM error stops the batch
      console.log(`skipped ${clipBaseName(runDir)}: ${firstLine(e)}`);
    }
  }
  console.log(`graded ${made}/${runDirs.length} run(s)`);
}

program
  .command("grade", { hidden: true })
  .description("(re)grade an existing run")
  .argument("<target>", "a run dir, a suite dir / case file (latest run of each case — same path you pass to run), a runs tree, or a case id")
  .option("--runs-root <dir>", "runs root to resolve a suite/case target against (default: nearest runs/)")
  .option("--tag <tag>", "when the target is a suite, only cases with this tag (repeatable)", collect, [])
  .option("--id <id>", "when the target is a suite, only the case with this id (repeatable)", collect, [])
  .action(run(async (target, opts) => gradeTarget(target, opts)));

program.parseAsync().catch((e) => die(e.message));
