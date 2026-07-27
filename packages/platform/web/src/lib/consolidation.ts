// Pure review logic for a consolidation plan (findings BUILD_PLAN P3 item 6).
//
// DOM-free on purpose, like lib/caseform.js and lib/finding-buckets.js: the
// decision rules a reviewer's clicks produce are the part worth pinning in the
// offline gate, so `tests/unit/web-consolidation.test.ts` can assert them
// without a browser.
//
// The reviewer has exactly three moves per item — accept it, edit its target or
// title and accept that, or leave it unresolved — and the payload this builds is
// the only thing the server will act on.

/**
 * Human scope line shown BEFORE a reviewer confirms a consolidation run.
 * Reads as what will happen, not as counters: zero-valued middle parts are
 * dropped, and the mechanical details live in the
 * page's technical-details fold, not the headline.
 */
export function scopeLine(preview: WebDynamic) {
  const s = preview?.scope || {};
  const parts: WebDynamic = [`${count(s.unassigned_candidates, "report")} awaiting review`];
  if (s.suggestions) parts.push(`${s.suggestions} matched by score`);
  if (s.proposed_new) parts.push(`${s.proposed_new} clearly distinct`);
  if (s.clusters) {
    parts.push(`${count(s.clusters, "group")} to verify — ${count(s.clusters, "model call")}, ~${s.est_input_tokens} tokens`);
  } else {
    parts.push("no model call needed");
  }
  return parts.join(" · ");
}

/** True when running this plan will spend money. */
export function requiresModel(preview: WebDynamic) {
  return Boolean(preview?.requires_model);
}

/** Post-hoc usage line, once the gateway has reported it. */
export function usageLine(plan: WebDynamic) {
  const u = plan?.usage;
  if (!u || !u.calls) return "no model call — every report was routed by score alone";
  const cost = u.cost_usd ? ` · $${u.cost_usd.toFixed(4)}` : "";
  return `${count(u.calls, "cluster call")} · ${u.in} in / ${u.out} out tokens${cost}`;
}

/** Who initiated a plan, in one word the history table reads at a glance. */
export function ranBy(plan: WebDynamic) {
  const by = plan?.created_by;
  if (by?.system === "auto_dedupe") return "auto-dedupe";
  if (by?.system) return "system";
  return "manual";
}

/** How an item's target reads on the review screen. */
export function itemTarget(item: WebDynamic) {
  if (item.finding_id) {
    return { kind: "existing", finding_id: item.finding_id, label: item.finding?.title || item.finding_id };
  }
  return { kind: "new", finding_id: null, label: item.proposed_title || "(untitled new group)" };
}

/** Where an item came from, in the reviewer's words. */
export function originLabel(item: WebDynamic) {
  if (item.origin === "shortlist_suggestion") return `scored match (${fmtScore(item.score)}) — no model call`;
  if (item.origin === "shortlist_new") return "no neighbor above the floor — no model call";
  return `model cluster${item.confidence ? ` · ${item.confidence} confidence` : ""}`;
}

/**
 * The starting decision for every item: accept as proposed. A reviewer downgrades
 * to `skip` or edits the target/title from here.
 */
export function initialDecisions(plan: WebDynamic) {
  const out: WebDynamic = new Map();
  for (const item of plan?.items || []) {
    const target = itemTarget(item);
    out.set(item.id, {
      action: "accept",
      finding_id: target.kind === "existing" ? target.finding_id : null,
      proposed_title: target.kind === "existing" ? null : item.proposed_title || "",
    });
  }
  return out;
}

/** True when the reviewer changed an item's target or title. */
export function isEdited(item: WebDynamic, decision: WebDynamic) {
  if (!decision) return false;
  const proposedFinding = item.finding_id ?? null;
  const chosenFinding = decision.finding_id || null;
  if (proposedFinding !== chosenFinding) return true;
  if (chosenFinding) return false;
  return norm(decision.proposed_title) !== norm(item.proposed_title);
}

/**
 * The apply payload. Skipped items are omitted entirely — the server records
 * anything not accepted as a rejection label and leaves its candidates
 * unassigned.
 *
 * Throws when an accepted new group has no title, so the reviewer sees the
 * problem before the request rather than as a 400.
 */
export function decisionPayload(plan: WebDynamic, decisions: WebDynamic) {
  const out: WebDynamic = [];
  for (const item of plan?.items || []) {
    const d = decisions.get(item.id);
    if (!d || d.action !== "accept") continue;
    const findingId = d.finding_id || null;
    const title = norm(d.proposed_title);
    if (!findingId && !title) {
      throw new Error(`"${itemTarget(item).label}" is a new finding and needs a title`);
    }
    out.push({
      item_id: item.id,
      action: "accept",
      ...(findingId ? { finding_id: findingId } : { proposed_title: title }),
    });
  }
  return out;
}

/** Counts of what an apply will do, for the confirm button's label. */
export function applySummary(plan: WebDynamic, decisions: WebDynamic) {
  let accepted = 0;
  let edited = 0;
  let candidates = 0;
  for (const item of plan?.items || []) {
    const d = decisions.get(item.id);
    if (!d || d.action !== "accept") continue;
    accepted += 1;
    candidates += item.candidate_ids.length;
    if (isEdited(item, d)) edited += 1;
  }
  const skipped = (plan?.items || []).length - accepted;
  return { accepted, skipped, edited, candidates };
}

function fmtScore(s: WebDynamic) {
  return s == null ? "—" : Number(s).toFixed(2);
}

function norm(s: WebDynamic) {
  return String(s ?? "").trim();
}

function count(n: WebDynamic, noun: WebDynamic) {
  const v = Number(n || 0);
  return `${v} ${noun}${v === 1 ? "" : "s"}`;
}
