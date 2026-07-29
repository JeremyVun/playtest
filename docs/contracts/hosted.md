# Hosted platform contracts

This file owns hosted platform state shared by the control plane, web
application, and runner agent. Read the narrower contracts for:

- [runner placement, execution, evidence upload, and fencing](hosted-runners.md);
- [findings, assisted authoring, and rule cards](hosted-findings.md);
- [hosted console information architecture and UX](hosted-web.md).

Executable inventories remain authoritative:

- `packages/platform/control-plane/src/routes.ts` owns HTTP routes.
- `packages/platform/control-plane/migrations/` owns the SQLite schema.
- `packages/platform/control-plane/src/config.ts` owns environment variables,
  defaults, and validation.
- `packages/platform/control-plane/src/errors.ts` owns error codes and status
  mappings.
- Core schemas own suite validation.

Update this contract for cross-component promises, persisted lifecycles,
authorization rules, and trust boundaries, not inventory changes.

## System and storage boundaries

Hosted Playtest has three runtime components:

- `packages/platform/control-plane` owns authentication, authorization,
  persistence, suite snapshots, dispatch, review, findings, and retention.
- `packages/platform/runner-agent` claims work, materializes pinned suites,
  executes through the public core API, and uploads sealed bundles. It never
  opens the control-plane database.
- `packages/platform/web` is a static client served by the control plane. Its
  build embeds the completed run-viewer build.

Hosted components consume core through `@playtest/core/*` exports. The local
CLI remains independent of the hosted platform. Generated browser builds live
only under each browser package's `build/` directory.

SQLite is the metadata system of record. The object store holds
content-addressed suite blobs, run bundles, clips, reports, and transient live
artifacts. Filesystem object storage is the only supported implementation.

`PLAYTEST_DATA_DIR` names the durable root and defaults to `.playtest-data`:

```text
<data-root>/
  playtest.sqlite
  objects/
```

`PLAYTEST_DB_FILE` and `OBJECT_STORE_URL` may split these locations; backups
must then cover both. Non-filesystem object-store URLs are reserved and fail
when used.

Migrations are forward-only, applied in filename order, one transaction each,
and recorded in `schema_migrations`. Startup refuses a data root whose ledger
names migrations absent from the running build. Retired migration lineages are
recreated, not converted.

Exactly one control-plane process writes the database. Active-active writers
and storage without trustworthy locking and atomic rename are unsupported.
Startup fails when the data root is unwritable or SQLite cannot enable WAL,
foreign keys, a busy timeout, and `synchronous = FULL`.

### Transaction guarantees

- The control plane owns one write connection; writes serialize.
- Contended read-decide-write operations use `BEGIN IMMEDIATE` and repeat their
  precondition in the mutating statement. A zero-row mutation loses the race
  and reports the winning state.
- Foreign keys, delete actions, unique indexes, and finding-fingerprint
  uniqueness are database constraints.
- A state change, its audit row, and its platform event commit atomically.
  Model calls, HTTP calls, object reads, and bundle rewrites run outside the
  transaction.
- Rolled-back changes emit no event or long-poll wake.
- Cross-process coordination uses lease rows, never connection-held locks.

JSON columns contain canonical JSON. Timestamps are UTC epoch milliseconds in
SQLite and ISO-8601 `Z` strings at the API boundary; daily buckets are UTC.
Booleans are constrained integers. Server-generated ULIDs keep feeds and
keyset pagination time-ordered.

## Platform invariants

1. Hosted suites are files, not a second semantic model. Hosted and local flows
   use the same core discovery, resolution, validation, and linting.
2. Every suite mutation creates an immutable snapshot. A run group pins one
   snapshot and its current baselines.
3. A runner materializes snapshots into the normal suite layout; core does not
   know their origin.
4. A completed story uploads one immutable `.ptrun`. Database projections serve
   lists and trends, but the bundle owns run evidence.
5. Deterministic gates own verdicts. Grader scores and movement are advisory.
6. Baseline changes require an authenticated reviewer. A runner, grader, or
   authoring model cannot accept its own candidate.
7. Suite, access, review, finding, intake, and retention mutations are audited.
8. All work uses the outbound runner claim board. A launch creates a dispatch;
   the control plane never starts or contacts a runner.

## HTTP and authorization

JSON routes live under `/api/v1`. Client failures use:

```json
{
  "error": {
    "code": "lower_snake_code",
    "message": "actionable message",
    "details": []
  }
}
```

`details` is optional. Validation failures preserve core validator messages.
Raw stacks and bare internal errors never reach clients.
An unavailable optional capability is `503 not_configured` naming the
configuration that enables it. `GET /api/v1/me` reports deployment
capabilities; these describe the server, not the caller's authorization.
Client-visible capability keys include:

- `llm`, whether drafting, synthesis, and model-assisted finding work can run;
- `auto_dedupe`, `auto_resolve`, and `auto_resolve_mode`, the deployment
  defaults that project policy may override; and
- `runner_check_in_window_s`, the shared silence threshold for runner presence
  and reconciliation.

Runner placement has no capability switch: every deployment uses the claim
board.

Project roles are cumulative:

```text
admin >= developer >= reviewer >= editor >= viewer
```

- `viewer` reads projects, suites, runs, evidence, findings, applications,
  rings, and runners.
- `editor` edits ordinary suite files, launches runs, synthesizes study
  findings, and manages project personas.
- `reviewer` decides baseline candidates and finding transitions.
- `developer` manages executable suite files, applications, rings, auth
  providers, and project runners.
- `admin` manages membership, project defaults, and permanent project deletion.

API tokens carry a role and are project-scoped unless explicitly site-scoped.
Development auth is a local admin bypass. Write routes are rate-limited per
principal except for the separately limited runner protocol; refusal is
`429 rate_limited` with `Retry-After`.

Fully buffered 200 GET/HEAD responses containing JSON, text, script, images, or
fonts carry `cache-control: no-cache` and a strong ETag derived from the
uncompressed bytes. Authorization runs before conditional handling. Matching
`If-None-Match` returns a bodyless 304. Compressible bodies of at least 1 KiB
use gzip or Brotli according to `Accept-Encoding`, with
`Vary: Accept-Encoding`; the ETag is stable across encodings. HEAD returns the
GET headers without its body. Streaming, Range, attachment, and error responses
own their separate behavior.

## Suites and snapshots

A suite belongs to one immutable application. Its cases must use that
application’s driver, and launches may select only the application’s rings.
Suite creation takes an application id or key. It may be omitted only when the
project has exactly one application; a project with none returns an actionable
create-application error. Suite reads include `application_id` and the
application’s key, name, driver, and platform.

Hosted suite reads and mutations resolve through core in
[structural mode](engine.md#resolution-modes). A hosted suite need not author a
physical target: the selected ring supplies it at launch, and a mobile runner
supplies machine-local build and device facts. Executable resolution remains a
runner and CLI concern.

Suite files retain exact bytes. Paths use forward slashes, stay within the
suite root, and cannot use reserved platform paths. File kinds distinguish
defaults, cases, personas, hooks, assertions, and opaque assets. Hooks and
assertions require `developer`.

Validation, linting, imports, and commits operate on the whole effective suite.
An import commits atomically only after path and suite validation. Exports
round-trip the stored tree without rewriting it.

A suite read accepts `include=cases,defaults`. `cases` has the same items as
the resolved-case endpoint; `defaults` has the stored `playtest.yaml` file row
or null before the first commit. The folds do not change either resource shape.
Unknown include values return 400 rather than being ignored.

Resolved discovery stories report `next_run: explore`. Other stories report
`check` when a non-superseded baseline exists for the persona-independent story
id and `record` otherwise. Hosted baselines are rows, not files in the snapshot.

A snapshot records the complete path-to-content-hash tree and a monotonically
increasing suite sequence. Mutations use optimistic concurrency; a stale base
sequence returns `409 conflict`. Snapshot blobs are content-addressed and may
be shared.

## Applications, rings, secrets, and target authentication

An application is one executable surface with immutable `key`, `driver`
(`web`, `api`, or `mobile`), and mobile `platform` (`ios` or `android`). Names
are editable. A suite's application binding is immutable.

A ring is an application-owned deployment target with immutable key, name,
routing labels, and a logical configuration overlay. Web/API rings require a
base URL; mobile rings reject one. A URL is evaluated from the claiming
runner's network position, so loopback means that runner's machine.

Every surface a person reads calls a ring an **environment**, including server
messages and the operator guides; see
[hosted web contracts](hosted-web.md#suites-and-authoring).

A ring carries no discovery permission. Journey and discovery stories may
launch against any ring. Launch previews report `discovery.runs`, and the
console warns without blocking before a discovery run against an environment
named like production.

The ring overlay is materialized as `app.envs.<ring key>` and may contain only
logical configuration such as identities, secret references, cookies, headers,
settle, viewport, and setup inputs. Physical target fields (`base_url`, `app`,
`platform`, `device`, `appium_url`) and compose are not representable there.
Hosted execution applies the ring as a
[runtime target](engine.md#runtime-target) after authored resolution, replacing
authored physical fields while preserving logical suite precedence. Minted
`auth_states` remain operator-owned.

A mobile ring stores no build path, device, Appium endpoint, or application
bytes. The runner resolves those facts from its own configuration keyed by
`(application key, ring key)`. Hosted offers and launch previews therefore
carry `base_url: null` and `build_supplied_by_runner: true`.
No hosted route uploads or serves application binaries, and run groups do not
pin them.

Application and ring reads require `viewer`; mutations require `developer`.
Partial ring updates preserve omitted fields. Deletion refuses rather than
cascades:

- an application must have no rings, suites, or run groups;
- a ring must have no run groups or auth-provider references.

Permanent project deletion is the sole whole-project removal. A new project
starts with no application because its executable surface and target cannot be
inferred.

Secret values are write-only through the API and encrypted at rest with an
external root key. Losing the key makes stored secrets and sessions unreadable;
rotating it does not rewrite existing ciphertext.

Auth providers are `storage_state_secret`, `token_endpoint`, or `script`. A
provider may be project-wide or bound to one ring in its project. Ring-bound
providers are usable only by that ring; project-wide standalone mints carry no
target labels. Sessions are encrypted, expiring, and cached per provider and
identity. Concurrent requests for the same missing session share one mint.
`auth: none` always means signed out. Hooks and setup scripts receive only
explicit secret environment variables or files, and suite files cannot shadow
the managed secret directory.

Runner delivery, mint recovery, redaction, and machine-local target rules are
defined in [Hosted runner contracts](hosted-runners.md).

## Run groups and runs

A launch atomically:

1. resolves and selects cases through core in structural mode;
2. verifies suite, application, ring, and driver agreement;
3. pins the suite snapshot and current baselines;
4. creates a run group and one run row per selected case; and
5. creates the first dispatch attempt with immutable routing and target
   snapshots.

The launch request names the suite and ring. Their agreement with the
application is rechecked inside the transaction.

Each attempt snapshots application and ring identity, driver, platform, URL,
logical overlay, and placement labels. Secrets are resolved only when the
claimed group spec is served. Retries and continuations snapshot current ring
state.

Launch-level `runner_labels` override the ring for that group and all later
attempts. Omission follows the ring; explicit `[]` means any runner in scope.
Labels route work but grant no authority. Run-group `placement` states the
attempt’s labels and `labels_source` (`launch` or `ring`) and folds application
and ring keys into the group. Individual run reads include the same application
and ring objects. Launch preview reports those values before creation, plus
`target.resolved_base_url` for web/API,
`target.build_supplied_by_runner` for mobile, and
`placement.runner_online` for the effective labels.

Run-group states are `queued`, `running`, `done`, and `canceled`. Run states are
`queued`, `running`, `uploading`, `pass`, `fail`, `infra`, `explored`,
`canceled`, and `lost`. Modes are `record`, `act`, `heal`, and `explore`.

Manifest fields copied into database projections are not reinterpreted.
Reported bundles are accepted only after size and SHA-256 verification.

Cancellation stops new case starts and concludes every live dispatch attempt.
The runner learns through heartbeat and tears down active work. Reconciliation
marks abandoned work as infrastructure failure and may create one bounded
continuation for queued work. Accepted reports are never duplicated.

An editor may retry a finished, non-canceled group in place only for `infra` or
`lost` stories that never started. The retry retains group, run ids, snapshot,
baselines, and completed verdicts. Reset and dispatch creation are one
transaction; concurrent or duplicate retries return `409 conflict`.

Run-group reads accept `wait=true` or a numeric duration capped at 25 seconds.
The request holds until the group settles or the deadline expires. A timeout
returns the ordinary current projection, not an error; callers inspect `status`
and repeat.

Each run-index row carries `stats` with:

- story counts for `pass`, `fail`, `infra`, `explored`, `canceled`, `lost`, and
  `changed`;
- progress counts `total`, `queued`, `running`, and `done`;
- summed `cost_usd`; and
- `started_at`, `finished_at`, and `duration_ms`.

`finished_at` and `duration_ms` remain null while any story is moving.
`include=runs` adds capped story rows with identity, status, mode, healed and
changed flags, score, steps, duration, start, cost, error, and current progress;
`stats.total` remains the uncapped truth. `outcome=attention` selects runs with
a failed check or a story that produced no verdict, excluding `explored` and
`canceled`. A newer pass of the same story on the same suite and ring retires an
older failure. Suite and status filters compose with attention.

Dispatch ownership, transition rules, executor fencing, cancellation, and claim
loss are defined in [Hosted runner contracts](hosted-runners.md).

## Model and concurrency defaults

Actor and grader models resolve per key, most specific first:

1. case;
2. suite defaults;
3. project defaults;
4. engine defaults.

Project model settings are an admin-owned cost and quality policy. Values use
the same tier-or-qualified-name vocabulary as suite configuration. An omitted
key is unchanged; `null` or `""` clears it. The runner fills only unset suite
keys before core performs the normal resolution. Manifests pin the models
actually used.

The model catalog reports suggestions and engine defaults, not a validation
allowlist. Launch previews state each effective model and its source. Platform
authoring and synthesis models are deployment settings; finding consolidation
and auto-resolution may have project-level policy as defined in
[Hosted findings contracts](hosted-findings.md).

History-based launch estimates group completed runs by the mode recorded in
their manifest, falling back to planned database mode only for legacy rows. A
replay that escalated to healing therefore does not inflate the estimate for a
clean replay.

Run-group concurrency resolves once:

1. the pinned suite's `parallel`, when present;
2. the project's concrete `{ total, record }` policy;
3. `{ total: 1, record: 1 }`.

Project policy requires positive integers with `record <= total`. The runner
passes the effective policy to core’s worker pool: `total` caps all stories and
`record` caps actor-driven stories. Input order and core’s start stagger are
preserved. Process-isolated execution keeps the shared ring overlay alive until
the last concurrent case releases it; one case cannot restore it while another
still runs.

## Personas

A project persona is `{ name, description }` prose selected by a story's
`persona` slug. Built-ins list first and are immutable. Project persona slugs
are immutable; persona writes require `editor`.

Project personas are stored as content-addressed YAML blobs in the same shape
as suite-local persona files. Snapshot-tree reads merge current project
personas at runtime, with snapshot files winning on collision. Consequently,
the pinned snapshot fixes stories but not project persona prose. A suite that
needs pinned prose commits its own persona file.

## Bundles, live viewing, and baseline review

The `.ptrun` and `BundleProvider` contracts live in
[Artifact contracts](artifacts.md). Hosted adapters translate project
projections and bundle entries without changing viewer semantics. The console
embeds the same viewer, suppresses local CLI review instructions, and passes an
explicit console theme.

Sibling artifacts such as clips never mutate a sealed bundle and take
precedence for their specific view. Clip generation is idempotent; clients join
an in-flight generation and observe completion through `clip.created`. Missing
source evidence or media tooling returns an actionable error. Hosted re-grading
is unsupported.

A healed run creates a pending baseline candidate containing its proposed
trajectory, source run, pinned story hash, baseline version, and diff summary.
Acceptance requires reviewer authorization, a still-current lineage, a passing
source run, and verified bundle integrity. It creates a baseline version and
supersedes competing candidates. Rejection leaves the baseline unchanged.
Stale or concurrent decisions fail visibly.

A newer clean replay or fresh recording of the same story also supersedes an
older pending candidate because it invalidates the proposal’s premise. Each
automatic retirement emits `candidate.superseded`.

A run may be viewer-visible before its bundle exists. Live state is transient,
non-authoritative, and cannot affect status, review, export, retention
decisions, or sealed bytes. It is open only while explicitly marked open and
the run is non-terminal.

Live manifest and trajectory data live in SQLite. Step artifacts use
object-store ledger rows that reserve budget before upload and become readable
only when ready. The deployment’s per-run staging budget defaults to and cannot
exceed 512 MB, matching the sealed-bundle ceiling. Exhaustion is an explicit
refusal, never truncation; entry, body, and trajectory-line limits bound each
request. Entry precedence is sibling artifact, sealed bundle, then staged
entry.

Viewer picker, history, changed-story, and live-stream wire shapes are owned by
[Interface contracts](interfaces.md#live-runs).

Staging is removed when a verified bundle lands. Terminal runs without a bundle
retain staged evidence through the retention grace period because it may be the
only evidence produced. Upload protocol and sanitization are defined in
[Hosted runner contracts](hosted-runners.md#live-evidence).

## Events and long polling

State mutations write platform events in the same transaction. The browser feed
returns ordered events and a durable cursor. Delivery is at least once, so
consumers deduplicate by event id.

A cursor belongs to its event-type filter; broadening `types=` requires an
empty cursor. Held reads end within the common hold window and release when the
client disconnects.

Post-commit in-process signals reduce latency but carry no state. Held reads
also rescan on a bounded interval, so missed signals and server restarts cannot
lose committed events. Process-generated ULIDs remain strictly increasing
through backwards clock movement. A reconnect from the last durably processed
cursor receives every later committed event in order.

## Background cycles and retention

Scheduled cycles such as reconciliation, retention, and finding sweeps use
named lease rows:

- conditional acquisition admits one non-reentrant holder;
- the holder renews during long work and releases on success or failure;
- expiry permits crash recovery; and
- each cycle operation remains independently safe through transactional
  preconditions. The lease prevents duplicate slow work but is not an atomicity
  boundary.

Skipped overlapping cycles are normal. Lease rows contain no user or evidence
data and are excluded from backup contracts.

Retention is deployment-wide; there is no project policy, console setting, or
legal hold. Defaults retain event rows for 14 days, full bundles for 90 days,
and core evidence for 365 days. Operator overrides may retain full or core
evidence forever.

Run evidence tiers are:

- `full`: the recorded bundle;
- `core`: manifest, trajectory, grade, text evidence, and timing captions;
- `meta`: database projections only.

Retention moves at most one tier per cycle. `full` to `core` deterministically
rewrites the bundle and records its hashes and removed paths. `core` to `meta`
deletes the bundle but preserves projections.

Current baselines, pending candidates, and evidence for `new`, `accepted`, or
`reopened` findings pin their required tier. Auto-resolved evidence remains
pinned for its configured grace period. Missing or pruned evidence must be
stated, never rendered as an empty success.

Clips and VTTs are sibling artifacts sharing the source run's lifecycle.
Transient live staging is collected only after a terminal bundle-less run's
grace period; pending reservations and orphan objects are reclaimed safely.
Unreferenced content-addressed suite blobs are reclaimed independently.

Bundle reads and rewrites remain subject to implementation upload and
safe-integer limits. Larger artifacts require a new streaming contract.

## External automation

Playtest does not execute project-authored plugins, generic webhooks, or
automatic tracker integrations. External automation uses authenticated project
tokens, run and finding reads, run-group long polling, and the same audited
finding transitions as the console. Human **Copy for tracker** remains the
default issue-tracker handoff.

## Contract changes

Update this file for changes to hosted state/status meanings, authorization,
suite snapshots, application/ring targeting, review, events, retention, or
cross-component trust boundaries. Update the narrower hosted contract when the
change concerns runner protocol, findings/authoring, or console UX.

Routes, columns, environment variables, module moves, tests, implementation
history, and deployment plans do not belong here by themselves.
