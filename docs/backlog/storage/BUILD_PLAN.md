# Single-node durable storage — phased build plan

Implements [`DESIGN.md`](./DESIGN.md). This is a prerequisite for the findings
intake work because hosted and local findings should not be built on different
database assumptions.

Read first:

- `CLAUDE.md`
- `docs/CONTRACTS.md`
- `docs/contracts/artifacts.md`
- `docs/contracts/hosted.md`
- `src/platform/control-plane/src/db.ts`
- `src/platform/control-plane/src/store/`
- `src/platform/control-plane/migrations/`

Standing rules:

- Do not start phase N+1 while phase N's exit gate is red.
- Update the owning contract in the same change as shipped behavior.
- Do not maintain PostgreSQL and SQLite runtime paths.
- Do not put `.ptrun`, video, clips, or suite blobs in SQLite.
- Keep model and network calls outside transactions.
- `npm test` remains hermetic and zero-skipped.
- If real hosted PostgreSQL data exists, its optional import preserves the
  source database and object store; cleanup is a separate confirmed operation.

## Phase map

| Phase | Outcome |
|---|---|
| **S0** | Freeze storage invariants and a database-neutral behavior fixture |
| **S1** | SQLite adapter, migrations, and query portability |
| **S2** | Events, workers, and tests work without PostgreSQL |
| **S3** | Filesystem objects have crash-safe lifecycle and `.ptrun` guarantees |
| **S4** | One-shot migration, backup, restore, and deployment cutover |

The critical path is **S0 → S1 → S2 → S3 → S4**. Findings phases that add
hosted tables begin after S2; production deployment waits for S4.

## S0 — Freeze behavior and data mapping

### Scope

1. Inventory every PostgreSQL-specific query and group it by replacement:
   JSON, arrays, dates/intervals, `LATERAL`, `ANY`, row locks, advisory locks,
   `LISTEN`/`NOTIFY`, or DML syntax.
2. Create a small database-neutral seed fixture covering:
   - users, projects, roles, and secrets;
   - suites, snapshots, and content-addressed blobs;
   - run groups, events, `.ptrun` artifacts, and retention tiers;
   - reviews, findings, evidence, and audit. (The seven simplification tables —
     plugins, integrations, insights, authoring sessions, retention policies, and
     legal holds — are dropped from Postgres by simplification migration `0009`
     and are not part of the target schema.)
3. Record expected row counts, relationships, JSON values, timestamps, and
   artifact hashes.
4. Freeze target representations for JSON, timestamps, booleans, ids, and
   nullable values.
5. Benchmark representative list, event, and write transactions against
   SQLite on a local durable filesystem.

This phase does not require provisioning PostgreSQL. The current migrations,
queries, and integration expectations provide the source behavior inventory.

**Delivered** in [`S0-INVENTORY.md`](./S0-INVENTORY.md) (construct inventory,
frozen representations, benchmark results, and the SQLite driver decision), with
the seed fixture and its frozen projections under
`src/platform/control-plane/tests/fixtures/storage-baseline/` and the benchmark
at `src/platform/control-plane/tests/bench/sqlite-contention.ts`.

### Contract impact

None. This phase adds fixtures and measurements without changing runtime
behavior.

### Exit gate

- [x] Every PostgreSQL-only construct has a named SQLite replacement.
- [x] The fixture covers every migration table and all artifact tiers.
- [x] Expected projections and object hashes are recorded independently of
      either database.
- [x] The write-contention benchmark supports the single-node assumption.

## S1 — SQLite database and portable queries

### Scope

1. Add one SQLite implementation and remove `pg` from application code. Prefer
   one connection and an explicit transaction wrapper over a pool-shaped
   abstraction.
2. Translate migrations to SQLite while preserving foreign keys, unique
   constraints, cascade behavior, and useful indexes.
   - **`insights` table timing — resolved and now moot (updated 2026-07-25).**
     The original decision (2026-07-24) had S1 port `insights` as-is because its
     removal was thought to wait on the evidence-complete findings intake. That
     is no longer true. The whole simplification (M0 P1–P6) shipped ahead of this
     storage phase, and under the 2026-07-25 operator data-preservation waiver
     simplification migration
     `0009_platform_simplification.sql` already dropped **all seven** deleted-
     feature tables from Postgres: `authoring_sessions`, `insights`, `plugins`,
     `plugin_deliveries`, `integrations`, `retention_policies`, and
     `legal_holds`. **S1 therefore ports NONE of the seven** — they no longer
     exist in the source schema, so the SQLite translation never sees them. There
     is no port-then-drop step and no cited-claim preservation gate left for
     storage to honor.
3. Configure and verify WAL, foreign keys, busy timeout, and synchronous mode
   at startup.
4. Replace PostgreSQL-specific queries with SQLite-native queries or small
   application-side transformations. Do not create a SQL text translator.
5. Replace row-lock workflows with short `BEGIN IMMEDIATE` transactions and
   conditional updates.
6. Make migrations atomic, ordered, idempotent where required, and tested from
   an empty database and every supported prior SQLite schema version.
7. Introduce the data-root configuration, placing the database and default
   object store on the same durable volume.

### Contract updates

- `docs/contracts/hosted.md`: SQLite system of record, single-writer deployment,
  transaction guarantees, and configuration boundary.
- `src/platform/control-plane/README.md` and `CLAUDE.md`: remove PostgreSQL
  startup instructions only when this phase is the sole runtime path.

### Tests

- Fresh-database migration test.
- Foreign-key, cascade, uniqueness, JSON, and timestamp behavior.
- Concurrent claim/review/finding operations prove one winner.
- Startup errors for unwritable paths and failed pragmas.
- Existing unit and API tests against temporary SQLite databases.

**Delivered.** `migrations/0001_control_plane.sql` is one fresh SQLite baseline
(the nine PostgreSQL migrations are deleted; the operator waiver made this a
clean cutover with no prior SQLite schema version to support).
`src/db.js` owns the `node:sqlite` connection, the verified pragma sequence, the
`BEGIN IMMEDIATE` transaction wrapper, and the post-commit hook.
`PLAYTEST_DATA_DIR` is the data root. `LISTEN`/`NOTIFY` became an in-process
post-commit signal (S2 still owns the full event/lease redesign; the retention
advisory lock is an in-process guard until then).

Two design choices worth knowing before reading the diff:

- `$1 … $n` are valid SQLite *named* parameters, so no query text changed for
  placeholders; the adapter binds the array by index.
- Rows are decoded from the schema itself. Columns are declared `TEXT_JSON` /
  `INT_TS` / `INT_BOOL`, `PRAGMA table_info` reports those verbatim, and
  `StatementSync#columns()` gives each result column's origin table — so JSON
  parsing, boolean coercion, and epoch-ms → `Date` happen once in `src/db.js`
  rather than at ~200 call sites, and cannot drift from the schema. Computed or
  aliased expression columns have no origin and are parsed deliberately at their
  call sites. `now()` is a registered SQL function frozen at transaction start,
  reproducing Postgres `now()` semantics.

### Exit gate

- [x] The control plane boots and serves its API with no PostgreSQL process or
      `DATABASE_URL`.
- [x] All routes use SQLite; no runtime import of `pg` remains (it is gone from
      `package.json`, `package-lock.json`, and `node_modules`).
- [x] Constraint and transaction tests preserve current behavior.
- [x] Root and control-plane unit tests are green and zero-skipped.

S1 also converted the integration harness to a temporary SQLite data root
because the configuration swap forced it; 67 of 68 integration tests then passed
with no PostgreSQL and no Docker. The remaining failure was long recorded here as
environmental (a slim local `ffmpeg` lacking the `subtitles`/`drawtext`
filters). It was not: `slideshowArgs` in `src/core/clip.js` wrote the ffmpeg
concat list and never passed it as an input, so clip generation failed on every
build and platform. Fixed 2026-07-25 and pinned by
`tests/core/unit/clip-args.test.ts`. S2 completed
the rest of the integration conversion — removing the vestigial `PLAYTEST_TEST_PG`
and `pgOpts` gate, and the event/lease work.

## S2 — Events, background work, and integration tests

### Scope

1. Replace `LISTEN`/`NOTIFY` with:
   - committed rows in the existing event/outbox tables;
   - a post-commit in-process wake signal;
   - cursor polling as restart-safe truth.
2. Replace PostgreSQL advisory locks with one application-level lease mechanism
   for retention and reconciliation cycles. (The plugin delivery worker was
   removed in simplification P5; there is no plugin cycle to lease.)
3. Ensure background cycles cannot overlap within the process and recover an
   expired lease after a crash.
4. Convert integration tests from per-test PostgreSQL schemas to temporary
   SQLite database files and isolated object roots.
5. Remove PostgreSQL and Docker requirements from all ordinary test and local
   development workflows.

### Contract updates

- `docs/contracts/hosted.md`: event delivery, lease, and restart semantics.
- Test and operator documentation that currently names PostgreSQL.

### Tests

- Event stream receives prompt wakeups and catches up after restart.
- Transaction rollback emits no externally visible event.
- Two attempted worker cycles produce one lease winner.
- Expired leases recover.
- Full control-plane integration suite uses temporary SQLite and filesystem
  objects.

**Delivered.** The event model was already right after S1 — committed rows are
truth, the post-commit signal only accelerates — so the audit found no consumer
that advances on the signal alone (`holdUntil` always re-scans within 1 s, and
the browser client dedupes by id and resumes from its cursor). Two real gaps
were closed instead:

- `ulid()` reused a lower timestamp after a backwards clock step, which could
  mint an event id *below* a cursor a consumer had already passed — an event
  that consumer would never see. A non-advancing clock is now treated like a
  same-millisecond collision.
- A held read spun against a closing database once `FeedWaker.stop()` made
  `wait()` resolve instantly; it now ends when the waker is stopped.

The restart-recovery test existed but was dead code (`if (!PG) return`), so
nothing actually proved the claim. It is now a real test: kill the process, boot
a new one on the same data root, commit events with no waiter alive, drain from
the pre-death cursor, assert the whole stream in order exactly once.

`src/leases.js` + migration `0002_leases.sql` are the one lease mechanism —
`name` primary key, owner, expiry, claimed by a conditional upsert inside
`BEGIN IMMEDIATE`, renewed while the cycle runs, released on success or throw.
Retention holds `retention` (inside `runRetentionCycle`, replacing the S1
in-process flag); the scheduled reconciliation tick holds `reconcile` (replacing
its boolean). The claim is deliberately non-reentrant, so it refuses an
overlapping tick in the same process and reclaims an expired lease left by a
dead one.

Vestige cleanup: `PLAYTEST_TEST_PG`, `PG`, and `pgOpts` are gone from
`tests/integration/helpers.ts` and all 20 call sites, along with the "PG-gated"
comments. Lease rows are ephemeral coordination and are excluded from the S0
baseline fixture's table contract (nothing references them; a restored lease
would only make the next cycle wait out a stale TTL).

### Exit gate

- [x] Integration tests need neither PostgreSQL nor Docker.
- [x] Event consumers recover every committed event using their cursor.
- [x] Background jobs do not overlap and recover after simulated process death.
- [x] The complete repository gate is green and zero-skipped.

Integration: 68 of 68 pass, once the clip defect S1 misfiled as environmental was
fixed. The suite still needs `PLAYTEST_FFMPEG` pointed at an ffmpeg carrying the
`drawtext` and `subtitles` filters for the burned-overlay clip case.

## S3 — Crash-safe object lifecycle

### Scope

1. Strengthen `FsStore.put`:
   - write a temporary sibling;
   - flush file contents;
   - rename atomically;
   - flush the parent directory where supported;
   - return verified size and SHA-256;
   - treat an existing immutable key as idempotent only when hashes match.
2. Make `.ptrun` upload ordering explicit: completed object first, SQLite
   artifact row second.
3. Add a creation timestamp or equivalent age check so garbage collection
   removes unreferenced objects only after a grace period. Never race an upload
   whose database transaction has not committed.
4. Keep reference deletion transactional and object deletion post-commit and
   retryable.
5. Exercise range reads against full and core `.ptrun` bundles. Rebuild missing
   and stale index sidecars.
6. Add disk-space checks for uploads, rewrites, SQLite WAL growth, and backup
   staging.

### Contract updates

- `docs/contracts/artifacts.md`: hosted object placement, write/reference
  ordering, immutable-key behavior, hashes, range reads, and orphan handling.
- `docs/contracts/hosted.md`: retention and integrity interaction with metadata
  transactions.

### Tests

- Kill/fault injection before rename, after rename, before database commit, and
  after reference removal.
- Concurrent identical upload succeeds idempotently; conflicting bytes at one
  key fail.
- Orphan sweep preserves young uploads and removes expired unreferenced files.
- SQLite never references a partial or missing object after a successful API
  response.
- Full-to-core rewrite keeps the old object until the new reference commits.

### Exit gate

- [ ] Simulated crashes leave either the old valid state or a recoverable orphan,
      never a partial referenced object.
- [ ] Hosted `.ptrun` viewing and media Range requests pass from filesystem
      storage.
- [ ] Integrity sweep and retention remain green under concurrent reads.

## S4 — Migration, backup, restore, and cutover

### Scope

1. Confirm whether any non-disposable hosted PostgreSQL data exists. Such a
   database may predate the simplification and still carry the seven dropped
   tables; the SQLite baseline was written from the post-simplification shape, so
   apply `0009_platform_simplification.sql` from git history (it is no longer in
   the tree) before importing. Only then build a one-shot PostgreSQL-to-SQLite
   importer:
   - read-only against the source database;
   - create a new destination file;
   - copy in dependency order;
   - preserve ids and canonical JSON values;
   - verify row counts, foreign keys, projections, and referenced object hashes;
   - atomically publish the destination only after all checks pass.
   If no such data exists, record that decision and cut over from a fresh
   SQLite database.
2. Add an online SQLite backup command and object-tree snapshot/copy procedure.
3. Write a manifest with schema version and every referenced object's key,
   size, and hash.
4. Add restore verification without automatic destructive cleanup.
5. Document persistent-volume, capacity, encryption-key, backup schedule,
   restore drill, and single-replica deployment requirements.
6. Remove obsolete PostgreSQL configuration, dependencies, migrations, CI
   services, and operator instructions after migration verification.

### Contract updates

- `docs/contracts/hosted.md`: backup/restore completeness and supported
  deployment topology.
- `docs/contracts/artifacts.md`: object-manifest and recovery guarantees if
  exposed as a persisted format.
- `CLAUDE.md`, control-plane README, deployment examples, and CI.

### Tests

- Seed SQLite from the S0 fixture and compare every expected projection and
  hash.
- If the legacy importer is admitted, migrate the same logical fixture from
  PostgreSQL; an interrupted import leaves the source untouched and no
  published destination.
- Backup while reads/writes continue, with retention paused by the backup
  lease.
- Restore into an empty data root and exercise login, lists, viewer, findings,
  and artifact download.
- Negative restore: missing object, wrong hash, missing key material, and
  incompatible schema version produce actionable failures.

### Exit gate

- [ ] Either no non-disposable PostgreSQL installation exists, or a
      representative installation migrates with no lost rows or broken
      evidence links.
- [ ] A backup/restore drill produces a working control plane from an empty
      volume.
- [ ] PostgreSQL is absent from runtime, tests, configuration, and deployment
      instructions.
- [ ] Operators are warned that database-only and object-only backups are
      incomplete.

## Explicit non-work

- PostgreSQL/SQLite dual support.
- Active-active SQLite replicas.
- SQLite on NFS.
- `.ptrun` or media BLOB columns.
- S3 implementation unless filesystem volume limits are measured.
- Changes to the `.ptrun` wire format.
