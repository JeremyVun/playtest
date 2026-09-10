-- Repair claims. An external repair daemon leases a finding while it attempts a
-- fix; Playtest arbitrates the lease and records the outcome, and never
-- dispatches the work (docs/contracts/hosted-findings.md, "Repair claims").
-- The lease lives on the finding row rather than in `leases`, because eligibility
-- is a fact about the finding and the whole precondition must be restatable in
-- one mutating WHERE.

ALTER TABLE findings
  ADD COLUMN repair_owner      TEXT COLLATE "C",
  ADD COLUMN repair_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN repair_expires_at TIMESTAMPTZ(3),
  ADD COLUMN repair_outcome    TEXT COLLATE "C" NOT NULL DEFAULT 'none'
    CHECK (repair_outcome IN ('none','suggested','not_fixed','needs_owner'));

CREATE INDEX findings_repairable_idx ON findings(project_id, last_seen DESC, id DESC)
  WHERE merged_into IS NULL AND repair_outcome = 'none' AND state IN ('new','reopened');

-- A note attaches prose to a finding without run evidence, so a duplicate
-- report can land on the finding it duplicates.
CREATE TABLE finding_notes (
  id         TEXT COLLATE "C" PRIMARY KEY,
  finding_id TEXT COLLATE "C" NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  source     TEXT COLLATE "C" NOT NULL,
  text       TEXT COLLATE "C" NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX finding_notes_finding_idx ON finding_notes(finding_id, created_at DESC);
