-- Verified auto-resolve for judgment-call findings
-- (docs/contracts/hosted.md, "Auto-resolve").
--
-- The keyless tier stops inferring "fixed" from a pass verdict: the grader
-- grades fresh and is never shown the open findings ledger, and checked
-- (act-mode) runs are not graded at all, so absence-of-mention proved nothing.
-- The sweep now re-checks the finding's own claim against the candidate run's
-- recorded page content through the platform LLM gateway; a verified absence
-- stamps with its own method so provenance says WHAT closed the triple.
--
-- SQLite cannot alter a CHECK constraint, so the stamps table is rebuilt
-- verbatim with 'verified_absent' added to the method vocabulary. Stamp rows
-- are a derived ledger keyed by finding — copying them across preserves every
-- guarantee (stamps are never deleted, they only go stale by timestamp).
CREATE TABLE finding_resolution_stamps_new (
  finding_id     TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  suite_id       TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  case_id        TEXT NOT NULL,
  run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
  method         TEXT NOT NULL CHECK (method IN ('gate_pass', 'signal_absent', 'case_pass', 'verified_absent')),
  stamped_at     INT_TS NOT NULL,
  PRIMARY KEY (finding_id, suite_id, environment_id, case_id)
);
INSERT INTO finding_resolution_stamps_new SELECT * FROM finding_resolution_stamps;
DROP TABLE finding_resolution_stamps;
ALTER TABLE finding_resolution_stamps_new RENAME TO finding_resolution_stamps;

-- Per-project auto-resolve mode, the tri-state pin shape of auto_resolve
-- (0013): NULL inherits the deployment default (PLAYTEST_AUTO_RESOLVE_MODE,
-- default 'semi'). 'semi' keeps every verified fix a suggestion a person
-- confirms; 'full' lets a verified fix resolve the finding outright. The mode
-- only governs the verified keyless tier — gate and signal resolutions are
-- deterministic and unaffected — and the verification model rides the
-- projects.models policy ('auto_resolve_model'), not a column of its own.
ALTER TABLE projects ADD COLUMN auto_resolve_mode TEXT
  CHECK (auto_resolve_mode IS NULL OR auto_resolve_mode IN ('semi', 'full'));
