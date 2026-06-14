// Unit tests for the shared comparability/movement module (VERSION_1.1
// item 6) — the one place the "which runs compare" rules live. Pure data in,
// data out: no fixtures, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";

import { movement, comparablePins, median, SCORE_DELTA_BADGE, DURATION_RATIO_BADGE } from "../src/shared/movement.js";

const PINS = {
  harness_version: "0.1.0",
  prompts_version: "prompts-v1",
  step_schema_version: 3,
  snapshot_format: "a11y-text-v1",
  settle: { name: "settle-v1", dom_quiet_ms: 500, net_quiet_ms: 500, max_ms: 10000 },
  actor_model: "claude-haiku-4-5",
  grader_model: "claude-sonnet-4-6",
  gateway: "http://localhost:4175",
  headed: false,
};

let seq = 0;
const entry = (over = {}) => ({
  run_id: `r${++seq}`,
  started_at: `2026-06-0${Math.min(9, seq)}T00:00:00Z`,
  status: "pass",
  healed: false,
  duration_ms: 1000,
  steps: 5,
  score: null,
  lcp_ms: null,
  pins: PINS,
  ...over,
});

const current = (over = {}) =>
  entry({ run_id: "current", started_at: "2026-06-10T00:00:00Z", ...over });

test("pin rule: a prior with a different pin set is excluded from comparison", () => {
  const aliened = entry({ duration_ms: 100, pins: { ...PINS, actor_model: "claude-sonnet-4-6" } });
  const kin = entry({ duration_ms: 2000 });
  const mv = movement([aliened, kin], current({ duration_ms: 2500 }));
  assert.equal(mv.prev.run_id, kin.run_id, "prev must be the pin-matching run");
  assert.equal(mv.duration.prev, 500, "delta vs the pin-matching run, not the alien one");

  const onlyAlien = movement([aliened], current());
  assert.equal(onlyAlien, null, "nothing compares when every prior has different pins");
});

test("pin rule: gateway differences never sever comparability", () => {
  const otherPort = entry({ duration_ms: 2000, pins: { ...PINS, gateway: "http://localhost:9999" } });
  const mv = movement([otherPort], current({ duration_ms: 2500 }));
  assert.equal(mv.duration.prev, 500);
});

test("pin rule: a missing pin field (or whole pin set) is a wildcard, so legacy runs stay comparable", () => {
  const legacyNoPins = entry({ duration_ms: 2000, pins: null });
  assert.equal(movement([legacyNoPins], current()).prev.run_id, legacyNoPins.run_id);

  const legacyNoHeaded = { ...PINS };
  delete legacyNoHeaded.headed;
  const old = entry({ duration_ms: 2000, pins: legacyNoHeaded });
  assert.equal(movement([old], current({ pins: { ...PINS, headed: true } })).prev.run_id, old.run_id);

  assert.equal(comparablePins(PINS, { ...PINS, headed: true }), false, "present-and-different is a mismatch");
  assert.equal(comparablePins(PINS, legacyNoHeaded), true, "absent is a wildcard");
});

test("comparable = earlier, different run_id, non-infra, non-explored", () => {
  const sibling = entry({ run_id: "current", duration_ms: 1 }); // repeat-run sibling shares run_id
  const later = entry({ started_at: "2026-06-11T00:00:00Z", duration_ms: 2 });
  const explored = entry({ status: "explored", duration_ms: 3 });
  const infra = entry({ status: "infra", duration_ms: 4 });
  const good = entry({ duration_ms: 2000 });
  const mv = movement([sibling, explored, infra, good, later], current({ duration_ms: 2500 }));
  assert.equal(mv.prev.run_id, good.run_id);
  assert.equal(mv.duration.prev, 500);
});

test("prev falls back to an infra prior when nothing else compares; explored never serves", () => {
  const infra = entry({ status: "infra", duration_ms: 2000 });
  const explored = entry({ status: "explored", duration_ms: 1 });
  const mv = movement([explored, infra], current({ duration_ms: 2500 }));
  assert.equal(mv.prev.run_id, infra.run_id, "infra beats nothing");
  assert.equal(movement([explored], current()), null, "explored priors never compare");
});

test("no movement for an infra or explored current run, or with no history", () => {
  assert.equal(movement([entry()], current({ status: "infra" })), null);
  assert.equal(movement([entry()], current({ status: "explored" })), null);
  assert.equal(movement([], current()), null);
});

test("medians come from the last 5 comparable runs", () => {
  const hist = [3000, 1000, 1200, 1400, 1600, 1800].map((d) => entry({ duration_ms: d }));
  const mv = movement(hist, current({ duration_ms: 2000 }));
  // last 5: 1000..1800, median 1400; the 3000 outlier fell outside the window
  assert.equal(mv.duration.med, 600);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("score deltas: prev graded-to-graded, --json delta vs last graded prior", () => {
  const graded = entry({ score: 80 });
  const ungraded = entry({ score: null, duration_ms: 900 });
  const mv = movement([graded, ungraded], current({ score: 90 }));
  assert.equal(mv.prev.run_id, ungraded.run_id, "prev is the most recent comparable run");
  assert.equal(mv.score.prev, null, "no score delta against an ungraded prev");
  assert.equal(mv.scoreVsLastGraded, 10, "the --json delta reaches back to the last graded run");
});

test("status movement and streak text", () => {
  const passes = [entry(), entry(), entry()];
  const mv = movement(passes, current({ status: "fail" }));
  assert.equal(mv.statusMove, "pass → fail");
  assert.equal(mv.statusStreak, "first fail after 3 passes");
  assert.equal(mv.badge, "regression");

  const healed = movement([entry()], current({ healed: true }));
  assert.equal(healed.statusMove, "pass → healed");
  assert.equal(healed.badge, null, "pass → healed is not a regression by itself");
});

test("badge thresholds: score ±5, duration ±30% vs prev; regression wins", () => {
  const base = entry({ duration_ms: 1000, score: 80 });
  assert.equal(movement([base], current({ score: 80 - SCORE_DELTA_BADGE })).badge, "regression");
  assert.equal(movement([base], current({ score: 80 + SCORE_DELTA_BADGE })).badge, "improved");
  assert.equal(movement([base], current({ duration_ms: 1000 * (1 + DURATION_RATIO_BADGE) })).badge, "regression");
  assert.equal(movement([base], current({ duration_ms: 1000 * (1 - DURATION_RATIO_BADGE) })).badge, "improved");
  assert.equal(movement([base], current({ duration_ms: 1100, score: 81 })).badge, null);
  assert.equal(
    movement([base], current({ score: 90, duration_ms: 1400 })).badge,
    "regression",
    "regression wins when signals disagree",
  );
});
