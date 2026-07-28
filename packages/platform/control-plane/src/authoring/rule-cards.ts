// Rule cards: storage, the approved-only boundary, and the proposal call
// (docs/contracts/hosted.md#rule-cards, docs/contracts/scripts.md#invariant-levels,
// DESIGN N6).
//
// This is the second call on the shipped authoring assistant, and it is shaped
// by S0's Level 1 disposition (DESIGN §7.1): **assisted authoring, not a
// zero-input headline.** The platform drafts sentences an owner recognizes; it
// does not discover their rules for them, and no copy in this product says it
// does.
//
// The governance rule N6 states — only human-approved sentences are enforced —
// is a SQL predicate here, not a convention. `approvedRuleCards` is the only
// exported path from this table to an authoring handout, its query filters on
// `state = 'approved'`, and it hands its rows through the engine's
// `approvedCardRules` on the way out, which filters again in its own body. A
// caller cannot reach the unapproved rows through this module at all, and the
// two filters are independent: breaking one still leaves the other.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { estimateCost, forcedToolCall } from "@playtest/core/llm";
import {
  LEVEL_0_POLICIES,
  RULE_PROPOSAL_TOOL,
  approvedCardRules,
  buildProposalPrompt,
  normalizeCard,
  normalizeProposalToolArgs,
  resolveSpecSource,
  validateProposalToolArgs,
} from "@playtest/core/api-suite-scripts";
import { AppError, badRequest } from "../errors.ts";
import { ulid } from "../ulid.ts";

export { LEVEL_0_POLICIES };

/** Card lifecycle, mirrored by the migration's CHECK constraint. */
export const RULE_CARD_STATES = Object.freeze(["candidate", "approved", "denied"]);

/** A proposal reply is capped well below the model's ceiling: eight short cards. */
const MAX_TOKENS = 4000;

/**
 * The public projection of a card row. `proposed_statement` rides along only
 * when the human changed the sentence — a reviewer wants to see what the model
 * actually said before they decide whether to trust the next batch.
 */
export function cardView(row: HostedDynamic) {
  const edited = Boolean(row.proposed_statement) && row.proposed_statement !== row.statement;
  return {
    id: row.id,
    rule_id: row.rule_id,
    state: row.state,
    origin: row.origin,
    title: row.title ?? null,
    statement: row.statement,
    applicability: row.applicability ?? null,
    exceptions: row.exceptions ?? null,
    provenance: row.provenance ?? null,
    note: row.note ?? null,
    edited,
    ...(edited ? { proposed_statement: row.proposed_statement } : {}),
    decided_by: row.decided_by ?? null,
    decided_at: row.decided_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Every card of a suite, in any state. Candidates first — they are the queue. */
export async function listRuleCards(q: HostedDynamic, suiteId: HostedDynamic) {
  const { rows } = await q.query(
    `SELECT * FROM rule_cards WHERE suite_id = $1
      ORDER BY CASE state WHEN 'candidate' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at, id`,
    [suiteId],
  );
  return rows;
}

/**
 * **The governance boundary.** The approved rule statements of one suite, in the
 * shape `buildHandout({ rules })` takes, and the only way anything in the hosted
 * platform gets rules for a handout or a gate.
 *
 * Two independent filters, deliberately: the `state = 'approved'` predicate
 * below, and the engine's `approvedCardRules`, which filters again. A denied or
 * never-approved sentence cannot reach an authoring job through here.
 */
export async function approvedRuleCards(q: HostedDynamic, suiteId: HostedDynamic) {
  const { rows } = await q.query(
    `SELECT * FROM rule_cards WHERE suite_id = $1 AND state = 'approved' ORDER BY created_at, id`,
    [suiteId],
  );
  return approvedCardRules(rows.map((row: HostedDynamic) => ({ ...row, id: row.rule_id, state: row.state })));
}

/** The denied sentences of a suite: what the proposer must not raise again. */
export async function deniedRuleCards(q: HostedDynamic, suiteId: HostedDynamic) {
  const { rows } = await q.query(
    `SELECT rule_id, statement FROM rule_cards WHERE suite_id = $1 AND state = 'denied' ORDER BY created_at`,
    [suiteId],
  );
  return rows.map((row: HostedDynamic) => ({ id: row.rule_id, statement: row.statement }));
}

/**
 * Mint a rule id that is free within this suite. Ids are obligation slugs and
 * are immutable once minted, so a collision is resolved at creation rather than
 * by renaming something an authored check may already reference.
 */
export function uniqueRuleId(candidate: HostedDynamic, taken: HostedDynamic) {
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; n < 100; n += 1) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }
  return `${candidate}-${ulid().slice(-6).toLowerCase()}`;
}

/** Insert one card. Every write goes through here so the shape is validated once. */
export async function insertRuleCard(tx: HostedDynamic, { projectId, suiteId, card, decidedBy = null, taken }: HostedDynamic) {
  const normalized = normalizeCard(card, { where: "rule card" });
  const ruleId = uniqueRuleId(normalized.id, taken);
  taken.add(ruleId);
  const id = ulid();
  const { rows } = await tx.query(
    `INSERT INTO rule_cards (id, project_id, suite_id, rule_id, state, origin, title, statement,
                             applicability, exceptions, provenance, note, proposed_statement,
                             decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      id,
      projectId,
      suiteId,
      ruleId,
      normalized.state,
      normalized.origin,
      normalized.title ?? null,
      normalized.statement,
      normalized.applicability ?? null,
      normalized.exceptions ?? null,
      normalized.provenance ?? null,
      normalized.note ?? null,
      normalized.origin === "proposed" ? normalized.statement : null,
      normalized.state === "candidate" ? null : decidedBy,
      normalized.state === "candidate" ? null : Date.now(),
    ],
  );
  return rows[0];
}

// ------------------------------------------------------------ the proposal call

/** Whether this deployment can call the model at all (the §8 LLM gateway). */
export const proposerConfigured = (env = process.env) => Boolean(env.PLAYTEST_LLM_BASE_URL);

export function requireProposerConfigured(env = process.env) {
  if (!env.PLAYTEST_LLM_BASE_URL) {
    throw new AppError(
      "not_configured",
      "proposing rule cards needs the platform LLM gateway: set PLAYTEST_LLM_BASE_URL " +
        "(and PLAYTEST_LLM_API_KEY) on the control plane (see src/config.ts). You can still write " +
        "your own rules by hand, and your suite is judged by its default policies either way",
    );
  }
}

/**
 * Resolve the OpenAPI document a proposal call reasons over.
 *
 * The control plane accepts an uploaded or pasted document only. It does not
 * fetch a URL and it does not auto-discover: reaching the user's target is the
 * runner-agent's job behind the escape-tested boundary, and spec provisioning
 * from ring config lands with the hosted authoring job (S4). Until then
 * the console asks for the document, which is one of the three supported ways
 * to supply one either way.
 */
export async function resolveProposalSpec(declaration: HostedDynamic) {
  if (!declaration || typeof declaration !== "object") throw badRequest('"spec" is required: paste or upload your OpenAPI document');
  if (declaration.url || declaration.discover) {
    throw badRequest(
      "the control plane does not fetch an OpenAPI document from a URL — paste or upload the document " +
        "(a spec URL becomes ring configuration when hosted authoring jobs land)",
    );
  }
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-spec-"));
  try {
    const { spec } = await resolveSpecSource(
      { document: declaration.document ?? undefined, text: declaration.text ?? undefined },
      { workDir, where: "spec" },
    );
    if (!spec.operations?.length) throw badRequest("that OpenAPI document declares no operations — there is nothing to propose rules about");
    return spec;
  } catch (error: HostedDynamic) {
    if (error instanceof AppError) throw error;
    throw badRequest(`that OpenAPI document could not be read — ${String(error?.message ?? error).split("\n")[0]}`);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Ask the model for candidate rule cards. Returns the parsed candidates and
 * what it cost; persisting them is the caller's transaction.
 *
 * Nothing here can produce an approved rule: the parser pins every card to
 * `candidate`, and the writer records `decided_by`/`decided_at` only for a
 * state a human chose.
 */
export async function proposeRuleCards(ctx: HostedDynamic, { spec, approved = [], denied = [], observation = null, focus = null }: HostedDynamic) {
  const model = ctx.config.llm.authoringModel;
  const prompt = buildProposalPrompt({ spec, policies: LEVEL_0_POLICIES, approved, denied, observation, focus });
  let reply;
  try {
    reply = await forcedToolCall({
      model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      tool: RULE_PROPOSAL_TOOL,
      validate: validateProposalToolArgs,
      maxTokens: MAX_TOKENS,
    });
  } catch (error: HostedDynamic) {
    throw new AppError("internal", `the model gateway did not respond (${String(error?.message ?? error).split("\n")[0]}) — try again in a moment`, { status: 502 });
  }
  const parsed = normalizeProposalToolArgs(reply.args, { deniedIds: denied.map((card: HostedDynamic) => card.id) });
  return {
    ...parsed,
    usage: { model, ...reply.tokens, cost_usd: estimateCost(model, reply.tokens) },
  };
}
