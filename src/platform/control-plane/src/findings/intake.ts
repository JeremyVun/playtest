// The single findings intake path (docs/contracts/hosted.md).
//
// Every typed, cited claim that the application malfunctioned enters durable
// state here, whatever produced it: discovery study synthesis, per-run grade
// ingest, or explicit reviewer filing. Nothing in this module asks who its
// caller is — a new source supplies the same structured claim plus its cited
// evidence and gets the same identity and audit behavior.
//
// There is no candidate object: a machine-filed claim IS a finding, in state
// `new`. The human guarantee is a state guarantee — nothing reaches a confirmed
// state, an alarm surface, or an external tracker without a person acting.
//
// The rules it owns (docs/contracts/hosted.md, "Findings intake"):
//
//   * Exact keys are computed SERVER-SIDE from trusted context only (findings/
//     keys.ts). Model text and the model-chosen category never enter a key.
//   * An intake-key hit appends evidence to the finding that key already
//     produced, and does nothing else.
//   * A strict hit appends every new evidence row, idempotently, following merge
//     tombstones, whatever the finding's state: a `rejected` finding absorbs the
//     evidence silently and counts the recurrence (a standing rejection IS the
//     suppression mechanism), a `resolved` one reopens.
//   * A loose hit files a `new` finding carrying a pre-attached suggestion. It
//     NEVER auto-merges.
//   * A miss files a `new` finding and emits `finding.created`.
//
// Every function here runs inside an open `withTx` (BEGIN IMMEDIATE): the read
// that decides is protected by the write lock, and each mutating statement
// re-asserts its precondition.
import crypto from "node:crypto";
import { ulid } from "../ulid.ts";
import { audit } from "../audit.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { publicFinding, publicEvidence } from "./extractor.ts";
import { CATEGORIES, VERSIONS, deriveCandidateKeys } from "./keys.ts";

const SEVERITIES = new Set(["info", "minor", "major"]);
const MAX_EXCERPT = 1200;

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/**
 * Take one typed, cited claim into hosted state as a finding.
 *
 * @param {{query: Function}} tx open transaction
 * @param {object} args
 * @param {string} args.projectId
 * @param {"synthesis"|"reviewer"|"run_grade"} args.source
 * @param {object} args.actor audit actor ({user_id}|{token_id}|{system})
 * @param {object} args.claim `{ category, storyId, caseId, signalType, locus,
 *   title, expected, observed, severity, signals }` — `signalType`/`locus` come
 *   from recorded anomaly signals, never from model prose.
 * @param {Array<{run_id: string, case_id?: string, step?: number|null, excerpt?: string}>} args.evidence
 *   every cited run/step, not only the first.
 * @param {string|null} [args.intakeKey] idempotency key for retried reports.
 * @param {{actor: object, title?: string, severity?: string, summaryExtra?: object}|null} [args.confirm]
 *   reviewer filing: a person deliberately filing a bug IS its confirmation, so
 *   a newly created finding lands `accepted` with the reviewer stamped.
 * @returns {Promise<{finding: object, action: string, created: boolean,
 *   evidence_added: number}>} action ∈ idempotent | appended | absorbed |
 *   suggested | created
 */
export async function intakeFinding(tx: HostedDynamic, {
  projectId, source, actor, claim: input, evidence, intakeKey = null, confirm = null,
}: HostedDynamic) {
  const claim = validateClaim(input);
  const cited = await validateEvidence(tx, projectId, evidence);
  const keys = deriveCandidateKeys({
    projectId,
    storyId: input.storyId ?? null,
    signalType: input.signalType ?? null,
    locus: input.locus ?? null,
    category: input.category,
    claim,
  });

  // 1. Idempotent retry of the very same report.
  if (intakeKey) {
    const prior = (
      await tx.query(
        `SELECT finding_id FROM finding_intake_keys WHERE project_id = $1 AND intake_key = $2`,
        [projectId, intakeKey],
      )
    ).rows[0];
    const target = prior ? await liveFinding(tx, prior.finding_id) : null;
    if (target) {
      const added = await appendFindingEvidence(tx, { projectId, finding: target, cited, actor, source });
      return { finding: await findingById(tx, target.id), action: "idempotent", created: false, evidence_added: added };
    }
  }

  // 2. Strict hit — the same story hit the same defect surface again. No model
  //    call, no review: append every new evidence row, whatever the state.
  if (keys.strict_key) {
    const hit = await findingByKey(tx, projectId, "strict_key", keys.strict_key);
    if (hit) {
      const added = await appendFindingEvidence(tx, { projectId, finding: hit, cited, actor, source });
      const absorbed = hit.state === "rejected";
      if (absorbed) {
        // A standing rejection replaces the old suppression ledger: count the
        // recurrence instead of returning the claim to review.
        await tx.query(
          `UPDATE findings SET recurrence_count = recurrence_count + 1, updated_at = now() WHERE id = $1`,
          [hit.id],
        );
      }
      await registerIntakeKey(tx, { projectId, intakeKey, findingId: hit.id });
      return {
        finding: await findingById(tx, hit.id),
        action: absorbed ? "absorbed" : "appended",
        created: false,
        evidence_added: added,
      };
    }
  }

  // 3. Loose hit — the same defect surface from a different story. A
  //    pre-attached suggestion, never an auto-append.
  let suggested: HostedDynamic = null;
  if (keys.loose_key) {
    suggested = (await findingByKey(tx, projectId, "loose_key", keys.loose_key))?.id ?? null;
  }

  // 4. Miss (or suggestion): file the finding. `new` unless a person is filing
  //    it, in which case the filing is the confirmation.
  const created = await insertFinding(tx, {
    projectId, source, input, claim, keys, cited, suggested, confirm,
  });
  const added = await appendFindingEvidence(tx, {
    projectId, finding: created, cited, actor, source, emit: false,
  });
  await registerIntakeKey(tx, { projectId, intakeKey, findingId: created.id });
  const next = await findingById(tx, created.id);

  await audit(tx, {
    actor,
    action: "finding.created",
    entityType: "finding",
    entityId: next.id,
    projectId,
    detail: {
      source,
      category: input.category,
      signal_type: input.signalType ?? null,
      strict_key: keys.strict_key,
      loose_key: keys.loose_key,
      suggested_finding_id: suggested,
      state: next.state,
      evidence_added: added,
    },
  });
  await emitPlatformEvent(tx, {
    projectId,
    type: "finding.created",
    entity: { finding_id: next.id, run_id: cited[0]?.run_id ?? null },
    payload: { finding: publicFinding(next), suggested_finding_id: suggested, actor },
  });
  return {
    finding: next,
    action: suggested ? "suggested" : "created",
    created: true,
    evidence_added: added,
  };
}

/**
 * Append cited evidence to a finding, idempotently, preserving the lifecycle: a
 * resolved finding reopens on recurrence, a rejected one absorbs the evidence
 * silently (no feed event, no return to review).
 *
 * Exported because merges and consolidation land evidence through the same rule.
 */
export async function appendFindingEvidence(tx: HostedDynamic, { projectId, finding, findingId = null, cited, actor, source, emit = true }: HostedDynamic) {
  const target = finding ?? (await liveFinding(tx, findingId));
  if (!target) throw notFound(`no finding "${findingId}"`);
  const inserted: HostedDynamic[] = [];
  for (const e of cited) {
    const dup = (
      await tx.query(
        `SELECT id FROM finding_evidence
          WHERE finding_id = $1 AND run_id = $2 AND COALESCE(step_from, -1) = COALESCE($3, -1)`,
        [target.id, e.run_id, e.step_from],
      )
    ).rows[0];
    if (dup) continue;
    const row: HostedDynamic = {
      id: ulid(),
      finding_id: target.id,
      run_id: e.run_id,
      case_id: e.case_id,
      step_from: e.step_from,
      step_to: e.step_to,
      excerpt: e.excerpt,
    };
    await tx.query(
      `INSERT INTO finding_evidence (id, finding_id, run_id, case_id, step_from, step_to, excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.id, row.finding_id, row.run_id, row.case_id, row.step_from, row.step_to, row.excerpt],
    );
    inserted.push(row);
  }
  if (!inserted.length) return 0;

  // Recurrence destination is a confirmation question, not an authorship one:
  // a finding a person confirmed (accepted, or filed by a reviewer) returns to
  // `reopened` — the alarm state — while an unconfirmed one returns to `new`,
  // back to quiet triage. A machine claim cannot ring an alarm without a
  // person having acted (docs/contracts/hosted.md, "Findings"). Leaving
  // `resolved` clears the resolution provenance either way — those columns
  // describe the current resolution only; the audit log keeps history.
  const wasResolved = target.state === "resolved";
  const { rows } = await tx.query(
    `UPDATE findings
        SET evidence_count = evidence_count + $2,
            last_seen = now(),
            state = CASE WHEN state = 'resolved'
                         THEN CASE WHEN json_extract(summary, '$.confirmed_at') IS NOT NULL
                                   THEN 'reopened' ELSE 'new' END
                         ELSE state END,
            reject_reason = CASE WHEN state = 'resolved' THEN NULL ELSE reject_reason END,
            resolved_by_run_id = CASE WHEN state = 'resolved' THEN NULL ELSE resolved_by_run_id END,
            auto_resolved_at = CASE WHEN state = 'resolved' THEN NULL ELSE auto_resolved_at END,
            summary = CASE WHEN state = 'resolved' THEN json_remove(summary, '$.auto_resolve.reason') ELSE summary END,
            updated_at = now()
      WHERE id = $1 AND merged_into IS NULL
      RETURNING *`,
    [target.id, inserted.length],
  );
  if (!rows[0]) throw conflict(`finding "${target.id}" changed while evidence was being appended`);
  const next = rows[0];
  const reopen = wasResolved && next.state === "reopened";
  const recurred = wasResolved && next.state === "new";

  if (emit) {
    await audit(tx, {
      actor,
      action: reopen ? "finding.reopened" : recurred ? "finding.recurred" : "finding.evidence_added",
      entityType: "finding",
      entityId: target.id,
      projectId,
      detail: { source, evidence_added: inserted.length, suppressed: next.state === "rejected" },
    });
    // A rejected finding absorbs matching evidence silently.
    if (next.state !== "rejected") {
      await emitPlatformEvent(tx, {
        projectId,
        type: reopen ? "finding.reopened" : "finding.evidence_added",
        entity: { finding_id: target.id, run_id: inserted[0].run_id },
        payload: reopen
          ? { finding: publicFinding(next), evidence: publicEvidence(inserted[0]), actor }
          : { finding_id: target.id, evidence: publicEvidence(inserted[0]), external_ref: next.external_ref ?? null, actor },
      });
    }
  }
  return inserted.length;
}

// ---------------------------------------------------------------------------
// Key algorithm version bump (docs/contracts/hosted.md)
// ---------------------------------------------------------------------------

/**
 * Recompute stored keys, normalized locus, and match text for findings written
 * under an older algorithm version. Every input is recorded on the row itself,
 * so a version bump never leaves an older finding silently unmatchable.
 *
 * `fingerprint` is deliberately untouched: it is the finding's durable dedupe
 * identity (and the extractor's), not a recomputable lookup key.
 *
 * @returns {Promise<{scanned: number, updated: number}>}
 */
export async function recomputeFindingKeys(tx: HostedDynamic, { projectId = null } = {}) {
  const params = [VERSIONS.key_algo, VERSIONS.locus_norm, VERSIONS.match_text];
  let where = `key_algo_version IS NOT NULL
    AND (key_algo_version <> $1 OR locus_norm_version <> $2 OR COALESCE(match_text_version, '') <> $3)`;
  if (projectId) {
    params.push(projectId);
    where += ` AND project_id = $${params.length}`;
  }
  const { rows } = await tx.query(`SELECT * FROM findings WHERE ${where}`, params);
  let updated = 0;
  for (const f of rows) {
    const keys = deriveCandidateKeys({
      projectId: f.project_id,
      storyId: f.summary?.story_id ?? null,
      signalType: f.signal_type,
      locus: f.locus,
      category: f.category,
      claim: claimOf(f),
    });
    await tx.query(
      `UPDATE findings
          SET normalized_locus = $2, strict_key = $3, loose_key = $4,
              key_algo_version = $5, locus_norm_version = $6,
              match_text = $7, match_text_version = $8, updated_at = now()
        WHERE id = $1`,
      [
        f.id, keys.normalized_locus, keys.strict_key, keys.loose_key,
        keys.key_algo_version, keys.locus_norm_version, keys.match_text, keys.match_text_version,
      ],
    );
    updated += 1;
  }
  return { scanned: rows.length, updated };
}

// ---------------------------------------------------------------------------
// Reads / helpers shared with the findings API and consolidation
// ---------------------------------------------------------------------------

/** The structured claim a finding carries, in the shape keys.js consumes. */
export function claimOf(f: HostedDynamic) {
  const c = f?.summary?.claim || {};
  return {
    title: f?.title ?? null,
    expected: c.expected ?? null,
    observed: c.observed ?? null,
    severity: f?.severity ?? "minor",
    signals: Array.isArray(c.signals) ? c.signals : [],
  };
}

export async function findingById(q: HostedDynamic, id: HostedDynamic) {
  return (await q.query(`SELECT * FROM findings WHERE id = $1`, [id])).rows[0] || null;
}

/** Follow merge tombstones to the active head of a finding's merge chain. */
export async function liveFinding(tx: HostedDynamic, id: HostedDynamic) {
  const seen = new Set();
  let row = (await tx.query(`SELECT * FROM findings WHERE id = $1`, [id])).rows[0];
  while (row?.merged_into && !seen.has(row.id)) {
    seen.add(row.id);
    row = (await tx.query(`SELECT * FROM findings WHERE id = $1`, [row.merged_into])).rows[0];
  }
  return row || null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validateClaim(input: HostedDynamic) {
  if (!input || typeof input !== "object") throw badRequest(`a finding claim must be an object`);
  if (!CATEGORIES.includes(input.category)) {
    throw badRequest(`"category" must be one of ${CATEGORIES.join(", ")}`);
  }
  const title = String(input.title || "").trim();
  if (!title) throw badRequest(`a finding claim needs a "title"`);
  return {
    title: title.slice(0, 180),
    expected: String(input.expected || "").slice(0, MAX_EXCERPT) || null,
    observed: String(input.observed || "").slice(0, MAX_EXCERPT) || null,
    severity: SEVERITIES.has(input.severity) ? input.severity : "minor",
    signals: Array.isArray(input.signals) ? input.signals.map(String).slice(0, 20) : [],
  };
}

/**
 * Every cited run must exist and belong to this project. A claim that cites
 * another project's run is rejected outright — cross-project evidence is never
 * silently dropped or silently accepted.
 */
async function validateEvidence(tx: HostedDynamic, projectId: HostedDynamic, evidence: HostedDynamic) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) throw badRequest(`a finding must cite at least one run/step`);
  const out: HostedDynamic[] = [];
  const seen = new Set();
  for (const e of list) {
    const runId = e?.run_id;
    if (!runId || typeof runId !== "string") throw badRequest(`each evidence entry needs a "run_id"`);
    const { rows } = await tx.query(
      `SELECT r.id, r.case_id, g.project_id
         FROM runs r JOIN run_groups g ON g.id = r.run_group_id
        WHERE r.id = $1`,
      [runId],
    );
    const run = rows[0];
    if (!run) throw notFound(`no run "${runId}"`);
    if (run.project_id !== projectId) {
      throw badRequest(`run "${runId}" belongs to another project — a finding cannot cite it`);
    }
    const step = Number.isInteger(e.step) && e.step > 0 ? e.step : null;
    const key = `${runId}${step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      run_id: run.id,
      case_id: e.case_id || run.case_id,
      step_from: step,
      step_to: step,
      excerpt: e.excerpt ? String(e.excerpt).slice(0, MAX_EXCERPT) : null,
    });
  }
  return out;
}

async function insertFinding(tx: HostedDynamic, { projectId, source, input, claim, keys, cited, suggested, confirm }: HostedDynamic) {
  const id = ulid();
  // Identity is opaque. The fingerprint column is a lookup key: use the strict
  // key when there is one (so a later gate-failure or synthesis path converges),
  // else an opaque per-finding value.
  // A strict key already taken as another live finding's fingerprint — the
  // transient state a key-algorithm bump leaves behind until the startup
  // recompute runs — falls back to the opaque value rather than failing the
  // report on the partial unique index.
  const taken = keys.strict_key
    ? (await tx.query(
        `SELECT 1 AS hit FROM findings WHERE project_id = $1 AND fingerprint = $2 AND merged_into IS NULL`,
        [projectId, keys.strict_key],
      )).rows[0]
    : null;
  const fingerprint = keys.strict_key && !taken ? keys.strict_key : sha256(`${projectId}finding${id}`);
  const summary: HostedDynamic = {
    story_id: input.storyId ?? null,
    case_id: input.caseId ?? cited[0]?.case_id ?? null,
    claim: { expected: claim.expected, observed: claim.observed, signals: claim.signals },
    ...(confirm?.summaryExtra && typeof confirm.summaryExtra === "object" ? confirm.summaryExtra : {}),
  };
  if (confirm) {
    // Accepting stamps the confirming actor and time as durable provenance; a
    // reviewer filing a bug from a run does both in one action.
    summary.confirmed_at = new Date().toISOString();
    summary.confirmed_by = confirm.actor;
  }
  const { rows } = await tx.query(
    `INSERT INTO findings
       (id, project_id, fingerprint, title, summary, severity, state,
        first_seen, last_seen, evidence_count,
        category, source, signal_type, locus, normalized_locus, strict_key, loose_key,
        key_algo_version, locus_norm_version, match_text, match_text_version,
        suggested_finding_id, suggestion_kind, first_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now(), 0,
             $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      id, projectId, fingerprint, claim.title, summary, claim.severity,
      confirm ? "accepted" : "new",
      input.category, source, input.signalType ?? null, input.locus ?? null,
      keys.normalized_locus, keys.strict_key, keys.loose_key,
      keys.key_algo_version, keys.locus_norm_version, keys.match_text, keys.match_text_version,
      suggested, suggested ? "loose_key" : null, cited[0]?.run_id ?? null,
    ],
  );
  return rows[0];
}

/**
 * The best live finding carrying this exact key. A finding a person has already
 * touched wins over an unreviewed one; merge tombstones are followed, so a key
 * left on a merged-away row still resolves to the survivor.
 */
async function findingByKey(tx: HostedDynamic, projectId: HostedDynamic, column: HostedDynamic, key: HostedDynamic) {
  const { rows } = await tx.query(
    `SELECT id FROM findings WHERE project_id = $1 AND ${column} = $2 ORDER BY last_seen DESC, id DESC`,
    [projectId, key],
  );
  const seen = new Set();
  const live: HostedDynamic[] = [];
  for (const r of rows) {
    const head = await liveFinding(tx, r.id);
    if (!head || seen.has(head.id)) continue;
    seen.add(head.id);
    live.push(head);
  }
  live.sort((a, b) => rank(a) - rank(b) || stamp(b.last_seen) - stamp(a.last_seen) || (a.id < b.id ? 1 : -1));
  return live[0] || null;
}

const rank = (f: HostedDynamic) => (f.state === "new" ? 1 : 0);
const stamp = (v: HostedDynamic) => (v instanceof Date ? v.getTime() : Number(v) || 0);

/** A finding may absorb many intake keys; a key belongs to exactly one finding. */
async function registerIntakeKey(tx: HostedDynamic, { projectId, intakeKey, findingId }: HostedDynamic) {
  if (!intakeKey) return;
  await tx.query(
    `INSERT INTO finding_intake_keys (id, project_id, intake_key, finding_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (project_id, intake_key) DO UPDATE SET finding_id = excluded.finding_id`,
    [ulid(), projectId, intakeKey, findingId],
  );
}

function sha256(s: HostedDynamic) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
