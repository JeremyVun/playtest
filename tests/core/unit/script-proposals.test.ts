// Rule cards: the Level 1 proposal shape, and the governance boundary under it
// (docs/contracts/scripts.md#invariant-levels, DESIGN N6).
//
// The load-bearing test in this file is not the prompt or the parser — it is
// `approved-only governance`: a candidate or denied sentence must have no path
// to a handout, an obligation id, or a gate. That is asserted structurally,
// over the real handout builder and the real obligation manifest, rather than
// by reading the prompt and hoping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  CARD_STATES,
  LEVEL_0_POLICIES,
  MAX_PROPOSED_CARDS,
  RULE_PROPOSAL_PROMPT_VERSION,
  approvedCardRules,
  buildHandout,
  buildProposalPrompt,
  defaultScriptPolicies,
  deriveObligations,
  normalizeCard,
  observableOperations,
  parseProposalReply,
  renderInvariants,
} from "../../../src/core/public/api-suite-scripts.ts";
import { loadOpenApi } from "../../../src/core/openapi.ts";
import { DummyConfigError } from "../../../src/core/config.ts";

const SPEC = loadOpenApi(fileURLToPath(new URL("../../fixtures/authoring-api/openapi.json", import.meta.url)));

/** One card of every state, so every filter has something to exclude. */
const CARDS = [
  {
    id: "publish-is-once",
    title: "A widget publishes once",
    statement: "Publishing a widget that is already published is refused; it never republishes.",
    applicability: "POST /widgets/{id}/publish, including a second call with the same body.",
    exceptions: "None.",
    provenance: "POST /widgets/{id}/publish · 409 response",
    note: "Our support team leans on this — a double publish re-notifies customers.",
    state: "approved",
    origin: "proposed",
  },
  { id: "names-are-unique", statement: "Two widgets never share a name.", state: "candidate", origin: "proposed" },
  { id: "archive-is-hard-delete", statement: "Archiving a widget deletes its history.", state: "denied", origin: "proposed" },
  { id: "hand-written", statement: "A widget's slug never changes after creation.", state: "approved", origin: "authored" },
];

test("a card is validated as user input, and a model cannot mint an approved one", () => {
  assert.throws(() => normalizeCard({ id: "x" }), DummyConfigError);
  assert.throws(() => normalizeCard({ statement: "ok", id: "bad id" }), DummyConfigError);
  assert.throws(() => normalizeCard({ statement: "ok", state: "blessed" }), DummyConfigError);
  assert.deepEqual(CARD_STATES, ["candidate", "approved", "denied"]);

  // The parser pins state and origin regardless of what the reply claimed.
  const reply = ['```json', JSON.stringify({ cards: [{ id: "sneaky", statement: "Anything goes.", state: "approved", origin: "authored" }] }), "```"].join("\n");
  const { cards } = parseProposalReply(reply);
  assert.equal(cards[0].state, "candidate");
  assert.equal(cards[0].origin, "proposed");
});

test("the proposal prompt is pinned, names the Level 0 set as off-limits, and carries the denied list", () => {
  const prompt = buildProposalPrompt({
    spec: SPEC,
    denied: [{ id: "archive-is-hard-delete", statement: "Archiving a widget deletes its history." }],
    approved: [{ id: "publish-is-once", statement: "Publishing a widget that is already published is refused." }],
  });
  assert.equal(prompt.version, RULE_PROPOSAL_PROMPT_VERSION);
  assert.match(prompt.system, /ONE rule per card/);
  assert.match(prompt.system, /An exception NARROWS a rule; it never cancels it/);
  assert.match(prompt.system, /5 and 8 cards/);
  for (const policy of LEVEL_0_POLICIES) assert.match(prompt.user, new RegExp(`\`${policy}\``));
  assert.match(prompt.user, /do not propose these/);
  assert.match(prompt.user, /already DENIED[\s\S]*Archiving a widget deletes its history/);
  assert.match(prompt.user, /POST \/widgets\/\{id\}\/publish/);

  // Deterministic: the same inputs write the same bytes.
  assert.equal(buildProposalPrompt({ spec: SPEC }).user, buildProposalPrompt({ spec: SPEC }).user);
});

test("the parser is tolerant, deduped, capped, and remembers denials", () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ id: `rule-${i}`, statement: `Rule number ${i} holds.` }));
  const { cards, warnings, notes } = parseProposalReply(
    ["I looked at the widget lifecycle.", "```json", JSON.stringify({ cards: [...many, { id: "rule-0", statement: "duplicate" }, { id: "denied-one", statement: "no" }, { nope: true }] }), "```"].join("\n"),
    { deniedIds: ["denied-one"] },
  );
  assert.equal(cards.length, MAX_PROPOSED_CARDS);
  assert.equal(notes, "I looked at the widget lifecycle.");
  assert.ok(warnings.some((w: string) => /already denied/.test(w)));
  assert.ok(warnings.some((w: string) => /second card with id/.test(w)));
  assert.ok(warnings.some((w: string) => /over the 8-card ceiling/.test(w)));
  assert.ok(warnings.some((w: string) => /malformed card/.test(w)));

  const empty = parseProposalReply("I could not find anything worth proposing.");
  assert.deepEqual(empty.cards, []);
  assert.ok(empty.warnings.length);
});

test("GOVERNANCE: only approved sentences become rules — a denied or candidate card reaches no handout, obligation, or gate", () => {
  const rules = approvedCardRules(CARDS);
  assert.deepEqual(rules.map((rule) => rule.id).sort(), ["hand-written", "publish-is-once"]);

  const handout = buildHandout({
    spec: SPEC,
    rules,
    target: { base_url: "http://127.0.0.1:9/", mode: "read-write" },
    budget: { execution_budget: 40, execution_timeout_ms: 60_000, iterations: 3, requests: 100, wall_clock_ms: 600_000 },
    policies: defaultScriptPolicies({ spec: SPEC }),
  });

  const everything = handout.files.map((file) => file.contents).join("\n");
  for (const card of CARDS.filter((c) => c.state !== "approved")) {
    assert.ok(!everything.includes(card.statement), `${card.id} leaked into the handout`);
    assert.ok(!handout.obligations.some((o: LegacyTestValue) => o.id === `rule:${card.id}`), `${card.id} became an obligation`);
  }
  assert.deepEqual(handout.manifest.rules.ids.sort(), ["hand-written", "publish-is-once"]);

  // The obligation manifest is what a verdict is computed against, so a card
  // that is not in it cannot influence one — with or without a handout.
  const obligations = deriveObligations({ policies: defaultScriptPolicies({ spec: SPEC }), spec: SPEC, rules });
  assert.deepEqual(
    obligations.filter((o: LegacyTestValue) => o.source === "rule").map((o: LegacyTestValue) => o.id).sort(),
    ["rule:hand-written", "rule:publish-is-once"],
  );
  assert.deepEqual(
    obligations.filter((o: LegacyTestValue) => o.source === "policy").map((o: LegacyTestValue) => o.id).sort(),
    LEVEL_0_POLICIES.map((policy: string) => `policy:${policy}`).sort(),
  );
});

test("card notes and declared exceptions render into INVARIANTS.md; provenance does not", () => {
  const invariants = renderInvariants(approvedCardRules(CARDS));
  assert.match(invariants, /\*\*Owner's note:\*\* Our support team leans on this/);
  assert.match(invariants, /\*\*Declared exception:\*\* None\./);
  assert.match(invariants, /A \*\*declared exception\*\* narrows its rule; it never cancels it/);
  // Provenance is the model's account of why it proposed a sentence. The
  // handout carries what a human approved, not why a model suggested it.
  assert.ok(!invariants.includes("409 response"));
});

test("an observation pass only calls GETs the document itself parameterizes", () => {
  const observable = observableOperations(SPEC);
  assert.deepEqual(observable.map((o: LegacyTestValue) => o.operation).sort(), ["GET /health", "GET /widgets"]);
  // `GET /widgets/{id}` needs an id the document does not supply, so the pass
  // never invents one.
  assert.ok(!observable.some((o: LegacyTestValue) => o.path.includes("{")));
});
