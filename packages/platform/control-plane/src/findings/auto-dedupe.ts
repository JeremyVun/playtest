// Automatic post-run consolidation of unreviewed findings ("auto-dedupe",
// docs/contracts/hosted.md, "Consolidation").
//
// The manual "Find duplicates" flow made semantic dedupe a chore a person had
// to remember; the economics say otherwise — a run costs dollars, a dedupe
// sweep costs cents. So when reports land, a debounced per-project sweep runs
// the SAME pipeline a reviewer would: deterministic lexical retrieval
// (shortlist.ts) finds the possible matches, and only the ambiguous middle
// reaches the model for verification. Nothing here is a second dedupe
// implementation.
//
// What changes is only the apply policy. The sweep is NOT a reviewer, so it
// takes the reversible subset and defers the rest:
//
//   * model-verified groups at HIGH confidence are applied — evidence moves
//     onto one finding through the ordinary merge helper (tombstones, audit,
//     rejected targets absorb, resolved targets stay reviewer business).
//     Routing an unreviewed machine-filed claim is reversible: evidence split
//     and reopen both exist, and no confirmed state is ever entered.
//   * MEDIUM-confidence matches and deterministic score-only matches become
//     pre-attached "possibly the same bug as" suggestions — a score alone
//     never merges, same rule as intake's loose-key hit.
//   * everything else stays a separate `new` finding for ordinary review,
//     labeled `unresolved` (not `rejected` — deferring to a person is not a
//     rejection signal for threshold tuning).
//
// Model calls run OUTSIDE any transaction (planConsolidation owns that); the
// apply is one short transaction. The debounce collapses a run group's many
// reports into one sweep; the per-project lease keeps sweeps single-flight.
// The sweep is best-effort: a crash before it fires only means the findings
// wait for the next report or a manual "Find duplicates".
import { AppError } from "../errors.ts";
import { audit } from "../audit.ts";
import { withLease } from "../leases.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { assistantConfigured } from "../authoring/assistant.ts";
import { applyConsolidationPlan, planConsolidation } from "./consolidation.ts";
import { liveFinding } from "./intake.ts";

export const AUTO_DEDUPE_ACTOR: HostedDynamic = { system: "auto_dedupe" };

// Debounce timers keyed by the shared Db instance, not by ctx: route handlers
// receive per-request ctx objects, and a timer parked on one of those would
// neither debounce across requests nor be visible to shutdown/tests. One Db,
// one timer map (and one app in tests never sees another app's timers).
const TIMERS_BY_DB = new WeakMap();

/** The pending sweep timers for this app — exported for shutdown and tests. */
export function autoDedupeTimers(ctx: HostedDynamic) {
  let m = TIMERS_BY_DB.get(ctx.db);
  if (!m) {
    m = new Map();
    TIMERS_BY_DB.set(ctx.db, m);
  }
  return m;
}

/**
 * Is the sweep on for this project? The project's tri-state pin wins
 * (`projects.auto_dedupe`), null inherits the deployment default, and neither
 * can conjure a gateway the deployment lacks.
 */
export function autoDedupeEnabledFor(ctx: HostedDynamic, project: HostedDynamic) {
  if (!assistantConfigured()) return false;
  return project?.auto_dedupe ?? ctx.config.autoDedupe.enabled;
}

/**
 * The apply policy over a proposed plan. Pure: same plan in, same split out.
 *
 * @param {{items?: Array<object>}} plan a consolidation plan's `plan` column
 * @returns {{decisions: Array<{item_id: string, action: "accept"}>,
 *   suggestions: Array<{candidate_id: string, finding_id: string,
 *   origin: string, confidence: string|null, score: number|null}>}}
 */
export function autoDecisions(plan: HostedDynamic) {
  const decisions: HostedDynamic[] = [];
  const suggestions: HostedDynamic[] = [];
  for (const item of plan?.items || []) {
    if (item.origin === "model_cluster" && item.confidence === "high") {
      decisions.push({ item_id: item.id, action: "accept" });
      continue;
    }
    // A weaker match toward an existing finding becomes a suggestion on each
    // member. A medium-confidence NEW group has no target to suggest: its
    // members simply stay separate findings.
    if (item.finding_id) {
      for (const candidateId of item.candidate_ids || []) {
        suggestions.push({
          candidate_id: candidateId,
          finding_id: item.finding_id,
          origin: item.origin,
          confidence: item.confidence ?? null,
          score: item.score ?? null,
        });
      }
    }
  }
  return { decisions, suggestions };
}

/**
 * One sweep: plan, auto-apply the high-confidence subset, attach suggestions.
 * Returns what happened; throws only on real failures (an unconfigured gateway
 * or an empty review queue is a documented skip, not an error).
 */
export async function runAutoDedupe(ctx: HostedDynamic, { project, callModel = null }: HostedDynamic) {
  const pending = (await ctx.db.query(
    `SELECT COUNT(*) AS n FROM findings
      WHERE project_id = $1 AND state = 'new' AND merged_into IS NULL`,
    [project.id],
  )).rows[0];
  if (!Number(pending.n)) return { skipped: "no_unreviewed_findings" };

  let planRow: HostedDynamic;
  try {
    planRow = await planConsolidation(ctx, { project, actor: AUTO_DEDUPE_ACTOR, callModel });
  } catch (err) {
    // A deployment without the gateway keeps deterministic intake dedupe and
    // the score-routed paths; the sweep just cannot verify clusters.
    if (err instanceof AppError && err.code === "not_configured") return { skipped: "not_configured" };
    throw err;
  }

  const { decisions, suggestions } = autoDecisions(planRow.plan);
  let applied: HostedDynamic[] = [];
  let attached = 0;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    ({ applied } = await applyConsolidationPlan(tx, {
      planRow,
      decisions,
      actor: AUTO_DEDUPE_ACTOR,
      undecidedDecision: "unresolved",
    }));
    for (const s of suggestions) {
      attached += await attachSuggestion(tx, { projectId: project.id, planId: planRow.id, suggestion: s });
    }
    await emitPlatformEvent(tx, {
      projectId: project.id,
      type: "consolidation.auto_applied",
      entity: { plan_id: planRow.id },
      payload: {
        plan_id: planRow.id,
        merged_groups: applied.length,
        suggestions_attached: attached,
        actor: AUTO_DEDUPE_ACTOR,
      },
    });
  });
  return { plan_id: planRow.id, applied: applied.length, suggestions_attached: attached };
}

/**
 * Debounced, lease-guarded sweep trigger. Call after any commit that may have
 * filed `new` findings; repeated calls while a run group reports collapse into
 * one sweep. Only the gateway gates scheduling — the per-project policy
 * (autoDedupeEnabledFor) is read fresh when the timer fires, so a project pin
 * flipped mid-debounce is honored and a pinned-on project sweeps even under a
 * deployment whose default is off. Fire-and-forget: a sweep failure is logged,
 * never surfaced to the report that scheduled it.
 */
export function scheduleAutoDedupe(ctx: HostedDynamic, projectId: HostedDynamic) {
  if (!assistantConfigured()) return false;
  const timers = autoDedupeTimers(ctx);
  clearTimeout(timers.get(projectId));
  const timer = setTimeout(() => {
    timers.delete(projectId);
    withLease(ctx.db, `auto-dedupe:${projectId}`, { log: ctx.log }, async () => {
      const project = (await ctx.db.query(`SELECT * FROM projects WHERE id = $1`, [projectId])).rows[0];
      if (project && autoDedupeEnabledFor(ctx, project)) await runAutoDedupe(ctx, { project });
    }).catch((err) => {
      ctx.log?.warn?.({ msg: "auto-dedupe sweep failed", projectId, err: String(err?.stack || err) });
    });
  }, ctx.config.autoDedupe.debounceMs);
  timer.unref?.();
  timers.set(projectId, timer);
  return true;
}

/**
 * Attach a "possibly the same bug as" suggestion to a still-unreviewed finding.
 * The target is resolved through merge tombstones (this sweep's own merges may
 * have just moved it); an existing suggestion is never overwritten, and
 * `suggestion_kind` stays NULL — provenance lives in the summary and the plan.
 */
async function attachSuggestion(tx: HostedDynamic, { projectId, planId, suggestion }: HostedDynamic) {
  const target = await liveFinding(tx, suggestion.finding_id);
  if (!target || target.id === suggestion.candidate_id) return 0;
  const provenance: HostedDynamic = {
    auto_dedupe: {
      plan_id: planId,
      origin: suggestion.origin,
      ...(suggestion.confidence ? { confidence: suggestion.confidence } : {}),
      ...(suggestion.score != null ? { score: suggestion.score } : {}),
    },
  };
  const { rowCount } = await tx.query(
    `UPDATE findings
        SET suggested_finding_id = $2, summary = json_patch(summary, $3), updated_at = now()
      WHERE id = $1 AND state = 'new' AND merged_into IS NULL AND suggested_finding_id IS NULL`,
    [suggestion.candidate_id, target.id, JSON.stringify(provenance)],
  );
  if (rowCount) {
    await audit(tx, {
      actor: AUTO_DEDUPE_ACTOR,
      action: "finding.suggested",
      entityType: "finding",
      entityId: suggestion.candidate_id,
      projectId,
      detail: { suggested_finding_id: target.id, ...provenance.auto_dedupe },
    });
  }
  return rowCount ? 1 : 0;
}
