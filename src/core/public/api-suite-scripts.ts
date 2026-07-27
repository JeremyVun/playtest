// Supported entry point: executable API suite scripts
// (docs/contracts/scripts.md).
//
// The hosted control plane and runner-agent consume the script substrate through
// this facade only — execution, the mechanical risk profile, the save-time leak
// scan, and the obligation manifest. Private implementation modules under
// ../api-suite-scripts/ are not a supported import surface.
export {
  DEFAULT_BUDGET,
  DEFAULT_TIMEOUT_MS,
  DEFECT_KINDS,
  EXIT as SCRIPT_EXIT,
  HAR_FILENAME as SCRIPT_HAR_FILENAME,
  REPORT_FILENAME as SCRIPT_REPORT_FILENAME,
  SCRIPT_CONTRACT_VERSION,
  SCRIPT_REPORT_VERSION,
  resolveScriptRun,
  runScript,
} from "../api-suite-scripts/runner.ts";

export { RISK_PROFILE_VERSION, profileScript, staticProfile, templatePath } from "../api-suite-scripts/profile.ts";
export { LEAK_RULES, describeLeakFindings, scanScriptText } from "../api-suite-scripts/leak-scan.ts";
export {
  OBLIGATION_MANIFEST_VERSION,
  OBLIGATION_SOURCES,
  OBLIGATION_STATUSES,
  accountObligations,
  deriveObligations,
  normalizeObligations,
  operationObligationId,
  policyObligationId,
  ruleObligationId,
} from "../api-suite-scripts/obligations.ts";
export {
  LEVEL_0_POLICIES,
  LEVEL_0_SPEC_FREE_POLICIES,
  defaultScriptPolicies,
  evaluateScriptGate,
  parseScriptPolicies,
  traceFromHar,
} from "../api-suite-scripts/gate.ts";
export { GUARD_CODES, READ_ONLY_METHODS } from "../api-suite-scripts/proxy.ts";
export {
  CLEANUP_POLICIES,
  DEFAULT_ACCUMULATION_CAP,
  accountCleanup,
  accountTestData,
  isRunNamespace,
  resolveCleanupPolicy,
  runNamespace,
} from "../api-suite-scripts/testdata.ts";
export { ALLOWED_BUILTINS } from "../api-suite-scripts/sandbox-hooks.ts";
export { HAR_CREATOR, HAR_VERSION, MAX_BODY_CHARS as MAX_HAR_BODY_CHARS, MAX_BODY_READ as MAX_HAR_BODY_READ } from "../api-suite-scripts/har.ts";

// ---- authoring (S2) --------------------------------------------------------
export { resolveTargetAuthorization } from "../api-suite-scripts/license.ts";
export {
  SPEC_DISCOVERY_PATHS,
  SPEC_LINK_RELS,
  SPEC_SOURCE_KINDS,
  normalizeSpecDeclaration,
  resolveSpecSource,
  specLinksFrom,
} from "../api-suite-scripts/spec-source.ts";
export {
  BRIEF_ASSET,
  CLIENT_ASSET,
  HANDOUT_VERSION,
  buildHandout,
  handoutPrompt,
  normalizeRules,
  parseInvariantRules,
  renderInvariants,
  writeHandout,
} from "../api-suite-scripts/handout.ts";
export {
  AUTHORING_OUTCOMES,
  AUTHORING_TRANSCRIPT_VERSION,
  DEFAULT_AUTHORING_BUDGET,
  digestExecution,
  evaluateRevisionDiscipline,
  parseAuthoringReply,
  prepareAuthoringJob,
  resolveAuthoringBudget,
  resolveAuthoringLicense,
  runAuthoringJob,
} from "../api-suite-scripts/authoring.ts";
export {
  AUTHORING_BUNDLE_VERSION,
  BUNDLE_MANIFEST,
  BUNDLE_SCRIPT,
  BUNDLE_TRANSCRIPT,
  readAuthoringBundle,
  replayScriptBundle,
  writeAuthoringBundle,
} from "../api-suite-scripts/bundle.ts";
export { SCRIPT_FINDING_VERSION, formatScriptFindings, scriptFindings, summarizeFindings } from "../api-suite-scripts/findings.ts";
export { loadAuthoringJob, resolveAuthoringConfig } from "../api-suite-scripts/authoring-config.ts";

// ---- lifecycle, replay, and drift (S4) -------------------------------------
export {
  SCRIPT_LIFECYCLE_VERSION,
  SCRIPT_VERSION_ORIGINS,
  SCRIPT_VERSION_STATES,
  approveScriptVersion,
  assertScriptDispatchable,
  describeScriptDiff,
  diffScriptText,
  editScriptVersion,
  rejectScriptVersion,
  scriptDispatchLicense,
  scriptFingerprint,
  scriptVersion,
} from "../api-suite-scripts/lifecycle.ts";
export {
  SCRIPT_DRIFT_REPORT_FILE,
  SCRIPT_DRIFT_REPORT_VERSION,
  SCRIPT_TRIAGE_CLASSIFICATIONS,
  buildRevisionPrompt,
  buildScriptDriftReport,
  diffOpenApiSurface,
  openApiSurface,
  parseRevisionReply,
  proposeScriptRevision,
  triageScriptReplay,
} from "../api-suite-scripts/drift.ts";

// ---- rule cards (S3) -------------------------------------------------------
export {
  CARD_ORIGINS,
  CARD_STATES,
  DEFAULT_OBSERVATION_BUDGET,
  MAX_PROPOSED_CARDS,
  MIN_PROPOSED_CARDS,
  RULE_PROPOSAL_TOOL,
  approvedCardRules,
  buildProposalPrompt,
  normalizeCard,
  normalizeProposalToolArgs,
  normalizeProposedCards,
  observableOperations,
  observeApi,
  renderObservation,
  validateProposalToolArgs,
} from "../api-suite-scripts/proposals.ts";
