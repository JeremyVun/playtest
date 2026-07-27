// Rule cards (docs/contracts/hosted.md#rule-cards, DESIGN N6).
//
// Level 1 of the invariant ladder as an HTTP surface: propose candidates, then
// approve / deny / edit / add-your-own / note them. Level 0 needs no surface —
// the four default policies are code and this API reports them read-only so the
// console can show a person what their suite is already judged against before
// they touch a single card.
//
// The one rule that governs the whole file: **a model cannot approve anything.**
// The proposal endpoint writes rows in `candidate` only; `decided_by` and
// `decided_at` are stamped from an authenticated human principal; and the only
// read path into an authoring handout is `approvedRuleCards`, whose query
// filters on state. There is no endpoint here that sets a state without a
// person behind it.
import { readJsonBody, created } from "../http.ts";
import { requireAuth, guard, getSuite, stringField } from "./util.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { audit, actorOf } from "../audit.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import {
  LEVEL_0_POLICIES,
  approvedRuleCards,
  cardView,
  deniedRuleCards,
  insertRuleCard,
  listRuleCards,
  proposeRuleCards,
  proposerConfigured,
  requireProposerConfigured,
  resolveProposalSpec,
} from "../authoring/rule-cards.ts";

/** The feed types this resource emits; the console subscribes to exactly these. */
export const RULE_CARD_EVENTS = Object.freeze([
  "rule_card.proposed",
  "rule_card.approved",
  "rule_card.denied",
  "rule_card.edited",
  "rule_card.added",
  "rule_card.removed",
]);

const MAX_STATEMENT = 1000;
const MAX_LINE = 600;
const MAX_NOTE = 2000;

/**
 * What a suite is judged against today, in the order a person reads it: the
 * Level 0 floor they get for free, then their cards.
 *
 * GET /suites/:s/rule-cards [viewer]
 */
export async function listCards(ctx: HostedDynamic) {
  requireAuth(ctx);
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "viewer");
  const rows = await listRuleCards(ctx.db, suite.id);
  return {
    suite_id: suite.id,
    level_0: LEVEL_0_POLICIES.map((policy: HostedDynamic) => ({ policy, obligation: `policy:${policy}` })),
    cards: rows.map(cardView),
    counts: {
      candidate: rows.filter((row: HostedDynamic) => row.state === "candidate").length,
      approved: rows.filter((row: HostedDynamic) => row.state === "approved").length,
      denied: rows.filter((row: HostedDynamic) => row.state === "denied").length,
    },
    can_propose: proposerConfigured(),
  };
}

/**
 * The approved statements exactly as an authoring handout will receive them.
 * Read-only, and it is the same function the authoring job calls — so what this
 * shows is what the author gets, not a parallel rendering of it.
 *
 * GET /suites/:s/rule-cards/handout [viewer]
 */
export async function handoutRules(ctx: HostedDynamic) {
  requireAuth(ctx);
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "viewer");
  return { suite_id: suite.id, policies: LEVEL_0_POLICIES, rules: await approvedRuleCards(ctx.db, suite.id) };
}

/**
 * Propose candidate cards from an OpenAPI document.
 *
 * POST /suites/:s/rule-cards/propose [editor]
 * Body: { spec: { document | text }, focus?, observation? }
 *
 * Every card lands `candidate`. Sentences the owner already denied are never
 * re-proposed — the denied list goes into the prompt AND is filtered out of the
 * reply, so a model that ignores the instruction still cannot put a denied rule
 * back in front of them.
 */
export async function proposeCards(ctx: HostedDynamic) {
  requireAuth(ctx);
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "editor");
  requireProposerConfigured();

  const body = await readJsonBody(ctx.req);
  const spec = await resolveProposalSpec(body.spec);
  const focus = stringField(body, "focus", { max: 2000 });

  const existing = await listRuleCards(ctx.db, suite.id);
  const denied = await deniedRuleCards(ctx.db, suite.id);
  const approved = existing.filter((row: HostedDynamic) => row.state === "approved").map((row: HostedDynamic) => ({ id: row.rule_id, statement: row.statement }));

  const result = await proposeRuleCards(ctx, { spec, approved, denied, observation: body.observation ?? null, focus });

  const taken = new Set(existing.map((row: HostedDynamic) => row.rule_id));
  const inserted: HostedDynamic[] = [];
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    for (const card of result.cards) {
      const row = await insertRuleCard(tx, { projectId: suite.project_id, suiteId: suite.id, card, promptVersion: result.prompt_version, taken });
      inserted.push(row);
    }
    await audit(tx, {
      actor: actorOf(ctx.principal),
      action: "rule_card.proposed",
      entityType: "suite",
      entityId: suite.id,
      projectId: suite.project_id,
      detail: { count: inserted.length, prompt_version: result.prompt_version, rule_ids: inserted.map((row) => row.rule_id), warnings: result.warnings },
    });
    await emitPlatformEvent(tx, {
      projectId: suite.project_id,
      type: "rule_card.proposed",
      entity: { suite_id: suite.id },
      payload: { count: inserted.length, actor: actorOf(ctx.principal) },
    });
  });

  return {
    suite_id: suite.id,
    cards: inserted.map(cardView),
    notes: result.notes,
    warnings: result.warnings,
    prompt_version: result.prompt_version,
    usage: result.usage,
  };
}

/**
 * Add your own rule. A sentence a person wrote is a sentence a person
 * approved — it lands `approved` with their name on it, and there is no state
 * in which the platform holds a human's own rule for review.
 *
 * POST /suites/:s/rule-cards [reviewer]
 */
export async function addCard(ctx: HostedDynamic) {
  requireAuth(ctx);
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "reviewer");
  const body = await readJsonBody(ctx.req);
  const card: HostedDynamic = {
    id: stringField(body, "rule_id", { max: 120, pattern: /^[a-z0-9][a-z0-9_.-]*$/, patternHint: "must be a lowercase slug" }) || undefined,
    title: stringField(body, "title", { max: MAX_LINE }) || undefined,
    statement: stringField(body, "statement", { required: true, max: MAX_STATEMENT }),
    applicability: stringField(body, "applicability", { max: MAX_LINE }) || undefined,
    exceptions: stringField(body, "exceptions", { max: MAX_LINE }) || undefined,
    note: stringField(body, "note", { max: MAX_NOTE }) || undefined,
    state: "approved",
    origin: "authored",
  };

  const taken = new Set((await listRuleCards(ctx.db, suite.id)).map((row: HostedDynamic) => row.rule_id));
  let row: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    row = await insertRuleCard(tx, { projectId: suite.project_id, suiteId: suite.id, card, decidedBy: userIdOf(ctx.principal), taken });
    await record(tx, ctx, suite, row, "rule_card.added", {});
  });
  return created(cardView(row));
}

/**
 * Edit a card's sentence, applicability, exceptions, or note.
 *
 * PATCH /rule-cards/:rc [reviewer]
 *
 * Editing never changes the `rule_id`: it is the obligation slug an authored
 * check already cites, and a slug that moved would orphan the check silently.
 * Editing does not approve, either — an edited candidate is still a candidate
 * until a person approves it.
 */
export async function editCard(ctx: HostedDynamic) {
  const { suite, card } = await cardWithSuite(ctx, "reviewer");
  const body = await readJsonBody(ctx.req);
  const patch: HostedDynamic = {
    title: field(body, "title", card.title, MAX_LINE),
    statement: field(body, "statement", card.statement, MAX_STATEMENT),
    applicability: field(body, "applicability", card.applicability, MAX_LINE),
    exceptions: field(body, "exceptions", card.exceptions, MAX_LINE),
    note: field(body, "note", card.note, MAX_NOTE),
  };
  if (!patch.statement) throw badRequest('"statement" cannot be emptied — a rule card is a sentence');

  let row: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows, rowCount } = await tx.query(
      `UPDATE rule_cards SET title = $2, statement = $3, applicability = $4, exceptions = $5, note = $6, updated_at = now()
        WHERE id = $1 AND updated_at = $7 RETURNING *`,
      [card.id, patch.title, patch.statement, patch.applicability, patch.exceptions, patch.note, card.updated_at],
    );
    row = await won(tx, card.id, rows, rowCount);
    await record(tx, ctx, suite, row, "rule_card.edited", {
      statement_changed: patch.statement !== card.statement,
      note_changed: patch.note !== card.note,
    });
  });
  return cardView(row);
}

/** POST /rule-cards/:rc/approve [reviewer] — the only way a sentence is enforced. */
export const approveCard = (ctx: HostedDynamic) => decide(ctx, "approved", "rule_card.approved");

/**
 * POST /rule-cards/:rc/deny [reviewer] — and the row STAYS.
 * A denial is memory: the proposer is told not to raise this rule again, and
 * the filter that enforces that reads these rows.
 */
export const denyCard = (ctx: HostedDynamic) => decide(ctx, "denied", "rule_card.denied");

/**
 * DELETE /rule-cards/:rc [reviewer] — remove a card you wrote yourself.
 * A proposed card is denied, never deleted: deleting it would forget the
 * decision and the platform would propose it again.
 */
export async function removeCard(ctx: HostedDynamic) {
  const { suite, card } = await cardWithSuite(ctx, "reviewer");
  if (card.origin !== "authored") {
    throw conflict(
      `rule card "${card.rule_id}" was proposed by the platform — deny it instead of deleting it, ` +
        "so it is not proposed to you again",
    );
  }
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rowCount } = await tx.query(`DELETE FROM rule_cards WHERE id = $1`, [card.id]);
    if (!rowCount) throw notFound(`no rule card "${card.id}"`);
    await record(tx, ctx, suite, card, "rule_card.removed", {});
  });
  return { deleted: card.id, rule_id: card.rule_id };
}

// ---------------------------------------------------------------- internals

const userIdOf = (principal: HostedDynamic) => (principal?.kind === "user" ? principal.userId : null);

/** A patch field: absent leaves the current value, `null`/"" clears it. */
function field(body: HostedDynamic, name: HostedDynamic, current: HostedDynamic, max: HostedDynamic) {
  if (!Object.prototype.hasOwnProperty.call(body, name)) return current ?? null;
  if (body[name] === null || body[name] === "") return null;
  return stringField(body, name, { max });
}

async function cardWithSuite(ctx: HostedDynamic, role: HostedDynamic) {
  requireAuth(ctx);
  const { rows } = await ctx.db.query(`SELECT * FROM rule_cards WHERE id = $1`, [ctx.params.rc]);
  const card = rows[0];
  if (!card) throw notFound(`no rule card "${ctx.params.rc}"`);
  guard(ctx, card.project_id, role);
  const suite = await getSuite(ctx, card.suite_id);
  return { suite, card };
}

async function decide(ctx: HostedDynamic, state: HostedDynamic, action: HostedDynamic) {
  const { suite, card } = await cardWithSuite(ctx, "reviewer");
  const body = await readJsonBody(ctx.req).catch(() => ({}));
  const note = field(body ?? {}, "note", card.note, MAX_NOTE);
  let row: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows, rowCount } = await tx.query(
      `UPDATE rule_cards SET state = $2, note = $3, decided_by = $4, decided_at = $5, updated_at = now()
        WHERE id = $1 AND updated_at = $6 RETURNING *`,
      [card.id, state, note, userIdOf(ctx.principal), Date.now(), card.updated_at],
    );
    row = await won(tx, card.id, rows, rowCount);
    await record(tx, ctx, suite, row, action, { from: card.state, to: state });
  });
  return cardView(row);
}

/** Lost the optimistic race: say which, precisely, rather than a bare 409. */
async function won(tx: HostedDynamic, id: HostedDynamic, rows: HostedDynamic, rowCount: HostedDynamic) {
  if (rowCount > 0) return rows[0];
  const current = (await tx.query(`SELECT * FROM rule_cards WHERE id = $1`, [id])).rows[0];
  if (!current) throw notFound(`no rule card "${id}"`);
  throw conflict(`rule card "${current.rule_id}" changed while it was being updated — reload and try again`);
}

/** Audit and feed, inside the mutation's own transaction. */
async function record(tx: HostedDynamic, ctx: HostedDynamic, suite: HostedDynamic, row: HostedDynamic, action: HostedDynamic, detail: HostedDynamic) {
  await audit(tx, {
    actor: actorOf(ctx.principal),
    action,
    entityType: "rule_card",
    entityId: row.id,
    projectId: suite.project_id,
    detail: { suite_id: suite.id, rule_id: row.rule_id, ...detail },
  });
  await emitPlatformEvent(tx, {
    projectId: suite.project_id,
    type: action,
    entity: { suite_id: suite.id, rule_card_id: row.id },
    payload: { rule_id: row.rule_id, state: row.state, actor: actorOf(ctx.principal) },
  });
}
