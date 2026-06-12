#!/usr/bin/env node
// `playtest` command wiring. See docs/CONTRACTS.md §12.
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { discoverCases, DummyConfigError } from "./config.js";
import {
  newRunId,
  readBaseline,
  baselinePaths,
  acceptBaseline,
  promoteHealed,
  rejectHealed,
  HARNESS_VERSION,
} from "./trajectory.js";
import { runAll } from "./runner.js";
import { caseLine, summary } from "./report.js";
import { LiveReporter } from "./live.js";
import { gradeRun } from "./grader.js";
import { llmConfig } from "./llm.js";
import { serveRun, listRuns, changed as changedJourneys } from "./view-server.js";
import { findRunsRoot, latestRun, scanHistory } from "./runs-root.js";
import { promptChangedReview } from "./prompt.js";
import { ensureBrowser } from "./preflight.js";
import { demo } from "./demo.js";
import { newCase, newPersona } from "./new.js";
import { listPersonas } from "./actor.js";

const program = new Command();
program
  .name("playtest")
  .description("Run user journey tests: an AI agent records a working path through your app, and later runs check it still works.")
  .version(HARNESS_VERSION);

program.addHelpText(
  "after",
  `
Workflow:
  playtest [paths...]        run user journey tests (default: .)
  playtest demo              watch record → act → heal on the bundled todo app
  playtest new <name>        add a test case (creates config on first use)
  playtest view              open the GUI for runs and changed journeys
  playtest refresh <paths>   create fresh saved paths
  playtest list              list discovered suites and cases

A suite whose playtest.yaml sets "mode: discovery" runs as a study: cases end "explored" instead of pass/fail, and playtest view shows the evidence.

Advanced hidden commands also exist: run, accept, reject, grade — each supports --help.`,
);

const collect = (v, all) => [...all, v];

const NO_SUITES_HINT = "No Playtest suites found. Create one with: playtest new <case-name>";

// Exit codes: 0 pass, 1 gate failure, 2 infra/config (see docs/playtest-design.md).
function die(message) {
  console.error(`playtest: ${message}`);
  process.exit(2);
}

const run = (fn) => (...args) =>
  Promise.resolve(fn(...args)).catch((e) => die(e instanceof DummyConfigError ? e.message : (e.stack ?? e.message)));

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

const parseParallel = (v) => (v === undefined ? null : v === true ? true : Number(v));

// Trend context: the runs root is scanned
// once before runAll; each finished case is compared against its prior runs.
const makeTrendFor = (history) => (result) =>
  computeTrend(history.get(result.manifest?.case?.id) ?? [], result);

/**
 * Movement of one result vs the case's prior runs (scanHistory entries, oldest
 * first). Previous comparable run = most recent prior run by started_at,
 * preferring non-infra; same-run_id siblings are excluded. Scores compare
 * only graded-to-graded; the streak prints only on a status change and counts
 * over non-infra runs. Explored runs have no regression-trend semantics and
 * are excluded entirely, current and prior.
 * @returns {{ duration_delta_ms: number|null, score_delta: number|null,
 *             status_streak: string|null }|null} null when no prior runs
 */
function computeTrend(prior, result) {
  const m = result.manifest;
  if (!m || result.status === "infra" || result.status === "explored") return null;
  const entries = prior.filter((e) => e.run_id !== m.run_id && e.status !== "explored");
  if (!entries.length) return null;
  const nonInfra = entries.filter((e) => e.status !== "infra");
  const prev = (nonInfra.length ? nonInfra : entries).at(-1);
  const duration_delta_ms =
    m.duration_ms != null && prev.duration_ms != null ? m.duration_ms - prev.duration_ms : null;
  let status_streak = null;
  const last = nonInfra.at(-1);
  if (last && last.status !== result.status) {
    let n = 0;
    while (n < nonInfra.length && nonInfra.at(-1 - n).status === last.status) n++;
    status_streak = `first ${result.status} after ${n} ${last.status}${n === 1 ? "" : last.status === "pass" ? "es" : "s"}`;
  }
  let score_delta = null;
  if (result.score != null) {
    const graded = entries.findLast((e) => e.score != null);
    if (graded) score_delta = result.score - graded.score;
  }
  return { duration_delta_ms, score_delta, status_streak };
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
    done: (results) => console.log(summary(results)),
  };
}

// "Environment: ..." header line — only when every selected case resolves to
// the same env config; a mixed selection prints nothing.
function environmentLine(cases) {
  const sig = (c) => JSON.stringify(c.env);
  if (!cases.length || !cases.every((c) => sig(c) === sig(cases[0]))) return null;
  const env = cases[0].env;
  if (env.compose) {
    const rel = path.relative(process.cwd(), env.compose);
    return `Environment: managed compose ${rel.startsWith(".") ? rel : `./${rel}`}`;
  }
  return `Environment: external ${env.base_url}`;
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
// files still exist and still point at this run dir (a sibling repeat run or
// a parallel job for the same case may already have superseded them).
function isPendingChanged(res) {
  if (res.status !== "pass" || !res.manifest?.healed || !res.runDir) return false;
  const caseFile = res.manifest.case?.file;
  return typeof caseFile === "string" && candidateMatchesRun(readCandidate(caseFile), res.runDir, res.manifest.run_id);
}

const pendingChanged = (results) => results.filter(isPendingChanged);

// The --json machine summary: one object on stdout, mirrors internal naming
// (mode stays record/act/heal/explore; `changed` marks a pending candidate).
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
          .map((c) => ({ spec: c.spec, detail: c.detail })),
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

// The default command: `playtest tests/` ≡ `playtest run tests/`. Exact
// subcommand names win, so `playtest view` never falls through to here.
program
  .command("run", { isDefault: true, hidden: true })
  .description("run the cases discovered under the given paths")
  .argument("[paths...]", "case files and/or directories", ["."])
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--mode <mode>", "auto (follow saved paths, else record) | agent (force fresh record)", "auto")
  .option("--base-url <url>", "override app.base_url (forces external mode)")
  .option("--parallel [n]", "run cases in parallel (default pool when n omitted)")
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
    await ensureBrowser(opts); // pinned chromium only — no chrome fallback for measured runs
    const cases = await discoverCases(paths, { tags: opts.tag, baseUrl: opts.baseUrl ?? null });
    if (!cases.length) {
      // Suites were found but the tag filter excluded everything: the
      // onboarding hint would mislead, so name the filter instead.
      if (opts.tag.length) die(`no cases matched --tag ${opts.tag.join(", ")}`);
      console.error(NO_SUITES_HINT);
      process.exit(2);
    }
    const runId = newRunId();
    const runsDir = path.join(opts.runsRoot, runId);
    if (!opts.json) {
      console.log(`run ${runId} — ${cases.length} case(s) → ${runsDir}`);
      const envLine = environmentLine(cases);
      if (envLine) console.log(envLine);
      console.log("");
    }
    const trendFor = makeTrendFor(scanHistory(opts.runsRoot)); // before this run writes manifests
    const { exitCode, results } = await runAll(cases, {
      mode: opts.mode,
      runsRoot: opts.runsRoot,
      runId,
      grade: opts.grade,
      headed: opts.headed,
      parallel: parseParallel(opts.parallel),
      junit: opts.junit ?? null,
      refresh: false,
      reporter: makeReporter(opts, trendFor, cases),
    });
    const pending = pendingChanged(results);
    // exit-code contract: 0 pass/explored, 1 gate failure, 2 infra.
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
  .argument("[dir]", "target directory (default: the nearest suite, else ./tests)")
  .option("--force", "overwrite an existing case file", false)
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
 * --changed -> changed-journey entries; --failed -> fail/infra runs only;
 * --case filters by case id; --latest narrows to the single most recent run.
 */
function viewJson(root, opts) {
  if (opts.changed) {
    const entries = changedJourneys(root, fs.existsSync(path.join(root, "manifest.json")));
    return opts.case ? entries.filter((e) => e.case_id === opts.case) : entries;
  }
  let entries = listRuns(root);
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
    const root = findRunsRoot(dir ?? opts.runsRoot ?? null);
    if (opts.json) {
      // No server, no browser: --port/--no-open are ignored under --json.
      console.log(JSON.stringify(viewJson(root, opts)));
      return;
    }
    if (opts.latest) {
      const hit = latestRun(root, opts.case ?? null);
      if (!hit) die(`no runs${opts.case ? ` of case ${opts.case}` : ""} found under ${root}`);
      return serveRun(hit.dir, { port: Number(opts.port), open: opts.open });
    }
    const q = new URLSearchParams();
    if (opts.changed) q.set("filter", "changed");
    if (opts.failed) q.set("filter", "failed");
    if (opts.case) q.set("case", opts.case);
    await serveRun(root, { port: Number(opts.port), open: opts.open, query: q.size ? `?${q}` : "" });
  }));

// `refresh` re-records and accepts passing runs.
program
  .command("refresh")
  .description("create fresh saved paths from scratch (re-record and save passing runs)")
  .argument("<paths...>", "case files and/or directories")
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--base-url <url>", "override app.base_url (forces external mode)")
  .option("--parallel [n]", "run cases in parallel (default pool when n omitted)")
  .option("--headed", "show the browser", false)
  .option("--runs-root <dir>", "where run directories are written", "runs")
  .option("--ci", "non-interactive CI mode: plain output", false)
  .option("--plain", "plain line-per-case output (no live status region)", false)
  .option("--no-tui", "same as --plain")
  .action(run(async (paths, opts) => {
    await ensureBrowser(opts); // pinned chromium only — no chrome fallback for measured runs
    const cases = await discoverCases(paths, { tags: opts.tag, baseUrl: opts.baseUrl ?? null });
    if (!cases.length) die("no cases matched");
    const runId = newRunId();
    console.log(`refresh ${runId} — ${cases.length} case(s)`);
    const envLine = environmentLine(cases);
    if (envLine) console.log(envLine);
    console.log("");
    const { exitCode } = await runAll(cases, {
      mode: "agent",
      runsRoot: opts.runsRoot,
      runId,
      grade: true,
      headed: opts.headed,
      parallel: parseParallel(opts.parallel),
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
  .option("--json", "print the list as a JSON array", false)
  .action(run(async (paths, opts) => {
    const cases = await discoverCases(paths, { tags: opts.tag });
    // With a tag filter, an empty result means "nothing matched", not "no
    // suites" — the onboarding hint would mislead. list always exits 0.
    const emptyHint = opts.tag.length ? `playtest: no cases matched --tag ${opts.tag.join(", ")}` : NO_SUITES_HINT;
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
      c.persona,
      c.mode === "discovery" ? "explore" : readBaseline(c.file) ? "check" : "record",
    ]);
    const widths = [0, 1, 2].map((i) => Math.max("ID TAGS PERSONA".split(" ")[i].length, ...rows.map((r) => r[i].length)));
    const line = (r) => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("  ");
    console.log(line(["ID", "TAGS", "PERSONA", "NEXT-RUN"]));
    for (const r of rows) console.log(line(r));
  }));

program
  .command("personas")
  .description("list available personas (built-in and custom)")
  .action(run(async () => printPersonas()));

// `accept` core, also run by the end-of-run "Accept all?" prompt. Throws
// DummyConfigError on bad input (the command wrapper turns that into exit 2).
function acceptRun(runDir) {
  const dir = path.resolve(runDir);
  const manifest = readManifest(runDir);
  // Acceptance safety: accepting rewrites a versioned baseline, so refuse
  // bad inputs outright — there is deliberately no --force.
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

program
  .command("accept", { hidden: true })
  .description("accept this run's trajectory as its case's new saved path (baseline)")
  .argument("<runDir>")
  .action(run(async (runDir) => acceptRun(runDir)));

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

program
  .command("grade", { hidden: true })
  .description("(re)grade an existing run")
  .argument("<runDir>")
  .action(run(async (runDir) => {
    if (!llmConfig().available) die("grading needs a model: set PLAYTEST_LLM_BASE_URL or an API key");
    const manifest = readManifest(runDir);
    const rc = { ...manifest.case, grader_model: manifest.pins?.grader_model ?? "claude-sonnet-4-6" };
    const grade = await gradeRun(path.resolve(runDir), rc);
    manifest.artifacts.grade = "grade.json";
    fs.writeFileSync(path.join(path.resolve(runDir), "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`score ${grade.score}/100 · completion ${grade.completion}`);
    console.log(grade.summary);
  }));

program.parseAsync().catch((e) => die(e.message));
