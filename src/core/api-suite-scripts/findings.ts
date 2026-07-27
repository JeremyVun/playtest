import type { DynamicValue } from "./types.ts";

// Candidate findings from a script execution
// (docs/contracts/scripts.md#findings).
//
// N5: a failing check on a SOUND suite is a candidate finding, not a defect and
// not a revision trigger. This module is the one place that turns a report into
// the finding list a human judges — the CLI prints it, the authoring job puts it
// in the bundle, and S4's approval screen renders it.
//
// The re-verification the design asks for happens here and is mechanical: a
// finding carries the recorded exchanges its check cited, read back out of the
// HAR the parent wrote. A failing check whose citations resolve to nothing is
// reported as `evidence_verified: false`, which the authoring loop treats as a
// reason not to terminate — an unevidenced accusation is not a finding.
import { redactSecrets } from "../secrets.ts";

/** Finding shape version, carried in the authoring bundle. */
export const SCRIPT_FINDING_VERSION = 1;

const exchangeOf = (entry: DynamicValue, index: DynamicValue) => {
  if (!entry) return null;
  return {
    har_entry: index,
    method: entry.request?.method ?? null,
    url: redactSecrets(entry.request?.url ?? ""),
    status: entry.response?.status ?? null,
    ...(entry.time === undefined ? {} : { time_ms: Math.round(entry.time) }),
  };
};

/**
 * Candidate findings from one execution.
 *
 * @param {object} report a script report
 * @param {{ harEntries?: object[] }} [context] the recorded HAR entries, for evidence read-back
 * @returns {object[]} findings, report-column first, then the HAR column
 */
export function scriptFindings(report: DynamicValue, { harEntries = [] }: DynamicValue = {}) {
  const findings: DynamicValue = [];
  const obligations: DynamicValue = new Map((report?.obligations?.entries ?? []).map((entry: DynamicValue) => [entry.id, entry]));

  for (const check of report?.checks ?? []) {
    if (check.pass) continue;
    const cited = check.evidence?.har_entries ?? [];
    const exchanges = cited.map((index: DynamicValue) => exchangeOf(harEntries[index], index)).filter(Boolean);
    findings.push({
      finding_version: SCRIPT_FINDING_VERSION,
      source: "check",
      id: check.id,
      obligation: check.obligation ?? null,
      statement: obligations.get(check.obligation)?.statement ?? null,
      title: check.title ?? check.id,
      expected: check.expected ?? null,
      observed: check.observed ?? null,
      note: check.note ?? null,
      evidence: { har_entries: cited, exchanges, subject: check.evidence?.subject ?? null },
      // Mechanical, not a judgement: did the citation resolve into recorded traffic?
      evidence_verified: exchanges.length > 0,
    });
  }

  for (const gate of report?.gate?.checks ?? []) {
    if (gate.pass !== false || gate.applicable === false) continue;
    const cited = gate.har_entries ?? [];
    findings.push({
      finding_version: SCRIPT_FINDING_VERSION,
      source: "policy",
      id: `policy:${gate.spec ?? gate.policy}`,
      obligation: gate.obligation ?? null,
      statement: obligations.get(gate.obligation)?.statement ?? null,
      title: `${gate.policy} (Tier ${gate.tier}) failed over the recorded traffic`,
      expected: gate.spec ?? gate.policy,
      observed: gate.detail ?? null,
      note: null,
      evidence: { har_entries: cited, exchanges: cited.map((index: DynamicValue) => exchangeOf(harEntries[index], index)).filter(Boolean), subject: null },
      evidence_verified: cited.length > 0,
    });
  }

  return findings;
}

/** A short, stable one-line summary for a log or a feed event. */
export const summarizeFindings = (findings: Array<{ id: DynamicValue }>) =>
  findings.length === 0
    ? "no findings"
    : `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${findings
        .slice(0, 3)
        .map((finding) => finding.id)
        .join(", ")}${findings.length > 3 ? `, and ${findings.length - 3} more` : ""}`;

/**
 * Render findings for a terminal. Plain text with no colour codes: the CLI adds
 * its own styling, and the hosted job log wants the same words.
 * @param {object[]} findings
 * @param {{ maxExchanges?: number }} [options]
 * @returns {string}
 */
export function formatScriptFindings(findings: DynamicValue, { maxExchanges = 4 }: DynamicValue = {}) {
  if (!findings.length) return "No findings: every check passed and the HAR column held.";
  const lines = [`${findings.length} candidate finding${findings.length === 1 ? "" : "s"} — each is a claim about the API, for a human to judge:`, ""];
  findings.forEach((finding: DynamicValue, index: DynamicValue) => {
    lines.push(`${index + 1}. ${finding.title}`);
    lines.push(`   id         ${finding.id}${finding.source === "policy" ? "  (HAR column)" : ""}`);
    if (finding.obligation) lines.push(`   obligation ${finding.obligation}`);
    if (finding.statement) lines.push(`   rule       ${finding.statement}`);
    if (finding.expected !== null) lines.push(`   expected   ${finding.expected}`);
    if (finding.observed !== null) lines.push(`   observed   ${finding.observed}`);
    if (finding.note) lines.push(`   note       ${finding.note}`);
    if (finding.evidence.exchanges.length) {
      lines.push("   evidence");
      for (const exchange of finding.evidence.exchanges.slice(0, maxExchanges)) {
        lines.push(`     [${exchange.har_entry}] ${exchange.method} ${exchange.url} → ${exchange.status}`);
      }
      const hidden = finding.evidence.exchanges.length - maxExchanges;
      if (hidden > 0) lines.push(`     … and ${hidden} more recorded exchange${hidden === 1 ? "" : "s"}`);
    } else {
      lines.push("   evidence   none that resolves — this finding is not backed by recorded traffic");
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
