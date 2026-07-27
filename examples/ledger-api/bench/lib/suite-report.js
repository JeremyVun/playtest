// The structured suite report: the bench's second input, beside the HAR.
//
// P1 scored every arm with one shared oracle over recorded traffic, and that
// instrument turned out to be biased: the agent-authored suite *reported* a
// held-out fault correctly, naming the offending ledger row, and the oracle
// refused to credit it because its applicability window never opened
// (`studies/api-probe/REPORT.md` §3). DESIGN N10 is the fix — verdicts are
// two-column — and this module reads the second column's input.
//
// A report is scored offline, from artifacts alone. Nothing here calls a model,
// touches the network, or trusts the report's own conclusion: a claimed
// violation counts only when the entries it cites resolve in the HAR recorded
// beside it (`funnel.js` does the resolving).
//
// ## The v0 shape
//
// This is the shape the S1 substrate is being built to, and it is deliberately
// the data model the P1 agent-authored suite already had
// (`studies/api-probe/comparators/agent-suite/lib/report.mjs`) rather than a
// new invention: named checks, an evidence list citing requests, and a channel
// for suite defects that is *not* the check-failure channel (N5 depends on the
// distinction — a script that crashed did not "find" anything).
//
//   {
//     "schema": "playtest.suite-report/v0",
//     "suite":  { "id": "agent-suite", "trial": "t1", "version": "…" },
//     "target": { "base_url": "http://127.0.0.1:4193", "label": "f-close-ghost" },
//     "totals": { "requests": 285, "wall_ms": 260 },
//     "obligations": [
//       { "id": "rule-1-conservation", "rule": "conservation",
//         "category": "cross-resource-invariant",
//         "status": "covered" | "skipped" | "unsupported",
//         "reason": null, "checks": ["settlement/usd-conservation"] }
//     ],
//     "checks": [
//       { "id": "settlement/usd-conservation", "obligation": "rule-1-conservation",
//         "rule": "conservation", "status": "pass" | "fail" | "not_exercised" | "error",
//         "title": "a settled transfer's entries sum to zero",
//         "expected": "…", "observed": "…",
//         "evidence": {
//           "entries": [ { "index": 41, "method": "GET", "path": "/accounts/acc_x/entries",
//                          "status": 200, "note": "…" } ],
//           "subject": { "transfer_id": "tr_x", "entry_ids": ["ent_y"] }
//         } }
//     ],
//     "defects": [ { "scenario": "pagination", "message": "the suite could not build …" } ],
//     "warnings": [ { "title": "…", "detail": "…" } ]
//   }
//
// A citation may address a HAR entry three ways, in this order of preference:
//
//   { "index": 41 }                     wire position in the HAR (0-based)
//   { "entry_id": "e41" }               an id the recorder stamped on the entry
//   { "method": "POST", "path": "/…" }  descriptive; must match exactly one entry
//
// ## The other two shapes this reads
//
// **The S1 script report** (`script_report_version: 1`,
// `src/core/schemas/script-report.schema.json`): checks carry `pass` +
// `exercised` instead of a status string, and cite evidence as
// `evidence.har_entries: [index]`. It is read natively, because the study's
// substrate may be either this or the v0 above and the preregistration pins
// exactly one — the bench must not be the reason a substrate cannot be chosen.
//
// **The P1 agent-suite's own shape**: it printed text, not JSON, so its data
// model — `violations[]` + `setupFailures[]` with `evidence[].requests[]` — is
// accepted and normalized too. That keeps every S0 arm scorable by one code path
// whether it emits v0, the S1 report, or the v0-of-the-v0.

import fs from "node:fs";
import path from "node:path";

export const SUITE_REPORT_SCHEMA = "playtest.suite-report/v0";

/** Check statuses. Anything else in a report is a hygiene problem, not a check. */
export const CHECK_STATUSES = Object.freeze(["pass", "fail", "not_exercised", "error"]);

/** Obligation statuses (N5: covered, skipped with an approved reason, or unsupported). */
export const OBLIGATION_STATUSES = Object.freeze(["covered", "skipped", "unsupported", "unaccounted"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (value === undefined || value === null ? null : String(value));

/** Compare rule/obligation names across vocabularies: "errorshape" ≡ "error_shape". */
export function normalizeTag(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Two tags refer to the same rule when their normalized forms contain one
 * another — a suite may call the rule "balance" where the oracle calls it
 * "balance_agreement", and neither spelling is more correct than the other.
 */
export function tagsMatch(left, right) {
  const a = normalizeTag(left);
  const b = normalizeTag(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function normalizeCitation(raw, problems, where) {
  if (!isObject(raw)) {
    problems.push(`${where}: a citation must be an object, got ${JSON.stringify(raw)}`);
    return null;
  }
  const citation = {
    index: Number.isInteger(raw.index) ? raw.index : null,
    entry_id: typeof raw.entry_id === "string" && raw.entry_id ? raw.entry_id : null,
    method: typeof raw.method === "string" ? raw.method.toUpperCase() : null,
    path: typeof raw.path === "string" ? raw.path.replace(/\/+$/, "") || "/" : null,
    status: Number.isInteger(raw.status) ? raw.status : null,
    ordinal: Number.isInteger(raw.ordinal) ? raw.ordinal : null,
    note: text(raw.note),
  };
  if (citation.index === null && citation.entry_id === null && citation.path === null) {
    problems.push(`${where}: a citation must carry an index, an entry_id, or a method+path`);
    return null;
  }
  return citation;
}

const ID_PATTERN = /\b(?:acc|tr|dep|ent)_[0-9a-z_]+\b/g;

/** Every resource identifier a check names, in its subject or in its prose. */
export function namedIds(check) {
  const found = new Set();
  const scan = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(ID_PATTERN)) found.add(match[0]);
      return;
    }
    if (Array.isArray(value)) return value.forEach(scan);
    if (isObject(value)) return Object.values(value).forEach(scan);
  };
  scan(check.title);
  scan(check.expected);
  scan(check.observed);
  scan(check.note);
  scan(check.evidence?.subject);
  for (const citation of check.evidence?.entries ?? []) scan(citation.note);
  return [...found];
}

/**
 * A check's status, across the three shapes: an explicit `status` string, or the
 * S1 report's `pass` + `exercised` booleans (a check that did not run is
 * `not_exercised`, which is a soundness result and never a detection).
 */
function statusOf(raw) {
  if (typeof raw.status === "string") return raw.status;
  if (raw.exercised === false) return "not_exercised";
  if (typeof raw.pass === "boolean") return raw.pass ? "pass" : "fail";
  return "fail";
}

function normalizeCheck(raw, index, problems) {
  const where = `checks[${index}]`;
  if (!isObject(raw)) {
    problems.push(`${where}: a check must be an object`);
    return null;
  }
  const status = statusOf(raw);
  if (!CHECK_STATUSES.includes(status)) {
    problems.push(`${where}: unknown status "${status}" (${CHECK_STATUSES.join(", ")})`);
  }
  const evidence = isObject(raw.evidence) ? raw.evidence : {};
  const rawEntries = Array.isArray(evidence.entries)
    ? evidence.entries
    : Array.isArray(evidence.requests)
      ? evidence.requests
      : Array.isArray(evidence.har_entries)
        ? // The S1 report cites bare HAR entry indices.
          evidence.har_entries.map((entry) => (Number.isInteger(entry) ? { index: entry } : entry))
        : [];
  const entries = rawEntries
    .map((citation, position) => normalizeCitation(citation, problems, `${where}.evidence.entries[${position}]`))
    .filter(Boolean);
  const check = {
    id: text(raw.id) ?? `${text(raw.rule) ?? "check"}#${index}`,
    obligation: text(raw.obligation),
    rule: text(raw.rule) ?? text(raw.invariant),
    category: text(raw.category),
    scenario: text(raw.scenario),
    status: CHECK_STATUSES.includes(status) ? status : "fail",
    title: text(raw.title),
    expected: text(raw.expected),
    observed: text(raw.observed),
    note: text(raw.note),
    occurrences: Number.isInteger(raw.occurrences) && raw.occurrences > 0 ? raw.occurrences : 1,
    evidence: { entries, subject: isObject(evidence.subject) ? evidence.subject : {} },
  };
  if (check.status === "fail" && entries.length === 0) {
    problems.push(`${where} ("${check.id}") fails but cites no HAR entry, so its evidence cannot be checked`);
  }
  check.named_ids = namedIds(check);
  return check;
}

function normalizeObligation(raw, index, problems) {
  const where = `obligations[${index}]`;
  if (!isObject(raw)) {
    problems.push(`${where}: an obligation must be an object`);
    return null;
  }
  const status = text(raw.status) ?? "covered";
  if (!OBLIGATION_STATUSES.includes(status)) {
    problems.push(`${where}: unknown status "${status}" (${OBLIGATION_STATUSES.join(", ")})`);
  }
  if (status === "skipped" && !text(raw.reason)) {
    problems.push(`${where}: a skipped obligation must carry the approved reason it was skipped for`);
  }
  return {
    id: text(raw.id) ?? `obligation#${index}`,
    rule: text(raw.rule) ?? text(raw.invariant) ?? text(raw.statement),
    category: text(raw.category) ?? text(raw.source),
    status,
    reason: text(raw.reason),
    checks: Array.isArray(raw.checks) ? raw.checks.map((value) => text(value)).filter(Boolean) : [],
  };
}

/** The P1 agent-suite's own report data model, mapped onto the v0 shape. */
function fromLegacy(document, problems) {
  const checks = [];
  for (const [index, violation] of (document.violations ?? []).entries()) {
    if (!isObject(violation)) {
      problems.push(`violations[${index}]: expected an object`);
      continue;
    }
    const evidence = Array.isArray(violation.evidence) ? violation.evidence : [];
    const entries = evidence.flatMap((item) => (Array.isArray(item?.requests) ? item.requests : []));
    checks.push({
      id: violation.id ?? `${violation.rule ?? "rule"}::${violation.title ?? index}`,
      rule: violation.rule,
      scenario: violation.scenario,
      status: "fail",
      title: violation.title,
      expected: evidence[0]?.expected ?? violation.expected,
      observed: evidence[0]?.observed ?? violation.observed,
      note: evidence[0]?.note ?? null,
      occurrences: violation.occurrences,
      evidence: { entries, subject: violation.subject ?? {} },
    });
  }
  const defects = [...(document.setupFailures ?? []), ...(document.setup_failures ?? [])];
  return {
    schema: SUITE_REPORT_SCHEMA,
    shape: "legacy-agent-suite",
    suite: isObject(document.suite) ? document.suite : {},
    target: isObject(document.target) ? document.target : {},
    totals: isObject(document.summary) ? document.summary : {},
    obligations: [],
    checks,
    defects,
    warnings: Array.isArray(document.warnings) ? document.warnings : [],
  };
}

/**
 * Normalize any accepted report document. Never throws on a malformed report:
 * every complaint lands in `problems`, because a study must be able to say "the
 * arm's report was unreadable" instead of crashing the bench that says so.
 */
export function normalizeSuiteReport(document, { source = null } = {}) {
  const problems = [];
  if (!isObject(document)) {
    return {
      schema: null,
      shape: "unreadable",
      source,
      suite: {},
      target: {},
      totals: {},
      obligations: [],
      checks: [],
      defects: [],
      warnings: [],
      problems: ["the report is not a JSON object"],
    };
  }

  const legacy = !Array.isArray(document.checks) && (Array.isArray(document.violations) || Array.isArray(document.setupFailures));
  const scriptReportVersion = Number.isInteger(document.script_report_version) ? document.script_report_version : null;
  const base = legacy
    ? fromLegacy(document, problems)
    : {
        schema: text(document.schema) ?? (scriptReportVersion ? `playtest.script-report/v${scriptReportVersion}` : null),
        shape: scriptReportVersion ? `script-report/v${scriptReportVersion}` : "v0",
        suite: isObject(document.suite) ? document.suite : {},
        target: isObject(document.target) ? document.target : {},
        totals: isObject(document.totals) ? document.totals : {},
        obligations: (Array.isArray(document.obligations)
          ? document.obligations
          : isObject(document.obligations) && Array.isArray(document.obligations.entries)
            ? document.obligations.entries
            : []
        ).map((raw, index) => normalizeObligation(raw, index, problems)),
        checks: Array.isArray(document.checks) ? document.checks : [],
        defects: Array.isArray(document.defects) ? document.defects : [],
        warnings: Array.isArray(document.warnings) ? document.warnings : [],
      };

  if (base.shape === "v0" && base.schema && base.schema !== SUITE_REPORT_SCHEMA) {
    problems.push(`unknown report schema "${base.schema}" (this bench reads ${SUITE_REPORT_SCHEMA})`);
  }
  if (base.shape === "v0" && !base.schema) {
    problems.push(`the report declares no schema; assuming ${SUITE_REPORT_SCHEMA}`);
  }
  if (scriptReportVersion && scriptReportVersion !== 1) {
    problems.push(`script_report_version ${scriptReportVersion} is newer than this bench reads (1)`);
  }

  const checks = base.checks.map((raw, index) => normalizeCheck(raw, index, problems)).filter(Boolean);
  const obligations = base.obligations.filter(Boolean);
  const defects = base.defects.map((defect, index) =>
    isObject(defect)
      ? { scenario: text(defect.scenario), message: text(defect.message) ?? JSON.stringify(defect) }
      : { scenario: null, message: `defects[${index}]: ${JSON.stringify(defect)}` },
  );

  const declared = new Set(obligations.map((obligation) => obligation.id));
  for (const check of checks) {
    if (check.obligation && declared.size && !declared.has(check.obligation)) {
      problems.push(`checks "${check.id}" traces to obligation "${check.obligation}", which the report never declares`);
    }
  }

  return {
    schema: base.schema ?? SUITE_REPORT_SCHEMA,
    shape: base.shape,
    source,
    suite: base.suite,
    target: base.target,
    totals: base.totals,
    obligations,
    checks,
    defects,
    warnings: base.warnings,
    problems,
  };
}

/** Failing checks — the second column's candidate detections. */
export const failingChecks = (report) => report.checks.filter((check) => check.status === "fail");

/** Every rule the report *exercised*, whether the check passed or failed. */
export function exercisedTags(report) {
  const tags = new Set();
  for (const obligation of report.obligations) {
    for (const value of [obligation.id, obligation.rule, obligation.category]) if (value) tags.add(value);
  }
  for (const check of report.checks) {
    for (const value of [check.obligation, check.rule, check.category]) if (value) tags.add(value);
  }
  return [...tags];
}

/**
 * Whether the report can answer "was this rule enumerated at all?". A report
 * with only failures in it (the legacy shape) cannot: absence of a rule there
 * means "did not fail", not "was not considered".
 */
export const enumerationIsAnswerable = (report) =>
  report.obligations.length > 0 || report.checks.some((check) => check.status !== "fail");

const REPORT_FILENAMES = Object.freeze(["suite-report.json", "script-report.json", "report.json"]);

/** Read and normalize a report file. */
export function loadSuiteReport(file) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const unreadable = normalizeSuiteReport(null, { source: file });
    return { ...unreadable, problems: [`cannot read ${file}: ${error.message}`] };
  }
  return normalizeSuiteReport(document, { source: file });
}

/**
 * Find the report that belongs to a trace: `<name>.report.json` beside a HAR
 * file, or `suite-report.json` / `report.json` inside a run directory. Returns
 * null when the trace has no report — a single-column trace is legitimate (the
 * probe arm has no report to give).
 */
export function findSuiteReport(target) {
  const candidates = [];
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    for (const name of REPORT_FILENAMES) candidates.push(path.join(target, name));
  } else {
    const stem = target.replace(/\.[^.]+$/, "");
    candidates.push(`${stem}.report.json`, `${stem}.suite-report.json`, `${stem}.script-report.json`);
  }
  for (const candidate of candidates) if (fs.existsSync(candidate)) return loadSuiteReport(candidate);
  return null;
}
