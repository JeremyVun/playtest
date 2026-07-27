import type { DynamicValue } from "./types.ts";

// Rule-card proposals — Level 1 of the invariant ladder
// (docs/contracts/scripts.md#invariant-levels, DESIGN §5 item 6, N6).
//
// Level 0 is the spec-derived policy set in ./gate.js: on by default, zero user
// input, and the floor under every script suite. Level 1 is this module: the
// platform reads the OpenAPI document — and, when the caller supplies one, a
// read-only observation of the running service — and PROPOSES five to eight
// plain-language rules for the API's owner to review.
//
// The disposition S0 recorded (studies/api-suite/REPORT.md §4, DESIGN §7.1) is
// what this module is shaped by, and it is not a headline: **assisted
// authoring**. The proposal trial's precision was clean — eight cards, none
// harmful, none unsupported, all approved unedited — but a suite built from
// self-proposed rules detected 8 of 13 sealed faults against 11–12 for suites
// given the rules. So nothing here claims to discover an owner's rules for them.
// It drafts sentences they recognize, and three of the study's findings are
// encoded as prompt rules rather than left to the model's taste:
//
//   1. **One rule per card.** Two of eight cards merged two independent rules,
//      which is how a card set that looks complete under-covers the API.
//   2. **An exception narrows a rule; it never cancels it.** The trial's
//      ownership card wrote "the administrator is unrestricted" in its
//      applicability and "immovable by anyone" in its exceptions — the rule was
//      unenforceable as written, and only the trial's own check found out.
//   3. **Do not re-propose the Level 0 policies.** The trial declined them
//      unprompted and was right to; the prompt now says so, and the policy set
//      it must not duplicate is passed in rather than assumed.
//
// Governance (N6) is structural, not advisory: `approvedCardRules` is the ONLY
// function in the engine that turns cards into handout rules, and it hard-filters
// on `state === "approved"`. A candidate or denied card has no path to a handout,
// an obligation id, or a gate — not because a prompt asked nicely.
//
// No model is called here. This module builds a prompt, parses a reply, and
// validates shapes; the caller owns the gateway.
import { DummyConfigError } from "../config.ts";
import { slugifyRuleId } from "./handout.ts";
import { LEVEL_0_POLICIES } from "./gate.ts";

/**
 * The proposal prompt's pin. Bump it whenever the prompt text, the card shape,
 * or the reply grammar changes — a suite's cards record the pin they were
 * proposed under, so a later reviewer can tell which instrument wrote them.
 */
export const RULE_PROPOSAL_PROMPT_VERSION = "rule-proposal-v1";

/** Card lifecycle. `candidate` is the only state a model can produce. */
export const CARD_STATES: DynamicValue = Object.freeze(["candidate", "approved", "denied"]);

/** Where a card's sentence came from. `authored` is add-your-own. */
export const CARD_ORIGINS: DynamicValue = Object.freeze(["proposed", "authored"]);

/** The band DESIGN §5 item 6 fixes, and what the prompt asks for. */
export const MIN_PROPOSED_CARDS = 5;
export const MAX_PROPOSED_CARDS = 8;

/** How many read-only requests an observation pass may spend by default. */
export const DEFAULT_OBSERVATION_BUDGET = 40;

const text = (value: DynamicValue) => (value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim());

/**
 * Validate one rule card. Cards are user-facing records — a human approves,
 * edits, or writes them — so a malformed one is user input, never a crash.
 *
 * @param {object} card
 * @param {{ where?: string, state?: string, origin?: string }} [options]
 */
export function normalizeCard(card: DynamicValue, { where = "rule card", state = null, origin = null }: DynamicValue = {}) {
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new DummyConfigError(`${where}: a card is an object { id, statement }`);
  const statement = text(card.statement);
  if (!statement) throw new DummyConfigError(`${where}: a card needs a statement — the one sentence a human approves`);
  const title = text(card.title);
  const id = text(card.id) || slugifyRuleId(title || statement).split("-").slice(0, 6).join("-");
  if (!id) throw new DummyConfigError(`${where}: a card needs an id, a title, or a statement to derive one from`);
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new DummyConfigError(`${where}: card id ${JSON.stringify(id)} must be letters, digits, dot, dash, or underscore`);
  const resolvedState = state ?? (text(card.state) || "candidate");
  if (!CARD_STATES.includes(resolvedState)) throw new DummyConfigError(`${where}: card state must be one of ${CARD_STATES.join(", ")} (got ${JSON.stringify(resolvedState)})`);
  const resolvedOrigin = origin ?? (text(card.origin) || "proposed");
  if (!CARD_ORIGINS.includes(resolvedOrigin)) throw new DummyConfigError(`${where}: card origin must be one of ${CARD_ORIGINS.join(", ")} (got ${JSON.stringify(resolvedOrigin)})`);
  return {
    id,
    ...(title ? { title } : {}),
    statement,
    ...(text(card.applicability) ? { applicability: text(card.applicability) } : {}),
    ...(text(card.exceptions) ? { exceptions: text(card.exceptions) } : {}),
    ...(text(card.provenance) ? { provenance: text(card.provenance) } : {}),
    ...(text(card.note) ? { note: text(card.note) } : {}),
    state: resolvedState,
    origin: resolvedOrigin,
  };
}

/**
 * Validate a proposed set: dedupe ids, cap at the band's ceiling, and report
 * what was dropped rather than silently trimming. Every card comes back a
 * `candidate` whatever the model called it — a model cannot propose an approved
 * rule, which is the whole of N6 in one line.
 *
 * @returns {{ cards: object[], warnings: string[] }}
 */
export function normalizeProposedCards(list: DynamicValue, { where = "proposed cards", deniedIds = [] }: DynamicValue = {}) {
  if (!Array.isArray(list)) throw new DummyConfigError(`${where}: expected a list of cards`);
  const denied: DynamicValue = new Set(deniedIds.map((id: DynamicValue) => String(id)));
  const cards: DynamicValue = [];
  const warnings: DynamicValue = [];
  const seen: DynamicValue = new Set();
  for (const raw of list) {
    let card;
    try {
      card = normalizeCard(raw, { where, state: "candidate", origin: "proposed" });
    } catch (error: DynamicValue) {
      warnings.push(`dropped a malformed card: ${String(error?.message ?? error).replace(`${where}: `, "")}`);
      continue;
    }
    if (seen.has(card.id)) {
      warnings.push(`dropped a second card with id ${JSON.stringify(card.id)}`);
      continue;
    }
    // Denial is remembered structurally, not by asking the prompt to remember:
    // a re-proposal of a denied rule never reaches the owner's queue.
    if (denied.has(card.id)) {
      warnings.push(`dropped ${JSON.stringify(card.id)}: the owner already denied this rule`);
      continue;
    }
    seen.add(card.id);
    if (cards.length >= MAX_PROPOSED_CARDS) {
      warnings.push(`dropped ${JSON.stringify(card.id)}: the proposal was over the ${MAX_PROPOSED_CARDS}-card ceiling`);
      continue;
    }
    cards.push(card);
  }
  if (cards.length && cards.length < MIN_PROPOSED_CARDS) warnings.push(`only ${cards.length} of ${MIN_PROPOSED_CARDS}–${MAX_PROPOSED_CARDS} cards came back`);
  return { cards, warnings };
}

/**
 * **The governance boundary.** Cards in, handout rule statements out, and the
 * filter is the first line of the function body rather than a caller's
 * responsibility (N6). Nothing else in the engine converts a card into a rule,
 * so a candidate or denied sentence cannot reach `buildHandout`, cannot become
 * a `rule:` obligation, and therefore cannot appear in any verdict column.
 *
 * The card's provenance is deliberately NOT carried into the handout: it is the
 * model's account of why it proposed the sentence, and the handout carries only
 * what a human approved plus what they wrote themselves.
 *
 * @param {object[]} cards every card of a suite, in any state
 * @returns {object[]} rule records for `buildHandout({ rules })`
 */
export function approvedCardRules(cards: DynamicValue = []) {
  return (Array.isArray(cards) ? cards : [])
    .filter((card) => card && card.state === "approved")
    .map((card) => ({
      id: card.id,
      ...(card.title ? { title: card.title } : {}),
      statement: card.statement,
      ...(card.applicability ? { applicability: card.applicability } : {}),
      ...(card.exceptions ? { exceptions: card.exceptions } : {}),
      ...(card.note ? { notes: [card.note] } : {}),
    }));
}

// ---------------------------------------------------------------- the prompt

const SYSTEM = [
  "You are Playtest's rule-card proposer. You read an API's OpenAPI document — and, when one is",
  "supplied, a read-only observation of the running service — and you propose a short list of",
  "candidate business rules for that API's owner to review.",
  "",
  "You are drafting sentences the owner will recognize, not discovering rules on their behalf. Every",
  "card is a proposal: the owner approves, edits, or denies it, and only the sentences they approve",
  "are ever enforced. You never decide anything, and you never write test code here.",
  "",
  "A good card is one sentence an owner can approve at sight — written in their API's own vocabulary,",
  "about behaviour their system either has or does not have. A bad card is a plausible sentence they",
  "will approve without checking, because a wrong approved rule is a false positive on every future",
  "build, forever. When you are not sure the document supports a rule, leave it out and say so in",
  "your notes rather than proposing it.",
  "",
  "The rules of the format, all of them load-bearing:",
  "",
  `1. Propose between ${MIN_PROPOSED_CARDS} and ${MAX_PROPOSED_CARDS} cards. Under the ceiling, prefer the rules whose violation would be`,
  "   worst — money, authorization, lifecycle, uniqueness, conservation, ordering.",
  "2. ONE rule per card. Never merge two independent rules into one sentence, even when they share a",
  "   subject: a merged card is approved once and tested once, and the second rule quietly vanishes.",
  "3. An exception NARROWS a rule; it never cancels it. If the exception you want to write would make",
  "   the statement unenforceable — 'except that the administrator may do anything' — the card is",
  "   wrong. Narrow the statement, or split the exception out as its own card.",
  "4. Do not propose rules the default policy set already enforces. They are listed below; a card that",
  "   duplicates one costs the owner a decision and buys nothing.",
  "5. Say where the rule bites. The applicability line names the operations and, when the rule has a",
  "   boundary or a state corner, names that too — 'including at exactly the limit', 'including after",
  "   the account is closed'. A rule with no corner named is decorative.",
  "6. Provenance is one line naming what you actually read: an operation and the fragment, or the",
  "   observed exchange. Do not cite a document you were not given.",
  "",
  "Reply with a short plain-text note about what you looked at and what you deliberately left out,",
  "then exactly one fenced ```json block:",
  "",
  "```json",
  "{",
  '  "cards": [',
  "    {",
  '      "id": "failed-transfer-writes-nothing",',
  '      "title": "A failed transfer writes no ledger entries",',
  '      "statement": "A transfer that ends in the failed state writes no ledger entries and moves no balance.",',
  '      "applicability": "POST /transfers and the settlement tick, including a transfer that fails the balance re-check at settlement time.",',
  '      "exceptions": "None. A transfer that is canceled before settlement also writes nothing.",',
  '      "provenance": "POST /transfers · Transfer.status enum · x-ledger-consistency.settlement"',
  "    }",
  "  ]",
  "}",
  "```",
  "",
  "`id` is a short lowercase slug. `title`, `applicability` and `provenance` are one line each;",
  "`exceptions` may be empty. Nothing outside the fenced block is read as a card.",
].join("\n");

function operationLines(spec: DynamicValue) {
  return (spec?.operations ?? []).map((operation: DynamicValue) => {
    const bits = [`${operation.method} ${operation.path}`];
    if (operation.summary) bits.push(operation.summary);
    if (operation.status_codes?.length) bits.push(`statuses ${operation.status_codes.join("/")}`);
    return `- ${bits.join(" · ")}`;
  });
}

/**
 * Assemble the proposal call's messages. Deterministic given its inputs: the
 * same spec, policy set, denied list, and observation produce the same bytes,
 * so a card set is reproducible from what the suite recorded.
 *
 * @param {{ spec: object, policies?: string[], denied?: object[], approved?: object[],
 *           observation?: object|null, focus?: string|null }} input
 * @returns {{ version: string, system: string, user: string }}
 */
export function buildProposalPrompt({ spec, policies = LEVEL_0_POLICIES, denied = [], approved = [], observation = null, focus = null }: DynamicValue = {}) {
  if (!spec || typeof spec !== "object") throw new DummyConfigError("rule proposal: a resolved OpenAPI document is required");
  const parts = [
    `# ${spec.title || "This API"}${spec.version ? ` ${spec.version}` : ""}`,
    "",
    `${spec.operations?.length ?? 0} operation(s):`,
    "",
    ...operationLines(spec),
    "",
    "## Already enforced by default (do not propose these)",
    "",
    ...policies.map((policy: DynamicValue) => `- \`${policy}\``),
    "",
  ];
  if (approved.length) {
    parts.push(
      "## Rules the owner has already approved (do not repeat them; propose what is missing)",
      "",
      ...approved.map((card: DynamicValue) => `- ${card.statement}`),
      "",
    );
  }
  if (denied.length) {
    parts.push(
      "## Rules the owner has already DENIED (their API does not work this way — do not propose them again)",
      "",
      ...denied.map((card: DynamicValue) => `- ${card.statement}`),
      "",
    );
  }
  if (observation) {
    parts.push("## A read-only observation of the running service", "", renderObservation(observation), "");
  }
  if (focus) parts.push("## What the owner asked you to look at", "", focus, "");
  parts.push("## The OpenAPI document", "", "```json", JSON.stringify(spec.document ?? spec, null, 2), "```", "");
  return { version: RULE_PROPOSAL_PROMPT_VERSION, system: SYSTEM, user: parts.join("\n") };
}

/**
 * Pull the cards out of one reply. Tolerant in the same way the authoring
 * loop's parser is: a reply that carries no usable block is a warning and an
 * empty set, never a thrown error — the owner sees "nothing came back, try
 * again", not a stack.
 *
 * @returns {{ cards: object[], notes: string, warnings: string[] }}
 */
export function parseProposalReply(reply: DynamicValue, { deniedIds = [] }: DynamicValue = {}) {
  const body = String(reply ?? "");
  const blocks = [...body.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  let parsed: DynamicValue = null;
  for (const block of blocks.reverse()) {
    try {
      const candidate = JSON.parse(block!); // TODO(ts): matchAll only adds the captured JSON block
      if (candidate && typeof candidate === "object") {
        parsed = candidate;
        break;
      }
    } catch {}
  }
  const notes = body.split(/```/)[0]!.trim(); // TODO(ts): splitting a string always yields a first segment
  if (!parsed) return { cards: [], notes, warnings: ["the reply carried no readable JSON block of cards"] };
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cards) ? parsed.cards : null;
  if (!list) return { cards: [], notes, warnings: ['the reply\'s JSON block had no "cards" list'] };
  const { cards, warnings } = normalizeProposedCards(list, { where: "rule proposal", deniedIds });
  return { cards, notes, warnings };
}

// ----------------------------------------------------- the observation pass

/**
 * Render an observation digest for the prompt. Kept small on purpose: the pass
 * exists to tell the proposer what the API's vocabulary and shapes actually
 * are, not to hand it a corpus to pattern-match.
 */
export function renderObservation(observation: DynamicValue) {
  const lines = [
    `${observation.requests} read-only request(s) of a ${observation.budget} budget. Nothing was mutated:`,
    "the client refused every non-GET/HEAD method at the wire.",
    "",
    "| Exchange | Status | Response |",
    "|---|---|---|",
  ];
  for (const exchange of observation.exchanges ?? []) {
    lines.push(`| \`${exchange.method} ${exchange.path}\` | ${exchange.status} | ${exchange.summary} |`);
  }
  if (observation.refused?.length) {
    lines.push("", "Refused by the client (never sent):", ...observation.refused.map((refusal: DynamicValue) => `- ${refusal}`));
  }
  return lines.join("\n");
}

/** A one-line account of a response body, capped hard. */
function summarize(body: DynamicValue, contentType: DynamicValue) {
  if (body === null || body === undefined || body === "") return "(empty)";
  if (!/json/.test(contentType ?? "")) return `${contentType || "unknown type"}, ${body.length} chars`;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `unparseable JSON, ${body.length} chars`;
  }
  const describe = (value: DynamicValue, depth = 0): DynamicValue => {
    if (Array.isArray(value)) return depth > 1 ? `[${value.length}]` : `[${value.length} × ${value.length ? describe(value[0], depth + 1) : "?"}]`;
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      if (depth > 1) return `{${keys.length} keys}`;
      return `{ ${keys.slice(0, 8).map((key) => `${key}: ${describe(value[key], depth + 1)}`).join(", ")}${keys.length > 8 ? ", …" : ""} }`;
    }
    if (typeof value === "string") return value.length > 24 ? `"${value.slice(0, 24)}…"` : JSON.stringify(value);
    return JSON.stringify(value);
  };
  const rendered = describe(parsed);
  return rendered.length > 240 ? `${rendered.slice(0, 240)}…` : rendered;
}

/**
 * Which operations an observation pass may call. `GET` only, and only when
 * every required parameter has a value the document itself supplies — the pass
 * must never invent an identifier and never guess at a path.
 */
export function observableOperations(spec: DynamicValue) {
  const out: DynamicValue = [];
  for (const operation of spec?.operations ?? []) {
    if (operation.method !== "GET") continue;
    let path = operation.path;
    let usable = true;
    const query: DynamicValue = [];
    for (const parameter of operation.parameters ?? []) {
      const example = parameter.example ?? parameter.schema?.example ?? parameter.schema?.default ?? parameter.schema?.enum?.[0];
      if (parameter.in === "path") {
        if (example === undefined) {
          usable = false;
          break;
        }
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(example)));
      } else if (parameter.in === "query" && parameter.required) {
        if (example === undefined) {
          usable = false;
          break;
        }
        query.push(`${encodeURIComponent(parameter.name)}=${encodeURIComponent(String(example))}`);
      }
    }
    if (!usable || /[{}]/.test(path)) continue;
    out.push({ operation: `${operation.method} ${operation.path}`, path: query.length ? `${path}?${query.join("&")}` : path });
  }
  return out;
}

/**
 * Run a read-only observation pass through the shipped script client
 * (DESIGN §5 item 6: "optionally plus a read-only observation pass"). S0's
 * proposal trial spent 42 of a 60-request budget here and its cards were
 * materially better for it — one of the eight rested on an anomaly it saw live,
 * which turned out to be a real defect.
 *
 * The pass is mechanical: GET operations the document itself parameterizes,
 * once each, plus a `limit=1` pagination probe on collections. There is no model
 * in it. It goes through the ordinary proxy in `read-only` mode, so the wire
 * refuses any mutation regardless of what this function asks for, the origin
 * lock holds, and the budget is enforced at the wire rather than by a counter
 * here.
 *
 * @param {{ target: {base_url: string, allowed_origins?: string[]}, spec: object,
 *           budget?: number, secrets?: (string|{name:string})[], headers?: object,
 *           fetchImpl?: Function }} input
 * @returns {Promise<{ version: string, requests: number, budget: number,
 *                     exchanges: object[], refused: string[], harEntries: object[] }>}
 */
export async function observeApi({ target, spec, budget = DEFAULT_OBSERVATION_BUDGET, secrets = [], headers = {}, fetchImpl = null }: DynamicValue = {}) {
  if (!target?.base_url) throw new DummyConfigError("observation pass: target.base_url is required");
  const { startScriptProxy } = await import("./proxy.ts");
  const { createScriptClient } = await import("./client.ts");
  const { createHarRecorder } = await import("./har.ts");

  const secretNames = secrets.map((secret: DynamicValue) => (typeof secret === "string" ? secret : secret.name));
  const recorder = createHarRecorder({ target: target.base_url, contractVersion: "observation" });
  const proxy = await startScriptProxy({
    baseUrl: target.base_url,
    allowedOrigins: target.allowed_origins ?? null,
    // Never anything else. An observation pass that could mutate would be an
    // authoring-time execution without the target authorization behind it.
    mode: "read-only",
    budget,
    secretNames,
    recorder,
    fetchImpl,
  });

  const exchanges: DynamicValue = [];
  const refused: DynamicValue = [];
  try {
    const client = createScriptClient({
      endpoint: proxy.endpoint,
      token: proxy.token,
      // The control channel is the proxy's own loopback socket; the target is
      // reached only from the proxy side, exactly as it is for a script child.
      fetchImpl: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
      baseUrl: target.base_url,
      mode: "read-only",
      budget,
      secretNames,
    });
    for (const { operation, path } of observableOperations(spec)) {
      let answer;
      try {
        answer = await client.get(path, { headers });
      } catch (error: DynamicValue) {
        refused.push(`${operation}: ${String(error?.message ?? error).split("\n")[0]}`);
        break;
      }
      exchanges.push({
        method: "GET",
        path,
        operation,
        status: answer.status,
        summary: summarize(answer.text, answer.headers?.["content-type"] ?? ""),
      });
      // One pagination probe per collection: the page-size-1 walk is what
      // surfaced a real cursor defect in S0, and it costs one request.
      const looksPaged = answer.json && typeof answer.json === "object" && !Array.isArray(answer.json) && Object.values(answer.json).some((value) => Array.isArray(value));
      if (looksPaged && !path.includes("limit=")) {
        try {
          const probePath = `${path}${path.includes("?") ? "&" : "?"}limit=1`;
          const probe = await client.get(probePath, { headers });
          exchanges.push({ method: "GET", path: probePath, operation, status: probe.status, summary: summarize(probe.text, probe.headers?.["content-type"] ?? "") });
        } catch (error: DynamicValue) {
          refused.push(`${operation} (limit=1 probe): ${String(error?.message ?? error).split("\n")[0]}`);
          break;
        }
      }
    }
  } finally {
    await proxy.close();
  }
  return { version: RULE_PROPOSAL_PROMPT_VERSION, requests: exchanges.length, budget, exchanges, refused, harEntries: recorder.entries };
}
