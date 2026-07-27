// The cards surface's copy and pure logic (packages/platform/web/src/lib/rule-cards.ts).
//
// Half of this file is a copy test, deliberately. S0 recorded Level 1's
// disposition as **assisted authoring** (DESIGN §7.1): the arm's precision was
// clean but a suite built from self-proposed rules found 8 of 13 sealed faults
// against 11–12 for suites given the rules. So the product may not claim it
// discovered a person's rules, and may not imply the set is complete. Those are
// the two sentences most likely to drift back toward a better-sounding headline
// in a later edit, so they are pinned here rather than left to review.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COPY,
  bucketCards,
  cardPayload,
  formFromCard,
  level0Label,
  provenanceLine,
  specDeclaration,
  summaryLine,
  validateRuleForm,
} from "../src/lib/rule-cards.js";

const allCopy = JSON.stringify(COPY).toLowerCase();

test("COPY: the surface says review-and-confirm, never that Playtest found your rules", () => {
  assert.equal(COPY.intro.heading, "Review and confirm your API's rules.");
  // The honest limit, stated where the person is deciding.
  assert.match(COPY.intro.body, /it cannot know your business/);
  assert.match(COPY.intro.body, /a suggestion for you to judge, not something we found out about your system/);
  // The precision lesson, in the user's language.
  assert.match(COPY.intro.stakes, /Only rules you approve are ever tested/);
  assert.match(COPY.intro.stakes, /fails every future build/);
  assert.match(COPY.intro.stakes, /deny anything you are not sure about/);

  // No zero-knowledge claim anywhere on the surface.
  for (const forbidden of [
    "we found your rules",
    "we discovered",
    "playtest discovers",
    "your complete",
    "every rule",
    "all your rules",
    "no input",
    "zero input",
    "without knowing",
    "answer nothing",
  ]) {
    assert.ok(!allCopy.includes(forbidden), `the cards copy claims too much: "${forbidden}"`);
  }
});

test("COPY: Level 0 is described as a floor with a named limit, not as coverage", () => {
  assert.match(COPY.level0.heading, /Always on, whatever you decide here/);
  assert.match(COPY.level0.body, /even if you approve nothing on this page/);
  assert.match(COPY.level0.limit, /cannot catch a rule your document does not state/);
  assert.deepEqual(Object.keys(COPY.level0.labels), ["no_server_error", "documented_status", "response_schema", "content_type"]);
  assert.equal(level0Label("no_server_error"), "No request answers a server error");
  assert.equal(level0Label("something_new"), "something_new");
});

test("COPY: a denial is described as remembered, and a written rule as approved by definition", () => {
  assert.match(COPY.sections.denied.blurb, /Playtest will not suggest these again/);
  assert.match(COPY.sections.candidate.blurb, /Nothing here is tested until you approve it/);
  assert.match(COPY.form.yoursIsApproved, /approved by definition/);
  assert.match(COPY.form.editingIsNotApproving, /Editing does not approve it/);
  assert.match(COPY.propose.body, /It approves nothing/);
  assert.match(COPY.form.exceptionsHint, /An exception narrows a rule; it cannot cancel it/);
  // A deployment with no gateway still has a working product to describe.
  assert.match(COPY.propose.unavailable, /You can still write your own rules/);
});

test("cards bucket by state and summarize what is enforced first", () => {
  const cards = [
    { id: "1", state: "candidate" },
    { id: "2", state: "approved" },
    { id: "3", state: "denied" },
    { id: "4", state: "approved" },
  ];
  const buckets = bucketCards(cards);
  assert.deepEqual(buckets.candidate.map((c: WebDynamic) => c.id), ["1"]);
  assert.deepEqual(buckets.approved.map((c: WebDynamic) => c.id), ["2", "4"]);
  assert.deepEqual(buckets.denied.map((c: WebDynamic) => c.id), ["3"]);
  assert.deepEqual(bucketCards(), { candidate: [], approved: [], denied: [] });

  assert.equal(
    summaryLine({ level_0: [1, 2, 3, 4], counts: { candidate: 3, approved: 2, denied: 1 } }),
    "4 default checks always on · 2 approved rules · 3 to review · 1 denied",
  );
  // A suite nobody has touched still says what it is judged against.
  assert.equal(summaryLine({ level_0: [1, 2, 3, 4], counts: { candidate: 0, approved: 0, denied: 0 } }), "4 default checks always on · 0 approved rules");
});

test("provenance shows only for a card a model proposed", () => {
  assert.equal(
    provenanceLine({ origin: "proposed", provenance: "POST /transfers · status enum" }),
    "proposed from: POST /transfers · status enum",
  );
  assert.equal(provenanceLine({ origin: "authored", provenance: "POST /transfers" }), null);
  assert.equal(provenanceLine({ origin: "proposed" }), null);
});

test("add-your-own produces a statement in the same shape as a proposal", () => {
  const form = { statement: "  A widget's slug never changes.  ", title: "Slugs are permanent", applicability: "", exceptions: "", note: " ours " };
  assert.deepEqual(cardPayload(form), {
    statement: "A widget's slug never changes.",
    title: "Slugs are permanent",
    applicability: "",
    exceptions: "",
    note: "ours",
  });
  // …and round-trips through the edit form unchanged.
  const card = { statement: "A widget's slug never changes.", title: "Slugs are permanent", applicability: null, exceptions: null, note: "ours" };
  assert.deepEqual(cardPayload(formFromCard(card)), cardPayload(form));

  assert.deepEqual(validateRuleForm({ statement: "A rule." }), []);
  assert.deepEqual(validateRuleForm({ statement: "   " }), ["A rule needs a sentence."]);
  assert.equal(validateRuleForm({ statement: "x".repeat(1001) }).length, 1);
});

test("a pasted spec travels as a document when it is JSON and as text otherwise", () => {
  assert.deepEqual(specDeclaration('{"openapi":"3.0.3"}'), { document: { openapi: "3.0.3" } });
  assert.deepEqual(specDeclaration("openapi: 3.0.3\n"), { text: "openapi: 3.0.3" });
  assert.equal(specDeclaration("   "), null);
  assert.equal(specDeclaration(null), null);
});
