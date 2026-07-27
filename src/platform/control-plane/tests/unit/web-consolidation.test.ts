// The consolidation review screen's decision rules (findings BUILD_PLAN P3
// item 6, test "UI test for reviewing and applying a plan").
//
// `src/platform/web/lib/consolidation.ts` is DOM-free on purpose, exactly like
// lib/caseform.js and lib/finding-buckets.js, so the reviewer-authority rules —
// what a click sends, what an edit means, what the reviewer is told a run will
// cost — are asserted in the offline gate rather than behind a browser. The
// repo has no hosted browser tier; this is its web-UI test pattern
// (see tests/README.md and web-ia.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applySummary,
  decisionPayload,
  initialDecisions,
  isEdited,
  itemTarget,
  originLabel,
  ranBy,
  requiresModel,
  scopeLine,
  usageLine,
} from "../../../web/lib/consolidation.js";

const PLAN = {
  id: "pl1",
  status: "proposed",
  item_count: 3,
  unresolved_count: 1,
  usage: { calls: 1, in: 900, out: 120, cache_read: 0, cost_usd: 0.0031 },
  items: [
    {
      id: "i1",
      origin: "model_cluster",
      confidence: "high",
      candidate_ids: ["c1", "c2"],
      finding_id: null,
      proposed_title: "Coupon never updates the order total",
      reason: "both describe one stale total",
      candidates: [{ id: "c1", claim: { title: "Coupon applied but total unchanged" } }, { id: "c2", claim: {} }],
    },
    {
      id: "i2",
      origin: "shortlist_suggestion",
      score: 0.71,
      candidate_ids: ["c3"],
      finding_id: "f1",
      finding: { id: "f1", title: "Search endpoint 500s", state: "new" },
      proposed_title: null,
      reason: "a single existing finding scored above the auto-suggest threshold",
      candidates: [{ id: "c3", claim: {} }],
    },
    {
      id: "i3",
      origin: "shortlist_new",
      candidate_ids: ["c4"],
      finding_id: null,
      proposed_title: "Gift-card redemption returns a server error",
      reason: "no neighbor scored above the similarity floor",
      candidates: [{ id: "c4", claim: {} }],
    },
  ],
  unresolved: [{ candidate_id: "c5", reason: "insufficient evidence" }],
};

const PREVIEW = {
  requires_model: true,
  model: "sonnet",
  shortlist_version: "shortlist-v1",
  scope: {
    unassigned_candidates: 5, suggestions: 1, proposed_new: 1,
    clusters: 1, clustered_candidates: 2, est_input_tokens: 96, prompt_bytes: 412,
  },
};

test("scope is stated before the reviewer confirms a run", () => {
  const line = scopeLine(PREVIEW);
  assert.match(line, /5 reports awaiting review/);
  assert.match(line, /1 matched by score/);
  assert.match(line, /1 clearly distinct/);
  assert.match(line, /1 group to verify — 1 model call, ~96 tokens/);
  assert.doesNotMatch(line, /prompt bytes/, "mechanical detail stays out of the headline");
  assert.equal(requiresModel(PREVIEW), true);
  // Zero-valued middle parts drop out instead of reading as dead counters.
  assert.doesNotMatch(
    scopeLine({ scope: { unassigned_candidates: 2, suggestions: 0, proposed_new: 0, clusters: 1, clustered_candidates: 2, est_input_tokens: 90 } }),
    /matched by score|clearly distinct/);
});

test("a run with no cluster says so instead of implying a spend", () => {
  const free = { requires_model: false, scope: { unassigned_candidates: 2, suggestions: 1, proposed_new: 1, clusters: 0 } };
  assert.match(scopeLine(free), /no model call needed/);
  assert.equal(requiresModel(free), false);
  assert.match(usageLine({ usage: { calls: 0 } }), /no model call/);
  assert.match(usageLine(PLAN), /1 cluster call · 900 in \/ 120 out tokens · \$0\.0031/);
});

test("a plan's initiator reads as one word in the history table", () => {
  assert.equal(ranBy({ created_by: { system: "auto_dedupe" } }), "auto-dedupe");
  assert.equal(ranBy({ created_by: { system: "findings" } }), "system");
  assert.equal(ranBy({ created_by: { user_id: "01ABC" } }), "manual");
  assert.equal(ranBy({}), "manual");
});

test("each item reads as an existing target or a proposed new group", () => {
  assert.deepEqual(itemTarget(PLAN.items[0]), { kind: "new", finding_id: null, label: "Coupon never updates the order total" });
  assert.deepEqual(itemTarget(PLAN.items[1]), { kind: "existing", finding_id: "f1", label: "Search endpoint 500s" });
  assert.match(originLabel(PLAN.items[1]), /scored match \(0\.71\) — no model call/);
  assert.match(originLabel(PLAN.items[2]), /no neighbor above the floor — no model call/);
  assert.match(originLabel(PLAN.items[0]), /model cluster · high confidence/);
});

test("the default decision is accept-as-proposed, and it round-trips to the API", () => {
  const d = initialDecisions(PLAN);
  assert.deepEqual([...d.keys()], ["i1", "i2", "i3"]);
  assert.deepEqual(decisionPayload(PLAN, d), [
    { item_id: "i1", action: "accept", proposed_title: "Coupon never updates the order total" },
    { item_id: "i2", action: "accept", finding_id: "f1" },
    { item_id: "i3", action: "accept", proposed_title: "Gift-card redemption returns a server error" },
  ]);
  assert.deepEqual(applySummary(PLAN, d), { accepted: 3, skipped: 0, edited: 0, candidates: 4 });
  for (const item of PLAN.items) assert.equal(isEdited(item, d.get(item.id)), false);
});

test("leaving an item unresolved omits it entirely — its candidates stay in the queue", () => {
  const d = initialDecisions(PLAN);
  d.get("i1").action = "skip";
  const payload = decisionPayload(PLAN, d);
  assert.deepEqual(payload.map((p: HostedDynamic) => p.item_id), ["i2", "i3"]);
  assert.deepEqual(applySummary(PLAN, d), { accepted: 2, skipped: 1, edited: 0, candidates: 2 });
});

test("editing a target or a title is sent as the reviewer's choice and marked edited", () => {
  const d = initialDecisions(PLAN);
  d.get("i1").proposed_title = "Order total ignores an applied coupon";
  d.set("i2", { action: "accept", finding_id: null, proposed_title: "Search results fail to load" });
  assert.equal(isEdited(PLAN.items[0], d.get("i1")), true);
  assert.equal(isEdited(PLAN.items[1], d.get("i2")), true, "detaching from a finding is an edit");
  assert.deepEqual(decisionPayload(PLAN, d), [
    { item_id: "i1", action: "accept", proposed_title: "Order total ignores an applied coupon" },
    { item_id: "i2", action: "accept", proposed_title: "Search results fail to load" },
    { item_id: "i3", action: "accept", proposed_title: "Gift-card redemption returns a server error" },
  ]);
  assert.equal(applySummary(PLAN, d).edited, 2);
});

test("an accepted new group with no title is caught before the request, not as a 400", () => {
  const d = initialDecisions(PLAN);
  d.get("i1").proposed_title = "   ";
  assert.throws(() => decisionPayload(PLAN, d), /needs a title/);
  // Whitespace-only is not an edit that silently becomes the proposal again.
  assert.equal(isEdited(PLAN.items[0], d.get("i1")), true);
});

test("an empty plan produces an empty payload rather than throwing", () => {
  const empty = { items: [], unresolved: [] };
  assert.deepEqual(decisionPayload(empty, initialDecisions(empty)), []);
  assert.deepEqual(applySummary(empty, initialDecisions(empty)), { accepted: 0, skipped: 0, edited: 0, candidates: 0 });
});
