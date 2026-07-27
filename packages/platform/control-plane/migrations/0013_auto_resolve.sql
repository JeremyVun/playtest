-- Auto-resolve findings from later runs (docs/contracts/hosted.md, "Findings").
--
-- The resolution ledger: one stamp per (finding, suite, environment, case)
-- triple recording the newer run that disproved the finding on that triple
-- under its tier's test. The finding resolves only when every affected triple
-- carries a stamp newer than that triple's latest evidence — stamps are never
-- deleted on new evidence, they go stale by timestamp comparison, and history
-- stays across reopens.
CREATE TABLE finding_resolution_stamps (
  finding_id     TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  suite_id       TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  case_id        TEXT NOT NULL,
  run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
  method         TEXT NOT NULL CHECK (method IN ('gate_pass', 'signal_absent', 'case_pass')),
  stamped_at     INT_TS NOT NULL,
  PRIMARY KEY (finding_id, suite_id, environment_id, case_id)
);

-- Auto-resolution provenance on the finding itself: which run closed it and
-- when the system did so. Cleared whenever the finding leaves `resolved`
-- (recurrence or manual reopen) and by a manual resolve — the columns describe
-- the CURRENT resolution, never a historical one (the audit log keeps those).
ALTER TABLE findings ADD COLUMN resolved_by_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE findings ADD COLUMN auto_resolved_at INT_TS;

CREATE INDEX findings_resolved_by_run_idx ON findings(resolved_by_run_id)
  WHERE resolved_by_run_id IS NOT NULL;

-- Per-project auto-resolve policy, the same tri-state shape as auto_dedupe
-- (0010): NULL inherits the deployment default (PLAYTEST_AUTO_RESOLVE), 1/0
-- pin the sweep on or off for this project. Unlike auto-dedupe the sweep is
-- fully deterministic — no model gateway is involved.
ALTER TABLE projects ADD COLUMN auto_resolve INT_BOOL CHECK (auto_resolve IS NULL OR auto_resolve IN (0, 1));
