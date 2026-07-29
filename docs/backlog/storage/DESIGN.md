# Single-node durable storage

**Status:** proposed. This design replaces the hosted control plane's PostgreSQL
dependency with SQLite and keeps large artifacts in the existing filesystem
object store.

Implementation phases and gates live in
[`BUILD_PLAN.md`](./BUILD_PLAN.md). Until those phases land,
[`docs/contracts/hosted.md`](../../contracts/hosted.md) remains authoritative:
the shipped control plane still uses PostgreSQL.

## Decision

Use SQLite for structured metadata in both hosted and local Playtest. Do not
support PostgreSQL and SQLite simultaneously.

Use separate physical databases for separate product boundaries:

- hosted: one control-plane database containing projects, users, runs,
  findings, audit, retention, and plugin state;
- local: a suite/workspace-scoped findings database containing only the
  cross-run identity and triage state needed by the CLI.

Shared findings tables and lifecycle code should use the same semantics, but a
local CLI database is not a replica of the hosted database and never contains
hosted authentication or operational state.

The deployment contract is deliberately single-node:

- one control-plane process writes one SQLite database;
- the database and filesystem object store live on one durable local volume;
- WAL mode supports concurrent readers, but Playtest does not run active-active
  control-plane replicas against that database;
- network filesystems with unreliable locking are unsupported.

This removes a database service from deployment without pretending SQLite is a
distributed database.

## Why this fits

The control plane is a coordination service with modest write volume. Most
large data is already outside PostgreSQL: suite blobs, `.ptrun` bundles, clips,
and reports use the object-store seam. SQLite therefore stores relationships,
state transitions, small JSON documents, and indexes rather than video or run
archives.

The main trade-off is operational, not semantic. A single writer and persistent
disk are acceptable for the intended deployment. If Playtest later needs
several active control-plane replicas, regional failover, or write throughput
that one process cannot sustain, that is a new architecture decision rather
than a reason to carry two SQL dialects now.

## Metadata database

The hosted database lives under one configured data root:

```text
<data-root>/
  playtest.sqlite
  objects/
  backups/
```

The exact environment variable and defaults become contract only when the
configuration phase lands. Prefer one `PLAYTEST_DATA_DIR` setting over
independent paths that can accidentally place the database and objects on
different ephemeral volumes. Expert overrides may remain possible.

Open every connection with:

```text
PRAGMA journal_mode = WAL
PRAGMA foreign_keys = ON
PRAGMA busy_timeout = 5000
PRAGMA synchronous = FULL
```

Use one application-owned write connection and short transactions. Operations
that first read and then decide a mutation use `BEGIN IMMEDIATE` so two requests
cannot both act on stale state. Slow model calls, network requests, bundle
rewrites, and object reads never run inside a database transaction.

SQLite adaptations are explicit:

- JSON is canonical JSON text, parsed and validated at application boundaries;
- timestamps use one representation everywhere, preferably integer epoch
  milliseconds;
- booleans are constrained integers;
- migration order is recorded in a migration table;
- foreign keys and uniqueness constraints remain database-enforced;
- PostgreSQL arrays, casts, intervals, `LATERAL`, `ANY`, advisory locks,
  `LISTEN`/`NOTIFY`, and row locks are replaced rather than emulated loosely.

The HTTP event feed uses the database event table as truth. A post-commit
in-process signal wakes connected clients quickly; cursor polling recovers from
missed signals and process restarts. Correctness never depends on an in-memory
notification.

## `.ptrun` and other objects

Do not store `.ptrun` bytes as SQLite BLOBs.

SQLite stores only the artifact record:

```js
{
  key: "runs/<group-id>/<run-id>.ptrun",
  sha256: "hex",
  size: 123,
  tier: "full" | "core",
  verified_at: "timestamp"
}
```

The filesystem object store holds the bytes under `<data-root>/objects/`.
This preserves the useful properties the repository already has:

- atomic sibling-temp-file plus rename writes;
- direct byte-range reads for seekable bundle and media access;
- independent integrity checks by SHA-256;
- content-addressed suite blobs;
- retention rewrites from `full` to a new immutable `core` bundle;
- a future S3-compatible adapter without changing artifact consumers.

An object and its metadata cannot be committed atomically, so operations use a
recoverable order:

1. Write the complete object to a temporary sibling.
2. Flush it, atomically rename it, and verify its size and SHA-256.
3. Commit the SQLite row that references the completed object.
4. Let a grace-period orphan sweep remove objects left by failed database
   transactions.

Deletion reverses the responsibility:

1. Commit the metadata transition that removes or replaces the reference.
2. Delete the old object after commit.
3. Retry failed deletion during later garbage collection.

Readers can therefore see an orphan file but must never see a database row
pointing at a partial file. Re-uploading an existing immutable key succeeds
only when its hash matches; different bytes require a new key.

`.ptrun.idx.json` remains a rebuildable cache. It may be stored beside the
bundle, but recovery depends only on the bundle and its verified metadata.

## Backups and recovery

SQLite removes the managed database requirement; it does not remove the need
for durable storage and backups. A valid hosted backup contains:

- an online SQLite backup or volume snapshot, never a raw copy of a live
  database file without its WAL;
- every object referenced by that database snapshot;
- a manifest containing database schema version, object keys, sizes, and
  hashes;
- the external encryption key material required to decrypt stored secrets.

Objects are immutable, so the simple safe procedure is:

1. pause retention and object garbage collection;
2. create an online SQLite backup;
3. snapshot or copy the object tree;
4. write and verify the backup manifest;
5. resume retention.

Restore verification runs foreign-key checks, confirms every referenced object
exists, samples or verifies hashes, and reports unreferenced objects without
silently deleting them.

Recovery point and retention policy must leave enough grace time for an object
referenced by a database backup to remain recoverable. A backup of only
`playtest.sqlite` is incomplete.

## Local findings persistence

The local CLI keeps portable evidence in normal `runs/` directories or exported
`.ptrun` files. Its SQLite database stores finding identity, candidates,
evidence references, lifecycle transitions, and merge tombstones; it does not
copy run bundles into database BLOBs.

The local database location must be explicit, ignored by source control, and
stable across processes. Its path and CLI behavior are decided in the findings
plan after the shared schema stabilizes. Import into hosted is an explicit
operation with project mapping and semantic consolidation; two records never
merge merely because their titles match.

## Failure handling

- Startup fails with an actionable error when the data root is not writable,
  SQLite cannot enable required pragmas, migrations fail, or the volume is
  ephemeral by configuration.
- `SQLITE_BUSY` receives a bounded retry only around short database work.
  Requests do not wait indefinitely.
- Database corruption never causes object deletion. Recovery works from the
  latest verified backup and retained immutable objects.
- Disk-space checks account for the database, WAL, temporary bundle uploads,
  retention rewrites, and backups.
- Retention and backup jobs use an application-level lease row. The
  single-process deployment also prevents overlapping in-process cycles.

## Non-goals

- Active-active control-plane replicas.
- SQLite on NFS or another filesystem without trustworthy locking and atomic
  rename.
- Large artifacts or media stored inside SQLite.
- Dual-dialect query support.
- Treating filesystem persistence as a backup.
- Changing the `.ptrun` format.
- Making S3 a deployment requirement.

## Contract ownership

Each implementation phase updates the shipped contracts in the same change:

| Behavior | Contract |
|---|---|
| Hosted SQLite boundary, single-node constraint, configuration, events, retention, and backup duties | `docs/contracts/hosted.md` |
| Object placement, immutable writes, hashes, range reads, and `.ptrun` recovery | `docs/contracts/artifacts.md` |
| Local database path and CLI operations | `docs/contracts/interfaces.md` |
| Shared findings identity and lifecycle | `docs/contracts/hosted-findings.md` and `docs/contracts/interfaces.md` |

`CLAUDE.md`, the control-plane README, deployment templates, and test commands
are updated when PostgreSQL is actually removed. They must not advertise the
target architecture while the shipped implementation still requires
`DATABASE_URL`.

## Reconsider SQLite when

Re-open this decision if any of these become real requirements:

- more than one active control-plane writer;
- zero-downtime regional failover;
- a platform that cannot mount a durable local volume;
- measured write contention that remains material after shortening
  transactions;
- an object corpus too large for volume snapshots and filesystem garbage
  collection.

The object-store seam makes moving bundle bytes to S3 independent of a future
metadata database decision.
