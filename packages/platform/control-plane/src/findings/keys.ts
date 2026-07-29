// Deterministic candidate identity: normalization, exact lookup keys, and the
// normalized match text used later by consolidation.
//
// The algorithms are the frozen P0 set (`tests/core/findings/spec.ts`) and live
// in ONE place: `@playtest/core/findings`, parameterized by an opaque scope id.
// This module is the hosted adapter over that public export — the hosted scope
// id is the `project_id`, the local ledger's is its opaque `workspace_id`, so
// hosted and local never share key VALUES while sharing the key ALGORITHM and
// its versions. `tests/unit/findings-keys.test.ts` still asserts parity with
// the frozen spec over the P0 fixture corpus, so a regression anywhere on this
// path fails the gate.
//
// docs/contracts/hosted.md: model-authored text (title, expected/observed prose) and the
// model-chosen category NEVER enter a key. Only trusted, recorded context does —
// project, story, the deterministic signal type, and a locus derived from
// recorded fields. Keys are lookup keys, never durable identity; findings and
// candidates keep opaque ids.
//
// The contract also requires that a version bump can recompute stored keys, so every
// algorithm carries an explicit version that is stored on each row.
import {
  deriveCandidateKeys as deriveScopedCandidateKeys,
  exactKeys as scopedExactKeys,
} from "@playtest/core/findings";
import type { FindingClaim, FindingLocus } from "@playtest/core/findings";
import type { DynamicJson } from "../types.ts";

export {
  CATEGORIES,
  VERSIONS,
  coarseSignalType,
  normalizeText,
  normalizeLocus,
  hasExactKeys,
  matchText,
} from "@playtest/core/findings";

interface Locus {
  route?: unknown;
  step_locus?: unknown;
  status_class?: unknown;
}
interface Claim {
  expected?: unknown;
  observed?: unknown;
  title?: unknown;
}
interface CandidateIdentity {
  projectId: string;
  storyId: string | null;
  signalType: string | null;
  locus: Locus | null;
}

/**
 * The two versioned exact lookup keys for one candidate identity, or nulls when
 * the candidate carries no deterministic signal (D4: those rely on P3
 * consolidation instead).
 *
 * @param {{projectId: string, storyId: string|null, signalType: string|null,
 *          locus: object|null}} identity
 * @returns {{strict: string|null, loose: string|null, normalized_locus: string|null}}
 */
export function exactKeys({ projectId, storyId, signalType, locus }: CandidateIdentity) {
  return scopedExactKeys({ scopeId: projectId, storyId, signalType, locus: locus as FindingLocus | null }); // SAFETY: the shared normalizer stringifies every locus field it reads
}

/**
 * Everything derived from one candidate identity + claim, ready to store. The
 * single place intake computes identity columns, so the recompute routine and
 * the write path cannot drift.
 */
export function deriveCandidateKeys({
  projectId,
  storyId,
  signalType,
  locus,
  category,
  claim
}: CandidateIdentity & { category: unknown; claim: Claim | null }): DynamicJson {
  return deriveScopedCandidateKeys({
    scopeId: projectId,
    storyId,
    signalType,
    locus: locus as FindingLocus | null, // SAFETY: the shared normalizer stringifies every locus field it reads
    category: category as string | null, // SAFETY: category only ever feeds the match-text normalizer
    claim: claim as FindingClaim | null, // SAFETY: the shared normalizer stringifies every claim field it reads
  });
}
