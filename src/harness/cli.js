#!/usr/bin/env node
// `dummy` command wiring. See docs/CONTRACTS.md §12.
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { discoverCases, DummyConfigError } from "./config.js";
import {
  newRunId,
  readTrajectory,
  readBaseline,
  baselinePaths,
  blessBaseline,
  actionTrack,
  diffTracks,
  HARNESS_VERSION,
} from "./trajectory.js";
import { runAll } from "./runner.js";
import { gradeRun } from "./grader.js";
import { llmConfig } from "./llm.js";
import { serveRun } from "./view-server.js";

const program = new Command();
program
  .name("dummy")
  .description("Agentic regression testing: an AI agent role-plays a user against your app.")
  .version(HARNESS_VERSION);

const collect = (v, all) => [...all, v];

// Exit codes: 0 pass, 1 gate failure, 2 infra/config (see docs/dummy-design.md).
function die(message) {
  console.error(`dummy: ${message}`);
  process.exit(2);
}

const run = (fn) => (...args) =>
  Promise.resolve(fn(...args)).catch((e) => die(e instanceof DummyConfigError ? e.message : (e.stack ?? e.message)));

function readManifest(runDir) {
  const file = path.join(path.resolve(runDir), "manifest.json");
  if (!fs.existsSync(file)) die(`${runDir} is not a run directory (no manifest.json)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

program
  .command("run")
  .description("run the cases discovered under the given paths")
  .argument("<paths...>", "case files and/or directories")
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--mode <mode>", "auto (act baselines, else record) | agent (force fresh record)", "auto")
  .option("--base-url <url>", "override env.base_url (forces external mode)")
  .option("--parallel [n]", "run cases in parallel (default pool when n omitted)")
  .option("--junit <path>", "write a JUnit XML report")
  .option("--no-grade", "skip the grader")
  .option("--headed", "show the browser", false)
  .option("--runs-root <dir>", "where run directories are written", "runs")
  .action(run(async (paths, opts) => {
    if (!["auto", "agent"].includes(opts.mode)) die(`invalid --mode ${opts.mode} (auto|agent)`);
    const cases = await discoverCases(paths, { tags: opts.tag, baseUrl: opts.baseUrl ?? null });
    if (!cases.length) die("no cases matched");
    const runId = newRunId();
    console.log(`run ${runId} — ${cases.length} case(s) → ${path.join(opts.runsRoot, runId)}\n`);
    const { exitCode } = await runAll(cases, {
      mode: opts.mode,
      runsRoot: opts.runsRoot,
      runId,
      grade: opts.grade,
      headed: opts.headed,
      parallel: opts.parallel === undefined ? null : opts.parallel === true ? true : Number(opts.parallel),
      junit: opts.junit ?? null,
      rebaseline: false,
    });
    process.exitCode = exitCode;
  }));

program
  .command("list")
  .description("show what a selection resolves to")
  .argument("<paths...>")
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .action(run(async (paths, opts) => {
    const cases = await discoverCases(paths, { tags: opts.tag });
    const rows = cases.map((c) => [
      c.id,
      c.tags.join(",") || "-",
      c.persona,
      readBaseline(c.file) ? "act" : "record",
    ]);
    const widths = [0, 1, 2].map((i) => Math.max("ID TAGS PERSONA".split(" ")[i].length, ...rows.map((r) => r[i].length)));
    const line = (r) => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("  ");
    console.log(line(["ID", "TAGS", "PERSONA", "NEXT-RUN"]));
    for (const r of rows) console.log(line(r));
  }));

program
  .command("view")
  .description("open the trajectory viewer on a run directory (or a runs root for a picker)")
  .argument("<dir>")
  .option("--port <n>", "port (0 = ephemeral)", "0")
  .option("--no-open", "do not open a browser")
  .action(run(async (dir, opts) => {
    await serveRun(dir, { port: Number(opts.port), open: opts.open });
  }));

program
  .command("diff")
  .description("action-track diff of a run against its case's current baseline")
  .argument("<runDir>")
  .action(run(async (runDir) => {
    const manifest = readManifest(runDir);
    const baseline = readBaseline(manifest.case.file);
    if (!baseline) die(`no baseline for ${manifest.case.id} (expected ${baselinePaths(manifest.case.file).traj})`);
    const a = actionTrack(baseline.envelopes);
    const b = actionTrack(readTrajectory(path.join(path.resolve(runDir), "trajectory.jsonl")));
    const { ops, summary } = diffTracks(a, b);
    const fmt = (env) => {
      const act = env.agent?.action ?? env.action ?? {};
      return [act.type, env.resolution?.locator ?? act.url ?? "", act.text != null ? JSON.stringify(act.text) : ""]
        .filter(Boolean)
        .join(" ");
    };
    const MARK = { same: "  = ", del: "  - ", add: "  + " };
    for (const op of ops) console.log(MARK[op.op] + fmt(op.a ?? op.b));
    console.log(`\n${summary.same} same, ${summary.del} removed, ${summary.add} added`);
  }));

program
  .command("bless")
  .description("bless this run's trajectory as its case's baseline")
  .argument("<runDir>")
  .action(run(async (runDir) => {
    const manifest = readManifest(runDir);
    const meta = blessBaseline(manifest.case.file, path.resolve(runDir));
    // a direct bless supersedes any pending healed candidate
    const p = baselinePaths(manifest.case.file);
    fs.rmSync(p.healedTraj, { force: true });
    fs.rmSync(p.healedMeta, { force: true });
    console.log(`blessed ${manifest.case.id} baseline from run ${meta.run_id}\n  ${p.traj}`);
  }));

program
  .command("rebaseline")
  .description("re-record baselines: force agent mode and bless on pass")
  .argument("<paths...>")
  .option("--tag <tag>", "only cases with this tag (repeatable)", collect, [])
  .option("--runs-root <dir>", "where run directories are written", "runs")
  .action(run(async (paths, opts) => {
    const cases = await discoverCases(paths, { tags: opts.tag });
    if (!cases.length) die("no cases matched");
    const runId = newRunId();
    console.log(`rebaseline ${runId} — ${cases.length} case(s)\n`);
    const { exitCode } = await runAll(cases, {
      mode: "agent",
      runsRoot: opts.runsRoot,
      runId,
      grade: true,
      headed: false,
      parallel: null,
      junit: null,
      rebaseline: true,
    });
    process.exitCode = exitCode;
  }));

program
  .command("grade")
  .description("(re)grade an existing run")
  .argument("<runDir>")
  .action(run(async (runDir) => {
    if (!llmConfig().available) die("grading needs a model: set DUMMY_LLM_BASE_URL or an API key");
    const manifest = readManifest(runDir);
    const rc = { ...manifest.case, grader_model: manifest.pins?.grader_model ?? "claude-sonnet-4-6" };
    const grade = await gradeRun(path.resolve(runDir), rc);
    manifest.artifacts.grade = "grade.json";
    fs.writeFileSync(path.join(path.resolve(runDir), "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`score ${grade.score}/100 · completion ${grade.completion}`);
    console.log(grade.summary);
  }));

program.parseAsync().catch((e) => die(e.message));
