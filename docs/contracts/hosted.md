# Hosted platform contracts

This file owns behavior shared by the hosted control plane, web application,
and runner agent. It describes guarantees that cannot be inferred from one
component alone.

The executable inventories remain authoritative:

- `packages/platform/control-plane/src/routes.ts` owns the complete HTTP route list.
- `packages/platform/control-plane/migrations/` owns the exact SQLite schema.
- `packages/platform/control-plane/src/config.ts` owns environment variables,
  defaults, and validation.
- `packages/platform/control-plane/src/errors.ts` owns error codes and HTTP status
  mappings.
- JSON and YAML schemas under `packages/core/src/schemas/` own suite validation.

Do not copy those inventories into this file. Update this contract when a
cross-component promise, persisted lifecycle, authorization rule, or trust
boundary changes.

## System boundaries

Hosted Playtest has three runtime components:

- `packages/platform/control-plane` owns authentication, authorization, persistence,
  suite snapshots, dispatch, review, findings (including discovery study
  synthesis), retention, and the HTTP API.
- `packages/platform/runner-agent` materializes a pinned suite snapshot, executes
  cases through the public core API, uploads sealed run bundles, and reports
  results. It never opens the control-plane database.
- `packages/platform/web` is a static browser client served by the control
  plane. Its completed build embeds the completed run-viewer browser build.

Each component is a private npm workspace with its own scripts and direct
dependency declarations. The private root is orchestration only, and its
`package-lock.json` is the only lockfile.

Hosted components consume core only through `@playtest/core/*` package exports.
The local CLI remains fully functional without the hosted platform.

The hosted console is one minified ESM bundle served with its copied HTML and
CSS from the generated `packages/platform/web/build/` directory. Its source map
is generated beside it, and the complete run-viewer build is copied under
`build/viewer/`. No generated JavaScript is emitted beside TypeScript source. A checkout must run
`npm install` (which runs `npm run build:web`) or run `npm run build:web`
explicitly before any server serves those directories. The supported hosted
entry point performs that build itself.

SQLite is the system of record for hosted metadata. The object store holds
content-addressed suite blobs, run bundles, clips, and reports. Filesystem
object storage is the currently supported implementation.

**There is one placement model, and no variable selects it.** Work is placed on
the runner claim board (see "Runner pool"): a launch writes a `requested`
dispatch row with its labels and target snapshots, and that row IS the board
entry. The control plane starts no process and opens no connection to a runner
in response to a launch — local, CI, and fleet runners all arrive the same way,
by polling outbound, claiming, and exchanging. Placement is not the system of
record and not an artifact store.

## Storage, deployment topology, and transactions

The control plane requires no database service. Metadata lives in one SQLite
file; large objects live in the object store beside it.

**Data root.** `PLAYTEST_DATA_DIR` is the single configuration knob and must
point at one durable local volume. It defaults to `.playtest-data` under the
working directory. Within it:

```text
<data-root>/
  playtest.sqlite      # metadata; system of record
  objects/             # default filesystem object store
```

`OBJECT_STORE_URL` selects a separate filesystem mount. An S3 or HTTP URL
selects the reserved, nonfunctional S3 adapter and fails when used.
`PLAYTEST_DB_FILE` overrides the database path. Overriding either splits durable
state across locations; a backup is then incomplete unless it covers both.

**Migrations.** `migrations/NNNN_*.sql` is applied in filename order, each in its
own transaction, and recorded in `schema_migrations`; the runner is forward-only
with no down-migrations. Boot additionally compares the data root's applied
ledger against the migration set this build SHIPS: a ledger naming a retired file
fails startup with a `ServerConfigError` naming those files and telling the
operator to point `PLAYTEST_DATA_DIR` somewhere new. That check exists because
forward-only means a root built by a retired lineage would otherwise have the
current schema applied on top of the old one. Applications and rings replaced
environments with no migration path — the deployment model is greenfield — so
such a root is recreated, never converted.

**Deployment topology.** Exactly one control-plane process writes the database.
Active-active replicas are unsupported, as are network filesystems without
trustworthy locking and atomic rename. Startup fails with a `ServerConfigError`
when the data root is not writable or when SQLite cannot enable WAL journalling,
foreign keys, a busy timeout, or `synchronous = FULL`.

**Transaction guarantees.**

1. One owned write connection. WAL admits concurrent readers; writes serialize.
2. Read-then-decide operations run in a single `BEGIN IMMEDIATE` transaction and
   restate their precondition in the mutating statement's `WHERE` clause, so
   exactly one concurrent caller wins a candidate resolution, a finding merge or
   transition, a session-claim fulfil, or a suite commit. The loser observes the
   winner's decision and receives the documented conflict error.
3. Foreign keys, `ON DELETE` actions, and unique constraints — including the
   partial unique index that makes an active finding fingerprint unique — are
   enforced by the database, not by application convention.
4. A transaction is the atomic unit for a state change, its audit row, and its
   platform event. Long work (model calls, HTTP requests, object reads and
   bundle rewrites) runs outside transactions.
5. Externally visible effects are post-commit. A rolled-back transaction emits
   no event and wakes no long-poll client.
6. Cross-process coordination is a lease row, never a lock held by a connection.
   See "Background cycles and leases".

**Stored representations.** JSON columns hold canonical JSON text (keys sorted
recursively, no insignificant whitespace); logically equal documents are
byte-equal. Timestamps are UTC epoch-millisecond integers and are rendered as
ISO-8601 `…Z` strings at the API boundary. Per-day aggregation buckets are UTC.
Booleans are constrained `0`/`1`. Identifiers remain server-generated ULIDs, so
feed cursors and audit keyset pagination stay time-ordered.

## Platform invariants

1. A hosted suite is stored as files, not as a second semantic model. The same
   core discovery, resolution, validation, and linting code used by the CLI
   processes hosted suites.
2. Every committed suite mutation creates an immutable snapshot. A run group
   pins one snapshot, so later edits cannot change an in-flight or completed
   run.
3. The runner materializes snapshots into the normal CLI directory layout.
   Core never knows whether a suite originated in the hosted database.
4. A completed case is uploaded as one immutable `.ptrun` bundle. Database
   projections support lists and trends, but the bundle remains authoritative
   for run evidence.
5. The deterministic gate decides pass or fail. Grader scores and movement are
   advisory trends and must not be promoted into gate verdicts.
6. Baseline changes require an explicit authenticated review action. A runner,
   grader, or authoring model cannot accept its own candidate.
7. Every mutation affecting suites, access, review, findings, or findings
   intake, and every automatic retention action, is attributable in the audit
   log.

## HTTP conventions and authorization

JSON API routes live under `/api/v1`. Client-facing failures use:

```json
{
  "error": {
    "code": "lower_snake_code",
    "message": "actionable message",
    "details": []
  }
}
```

`details` is optional. Validation failures carry the core validators' messages.
Raw stack traces and bare internal errors never reach clients.

An optional capability this deployment was not configured with is
`503 not_configured`, never a 500: the request was well-formed and authorized
and nothing crashed, so reporting a deployment choice as "Internal Server Error"
would send people hunting a bug that does not exist. The message names the
environment variable that switches the capability on. `GET /api/v1/me` reports
the same thing ahead of time as `capabilities`, a description of the SERVER and
never an authorization signal — `capabilities.llm`, the platform LLM
gateway behind story drafting, study synthesis, and candidate consolidation,
and `capabilities.auto_dedupe`, whether that gateway plus the
`PLAYTEST_AUTO_DEDUPE` toggle has automatic post-run finding dedupe on. The
console uses them to present those affordances as unavailable-and-why instead of
offering a control the server cannot answer; the routes still enforce roles.

One more describes placement:

- `capabilities.runner_check_in_window_s` — how long since a runner's last
  check-in still counts as present (§ Runner pool). Published so a console's
  presence and the reconciler's patience are one number, not two.

There is deliberately no capability describing WHETHER this deployment places
runs on self-hosted runners. It always does, so the Runners section, runner
labels, and the launch dialog's placement line are always present.

Project roles are cumulative:

```text
admin >= developer >= reviewer >= editor >= viewer
```

- `viewer` reads projects, suites, runs, evidence, and findings.
- `editor` edits ordinary suite files, launches runs, runs study synthesis, and
  manages project personas.
- `reviewer` accepts or rejects baseline candidates and triages findings —
  confirming, rejecting, merging, resolving.
- `developer` manages executable suite files, applications and rings, auth
  providers, and the self-hosted runner registry (`viewer` may list runners and
  read applications and rings — an editor has to pick one to create a suite, and
  the launch dialog is a viewer surface).
- `admin` manages membership and project-wide administration, including
  permanent project deletion (`DELETE /api/v1/projects/:p`). Retention is a
  deployment-wide policy set by operators, not configured per project; legal
  holds do not exist.

API tokens have a role and are scoped to one project unless explicitly
site-scoped. Development auth is an admin bypass for local use only.

Write routes are rate-limited per principal, except the separately scoped
runner protocol. Refusal uses `429 rate_limited` with `Retry-After`. The limiter
is process-local, so its effective capacity scales with server replicas.

**Validators and content coding.** Every fully buffered response — handler
JSON, small handler buffers, and the static web app — leaves through one sender
(`packages/platform/control-plane/src/response.ts`), which owns conditional requests
and content coding; no route implements either. A 200 GET/HEAD whose body is
JSON, text, script, image, or font carries a strong `ETag` (truncated SHA-256
of the uncompressed bytes) plus `cache-control: no-cache`: nothing here has
content-hashed filenames, so every response revalidates, and the validator
makes revalidation bodyless. A matching `If-None-Match` returns 304 with no
body — always after the handler has run its authorization guards, so a 304 is
reachable only by a request that was already allowed. Compressible bodies of at
least 1 KiB are gzip- or brotli-coded per `Accept-Encoding` with
`vary: accept-encoding`; the ETag is computed over the uncompressed bytes, so
it is stable across encodings. HEAD returns exactly the headers its GET would,
without a body. Deliberately outside all of this: streaming and Range replies
(the viewer's bundle-entry serving keeps its own `last-modified`/304/206
handling), attachment downloads, and error envelopes.

## Suites and snapshots

A suite belongs to exactly ONE application (`suites.application_id`), chosen at
creation and immutable: the suite's driver is the application's driver, and the
launch selector is `(suite, ring)`, so a suite can never launch against another
surface's deployment. `POST /api/v1/projects/:p/suites` takes `application_id`
(an id or a key); with exactly one application in the project it may be omitted,
and with none the refusal says a developer has to create the first application
rather than 404ing on a null id. Suite reads fold the binding in as
`application_id` plus an `application` object (key, name, driver, platform).

Every hosted read of a suite resolves through core in STRUCTURAL mode
(`docs/contracts/engine.md#resolution-modes`): commit, import, listing, preview,
validation, linting, authoring, review and Playwright export all validate cases
and logical configuration without requiring a complete physical target. That is
the honest mode here, because a hosted suite legitimately authors no target at
all — the ring supplies the URL at launch, and for mobile the platform
deliberately does not know an app path. Executable resolution, which still
requires a complete target, happens on the runner and on the CLI. Lint follows
the same mode, so a target-free suite is linted rather than silently skipped.

Suite files retain their exact bytes. Paths use forward slashes and cannot be
absolute, escape the suite root, or address reserved platform paths. File kinds
distinguish defaults, cases, personas, hooks, assertions, and opaque assets.
Executable hooks and assertions require the `developer` role.

Validation and linting operate on the whole effective suite. Imports commit
atomically only after every file passes path and suite validation. Exports
round-trip the stored tree without rewriting file contents.

`GET /api/v1/projects/:p/suites/:slug` accepts `include=cases,defaults`, which
folds onto the suite row exactly what the suite surfaces render on first
paint: `cases` carries the same items as `GET /suites/:s/cases`, and
`defaults` the same row as `GET /suites/:s/files/playtest.yaml` — null before
the first commit, a new suite's normal state. The folds change no shapes and
add no second semantic model; they exist so a page is one request instead of
a lookup-then-fetch waterfall. An unknown include value is a `400`, never
silently ignored.

The hosted resolved-case list reports the same `next_run` values as the CLI, but
decides them from stored state rather than from files: discovery stories report
`explore`, and every other story reports `check` when the suite holds a
non-superseded baseline for its persona-independent story id and `record`
otherwise. Baselines are database rows, not files in the tree, so a materialized
suite tree alone never decides `next_run`. This is the rule dispatch plans run
modes with.

A snapshot records the complete path-to-content-hash tree and a monotonically
increasing suite sequence. Mutations use optimistic concurrency; a stale base
sequence fails with `409 conflict` rather than overwriting a concurrent edit.
Snapshot blobs are content-addressed and may be shared.

## Run groups and runs

A launch:

1. resolves and selects cases through core (structural resolution);
2. resolves `(suite, ring)` to the application all three must agree on, and
   validates driver and discovery policy: every resolved case's driver must
   equal the application's — a suite has no driver column, its case files do —
   and a selection holding discovery stories needs a ring marked
   `discovery_allowed`;
3. pins the suite snapshot and current baselines;
4. creates a run group plus one run row per selected case, recording
   `application_id` and `ring_id`;
5. creates a dispatch ledger entry carrying this attempt's labels and target
   snapshots — which IS its claim-board entry. Nothing is started.

The launch request names `suite_id` and `ring_id`. Suite, ring and application
are re-checked to agree INSIDE the launch transaction, so a stale client cannot
pin a group whose three references contradict each other.

Each dispatch attempt records a **non-secret target snapshot** — application and
ring ids and keys, driver, platform, the ring's URL, the placement labels, and
the logical overlay — and its offer and its group spec serve that snapshot. A
ring edit between preview, poll, claim and exchange therefore cannot make them
disagree. A retry or a continuation snapshots current ring state, which is the
documented retry behavior. Secrets are never in the snapshot; they are resolved
when the group spec is served, after the claim and the exchange.

A launch may pin its placement: `runner_labels` on the launch request (and on
its preview) overrides the ring's `runner_labels` for that group alone.
It takes the role that launches (`editor`) and no other, because labels are
routing and never authority — a runner reaches only jobs in the project its
credential is registered to, so choosing which of that project's runners takes a
run is the same decision scope as running it at all. Absent means "follow the
ring"; an explicit `[]` is a decision, not an absence, and means "any
runner in this project". The pin is recorded on the group (`runner_labels`, null
when unpinned) and places every later attempt of that group — a continuation
after a partial completion, an in-place retry — even if the ring's labels change
in between. `GET /api/v1/run-groups/:id` states the outcome in `placement`: the
attempt's `labels` and whether the launch or the ring chose them
(`labels_source`, `launch` | `ring`), and carries the group's `application` and
`ring` by key so a reader never has to join an opaque id. `GET /api/v1/runs/:r`
folds the same two objects in, so a single run read names its surface without
two more requests. The launch preview
reports the same pair before anything is created, plus `target` (the application,
the ring, the `resolved_base_url` for web/API, and `build_supplied_by_runner`
for mobile) and `placement.runner_online` — whether a runner advertising these
labels has actually checked in.

Run-group states are `queued`, `running`, `done`, and `canceled`. Case states
are `queued`, `running`, `uploading`, `pass`, `fail`, `infra`, `explored`,
`canceled`, and `lost`. Modes are `record`, `act`, `heal`, and `explore`.

The database stores list and trend projections copied from the reported manifest.
It must not reinterpret or enrich core manifest fields in place. Bundle
integrity is checked against the reported size and SHA-256 before the run can
be considered complete.

Cancellation stops new case starts and marks the claim canceled; nothing can
call a runner, so the runner learns at its next heartbeat and runs the teardown
a SIGTERM triggers. A dead executor cannot strand a group indefinitely: the
reconciler marks unreported work as infrastructure failure and may dispatch a
bounded remainder. Retries never duplicate an already accepted case report.

`POST /api/v1/run-groups/:id/retry` is an editor-authorized, in-place retry for
a finished group's stories that never started (`infra` or `lost` with no
`started_at`). It resets only those rows to `queued`, keeps the same group,
pinned snapshot, case/run ids, and completed verdicts, and creates a new
dispatch attempt under that group. Product failures and any story that started
are immutable evidence and are not reset by this route. The group-state check,
row reset, and dispatch-ledger insert are one transaction: a double click or a
retry while another attempt is active returns `409 conflict` and creates no
second attempt.

`GET /api/v1/run-groups/:id?wait=true` is the long-polling surface for
automation clients. The request is **held** — on the same discipline as the
event feed and the claim board (post-commit wake, bounded rescan, correctness
from the committed row) — until the group reaches `done` or `canceled`, or the
hold window elapses. `wait` accepts `true` (the 25-second maximum) or a number
of seconds, capped there. An unsettled answer at the deadline is normal, not an
error: the body is the same run-group projection either way, so a caller reads
`status` and asks again with its next `wait`.

`GET /api/v1/projects/:p/run-groups` is the Runs index projection, and every row
carries `stats`: per-status story counts (`pass`, `fail`, `infra`, `explored`,
`canceled`, `lost`, `changed`), progress (`total`, `queued`, `running`, `done`),
the summed `cost_usd`, and `started_at`, `finished_at`, `duration_ms`. They are
aggregates over `runs` computed in one grouped pass for the whole page — never a
request per row. `duration_ms` and `finished_at` stay null until nothing in the
run is still moving, because the last story that happened to finish is not the
run's wall clock. `include=runs` adds each run's story rows (run id, case, story,
status, mode, healed, changed, score, steps, duration, start, cost, error, and —
for a story in flight — the runner's live `progress` snapshot, § Runner
protocol) so a
console can expand a run without another request; those rows are capped per
page, and a run whose rows were cut still states its true story count in
`stats.total`. `outcome=attention` keeps only runs holding a story that failed a
check or never produced a verdict — `explored` and `canceled` are not attention,
and a failure is retired once a newer run of the same story on the same suite
and ring passes. The `suite` and `status` filters compose with it.

## Runner protocol

The runner authenticates and then uses only HTTP:

1. `POST /runner/exchange`
2. `GET /runner/groups/:group`
3. snapshot tree, blob, baseline, and session-claim reads
4. case start
5. case progress (optional, throttled)
6. live staging (optional: open, step artifacts, trajectory batches)
7. bundle upload
8. case report
9. group completion

Runner routes are under `/api/v1`; the abbreviated paths above identify the
protocol rather than a second namespace.

An exchange binds one executor to one active dispatch, and there is exactly one
way to obtain it: the runner presents its registration credential plus the
dispatch it CLAIMED on the board. A credential alone resolves no dispatch, so it
can never fetch a snapshot, a blob, a session grant, or post a report, and a
runner that did not win a claim cannot exchange for it. There is no development
shortcut past this boundary — no insecure exchange, under any auth mode. The
returned bearer is short-lived and scoped to exactly one run group or mint
claim; group and mint tokens are not interchangeable.

The group spec includes only the selected cases, pinned snapshot, baseline
references, this attempt's `ring` (`id`, `key`, `base_url`, the logical `config`
overlay, `runner_labels`, and `resolved_secrets`) and `application` (`id`,
`key`, `driver`, `platform`), session requirements, execution limits, concurrency
policy, and model configuration needed by that group. The ring block is served
from the attempt's target snapshot, so a ring edited mid-flight cannot change
what an in-flight group runs against; only `resolved_secrets` is computed at
serve time.

The runner materializes the ring's `config` under `app.envs.<ring key>` and
passes the ring's URL to core as a **runtime target**
(`docs/contracts/engine.md#runtime-target`), applied after the complete authored
merge. Hosted execution therefore replaces the authored physical fields —
`base_url`, `app`, `platform`, `device`, `appium_url` — rather than merging with
them, and a suite edit can no longer redirect which application a placed run
reaches. Authored physical fields stay valid for direct CLI use and are simply
inert here. The suite still wins on LOGICAL keys inside
`app.envs.<ring key>`, exactly as before, with one carve-out: minted
`auth_states` are operator-owned and can never be shadowed by a committed file.
`selection.max_steps` and
`selection.timeout_ms` are optional positive-integer, per-story overrides for
one run group; they ride each selected case as `options.limits` and replace the
resolved suite/story limits in executor memory without rewriting the sealed
snapshot. Executors never receive database credentials or platform-wide
secrets.

Case execution is isolated:

- Process isolation is allowed for local development, tests, and fresh
  ephemeral machines.
- Persistent runners use per-case containers.
- A case observes only its image, mounted workspace, and delivered
  environment.
- Root auth-provider credentials exist only during minting; cases receive
  derived session artifacts.
- Secret values must not appear in logs, events, manifests, or error messages.

Case progress (`POST /runner/groups/:g/cases/:run_id/progress`) is telemetry,
never load-bearing: while a case runs, the executor folds the engine's progress
events into one small snapshot — step and step budget, the mode word from core
reporting, the actor's last action, cost so far, token counts, the model at
work — and posts it at most every couple of seconds, fire-and-forget. The
executor redacts secret values from free text before posting (the snapshot rides
straight into a browser); the control plane whitelists and clamps the shape,
stores it on the run row (`runs.progress`), and announces it as a `run.event`
with `payload.type: "progress"`. It lands only while the case is `running` or
`uploading`, and the case report — or any terminal transition — clears it: a
finished run's truth is its manifest, and a late tick must never repaint a
finished row as live. A runner that never posts progress is fully conformant.

Case start, upload, report, and group completion are retry-safe. Completion may
be partial when the executor approaches its runtime budget; the control plane
dispatches only the remaining cases. A case report is accepted only for its
group, run id, and current executor binding.

### Live staging routes

Three optional routes stream a case's evidence in ahead of its bundle, so the
run is viewable while it executes ([Live runs](#live-runs)). All three ride the
existing group-scoped runner bearer with the same run-group check the bundle PUT
applies — no new principal and no new exchange — and all three answer refused or
no-op once the run is terminal. A runner that never calls them is fully
conformant; the run is then invisible until it seals, which is the older
behavior.

| Route | Meaning |
|---|---|
| `POST /runner/groups/:g/cases/:run_id/open` | `{ manifest }` — the placeholder manifest, and every later snapshot of it |
| `PUT /runner/runs/:r/live/<entry-path>` | one staged step artifact, raw bytes |
| `POST /runner/runs/:r/live/trajectory` | `{ from_line, lines }` — a batch of whole `trajectory.jsonl` lines |

**Every answer is an explicit JSON ack, never a silent success**: either
`{ accepted: true, … }` or `{ accepted: false, reason, message, … }`. A refusal
is a normal answer the uploader acts on. The reasons are `terminal` (the run has
finished), `not_open` (no `open` call landed for this run), `shape` (the entry
path or a line is not a shape the route stores), `immutable` (the entry already
holds different bytes), `budget`, `gap`, `divergent`, and `line_too_large`.
Malformed requests — a non-integer `from_line`, `lines` that is not an array of
strings, a missing manifest — remain ordinary `bad_request` errors.

`open` is idempotent and doubles as the manifest-snapshot route: it stores the
manifest on the run row and sets `live_opened_at`, and the returned
`manifest_generation` advances only when the stored bytes actually change, so a
repeated open costs nothing and never churns a watching viewer. Opening does not
touch the status machine.

`(run, entry path)` is unique and **immutable**. An identical-bytes retry (hash
match) replays the original acknowledgement without charging budget twice;
different bytes for a path already staged are refused. Entry paths are validated
against the step-artifact shape — `steps/<name>`, no traversal, no nesting — so
`manifest.json`, `trajectory.jsonl` and end-of-run artifacts are not stageable.

The trajectory route holds the authoritative line count and returns it on
**every** answer, refusals included, so one response always resynchronizes the
uploader. A batch at the count appends. An overlapping resend is *verified* —
the resent prefix must hash-match the stored lines — then deduplicated, so a
divergent retry is refused rather than silently merged. A batch that would leave
a gap is refused, and the answered count says where to rewind. The route carries
an explicit body cap set comfortably above the practical envelope maximum; a
single line over the line cap is refused with its own reason rather than
truncated.

The group spec advertises the live URL templates and every cap under
`uploads.live`, so a runner sizes its batches from the deployment rather than
from a constant it compiled in. A runner may keep the advertised route *path*
while dialling its own origin: `publicUrl` is not necessarily the address the
runner was pointed at.

**The uploader's posture.** The runner-agent ships this stream from one
serialized, single-flight queue per case, on the progress reporter's ~2 s
coalescing floor — a floor, not a heartbeat: a tick where nothing completed
sends nothing, and inactivity is read server-side from absence. It opens on
manifest readiness rather than on `case_start` (the event precedes the
placeholder write), ships each tick in run-dir order — artifacts, then the
trajectory delta naming only acked artifacts, then a manifest re-POST if the
run rewrote it — and lets acks drive the queue: a `gap` or `divergent` refusal
rewinds to the answered count, a transport failure pauses and the next tick
retries from the same position. Where the stream cannot continue honestly —
`budget`, `line_too_large`, a refusal no retry can fix, or a queue hopelessly
behind — **the uploader stops itself**, silently and without truncating or
inventing skip markers; the sealed bundle carries everything regardless. The
case scheduler owns shutdown: the queue is stopped and any in-flight request
aborted before the case report and before workspace cleanup. Nothing the
uploader does or fails to do may change a run's status, ordering, timing, or
sealed artifacts.

## Runner pool

The claim board is how ALL work is placed. The control plane never starts or
contacts an executor. A self-hosted runner — long-lived on a developer machine,
or ephemeral inside a CI job — authenticates outbound, advertises labels, and
claims work. **No inbound connection to a runner exists.**

**Identity is not routing.** Two things stay separate:

- The **runner credential** proves identity. It is minted once at registration,
  shown once, stored as a hash like an API token, and is the only long-lived
  secret on the runner's machine. It scopes the runner to exactly one project —
  or, for a site-scoped runner, to every project (see "Site-scoped runners").
  Credential hashes are globally unique, so a presented value resolves to
  exactly one row whatever its scope.
- **Labels** route work. They are not secrets, confer no authority, and appear
  freely in ring settings and console UI. A runner may re-advertise its
  labels at check-in; that changes which of the jobs in its scope match it, never
  what its scope is. A label is spelled with letters, digits, `.`, `_`
  and `-` only (at most 32 labels, 64 characters each), enforced at one
  validator for every surface that accepts one — runner registration,
  a ring's `runner_labels`, a per-launch pin, ephemeral CI registration and
  check-in re-advertisement. The alphabet is narrow because labels travel
  comma-joined on the agent's `--labels` (a comma inside one would silently
  become two) and unquoted inside the start command the console hands over.
  Anything outside it is `400`, naming the label and the allowed characters.

Registration is project-scoped by default: `POST /api/v1/projects/:p/runners`
(`developer`) returns the runner plus its one-time credential, `GET` the same
path (`viewer`) lists name, labels, last-seen and current claim, and
`DELETE …/:r` (`developer`) revokes. The list also carries applicable
site-scoped runners, read-only and per-viewer redacted — the shape is under
"Site-scoped runners" below — and `DELETE` on one of those is `403`, naming the
site route: a machine serving every project is not one project's to retire.
Revocation is a timestamp, not a delete:
the row and its history remain, future check-ins, claims and exchanges are
refused, and a group already exchanged finishes under its already-issued scoped
bearer — including its heartbeats, which the claim board keeps answering for the
dispatch that runner already holds (see the claim board below). Revoking twice
is a no-op. Registration, revocation, and every claim write audit rows. Runner
names are unique among a project's **live** runners: revoking one frees its name,
because "register it again" is the console's own remedy for a credential nobody
wrote down, and a second standing runner under that name is the `409`.

**Ephemeral CI runners.** `POST /runner/pool/register-oidc` is the second way to
join a project's pool: a CI job presents its GitHub Actions OIDC token instead of
a credential it was given in advance, and receives one that expires with the job.
No long-lived runner secret lands in repository settings.

- The token is judged against the deployment's own pins — issuer, audience,
  repository, workflow file, ref, expiry, signature against the issuer's JWKS.
  This is the ONLY place the platform trusts a GitHub identity, so every pin is
  its own variable (`PLAYTEST_POOL_OIDC_REPOSITORY`, `…_WORKFLOW`, `…_REF`,
  `…_AUDIENCE`, `…_ISSUER`) rather than inherited from anywhere.
- **The route is closed until a repository is pinned.** Without
  `PLAYTEST_POOL_OIDC_REPOSITORY` it answers `503 not_configured` naming the
  variable. Half-configuration is a `ServerConfigError` at boot: a workflow or
  ref pin without a repository pin. The pin is deployment-wide, so a deployment
  hosting projects for mutually untrusting teams leaves it unset until
  per-project pins exist.
- The registration is **ephemeral**: `expires_at` is `now + PLAYTEST_POOL_OIDC_TTL_S`
  (default 3600, floor 60, ceiling 21600 — GitHub's own per-job limit, because a
  credential outliving its job is a credential nobody is watching). An expired
  credential is refused at poll, claim and exchange exactly like a revoked one,
  with its own message. Expiry never interrupts work in flight: an exchanged
  group runs on under its already-issued scoped bearer, and keeps heartbeating
  its claim. An expired registration is also excluded from the unclaimed-timeout
  diagnostic below, because it is invisible in Settings and cannot be restarted —
  naming it would send a reader after a machine that no longer exists.
- Ephemeral runners are **never listed as standing runners** —
  `GET /api/v1/projects/:p/runners` and the console's Runners section exclude
  them. They are pipeline scaffolding, not fleet.
- The runner's **name comes from the verified token**
  (`ci-<run_id>.<run_attempt>-<random>`), never from the request, so a CI job
  cannot register under a standing runner's name. The verified claims
  (repository, workflow ref, ref, sha, run id and attempt) are stored on the row
  and written to the audit row, whose actor is `{"system": "github_oidc"}` and
  whose detail is flagged `ephemeral: true`.
- One workflow run may hold at most 8 live ephemeral registrations in a project;
  the ninth is `409 conflict`. An OIDC token is replayable for its own short
  lifetime, so a leaked one must not be able to fill the table.

The CI recipe this enables — build, start the app on localhost, register with the
job's OIDC token under a label unique to the pipeline run, launch pinned to that
label, wait for the verdict — is written out in
[`docs/guidance/hosted-runners.md`](../guidance/hosted-runners.md) with a copyable workflow under
`examples/ci-github-actions/`. The unique label is load-bearing, not cosmetic:
two concurrent pull requests sharing one label would claim each other's jobs and
report green against the wrong build.

**The claim board.** A `requested` dispatch row plus its labels and target
snapshots IS the board entry; posting to the board performs no network call and
writes no new entity. Both snapshots are written in the same transaction as the
ledger row, so an entry is never readable before what places it is durable. The
three runner-credential-authenticated routes are:

1. `GET /runner/pool/claims?wait=true[&labels=…][&skip=…]` — check in and
   long-poll. The answer is a **bounded page** (8) of the oldest unclaimed
   dispatches in the runner's scope whose label set is a subset of the
   runner's, of kind `group` **or** `mint` (session minting places through the
   same path and must be served), oldest first. An empty job label set matches
   any runner in scope. Held reads follow the event feed's discipline:
   post-commit wake, bounded rescan, correctness from the durable row. The poll
   only offers; two runners woken by one signal both see it. A runner that
   already holds a claim is offered nothing (`offers: []`) and is handed that
   claim back as `current` instead, which is how an agent restarted mid-group
   finds its work.

   A page rather than one offer, because compatibility is not all server-side:
   labels are, but "does this runner hold a binding for `todo-ios/local`?" is a
   fact only the runner knows. With a single-offer board one unclaimable job at
   the head would starve every newer job for every runner. The runner claims the
   first entry it can.
2. `POST /runner/pool/claims/:dispatch` — claim it. One `BEGIN IMMEDIATE`
   transaction restates the whole precondition in the mutating `WHERE` (still
   `requested`, still unclaimed, not canceled, runner live and in scope for this
   dispatch's project, labels still a subset), so exactly one concurrent runner wins and the loser
   receives `409 conflict` and returns to polling. The winning claim stamps the
   runner, moves the dispatch to `scheduled`, flips the group to running, and
   emits the `run.status` provisioning event.
3. `POST /runner/pool/claims/:dispatch/heartbeat` — coarse group-level liveness
   between claim and completion, on the order of tens of seconds. Case-level
   telemetry remains the progress route. Only the claim holder may heartbeat it,
   and that — not the credential's standing — is the authorization: this is the
   one runner-credential route that answers a **revoked or expired** credential,
   because a group already exchanged must be able to finish and it cannot finish
   with its liveness channel closed under it. (Refusing here broke that promise
   twice: the agent reads any 4xx on a heartbeat as "this claim is no longer
   mine" and tears the run down, and a stale `heartbeat_at` has the reconciler
   fail the group as a dead executor.) Poll, claim and exchange keep refusing
   both, so a revoked runner gains no new work and no new scoped bearer. The
   heartbeat still stamps `last_seen_at`, which is simply true — the machine is
   here, finishing what it was given — and cannot mislead, because the console
   reads revoked and expired ahead of presence.

**Presence is an edge on the feed, never a poll.** Every poll and every
heartbeat stamps `runners.last_seen_at`, which is far too often to publish: a
fleet of ten idle runners would emit an event every two and a half seconds
forever. So the feed carries only what a reader sees CHANGE, as
`runner.status` events with `entity.runner_id` and a payload naming the runner
and its `state`:

- `registered` and `revoked` — the registry moved;
- `online` — a runner that was absent (never seen, or silent past the window
  below) has checked in, or has re-advertised its labels, which the payload
  then carries;
- `claimed` — it took a dispatch, with `dispatch_id` and `run_group_id`.

A runner that simply keeps polling emits nothing, and a runner going quiet
emits nothing either, because both are derivable: whether a runner counts as
present is arithmetic on `last_seen_at` against
`capabilities.runner_check_in_window_s` from `GET /api/v1/me` — the same
silence at which the board itself stops believing in a claim, floored so
an idle runner may miss two of its 25-second polls. Publishing that number is
what keeps a console's presence dot and the reconciler's patience the same
fact. A console therefore refetches the runner list when a `runner.status` (or
a `run.status`, which is how a claim ENDS) event lands, and re-reads the clock
in between without asking the server anything.

**The offer.** Every entry on the page — and `current` — has this shape, and it
is contractual: no platform-managed record may carry a runner-resolved physical
fact, so the target block holds exactly these seven fields and nothing else.

```json
{
  "dispatch_id": "…", "kind": "group" | "mint", "ref_id": "…",
  "run_group_id": "…" | null, "mint_claim_id": "…" | null,
  "attempt": 1, "labels": [], "requested_at": "…Z", "claimed_at": null,
  "project_id": "…", "project_key": "acme",
  "target": {
    "application_id": "app_…", "application_key": "todo-web",
    "ring_id": "ring_…",       "ring_key": "local",
    "driver": "web" | "api" | "mobile", "platform": "ios" | "android" | null,
    "base_url": "http://127.0.0.1:4173" | null
  } | null
}
```

The project rides the ENVELOPE, not the target, because a runner needs it on
every offer — including a project-wide mint, which has no target at all.
`target` is the attempt's own snapshot, so a ring edited between poll, claim and
exchange cannot make the offer and the group spec disagree. It is null for a
mint whose auth provider is project-wide (null `ring_id`); a ring-bound
provider's mint carries the ring's labels and its target block, exactly as a run
group does. No suite files and no secrets travel before the claim, and mint
compatibility is labels only — no binding is required to claim one.

**`skip` is how a runner declines locally.** A runner that can take nothing on a
page re-polls naming those dispatch ids in `skip` (comma-separated, at most 64 —
more is `400`, because past that many unclaimable offers the runner should back
off rather than keep asking). The server excludes them, which means the
long-poll **holds when nothing else remains** instead of returning the same page
for the agent to re-poll against in a tight loop. The list is session-local,
never persisted, and carries no reason: the advertisement itself is never
mutated, so a capable runner claims those entries unaffected. The agent clears
its list whenever a long-poll comes back empty, so an incompatibility that was
transient is reconsidered without restarting it.

Delivery order is oldest-first per project; v1 makes no stronger fairness
promise, and beyond the skip cap the residual delay of newer work is accepted —
ring `runner_labels` remain the primary routing tool. One runner executes one
group at a time: holding an active claim is part of the claim precondition, so a
runner cannot take a second job and starve the fleet, while re-claiming the job
it already holds is idempotent.

**Claiming assigns, exchanging authorizes.** A credential alone resolves no
dispatch, so it can never fetch a snapshot, a blob, a session grant, or post a
report. After winning a claim the runner enters the protocol at
`POST /runner/exchange` with its credential and `dispatch_id`, and receives the
short-lived bearer scoped to that one run group or mint claim. A runner that did
not claim a dispatch cannot exchange for it. That boundary is the whole security
model, and it has no development bypass: there is no insecure exchange to
enable, under any auth mode.

**Liveness and loss.** The board reports claim and heartbeat state as run
status, which is what the reconciler reads to tell a slow runner from a gone
one. It has two loss shapes:

- **Claimed but heartbeat-stale** beyond `PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S`
  (default 120) is a dead executor: unreported work becomes infrastructure
  failure and the queued remainder is re-dispatched once, bounded, unchanged.
- **Never claimed** within `PLAYTEST_POOL_CLAIM_TIMEOUT_S` (default 600) fails
  the group instead, because re-posting to a board no runner is watching would
  fail identically. The failure names what nothing checked in to serve ("no
  runner with the label `jeremys-mac` has checked in for 10 minutes…") together
  with the remedy, and that message lands on the stories that never ran, not
  only in a log.

Cancellation marks the claim canceled; the runner observes it at its next
heartbeat and runs the same teardown a SIGTERM triggers, since nothing can call
it. Case reports for already-finished cases remain accepted.

**Isolation is stated, not laundered.** A developer laptop is process isolation,
which this contract already allows for local development and fresh ephemeral
machines; a persistent shared runner requires per-case containers and reports
what it used, so a reviewer can see what produced the evidence. The runner sends
its real mode on the exchange (`isolation`), the control plane records it on the
executor, and a run group states its placement: `placement` on
`GET /api/v1/run-groups/:id` carries the newest attempt's `dispatch_id`,
`attempt`, the `isolation` its executor reported, the `runner` that claimed it,
and the `labels` that attempt was placed on with their `labels_source`
(`launch` when the launch pinned them, `ring` otherwise).

### Site-scoped runners

Runner scope is a **trust** decision, not a capability one: a claiming runner
receives suite files and secrets and executes suite hooks, so which projects may
reach a machine is stated, never inferred. Project scope is the default and the
only scope a project developer can grant. A **site-scoped runner** is one
`runners` row with a null `project_id` — a machine a site operator deliberately
trusted with every project's work. v1 site scope means "all projects";
per-project grants are deferred.

- **It is one board across every project.** The poll is not narrowed by project;
  every offer names its own project on the envelope, which is the only way such
  a runner can tell them apart. Long-poll wakes are keyed per project, so an
  idle cross-project poll falls back to the held read's existing one-second
  rescan rather than a multi-project waker — an accepted, bounded latency.
- **Scope is not authority.** The exchanged bearer is scoped to the claimed
  dispatch's run group or mint claim exactly like any other, so a site runner
  executing project A's group cannot read project B's. One active claim,
  globally: holding project A's group is what stops it taking project B's.
- **Names are unique among live site runners**, enforced by a partial unique
  index over `project_id IS NULL AND revoked_at IS NULL`. The project index
  cannot do that job — SQLite treats every NULL project as distinct — and the
  two namespaces are separate, so a project may name a runner `build-box` while
  a site runner is also called `build-box`.
- **Revocation is a site act with project-runner semantics**: future polls,
  claims and exchanges are refused in every project at once, while a group
  already exchanged finishes under the bearer it holds, heartbeats included.
- **It counts as presence for every project it can serve.** The launch
  preview's `placement.runner_online` and the unclaimed-timeout diagnostic both
  include site runners; saying "this project has no runner registered" while a
  shared machine is polling would send a reader to register one they do not
  need.

**Lifecycle API.** Three routes, above any project's URL space, gated to a
**site-admin principal** and writing audit rows with no `project_id`:

| Route | Meaning |
|---|---|
| `POST /api/v1/site/runners` `{name, labels?}` | Register; `201` with the one-time `credential`. A live duplicate name is `409`. |
| `GET /api/v1/site/runners` | List, each with its claim and that claim's `claim_project_key` — the site operator is the one reader who sees claims unredacted. |
| `DELETE /api/v1/site/runners/:r` | Revoke. Idempotent: revoking twice is `204`. |

The site-admin principal is the `PLAYTEST_AUTH=dev` admin bypass and nothing
else. A project `admin` is deliberately insufficient — a site runner would
receive OTHER projects' secrets — and site-scoped API tokens remain reserved for
a later ops flow, so a non-dev deployment answers `403` naming that and simply
has no site runners. Console CRUD, per-project grants, and production
site-admin provisioning are the deferred runner-trust follow-up.

**The projection is tenant-shaped.** `GET /api/v1/projects/:p/runners` lists a
project's own runners and every live site runner, each carrying:

```jsonc
{
  "id": "…", "project_id": null,      // null for a site runner
  "scope": "site" | "project",
  "managed_here": false,               // a project cannot revoke a site runner
  "name": "local", "labels": [], "ephemeral": false,
  "created_at": "…Z", "last_seen_at": "…Z", "revoked_at": null, "expires_at": null,
  "claim": {
    "foreign": true,                   // the claim belongs to another project
    "dispatch_id": null, "kind": null, "run_group_id": null, "mint_claim_id": null,
    "claimed_at": "…Z", "heartbeat_at": "…Z"
  }
}
```

A claim belonging to another project reads as busy and nothing more: `foreign`
is true and every identifier is null, while `claimed_at`/`heartbeat_at` remain
because they describe the machine's liveness, not the other tenant's work. The
keys do not change shape between the two cases, so no reader needs a branch and
no branch can forget to redact one. Revoked site runners are omitted from a
project's list entirely — a project can neither act on one nor learn from it.

**Events.** A `platform_events` row requires a project, so site-runner presence
and registry edges (`registered`, `revoked`, `online`) fan out **one event per
project** at emit time; they are rare and edge-triggered, so the cost is
bounded. A `claimed` event is addressed to the claimed dispatch's project ALONE,
because its payload names a dispatch and a run group. Every `runner.status`
payload carries `scope`.

### The dev peer runner

Under `PLAYTEST_AUTH=dev` the control plane ensures, at boot, one site-scoped
runner named `local` and writes its credential to
`$PLAYTEST_DATA_DIR/local-runner.credential` with mode `0600`. This is a
registration, not a process: the control plane still starts nothing and connects
to nothing. `scripts/hosted-server.sh` starts `runner-agent pool` against that
credential file beside the server, restarts it if it stops, and stops it when
the server stops; the agent's existing backoff covers boot order, and the
credential file is written whole through a rename so a concurrent reader never
sees half a value.

The ensure is **idempotent**: a second boot reuses the same runner row and the
same credential. Only a hash is stored, so a credential file that no longer
matches its row cannot be recovered — boot re-issues one on the same row, which
keeps the runner's identity and history and kills the old value. The script also
seeds `$PLAYTEST_DATA_DIR/runner.yaml` when absent — the runner configuration
schema, commented out — and starts the agent with `--config` pointing at it. Web
and API runs need nothing in it (an all-comments file is a valid empty
configuration); uncommenting it is the whole of mobile setup
([Interfaces](interfaces.md#runner-configuration-file)).

The result is that `npm run hosted` gives launch-to-verdict web and API runs with
zero runner ceremony, over exactly the placement path CI and a fleet use.

### The pool runner process

`runner-agent pool --server <url> [--labels a,b] [--isolation process|container]
[--work-dir <dir>] [--credential-file <path>] [--config <path>]` is the
long-lived agent, and the
package's ONLY entry point (`docs/contracts/interfaces.md`). Its loop is check
in → long-poll → claim → exchange → execute through the group or mint executor →
complete → poll again.

- **The credential never rides argv.** It arrives in `PLAYTEST_RUNNER_CREDENTIAL`
  or in a file named by `--credential-file` / `PLAYTEST_RUNNER_CREDENTIAL_FILE`,
  so it cannot be read out of a process list. Offering it as an argument is
  refused with the remedy.
- **The first check-in does not hold**, so a misconfigured runner is diagnosable
  at once: startup output states the runner name, its scope (its project, or
  "every project on this deployment"), server, labels, isolation, work
  directory, and that it is waiting for work. The poll answer's `runner` object
  carries `{id, name, labels, scope, project_id, project_key}` and is where that
  scope comes from. Later check-ins long-poll.
- **A refused credential stops the process** with one actionable line (401/403 —
  unknown, or revoked). Any other failure to reach the control plane is retried
  with exponential backoff and jitter, reported once per outage rather than once
  per attempt. A lost claim race (`409`) is not an error and is not backed off.
- **One group at a time**, and a runner restarted mid-group resumes the claim the
  board still says it holds instead of abandoning it.
- **It claims the first offer on the page it can execute.** Anything it cannot —
  a driver it does not run, or a mobile target its configuration file does not
  bind ([Interfaces](interfaces.md#claim-compatibility)) — is skipped LOCALLY:
  one deduplicated, actionable reason
  in its own log, the dispatch ids named in the next poll's `skip` list, and
  nothing else sent. It clears that list whenever a long-poll comes back empty,
  and past the skip cap it backs off explicitly rather than re-polling in a
  tight loop.
- **Cancellation and shutdown share one path.** A `canceled` heartbeat aborts the
  group exactly as `SIGTERM` does: stop starting cases, stop what is in flight,
  report what exists, post a best-effort completion. `SIGTERM` while idle exits
  immediately; `SIGTERM` mid-group finishes that teardown first, then exits.
- **A failed group never takes the runner down.** The executor posts its own
  completion carrying the error; the agent reports one actionable line — never a
  stack — and returns to the board.

## Rule cards

Level 1 of the invariant ladder
([Script contracts: invariant levels](scripts.md#invariant-levels)) as hosted
state and a review surface. Level 0 has no storage and no switch: the four
default policies are code, always on, and reported here read-only so a person
can see what their suite is judged against before deciding anything.

The surface presents assisted authoring: *"review and confirm your API's
rules"*. It never claims the platform discovered authoritative rules.

### Storage

One row per card in `rule_cards`, suite-scoped:

| Column | Meaning |
|---|---|
| `rule_id` | the obligation slug — `rule:<rule_id>` is what the handout, the manifest, and every report entry key off. Unique per suite and **immutable**: an edit never re-slugs a card, because a slug that moved would orphan an authored check |
| `state` | `candidate` \| `approved` \| `denied` |
| `origin` | `proposed` (a model wrote the sentence) \| `authored` (a person did) |
| `statement`, `title`, `applicability`, `exceptions` | the card, in the handout's own shape |
| `provenance` | one line of what the model read. It never travels into a handout |
| `note` | the owner's steering, rendered beside the rule as **Owner's note** |
| `proposed_statement` | what the model originally said, kept when a person edits the sentence |
| `decided_by`, `decided_at` | the human behind the current state. Never set for a `candidate` |

### Governance

**Only human-approved sentences are enforced.**
`approvedRuleCards(db, suiteId)` is the only path from this table to an
authoring handout; its predicate is
`state = 'approved'`, and it returns its rows through the engine's
`approvedCardRules`, which filters again in its own body. Two independent
filters: breaking one leaves the other.

Three consequences the API must preserve:

- **A model cannot mint an approved rule.** The proposal endpoint writes
  `candidate` rows only, whatever the reply claimed, and `decided_by` is stamped
  from an authenticated principal.
- **A denial is memory, not a delete.** A denied row stays: its sentence goes
  into the next proposal prompt as a rule not to raise again, *and* the reply is
  filtered against the denied ids, so a model that ignores the instruction still
  cannot put the card back in front of the owner. A proposed card is therefore
  denied, never deleted; only an `authored` card can be removed.
- **Editing is not approving.** An edited candidate is still a candidate.

### The endpoints

| Route | Role | Notes |
|---|---|---|
| `GET /suites/:s/rule-cards` | viewer | the Level 0 set, every card, counts, and whether this deployment can propose |
| `GET /suites/:s/rule-cards/handout` | viewer | the approved statements in the core authoring-handout shape |
| `POST /suites/:s/rule-cards/propose` | editor | the model call; drafting, so it is an editor act |
| `POST /suites/:s/rule-cards` | reviewer | add-your-own: a sentence a person wrote lands `approved`, because writing it is approving it |
| `PATCH /rule-cards/:rc` | reviewer | statement, applicability, exceptions, note |
| `POST /rule-cards/:rc/approve` \| `/deny` | reviewer | the state change, with an optional note in the same call |
| `DELETE /rule-cards/:rc` | reviewer | `authored` cards only; a proposed card is denied |

Every mutation writes its audit row and its `rule_card.*` platform event inside
the same transaction, and the console repaints off the feed — no polling.

The proposal call takes the OpenAPI document as an upload or paste. The control
plane does not fetch a spec URL or auto-discover one. A deployment without the
LLM gateway answers `503 not_configured`; the console still offers
write-your-own.

## Model selection

Which model plays the actor and which grades resolves per key, most specific
wins, and never inside platform code:

1. the case file;
2. the suite's `playtest.yaml` chain (nearest file wins — core's ordinary
   defaults merge);
3. the project's model defaults (`projects.models`);
4. the engine's built-in defaults.

The project record stores at most `actor_model`, `grader_model`, and
`consolidation_model`, set with `PUT /api/v1/projects/:p/models` (admin — a
project-wide cost/quality policy).
Each value is a short tier enum or a fully-qualified gateway model name, the
same vocabulary `playtest.yaml` accepts, passed through verbatim. The update
merges per key: an omitted key keeps its stored value, `null` or `""` clears
exactly the key it names, and the change audits as `project.models_set`. Every
project view carries `models`.

The platform applies step 3 in exactly one place: the group spec carries
`project.models`, and the runner workspace fills only **unset** top-level
`actor_model`/`grader_model` keys of the materialized suite's `playtest.yaml`
before core resolves the tree. There stays one resolver, a suite that chose can
never be overridden, and the run's manifest pins record what each run actually
used.

`GET /api/v1/models` reports the deployment's shipped tier enums and the
engine's built-in defaults — suggestions for settings forms, never validation.
The launch preview's `models` block states the effective value and source
(`suite` | `project` | `default`) per key, mirroring `target`'s
say-the-resolution-out-loud rule; a case-level override still wins at run time
and is visible in that run's pins.
Its history-based cost estimate groups finished runs by the manifest's actual
mode (falling back to the planned database mode for legacy rows), so a replay
that escalated to a heal does not inflate the next clean replay estimate.

Control-plane LLM jobs split: authoring and synthesis remain deployment-level
operator configuration (`PLAYTEST_*_MODEL` env), unaffected by project or
suite settings. Consolidation — which also runs automatically per project
(auto-dedupe) — resolves per project: `projects.models.consolidation_model`,
else `PLAYTEST_CONSOLIDATION_MODEL`, else the `gpt5_6_terra` tier. The plan
row records the model actually used.

## Run concurrency

Hosted run-group concurrency resolves once, with the suite replacing the
project policy:

1. `parallel` from the suite's pinned `playtest.yaml`, when present;
2. the project's `projects.parallel` value;
3. `{ total: 1, record: 1 }` for projects created before or without a policy.

`PUT /api/v1/projects/:p/parallel` is admin-only and accepts concrete positive
integers `{ total, record }`, with `record <= total`. Every project view carries
that policy. Core's full suite vocabulary remains valid, including `true` and
the scalar form; the project API stays concrete because it is the platform's
capacity and cost default.

The runner group spec carries the project fallback as `parallel`. After
materializing the pinned snapshot, the executor discovers the suite through
core, selects the suite's non-null `parallel` value when one exists, and runs
the cases through core's single worker-pool scheduler. `total` caps every story
in flight; `record` caps stories driving the actor, while baseline checks fill
unused workers. The executor preserves input order in its completion summary,
starts workers with core's rate-limit stagger, and remains serial when no
setting opts into concurrency. Process-isolated local execution reference-counts
the shared ring overlay so one concurrent case cannot restore it while
another is still running; persistent runners keep per-case container isolation.

## Applications, rings, secrets, and target authentication

The console talks about **applications**; runner setup is an operational task
documented separately (`docs/guidance/hosted-runners.md`).

An **application** is one executable test surface: `driver` is `web`, `api`, or
`mobile`, and a mobile application additionally names `platform` (`ios` or
`android`) because core has to choose XCUITest or UiAutomator2 from it. `Todo
Web` and `Todo iOS` are two applications even when a person thinks of them as
one product. `key` is unique within the project and immutable, as are `driver`
and `platform`, a ring's application, and a suite's binding: runner
configuration and run evidence address these by key, so a rename would silently
rebind a machine. Names are editable. v1 has no rebind and no migrate, so
delete-and-recreate is the stated remedy for a mistyped key — with one stated
consequence, that a runner configuration still naming the old key binds the
recreated entity.

A **ring** is an application-owned deployment target — `local`, `staging`,
`prod` — holding a URL, routing labels, a discovery flag, and a logical overlay:

```json
{
  "id": "ring_…",
  "application_id": "app_…",
  "key": "local",
  "name": "Local",
  "base_url": "http://127.0.0.1:4173",
  "runner_labels": [],
  "discovery_allowed": true,
  "config": {}
}
```

`key` is unique within its application and immutable, so every application may
have its own `local`. `base_url` is **required for web/API rings and refused for
mobile ones**, and it is evaluated **from the claiming runner's network
position**: a loopback URL means "on the runner's own machine", and
`runner_labels` are how such a ring is routed to a machine that can reach it.

`config` is the LOGICAL overlay and nothing else — auth identities and defaults,
`secret_env`, cookies, headers, settle, viewport, setup inputs — materialized by
the runner as `app.envs.<ring key>`. It is validated against an **allowlist** at
the two positions core reads (`config.app` and `config.auth`), which is what
makes the five physical fields — `base_url`, `app`, `platform`, `device`,
`appium_url` — unrepresentable exactly where they would take effect. A
property-name blacklist applied at every depth would be the wrong tool twice
over: it would reject the logical `app` container itself, and it would reject
legitimate data that merely happens to be named `device` — an auth identity, a
`secret_env` variable. Those are untouched. `config.app.compose` is refused too,
because hosted execution clears it and an authored compose block must not be
able to boot a different application under the ring's name.

A mobile ring therefore holds no URL, no build path, no device, and no Appium
endpoint. Those are machine-local facts read from the claiming runner's own
configuration file, keyed by immutable `(application key, ring key)`; no
platform-managed record stores, serves, or displays them. Verbatim authored
suite source is the one stated exception — suite files are stored and exported
as written for CLI use, and hosted execution provably ignores their physical
fields.

CRUD is `developer`; reads are `viewer`:

```text
GET    /api/v1/projects/:p/applications[?include=rings]
POST   /api/v1/projects/:p/applications      {key, name, driver, platform?}
GET    /api/v1/applications/:a[?include=rings]
PUT    /api/v1/applications/:a               {name}
DELETE /api/v1/applications/:a
GET    /api/v1/applications/:a/rings
POST   /api/v1/applications/:a/rings         {key, name?, base_url?, runner_labels?, discovery_allowed?, config?}
PUT    /api/v1/rings/:r
DELETE /api/v1/rings/:r
```

`PUT /rings/:r` merges: an omitted field keeps its stored value, so a partial
`{discovery_allowed: true}` can never wipe the overlay, the URL, or the labels.

Deletion is **refuse-not-cascade**, and every refusal names the referrers. An
application is deletable only when it has no rings, no suites, and no run
groups; a ring only when no run group and no auth provider reference it.
Nothing an application owns is removed as a side effect of deleting it: rings
carry credentials and run groups are evidence. The database backs each refusal
with `ON DELETE RESTRICT` — including `auth_providers.ring_id`, which is
deliberately never `SET NULL`, since silently promoting a ring-bound provider to
project-wide would move secrets policy without anyone deciding it. Permanent
project deletion (`DELETE /api/v1/projects/:p`, `admin`) is the one operation
that removes everything, and it spells the order out explicitly rather than
relying on a cascade that is not there.

A new project starts with **no** application. What a suite runs against is a
decision — "this web app, at this URL" — and the platform cannot guess it, so
creating the first application is the first step of the first-run path rather
than a hidden default that quietly resolves to whatever a suite happened to
author. A first web run is: create the application, create ring `local` with its
URL, launch. No runner file is touched.

No hosted route accepts or serves application bytes. There is no app-artifact
upload, no `run_groups.app_artifact` pin, no `GET /runner/artifacts/:sha256`,
and no size cap to configure: a mobile build lives on the runner that will
install it, and in a real deployment comes from an internal artifactory through
a runner-side provider the platform never sees.

A mobile launch is posted to the claim board exactly like a web or API one. Its
offer and its group spec carry the same target block — `base_url` null,
`platform` set — and the build, the device and the Appium endpoint are supplied
by whichever runner claims it, from that runner's own configuration file
([Runner configuration file](interfaces.md#runner-configuration-file)). A runner
holding no binding for the offered `(application key, ring key)` skips the offer
locally and another runner claims it unaffected; when nothing binds it, the group
ends with the ordinary unclaimed-timeout diagnostic naming the labels it waited
on. The launch preview for a mobile ring reports no URL and
`build_supplied_by_runner: true`; nothing in the hosted path ever claims the
platform inspected a binary or a device.

Secret values are encrypted at rest and write-only through the API. The root
encryption key is external to the database. Losing it makes stored secrets and
minted sessions unreadable; changing it does not re-encrypt existing values.

Auth providers have three supported forms:

- `storage_state_secret` reads an existing Playwright storage-state secret.
- `token_endpoint` exchanges provider credentials for a session.
- `script` executes trusted login code in runner isolation.

A provider carries a nullable `ring_id`. Null keeps it **project-wide**: every
ring may reference it, and its standalone mints ride the board with empty
labels. A bound provider is reachable **only from that ring**, and its mints
carry the ring's labels. Resolving a ring's session references accepts a
provider only when its `ring_id` is null or that exact ring, so one ring can
never borrow another ring's credentials by naming it in its own
`auth.identities`; the refusal is per-identity, like every other mint failure.
A provider may bind only a ring of its own project.

Session artifacts are encrypted, expiring, and cached per provider and
identity. Concurrent requests for the same missing session share one pending
mint. Stories select identities with core `app.auth`; `auth: none` always means
signed out and cannot be replaced by a ring's default identity.

Setup scripts and hooks receive only explicitly delivered secret environment
variables or secret files. Suite files cannot shadow the platform-managed
secret directory.

## Personas

A project keeps a table of personas — `{ name, description }` prose a story
selects with `persona: <slug>`, the same field a suite-local
`personas/<slug>.yaml` file answers. Built-ins (`tester`, `exploratory`,
`adversarial`) always list first and cannot be created, renamed, or deleted;
a project persona's `slug` is immutable once created, since stories reference
it by slug the same way a file does. `editor` is the role for all persona
routes: authoring a persona is authoring, not infrastructure.

Each write renders the persona's `{ name, description }` as YAML and stores it
as a content-addressed blob, identical in shape to a suite-committed
`personas/<slug>.yaml` file. `GET /runner/snapshots/:id/tree` merges a
project's persona blobs into the snapshot tree at READ time — the runner sees
`personas/<slug>.yaml` for every project persona alongside the snapshot's own
files, with the snapshot's own files winning on a slug collision. The merge
happens at read time rather than at commit time because a snapshot is
immutable: baking persona prose in at commit would freeze it as of whichever
commit happened to precede it, and an edit made on the Personas page would
never reach the next run without a pointless re-commit of every suite in the
project. The trade-off is real: a run is reproducible in its stories (the
pinned snapshot) but not in its project persona prose, which keeps changing
underneath old snapshots. A suite that needs a persona pinned commits its own
`personas/<slug>.yaml` to shadow the project one.

## Bundles, viewer, and review

The `.ptrun` format and `BundleProvider` behavior are defined in the artifact
contract. The hosted viewer uses the same static application and viewer URL
contract as local runs. Project-scoped adapter routes translate database
projections and bundle entries without changing viewer semantics.

The console embeds it with `embed=1`, and passes its own palette through
`theme=` whenever a theme is explicitly chosen (with none chosen both sides fall
back to `prefers-color-scheme` and already agree). Toggling the console theme
re-points any mounted viewer iframe. Under `embed=1` the viewer suppresses its
CLI accept instruction: the host owns Accept and Reject, and telling a web user
to run `playtest baseline accept` below a button that does exactly that is
viewer copy leaking into the hosted context.

Optional sibling artifacts such as generated clips do not mutate the sealed
bundle. When a sibling artifact exists it takes precedence for its specific view
while the original bundle remains available and verifiable.

**Export clip** is one run action. A client GETs an existing clip and downloads
it; on not-found it POSTs generation with standard action captions and burned
overlays, shows durable progress, reacts to the `clip.created` event, and then
downloads (or leaves a Download clip action where automatic download is
blocked). Generation is idempotent: repeated requests while one is in flight
join the existing generation rather than starting a second. A pruned full bundle
or a server without the required media tools returns an actionable error.
Advanced caption/burn options remain available on the API for non-UI clients.
Re-grade is not a hosted product action or API; stored evidence is reprocessed,
if ever, only by an offline maintenance command.

A healed run creates a pending candidate containing the proposed trajectory,
source run, pinned story hash, baseline version, and shared `diffTracks`
summary. Acceptance requires:

- reviewer authorization;
- a still-pending candidate;
- matching suite, story, source run, and current baseline lineage;
- a passing source run;
- verified bundle integrity.

Acceptance creates a new baseline version and supersedes other pending
candidates for the same story. Rejection leaves the baseline unchanged.
Concurrent or stale decisions fail visibly rather than silently winning.

A later clean pass for the same story — a passing run that neither healed nor
changed and wrote no baseline or candidate — also supersedes the story's
pending candidates: it proves the current baseline still replays, so accepting
an older healed trajectory would regress the baseline. A fresh recording
supersedes the same way. Both emit `candidate.superseded`.

### Live runs

**A run may be viewer-visible before its bundle exists.** From its `open` call
until its case report lands, an open run serves `manifest.json`,
`trajectory.jsonl` and the step artifacts that have arrived, and the viewer
streams them through the [`live` route](interfaces.md#live-runs). This changes
nothing about the seal: **the sealed `.ptrun` and the case report are byte-for-byte
what they were**, they remain the sole authoritative artifact, and verdicts,
retention decisions, review and export never read live state. No live failure
may change a run's status, ordering, timing, or sealed artifacts.

A run is **open** exactly while `live_opened_at` is set and its status is still
non-terminal (`queued`, `running`, `uploading`). Openness is explicit state and
is never inferred from manifest contents: the placeholder manifest carries a
terminal-looking status from the first instant of a case. The reconciler failing
a run ends openness the same way a report does.

Staged state has **two shapes, split by transactionality** — the metadata store
and the object store cannot share a transaction, so each side holds what it is
good at:

- **Trajectory batches and the manifest snapshot live in the metadata store**,
  the line text in the row, keyed and ordered by line range beside the
  authoritative line count. Accepting a batch is one transaction, reading is one
  indexed query, cleanup is a delete, and the highest-frequency write path has no
  object-ownership question at all.
- **Step artifacts live in the object store** behind a **two-phase ledger row**:
  reserve `pending` (budget charged, key and hash recorded) → write the object →
  mark `ready`. Readers serve `ready` only. Retention treats *both* states as
  owned, so the orphan sweep — which deletes every unowned `runs/`-prefixed
  object in the same cycle — never sees a window in which a live object is
  unowned. A crash between the reservation and `ready` leaves a `pending` row
  that garbage collection reaps on the grace schedule, refunding its reservation.

Staged bytes are budget-accounted per run against a deployment ceiling
(`PLAYTEST_LIVE_BUDGET_MB`, default and maximum 512 — the sealed bundle limit,
because staging must never cost more than the bundle it precedes). Exhausting it
is a refusal ack, not a silent drop. Per-entry, per-body and per-line caps bound
one request each.

Entry precedence for a run becomes **sibling artifact → sealed bundle entry →
staged live entry**. The existing sibling-over-bundle order is unchanged, so a
generated clip still wins over the bundled original; staging is only the final
rung. Two entries are *virtual* for a staged run because their source is a row
rather than an object: `manifest.json` from the run row (so the viewer's first
fetch works the moment the run opens) and `trajectory.jsonl` as the ordered
concatenation of the ledger's batches, in append order. A sealed run serves
exactly what it always did, byte for byte.

Picker projection follows the additive wire shape in
[interfaces.md](interfaces.md#live-runs): an open run projects `status: null`
plus `open: true`, never the placeholder's `interrupted`, and a sealed entry
carries no `open` key. Open runs are excluded from `/history.json` and
`/changed.json` until they seal — a half-recorded run is neither history nor a
review item — and completed-run projections are untouched.

**Staging is deleted only when a verified sealed bundle exists.** On the case
report that follows a successful bundle upload, the ledger rows go in the report
transaction and the staged objects immediately after it commits; a failed object
delete leaves an object with no owning row, which the orphan sweep collects. A
terminal report *without* a bundle — the runner reports `infra` when the bundle
upload itself fails, and the reconciler fails runs whose runner died — keeps its
staging through the retention grace window, because staging is then the only
evidence the run produced.

## Events and long polling

State changes write platform events transactionally with their owning database
mutation, so events cannot be published before their state commits.

The browser feed returns ordered events plus a durable cursor. A client resumes
from the last processed cursor after reloads, disconnects, or server restarts.
Held reads end within the configured hold window and release promptly when the
client disconnects.

A cursor belongs to its event-type filter. A client that broadens `types=` must
start with an empty cursor; resuming a filtered cursor with a broader filter can
skip events that did not match the original subscription.

Delivery is at least once. Consumers must deduplicate by event id.

The committed event row is the only source of truth. A held read is woken by an
in-process post-commit signal, but that signal is a latency optimization: it is
delivered only after the emitting transaction commits, never after a rollback,
and a lost signal costs only the scan-fallback delay. Correctness always comes
from the cursor.

The signal holds no state a consumer depends on and is never replayed. It is
lost whenever there is no waiter to receive it — including for every event
committed between a client's read and its next subscription, and for every event
committed while the process is down. A held read therefore always re-scans on a
bounded interval as well as on the signal, and a consumer that receives no signal
at all still observes the whole stream.

**Restart behavior.** Event ids are process-generated ULIDs that increase
strictly, including across a backwards clock step, so a cursor is a durable
position in a totally ordered stream. Restarting the control plane discards every
waiter and pending signal and nothing else: a consumer that reconnects with the
last cursor it durably processed receives every event committed since — in id
order, once each — with no coordination, no replay request, and no dependence on
the consumer having been connected. Consumers must persist their cursor, not
their connection.

## Findings

Failed journey runs may create findings; infrastructure failures do not.
Deterministic fingerprints deduplicate repeated evidence within a project.
Rejected findings continue absorbing matching evidence without returning to
triage. A resolved finding that recurs returns to work, and the destination is
a confirmation question: a finding a person confirmed (accepted, or filed by a
reviewer) reopens — `reopened` is an alarm state — while an unconfirmed claim
returns to `new`, back to quiet triage (audit `finding.recurred`). Either way,
leaving `resolved` clears the resolution provenance columns; the audit log
keeps history.

The control-plane database is the system of record for these durable platform
findings, and the **finding is the only defect entity**: there is no separate
bug-candidate object, queue, or lifecycle. Machine-filed claims are findings in
state `new` — durable, cited, and unconfirmed. Actor raises remain
evidence/observations inside a run. The grader's structured issues enter
automatically: when a run's report lands, its `grade.json` `bug_candidates`
(a sealed artifact field name; on the platform they are claims like any other)
and its `minor`/`major` `findings` go through findings intake with source
`run_grade` (`info` observations stay run-scoped).

The human guarantee is a state guarantee, not an existence guarantee: nothing
reaches a **confirmed** state, rings an attention surface, or is handed to an
external tracker without a person acting. The guarantee governs what a machine
may **enter**, not what it may exit: auto-resolve (below) moves findings out
of alarm states on new run evidence, and its recurrence destinations ensure a
machine claim still cannot ring an alarm without a person having acted. A
`new` finding is machine output awaiting judgment, and every alarm-adjacent
projection (overview attention, per-suite open counts, the suite-page story
rows) counts only `accepted` and `reopened` findings, reporting `new`
separately as a quiet needs-review count. The per-suite health projection also
reports `fix_suggested` — open findings carrying a pending auto-resolve "looks
fixed" suggestion, the same derivation as the review tab's Looks-fixed queue —
so the suites table's counts and the tabs they link to always agree. (The
suite page's per-story rows keep their client-side story-health decoration: a
pass newer than the finding's last evidence on that story's own latest run.)
`GET /api/v1/projects/:p/findings/counts` (viewer) returns exact per-state
totals over live (unmerged) findings, plus `fix_suggested` — the number of
`reopened`/`accepted` findings carrying a pending "looks fixed" suggestion
(a `new` finding with one is already review work by state); the console folds
them into its bucket tallies so the Needs review and Open tabs carry true
counts rather than a capped page length. The findings list accepts
`?fix_suggested=1` to select findings with a pending suggestion. The project dashboard's finding lines ride
`GET /projects/:p/health` instead of a second findings round trip:
`major_findings` (the five newest confirmed — `accepted`/`reopened` — major
findings), `findings_needs_review` (the exact `new` count), and
`findings_fix_suggested` (the exact pending-suggestion count). The dashboard
renders both review queues as rows in the Needs-attention card alongside the
alarm rows, but in their own tones — muted for unvetted claims, calm for
looks-fixed suggestions — never an alarm tone: a machine claim still cannot
ring an alarm without a person having acted.

Findings are the only durable cross-run claim surface: there is no separate
Insight object, report page, or Markdown download. Semantic deduplication across
arbitrarily worded claims beyond the deterministic keys described below is not a
hosted guarantee.

### Findings intake

A machine-filed finding is a typed, cited claim that the application
malfunctioned. It is persisted with an opaque id, its project, first cited run,
case and story, a category from the fixed vocabulary (`http_error`,
`console_exception`, `expectation_violation`, `data_mismatch`, `no_effect`,
`perf_regression`, `broken_navigation`), a structured claim (title, expected
behavior, observed behavior, severity, signals), its lookup keys and algorithm
versions, a normalized match text, and finding state `new`.

All intake flows through one server-side path. Its sources are discovery study
synthesis, per-run grade ingest, and explicit reviewer filing; the path makes
no assumption about its caller. Evidence rows are append-only and idempotent on
(finding, run, step): a study-synthesized finding carries **every** cited
run/step, never only the first. Caller idempotency keys are durable in a
dedicated table — one finding may absorb many intake keys, and a runner retry
re-presenting a key appends evidence instead of filing twice.

Exact recurrence is deterministic and requires no model call. The server computes
two versioned keys from trusted recorded context only:

```text
strict = sha256(project_id ‖ story_id ‖ signal_type ‖ normalized_locus)
loose  = sha256(project_id ‖ signal_type ‖ normalized_locus)
```

Model-authored text and the model-chosen category never enter a key. The
`signal_type` is the deterministic anomaly signal that grounds the claim and the
`normalized_locus` is derived from recorded fields (route template, step/selector
locus, status class) with run-specific ids, numbers, and timestamps stripped. A
claim with no deterministic signal carries no exact keys. Normalization and
key derivation are pure and versioned, and every row stores its versions: because
all inputs are recorded, a version bump recomputes stored keys — the control
plane runs that recompute once at startup, after migrations — so older findings
never silently stop matching.

Intake resolves against live findings (merge tombstones followed), in order:

- An **intake-key hit** (idempotent retry) appends evidence to the finding that
  key already produced, and does nothing else.
- A **strict hit** appends every new evidence row with no review, whatever the
  finding's state: a `rejected` finding absorbs matching evidence silently and
  increments its recurrence count — standing rejection **is** the suppression
  mechanism; there is no separate suppression table — and a `resolved` one
  reopens.
- A **loose hit** (the same defect surface reached from another story): the
  claim is filed as a `new` finding carrying a pre-attached suggestion toward
  the best live match, preferring findings a person has already touched. It
  never auto-merges. A grader restatement of a failed assertion is expected to
  loose-match the deterministic gate-failure finding as a suggestion, not
  duplicate it.
- A **miss** files a `new` finding and emits `finding.created`.

Reviewer verbs on a `new` finding are the ordinary finding transitions:
**accept** confirms it, **reject** dismisses it (reason vocabulary
`not_a_bug`, `wont_fix`, `duplicate`), and **merge** resolves a suggestion
into the finding it duplicates. There are no candidate routes. The console
reaches unreviewed findings as a filter of the Findings list
(`state=new`), not a separate page. A finding may never cite another project's
run, and a merge may never cross a project boundary. Every intake, transition,
and merge writes an audit row naming the actor, in the same transaction as the
state change.

Discovery study synthesis (`POST /api/v1/run-groups/:g/synthesize-findings`,
editor-authorized, contextual on a finished discovery run group) mines the
group's graded runs and emits claims into this intake path. Synthesis enforces
grounding — a claim that cannot cite a real run is dropped, not shipped — and
the model supplies the claim, never the identity: the signal type and locus
behind a finding's keys are derived server-side from the cited runs' recorded
anomaly signals. Its response reports finding-centric counts:
`created` (new findings filed), `suggested` (filed with a same-surface
suggestion attached), `appended` (strict recurrences absorbed by live
findings), and `absorbed` (recurrences of rejected findings).

Per-run grade intake (`findings/run-grade.ts`, source `run_grade`) is the
automatic per-run twin of synthesis: report ingest reads the run's sealed
bundle's `grade.json` and takes its typed `bug_candidates` (category = `kind`)
and its `minor`/`major` free-form `findings` (category
`expectation_violation`) through this same path, with identity derived from
the run's recorded anomaly signals and an intake key stable across runner
retries. The deterministic gate-failure extractor keeps its own fingerprint
scheme for continuity but stores derived exact keys, so grade claims can
loose-match it.

Reviewer filing from a run (`POST /api/v1/runs/:r/promote-finding`) uses the
same path but lands **confirmed**: a person deliberately filing a bug is its
confirmation, so the finding is created in state `accepted` with the reviewer
stamped as confirmer. The run is provenance and evidence, not identity: two
reviewers filing the same defect surface from two runs converge on one finding.

### Consolidation

Semantic grouping of differently worded **unreviewed (`new`) findings** runs
retrieve-then-verify. It has two triggers — a reviewer pressing the manual
flow, and the automatic post-run sweep described below ("auto-dedupe") — and
both run the same pipeline; only the apply policy differs. The order of the
three steps is a guarantee, not an implementation detail:

1. **Deterministic retrieval.** Every `new` finding is scored by
   rare-word-weighted token overlap of its stored match text against the
   project's other live findings — open, rejected, and resolved alike — and
   against the other `new` findings. The top-k neighbors above a similarity
   floor form its shortlist. A shared category raises the score (the category
   word is part of the match text) but never gates comparison: two claims the
   model labeled differently must still converge. Retrieval is pure, versioned
   (`shortlist-v1`), and makes no model call, uses no index, and needs no
   external service.
2. **Score routing, before any model call.** A `new` finding with a single
   reviewed-finding neighbor at or above the auto-suggest threshold is proposed
   as a merge into it. One with no neighbor above the floor is proposed to
   stand alone. Neither path reaches the gateway.
3. **Cluster verification.** Only the ambiguous middle is clustered, as connected
   components of shortlist edges, so one defect cannot be split across two calls.
   Each cluster costs exactly one forced-tool call. A cluster prompt carries ids,
   titles, expected and observed behavior, story and surface, and evidence
   *references* — never screenshots, HAR bodies, cookies, authorization headers,
   or trajectories. Configurable hard caps bound the items and prompt bytes of one
   call and the number of clusters in one run; an over-large component is split
   into capped calls and the split is recorded, never silently truncated.

Retrieval thresholds are server configuration rather than algorithm constants.
The verification model resolves per project — see "Model selection"
(`consolidation_model` policy, `PLAYTEST_CONSOLIDATION_MODEL` env, then the
`gpt5_6_terra` tier). Startup rejects an out-of-range value, or an auto-suggest
threshold below the floor, with a `ServerConfigError`.

| Value | Default | Environment variable |
|---|---|---|
| shortlist size `k` | 5 | `PLAYTEST_CONSOLIDATION_K` |
| similarity floor | 0.25 | `PLAYTEST_CONSOLIDATION_FLOOR` |
| auto-suggest threshold | 0.6 | `PLAYTEST_CONSOLIDATION_AUTO_SUGGEST` |
| per-cluster item cap | 15 | `PLAYTEST_CONSOLIDATION_MAX_CLUSTER_ITEMS` |
| per-cluster prompt-byte cap | 24000 | `PLAYTEST_CONSOLIDATION_MAX_PROMPT_BYTES` |
| clusters per run | 20 | `PLAYTEST_CONSOLIDATION_MAX_CLUSTERS` |

Word overlap alone never bypasses verification: a duplicate either matched a
deterministic exact key at intake or goes to a reviewed cluster call.
`consolidation_labels` records every reviewer confirmation, edit, and rejection
with the deterministic score that produced it.

**A consolidation plan is a proposal, never a write.** The model may reference
only ids the server put in that cluster's prompt. Before a plan is persisted the
server validates that every referenced id appeared in that cluster's input, that
no merge crosses a project boundary, that each `new` finding appears at most
once across the whole plan, and that a group with no existing target carries a
non-empty proposed title. Confidence is `high` or `medium` only — a grouping the
model cannot support at medium belongs in `unresolved`. A plan that fails
validation is not persisted at all. Persisting a valid plan changes no finding:
states, titles, and evidence are untouched until a reviewer applies it.

Applying is one transaction and goes through the same merge machinery as any
reviewer merge, so every accepted group carries all of its members' cited
evidence onto the surviving finding, follows merge tombstones to the live head
of a chain, and audits. A group with an existing target merges its members into
it; a group proposed as new merges into its oldest member, which takes the
proposed title and stays `new` for ordinary review. The reviewer may accept an
item, edit its target finding or proposed title, or leave it unresolved; an
item that is not accepted leaves its findings unreviewed. The full plan, the
reviewer's edits, and the skipped items are recorded in one audit entry. Every
confirmation, edit, rejection, and unresolved outcome is also written as a
labeled pair with the deterministic score and the model's confidence, so the
thresholds can be recalibrated from real decisions.

**Auto-dedupe.** When a run report or study synthesis may have filed `new`
findings, the control plane schedules a debounced per-project sweep
(post-commit, best-effort, single-flight under an application lease) that
builds a plan through the same pipeline and applies a deliberately
non-reviewer policy:

- Model-verified groups at **high** confidence are applied — through the same
  validated plan and merge machinery as a reviewer apply, actor
  `{system: "auto_dedupe"}`. Routing an unreviewed machine-filed claim is
  reversible (evidence split and reopen exist) and enters no confirmed state,
  so the human guarantee holds: the sweep can group and route claims, never
  judge them.
- **Medium**-confidence matches toward an existing finding, and deterministic
  score-routed matches, become pre-attached "possibly the same bug as"
  suggestions. A lexical score alone still never merges.
- Everything else stays a separate `new` finding. Items the sweep leaves
  behind are labeled `unresolved`, not `rejected` — deferring to a person is
  not a rejection signal for threshold recalibration.

The sweep is on by default whenever the LLM gateway is configured.
`PLAYTEST_AUTO_DEDUPE` sets the deployment default and
`PLAYTEST_AUTO_DEDUPE_DEBOUNCE_S` (default 20) sets how long reports batch
before one sweep covers them. Each project may pin the sweep on or off over
that default (`projects.auto_dedupe`, tri-state, admin-set via
`PUT /api/v1/projects/:p/auto-dedupe`, audited): a pinned-on project sweeps
even under an off-by-default deployment, but no project can conjure a gateway
the deployment lacks. `/me` reports the deployment default as
`capabilities.auto_dedupe`; every project view carries the pin.

**The manual "Find duplicates" flow follows the toggle.** With the sweep on
for a project there is no manual run affordance — the console shows a quiet
dedupe-history view instead — and switching the sweep on schedules an
immediate catch-up pass, so a backlog accumulated while it was off never
strands behind a missing button. With the sweep off, the reviewer-triggered
flow above is the only semantic dedupe path and the console presents it in
full. An applied sweep emits `consolidation.auto_applied`; a sweep failure or
an unconfigured gateway degrades to the manual flow, never fails a report.

Idempotency is explicit. A plan records a digest of every finding it covers at
proposal time; applying a plan whose findings were reviewed, merged, or re-keyed
since fails cleanly as a conflict, as does applying a plan that was already
applied or discarded. Nothing partial is left behind.

Algorithm and model metadata are recomputable assignment provenance: the plan
records its shortlist and match-text algorithm versions, the model, the
deterministic scope shown to the reviewer before the run, and the gateway usage
reported after it. A finding retitled by a plan carries the same algorithm
versions in its summary.

Routes: `GET /api/v1/projects/:p/consolidation/preview` (reviewer) returns the
deterministic scope — unreviewed-finding counts, cluster count, prompt bytes,
estimated input tokens, and the thresholds in force — with no model call and no
write, so the console can state what a run will cost before it is confirmed.
`POST /api/v1/projects/:p/consolidation` (reviewer) runs it and returns the
proposed plan. `GET /api/v1/projects/:p/consolidation-plans` and
`GET /api/v1/consolidation-plans/:id` are `viewer` reads; the plan detail carries
each member finding's claim and all of its evidence links so a reviewer decides
without leaving the page. `POST /api/v1/consolidation-plans/:id/apply` and
`.../discard` are `reviewer`. Consolidation is reached from the Findings
needs-review view; it is not a rail item.

### Auto-resolve

A failing run raises findings; a later run that demonstrates the fix retires
them. After every pass **or** fail report the control plane schedules a
debounced per-project sweep (post-commit, best-effort, single-flight under its
own lease — deliberately not auto-dedupe's lease name, since an overlapping
lease claim is refused rather than queued, and a dropped resolve sweep after a
group's final report has no later retrigger). Gate and signal tiers are
fully deterministic; the keyless tier re-verifies the finding's own claim
through the platform LLM gateway when one is configured.

**Resolution is per (suite, ring, case).** One finding's evidence
legitimately spans suites and rings, and one story fans out into one
case per persona, so the affected set is *derived* from evidence — the
distinct `(run_groups.suite_id, run_groups.ring_id, runs.case_id)`
triples reached through `finding_evidence` — never hand-maintained. (This is
deliberately the same key as run-attention retirement.) Each triple carries a
resolution stamp (`finding_resolution_stamps`: run, method, timestamp) written
when a newer run on that triple disproves the finding under its tier's test;
the finding resolves only when **every** affected triple carries a stamp newer
than that triple's latest evidence. Stamps are never deleted: new evidence
makes a stamp stale by timestamp comparison, so intake stays uncoupled from
the sweep, and the ledger survives reopens as history. Case granularity is
what makes personas sound — one persona passing cannot stamp out evidence
another persona raised.

The tiers, by what grounds the finding:

- **Gate-failure findings** (`gate_*` signal type) are stamped when the *same
  gate check* passes in a newer run on the triple — a run that failed at step
  8 still retires a finding whose step-3 check now passes. Gate keys never
  route through the signal test.
- **Signal-keyed findings** (a strict key derived from recorded anomalies) are
  stamped when a newer run's recomputed anomaly signals would **not**
  strict-hit the finding, guarded by locus coverage: absence counts only if
  the run passed outright or actually reached the finding's route template.
  An aborted or divergent run that never visited the page proves nothing. A
  lost or pruned bundle proves nothing either and is simply retried. A run in
  which the signal is still present (or coverage never reached it) writes a
  checked memo in the finding's summary — **never** an evidence row: citing a
  passing run as defect evidence would corrupt `last_seen` and reopen a
  finding from a pass.
- **Key-less findings** (judgment calls) are **verified**, not inferred: a
  pass verdict never proved the claim — the grader grades fresh (it is not
  shown the findings ledger) and checked act-mode runs are not graded at
  all, so absence from a later grade means "nobody looked". The sweep looks:
  one forced-tool call (`findings/verify-fix.ts`, model `auto_resolve_model` →
  `PLAYTEST_AUTO_RESOLVE_MODEL` → the consolidation cost tier) re-checks the
  claim against the newer run's recorded page content (the cited evidence
  steps' a11y text plus the final page) and answers **fixed / not fixed /
  indeterminate**. Fixed stamps `verified_absent`; not-fixed and
  indeterminate write the checked memo (never evidence). What a verified fix
  may *do* is the **auto-resolve mode**: `semi` (default) writes the "looks
  fixed by run … — Resolve / Not fixed" suggestion a person confirms; `full`
  resolves outright, with the same provenance and visibility as the
  deterministic tiers — but only when *every* covering stamp is a verified
  absence, and never over a person's "Not fixed" on that same run. Without a
  gateway the tier degrades: an outright pass by a **graded** run still
  writes the suggestion (method `case_pass`, suggestion-only in any mode);
  an ungraded checked run proves nothing about a judgment call. Findings
  carrying a **live external reference** only ever get the suggestion,
  whatever the mode — a live external ticket is never contradicted silently.

Guards on every stamp: timestamps compare strict-newer (a finding filed by
run R carries R's own report instant), and a run never resolves a finding it
evidenced. The apply re-asserts `merged_into IS NULL`, the state, and
`last_seen` the sweep read, and does **not** follow merge tombstones —
auto-dedupe can merge concurrently, and resolving through a tombstone chain
could close a different story's survivor. A lost race aborts quietly; the
next sweep re-derives everything from durable state.

**No new lifecycle state.** Auto-resolve reuses `resolved` with provenance:
`findings.resolved_by_run_id` (the run that demonstrated the fix) and
`findings.auto_resolved_at`, audit action `finding.auto_resolved` with actor
`{system: "auto_resolve"}`, and the existing `finding.resolved` platform
event, so feed subscriptions live-refresh unchanged. The provenance columns
describe the *current* resolution only: they are cleared when the finding
leaves `resolved` (recurrence or manual reopen), and a manual resolve clears
them too. `new` findings are eligible for auto-resolve — a machine-filed
claim that is already fixed must not sit in the review queue going stale.
The human guarantee is preserved by the recurrence destinations above: a
finding auto-resolved from `new` returns to `new` on recurrence, never to
`reopened`.

Visibility — findings must never just disappear; a mistaken auto-close must
be findable and reversible:

- The resolving run's page and row carry a calm "resolved N findings" chip
  (`resolved_findings` on the run projection; the findings list accepts
  `?resolved_by_run=`). The suite-page story row shows a calm
  `N auto-resolved` chip once its open and review counts are clear.
- Resolved-bucket rows wear an "auto" badge; the detail page carries a
  **Resolution** section (peer of "Latest evidence") with the resolving run,
  a link to its replay, and the sweep's **stated reason**: every stamp writes
  a short deterministic human-legible sentence for what it verified
  (`summary.auto_resolve.reason` on a resolution,
  `summary.auto_resolve.suggested.reason` on a suggestion), cleared with the
  rest of the provenance whenever the finding leaves `resolved`.
  **Acknowledge** (`POST /findings/:f/acknowledge`, reviewer, audit
  `finding.acknowledged`) remains the API's explicit-agreement verb and its
  receipt is displayed, but the console offers no Acknowledge button — a
  resolved finding is finished work and must not present a pending action;
  reopen is the disagreement verb, and suggestion outcomes are the
  promotion-gate signal.
- Suggestions surface on the finding (`summary.auto_resolve.suggested`, event
  `finding.fix_suggested`) with one-click **Resolve** (the ordinary reviewer
  resolve — the result is a human resolution, not an auto one) and **Not
  fixed** (`POST /findings/:f/not-fixed`, audit `finding.fix_dismissed`).
  Suggestions are review work: the console's Needs review tab carries
  pending suggestions on confirmed/reopened findings as a second
  "Looks fixed" queue with the same two verbs inline, its tally folded into
  the Needs review count. On list rows the suggestion takes the "Latest run"
  reconciliation cell as the strongest value of that one vocabulary
  (still failing / passing now / looks fixed / not re-run — all in the
  run-status chip family). **Not fixed**
  withdraws the suggestion and remembers the run so repeated green runs
  never re-nag; a *newer* passing run may suggest again. Promoting a
  project from `semi` to `full` mode is a team's call, informed by measured
  agreement (suggested → resolved versus not-fixed/reopened); the verified
  suggestion's quoted evidence is the trail that decision reads.

The sweep is on by default — the deterministic tiers cost no model calls,
and keyless verification is one short call per (finding, newest run), memoized
by the checked memo. `PLAYTEST_AUTO_RESOLVE` sets the deployment default,
`PLAYTEST_AUTO_RESOLVE_MODE` (`semi`|`full`, default `semi`) what a verified
fix may do, `PLAYTEST_AUTO_RESOLVE_MODEL` the verification model default,
`PLAYTEST_AUTO_RESOLVE_DEBOUNCE_S` (default 20) how long reports batch
before one sweep covers them, and `PLAYTEST_AUTO_RESOLVE_PIN_DAYS` (default
90) the retention grace window below. Each project may pin the sweep on or
off and its mode over the defaults (`projects.auto_resolve` and
`projects.auto_resolve_mode`, tri-state, admin-set via
`PUT /api/v1/projects/:p/auto-resolve {enabled?, mode?}`, audited; switching
on or widening runs a catch-up sweep) and pin the verification model
(`projects.models.auto_resolve_model`, `PUT /projects/:p/models`). `/me`
reports the deployment defaults as `capabilities.auto_resolve` and
`capabilities.auto_resolve_mode`; every project view carries the pins.

Findings present four disjoint user-facing buckets over the internal states:
**Needs review** (new), **Open** (accepted/confirmed or reopened),
**Resolved** (resolved), and **Rejected** (rejected). "All occurrences" is
hidden when a finding has a single occurrence.

Finding transitions are explicit and audited: accept (confirm), reject with
reason (`not_a_bug`, `wont_fix`, `duplicate`), resolve, reopen, merge, split
evidence, acknowledge (agree with an auto-resolution), and not-fixed (dismiss
a fix suggestion) — plus the system's own auto-resolve, which is evidenced,
audited, and reversible through the ordinary reopen. Evidence links resolve
to a specific run and, when known, viewer step. Confirmation and handoff are one step: an unreviewed finding
offers **Confirm and copy**, which records the human confirmation and copies
the tracker summary in one action; a confirmed finding offers **Copy for
tracker**. Accepting stamps the confirming actor and time into the finding as
durable provenance (and into the audit log). A finding may carry
an external tracker reference, but Playtest never files or updates a ticket
automatically: human confirmation always precedes external handoff, done with
**Copy for tracker** or by setting the external reference through the finding
API. The control plane executes no project-authored code and runs no
ticket-export runtime.

## External automation boundary

Playtest does not run project-authored plugins, generic webhooks, or an
automatic tracker integration. External automation instead uses stable,
authenticated endpoints:

- project-scoped API tokens authorize automation with a normal project role;
- run and finding read APIs expose evidence and finding state for external
  tools to poll or fetch;
- explicit finding transition APIs (accept, reject, resolve, reopen, set
  external reference) let an authorized token record the same audited decisions
  a reviewer makes in the console;
- **Copy for tracker** remains the default human handoff into an issue tracker.

Every transition through these APIs is authorized by role and recorded in the
audit log exactly as its console equivalent.

## Authoring and study synthesis

Story authoring uses inline, stateless AI drafting. The story form offers **Help
me draft**: one editor-authorized request (`POST /api/v1/suites/:s/story-draft`)
drafts or improves stories from a plain-language goal, a short browser-held
clarification transcript, and — when improving — the existing story path and
YAML. The server derives context from current suite state (defaults, compact
story summaries, personas, and the suite's own application's ring keys/base
URLs) and never sends
secrets, session artifacts, or raw auth values to the model. It returns either
a clarifying reply (`needs_input`) or `{ draft, drafts }`: `drafts` is the
proposed set — one story by default, several (capped) within the same stateless
request only when the goal explicitly asks for a set — and `draft` is its final
entry, each `{ path, yaml, validation, lint }`. Improving an existing story is
always a single draft pinned to its path. The web console reviews a set in
place and saves the approved stories as one ordinary commit.

The endpoint has no durable write path: it creates no authoring row, platform
event, suite snapshot, audit entry, or file. A returned draft only populates the
unsaved story form; when improving, the draft is pinned to the existing story's
path. The model can validate and lint (the same core validators as the CLI and
suite editor) but cannot save or commit. The only durable write is the ordinary
human Save (`POST /api/v1/suites/:s/commit`), which applies the same whole-suite
validation and optimistic concurrency as any edit — model output cannot bypass
either. There is no persisted session, transcript, server-side draft, assistant
feed event, or assistant-specific commit endpoint.

Rule-card proposal is the assistant's second call and the one durable-writing
one ([Rule cards](#rule-cards)): it persists `candidate` rows, an audit entry,
and a feed event. Its prompt, forced-tool schema, validation, and normalization
are owned by the engine
(`packages/core/src/public/api-suite-scripts.ts`) so all callers share one
instrument. Like every other model call here it decides nothing:
a proposed card is always a candidate.

Discovery study synthesis is a findings operation, not a stored report.
Triggered contextually on a finished discovery run group, it reasons across the
group's graded runs and personas and emits typed, cited claims straight
into findings intake, where they land as unreviewed `new` findings (see the
Findings section). It must cite provided run
references; ungrounded citations are rejected. There is no Insight row, report
object, Markdown download, regression digest, or custom-insight document.

Both jobs call the platform LLM gateway (`PLAYTEST_LLM_BASE_URL`,
`PLAYTEST_LLM_API_KEY`); a deployment without it answers `503 not_configured`
and advertises `capabilities.llm: false` on `GET /api/v1/me`. Both default to
the grader-tier model. They are
separately pinnable and must stay so: `PLAYTEST_AUTHORING_MODEL` selects the
drafting model and `PLAYTEST_SYNTHESIS_MODEL` the synthesis model. One variable
must never silently re-tier the other job.

## Background cycles and leases

Retention and dispatch reconciliation are scheduled cycles, not queues. Each is
coordinated by one named lease row claimed with a conditional update inside a
`BEGIN IMMEDIATE` transaction. There are no advisory locks and no in-memory
guards.

1. **Single winner.** Concurrent claims for one lease name produce exactly one
   holder. A live lease is never stolen, including by a second cycle in the same
   process: the claim is not reentrant, because refusing an overlapping tick is
   the point.
2. **Expiry.** A lease has an owner and an expiry. Its holder renews while the
   cycle runs, so a legitimately long cycle is not interrupted.
3. **Crash recovery.** A process that dies mid-cycle renews nothing. Once the
   expiry passes, the next scheduled cycle claims the lease and proceeds without
   operator action.
4. **Prompt release.** A cycle that finishes or throws releases its lease
   immediately rather than making the next one wait out the expiry.
5. **Advisory, not a correctness barrier.** Every step inside a cycle is already
   safe on its own — short transactions that restate their preconditions in the
   mutating statement. The lease prevents duplicated slow object work and a
   wedged schedule; it is not what makes a step atomic.

A skipped cycle is a normal outcome, reported as such, and never an error. Lease
rows are ephemeral coordination state: nothing references them, they carry no
user or evidence data, and they are excluded from the migration and backup data
contract.

## Retention

Retention is one deployment-wide policy, not a per-project configuration. It
uses conservative defaults with optional operator environment overrides
(`PLAYTEST_RETENTION_EVENTS_DAYS`, `PLAYTEST_RETENTION_FULL_DAYS`,
`PLAYTEST_RETENTION_CORE_DAYS`; the full/core overrides accept `forever` to keep
that tier indefinitely). The defaults are event rows 14 days, full bundles 90
days, and core evidence 365 days. There is no project retention API or UI, and
legal holds no longer exist.

Run evidence has three tiers:

- `full`: the complete bundle as the run recorded it, including heavy media and
  any Playwright trace;
- `core`: manifest, trajectory, grade, text evidence, and timing captions;
- `meta`: database projections only.

A `full` bundle is *complete*, not *fixed*: which artifacts a run records is the
suite's own choice of artifact profile
([artifacts.md](artifacts.md#artifact-profiles)), and the default profile writes
no Playwright trace, no MHTML, and no native accessibility tree. Retention never
assumes an artifact is present — every tier is a filter, and an absent path is
simply absent. Nothing in the control plane or the runner agent reads a trace or
an MHTML file, and no console surface exposes one.

Retention moves at most one tier per cycle. `full` to `core` rewrites the bundle
with the artifact contract's deterministic rules and records old hash, new hash,
and removed paths. `core` to `meta` deletes the bundle while preserving run
history projections.

Current baselines, pending baseline-change candidates, and finding evidence
that is open (`new`, `accepted`, `reopened`) or exported prevent deletion
below their required tier — an unreviewed finding keeps the runs that
justify it. Evidence of an **auto-resolved** finding stays pinned for a grace
window after `auto_resolved_at` (`PLAYTEST_AUTO_RESOLVE_PIN_DAYS`, default
90): reopen restores state, not evidence, so a mistaken auto-close must stay
reversible with its proof intact. Unbounded pinning of every resolved finding
forever would be a storage decision, not a default, so findings a person
resolved follow the normal schedule. The viewer must state when evidence
was pruned or is missing; absence never masquerades as an empty or successful
artifact.

A generated clip and its VTT are sibling artifacts tied to their source run and
share the run's retention lifecycle. Because they live outside the sealed
bundle, they survive the `full`-to-`core` rewrite; they are deleted when the run
tiers to `meta`, alongside the rest of that run's evidence. Regenerating a clip
overwrites the previous clip at its deterministic object key, so superseded
copies do not accumulate, and orphan-object cleanup removes any clip object no
longer referenced by an artifact row.

Live staging ([Live runs](#live-runs)) is transient serving state, not evidence
retention decides about: it is deleted the moment a verified bundle lands. What
the retention cycle collects is therefore only what the seal could not — the
ledger rows and staged objects of a **terminal run with no bundle**, once a grace
window (a day) has passed; `pending` reservations older than that window, whose
upload crashed, refunded with the row; and any row whose run row is gone.
Rows and objects go together, and deleting a row deliberately re-exposes its
object to the orphan sweep as the backstop. That sweep counts a live staging row
in *either* state as an owner, which is what lets it run mid-stream without
touching a run's staged bytes.

Content-addressed blobs (`blobs/<sha256>`) are reclaimed by their own sweep, and
every referrer counts. Suite-snapshot trees are the only one: the platform holds
no application bytes, so a blob nothing any snapshot names is reclaimed on the
next cycle.

Bundle rewriting and reads are buffered and therefore subject to the
safe-integer and upload limits enforced by the implementation. Larger artifacts
require a different streaming contract rather than silently bypassing those
guards.

## Hosted information architecture

The hosted console is desktop-first and narrows to the loop Playtest owns:
author stories, run them, inspect evidence, make a human decision.

- Primary project navigation is exactly five items: **Suites**, **Runs**,
  **Findings**, **Personas**, **Settings**. The project switcher and user menu
  remain in the top bar. There is no global search and no permanent Review,
  Candidates, or Insights entry: unreviewed findings are a filter of the
  Findings list, not a separate destination. Personas earns a permanent entry because a persona is
  project-wide rather than owned by any one suite, and the story editor's
  persona picker has to be able to send an author somewhere to make one.
- The Personas page lists the built-ins as locked cards showing the exact prose
  the actor is given, and project personas with create, edit, and delete. The
  story editor's `persona` field is a picker over that same list, not free
  text: personas resolve at run time, so a typed name validates and then fails
  the run. Discovery stories pick several and the picker states the resulting
  run count; journey stories pick one.
- Suites is the project landing page and the only suite index. It carries Needs
  attention, a compact 7-day pass-rate summary with its graded-story denominator,
  and a suite table showing latest result and open-finding count.
  `/p/:key/suites` redirects to this project home;
  suite-detail, story, run, finding, and viewer deep links stay stable.
- Runs is a triage surface, not a list of identifiers, and it is sized for a
  busy console rather than for one run at a time. It is **one table** — one
  sticky column header, one card, suites as full-width head rows carrying that
  suite's recent-outcome trend and its own launch control — because a header
  per suite cost a header's height per suite, and separate tables cannot align
  their columns with each other. Every run is **one row** whatever it is doing:
  what it did (one count per outcome it produced), where it ran, its wall
  clock, its cost, and one action at its right edge (Cancel while it is
  spending, Retry in place when stories never started, Synthesize once a
  discovery run has trajectories to mine). A row
  expands **in place** to its stories, and each story links straight to its
  replay. A run of one story has no summary screen of its own — its name is the
  link to the replay.
- What opens by itself is deliberately rare, because an expanded run is worth
  several collapsed ones in height: only a failure among a suite's three newest
  **finished** runs (finished, so that four things launched at lunchtime cannot
  quietly close last night's failure), plus whatever a filter has narrowed the
  page to. A person's own expand or collapse always outranks that. Three tabs
  narrow the page: **All runs**, **Needs attention** (`?attention=1`, the
  server-side filter for runs holding a failure or a story that never ran), and
  **In flight** (`?live=1`, client-side over the loaded page — a run still
  queued or running was launched more recently than anything that has finished
  since, so it is always on the newest page).
- Runs is also the **only** live surface for a run in flight: there is no
  separate run dashboard, and nothing on a live row says "Follow". A live run's
  wall clock and cost tick in place, its OUTCOME cell is a two-segment meter
  (finished solid, in flight breathing) with `done/total` beside it and the
  sentence "N of M stories done" for assistive technology, and its row carries a
  single **now** line: the story furthest along, what it is doing, its step
  within the budget, and the actor's latest action, in that priority order
  because the tail is what gets cut. Nothing expands itself into a live block —
  that is what **In flight** and a run's own URL are for.
- Expanded, each in-flight story renders the runner's live progress as a block
  built for a page rather than a terminal: the mode word as a pulsing chip,
  `step N/M · cost · elapsed` as right-aligned vitals, a thin step-budget meter
  (budget consumed, never an ETA), and the actor's recent actions as a fading
  "↳" trail on one line, newest first, which the client accumulates from the
  progress events on the feed (the server keeps only the latest snapshot; model
  and token telemetry ride the tooltip). Queued stories are summarised on one
  line rather than given a row each — a queued story has no vitals, no evidence
  and nowhere to go. Current progress or the plain-language final verdict heads
  the expanded stories. A run's own URL
  (`/p/:key/runs/:group`) still resolves: it opens the index with that run
  expanded and scrolled into view.
- The replay is a destination the interface names. Every story row offers
  **▶ Replay**; a story that never produced a verdict offers the reason instead,
  because there is nothing to replay and the cause is what a person wants. The
  replay page carries previous/next and a picker over the other stories in the
  same run, so triaging several failures never goes back up to the run in order
  to move sideways.
- A changed run is a run awaiting a decision, not a durable top-level object.
  Needs-attention and suite/story changed indicators open the run's evidence at
  the Diff view, where Accept and Reject live beside the diff. The baseline trust
  boundary is unchanged: a runner, grader, or model cannot accept its own
  candidate. A batch review view remains reachable but is contextual — Suites
  offers "Review all changed stories" only when several candidates are pending,
  and it is not on the rail. A single pending candidate is decidable from its own
  run page.
- **Applications** is a first-class project section (`developer` to edit,
  `viewer` to read): create and rename applications, see their immutable keys and
  drivers, manage each application's rings — key, name, URL for web/API, routing
  labels, discovery permission, browser cookies (`config.app.cookies`, sent on
  every web run against that ring), auth identities and secret references — and
  see the suites bound to each. No URL, binary, device, or Appium control exists
  anywhere for mobile: a mobile ring's page states that the claiming runner
  supplies the build and links the runner operations guide.
- Settings defines five sections: **Runners** (`developer`: register a
  self-hosted runner, list what each advertises, whether it is here right now
  and what it is executing, revoke — always present, because the claim board is
  the one placement model),
  **Runs** (project concurrency), **Models**
  (project model and finding-dedupe policy), **Team**
  (members, roles, and permanent project deletion for admins), and **Audit**.
  Secret values are never rendered. Project API tokens remain supported through
  the existing API/CLI boundary; the console adds no token-management UI.
  Plugins, Integrations, and Retention are not configured from the console.
- Registering a runner reveals its credential **exactly once**, together with the
  complete one-line start command for that server and those labels; the value is
  stored hashed and is unreachable afterwards, so the console cannot show it a
  second time either and says so. The credential appears in the command as an
  environment assignment, never as an argument.
- Each runner row states whether it is **here**, as a dot and a word (never a
  colour alone): online, running a job — linked to the run group it claimed —
  offline with how long the silence has been, never started, revoked, or
  expired. The section repaints on `runner.status` and `run.status` from the
  event feed and re-reads the clock on a slow local interval that makes no
  request, so a laptop that closed its lid goes quiet on the page without
  anything having reported it. Nothing on this surface polls.
- **Suite creation asks for the application**, because a suite runs against
  exactly one and the binding is immutable. A developer may create one inline —
  for web that is a name plus a ring URL, nothing more — so the affordance is
  visible only to developers; an editor picks from the applications that exist,
  and an empty project tells an editor that a developer has to create the first
  one. There is no target card and no per-suite target form: the suite never
  writes into a shared ring record.
- The launch dialog shows suite, application, ring, the resolved URL (web/API)
  or "build supplied by the claiming runner" (mobile), the labels this run
  needs and whether the launch or the ring chose them, and whether anything
  advertising those labels is checked in — warning in the words the
  unclaimed-timeout failure would have used.
- A run that never ran because nothing claimed it is explained as **placement,
  not the app**: the four pool failures (no runners registered, none
  advertising the labels, none polling, the claim holder went silent) each get
  their remedy and a link to Settings → Runners, instead of a sentence about
  the app under test. A run's provenance line states the runner that claimed it
  and the isolation that runner reported, so a reviewer can see what produced
  the evidence.
- Every page's `nav:` value resolves to exactly one rail item through
  `railFor` (`packages/platform/web/src/lib/nav.ts`). Surfaces that live under a rail
  item say so: the suite page, story editor, suite settings, Versions and run
  history map to Suites; the changed-stories queue maps to Runs. A page that
  lights up no rail item is a bug, and the hermetic gate asserts the mapping.
- System health is a status bar, not a page. Inside a project, a thin always-on
  footer (`packages/platform/web/src/lib/statusbar.ts`) states whether this console is
  live and — for developers — dispatch depth against the cap, board queue wait,
  reconciler liveness, and model spend; the dispatch ledger opens in a drawer
  over the page. The words and tones are DOM-free in `lib/ops-status.ts`. The
  bar reads `GET /projects/:p/ops` and
  `GET /projects/:p/dispatches`, both still developer-only, and non-developers
  see only the feed indicator. It stays live off the event feed (§ Events and
  long polling) — a refetch when anything moves, plus a slow safety refresh,
  paused while the tab is hidden, for the numbers that decay with the clock
  rather than with events (a dead reconciler emits nothing, which is exactly
  when its lag matters).
- Below the supported minimum width the console shows a desktop-requirement
  message instead of a clipped rail and tables. It keeps the top bar and offers
  "Continue anyway", which sets `data-scope="wide"` and renders the console at
  that width.
- The console authors stories and the suite's shared defaults; it is not a file
  manager. A suite's `playtest.yaml` is edited on **Suite settings**
  (`/p/:key/suites/:slug/settings`) as a form with a YAML view of the identical
  bytes — the same discipline as the story editor, applied through
  `packages/platform/web/src/lib/defaults-form.ts`, so comments and unedited keys survive.
  Personas, hooks and assertions are code-tier files: they arrive and leave as a
  `.tar` (Import/Export) and are edited with the CLI.
  `/p/:key/suites/:slug/files` redirects to Suite settings.
- **API rules** (`/p/:key/suites/:slug/rules`) is the suite's rule cards
  ([Rule cards](#rule-cards)), reached from the suite's overflow menu. It is not
  gated on anyone having approved a card: every suite already has the Level 0
  set, and the page's first job is to say so. The page opens with the enforced
  rules, then the cards to review, then approved, then denied — the
  order a person reads them in — and each card carries its one-line provenance,
  approve / not-a-rule / edit, and a note field that travels to the test author.
- **The ring says where a run points; the suite never does.** A ring owns the
  URL, the credentials, the routing labels and the discovery permission for one
  deployment of one application, and hosted execution applies that URL as the
  runtime target — after the complete authored merge, replacing anything the
  suite wrote. Suite settings therefore has no base-URL field and no per-ring URL
  table. What a suite may still say per ring is LOGICAL: `app.envs.<ring key>`
  cookies, identities, settle, viewport. The launch dialog names the ring and the
  URL it resolves to, and there is no precedence left to explain.
- The launch dialog offers only the rings of the suite's own application, each
  option naming the host it resolves to (`staging · staging.acme.test ·
  discovery`). Switching suites re-derives the choice, since a selection can
  belong to an application that no longer applies.
- Suite settings exposes `max_steps` and `timeout` as editable shared defaults,
  preserving either their top-level or nested `limits.*` YAML spelling. The
  launch dialog states the effective resolved limits on its Limits disclosure
  and accepts optional maximum-step and timeout overrides for that launch only.
- Run concurrency is exposed at both levels of § Run concurrency. Settings →
  **Runs** (admin) edits the concrete project worker and recording caps. Suite
  settings has a **Concurrency** card that inherits that pair or writes the
  suite's top-level `parallel`; automatic core pool sizing remains available.
  The suite form and YAML view edit the same bytes, so imported scalar/object
  forms remain valid.
- For web suites, Suite settings exposes a **Browser display** card for
  `app.viewport.width`, `app.viewport.height`, and `app.device_scale_factor`.
  With no configured values it shows core's 1280 × 720 viewport and 1× scale as
  the inherited defaults; editing one viewport dimension preserves the other,
  including a YAML-authored null height for full-page screenshots.
- Model choice is exposed at both levels of § Model selection. Settings →
  **Models** (admin) edits the project's actor/grader defaults; Suite settings
  has a **Models** card writing the suite's own top-level
  `actor_model`/`grader_model`. Both are dropdowns over the `GET /models` tier
  list (`packages/platform/web/src/lib/model-select.ts`), whose first option is the
  inherited state and names what it resolves to — "Project default — sonnet",
  "Engine default — gpt5_4_mini" — so not choosing reads as the concrete model
  it means, never as an empty box. A final "Custom model name…" option reveals
  a text input for a fully-qualified gateway name (choosing it commits nothing
  until a name is typed); with no catalog the field degrades to plain text.
  The launch dialog names the resolved model per role, and whose choice it was,
  under the mode control that decides how hard those models will work.
- `app.base_url` is a suite-level setting, and core resolves every case against
  the suite's defaults: until one exists no story in the suite can be saved or
  run. It is collected by the empty suite's target card rather than by the New
  suite dialog, because where an app runs is a ring's question and the caps a
  suite tree lives under cannot hold a real mobile build. A suite that still
  lacks one after that says so on the suite page and in the story editor's
  checks, with a link to Suite settings.
- Machine identifiers are derived, not requested. Creating a project or a suite
  asks only for a name; the key/slug is slugified from it, made unique by a
  numeric suffix on 409, and is immutable thereafter. A project's key is shown
  read-only in Settings, since it appears in URLs, the CLI and the API. Names,
  not keys, are the headline wherever both are shown.
- The findings lifecycle has one vocabulary. The API keeps its five states
  (`new`/`reopened`/`accepted`/`rejected`/`resolved`); the console shows four
  disjoint buckets — **Needs review** (new), **Open** (accepted or reopened),
  **Resolved**, **Rejected** — and
  `packages/platform/web/src/lib/finding-buckets.ts` is the only mapping between them.
  A `new` finding's chip reads "needs review", an `accepted` one "confirmed":
  confirming a finding says it is real, not that it is done.
  `?filter=dismissed` still resolves to the Rejected bucket.
- A baseline change awaiting a decision is a **changed story** on screen (its
  API resource stays `candidates`). The UI does not call machine-filed defect
  claims "suspected bugs" or "bug candidates"; they are findings that need
  review.

## Web experience invariants

- Primary copy says story, suite, and run. "Journey" is reserved for the
  recorded path being compared, and "case" and "run group" do not appear in the
  interface at all — a person launches a run, of some stories, against a ring.
- Engine tokens are translated before a person reads them.
  `packages/platform/web/src/lib/vocab.ts` owns the display words for candidate
  categories, deterministic signals, success-criterion kinds and the run-status
  legend; an unmapped token degrades to a readable phrase rather than a blank,
  so a new engine signal is usable without a web release. The raw token stays
  reachable in a `title`, a provenance line, or a disclosure.
- The plain-language thing is the row title and the identifier is a tag beside
  it. Monospace is reserved for what is genuinely code: selectors, URLs, paths
  and ids in provenance lines.
- A run is named by what a person can read: the note whoever launched it wrote,
  else what triggered it. Never a shortened ULID — `short()` takes a ULID's
  leading characters, which are its timestamp, so two runs minted in the same
  millisecond render the same "id" and the label distinguishes nothing.
- One arithmetic per run. `packages/platform/web/src/lib/run-stats.ts` derives every
  count, word and tone about a run from whichever shape the caller holds — the
  list projection's `stats`, a fetched group's story rows, or a legacy
  `exit_summary` — so an index row, the run's own header and its narration cannot
  disagree about the same run.
- Authoring asks product questions, not filesystem ones. A new story's path is
  derived from its description, shown read-only, and overridable only behind an
  Advanced disclosure.
- Gate verdicts have primary visual weight. Scores and movement remain
  secondary and never borrow pass/fail colors.
- Story editing is form-first with a YAML escape hatch. Untouched content
  round-trips without unrelated rewriting.
- Every finding and synthesized claim links to its evidence.
- One fact has one source. A run's time comes from the platform run row on
  every surface, including story history — `history.json` carries the bundle
  MANIFEST's timestamp, which is the trajectory's own clock and disagrees with
  the run row for replayed or backdated bundles.
- Missing, pruned, delayed, or failed data is stated with provenance.
- Cost is visible before fan-out launches and on completed runs.
- Developer and admin surfaces are progressively disclosed by role.
- Destructive decisions wait for server confirmation. Live updates resume from
  durable cursors and expose reconnecting state — in one place, the status bar,
  rather than a per-page pill, so "am I still connected?" has the same answer in
  the same spot on every screen.
- Anything that destroys work or spends money confirms first, and looks like it
  before it is hovered. Cancelling a run, discarding unsaved story edits, and
  synthesizing findings each name their consequence in the dialog; `.btn.danger`
  carries a resting treatment, and filled red is reserved for a confirm
  dialog's action. The launch dialog never preselects a ring named like
  production: it defaults to where the suite last ran, else one that allows
  discovery, else the first non-production ring of the suite's application.
- What a run does to saved paths is one binary control. Mode is Auto (each story
  replays its saved path; a story with none, or whose text changed, records) or
  Agent (every story records, and each passing recording replaces that story's
  saved path — the wire's `selection.refresh`, which the dispatcher and the
  engine both read before `selection.mode`). Recording without keeping the
  recording is not offered. Both options are on the surface naming what they do,
  not folded into a dropdown that hides the alternative behind the expensive
  choice, and the selected one's consequence is stated under the control, before
  Launch.
- The launch dialog opens on the two decisions that spend money and touch a real
  application — which ring, and whether the agent drives — with the plan
  and the estimate beside Launch itself. Which suite and which stories are
  context under the title, not controls: a launch scoped from a story row or the
  story editor (`selection.ids`) says so and stays scoped, since widening it to
  the whole suite is a different launch a click away on the suite. Per-story
  step and timeout overrides are a disclosure whose summary already states the
  limits in force, so folding them away hides no budget.
- A run still executing is shown as live, never as a verdict it has not earned.
  Its detail header wears the embedded viewer's own ● live badge — one word, one
  colour, one dot across the iframe seam — plus a line of what the run is doing,
  read from the progress snapshot the feed already delivers; a queued story is
  not live yet and says so. Its story row on the runs index carries **Watch**, in
  the column a finished story keeps **Replay**. The two halves of the run page
  update over **separate channels and neither polls**: the embedded viewer owns
  the live stream against the run's [`live` route](interfaces.md#live-runs), the
  page owns the event feed, and the seal reaches them independently — `open:
  false` on one side, one `run.status` event on the other — so they land within a
  tick of each other with no second live loop in the console. The page re-mounts
  the frame only when the frame came up empty (a run claimed a moment ago has
  started but staged nothing yet), never while it is streaming, because a reload
  would cost the reader their selection.
- A run that produced no verdict (`infra`, `canceled`, `lost`) is presented as
  "didn't run" in amber with a plain-English cause and a retry, never as a
  product failure, and does not offer to file a finding. If it *streamed* before
  it died, the steps it staged are still played on the page and the provenance
  says so — "no bundle — showing the steps it streamed" — because that stream is
  the only record of what the run saw.
- A run whose manifest ends with `end_reason: "timeout"` is labelled **timed
  out** on run lists and detail. Its detail header states the configured
  `timeout_ms` and `max_steps`, and the failure strip names the timeout before
  downstream gate failures so an incomplete journey is not mistaken for an
  application action failure.
- A statement about where a suite points, what a version promises, or what a
  run will cost must be true at the moment it is read. The suite header says the
  target is chosen at launch; Versions offers a real Restore (one snapshot
  exported and re-imported, landing as a new version); the launch dialog's
  persona count sits inside the run-plan breakdown because it re-describes the
  explore runs rather than adding to them.
- Every dead end carries the frame it was reached from and at least one next
  step that works. A 404 under a project keeps that project's rail; a missing
  run says it may have been pruned instead of offering a retry that cannot
  succeed.
- Status never relies on color alone, controls remain keyboard accessible, and
  errors name the action or field without exposing stacks. Anything carried by
  colour, shape, or a `title` has a visually hidden text equivalent beside it:
  `title` is unreachable by keyboard and invisible on touch.
- Every modal goes through one primitive (`openModal` in
  `packages/platform/web/src/lib/ui.ts`): Escape closes it, Tab is trapped inside it,
  focus lands on the first control on open and returns to the opener on close,
  and a confirm dialog's default focus is Cancel.
- Where a screen repeats a control — Delete per ring, Run per story —
  each instance names its object with an `aria-label`. Every input has an
  accessible name from a `<label>` or an `aria-label`; a placeholder is never
  the only name.

## Contract changes

Update this file in the same change when altering:

- cross-component state or status meanings;
- runner or remote-client protocol behavior;
- role requirements or token scope;
- suite snapshot, review, findings, event, or retention semantics;
- secret delivery or trust boundaries;
- hosted UI judgment and evidence rules.

Route additions, migration columns, environment variables, module moves, tests,
implementation history, and deployment plans do not by themselves belong here.
