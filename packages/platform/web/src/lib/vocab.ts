// Plain-English display words for the machine tokens the engine emits. The raw
// token stays the identity everywhere it matters (API payloads, `title`
// attributes, provenance lines); this module owns what a person READS.
//
// Two rules:
//   1. Unknown tokens degrade to a readable phrase, never to a blank — a new
//      engine signal must be usable in the console without a web release
//      (same promise coarseSignalType makes server-side).
//   2. Nothing here invents judgment. These are translations, not verdicts.
//
// Kept DOM-free so the hermetic gate can assert the vocabulary without a
// browser (sibling of nav.ts / redirects.ts / finding-buckets.ts).

/** `some_token` → "some token". The floor every map falls back to. */
export function humanize(token: WebDynamic) {
  const t = String(token ?? "").trim();
  if (!t) return "";
  return t.replace(/[_-]+/g, " ");
}

// The D3 candidate category vocabulary (core packages/core/src/findings/keys.js
// CATEGORIES — the frozen seven). Short enough for a table cell.
const CATEGORY: WebDynamic = {
  http_error: "Server error",
  console_exception: "JavaScript error",
  expectation_violation: "Didn't behave as promised",
  data_mismatch: "Wrong data shown",
  no_effect: "Nothing happened",
  perf_regression: "Too slow",
  broken_navigation: "Navigation broke",
};

/** A bug candidate's category, in words. */
export const categoryLabel = (c: WebDynamic) => CATEGORY[c] || humanize(c) || "Uncategorized";

// Deterministic evidence signals. Covers both the fine anomaly vocabulary from
// core packages/core/src/anomalies.ts (http_4xx/http_5xx/console_exception/failed_action/
// no_effect/repeated_action/perf_budget) and the coarse types keys.js collapses
// them into, because a candidate can carry either.
const SIGNAL: WebDynamic = {
  http_error: "an HTTP error response",
  http_4xx: "a 4xx response",
  http_5xx: "a 5xx response",
  console_exception: "a JavaScript exception",
  failed_action: "an action that failed",
  no_effect: "an action with no visible effect",
  repeated_action: "the same action repeated",
  perf_budget: "a performance budget breach",
  perf_regression: "a slowdown against the budget",
  broken_navigation: "a navigation that went nowhere",
};

/** The recorded signal behind a candidate, as a noun phrase ("a 4xx response"). */
export const signalLabel = (s: WebDynamic) => SIGNAL[s] || humanize(s) || "an unrecognized signal";

// Success-criterion kinds (lib/caseform.js SUCCESS_KINDS, mirroring core
// config.ts). Each reads as the start of a sentence the value completes, so the
// story form says "An element is present  [data-testid=…]" rather than
// "element_exists  [data-testid=…]".
const CRITERION: WebDynamic = {
  assert: "Outcome, in words",
  element_exists: "Element is present",
  url_matches: "URL matches",
  api_called: "API was called",
  console_errors: "Console errors at most",
  accessibility_violations: "Accessibility issues ≤",
  screen_shows: "Screen shows",
  response_status: "Response status",
  response_matches: "Response body matches",
  invariant: "API invariant holds",
};

/** A success criterion's kind, as the opening of a sentence. */
export const criterionLabel = (k: WebDynamic) => CRITERION[k] || humanize(k);

// What the next run of a story will DO (core `list`: record/check/explore).
// The words are the CLI's; the gloss is what the console adds.
const NEXT_RUN: WebDynamic = {
  record: "record",
  check: "check",
  explore: "explore",
};
const NEXT_RUN_GLOSS: WebDynamic = {
  record: "no saved path yet — the next run captures one",
  check: "replays the saved path and checks the story still works",
  explore: "an open-ended discovery study, with no saved path to check",
};

export const nextRunLabel = (n: WebDynamic) => NEXT_RUN[n] || humanize(n) || "—";
export const nextRunGloss = (n: WebDynamic) => NEXT_RUN_GLOSS[n] || null;

/**
 * What each outcome word means, one sentence each. These words are the
 * most-read text in the console and every one is a term of art; the definition
 * rides on the word itself (a chip's tooltip and its accessible text) instead
 * of a standing legend under the table, so it appears exactly where the word
 * does and only when asked for. Keyed by tone AND by the display word, so both
 * a chip's status class and an outcome count's word ("passed") resolve.
 */
const GLOSS: WebDynamic = {
  pass: "the story did what it said",
  fail: "a check the story declared did not hold",
  changed: "the app changed; the story still worked — a person decides whether to keep the new path",
  explored: "an open-ended discovery run; there is no pass/fail to give",
  infra: "the run never produced a verdict — a setup, network or runner problem",
  canceled: "the run was canceled before this story produced a verdict",
};
GLOSS.passed = GLOSS.pass;
GLOSS.failed = GLOSS.fail;
GLOSS.lost = GLOSS.infra;
GLOSS["didn't run"] = GLOSS.infra;

export const outcomeGloss = (wordOrTone: WebDynamic) => GLOSS[wordOrTone] || null;

/**
 * An infra-class run in plain words. `infra`, `canceled` and `lost` are three
 * ways of never getting a verdict, and none of them is a product failure — the
 * amber "didn't run" family, not the red one.
 */
export function didNotRunLabel(status: WebDynamic, { started = false, short = false }: WebDynamic = {}) {
  if (short) return "didn't run";
  if (status === "canceled") return "didn't run — canceled";
  if (status === "lost") return "didn't run — the runner never reported back";
  return started ? "didn't run — stopped partway" : "didn't run — never started";
}
