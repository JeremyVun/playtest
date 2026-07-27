#!/usr/bin/env node
// `playtest` command wiring. See docs/contracts/interfaces.md#cli-conventions.
import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import { discoverCases, DummyConfigError, lintCase, listPersonas } from "../core/public/suite.ts";
import { fileURLToPath } from "node:url";
import {
  freshRunId,
  readBaseline,
  baselinePaths,
  acceptBaseline,
  describeFindings,
  exportSpec,
  promoteHealed,
  rejectHealed,
  scanRun,
  firstLine,
} from "../core/public/artifacts.ts";
import { runAll, willRecord, gradeRun } from "../core/public/run.ts";
import { caseLine, summary, healDigest } from "../core/public/reporting.ts";
import { LiveReporter } from "./live.ts";
import { llmConfig, missingLlmConfigMessage } from "../core/public/llm.ts";
import { serveRun, listRuns, changed as changedJourneys } from "../run-viewer/node.ts";
import {
  BundleProvider,
  findRunsRoot,
  isBundlePath,
  latestRun,
  LocalFsProvider,
  scanHistory,
} from "../core/public/artifacts.ts";
import { movement } from "../core/public/analysis.ts";
import { promptChangedReview, promptEnv } from "./prompt.ts";
import { preflightFor } from "./preflight.ts";
import { clip } from "../core/public/media.ts";
import { newCase, newPersona, installSkill } from "./new.ts";
import { scriptAuthor } from "./script.ts";
import {
  findingsAccept,
  findingsConsolidate,
  findingsExport,
  findingsList,
  findingsReject,
  findingsResolve,
  findingsShow,
} from "./findings.ts";
import type { StorageProvider } from "../core/storage-provider.ts";

type DynamicValue = any; // SAFETY: Commander callbacks and legacy artifact projections remain dynamic at the CLI boundary

interface HiddenOptionConfig {
  parser?: ((value: string, previous: DynamicValue) => DynamicValue) | null;
  defaultValue?: DynamicValue;
}

interface PrepareRunHooks {
  label: string;
  afterValidation?: (() => void | Promise<void>) | null;
  afterDiscovery?: ((cases: DynamicValue[]) => void | Promise<void>) | null;
  showAssertions?: boolean;
}

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
  playtest <suite|story>            run user journey tests
  playtest view                     inspect runs and changed journeys
  playtest clip <run|case-id> --burn   create a shareable subtitled clip
  playtest findings list            triage durable bugs found across runs
  playtest baseline accept <run>    accept a changed saved path
  playtest baseline reject <run>    reject a changed saved path
  playtest baseline refresh <path>  replace saved paths with fresh recordings
  playtest export <suite|story>     render saved paths as Playwright specs (one-way)
  playtest install-skill            install the Playtest agent skills
  playtest new <name>               scaffold a case

A suite whose playtest.yaml sets "mode: discovery" runs as a study: cases end "explored" instead of pass/fail, and playtest view shows the evidence.
`,
);

const collect = (v: string, all: string[]) => [...all, v];
const hiddenOption = (flags: string, description: string, { parser = null, defaultValue }: HiddenOptionConfig = {}) => {
  const option = new Option(flags, description).hideHelp();
  if (parser) option.argParser(parser);
  if (defaultValue !== undefined) option.default(defaultValue);
  return option;
};

const NO_SUITES_HINT = "No Playtest suites found. Create one with: playtest new <case-name>";

// Empty-selection message body (no "playtest:" prefix): when a --id/--tag filter
// excluded everything, name the filter (a bare "no cases matched" hid which one);
// null when no filter is set, so callers fall back to NO_SUITES_HINT. Shared by
// run/refresh (via die, which adds the prefix) and list/lint (which bake it).
const filterMismatchHint = (opts: DynamicValue) =>
  opts.id.length
    ? `no cases matched --id ${opts.id.join(", ")}`
    : opts.tag.length
      ? `no cases matched --tag ${opts.tag.join(", ")}`
      : null;
const emptySelectionHint = (opts: DynamicValue) => {
  const m = filterMismatchHint(opts);
  return m ? `playtest: ${m}` : NO_SUITES_HINT;
};

// Exit codes: 0 pass, 1 gate failure, 2 infra/config (see docs/playtest-design.md).
function die(message: string): never {
  console.error(`playtest: ${message}`);
  process.exit(2);
}

// Never surface a raw stack to the user: a DummyConfigError shows its full
// (already-friendly, multi-line) message; any other error shows its first line.
// PLAYTEST_DEBUG=1 keeps the full stack when diagnosing an unexpected throw.
const run = (fn: (...args: DynamicValue[]) => DynamicValue) => (...args: DynamicValue[]) =>
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

function readManifest(runDir: string): DynamicValue {
  const file = path.join(path.resolve(runDir), "manifest.json");
  if (!fs.existsSync(file)) throw new DummyConfigError(`${runDir} is not a run directory (no manifest.json)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The pending healed candidate's meta for a case, or null. */
function readCandidate(caseFile: string): DynamicValue {
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
function candidateMatchesRun(candidate: DynamicValue, runDir: string, runId: string) {
  if (!candidate) return false;
  return candidate.run_dir ? path.resolve(candidate.run_dir) === path.resolve(runDir) : candidate.run_id === runId;
}

// Copy-paste safety for printed commands: quote a path for POSIX shells when
// it contains anything outside the safe set ('\'' escapes embedded quotes).
// The viewer keeps an inline copy (no bundler).
const shellQuote = (s: string) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);

// A concurrency flag value must be a positive integer (or the bare `--parallel`
// sentinel `true`). A non-numeric string like "abc" coerces to NaN, which — left
// unchecked — poisons the record cap and deadlocks the worker pool (a NaN record
// budget makes `recordsInFlight < record` always false, so every record parks
// forever; see resolveBudget/schedulePool). Reject at parse time with a friendly
// DummyConfigError (exit 2 via run()) instead. `undefined` (flag absent) passes
// through unchanged; `true` (bare `--parallel`) is the default-pool sentinel.
const parseCount = <T extends string | number | boolean | undefined>(v: T, label: string): T extends true ? true : number | undefined => {
  if (v === undefined || v === true) return v as unknown as T extends true ? true : number | undefined; // SAFETY: the two sentinel branches match the conditional return
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw new DummyConfigError(`${label} must be a positive integer (got ${JSON.stringify(v)})`);
  return n as T extends true ? true : number | undefined; // SAFETY: every non-sentinel value is validated into a number
};

const parseParallel = (v: string | number | boolean | undefined) => (v === undefined ? null : v === true ? true : Number(v));

// --port accepts a non-negative integer < 65536 (0 = ephemeral). A typo like
// "80a0" coerces to NaN, which server.listen throws a raw RangeError on — turn it
// into a friendly config error instead (exit 2 via run()).
const parsePort = (v: string | number) => {
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
const resolveParallel = (flag: string | number | boolean | undefined, record: string | number | undefined, cases: DynamicValue[]) => {
  const validRecord = parseCount(record, "--parallel-record");
  const validFlag = parseCount(flag, "--parallel");
  const rec = validRecord === undefined ? null : validRecord;
  if (validFlag === undefined || rec !== null) {
    const total = parseParallel(validFlag); // null (flag absent) | true | n
    if (rec === null) return total; // --parallel alone: scalar/true, no record cap
    // Same cross-field rule the playtest.yaml object form enforces (config.ts):
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
const makeTrendFor = (history: Map<string, DynamicValue[]>) => (result: DynamicValue) =>
  computeTrend(history.get(result.manifest?.case?.id) ?? [], result);

/**
 * Movement of one result vs the case's prior runs (scanHistory entries,
 * oldest first). The comparability rules — pin set included — live in the
 * shared module (src/core/shared/movement.ts); this maps a runner result onto its
 * inputs and keeps only the fields the CLI surfaces.
 * @returns {{ duration_delta_ms: number|null, score_delta: number|null,
 *   status_streak: string|null }|null} null when nothing compares
 */
function computeTrend(prior: DynamicValue[], result: DynamicValue) {
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
function makeReporter(opts: DynamicValue, trendFor: (result: DynamicValue) => DynamicValue = () => null, cases: DynamicValue[] = []) {
  // EXPLORED is wider than the journey labels: widen the status column up
  // front when the selection includes discovery cases.
  const labelWidth = cases.some((c) => c.mode === "discovery") ? "EXPLORED".length : 5;
  if (opts.json) {
    return {
      onEvent: (ev: DynamicValue) => {
        if (ev.type === "warn") console.error(ev.message);
      },
      done: () => {},
    };
  }
  if (process.stdout.isTTY) return new LiveReporter({ trendFor, labelWidth });
  return {
    onEvent: (ev: DynamicValue) => {
      if (ev.type === "case_end") console.log(caseLine(ev.result, trendFor(ev.result), labelWidth));
      else if (ev.type === "warn") console.error(ev.message);
    },
    done: (results: DynamicValue[]) => {
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
// own toolchain and an unused Chromium is never installed. See preflight.ts.
async function preflightDrivers(cases: DynamicValue[], opts: DynamicValue) {
  for (const driver of [...new Set(cases.map((c) => c.env.driver ?? "web"))]) {
    await preflightFor(driver, opts);
  }
}

function environmentLine(cases: DynamicValue[], envName: string | null = null) {
  const sig = (c: DynamicValue) => JSON.stringify(c.env);
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
function driverLine(cases: DynamicValue[]) {
  if (!cases.length || !cases.every((c) => c.env.driver === cases[0].env.driver)) return null;
  const env = cases[0].env;
  let driver = env.driver;
  if (driver === "mobile" && env.platform) driver += ` (${env.platform})`;
  const all = (pick: (c: DynamicValue) => boolean) => cases.every(pick);
  const chips: string[] = [];
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
async function discoverWithEnv(paths: string[], opts: DynamicValue) {
  let env = opts.env ?? null;
  const discover = () => discoverCases(paths, { tags: opts.tag, ids: opts.id, baseUrl: opts.baseUrl ?? null, env });
  const interactive = process.stdout.isTTY && process.stdin.isTTY && !opts.json;
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
function assertionsLine(cases: DynamicValue[]) {
  const names = new Set<string>();
  for (const c of cases) for (const a of c._assertions?.assertions ?? []) names.add(a.name);
  if (!names.size) return null;
  return `Loaded assertions: [${[...names].sort().join(", ")}]`;
}

async function prepareRun(paths: string[], opts: DynamicValue, { label, afterValidation = null, afterDiscovery = null, showAssertions = false }: PrepareRunHooks) {
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
function printNextActions(results: DynamicValue[], runsDir: string) {
  const changed = results.some((res) => res.status === "pass" && res.manifest?.healed);
  const failed = results.some((res) => res.status === "fail");
  const line = (label: string, rest: string) => console.log(label.padEnd(18) + rest);
  console.log("");
  line("View results:", "playtest view");
  if (changed) line("Review changes:", "playtest view --changed");
  if (failed) line("Open failed runs:", "playtest view --failed");
  line("CI artifacts:", runsDir);
}

// A changed journey from THIS run: a passing healed result whose candidate
// files still exist and still point at this rundir (a sibling repeat run or
// a parallel job for the same case may already have superseded them).
// A run awaiting an explicit `playtest baseline accept`: a healed journey, or a
// recording the acceptance leak scan refused to save automatically
// (docs/contracts/interfaces.md#baseline-review-and-grading). Both leave the
// same pending candidate, so both are reviewed and accepted the same way.
function isPendingChanged(res: DynamicValue) {
  if (res.status !== "pass" || !res.runDir) return false;
  if (!res.manifest?.healed && !res.manifest?.baseline_scan?.blocked) return false;
  const caseFile = res.manifest.case?.file;
  return typeof caseFile === "string" && candidateMatchesRun(readCandidate(caseFile), res.runDir, res.manifest.run_id);
}
const pendingChanged = (results: DynamicValue[]) => results.filter(isPendingChanged);

// The --json machine summary: one object on stdout, mirrors internal naming
// (mode stays record/act/heal/explore; changed marks a pending candidate).
// Trend fields are null when the case has no prior runs in the runs root.
function jsonSummary(results: DynamicValue[], { runId, runsRoot, exitCode, trendFor }: DynamicValue) {
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
          .filter((c: DynamicValue) => !c.pass)
          .map((c: DynamicValue) => ({ spec: c.spec, detail: c.detail, severity: c.severity ?? "hard" })),
      };
    }),
  };
}

// --fail-on-changed: a CI gate that treats unreviewed changed journeys as a
// failure. Listed on stderr under --json so stdout stays one JSON object.
function printChangedGate(pending: DynamicValue[], { toStderr = false }: { toStderr?: boolean } = {}) {
  const log = toStderr ? console.error : console.log;
  log(`\nfail-on-changed: ${pending.length} changed journey(s) need review`);
  for (const res of pending) {
    log(`  ${res.manifest.case.id}  playtest baseline accept ${shellQuote(path.relative(process.cwd(), res.runDir))}`);
  }
}

/**
 * Interactive review of pending changed journeys, then the resume lines.
 * Exit code is already set by runAll; opening the viewer just keeps serving.
 * @param {object[]} pending pendingChanged() results
 * @param {{ runsRoot: string, json?: boolean }} opts
 */
async function promptChanged(pending: DynamicValue[], opts: DynamicValue) {
  const interactive = process.stdout.isTTY && process.stdin.isTTY && !opts.json;
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
            } catch (e: any) { // SAFETY: the CLI preserves legacy stack/message handling for arbitrary thrown values
              console.error(`playtest: ${e instanceof DummyConfigError ? e.message : (e.stack ?? e.message)}`);
            }
          }
        },
      });
    } catch {} // stdin closed mid-prompt: treat as declined
  }
  const line = (label: string, rest: string) => console.log(label.padEnd(20) + rest);
  console.log("");
  line("Review later with:", "playtest view --changed");
  pending.forEach((res, i) =>
    line(i === 0 ? "Accept later with:" : "", `playtest baseline accept ${shellQuote(path.relative(process.cwd(), res.runDir))}`),
  );
}

function printPersonas() {
  const personas = listPersonas(process.cwd());
  const rows: Array<[string, string]> = personas.map((p) => [p.name, p.file ? path.relative(process.cwd(), p.file) : "(built-in)"]);
  const width = Math.max("PERSONA".length, ...rows.map((r) => r[0].length));
  console.log(`${"PERSONA".padEnd(width)}  SOURCE`);
  for (const [name, source] of rows) console.log(`${name.padEnd(width)}  ${source}`);
}
// The default command: `playtest test-stories/` === `playtest run test-stories/`.
// Help shows invocation intent; automation and policy flags remain callable
// without crowding the everyday surface.
program
  .command("run", { isDefault: true, hidden: true })
  .description("run the cases discovered under the given paths")
  .argument("[paths...]", "case files and/or directories", ["."])
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--base-url <url>", "override app.base_url (forces external mode)")
  .option("--env <name>", "select a named environment from app.envs")
  .option("--fresh", "force fresh recordings without replacing saved paths", false)
  .option("--junit <path>", "write a JUnit XML report")
  .option("--no-grade", "skip the grader")
  .option("--headed", "show the browser", false)
  .option("--json", "print one machine-readable JSON summary on stdout", false)
  .addOption(hiddenOption("--id <id>", "only the case with this id", { parser: collect, defaultValue: [] }))
  .addOption(hiddenOption("--parallel [n]", "override configured worker concurrency"))
  .addOption(hiddenOption("--parallel-record <n>", "override configured recording concurrency"))
  .addOption(hiddenOption("--runs-root <dir>", "where run directories are written", { defaultValue: "runs" }))
  .addOption(hiddenOption("--fail-on-changed", "exit 1 for pending changed journeys", { defaultValue: false }))
  .action(run(async (paths, opts) => {
    const mode = opts.fresh ? "agent" : "auto";
    const { cases, runId, runsDir } = await prepareRun(paths, opts, {
      label: "run",
      showAssertions: true,
      afterDiscovery: (selected) => {
        // Preflight the model when the run will need one: grading (default on),
        // --fresh, or ANY selected case that must record (a fresh case with no
        // saved baseline). This must run AFTER discovery so willRecord can see the
        // real baselines — otherwise `--no-grade` on a never-recorded case would skip
        // the preflight and surface a cryptic per-step 401 mid-record. The one truly
        // keyless path is --no-grade acting against saved baselines (nothing records).
        if (opts.grade || mode === "agent" || selected.some((rc) => willRecord(rc, { mode, refresh: false }))) {
          requireModel();
        }
      },
    });
      const trendFor = makeTrendFor(scanHistory(opts.runsRoot)); // before this run writes manifests
      const { exitCode, results } = await runAll(cases, {
        mode,
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
function viewJson(root: string, opts: DynamicValue) {
  const provider = isBundlePath(root) ? BundleProvider.fromFile(root) : new LocalFsProvider(root);
  const singleRun = isBundlePath(root) || fs.existsSync(path.join(root, "manifest.json"));
  if (opts.changed) {
    const entries = changedJourneys(provider, path.resolve(root), singleRun);
    return opts.case ? entries.filter((e) => e.case_id === opts.case) : entries;
  }
  let entries = singleRun ? singleRunJson(provider) : listRuns(provider);
  if (opts.failed) entries = entries.filter((e) => e.status === "fail" || e.status === "infra");
  if (opts.case) entries = entries.filter((e) => e.case_id === opts.case);
  return opts.latest ? entries.slice(0, 1) : entries; // listRuns sorts newest first
}

function singleRunJson(provider: StorageProvider) {
  try {
    const m = JSON.parse(provider.readText("manifest.json") as string); // SAFETY: JSON.parse(null) preserves the legacy empty-provider failure path
    return [{
      run_id: m.run_id ?? null,
      case_id: m.case?.id ?? null,
      path: "",
      status: m.result?.status ?? null,
      mode: m.mode ?? null,
      healed: m.healed ?? false,
      started_at: m.started_at ?? null,
      duration_ms: m.duration_ms ?? null,
      story: m.case?.story ?? null,
      description: m.case?.description ?? null,
      tags: m.case?.tags ?? [],
    }];
  } catch {
    return [];
  }
}

program
  .command("view")
  .description("open the GUI to inspect runs and review changed journeys")
  .argument("[run_or_root]", "a run directory or a runs root (default: the nearest runs/ dir)")
  .option("--latest", "open the most recent run instead of the picker", false)
  .option("--changed", "open the review list of changed journeys", false)
  .option("--failed", "show only failed and infra runs", false)
  .option("--case <id>", "show only this case (with --latest: open its most recent run)")
  .addOption(hiddenOption("--json", "print the run list as JSON", { defaultValue: false }))
  .addOption(hiddenOption("--port <n>", "viewer server port", { defaultValue: "0" }))
  .addOption(hiddenOption("--no-open", "do not open a browser"))
  .action(run(async (dir, opts) => {
    if (opts.changed && opts.failed) die("--changed and --failed are mutually exclusive");
    if (opts.latest && (opts.changed || opts.failed)) die("--latest opens a single run; --changed/--failed filter the picker");
    const port = parsePort(opts.port);
    const root = findRunsRoot(dir ?? null);
    if (opts.json) {
      // No server, no browser: --port/--no-open are ignored under --json.
      console.log(JSON.stringify(viewJson(root, opts)));
      return;
    }
    if (opts.latest) {
      if (isBundlePath(root)) return serveRun(root, { port, open: opts.open });
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

// `install-skill` (new.ts): the packaged agent skills, installed into the project
// (real files under .agents/skills/, symlinked into .claude/skills/) so they
// version with the installed harness's --json contract.
program
  .command("install-skill")
  .description("install the playtest agent skills into .agents/skills/ (symlinked into .claude/skills/)")
  .option("--force", "overwrite a locally modified skill file", false)
  .action(run(async (opts) => installSkill(opts)));

// `clip` (clip.ts): a slideshow video.mp4 + WebVTT sidecar stitched from a run's
// per-step stills (a legacy run carrying a real video.webm still emits a .webm
// pair); --burn makes the self-contained variant (H.264 MP4, GitHub-renderable)
// via system ffmpeg (optional dependency).
const clipCommand = program
  .command("clip")
  .description("cut a subtitled clip from a run (slideshow .mp4 + WebVTT sidecar; legacy screencast runs emit a .webm pair)")
  .argument("<target>", "an exact run directory or a case id (latest run)")
  .option("--captions <style>", "caption source: action (Click “Checkout”) | thought (agent narration)", "action")
  .option("--burn", "burn captions + status watermark into a single MP4 (H.264, plays in a GitHub PR; needs system ffmpeg)", false)
  .option("--out <dir>", "output directory (default: the run directory)")
  .action(run(async (target, opts) => clip(target, opts)));

// `export` (export-playwright.ts): a ONE-WAY render of each web case's accepted
// baseline as a standalone @playwright/test spec. An escape hatch and an
// inspection tool — Playtest never reads the file back and never heals it
// (docs/contracts/interfaces.md#playwright-export). Visible in --help on
// purpose: hiding a trust feature defeats it.
// `--out` can point anywhere, so prefer a cwd-relative path but fall back to the
// absolute one rather than printing a ../../.. ladder out of the project.
function displayPath(p: string) {
  const rel = path.relative(process.cwd(), p);
  return !rel || rel.startsWith("..") ? p : rel;
}

async function exportPlaywright(paths: string[], opts: DynamicValue) {
  const cases = await discoverCases(paths, { tags: opts.tag, ids: opts.id, baseUrl: opts.baseUrl ?? null, env: opts.env ?? null });
  if (!cases.length) {
    console.log(emptySelectionHint(opts));
    return;
  }
  const outDir = path.resolve(opts.out);
  const written: DynamicValue[] = [];
  const skipped: string[] = [];
  for (const c of cases) {
    if (c.mode === "discovery") {
      skipped.push(`${c.id}: discovery studies explore rather than replay a saved path — nothing to export`);
      continue;
    }
    const driver = c.env?.driver ?? "web";
    if (driver !== "web") {
      skipped.push(`${c.id}: export supports web cases; this one uses driver "${driver}"`);
      continue;
    }
    const baseline = readBaseline(c.file);
    if (!baseline) {
      skipped.push(`${c.id}: no saved path yet — run the case first (playtest ${displayPath(c.file)})`);
      continue;
    }
    const { filename, code, notes } = exportSpec({
      caseCfg: c,
      envelopes: baseline.envelopes,
      meta: baseline.meta,
      sourcePath: displayPath(c.file),
    });
    const target = path.join(outDir, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code);
    written.push({ id: c.id, target, notes });
    // The accepted baseline is the truth, so a pending candidate does not block
    // the export — but exporting a path that is under review, silently, would be
    // the wrong kind of surprise.
    if (fs.existsSync(baselinePaths(c.file).healedTraj)) {
      written[written.length - 1].notes = [
        `a changed journey is pending review — this spec is the ACCEPTED path, not the candidate`,
        ...notes,
      ];
    }
  }

  for (const w of written) {
    console.log(`${w.id} → ${displayPath(w.target)}`);
    for (const n of w.notes) console.log(`  note: ${n}`);
  }
  for (const s of skipped) console.log(`skipped ${s}`);
  if (written.length) {
    console.log(
      `\n${written.length} spec(s) in ${displayPath(outDir)}.` +
        ` These are one-way snapshots: Playtest never reads them back and will not heal them.` +
        `\nRun them with: npx playwright test ${displayPath(outDir)}`,
    );
  }
}

program
  .command("export")
  .description("render saved journey paths as standalone Playwright specs (one-way; never read back)")
  .argument("[paths...]", "case files and/or directories", ["."])
  .option("--out <dir>", "output directory", "playwright-export")
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--base-url <url>", "bake this base_url into the specs instead of the case's")
  .option("--env <name>", "select a named environment from app.envs")
  .addOption(hiddenOption("--id <id>", "only this case", { parser: collect, defaultValue: [] }))
  .action(run(exportPlaywright));

// `script` (script.ts): executable API test suites — the script-authoring track
// (docs/contracts/scripts.md). `author` runs one bounded authoring job against a
// target its owner authorized and prints the findings its suite produced. The
// approval lifecycle lives in the hosted product (DESIGN N3); locally the suite
// is a plain file and the team's own code review is the approval.
const scriptCommand = program
  .command("script")
  .description("author and inspect executable API test suites")
  .addHelpText("after", "\nExamples:\n  playtest script author api-suite.json          author a suite, print its findings\n  playtest script author api-suite.json --prepare  write the handout only, no model call\n");

scriptCommand
  .command("author")
  .description("run one bounded authoring job (spec + approved rules → a sound suite)")
  .argument("<job>", "an authoring job file (docs/contracts/scripts.md#the-authoring-loop)")
  .option("--out <dir>", "where to write the handout, executions, transcript, and bundle")
  .option("--prepare", "assemble and write the handout, then stop — no model call, no execution", false)
  .action(run(async (file, opts) => {
    if (!opts.prepare) requireModel();
    process.exitCode = await scriptAuthor(file, { outDir: opts.out, prepare: opts.prepare });
  }));

// `findings` (findings.ts): the local, suite-scoped SQLite ledger that gives bug
// candidates recorded in run grades a durable cross-run identity and lifecycle.
// Identity and lifecycle only — run directories stay the evidence, and the
// ledger stores references to them, never bytes
// (docs/contracts/interfaces.md#local-findings-ledger).
const findingsCommand = program
  .command("findings")
  .description("triage durable bugs found across runs (local suite ledger)")
  .addHelpText(
    "after",
    "\nExamples:\n" +
      "  playtest findings consolidate         take recorded bug candidates into the ledger\n" +
      "  playtest findings list --candidates   what is waiting for a decision\n" +
      "  playtest findings accept <id>         a candidate becomes a durable finding\n" +
      "  playtest findings export --out f.json portable JSON (the .db file never travels)\n",
  );

const suiteOption = (command: Command) =>
  command.addOption(hiddenOption("--suite <dir>", "the suite whose ledger to use (default: the nearest playtest.yaml)"));

suiteOption(
  findingsCommand
    .command("list", { isDefault: true })
    .description("list durable findings (or --candidates awaiting a decision)")
    .option("--candidates", "list bug candidates instead of findings", false)
    .option("--state <state>", "only findings in this state (new|accepted|rejected|resolved|reopened)")
    .option("--status <status>", "with --candidates: unassigned|assigned|dismissed", "unassigned")
    .option("--json", "print the list as JSON", false),
).action(run(async (opts) => findingsList(opts)));

suiteOption(
  findingsCommand
    .command("show")
    .description("show one finding or bug candidate with all its evidence references")
    .argument("<id>")
    .option("--json", "print the record as JSON", false),
).action(run(async (id, opts) => findingsShow(id, opts)));

suiteOption(
  findingsCommand
    .command("consolidate")
    .description("take recorded bug candidates into the ledger and propose groupings (never applied unconfirmed)")
    .option("--runs-root <dir>", "where run directories are read from (default: the nearest runs/ dir)")
    .option("--plan <file>", "where to write the proposed plan")
    .option("--apply-plan <file>", "apply a previously written plan")
    .option("--only <id>", "with --apply-plan: apply only these proposal ids (repeatable)", collect, [])
    .option("--no-cluster-model", "skip the cluster call; report every cluster unresolved")
    .option("--json", "print the result as JSON", false)
    .addOption(hiddenOption("--model <name>", "model for the cluster call", { defaultValue: "sonnet" })),
).action(run(async (opts) => findingsConsolidate(opts)));

suiteOption(
  findingsCommand
    .command("accept")
    .description("accept a bug candidate as a durable finding, or accept an existing finding")
    .argument("<id>")
    .option("--title <title>", "title for the finding a candidate creates")
    .option("--note <note>", "note recorded with the transition")
    .option("--json", "print the result as JSON", false),
).action(run(async (id, opts) => findingsAccept(id, opts)));

suiteOption(
  findingsCommand
    .command("reject")
    .description("reject a finding, or dismiss a bug candidate and suppress its exact recurrences")
    .argument("<id>")
    .option("--reason <reason>", "not_a_bug | wont_fix | duplicate (candidates only)", "not_a_bug")
    .option("--note <note>", "note recorded with the transition")
    .option("--json", "print the result as JSON", false),
).action(run(async (id, opts) => findingsReject(id, opts)));

suiteOption(
  findingsCommand
    .command("resolve")
    .description("mark a finding fixed; an exact recurrence reopens it")
    .argument("<id>")
    .option("--note <note>", "note recorded with the transition")
    .option("--json", "print the result as JSON", false),
).action(run(async (id, opts) => findingsResolve(id, opts)));

suiteOption(
  findingsCommand
    .command("export")
    .description("write the portable findings export (JSON); the ledger file itself is not portable")
    .option("--out <file>", "write to this file instead of stdout")
    .option("--json", "single-line JSON on stdout", false),
).action(run(async (opts) => findingsExport(opts)));

const baselineCommand = program
  .command("baseline")
  .description("review and replace saved journey paths");

async function refreshPaths(paths: string[], opts: DynamicValue) {
  const { cases, runId } = await prepareRun(paths, opts, {
    label: "baseline refresh",
    afterValidation: () => requireModel(),
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
}

function configureRefresh(command: Command) {
  return command
    .description("replace saved paths with fresh passing recordings")
    .argument("<paths...>", "case files and/or directories")
    .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
    .option("--base-url <url>", "override app.base_url (forces external mode)")
    .option("--env <name>", "select a named environment from app.envs")
    .option("--headed", "show the browser", false)
    .addOption(hiddenOption("--id <id>", "only this case", { parser: collect, defaultValue: [] }))
    .addOption(hiddenOption("--parallel [n]", "override configured worker concurrency"))
    .addOption(hiddenOption("--parallel-record <n>", "override configured recording concurrency"))
    .addOption(hiddenOption("--runs-root <dir>", "where run directories are written", { defaultValue: "runs" }))
    .action(run(refreshPaths));
}

configureRefresh(baselineCommand.command("refresh"));

program
  .command("list", { hidden: true })
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
    const widths = [0, 1, 2].map((i) => Math.max("ID TAGS PERSONA".split(" ")[i]!.length, ...rows.map((r) => r[i]!.length))); // SAFETY: fixed headers and rows always contain these columns
    const line = (r: string[]) => r.map((cell: string, i: number) => (i < 3 ? cell.padEnd(widths[i]!) : cell)).join("  "); // SAFETY: widths is built for the first three columns
    console.log(line(["ID", "TAGS", "PERSONA", "NEXT-RUN"]));
    for (const r of rows) console.log(line(r));
  }));

program
  // Static quality lint: reuses discoverCases (so schema/config errors still
  // exit 2 via run()), then flags content the schema can't — empty/duplicate
  // asserts, a journey with no gate, an assert that should be a deterministic
  // kind. Warnings are advisory: lint always exits 0
  // (docs/contracts/interfaces.md#listing-linting-and-scaffolding).
  .command("lint", { hidden: true })
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
  .command("personas", { hidden: true })
  .description("List available personas (built-in and custom)")
  .action(run(async () => printPersonas()));

// `accept` core, also run by the end-of-run "Accept all?" prompt. Throws
// DummyConfigError on bad input (the command wrapper turns that into exit 2).
function acceptRun(runDir: string) {
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
  // The acceptance leak scan (docs/contracts/interfaces.md#baseline-review-and-grading).
  // Naming a run here IS the human approval, so findings never block this path —
  // they are shown, and the approval records a content-hash fingerprint of
  // exactly the bytes approved, so any later change is gated again.
  let scan: DynamicValue = { findings: [], fingerprint: null };
  try {
    scan = scanRun(dir, {
      redact: manifest.case?.redact ?? null,
      driver: manifest.pins?.driver ?? manifest.env?.driver ?? "web",
      secretNames: manifest.case?.secrets ?? null,
    });
  } catch {}
  if (scan.findings.length) {
    console.log(`leak scan: approving ${scan.findings.length} finding(s) into the committed baseline:`);
    for (const line of describeFindings(scan.findings)) console.log(line);
  }
  let meta;
  if (candidateMatchesRun(candidate, dir, manifest.run_id)) {
    // This run produced the pending candidate: promote it
    // (docs/contracts/artifacts.md#baseline-files),
    // keeping its healed_from_run_id provenance.
    meta = promoteHealed(caseFile, { scan });
  } else {
    if (candidate) {
      // Accepting a named run is deliberate: supersede the pending candidate,
      // but say so rather than dropping it silently.
      console.log(
        `note: pending changed journey from run ${candidate.run_id ?? "(unknown)"}` +
          ` (${candidate.run_dir ?? "?"}) is superseded by this accept`,
      );
    }
    meta = acceptBaseline(caseFile, dir, { scan, approved: true });
    fs.rmSync(p.healedTraj, { force: true });
    fs.rmSync(p.healedMeta, { force: true });
  }
  console.log(`accepted ${manifest.case.id} — new saved path from run ${meta.run_id}\n  ${p.traj}`);
}

function configureAccept(command: Command) {
  return command
    .description("accept a passing run as its case's saved path")
    .argument("<runDir>", "the exact reviewed run directory")
    .action(run(async (runDir) => acceptRun(runDir)));
}

function rejectRun(runDir: string) {
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
}

function configureReject(command: Command) {
  return command
    .description("reject a run's pending changed path (run artifacts are kept)")
    .argument("<runDir>")
    .action(run(async (runDir) => rejectRun(runDir)));
}

configureAccept(baselineCommand.command("accept"));
configureReject(baselineCommand.command("reject"));

// Repair one run whose original grader call failed, without replaying the app.
async function gradeOneRun(runDir: string) {
  const manifest = readManifest(runDir);
  const rc = { ...manifest.case, grader_model: manifest.pins?.grader_model ?? "sonnet" };
  const grade = await gradeRun(path.resolve(runDir), rc);
  manifest.artifacts.grade = "grade.json";
  fs.writeFileSync(path.join(path.resolve(runDir), "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return grade;
}

program
  .command("grade", { hidden: true })
  .description("(re)grade an existing run")
  .argument("<runDir>", "the exact run directory")
  .action(run(async (runDir) => {
    requireModel();
    const grade = await gradeOneRun(runDir);
    console.log(`score ${grade.score}/100 · completion ${grade.completion}`);
    console.log(grade.summary);
  }));

program.parseAsync().catch((e: any) => die(e.message)); // SAFETY: Commander rejection values are treated as Error-like by the existing CLI contract
