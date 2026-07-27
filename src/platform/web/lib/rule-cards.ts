// Rule cards: the copy and the pure logic behind the cards surface
// (docs/contracts/hosted.md#rule-cards, DESIGN N6, S0 §7.1).
//
// DOM-free on purpose, like lib/consolidation.js: the words and the decision
// rules are the parts worth pinning in the offline gate, and
// `tests/unit/web-rule-cards.test.ts` asserts both without a browser.
//
// **The copy is governed.** S0's proposal trial cleared precision and detection
// but its suite found 8 of 13 sealed faults against 11–12 for suites given the
// rules, so Level 1 ships as ASSISTED AUTHORING. Nothing on this surface may
// claim Playtest found a person's rules for them, and nothing may imply a
// complete set. The framing is "review and confirm your API's rules", the
// drafting is described as guessing from the document, and the cost of a wrong
// approval is stated where the person is deciding — because a wrong approved
// rule is a false positive on every future build. The offline test pins the
// phrases that carry that promise, so a future edit that quietly re-inflates
// the claim fails the gate.

/** Every user-visible string on the cards surface, in one reviewable place. */
export const COPY: WebDynamic = Object.freeze({
  title: "Your API's rules",

  intro: Object.freeze({
    heading: "Review and confirm your API's rules.",
    body:
      "Playtest reads your OpenAPI document and drafts rules it thinks your API follows. It is working " +
      "from the document alone — it cannot know your business — so every card is a suggestion for you " +
      "to judge, not something we found out about your system.",
    stakes:
      "Only rules you approve are ever tested. A rule you approve by mistake fails every future build, " +
      "so deny anything you are not sure about — you can always add it later.",
  }),

  level0: Object.freeze({
    heading: "Always on, whatever you decide here",
    body:
      "Your suite is judged against your OpenAPI document even if you approve nothing on this page: no " +
      "request answers a server error, every response uses a status the document declares, every body " +
      "matches its declared schema, and every response carries its declared content type.",
    limit:
      "Those four cannot catch a rule your document does not state — that a failed transfer writes no " +
      "ledger entries, that two accounts never share a name. That is what the cards below are for.",
    labels: Object.freeze({
      no_server_error: "No request answers a server error",
      documented_status: "Every response uses a documented status",
      response_schema: "Every body matches its declared schema",
      content_type: "Every response carries its declared content type",
    }),
  }),

  sections: Object.freeze({
    candidate: Object.freeze({
      title: "To review",
      blurb: "Drafted from your document. Nothing here is tested until you approve it.",
    }),
    approved: Object.freeze({
      title: "Approved",
      blurb: "These go to the test author with your notes.",
    }),
    denied: Object.freeze({
      title: "Not a rule",
      blurb: "How your API does not work. Playtest will not suggest these again.",
    }),
  }),

  actions: Object.freeze({
    approve: "Approve",
    deny: "Not a rule",
    edit: "Edit",
    remove: "Remove",
    undeny: "Actually, approve it",
    propose: "Draft rules from my document",
    proposeAgain: "Draft more rules",
    add: "Write a rule",
  }),

  note: Object.freeze({
    label: "Note for the test author",
    hint:
      "Anything that changes how this should be tested — “closure is a soft delete”, “only for EU " +
      "accounts”. It travels with the rule.",
    save: "Save note",
  }),

  empty: Object.freeze({
    title: "No rules yet",
    body:
      "Your suite already runs the four checks above. Add rules to cover what a document cannot state: " +
      "the things your team knows and your spec does not say.",
  }),

  propose: Object.freeze({
    title: "Draft rules from your OpenAPI document",
    body:
      "Playtest will suggest five to eight rules for you to review. It approves nothing — every " +
      "suggestion waits for you.",
    specLabel: "Your OpenAPI document (JSON or YAML)",
    specHint: "Paste it, or choose a file. It is read for this request and not stored.",
    focusLabel: "Anything specific to look at? (optional)",
    focusHint: "“Focus on the payments endpoints”, “we care most about who can see what”.",
    submit: "Draft rules",
    working: "Reading your document…",
    notesLabel: "What Playtest looked at",
    unavailable:
      "Drafting needs the platform's model gateway, which this deployment has not configured. You can " +
      "still write your own rules, and your suite is judged by the four checks above either way.",
  }),

  form: Object.freeze({
    addTitle: "Write a rule",
    editTitle: "Edit rule",
    intro: "One sentence about how your API behaves, in your own words. Write it as something that is always true.",
    yoursIsApproved: "A rule you write is approved by definition — it is yours.",
    editingIsNotApproving: "Editing does not approve it. Approve it when the sentence is right.",
    statementLabel: "The rule",
    statementHint: "e.g. “A transfer that ends failed writes no ledger entries.”",
    titleLabel: "Short name (optional)",
    applicabilityLabel: "Where it applies (optional)",
    applicabilityHint: "Which endpoints, and the corners that matter — “including at exactly the daily limit”.",
    exceptionsLabel: "Exception (optional)",
    exceptionsHint: "Something the rule deliberately does not cover. An exception narrows a rule; it cannot cancel it.",
    submitAdd: "Add rule",
    submitEdit: "Save",
    removeConfirmTitle: "Remove this rule?",
    removeConfirmBody: "It stops being tested. You can write it again later.",
  }),

  provenancePrefix: "proposed from: ",
  editedBadge: "edited",
  yoursBadge: "yours",
});

/** Split a suite's cards into the three sections the page renders. */
export function bucketCards(cards: WebDynamic = []) {
  const out: WebDynamic = { candidate: [], approved: [], denied: [] };
  for (const card of cards) (out[card.state] ?? out.candidate).push(card);
  return out;
}

/** The one line under the page title: what is enforced, and what is waiting. */
export function summaryLine(data: WebDynamic) {
  const counts = data?.counts ?? { candidate: 0, approved: 0, denied: 0 };
  const level0 = data?.level_0?.length ?? 0;
  const parts: WebDynamic = [`${level0} default check${level0 === 1 ? "" : "s"} always on`];
  parts.push(`${counts.approved} approved rule${counts.approved === 1 ? "" : "s"}`);
  if (counts.candidate) parts.push(`${counts.candidate} to review`);
  if (counts.denied) parts.push(`${counts.denied} denied`);
  return parts.join(" · ");
}

/** "proposed from: …" — one line, and only for a card a model proposed. */
export function provenanceLine(card: WebDynamic) {
  if (!card?.provenance || card.origin !== "proposed") return null;
  return `${COPY.provenancePrefix}${card.provenance}`;
}

/** A friendly name for a Level 0 policy; unknown ones fall back to their id. */
export const level0Label = (policy: WebDynamic) => COPY.level0.labels[policy] ?? policy;

/**
 * Validate a rule form before it is sent. The statement is the whole card, so
 * an empty one is the only hard error; everything else is optional by design
 * (an owner who has only a sentence should not be blocked by a form).
 */
export function validateRuleForm(form: WebDynamic) {
  const errors: WebDynamic = [];
  const statement = (form?.statement ?? "").trim();
  if (!statement) errors.push("A rule needs a sentence.");
  if (statement.length > 1000) errors.push("That is longer than a rule should be — trim it to one sentence.");
  return errors;
}

/** The request body for adding or editing a card. Empty strings clear a field. */
export function cardPayload(form: WebDynamic) {
  return {
    statement: (form?.statement ?? "").trim(),
    title: (form?.title ?? "").trim(),
    applicability: (form?.applicability ?? "").trim(),
    exceptions: (form?.exceptions ?? "").trim(),
    note: (form?.note ?? "").trim(),
  };
}

/** Current field values for the edit form, from a card. */
export function formFromCard(card: WebDynamic) {
  return {
    statement: card?.statement ?? "",
    title: card?.title ?? "",
    applicability: card?.applicability ?? "",
    exceptions: card?.exceptions ?? "",
    note: card?.note ?? "",
  };
}

/** A pasted spec: JSON parses into `document`, anything else travels as `text`. */
export function specDeclaration(raw: WebDynamic) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return { document: parsed };
  } catch {}
  return { text };
}
