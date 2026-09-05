# Hosted Compose implementation inventory

Captured 2026-09-05 for P0. Paths below are relative to
`packages/platform/control-plane/` unless qualified. This records the current
SQLite implementation; it does not claim that the Postgres port has landed.
No environment file or old data root was read.

## Async database boundary

`src/db.ts` owns the only runtime DatabaseSync connection. `Tx.query` and
`Db.exec` now return promises; `src/migrate.ts` awaits scripts, and
`dispatch/state.ts` requires promise-based Queryable results. SQL execution,
SQLite decoding, FIFO order, nested transaction joining and callbacks retain
their existing semantics. Migration execution remains internal to withTx.

All transaction query calls in source and tests were audited, including
HostedDynamic callbacks: their results are awaited or returned. Loose query
batches in `api/projects.ts`, `tests/unit/dispatch-state.test.ts`, and
`tests/integration/suites-e2e.test.ts` are awaited through Promise.all. The
transaction regression now also asserts that its query returns a Promise.

Direct connection users: the adapter, `tests/unit/sqlite-storage.test.ts`
(post-commit visibility and standalone decoder fixture), and the standalone
`tests/bench/sqlite-contention.ts`. Migration alone uses Db.exec and
refreshSchema. The benchmark is SQLite-specific historical measurement, not
part of the deployment acceptance gate.

P1 must preserve the after-commit signal contract in `src/audit.ts`, the feed
waker and dispatch board, while replacing synchronous connection operations.
`src/ulid.ts` has process-local monotonic state; seed event ordering from
persisted platform_events before admitting requests.

## SQL schema and dialect

The baseline contains 37 tables. `0002_drop_discovery_allowed.sql`
removes rings.discovery_allowed; the Postgres baseline must represent that
effective schema. `schema_migrations` is created separately by the migrator.

Tables: `users`, `sessions`, `projects`, `memberships`, `api_tokens`, `applications`, `rings`, `suites`, `suite_files`, `suite_snapshots`, `personas`, `rule_cards`, `secrets`, `auth_providers`, `session_artifacts`, `session_claims`, `run_groups`, `executors`, `runners`, `dispatches`, `runs`, `run_events`, `artifacts`, `live_artifacts`, `live_trajectory`, `baselines`, `candidates`, `findings`, `finding_evidence`, `finding_intake_keys`, `finding_resolution_stamps`, `consolidation_plans`, `consolidation_labels`, `audit_log`, `platform_events`, `leases`, `service_heartbeats`.

Named unique indexes: `runners_credential_idx`, `runners_live_name_idx`, `runners_live_site_name_idx`, `dispatches_ref_idx`, `dispatches_active_group_idx`, `artifacts_run_kind_idx`, `live_artifacts_run_entry_idx`, `live_trajectory_run_from_idx`, `findings_project_fingerprint_active_idx`, `finding_intake_keys_key_idx`. Preserve all inline UNIQUE, CHECK, and foreign-key
clauses too. executors references dispatches before its declaration and dispatches
references executors; add that cyclic foreign key after both tables exist in
Postgres. Preserve delete actions and the initial nullable executor links.

Dialect-bearing source files:

- `src/api/applications.ts`
- `src/api/audit.ts`
- `src/api/auth-providers.ts`
- `src/api/findings.ts`
- `src/api/personas.ts`
- `src/api/pool.ts`
- `src/api/projects.ts`
- `src/api/review.ts`
- `src/api/runners.ts`
- `src/api/runs.ts`
- `src/api/site-runners.ts`
- `src/api/suites.ts`
- `src/api/viewer-adapter.ts`
- `src/dispatch/dispatcher.ts`
- `src/dispatch/state.ts`
- `src/findings/auto-dedupe.ts`
- `src/findings/auto-resolve.ts`
- `src/findings/consolidation.ts`
- `src/findings/intake.ts`
- `src/migrate.ts`
- `src/ops.ts`

Port TEXT_JSON to jsonb, INT_BOOL to boolean, INT_TS to timestamptz, BLOB to
bytea. Every id/cursor ordering needs deterministic C collation. Counts, SUM,
AVG, and integer casts need checked conversion at result boundaries. Numeric
millisecond arguments must become Dates at callers, not a global number cast.

SQLite binds only referenced `$n` parameters and ignores extras. Audit every
query, especially dynamically built filters and auto-resolve's `$6` with missing
intermediate positions. PostgreSQL requires complete, correctly typed bindings.
Serialize JS arrays deliberately for JSON columns and JSON label comparisons.

`json_patch` is recursive RFC 7386 merge patch: null deletes a member. A shallow
jsonb concatenation changes findings behavior. Preserve json_extract's absent
versus null behavior, boolean predicates, numeric cost casts and distinct
aggregate semantics. Inspect daily UTC bucket expressions alongside date binds.

Conflict catches currently inspect SQLite error text. Site-runner and suite
insertion paths can catch errors inside transactions; use ON CONFLICT or
savepoints before continuing on Postgres. Preserve index-specific diagnostics.

## Object references and lifecycle

| Persisted reference | Object ownership |
|---|---|
| suite_snapshots.tree values | blobs/<sha256> |
| personas.blob_sha256 | blobs/<sha256> |
| suite_files.content | Inline source, not an object key; hash content when protecting matching current blobs |
| artifacts.key | Bundle, index, clip and caption objects |
| live_artifacts.key | Protect pending reservations as well as ready bytes |
| baselines.trajectory_key | Bundle key before `#entry`; protect independently of artifact rows |
| candidates.trajectory_key | Same bundle-entry pointer semantics |
| live_trajectory.text / runs.live_manifest | Inline database content; no independent object |

Runs select artifact keys through artifact rows; `artifact_key` in retention is
an alias, not a runs column. Session artifacts and secrets contain encrypted DB
bytes, not object-store keys. Findings/evidence refer to runs and therefore do
not own separate blob keys.

| Publisher / deleter | Existing behavior requiring P3 audit |
|---|---|
| suites/snapshots.putBlobs; api/suites.commit | Hash-key blobs, but has/put inside the suite transaction |
| api/personas create/update | Blob upload inside transaction; conflicts leave bytes |
| api/executor-api.uploadBundle | Mutable executor key; failed publish eagerly deletes it; replacement eagerly removes old key |
| api/executor-api.report | Publishes baseline/candidate bundle-entry pointers and removes staging objects |
| api/live-ingest | Reserve, put outside transaction, then mark ready; preserve budget and fencing |
| media/clip | Fixed clip/caption keys; publish after external work, needs immutable identities |
| retention/worker | Tier rewrites and later deletes; collect every reference immediately before physical deletion |
| api/projects deletion / api/suites deletion | Cascade metadata; objects become orphans for GC |

Current gcBlobs sees only snapshots. orphanRunObjects sees artifacts and live
reservations, but misses independent baseline/candidate pointers. Neither sweep
has an object-age grace. P3 must share one complete reference enumerator with
backup and restore, hold publication/read guards across object I/O, and keep
exclusive GC separate from the DB FIFO. No lock may be acquired in reversed order.
`run-storage.ts` caches complete buffered bundles; retain the 512 MiB ceiling and
measure overlapping upload/view/clip memory in P7.

## Auth, transport and containers

Production admin checks are required in `auth/roles.ts`, `api/util.ts`, and
`api/projects.ts`; `auth/middleware.ts` currently creates only isDevAdmin.
`api/auth-routes.ts` and `auth/oidc.ts` own the identity audit. P4 cannot select
a role policy or replace the auth mechanism until the pending owner rulings land.

`api/executor-api.ts` emits absolute publicUrl upload templates. Runner
`api-client.ts`, `exec-group.ts`, and `live-uploader.ts` need one same-origin resolver.

Runner `case-runner.ts` mounts opts.workspaceRoot at /ws, uses a latest image
fallback, permits a Docker socket for opted-in nested Compose, and provides CPU
and memory flags. `mint.ts` has a separate Docker path. P5 must apply matching
host paths, deployment limits, ownership labels, explicit network/user/PID/shm
settings and no socket to both paths. Audit janitor ownership and cancellation.

## Test placement ledger

No tests moved in P0. P1 must move the following SQL-backed unit files into
`tests/postgres/` and execute them in a required explicit tier:

- `tests/unit/dispatch-state.test.ts` → `tests/postgres/dispatch-state.test.ts`
- `tests/unit/leases.test.ts` → `tests/postgres/leases.test.ts`
- `tests/unit/pool-dispatch.test.ts` → `tests/postgres/pool-dispatch.test.ts`
- `tests/unit/pool-ephemeral.test.ts` → `tests/postgres/pool-ephemeral.test.ts`
- `tests/unit/sqlite-storage.test.ts` → `tests/postgres/postgres-storage.test.ts`

Split pure token/policy tests out of mixed pool-ephemeral coverage if retaining
those tests in the offline gate. sqlite-storage becomes postgres-storage with
matching behavioral coverage; keep pure canonicalJson/inClause tests hermetic.

Every existing `tests/integration/*.test.ts` stays at its current path and runs
against a fresh isolated Postgres database through the rewritten helpers.ts.
Browser, mobile and load helpers use the same database fixture and remain
explicit tiers. The repository gate must no longer transitively require SQL
services. No mock replaces the dispatch, lease or concurrency tests.

## Existing environment inputs

This source scan inventories names only, not values or deployment permissions.
P6 must classify these and dynamically forwarded target secrets into the
operator guide; a variable's presence here does not authorize passing it to an
image. Standard process environment and test-only knobs need separate handling.

Control plane: `HOST`, `LOG_LEVEL`, `OBJECT_STORE_ACCESS_KEY`, `OBJECT_STORE_BUCKET`, `OBJECT_STORE_REGION`, `OBJECT_STORE_SECRET_KEY`, `OBJECT_STORE_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ISSUER`, `OIDC_REDIRECT_URI`, `OIDC_SCOPE`, `PLAYTEST_AUTH`, `PLAYTEST_AUTHORING_MODEL`, `PLAYTEST_AUTO_DEDUPE`, `PLAYTEST_AUTO_DEDUPE_DEBOUNCE_S`, `PLAYTEST_AUTO_RESOLVE`, `PLAYTEST_AUTO_RESOLVE_DEBOUNCE_S`, `PLAYTEST_AUTO_RESOLVE_MODE`, `PLAYTEST_AUTO_RESOLVE_MODEL`, `PLAYTEST_AUTO_RESOLVE_PIN_DAYS`, `PLAYTEST_CONSOLIDATION_AUTO_SUGGEST`, `PLAYTEST_CONSOLIDATION_FLOOR`, `PLAYTEST_CONSOLIDATION_K`, `PLAYTEST_CONSOLIDATION_MAX_CLUSTERS`, `PLAYTEST_CONSOLIDATION_MAX_CLUSTER_ITEMS`, `PLAYTEST_CONSOLIDATION_MAX_PROMPT_BYTES`, `PLAYTEST_CONSOLIDATION_MODEL`, `PLAYTEST_DATA_DIR`, `PLAYTEST_DB_FILE`, `PLAYTEST_DEV_EMAIL`, `PLAYTEST_DEV_NAME`, `PLAYTEST_DEV_SUBJECT`, `PLAYTEST_DISPATCH_MAX_ACTIVE_PER_PROJECT`, `PLAYTEST_KMS_KEY`, `PLAYTEST_LIVE_BUDGET_MB`, `PLAYTEST_LLM_BASE_URL`, `PLAYTEST_POOL_CLAIM_TIMEOUT_S`, `PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S`, `PLAYTEST_POOL_OIDC_AUDIENCE`, `PLAYTEST_POOL_OIDC_ISSUER`, `PLAYTEST_POOL_OIDC_REF`, `PLAYTEST_POOL_OIDC_REPOSITORY`, `PLAYTEST_POOL_OIDC_TTL_S`, `PLAYTEST_POOL_OIDC_WORKFLOW`, `PLAYTEST_RATE_LIMIT_WRITES_PER_MIN`, `PLAYTEST_RATE_LIMIT_WRITE_BURST`, `PLAYTEST_RECONCILE_INTERVAL_S`, `PLAYTEST_RETENTION_CORE_DAYS`, `PLAYTEST_RETENTION_EVENTS_DAYS`, `PLAYTEST_RETENTION_FULL_DAYS`, `PLAYTEST_RETENTION_INTERVAL_S`, `PLAYTEST_SYNTHESIS_MODEL`, `PLAYTEST_VIEW_CACHE_MB`, `PORT`, `PUBLIC_URL`.

Runner: `APPIUM_HOME`, `HOME`, `PATH`, `PLAYTEST_CASE_CPUS`, `PLAYTEST_CASE_MEMORY`, `PLAYTEST_HOSTED_URL`, `PLAYTEST_JOB_IMAGE`, `PLAYTEST_RUNNER_CONFIG`, `PLAYTEST_RUNNER_CREDENTIAL`, `PLAYTEST_RUNNER_CREDENTIAL_FILE`, `PLAYTEST_RUNNER_ISOLATION`, `PLAYTEST_RUNNER_LABELS`, `PLAYTEST_RUNNER_WORKDIR`, `PLAYTEST_SERVER_URL`, `TMPDIR`, `USERPROFILE`.

Core used by control plane/jobs: `PLAYTEST_APPIUM_CREDENTIAL`, `PLAYTEST_APPIUM_CREDENTIAL_FILE`, `PLAYTEST_BASE_URL`, `PLAYTEST_BROWSER_CHANNEL`, `PLAYTEST_FFMPEG`, `PLAYTEST_LLM_BASE_URL`, `PLAYTEST_LLM_CACHE`, `PLAYTEST_LLM_TIMEOUT_MS`, `PLAYTEST_PERF_SIDECAR`.

Job image passthrough is currently PLAYTEST_LLM_BASE_URL, PLAYTEST_LLM_API_KEY,
ANTHROPIC_API_KEY, OPENAI_API_KEY, PLAYTEST_LLM_CACHE, PLAYTEST_BROWSER_CHANNEL,
and PLAYTEST_FFMPEG, plus explicitly delivered case variables. The runner's
process isolation inherits process.env; deployed jobs must use container mode.

## Verification

Results and unresolved gates are recorded in build_plan.md. Existing unrelated
working-tree changes and intentionally deleted backlog folders are preserved.

## P1 implementation ledger

SQL-backed unit files now live at the mapped tests/postgres destinations.
pool-ephemeral.test.ts retains six pure configuration/label/placement tests in
unit; its four database tests moved. db-values.test.ts keeps pure canonical JSON
and placeholder coverage. The old SQLite pragmas/file-open/schema-decoder checks
are superseded by adapter.test.ts covering actual PostgreSQL writer ownership,
DDL/ledger rollback, checksums, connection loss, type fidelity and numeric bounds.
Foreign keys, cascades, partial uniqueness, JSON, timestamps, booleans, bytea,
transaction rollback/wake, nested query joining and merge-patch behavior remain
in postgres-storage.test.ts. Existing integration file paths are unchanged.

Postgres dispatch age uses the database clock, avoiding host/DB clock skew.
Timestamp columns use millisecond precision so optimistic equality checks survive
JS Date decoding. Recursive merge patch uses a database jsonb helper, preserving
nested/null semantics rather than using shallow concatenation.
