// Plain-text rendering of a bench result. No colour, no spinners: the output
// is meant to be pasted into a study report and diffed between rounds.

import { ORACLE_IDS } from "./oracles.js";
import { FUNNEL_STAGES } from "./funnel.js";

/** Funnel stages, abbreviated for a five-column table. */
const STAGE_HEADS = Object.freeze(["enum", "reach", "manif", "assert", "cite"]);
const flag = (value) => (value === true ? "y" : value === false ? "NO" : "?");

const dash = (value) => (value === null || value === undefined ? "-" : String(value));
const ms = (value) => (Number.isFinite(value) ? `${Math.round(value)}` : "-");
const usd = (value) => (Number.isFinite(value) ? value.toFixed(4) : "-");

function table(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column] ?? "").length)),
  );
  const line = (cells) => cells.map((cell, column) => String(cell ?? "").padEnd(widths[column])).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

/** One line per violation, with the request it cites. */
export function formatViolation(violation) {
  const request = violation.evidence?.request ?? {};
  const where =
    request.method && request.path
      ? `#${request.index} ${request.method} ${request.path} -> ${request.status}`
      : `#${request.index}`;
  return `${violation.oracle}/${violation.code} at ${where}: ${violation.message}`;
}

export function formatReport({ traces, summary }, { verbose = true } = {}) {
  const out = [];

  out.push(
    table(
      ["trace", "source", "label", "req", "steps", "wall_ms", "cost", "oracles", "detect", "evid", "findings"],
      traces.map((row) => [
        row.id,
        row.source,
        dash(row.label),
        row.requests,
        dash(row.steps),
        ms(row.wall_ms),
        usd(row.cost_usd),
        `${row.oracles_applicable.length}/${ORACLE_IDS.length}`,
        row.detected === null ? "-" : row.detected ? "yes" : "NO",
        row.evidence_correct === null ? "-" : row.evidence_correct ? "ok" : "BAD",
        row.violations.length,
      ]),
    ),
  );

  if (verbose) {
    for (const row of traces) {
      if (!row.violations.length) continue;
      out.push("", `${row.id} [${dash(row.label)}]`);
      for (const violation of row.violations) {
        const tag =
          row.label_kind === "clean"
            ? "FALSE POSITIVE"
            : violation.expected_for_label === true
              ? "on-label"
              : row.label_kind === "faulty"
                ? "off-label"
                : "finding";
        out.push(`  - [${tag}] ${formatViolation(violation)}`);
        for (const support of violation.evidence?.supporting ?? []) {
          out.push(`      support #${support.index}: ${support.note ?? ""}`.trimEnd());
        }
      }
    }
  }

  // Column two and the funnel, only when an arm actually shipped a report: an
  // empty table would read as a row of misses rather than as an absent input.
  const withReports = traces.filter((row) => row.report);
  if (withReports.length) {
    out.push("", "Two-column detection and funnel (per fault-labelled trace with a report)");
    out.push(
      table(
        ["trace", "label", "arm", "oracle", "reported", "strict", ...STAGE_HEADS, "diagnosis"],
        traces
          .filter((row) => row.label_kind === "faulty")
          .map((row) => [
            row.id,
            dash(row.label),
            row.arm,
            flag(row.columns.oracle_confirmed),
            flag(row.columns.reported_with_evidence),
            flag(row.columns.reported_with_evidence_strict),
            ...FUNNEL_STAGES.map((stage) => flag(row.funnel?.stages?.[stage])),
            row.funnel?.diagnosis ?? "-",
          ]),
      ).replace(/^/gm, "  "),
    );

    if (verbose) {
      for (const row of withReports) {
        const problems = row.report.problems ?? [];
        if (!problems.length && !row.report.defects) continue;
        if (problems.length) {
          out.push("", `${row.id} report hygiene (${row.report.source ?? "attached"}, ${row.report.shape})`);
          for (const problem of problems) out.push(`  - ${problem}`);
        }
      }
      for (const row of traces.filter((r) => r.label_kind === "faulty" && r.attributions?.length)) {
        const attributed = row.attributions.filter((item) => item.attributed);
        if (!attributed.length) continue;
        out.push("", `${row.id} reported checks attributed to ${row.fault}`);
        for (const item of attributed) {
          out.push(
            `  - ${item.check_id} [${item.attribution.join("+")}] ` +
              `${item.citations_resolved}/${item.citations_total} citations resolve` +
              `${item.evidence_correct ? ", on target" : ", NOT on target"}`,
          );
          for (const citation of item.citations.filter((c) => !c.resolved)) {
            out.push(`      unresolved: ${JSON.stringify(citation.cited)} — ${citation.reason}`);
          }
        }
      }
    }
  }

  if (Object.keys(summary.by_category ?? {}).length) {
    out.push("", "Per category (a fault counts once, however many trials replayed it)");
    out.push(
      table(
        ["category", "faults", "oracle", "reported", "missed by both", "diagnoses"],
        Object.values(summary.by_category).map((bucket) => [
          bucket.category,
          bucket.faults,
          `${bucket.oracle_confirmed}/${bucket.faults}`,
          `${bucket.reported_with_evidence}/${bucket.faults}`,
          bucket.missed_both.join(", ") || "-",
          Object.entries(bucket.diagnoses)
            .map(([diagnosis, count]) => `${diagnosis} ${count}`)
            .join(", ") || "-",
        ]),
      ).replace(/^/gm, "  "),
    );
  }

  out.push("", "Detection");
  const detections = Object.values(summary.detections);
  if (detections.length === 0) {
    out.push("  (no fault-labelled traces)");
  } else {
    out.push(
      table(
        ["fault", "tier", "traces", "detected", "evidence ok", "arms"],
        detections.map((bucket) => [
          bucket.fault,
          bucket.tier,
          bucket.traces,
          bucket.detected,
          bucket.evidence_correct,
          Object.entries(bucket.arms)
            .map(([arm, stats]) => `${arm} ${stats.detected}/${stats.traces}`)
            .join(", "),
        ]),
      ).replace(/^/gm, "  "),
    );
    const uncovered = summary.faults_without_column_one ?? 0;
    out.push(
      `  faults detected: ${summary.faults_detected}/${summary.faults_seen - uncovered}` +
        (uncovered > 0 ? ` (${uncovered} fault(s) outside the pinned oracles' vocabulary, scored on column two)` : ""),
    );
  }

  out.push("", "False positives (clean and conforming-variant builds)");
  out.push(
    `  oracle:   ${summary.false_positives.total} finding(s) across ${summary.clean_traces} conforming trace(s); ` +
      `${summary.false_positives.clean_traces_with_findings} trace(s) affected`,
  );
  for (const [oracle, count] of Object.entries(summary.false_positives.by_oracle)) {
    out.push(`    ${oracle}: ${count}`);
  }
  out.push(
    `  reported: ${summary.false_positives.reported} failing check(s); ` +
      `${summary.false_positives.clean_traces_with_reported_findings} trace(s) affected`,
  );
  for (const [label, bucket] of Object.entries(summary.false_positives.by_label ?? {})) {
    if (bucket.oracle === 0 && bucket.reported === 0) continue;
    out.push(`    ${label}: oracle ${bucket.oracle}, reported ${bucket.reported} (${bucket.traces} trace(s))`);
  }
  if (verbose) {
    for (const row of traces.filter((r) => r.reported_false_positives > 0)) {
      out.push(`  ${row.id} [${dash(row.label)}] failing checks on a conforming build:`);
      for (const check of row.reported_false_positive_checks) {
        out.push(
          `    - ${check.check_id}${check.rule ? ` (${check.rule})` : ""}: ${check.title ?? ""}`.trimEnd() +
            ` — ${check.citations_resolved}/${check.citations_total} citations resolve`,
        );
      }
    }
  }

  out.push("", "Totals");
  out.push(
    `  traces ${summary.trace_count} (clean ${summary.clean_traces}, faulty ${summary.faulty_traces}, ` +
      `unlabelled ${summary.unlabeled_traces})`,
  );
  out.push(
    `  requests ${summary.totals.requests}  steps ${summary.totals.steps}  ` +
      `wall ${ms(summary.totals.wall_ms)}ms  cost $${summary.totals.cost_usd.toFixed(4)}`,
  );

  return out.join("\n");
}
