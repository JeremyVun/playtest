import crypto from "node:crypto";
import { readJsonBody } from "../http.ts";
import { audit, actorOf } from "../audit.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { ulid } from "../ulid.ts";
import { publicFinding, publicEvidence } from "../findings/extractor.ts";
import { synthesizeStudyFindings, requireSynthesisConfigured } from "../findings/synthesis.ts";
import { intakeFinding } from "../findings/intake.ts";
import { scheduleAutoDedupe } from "../findings/auto-dedupe.ts";
import { mergeFindings } from "../findings/merge.ts";
import { CATEGORIES } from "../findings/keys.ts";
import { inClause } from "../db.ts";
import { requireAuth, guard, getProjectByKey, parsePagination, stringField } from "./util.ts";

const STATES = new Set(["new", "accepted", "rejected", "resolved", "reopened"]);
const SEVERITIES = new Set(["info", "minor", "major"]);
// `duplicate` joined the vocabulary with the candidate collapse: dismissing a
// needs-review finding as "same bug, already filed" is a rejection reason, not a
// separate lifecycle.
const REJECT_REASONS = new Set(["not_a_bug", "wont_fix", "duplicate"]);

// The latest finished verdict for each story — the reconciliation signal ("is
// this fixed, stale, still failing?") that decorates finding rows on list and
// detail. Null when the story has no finished pass/fail run.
//
// SQLite has no LATERAL, and the correlation key is itself a JSON extraction
// (`summary.story_id`), so the per-finding "newest run, LIMIT 1" becomes one
// windowed pass over the runs of every story, filtered to the top row and
// joined once. Both the list and the detail query use the same three parts.
const STORY_HEALTH_CTE = `
  WITH story_health_latest AS (
    SELECT project_id, story_id, run_db_id, run_group_id, status, finished_at
      FROM (
        SELECT rg.project_id, r.story_id, r.id AS run_db_id, r.run_group_id,
               r.status, r.finished_at,
               row_number() OVER (
                 PARTITION BY rg.project_id, r.story_id
                 ORDER BY COALESCE(r.finished_at, r.created_at) DESC, r.id DESC
               ) AS rn
          FROM runs r
          JOIN run_groups rg ON rg.id = r.run_group_id
         WHERE r.status IN ('pass','fail')
      )
     WHERE rn = 1
  )`;
const STORY_HEALTH_JOIN = `
  LEFT JOIN story_health_latest sh
         ON sh.project_id = f.project_id
        AND sh.story_id = json_extract(f.summary, '$.story_id')`;
const STORY_HEALTH_SELECT = `
  CASE WHEN sh.run_db_id IS NULL THEN NULL
       ELSE json_object('run_db_id', sh.run_db_id, 'run_group_id', sh.run_group_id,
                        'status', sh.status, 'finished_at', sh.finished_at)
  END AS story_health`;

/**
 * `story_health` is a computed column, so the adapter cannot decode it from a
 * declared column type: it arrives as JSON text with `finished_at` still epoch
 * milliseconds. Parse it and restore the `Date` the rest of the API expects
 * (the wire format stays an ISO-8601 `…Z` string).
 */
function decodeStoryHealth(raw: HostedDynamic) {
  if (raw == null) return null;
  const sh = typeof raw === "string" ? JSON.parse(raw) : raw;
  return { ...sh, finished_at: sh.finished_at == null ? null : new Date(sh.finished_at) };
}

/** GET /projects/:p/findings?state&severity&cursor [viewer] */
export async function listFindings(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { limit, cursor } = parsePagination(ctx.query);
  const params = [project.id];
  const where = [`f.project_id = $1`, `f.merged_into IS NULL`];

  const stateQ = ctx.query.get("state");
  if (stateQ && stateQ !== "all") {
    const states = stateQ.split(",").filter(Boolean);
    for (const s of states) if (!STATES.has(s)) throw badRequest(`invalid finding state "${s}"`);
    where.push(`f.state IN (${inClause(states, params.length + 1)})`);
    params.push(...states);
  } else if (!stateQ) {
    const states = ["new", "reopened", "accepted"];
    where.push(`f.state IN (${inClause(states, params.length + 1)})`);
    params.push(...states);
  }
  const severity = ctx.query.get("severity");
  if (severity) {
    if (!SEVERITIES.has(severity)) throw badRequest(`invalid finding severity "${severity}"`);
    params.push(severity);
    where.push(`f.severity = $${params.length}`);
  }
  // The review queue's second section: findings wearing a pending "looks
  // fixed" suggestion, awaiting a person's Resolve / Not fixed call.
  if (ctx.query.get("fix_suggested")) {
    where.push(`json_extract(f.summary, '$.auto_resolve.suggested') IS NOT NULL`);
  }
  // The run chip's query: findings this run's report auto-resolved.
  const resolvedByRun = ctx.query.get("resolved_by_run");
  if (resolvedByRun) {
    params.push(resolvedByRun);
    where.push(`f.resolved_by_run_id = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    where.push(`f.id < $${params.length}`);
  }
  params.push(limit);
  const { rows } = await ctx.db.query(
    `${STORY_HEALTH_CTE}
     SELECT f.*, sf.title AS suggested_finding_title, ${STORY_HEALTH_SELECT}
       FROM findings f
       LEFT JOIN findings sf ON sf.id = f.suggested_finding_id
       ${STORY_HEALTH_JOIN}
      WHERE ${where.join(" AND ")}
      ORDER BY f.last_seen DESC, f.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return {
    items: rows.map((r: HostedDynamic) => ({
      ...publicFinding(r),
      suggested_finding_title: r.suggested_finding_title ?? null,
      story_health: decodeStoryHealth(r.story_health),
    })),
    next_cursor: rows.length === limit ? rows.at(-1).id : null,
  };
}

/**
 * GET /projects/:p/findings/counts [viewer]
 * Per-state totals over live (unmerged) findings — the console folds these
 * into its bucket tallies, so a tab can say how much work sits behind it
 * without fetching (and capping at) a page of rows.
 */
export async function findingCounts(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT state, COUNT(*) AS n
       FROM findings
      WHERE project_id = $1 AND merged_into IS NULL
      GROUP BY state`,
    [project.id],
  );
  const counts = Object.fromEntries([...STATES].map((s) => [s, 0]));
  for (const r of rows) if (r.state in counts) counts[r.state] = Number(r.n);
  // Pending "looks fixed" suggestions are review work too: the console folds
  // this into its Needs review tally. Only reopened/accepted count — a `new`
  // finding already sits in the review bucket by state.
  const { rows: sugg } = await ctx.db.query(
    `SELECT COUNT(*) AS n
       FROM findings
      WHERE project_id = $1 AND merged_into IS NULL
        AND state IN ('reopened','accepted')
        AND json_extract(summary, '$.auto_resolve.suggested') IS NOT NULL`,
    [project.id],
  );
  return { counts, fix_suggested: Number(sugg[0].n) };
}

/** GET /findings/:f [viewer] */
export async function getFinding(ctx: HostedDynamic) {
  const detail = await getFindingWithEvidence(ctx, ctx.params.f);
  guard(ctx, detail.project_id, "viewer");
  return detail;
}

/** POST /findings/:f/accept {title?, severity?, note?} [reviewer] */
export async function acceptFinding(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const body = await readJsonBody(ctx.req);
  return await transitionFinding(ctx, ctx.params.f, async (tx: HostedDynamic, f: HostedDynamic) => {
    const title = stringField(body, "title", { max: 180 });
    const severity = severityField(body, "severity", f.severity);
    // Accepting is confirmation: stamp the confirming actor and time into the
    // finding's own summary so the provenance is durable and travels with the
    // finding (the audit log records it too). Preserve the ORIGINAL confirmer
    // if the finding was already confirmed once.
    const confirmedAt = new Date().toISOString();
    const confirmedBy = actorOf(principal);
    // `json_patch` is RFC-7386 merge-patch, so unlike jsonb's `||` a null value
    // would DELETE the key rather than set it. Neither of these can be null
    // today; assert it rather than silently drop provenance if that changes.
    assertMergeable({ confirmed_at: confirmedAt, confirmed_by: confirmedBy });
    const { rows } = await tx.query(
      `UPDATE findings
          SET title = COALESCE($2, title),
              severity = $3,
              state = 'accepted',
              reject_reason = NULL,
              summary = json_patch(summary, json_object(
                'confirmed_at', COALESCE(json_extract(summary, '$.confirmed_at'), $4),
                'confirmed_by', json(COALESCE(json_extract(summary, '$.confirmed_by'), $5)))),
              updated_at = now()
        WHERE id = $1 AND merged_into IS NULL
        RETURNING *`,
      [f.id, title, severity, confirmedAt, confirmedBy],
    );
    const next = await assertWon(tx, f.id, rows);
    await recordFindingTransition(tx, {
      projectId: f.project_id,
      principal,
      action: "finding.accepted",
      finding: next,
      detail: { from: f.state, to: "accepted", note: note(body), title_changed: title != null, severity },
    });
    return next;
  });
}

/** POST /findings/:f/reject {reason, note?} [reviewer] */
export async function rejectFinding(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const body = await readJsonBody(ctx.req);
  if (!REJECT_REASONS.has(body.reason)) throw badRequest(`"reason" must be not_a_bug, wont_fix, or duplicate`);
  return await transitionFinding(ctx, ctx.params.f, async (tx: HostedDynamic, f: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE findings
          SET state = 'rejected',
              reject_reason = $2,
              updated_at = now()
        WHERE id = $1 AND merged_into IS NULL
        RETURNING *`,
      [f.id, body.reason],
    );
    const next = await assertWon(tx, f.id, rows);
    await recordFindingTransition(tx, {
      projectId: f.project_id,
      principal,
      action: "finding.rejected",
      finding: next,
      detail: { from: f.state, to: "rejected", reason: body.reason, note: note(body) },
    });
    return next;
  });
}

/** POST /findings/:f/resolve [reviewer] */
export async function resolveFinding(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const body = await readJsonBody(ctx.req);
  return await transitionFinding(ctx, ctx.params.f, async (tx: HostedDynamic, f: HostedDynamic) => {
    // A person resolving is not an auto-resolution: clear any auto provenance
    // so the "auto" badge and run chip only ever describe the current close.
    const { rows } = await tx.query(
      `UPDATE findings
          SET state = 'resolved', resolved_by_run_id = NULL, auto_resolved_at = NULL,
              summary = json_remove(summary, '$.auto_resolve.reason'),
              updated_at = now()
        WHERE id = $1 AND merged_into IS NULL
        RETURNING *`,
      [f.id],
    );
    const next = await assertWon(tx, f.id, rows);
    await recordFindingTransition(tx, {
      projectId: f.project_id,
      principal,
      action: "finding.resolved",
      finding: next,
      detail: { from: f.state, to: "resolved", note: note(body) },
    });
    return next;
  });
}

/**
 * POST /findings/:f/acknowledge [reviewer] — agree with an auto-resolution.
 * Reopen is the only reversal verb; without an agreement verb the "auto" badge
 * would nag forever, and "auto-resolved, unacknowledged" could never be
 * counted. Stamps the acknowledging actor into the finding's summary (audit
 * carries it too); the badge quiets, and the unacknowledged set stays a
 * measurable agreement signal for promoting suggestions to auto-resolve.
 */
export async function acknowledgeFinding(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  return await transitionFinding(ctx, ctx.params.f, async (tx: HostedDynamic, f: HostedDynamic) => {
    if (f.state !== "resolved" || !f.auto_resolved_at) {
      throw conflict(`finding "${f.id}" is not auto-resolved — there is nothing to acknowledge`);
    }
    const at = new Date().toISOString();
    const by = actorOf(principal);
    assertMergeable({ at, by });
    const { rows } = await tx.query(
      `UPDATE findings
          SET summary = json_patch(summary, json_object('auto_resolve',
                json_object('acknowledged_at', $2, 'acknowledged_by', json($3)))),
              updated_at = now()
        WHERE id = $1 AND merged_into IS NULL AND state = 'resolved'
        RETURNING *`,
      [f.id, at, by],
    );
    const next = await assertWon(tx, f.id, rows);
    await audit(tx, {
      actor: by,
      action: "finding.acknowledged",
      entityType: "finding",
      entityId: f.id,
      projectId: f.project_id,
      detail: { resolved_by_run_id: f.resolved_by_run_id ?? null },
    });
    return next;
  });
}

/**
 * POST /findings/:f/not-fixed [reviewer] — disagree with a "looks fixed by
 * run …" suggestion. Removes the suggestion and remembers which run it named,
 * so the sweep never re-suggests the same run; a NEWER passing run may
 * suggest again. The disagreement is the calibration signal the promotion
 * gate needs, so it is audited.
 */
export async function suggestionNotFixed(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  return await transitionFinding(ctx, ctx.params.f, async (tx: HostedDynamic, f: HostedDynamic) => {
    const suggested = f.summary?.auto_resolve?.suggested;
    if (!suggested?.run_id) {
      throw conflict(`finding "${f.id}" carries no fix suggestion to dismiss`);
    }
    const at = new Date().toISOString();
    const by = actorOf(principal);
    assertMergeable({ at, by });
    const { rows } = await tx.query(
      `UPDATE findings
          SET summary = json_patch(json_remove(summary, '$.auto_resolve.suggested'),
                json_object('auto_resolve', json_object('dismissed',
                  json_object('run_id', $2, 'at', $3, 'by', json($4))))),
              updated_at = now()
        WHERE id = $1 AND merged_into IS NULL
        RETURNING *`,
      [f.id, suggested.run_id, at, by],
    );
    const next = await assertWon(tx, f.id, rows);
    await audit(tx, {
      actor: by,
      action: "finding.fix_dismissed",
      entityType: "finding",
      entityId: f.id,
      projectId: f.project_id,
      detail: { run_id: suggested.run_id },
    });
    return next;
  });
}

/** POST /findings/:f/reopen [reviewer] */
export async function reopenFinding(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const body = await readJsonBody(ctx.req);
  return await transitionFinding(ctx, ctx.params.f, async (tx: HostedDynamic, f: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE findings
          SET state = 'reopened',
              reject_reason = NULL,
              resolved_by_run_id = NULL,
              auto_resolved_at = NULL,
              summary = json_remove(summary, '$.auto_resolve.reason'),
              updated_at = now()
        WHERE id = $1 AND merged_into IS NULL
        RETURNING *`,
      [f.id],
    );
    const next = await assertWon(tx, f.id, rows);
    await recordFindingTransition(tx, {
      projectId: f.project_id,
      principal,
      action: "finding.reopened",
      finding: next,
      detail: { from: f.state, to: "reopened", note: note(body) },
    });
    return next;
  });
}

/** POST /findings/:f/merge {into} [reviewer] */
export async function mergeFinding(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const body = await readJsonBody(ctx.req);
  if (!body.into || typeof body.into !== "string") throw badRequest(`"into" is required`);
  const source = await findingRow(ctx, ctx.params.f);
  guard(ctx, source.project_id, "reviewer");
  if (source.id === body.into) throw badRequest(`a finding cannot be merged into itself`);

  let targetId = body.into;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    // One merge implementation serves the reviewer verb, suggestion
    // confirmation, and applied consolidation groups alike.
    const survivor = await mergeFindings(tx, {
      sourceId: source.id,
      targetId,
      actor: actorOf(principal),
    });
    targetId = survivor.id;
  });
  return await getFindingWithEvidence(ctx, targetId);
}

/** POST /finding-evidence/:e/split {title, severity?} [reviewer] */
export async function splitEvidence(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const body = await readJsonBody(ctx.req);
  const title = stringField(body, "title", { required: true, max: 180 });
  let newId: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    // No FOR UPDATE: the transaction's BEGIN IMMEDIATE already holds the write
    // lock (same reasoning as findingInTx), and SQLite refuses the clause.
    const { rows } = await tx.query(
      `SELECT e.*, f.project_id, f.id AS source_id, f.fingerprint AS source_fingerprint, f.severity AS source_severity, f.merged_into
         FROM finding_evidence e
         JOIN findings f ON f.id = e.finding_id
        WHERE e.id = $1`,
      [ctx.params.e],
    );
    const ev = rows[0];
    if (!ev) throw notFound(`no finding evidence "${ctx.params.e}"`);
    guard(ctx, ev.project_id, "reviewer");
    if (ev.merged_into) throw conflict(`finding "${ev.source_id}" has already been merged`);
    newId = ulid();
    const fingerprint = sha256(`${ev.source_fingerprint}\u001fsplit\u001f${ev.id}`);
    const severity = severityField(body, "severity", ev.source_severity);
    await tx.query(
      `INSERT INTO findings
         (id, project_id, fingerprint, title, summary, severity, state, first_seen, last_seen, evidence_count)
       VALUES ($1, $2, $3, $4, $5, $6, 'new', $7, $7, 1)`,
      [
        newId,
        ev.project_id,
        fingerprint,
        title,
        JSON.stringify({ split_from: ev.source_id, source_evidence_id: ev.id }),
        severity,
        ev.created_at,
      ],
    );
    await tx.query(`UPDATE finding_evidence SET finding_id = $2 WHERE id = $1`, [ev.id, newId]);
    await recalcFindingCounters(tx, ev.source_id);
    const newFinding = await findingInTx(tx, newId);
    await audit(tx, {
      actor: actorOf(principal),
      action: "finding.split",
      entityType: "finding",
      entityId: newId,
      projectId: ev.project_id,
      detail: { from: ev.source_id, evidence_id: ev.id },
    });
    await emitPlatformEvent(tx, {
      projectId: ev.project_id,
      type: "finding.created",
      entity: { finding_id: newId, split_from: ev.source_id },
      payload: { finding: publicFinding(newFinding), evidence: { id: ev.id, run_id: ev.run_id, case_id: ev.case_id } },
    });
  });
  return await getFindingWithEvidence(ctx, newId);
}

/**
 * POST /runs/:r/promote-finding {title, severity?, note?, category?} [reviewer]
 *
 * Reviewer filing goes through the ONE findings intake path and lands
 * **confirmed**: a person deliberately filing a bug is its confirmation, so the
 * finding is created `accepted` with the reviewer stamped. The run id is
 * provenance and evidence, never semantic identity: identity comes from the
 * deterministic keys (project ‖ story ‖ signal ‖ normalized locus), so two
 * reviewers filing the same defect surface from two runs converge on one
 * finding instead of creating two run-scoped fingerprints.
 */
export async function promoteRun(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const body = await readJsonBody(ctx.req);
  const title = stringField(body, "title", { required: true, max: 180 });
  const severity = severityField(body, "severity", "minor");
  const run = await runRow(ctx, ctx.params.r);
  guard(ctx, run.project_id, "reviewer");
  if (body.category != null && !CATEGORIES.includes(body.category)) {
    throw badRequest(`"category" must be one of ${CATEGORIES.join(", ")}`);
  }
  // The evidence must carry the claim on its own (round-3 audit: a promote
  // note like "manually promoted" left the finding card unable to defend
  // itself) — append the run's failing gate text to whatever the note says.
  const failedCheck = (run.gate?.checks || []).find((c: HostedDynamic) => c && c.pass === false) || null;
  const gateText = failedCheck ? [failedCheck.spec, failedCheck.detail].filter(Boolean).join(" — ") : "";
  const note = stringField(body, "note", { max: 1200 });
  const excerpt = [note, gateText].filter(Boolean).join(" — ").slice(0, 1200) || title;
  // Pin the evidence to the run's final observed state — the gate judges the
  // end state, and `executed_steps` stops at the last *action*, one short of the
  // screenshot that actually shows the failure (round-3 audit).
  const step = finalStateStep(run.totals);
  // A failing gate check is recorded, deterministic context, so it can ground
  // exact keys. A run with no failing check has no deterministic signal: the
  // finding carries no exact keys and simply stands on its own (D4).
  const signalType = failedCheck ? `gate_${failedCheck.kind || "check"}` : null;
  const locus = failedCheck
    ? { route: null, step_locus: [failedCheck.spec, failedCheck.detail].filter(Boolean).join(" "), status_class: null }
    : null;

  let findingId: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const intake = await intakeFinding(tx, {
      projectId: run.project_id,
      source: "reviewer",
      actor: actorOf(principal),
      claim: {
        category: body.category && CATEGORIES.includes(body.category) ? body.category : "expectation_violation",
        storyId: run.story_id ?? run.case_id ?? null,
        caseId: run.case_id,
        signalType,
        locus,
        title,
        expected: failedCheck?.spec ?? null,
        observed: gateText || note || title,
        severity,
        signals: failedCheck ? [signalType] : [],
      },
      evidence: [{ run_id: run.id, case_id: run.case_id, step, excerpt }],
      confirm: {
        actor: actorOf(principal),
        // Caller provenance (the filing run and its failing gate check).
        // Provenance only — never part of identity.
        summaryExtra: {
          promoted_from_run_id: run.id,
          note: note || undefined,
          gate: failedCheck
            ? { spec: failedCheck.spec ?? null, kind: failedCheck.kind ?? null, detail: failedCheck.detail ?? null }
            : null,
        },
      },
    });
    // An exact recurrence of an already-filed defect surface: the evidence is on
    // the existing finding, with no model call and no second finding.
    findingId = intake.finding.id;
  });
  return await getFindingWithEvidence(ctx, findingId);
}

/**
 * POST /run-groups/:g/synthesize-findings [editor] — synthesize a discovery run
 * group's graded runs into cited findings. Runs the grounded model call in
 * process and ingests every finding, with all its cited run/step evidence,
 * through the findings consolidation path. There is no Insight row or report
 * object: the discovery study's product problems become findings directly, in
 * the ordinary `new` state, awaiting the usual human confirmation.
 */
export async function synthesizeGroup(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const { rows } = await ctx.db.query(
    `SELECT g.*, p.key AS project_key FROM run_groups g JOIN projects p ON p.id = g.project_id WHERE g.id = $1`,
    [ctx.params.g],
  );
  const group = rows[0];
  if (!group) throw notFound(`no run group "${ctx.params.g}"`);
  guard(ctx, group.project_id, "editor");
  requireSynthesisConfigured();
  const explored = await ctx.db.query(
    `SELECT COUNT(*) AS n FROM runs WHERE run_group_id = $1 AND status = 'explored'`,
    [group.id],
  );
  if (!explored.rows[0].n) {
    throw badRequest(
      `run group "${group.id}" has no explored runs — study synthesis needs finished discovery runs ` +
        `(launch a discovery study first, or wait for this one to finish)`,
    );
  }
  const project: HostedDynamic = { id: group.project_id, key: group.project_key };
  const result = await synthesizeStudyFindings(ctx, { project, group, actor: actorOf(principal) });
  // Synthesis files `new` findings in bulk — the natural moment for the
  // debounced semantic dedupe sweep to follow it.
  scheduleAutoDedupe(ctx, group.project_id);
  return result;
}

export async function getFindingWithEvidence(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `${STORY_HEALTH_CTE}
     SELECT f.*, p.key AS project_key, sf.title AS suggested_finding_title, ${STORY_HEALTH_SELECT}
       FROM findings f
       JOIN projects p ON p.id = f.project_id
       LEFT JOIN findings sf ON sf.id = f.suggested_finding_id
       ${STORY_HEALTH_JOIN}
      WHERE f.id = $1`,
    [id],
  );
  const f = rows[0];
  if (!f) throw notFound(`no finding "${id}"`);
  const ev = await ctx.db.query(
    `SELECT e.*, r.run_group_id, r.run_id AS core_run_id, r.status AS run_status,
            r.finished_at, r.story_id
       FROM finding_evidence e
       JOIN runs r ON r.id = e.run_id
      WHERE e.finding_id = $1
      ORDER BY e.created_at DESC`,
    [f.id],
  );
  // The auto-resolve provenance line ("resolved by run →") and the "looks
  // fixed by run …" suggestion each need a linkable run, and the resolving run
  // is by design NOT one of the evidence rows.
  const resolvedByRun = await runSummaryFor(ctx, f.resolved_by_run_id);
  const suggestedFixRun = await runSummaryFor(ctx, f.summary?.auto_resolve?.suggested?.run_id);
  return {
    ...publicFinding(f),
    project_key: f.project_key,
    suggested_finding_title: f.suggested_finding_title ?? null,
    story_health: decodeStoryHealth(f.story_health),
    resolved_by_run: resolvedByRun,
    suggested_fix_run: suggestedFixRun,
    evidence: ev.rows.map((e: HostedDynamic) => ({
      ...publicEvidence(e),
      run_db_id: e.run_id,
      core_run_id: e.core_run_id,
      run_group_id: e.run_group_id,
      run_status: e.run_status,
      story_id: e.story_id,
      finished_at: e.finished_at,
      viewer_url: `/p/${f.project_key}/runs/${e.run_group_id}/${e.run_id}${e.step_from != null ? `?step=${e.step_from}` : ""}`,
    })),
  };
}

/** A linkable projection of one run, or null — never throws on a pruned row. */
async function runSummaryFor(ctx: HostedDynamic, runId: HostedDynamic) {
  if (!runId) return null;
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.run_group_id, r.case_id, r.status, r.finished_at
       FROM runs r WHERE r.id = $1`,
    [runId],
  );
  return rows[0] ?? null;
}

async function transitionFinding(ctx: HostedDynamic, id: HostedDynamic, mutator: HostedDynamic) {
  const current = await findingRow(ctx, id);
  guard(ctx, current.project_id, "reviewer");
  let next: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const f = await findingInTx(tx, id);
    if (!f) throw notFound(`no finding "${id}"`);
    assertNotMerged(f);
    next = await mutator(tx, f);
  });
  return await getFindingWithEvidence(ctx, next.id);
}

async function recordFindingTransition(tx: HostedDynamic, { projectId, principal, action, finding, detail }: HostedDynamic) {
  await audit(tx, {
    actor: actorOf(principal),
    action,
    entityType: "finding",
    entityId: finding.id,
    projectId,
    detail,
  });
  await emitPlatformEvent(tx, {
    projectId,
    type: action,
    entity: { finding_id: finding.id },
    payload: { finding: publicFinding(finding), actor: actorOf(principal) },
  });
}

async function recalcFindingCounters(tx: HostedDynamic, id: HostedDynamic) {
  // SQLite: no alias on an UPDATE target and no `::int` cast — the outer row
  // is addressed by table name inside the correlated subqueries.
  await tx.query(
    `UPDATE findings
        SET evidence_count = (SELECT COUNT(*) FROM finding_evidence WHERE finding_id = findings.id),
            last_seen = COALESCE((SELECT MAX(created_at) FROM finding_evidence WHERE finding_id = findings.id), last_seen),
            updated_at = now()
      WHERE id = $1`,
    [id],
  );
}

async function findingRow(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM findings WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`no finding "${id}"`);
  return rows[0];
}

/**
 * Read a finding inside the enclosing transaction. `BEGIN IMMEDIATE` already
 * holds the write lock, so this read cannot observe a concurrent writer's
 * uncommitted state — the `FOR UPDATE` this replaces has no analogue and needs
 * none. The decision this read feeds is re-asserted by `assertWon` on write.
 */
async function findingInTx(tx: HostedDynamic, id: HostedDynamic) {
  return (await tx.query(`SELECT * FROM findings WHERE id = $1`, [id])).rows[0] || null;
}

/**
 * The write half of every read-decide-write on a finding: each mutating
 * statement carries `merged_into IS NULL` (plus its own state guards) in its
 * WHERE clause, and zero affected rows means this caller lost the race. Re-read
 * to raise exactly the error the pre-read would have raised.
 */
async function assertWon(tx: HostedDynamic, id: HostedDynamic, rows: HostedDynamic, rowCount = rows.length) {
  if (rowCount > 0) return rows[0] ?? null;
  const current = (await tx.query(`SELECT * FROM findings WHERE id = $1`, [id])).rows[0];
  if (!current) throw notFound(`no finding "${id}"`);
  assertNotMerged(current);
  throw conflict(`finding "${id}" changed while it was being updated`);
}

/**
 * `json_patch` implements RFC-7386 merge-patch: a null value deletes the key
 * instead of setting it, which jsonb's `||` never did. Refuse to build a patch
 * that would silently drop a key.
 */
function assertMergeable(values: HostedDynamic) {
  for (const [k, v] of Object.entries(values)) {
    if (v == null) throw badRequest(`cannot record "${k}": a null value would delete it from the finding summary`);
  }
}

async function runRow(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT r.*, g.project_id
       FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound(`no run "${id}"`);
  return rows[0];
}

function finalStateStep(totals: HostedDynamic) {
  const n = totals?.steps ?? totals?.executed_steps;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function severityField(body: HostedDynamic, name: HostedDynamic, fallback: HostedDynamic) {
  if (body[name] == null || body[name] === "") return fallback;
  if (!SEVERITIES.has(body[name])) throw badRequest(`"${name}" must be info, minor, or major`);
  return body[name];
}

function note(body: HostedDynamic) {
  return typeof body.note === "string" ? body.note.slice(0, 2000) : null;
}

function assertNotMerged(f: HostedDynamic) {
  if (f.merged_into) throw conflict(`finding "${f.id}" was merged into "${f.merged_into}"`);
}

function sha256(s: HostedDynamic) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
