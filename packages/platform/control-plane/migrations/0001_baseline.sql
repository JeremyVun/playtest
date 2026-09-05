-- Postgres hosted schema. Fresh deployments only.
CREATE TABLE users (
  id          TEXT COLLATE "C" PRIMARY KEY,
  subject     TEXT COLLATE "C" UNIQUE NOT NULL,
  email       TEXT COLLATE "C" NOT NULL,
  name        TEXT COLLATE "C",
  disabled    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          TEXT COLLATE "C" PRIMARY KEY,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ(3) NOT NULL,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE projects (
  id          TEXT COLLATE "C" PRIMARY KEY,
  key         TEXT COLLATE "C" UNIQUE NOT NULL,
  name        TEXT COLLATE "C" NOT NULL,
  archived    BOOLEAN NOT NULL DEFAULT false,

  models      JSONB NOT NULL DEFAULT '{}',

  auto_dedupe BOOLEAN,
  auto_resolve BOOLEAN,
  auto_resolve_mode TEXT COLLATE "C" CHECK (auto_resolve_mode IS NULL OR auto_resolve_mode IN ('semi', 'full')),
  parallel    JSONB NOT NULL DEFAULT '{"record":3,"total":10}',
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT COLLATE "C" NOT NULL CHECK (role IN ('viewer','editor','reviewer','developer','admin')),
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE api_tokens (
  id          TEXT COLLATE "C" PRIMARY KEY,
  project_id  TEXT COLLATE "C" REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT COLLATE "C" NOT NULL CHECK (role IN ('viewer','editor','reviewer','developer','admin')),
  name        TEXT COLLATE "C" NOT NULL,
  token_hash  TEXT COLLATE "C" NOT NULL,
  expires_at  TIMESTAMPTZ(3),
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX api_tokens_project_idx ON api_tokens(project_id);

CREATE TABLE applications (
  id          TEXT COLLATE "C" PRIMARY KEY,
  project_id  TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT COLLATE "C" NOT NULL,
  name        TEXT COLLATE "C" NOT NULL,
  driver      TEXT COLLATE "C" NOT NULL CHECK (driver IN ('web','api','mobile')),


  platform    TEXT COLLATE "C" CHECK (platform IS NULL OR platform IN ('ios','android')),
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (project_id, key),
  CHECK ((driver = 'mobile') = (platform IS NOT NULL))
);

CREATE INDEX applications_project_idx ON applications(project_id);

CREATE TABLE rings (
  id                TEXT COLLATE "C" PRIMARY KEY,
  application_id    TEXT COLLATE "C" NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  key               TEXT COLLATE "C" NOT NULL,
  name              TEXT COLLATE "C" NOT NULL,
  base_url          TEXT COLLATE "C",
  runner_labels     JSONB NOT NULL DEFAULT '[]',



  config            JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (application_id, key)
);

CREATE INDEX rings_application_idx ON rings(application_id);

CREATE TABLE suites (
  id             TEXT COLLATE "C" PRIMARY KEY,
  project_id     TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id TEXT COLLATE "C" NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  slug           TEXT COLLATE "C" NOT NULL,
  name           TEXT COLLATE "C" NOT NULL,
  archived       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);

CREATE INDEX suites_application_idx ON suites(application_id);

CREATE TABLE suite_files (
  id          TEXT COLLATE "C" PRIMARY KEY,
  suite_id    TEXT COLLATE "C" NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  path        TEXT COLLATE "C" NOT NULL,
  kind        TEXT COLLATE "C" NOT NULL CHECK (kind IN ('defaults','case','persona','hook','assertion','asset')),
  content     TEXT COLLATE "C" NOT NULL,
  updated_by  TEXT COLLATE "C" REFERENCES users(id),
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (suite_id, path)
);

CREATE INDEX suite_files_suite_idx ON suite_files(suite_id);

CREATE TABLE suite_snapshots (
  id          TEXT COLLATE "C" PRIMARY KEY,
  suite_id    TEXT COLLATE "C" NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  tree        JSONB NOT NULL,
  created_by  TEXT COLLATE "C" REFERENCES users(id),
  note        TEXT COLLATE "C",
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (suite_id, seq)
);

CREATE INDEX suite_snapshots_suite_idx ON suite_snapshots(suite_id);

CREATE TABLE personas (
  id            TEXT COLLATE "C" PRIMARY KEY,
  project_id    TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug          TEXT COLLATE "C" NOT NULL,
  name          TEXT COLLATE "C" NOT NULL,
  description   TEXT COLLATE "C" NOT NULL,
  blob_sha256   TEXT COLLATE "C" NOT NULL,
  created_by    TEXT COLLATE "C" REFERENCES users(id),
  created_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);

CREATE TABLE rule_cards (
  id                 TEXT COLLATE "C" PRIMARY KEY,
  project_id         TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id           TEXT COLLATE "C" NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  rule_id            TEXT COLLATE "C" NOT NULL,
  state              TEXT COLLATE "C" NOT NULL CHECK (state IN ('candidate', 'approved', 'denied')),
  origin             TEXT COLLATE "C" NOT NULL CHECK (origin IN ('proposed', 'authored')),
  title              TEXT COLLATE "C",
  statement          TEXT COLLATE "C" NOT NULL,
  applicability      TEXT COLLATE "C",
  exceptions         TEXT COLLATE "C",
  provenance         TEXT COLLATE "C",
  note               TEXT COLLATE "C",
  proposed_statement TEXT COLLATE "C",
  prompt_version     TEXT COLLATE "C",
  decided_by         TEXT COLLATE "C" REFERENCES users(id),
  decided_at         TIMESTAMPTZ(3),
  created_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (suite_id, rule_id)
);

CREATE INDEX rule_cards_project_idx ON rule_cards(project_id);
CREATE INDEX rule_cards_suite_idx ON rule_cards(suite_id, state);

CREATE TABLE secrets (
  id          TEXT COLLATE "C" PRIMARY KEY,
  project_id  TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT COLLATE "C" NOT NULL,
  ciphertext  BYTEA NOT NULL,
  created_by  TEXT COLLATE "C" REFERENCES users(id),
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE auth_providers (
  id              TEXT COLLATE "C" PRIMARY KEY,
  project_id      TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ring_id         TEXT COLLATE "C" REFERENCES rings(id) ON DELETE RESTRICT,
  name            TEXT COLLATE "C" NOT NULL,
  kind            TEXT COLLATE "C" NOT NULL CHECK (kind IN ('token_endpoint','storage_state_secret','script')),
  config          JSONB NOT NULL DEFAULT '{}',
  code            TEXT COLLATE "C",
  identities      JSONB NOT NULL DEFAULT '{}',
  ttl_minutes     INTEGER NOT NULL DEFAULT 60,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  updated_by      TEXT COLLATE "C" REFERENCES users(id),
  created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE INDEX auth_providers_project_idx ON auth_providers(project_id);
CREATE INDEX auth_providers_ring_idx ON auth_providers(ring_id);

CREATE TABLE session_artifacts (
  id             TEXT COLLATE "C" PRIMARY KEY,
  provider_id    TEXT COLLATE "C" NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  identity       TEXT COLLATE "C" NOT NULL,
  ciphertext     BYTEA NOT NULL,
  minted_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ(3) NOT NULL,
  minted_by_job  TEXT COLLATE "C",
  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (provider_id, identity)
);

CREATE INDEX session_artifacts_provider_idx ON session_artifacts(provider_id);
CREATE INDEX session_artifacts_expiry_idx ON session_artifacts(expires_at);

CREATE TABLE session_claims (
  id          TEXT COLLATE "C" PRIMARY KEY,
  provider_id TEXT COLLATE "C" NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  identity    TEXT COLLATE "C" NOT NULL,
  executor_id TEXT COLLATE "C",
  status      TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ(3) NOT NULL
);

CREATE INDEX session_claims_pending_idx
  ON session_claims(provider_id, identity) WHERE status = 'pending';

CREATE TABLE run_groups (
  id              TEXT COLLATE "C" PRIMARY KEY,
  project_id      TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id        TEXT COLLATE "C" NOT NULL REFERENCES suites(id) ON DELETE RESTRICT,
  snapshot_id     TEXT COLLATE "C" NOT NULL REFERENCES suite_snapshots(id) ON DELETE RESTRICT,
  application_id  TEXT COLLATE "C" NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  ring_id         TEXT COLLATE "C" NOT NULL REFERENCES rings(id) ON DELETE RESTRICT,
  trigger         JSONB NOT NULL,
  selection       JSONB NOT NULL,
  status          TEXT COLLATE "C" NOT NULL CHECK (status IN ('queued','running','done','canceled')),


  runner_labels   JSONB,
  exit_summary    JSONB,
  created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX run_groups_project_idx ON run_groups(project_id, created_at DESC);
CREATE INDEX run_groups_status_idx ON run_groups(status);
CREATE INDEX run_groups_suite_idx ON run_groups(suite_id);
CREATE INDEX run_groups_ring_idx ON run_groups(ring_id);
CREATE INDEX run_groups_application_idx ON run_groups(application_id);

CREATE TABLE executors (
  id                TEXT COLLATE "C" PRIMARY KEY,
  run_group_id      TEXT COLLATE "C" REFERENCES run_groups(id) ON DELETE SET NULL,
  dispatch_id       TEXT COLLATE "C",
  kind              TEXT COLLATE "C" NOT NULL CHECK (kind IN ('group','media','mint')),
  versions          JSONB NOT NULL DEFAULT '{}',
  isolation         TEXT COLLATE "C" CHECK (isolation IS NULL OR isolation IN ('container','process')),
  registered_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  last_report_at    TIMESTAMPTZ(3),
  concluded_at      TIMESTAMPTZ(3),
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX executors_group_idx ON executors(run_group_id);
CREATE INDEX executors_dispatch_idx ON executors(dispatch_id) WHERE dispatch_id IS NOT NULL;

CREATE TABLE runners (
  id              TEXT COLLATE "C" PRIMARY KEY,
  project_id      TEXT COLLATE "C" REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT COLLATE "C" NOT NULL,
  labels          JSONB NOT NULL DEFAULT '[]',
  credential_hash TEXT COLLATE "C" NOT NULL,
  ephemeral       BOOLEAN NOT NULL DEFAULT false,
  created_by      TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ(3),
  revoked_at      TIMESTAMPTZ(3),
  expires_at      TIMESTAMPTZ(3),
  source          JSONB
);

CREATE UNIQUE INDEX runners_credential_idx ON runners(credential_hash);
CREATE INDEX runners_project_idx ON runners(project_id);
CREATE INDEX runners_ephemeral_idx ON runners(project_id, expires_at) WHERE ephemeral = true;

CREATE UNIQUE INDEX runners_live_name_idx ON runners(project_id, name) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX runners_live_site_name_idx ON runners(name)
  WHERE project_id IS NULL AND revoked_at IS NULL;

CREATE TABLE dispatches (
  id               TEXT COLLATE "C" PRIMARY KEY,
  project_id       TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind             TEXT COLLATE "C" NOT NULL CHECK (kind IN ('group','media','mint')),
  ref_id           TEXT COLLATE "C" NOT NULL,
  attempt          INTEGER NOT NULL,
  executor_id      TEXT COLLATE "C" REFERENCES executors(id) ON DELETE SET NULL,
  status           TEXT COLLATE "C" NOT NULL CHECK (status IN ('requested','scheduled','running','concluded','reconciled_dead')),
  labels           JSONB,
  target           JSONB,
  runner_id        TEXT COLLATE "C" REFERENCES runners(id) ON DELETE SET NULL,
  claimed_at       TIMESTAMPTZ(3),
  heartbeat_at     TIMESTAMPTZ(3),
  canceled_at      TIMESTAMPTZ(3),
  requested_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  concluded_at     TIMESTAMPTZ(3),
  error            TEXT COLLATE "C",
  created_at       TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX dispatches_ref_idx ON dispatches(kind, ref_id, attempt);

CREATE UNIQUE INDEX dispatches_active_group_idx ON dispatches(ref_id)
  WHERE kind = 'group' AND status IN ('requested','scheduled','running');
CREATE INDEX dispatches_project_active_idx ON dispatches(project_id, status);
CREATE INDEX dispatches_runner_idx ON dispatches(runner_id) WHERE runner_id IS NOT NULL;
CREATE INDEX dispatches_board_idx ON dispatches(project_id, status, requested_at)
  WHERE claimed_at IS NULL;

CREATE TABLE runs (
  id                   TEXT COLLATE "C" PRIMARY KEY,
  run_group_id         TEXT COLLATE "C" NOT NULL REFERENCES run_groups(id) ON DELETE CASCADE,
  case_id              TEXT COLLATE "C" NOT NULL,
  story_id             TEXT COLLATE "C",
  run_id               TEXT COLLATE "C" NOT NULL,
  status               TEXT COLLATE "C" NOT NULL CHECK (status IN ('queued','running','uploading','pass','fail','infra','explored','canceled','lost')),
  mode                 TEXT COLLATE "C" NOT NULL CHECK (mode IN ('record','act','heal','explore')),
  healed               BOOLEAN NOT NULL DEFAULT false,
  changed              BOOLEAN NOT NULL DEFAULT false,
  manifest             JSONB,
  totals               JSONB,
  score                INTEGER,
  gate                 JSONB,
  pins                 JSONB,
  progress             JSONB,
  duration_ms          INTEGER,
  started_at           TIMESTAMPTZ(3),
  finished_at          TIMESTAMPTZ(3),
  baseline_id          TEXT COLLATE "C",
  executor_id          TEXT COLLATE "C" REFERENCES executors(id) ON DELETE SET NULL,
  error                TEXT COLLATE "C",
  artifact_tier        TEXT COLLATE "C" NOT NULL DEFAULT 'full' CHECK (artifact_tier IN ('full','core','meta')),
  retention_pruned_at  TIMESTAMPTZ(3),
  retention_provenance JSONB NOT NULL DEFAULT '{}',

  live_opened_at           TIMESTAMPTZ(3),
  live_manifest            JSONB,
  live_manifest_generation INTEGER NOT NULL DEFAULT 0,
  live_activity_at         TIMESTAMPTZ(3),
  created_at           TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (run_group_id, run_id)
);

CREATE INDEX runs_group_idx ON runs(run_group_id);
CREATE INDEX runs_status_idx ON runs(status);
CREATE INDEX runs_story_idx ON runs(story_id, created_at DESC);
CREATE INDEX runs_artifact_tier_idx ON runs(artifact_tier, finished_at);
CREATE INDEX runs_live_open_idx ON runs(live_opened_at) WHERE live_opened_at IS NOT NULL;

CREATE TABLE run_events (
  run_id   TEXT COLLATE "C" NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  ts       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  type     TEXT COLLATE "C" NOT NULL,
  payload  JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX run_events_ts_idx ON run_events(ts DESC);

CREATE TABLE artifacts (
  id           TEXT COLLATE "C" PRIMARY KEY,
  run_id       TEXT COLLATE "C" NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind         TEXT COLLATE "C" NOT NULL CHECK (kind IN ('bundle','index','clip','clip_vtt')),
  key          TEXT COLLATE "C" NOT NULL,
  sha256       TEXT COLLATE "C" NOT NULL,
  size         INTEGER NOT NULL,
  tier         TEXT COLLATE "C" NOT NULL CHECK (tier IN ('full','core')),
  verified_at  TIMESTAMPTZ(3) NOT NULL,
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX artifacts_run_idx ON artifacts(run_id);
CREATE UNIQUE INDEX artifacts_run_kind_idx ON artifacts(run_id, kind, tier);

CREATE TABLE live_artifacts (
  id         TEXT COLLATE "C" PRIMARY KEY,
  run_id     TEXT COLLATE "C" NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  entry      TEXT COLLATE "C" NOT NULL,
  key        TEXT COLLATE "C" NOT NULL,
  state      TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending','ready')),

  size       INTEGER NOT NULL,



  sha256     TEXT COLLATE "C" NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX live_artifacts_run_entry_idx ON live_artifacts(run_id, entry);
CREATE INDEX live_artifacts_state_idx ON live_artifacts(state, created_at);

CREATE TABLE live_trajectory (
  id         TEXT COLLATE "C" PRIMARY KEY,
  run_id     TEXT COLLATE "C" NOT NULL REFERENCES runs(id) ON DELETE CASCADE,


  from_line  INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,

  text       TEXT COLLATE "C" NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX live_trajectory_run_from_idx ON live_trajectory(run_id, from_line);

CREATE TABLE baselines (
  id                    TEXT COLLATE "C" PRIMARY KEY,
  project_id            TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id              TEXT COLLATE "C" NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  story_id              TEXT COLLATE "C" NOT NULL,
  version               INTEGER NOT NULL,
  trajectory_key        TEXT COLLATE "C" NOT NULL,
  meta                  JSONB NOT NULL,
  accepted_by           TEXT COLLATE "C" REFERENCES users(id),
  accepted_from_run_id  TEXT COLLATE "C" REFERENCES runs(id) ON DELETE SET NULL,
  superseded_by         TEXT COLLATE "C",
  created_at            TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (suite_id, story_id, version)
);

CREATE INDEX baselines_project_idx ON baselines(project_id);
CREATE INDEX baselines_story_idx ON baselines(suite_id, story_id, version DESC);

CREATE TABLE candidates (
  id              TEXT COLLATE "C" PRIMARY KEY,
  project_id      TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id        TEXT COLLATE "C" NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  story_id        TEXT COLLATE "C" NOT NULL,
  run_id          TEXT COLLATE "C" NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  trajectory_key  TEXT COLLATE "C" NOT NULL,
  meta            JSONB NOT NULL,
  status          TEXT COLLATE "C" NOT NULL CHECK (status IN ('pending','accepted','rejected','superseded')),
  diff_summary    JSONB,
  resolved_by     TEXT COLLATE "C" REFERENCES users(id),
  resolved_at     TIMESTAMPTZ(3),
  created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX candidates_project_idx ON candidates(project_id, status);
CREATE INDEX candidates_story_idx ON candidates(suite_id, story_id, status);

CREATE TABLE findings (
  id             TEXT COLLATE "C" PRIMARY KEY,
  project_id     TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint    TEXT COLLATE "C" NOT NULL,
  title          TEXT COLLATE "C" NOT NULL,
  summary        JSONB NOT NULL DEFAULT '{}',
  severity       TEXT COLLATE "C" NOT NULL CHECK (severity IN ('info','minor','major')),
  state          TEXT COLLATE "C" NOT NULL CHECK (state IN ('new','accepted','rejected','resolved','reopened')),
  reject_reason  TEXT COLLATE "C" CHECK (reject_reason IS NULL OR reject_reason IN ('not_a_bug','wont_fix','duplicate')),
  external_ref   TEXT COLLATE "C",
  merged_into    TEXT COLLATE "C" REFERENCES findings(id) ON DELETE SET NULL,
  first_seen     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),




  category            TEXT COLLATE "C",
  source              TEXT COLLATE "C",
  signal_type         TEXT COLLATE "C",
  locus               JSONB,
  normalized_locus    TEXT COLLATE "C",
  strict_key          TEXT COLLATE "C",
  loose_key           TEXT COLLATE "C",
  key_algo_version    TEXT COLLATE "C",
  locus_norm_version  TEXT COLLATE "C",
  match_text          TEXT COLLATE "C",
  match_text_version  TEXT COLLATE "C",



  suggested_finding_id TEXT COLLATE "C" REFERENCES findings(id) ON DELETE SET NULL,
  suggestion_kind      TEXT COLLATE "C" CHECK (suggestion_kind IS NULL OR suggestion_kind IN ('loose_key')),



  recurrence_count INTEGER NOT NULL DEFAULT 0,
  first_run_id     TEXT COLLATE "C" REFERENCES runs(id) ON DELETE SET NULL,



  resolved_by_run_id TEXT COLLATE "C" REFERENCES runs(id) ON DELETE SET NULL,
  auto_resolved_at   TIMESTAMPTZ(3),

  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX findings_project_fingerprint_active_idx
  ON findings(project_id, fingerprint)
  WHERE merged_into IS NULL;
CREATE INDEX findings_project_queue_idx ON findings(project_id, state, severity, last_seen DESC)
  WHERE merged_into IS NULL;
CREATE INDEX findings_merged_idx ON findings(merged_into);
CREATE INDEX findings_strict_key_idx ON findings(project_id, strict_key);
CREATE INDEX findings_loose_key_idx ON findings(project_id, loose_key);
CREATE INDEX findings_resolved_by_run_idx ON findings(resolved_by_run_id)
  WHERE resolved_by_run_id IS NOT NULL;

CREATE TABLE finding_evidence (
  id          TEXT COLLATE "C" PRIMARY KEY,
  finding_id  TEXT COLLATE "C" NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  run_id      TEXT COLLATE "C" NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id     TEXT COLLATE "C" NOT NULL,
  step_from   INTEGER,
  step_to     INTEGER,
  excerpt     TEXT COLLATE "C",
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX finding_evidence_finding_idx ON finding_evidence(finding_id, created_at DESC);
CREATE INDEX finding_evidence_run_idx ON finding_evidence(run_id);

CREATE TABLE finding_intake_keys (
  id          TEXT COLLATE "C" PRIMARY KEY,
  project_id  TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  intake_key  TEXT COLLATE "C" NOT NULL,
  finding_id  TEXT COLLATE "C" NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX finding_intake_keys_finding_idx ON finding_intake_keys(finding_id);
CREATE UNIQUE INDEX finding_intake_keys_key_idx ON finding_intake_keys(project_id, intake_key);

CREATE TABLE finding_resolution_stamps (
  finding_id  TEXT COLLATE "C" NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  suite_id    TEXT COLLATE "C" NOT NULL,
  ring_id     TEXT COLLATE "C" NOT NULL,
  case_id     TEXT COLLATE "C" NOT NULL,
  run_id      TEXT COLLATE "C" REFERENCES runs(id) ON DELETE SET NULL,
  method      TEXT COLLATE "C" NOT NULL CHECK (method IN ('gate_pass', 'signal_absent', 'case_pass', 'verified_absent')),
  stamped_at  TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY (finding_id, suite_id, ring_id, case_id)
);

CREATE TABLE consolidation_plans (
  id                  TEXT COLLATE "C" PRIMARY KEY,
  project_id          TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status              TEXT COLLATE "C" NOT NULL CHECK (status IN ('proposed','applied','discarded')),


  thresholds          JSONB NOT NULL,
  shortlist_version   TEXT COLLATE "C" NOT NULL,
  match_text_version  TEXT COLLATE "C" NOT NULL,





  plan                JSONB NOT NULL,



  scope               JSONB NOT NULL,
  usage               JSONB,



  prompt_version      TEXT COLLATE "C",
  model               TEXT COLLATE "C",




  candidate_digest    TEXT COLLATE "C" NOT NULL,

  created_by          JSONB NOT NULL,
  applied_by          JSONB,
  created_at          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  applied_at          TIMESTAMPTZ(3),
  updated_at          TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX consolidation_plans_project_idx ON consolidation_plans(project_id, created_at DESC);
CREATE INDEX consolidation_plans_status_idx ON consolidation_plans(project_id, status, created_at DESC);

CREATE TABLE consolidation_labels (
  id                 TEXT COLLATE "C" PRIMARY KEY,
  project_id         TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id            TEXT COLLATE "C" REFERENCES consolidation_plans(id) ON DELETE SET NULL,
  subject_finding_id TEXT COLLATE "C" REFERENCES findings(id) ON DELETE SET NULL,
  finding_id         TEXT COLLATE "C" REFERENCES findings(id) ON DELETE SET NULL,
  origin             TEXT COLLATE "C" NOT NULL,
  score              DOUBLE PRECISION,
  confidence         TEXT COLLATE "C",
  decision           TEXT COLLATE "C" NOT NULL CHECK (decision IN ('confirmed','edited','rejected','unresolved')),
  detail             JSONB,
  actor              JSONB NOT NULL,
  created_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX consolidation_labels_project_idx ON consolidation_labels(project_id, created_at DESC);
CREATE INDEX consolidation_labels_plan_idx ON consolidation_labels(plan_id);
CREATE INDEX consolidation_labels_subject_idx ON consolidation_labels(subject_finding_id);

CREATE TABLE audit_log (
  id           TEXT COLLATE "C" PRIMARY KEY,
  ts           TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  project_id   TEXT COLLATE "C",
  actor        JSONB NOT NULL,
  action       TEXT COLLATE "C" NOT NULL,
  entity_type  TEXT COLLATE "C" NOT NULL,
  entity_id    TEXT COLLATE "C",
  detail       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_log_project_idx ON audit_log(project_id, ts DESC);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_log_ts_idx ON audit_log(ts DESC);

CREATE TABLE platform_events (
  id          TEXT COLLATE "C" PRIMARY KEY,
  project_id  TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT COLLATE "C" NOT NULL,
  entity      JSONB NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  ts          TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX platform_events_project_idx ON platform_events(project_id, id);
CREATE INDEX platform_events_type_idx ON platform_events(type);

CREATE TABLE leases (
  name        TEXT COLLATE "C" PRIMARY KEY,
  owner       TEXT COLLATE "C" NOT NULL,
  acquired_at TIMESTAMPTZ(3) NOT NULL,
  renewed_at  TIMESTAMPTZ(3) NOT NULL,
  expires_at  TIMESTAMPTZ(3) NOT NULL
);

CREATE TABLE service_heartbeats (
  name    TEXT COLLATE "C" PRIMARY KEY,
  beat_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  detail  JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE executors ADD CONSTRAINT executors_dispatch_id_fkey FOREIGN KEY (dispatch_id) REFERENCES dispatches(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION jsonb_merge_patch(target jsonb, patch jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE k text; v jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(patch) <> 'object' THEN RETURN patch; END IF;
  result := CASE WHEN jsonb_typeof(target) = 'object' THEN target ELSE '{}'::jsonb END;
  FOR k, v IN SELECT * FROM jsonb_each(patch) LOOP
    IF v = 'null'::jsonb THEN result := result - k;
    ELSE result := jsonb_set(result, ARRAY[k], jsonb_merge_patch(COALESCE(result -> k, 'null'::jsonb), v), true);
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

CREATE FUNCTION jsonb_remove_paths(target jsonb, VARIADIC paths text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE p text;
BEGIN
  FOREACH p IN ARRAY paths LOOP
    target := target #- string_to_array(substr(p, 3), '.');
  END LOOP;
  RETURN target;
END;
$$;
