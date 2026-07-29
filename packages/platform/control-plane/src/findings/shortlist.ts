// Deterministic retrieval for consolidation (docs/contracts/hosted.md).
// PURE: no database, no clock, no model, no I/O.
//
// The chain is match text → rare-word-weighted token overlap → top-k shortlist →
// score routing → connected-component clusters. Only the ambiguous middle ever
// reaches a model call, and the routing decision itself is made here, before any
// call is issued.
//
// The algorithms are the frozen P0 set (`tests/core/findings/spec.ts`) and live
// in ONE place: `@playtest/core/findings`; this module re-exports them so hosted
// call sites keep their import path. `tests/unit/findings-shortlist.test.ts`
// still asserts parity with the frozen spec over the P0 fixture corpus, so a
// regression anywhere on this path fails the gate rather than silently
// re-partitioning findings.
//
// Server-side, every DEFAULT_RETRIEVAL value is overridable through
// `config.consolidation`.
//
// A matching category raises similarity (the category word is the first token of
// the match text) but never gates comparison: the model may label one defect
// differently across runs, and consolidation must still converge.
export {
  SHORTLIST_VERSION,
  DEFAULT_RETRIEVAL,
  tokenize,
  findingMatchText,
  retrievalItem,
  idfTable,
  similarity,
  shortlist,
  route,
  clusters,
  capClusters,
  estimateTokens,
} from "@playtest/core/findings";
export type { RetrievalItem, Neighbor } from "@playtest/core/findings";
