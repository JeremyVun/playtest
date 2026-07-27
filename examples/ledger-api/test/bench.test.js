// The measurement bench, end to end.
//
// Every trace scored here was produced by driving the real fixture, so the
// bench is tested against traffic the fixture actually emits rather than
// hand-written JSON that could drift from it.

import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { record, writePlaytestRun, writeHarFile, writeSchemathesisCassette } from "./support/record.js";
import { MANIFESTATIONS } from "./support/manifestations.js";
import { FAULT_IDS } from "../src/faults.js";
import { main } from "../bench/bench.js";
import { loadTraces, loadSchemathesisCassette } from "../bench/lib/sources.js";
import { scoreOne, columnOneCovers, faultsWithoutExpectations } from "../bench/lib/score.js";

/** The denominator column one is actually scored against (score.js). */
const ORACLE_COVERED = FAULT_IDS.filter(columnOneCovers);

let workspace;
/** fault id -> { faulty: entries, clean: entries } */
const recordings = new Map();

before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-bench-"));
  for (const manifestation of MANIFESTATIONS) {
    const faulty = await record({ faults: [manifestation.fault], scenario: (client) => manifestation.probe(client) });
    const clean = await record({ faults: [], scenario: (client) => manifestation.probe(client) });
    recordings.set(manifestation.fault, { faulty: faulty.entries, clean: clean.entries });

    writePlaytestRun(path.join(workspace, "runs", `${manifestation.fault}-faulty`), faulty.entries, {
      label: manifestation.fault,
      caseId: `${manifestation.fault}@api-fuzzer`,
      steps: faulty.entries.length,
      costUsd: 0.0125,
    });
    writePlaytestRun(path.join(workspace, "runs", `${manifestation.fault}-clean`), clean.entries, {
      label: "clean",
      caseId: `${manifestation.fault}@api-fuzzer`,
      steps: clean.entries.length,
      costUsd: 0.0125,
    });
  }
});

after(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

test("every catalogued fault declares how column one scores it", () => {
  // An entry with empty codes is a deliberate "the pinned oracles have no rule
  // for this"; a *missing* entry is a catalog that outgrew its scoring table,
  // which would score `null` and look like a shrug rather than a mistake.
  assert.deepEqual(faultsWithoutExpectations(), []);
  assert.ok(ORACLE_COVERED.length > 0);
});

test("the bench scores a tree of Playtest run directories with one oracle set", () => {
  const outcome = main([path.join(workspace, "runs")]);
  const { summary, traces } = outcome.result;

  assert.equal(summary.trace_count, MANIFESTATIONS.length * 2);
  assert.equal(summary.faulty_traces, MANIFESTATIONS.length);
  assert.equal(summary.clean_traces, MANIFESTATIONS.length);
  assert.equal(summary.faults_seen, FAULT_IDS.length);
  assert.equal(summary.faults_detected, ORACLE_COVERED.length, "every fault the pinned oracles cover is detected");
  assert.equal(
    summary.faults_evidence_correct,
    ORACLE_COVERED.length,
    "every detection cites the right request",
  );
  assert.equal(summary.faults_without_column_one, FAULT_IDS.length - ORACLE_COVERED.length);
  assert.equal(summary.false_positives.total, 0, "no clean build produces a finding");
  assert.deepEqual(summary.false_positives.by_oracle, {});
  assert.equal(outcome.code, 0);

  for (const row of traces.filter((candidate) => candidate.label_kind === "faulty" && candidate.column_one_covered)) {
    assert.equal(row.detected, true, row.id);
    assert.equal(row.evidence_correct, true, row.id);
    const onLabel = row.violations.filter((violation) => violation.expected_for_label);
    assert.ok(onLabel.length >= 1, row.id);
    for (const violation of onLabel) {
      assert.equal(violation.evidence_resolvable, true);
      assert.equal(violation.on_target, true);
      assert.ok(Number.isInteger(violation.evidence.request.index));
    }
  }
});

test("per-trace metrics come from the run's own metadata", () => {
  const [trace] = loadTraces(`${path.join(workspace, "runs", "f-close-ghost-faulty")}`);
  const row = scoreOne(trace);
  assert.equal(row.source, "playtest-run");
  assert.equal(row.label, "f-close-ghost");
  assert.equal(row.fault_tier, "semantic");
  assert.equal(row.requests, trace.exchanges.length);
  assert.equal(row.steps, trace.exchanges.length);
  assert.equal(row.cost_usd, 0.0125);
  assert.ok(Number.isFinite(row.wall_ms));
  assert.ok(row.oracles_applicable.includes("lifecycle"));
  assert.equal(row.violations[0].oracle, "lifecycle");
});

test("a plain HAR and a Schemathesis cassette score identically to a run directory", () => {
  const comparators = path.join(workspace, "comparators");
  const { faulty, clean } = recordings.get("f-fee-rounding-drift");
  const harFile = writeHarFile(path.join(comparators, "agent-suite-clean.har"), clean);
  const cassette = writeSchemathesisCassette(path.join(comparators, "schemathesis-fee.har"), faulty);

  const outcome = main([`clean=${harFile}`, `f-fee-rounding-drift=${cassette}`]);
  const [cleanRow, faultyRow] = outcome.result.traces;

  assert.equal(cleanRow.source, "har");
  assert.equal(cleanRow.arm, "har");
  assert.equal(cleanRow.false_positives, 0);
  assert.deepEqual(cleanRow.violations, []);

  assert.equal(faultyRow.source, "schemathesis", "the cassette is recognised by its creator block");
  assert.equal(faultyRow.detected, true);
  assert.equal(faultyRow.evidence_correct, true);
  assert.deepEqual(faultyRow.violations.map((violation) => violation.code), ["transfer_entries_nonzero"]);

  // Same traffic, same verdict, whichever adapter carried it.
  const viaRunDir = main([path.join(workspace, "runs", "f-fee-rounding-drift-faulty")]).result.traces[0];
  assert.deepEqual(
    faultyRow.violations.map((violation) => `${violation.oracle}/${violation.code}`),
    viaRunDir.violations.map((violation) => `${violation.oracle}/${violation.code}`),
  );
  assert.deepEqual(faultyRow.applicability, viaRunDir.applicability);
});

test("a cassette can be tagged as Schemathesis output explicitly", () => {
  const file = path.join(workspace, "comparators", "unbranded.har");
  // A future Schemathesis release could rename its creator block; the explicit
  // loader keeps the arm attribution correct anyway.
  writeHarFile(file, recordings.get("f-close-ghost").faulty, { creator: { name: "unknown", version: "0" } });
  const trace = loadSchemathesisCassette(file, { label: "f-close-ghost" });
  assert.equal(trace.source, "schemathesis");
  const row = scoreOne(trace);
  assert.equal(row.detected, true);
  assert.equal(row.arm, "schemathesis");
});

test("a HAR sidecar can carry the label and the arm's own cost and step counts", () => {
  const file = path.join(workspace, "comparators", "labelled.har");
  writeHarFile(file, recordings.get("f-close-ghost").faulty, {
    label: "f-close-ghost",
    meta: { arm: "agent-suite", steps: 42, cost_usd: 1.5, wall_ms: 1234 },
  });
  const [row] = main([file]).result.traces.map((candidate) => candidate);
  assert.equal(row.label, "f-close-ghost");
  assert.equal(row.arm, "agent-suite");
  assert.equal(row.steps, 42);
  assert.equal(row.cost_usd, 1.5);
  assert.equal(row.wall_ms, 1234);
  assert.equal(row.detected, true);
});

test("a finding on a clean-labelled trace is a false positive and reddens the bench", () => {
  const file = path.join(workspace, "comparators", "mislabelled.har");
  writeHarFile(file, recordings.get("f-close-ghost").faulty);
  const outcome = main([`clean=${file}`]);
  assert.equal(outcome.result.summary.false_positives.total, 1);
  assert.deepEqual(outcome.result.summary.false_positives.by_oracle, { lifecycle: 1 });
  assert.equal(outcome.code, 1);
  assert.match(outcome.stdout, /FALSE POSITIVE/);
});

test("an undetected fault reddens the bench", () => {
  const file = path.join(workspace, "comparators", "missed.har");
  // Clean traffic labelled as a faulty build: the arm never reached the fault.
  writeHarFile(file, recordings.get("f-close-ghost").clean);
  const outcome = main([`f-close-ghost=${file}`]);
  assert.equal(outcome.result.summary.faults_detected, 0);
  assert.equal(outcome.result.traces[0].detected, false);
  assert.equal(outcome.code, 1);
});

test("the text report names the offending request for every finding", () => {
  const outcome = main([path.join(workspace, "runs", "f-settle-cancel-race-faulty")]);
  assert.match(outcome.stdout, /lifecycle\/cancel_after_settlement at #\d+ POST \/transfers\/tr_\w+\/cancel -> 200/);
  assert.match(outcome.stdout, /conservation\/transfer_entries_nonzero/);
  assert.match(outcome.stdout, /support #\d+/);
  assert.match(outcome.stdout, /Detection/);
  assert.match(outcome.stdout, /False positives \(clean and conforming-variant builds\)/);
  assert.match(outcome.stdout, /requests \d+ {2}steps \d+/);
});

test("the CLI supports --json, --out, --quiet, and --help", () => {
  const runs = path.join(workspace, "runs");
  const asJson = main(["--json", path.join(runs, "f-close-ghost-faulty")]);
  assert.equal(JSON.parse(asJson.stdout).summary.faults_detected, 1);

  const outFile = path.join(workspace, "result.json");
  main(["--out", outFile, path.join(runs, "f-close-ghost-faulty")]);
  assert.equal(JSON.parse(fs.readFileSync(outFile, "utf8")).summary.trace_count, 1);

  const quiet = main(["--quiet", path.join(runs, "f-close-ghost-faulty")]);
  assert.equal(/on-label/.test(quiet.stdout), false);

  assert.match(main(["--help"]).stdout, /usage: node/);
  assert.equal(main([]).code, 2);
  assert.match(main(["--nope", "x"]).stderr, /unknown option/);
});

test("input errors are actionable, including a VCR cassette", () => {
  assert.match(main(["/no/such/path"]).stderr, /no such path/);

  const vcr = path.join(workspace, "comparators", "cassette.json");
  fs.writeFileSync(vcr, JSON.stringify({ interactions: [{ request: {}, response: {} }] }));
  assert.match(main([vcr]).stderr, /VCR cassette.*--cassette-format har/s);

  const junk = path.join(workspace, "comparators", "junk.har");
  fs.writeFileSync(junk, JSON.stringify({ hello: "world" }));
  assert.match(main([junk]).stderr, /not a HAR document/);

  const emptyDir = path.join(workspace, "empty");
  fs.mkdirSync(emptyDir, { recursive: true });
  assert.match(main([emptyDir]).stderr, /no run directories or \.har files/);
});

test("scoring is offline: it makes no network call and no model call", () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("the bench must not make network calls");
  };
  try {
    const outcome = main([path.join(workspace, "runs")]);
    assert.equal(outcome.result.summary.faults_detected, ORACLE_COVERED.length);
  } finally {
    globalThis.fetch = realFetch;
  }
});
