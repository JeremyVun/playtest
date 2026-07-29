# S0 — PostgreSQL construct inventory and frozen data mapping

Deliverable of [`BUILD_PLAN.md`](./BUILD_PLAN.md) phase S0, implementing
[`DESIGN.md`](./DESIGN.md). **No runtime behavior and no contract changes.**
This file records what the SQLite port must reproduce; `docs/contracts/hosted.md`
remains authoritative until S1 ships.

> Historical note: the exhaustive neutral fixture and frozen Postgres
> projections described below were retired after SQLite became the sole
> implementation. Current migration, representation, constraint, and
> transaction coverage lives in `tests/unit/sqlite-storage.test.ts`.

Source of truth for the inventory is the shipped code, not a live database:
`src/platform/control-plane/migrations/*.sql`, `src/platform/control-plane/src/`,
and the integration expectations under
`src/platform/control-plane/tests/integration/`. All `file:line` references below
are relative to `src/platform/control-plane/`.

**Scope note.** Simplification migration `0009_platform_simplification.sql`
dropped seven tables — `authoring_sessions`, `insights`, `plugins`,
`plugin_deliveries`, `integrations`, `retention_policies`, `legal_holds`. They
are **dropped, out of scope**: not in the target schema, not in the fixture, not
in this inventory. The post-0009 schema is 26 tables plus `schema_migrations`.

## Deliverables

| Item | Location |
|---|---|
| Construct inventory + replacements | this file, §2 |
| Frozen representations | this file, §1 |
| Database-neutral seed fixture | Retired after the port |
| Expected projections (frozen) | Retired after the port |
| Current storage regression coverage | `tests/unit/sqlite-storage.test.ts` |
| Write-contention benchmark | `tests/bench/sqlite-contention.ts` (never runs in a test gate) |
| Benchmark results + driver decision | this file, §5 |

---

## 1. Frozen target representations

These are decided now and are binding on S1–S4. Every one of them is asserted by
the fixture's expected projections, so a drift is a test failure, not a review
miss.

| Domain | Postgres today | SQLite target | Rule |
|---|---|---|---|
| **JSON** | `jsonb`; driver parses to JS objects on read, `JSON.stringify` on write | `TEXT` holding **canonical JSON** (keys sorted recursively, no insignificant whitespace) | Serialize with the canonical writer at the storage boundary; parse to a JS value on read. Never store `undefined`; omit the key. Never store SQL `NULL` where `{}` / `[]` is the column default. Query with `json_extract` / `json_each` / `json_patch`, never string matching. |
| **Timestamps** | `timestamptz`, `DEFAULT now()`; driver returns JS `Date` | **`INTEGER` epoch milliseconds, UTC** | One representation everywhere — no ISO text columns, no seconds, no local time. The API boundary converts to ISO-8601 `…Z` strings on the way out (that is the wire format `docs/contracts/hosted.md` already promises); the database never sees a string timestamp. Defaults become an application-supplied `Date.now()`, not a SQL default, so a single `now` value is reused consistently inside one transaction. |
| **Booleans** | `boolean` | `INTEGER` constrained `CHECK (col IN (0,1))`, `NOT NULL DEFAULT 0/1` | Bind `x ? 1 : 0`; read `!!x`. Adapter-level, so no call site sees an integer. |
| **Ids** | `text` ULID (26 chars, Crockford base32), server-generated | unchanged: `TEXT PRIMARY KEY` | No `AUTOINCREMENT`, no `rowid` exposure, no sequences. ULIDs stay lexicographically time-ordered, which is what feed cursors (`platform_events.id > $cursor`) and audit keyset pagination depend on. `run_events.seq` and `suite_snapshots.seq` stay application-computed monotonic integers inside the write transaction. |
| **NULL** | SQL `NULL` | SQL `NULL` | A nullable column is `NULL`, never `""`, `0`, or the string `"null"`. JSON columns distinguish `NULL` (no document) from `'{}'` (empty document): `runs.manifest` NULL vs `runs.retention_provenance` `{}` are different states today and must stay different. |
| **Bytes** | `bytea` (`secrets.ciphertext`, `session_artifacts.ciphertext`) | `BLOB` | Node `Buffer` in and out; AES-GCM `iv‖tag‖ciphertext` layout is unchanged (`src/crypto/secrets.js`). Never hex/base64 text. |
| **Arrays** | `text[]` (`environments.runner_labels`) | canonical **JSON array in TEXT** | The only surviving array column. Empty is `[]`, never `NULL`. Membership queries use `json_each`. |
| **Numbers** | `integer`, `bigint`, `numeric` | `INTEGER` / `REAL` | Sizes and counters are safe-integer range (already assumed: `db.js:13-14` coerces int8/numeric to JS `Number`). Money (`totals.cost_usd`) lives inside JSON and is aggregated as `REAL` — it is a display/metering figure, not ledger money. |

Connection pragmas, in this order (order matters — see §5):

```text
PRAGMA busy_timeout = 5000;   -- FIRST: journal_mode needs a lock that must wait
PRAGMA journal_mode = WAL;    -- persistent; set once by the owning connection
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
```

---

## 2. Construct inventory

`pg` is imported in exactly two files: `src/db.js:6` (pool, `withTx`, type
parsers) and `src/events/feed.js:7` (a dedicated `LISTEN` client). Everything
below is what those two seams carry.

### 2.1 JSON operators and functions

| Occurrence | Construct | SQLite replacement |
|---|---|---|
| `src/ops.js:101`, `src/dispatch/dispatcher.js:213`, `src/api/projects.js:246` | `(r.totals->>'cost_usd')::numeric` inside `SUM`/`AVG` | `CAST(json_extract(totals, '$.cost_usd') AS REAL)` |
| `src/ops.js:103`, `src/dispatch/dispatcher.js:218` | `r.totals ? 'cost_usd'` (jsonb key-existence; also collides with the `?` placeholder syntax) | `json_extract(totals, '$.cost_usd') IS NOT NULL` |
| `src/api/review.js:46`, `src/api/review.js:362` | `r.manifest->'case'->>'story'` | `json_extract(manifest, '$.case.story')` |
| `src/api/findings.js:24` | `r.story_id = f.summary->>'story_id'` | `r.story_id = json_extract(f.summary, '$.story_id')` |
| `src/api/audit.js:24` | `actor->>'user_id' = $?` | `json_extract(actor, '$.user_id') = ?` |
| `src/api/viewer-adapter.js:141-142` | `(r.manifest->>'healed')::boolean IS TRUE`, `r.manifest->'result'->>'status' = 'pass'` | `json_extract(manifest,'$.healed') IN (1, 'true')` — canonical JSON writes booleans, and `json_extract` returns SQLite `1`/`0` — plus `json_extract(manifest,'$.result.status') = 'pass'` |
| `src/api/findings.js:31`, `src/api/runs.js:282,287,294` | `jsonb_build_object(...)` | `json_object(...)` (identical arity and semantics) |
| `src/api/runs.js:294-296` | `COALESCE(jsonb_agg(json_object(...) ORDER BY f.last_seen DESC), '[]'::jsonb)` | `json_group_array(json_object(...))` over an ordered subquery. SQLite has no `ORDER BY` inside an aggregate, so the ordering moves into a nested `SELECT … ORDER BY` that the aggregate consumes. Empty result is already `[]`. |
| `src/api/findings.js:105-107` | `summary = summary \|\| jsonb_build_object('confirmed_at', COALESCE(summary->>'confirmed_at', $4), 'confirmed_by', COALESCE(summary->'confirmed_by', $5::jsonb))` | `json_patch(summary, json_object(…))` with the same `COALESCE(json_extract(…), ?)` guards. `json_patch` is RFC-7386 merge — same shallow-merge semantics as jsonb `\|\|` for these flat keys. **Caveat:** merge-patch treats a `null` value as a delete; the two keys here are never `null`, and a helper must assert that. |
| write paths (`src/audit.js:29`, `src/events/outbox.js:9`, `src/events/run-events.js:8`, `src/retention/worker.js:147,234`, `src/api/suites.js:474`, …) | `JSON.stringify(value)` bound to a `jsonb` parameter | canonical-JSON writer bound to `TEXT`. This is a *behavior* change worth naming: today two logically equal documents can differ byte-for-byte; after S1 they cannot. |
| read paths (everywhere `row.manifest.…` is dereferenced) | `pg` auto-parses `jsonb` to a JS object | adapter must `JSON.parse` declared JSON columns on read, or every consumer breaks. This is the single largest mechanical risk in S1 — see §6. |

### 2.2 Casts

| Occurrence | Construct | SQLite replacement |
|---|---|---|
| `src/ops.js:31`, `src/dispatch/dispatcher.js:19,215`, `src/dispatch/reconciler.js:97,101`, `src/api/findings.js:218,413,496`, `src/api/executor-api.js:400,411`, `src/api/projects.js:224,225,232,233,239,241,253,254,255,268`, `src/api/suites.js:32,91`, `src/api/retention.js:15` | `COUNT(*)::int` | drop the cast — SQLite `COUNT` already yields an INTEGER |
| `src/dispatch/dispatcher.js:214`, `src/api/retention.js:15` | `AVG(...)::bigint`, `SUM(a.size)::bigint` | `CAST(… AS INTEGER)` |
| `src/ops.js:101`, `src/dispatch/dispatcher.js:213`, `src/api/projects.js:246` | `::numeric` | `CAST(… AS REAL)` |
| `src/api/viewer-adapter.js:141` | `::boolean` | see §2.1 |
| `src/db.js:13-14` | `pg.types.setTypeParser` for int8/numeric → `Number` | delete: SQLite returns JS numbers (and `bigint` only when asked) |

### 2.3 Arrays and `ANY`

| Occurrence | Construct | SQLite replacement |
|---|---|---|
| `src/dispatch/reconciler.js:12`, `src/dispatch/dispatcher.js:19`, `src/api/findings.js:48,51`, `src/api/runs.js:189`, `src/api/executor-api.js:568` | `col = ANY($n)` with a JS array bound as one parameter | expand to `col IN (?,?,…)` generated from the array length, with a shared helper (`inClause(values)`) so no call site hand-rolls it. Lists here are small, bounded, and server-controlled (statuses, states, event types, secret names). |
| `migrations/0001:113` (`environments.runner_labels text[] DEFAULT '{}'`) | `text[]` column | canonical JSON array in `TEXT NOT NULL DEFAULT '[]'`; adapter converts to/from a JS array. Consumers (`src/dispatch/dispatcher.js` label routing) keep seeing an array. |

### 2.4 Dates, intervals, and `now()`

| Occurrence | Construct | SQLite replacement |
|---|---|---|
| ~70 SQL sites (`DEFAULT now()` in every migration; `updated_at = now()` across `src/api/*`, `src/dispatch/*`, `src/findings/*`, `src/retention/worker.js`) | `now()` | bind an application `Date.now()` epoch-ms parameter. One `now` per transaction, passed down, so a multi-statement transaction stamps one consistent instant (today `now()` is transaction-start time in Postgres; reproducing that explicitly is *more* predictable, not less). |
| `src/api/projects.js:227,235,286,331` | `r.finished_at > now() - interval '7 days'` | `finished_at > ?` with `now - 7*86400000` computed in JS |
| `src/ops.js:104` | `r.created_at > now() - make_interval(days => $2)` | `created_at > ?` with `now - days*86400000` |
| `src/dispatch/sessions.js:184,310` | `now() + interval '${CLAIM_TTL}'` (a **template-literal** interval — the one place a constant is interpolated into SQL) | `?` bound to `now + ttlMs`. Removes the interpolation entirely. |
| `src/api/projects.js:231` | `date_trunc('day', r.finished_at)` in a `GROUP BY` | `CAST(finished_at / 86400000 AS INTEGER)` day bucket (UTC), converted back to a date string in JS. Documented as UTC-bucketed, which is what `date_trunc` on a `timestamptz` in a UTC server already does. |
| `src/api/projects.js:242,248` | `r.created_at > date_trunc('day'\|'month', now())` | bind a JS-computed UTC day/month boundary |
| `src/ops.js:32,59,81` | `EXTRACT(epoch FROM now() - x)`, `EXTRACT(epoch FROM a - b)` | `(? - x) / 1000.0`, `(a - b) / 1000.0` — trivial once timestamps are epoch-ms integers |
| `src/auth/sessions.js:37`, `src/auth/tokens.js:44`, `src/dispatch/sessions.js:247,371` | `new Date(row.expires_at) < new Date()` in JS | compare integers directly; keep `new Date(ms)` only for rendering |

### 2.5 `LATERAL`

| Occurrence | Construct | SQLite replacement |
|---|---|---|
| `src/api/findings.js:19-27` (`STORY_HEALTH_JOIN`) | `LEFT JOIN LATERAL (SELECT … WHERE r.story_id = f.summary->>'story_id' ORDER BY … LIMIT 1) sh ON TRUE` | correlated scalar subqueries in the select list (`(SELECT r.status FROM runs r … LIMIT 1) AS story_health_status`, one per projected field), or a windowed CTE (`row_number() OVER (PARTITION BY story_id ORDER BY …)` filtered to `rn = 1`) joined once. Prefer the CTE: four correlated subqueries repeat the same scan. |
| `src/dispatch/dispatcher.js:294-303` (`getRunGroupView`) | two `LEFT JOIN LATERAL … LIMIT 1` for the newest bundle and newest clip per run | one `artifacts` CTE with `row_number() OVER (PARTITION BY run_id, kind ORDER BY created_at DESC)`, `LEFT JOIN`ed twice on `rn = 1`. Row counts are tiny; a second query plus an application-side merge is an acceptable fallback. |

### 2.6 `DISTINCT ON` and window functions

| Occurrence | Construct | SQLite replacement |
|---|---|---|
| `src/api/executor-api.js:160` | `SELECT DISTINCT ON (story_id) … ORDER BY story_id, version DESC` (current baseline per story) | `row_number() OVER (PARTITION BY story_id ORDER BY version DESC)` filtered to `rn = 1` |
| `src/api/projects.js:252` | `DISTINCT ON (g.suite_id) … ORDER BY g.suite_id, g.created_at DESC` (latest group per suite) | same window pattern on `(suite_id ORDER BY created_at DESC)` |
| `src/api/projects.js:284` | `DISTINCT ON (r.story_id) … LIMIT 5` (latest failing run per story) | window pattern, then `LIMIT 5` in an outer select |
| `src/api/suites.js:292` | `row_number() OVER (PARTITION BY r.story_id ORDER BY r.started_at DESC NULLS LAST)` | supported as-is **except** `NULLS LAST`: SQLite sorts `NULL` first under `DESC`, so this becomes `ORDER BY (r.started_at IS NULL), r.started_at DESC` |

### 2.7 Aggregate `FILTER`

`src/api/projects.js:224,225,232,233` — `COUNT(*) FILTER (WHERE r.status = 'pass')`.
Supported natively by SQLite 3.30+ (bundled build is 3.53). **No change**;
`SUM(CASE WHEN … THEN 1 ELSE 0 END)` is the fallback if a build ever lacks it.

### 2.8 Row locks (`SELECT … FOR UPDATE`)

18 occurrences: `src/dispatch/sessions.js:357` (`FOR UPDATE OF c`), `:504`, `:512`;
`src/dispatch/reconciler.js:155`; `src/findings/extractor.js:198,202`;
`src/findings/synthesis.js:416,420`; `src/api/review.js:153,238`;
`src/api/findings.js:250,317,511`; `src/api/executor-api.js:62`;
`src/api/suites.js:90,425`.

Every one is the same shape: *read a row, decide, write* — the losing caller must
observe the winner's decision, not stale state.

**Replacement:** `BEGIN IMMEDIATE` on the enclosing transaction plus a
**conditional update** that re-asserts the precondition in its `WHERE` clause,
checking `changes()` to detect the loser. `BEGIN IMMEDIATE` takes the database
write lock at statement one, so the read inside the transaction is already
serialized against other writers; the conditional `WHERE` is the belt-and-braces
that survives a future refactor. Concretely:

- candidate accept/reject (`review.js:153,238`) → `UPDATE candidates SET status='accepted' … WHERE id=? AND status='pending'`; zero `changes()` raises the existing `conflict(...)`;
- finding transitions and merges (`findings.js:250,317,511`, `extractor.js`, `synthesis.js`) → `WHERE id = ? AND merged_into IS NULL` (plus state guards);
- session claim fulfil (`executor-api.js:62`, `sessions.js:357`) → `WHERE id = ? AND status='pending' AND expires_at > ?`;
- suite commit serialization (`suites.js:90,425`) → `BEGIN IMMEDIATE`; the snapshot `seq` allocation is already `MAX(seq)+1` inside the transaction, and the `UNIQUE (suite_id, seq)` constraint is the real guarantee;
- provider lock during mint (`sessions.js:504,512`) → `BEGIN IMMEDIATE`; the `ON CONFLICT (provider_id, identity)` upsert already makes the artifact write idempotent.

`FOR UPDATE OF c` (locking only the aliased table in a join) has no analogue and
needs none: one writer holds the whole database.

### 2.9 Advisory locks

`src/retention/worker.js:36` — `SELECT pg_try_advisory_xact_lock($1)`, constant
`705205`, used so only one process runs a retention cycle.

**Replacement (S2):** an application-level lease row —
`leases(name TEXT PRIMARY KEY, holder TEXT, acquired_at INTEGER, expires_at INTEGER)`
— acquired with a single conditional statement inside `BEGIN IMMEDIATE`:

```sql
INSERT INTO leases (name, holder, acquired_at, expires_at) VALUES (?,?,?,?)
ON CONFLICT (name) DO UPDATE SET holder = excluded.holder,
  acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
WHERE leases.expires_at <= excluded.acquired_at
```

Non-zero `changes()` means the caller holds the lease; an expired lease is
reclaimed, so a crashed cycle recovers. The lease is renewed during long cycles
and released on completion. Retention and backup both use it; the plugin
delivery worker that also needed one was deleted in simplification P5.

Note the lock's current semantics differ subtly: `pg_try_advisory_xact_lock` is
released at transaction end, while the retention cycle does object-store I/O
*after* its transaction commits (`worker.js:63-67`). The lease must therefore be
held across that post-commit window, which the row-based lease does correctly and
the advisory lock does not. This is a latent bug fixed by the port, not a
regression.

### 2.10 `LISTEN` / `NOTIFY`

| Occurrence | Construct |
|---|---|
| `src/events/outbox.js:13` | `SELECT pg_notify($1, $2)` issued inside the emitting transaction |
| `src/events/feed.js:7,61,64,71` | a dedicated `pg.Client` holding `LISTEN playtest_events`, with reconnect |
| `src/app.js:31-33` | `FeedWaker` construction and injection |
| `src/api/runs.js:167,201,346-360` | the long-poll `holdUntil` that races the waker against a 1 s scan |

**Replacement (S2):** the `platform_events` table is already the truth and the
long poll already has a scan fallback, so only the wake channel changes.
`FeedWaker` keeps its `wait(projectId, ms)` interface and becomes a plain
in-process `EventEmitter`; `emitPlatformEvent` stops issuing `pg_notify` and
instead registers a **post-commit** callback on the transaction wrapper, so a
rolled-back transaction emits nothing (today `NOTIFY` gets that for free by
deferring to `COMMIT`; the wrapper must reproduce it deliberately). Cursor
polling stays the restart-safe truth. Correctness never depends on the signal.

Single-node deployment is what makes an in-process signal sufficient — that is
the trade the deployment contract already accepts.

### 2.11 `ON CONFLICT` and `RETURNING`

`ON CONFLICT (…) DO UPDATE SET … EXCLUDED.x` at `src/ops.js:11`,
`src/auth/users.js:10`, `src/dispatch/sessions.js:78,123,394`,
`src/api/projects.js:146`, `src/api/secrets.js:47`,
`src/api/executor-api.js:273`, `src/api/suites.js:458`, `src/media/clip.js:145`.

`RETURNING` at 28 sites: `src/auth/users.js:11`;
`src/dispatch/sessions.js:81,126,397`;
`src/findings/extractor.js:34,69,96,212`;
`src/findings/synthesis.js:196,211,245`;
`src/api/findings.js:110,137,158,184,327`; `src/api/projects.js:84`;
`src/api/secrets.js:49`; `src/api/executor-api.js:275,489,637`;
`src/api/suites.js:62,144`; `src/api/environments.js:44,89`;
`src/api/auth-providers.js:40,96`; `src/events/run-events.js:7`.

**Both are supported by SQLite** (upsert since 3.24, `RETURNING` since 3.35;
bundled build is 3.53). Two mechanical differences: the keyword is lowercase
`excluded` (case-insensitive, so the SQL is literally unchanged), and the
conflict target must name a **column list or unique index**, which every site
already does. Verified working under `node:sqlite` while building the benchmark.

### 2.12 DML syntax

| Occurrence | Construct | SQLite replacement |
|---|---|---|
| `src/retention/worker.js:102-107` | `DELETE FROM run_events e USING runs r, run_groups g WHERE …` | `DELETE FROM run_events WHERE run_id IN (SELECT r.id FROM runs r JOIN run_groups g ON g.id = r.run_group_id WHERE g.project_id = ? ) AND ts < ?` |
| `src/retention/worker.js:357-362` | `DELETE FROM suite_snapshots ss WHERE ss.suite_id = ? AND NOT EXISTS (…) AND ss.id NOT IN (SELECT … ORDER BY seq DESC LIMIT 50)` (aliased target) | drop the alias; SQLite allows neither an alias nor a `USING` clause on `DELETE`. Subqueries are unchanged. |
| `src/api/findings.js:217-223`, `src/api/findings.js:495-500` | `UPDATE findings t SET … WHERE t.id = ?` (aliased target) | drop the alias and qualify the correlated subqueries against the bare table name. SQLite's `UPDATE` has no alias. |
| `src/retention/worker.js:101,365` | `result.rowCount` | `changes()` from the statement result (`StatementSync.run()` returns `{ changes, lastInsertRowid }`); the adapter normalizes it to `rowCount`. |
| `src/api/findings.js:219` | `GREATEST(a, b)` | `MAX(a, b)` — SQLite's scalar 2-argument `max()` |
| `src/retention/worker.js:179-186` | `$2 \|\| substr(trajectory_key, length($3) + 1)` and `starts_with(trajectory_key, $3)` | `\|\|`, `substr`, `length` are identical; `starts_with(x, p)` becomes `x LIKE ? \|\| '%'` (unsafe for keys containing `%`/`_`) or, preferred, `substr(x, 1, length(?)) = ?` which is exact and index-free-but-cheap at these row counts |

### 2.13 Sequences, identifiers, schemas, and DDL

| Occurrence | Construct | SQLite replacement |
|---|---|---|
| `src/db.js:61-82` | `CREATE SCHEMA IF NOT EXISTS "…"` + per-connection `options: -c search_path=<schema>,public` (the only string-concatenated SQL in the codebase, allowlist-guarded) | delete. Test isolation becomes one temporary SQLite **file** per test (`tests/integration/helpers.ts:25,48` — the `t_<ulid>` schema and the `DROP SCHEMA … CASCADE` teardown both go away, replaced by `mkdtemp` + `rm`). |
| `src/db.js:8,70,76` | `pg.Pool`, `pool.connect()`, `client.release()`, `pool.end()`; `config.dbPoolMax` | one owned write connection plus an explicit `withTx` wrapper. `DESIGN.md` prefers this over a pool-shaped abstraction. |
| every query | `$1 … $n` placeholders | `?` positional. Mechanical, but must be done per statement; `src/api/audit.js:15-35` and `src/api/findings.js:44-60` build placeholder indexes dynamically and need small helper rewrites. |
| — | id generation | already `src/ulid.js`; no sequences, no `SERIAL`, no `AUTOINCREMENT` |
| `migrations/0001` and later | `timestamptz`, `jsonb`, `bytea`, `boolean`, `bigint` column types | `INTEGER`, `TEXT`, `BLOB`, `INTEGER`, `INTEGER` per §1 |
| `migrations/0003:18`, `0006:29`, `0007:50,53` | partial indexes (`WHERE status='pending'`, `WHERE released_at IS NULL`, `WHERE merged_into IS NULL`) | supported natively; carry over verbatim. `findings_project_fingerprint_active_idx` (partial UNIQUE) is load-bearing for merge semantics and must survive. |
| `migrations/0006:3-6` | `ALTER TABLE runs ADD COLUMN a …, ADD COLUMN b …, ADD COLUMN c …` in one statement | SQLite adds one column per `ALTER TABLE`; split into three |
| `migrations/0009:38-50` | `ALTER TABLE … DROP CONSTRAINT / ADD CONSTRAINT` to retighten `CHECK`s | SQLite cannot alter a constraint. Because S1 writes a fresh SQLite schema from the *post-0009* shape, this never needs porting — the tightened `CHECK` is simply what the `CREATE TABLE` says. Future constraint changes use the 12-step table rebuild (new table, copy, drop, rename) inside one transaction with `PRAGMA foreign_keys` handled correctly. |
| `src/migrate.js:24-45` | forward-only numbered SQL in `schema_migrations`, one transaction per file | unchanged design; `DEFAULT now()` on `applied_at` becomes an application-supplied epoch-ms. `db.query(sql)` executing a multi-statement file becomes `db.exec(sql)`. |
| `migrations/*` `ON DELETE CASCADE` / `SET NULL` / `RESTRICT` | referential actions | supported, but **only with `PRAGMA foreign_keys = ON`, which is off by default and per-connection**. Startup must verify it took effect. |

### 2.14 Driver result shape

`{ rows, rowCount }` is assumed at every call site. `node:sqlite` returns arrays
from `.all()`, a row or `undefined` from `.get()`, and `{ changes, lastInsertRowid }`
from `.run()`. The S1 adapter normalizes to `{ rows, rowCount }` so the ~200 call
sites keep their current shape, and additionally applies the JSON/boolean/BLOB
column decoding from §1 based on a per-table column-type map (the fixture's
`COLUMN_TYPES` is exactly that map, already written).

---

## 3. The database-neutral behavior fixture

`src/platform/control-plane/tests/fixtures/storage-baseline/fixture.ts`

Plain JS data with **no driver import**. Values are JS primitives, POJOs/arrays
for JSON columns, ISO-8601 UTC strings for timestamps, `{ $base64 }` envelopes
for byte columns, and JS arrays for `text[]`. `COLUMN_TYPES` declares the neutral
type of every column so a phase-specific loader binds each value correctly;
`TABLE_ORDER` is a valid foreign-key insert order.

Coverage — 84 rows across all 27 tables (26 schema tables + `schema_migrations`),
asserted against the migrations by `tests/unit/storage-fixture.test.ts`:

- **identity/tenancy:** 3 users (incl. a disabled one and a `NULL` name), 2 projects (one archived), 4 memberships spanning admin/reviewer/viewer, a live and an expired session, a project-scoped and a site-scoped (`project_id NULL`, `expires_at NULL`) API token;
- **suites:** 2 suites (one archived), 6 suite files covering all six `kind`s, 3 snapshots with `tree` maps into 7 content-addressed `blobs/<sha256>` objects (including a superseded revision of one file, so blob GC has something to keep and something to reclaim);
- **environments/secrets:** a fully-populated environment (app overlay, `secret_env`, `runner_labels` array) and an empty one (`{}` config, `[]` labels), 2 AES-GCM `bytea` secrets;
- **auth broker:** a `token_endpoint` provider and a `script` provider (nullable `environment_id`), 1 session artifact, 1 **pending** session claim (the single-flight partial index);
- **execution:** 2 run groups (`done`, `running`), 3 executors covering all surviving kinds (`group`, `media`, `mint`), 5 runs covering `pass`/`fail`/`explored`/`queued`, modes `act`/`heal`/`explore`, a fully-`NULL` projection row, 3 dispatches covering `concluded`/`running` and a second `attempt`, 4 run events;
- **artifact tiers:** all four artifact kinds (`bundle`, `index`, `clip`, `clip_vtt`), both artifact tiers (`full`, `core`), and all three run tiers (`full`, `core`, `meta` — the meta run correctly owns zero artifact rows), plus retention provenance JSON;
- **review:** 2 baselines (v1 superseded by v2), 2 candidates (`pending` with `diff_summary`, `accepted` with a legacy `NULL` summary);
- **findings:** 3 findings (`new`, `accepted` with `external_ref` and `summary.confirmed_*`, and a **merge tombstone** whose duplicate fingerprint is legal only because `merged_into` is set), 3 evidence rows including one with all-`NULL` locus columns;
- **feed/audit/ops:** 5 ULID-ordered platform events across five types, 5 audit rows including one site-level `project_id NULL`, 1 service heartbeat;
- **objects:** 12 object-store entries — 7 suite blobs, a full bundle, a rebuildable `.idx.json` sidecar, a clip, a clip VTT, a core bundle, plus one deliberate **orphan** under `runs/` that no artifact row references (the grace-period sweep target).

Sealed `bytea` values were produced with a fixed IV under
`FIXTURE_KMS_KEY_BASE64`; `FIXTURE_SECRET_PLAINTEXTS` records what they decrypt
to, so a restore drill can prove round-trip decryption end to end. Bundle and
clip object bytes are deterministic stand-ins, not real tar archives — the
metadata layer only stores key/sha256/size/tier, and S3 owns real-bundle
exercises.

## 4. Recorded expected projections

`tests/fixtures/storage-baseline/expected-projections.json`, computed in plain JS
by `projections.ts` (no database) and regenerated by `build-expectations.mjs`.
Frozen contents:

1. `rowCounts` per table and `totalRows` (84);
2. `relationships` — dangling-FK check (empty), memberships per project, runs per group, artifacts per run, max `run_events.seq` per run, max `suite_snapshots.seq` per suite, `evidence_count` agreeing with the evidence rows, the merged-finding list, and active-fingerprint uniqueness;
3. `canonicalJsonValues` — the canonical JSON string for **every** JSON column of every row, keyed `table:pk:column`;
4. `timestampEpochs` — every timestamp as UTC epoch milliseconds, keyed the same way (this is the frozen SQLite representation, recorded independently of any database);
5. `nullColumns` — every column that must round-trip as SQL `NULL`;
6. `objects` — sha256 and size per key, which keys are referenced by artifact rows vs by snapshot trees, the orphan list, and the artifact-row/object agreement flag;
7. `queries` — the read projections behind the Postgres-specific SQL: storage usage by tier and kind (1290 bytes over 5 artifacts), runs by artifact tier, health counts, LLM spend (`0.9488` USD, the `->>` + `SUM` aggregate), the default findings queue, feed cursor order and tail, audit descending keyset order, newest artifact per (run, kind) (`DISTINCT ON`), current baselines (`superseded_by IS NULL`), `changed.json` runs (the `manifest->>'healed'` boolean projection), pending session claims, and the active-dispatch count.

S1 and S4 seed SQLite from `fixture.ts`, run the equivalent queries, and must
reproduce all of it exactly.

## 5. Write-contention benchmark and driver decision

### Driver: `node:sqlite` (built in)

Node available here is **v25.8.2**; `node:sqlite` (`DatabaseSync`) is present,
non-experimental (no warning on import), bundles SQLite **3.53.3**, and ships
`StatementSync`, `Session`, and an online `backup()` — which S4 needs for
hot backups. Chosen over `better-sqlite3` because:

- zero dependencies and zero native build step; the control plane currently
  depends on exactly one package (`pg`), and this replaces it with none;
- no prebuilt-binary/ABI risk across Node upgrades, which is the standard
  operational cost of `better-sqlite3`;
- `backup()`, `RETURNING`, upsert, window functions, `FILTER`, partial indexes,
  and the `json_*` family are all verified working (§2 and the benchmark);
- the API is synchronous, exactly like `better-sqlite3`, so the transaction
  wrapper is the same shape either way and switching later is contained to
  `src/db.js`.

**Consequence to record in S1:** `node:sqlite` first shipped in Node 22.5 and
stabilized after that. `src/platform/control-plane/package.json` currently
declares `"engines": { "node": ">=20" }`; S1 must raise the control-plane engine
floor to **`>=22.5`** (recommend `>=24` to be clear of the experimental window).
The root package's floor is unaffected — SQLite is a control-plane concern and
**no dependency is added to the root package**. If a deployment is pinned below
that floor, `better-sqlite3` as a control-plane-only dependency is the fallback,
and only `src/db.js` changes.

### Benchmark

`tests/bench/sqlite-contention.ts` — not wired into `npm test`,
`npm run hosted:test`, or any glob (`tests/unit/*.test.ts`,
`tests/integration/*.test.ts`). Run it by path. Each scenario seeds a fresh
temp-directory database (40 runs, 60 findings, 80 artifacts) and drives worker
threads holding independent connections to the same file.

The `write` operation is the real transactional-outbox unit, in one
`BEGIN IMMEDIATE`: append a `run_events` row with a `MAX(seq)+1` subquery, update
the `runs` projection, insert a `platform_events` row, and append an `audit_log`
row. `list` is a feed page by ULID cursor + the findings queue + the
storage-usage `GROUP BY` + the `json_extract` spend aggregate. `event` is the
long-poll tail read.

Results — macOS 15 / arm64 / 12 cpus, APFS local volume, Node v25.8.2, SQLite
3.53.3, WAL, `foreign_keys=ON`, `busy_timeout=5000`:

| scenario | workers | ops | ops/s | p50 ms | p95 ms | p99 ms | max ms | `SQLITE_BUSY` |
|---|---|---|---|---|---|---|---|---|
| 1 writer, `synchronous=FULL` | 1 | 1000 | 11905 | 0.06 | 0.09 | 0.29 | 0.42 | 0 |
| 1 writer, `synchronous=NORMAL` | 1 | 2000 | 18868 | 0.03 | 0.06 | 0.74 | 1.08 | 0 |
| 1 writer, `FULL` + `fullfsync` (durable floor) | 1 | 300 | **247** | 3.99 | 4.13 | 7.99 | 10.63 | 0 |
| 4 writers, `FULL` + `fullfsync` | 4 | 600 | **235** | 3.99 | 4.13 | 8.07 | 1924 | 0 |
| 4 writers, `synchronous=FULL` | 4 | 2000 | 11236 | 0.06 | 0.09 | 0.33 | 117 | 0 |
| 8 writers, `synchronous=NORMAL` | 8 | 4000 | 16529 | 0.04 | 0.06 | 0.99 | 200 | 0 |
| 2 writers + 4 readers (WAL), `FULL` | 6 | 11000 | 54455 | 0.00 | 0.20 | 0.28 | 94 | 0 |
| ↳ writes only | 2 | 1000 | 4951 | 0.12 | 0.19 | 0.29 | 94 | 0 |
| ↳ reads only | 4 | 10000 | 49505 | 0.00 | 0.20 | 0.28 | 0.97 | 0 |

`fullfsync` is included because macOS `fsync(2)` does not flush the drive's write
cache — only `F_FULLFSYNC` does. The `fullfsync` rows are therefore the honest
*durable floor* and the closest analogue to a Linux server with a real barrier;
the plain `FULL` rows show what the page cache alone can do.

**Reading:** the durable floor is **~240 outbox transactions per second**, single
writer, at ~4 ms p50 — one drive flush per commit, exactly as expected. Adding
three more concurrent writers changed aggregate throughput by **−5 %** (247 → 235
ops/s), which says the ceiling is the flush, not lock contention. Across
21 900 write transactions and 8 concurrent connections there were **zero**
`SQLITE_BUSY` errors — `busy_timeout` absorbed every collision. WAL readers were
never blocked by writers: 49 500 reads/s with a p99 of 0.28 ms while two writers
committed continuously.

**Conclusion: the benchmark supports the single-node assumption.** A hosted
control plane whose write volume is run-status events, dispatch ledger rows,
review actions, and audit entries — order tens of writes per second at its
busiest, with reads dominating — has roughly two orders of magnitude of headroom
against the durable floor, and read throughput is effectively unbounded by the
writer.

**Two operational facts the port must carry:**

1. **Pragma order is load-bearing.** `PRAGMA journal_mode = WAL` briefly needs an
   exclusive lock. Setting it before `busy_timeout` on a second concurrent
   connection fails hard with `SQLITE_BUSY_RECOVERY` (`errcode 261`) instead of
   waiting — reproduced while writing this benchmark. Arm `busy_timeout` first;
   set `journal_mode` only on the owning connection (it is persistent in the
   file).
2. **Multi-connection tail latency is unfair.** Under 4-way contention the p50/p95
   were flat but one worker saw a 1.9 s max while others made progress — SQLite's
   lock is not FIFO. The `DESIGN.md` single-write-connection model avoids this
   entirely, and it is a concrete reason to prefer it over a connection pool.

Re-run on the actual deployment volume before S4 cutover; a network or throttled
volume invalidates these numbers.

---

## 6. Constructs that will be genuinely awkward in S1

Ranked by risk, for S1 planning.

1. **Automatic JSON parsing on read.** `pg` parses `jsonb` to JS objects, and
   roughly every read path dereferences the result (`row.manifest.result.status`,
   `row.tree`, `row.gate.checks`, `row.detail`, `row.totals.cost_usd`, …). SQLite
   returns TEXT. This must be solved once in the adapter with a per-table column
   map — the fixture's `COLUMN_TYPES` — and not by sprinkling `JSON.parse` at
   call sites. If it is missed anywhere the failure is silent-ish and far from
   the cause. Highest-value place to spend review effort in S1.
2. **`LATERAL` in `STORY_HEALTH_JOIN`** (`api/findings.js:19`). The correlation
   key is itself a JSON extraction (`f.summary->>'story_id'`), so the rewrite
   crosses two categories at once and the query decorates both the findings list
   and the findings detail. Get the windowed-CTE version right once and reuse it.
3. **`jsonb ||` merge on accept** (`api/findings.js:105`). `json_patch` is
   RFC-7386 merge-patch, which deletes keys whose value is `null` — jsonb `||`
   does not. The two keys involved are never `null` today, but the difference is
   silent and needs an explicit guard plus a test.
4. **Row-lock → conditional-update conversion.** 18 sites, each carrying a
   concurrency invariant (one winner per candidate resolution, per finding merge,
   per session-claim fulfil, per suite commit). `BEGIN IMMEDIATE` does most of
   the work, but each site needs its precondition restated in a `WHERE` clause
   and a `changes()` check, and each needs a concurrency test. Mechanical but
   unforgiving.
5. **`pg_notify` → post-commit signal** (`events/outbox.js:13`). `NOTIFY` inside a
   transaction is delivered at `COMMIT` for free, so a rollback silently emits
   nothing. An in-process emitter has to reproduce that deliberately in the
   transaction wrapper, or a rolled-back transaction will wake clients for an
   event they can never read.
6. **The advisory-lock lifetime mismatch** (`retention/worker.js:36`). The
   advisory lock is released at transaction end, but the retention cycle deletes
   objects *after* commit. The replacement lease must span the post-commit
   window. Do not port the lifetime, port the intent.
7. **`date_trunc` day bucketing** (`api/projects.js:231`). Integer division by
   86 400 000 is UTC-only. That matches today's behavior on a UTC server, but it
   is now explicit and should be stated in the contract rather than inherited.
8. **`NULLS LAST`** (`api/suites.js:292`). Easy to miss and it silently reorders
   the suite page's "last run" column; SQLite sorts `NULL` first under `DESC`.
9. **Test-isolation model change** (`tests/integration/helpers.ts:25,48`).
   Per-test Postgres schemas become per-test SQLite files. Straightforward, but
   it touches every integration test's setup and teardown, and it is what finally
   removes `PLAYTEST_TEST_PG` and Docker from the workflow (S2).

None of these argue against the port. They are the places where a careless
mechanical translation compiles and runs while quietly changing behavior, which
is why the fixture and its frozen projections exist.

### Corrections found while implementing S1 (2026-07-25)

1. **`json_object` loses the JSON subtype of an object-valued parameter.** §2.1
   says `json_patch(summary, json_object(…))` has the same shallow-merge
   semantics as jsonb `||`, which is true — but binding an *object* through
   `json_object` stores it as a quoted JSON **string**
   (`{"confirmed_by":"{\"user_id\":…}"}`). The value must be wrapped:
   `json(COALESCE(json_extract(summary, '$.confirmed_by'), $5))`. Any
   `jsonb_build_object` site carrying an object-valued parameter has the same
   trap. Pinned by a test.
2. **The fixture violated `UNIQUE (run_group_id, run_id)`.** Three `runs` rows in
   `group1` (and two in `group2`) shared one `run_id`, so the fixture could never
   have loaded into Postgres either — it had never been loaded into any database.
   Each run now carries its own run-directory stamp and
   `expected-projections.json` was regenerated (`run_id` appears in no
   projection, so the only diff is inside the affected `runs.manifest` canonical
   JSON strings).
3. **Timestamp comparisons must bind a `Date`, not an ISO string.** With
   `INT_TS` columns, SQLite ranks INTEGER below non-numeric TEXT, so
   `ts >= '2026-01-01T…'` silently matches **zero** rows instead of failing.
   `api/audit.js`'s `since=` filter had exactly this shape.

Two S1 implementation choices deliberately differ from what §2.13 and §1
anticipated, both because they remove churn without weakening a guarantee:

4. **`$1 … $n` placeholders were not rewritten to `?`.** SQLite accepts `$AAA`
   as a *named* parameter, so `$1` binds natively; `src/db.js` scans the
   statement (string literals stripped) for the indices it references and binds
   the array by position. Query text is therefore unchanged at ~200 call sites,
   and the dynamic placeholder builders in `api/audit.js` and `api/findings.js`
   needed no rewrite.
5. **`now()` stayed in SQL instead of becoming a bound parameter at ~70 sites.**
   It is registered as a SQL function returning the transaction's start instant,
   which is exactly Postgres `now()` semantics — one transaction still stamps one
   consistent instant. `DEFAULT` clauses compute epoch milliseconds inline
   (`CAST(unixepoch('subsec') * 1000 AS INTEGER)`) because SQLite will not call an
   application-defined function from DDL.

---

## Exit gate

- [x] **Every PostgreSQL-only construct has a named SQLite replacement** — §2, grouped by construct with `file:line` for each occurrence.
- [x] **The fixture covers every migration table and all artifact tiers** — all 27 seeded tables (26 post-0009 schema tables + `schema_migrations`), all four artifact kinds, both artifact tiers, all three run tiers; asserted against the migration files by `tests/unit/storage-fixture.test.ts`.
- [x] **Expected projections and object hashes are recorded independently of either database** — `expected-projections.json`, computed in plain JS, no driver involved.
- [x] **The write-contention benchmark supports the single-node assumption** — §5: ~240 durable outbox transactions/s single writer, −5 % under 4-way contention, zero `SQLITE_BUSY` across 21 900 write transactions, readers unblocked at 49 500 ops/s.
