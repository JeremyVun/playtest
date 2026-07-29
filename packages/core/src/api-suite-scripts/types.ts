// The script-suite domain vocabulary (docs/contracts/scripts.md). These are the
// shapes the subsystem exchanges internally after the trust boundary: external
// JSON (a script's records, a HAR on disk, a job document) is parsed as
// untrusted input and validated once — by the check channel, the obligation
// normalizer, or Ajv — and everything downstream passes these.
export type DynamicValue = any; // SAFETY: script suites cross runtime-validated OpenAPI, HAR, user-module, and persisted report shapes

// ---- the check channel (docs/contracts/scripts.md#the-check-channel) --------

/** Evidence a record cites: HAR entry indexes plus an optional free subject. */
export interface CheckEvidence {
  requests: number[];
  subject?: unknown;
}

interface CheckRecordBase {
  /** Assigned by the channel, 1-based, in record order. */
  seq: number;
}

/** A verdict about the API — pass or fail. */
export interface CheckVerdictRecord extends CheckRecordBase {
  kind: "check";
  id: string;
  obligation: string;
  title: string;
  pass: boolean;
  exercised: boolean;
  expected?: string;
  observed?: string;
  note?: string;
  evidence: CheckEvidence;
}

/** An obligation deliberately not covered, with a reason. */
export interface CheckSkipRecord extends CheckRecordBase {
  kind: "skip";
  obligation: string;
  reason: string;
  id?: string;
}

/** An obligation this substrate cannot express. */
export interface CheckUnsupportedRecord extends CheckRecordBase {
  kind: "unsupported";
  obligation: string;
  reason: string;
}

/** The SCRIPT could not do its job. Never a statement about the API. */
export interface CheckDefectRecord extends CheckRecordBase {
  kind: "defect";
  message: string;
  detail?: string;
  obligation?: string;
  evidence: CheckEvidence;
}

/** An observation that gates nothing. */
export interface CheckAdvisoryRecord extends CheckRecordBase {
  kind: "advisory";
  title: string;
  detail?: string;
  evidence: CheckEvidence;
}

export type CheckRecord =
  | CheckVerdictRecord
  | CheckSkipRecord
  | CheckUnsupportedRecord
  | CheckDefectRecord
  | CheckAdvisoryRecord;

// ---- coverage obligations (docs/contracts/scripts.md#coverage-obligation-manifest)

export type ObligationSource = "policy" | "operation" | "rule";
/** Terminal accounting statuses. Only the first three are sound. */
export type ObligationStatus = "covered" | "skipped" | "unsupported" | "unaccounted";

/** One manifest entry, derived mechanically from the handout inputs. */
export interface ObligationEntry {
  id: string;
  source: ObligationSource;
  statement: string;
  applicability?: string;
  approved_skip_reasons?: string[];
  unsupported?: boolean;
}

/** A manifest entry after accounting against the report and the traffic. */
export interface AccountedObligation extends ObligationEntry {
  status: ObligationStatus;
  /** Ids of the checks that traced to this obligation. */
  checks: string[];
  reason?: string;
}

export interface ObligationSummary {
  total: number;
  covered: number;
  skipped: number;
  unsupported: number;
  unaccounted: number;
}

export interface ObligationAccounting {
  entries: AccountedObligation[];
  summary: ObligationSummary;
  sound: boolean;
  reasons: string[];
  /** Report records citing an obligation id the manifest does not contain. */
  unknown: Array<{ obligation: string; from: string }>;
}

// ---- recorded traffic (docs/contracts/scripts.md#har-lifecycle) -------------

/**
 * One HAR 1.2 entry as the parent's recorder writes it. Typed to the fields the
 * subsystem reads back; a HAR handed in from outside may carry more.
 */
export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: unknown[];
    cookies: unknown[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string | null };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    cookies: unknown[];
    content: { size: number; mimeType: string; text?: string | null };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _failed?: boolean;
}

/** One request as the invariant policies consume it (gate.ts traceFromHar). */
export interface TraceRequest {
  // Structurally compatible with invariants.ts InvariantTraceRequest, whose
  // policies read extra keys through its open index signature.
  [key: string]: unknown;
  index: number;
  method: string;
  path: string;
  url: string;
  status: number;
  mime: string;
  body: string | null;
  requestBody: string | null;
  requestHeaders: Record<string, string>;
  step: number | null;
}

// ---- the HAR column (docs/contracts/scripts.md#verdict) ---------------------

/** One declared policy, parsed and tied to its obligation id. */
export interface ParsedScriptPolicy {
  declaration: DynamicValue;
  parsed: DynamicValue;
  spec: string;
  obligation: string;
}

export interface ScriptGateCheck {
  policy: string;
  tier: number;
  spec: string;
  obligation: string;
  applicable: boolean;
  pass: boolean;
  detail: string;
  /** Evidence keyed into the HAR, the same handle a script's own checks use. */
  har_entries: number[];
}

export interface ScriptGateResult {
  pass: boolean;
  checks: ScriptGateCheck[];
}

// ---- candidate findings (docs/contracts/scripts.md#findings) ----------------

export interface ScriptFindingExchange {
  har_entry: number;
  method: string | null;
  url: string;
  status: number | null;
  time_ms?: number;
}

export interface ScriptFinding {
  finding_version: number;
  source: "check" | "policy";
  id: string;
  obligation: string | null;
  statement: string | null;
  title: string;
  expected: string | null;
  observed: string | null;
  note: string | null;
  evidence: {
    har_entries: number[];
    exchanges: ScriptFindingExchange[];
    subject: unknown;
  };
  /** Mechanical, not a judgement: did the citation resolve into recorded traffic? */
  evidence_verified: boolean;
}

// ---- the script report (docs/contracts/scripts.md#report-schema) ------------

/** One per-check verdict as persisted in script-report.json. */
export interface ReportCheck {
  id: string;
  obligation: string;
  title: string;
  pass: boolean;
  exercised: boolean;
  expected?: string;
  observed?: string;
  note?: string;
  evidence: { har_entries: number[]; subject?: unknown };
}

export interface ReportDefect {
  kind: string;
  message: string;
  [key: string]: unknown;
}

/**
 * The persisted two-column report. The tail fields (obligations, gate,
 * soundness, verdict) are null until finalizeReport attaches them.
 */
export interface ScriptReport {
  script_report_version: number;
  contract_version: number;
  script: { path: string; sha256: string; bytes: number };
  run: DynamicValue;
  test_data: DynamicValue;
  cleanup: DynamicValue;
  checks: ReportCheck[];
  advisories: Array<{ title: string; detail: string | null; evidence: CheckEvidence }>;
  defects: ReportDefect[];
  hygiene: { leak_findings: DynamicValue[] };
  guard: Array<{ code: string; request: string; at: string }>;
  obligations: { manifest_version: number; summary: ObligationSummary; entries: AccountedObligation[] } | null;
  gate: ScriptGateResult | null;
  soundness: { ok: boolean; reasons: string[] } | null;
  verdict: {
    pass: boolean;
    report_pass: boolean;
    gate_pass: boolean;
    sound: boolean;
    failing_checks: string[];
    exit_code: number;
  } | null;
}

/** A report after finalizeReport has attached the tail fields. */
export interface FinalizedScriptReport extends ScriptReport {
  obligations: NonNullable<ScriptReport["obligations"]>;
  gate: ScriptGateResult;
  soundness: NonNullable<ScriptReport["soundness"]>;
  verdict: NonNullable<ScriptReport["verdict"]>;
}
