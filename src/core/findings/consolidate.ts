// Local consolidation: read bug candidates out of local
// run artifacts, take them into the ledger through the deterministic exact-key
// path, then propose — never apply — the semantic groupings.
//
// Two layers, deliberately separated:
//
//   1. INTAKE is deterministic and self-applying. Exact keys (D4) are computed
//      from recorded context only, so a recurrence of the same defect surface in
//      the same story appends evidence to the finding that already exists. This
//      is what makes two offline runs, in two processes, converge on ONE local
//      finding without any review step.
//   2. GROUPING is a PROPOSAL. Score routing (D5) and, when a model is
//      configured, one forced-tool call per cluster produce a plan file. The
//      plan mutates nothing. A human applies it with an explicit
//      `--apply-plan <file>`, which re-validates every id against the live
//      ledger. No model output ever reaches the ledger unconfirmed.
//
// Local intake source: `grade.json` `bug_candidates` recorded by discovery runs
// (P1). Locally the runs ARE the evidence source, so there is no hosted-style
// per-run conditional here.
import fs from "node:fs";
import path from "node:path";
import { DummyConfigError } from "../config.ts";
import { extractAnomalies } from "../anomalies.ts";
import { findManifests, readJsonFile } from "../run-history.ts";
import { readTrajectory } from "../trajectory.ts";
import { coarseSignalType, VERSIONS } from "./keys.ts";
import {
  DEFAULT_RETRIEVAL,
  SHORTLIST_VERSION,
  capClusters,
  clusters as connectedComponents,
  estimateTokens,
  findingMatchText,
  idfTable,
  retrievalItem,
  route,
  shortlist,
} from "./shortlist.ts";
import { intakeCandidate, liveFinding, promoteWithinTx, publicCandidate } from "./intake.ts";
import { nowIso } from "./ledger.ts";
import {
  CONSOLIDATION_SYSTEM,
  CONSOLIDATION_TOOL,
} from "./consolidation-prompt.ts";
import type { Ledger } from "./ledger.ts";

type DynamicValue = any; // SAFETY: consolidation joins legacy run artifacts, SQLite rows, and validated model plan payloads
export const PLAN_FORMAT = "playtest.findings.plan";
export const PLAN_FORMAT_VERSION = 1;
export {
  CONSOLIDATION_SYSTEM,
  CONSOLIDATION_TOOL,
} from "./consolidation-prompt.ts";

const CONFIDENCES = new Set(["high", "medium"]);

// ---------------------------------------------------------------------------
// 1. Intake from local run artifacts
// ---------------------------------------------------------------------------

/**
 * Every bug candidate recorded in the run artifacts under `runsRoot`, with the
 * deterministic identity (signal type + locus) derived from that run's recorded
 * envelopes — never from the model's prose.
 *
 * @returns {Array<{intakeKey: string, candidate: object, evidence: object[], run_id: string, run_dir: string}>}
 */
export function scanRunCandidates(runsRoot: string): DynamicValue[] {
  const root = path.resolve(runsRoot);
  if (!fs.existsSync(root)) {
    throw new DummyConfigError(
      `no runs directory at ${root}. Run a discovery study first, or name the runs root:\n` +
        "  playtest findings consolidate --runs-root runs/",
    );
  }
  const out: DynamicValue[] = [];
  for (const dir of findManifests(root)) {
    const manifest: DynamicValue = readJsonFile(path.join(dir, "manifest.json"));
    const grade: DynamicValue = readJsonFile(path.join(dir, "grade.json"));
    const candidates = Array.isArray(grade?.bug_candidates) ? grade.bug_candidates : [];
    if (!candidates.length) continue;
    const runId = manifest?.run_id ?? path.basename(dir);
    const caseId = manifest?.case?.id ?? "unknown";
    const envelopes = safeTrajectory(path.join(dir, "trajectory.jsonl"));
    const signals = extractAnomalies(envelopes, { perf: manifest?.case?.perf ?? null });
    candidates.forEach((raw: DynamicValue, index: number) => {
      const identity = identityFor(raw, envelopes, signals);
      const steps = (Array.isArray(raw.evidence_steps) ? raw.evidence_steps : []).filter(Number.isInteger);
      out.push({
        // Stable across re-scans of the same run: a repeated consolidate adds
        // nothing (intake's idempotent path).
        intakeKey: `run_grade:${runId}:${caseId}:${index}`,
        run_id: runId,
        run_dir: dir,
        candidate: {
          category: raw.kind,
          caseId,
          // Locally the case IS the story: one case file, one story.
          storyId: caseId,
          signalType: identity.signalType,
          locus: identity.locus,
          claim: {
            title: raw.title,
            expected: raw.expected,
            observed: raw.observed,
            severity: raw.severity,
            signals: Array.isArray(raw.signals) ? raw.signals : [],
          },
        },
        evidence: (steps.length ? steps : [null]).map((step: DynamicValue) => ({
          run_id: runId,
          run_dir: dir,
          case_id: caseId,
          step,
          excerpt: signals.find((s) => s.step === step)?.detail ?? null,
        })),
      });
    });
  }
  return out;
}

/**
 * The deterministic identity for one recorded grade candidate.
 *
 * A candidate is grounded when a recorded anomaly signal sits on one of its
 * cited steps (and, when it named signal types, matches one of them). The locus
 * uses recorded fields only:
 *
 *   - a signal that carries a route (an HTTP error) keys on route + status class,
 *     so the same endpoint failing in a later run matches regardless of selector
 *     churn;
 *   - a signal without a route (console exception, no-effect, failed action)
 *     keys on the step's page route plus its recorded step locus.
 */
export function identityFor(rawCandidate: DynamicValue, envelopes: DynamicValue[], signals: DynamicValue[]): DynamicValue {
  const steps = new Set((rawCandidate?.evidence_steps ?? []).filter(Number.isInteger));
  const named = new Set((rawCandidate?.signals ?? []).map(String));
  const hit = signals.find((s) => steps.has(s.step) && (!named.size || named.has(s.type)))
    ?? signals.find((s) => steps.has(s.step));
  if (!hit) return { signalType: null, locus: null };
  const env = (envelopes ?? []).find((e) => e?.step === hit.step) ?? null;
  const locus = hit.locus?.route
    ? { route: hit.locus.route, status_class: hit.locus.status_class ?? null }
    : { route: routeOf(env?.result?.url), step_locus: stepLocus(env) };
  return { signalType: coarseSignalType(hit.type), locus };
}

/** Take every scanned run candidate into the ledger. Deterministic; no model. */
export function intakeRunCandidates(ledger: Ledger, runsRoot: string): DynamicValue {
  const scanned = scanRunCandidates(runsRoot);
  // `deduped` is the exact-key story: a recurrence of a defect surface already
  // in the ledger appended its evidence instead of creating a second record.
  const actions: DynamicValue = { unassigned: 0, deduped: 0, appended: 0, suggested: 0, auto_dismissed: 0, idempotent: 0 };
  for (const item of scanned) {
    const result = intakeCandidate(ledger, {
      source: "run_grade",
      candidate: item.candidate,
      evidence: item.evidence,
      intakeKey: item.intakeKey,
    });
    const key = result.matched === "strict" && result.action === "unassigned" ? "deduped" : result.action;
    actions[key] = (actions[key] ?? 0) + 1;
  }
  return { scanned: scanned.length, actions };
}

// ---------------------------------------------------------------------------
// 2. Proposal: deterministic routing, then (optionally) one call per cluster
// ---------------------------------------------------------------------------

/**
 * Build a consolidation plan. Reads the ledger; writes nothing.
 *
 * @param {object} ledger
 * @param {{thresholds?: object, callModel?: Function|null, model?: string|null}} [opts]
 *   `callModel(cluster)` returns a validated model plan for one cluster; omit it
 *   (no model configured) and every cluster is reported unresolved.
 */
export async function buildPlan(ledger: Ledger, { thresholds = DEFAULT_RETRIEVAL, callModel = null, model = null }: DynamicValue = {}): Promise<DynamicValue> {
  const candidates: DynamicValue = ledger
    .all("SELECT * FROM bug_candidates WHERE status = 'unassigned' ORDER BY created_at, id")
    .map((c) => publicCandidate(ledger, c));
  const findings: DynamicValue = ledger
    .all("SELECT * FROM findings WHERE merged_into IS NULL AND state <> 'rejected' ORDER BY created_at, id")
    .map((f) => ({ id: f.id, title: f.title, summary: safeJson(f.summary), state: f.state }));

  const items: DynamicValue = [
    ...candidates.map((c: DynamicValue) => retrievalItem({ id: c.id, role: "candidate", text: c.match_text })),
    ...findings.map((f: DynamicValue) => retrievalItem({ id: f.id, role: "finding", text: findingMatchText(f) })),
  ];
  const idf = idfTable(items);
  const byId: DynamicValue = new Map(items.map((i: DynamicValue) => [i.id, i]));

  const proposals: DynamicValue[] = [];
  const unresolved: DynamicValue[] = [];
  const clustered: string[] = [];
  const edges: Array<{ a: string; b: string }> = [];
  const neighborsById: DynamicValue = new Map();

  for (const c of candidates) {
    const neighbors = shortlist(byId.get(c.id), items, idf, thresholds);
    neighborsById.set(c.id, neighbors);
    // A pre-attached loose-key suggestion from intake outranks word overlap: it
    // is grounded in recorded context, not in prose.
    if (c.suggested_finding_id) {
      proposals.push({
        action: "attach",
        candidate_ids: [c.id],
        finding_id: c.suggested_finding_id,
        source: "loose_key",
        score: null,
        confidence: null,
        reason: "same defect surface reached from a different story (loose key)",
      });
      continue;
    }
    const decision = route(neighbors, thresholds);
    if (decision === "suggestion") {
      const target: DynamicValue = neighbors.find((n) => n.role === "finding");
      proposals.push({
        action: "attach",
        candidate_ids: [c.id],
        finding_id: target.id,
        source: "score",
        score: round(target.score),
        confidence: null,
        reason: `word overlap ${round(target.score)} with this finding, above the auto-suggest threshold`,
      });
      continue;
    }
    if (decision === "new") {
      proposals.push({
        action: "new",
        candidate_ids: [c.id],
        finding_id: null,
        proposed_title: c.claim?.title ?? "Bug candidate",
        source: "score",
        score: null,
        confidence: null,
        reason: "no neighbor above the similarity floor",
      });
      continue;
    }
    clustered.push(c.id);
    for (const n of neighbors) {
      if (n.role === "candidate") edges.push({ a: c.id, b: n.id });
    }
  }

  const components = capClusters(connectedComponents(clustered, edges), thresholds);
  const stats = {
    candidates: candidates.length,
    findings: findings.length,
    routed_attach: proposals.filter((p) => p.action === "attach").length,
    routed_new: proposals.filter((p) => p.action === "new").length,
    clusters: components.length,
    model_calls: 0,
    input_tokens: 0,
  };

  const claimed = new Set<string>();
  for (const component of components.slice(0, thresholds.maxClusters ?? DEFAULT_RETRIEVAL.maxClusters)) {
    const cluster = {
      candidates: component.ids.map((id: string) => candidates.find((c: DynamicValue) => c.id === id)),
      findings: findingsForCluster(component.ids, neighborsById, findings),
      split: component.split,
    };
    if (!callModel) {
      unresolved.push({
        candidate_ids: component.ids,
        reason: "no model configured — cluster left unresolved (exact-key and score-routed work still applied)",
      });
      continue;
    }
    let plan: DynamicValue;
    try {
      plan = await callModel({ cluster, model, claimed });
    } catch (e) {
      unresolved.push({ candidate_ids: component.ids, reason: `cluster call failed: ${firstLine(e)}` });
      continue;
    }
    stats.model_calls += 1;
    stats.input_tokens += plan.input_tokens ?? 0;
    for (const a of plan.assignments ?? []) {
      for (const id of a.candidate_ids) claimed.add(id);
      proposals.push({
        action: a.finding_id ? "attach" : "new",
        candidate_ids: [...a.candidate_ids],
        finding_id: a.finding_id ?? null,
        proposed_title: a.finding_id ? null : a.proposed_title,
        source: "model",
        score: null,
        confidence: a.confidence,
        reason: a.reason,
      });
    }
    for (const u of plan.unresolved ?? []) {
      unresolved.push({ candidate_ids: [u.candidate_id], reason: u.reason });
    }
  }

  return {
    format: PLAN_FORMAT,
    format_version: PLAN_FORMAT_VERSION,
    created_at: nowIso(),
    workspace_id: ledger.workspaceId,
    ledger: ledger.file,
    algorithms: { ...VERSIONS, shortlist: SHORTLIST_VERSION },
    thresholds: { ...thresholds },
    model: callModel ? model : null,
    proposals: proposals.map((p, i) => ({ id: `p${i + 1}`, ...p })),
    unresolved,
    stats,
  };
}

/** Existing findings any member of this cluster is near — the only attach targets. */
function findingsForCluster(ids: string[], neighborsById: DynamicValue, findings: DynamicValue[]): DynamicValue[] {
  const wanted = new Set<string>();
  for (const id of ids) {
    for (const n of neighborsById.get(id) ?? []) if (n.role === "finding") wanted.add(n.id);
  }
  return findings.filter((f) => wanted.has(f.id));
}

// ---------------------------------------------------------------------------
// 3. Apply — only ever from an explicit human confirmation
// ---------------------------------------------------------------------------

/**
 * Apply a plan's proposals in one transaction. Every id is re-validated against
 * the live ledger, so a stale plan fails loudly instead of mutating half of it.
 *
 * @param {object} ledger
 * @param {object} plan a plan produced by `buildPlan`
 * @param {{only?: string[]|null}} [opts] `only` selects proposal ids to apply
 */
export function applyPlan(ledger: Ledger, plan: DynamicValue, { only = null }: DynamicValue = {}): DynamicValue {
  if (plan?.format !== PLAN_FORMAT) {
    throw new DummyConfigError(`not a Playtest consolidation plan (expected "format": "${PLAN_FORMAT}")`);
  }
  if (plan.format_version !== PLAN_FORMAT_VERSION) {
    throw new DummyConfigError(
      `this plan was written in format version ${plan.format_version}; this build applies version ${PLAN_FORMAT_VERSION}. Re-run: playtest findings consolidate`,
    );
  }
  if (plan.workspace_id !== ledger.workspaceId) {
    throw new DummyConfigError(
      `this plan belongs to another workspace (${plan.workspace_id}), not ${ledger.workspaceId}. Plans are never portable between ledgers.`,
    );
  }
  const selected: DynamicValue = (plan.proposals ?? []).filter((p: DynamicValue) => !only || only.includes(p.id));
  if (only) {
    const missing = only.filter((id: string) => !(plan.proposals ?? []).some((p: DynamicValue) => p.id === id));
    if (missing.length) throw new DummyConfigError(`no proposal ${missing.join(", ")} in this plan`);
  }

  return ledger.tx(() => {
    const applied: DynamicValue[] = [];
    for (const p of selected) {
      const ids = p.candidate_ids ?? [];
      for (const id of ids) {
        const row = ledger.get("SELECT id, status FROM bug_candidates WHERE id = ?", [id]);
        if (!row) throw new DummyConfigError(`plan proposal ${p.id} names bug candidate ${id}, which is not in this ledger`);
        if (row.status !== "unassigned") {
          throw new DummyConfigError(
            `plan proposal ${p.id} is stale: bug candidate ${id} is now "${row.status}". Re-run: playtest findings consolidate`,
          );
        }
      }
      let targetId = p.finding_id ?? null;
      if (targetId) {
        const live = liveFinding(ledger, targetId);
        if (!live) throw new DummyConfigError(`plan proposal ${p.id} names finding ${targetId}, which is not in this ledger`);
        targetId = live.id;
      }
      let created = false;
      for (const id of ids) {
        const result = promoteWithinTx(ledger, {
          candidateId: id,
          findingId: targetId,
          title: targetId ? null : p.proposed_title ?? null,
          actor: p.source === "model" ? "cli:plan(model-proposed, human-confirmed)" : "cli:plan",
        });
        targetId = result.finding.id;
        created = created || result.created;
      }
      applied.push({ proposal: p.id, finding_id: targetId, created, candidates: ids.length });
    }
    return { applied, count: applied.length };
  });
}

// ---------------------------------------------------------------------------
// Model call (forced tool; runs OUTSIDE any transaction)
// ---------------------------------------------------------------------------

/** The compact per-cluster payload: claims and references, never trajectories. */
export function clusterPrompt(cluster: DynamicValue): string {
  const lines: DynamicValue = ["## Candidates"];
  for (const c of cluster.candidates) {
    lines.push(
      "",
      `### candidate_id ${c.id}`,
      `Category: ${c.category}`,
      `Title: ${oneLine(c.claim?.title)}`,
      c.claim?.expected ? `Expected: ${oneLine(c.claim.expected)}` : null,
      c.claim?.observed ? `Observed: ${oneLine(c.claim.observed)}` : null,
      c.story_id ? `Story: ${c.story_id}` : null,
      c.normalized_locus ? `Surface: ${c.normalized_locus}` : null,
      `Evidence: ${c.evidence_count} cited run/step reference(s)${c.run_id ? ` (first run ${c.run_id})` : ""}`,
    );
  }
  lines.push("", "## Existing findings you may attach to");
  if (!cluster.findings.length) lines.push("(none — every group here is new)");
  for (const f of cluster.findings) {
    lines.push(
      "",
      `### finding_id ${f.id}`,
      `Title: ${oneLine(f.title)}`,
      f.summary?.expected ? `Expected: ${oneLine(f.summary.expected)}` : null,
      f.summary?.observed ? `Observed: ${oneLine(f.summary.observed)}` : null,
      `State: ${f.state}`,
    );
  }
  return lines.filter((l: DynamicValue) => l != null).join("\n");
}

/**
 * Validate one cluster's returned plan. Returns an error string (the
 * `forcedToolCall` validator contract) or null. Pure — offline testable.
 */
export function validateClusterPlan(args: DynamicValue, { candidateIds, findingIds, claimed = new Set() }: DynamicValue): string | null {
  const inCluster = candidateIds instanceof Set ? candidateIds : new Set(candidateIds);
  const targets = findingIds instanceof Set ? findingIds : new Set(findingIds);
  if (!args || typeof args !== "object") return "args must be an object";
  if (!Array.isArray(args.assignments)) return `"assignments" must be an array`;
  if (args.unresolved != null && !Array.isArray(args.unresolved)) return `"unresolved" must be an array`;

  const seen = new Set<string>();
  for (const a of args.assignments) {
    if (!a || typeof a !== "object") return "each assignment must be an object";
    if (!Array.isArray(a.candidate_ids) || !a.candidate_ids.length) {
      return `each assignment needs a non-empty "candidate_ids" array`;
    }
    for (const id of a.candidate_ids) {
      if (typeof id !== "string" || !inCluster.has(id)) {
        return `assignment cites candidate_id "${id}" which was not in this cluster's input — only use the ids listed`;
      }
      if (seen.has(id) || claimed.has(id)) {
        return `candidate_id "${id}" appears in more than one group — each candidate belongs to at most one`;
      }
      seen.add(id);
    }
    if (a.finding_id != null && a.finding_id !== "") {
      if (typeof a.finding_id !== "string" || !targets.has(a.finding_id)) {
        return `assignment cites finding_id "${a.finding_id}" which was not in this cluster's input — omit it to propose a new group`;
      }
    } else if (typeof a.proposed_title !== "string" || !a.proposed_title.trim()) {
      return `a new group needs a non-empty "proposed_title"`;
    }
    if (!CONFIDENCES.has(a.confidence)) {
      return `"confidence" must be high or medium — anything weaker belongs in "unresolved"`;
    }
    if (typeof a.reason !== "string" || !a.reason.trim()) return `each assignment needs a "reason"`;
  }
  for (const u of args.unresolved || []) {
    if (!u || typeof u.candidate_id !== "string" || !inCluster.has(u.candidate_id)) {
      return `unresolved cites candidate_id "${u?.candidate_id}" which was not in this cluster's input`;
    }
    if (seen.has(u.candidate_id)) return `candidate_id "${u.candidate_id}" is both assigned and unresolved`;
    if (typeof u.reason !== "string" || !u.reason.trim()) return `each unresolved entry needs a "reason"`;
  }
  return null;
}

/**
 * One forced-tool cluster call, through the same LLM facade the grader uses.
 * Returns the validated plan; the caller still treats it as a proposal.
 */
export async function callClusterModel({ cluster, model, claimed = new Set() }: DynamicValue, { forcedToolCall }: DynamicValue = {}): Promise<DynamicValue> {
  if (!forcedToolCall) throw new DummyConfigError("no model transport supplied for the cluster call");
  const candidateIds = new Set(cluster.candidates.map((c: DynamicValue) => c.id));
  const findingIds = new Set(cluster.findings.map((f: DynamicValue) => f.id));
  const prompt = clusterPrompt(cluster);
  const { args, tokens } = await forcedToolCall({
    model,
    messages: [
      { role: "system", content: CONSOLIDATION_SYSTEM },
      { role: "user", content: prompt },
    ],
    tool: CONSOLIDATION_TOOL,
    validate: (a: DynamicValue) => validateClusterPlan(a, { candidateIds, findingIds, claimed }),
    maxTokens: 2048,
  });
  return {
    assignments: args.assignments ?? [],
    unresolved: args.unresolved ?? [],
    input_tokens: tokens?.in ?? estimateTokens(prompt),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function safeTrajectory(file: string): DynamicValue[] {
  try {
    return fs.existsSync(file) ? readTrajectory(file) : [];
  } catch {
    return [];
  }
}

function safeJson(v: DynamicValue): DynamicValue {
  try {
    return v == null ? {} : JSON.parse(v);
  } catch {
    return {};
  }
}

function routeOf(url: DynamicValue): string | null {
  if (!url) return null;
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url);
  }
}

function stepLocus(env: DynamicValue): DynamicValue {
  return env?.resolution?.locator ?? env?.agent?.action?.type ?? null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
const oneLine = (s: unknown): string => String(s || "").replace(/\s+/g, " ").trim().slice(0, 400);
const firstLine = (e: DynamicValue): DynamicValue => String(e?.message ?? e).split("\n")[0];
