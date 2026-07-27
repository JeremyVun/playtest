// Deterministic candidate identity: normalization, exact lookup keys, and the
// normalized match text used later by consolidation.
//
// This is the LOCAL (core/CLI) implementation of the algorithms frozen by P0
// (`tests/core/findings/spec.ts`). It is PURE: no database, no clock, no model,
// no I/O. `tests/core/unit/findings-local-keys.test.ts` asserts byte parity with
// the frozen spec over the P0 fixture corpus, so a change here that diverges
// from the spec fails the gate.
//
// LAYERING: core must not import the control plane, and
// the control plane must not import core internals, so the hosted port
// (`src/platform/control-plane/src/findings/keys.ts`) and this one are
// deliberate duplicates of the same frozen spec. Both are pinned to
// `tests/core/findings/spec.ts` by their own parity tests; the spec is the
// single source of truth, not either copy.
//
// SCOPE: the first key part is the *scope* id — the hosted
// `project_id` there, the local ledger's opaque `workspace_id` here. Hosted and
// local therefore never share key VALUES (different scopes) while sharing the
// key ALGORITHM and its versions; a local→hosted import recomputes keys under
// the hosted project scope from the exported `signal_type`/`locus`.
//
// docs/contracts/hosted.md: model-authored text (title, expected/observed prose) and the
// model-chosen category NEVER enter a key. Only trusted, recorded context does —
// project, story, the deterministic signal type, and a locus derived from
// recorded fields. Keys are lookup keys, never durable identity; findings and
// candidates keep opaque ids.
//
// The contract also requires that a version bump can recompute stored keys, so every
// algorithm carries an explicit version that is stored on each row.
import crypto from "node:crypto";

type DynamicValue = any; // TODO(ts): local findings accept legacy candidate payloads before schema-normalized persistence

export interface FindingLocus {
  route?: string | null;
  step_locus?: string | null;
  status_class?: string | null;
  [key: string]: unknown;
}

export interface FindingClaim {
  expected?: string | null;
  observed?: string | null;
  title?: string | null;
  [key: string]: unknown;
}

export interface CandidateIdentity {
  scopeId: string;
  storyId: string | null;
  signalType: string | null;
  locus: FindingLocus | null;
}

/** Algorithm versions stored per row; a bump recomputes stored keys. */
export const VERSIONS = Object.freeze({
  locus_norm: "locus-norm-v1",
  key_algo: "key-v1",
  match_text: "match-text-v1",
});

/** The D3 category vocabulary. A comparison signal, never identity. */
export const CATEGORIES = Object.freeze([
  "http_error",
  "console_exception",
  "expectation_violation",
  "data_mismatch",
  "no_effect",
  "perf_regression",
  "broken_navigation",
]);

// Key parts are joined with US (U+001F), the separator the hosted extractor
// already uses, so no combination of part values can be re-read as another.
// Parity with tests/core/findings/spec.ts is asserted by the unit test.
const SEP = "\u001f";

/**
 * Coarse deterministic signal type (D4) from the fine-grained anomaly signal
 * vocabulary emitted by `src/core/anomalies.ts`. Unknown types pass through
 * unchanged so a new engine signal is usable without a hosted release.
 */
export function coarseSignalType(fine: unknown): string | null {
  const t = String(fine || "").trim();
  if (!t) return null;
  if (t === "http_4xx" || t === "http_5xx") return "http_error";
  if (t === "repeated_action") return "no_effect";
  return t;
}

/** Lowercase and strip volatile run-specific tokens. Frozen: match-text-v1. */
export function normalizeText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, " <uuid> ")
    .replace(/\b[0-9a-f]{12,}\b/gi, " <hex> ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ][0-9:.+\-z]+)?\b/gi, " <time> ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " <num> ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * Normalized locus from recorded fields only (D4): route template, step/selector
 * locus, and status class, after stripping run-specific ids/numbers/timestamps.
 * Frozen: locus-norm-v1. Returns "" when there is nothing recorded to normalize.
 */
export function normalizeLocus(locus: DynamicValue = {}): string {
  if (!locus || typeof locus !== "object") return "";
  // Route templates ignore the query string: it carries run-specific ids and
  // filter values, not the defect surface.
  const route = locus.route ? String(locus.route).split("?")[0] : null;
  return [route, locus.step_locus, locus.status_class]
    .filter((p) => p != null && p !== "")
    .map((p) => normalizeText(p))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** True when this identity is grounded in a deterministic anomaly signal. */
export function hasExactKeys({ signalType, locus }: { signalType?: string | null; locus?: FindingLocus | null } = {}): boolean {
  return Boolean(signalType) && Boolean(normalizeLocus(locus));
}

/**
 * The two versioned exact lookup keys for one candidate identity, or nulls when
 * the candidate carries no deterministic signal (D4: those rely on P3
 * consolidation instead).
 *
 * @param {{scopeId: string, storyId: string|null, signalType: string|null,
 *          locus: object|null}} identity
 * @returns {{strict: string|null, loose: string|null, normalized_locus: string|null}}
 */
export function exactKeys({ scopeId, storyId, signalType, locus }: CandidateIdentity): { strict: string | null; loose: string | null; normalized_locus: string | null } {
  if (!hasExactKeys({ signalType, locus })) {
    return { strict: null, loose: null, normalized_locus: null };
  }
  const normalized = normalizeLocus(locus);
  return {
    strict: sha256([scopeId, storyId ?? "", signalType, normalized].join(SEP)),
    loose: sha256([scopeId, signalType, normalized].join(SEP)),
    normalized_locus: normalized,
  };
}

/**
 * Normalized match text for the P3 consolidation shortlist (D5), computed and
 * stored now so the shortlist never has to re-derive it. Built from the
 * structured claim plus the recorded route — deterministic and pure.
 */
export function matchText({ category, locus, claim }: { category?: string | null; locus?: FindingLocus | null; claim?: FindingClaim | null } = {}): string {
  return normalizeText(
    [category, locus?.route, claim?.expected, claim?.observed, claim?.title]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Everything derived from one candidate identity + claim, ready to store. The
 * single place intake computes identity columns, so the recompute routine and
 * the write path cannot drift.
 */
export function deriveCandidateKeys({
  scopeId,
  storyId,
  signalType,
  locus,
  category,
  claim
}: CandidateIdentity & { category?: string | null; claim?: FindingClaim | null }) {
  const keys = exactKeys({ scopeId, storyId, signalType, locus });
  return {
    normalized_locus: keys.normalized_locus,
    strict_key: keys.strict,
    loose_key: keys.loose,
    key_algo_version: VERSIONS.key_algo,
    locus_norm_version: VERSIONS.locus_norm,
    match_text: matchText({ category, locus, claim }),
    match_text_version: VERSIONS.match_text,
  };
}
