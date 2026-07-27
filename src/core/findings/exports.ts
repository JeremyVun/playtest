// The portable local findings export (docs/contracts/artifacts.md#local-findings-export).
//
// The ledger FILE is not portable: it is local state, gitignored, and carries a
// workspace-scoped key space. This JSON document is the portable form, and it is
// the contract a future hosted importer reads. Documented in
// docs/contracts/artifacts.md#local-findings-export.
//
// Rules the format exists to enforce:
//
//   * Identity travels as OPAQUE ids plus their source workspace
//     (`source_workspace_id` + `source_id`), so an importer records provenance
//     instead of guessing. Records are NEVER merged by mutable title.
//   * Exact keys are exported for audit only and are explicitly marked
//     non-transferable: they are computed under the local workspace scope, so an
//     importer MUST recompute them under its own project scope from the exported
//     `signal_type` + `locus` + `story_id` using the same algorithm versions.
//   * Evidence stays references (run id, run directory, case id, step numbers).
//     No artifact bytes cross this boundary — the run bundles are the evidence.
//
// Import is deliberately NOT implemented in P5: this phase defines and ships the
// format so hosted interoperability can be built against a frozen contract.
import { VERSIONS } from "./keys.ts";
import { nowIso } from "./ledger.ts";
import { publicCandidate, publicEvidence, publicFinding } from "./intake.ts";
import type { Ledger, LedgerRow } from "./ledger.ts";

export const EXPORT_FORMAT = "playtest.findings.export";
export const EXPORT_FORMAT_VERSION = 1;

/**
 * The whole ledger as one portable JSON document.
 * @param {object} ledger open ledger
 * @returns {object}
 */
export function exportLedger(ledger: Ledger) {
  const findings = ledger.all("SELECT * FROM findings ORDER BY created_at, id").map((f: LedgerRow) => ({
    ...publicFinding(f),
    source_id: f.id,
    evidence: ledger
      .all("SELECT * FROM finding_evidence WHERE finding_id = ? ORDER BY created_at, id", [f.id])
      .map(publicEvidence),
    transitions: ledger.all(
      "SELECT from_state, to_state, reason, note, actor, created_at FROM finding_transitions WHERE finding_id = ? ORDER BY created_at, id",
      [f.id],
    ),
  }));

  const candidates = ledger
    .all("SELECT * FROM bug_candidates ORDER BY created_at, id")
    .map((c: LedgerRow) => ({ ...publicCandidate(ledger, c, { withEvidence: true }), source_id: c.id }));

  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: nowIso(),
    workspace: {
      // Opaque and stable for the life of the ledger file. It is the scope id
      // every exported key was computed under.
      id: ledger.workspaceId,
      suite_root: ledger.suiteRoot,
    },
    algorithms: {
      key_algo_version: VERSIONS.key_algo,
      locus_norm_version: VERSIONS.locus_norm,
      match_text_version: VERSIONS.match_text,
    },
    key_scope: {
      // The one sentence an importer has to obey.
      note:
        "strict_key/loose_key are scoped to workspace.id and are NOT transferable. " +
        "An importer must recompute them under its own project scope from signal_type, locus, and story_id, " +
        "using these algorithm versions. Never merge records by title.",
    },
    findings,
    candidates,
    merges: ledger.all(
      "SELECT from_finding_id, into_finding_id, actor, created_at FROM finding_merges ORDER BY created_at, id",
    ),
    suppressions: ledger.all(
      "SELECT scope, key, key_algo_version, candidate_id, reason, absorbed_count, created_at FROM bug_candidate_suppressions ORDER BY created_at, id",
    ),
  };
}
