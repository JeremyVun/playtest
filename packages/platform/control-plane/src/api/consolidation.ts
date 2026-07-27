// Reviewer-triggered consolidation of unreviewed findings.
//
// The surface is deliberately three-step, because the cost and the trust
// boundary are both real:
//
//   GET  /projects/:p/consolidation/preview   deterministic scope, no model call
//   POST /projects/:p/consolidation           run it: retrieval + one call per
//                                             cluster, persisted as a PROPOSAL
//   POST /consolidation-plans/:id/apply       the reviewer's decisions, applied
//                                             in one transaction
//
// Reading a plan is `viewer`; proposing, applying, and discarding are
// `reviewer` — the same authority that confirms or dismisses a finding.
// Nothing between the model and the database is automatic: a proposed plan
// changes no finding.
import { readJsonBody } from "../http.ts";
import { actorOf } from "../audit.ts";
import { badRequest, notFound } from "../errors.ts";
import { inClause } from "../db.ts";
import {
  applyConsolidationPlan,
  discardConsolidationPlan,
  planConsolidation,
  previewConsolidation,
} from "../findings/consolidation.ts";
import { publicFinding } from "../findings/extractor.ts";
import { requireAuth, guard, getProjectByKey, parsePagination } from "./util.ts";

const STATUSES = new Set(["proposed", "applied", "discarded"]);

/** GET /projects/:p/consolidation/preview [reviewer] — scope before any spend. */
export async function previewProjectConsolidation(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "reviewer");
  return await previewConsolidation(ctx, { project });
}

/**
 * POST /projects/:p/consolidation [reviewer] — build a plan.
 *
 * The model calls run OUTSIDE any transaction; the only write is the proposal
 * row and its audit entry.
 */
export async function createConsolidationPlan(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "reviewer");
  await readJsonBody(ctx.req);
  const row: HostedDynamic = await planConsolidation(ctx, { project, actor: actorOf(principal) });
  return await planDetail(ctx, row.id);
}

/** GET /projects/:p/consolidation-plans?status&cursor [viewer] */
export async function listConsolidationPlans(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { limit, cursor } = parsePagination(ctx.query);
  const params = [project.id];
  const where = [`project_id = $1`];
  const statusQ = ctx.query.get("status");
  if (statusQ && statusQ !== "all") {
    const statuses = statusQ.split(",").filter(Boolean);
    for (const s of statuses) if (!STATUSES.has(s)) throw badRequest(`invalid plan status "${s}"`);
    where.push(`status IN (${inClause(statuses, params.length + 1)})`);
    params.push(...statuses);
  }
  if (cursor) {
    params.push(cursor);
    where.push(`id < $${params.length}`);
  }
  params.push(limit);
  const { rows } = await ctx.db.query(
    `SELECT * FROM consolidation_plans
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return {
    items: rows.map(publicPlan),
    next_cursor: rows.length === limit ? rows.at(-1).id : null,
  };
}

/** GET /consolidation-plans/:id [viewer] — the review screen's whole payload. */
export async function getConsolidationPlan(ctx: HostedDynamic) {
  const row = await planRow(ctx, ctx.params.id);
  guard(ctx, row.project_id, "viewer");
  return await planDetail(ctx, row.id);
}

/** POST /consolidation-plans/:id/apply {decisions:[…]} [reviewer] */
export async function applyPlan(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const body = await readJsonBody(ctx.req);
  const row = await planRow(ctx, ctx.params.id);
  guard(ctx, row.project_id, "reviewer");
  if (body.decisions != null && !Array.isArray(body.decisions)) throw badRequest(`"decisions" must be an array`);
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await applyConsolidationPlan(tx, {
      planRow: row,
      decisions: body.decisions || [],
      actor: actorOf(principal),
    });
  });
  return await planDetail(ctx, row.id);
}

/** POST /consolidation-plans/:id/discard [reviewer] */
export async function discardPlan(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const row = await planRow(ctx, ctx.params.id);
  guard(ctx, row.project_id, "reviewer");
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await discardConsolidationPlan(tx, { planId: row.id, actor: actorOf(principal) });
  });
  return await planDetail(ctx, row.id);
}

// --- reads -------------------------------------------------------------------

async function planRow(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM consolidation_plans WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`no consolidation plan "${id}"`);
  return rows[0];
}

function publicPlan(p: HostedDynamic) {
  return {
    id: p.id,
    project_id: p.project_id,
    status: p.status,
    thresholds: p.thresholds,
    shortlist_version: p.shortlist_version,
    match_text_version: p.match_text_version,
    model: p.model,
    scope: p.scope,
    usage: p.usage,
    item_count: (p.plan?.items || []).length,
    unresolved_count: (p.plan?.unresolved || []).length,
    created_by: p.created_by,
    applied_by: p.applied_by,
    created_at: p.created_at,
    applied_at: p.applied_at,
  };
}

/**
 * A plan plus everything the reviewer needs to decide without leaving the page:
 * the existing target or the proposed new group, each member finding's claim,
 * and all of its evidence links.
 */
async function planDetail(ctx: HostedDynamic, id: HostedDynamic) {
  const p = await planRow(ctx, id);
  const projectKey = (await ctx.db.query(`SELECT key FROM projects WHERE id = $1`, [p.project_id])).rows[0]?.key;
  const plan = p.plan || { items: [], unresolved: [] };
  // A plan's "candidates" are its grouping subjects: unreviewed findings.
  const memberIds = [...new Set([
    ...(plan.items || []).flatMap((i: HostedDynamic) => i.candidate_ids || []),
    ...(plan.unresolved || []).map((u: HostedDynamic) => u.candidate_id),
  ])];
  const members = memberIds.length
    ? (await ctx.db.query(`SELECT * FROM findings WHERE id IN (${inClause(memberIds, 1)})`, memberIds)).rows
    : [];
  const evidence = memberIds.length
    ? (await ctx.db.query(
        `SELECT e.*, r.run_group_id, r.run_id AS core_run_id, r.status AS run_status, r.story_id
           FROM finding_evidence e
           JOIN runs r ON r.id = e.run_id
          WHERE e.finding_id IN (${inClause(memberIds, 1)})
          ORDER BY e.created_at, e.id`,
        memberIds,
      )).rows
    : [];
  const byFinding = new Map();
  for (const e of evidence) {
    if (!byFinding.has(e.finding_id)) byFinding.set(e.finding_id, []);
    byFinding.get(e.finding_id).push({
      id: e.id,
      run_db_id: e.run_id,
      core_run_id: e.core_run_id,
      case_id: e.case_id,
      story_id: e.story_id,
      step_from: e.step_from,
      excerpt: e.excerpt,
      viewer_url: `/p/${projectKey}/runs/${e.run_group_id}/${e.run_id}${e.step_from != null ? `?step=${e.step_from}` : ""}`,
    });
  }
  const memberById = new Map(members.map((f: HostedDynamic) => [f.id, {
    ...publicFinding(f),
    evidence: byFinding.get(f.id) || [],
  }]));

  const targetIds = [...new Set((plan.items || []).map((i: HostedDynamic) => i.finding_id).filter(Boolean))];
  const findings = targetIds.length
    ? (await ctx.db.query(
        `SELECT id, title, state, severity, merged_into FROM findings WHERE id IN (${inClause(targetIds, 1)})`,
        targetIds,
      )).rows
    : [];
  const findingById = new Map(findings.map((f: HostedDynamic) => [f.id, f]));

  return {
    ...publicPlan(p),
    project_key: projectKey ?? null,
    items: (plan.items || []).map((i: HostedDynamic) => ({
      ...i,
      finding: i.finding_id ? findingById.get(i.finding_id) ?? null : null,
      candidates: (i.candidate_ids || []).map((mid: HostedDynamic) => memberById.get(mid) ?? { id: mid, missing: true }),
    })),
    unresolved: (plan.unresolved || []).map((u: HostedDynamic) => ({
      ...u,
      candidate: memberById.get(u.candidate_id) ?? { id: u.candidate_id, missing: true },
    })),
  };
}
