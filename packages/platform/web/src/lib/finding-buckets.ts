// The findings lifecycle, in ONE place.
//
// The API keeps its five states (new / reopened / accepted / rejected /
// resolved). The console shows four disjoint buckets — Needs review · Open ·
// Resolved · Rejected — and this module is the only mapping between them.
//
// `new` is a machine-filed claim no person has judged: it gets its own bucket
// and its own words, because collapsing the old "suspected bugs" queue made
// triage a STATE of a finding rather than a separate place. Open deliberately
// still holds `accepted`: a confirmed
// finding is open work — confirming it says "this is real", not "this is
// done".
//
// Kept DOM-free so the hermetic gate can assert the mapping without a browser
// (sibling of nav.ts / redirects.ts / vocab.ts).

export const FINDING_BUCKETS: WebDynamic = {
  review: {
    label: "Needs review",
    state: "new",
    blurb: "filed from run evidence — confirm the real ones, dismiss the rest; nothing is a confirmed finding until a person says so",
  },
  open: {
    label: "Open",
    state: "reopened,accepted",
    blurb: "confirmed as real by a person, or resolved once and then seen again",
  },
  resolved: {
    label: "Resolved",
    state: "resolved",
    blurb: "fixed, or otherwise finished with",
  },
  rejected: {
    label: "Rejected",
    state: "rejected",
    blurb: "judged not a bug, a duplicate, or not worth fixing — matching evidence stays suppressed",
  },
};

export const DEFAULT_BUCKET = "open";

// Old filter names keep working: `?filter=dismissed` was the rejected bucket's
// first name, and `new` reads naturally for the needs-review bucket.
const BUCKET_ALIASES: WebDynamic = { dismissed: "rejected", new: "review" };

/** Resolve a `?filter=` value to a real bucket id, falling back to the default. */
export function bucketId(raw: WebDynamic) {
  const id = BUCKET_ALIASES[raw] || raw;
  return FINDING_BUCKETS[id] ? id : DEFAULT_BUCKET;
}

/**
 * Fold the API's per-state counts ({new: 3, accepted: 1, …}) into per-bucket
 * tallies ({review: 3, open: 1, …}). Lives here so the seg tabs and any badge
 * count with the same partition the buckets themselves declare.
 */
export function bucketCounts(stateCounts: WebDynamic = {}) {
  return Object.fromEntries(Object.entries(FINDING_BUCKETS).map(([id, b]: WebDynamic) =>
    [id, b.state.split(",").reduce((n: WebDynamic, s: WebDynamic) => n + (Number(stateCounts[s]) || 0), 0)]));
}

// The user-facing words over the five API states.
const STATE_LABEL: WebDynamic = {
  new: "Needs review",
  reopened: "Reopened",
  accepted: "Confirmed",
  rejected: "Rejected",
  resolved: "Resolved",
};

/** A finding's state in the console's words ("accepted" reads as Confirmed). */
export const findingStateLabel = (state: WebDynamic) => STATE_LABEL[state] || state || "Needs review";

// Every state word is a term of art; the definition rides on the chip as a
// tooltip, the same pattern the runs table uses (lib/vocab.js outcomeGloss).
const STATE_GLOSS: WebDynamic = {
  new: "filed by the system from run evidence — not a confirmed finding until a person reviews it",
  reopened: "resolved once, then the same defect recurred",
  accepted: "a person confirmed this is a real defect",
  rejected: "judged not a bug, a duplicate, or not worth fixing — matching evidence is absorbed silently",
  resolved: "fixed, or otherwise finished with",
};

export const findingStateGloss = (state: WebDynamic) => STATE_GLOSS[state] || null;

/**
 * The chip tone for a state: `new`-ish work needs attention, a confirmed
 * finding is acknowledged, resolved wears the pass green (finished work, good
 * news), and rejected is muted. Triage state is NOT a run status — these never
 * wear the ✓/✗ glyph vocabulary.
 */
export function findingStateTone(state: WebDynamic) {
  if (state === "accepted") return "state-accepted";
  if (state === "resolved") return "state-resolved";
  if (state === "rejected") return "state-muted";
  return "state-new";
}
