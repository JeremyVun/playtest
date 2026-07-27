// Local findings intake and lifecycle — the core/CLI mirror of the hosted rules
// in `src/platform/control-plane/src/findings/intake.ts`. Same lifecycle, same evidence model, same fingerprint versions, same
// merge tombstones; a different physical database and a different scope id
// (docs/contracts/hosted.md). Nothing here imports the control plane.
//
// The rules (docs/contracts/hosted.md), unchanged from hosted:
//
//   * Exact keys are computed from trusted recorded context only. Model text and
//     the model-chosen category never enter a key.
//   * A strict hit appends every new evidence row, idempotently, following merge
//     tombstones: a rejected finding still absorbs evidence silently, a resolved
//     one reopens.
//   * A loose hit becomes a pre-attached suggestion. It NEVER auto-appends.
//   * A miss stays an unassigned candidate. No finding exists until the user
//     accepts one.
//   * Rejecting a candidate records its keys as suppression entries; an exact
//     recurrence is auto-dismissed and counted instead of re-entering the queue.
//
// Every mutation runs inside `ledger.tx` (BEGIN IMMEDIATE), so two Playtest
// processes writing the same ledger serialize rather than interleave.
import crypto from "node:crypto";
import { DummyConfigError } from "../config.ts";
import { ulid } from "../ulid.ts";
import { nowIso } from "./ledger.ts";
import { CATEGORIES, VERSIONS, deriveCandidateKeys } from "./keys.ts";
import type { Ledger, LedgerRow } from "./ledger.ts";

type DynamicValue = any; // TODO(ts): intake spans validated model claims, persisted SQLite rows, and legacy evidence records
const SEVERITIES = new Set(["info", "minor", "major"]);
const DISMISS_REASONS = new Set(["not_a_bug", "wont_fix", "duplicate"]);
const REJECT_REASONS = new Set(["not_a_bug", "wont_fix"]);
const MAX_EXCERPT = 1200;

const json = (v: unknown): string => JSON.stringify(v ?? null);
const parse = (v: DynamicValue, fallback: DynamicValue = null): DynamicValue => {
  try {
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/**
 * Take one typed, cited bug candidate into the local ledger.
 *
 * @param {object} ledger open ledger (see ./ledger.ts)
 * @param {object} args
 * @param {"run_grade"|"reviewer"|"import"} args.source
 * @param {object} args.candidate `{ category, claim{title,expected,observed,severity,signals},
 *   storyId, caseId, signalType, locus }` — signalType/locus come from recorded
 *   anomaly signals, never from model prose.
 * @param {Array<{run_id: string, run_dir?: string, case_id?: string, step?: number|null, excerpt?: string}>} args.evidence
 * @param {string|null} [args.intakeKey] idempotency key for a repeated scan.
 * @returns {{action: string, candidate: object, finding_id: string|null, evidence_added: number}}
 *   action ∈ appended | suggested | unassigned | auto_dismissed | idempotent
 */
export function intakeCandidate(ledger: Ledger, { source, candidate, evidence, intakeKey = null }: DynamicValue): DynamicValue {
  const claim = validateClaim(candidate);
  const cited = validateEvidence(evidence);
  const keys = deriveCandidateKeys({
    scopeId: ledger.workspaceId,
    storyId: candidate.storyId ?? null,
    signalType: candidate.signalType ?? null,
    locus: candidate.locus ?? null,
    category: candidate.category,
    claim,
  });

  return ledger.tx(() => {
    // 1. Idempotent repeat of the very same report (same run, same candidate).
    if (intakeKey) {
      const prior = ledger.get("SELECT * FROM bug_candidates WHERE intake_key = ?", [intakeKey]);
      if (prior) {
        const added = appendCandidateEvidence(ledger, prior, cited, source);
        const synced = added && prior.status === "assigned" && prior.finding_id
          ? appendFindingEvidence(ledger, { findingId: prior.finding_id, cited, source })
          : 0;
        return {
          action: "idempotent",
          candidate: candidateById(ledger, prior.id),
          finding_id: prior.finding_id ?? null,
          evidence_added: synced,
        };
      }
    }

    // 2. Exact recurrence of something the user already rejected: absorb, count,
    //    keep out of the queue.
    if (keys.strict_key) {
      const suppression = ledger.get(
        "SELECT * FROM bug_candidate_suppressions WHERE scope = 'strict' AND key = ?",
        [keys.strict_key],
      );
      if (suppression) {
        const existing = candidateByKey(ledger, "strict_key", keys.strict_key, "dismissed");
        const row = existing ?? insertCandidate(ledger, {
          source, candidate, claim, keys, cited, intakeKey,
          status: "dismissed",
          dismissReason: DISMISS_REASONS.has(suppression.reason) ? suppression.reason : null,
        });
        const added = appendCandidateEvidence(ledger, row, cited, source);
        ledger.run(
          "UPDATE bug_candidates SET recurrence_count = recurrence_count + 1, updated_at = ? WHERE id = ?",
          [nowIso(), row.id],
        );
        ledger.run(
          "UPDATE bug_candidate_suppressions SET absorbed_count = absorbed_count + 1, updated_at = ? WHERE id = ?",
          [nowIso(), suppression.id],
        );
        return {
          action: "auto_dismissed",
          candidate: candidateById(ledger, row.id),
          finding_id: null,
          evidence_added: added,
        };
      }
    }

    // 3. Strict hit — the same story hit the same defect surface again. No
    //    review, no model call: append every new evidence row.
    if (keys.strict_key) {
      const hit = candidateByKey(ledger, "strict_key", keys.strict_key);
      if (hit) {
        const added = appendCandidateEvidence(ledger, hit, cited, source);
        ledger.run("UPDATE bug_candidates SET updated_at = ? WHERE id = ?", [nowIso(), hit.id]);
        let findingId = hit.finding_id ?? null;
        let appended = 0;
        if (hit.status === "assigned" && findingId) {
          const finding = liveFinding(ledger, findingId);
          findingId = finding?.id ?? null;
          if (finding) appended = appendFindingEvidence(ledger, { findingId: finding.id, cited, source });
        }
        return {
          action: hit.status === "assigned" ? "appended" : "unassigned",
          // The caller's summary distinguishes "a new candidate" from "the same
          // defect surface again"; the action word stays hosted-compatible.
          matched: "strict",
          candidate: candidateById(ledger, hit.id),
          finding_id: findingId,
          evidence_added: appended || added,
        };
      }
    }

    // 4. Loose hit — the same defect surface from a different story. A
    //    pre-attached suggestion, never an auto-append.
    let suggested = null;
    if (keys.loose_key) {
      const neighbor = candidateByKey(ledger, "loose_key", keys.loose_key, "assigned");
      if (neighbor?.finding_id) suggested = liveFinding(ledger, neighbor.finding_id)?.id ?? null;
    }

    // 5. Miss (or suggestion): an unassigned candidate. No finding yet.
    const row = insertCandidate(ledger, {
      source, candidate, claim, keys, cited, intakeKey,
      status: "unassigned",
      suggestedFindingId: suggested,
      suggestionKind: suggested ? "loose_key" : null,
    });
    const added = appendCandidateEvidence(ledger, row, cited, source);
    return {
      action: suggested ? "suggested" : "unassigned",
      candidate: candidateById(ledger, row.id),
      finding_id: null,
      evidence_added: added,
    };
  });
}

// ---------------------------------------------------------------------------
// Decisions (always explicit and human-initiated)
// ---------------------------------------------------------------------------

/**
 * Promote a candidate into a finding, carrying ALL of its evidence. With
 * `findingId`, attaches to that finding (merge tombstones followed) instead of
 * creating one. A run id is provenance, never identity.
 */
export function promoteCandidate(ledger: Ledger, { candidateId, findingId = null, title = null, severity = null, state = "new", actor = "cli" }: DynamicValue): DynamicValue {
  return ledger.tx(() => promoteWithinTx(ledger, { candidateId, findingId, title, severity, state, actor }));
}

function promoteWithinTx(ledger: Ledger, { candidateId, findingId = null, title = null, severity = null, state = "new", actor = "cli" }: DynamicValue): DynamicValue {
  const c = candidateRow(ledger, candidateId);
  if (c.status === "assigned") {
    throw new DummyConfigError(`bug candidate ${c.id} is already part of finding ${c.finding_id}`);
  }
  const cited = ledger.all(
    "SELECT * FROM bug_candidate_evidence WHERE candidate_id = ? ORDER BY created_at, id",
    [c.id],
  );
  if (!cited.length) throw new DummyConfigError(`bug candidate ${c.id} has no evidence to promote`);

  let finding: DynamicValue;
  let created = false;
  if (findingId) {
    finding = liveFinding(ledger, findingId);
    if (!finding) throw new DummyConfigError(`no finding ${findingId} in this ledger`);
  } else {
    const claim = parse(c.claim, {});
    // Identity is opaque; the fingerprint is a lookup key only.
    const fingerprint = c.strict_key || sha256(`${c.workspace_id}bug_candidate${c.id}`);
    const id = ulid();
    const ts = nowIso();
    ledger.run(
      `INSERT INTO findings
         (id, workspace_id, fingerprint, title, summary, severity, state,
          first_seen, last_seen, evidence_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
      [
        id,
        c.workspace_id,
        fingerprint,
        clampTitle(title || claim.title || "Bug candidate"),
        json({
          candidate_id: c.id,
          source: c.source,
          category: c.category,
          story_id: c.story_id,
          case_id: c.case_id,
          route: parse(c.locus, {})?.route ?? null,
          expected: claim.expected ?? null,
          observed: claim.observed ?? null,
          signals: claim.signals ?? [],
          signal_type: c.signal_type,
          locus: c.normalized_locus,
          key_algo_version: c.key_algo_version,
        }),
        severity && SEVERITIES.has(severity) ? severity : claim.severity || "minor",
        state,
        ts, ts, ts, ts,
      ],
    );
    finding = ledger.get("SELECT * FROM findings WHERE id = ?", [id]);
    recordTransition(ledger, { findingId: id, from: null, to: state, reason: "promoted", actor });
    created = true;
  }

  const added = appendFindingEvidence(ledger, {
    findingId: finding.id,
    cited: cited.map((e) => ({
      run_id: e.run_id,
      run_dir: e.run_dir,
      case_id: e.case_id,
      step_from: e.step_from,
      step_to: e.step_to,
      excerpt: e.excerpt,
    })),
    source: c.source,
  });
  ledger.run(
    `UPDATE bug_candidates
        SET status = 'assigned', finding_id = ?, suggested_finding_id = NULL,
            suggestion_kind = NULL, updated_at = ?
      WHERE id = ? AND status <> 'assigned'`,
    [finding.id, nowIso(), c.id],
  );
  return {
    created,
    evidence_added: added,
    candidate: candidateById(ledger, c.id),
    finding: findingById(ledger, finding.id),
  };
}

/**
 * `playtest findings accept <id>`: an unassigned candidate becomes an accepted
 * finding carrying all its evidence; an existing finding moves to `accepted`.
 */
export function acceptItem(ledger: Ledger, { id, title = null, note = null, actor = "cli" }: DynamicValue): DynamicValue {
  return ledger.tx(() => {
    const finding = ledger.get("SELECT * FROM findings WHERE id = ?", [id]);
    if (finding) return { kind: "finding", ...transition(ledger, { finding, to: "accepted", note, actor }) };
    const promoted = promoteWithinTx(ledger, { candidateId: id, title, state: "accepted", actor });
    return { kind: "candidate", ...promoted };
  });
}

/**
 * `playtest findings reject <id>`: a candidate is dismissed and its keys are
 * suppressed (exact recurrences are absorbed); a finding moves to `rejected` and
 * keeps absorbing matching evidence silently.
 */
export function rejectItem(ledger: Ledger, { id, reason = "not_a_bug", note = null, actor = "cli" }: DynamicValue): DynamicValue {
  return ledger.tx(() => {
    const finding = ledger.get("SELECT * FROM findings WHERE id = ?", [id]);
    if (finding) {
      if (!REJECT_REASONS.has(reason)) {
        throw new DummyConfigError(`--reason for a finding must be not_a_bug or wont_fix (got ${reason})`);
      }
      return { kind: "finding", ...transition(ledger, { finding, to: "rejected", reason, note, actor }) };
    }
    const c = candidateRow(ledger, id);
    if (!DISMISS_REASONS.has(reason)) {
      throw new DummyConfigError(`--reason must be not_a_bug, wont_fix, or duplicate (got ${reason})`);
    }
    if (c.status === "assigned") {
      throw new DummyConfigError(
        `bug candidate ${c.id} is already part of finding ${c.finding_id} — reject the finding instead`,
      );
    }
    ledger.run(
      "UPDATE bug_candidates SET status = 'dismissed', dismiss_reason = ?, updated_at = ? WHERE id = ? AND status <> 'assigned'",
      [reason, nowIso(), c.id],
    );
    for (const [scope, key] of [["strict", c.strict_key], ["loose", c.loose_key]]) {
      if (!key) continue;
      const ts = nowIso();
      ledger.run(
        `INSERT INTO bug_candidate_suppressions (id, scope, key, key_algo_version, candidate_id, reason, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (scope, key)
         DO UPDATE SET candidate_id = excluded.candidate_id, reason = excluded.reason, updated_at = excluded.updated_at`,
        [ulid(), scope, key, c.key_algo_version, c.id, reason, ts, ts],
      );
    }
    return { kind: "candidate", candidate: candidateById(ledger, c.id), suppressed: [c.strict_key, c.loose_key].filter(Boolean).length };
  });
}

/** `playtest findings resolve <id>`: a finding is fixed. An exact recurrence reopens it. */
export function resolveItem(ledger: Ledger, { id, note = null, actor = "cli" }: DynamicValue): DynamicValue {
  return ledger.tx(() => {
    const finding = ledger.get("SELECT * FROM findings WHERE id = ?", [id]);
    if (!finding) {
      const c = ledger.get("SELECT id FROM bug_candidates WHERE id = ?", [id]);
      if (c) {
        throw new DummyConfigError(
          `${id} is an unassigned bug candidate, not a finding — accept it first (playtest findings accept ${id}), or reject it`,
        );
      }
      throw new DummyConfigError(`no finding or bug candidate ${id} in this ledger`);
    }
    return { kind: "finding", ...transition(ledger, { finding, to: "resolved", note, actor }) };
  });
}

/** Merge one finding into another, leaving a tombstone that lookups follow. */
export function mergeFindings(ledger: Ledger, { fromId, intoId, actor = "cli" }: DynamicValue): DynamicValue {
  return ledger.tx(() => mergeWithinTx(ledger, { fromId, intoId, actor }));
}

function mergeWithinTx(ledger: Ledger, { fromId, intoId, actor = "cli" }: DynamicValue): DynamicValue {
  const from = ledger.get("SELECT * FROM findings WHERE id = ?", [fromId]);
  if (!from) throw new DummyConfigError(`no finding ${fromId} in this ledger`);
  const into = liveFinding(ledger, intoId);
  if (!into) throw new DummyConfigError(`no finding ${intoId} in this ledger`);
  if (from.id === into.id) throw new DummyConfigError(`cannot merge finding ${fromId} into itself`);

  const cited = ledger.all("SELECT * FROM finding_evidence WHERE finding_id = ? ORDER BY created_at, id", [from.id]);
  appendFindingEvidence(ledger, {
    findingId: into.id,
    cited: cited.map((e) => ({
      run_id: e.run_id, run_dir: e.run_dir, case_id: e.case_id,
      step_from: e.step_from, step_to: e.step_to, excerpt: e.excerpt,
    })),
    source: "merge",
  });
  ledger.run("UPDATE findings SET merged_into = ?, updated_at = ? WHERE id = ?", [into.id, nowIso(), from.id]);
  ledger.run("UPDATE bug_candidates SET finding_id = ?, updated_at = ? WHERE finding_id = ?", [into.id, nowIso(), from.id]);
  ledger.run(
    "INSERT INTO finding_merges (id, from_finding_id, into_finding_id, actor, created_at) VALUES (?,?,?,?,?)",
    [ulid(), from.id, into.id, actor, nowIso()],
  );
  recordTransition(ledger, { findingId: from.id, from: from.state, to: from.state, reason: `merged_into:${into.id}`, actor });
  return { from: findingById(ledger, from.id), into: findingById(ledger, into.id) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listFindings(ledger: Ledger, { state = null, includeMerged = false }: DynamicValue = {}): DynamicValue[] {
  const where: string[] = [];
  const params: DynamicValue[] = [];
  if (!includeMerged) where.push("merged_into IS NULL");
  if (state) {
    where.push("state = ?");
    params.push(state);
  }
  const sql = `SELECT * FROM findings${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY last_seen DESC, id`;
  return ledger.all(sql, params).map((f) => publicFinding(f));
}

export function listCandidates(ledger: Ledger, { status = "unassigned" }: DynamicValue = {}): DynamicValue[] {
  const sql = status
    ? "SELECT * FROM bug_candidates WHERE status = ? ORDER BY created_at DESC, id"
    : "SELECT * FROM bug_candidates ORDER BY created_at DESC, id";
  return ledger.all(sql, status ? [status] : []).map((c) => publicCandidate(ledger, c));
}

/** One finding or candidate by opaque id, with its evidence and history. */
export function showItem(ledger: Ledger, id: string): DynamicValue {
  const f = ledger.get("SELECT * FROM findings WHERE id = ?", [id]);
  if (f) {
    return {
      kind: "finding",
      ...publicFinding(f),
      evidence: ledger
        .all("SELECT * FROM finding_evidence WHERE finding_id = ? ORDER BY created_at, id", [f.id])
        .map(publicEvidence),
      transitions: ledger.all(
        "SELECT from_state, to_state, reason, note, actor, created_at FROM finding_transitions WHERE finding_id = ? ORDER BY created_at, id",
        [f.id],
      ),
      candidates: ledger.all("SELECT id FROM bug_candidates WHERE finding_id = ? ORDER BY created_at", [f.id])
        .map((r) => r.id),
      merged_from: ledger.all("SELECT from_finding_id FROM finding_merges WHERE into_finding_id = ?", [f.id])
        .map((r) => r.from_finding_id),
    };
  }
  const c = ledger.get("SELECT * FROM bug_candidates WHERE id = ?", [id]);
  if (!c) throw new DummyConfigError(`no finding or bug candidate ${id} in this ledger`);
  return { kind: "candidate", ...publicCandidate(ledger, c, { withEvidence: true }) };
}

export function candidateById(ledger: Ledger, id: string): DynamicValue {
  const c = ledger.get("SELECT * FROM bug_candidates WHERE id = ?", [id]);
  return c ? publicCandidate(ledger, c) : null;
}

export function findingById(ledger: Ledger, id: string): DynamicValue {
  const f = ledger.get("SELECT * FROM findings WHERE id = ?", [id]);
  return f ? publicFinding(f) : null;
}

export function publicFinding(f: LedgerRow): DynamicValue {
  return {
    id: f.id,
    title: f.title,
    summary: parse(f.summary, {}),
    severity: f.severity,
    state: f.state,
    reject_reason: f.reject_reason ?? null,
    merged_into: f.merged_into ?? null,
    fingerprint: f.fingerprint ?? null,
    first_seen: f.first_seen,
    last_seen: f.last_seen,
    evidence_count: f.evidence_count,
  };
}

export function publicEvidence(e: LedgerRow): DynamicValue {
  return {
    run_id: e.run_id,
    run_dir: e.run_dir ?? null,
    case_id: e.case_id,
    step_from: e.step_from ?? null,
    step_to: e.step_to ?? null,
    excerpt: e.excerpt ?? null,
    source: e.source ?? null,
  };
}

export function publicCandidate(ledger: Ledger, c: LedgerRow, { withEvidence = false }: DynamicValue = {}): DynamicValue {
  const out: DynamicValue = {
    id: c.id,
    run_id: c.run_id ?? null,
    run_dir: c.run_dir ?? null,
    case_id: c.case_id ?? null,
    story_id: c.story_id ?? null,
    category: c.category,
    claim: parse(c.claim, {}),
    source: c.source,
    signal_type: c.signal_type ?? null,
    locus: parse(c.locus, null),
    normalized_locus: c.normalized_locus ?? null,
    strict_key: c.strict_key ?? null,
    loose_key: c.loose_key ?? null,
    key_algo_version: c.key_algo_version,
    locus_norm_version: c.locus_norm_version,
    match_text: c.match_text,
    match_text_version: c.match_text_version,
    status: c.status,
    finding_id: c.finding_id ?? null,
    suggested_finding_id: c.suggested_finding_id ?? null,
    suggestion_kind: c.suggestion_kind ?? null,
    dismiss_reason: c.dismiss_reason ?? null,
    recurrence_count: c.recurrence_count,
    evidence_count: ledger.get("SELECT COUNT(*) AS n FROM bug_candidate_evidence WHERE candidate_id = ?", [c.id]).n,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
  if (withEvidence) {
    out.evidence = ledger
      .all("SELECT * FROM bug_candidate_evidence WHERE candidate_id = ? ORDER BY created_at, id", [c.id])
      .map(publicEvidence);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function transition(ledger: Ledger, { finding, to, reason = null, note = null, actor = "cli" }: DynamicValue): DynamicValue {
  const live = liveFinding(ledger, finding.id);
  if (!live) throw new DummyConfigError(`no finding ${finding.id} in this ledger`);
  if (live.id !== finding.id) {
    throw new DummyConfigError(`finding ${finding.id} was merged into ${live.id} — triage ${live.id} instead`);
  }
  ledger.run(
    "UPDATE findings SET state = ?, reject_reason = ?, updated_at = ? WHERE id = ?",
    [to, to === "rejected" ? reason : null, nowIso(), live.id],
  );
  recordTransition(ledger, { findingId: live.id, from: live.state, to, reason, note, actor });
  return { finding: findingById(ledger, live.id), from_state: live.state };
}

function recordTransition(ledger: Ledger, { findingId, from, to, reason = null, note = null, actor = "cli" }: DynamicValue): void {
  ledger.run(
    "INSERT INTO finding_transitions (id, finding_id, from_state, to_state, reason, note, actor, created_at) VALUES (?,?,?,?,?,?,?,?)",
    [ulid(), findingId, from, to, reason, note, actor, nowIso()],
  );
}

function candidateRow(ledger: Ledger, id: string): LedgerRow {
  const c = ledger.get("SELECT * FROM bug_candidates WHERE id = ?", [id]);
  if (!c) throw new DummyConfigError(`no finding or bug candidate ${id} in this ledger`);
  return c;
}

function validateClaim(candidate: DynamicValue): DynamicValue {
  if (!candidate || typeof candidate !== "object") throw new DummyConfigError("a bug candidate must be an object");
  if (!CATEGORIES.includes(candidate.category)) {
    throw new DummyConfigError(`bug candidate "category" must be one of ${CATEGORIES.join(", ")}`);
  }
  const claim = candidate.claim || {};
  const title = String(claim.title || "").trim();
  if (!title) throw new DummyConfigError('a bug candidate needs a "title"');
  return {
    title: title.slice(0, 180),
    expected: String(claim.expected || "").slice(0, MAX_EXCERPT) || null,
    observed: String(claim.observed || "").slice(0, MAX_EXCERPT) || null,
    severity: SEVERITIES.has(claim.severity) ? claim.severity : "minor",
    signals: Array.isArray(claim.signals) ? claim.signals.map(String).slice(0, 20) : [],
  };
}

/** Evidence is references only: run id, run directory, case id, step numbers. */
function validateEvidence(evidence: DynamicValue): DynamicValue[] {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) throw new DummyConfigError("a bug candidate must cite at least one run/step");
  const out: DynamicValue[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!e?.run_id || typeof e.run_id !== "string") throw new DummyConfigError('each evidence entry needs a "run_id"');
    const step = Number.isInteger(e.step) && e.step > 0 ? e.step : null;
    const key = `${e.run_id}${step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      run_id: e.run_id,
      run_dir: e.run_dir ?? null,
      case_id: e.case_id || "unknown",
      step_from: step,
      step_to: step,
      excerpt: e.excerpt ? String(e.excerpt).slice(0, MAX_EXCERPT) : null,
    });
  }
  return out;
}

function insertCandidate(ledger: Ledger, {
  source, candidate, claim, keys, cited, intakeKey,
  status, suggestedFindingId = null, suggestionKind = null, dismissReason = null,
}: DynamicValue): LedgerRow {
  const id = ulid();
  const first = cited[0];
  const ts = nowIso();
  ledger.run(
    `INSERT INTO bug_candidates
       (id, workspace_id, run_id, run_dir, case_id, story_id, category, claim, source,
        signal_type, locus, normalized_locus, strict_key, loose_key,
        key_algo_version, locus_norm_version, match_text, match_text_version,
        status, suggested_finding_id, suggestion_kind, dismiss_reason, intake_key,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, ledger.workspaceId, first?.run_id ?? null, first?.run_dir ?? null,
      candidate.caseId ?? first?.case_id ?? null, candidate.storyId ?? null,
      candidate.category, json(claim), source,
      candidate.signalType ?? null, candidate.locus ? json(candidate.locus) : null,
      keys.normalized_locus, keys.strict_key, keys.loose_key,
      keys.key_algo_version, keys.locus_norm_version, keys.match_text, keys.match_text_version,
      status, suggestedFindingId, suggestionKind, dismissReason, intakeKey,
      ts, ts,
    ],
  );
  return ledger.get("SELECT * FROM bug_candidates WHERE id = ?", [id]);
}

/** Append-only, idempotent on (candidate, run, step, source). Returns rows added. */
function appendCandidateEvidence(ledger: Ledger, candidateRowValue: LedgerRow, cited: DynamicValue[], source: string): number {
  let added = 0;
  for (const e of cited) {
    const dup = ledger.get(
      `SELECT id FROM bug_candidate_evidence
        WHERE candidate_id = ? AND run_id = ? AND COALESCE(step_from, -1) = COALESCE(?, -1) AND source = ?`,
      [candidateRowValue.id, e.run_id, e.step_from, source],
    );
    if (dup) continue;
    ledger.run(
      `INSERT INTO bug_candidate_evidence
         (id, candidate_id, run_id, run_dir, case_id, step_from, step_to, excerpt, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ulid(), candidateRowValue.id, e.run_id, e.run_dir ?? null, e.case_id, e.step_from, e.step_to, e.excerpt, source, nowIso()],
    );
    added += 1;
  }
  return added;
}

/**
 * Append cited evidence to a finding, idempotently, preserving the lifecycle: a
 * resolved finding reopens on recurrence, a rejected one absorbs the evidence
 * silently and stays out of the active queue.
 */
function appendFindingEvidence(ledger: Ledger, { findingId, cited, source }: DynamicValue): number {
  const finding = liveFinding(ledger, findingId);
  if (!finding) throw new DummyConfigError(`no finding ${findingId} in this ledger`);
  let inserted = 0;
  for (const e of cited) {
    const dup = ledger.get(
      "SELECT id FROM finding_evidence WHERE finding_id = ? AND run_id = ? AND COALESCE(step_from, -1) = COALESCE(?, -1)",
      [finding.id, e.run_id, e.step_from],
    );
    if (dup) continue;
    ledger.run(
      `INSERT INTO finding_evidence
         (id, finding_id, run_id, run_dir, case_id, step_from, step_to, excerpt, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ulid(), finding.id, e.run_id, e.run_dir ?? null, e.case_id, e.step_from, e.step_to, e.excerpt, source, nowIso()],
    );
    inserted += 1;
  }
  if (!inserted) return 0;
  const reopen = finding.state === "resolved";
  ledger.run(
    `UPDATE findings
        SET evidence_count = evidence_count + ?,
            last_seen = ?,
            state = CASE WHEN state = 'resolved' THEN 'reopened' ELSE state END,
            reject_reason = CASE WHEN state = 'resolved' THEN NULL ELSE reject_reason END,
            updated_at = ?
      WHERE id = ? AND merged_into IS NULL`,
    [inserted, nowIso(), nowIso(), finding.id],
  );
  if (reopen) {
    recordTransition(ledger, {
      findingId: finding.id, from: "resolved", to: "reopened", reason: "recurrence", actor: "intake",
    });
  }
  return inserted;
}

/** The newest candidate carrying this exact key; an assigned one wins. */
function candidateByKey(ledger: Ledger, column: string, key: string, status: string | null = null): LedgerRow | null {
  const params: DynamicValue[] = [key];
  let sql = `SELECT * FROM bug_candidates WHERE ${column} = ?`;
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  } else {
    sql += " AND status <> 'dismissed'";
  }
  sql += " ORDER BY CASE status WHEN 'assigned' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1";
  return ledger.get(sql, params);
}

/** Follow merge tombstones to the active head of a finding's merge chain. */
export function liveFinding(ledger: Ledger, id: string): LedgerRow | null {
  const seen = new Set<string>();
  let row = ledger.get("SELECT * FROM findings WHERE id = ?", [id]);
  while (row?.merged_into && !seen.has(row.id)) {
    seen.add(row.id);
    row = ledger.get("SELECT * FROM findings WHERE id = ?", [row.merged_into]);
  }
  return row ?? null;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function clampTitle(s: unknown): string {
  const line = String(s || "").split("\n").find((l) => l.trim())?.trim() || "";
  return (line.replace(/\s+/g, " ").trim() || "Bug candidate").slice(0, 180);
}

export { promoteWithinTx, mergeWithinTx };
