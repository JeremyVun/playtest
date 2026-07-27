import crypto from "node:crypto";
import { ulid } from "../ulid.ts";
import { audit } from "../audit.ts";
import { conflict } from "../errors.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { deriveCandidateKeys } from "./keys.ts";

const MAX_EXCERPT = 1200;

/**
 * Deterministic Phase 6 extraction: only trusted gate failures become findings.
 * Infra/canceled/lost/explored reports do not spend triage attention.
 */
export async function extractFindingFromReport(tx: HostedDynamic, { projectId, group, run, status, manifest = null, body = {} }: HostedDynamic) {
  if (status !== "fail") return null;
  const seed = failureSeed({ projectId, run, manifest, body });
  const now = new Date();
  let finding = await resolveByFingerprint(tx, projectId, seed.fingerprint);
  const evidence: HostedDynamic = {
    id: ulid(),
    finding_id: null,
    run_id: run.id,
    case_id: run.case_id,
    step_from: seed.step_from,
    step_to: seed.step_to,
    excerpt: seed.excerpt,
  };

  if (!finding) {
    const id = ulid();
    const { rows } = await tx.query(
      `INSERT INTO findings
         (id, project_id, fingerprint, title, summary, severity, state,
          first_seen, last_seen, evidence_count,
          category, source, signal_type, locus, normalized_locus, strict_key, loose_key,
          key_algo_version, locus_norm_version, match_text, match_text_version, first_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'new', $7, $7, 1,
               $8, 'extractor', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        id, projectId, seed.fingerprint, seed.title, seed.summary, seed.severity, now,
        seed.category, seed.signal_type, seed.locus,
        seed.keys.normalized_locus, seed.keys.strict_key, seed.keys.loose_key,
        seed.keys.key_algo_version, seed.keys.locus_norm_version,
        seed.keys.match_text, seed.keys.match_text_version, run.id,
      ],
    );
    finding = rows[0];
    evidence.finding_id = finding.id;
    await insertEvidence(tx, evidence);
    await audit(tx, {
      actor: { system: "findings" },
      action: "finding.created",
      entityType: "finding",
      entityId: finding.id,
      projectId,
      detail: { run_id: run.id, case_id: run.case_id, run_group_id: group.id, fingerprint: seed.fingerprint },
    });
    await emitPlatformEvent(tx, {
      projectId,
      type: "finding.created",
      entity: { finding_id: finding.id, run_id: run.id, run_group_id: group.id },
      payload: { finding: publicFinding(finding), evidence: publicEvidence(evidence) },
    });
    return { finding, evidence, action: "created" };
  }

  evidence.finding_id = finding.id;
  await insertEvidence(tx, evidence);

  if (finding.state === "resolved") {
    // Recurrence destination by confirmation (docs/contracts/hosted.md,
    // "Findings"): confirmed findings reopen — the alarm state — while an
    // unconfirmed claim returns to `new`, back to quiet triage. Leaving
    // `resolved` clears the resolution provenance either way.
    const confirmed = Boolean(finding.summary?.confirmed_at);
    const destination = confirmed ? "reopened" : "new";
    const { rows } = await tx.query(
      `UPDATE findings
          SET state = $3,
              reject_reason = NULL,
              resolved_by_run_id = NULL,
              auto_resolved_at = NULL,
              last_seen = $2,
              evidence_count = evidence_count + 1,
              updated_at = now()
        WHERE id = $1 AND merged_into IS NULL AND state = 'resolved'
        RETURNING *`,
      [finding.id, now, destination],
    );
    finding = assertWon(rows, finding);
    await audit(tx, {
      actor: { system: "findings" },
      action: confirmed ? "finding.reopened" : "finding.recurred",
      entityType: "finding",
      entityId: finding.id,
      projectId,
      detail: { reason: "recurrence", run_id: run.id, case_id: run.case_id, evidence_id: evidence.id },
    });
    await emitPlatformEvent(tx, {
      projectId,
      type: confirmed ? "finding.reopened" : "finding.evidence_added",
      entity: { finding_id: finding.id, run_id: run.id, run_group_id: group.id },
      payload: confirmed
        ? { finding: publicFinding(finding), evidence: publicEvidence(evidence), actor: { system: "findings" } }
        : { finding_id: finding.id, evidence: publicEvidence(evidence), external_ref: finding.external_ref ?? null },
    });
    return { finding, evidence, action: confirmed ? "reopened" : "recurred" };
  }

  const { rows } = await tx.query(
    `UPDATE findings
        SET last_seen = $2,
            evidence_count = evidence_count + 1,
            updated_at = now()
      WHERE id = $1 AND merged_into IS NULL
      RETURNING *`,
    [finding.id, now],
  );
  finding = assertWon(rows, finding);
  await audit(tx, {
    actor: { system: "findings" },
    action: "finding.evidence_added",
    entityType: "finding",
    entityId: finding.id,
    projectId,
    detail: { run_id: run.id, case_id: run.case_id, evidence_id: evidence.id, suppressed: finding.state === "rejected" },
  });
  if (finding.state !== "rejected") {
    await emitPlatformEvent(tx, {
      projectId,
      type: "finding.evidence_added",
      entity: { finding_id: finding.id, run_id: run.id, run_group_id: group.id },
      payload: { finding_id: finding.id, evidence: publicEvidence(evidence), external_ref: finding.external_ref ?? null },
    });
  }
  return { finding, evidence, action: finding.state === "rejected" ? "suppressed" : "evidence_added" };
}

export function failureSeed({ projectId, run, manifest = null, body = {} }: HostedDynamic) {
  const check = failingCheck(manifest) || {};
  const failureKind = String(check.kind || manifest?.result?.end_reason || body.error || "gate_failed");
  const rawLocus = [
    check.spec,
    check.label,
    check.detail,
    manifest?.result?.error,
    body.error,
  ].filter(Boolean).join(" ");
  const locus = normalizeLocus(rawLocus || failureKind);
  const story = run.story_id || run.case_id || "unknown";
  const fingerprint = sha256([projectId, story, failureKind, locus].join("\u001f"));
  const step = lastStep(manifest);
  const title = clampTitle(check.label || check.spec || check.detail || body.error || `Failure in ${run.case_id}`);
  const excerpt = firstLine([check.detail, check.spec, body.error, manifest?.result?.error].filter(Boolean).join(" — "));
  const severity = check.severity === "soft" ? "minor" : "major";
  const claim: HostedDynamic = {
    title,
    expected: check.spec ?? null,
    observed: excerpt || title,
    severity,
    signals: [],
  };
  // The fingerprint scheme is unchanged (dedupe continuity across the collapse),
  // but a failing gate check is recorded, deterministic context, so the finding
  // also carries the exact keys grade-issue intake matches against. A failure
  // with no recorded check carries no signal type and therefore no keys.
  const category = "expectation_violation";
  const signalType = check.spec || check.kind ? `gate_${check.kind || "check"}` : null;
  const keyLocus = signalType
    ? { route: null, step_locus: [check.spec, check.detail].filter(Boolean).join(" "), status_class: null }
    : null;
  return {
    fingerprint,
    title,
    severity,
    step_from: step,
    step_to: step,
    excerpt: excerpt.slice(0, MAX_EXCERPT),
    category,
    signal_type: signalType,
    locus: keyLocus,
    keys: deriveCandidateKeys({
      projectId, storyId: story, signalType, locus: keyLocus, category, claim,
    }),
    summary: {
      story_id: story,
      case_id: run.case_id,
      failure_kind: failureKind,
      locus,
      claim: { expected: claim.expected, observed: claim.observed, signals: [] },
      gate: check.spec ? { spec: check.spec, kind: check.kind ?? null, detail: check.detail ?? null } : null,
    },
  };
}

export function normalizeLocus(value: HostedDynamic) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ][0-9:.+-z]+)?\b/gi, "<time>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

export function publicFinding(f: HostedDynamic) {
  return {
    id: f.id,
    project_id: f.project_id,
    fingerprint: f.fingerprint,
    title: f.title,
    summary: f.summary,
    severity: f.severity,
    state: f.state,
    reject_reason: f.reject_reason,
    external_ref: f.external_ref,
    merged_into: f.merged_into,
    first_seen: f.first_seen,
    last_seen: f.last_seen,
    evidence_count: f.evidence_count,
    // Intake identity. A needs-review row renders from these without a second
    // request: the claim it makes, what surface it came from, and whether a
    // same-surface finding is already on file.
    category: f.category ?? null,
    source: f.source ?? null,
    claim: {
      title: f.title,
      expected: f.summary?.claim?.expected ?? f.summary?.expected ?? null,
      observed: f.summary?.claim?.observed ?? f.summary?.observed ?? null,
      severity: f.severity,
      signals: f.summary?.claim?.signals ?? [],
    },
    signal_type: f.signal_type ?? null,
    normalized_locus: f.normalized_locus ?? null,
    strict_key: f.strict_key ?? null,
    loose_key: f.loose_key ?? null,
    key_algo_version: f.key_algo_version ?? null,
    locus_norm_version: f.locus_norm_version ?? null,
    match_text_version: f.match_text_version ?? null,
    suggested_finding_id: f.suggested_finding_id ?? null,
    suggestion_kind: f.suggestion_kind ?? null,
    recurrence_count: f.recurrence_count ?? 0,
    first_run_id: f.first_run_id ?? null,
    // Auto-resolution provenance: which run closed it and when the system did.
    // Null on findings a person resolved. The acknowledge / suggestion memos
    // ride inside `summary.auto_resolve`.
    resolved_by_run_id: f.resolved_by_run_id ?? null,
    auto_resolved_at: f.auto_resolved_at ?? null,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

export function publicEvidence(e: HostedDynamic) {
  return {
    id: e.id,
    finding_id: e.finding_id,
    run_id: e.run_id,
    case_id: e.case_id,
    step_from: e.step_from,
    step_to: e.step_to,
    excerpt: e.excerpt,
    created_at: e.created_at,
  };
}

/**
 * Follow the fingerprint to the active head of its merge chain. The reads need
 * no `FOR UPDATE`: extraction always runs inside `withTx` (`BEGIN IMMEDIATE`),
 * which holds the write lock from statement one, and every write below
 * re-asserts the state this read decided on.
 */
async function resolveByFingerprint(tx: HostedDynamic, projectId: HostedDynamic, fingerprint: HostedDynamic) {
  const seen = new Set();
  let row = (
    await tx.query(`SELECT * FROM findings WHERE project_id = $1 AND fingerprint = $2`, [projectId, fingerprint])
  ).rows[0];
  while (row?.merged_into && !seen.has(row.id)) {
    seen.add(row.id);
    row = (await tx.query(`SELECT * FROM findings WHERE id = $1`, [row.merged_into])).rows[0];
  }
  return row || null;
}

/**
 * The conditional UPDATEs above carry the precondition the read decided on
 * (`merged_into IS NULL`, plus `state = 'resolved'` for the reopen). Zero rows
 * back means the finding moved underneath this ingest; fail the report rather
 * than continue against a row that was never written.
 */
function assertWon(rows: HostedDynamic, previous: HostedDynamic) {
  if (rows[0]) return rows[0];
  throw conflict(`finding "${previous.id}" changed while evidence was being recorded — retry the report`);
}

async function insertEvidence(tx: HostedDynamic, e: HostedDynamic) {
  const { rows } = await tx.query(
    `INSERT INTO finding_evidence
       (id, finding_id, run_id, case_id, step_from, step_to, excerpt)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [e.id, e.finding_id, e.run_id, e.case_id, e.step_from, e.step_to, e.excerpt],
  );
  Object.assign(e, rows[0]);
}

function failingCheck(manifest: HostedDynamic) {
  const checks = manifest?.result?.gate?.checks || manifest?.gate?.checks || [];
  return checks.find((c: HostedDynamic) => c && c.pass === false) || null;
}

// The final observed state, not the last action: the gate judges the end
// state, and executed_steps stops one screenshot short of it (round-3 audit).
function lastStep(manifest: HostedDynamic) {
  const n = manifest?.totals?.steps ?? manifest?.totals?.executed_steps;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sha256(s: HostedDynamic) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function firstLine(s: HostedDynamic) {
  return String(s || "").split("\n").find((l) => l.trim())?.trim() || "";
}

function clampTitle(s: HostedDynamic) {
  const line = firstLine(s).replace(/\s+/g, " ").trim();
  return (line || "Run failure").slice(0, 180);
}
