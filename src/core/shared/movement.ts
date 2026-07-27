// The one implementation of run comparability and movement,
// shared by cli.ts (trend line, --json deltas) and the viewer
// (badge, history chips) — the viewer imports it over HTTP via /shared/.
// Pure browser-safe ESM: ordered history entries + the current run's numbers
// in, deltas/badge out. Data access stays with the callers (runs-root.ts
// scanHistory, view-server /history.json) — that seam is where a SQLite
// index or remote API plugs in later (docs/backlog/pr-journey-diff-bot.md §12).

// Badge thresholds (product constants, one config spot): a pass that turns
// into a fail, a pass that only held after a heal, or a score drop of 5+
// points vs the previous comparable run is a regression; a score gain of 5+
// is an improvement. Regression wins when signals disagree. Duration is
// DELIBERATELY NOT a badge signal — it swings with actor/grader model latency
// run-to-run, so a slow run is not a regression. Duration deltas still surface
// on the CLI trend line and viewer chips (mv.duration), just never as a badge.
export const SCORE_DELTA_BADGE = 5;

// The pin fields that key comparability. `gateway` is excluded on purpose:
// it carries ephemeral localhost ports (mock, proxies) that would fragment
// every history. A field missing on either side is a wildcard, so manifests
// from before a pin existed (headed, vision) stay comparable.
const PIN_KEYS = [
  "harness_version", "prompts_version", "step_schema_version", "snapshot_format",
  "settle", "actor_model", "grader_model", "headed", "vision", "driver", "viewport",
];

export interface MovementEntry {
  run_id?: string | null;
  started_at?: string | null;
  status?: string | null;
  healed?: boolean;
  duration_ms?: number | null;
  steps?: number | null;
  score?: number | null;
  lcp_ms?: number | null;
  pins?: Record<string, unknown>;
}

export interface MovementDelta {
  prev: number | null;
  med: number | null;
}

export interface Movement {
  prev: MovementEntry;
  duration: MovementDelta;
  steps: MovementDelta;
  lcp: MovementDelta;
  score: MovementDelta;
  scoreVsLastGraded?: number | null;
  statusMove?: string | null;
  statusStreak?: string | null;
  badge?: "regression" | "improved" | null;
}

/** Same pin set (PIN_KEYS subset, missing = wildcard)? */
export function comparablePins(a?: Record<string, unknown> | null, b?: Record<string, unknown> | null) {
  if (!a || !b) return true;
  return PIN_KEYS.every(
    (k) => a[k] === undefined || b[k] === undefined || JSON.stringify(a[k]) === JSON.stringify(b[k]),
  );
}

export function median(vals: number[]) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[(s.length >> 1) - 1]! + s[s.length >> 1]!) / 2; // TODO(ts): Non-empty sorted input guarantees these midpoint indexes.
}

/**
 * Movement of one run vs its case history. The comparability rule lives here,
 * decided once: a prior entry compares when it is a different run_id (repeat
 * siblings share one), started earlier, is non-infra and non-explored, and
 * its pin set matches (comparablePins). When nothing fully comparable exists,
 * `prev` falls back to the most recent pin-matching non-explored prior even
 * if infra — context beats nothing — while medians stay strictly comparable.
 * Explored, infra, and interrupted *current* runs have no movement at all.
 *
 * `scoreVsLastGraded` is the --json score_delta (graded-to-graded);
 * `statusMove` is "pass → fail" or "pass → healed"; `statusStreak` is a
 * phrase such as "first fail after 12 passes". A regression badge means
 * pass→fail, pass→healed, or score drop ≥5 (NOT duration).
 */
export function movement(
  history: MovementEntry[] | null | undefined,
  current: MovementEntry | null | undefined
): Movement | null {
  if (!current || current.status === "infra" || current.status === "explored" || current.status === "interrupted") return null;
  const before = (history ?? []).filter(
    (r) => r.run_id !== current.run_id && String(r.started_at ?? "") < String(current.started_at ?? "￿"),
  );
  const eligible = before.filter((r) => r.status !== "explored" && r.status !== "interrupted" && comparablePins(current.pins, r.pins));
  const comparable = eligible.filter((r) => r.status !== "infra");
  const prev = comparable.length ? comparable.at(-1) : eligible.at(-1);
  if (!prev) return null;
  const recent = comparable.slice(-5);

  const delta = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? a - b : null);
  const medOf = (key: "duration_ms" | "steps" | "lcp_ms" | "score") => median(recent.map((r) => r[key]).filter((v): v is number => v != null));
  const mv: Movement = {
    prev,
    duration: { prev: delta(current.duration_ms, prev.duration_ms), med: delta(current.duration_ms, medOf("duration_ms")) },
    steps: { prev: delta(current.steps, prev.steps), med: delta(current.steps, medOf("steps")) },
    lcp: { prev: delta(current.lcp_ms, prev.lcp_ms), med: delta(current.lcp_ms, medOf("lcp_ms")) },
    score: { prev: delta(current.score, prev.score), med: delta(current.score, medOf("score")) },
  };

  // Scores compare only graded-to-graded: checking runs have no grade, so the
  // --json delta baselines against the most recent *graded* eligible prior.
  const lastGraded = eligible.findLast((r): r is MovementEntry & { score: number } => r.score != null);
  mv.scoreVsLastGraded = current.score != null && lastGraded ? current.score - lastGraded.score : null;

  mv.statusMove =
    prev.status === "pass" && current.status === "fail" ? "pass → fail"
    : prev.status === "pass" && !prev.healed && current.healed && current.status === "pass" ? "pass → healed"
    : null;

  // The streak prints only on a status change and counts over comparable runs.
  mv.statusStreak = null;
  const last = comparable.at(-1);
  if (last && last.status !== current.status) {
    let n = 0;
    while (n < comparable.length && comparable.at(-1 - n)!.status === last.status) n++; // TODO(ts): Loop bound guarantees the indexed comparable entry exists.
    mv.statusStreak = `first ${current.status} after ${n} ${last.status}${n === 1 ? "" : last.status === "pass" ? "es" : "s"}`;
  }

  // A heal is a real regression even when the run still passes: the baseline
  // no longer reproduces and a human must review the heal diff. Duration is
  // intentionally absent here (see the threshold preamble).
  mv.badge =
    mv.statusMove === "pass → fail" ||
    mv.statusMove === "pass → healed" ||
    (mv.score.prev != null && mv.score.prev <= -SCORE_DELTA_BADGE)
      ? "regression"
      : mv.score.prev != null && mv.score.prev >= SCORE_DELTA_BADGE
      ? "improved"
      : null;
  return mv;
}
