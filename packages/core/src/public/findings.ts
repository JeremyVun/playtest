// Supported entry point: the local (suite-scoped) findings ledger.
// See docs/contracts/interfaces.md#local-findings-ledger.
export {
  LEDGER_DIR,
  LEDGER_FILE,
  SCHEMA_VERSION,
  ledgerPath,
  openLedger,
  resolveSuiteRoot,
  sqliteSupported,
} from "../findings/ledger.ts";

export {
  acceptItem,
  intakeCandidate,
  listCandidates,
  listFindings,
  mergeFindings,
  promoteCandidate,
  rejectItem,
  resolveItem,
  showItem,
} from "../findings/intake.ts";

export {
  PLAN_FORMAT,
  PLAN_FORMAT_VERSION,
  applyPlan,
  buildPlan,
  callClusterModel,
  intakeRunCandidates,
  scanRunCandidates,
  validateClusterPlan,
} from "../findings/consolidate.ts";

export {
  CONSOLIDATION_SYSTEM,
  CONSOLIDATION_TOOL,
} from "../findings/consolidation-prompt.ts";

export { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, exportLedger } from "../findings/exports.ts";

// The pure, frozen identity and retrieval algorithms
// (tests/core/findings/spec.ts), parameterized by an opaque scope id — the
// local ledger's workspace id, or the hosted project id. The control plane
// consumes THESE exports for its keys/shortlist so the two deployments share
// one implementation; database adapters stay on each side of the boundary.
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
} from "../findings/shortlist.ts";
export type { RetrievalItem, Neighbor } from "../findings/shortlist.ts";
export {
  CATEGORIES,
  VERSIONS,
  coarseSignalType,
  normalizeText,
  normalizeLocus,
  hasExactKeys,
  exactKeys,
  matchText,
  deriveCandidateKeys,
} from "../findings/keys.ts";
export type { CandidateIdentity, FindingClaim, FindingLocus } from "../findings/keys.ts";
export type { Ledger } from "../findings/ledger.ts";
