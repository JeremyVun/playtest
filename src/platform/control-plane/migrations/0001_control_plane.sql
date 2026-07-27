-- Control-plane schema for SQLite. One fresh forward-only baseline: this is the
-- post-simplification (Postgres 0009) shape, translated per
-- docs/backlog/storage/S0-INVENTORY.md. The nine Postgres migrations it replaces
-- are gone; there is no prior SQLite schema version to upgrade from.
--
-- Declared column types carry the *logical* type so `src/db.js` can decode rows
-- without a hand-maintained map (PRAGMA table_info reports the declared type
-- verbatim, and SQLite's affinity rules still apply on the substring):
--
--   TEXT       plain text                       (TEXT affinity)
--   TEXT_JSON  canonical JSON document or array (TEXT affinity)
--   INTEGER    number                           (INTEGER affinity)
--   INT_TS     UTC epoch-milliseconds timestamp (INTEGER affinity)
--   INT_BOOL   0/1 boolean                      (INTEGER affinity)
--   BLOB       bytes                            (BLOB affinity)
--
-- Timestamp defaults compute epoch milliseconds inline; every application write
-- uses the `now()` function registered by the adapter, which is frozen at
-- transaction start (matching Postgres `now()` semantics).

-- ---------- identity & tenancy ----------

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  subject     TEXT UNIQUE NOT NULL,           -- OIDC sub
  email       TEXT NOT NULL,
  name        TEXT,
  disabled    INT_BOOL NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,           -- short slug
  name        TEXT NOT NULL,
  archived    INT_BOOL NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- Roles are cumulative: admin ⊇ developer ⊇ reviewer ⊇ editor ⊇ viewer.
CREATE TABLE memberships (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer','editor','reviewer','developer','admin')),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,               -- cookie value (opaque, random)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INT_TS NOT NULL,
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Service tokens (CI trigger, runner bootstrap). project_id null = site-scoped.
-- Only the hash is stored; the plaintext is shown once at creation.
CREATE TABLE api_tokens (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer','editor','reviewer','developer','admin')),
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  expires_at  INT_TS,
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX api_tokens_project_idx ON api_tokens(project_id);

-- ---------- suite of record ----------

CREATE TABLE suites (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  archived    INT_BOOL NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, slug)
);

-- The live editable file set. `content` is the exact bytes (text). Ajv-validated on
-- write for yaml kinds with the SAME core schemas + DummyConfigError rendering as
-- the CLI. path is suite-root-relative.
CREATE TABLE suite_files (
  id          TEXT PRIMARY KEY,
  suite_id    TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('defaults','case','persona','hook','assertion','asset')),
  content     TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (suite_id, path)
);
CREATE INDEX suite_files_suite_idx ON suite_files(suite_id);

-- Every mutation (single or batched commit) produces exactly one snapshot; seq is
-- per-suite monotonic. tree is { "<path>": "<sha256>" }; blobs live at
-- blobs/<sha256> in object storage (content-addressed, deduped, immutable).
CREATE TABLE suite_snapshots (
  id          TEXT PRIMARY KEY,
  suite_id    TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  tree        TEXT_JSON NOT NULL,
  created_by  TEXT REFERENCES users(id),
  note        TEXT,
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (suite_id, seq)
);
CREATE INDEX suite_snapshots_suite_idx ON suite_snapshots(suite_id);

-- ---------- environments & secrets ----------

-- config: { app: {…}, auth: {…}, secret_env: {…} } — a core-shaped app{} overlay
-- merged at materialization as app.envs.<name> (§3a).
CREATE TABLE environments (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  config            TEXT_JSON NOT NULL DEFAULT '{}',
  discovery_allowed INT_BOOL NOT NULL DEFAULT 0 CHECK (discovery_allowed IN (0,1)),
  runner_labels     TEXT_JSON NOT NULL DEFAULT '[]',   -- was Postgres text[]
  created_at        INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at        INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, name)
);

-- AES-256-GCM ciphertext under the platform KMS key. GET lists names only; plaintext
-- is delivered only to a runner. Write-only from the UI.
CREATE TABLE secrets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ciphertext  BLOB NOT NULL,
  created_by  TEXT REFERENCES users(id),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, name)
);

-- ---------- audit ----------

-- Append-only. actor is {user_id} | {token_id} | {system:"…"}; detail carries the
-- before/after refs (snapshot ids, changed paths, …). Every mutation writes here.
-- project_id is a denormalized scope column (nullable for site-level actions) so
-- `GET /projects/:p/audit` is one indexed query.
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  ts           INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  project_id   TEXT,
  actor        TEXT_JSON NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  detail       TEXT_JSON NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_log_project_idx ON audit_log(project_id, ts DESC);
CREATE INDEX audit_log_ts_idx ON audit_log(ts DESC);

-- ---------- target-app auth broker ----------

CREATE TABLE auth_providers (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id  TEXT REFERENCES environments(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('token_endpoint','storage_state_secret','script')),
  config          TEXT_JSON NOT NULL DEFAULT '{}',
  code            TEXT,
  identities      TEXT_JSON NOT NULL DEFAULT '{}',
  ttl_minutes     INTEGER NOT NULL DEFAULT 60,
  enabled         INT_BOOL NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_by      TEXT REFERENCES users(id),
  created_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, name)
);
CREATE INDEX auth_providers_project_idx ON auth_providers(project_id);
CREATE INDEX auth_providers_environment_idx ON auth_providers(environment_id);

CREATE TABLE session_artifacts (
  id             TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  identity       TEXT NOT NULL,
  ciphertext     BLOB NOT NULL,
  minted_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  expires_at     INT_TS NOT NULL,
  minted_by_job  TEXT,
  created_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (provider_id, identity)
);
CREATE INDEX session_artifacts_provider_idx ON session_artifacts(provider_id);
CREATE INDEX session_artifacts_expiry_idx ON session_artifacts(expires_at);

-- Session mint claims: the single-flight ledger for `script` auth providers,
-- whose storage state is minted by the claiming group executor rather than the
-- control plane. One pending row per (provider, identity) is the mint grant;
-- concurrent claimers see it and wait. Fulfilled rows are kept as breadcrumbs;
-- failed mints delete their claim so the next claimer takes over.
CREATE TABLE session_claims (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  identity    TEXT NOT NULL,
  executor_id TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | fulfilled
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  expires_at  INT_TS NOT NULL
);
CREATE INDEX session_claims_pending_idx
  ON session_claims(provider_id, identity) WHERE status = 'pending';

-- ---------- runs, dispatches, events ----------

CREATE TABLE run_groups (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id        TEXT NOT NULL REFERENCES suites(id) ON DELETE RESTRICT,
  snapshot_id     TEXT NOT NULL REFERENCES suite_snapshots(id) ON DELETE RESTRICT,
  environment_id  TEXT NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  trigger         TEXT_JSON NOT NULL,
  selection       TEXT_JSON NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','done','canceled')),
  exit_summary    TEXT_JSON,
  created_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX run_groups_project_idx ON run_groups(project_id, created_at DESC);
CREATE INDEX run_groups_suite_idx ON run_groups(suite_id);
CREATE INDEX run_groups_status_idx ON run_groups(status);

CREATE TABLE executors (
  id                TEXT PRIMARY KEY,
  run_group_id      TEXT REFERENCES run_groups(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('group','media','mint')),
  workflow_run_url  TEXT,
  versions          TEXT_JSON NOT NULL DEFAULT '{}',
  isolation         TEXT CHECK (isolation IS NULL OR isolation IN ('container','process')),
  registered_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_report_at    INT_TS,
  concluded_at      INT_TS,
  created_at        INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX executors_group_idx ON executors(run_group_id);

CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,
  run_group_id         TEXT NOT NULL REFERENCES run_groups(id) ON DELETE CASCADE,
  case_id              TEXT NOT NULL,
  story_id             TEXT,
  run_id               TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('queued','running','uploading','pass','fail','infra','explored','canceled','lost')),
  mode                 TEXT NOT NULL CHECK (mode IN ('record','act','heal','explore')),
  healed               INT_BOOL NOT NULL DEFAULT 0 CHECK (healed IN (0,1)),
  changed              INT_BOOL NOT NULL DEFAULT 0 CHECK (changed IN (0,1)),
  manifest             TEXT_JSON,
  totals               TEXT_JSON,
  score                INTEGER,
  gate                 TEXT_JSON,
  pins                 TEXT_JSON,
  duration_ms          INTEGER,
  started_at           INT_TS,
  finished_at          INT_TS,
  baseline_id          TEXT,
  executor_id          TEXT REFERENCES executors(id) ON DELETE SET NULL,
  error                TEXT,
  created_at           INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at           INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  artifact_tier        TEXT NOT NULL DEFAULT 'full' CHECK (artifact_tier IN ('full','core','meta')),
  retention_pruned_at  INT_TS,
  retention_provenance TEXT_JSON NOT NULL DEFAULT '{}',
  UNIQUE (run_group_id, run_id)
);
CREATE INDEX runs_group_idx ON runs(run_group_id);
CREATE INDEX runs_story_idx ON runs(story_id, created_at DESC);
CREATE INDEX runs_status_idx ON runs(status);
CREATE INDEX runs_artifact_tier_idx ON runs(artifact_tier, finished_at);

CREATE TABLE dispatches (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('group','media','mint')),
  ref_id           TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  workflow_run_id  TEXT,
  workflow_run_url TEXT,
  executor_id      TEXT REFERENCES executors(id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN ('requested','scheduled','running','concluded','reconciled_dead')),
  requested_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  concluded_at     INT_TS,
  error            TEXT,
  created_at       INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX dispatches_ref_idx ON dispatches(kind, ref_id, attempt);
CREATE INDEX dispatches_project_active_idx ON dispatches(project_id, status);
CREATE INDEX dispatches_workflow_idx ON dispatches(workflow_run_id);

CREATE TABLE run_events (
  run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  ts       INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  type     TEXT NOT NULL,
  payload  TEXT_JSON NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX run_events_ts_idx ON run_events(ts DESC);

CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('bundle','index','clip','clip_vtt')),
  key          TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  tier         TEXT NOT NULL CHECK (tier IN ('full','core')),
  verified_at  INT_TS NOT NULL,
  created_at   INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX artifacts_run_idx ON artifacts(run_id);
CREATE UNIQUE INDEX artifacts_run_kind_idx ON artifacts(run_id, kind, tier);

-- ---------- baselines / candidates ----------

CREATE TABLE baselines (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id              TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  story_id              TEXT NOT NULL,
  version               INTEGER NOT NULL,
  trajectory_key        TEXT NOT NULL,
  meta                  TEXT_JSON NOT NULL,
  accepted_by           TEXT REFERENCES users(id),
  accepted_from_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
  superseded_by         TEXT,
  created_at            INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at            INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (suite_id, story_id, version)
);
CREATE INDEX baselines_project_idx ON baselines(project_id);
CREATE INDEX baselines_story_idx ON baselines(suite_id, story_id, version DESC);

CREATE TABLE candidates (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id        TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  story_id        TEXT NOT NULL,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  trajectory_key  TEXT NOT NULL,
  meta            TEXT_JSON NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','superseded')),
  resolved_by     TEXT REFERENCES users(id),
  resolved_at     INT_TS,
  created_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  diff_summary    TEXT_JSON
);
CREATE INDEX candidates_project_idx ON candidates(project_id, status);
CREATE INDEX candidates_story_idx ON candidates(suite_id, story_id, status);

-- ---------- platform feed/outbox ----------

CREATE TABLE platform_events (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  entity      TEXT_JSON NOT NULL,
  payload     TEXT_JSON NOT NULL DEFAULT '{}',
  ts          INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX platform_events_project_idx ON platform_events(project_id, id);
CREATE INDEX platform_events_type_idx ON platform_events(type);

-- ---------- findings ----------

CREATE TABLE findings (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint    TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT_JSON NOT NULL DEFAULT '{}',
  severity       TEXT NOT NULL CHECK (severity IN ('info','minor','major')),
  state          TEXT NOT NULL CHECK (state IN ('new','accepted','rejected','resolved','reopened')),
  reject_reason  TEXT CHECK (reject_reason IS NULL OR reject_reason IN ('not_a_bug','wont_fix')),
  external_ref   TEXT,
  merged_into    TEXT REFERENCES findings(id) ON DELETE SET NULL,
  first_seen     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_seen      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  created_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX findings_project_fingerprint_active_idx
  ON findings(project_id, fingerprint)
  WHERE merged_into IS NULL;
CREATE INDEX findings_project_queue_idx ON findings(project_id, state, severity, last_seen DESC)
  WHERE merged_into IS NULL;
CREATE INDEX findings_merged_idx ON findings(merged_into);

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
CREATE INDEX finding_evidence_finding_idx ON finding_evidence(finding_id, created_at DESC);
CREATE INDEX finding_evidence_run_idx ON finding_evidence(run_id);

-- ---------- ops ----------

-- Background loops stamp one row per tick so the ops dashboard can show liveness
-- and lag instead of guessing. One row per service, upserted.
CREATE TABLE service_heartbeats (
  name    TEXT PRIMARY KEY,
  beat_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  detail  TEXT_JSON NOT NULL DEFAULT '{}'
);
