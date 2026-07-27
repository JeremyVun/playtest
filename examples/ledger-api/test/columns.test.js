// The bench's second scoring column and the five-stage funnel
// (DESIGN N10, BUILD_PLAN S0 scope 4).
//
// Every trace here was produced by driving the real fixture, so the columns are
// exercised against traffic the fixture actually emits. The reports are written
// by hand on purpose: they are the input a suite arm supplies, and the point of
// the column is that a *claimed* violation is only credited when the artifacts
// back it up.

import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { record, writeHarFile, writePlaytestRun } from "./support/record.js";
import { MANIFESTATIONS } from "./support/manifestations.js";
import {
  FAULT_IDS,
  FAULT_CATEGORIES,
  CATEGORY_IDS,
  DEVELOPMENT_FAULT_IDS,
  HELD_OUT_FAULT_IDS,
} from "../src/faults.js";
import { ORACLE_IDS, scoreTrace } from "../bench/lib/oracles.js";
import { traceFromHarEntries } from "../bench/lib/trace.js";
import { WITNESSES, witnessFor } from "../bench/lib/witnesses.js";
import { normalizeSuiteReport, SUITE_REPORT_SCHEMA, tagsMatch } from "../bench/lib/suite-report.js";
import { resolveCitation } from "../bench/lib/funnel.js";
import { scoreOne, scoreAll } from "../bench/lib/score.js";
import { main } from "../bench/bench.js";

let workspace;
/** fault id -> { faulty: entries, clean: entries } */
const recordings = new Map();

const T = (client, body) => client.post("/transfers", body);

before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-columns-"));
  for (const manifestation of MANIFESTATIONS) {
    const faulty = await record({ faults: [manifestation.fault], scenario: (client) => manifestation.probe(client) });
    const clean = await record({ faults: [], scenario: (client) => manifestation.probe(client) });
    recordings.set(manifestation.fault, { faulty: faulty.entries, clean: clean.entries });
  }
});

after(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

/** Build a scorable trace, optionally with the arm's structured report attached. */
function traceOf(entries, { label = null, id = label ?? "trace", arm = "agent-suite", report = null } = {}) {
  const trace = traceFromHarEntries(entries, { id, source: "har", label, meta: { arm } });
  if (report) trace.report = normalizeSuiteReport(report, { source: "inline" });
  return trace;
}

const contextOf = (entries) => {
  const trace = traceOf(entries);
  const { violations, facts } = scoreTrace(trace);
  return { trace, facts, violations };
};

/** Locate a request the way a suite author would: by method, path, and status. */
function indexOf(entries, method, pathFragment, { status = null, last = false } = {}) {
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.request.method === method &&
        entry.request.url.includes(pathFragment) &&
        (status === null || entry.response.status === status),
    );
  assert.ok(matches.length > 0, `no ${method} ${pathFragment} (${status ?? "any status"}) in the recording`);
  return (last ? matches[matches.length - 1] : matches[0]).index;
}

/** A report in the v0 shape, with one obligation and one failing check. */
function reportWith({ rule, obligation = `obligation-${rule}`, check = {}, obligations = null, checks = null }) {
  return {
    schema: SUITE_REPORT_SCHEMA,
    suite: { id: "agent-suite", trial: "t1" },
    obligations: obligations ?? [{ id: obligation, rule, status: "covered", checks: [check.id ?? "check-1"] }],
    checks:
      checks ?? [
        {
          id: "check-1",
          obligation,
          rule,
          status: "fail",
          title: "the rule broke",
          ...check,
        },
      ],
  };
}

// ---------------------------------------------------------------- the registry

test("every catalogued fault declares a category and a witness", () => {
  assert.deepEqual(Object.keys(WITNESSES).sort(), [...FAULT_IDS].sort());
  for (const fault of FAULT_IDS) {
    const category = FAULT_CATEGORIES[fault];
    assert.ok(CATEGORY_IDS.includes(category), `${fault} has category "${category}"`);
    for (const oracle of WITNESSES[fault].oracles) {
      assert.ok(ORACLE_IDS.includes(oracle), `${fault} names oracle "${oracle}"`);
    }
  }
  // The taxonomy is the study's, not the catalog's: a category with no fault
  // at all is a gap in the evidence, and it must stay visible. With the S0
  // sealed set applied there is none — authorization, the one the thirteen
  // public faults left empty, is the sealed set's to fill.
  const covered = new Set(Object.values(FAULT_CATEGORIES));
  assert.deepEqual(
    CATEGORY_IDS.filter((category) => !covered.has(category)),
    [],
    "every taxonomy category carries at least one fault",
  );
});

test("a witness fires on its own fault's traffic and on no conforming traffic", () => {
  const failures = [];
  for (const manifestation of MANIFESTATIONS) {
    const fault = manifestation.fault;
    const faulty = witnessFor(fault, contextOf(recordings.get(fault).faulty));
    if (faulty.witnesses.length === 0) failures.push(`${fault}: no witness on its own faulty traffic`);
    if (faulty.reached !== true) failures.push(`${fault}: reach false on its own faulty traffic`);

    // Soundness, exhaustively: no fault's witness may fire on the clean-build
    // traffic of any probe. A witness that does is a false detector.
    for (const other of MANIFESTATIONS) {
      const witness = witnessFor(fault, contextOf(recordings.get(other.fault).clean));
      if (witness.witnesses.length > 0) {
        failures.push(`${fault}: witness fired on the clean traffic of ${other.fault}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

// -------------------------------------------------------------- citations

test("a citation resolves by index, by entry id, and by description", () => {
  const entries = recordings.get("f-error-200").faulty;
  const trace = traceOf(entries);
  const target = indexOf(entries, "POST", "/transfers", { status: 200 });
  const exchange = trace.exchanges[target];

  assert.equal(resolveCitation({ index: target, entry_id: null, method: null, path: null, status: null, ordinal: null }, trace).resolved, true);
  assert.equal(
    resolveCitation(
      { index: null, entry_id: null, method: "POST", path: exchange.path, status: 200, ordinal: null },
      trace,
    ).resolved,
    true,
  );

  const stamped = traceOf(entries);
  stamped.meta.entry_ids = entries.map((_, index) => `e${index}`);
  assert.equal(
    resolveCitation({ index: null, entry_id: `e${target}`, method: null, path: null, status: null, ordinal: null }, stamped).index,
    target,
  );

  // Out of range, and — the failure mode that matters — a citation that resolves
  // but describes something else.
  assert.equal(resolveCitation({ index: 9999, entry_id: null, method: null, path: null, status: null, ordinal: null }, trace).resolved, false);
  const lying = resolveCitation(
    { index: target, entry_id: null, method: "GET", path: "/health", status: null, ordinal: null },
    trace,
  );
  assert.equal(lying.resolved, false);
  assert.match(lying.reason, /describes a different exchange/);
});

test("rule names match across vocabularies but not across rules", () => {
  assert.equal(tagsMatch("errorshape", "error_shape"), true);
  assert.equal(tagsMatch("balance", "balance_agreement"), true);
  assert.equal(tagsMatch("5 error shape / no 5xx", "error_shape"), true);
  assert.equal(tagsMatch("pagination", "conservation"), false);
  assert.equal(tagsMatch("", "conservation"), false);
});

// -------------------------------------------------------------- the two columns

test("a correct report is credited on both columns with a clean funnel", () => {
  const entries = recordings.get("f-error-200").faulty;
  const cited = indexOf(entries, "POST", "/transfers", { status: 200 });
  const row = scoreOne(
    traceOf(entries, {
      label: "f-error-200",
      report: reportWith({
        rule: "errorshape",
        check: {
          observed: "POST /transfers answered 200 with status \"failed\"",
          evidence: { entries: [{ index: cited, method: "POST", path: "/transfers", status: 200 }] },
        },
      }),
    }),
  );

  assert.equal(row.columns.oracle_confirmed, true);
  assert.equal(row.columns.reported_with_evidence, true);
  assert.deepEqual(
    row.funnel.stages,
    {
      obligation_enumerated: true,
      scenario_executed: true,
      manifested_in_traffic: true,
      assertion_detected: true,
      evidence_correctly_cited: true,
    },
  );
  assert.equal(row.funnel.diagnosis, "none");
  assert.equal(row.fault_category, "error-semantics");
});

test("a fabricated citation fails the second column and is diagnosed as reporting", () => {
  const entries = recordings.get("f-error-200").faulty;
  const row = scoreOne(
    traceOf(entries, {
      label: "f-error-200",
      report: reportWith({
        rule: "errorshape",
        check: { evidence: { entries: [{ index: 9999 }] } },
      }),
    }),
  );

  assert.equal(row.columns.oracle_confirmed, true, "the oracle still confirms the fault in the traffic");
  assert.equal(row.columns.reported_with_evidence, false);
  assert.equal(row.columns.reported_without_evidence, true);
  assert.equal(row.funnel.stages.assertion_detected, true);
  assert.equal(row.funnel.stages.evidence_correctly_cited, false);
  assert.equal(row.funnel.diagnosis, "reporting");
});

test("the P1 applicability bias: a report is credited where the shared oracle cannot confirm", async () => {
  // studies/api-probe/REPORT.md §3. The suite caught f-settle-failed-debit and
  // named the offending ledger row; the shared oracle refused to credit it
  // because its balance-agreement window needs a balance read and a complete
  // enumeration with no write in between. Here a write lands in between, so the
  // oracle is silent — and the second column still credits the report.
  const { entries, outcome } = await record({
    faults: ["f-settle-failed-debit"],
    scenario: async (client) => {
      const source = await client.fundedAccount("alice", 3000);
      const destination = await client.openAccount("bob");
      const body = (amount) => ({ source_account_id: source.id, destination_account_id: destination.id, amount });
      await T(client, body(1000));
      const second = await T(client, body(1950));
      await client.tick();
      const rows = await client.allEntries(source.id);
      await client.openAccount("carol"); // the write that closes the oracle's window
      await client.get(`/accounts/${source.id}`);
      return { orphan: rows.find((entry) => entry.transfer_id === second.body?.id), transfer: second.body?.id };
    },
  });
  assert.ok(outcome.orphan, "the failed transfer left a row to name");

  const oracleOnly = scoreOne(traceOf(entries, { label: "f-settle-failed-debit" }));
  assert.equal(oracleOnly.detected, false, "column one cannot see it in this traffic");
  assert.equal(oracleOnly.columns.reported_with_evidence, null, "no report attached is not a miss");
  assert.equal(oracleOnly.funnel.stages.manifested_in_traffic, true, "the witness still sees it");
  assert.equal(oracleOnly.funnel.diagnosis, "indeterminate");

  const withReport = scoreOne(
    traceOf(entries, {
      label: "f-settle-failed-debit",
      report: reportWith({
        rule: "conservation",
        check: {
          title: "a failed transfer wrote ledger entries",
          expected: 'a transfer that ends "failed" writes no entries at all',
          observed: `${outcome.transfer} (failed) carries 1 entries: ${outcome.orphan.id}[${outcome.orphan.account_id} transfer_debit ${outcome.orphan.amount}]`,
          evidence: { entries: [{ index: indexOf(entries, "GET", "/entries", { status: 200 }) }] },
        },
      }),
    }),
  );
  assert.equal(withReport.columns.oracle_confirmed, false);
  assert.equal(withReport.columns.reported_with_evidence, true);
  assert.equal(withReport.columns.reported_with_evidence_strict, true, "the citation lands on a witnessing exchange");
  assert.equal(withReport.funnel.diagnosis, "none");
  assert.ok(withReport.witness.subject_ids.includes(outcome.orphan.id));
});

test("an unreached conditional branch is diagnosed as reachability, not as a bad assertion", async () => {
  // The currency-conditional fault the P1 probe missed because it worked in one
  // currency (REPORT.md §2). A thorough USD-only suite is not wrong; it never
  // reached the branch, and the funnel has to say so.
  const { entries } = await record({
    faults: ["f-fee-double-charged"],
    scenario: async (client) => {
      const source = await client.fundedAccount("alice", 9000, "USD");
      const destination = await client.openAccount("bob", "USD");
      await T(client, { source_account_id: source.id, destination_account_id: destination.id, amount: 2000 });
      await client.tick();
      await client.allEntries(source.id);
      await client.allEntries(destination.id);
      await client.allEntries("acc_fee_usd");
      return null;
    },
  });

  const row = scoreOne(
    traceOf(entries, {
      label: "f-fee-double-charged",
      report: {
        schema: SUITE_REPORT_SCHEMA,
        obligations: [{ id: "rule-1", rule: "conservation", status: "covered", checks: ["usd-conservation"] }],
        checks: [{ id: "usd-conservation", obligation: "rule-1", rule: "conservation", status: "pass" }],
      },
    }),
  );

  assert.equal(row.columns.oracle_confirmed, false);
  assert.equal(row.columns.reported_with_evidence, false);
  assert.equal(row.funnel.stages.obligation_enumerated, true, "the rule was enumerated");
  assert.equal(row.funnel.stages.scenario_executed, false, "the EUR branch was never reached");
  assert.equal(row.funnel.diagnosis, "reachability");
});

test("a rule the report never enumerated is diagnosed as enumeration", () => {
  const row = scoreOne(
    traceOf(recordings.get("f-fee-double-charged").faulty, {
      label: "f-fee-double-charged",
      report: {
        schema: SUITE_REPORT_SCHEMA,
        obligations: [{ id: "rule-4", rule: "pagination", status: "covered", checks: ["pages"] }],
        checks: [{ id: "pages", obligation: "rule-4", rule: "pagination", status: "pass" }],
      },
    }),
  );
  assert.equal(row.funnel.stages.obligation_enumerated, false);
  assert.equal(row.funnel.stages.manifested_in_traffic, true);
  assert.equal(row.funnel.diagnosis, "enumeration");
});

test("the legacy agent-suite report shape scores on the second column", () => {
  const entries = recordings.get("f-close-ghost").faulty;
  const cited = indexOf(entries, "POST", "/transfers", { last: true });
  const trace = traceOf(entries, {
    label: "f-close-ghost",
    report: {
      violations: [
        {
          rule: "lifecycle",
          title: "a closed account transacted",
          scenario: "lifecycle",
          occurrences: 1,
          evidence: [
            {
              expected: "a closed account refuses transfers",
              observed: "the transfer was accepted",
              requests: [{ index: cited, method: "POST", path: "/transfers" }],
            },
          ],
        },
      ],
      setupFailures: [{ scenario: "pagination", message: "could not build a second page" }],
      warnings: [],
    },
  });
  const row = scoreOne(trace);

  assert.equal(trace.report.shape, "legacy-agent-suite");
  assert.equal(row.report.defects, 1, "a suite defect is not a check failure");
  assert.equal(row.columns.reported_with_evidence, true);
  // A report carrying only failures cannot answer "was the rule enumerated?" —
  // absence there means "did not fail", so the stage is unknown, never false.
  assert.equal(row.funnel.stages.obligation_enumerated, null);
  assert.equal(row.funnel.diagnosis, "indeterminate");
});

test("the S1 script report shape scores natively", () => {
  // src/core/schemas/script-report.schema.json: checks carry `pass` +
  // `exercised` rather than a status string, and cite `evidence.har_entries` as
  // bare indices. The study's substrate may be this or the v0 shape, and the
  // preregistration pins exactly one — the bench must not be what forces the
  // choice.
  const entries = recordings.get("f-error-200").faulty;
  const cited = indexOf(entries, "POST", "/transfers", { status: 200 });
  const trace = traceOf(entries, {
    label: "f-error-200",
    report: {
      script_report_version: 1,
      contract_version: 1,
      script: { path: "suite.mjs", sha256: "0".repeat(64) },
      obligations: [
        { id: "rule:error_shape", status: "covered", checks: ["errors/refusal-envelope"] },
        { id: "rule:pagination", status: "skipped", reason: "no paginated collection reached 2 pages" },
      ],
      checks: [
        {
          id: "errors/refusal-envelope",
          obligation: "rule:error_shape",
          title: "a refusal is never a 2xx",
          pass: false,
          exercised: true,
          observed: "POST /transfers answered 200 with status \"failed\"",
          evidence: { har_entries: [cited] },
        },
        {
          id: "pagination/identity",
          obligation: "rule:pagination",
          title: "no duplicate entry in one enumeration",
          pass: true,
          exercised: false,
          evidence: { har_entries: [] },
        },
      ],
      defects: [],
      advisories: [],
    },
  });
  const row = scoreOne(trace);

  assert.equal(trace.report.shape, "script-report/v1");
  assert.equal(trace.report.schema, "playtest.script-report/v1");
  assert.deepEqual(trace.report.problems, [], "the S1 shape reads cleanly");
  assert.equal(trace.report.checks[1].status, "not_exercised", "exercised:false is a soundness result");
  assert.equal(row.report.failing, 1);
  assert.equal(row.columns.reported_with_evidence, true);
  assert.equal(row.funnel.stages.obligation_enumerated, true, "obligation ids like rule:error_shape match");
  assert.equal(row.funnel.diagnosis, "none");
});

test("the S1 runner's nested obligations manifest reads natively", () => {
  // The runner emits `obligations: { manifest_version, summary, entries }`
  // (script-report.schema.json), not a flat array; entries carry `statement`
  // and `source` and may be `unaccounted`. The bench reads that shape without
  // problems so `report.obligations` never silently counts zero.
  const report = normalizeSuiteReport({
    script_report_version: 1,
    contract_version: 1,
    script: { path: "suite.mjs", sha256: "0".repeat(64) },
    obligations: {
      manifest_version: 1,
      summary: { total: 3, covered: 1, skipped: 1, unsupported: 0, unaccounted: 1 },
      entries: [
        {
          id: "rule:error_shape",
          source: "rule",
          statement: "a refusal is never a 2xx",
          status: "covered",
          checks: ["errors/refusal-envelope"],
        },
        { id: "policy:pagination", source: "policy", status: "skipped", reason: "no collection reaches two pages" },
        { id: "op:GET /fees", source: "operation", status: "unaccounted" },
      ],
    },
    checks: [
      {
        id: "errors/refusal-envelope",
        obligation: "rule:error_shape",
        pass: true,
        exercised: true,
        evidence: { har_entries: [] },
      },
    ],
    defects: [],
  });
  assert.deepEqual(report.problems, [], "the nested manifest reads cleanly");
  assert.equal(report.obligations.length, 3);
  assert.equal(report.obligations[0].rule, "a refusal is never a 2xx");
  assert.equal(report.obligations[0].category, "rule");
  assert.equal(report.obligations[2].status, "unaccounted");
});

test("report hygiene problems are surfaced, not swallowed", () => {
  const report = normalizeSuiteReport({
    schema: "something.else/v9",
    obligations: [{ id: "o1", rule: "conservation", status: "skipped" }],
    checks: [
      { id: "c1", obligation: "o2", rule: "conservation", status: "fail" },
      { id: "c2", rule: "conservation", status: "invented" },
    ],
  });
  const joined = report.problems.join("\n");
  assert.match(joined, /unknown report schema/);
  assert.match(joined, /skipped obligation must carry the approved reason/);
  assert.match(joined, /fails but cites no HAR entry/);
  assert.match(joined, /unknown status "invented"/);
  assert.match(joined, /obligation "o2", which the report never declares/);

  const unreadable = normalizeSuiteReport("not a report");
  assert.equal(unreadable.shape, "unreadable");
  assert.deepEqual(unreadable.checks, []);
});

// -------------------------------------------------- conforming builds and totals

test("a failing check on a conforming build is a second-column false positive", () => {
  const entries = recordings.get("f-error-200").clean;
  const result = scoreAll([
    traceOf(entries, {
      id: "variant-run",
      label: "clean.terse-optionals",
      report: reportWith({
        rule: "errorshape",
        check: {
          title: "activated_at is present on every account",
          evidence: { entries: [{ index: indexOf(entries, "POST", "/accounts", { status: 201 }) }] },
        },
      }),
    }),
    traceOf(recordings.get("f-error-200").clean, { id: "canonical-run", label: "clean" }),
  ]);

  assert.equal(result.summary.false_positives.total, 0, "the oracles see nothing wrong with a conforming build");
  assert.equal(result.summary.false_positives.reported, 1);
  assert.equal(result.summary.false_positives.clean_traces_with_reported_findings, 1);
  assert.equal(result.summary.false_positives.by_label["clean.terse-optionals"].reported, 1);
  assert.equal(result.traces[0].label_variant, "terse-optionals");
  assert.equal(result.traces[0].reported_false_positive_checks[0].citations_resolved, 1);
});

test("detection aggregates per category over the whole catalog", () => {
  const traces = MANIFESTATIONS.map((manifestation) =>
    traceOf(recordings.get(manifestation.fault).faulty, {
      id: `${manifestation.fault}-faulty`,
      label: manifestation.fault,
      arm: "manifestation-probe",
    }),
  );
  const result = scoreAll(traces);
  const { summary } = result;

  assert.equal(summary.faults_seen, FAULT_IDS.length);
  assert.equal(summary.columns.reported_with_evidence, 0, "no arm reports were attached");

  // Stage 3 is the property every fault must have: on its own faulty traffic,
  // its witness fires. That is what makes a funnel diagnosis mean something.
  assert.deepEqual(
    result.traces.filter((row) => row.funnel.stages.manifested_in_traffic !== true).map((row) => row.fault),
    [],
    "every fault manifests in the traffic of its own manifestation probe",
  );

  // Column one is the seven frozen oracles, and the catalog is deliberately
  // wider than their vocabulary: an ownership breach, a fee schedule applied
  // per currency, or a reference that does not resolve is a real violation
  // they were never written to see. The oracles are pinned for cross-study
  // comparability (P1's freeze), so the honest assertion is that they still
  // confirm everything they confirmed in P1 — not that they cover the world.
  const confirmed = new Set(result.traces.filter((row) => row.columns.oracle_confirmed).map((row) => row.fault));
  assert.deepEqual(
    [...DEVELOPMENT_FAULT_IDS, ...HELD_OUT_FAULT_IDS].filter((id) => !confirmed.has(id)),
    [],
    "column one still confirms every fault that was public before the sealed round",
  );

  const categories = Object.values(summary.by_category);
  assert.equal(
    categories.reduce((total, bucket) => total + bucket.faults, 0),
    FAULT_IDS.length,
  );
  assert.equal(categories.length, CATEGORY_IDS.length, "every category is populated");
  assert.equal(summary.by_category["temporal-boundary"].fault_ids.length, 3);
  assert.equal(summary.by_category["authorization"].fault_ids.length, 2);
});

// ------------------------------------------------------------------- the CLI

test("the CLI finds a report beside a HAR, inside a run directory, and by flag", () => {
  const entries = recordings.get("f-close-ghost").faulty;
  const cited = indexOf(entries, "POST", "/transfers", { last: true });
  const report = reportWith({
    rule: "lifecycle",
    check: {
      title: "a closed account transacted",
      evidence: { entries: [{ index: cited }] },
    },
  });

  const harFile = path.join(workspace, "cli", "agent-suite-close-ghost.har");
  writeHarFile(harFile, entries, { label: "f-close-ghost", meta: { arm: "agent-suite" } });
  fs.writeFileSync(path.join(workspace, "cli", "agent-suite-close-ghost.report.json"), JSON.stringify(report));

  const beside = main(["--quiet", harFile]);
  assert.equal(beside.result.summary.reports_attached, 1);
  assert.equal(beside.result.traces[0].columns.reported_with_evidence, true);
  assert.match(beside.stdout, /Two-column detection and funnel/);
  assert.match(beside.stdout, /Per category/);

  const runDir = writePlaytestRun(path.join(workspace, "cli", "runs", "close-ghost"), entries, {
    label: "f-close-ghost",
  });
  fs.writeFileSync(path.join(runDir, "suite-report.json"), JSON.stringify(report));
  const inside = main(["--quiet", runDir]);
  assert.equal(inside.result.summary.reports_attached, 1);
  assert.equal(inside.result.traces[0].columns.reported_with_evidence, true);

  const bare = path.join(workspace, "cli", "bare.har");
  writeHarFile(bare, entries, { label: "f-close-ghost" });
  const flagged = main(["--quiet", "--report", "f-close-ghost=" + path.join(workspace, "cli", "agent-suite-close-ghost.report.json"), bare]);
  assert.equal(flagged.result.summary.reports_attached, 1);
  assert.equal(main(["--quiet", bare]).result.summary.reports_attached, 0);

  assert.equal(main(["--report", "nonsense", bare]).code, 2);
  assert.equal(main(["--report", "no-such-trace=" + harFile, bare]).code, 2);
});

test("the CLI goes red on a reported false positive alone", () => {
  const entries = recordings.get("f-error-200").clean;
  const har = path.join(workspace, "fp", "variant.har");
  writeHarFile(har, entries, { label: "clean.wide-ids" });
  fs.writeFileSync(
    path.join(workspace, "fp", "variant.report.json"),
    JSON.stringify(
      reportWith({
        rule: "lifecycle",
        check: { title: "account ids are 14 characters", evidence: { entries: [{ index: 1 }] } },
      }),
    ),
  );

  const outcome = main([har]);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stdout, /reported: 1 failing check/);
  assert.match(outcome.stdout, /account ids are 14 characters/);
});
