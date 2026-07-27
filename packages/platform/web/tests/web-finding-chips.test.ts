// Honest pills (lib/finding-chips.ts): "open" counts only confirmed work,
// unreviewed `new` findings never ride a red pill, a fresh pass folds "look
// fixed" INTO the open pill (never a second pill for the same findings), and
// the auto-resolved receipt shows only once the work is clear. DOM-free, so
// the hermetic gate asserts the rules without a browser (sibling of
// web-ia.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { storyFindingSummary, findingChipDescriptors } from "../src/lib/finding-chips.js";

let nextId = 0;
const f = (state: WebDynamic, over = {}) => ({ id: `f${++nextId}`, state, severity: "minor", last_seen: "2026-07-20T00:00:00Z", ...over });

test("open counts only reopened/accepted; new rides a separate review count", () => {
  const s = storyFindingSummary([f("new"), f("new"), f("accepted"), f("reopened", { severity: "major" })]);
  assert.equal(s.open, 2);
  assert.equal(s.majors, 1);
  assert.equal(s.review, 2);
  const chips = findingChipDescriptors(s);
  assert.deepEqual(chips.map((c: WebDynamic) => c.kind), ["open", "review"]);
  assert.equal(chips[0].label, "2 open · 1 major");
  assert.equal(chips[0].tone, "sev-major");
  assert.equal(chips[1].label, "2 to review");
  assert.equal(chips[1].tone, "muted", "an unjudged machine claim never rings an alarm tone");
});

test("a pass newer than the evidence folds look-fixed into the open pill, never a second pill", () => {
  const s = storyFindingSummary(
    [f("accepted"), f("reopened", { last_seen: "2026-07-26T00:00:00Z" })],
    { status: "pass", started_at: "2026-07-25T00:00:00Z" },
  );
  assert.equal(s.lookFixed, 1, "only findings older than the pass look fixed");
  const chips = findingChipDescriptors(s);
  assert.deepEqual(chips.map((c: WebDynamic) => c.kind), ["open"], "look-fixed is a decoration, not its own pill");
  assert.equal(chips[0].label, "2 open · 1 looks fixed");
});

test("when every open finding looks fixed the count is not repeated", () => {
  const one = findingChipDescriptors(storyFindingSummary(
    [f("accepted")], { status: "pass", started_at: "2026-07-25T00:00:00Z" }));
  assert.equal(one[0].label, "1 open · looks fixed");
  const two = findingChipDescriptors(storyFindingSummary(
    [f("accepted"), f("reopened")], { status: "pass", started_at: "2026-07-25T00:00:00Z" }));
  assert.equal(two[0].label, "2 open · look fixed");
});

test("a failing or missing last run never claims anything looks fixed", () => {
  assert.equal(storyFindingSummary([f("accepted")], { status: "fail", started_at: "2026-07-25T00:00:00Z" }).lookFixed, 0);
  assert.equal(storyFindingSummary([f("accepted")], null).lookFixed, 0);
});

test("the auto-resolved receipt appears only once open and review counts are clear", () => {
  const auto = f("resolved", { auto_resolved_at: "2026-07-25T00:00:00Z" });
  const manual = f("resolved");
  // Beside open work: no receipt chip.
  let chips = findingChipDescriptors(storyFindingSummary([auto, f("accepted")]));
  assert.ok(!chips.some((c: WebDynamic) => c.kind === "auto-resolved"));
  // Work clear: the receipt, calm-toned; manually resolved rows never count.
  chips = findingChipDescriptors(storyFindingSummary([auto, manual]));
  assert.deepEqual(chips.map((c: WebDynamic) => c.kind), ["auto-resolved"]);
  assert.equal(chips[0].label, "1 auto-resolved");
  assert.equal(chips[0].tone, "calm");
});

test("each chip carries the ids of the findings it counts, for one-finding deep links", () => {
  const open = f("accepted");
  const review = f("new");
  const s = storyFindingSummary([open, review]);
  const chips = findingChipDescriptors(s);
  assert.deepEqual(chips.find((c: WebDynamic) => c.kind === "open").ids, [open.id]);
  assert.deepEqual(chips.find((c: WebDynamic) => c.kind === "review").ids, [review.id]);
  const auto = f("resolved", { auto_resolved_at: "2026-07-25T00:00:00Z" });
  const receipt = findingChipDescriptors(storyFindingSummary([auto]));
  assert.deepEqual(receipt[0].ids, [auto.id]);
});

test("no findings, no chips", () => {
  assert.deepEqual(findingChipDescriptors(storyFindingSummary([])), []);
});
