-- The control-plane baseline (docs/contracts/hosted.md).
--
-- This file REPLACES the retired `0001_control_plane` … `0020_environment_drivers`
-- lineage. The applications/rings model has no migration from the environments
-- model it supersedes, so the deployment is greenfield: a data root whose
-- `schema_migrations` ledger names any retired file fails boot with an
-- actionable reset message (src/migrate.ts) rather than being converted in
-- place by the forward-only migrator.
--
-- Column-type conventions the row decoder reads back (src/db.ts):
--   TEXT_JSON  JSON document, parsed on read and canonical-JSON encoded on write
--   INT_TS     epoch milliseconds, decoded to a Date
--   INT_BOOL   0/1, decoded to a boolean

-- ---------------------------------------------------------------------------
-- Identity and tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  subject     TEXT UNIQUE NOT NULL,           -- OIDC sub
  email       TEXT NOT NULL,
  name        TEXT,
  disabled    INT_BOOL NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,               -- cookie value (opaque, random)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INT_TS NOT NULL,
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,           -- short slug
  name        TEXT NOT NULL,
  archived    INT_BOOL NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  -- Project-level actor/grader model policy; a suite's own playtest.yaml wins.
  models      TEXT_JSON NOT NULL DEFAULT '{}',
  -- Tri-state policy pins: NULL inherits the deployment default.
  auto_dedupe INT_BOOL CHECK (auto_dedupe IS NULL OR auto_dedupe IN (0, 1)),
  auto_resolve INT_BOOL CHECK (auto_resolve IS NULL OR auto_resolve IN (0, 1)),
  auto_resolve_mode TEXT CHECK (auto_resolve_mode IS NULL OR auto_resolve_mode IN ('semi', 'full')),
  parallel    TEXT_JSON NOT NULL DEFAULT '{"record":1,"total":1}',
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE memberships (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer','editor','reviewer','developer','admin')),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (user_id, project_id)
);

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

-- ---------------------------------------------------------------------------
-- Applications and rings — the test surfaces a project owns
-- ---------------------------------------------------------------------------

-- An application is ONE executable test surface: a web app, an HTTP API, or a
-- mobile build for one platform. `Todo Web` and `Todo iOS` are two applications
-- even when a person thinks of them as one product, because core has to pick a
-- different driver for each.
--
-- `key` is immutable and unique in the project: runner configuration and run
-- evidence address an application by key, so renaming one would silently rebind
-- a machine's bindings. `driver` and `platform` are immutable for the same
-- reason — v1 has no rebind, and delete-and-recreate is the stated remedy.
CREATE TABLE applications (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  driver      TEXT NOT NULL CHECK (driver IN ('web','api','mobile')),
  -- Required for mobile (core must choose XCUITest or UiAutomator2) and refused
  -- for every other driver — one CHECK, both directions.
  platform    TEXT CHECK (platform IS NULL OR platform IN ('ios','android')),
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, key),
  CHECK ((driver = 'mobile') = (platform IS NOT NULL))
);

CREATE INDEX applications_project_idx ON applications(project_id);

-- A ring is an application-owned deployment target: `local`, `staging`, `prod`.
--
-- `base_url` is a first-class column, required for web/API rings and refused for
-- mobile ones, and it is evaluated FROM THE CLAIMING RUNNER'S NETWORK POSITION —
-- a loopback URL means "on the runner's own machine", and `runner_labels` are
-- how such a ring is routed to the right machine.
--
-- `config` is the LOGICAL overlay only: auth identities and defaults,
-- `secret_env`, cookies/headers/settle, setup inputs. It is validated against an
-- allowlist (src/api/applications.ts), so the five physical fields — `base_url`,
-- `app`, `platform`, `device`, `appium_url` — can never enter it at the overlay
-- positions where they would take effect. A mobile build's path, its device and
-- its Appium endpoint are runner-local facts and live only in a runner's own
-- configuration file; no platform-managed record stores or serves them.
CREATE TABLE rings (
  id                TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  key               TEXT NOT NULL,
  name              TEXT NOT NULL,
  base_url          TEXT,
  runner_labels     TEXT_JSON NOT NULL DEFAULT '[]',
  -- The discovery guardrail, made enforceable: discovery agents genuinely click
  -- buy, delete and submit, so a discovery story only runs on a ring a developer
  -- explicitly opened.
  discovery_allowed INT_BOOL NOT NULL DEFAULT 0 CHECK (discovery_allowed IN (0,1)),
  config            TEXT_JSON NOT NULL DEFAULT '{}',
  created_at        INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at        INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (application_id, key)
);

CREATE INDEX rings_application_idx ON rings(application_id);

-- ---------------------------------------------------------------------------
-- Suites of record
-- ---------------------------------------------------------------------------

-- A suite belongs to exactly ONE application, chosen at creation and immutable:
-- the suite's driver IS the application's driver, and the launch selector is
-- (suite, ring), so a suite can never launch against another surface's ring.
CREATE TABLE suites (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  archived       INT_BOOL NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, slug)
);

CREATE INDEX suites_application_idx ON suites(application_id);

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

CREATE TABLE personas (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  blob_sha256   TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id),
  created_at    INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at    INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, slug)
);

CREATE TABLE rule_cards (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id           TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  rule_id            TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('candidate', 'approved', 'denied')),
  origin             TEXT NOT NULL CHECK (origin IN ('proposed', 'authored')),
  title              TEXT,
  statement          TEXT NOT NULL,
  applicability      TEXT,
  exceptions         TEXT,
  provenance         TEXT,
  note               TEXT,
  proposed_statement TEXT,
  prompt_version     TEXT,
  decided_by         TEXT REFERENCES users(id),
  decided_at         INT_TS,
  created_at         INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at         INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (suite_id, rule_id)
);

CREATE INDEX rule_cards_project_idx ON rule_cards(project_id);
CREATE INDEX rule_cards_suite_idx ON rule_cards(suite_id, state);

-- ---------------------------------------------------------------------------
-- Secrets and target authentication
-- ---------------------------------------------------------------------------

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

-- `ring_id` NULL means a project-wide provider: every ring may reference it, and
-- its standalone mints carry empty labels. A ring-bound provider is reachable
-- ONLY from that ring (src/dispatch/sessions.ts), so one ring can never borrow
-- another's credentials.
--
-- ON DELETE RESTRICT, never SET NULL: silently promoting a ring-bound provider
-- to project-wide would move secrets policy without anyone deciding it.
CREATE TABLE auth_providers (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ring_id         TEXT REFERENCES rings(id) ON DELETE RESTRICT,
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
CREATE INDEX auth_providers_ring_idx ON auth_providers(ring_id);

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

-- ---------------------------------------------------------------------------
-- Runs, dispatch, and the claim board
-- ---------------------------------------------------------------------------

-- A launch pins the suite snapshot AND the (application, ring) it resolved. The
-- three are checked to agree inside the launch transaction, so a group always
-- reads back as a self-consistent statement of what ran where.
CREATE TABLE run_groups (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id        TEXT NOT NULL REFERENCES suites(id) ON DELETE RESTRICT,
  snapshot_id     TEXT NOT NULL REFERENCES suite_snapshots(id) ON DELETE RESTRICT,
  application_id  TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  ring_id         TEXT NOT NULL REFERENCES rings(id) ON DELETE RESTRICT,
  trigger         TEXT_JSON NOT NULL,
  selection       TEXT_JSON NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','done','canceled')),
  -- NULL unless THIS launch pinned its placement labels, so a group reads back
  -- saying whether its placement was a launch decision or the ring's standing one.
  runner_labels   TEXT_JSON,
  exit_summary    TEXT_JSON,
  created_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX run_groups_project_idx ON run_groups(project_id, created_at DESC);
CREATE INDEX run_groups_status_idx ON run_groups(status);
CREATE INDEX run_groups_suite_idx ON run_groups(suite_id);
CREATE INDEX run_groups_ring_idx ON run_groups(ring_id);
CREATE INDEX run_groups_application_idx ON run_groups(application_id);

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

-- A self-hosted runner's identity. Labels ROUTE work; they never authorize it.
-- `project_id` is NULL for a SITE-SCOPED runner: a machine a site operator has
-- deliberately trusted with every project's suites and secrets, polling one
-- board across all of them. Project scope stays the default and the only scope
-- a project developer can create.
CREATE TABLE runners (
  id              TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  labels          TEXT_JSON NOT NULL DEFAULT '[]',
  credential_hash TEXT NOT NULL,
  ephemeral       INT_BOOL NOT NULL DEFAULT 0 CHECK (ephemeral IN (0,1)),
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_seen_at    INT_TS,
  revoked_at      INT_TS,
  expires_at      INT_TS,
  source          TEXT_JSON
);

CREATE UNIQUE INDEX runners_credential_idx ON runners(credential_hash);
CREATE INDEX runners_project_idx ON runners(project_id);
CREATE INDEX runners_ephemeral_idx ON runners(project_id, expires_at) WHERE ephemeral = 1;
-- A revoked runner's name is free to reuse; a live one's is not.
CREATE UNIQUE INDEX runners_live_name_idx ON runners(project_id, name) WHERE revoked_at IS NULL;
-- …and the index above cannot do that job for site runners: SQLite treats NULLs
-- as distinct, so every site runner's (NULL, name) pair is unique by definition.
-- A partial index over the site rows is what actually keeps `local` singular.
CREATE UNIQUE INDEX runners_live_site_name_idx ON runners(name)
  WHERE project_id IS NULL AND revoked_at IS NULL;

-- The dispatch ledger. Under pull-based placement a `requested` row plus its
-- labels snapshot IS the claim-board entry.
--
-- `target` is this attempt's NON-SECRET target snapshot — application and ring
-- ids and keys, driver, platform, ring URL, labels, and the logical overlay —
-- so a ring edit between preview, poll, claim and exchange cannot make the
-- offer and the group spec disagree. A retry snapshots current ring state.
-- Secrets are never in it; they are resolved when the group spec is served.
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
  labels           TEXT_JSON,
  target           TEXT_JSON,
  runner_id        TEXT REFERENCES runners(id) ON DELETE SET NULL,
  claimed_at       INT_TS,
  heartbeat_at     INT_TS,
  canceled_at      INT_TS,
  requested_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  concluded_at     INT_TS,
  error            TEXT,
  created_at       INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX dispatches_ref_idx ON dispatches(kind, ref_id, attempt);
CREATE INDEX dispatches_workflow_idx ON dispatches(workflow_run_id);
CREATE INDEX dispatches_project_active_idx ON dispatches(project_id, status);
CREATE INDEX dispatches_runner_idx ON dispatches(runner_id) WHERE runner_id IS NOT NULL;
CREATE INDEX dispatches_board_idx ON dispatches(project_id, status, requested_at)
  WHERE claimed_at IS NULL;

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
  progress             TEXT_JSON,
  duration_ms          INTEGER,
  started_at           INT_TS,
  finished_at          INT_TS,
  baseline_id          TEXT,
  executor_id          TEXT REFERENCES executors(id) ON DELETE SET NULL,
  error                TEXT,
  artifact_tier        TEXT NOT NULL DEFAULT 'full' CHECK (artifact_tier IN ('full','core','meta')),
  retention_pruned_at  INT_TS,
  retention_provenance TEXT_JSON NOT NULL DEFAULT '{}',
  -- Live-run staging state (docs/contracts/hosted.md, "Live runs").
  live_opened_at           INT_TS,
  live_manifest            TEXT_JSON,
  live_manifest_generation INTEGER NOT NULL DEFAULT 0,
  live_activity_at         INT_TS,
  created_at           INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at           INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (run_group_id, run_id)
);

CREATE INDEX runs_group_idx ON runs(run_group_id);
CREATE INDEX runs_status_idx ON runs(status);
CREATE INDEX runs_story_idx ON runs(story_id, created_at DESC);
CREATE INDEX runs_artifact_tier_idx ON runs(artifact_tier, finished_at);
CREATE INDEX runs_live_open_idx ON runs(live_opened_at) WHERE live_opened_at IS NOT NULL;

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

-- Live staging: screenshots and trajectory lines a runner uploads WHILE a case
-- is in flight, served to the viewer and discarded when the sealed bundle lands.
CREATE TABLE live_artifacts (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- The bundle-relative entry path (steps/NNN.png and its profile siblings).
  entry      TEXT NOT NULL,
  key        TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('pending','ready')),
  -- Charged against the run's live budget from the reservation onward.
  size       INTEGER NOT NULL,
  -- Recorded at reservation: an identical-bytes retry is answered from the row
  -- without charging budget twice, and different bytes for the same entry are
  -- refused.
  sha256     TEXT NOT NULL,
  created_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE UNIQUE INDEX live_artifacts_run_entry_idx ON live_artifacts(run_id, entry);
CREATE INDEX live_artifacts_state_idx ON live_artifacts(state, created_at);

CREATE TABLE live_trajectory (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- 0-based index of this batch's first line. Batches are contiguous by
  -- construction, so MAX(from_line + line_count) is the authoritative count.
  from_line  INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  -- `line_count` whole trajectory.jsonl lines, each newline-terminated.
  text       TEXT NOT NULL,
  created_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE UNIQUE INDEX live_trajectory_run_from_idx ON live_trajectory(run_id, from_line);

-- ---------------------------------------------------------------------------
-- Review: baselines and changed-journey candidates
-- ---------------------------------------------------------------------------

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
  diff_summary    TEXT_JSON,
  resolved_by     TEXT REFERENCES users(id),
  resolved_at     INT_TS,
  created_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX candidates_project_idx ON candidates(project_id, status);
CREATE INDEX candidates_story_idx ON candidates(suite_id, story_id, status);

-- ---------------------------------------------------------------------------
-- Findings
-- ---------------------------------------------------------------------------

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

  -- Identity. Computed server-side from trusted, recorded context only; model
  -- text and the model-chosen category never enter a key. A NULL signal_type
  -- means no deterministic signal, hence no exact keys.
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

  -- Auto-resolution provenance: which run closed it and when. Cleared whenever
  -- the finding leaves `resolved`.
  resolved_by_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  auto_resolved_at   INT_TS,

  created_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
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

CREATE TABLE finding_intake_keys (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  intake_key  TEXT NOT NULL,
  finding_id  TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  created_at  INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX finding_intake_keys_finding_idx ON finding_intake_keys(finding_id);
CREATE UNIQUE INDEX finding_intake_keys_key_idx ON finding_intake_keys(project_id, intake_key);

-- The auto-resolve ledger: one stamp per (finding, suite, RING, case) triple
-- recording the newer run that disproved the finding on that triple under its
-- tier's test. The finding resolves only when every affected triple carries a
-- stamp newer than that triple's latest evidence — stamps are never deleted on
-- new evidence, they go stale by timestamp comparison, and history stays across
-- reopens. The ring replaces the environment the key used to embed.
CREATE TABLE finding_resolution_stamps (
  finding_id  TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  suite_id    TEXT NOT NULL,
  ring_id     TEXT NOT NULL,
  case_id     TEXT NOT NULL,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  method      TEXT NOT NULL CHECK (method IN ('gate_pass', 'signal_absent', 'case_pass', 'verified_absent')),
  stamped_at  INT_TS NOT NULL,
  PRIMARY KEY (finding_id, suite_id, ring_id, case_id)
);

-- ---------------------------------------------------------------------------
-- Consolidation
-- ---------------------------------------------------------------------------

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
  -- storage fixtures remain readable.
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

CREATE INDEX consolidation_labels_project_idx ON consolidation_labels(project_id, created_at DESC);
CREATE INDEX consolidation_labels_plan_idx ON consolidation_labels(plan_id);
CREATE INDEX consolidation_labels_subject_idx ON consolidation_labels(subject_finding_id);

-- ---------------------------------------------------------------------------
-- Platform plumbing: audit, events, leases, heartbeats
-- ---------------------------------------------------------------------------

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

CREATE INDEX audit_log_project_idx ON audit_log(project_id, ts DESC);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_log_ts_idx ON audit_log(ts DESC);

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

CREATE TABLE leases (
  name        TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  acquired_at INT_TS NOT NULL,
  renewed_at  INT_TS NOT NULL,
  expires_at  INT_TS NOT NULL
);

CREATE TABLE service_heartbeats (
  name    TEXT PRIMARY KEY,
  beat_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  detail  TEXT_JSON NOT NULL DEFAULT '{}'
);
