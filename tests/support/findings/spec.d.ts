export declare const VERSIONS: Readonly<{
    locus_norm: "locus-norm-v1";
    key_algo: "key-v1";
    match_text: "match-text-v1";
    shortlist: "shortlist-v1";
}>;
export declare const RETRIEVAL: Readonly<{
    k: 5;
    floor: 0.25;
    auto_suggest: 0.6;
}>;
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
/** Lowercase and strip volatile run-specific tokens. Frozen: match-text-v1. */
export declare function normalizeText(value: unknown): string;
/**
 * Derive the normalized locus from recorded fields only:
 * route template, step/selector locus, and status class, after stripping
 * run-specific ids/numbers/timestamps. Frozen: locus-norm-v1.
 */
export declare function normalizeLocus(locus?: FindingLocus): string;
/** True when the candidate is grounded in a deterministic anomaly signal. */
export declare function hasExactKeys(candidate: FindingItem): boolean;
/** strict = sha256(project ‖ story ‖ signal_type ‖ normalized_locus). */
export declare function strictKey(candidate: FindingItem): string | null;
/** loose = sha256(project ‖ signal_type ‖ normalized_locus). Story dropped. */
export declare function looseKey(candidate: FindingItem): string | null;
/**
 * Compare an incoming candidate against an existing finding/candidate.
 * Returns { strict, loose } booleans. A strict hit implies a loose hit.
 */
export declare function keyMatch(incoming: FindingItem, existing: FindingItem): {
    strict: boolean;
    loose: boolean;
};
/** Normalized match text built from structured fields. Frozen: match-text-v1. */
export declare function matchText(item: FindingItem): string;
/** Tokenize match text: alphanumerics ≥3 chars, minus stopwords. */
export declare function tokenize(item: FindingItem): Set<string>;
/** Smoothed inverse document frequency over a set of items. */
export declare function idfTable(items: FindingItem[]): Map<string, number>;
/**
 * Rare-word-weighted token overlap: cosine similarity between the two items'
 * idf-weighted token sets. In [0, 1]; higher = more similar.
 */
export declare function similarity(a: FindingItem, b: FindingItem, idf: Map<string, number>): number;
/**
 * Top-k neighbors of `target` among `pool`, scored by rare-word overlap,
 * filtered to the similarity floor, sorted by descending score then id.
 * `pool` items may be candidates or existing findings; each carries `.id`.
 */
export declare function shortlist(target: FindingItem, pool: FindingItem[], idf: Map<string, number>, { k, floor }?: {
    k?: number;
    floor?: number;
}): {
    id: string;
    role: string;
    score: number;
}[];
/**
 * Route one candidate given its exact-key state and shortlist neighbors.
 *   "append"     — strict key hit against an existing finding (no model call).
 *   "suggestion" — loose key hit, or a single existing-finding neighbor at/above
 *                  the auto-suggest threshold (no model call).
 *   "new"        — no neighbor at/above the floor (no model call).
 *   "cluster"    — ambiguous middle; goes into a cluster for one model call.
 */
export declare function route(_candidate: FindingItem, { strictHit, looseHit, neighbors }?: {
    strictHit?: boolean;
    looseHit?: boolean;
    neighbors?: Neighbor[];
}): "append" | "cluster" | "new" | "suggestion";
/**
 * Connected components of shortlist edges among the clustered candidates.
 * Because clusters are connected components, one defect cannot be split across
 * two model calls.
 * `edges` is a list of { a, b } candidate-id pairs above the floor.
 */
export declare function clusters(candidateIds: string[], edges: Array<{
    a: string;
    b: string;
}>): string[][];
/** Coarse token estimate for a cluster's compact claim payload. */
export declare function estimateTokens(str: unknown): number;
