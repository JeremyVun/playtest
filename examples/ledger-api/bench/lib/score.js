// Scoring: turn oracle output into the P1 measurement metrics
// (BUILD_PLAN P0 scope 6 / P1 scope 6) — detection with evidence correctness,
// false positives on clean builds, request and step counts, wall time, and
// cost where the trace's own metadata carries it.
//
// Nothing here is a judgement call: a detection counts only when an oracle
// fired, and it counts as *correctly evidenced* only when the oracle that fired
// is one the labelled fault can actually cause and the violation cites a real
// request in the trace.

import { scoreTrace, ORACLE_IDS } from "./oracles.js";
import { route } from "./trace.js";
import { FAULT_IDS, FAULT_TIERS, FAULT_CATEGORIES, CATEGORY_IDS } from "../../src/faults.js";
import { scoreFunnel, reportedFalsePositives, FUNNEL_STAGES } from "./funnel.js";

/**
 * What each fault must look like when an oracle catches it: the codes it can
 * produce, and the routes whose exchange the evidence should cite. The
 * development set is listed first; the sealed held-out set ships its own
 * expectations with it (DESIGN §6.3) and adds only entries, so the oracles and
 * the scoring rules the round freezes are untouched.
 *
 * **`codes: []` means the pinned oracles have no vocabulary for this fault's
 * rule.** The seven oracles are one frozen instrument covering seven declared
 * invariants; the fault taxonomy is a statement about what a test author has to
 * *do*, and it is deliberately wider. A fault outside the oracles' vocabulary
 * is not a fault column one missed — it is one column one cannot speak to, and
 * it scores `detected: null`, never `false`. That is the same
 * unknown-is-never-false rule the funnel already follows
 * (`studies/api-suite/PREREGISTRATION.md` §6.2): conflating "the artifacts
 * cannot answer" with "the arm failed" damns an arm for free, and here it would
 * also turn every round red for a reason that has nothing to do with the arm.
 * Column two and the per-fault witness are what score those faults.
 *
 * Every catalogued fault needs an entry, empty codes included, so that a fault
 * added without thinking about how it is scored is a loud test failure rather
 * than a silent `null`.
 */
export const FAULT_EXPECTATIONS = Object.freeze({
  "f-error-200": { codes: ["failure_masked_as_2xx"], routes: ["transfers_create"] },
  "f-undocumented-500": { codes: ["unexpected_server_error"], routes: ["transfers_create"] },
  "f-fee-rounding-drift": { codes: ["transfer_entries_nonzero"], routes: ["account_entries"] },
  "f-idempotency-replay-double": {
    codes: ["phantom_ledger_effect", "idempotency_key_diverged"],
    routes: ["account_entries", "transfers_create"],
  },
  "f-settle-cancel-race": {
    codes: ["cancel_after_settlement", "transfer_entries_nonzero"],
    routes: ["transfer_cancel", "account_entries"],
  },
  "f-close-ghost": { codes: ["transfer_on_closed_account"], routes: ["transfers_create"] },
  "f-pagination-dup": { codes: ["duplicate_entry_in_enumeration"], routes: ["account_entries"] },
  "f-balance-cache-stale": { codes: ["stored_balance_diverged"], routes: ["account_get", "account_entries"] },
  // held-out set
  "f-cursor-error-bare": { codes: ["error_envelope_violation"], routes: ["account_entries"] },
  "f-close-pending-inbound": { codes: ["close_with_pending_transfers"], routes: ["account_close"] },
  "f-settle-failed-debit": { codes: ["stored_balance_diverged"], routes: ["account_get", "account_entries"] },
  "f-idempotency-day-expiry": { codes: ["idempotency_key_diverged"], routes: ["transfers_create"] },
  "f-fee-double-charged": { codes: ["transfer_entries_nonzero"], routes: ["account_entries"] },
  // S0 sealed set. Four of the fourteen break a rule one of the seven pinned
  // oracles already owns; the other ten are outside their vocabulary — the
  // fee schedule, ownership, receipts, page shape, documented parameters, and
  // the ledger day are rules the P1 instrument was never written against, and
  // the oracles stay byte-identical so the probe rematch remains comparable.
  // Those ten are scored on column two and their witnesses, and column one
  // reports `null` for them rather than a miss.
  "f-activate-after-close": { codes: [], routes: ["account_activate", "account_get"] },
  "f-transfer-to-pending-destination": {
    codes: ["transfer_on_inactive_account"],
    routes: ["transfers_create"],
  },
  "f-deposit-entry-mismatch": { codes: [], routes: ["deposit_get", "account_entries"] },
  "f-fee-account-balance-untouched": {
    codes: ["stored_balance_diverged"],
    routes: ["account_get", "account_entries"],
  },
  "f-eur-fee-flat": { codes: [], routes: ["transfers_create", "transfer_get"] },
  "f-include-closed-ignored": { codes: [], routes: ["accounts_list"] },
  "f-transfers-filter-after-page": { codes: [], routes: ["transfers_list"] },
  "f-idempotency-conflict-ignored": { codes: [], routes: ["transfers_create"] },
  "f-idempotency-freed-by-cancel": {
    codes: ["idempotency_key_diverged"],
    routes: ["transfers_create", "transfer_cancel"],
  },
  "f-day-usage-carryover": { codes: [], routes: ["transfers_create", "admin_tick"] },
  "f-tick-day-skips-settlement": { codes: [], routes: ["admin_tick", "transfer_get"] },
  "f-entries-cross-principal": { codes: [], routes: ["account_entries"] },
  "f-transfer-source-unowned": { codes: [], routes: ["transfers_create"] },
  "f-same-account-envelope-bare": { codes: ["error_envelope_violation"], routes: ["transfers_create"] },
});

/** Can the pinned oracles confirm this fault at all? */
export const columnOneCovers = (fault) => (FAULT_EXPECTATIONS[fault]?.codes.length ?? 0) > 0;

/** Faults with no expectation entry: a catalog and a scoring table out of step. */
export const faultsWithoutExpectations = () => FAULT_IDS.filter((fault) => !FAULT_EXPECTATIONS[fault]);

const CLEAN_LABELS = new Set(["clean", "clean-build", "none"]);

/**
 * Resolve a trace label into `{ kind, fault, variant }`.
 *
 * A conforming-variant or jittered build is still a clean build for scoring
 * purposes — any finding on it is a false positive (DESIGN §7) — so its label is
 * `clean.<variant>`: `clean.terse-optionals`, `clean.jitter`, `clean.wide-ids`.
 * The variant name is carried through so the report can say *which* conforming
 * implementation a check snapshotted.
 */
export function classifyLabel(label) {
  if (label === null || label === undefined || label === "") return { kind: "unlabeled", fault: null, variant: null };
  if (CLEAN_LABELS.has(label)) return { kind: "clean", fault: null, variant: null };
  if (FAULT_IDS.includes(label)) return { kind: "faulty", fault: label, variant: null };
  const variant = /^clean[.](.+)$/.exec(label);
  if (variant) return { kind: "clean", fault: null, variant: variant[1] };
  return { kind: "other", fault: null, variant: null };
}

/**
 * Does this violation cite evidence that actually exists in the trace, and does
 * it point at the kind of request the fault lives in?
 */
function evidenceCheck(violation, trace, expectation) {
  const index = violation.evidence?.request?.index;
  const cited = Number.isInteger(index) ? trace.exchanges[index] : undefined;
  if (!cited) return { resolvable: false, on_target: false };
  const routes = [cited, ...(violation.evidence.supporting ?? [])
    .map((support) => trace.exchanges[support.index])
    .filter(Boolean)].map((exchange) => route(exchange).kind);
  const on_target = expectation ? routes.some((kind) => expectation.routes.includes(kind)) : false;
  return { resolvable: true, on_target, cited_routes: routes };
}

/** Score a single trace into a report row. */
export function scoreOne(trace) {
  const { violations, applicability, facts } = scoreTrace(trace);
  const { kind, fault, variant } = classifyLabel(trace.label);
  const expectation = fault ? FAULT_EXPECTATIONS[fault] : null;
  const report = trace.report ?? null;

  const enriched = violations.map((violation) => {
    const check = evidenceCheck(violation, trace, expectation);
    return {
      ...violation,
      evidence_resolvable: check.resolvable,
      on_target: expectation ? check.on_target : null,
      expected_for_label: expectation ? expectation.codes.includes(violation.code) : null,
    };
  });

  const onTargetHits = enriched.filter(
    (violation) => violation.expected_for_label === true && violation.evidence_resolvable && violation.on_target,
  );
  // `null` where column one cannot speak: no label, or a fault whose rule the
  // pinned oracles do not cover.
  const scorable = kind === "faulty" && columnOneCovers(fault);
  const detected = scorable ? enriched.some((violation) => violation.expected_for_label === true) : null;

  // Column two (DESIGN N10) and the five-stage funnel, from the structured suite
  // report recorded beside this trace. Absent a report both stay null: a trace
  // with no report is a one-column measurement, not a failed one.
  const second =
    kind === "faulty"
      ? scoreFunnel({ trace, fault, expectation, facts, violations, report })
      : { columns: {}, funnel: null, witness: null, attributions: [] };
  const reportedFp = kind === "clean" ? reportedFalsePositives({ trace, report }) : { total: 0, checks: [] };

  return {
    id: trace.id,
    source: trace.source,
    arm: trace.meta.arm ?? trace.source,
    label: trace.label ?? null,
    label_kind: kind,
    label_variant: variant,
    fault,
    fault_tier: fault ? FAULT_TIERS[fault] : null,
    fault_category: fault ? (FAULT_CATEGORIES[fault] ?? null) : null,
    column_one_covered: kind === "faulty" ? columnOneCovers(fault) : null,
    requests: trace.exchanges.length,
    steps: trace.meta.steps ?? null,
    wall_ms: trace.meta.wall_ms ?? null,
    cost_usd: trace.meta.cost_usd ?? null,
    applicability,
    oracles_applicable: ORACLE_IDS.filter((id) => applicability[id]),
    violations: enriched,
    detected,
    evidence_correct: detected === null ? null : onTargetHits.length > 0,
    // The two columns, side by side and never merged: the shared oracle over the
    // traffic, and the suite's own report with its citations resolved.
    columns: {
      oracle_confirmed: detected === null ? null : detected && onTargetHits.length > 0,
      reported_with_evidence: second.columns.reported_with_evidence ?? null,
      reported_with_evidence_strict: second.columns.reported_with_evidence_strict ?? null,
      reported_without_evidence: second.columns.reported_without_evidence ?? null,
    },
    funnel: second.funnel,
    witness: second.witness,
    attributions: second.attributions,
    report: report
      ? {
          source: report.source,
          shape: report.shape,
          checks: report.checks.length,
          failing: report.checks.filter((check) => check.status === "fail").length,
          obligations: report.obligations.length,
          obligations_unaccounted: report.obligations.filter(
            (obligation) => obligation.status === "skipped" && !obligation.reason,
          ).length,
          defects: report.defects.length,
          problems: report.problems,
        }
      : null,
    // A violation on a build with no fault enabled is a false positive by
    // definition; on a faulty build, violations outside the fault's expected
    // codes are reported separately rather than counted against the arm.
    false_positives: kind === "clean" ? enriched.length : 0,
    reported_false_positives: reportedFp.total,
    reported_false_positive_checks: reportedFp.checks,
    off_target_violations: kind === "faulty" ? enriched.filter((v) => v.expected_for_label !== true).length : 0,
    path: trace.meta.path ?? null,
  };
}

const sum = (rows, key) =>
  rows.reduce((total, row) => (Number.isFinite(row[key]) ? total + row[key] : total), 0);

const isFaulty = (row) => row.label_kind === "faulty";

/** Score every trace and aggregate the arm-level metrics. */
export function scoreAll(traces) {
  const rows = traces.map(scoreOne);

  const byFault = {};
  for (const row of rows.filter(isFaulty)) {
    const bucket = (byFault[row.fault] ??= {
      fault: row.fault,
      tier: row.fault_tier,
      category: row.fault_category,
      traces: 0,
      detected: 0,
      evidence_correct: 0,
      oracle_confirmed: 0,
      reported_with_evidence: 0,
      reported_without_evidence: 0,
      reports_attached: 0,
      funnel: Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, { true: 0, false: 0, unknown: 0 }])),
      diagnoses: {},
      arms: {},
    });
    bucket.traces += 1;
    if (row.detected) bucket.detected += 1;
    if (row.evidence_correct) bucket.evidence_correct += 1;
    if (row.columns.oracle_confirmed) bucket.oracle_confirmed += 1;
    if (row.report) bucket.reports_attached += 1;
    if (row.columns.reported_with_evidence) bucket.reported_with_evidence += 1;
    if (row.columns.reported_without_evidence) bucket.reported_without_evidence += 1;
    for (const stage of FUNNEL_STAGES) {
      const value = row.funnel?.stages?.[stage];
      bucket.funnel[stage][value === true ? "true" : value === false ? "false" : "unknown"] += 1;
    }
    if (row.funnel) bucket.diagnoses[row.funnel.diagnosis] = (bucket.diagnoses[row.funnel.diagnosis] ?? 0) + 1;
    const arm = (bucket.arms[row.arm] ??= { traces: 0, detected: 0, oracle_confirmed: 0, reported_with_evidence: 0 });
    arm.traces += 1;
    if (row.detected) arm.detected += 1;
    if (row.columns.oracle_confirmed) arm.oracle_confirmed += 1;
    if (row.columns.reported_with_evidence) arm.reported_with_evidence += 1;
  }

  // Per category (BUILD_PLAN S0 scope 3): a fault counts for a category once,
  // however many trials replayed against it — three suites replayed against the
  // same fault are repeated measurements, not extra fault samples (N12).
  const byCategory = {};
  for (const category of CATEGORY_IDS) {
    const buckets = Object.values(byFault).filter((bucket) => bucket.category === category);
    if (buckets.length === 0) continue;
    byCategory[category] = {
      category,
      faults: buckets.length,
      fault_ids: buckets.map((bucket) => bucket.fault),
      oracle_confirmed: buckets.filter((bucket) => bucket.oracle_confirmed > 0).length,
      reported_with_evidence: buckets.filter((bucket) => bucket.reported_with_evidence > 0).length,
      missed_both: buckets.filter((bucket) => bucket.oracle_confirmed === 0 && bucket.reported_with_evidence === 0)
        .map((bucket) => bucket.fault),
      diagnoses: buckets.reduce((total, bucket) => {
        for (const [diagnosis, count] of Object.entries(bucket.diagnoses)) {
          total[diagnosis] = (total[diagnosis] ?? 0) + count;
        }
        return total;
      }, {}),
    };
  }

  const cleanRows = rows.filter((row) => row.label_kind === "clean");
  const falsePositivesByOracle = {};
  for (const row of cleanRows) {
    for (const violation of row.violations) {
      falsePositivesByOracle[violation.oracle] = (falsePositivesByOracle[violation.oracle] ?? 0) + 1;
    }
  }
  const falsePositivesByLabel = {};
  for (const row of cleanRows) {
    const key = row.label ?? "clean";
    const bucket = (falsePositivesByLabel[key] ??= { traces: 0, oracle: 0, reported: 0 });
    bucket.traces += 1;
    bucket.oracle += row.false_positives;
    bucket.reported += row.reported_false_positives;
  }

  const detectedFaults = Object.values(byFault).filter((bucket) => bucket.detected > 0).length;
  return {
    traces: rows,
    summary: {
      trace_count: rows.length,
      clean_traces: cleanRows.length,
      faulty_traces: rows.filter(isFaulty).length,
      unlabeled_traces: rows.filter((row) => row.label_kind === "unlabeled").length,
      reports_attached: rows.filter((row) => row.report).length,
      faults_seen: Object.keys(byFault).length,
      faults_detected: detectedFaults,
      // Faults the pinned oracles have no rule for: reported so a reader can
      // see the denominator column one was actually scored against.
      faults_without_column_one: Object.keys(byFault).filter((fault) => !columnOneCovers(fault)).length,
      faults_evidence_correct: Object.values(byFault).filter((bucket) => bucket.evidence_correct > 0).length,
      columns: {
        oracle_confirmed: Object.values(byFault).filter((bucket) => bucket.oracle_confirmed > 0).length,
        reported_with_evidence: Object.values(byFault).filter((bucket) => bucket.reported_with_evidence > 0).length,
        reported_without_evidence: Object.values(byFault).filter((bucket) => bucket.reported_without_evidence > 0)
          .length,
      },
      detections: byFault,
      by_category: byCategory,
      false_positives: {
        total: sum(cleanRows, "false_positives"),
        clean_traces_with_findings: cleanRows.filter((row) => row.false_positives > 0).length,
        by_oracle: falsePositivesByOracle,
        // Column two's false positives: a suite check failing a build that is
        // conforming — the canonical clean build, a conforming variant, or a
        // jittered repeat.
        reported: sum(cleanRows, "reported_false_positives"),
        clean_traces_with_reported_findings: cleanRows.filter((row) => row.reported_false_positives > 0).length,
        by_label: falsePositivesByLabel,
      },
      totals: {
        requests: sum(rows, "requests"),
        steps: sum(rows, "steps"),
        wall_ms: sum(rows, "wall_ms"),
        cost_usd: Number(sum(rows, "cost_usd").toFixed(6)),
      },
    },
  };
}
