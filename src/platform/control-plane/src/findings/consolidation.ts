// Reviewer-triggered retrieve-then-verify consolidation
// (docs/contracts/hosted.md, "Consolidation").
//
// The subjects are the project's **unreviewed (`new`) findings**; they are
// compared against every other live finding — open, rejected, and resolved
// alike — and against each other. Three steps, in this order, and the order is
// the whole point:
//
//   1. Deterministic retrieval (findings/shortlist.ts) scores every `new`
//      finding against the rest. No model call, no index, no external service.
//   2. Score routing decides BEFORE any call is issued: a single reviewed-finding
//      neighbor above the auto-suggest threshold is proposed as a merge into it;
//      a finding below the floor everywhere is proposed to stand alone. Those two
//      paths never reach the gateway.
//   3. Only the ambiguous middle is clustered — connected components of
//      shortlist edges, so one defect cannot be split across two calls — and
//      each cluster gets exactly one forced-tool call.
//
// TRUST BOUNDARY. The model's answer is a proposal over ids this server put in
// its prompt. It is validated (ids in-cluster, project-scoped, each finding at
// most once, new groups titled) and then PERSISTED AS A PROPOSAL. No finding
// changes until a reviewer applies the plan, and applying runs in one
// transaction through the same merge helper as any reviewer merge, so evidence
// completeness, merge tombstones, and audit are preserved.
//
// Model calls happen OUTSIDE any transaction (the storage rule): planning reads,
// calls, then opens a short write transaction to record the proposal.
import crypto from "node:crypto";
import { forcedToolCall, estimateCost } from "../../../../core/public/llm.ts";
import { ulid } from "../ulid.ts";
import { audit } from "../audit.ts";
import { AppError, badRequest, conflict, notFound } from "../errors.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { VERSIONS } from "./keys.ts";
import { liveFinding } from "./intake.ts";
import { mergeFindings } from "./merge.ts";
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
  similarity,
} from "./shortlist.ts";

/**
 * Prompt pin (engine contract convention: a prompt change bumps its own version
 * and that version is recorded as assignment provenance).
 */
export const CONSOLIDATION_PROMPT_VERSION = "consolidate-v1";

const CONFIDENCES = new Set(["high", "medium"]);
const MAX_REASON = 400;
const MAX_TITLE = 180;

// ---------------------------------------------------------------------------
// Prompt + forced tool
// ---------------------------------------------------------------------------

export const CONSOLIDATION_SYSTEM = [
  "You are consolidating unreviewed bug reports for one software project. Each report below is a typed,",
  "cited claim that the application malfunctioned. A deterministic retrieval step already decided",
  "these few items are worth comparing; your job is only to say which of them describe the SAME",
  "underlying defect.",
  "",
  "- Group reports that describe one underlying defect, however differently they are worded.",
  "  Different personas describe one defect in different words, and the category label is a hint,",
  "  not identity: two reports in different categories may still be one defect.",
  "- Two reports that merely share a category or a surface are NOT the same defect. Distinct",
  "  failures on distinct surfaces stay in distinct groups.",
  "- Attach a group to an existing finding by its finding_id only when that finding describes the",
  "  same defect. Otherwise omit finding_id and give the new group a short, specific proposed_title.",
  "- Use only the candidate_id and finding_id values listed below. Never invent an id.",
  "- Each report belongs to at most one group. A report you cannot place at medium confidence",
  "  or better goes in `unresolved` with a reason — there is deliberately no low confidence.",
  "",
  "Call the consolidation_plan tool with your answer.",
].join("\n");

export const CONSOLIDATION_TOOL: HostedDynamic = {
  type: "function",
  function: {
    name: "consolidation_plan",
    description: "Propose which of the supplied unreviewed bug reports describe the same underlying defect.",
    parameters: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          description: "One entry per group of reports that share an underlying defect.",
          items: {
            type: "object",
            properties: {
              candidate_ids: {
                type: "array",
                items: { type: "string" },
                description: "unreviewed-finding ids from this input, each used at most once across the whole plan",
              },
              finding_id: {
                type: "string",
                description: "an existing finding id from this input; omit entirely for a new group",
              },
              proposed_title: {
                type: "string",
                description: "short, specific title; REQUIRED when finding_id is omitted",
              },
              confidence: { type: "string", enum: ["high", "medium"] },
              reason: { type: "string", description: "why these reports are one defect" },
            },
            required: ["candidate_ids", "confidence", "reason"],
          },
        },
        unresolved: {
          type: "array",
          description: "reports you cannot place at medium confidence or better",
          items: {
            type: "object",
            properties: {
              candidate_id: { type: "string" },
              reason: { type: "string" },
            },
            required: ["candidate_id", "reason"],
          },
        },
      },
      required: ["assignments"],
    },
  },
};

/**
 * Which model verifies clusters for this project: the project's own
 * `consolidation_model` policy when set, else the deployment default
 * (`PLAYTEST_CONSOLIDATION_MODEL`, else the gpt5_6_terra tier). Callers pass
 * the full project row so the policy travels with the project.
 */
export function consolidationModelFor(ctx: HostedDynamic, project: HostedDynamic) {
  return project?.models?.consolidation_model || ctx.config.llm.consolidationModel;
}

/** Friendly preflight — the §8 LLM gateway config, named exactly. */
export function requireConsolidationConfigured(env = process.env) {
  if (!env.PLAYTEST_LLM_BASE_URL) {
    throw new AppError(
      "not_configured",
      "consolidating findings needs the platform LLM gateway: set PLAYTEST_LLM_BASE_URL " +
        "(and PLAYTEST_LLM_API_KEY) on the control plane (see src/config.ts). " +
        "Findings routed by score alone need no gateway.",
    );
  }
}

// ---------------------------------------------------------------------------
// Step 1–3: deterministic retrieval and routing (no model call)
// ---------------------------------------------------------------------------

/**
 * The match text a finding is scored on. Intake stores it (`findings.match_text`);
 * a finding written before the collapse, or by the extractor under an older
 * version, derives it on read with the same frozen function rather than being
 * silently unmatchable.
 */
export function subjectMatchText(f: HostedDynamic) {
  return f.match_text || findingMatchText(f);
}

/**
 * Score, route, and cluster one project's unreviewed findings against its live
 * findings. Pure over its inputs: same rows in, same plan scope out.
 *
 * @param {object} args
 * @param {Array<object>} args.subjects live `findings` rows in state `new`
 * @param {Array<object>} args.findings every live (unmerged) `findings` row,
 *   subjects included
 * @param {object} args.thresholds `config.consolidation`
 */
export function buildRetrieval({ subjects, findings, thresholds = DEFAULT_RETRIEVAL }: HostedDynamic) {
  const t: HostedDynamic = { ...DEFAULT_RETRIEVAL, ...thresholds };
  const subjectIds = new Set(subjects.map((f: HostedDynamic) => f.id));
  // `role` is retrieval vocabulary: routing distinguishes an unreviewed subject
  // from a finding a person has already touched; scoring does not.
  const pool: HostedDynamic[] = [];
  for (const f of findings) {
    pool.push(retrievalItem({
      id: f.id,
      role: subjectIds.has(f.id) ? "subject" : "finding",
      text: subjectMatchText(f),
    }));
  }
  for (const f of subjects) {
    if (!findings.some((x: HostedDynamic) => x.id === f.id)) {
      pool.push(retrievalItem({ id: f.id, role: "subject", text: subjectMatchText(f) }));
    }
  }
  const subjectItems = pool.filter((i) => i.role === "subject");
  const idf = idfTable(pool);
  const itemsById = new Map(pool.map((i) => [i.id, i]));

  const neighbors = new Map();
  for (const item of subjectItems) {
    neighbors.set(item.id, shortlist(item, pool, idf, { k: t.k, floor: t.floor }));
  }

  const suggestions: HostedDynamic[] = [];
  const newGroups: HostedDynamic[] = [];
  const clustered: HostedDynamic[] = [];
  for (const item of subjectItems) {
    const near = neighbors.get(item.id);
    const decision = route(near, { autoSuggest: t.autoSuggest });
    if (decision === "suggestion") {
      const target = near.find((n: HostedDynamic) => n.role === "finding");
      suggestions.push({ candidate_id: item.id, finding_id: target.id, score: target.score });
    } else if (decision === "new") {
      newGroups.push({ candidate_id: item.id });
    } else {
      clustered.push(item);
    }
  }

  // Connected components over subject-to-subject edges above the floor. A
  // clustered subject whose only neighbors are reviewed findings still forms its
  // own component, so the model sees it together with those findings.
  const clusteredIds = clustered.map((i) => i.id);
  const clusteredSet = new Set(clusteredIds);
  const edges: HostedDynamic[] = [];
  for (let i = 0; i < clustered.length; i += 1) {
    for (let j = i + 1; j < clustered.length; j += 1) {
      if (similarity(clustered[i], clustered[j], idf) >= t.floor) {
        edges.push({ a: clustered[i].id, b: clustered[j].id });
      }
    }
  }
  const components = capClusters(connectedComponents(clusteredIds, edges), { maxClusterItems: t.maxClusterItems });

  const byId = new Map(findings.map((f: HostedDynamic) => [f.id, f]));
  for (const f of subjects) if (!byId.has(f.id)) byId.set(f.id, f);
  const clusterList = components.slice(0, t.maxClusters).map((component, index) => {
    // Every reviewed-finding neighbor of any member is offered as a target.
    const findingIds = new Set();
    for (const id of component.ids) {
      for (const n of neighbors.get(id) || []) {
        if (n.role === "finding") findingIds.add(n.id);
        // A subject neighbor outside this component (only possible after a size
        // cap split) is not offered: the model may reference in-cluster ids only.
        if (n.role === "subject" && !clusteredSet.has(n.id)) continue;
      }
    }
    return {
      id: `cl${index + 1}`,
      candidate_ids: component.ids,
      finding_ids: [...findingIds].sort(),
      split: component.split,
      candidates: component.ids.map((id) => byId.get(id)).filter(Boolean),
      findings: [...findingIds].sort().map((id) => byId.get(id)).filter(Boolean),
    };
  });

  const dropped = components.length - clusterList.length;
  const prompts = clusterList.map((c) => clusterPrompt(c));
  const promptBytes = prompts.reduce((sum, p) => sum + Buffer.byteLength(p, "utf8"), 0);
  const scope: HostedDynamic = {
    unassigned_candidates: subjectItems.length,
    findings_compared: pool.length - subjectItems.length,
    suggestions: suggestions.length,
    proposed_new: newGroups.length,
    clustered_candidates: clusterList.reduce((s, c) => s + c.candidate_ids.length, 0),
    clusters: clusterList.length,
    clusters_dropped_by_cap: dropped > 0 ? dropped : 0,
    prompt_bytes: promptBytes,
    est_input_tokens: prompts.reduce((s, p) => s + estimateTokens(p), 0),
    max_cluster_size: clusterList.reduce((m, c) => Math.max(m, c.candidate_ids.length), 0),
    model_calls_planned: clusterList.length,
    thresholds: publicThresholds(t),
  };
  return { suggestions, newGroups, clusters: clusterList, scope, neighbors, itemsById, thresholds: t };
}

export function publicThresholds(t: HostedDynamic) {
  return {
    k: t.k,
    floor: t.floor,
    auto_suggest: t.autoSuggest,
    max_cluster_items: t.maxClusterItems,
    max_prompt_bytes: t.maxPromptBytes,
    max_clusters: t.maxClusters,
  };
}

/**
 * The compact cluster payload: ids, titles, expected/observed, story/surface, and
 * evidence references. Never screenshots, HAR bodies, cookies, authorization
 * headers, or trajectories.
 */
export function clusterPrompt(cluster: HostedDynamic) {
  const lines: HostedDynamic[] = ["## Unreviewed reports"];
  for (const m of cluster.candidates) {
    const claim = m.summary?.claim || {};
    lines.push(
      "",
      `### candidate_id ${m.id}`,
      `Category: ${m.category ?? "unknown"}`,
      `Title: ${oneLine(m.title)}`,
      claim.expected ? `Expected: ${oneLine(claim.expected)}` : null,
      claim.observed ? `Observed: ${oneLine(claim.observed)}` : null,
      m.summary?.story_id ? `Story: ${m.summary.story_id}` : null,
      m.normalized_locus ? `Surface: ${m.normalized_locus}` : null,
      `Evidence: ${evidenceRef(m)}`,
    );
  }
  if (cluster.findings.length) {
    lines.push("", "## Existing findings you may attach to");
    for (const f of cluster.findings) {
      const claim = f.summary?.claim || {};
      lines.push(
        "",
        `### finding_id ${f.id}`,
        `Title: ${oneLine(f.title)}`,
        claim.expected || f.summary?.expected ? `Expected: ${oneLine(claim.expected ?? f.summary.expected)}` : null,
        claim.observed || f.summary?.observed ? `Observed: ${oneLine(claim.observed ?? f.summary.observed)}` : null,
        f.state ? `State: ${f.state}` : null,
      );
    }
  } else {
    lines.push("", "## Existing findings you may attach to", "(none — every group here is new)");
  }
  return lines.filter((l) => l != null).join("\n");
}

function evidenceRef(f: HostedDynamic) {
  const n = Number(f.evidence_count ?? 0);
  return `${n} cited run/step reference${n === 1 ? "" : "s"}${f.first_run_id ? ` (first run ${f.first_run_id})` : ""}`;
}

function oneLine(s: HostedDynamic) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 400);
}

// ---------------------------------------------------------------------------
// Model output validation (pure — offline testable)
// ---------------------------------------------------------------------------

/**
 * Validate one cluster's returned plan. Returns an error string (the
 * `forcedToolCall` validator contract) or null.
 *
 * Pure and idempotent: `claimed` is read-only, so a retry validates identically.
 *
 * @param {object} args the model's tool arguments
 * @param {{candidateIds: Set<string>|Array, findingIds: Set<string>|Array,
 *          claimed?: Set<string>}} ctx ids that appeared in THIS cluster's input,
 *   plus members already claimed by an earlier cluster in the same plan.
 */
export function validateClusterPlan(args: HostedDynamic, { candidateIds, findingIds, claimed = new Set() }: HostedDynamic): HostedDynamic {
  const inCluster = candidateIds instanceof Set ? candidateIds : new Set(candidateIds);
  const targets = findingIds instanceof Set ? findingIds : new Set(findingIds);
  if (!args || typeof args !== "object") return "args must be an object";
  if (!Array.isArray(args.assignments)) return `"assignments" must be an array`;
  if (args.unresolved != null && !Array.isArray(args.unresolved)) return `"unresolved" must be an array`;

  const seen = new Set();
  for (const a of args.assignments) {
    if (!a || typeof a !== "object") return `each assignment must be an object`;
    if (!Array.isArray(a.candidate_ids) || !a.candidate_ids.length) {
      return `each assignment needs a non-empty "candidate_ids" array`;
    }
    for (const id of a.candidate_ids) {
      if (typeof id !== "string" || !inCluster.has(id)) {
        return `assignment cites candidate_id "${id}" which was not in this cluster's input — only use the ids listed`;
      }
      if (seen.has(id) || claimed.has(id)) {
        return `candidate_id "${id}" appears in more than one group — each finding belongs to at most one`;
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
    if (seen.has(u.candidate_id)) {
      return `candidate_id "${u.candidate_id}" is both assigned and unresolved`;
    }
    if (typeof u.reason !== "string" || !u.reason.trim()) return `each unresolved entry needs a "reason"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Planning (model calls run OUTSIDE any transaction)
// ---------------------------------------------------------------------------

/** Deterministic scope only. No model call, no write — what the reviewer sees first. */
export async function previewConsolidation(ctx: HostedDynamic, { project }: HostedDynamic) {
  const { subjects, findings } = await loadCorpus(ctx, project.id);
  const retrieval = buildRetrieval({ subjects, findings, thresholds: ctx.config.consolidation });
  return {
    project_id: project.id,
    scope: retrieval.scope,
    shortlist_version: SHORTLIST_VERSION,
    match_text_version: VERSIONS.match_text,
    prompt_version: retrieval.clusters.length ? CONSOLIDATION_PROMPT_VERSION : null,
    model: retrieval.clusters.length ? consolidationModelFor(ctx, project) : null,
    // Named so the console can say exactly what a confirmation will spend.
    requires_model: retrieval.clusters.length > 0,
  };
}

/**
 * Build a consolidation plan: deterministic retrieval, then one forced-tool call
 * per cluster, then persist the PROPOSAL. No finding changes here.
 *
 * @param {object} ctx server ctx (db, config)
 * @param {{project: object, actor: object, callModel?: Function}} args
 *   `callModel` is injected by tests; production uses the gateway.
 */
export async function planConsolidation(ctx: HostedDynamic, { project, actor, callModel = null }: HostedDynamic) {
  const { subjects, findings } = await loadCorpus(ctx, project.id);
  if (!subjects.length) {
    throw badRequest(`project "${project.id}" has no unreviewed findings to consolidate`);
  }
  const retrieval = buildRetrieval({ subjects, findings, thresholds: ctx.config.consolidation });
  const model = consolidationModelFor(ctx, project);
  const call = callModel || defaultCallModel;

  const items: HostedDynamic[] = [];
  const unresolved: HostedDynamic[] = [];
  const usage: HostedDynamic = { calls: 0, in: 0, out: 0, cache_read: 0, cost_usd: 0 };

  // Score-routed findings never reach the gateway (docs/contracts/hosted.md).
  for (const s of retrieval.suggestions) {
    items.push(planItem({
      origin: "shortlist_suggestion",
      candidate_ids: [s.candidate_id],
      finding_id: s.finding_id,
      score: round(s.score),
      reason: "a single existing finding scored above the auto-suggest threshold",
    }));
  }
  for (const n of retrieval.newGroups) {
    const f = subjects.find((x: HostedDynamic) => x.id === n.candidate_id);
    items.push(planItem({
      origin: "shortlist_new",
      candidate_ids: [n.candidate_id],
      proposed_title: clampTitle(f?.title),
      reason: "no neighbor scored above the similarity floor",
    }));
  }

  if (retrieval.clusters.length) {
    if (!callModel) requireConsolidationConfigured();
    const claimed = new Set();
    for (const cluster of retrieval.clusters) {
      const prompt = clusterPrompt(cluster);
      if (Buffer.byteLength(prompt, "utf8") > retrieval.thresholds.maxPromptBytes) {
        throw badRequest(
          `consolidation cluster "${cluster.id}" is ${Buffer.byteLength(prompt, "utf8")} prompt bytes, over the ` +
            `${retrieval.thresholds.maxPromptBytes}-byte cap — lower PLAYTEST_CONSOLIDATION_MAX_CLUSTER_ITEMS ` +
            `or raise PLAYTEST_CONSOLIDATION_MAX_PROMPT_BYTES`,
        );
      }
      const candidateIds = new Set(cluster.candidate_ids);
      const findingIds = new Set(cluster.finding_ids);
      const { args, tokens } = await call({
        model,
        messages: [
          { role: "system", content: CONSOLIDATION_SYSTEM },
          { role: "user", content: prompt },
        ],
        tool: CONSOLIDATION_TOOL,
        maxTokens: 1500,
        validate: (a: HostedDynamic) => validateClusterPlan(a, { candidateIds, findingIds, claimed }),
      });
      usage.calls += 1;
      usage.in += tokens?.in ?? 0;
      usage.out += tokens?.out ?? 0;
      usage.cache_read += tokens?.cache_read ?? 0;
      usage.cost_usd += estimateCost(model, tokens || {});

      // Belt and braces: the validator already ran inside forcedToolCall, but a
      // caller-supplied `callModel` (or a future gateway change) must not be able
      // to slip an unvalidated proposal past the trust boundary.
      const err = validateClusterPlan(args, { candidateIds, findingIds, claimed });
      if (err) throw badRequest(`the consolidation model returned an invalid plan: ${err}`);

      for (const a of args.assignments) {
        for (const id of a.candidate_ids) claimed.add(id);
        items.push(planItem({
          origin: "model_cluster",
          cluster_id: cluster.id,
          candidate_ids: [...a.candidate_ids],
          finding_id: a.finding_id || null,
          proposed_title: a.finding_id ? null : clampTitle(a.proposed_title),
          confidence: a.confidence,
          reason: String(a.reason).slice(0, MAX_REASON),
        }));
      }
      for (const u of args.unresolved || []) {
        unresolved.push({
          candidate_id: u.candidate_id,
          cluster_id: cluster.id,
          reason: String(u.reason).slice(0, MAX_REASON),
        });
      }
    }
  }

  const plan: HostedDynamic = { items, unresolved };
  const digest = candidateDigest(subjects.filter((f: HostedDynamic) => referencedIds(plan).has(f.id)));
  const id = ulid();
  let row;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `INSERT INTO consolidation_plans
         (id, project_id, status, thresholds, shortlist_version, match_text_version,
          plan, scope, usage, prompt_version, model, candidate_digest, created_by)
       VALUES ($1,$2,'proposed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, project.id, publicThresholds(retrieval.thresholds), SHORTLIST_VERSION, VERSIONS.match_text,
        plan, retrieval.scope, usage,
        retrieval.clusters.length ? CONSOLIDATION_PROMPT_VERSION : null,
        retrieval.clusters.length ? model : null,
        digest, actor,
      ],
    );
    await audit(tx, {
      actor,
      action: "consolidation.planned",
      entityType: "consolidation_plan",
      entityId: id,
      projectId: project.id,
      detail: {
        scope: retrieval.scope,
        usage,
        prompt_version: retrieval.clusters.length ? CONSOLIDATION_PROMPT_VERSION : null,
        model: retrieval.clusters.length ? model : null,
        shortlist_version: SHORTLIST_VERSION,
        items: items.length,
        unresolved: unresolved.length,
      },
    });
    await emitPlatformEvent(tx, {
      projectId: project.id,
      type: "consolidation.planned",
      entity: { plan_id: id },
      payload: { plan_id: id, items: items.length, unresolved: unresolved.length, actor },
    });
    row = (await tx.query(`SELECT * FROM consolidation_plans WHERE id = $1`, [id])).rows[0];
  });
  return row;
}

async function defaultCallModel({ model, messages, tool, maxTokens, validate }: HostedDynamic) {
  return await forcedToolCall({ model, messages, tool, maxTokens, validate });
}

// ---------------------------------------------------------------------------
// Applying an approved plan (ONE transaction, reviewer authority)
// ---------------------------------------------------------------------------

/**
 * Apply a reviewer's decisions over a proposed plan, in the caller's open
 * transaction. Every accepted group MERGES its members: into the existing
 * target, or — for a group proposed as new — into its oldest member, which takes
 * the proposed title and stays `new` for ordinary review. The merge helper is
 * the same one the findings API uses, so evidence, tombstones, and audit behave
 * identically.
 *
 * @param {{query: Function}} tx
 * @param {object} args
 * @param {object} args.planRow the persisted plan
 * @param {Array<{item_id: string, action?: "accept"|"skip", finding_id?: string,
 *   proposed_title?: string}>} args.decisions an item with no decision is left
 *   unresolved; an item whose `finding_id`/`proposed_title` differs from the
 *   proposal is recorded as a reviewer edit.
 * @param {object} args.actor
 * @param {"rejected"|"unresolved"} [args.undecidedDecision] the label recorded
 *   for items nobody accepted. A reviewer leaving an item behind is a rejection
 *   signal for threshold tuning; the auto-dedupe sweep leaving one behind is
 *   not — it is deliberately deferring to a person — so it records `unresolved`.
 */
export async function applyConsolidationPlan(tx: HostedDynamic, { planRow, decisions, actor, undecidedDecision = "rejected" }: HostedDynamic) {
  const current = (await tx.query(
    `SELECT * FROM consolidation_plans WHERE id = $1`, [planRow.id],
  )).rows[0];
  if (!current) throw notFound(`no consolidation plan "${planRow.id}"`);
  if (current.status !== "proposed") {
    throw conflict(
      `consolidation plan "${current.id}" was already ${current.status} — build a fresh plan and review it again`,
    );
  }
  const plan = current.plan || { items: [], unresolved: [] };
  const itemsById: HostedDynamic = new Map((plan.items || []).map((i: HostedDynamic) => [i.id, i]));

  // --- staleness: every referenced finding must be exactly as it was ---
  const ids = [...referencedIds(plan)];
  const rows = ids.length
    ? (await tx.query(
        `SELECT * FROM findings WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})`, ids,
      )).rows
    : [];
  if (rows.length !== ids.length || candidateDigest(rows) !== current.candidate_digest) {
    throw conflict(
      `consolidation plan "${current.id}" is stale: the findings it covers changed since it was proposed — ` +
        `build a fresh plan and review it again`,
    );
  }
  const byId: HostedDynamic = new Map(rows.map((f: HostedDynamic) => [f.id, f]));
  for (const f of rows) {
    if (f.project_id !== current.project_id) {
      throw badRequest(`consolidation plan "${current.id}" references a finding from another project`);
    }
  }

  // --- validate the reviewer's decisions before writing anything ---
  const accepted: HostedDynamic[] = [];
  const claimed = new Set();
  for (const d of decisions || []) {
    if (!d || typeof d.item_id !== "string") throw badRequest(`each decision needs an "item_id"`);
    const item = itemsById.get(d.item_id);
    if (!item) throw badRequest(`decision names item "${d.item_id}", which is not part of this plan`);
    const action = d.action || "accept";
    if (action === "skip") continue;
    if (action !== "accept") throw badRequest(`"action" must be accept or skip (got ${JSON.stringify(d.action)})`);
    if (accepted.some((a) => a.item.id === item.id)) throw badRequest(`item "${item.id}" was decided twice`);
    for (const id of item.candidate_ids) {
      if (claimed.has(id)) {
        throw badRequest(`finding "${id}" appears in more than one accepted item — each belongs to at most one`);
      }
      claimed.add(id);
    }
    const findingId = pick(d.finding_id, item.finding_id);
    const title = clampTitle(pick(d.proposed_title, item.proposed_title));
    if (!findingId && !title) {
      throw badRequest(`item "${item.id}" proposes a new finding and needs a non-empty title`);
    }
    let target: HostedDynamic = null;
    if (findingId) {
      target = await liveFinding(tx, findingId);
      if (!target || target.project_id !== current.project_id) {
        throw notFound(`no target finding "${findingId}" in this project`);
      }
    }
    accepted.push({
      item,
      findingId: target?.id ?? null,
      title,
      edited: (findingId ?? null) !== (item.finding_id ?? null) || title !== clampTitle(item.proposed_title),
    });
  }

  // --- apply ---
  const applied: HostedDynamic[] = [];
  for (const a of accepted) {
    let survivorId = a.findingId;
    const created = !survivorId;
    if (created) {
      // A group proposed as new merges into its OLDEST member, which takes the
      // proposed title and stays `new` for ordinary review.
      const oldest = [...a.item.candidate_ids]
        .map((id) => byId.get(id))
        .filter(Boolean)
        .sort((x: HostedDynamic, y: HostedDynamic) => stampOf(x.created_at) - stampOf(y.created_at) || (x.id < y.id ? -1 : 1))[0];
      if (!oldest) throw conflict(`consolidation item "${a.item.id}" has no member findings left to group`);
      survivorId = oldest.id;
      const provenance: HostedDynamic = {
        consolidation_plan_id: current.id,
        consolidation_item_id: a.item.id,
        consolidation_origin: a.item.origin,
        consolidation_confidence: a.item.confidence ?? null,
        shortlist_version: current.shortlist_version,
        match_text_version: current.match_text_version,
        prompt_version: a.item.origin === "model_cluster" ? current.prompt_version : null,
        consolidation_model: a.item.origin === "model_cluster" ? current.model : null,
      };
      const retitled = await tx.query(
        `UPDATE findings
            SET title = $2, summary = json_patch(summary, $3), updated_at = now()
          WHERE id = $1 AND merged_into IS NULL`,
        [survivorId, a.title, JSON.stringify(stripNulls(provenance))],
      );
      if (retitled.rowCount === 0) {
        throw conflict(`finding "${survivorId}" changed while the consolidation plan was being applied`);
      }
    }
    for (const memberId of a.item.candidate_ids) {
      if (memberId === survivorId) continue;
      const survivor = await mergeFindings(tx, {
        sourceId: memberId,
        targetId: survivorId,
        actor,
        detail: { consolidation_plan_id: current.id, consolidation_item_id: a.item.id },
      });
      survivorId = survivor.id;
    }
    applied.push({
      item_id: a.item.id,
      origin: a.item.origin,
      candidate_ids: a.item.candidate_ids,
      finding_id: survivorId,
      created,
      edited: a.edited,
      proposed_finding_id: a.item.finding_id ?? null,
      proposed_title: a.item.proposed_title ?? null,
      applied_title: a.title,
    });
    for (const memberId of a.item.candidate_ids) {
      await recordLabel(tx, {
        projectId: current.project_id,
        planId: current.id,
        candidateId: memberId,
        findingId: survivorId,
        origin: a.item.origin,
        score: a.item.score ?? null,
        confidence: a.item.confidence ?? null,
        decision: a.edited ? "edited" : "confirmed",
        detail: { proposed_finding_id: a.item.finding_id ?? null, created },
        actor,
      });
    }
  }

  // Everything not accepted is a rejection signal: record it as a labeled pair
  // so the thresholds can be re-measured against real reviewer decisions.
  const acceptedItems = new Set(accepted.map((a) => a.item.id));
  const skipped: HostedDynamic[] = [];
  for (const item of plan.items || []) {
    if (acceptedItems.has(item.id)) continue;
    skipped.push(item.id);
    for (const memberId of item.candidate_ids) {
      await recordLabel(tx, {
        projectId: current.project_id,
        planId: current.id,
        candidateId: memberId,
        findingId: item.finding_id ?? null,
        origin: item.origin,
        score: item.score ?? null,
        confidence: item.confidence ?? null,
        decision: undecidedDecision,
        detail: {
          reason: undecidedDecision === "rejected"
            ? "reviewer left it unresolved"
            : "auto-dedupe deferred it to a person",
        },
        actor,
      });
    }
  }
  for (const u of plan.unresolved || []) {
    await recordLabel(tx, {
      projectId: current.project_id,
      planId: current.id,
      candidateId: u.candidate_id,
      findingId: null,
      origin: "model_cluster",
      score: null,
      confidence: null,
      decision: "unresolved",
      detail: { reason: u.reason },
      actor,
    });
  }

  const done = await tx.query(
    `UPDATE consolidation_plans
        SET status = 'applied', applied_by = $2, applied_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'proposed'
      RETURNING *`,
    [current.id, actor],
  );
  if (!done.rows[0]) throw conflict(`consolidation plan "${current.id}" changed while it was being applied`);

  await audit(tx, {
    actor,
    action: "consolidation.applied",
    entityType: "consolidation_plan",
    entityId: current.id,
    projectId: current.project_id,
    detail: {
      plan,
      applied,
      skipped_items: skipped,
      unresolved: (plan.unresolved || []).map((u: HostedDynamic) => u.candidate_id),
      prompt_version: current.prompt_version,
      model: current.model,
      shortlist_version: current.shortlist_version,
      thresholds: current.thresholds,
    },
  });
  await emitPlatformEvent(tx, {
    projectId: current.project_id,
    type: "consolidation.applied",
    entity: { plan_id: current.id },
    payload: { plan_id: current.id, applied: applied.length, skipped: skipped.length, actor },
  });
  return { plan: done.rows[0], applied, skipped };
}

/** Discard a proposed plan without applying any of it. */
export async function discardConsolidationPlan(tx: HostedDynamic, { planId, actor }: HostedDynamic) {
  const { rows } = await tx.query(
    `UPDATE consolidation_plans SET status = 'discarded', updated_at = now()
      WHERE id = $1 AND status = 'proposed'
      RETURNING *`,
    [planId],
  );
  if (!rows[0]) {
    const current = (await tx.query(`SELECT * FROM consolidation_plans WHERE id = $1`, [planId])).rows[0];
    if (!current) throw notFound(`no consolidation plan "${planId}"`);
    throw conflict(`consolidation plan "${planId}" was already ${current.status}`);
  }
  await audit(tx, {
    actor,
    action: "consolidation.discarded",
    entityType: "consolidation_plan",
    entityId: planId,
    projectId: rows[0].project_id,
    detail: {},
  });
  return rows[0];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The corpus one project's consolidation compares: every unreviewed (`new`)
 * finding, scored against every live finding — open, rejected, and resolved
 * alike. A rejected or resolved finding must stay comparable so a recurrence is
 * recognized rather than filed as a new defect; merging into one remains an
 * explicit reviewer choice.
 */
async function loadCorpus(ctx: HostedDynamic, projectId: HostedDynamic) {
  const findings = (await ctx.db.query(
    `SELECT * FROM findings WHERE project_id = $1 AND merged_into IS NULL ORDER BY last_seen DESC, id DESC`,
    [projectId],
  )).rows;
  return { subjects: findings.filter((f: HostedDynamic) => f.state === "new"), findings };
}

function planItem({ origin, candidate_ids, finding_id = null, proposed_title = null, confidence = null, reason = null, score = null, cluster_id = null }: HostedDynamic) {
  return {
    id: `it_${ulid()}`,
    origin,
    cluster_id,
    candidate_ids,
    finding_id,
    proposed_title,
    confidence,
    reason,
    score,
  };
}

/** Every finding id a plan touches, grouped or unresolved. */
export function referencedIds(plan: HostedDynamic) {
  const ids = new Set();
  for (const i of plan?.items || []) for (const id of i.candidate_ids || []) ids.add(id);
  for (const u of plan?.unresolved || []) ids.add(u.candidate_id);
  return ids;
}

/**
 * A digest of the findings a plan covers. Re-applying a plan whose findings were
 * reviewed, merged, retitled, or re-keyed since it was proposed fails cleanly on
 * this rather than merging stale ids. (The plan's "candidates" are its grouping
 * subjects — unreviewed findings — which is why the wire names survived the
 * collapse of the bug-candidate entity.)
 */
export function candidateDigest(rows: HostedDynamic) {
  const parts = [...rows]
    .map((f) => [f.id, f.state, f.merged_into ?? "", f.title ?? "", stamp(f.updated_at)].join(""))
    .sort();
  return crypto.createHash("sha256").update(parts.join("")).digest("hex");
}

function stamp(v: HostedDynamic) {
  if (v == null) return "";
  return String(v instanceof Date ? v.getTime() : v);
}

function stampOf(v: HostedDynamic) {
  if (v == null) return 0;
  return v instanceof Date ? v.getTime() : Number(v) || 0;
}

function stripNulls(o: HostedDynamic) {
  // json_patch is RFC-7386 merge-patch: a null value DELETES the key rather than
  // setting it, so a null provenance field must simply not be written.
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}

async function recordLabel(tx: HostedDynamic, { projectId, planId, candidateId, findingId, origin, score, confidence, decision, detail, actor }: HostedDynamic) {
  await tx.query(
    `INSERT INTO consolidation_labels
       (id, project_id, plan_id, subject_finding_id, finding_id, origin, score, confidence, decision, detail, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [ulid(), projectId, planId, candidateId, findingId, origin, score, confidence, decision, detail || {}, actor],
  );
}

function pick(override: HostedDynamic, fallback: HostedDynamic) {
  if (override == null) return fallback ?? null;
  const s = String(override).trim();
  return s ? s : null;
}

function clampTitle(s: HostedDynamic) {
  const line = String(s || "").split("\n").find((l) => l.trim())?.trim() || "";
  return line.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || null;
}

function round(n: HostedDynamic) {
  return Math.round(n * 1000) / 1000;
}
