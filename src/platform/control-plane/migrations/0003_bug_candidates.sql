-- Findings intake: unassigned bug candidates, their append-only evidence, and
-- the suppression ledger that absorbs exact recurrences of dismissed candidates.
-- (docs/contracts/hosted.md, "Bug candidates and intake".)
--
-- SQLite persists identity; run bundles persist evidence. Nothing here stores
-- artifact bytes: evidence rows reference runs and step numbers only.
--
-- The table is named `bug_candidates` because `candidates` already means a
-- pending baseline-change candidate (review), a different object entirely.

CREATE TABLE bug_candidates (
  id                    TEXT PRIMARY KEY,                -- opaque ulid; never derived from a key
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id                TEXT REFERENCES runs(id) ON DELETE SET NULL,   -- first cited run (a pointer, not identity)
  case_id               TEXT,
  story_id              TEXT,
  category              TEXT NOT NULL,                   -- D3 vocabulary; a comparison signal, not identity
  claim                 TEXT_JSON NOT NULL,              -- { title, expected, observed, severity, signals[] }
  source                TEXT NOT NULL CHECK (source IN ('synthesis','reviewer','run_grade')),

  -- Deterministic identity (D4), computed server-side from trusted context only.
  signal_type           TEXT,                            -- NULL ⇒ no deterministic signal ⇒ no exact keys
  locus                 TEXT_JSON,                       -- { route, step_locus, status_class } from recorded fields
  normalized_locus      TEXT,
  strict_key            TEXT,                            -- sha256(project ‖ story ‖ signal ‖ locus)
  loose_key             TEXT,                            -- sha256(project ‖ signal ‖ locus)
  key_algo_version      TEXT NOT NULL,
  locus_norm_version    TEXT NOT NULL,

  -- Deterministic shortlist input (D5), stored now, consumed by P3.
  match_text            TEXT NOT NULL DEFAULT '',
  match_text_version    TEXT NOT NULL,

  status                TEXT NOT NULL CHECK (status IN ('unassigned','assigned','dismissed')),
  finding_id            TEXT REFERENCES findings(id) ON DELETE SET NULL,        -- set when assigned
  suggested_finding_id  TEXT REFERENCES findings(id) ON DELETE SET NULL,        -- loose hit: pre-attached suggestion
  suggestion_kind       TEXT CHECK (suggestion_kind IS NULL OR suggestion_kind IN ('loose_key')),
  dismiss_reason        TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('not_a_bug','wont_fix','duplicate')),
  recurrence_count      INTEGER NOT NULL DEFAULT 0,      -- exact recurrences absorbed after dismissal
  intake_key            TEXT,                            -- caller-supplied idempotency key
  created_at            INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at            INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX bug_candidates_queue_idx ON bug_candidates(project_id, status, created_at DESC);
CREATE INDEX bug_candidates_strict_idx ON bug_candidates(project_id, strict_key);
CREATE INDEX bug_candidates_loose_idx ON bug_candidates(project_id, loose_key);
CREATE INDEX bug_candidates_finding_idx ON bug_candidates(finding_id);
CREATE UNIQUE INDEX bug_candidates_intake_key_idx
  ON bug_candidates(project_id, intake_key) WHERE intake_key IS NOT NULL;

-- Append-only. A study-synthesized candidate carries EVERY cited run/step, not
-- only the first. The natural key (candidate, run, step, source) makes appends
-- idempotent, so a retried intake adds nothing. COALESCE keeps a NULL step from
-- reading as "distinct from every other NULL step".
CREATE TABLE bug_candidate_evidence (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL REFERENCES bug_candidates(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id       TEXT NOT NULL,
  step_from     INTEGER,
  step_to       INTEGER,
  excerpt       TEXT,
  source        TEXT NOT NULL,
  created_at    INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX bug_candidate_evidence_natural_idx
  ON bug_candidate_evidence(candidate_id, run_id, COALESCE(step_from, -1), source);
CREATE INDEX bug_candidate_evidence_candidate_idx ON bug_candidate_evidence(candidate_id, created_at);
CREATE INDEX bug_candidate_evidence_run_idx ON bug_candidate_evidence(run_id);

-- Dismissal records the candidate's keys here. An exact (strict) recurrence is
-- auto-dismissed and increments `absorbed_count` instead of re-entering the
-- queue; a large counter is itself a signal. Loose entries are recorded for the
-- P3 shortlist and never auto-dismiss on their own.
CREATE TABLE bug_candidate_suppressions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL CHECK (scope IN ('strict','loose')),
  key               TEXT NOT NULL,
  key_algo_version  TEXT NOT NULL,
  candidate_id      TEXT REFERENCES bug_candidates(id) ON DELETE SET NULL,
  reason            TEXT,
  absorbed_count    INTEGER NOT NULL DEFAULT 0,
  created_at        INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at        INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, scope, key)
);
