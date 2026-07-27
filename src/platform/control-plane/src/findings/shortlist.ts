// Deterministic retrieval for consolidation (docs/contracts/hosted.md).
// PURE: no database, no clock, no model, no I/O.
//
// The chain is match text → rare-word-weighted token overlap → top-k shortlist →
// score routing → connected-component clusters. Only the ambiguous middle ever
// reaches a model call, and the routing decision itself is made here, before any
// call is issued.
//
// This is the runtime implementation of the algorithms frozen by P0
// (`tests/core/findings/spec.ts`). `tests/unit/findings-shortlist.test.ts`
// asserts parity with the frozen spec over the P0 fixture corpus, so a change
// here that diverges from the spec fails the gate rather than silently
// re-partitioning findings.
//
// A matching category raises similarity (the category word is the first token of
// the match text) but never gates comparison: the model may label one defect
// differently across runs, and consolidation must still converge.
import { matchText, normalizeText } from "./keys.ts";
import type { DynamicJson } from "../types.ts";

export interface RetrievalItem {
  id: string;
  role: string;
  tokens: Set<string>;
}
export interface Neighbor {
  id: string;
  role: string;
  score: number;
}

/** Retrieval algorithm version, stored on every plan for later recomputation. */
export const SHORTLIST_VERSION = "shortlist-v1";

/**
 * Measured defaults (see tests/core/findings/README.md). Every value is
 * overridable server-side through `config.consolidation`.
 */
export const DEFAULT_RETRIEVAL = Object.freeze({
  k: 5,
  floor: 0.25,
  autoSuggest: 0.6,
  maxClusterItems: 15,
  maxPromptBytes: 24000,
  maxClusters: 20,
});

// Stopwords, frozen with the P0 spec. Grammar plus the generic anomaly
// vocabulary that appears in almost every failure claim (it must not create
// similarity between unrelated defects) plus the normalization placeholders.
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "is", "was", "are", "were", "be", "been", "it", "its", "this", "that",
  "as", "by", "from", "not", "no", "did", "does", "do", "has", "have", "had",
  "then", "than", "still", "after", "when", "which", "into", "out", "up", "off",
  "page", "user", "click", "clicked", "button", "field", "shows", "showed",
  "again", "yet",
  "server", "http", "error", "errors", "endpoint", "returned", "return",
  "request", "requests", "response", "status", "api", "www",
  "num", "uuid", "hex", "time",
]);

/** Tokenize a normalized match text: alphanumerics >= 3 chars, minus stopwords. */
export function tokenize(text: unknown): Set<string> {
  const seen = new Set<string>();
  for (const t of String(text || "").split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOP.has(t)) seen.add(t);
  }
  return seen;
}

/**
 * The match text for a finding that has none stored. Intake computes and stores
 * `findings.match_text`; a finding written before that column existed carries the
 * same structured fields inside its summary, so its text is derived on read with
 * the same frozen function rather than being silently unmatchable.
 */
export function findingMatchText(finding: DynamicJson | null | undefined): string {
  const s = finding?.summary || {};
  return matchText({
    category: s.category ?? null,
    locus: { route: s.route ?? null },
    claim: { expected: s.expected ?? null, observed: s.observed ?? null, title: finding?.title ?? null },
  });
}

/**
 * A retrieval item: an opaque id, a role, and its tokens. Routing distinguishes
 * an unreviewed subject from a finding a person has already touched (role
 * "finding"); scoring does not look at the role at all.
 */
export function retrievalItem(
  { id, role = "candidate", text }: { id: string; role?: string; text: unknown }
): RetrievalItem {
  return { id, role, tokens: tokenize(normalizeText(text)) };
}

/** Smoothed inverse document frequency over a set of retrieval items. */
export function idfTable(items: RetrievalItem[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const item of items) {
    for (const t of item.tokens) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = items.length;
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, Math.log((n + 1) / (f + 1)) + 1);
  return idf;
}

/**
 * Rare-word-weighted token overlap: cosine similarity between two items'
 * idf-weighted token sets. In [0, 1]; higher is more similar.
 */
export function similarity(a: RetrievalItem, b: RetrievalItem, idf: Map<string, number>): number {
  const w = (t: string) => idf.get(t) ?? 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const t of a.tokens) na += w(t) ** 2;
  for (const t of b.tokens) {
    nb += w(t) ** 2;
    if (a.tokens.has(t)) dot += w(t) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Top-k neighbors of `target` among `pool`, above the similarity floor, ordered
 * by descending score then id. Ties break on id so the shortlist is stable
 * across processes and row orderings.
 */
export function shortlist(
  target: RetrievalItem,
  pool: RetrievalItem[],
  idf: Map<string, number>,
  { k = DEFAULT_RETRIEVAL.k, floor = DEFAULT_RETRIEVAL.floor }: { k?: number; floor?: number } = {}
): Neighbor[] {
  return pool
    .filter((p) => p.id !== target.id)
    .map((p) => ({ id: p.id, role: p.role ?? "candidate", score: similarity(target, p, idf) }))
    .filter((n) => n.score >= floor)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}

/**
 * Route one candidate BEFORE any model call (docs/contracts/hosted.md, step 2).
 *
 *   "suggestion" — a single existing-finding neighbor at/above the auto-suggest
 *                  threshold: attach-to-that-finding is proposed with no call.
 *   "new"        — no neighbor at/above the floor anywhere: a new finding is
 *                  proposed with no call.
 *   "cluster"    — the ambiguous middle; goes into one cluster call.
 */
export function route(
  neighbors: Neighbor[] = [],
  { autoSuggest = DEFAULT_RETRIEVAL.autoSuggest }: { autoSuggest?: number } = {}
): "suggestion" | "new" | "cluster" {
  const findingNeighbors = neighbors.filter((n) => n.role === "finding");
  if (findingNeighbors.length === 1 && findingNeighbors[0]!.score >= autoSuggest) return "suggestion"; // TODO(ts): The length guard proves this neighbor exists.
  if (neighbors.length === 0) return "new";
  return "cluster";
}

/**
 * Connected components of shortlist edges. Because a cluster is a connected
 * component, one defect cannot be split across two model calls.
 * `edges` is a list of `{ a, b }` candidate-id pairs above the floor.
 */
export function clusters(candidateIds: string[], edges: Array<{ a: string; b: string }>): string[][] {
  const parent = new Map<string, string>(candidateIds.map((id) => [id, id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x) as string) as string);
      x = parent.get(x) as string;
    }
    return x;
  };
  for (const { a, b } of edges) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of candidateIds) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id); // TODO(ts): The preceding has/set branch guarantees this group exists.
  }
  return [...groups.values()].map((g) => [...g].sort()).sort((x, y) => x[0]!.localeCompare(y[0]!)); // TODO(ts): Candidate groups are non-empty by construction.
}

/**
 * Split a component that exceeds the per-call item cap into ordered chunks. A
 * component is only split when it is too large to send at all; the split is
 * recorded on the plan so an over-large cluster is visible rather than silently
 * truncated.
 */
export function capClusters(
  components: string[][],
  { maxClusterItems = DEFAULT_RETRIEVAL.maxClusterItems }: { maxClusterItems?: number } = {}
): Array<{ ids: string[]; split: boolean }> {
  const out: Array<{ ids: string[]; split: boolean }> = [];
  for (const ids of components) {
    if (ids.length <= maxClusterItems) {
      out.push({ ids, split: false });
      continue;
    }
    for (let i = 0; i < ids.length; i += maxClusterItems) {
      out.push({ ids: ids.slice(i, i + maxClusterItems), split: true });
    }
  }
  return out;
}

/** Coarse token estimate for a cluster's compact claim payload. */
export function estimateTokens(str: unknown): number {
  return Math.ceil(String(str || "").length / 4);
}
