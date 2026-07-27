-- Reviewer-triggered retrieve-then-verify consolidation
-- (docs/contracts/hosted.md, "Candidate consolidation").
--
-- A consolidation plan is a PROPOSAL over ids the server supplied. Persisting it
-- mutates no candidate and no finding: model output never reaches findings state
-- without an explicit reviewer apply. Applying a plan runs in one transaction
-- through the existing intake/promotion machinery, so evidence completeness,
-- merge tombstones, and audit are preserved.

CREATE TABLE consolidation_plans (
  id                  TEXT PRIMARY KEY,             -- opaque ulid
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN ('proposed','applied','discarded')),

  -- Deterministic retrieval that produced the plan.
  thresholds          TEXT_JSON NOT NULL,           -- { k, floor, auto_suggest, max_cluster_items, max_prompt_bytes, max_clusters }
  shortlist_version   TEXT NOT NULL,
  match_text_version  TEXT NOT NULL,

  -- The proposal itself: { items: [...], unresolved: [...] }. Every item carries
  -- an opaque item id, its candidate ids, an optional existing finding target, a
  -- proposed title for a new group, the routing origin (shortlist_suggestion |
  -- shortlist_new | model_cluster), confidence, reason, and scores.
  plan                TEXT_JSON NOT NULL,

  -- Deterministic scope shown to the reviewer BEFORE the model runs, and the
  -- actual gateway usage recorded after it.
  scope               TEXT_JSON NOT NULL,           -- { candidates, clusters, prompt_bytes, est_input_tokens, ... }
  usage               TEXT_JSON,                    -- { calls, in, out, cache_read, cost_usd }

  -- `prompt_version` is legacy and no longer written; retained so existing
  -- databases and storage fixtures remain readable.
  prompt_version      TEXT,
  model               TEXT,

  -- Staleness guard: a digest of every referenced candidate's (id, status,
  -- finding_id, updated_at) at plan time. Re-applying a plan whose candidates
  -- moved fails cleanly instead of assigning stale ids.
  candidate_digest    TEXT NOT NULL,

  created_by          TEXT_JSON NOT NULL,           -- audit actor shape
  applied_by          TEXT_JSON,
  created_at          INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  applied_at          INT_TS,
  updated_at          INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX consolidation_plans_project_idx ON consolidation_plans(project_id, created_at DESC);
CREATE INDEX consolidation_plans_status_idx ON consolidation_plans(project_id, status, created_at DESC);

-- Labeled pairs for threshold calibration (tests/core/findings/README.md). Every reviewer
-- confirmation and rejection of a suggestion or assignment lands here with the
-- deterministic score and the model's confidence that produced it, so k, the
-- similarity floor, and the auto-suggest threshold can be re-measured against
-- real decisions instead of guessed again.
CREATE TABLE consolidation_labels (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id        TEXT REFERENCES consolidation_plans(id) ON DELETE SET NULL,
  candidate_id   TEXT REFERENCES bug_candidates(id) ON DELETE SET NULL,
  finding_id     TEXT REFERENCES findings(id) ON DELETE SET NULL,
  origin         TEXT NOT NULL,                     -- shortlist_suggestion | shortlist_new | model_cluster | loose_key
  score          REAL,                              -- deterministic similarity, when one produced the pair
  confidence     TEXT,                              -- high | medium (model clusters only)
  decision       TEXT NOT NULL CHECK (decision IN ('confirmed','edited','rejected','unresolved')),
  detail         TEXT_JSON,
  actor          TEXT_JSON NOT NULL,
  created_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX consolidation_labels_project_idx ON consolidation_labels(project_id, created_at DESC);
CREATE INDEX consolidation_labels_plan_idx ON consolidation_labels(plan_id);
CREATE INDEX consolidation_labels_candidate_idx ON consolidation_labels(candidate_id);
