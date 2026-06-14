// The one implementation of run comparability and movement (VERSION_1.1
// item 6), shared by cli.js (trend line, --json deltas) and the viewer
// (badge, history chips) — the viewer imports it over HTTP via /shared/.
// Pure browser-safe ESM: ordered history entries + the current run's numbers
// in, deltas/badge out. Data access stays with the callers (runs-root.js
// scanHistory, view-server /history.json) — that seam is where a SQLite
// index or remote API plugs in later (CI_INTEGRATION.md §12).

// Badge thresholds (product constants, one config spot): a pass that turns
// into a fail, a score drop of 5+ points, or a 30%+ duration increase vs the
// previous comparable run is a regression; a score gain of 5+ or a 30%+
// duration drop is an improvement. Regression wins when signals disagree.
export const SCORE_DELTA_BADGE = 5;
export const DURATION_RATIO_BADGE = 0.3;

// The pin fields that key comparability. `gateway` is excluded on purpose:
// it carries ephemeral localhost ports (mock, proxies) that would fragment
// every history. A field missing on either side is a wildcard, so manifests
// from before a pin existed (headed, vision) stay comparable.
const PIN_KEYS = [
  "harness_version", "prompts_version", "step_schema_version", "snapshot_format",
  "settle", "actor_model", "grader_model", "headed", "vision", "driver",
];

/** Same pin set (PIN_KEYS subset, missing = wildcard)? */
export function comparablePins(a, b) {
  if (!a || !b) return true;
  return PIN_KEYS.every(
    (k) => a[k] === undefined || b[k] === undefined || JSON.stringify(a[k]) === JSON.stringify(b[k]),
  );
}

export function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
}

/**
 * Movement of one run vs its case history. The comparability rule lives here,
 * decided once: a prior entry compares when it is a different run_id (repeat
 * siblings share one), started earlier, is non-infra and non-explored, and
 * its pin set matches (comparablePins). When nothing fully comparable exists,
 * `prev` falls back to the most recent pin-matching non-explored prior even
 * if infra — context beats nothing — while medians stay strictly comparable.
 * Explored and infra *current* runs have no movement at all.
 *
 * @param {Array<{run_id, started_at, status, healed, duration_ms, steps,
 *   score, lcp_ms?, pins?}>} history oldest-first entries for the case
 * @param {{run_id, started_at, status, healed, duration_ms, steps, score,
 *   lcp_ms?, pins?}} current this run's numbers
 * @returns {{ prev: object,
 *   duration: {prev, med}, steps: {prev, med}, lcp: {prev, med}, score: {prev, med},
 *   scoreVsLastGraded: number|null,    // --json score_delta: graded-to-graded
 *   statusMove: string|null,           // "pass → fail" | "pass → healed"
 *   statusStreak: string|null,         // "first fail after 12 passes"
 *   badge: "regression"|"improved"|null }|null} null when nothing compares
 */
export function movement(history, current) {
  if (!current || current.status === "infra" || current.status === "explored") return null;
  const before = (history ?? []).filter(
    (r) => r.run_id !== current.run_id && String(r.started_at ?? "") < String(current.started_at ?? "￿"),
  );
  const eligible = before.filter((r) => r.status !== "explored" && comparablePins(current.pins, r.pins));
  const comparable = eligible.filter((r) => r.status !== "infra");
  const prev = (comparable.length ? comparable : eligible).at(-1);
  if (!prev) return null;
  const recent = comparable.slice(-5);

  const delta = (a, b) => (a != null && b != null ? a - b : null);
  const medOf = (key) => median(recent.map((r) => r[key]).filter((v) => v != null));
  const mv = {
    prev,
    duration: { prev: delta(current.duration_ms, prev.duration_ms), med: delta(current.duration_ms, medOf("duration_ms")) },
    steps: { prev: delta(current.steps, prev.steps), med: delta(current.steps, medOf("steps")) },
    lcp: { prev: delta(current.lcp_ms, prev.lcp_ms), med: delta(current.lcp_ms, medOf("lcp_ms")) },
    score: { prev: delta(current.score, prev.score), med: delta(current.score, medOf("score")) },
  };

  // Scores compare only graded-to-graded: checking runs have no grade, so the
  // --json delta baselines against the most recent *graded* eligible prior.
  const lastGraded = eligible.findLast((r) => r.score != null);
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
    while (n < comparable.length && comparable.at(-1 - n).status === last.status) n++;
    mv.statusStreak = `first ${current.status} after ${n} ${last.status}${n === 1 ? "" : last.status === "pass" ? "es" : "s"}`;
  }

  const durRatio = mv.duration.prev != null && prev.duration_ms > 0 ? mv.duration.prev / prev.duration_ms : null;
  mv.badge =
    mv.statusMove === "pass → fail" ||
    (mv.score.prev != null && mv.score.prev <= -SCORE_DELTA_BADGE) ||
    (durRatio != null && durRatio >= DURATION_RATIO_BADGE)
      ? "regression"
      : (mv.score.prev != null && mv.score.prev >= SCORE_DELTA_BADGE) ||
          (durRatio != null && durRatio <= -DURATION_RATIO_BADGE)
        ? "improved"
        : null;
  return mv;
}
