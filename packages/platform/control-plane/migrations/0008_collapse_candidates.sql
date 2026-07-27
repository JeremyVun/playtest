-- Collapse bug candidates into findings (docs/contracts/hosted.md
-- "Findings intake").
--
-- The finding becomes the only defect entity: a machine-filed claim is a finding
-- in state `new`. Candidate ids are REUSED as finding ids (both opaque ULIDs) so
-- audit rows, deep links, and consolidation labels stay resolvable.
--
-- `findings` needs a table rebuild: its `reject_reason` CHECK widens to include
-- `duplicate` and it absorbs the candidate identity columns. `PRAGMA
-- foreign_keys` cannot be changed inside a transaction, so ordering does the
-- work instead. A RENAME repoints every child's FK text at the renamed table, so
-- `finding_evidence` and `consolidation_labels` are rebuilt against the new
-- `findings` before the old table is dropped — dropping a parent that still owns
-- an ON DELETE CASCADE child would delete the evidence this migration exists to
-- preserve.

-- ---------------------------------------------------------------------------
-- 1. Rebuild `findings`.
-- ---------------------------------------------------------------------------

ALTER TABLE findings RENAME TO findings_pre0008;

CREATE TABLE findings (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint    TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT_JSON NOT NULL DEFAULT '{}',
  severity       TEXT NOT NULL CHECK (severity IN ('info','minor','major')),
  state          TEXT NOT NULL CHECK (state IN ('new','accepted','rejected','resolved','reopened')),
  reject_reason  TEXT CHECK (reject_reason IS NULL OR reject_reason IN ('not_a_bug','wont_fix','duplicate')),
  external_ref   TEXT,
  merged_into    TEXT REFERENCES findings(id) ON DELETE SET NULL,
  first_seen     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_seen      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),

  -- Identity absorbed from bug_candidates. Computed server-side from trusted,
  -- recorded context only; model text and the model-chosen category never enter
  -- a key. A NULL signal_type means no deterministic signal, hence no exact keys.
  category            TEXT,
  source              TEXT,   -- synthesis | run_grade | reviewer | extractor | split
  signal_type         TEXT,
  locus               TEXT_JSON,
  normalized_locus    TEXT,
  strict_key          TEXT,   -- sha256(project ‖ story ‖ signal ‖ locus)
  loose_key           TEXT,   -- sha256(project ‖ signal ‖ locus)
  key_algo_version    TEXT,
  locus_norm_version  TEXT,
  match_text          TEXT,   -- deterministic shortlist input (consolidation)
  match_text_version  TEXT,

  -- A loose hit is filed as its own `new` finding carrying a pre-attached
  -- suggestion. It never auto-merges.
  suggested_finding_id TEXT REFERENCES findings(id) ON DELETE SET NULL,
  suggestion_kind      TEXT CHECK (suggestion_kind IS NULL OR suggestion_kind IN ('loose_key')),

  -- Exact recurrences absorbed while the finding stood rejected. A standing
  -- rejection IS the suppression mechanism; there is no suppression table.
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  first_run_id     TEXT REFERENCES runs(id) ON DELETE SET NULL,

  created_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- merged_into is restored in a second pass: one INSERT..SELECT would check the
-- self-referencing key against rows that have not been copied yet.
INSERT INTO findings
  (id, project_id, fingerprint, title, summary, severity, state, reject_reason,
   external_ref, merged_into, first_seen, last_seen, evidence_count, created_at, updated_at)
SELECT id, project_id, fingerprint, title, summary, severity, state, reject_reason,
       external_ref, NULL, first_seen, last_seen, evidence_count, created_at, updated_at
  FROM findings_pre0008;

UPDATE findings
   SET merged_into = (SELECT o.merged_into FROM findings_pre0008 o WHERE o.id = findings.id)
 WHERE EXISTS (SELECT 1 FROM findings_pre0008 o WHERE o.id = findings.id AND o.merged_into IS NOT NULL);

-- `finding_evidence` follows, so its ON DELETE CASCADE names the new parent.
ALTER TABLE finding_evidence RENAME TO finding_evidence_pre0008;

CREATE TABLE finding_evidence (
  id          TEXT PRIMARY KEY,
  finding_id  TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id     TEXT NOT NULL,
  step_from   INTEGER,
  step_to     INTEGER,
  excerpt     TEXT,
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

INSERT INTO finding_evidence (id, finding_id, run_id, case_id, step_from, step_to, excerpt, created_at)
SELECT id, finding_id, run_id, case_id, step_from, step_to, excerpt, created_at
  FROM finding_evidence_pre0008;

DROP TABLE finding_evidence_pre0008;

CREATE INDEX finding_evidence_finding_idx ON finding_evidence(finding_id, created_at DESC);
CREATE INDEX finding_evidence_run_idx ON finding_evidence(run_id);

-- Caller idempotency keys are durable and many-to-one: one finding may absorb
-- many intake keys as recurrences and retries land on it.
CREATE TABLE finding_intake_keys (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  intake_key  TEXT NOT NULL,
  finding_id  TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX finding_intake_keys_key_idx ON finding_intake_keys(project_id, intake_key);
CREATE INDEX finding_intake_keys_finding_idx ON finding_intake_keys(finding_id);

-- ---------------------------------------------------------------------------
-- 2. Data step: every candidate becomes, or folds into, a finding.
-- ---------------------------------------------------------------------------

-- candidate id -> the finding id it resolves to.
CREATE TABLE _m0008_map (candidate_id TEXT PRIMARY KEY, finding_id TEXT NOT NULL);

-- The fingerprint each non-assigned candidate would carry: its strict key when
-- it has one, else an opaque per-candidate value that cannot collide.
CREATE TABLE _m0008_fp (candidate_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL);

INSERT INTO _m0008_fp (candidate_id, project_id, fingerprint)
SELECT c.id, c.project_id, COALESCE(c.strict_key, 'bug_candidate:' || c.id)
  FROM bug_candidates c
 WHERE c.status <> 'assigned';

-- `assigned` candidates create no finding: they map to the one they own.
INSERT INTO _m0008_map (candidate_id, finding_id)
SELECT c.id, c.finding_id
  FROM bug_candidates c
 WHERE c.status = 'assigned'
   AND c.finding_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM findings f WHERE f.id = c.finding_id);

-- A fingerprint collision with an existing live finding folds evidence in rather
-- than inserting a second row under the partial unique index.
INSERT OR IGNORE INTO _m0008_map (candidate_id, finding_id)
SELECT p.candidate_id,
       (SELECT f.id FROM findings f
         WHERE f.project_id = p.project_id AND f.fingerprint = p.fingerprint AND f.merged_into IS NULL
         ORDER BY f.id LIMIT 1)
  FROM _m0008_fp p
 WHERE EXISTS (SELECT 1 FROM findings f
                WHERE f.project_id = p.project_id AND f.fingerprint = p.fingerprint AND f.merged_into IS NULL);

-- Of what is left, one candidate per (project, fingerprint) becomes the finding;
-- its siblings fold into it.
CREATE TABLE _m0008_new (candidate_id TEXT PRIMARY KEY);
INSERT INTO _m0008_new (candidate_id)
SELECT MIN(p.candidate_id)
  FROM _m0008_fp p
 WHERE p.candidate_id NOT IN (SELECT candidate_id FROM _m0008_map)
 GROUP BY p.project_id, p.fingerprint;

-- `unassigned` -> `new`, `dismissed` -> `rejected` with its mapped reason and
-- recurrence count. Title and severity are columns; the rest of the claim lives
-- under summary.claim.
INSERT INTO findings
  (id, project_id, fingerprint, title, summary, severity, state, reject_reason,
   external_ref, merged_into, first_seen, last_seen, evidence_count,
   category, source, signal_type, locus, normalized_locus, strict_key, loose_key,
   key_algo_version, locus_norm_version, match_text, match_text_version,
   suggested_finding_id, suggestion_kind, recurrence_count, first_run_id,
   created_at, updated_at)
SELECT
  c.id,
  c.project_id,
  COALESCE(c.strict_key, 'bug_candidate:' || c.id),
  substr(COALESCE(NULLIF(json_extract(c.claim, '$.title'), ''), 'Bug candidate'), 1, 180),
  json_object(
    'story_id', c.story_id,
    'case_id', c.case_id,
    'claim', json_object(
      'expected', json_extract(c.claim, '$.expected'),
      'observed', json_extract(c.claim, '$.observed'),
      'signals', json(COALESCE(json_extract(c.claim, '$.signals'), '[]'))
    )
  ),
  CASE WHEN json_extract(c.claim, '$.severity') IN ('info','minor','major')
       THEN json_extract(c.claim, '$.severity') ELSE 'minor' END,
  CASE WHEN c.status = 'dismissed' THEN 'rejected' ELSE 'new' END,
  CASE WHEN c.status = 'dismissed' AND c.dismiss_reason IN ('not_a_bug','wont_fix','duplicate')
       THEN c.dismiss_reason
       WHEN c.status = 'dismissed' THEN 'not_a_bug'
       ELSE NULL END,
  NULL,
  NULL,
  c.created_at,
  c.updated_at,
  0,
  c.category,
  c.source,
  c.signal_type,
  c.locus,
  c.normalized_locus,
  c.strict_key,
  c.loose_key,
  c.key_algo_version,
  c.locus_norm_version,
  c.match_text,
  c.match_text_version,
  CASE WHEN c.status = 'unassigned' THEN c.suggested_finding_id ELSE NULL END,
  CASE WHEN c.status = 'unassigned' THEN c.suggestion_kind ELSE NULL END,
  c.recurrence_count,
  c.run_id,
  c.created_at,
  c.updated_at
FROM bug_candidates c
JOIN _m0008_new n ON n.candidate_id = c.id;

INSERT OR IGNORE INTO _m0008_map (candidate_id, finding_id)
SELECT n.candidate_id, n.candidate_id FROM _m0008_new n;

INSERT OR IGNORE INTO _m0008_map (candidate_id, finding_id)
SELECT p.candidate_id,
       (SELECT q.candidate_id FROM _m0008_fp q
         JOIN _m0008_new n ON n.candidate_id = q.candidate_id
        WHERE q.project_id = p.project_id AND q.fingerprint = p.fingerprint
        LIMIT 1)
  FROM _m0008_fp p
 WHERE EXISTS (SELECT 1 FROM _m0008_fp q
                JOIN _m0008_new n ON n.candidate_id = q.candidate_id
               WHERE q.project_id = p.project_id AND q.fingerprint = p.fingerprint);

-- Backfill identity onto the findings that `assigned` candidates owned, only
-- where the finding has none: an existing value is never overwritten.
UPDATE findings
   SET category           = COALESCE(category,           (SELECT c.category           FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       source             = COALESCE(source,             (SELECT c.source             FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       signal_type        = COALESCE(signal_type,        (SELECT c.signal_type        FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       locus              = COALESCE(locus,              (SELECT c.locus              FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       normalized_locus   = COALESCE(normalized_locus,   (SELECT c.normalized_locus   FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       strict_key         = COALESCE(strict_key,         (SELECT c.strict_key         FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       loose_key          = COALESCE(loose_key,          (SELECT c.loose_key          FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       key_algo_version   = COALESCE(key_algo_version,   (SELECT c.key_algo_version   FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       locus_norm_version = COALESCE(locus_norm_version, (SELECT c.locus_norm_version FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       match_text         = COALESCE(match_text,         (SELECT c.match_text         FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       match_text_version = COALESCE(match_text_version, (SELECT c.match_text_version FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1)),
       first_run_id       = COALESCE(first_run_id,       (SELECT c.run_id             FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned' ORDER BY c.created_at, c.id LIMIT 1))
 WHERE EXISTS (SELECT 1 FROM bug_candidates c WHERE c.finding_id = findings.id AND c.status = 'assigned');

-- Candidate evidence becomes finding evidence, de-duplicated on the
-- application-level natural key (finding, run, step).
INSERT INTO finding_evidence (id, finding_id, run_id, case_id, step_from, step_to, excerpt, created_at)
SELECT bce.id, m.finding_id, bce.run_id, bce.case_id, bce.step_from, bce.step_to, bce.excerpt, bce.created_at
  FROM bug_candidate_evidence bce
  JOIN _m0008_map m ON m.candidate_id = bce.candidate_id
 WHERE bce.id = (SELECT MIN(b2.id)
                   FROM bug_candidate_evidence b2
                   JOIN _m0008_map m2 ON m2.candidate_id = b2.candidate_id
                  WHERE m2.finding_id = m.finding_id
                    AND b2.run_id = bce.run_id
                    AND COALESCE(b2.step_from, -1) = COALESCE(bce.step_from, -1))
   AND NOT EXISTS (SELECT 1 FROM finding_evidence fe
                    WHERE fe.finding_id = m.finding_id
                      AND fe.run_id = bce.run_id
                      AND COALESCE(fe.step_from, -1) = COALESCE(bce.step_from, -1));

UPDATE findings
   SET evidence_count = (SELECT COUNT(*) FROM finding_evidence fe WHERE fe.finding_id = findings.id),
       first_seen = COALESCE((SELECT MIN(fe.created_at) FROM finding_evidence fe WHERE fe.finding_id = findings.id), findings.first_seen),
       last_seen  = COALESCE((SELECT MAX(fe.created_at) FROM finding_evidence fe WHERE fe.finding_id = findings.id), findings.last_seen)
 WHERE findings.id IN (SELECT finding_id FROM _m0008_map);

-- Every candidate's intake key becomes a durable mapping onto its finding.
INSERT OR IGNORE INTO finding_intake_keys (id, project_id, intake_key, finding_id, created_at)
SELECT c.id, c.project_id, c.intake_key, m.finding_id, c.created_at
  FROM bug_candidates c
  JOIN _m0008_map m ON m.candidate_id = c.id
 WHERE c.intake_key IS NOT NULL;

-- Proposed plans cannot survive: their digests describe rows that no longer
-- exist. Discard them; a fresh plan is one reviewer click.
UPDATE consolidation_plans
   SET status = 'discarded', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE status = 'proposed';


-- ---------------------------------------------------------------------------
-- 3. consolidation_labels.candidate_id -> subject_finding_id.
-- ---------------------------------------------------------------------------

ALTER TABLE consolidation_labels RENAME TO _m0008_labels_pre;

CREATE TABLE consolidation_labels (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id            TEXT REFERENCES consolidation_plans(id) ON DELETE SET NULL,
  subject_finding_id TEXT REFERENCES findings(id) ON DELETE SET NULL,
  finding_id         TEXT REFERENCES findings(id) ON DELETE SET NULL,
  origin             TEXT NOT NULL,                     -- shortlist_suggestion | shortlist_new | model_cluster | loose_key
  score              REAL,                              -- deterministic similarity, when one produced the pair
  confidence         TEXT,                              -- high | medium (model clusters only)
  decision           TEXT NOT NULL CHECK (decision IN ('confirmed','edited','rejected','unresolved')),
  detail             TEXT_JSON,
  actor              TEXT_JSON NOT NULL,
  created_at         INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

INSERT INTO consolidation_labels
  (id, project_id, plan_id, subject_finding_id, finding_id, origin, score, confidence, decision, detail, actor, created_at)
SELECT l.id, l.project_id, l.plan_id,
       CASE
         WHEN (SELECT m.finding_id FROM _m0008_map m WHERE m.candidate_id = l.candidate_id) IS NOT NULL
           THEN (SELECT m.finding_id FROM _m0008_map m WHERE m.candidate_id = l.candidate_id)
         WHEN EXISTS (SELECT 1 FROM findings f WHERE f.id = l.candidate_id) THEN l.candidate_id
         ELSE NULL
       END,
       l.finding_id, l.origin, l.score, l.confidence, l.decision, l.detail, l.actor, l.created_at
  FROM _m0008_labels_pre l;

DROP TABLE _m0008_labels_pre;

CREATE INDEX consolidation_labels_project_idx ON consolidation_labels(project_id, created_at DESC);
CREATE INDEX consolidation_labels_plan_idx ON consolidation_labels(plan_id);
CREATE INDEX consolidation_labels_subject_idx ON consolidation_labels(subject_finding_id);

-- ---------------------------------------------------------------------------
-- 4. Drop the candidate lifecycle and the old parent table.
-- ---------------------------------------------------------------------------

DROP TABLE bug_candidate_suppressions;
DROP TABLE bug_candidate_evidence;
DROP TABLE bug_candidates;

DROP TABLE _m0008_new;
DROP TABLE _m0008_fp;
DROP TABLE _m0008_map;

-- Nothing references it any more.
DROP TABLE findings_pre0008;

CREATE UNIQUE INDEX findings_project_fingerprint_active_idx
  ON findings(project_id, fingerprint)
  WHERE merged_into IS NULL;
CREATE INDEX findings_project_queue_idx ON findings(project_id, state, severity, last_seen DESC)
  WHERE merged_into IS NULL;
CREATE INDEX findings_merged_idx ON findings(merged_into);
CREATE INDEX findings_strict_key_idx ON findings(project_id, strict_key);
CREATE INDEX findings_loose_key_idx ON findings(project_id, loose_key);
