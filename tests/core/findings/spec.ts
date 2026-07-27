// FROZEN P0 REFERENCE SPEC — findings intake and semantic consolidation.
//
// These are pure, model-free reference implementations of the algorithms named
// contracted in docs/contracts/hosted.md (exact keys, match text, shortlist).
// They are frozen by the fixture corpus in ./corpus.ts and become the executable
// spec that later phases (P1–P3) must reproduce.
//
// IMPORTANT: this module lives under tests/ and must NOT be imported by any
// runtime code path (src/**). P0 changes no runtime behavior. When P2/P3 wire
// the real hosted implementation, it must match these outputs on this corpus.
//
// Algorithm versions are explicit so a later bump can recompute stored keys
// (docs/contracts/hosted.md: "because all inputs are recorded, a version bump recomputes stored
// keys, so older findings never silently stop matching").
import crypto from "node:crypto";

export const VERSIONS = Object.freeze({
  locus_norm: "locus-norm-v1",
  key_algo: "key-v1",
  match_text: "match-text-v1",
  shortlist: "shortlist-v1",
});

// Retrieval + routing constants. Measured defaults; the rationale and the
// scored pairs behind them are in ./README.md.
export const RETRIEVAL = Object.freeze({
  k: 5, // shortlist size
  floor: 0.25, // similarity floor: below this everywhere ⇒ proposed new finding
  auto_suggest: 0.6, // a single finding neighbor at/above this ⇒ pre-attached suggestion
});

export interface FindingLocus {
  route?: string | null;
  step_locus?: string | null;
  status_class?: string | null;
}

export interface FindingItem {
  id: string;
  role?: string;
  project_id: string;
  story_id: string;
  kind: string;
  title: string;
  expected: string;
  observed: string;
  signal_type: string | null;
  locus: FindingLocus | null;
  [key: string]: unknown;
}

export interface Neighbor {
  id: string;
  role: string;
  score: number;
}

const SEP = ""; // matches the existing hosted extractor's key separator

const STOP = new Set([
  // grammar
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "is", "was", "are", "were", "be", "been", "it", "its", "this", "that",
  "as", "by", "from", "not", "no", "did", "does", "do", "has", "have", "had",
  "then", "than", "still", "after", "when", "which", "into", "out", "up", "off",
  "page", "user", "click", "clicked", "button", "field", "shows", "showed",
  "again", "yet",
  // generic anomaly vocabulary — present in almost every failure claim, so it
  // must not create similarity between unrelated defects.
  "server", "http", "error", "errors", "endpoint", "returned", "return",
  "request", "requests", "response", "status", "api", "www",
  // normalization placeholders (see normalizeText) — never discriminating.
  "num", "uuid", "hex", "time",
]);

// ---------------------------------------------------------------------------
// Normalization (frozen). Strips run-specific ids, numbers, and timestamps so
// two runs of the same defect surface produce identical text/keys.
// ---------------------------------------------------------------------------

/** Lowercase and strip volatile run-specific tokens. Frozen: match-text-v1. */
export function normalizeText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, " <uuid> ")
    .replace(/\b[0-9a-f]{12,}\b/gi, " <hex> ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ][0-9:.+\-z]+)?\b/gi, " <time> ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " <num> ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * Derive the normalized locus from recorded fields only:
 * route template, step/selector locus, and status class, after stripping
 * run-specific ids/numbers/timestamps. Frozen: locus-norm-v1.
 */
export function normalizeLocus(locus: FindingLocus = {}) {
  // Route templates ignore the query string: it carries run-specific ids and
  // filter values, not the defect surface ("route template").
  const route = locus.route ? String(locus.route).split("?")[0] : null;
  const parts = [route, locus.step_locus, locus.status_class]
    .filter((p) => p != null && p !== "")
    .map((p) => normalizeText(p));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Exact keys. Model text and the model-chosen category never enter
// a key. Candidates without a deterministic signal carry no exact keys.
// ---------------------------------------------------------------------------

/** True when the candidate is grounded in a deterministic anomaly signal. */
export function hasExactKeys(candidate: FindingItem) {
  return Boolean(candidate.signal_type) && Boolean(candidate.locus);
}

/** strict = sha256(project ‖ story ‖ signal_type ‖ normalized_locus). */
export function strictKey(candidate: FindingItem) {
  if (!hasExactKeys(candidate)) return null;
  return sha256([
    candidate.project_id,
    candidate.story_id,
    candidate.signal_type,
    normalizeLocus(candidate.locus!), // TODO(ts): hasExactKeys proves the candidate has a locus
  ].join(SEP));
}

/** loose = sha256(project ‖ signal_type ‖ normalized_locus). Story dropped. */
export function looseKey(candidate: FindingItem) {
  if (!hasExactKeys(candidate)) return null;
  return sha256([
    candidate.project_id,
    candidate.signal_type,
    normalizeLocus(candidate.locus!), // TODO(ts): hasExactKeys proves the candidate has a locus
  ].join(SEP));
}

/**
 * Compare an incoming candidate against an existing finding/candidate.
 * Returns { strict, loose } booleans. A strict hit implies a loose hit.
 */
export function keyMatch(incoming: FindingItem, existing: FindingItem) {
  const strict = hasExactKeys(incoming) && hasExactKeys(existing)
    && strictKey(incoming) === strictKey(existing);
  const loose = hasExactKeys(incoming) && hasExactKeys(existing)
    && looseKey(incoming) === looseKey(existing);
  return { strict, loose };
}

// ---------------------------------------------------------------------------
// Match text + rare-word-weighted shortlist. Deterministic, no
// model call, no index. Category words are part of the text so a shared
// category raises the score but never gates comparison.
// ---------------------------------------------------------------------------

/** Normalized match text built from structured fields. Frozen: match-text-v1. */
export function matchText(item: FindingItem) {
  return normalizeText([
    item.kind,
    item.locus?.route,
    item.expected,
    item.observed,
    item.title,
  ].filter(Boolean).join(" "));
}

/** Tokenize match text: alphanumerics ≥3 chars, minus stopwords. */
export function tokenize(item: FindingItem) {
  const seen = new Set<string>();
  for (const t of matchText(item).split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOP.has(t)) seen.add(t);
  }
  return seen;
}

/** Smoothed inverse document frequency over a set of items. */
export function idfTable(items: FindingItem[]) {
  const df = new Map<string, number>();
  for (const item of items) {
    for (const t of tokenize(item)) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = items.length;
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, Math.log((n + 1) / (f + 1)) + 1);
  return idf;
}

/**
 * Rare-word-weighted token overlap: cosine similarity between the two items'
 * idf-weighted token sets. In [0, 1]; higher = more similar.
 */
export function similarity(a: FindingItem, b: FindingItem, idf: Map<string, number>) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const w = (t: string) => idf.get(t) ?? 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const t of ta) na += w(t) ** 2;
  for (const t of tb) {
    nb += w(t) ** 2;
    if (ta.has(t)) dot += w(t) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Top-k neighbors of `target` among `pool`, scored by rare-word overlap,
 * filtered to the similarity floor, sorted by descending score then id.
 * `pool` items may be candidates or existing findings; each carries `.id`.
 */
export function shortlist(
  target: FindingItem,
  pool: FindingItem[],
  idf: Map<string, number>,
  { k = RETRIEVAL.k, floor = RETRIEVAL.floor }: { k?: number; floor?: number } = {}
) {
  return pool
    .filter((p) => p.id !== target.id)
    .map((p) => ({ id: p.id, role: p.role ?? "candidate", score: similarity(target, p, idf) }))
    .filter((n) => n.score >= floor)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}

// ---------------------------------------------------------------------------
// Score routing + clustering. Route candidates BEFORE any
// model call; only the ambiguous middle is clustered for one call per cluster.
// ---------------------------------------------------------------------------

/**
 * Route one candidate given its exact-key state and shortlist neighbors.
 *   "append"     — strict key hit against an existing finding (no model call).
 *   "suggestion" — loose key hit, or a single existing-finding neighbor at/above
 *                  the auto-suggest threshold (no model call).
 *   "new"        — no neighbor at/above the floor (no model call).
 *   "cluster"    — ambiguous middle; goes into a cluster for one model call.
 */
export function route(
  candidate: FindingItem,
  { strictHit = false, looseHit = false, neighbors = [] }: {
    strictHit?: boolean;
    looseHit?: boolean;
    neighbors?: Neighbor[];
  } = {}
) {
  if (strictHit) return "append";
  if (looseHit) return "suggestion";
  const findingNeighbors = neighbors.filter((n) => n.role === "finding");
  if (findingNeighbors.length === 1 && findingNeighbors[0]!.score >= RETRIEVAL.auto_suggest) { // TODO(ts): length check proves the first neighbor exists
    return "suggestion";
  }
  if (neighbors.length === 0) return "new";
  return "cluster";
}

/**
 * Connected components of shortlist edges among the clustered candidates.
 * Because clusters are connected components, one defect cannot be split across
 * two model calls.
 * `edges` is a list of { a, b } candidate-id pairs above the floor.
 */
export function clusters(candidateIds: string[], edges: Array<{ a: string; b: string }>) {
  const parent = new Map(candidateIds.map((id) => [id, id]));
  const find = (x: string) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!); // TODO(ts): candidate ids and their parents are initialized together
      x = parent.get(x)!; // TODO(ts): candidate ids and their parents are initialized together
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const { a, b } of edges) {
    if (parent.has(a) && parent.has(b)) union(a, b);
  }
  const groups = new Map<string, string[]>();
  for (const id of candidateIds) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id); // TODO(ts): the group is initialized immediately before this lookup
  }
  return [...groups.values()].map((g) => g.sort()).sort((x, y) => x[0]!.localeCompare(y[0]!)); // TODO(ts): every connected component contains at least one candidate id
}

/** Coarse token estimate for a cluster's compact claim payload. */
export function estimateTokens(str: unknown) {
  return Math.ceil(String(str || "").length / 4);
}
