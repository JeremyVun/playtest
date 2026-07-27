// Recording-performance baseline harness (docs/backlog/perf/BUILD_PLAN.md T0.2).
//
// Runs a SHORT and a LONG recording at suite concurrency 1, 2, and 4, then
// reports p50/p95 per perf.jsonl span, peak RSS, and artifact bytes by type.
// Every phase of the perf plan is accepted against numbers this produces, so it
// has to be repeatable: no network, no model credentials, no Docker, no
// database. A workbench, not a test — nothing in `npm test` runs it.
//
//   node tools/perf/baseline.mjs                 # api workload (no browser)
//   node tools/perf/baseline.mjs --driver=web    # real Chromium, local fixture
//   node tools/perf/baseline.mjs --json out.json
//
// Two local fixtures stand in for the system under test — the invariant-api
// ledger and the todo-app page, both already used by the offline suites — and a
// STEP-ADDRESSED gateway below stands in for the model. The gateway answers from
// the step number in the prompt rather than from a call counter, because at
// concurrency 2 and 4 several cases share one endpoint and a counter would
// interleave their journeys.
//
// What this measures and what it does not:
//
//   * IT MEASURES harness work: capture, settle, dispatch, artifact writes, HAR,
//     teardown, video, and the scheduler — everything phases 1, 2, 4, and 5
//     change.
//   * IT DOES NOT measure model latency. A loopback gateway answers in about a
//     millisecond, where a real actor turn is tens of seconds (ANALYSIS.md:
//     25.0 s p50). Read `actor_request` here as harness overhead per turn, never
//     as a turn's real duration.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCases } from "../../packages/core/src/config.ts";
import { runAll } from "../../packages/core/src/runner.ts";
import { newRunId } from "../../packages/core/src/trajectory.ts";
import { start as startTodoApp } from "../../tests/fixtures/todo-app/server.ts";
import { startInvariantApi } from "../../tests/fixtures/invariant-api/server.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Cases per cell. Four is the smallest number that lets concurrency 4 actually
// run four at once while concurrency 1 still averages over four recordings.
const CASES_PER_CELL = 4;
const SHORT_STEPS = 5;
const LONG_STEPS = 20;
const CONCURRENCIES = [1, 2, 4];
const RSS_SAMPLE_MS = 50;

// ---------------------------------------------------------------- workloads

/**
 * The api workload: a ledger journey of real HTTP round-trips against the
 * invariant-api fixture. Every step is one request plus one snapshot projection.
 */
function apiSteps(count) {
  const steps = [
    { thought: "open an account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "perf-harness" } }, expectation: "201 with an account id" },
  ];
  for (let i = steps.length; i < count; i++) {
    steps.push(i % 3 === 1
      ? { thought: "post an entry", action: { type: "request", method: "POST", path: "/entries", body: { account_id: "acc_A_1", amount: i } }, expectation: "201 with the entry" }
      : i % 3 === 2
        ? { thought: "list the entries", action: { type: "request", method: "GET", path: "/entries?account=acc_A_1" }, expectation: "200 with a page" }
        : { thought: "read the account", action: { type: "request", method: "GET", path: "/accounts/acc_A_1" }, expectation: "200 with the balance" });
  }
  return steps;
}

/**
 * The first `[eN]` ref on a snapshot line matching `role`, or null.
 *
 * A scripted actor cannot HARDCODE refs — they are renumbered per snapshot, so a
 * fixed "e2" would turn the harness into a snapshot-format canary. Reading the
 * ref back out of the snapshot the gateway was just shown keeps the workload
 * stable while still exercising the element path (validation, durable locator,
 * bbox) that `action_resolve` measures.
 */
function refFor(snapshotText, role) {
  const line = String(snapshotText ?? "").split("\n").find((l) => new RegExp(`^\\[e\\d+\\]\\s+${role}\\b`).test(l.trim()));
  return line ? /\[(e\d+)\]/.exec(line)?.[1] ?? null : null;
}

/**
 * The web workload. Every step drives the whole expensive capture path —
 * custom snapshot, screenshot + dHash, MHTML, native AX tree, artifact writes,
 * settle, axe — and two steps in five also resolve an element, so
 * `action_resolve` (the T2.3 grouping candidate) is measured rather than
 * guessed. Actions that need a ref are functions of the snapshot.
 */
function webSteps(count) {
  const steps = [];
  for (let i = 0; i < count; i++) {
    steps.push([
      { thought: "add a todo", action: (snap) => ({ type: "type", ref: refFor(snap, "textbox"), text: `perf item ${i}`, submit: true }), expectation: "the todo appears" },
      { thought: "switch the filter", action: (snap) => ({ type: "click", ref: refFor(snap, "link") }), expectation: "the filtered list" },
      { thought: "look further down", action: { type: "scroll", direction: "down" }, expectation: "more of the page" },
      { thought: "reload the list", action: { type: "navigate", url: "/" }, expectation: "the todo page" },
      { thought: "let it settle", action: { type: "wait", seconds: 0.1 }, expectation: "a quiet page" },
    ][i % 5]);
  }
  return steps;
}

const WORKLOADS = {
  api: {
    driver: "api",
    steps: apiSteps,
    success: '  - response_status: "200"',
    suiteHeader: "app:\n  driver: api\n",
    async target() {
      return startInvariantApi({ pageSize: 5 });
    },
  },
  web: {
    driver: "web",
    steps: webSteps,
    success: '  - element_exists: "#todo-count"',
    suiteHeader: "app: {}\n",
    async target() {
      const app = await startTodoApp();
      return { url: app.url, close: () => app.close() };
    },
  },
};

// ------------------------------------------------------------- the gateway

/**
 * A step-addressed OpenAI-compatible gateway.
 *
 * The actor's final user message is always `Current page snapshot (step N):…`
 * (actor.ts), so the reply is a pure function of N — which makes the gateway
 * safe to share between concurrently recording cases. A request offering the
 * `grade` tool is the grader and gets a canned verdict instead.
 */
async function startStepGateway(steps) {
  const terminal = { thought: "the journey is finished", action: { type: "done", summary: "the scripted journey completed" }, expectation: "the run ends" };
  const grade = {
    score: 90,
    completion: "full",
    efficiency: { assessment: "the scripted journey took the direct path", wasted_steps: 0 },
    findings: [],
    summary: "A scripted performance-baseline journey.",
  };
  const reply = (name, args) => JSON.stringify({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", content: "", tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    }],
    usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } },
  });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      const tools = body?.tools ?? [];
      let payload;
      if (tools.some((t) => t?.function?.name === "grade")) {
        payload = reply("grade", grade);
      } else if (tools.some((t) => t?.function?.name === "verdict")) {
        payload = reply("verdict", { pass: true, detail: "scripted" });
      } else {
        const last = body?.messages?.at(-1)?.content;
        const text = typeof last === "string" ? last : JSON.stringify(last);
        const n = Number(/Current page snapshot \(step (\d+)\)/.exec(text ?? "")?.[1] ?? 0);
        const step = steps[n - 1] ?? terminal;
        // A ref-bearing action is a function of the snapshot it is answering;
        // if the element it wants is not on screen, wait rather than emit an
        // action the driver would reject (a failed step is not a measurement).
        const action = typeof step.action === "function" ? step.action(text) : step.action;
        const unresolved = action && "ref" in action && !action.ref;
        payload = reply("step", unresolved ? { ...step, action: { type: "wait", seconds: 0.1 } } : { ...step, action });
      }
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

// ------------------------------------------------------------- measurement

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const value = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  return Math.round(value * 100) / 100;
}

/** Every perf.jsonl under a runs root, grouped into { span: [ms, …] }. */
function collectSpans(runsRoot) {
  const byspan = new Map();
  for (const file of walk(runsRoot)) {
    if (path.basename(file) !== "perf.jsonl") continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      let list = byspan.get(row.span);
      if (!list) byspan.set(row.span, (list = []));
      list.push(row.ms);
    }
  }
  const out = {};
  for (const [span, values] of [...byspan].sort(([a], [b]) => a.localeCompare(b))) {
    values.sort((a, b) => a - b);
    out[span] = { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
  }
  return out;
}

// Artifact classes, most specific first: the point is to see which KIND of
// output dominates a bundle, so the buckets mirror how the plan talks about
// them (trace vs stills vs MHTML vs native AX vs the journals).
const ARTIFACT_CLASSES = [
  [/(^|\/)trace\.zip$/, "trace.zip"],
  [/\.pw-a11y\.txt$/, "native AX text"],
  [/\.a11y\.txt$/, "a11y text"],
  [/\.mhtml$/, "MHTML"],
  [/\.png$/, "step PNGs"],
  [/(^|\/)har\.json$/, "har.json"],
  [/(^|\/)trajectory\.jsonl$/, "trajectory.jsonl"],
  [/(^|\/)context\.jsonl$/, "context.jsonl"],
  [/(^|\/)events\.jsonl$/, "events.jsonl"],
  [/(^|\/)perf\.jsonl$/, "perf.jsonl (sidecar)"],
  [/(^|\/)manifest\.json$/, "manifest.json"],
  [/(^|\/)grade\.json$/, "grade.json"],
  [/(^|\/)video\./, "video"],
];

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function artifactBytes(runsRoot) {
  const totals = new Map();
  for (const file of walk(runsRoot)) {
    const rel = path.relative(runsRoot, file).replaceAll(path.sep, "/");
    const cls = ARTIFACT_CLASSES.find(([re]) => re.test(rel))?.[1] ?? "other";
    totals.set(cls, (totals.get(cls) ?? 0) + fs.statSync(file).size);
  }
  return Object.fromEntries([...totals].sort((a, b) => b[1] - a[1]));
}

// ------------------------------------------------------------------- cells

function writeSuite(dir, { workload, baseUrl, count, cases }) {
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(path.join(dir, "playtest.yaml"), `${workload.suiteHeader}actor_model: sonnet\ngrader_model: sonnet\n`);
  for (let i = 1; i <= cases; i++) {
    fs.writeFileSync(
      path.join(dir, "stories", `journey-${i}.yaml`),
      ["story: |", `  Scripted performance journey ${i} (${count} steps).`, "limits:", `  max_steps: ${count + 2}`, "success:", workload.success, ""].join("\n"),
    );
  }
  return dir;
}

async function runCell({ workload, label, count, concurrency, tmpRoot, target }) {
  const cell = `${label}-c${concurrency}`;
  const suite = writeSuite(path.join(tmpRoot, `suite-${cell}`), { workload, count, cases: CASES_PER_CELL });
  const runsRoot = path.join(tmpRoot, `runs-${cell}`);
  const gateway = await startStepGateway(workload.steps(count));
  process.env.PLAYTEST_LLM_BASE_URL = gateway.url;

  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, RSS_SAMPLE_MS);
  const startedAt = performance.now();
  let results;
  try {
    const cases = await discoverCases([suite], { baseUrl: target.url });
    ({ results } = await runAll(cases, {
      runsRoot,
      runId: newRunId(),
      parallel: concurrency,
      reporter: { onEvent: () => {}, done: () => {} },
    }));
  } finally {
    clearInterval(sampler);
    await gateway.close();
    delete process.env.PLAYTEST_LLM_BASE_URL;
  }
  const wallMs = Math.round(performance.now() - startedAt);
  const statuses = {};
  for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;

  return {
    workload: workload.driver,
    length: label,
    steps: count,
    cases: CASES_PER_CELL,
    concurrency,
    wall_ms: wallMs,
    statuses,
    peak_rss_mb: Math.round(peakRss / 1048576),
    spans: collectSpans(runsRoot),
    artifact_bytes: artifactBytes(runsRoot),
  };
}

// ------------------------------------------------------------------ report

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function printCell(cell) {
  const statuses = Object.entries(cell.statuses).map(([k, v]) => `${v} ${k}`).join(", ");
  console.log(`\n### ${cell.workload} · ${cell.length} (${cell.steps} steps) · concurrency ${cell.concurrency}`);
  // schedulePool staggers worker startup by 500 ms per slot so concurrent cases
  // do not fire their first model call together; at c>1 that is a fixed floor on
  // the suite wall, and on short workloads it dominates it.
  const stagger = (cell.concurrency - 1) * 500;
  const staggerNote = stagger ? ` (includes a ${stagger} ms worker stagger)` : "";
  console.log(`\n${cell.cases} cases · ${statuses} · suite wall ${cell.wall_ms} ms${staggerNote} · peak RSS ${cell.peak_rss_mb} MB\n`);
  console.log("| span | n | p50 ms | p95 ms |");
  console.log("|---|---:|---:|---:|");
  for (const [span, s] of Object.entries(cell.spans)) {
    console.log(`| ${span} | ${s.count} | ${s.p50} | ${s.p95} |`);
  }
  console.log("\n| artifact | bytes (4 runs) |");
  console.log("|---|---:|");
  for (const [cls, bytes] of Object.entries(cell.artifact_bytes)) {
    console.log(`| ${cls} | ${kb(bytes)} |`);
  }
}

// -------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const driver = (args.find((a) => a.startsWith("--driver="))?.split("=")[1] ?? "api").trim();
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  const workload = WORKLOADS[driver];
  if (!workload) {
    console.error(`unknown --driver "${driver}" (expected ${Object.keys(WORKLOADS).join(" | ")})`);
    process.exitCode = 2;
    return;
  }
  // A stray gateway/key in the developer's shell must not turn a baseline into a
  // paid run against a real model.
  for (const key of ["PLAYTEST_LLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[key];

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-perf-baseline-"));
  const target = await workload.target();
  const cells = [];
  try {
    for (const [label, count] of [["short", SHORT_STEPS], ["long", LONG_STEPS]]) {
      for (const concurrency of CONCURRENCIES) {
        process.stderr.write(`running ${driver}/${label}/c${concurrency}…\n`);
        cells.push(await runCell({ workload, label, count, concurrency, tmpRoot, target }));
      }
    }
  } finally {
    await target.close().catch(() => {});
  }

  console.log(`## ${driver} workload`);
  console.log(`\nnode ${process.version} · ${os.cpus()[0]?.model ?? "unknown cpu"} · ${os.availableParallelism()} threads · ${new Date().toISOString().slice(0, 10)}`);
  for (const cell of cells) printCell(cell);

  if (jsonOut) {
    const out = path.resolve(ROOT, jsonOut);
    fs.writeFileSync(out, JSON.stringify({ driver, node: process.version, cells }, null, 2) + "\n");
    process.stderr.write(`wrote ${out}\n`);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

await main();
