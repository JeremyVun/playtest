#!/usr/bin/env node
// The measurement bench (BUILD_PLAN P0 scope 6).
//
//   node examples/ledger-api/bench/bench.js [options] [label=]<path>...
//
// Scores any mix of Playtest run directories, plain HAR files, and Schemathesis
// HAR cassettes with the *same* deterministic oracles, and reports detection in
// **two columns** — oracle-confirmed-in-traffic and reported-with-correct-
// evidence (DESIGN N10) — plus the five-stage funnel per fault per trace, false
// positives on clean and conforming-variant builds, request and step counts,
// wall time, and cost where the trace carries it.
//
// Fully offline. No model calls, no network, no dependencies.
//
// Labels tell the bench which build a trace came from:
//   clean=runs/2026-07-25T0900-ab12/probe@api-fuzzer
//   clean.terse-optionals=comparator/agent-suite-variant.har
//   f-close-ghost=comparator/schemathesis-close-ghost.har
// A label may also live in a `bench-meta.json` beside a run directory or a
// `<name>.meta.json` beside a HAR file.
//
// The second column needs the arm's own structured report; it is picked up
// automatically (`suite-report.json` in a run directory, `<name>.report.json`
// beside a HAR) or attached explicitly with `--report <traceId|label>=<file>`.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadTraces } from "./lib/sources.js";
import { loadSuiteReport } from "./lib/suite-report.js";
import { scoreAll } from "./lib/score.js";
import { formatReport } from "./lib/report.js";
import { FAULT_IDS } from "../src/faults.js";

const USAGE = `usage: node examples/ledger-api/bench/bench.js [options] [label=]<path>...

  <path>            a Playtest run directory (manifest.json + har.json),
                    a directory of run directories, a .har file, or a
                    Schemathesis HAR cassette (--cassette-format har)
  label             "clean" for a clean build, "clean.<variant>" for a
                    conforming-variant or jittered build, or a fault id:
                    ${FAULT_IDS.join(", ")}

options:
  --report <k>=<f>  attach a suite report to the trace whose id or label is <k>
                    (otherwise found beside the trace automatically)
  --json            emit the full machine-readable result instead of a report
  --out <file>      also write the JSON result to <file>
  --quiet           report tables only, without per-violation evidence
  -h, --help        this text
`;

export function main(argv) {
  const inputs = [];
  const options = { json: false, out: null, quiet: false, reports: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--out") options.out = argv[++index];
    else if (argument === "--report") options.reports.push(argv[++index]);
    else if (argument === "-h" || argument === "--help") return { code: 0, stdout: USAGE };
    else if (argument.startsWith("-")) return { code: 2, stderr: `unknown option: ${argument}\n\n${USAGE}` };
    else inputs.push(argument);
  }
  if (inputs.length === 0) return { code: 2, stderr: USAGE };

  const traces = [];
  for (const input of inputs) {
    try {
      traces.push(...loadTraces(input));
    } catch (error) {
      return { code: 2, stderr: `bench: ${error.message}\n` };
    }
  }

  for (const spec of options.reports) {
    const split = String(spec ?? "").indexOf("=");
    if (split < 1) return { code: 2, stderr: `bench: --report wants <traceId|label>=<file>, got "${spec}"\n` };
    const key = spec.slice(0, split);
    const file = spec.slice(split + 1);
    if (!fs.existsSync(file)) return { code: 2, stderr: `bench: no such report file: ${file}\n` };
    const matched = traces.filter((trace) => trace.id === key || trace.label === key);
    if (matched.length === 0) return { code: 2, stderr: `bench: --report ${key}= matches no trace\n` };
    const report = loadSuiteReport(file);
    for (const trace of matched) trace.report = report;
  }

  const result = scoreAll(traces);
  if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  const stdout = options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${formatReport(result, { verbose: !options.quiet })}\n`;

  // Exit code carries the headline: any false positive on a clean or conforming
  // build — in either column — or a fault-labelled trace whose fault went
  // undetected, is a red bench.
  const missed = result.traces.filter((row) => row.detected === false).length;
  const falsePositives = result.summary.false_positives.total + result.summary.false_positives.reported;
  const code = falsePositives > 0 || missed > 0 ? 1 : 0;
  return { code, stdout, result };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { code, stdout, stderr } = main(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
