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

`PLAYTEST_DISPATCH` selects one placement adapter for the deployment, and an
unrecognized value fails startup rather than silently meaning GitHub. GitHub
dispatch (the default) uses one workflow per run group or standalone mint and
binds executors through GitHub OIDC. `PLAYTEST_DISPATCH=local` starts the real
runner agent as a child process for local development and exercises the same
executor protocol. `PLAYTEST_DISPATCH=pool` places work on self-hosted runners
that claim it outbound (see "Runner pool"). All three implement one adapter
interface, so run-group lifecycle, the dispatch ledger, and the reconciler do
not vary by adapter. Dispatch is placement; it is not the system of record or an
artifact store.

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

`OBJECT_STORE_URL` remains the expert override for S3 or a separate mount, and
`PLAYTEST_DB_FILE` overrides the database path. Overriding either splits durable
state across locations; a backup is then incomplete unless it covers both.

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
recursively, no insignificant whitespace); two logically equal documents are now
byte-equal. Timestamps are UTC epoch-millisecond integers and are rendered as
ISO-8601 `…Z` strings at the API boundary. Per-day aggregation buckets are UTC.
Booleans are constrained `0`/`1`. Identifiers remain server-generated ULIDs, so
feed cursors and audit keyset pagination stay time-ordered.

## Platform invariants

1. A hosted suite is stored as files, not as a second semantic model. The same
   core discovery, resolution, validation, and linting code used by the CLI
   processes hosted suites.
2. Every committed suite mutation creates an immutable snapshot. A run group
   pins one snapshot, so later edits cannot change an in-flight or historical
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
never an authorization signal — today `capabilities.llm`, the platform LLM
gateway behind story drafting, study synthesis, and candidate consolidation,
and `capabilities.auto_dedupe`, whether that gateway plus the
`PLAYTEST_AUTO_DEDUPE` toggle has automatic post-run finding dedupe on. The
console uses them to present those affordances as unavailable-and-why instead of
offering a control the server cannot answer; the routes still enforce roles.

Project roles are cumulative:

```text
admin >= developer >= reviewer >= editor >= viewer
```

- `viewer` reads projects, suites, runs, evidence, and findings.
- `editor` edits ordinary suite files, launches runs, runs study synthesis, and
  manages project personas.
- `reviewer` accepts or rejects baseline candidates and triages findings —
  confirming, rejecting, merging, resolving.
- `developer` manages executable suite files, environments, auth providers, and
  the self-hosted runner registry (`viewer` may list runners).
- `admin` manages membership and project-wide administration, including
  permanent project deletion (`DELETE /api/v1/projects/:p`). Retention is a
  deployment-wide policy set by operators, not configured per project; legal
  holds no longer exist.

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

1. resolves and selects cases through core;
2. validates the requested environment and discovery policy;
3. pins the suite snapshot and current baselines;
4. creates a run group plus one run row per selected case;
5. creates a dispatch ledger entry;
6. asks the configured placement adapter to start the runner agent.

A launch may pin its placement: `runner_labels` on the launch request (and on
its preview) overrides the environment's `runner_labels` for that group alone.
It takes the role that launches (`editor`) and no other, because labels are
routing and never authority — a runner reaches only jobs in the project its
credential is registered to, so choosing which of that project's runners takes a
run is the same decision scope as running it at all. Absent means "follow the
environment"; an explicit `[]` is a decision, not an absence, and means "any
runner in this project". The pin is recorded on the group (`runner_labels`, null
when unpinned) and places every later attempt of that group — a continuation
after a partial completion, an in-place retry — even if the environment's labels
change in between. `GET /api/v1/run-groups/:id` states the outcome in
`placement`: the attempt's `labels` and whether the launch or the environment
chose them (`labels_source`). The launch preview reports the same pair before
anything is created.

Run-group states are `queued`, `running`, `done`, and `canceled`. Case states
are `queued`, `running`, `uploading`, `pass`, `fail`, `infra`, `explored`,
`canceled`, and `lost`. Modes are `record`, `act`, `heal`, and `explore`.

The database stores list and trend projections copied from the reported manifest.
It must not reinterpret or enrich core manifest fields in place. Bundle
integrity is checked against the reported size and SHA-256 before the run can
be considered complete.

Cancellation stops new case starts and asks the placement adapter to terminate
the active executor. A dead executor cannot strand a group indefinitely: the
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
automation clients. Its completed result preserves the hosted run-group
projection.

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
and environment passes. The `suite` and `status` filters compose with it.

## Runner protocol

The runner authenticates and then uses only HTTP:

1. `POST /runner/exchange`
2. `GET /runner/groups/:group`
3. snapshot tree, blob, baseline, and session-claim reads
4. case start
5. case progress (optional, throttled)
6. bundle upload
7. case report
8. group completion

Runner routes are under `/api/v1`; the abbreviated paths above identify the
protocol rather than a second namespace.

An exchange binds one executor to one active dispatch. In GitHub mode, the
signed OIDC token must match the configured issuer, audience, repository,
workflow, ref, and workflow run. In pool mode the runner presents its
registration credential plus the dispatch it claimed. Local development uses an
explicitly enabled insecure exchange. The returned bearer is short-lived and
scoped to exactly one run group or mint claim; group and mint tokens are not
interchangeable.

The group spec includes only the selected cases, pinned snapshot, baseline
references, resolved environment, session requirements, execution limits,
concurrency policy, and model configuration needed by that group.
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

## Runner pool

Under `PLAYTEST_DISPATCH=pool` the control plane never starts or contacts an
executor. A self-hosted runner — long-lived on a developer machine, or ephemeral
inside a CI job — authenticates outbound, advertises labels, and claims work.
**No inbound connection to a runner exists anywhere in this design.** The pool is
a third implementation of the placement-adapter interface: dispatch rows, the
reconciler, and run-group lifecycle are the same ones every other adapter uses.

**Identity is not routing.** Two things stay separate:

- The **runner credential** proves identity. It is minted once at registration,
  shown once, stored as a hash like an API token, and is the only long-lived
  secret on the runner's machine. It scopes the runner to exactly one project.
- **Labels** route work. They are not secrets, confer no authority, and appear
  freely in environment settings and console UI. A runner may re-advertise its
  labels at check-in; that changes which of its project's jobs match it, never
  which project it can reach.

Registration is project-scoped: `POST /api/v1/projects/:p/runners`
(`developer`) returns the runner plus its one-time credential, `GET` the same
path (`viewer`) lists name, labels, last-seen and current claim, and
`DELETE …/:r` (`developer`) revokes. Revocation is a timestamp, not a delete:
the row and its history remain, future check-ins, claims and exchanges are
refused, and a group already exchanged finishes under its already-issued scoped
bearer. Revoking twice is a no-op. Registration, revocation, and every claim
write audit rows. Runner names are unique per project.

**Ephemeral CI runners.** `POST /runner/pool/register-oidc` is the second way to
join a project's pool: a CI job presents its GitHub Actions OIDC token instead of
a credential it was given in advance, and receives one that expires with the job.
No long-lived runner secret lands in repository settings.

- The token is judged by the **same verifier** the GitHub-dispatch exchange uses
  (issuer, audience, repository, workflow file, ref, expiry, signature against
  the issuer's JWKS). The pins are their own deployment variables
  (`PLAYTEST_POOL_OIDC_REPOSITORY`, `…_WORKFLOW`, `…_REF`, `…_AUDIENCE`) because
  a pool deployment configures no GitHub App at all, so inheriting a null
  repository pin would accept a token from any repository on GitHub.
- **The route is closed until a repository is pinned.** Without
  `PLAYTEST_POOL_OIDC_REPOSITORY` it answers `503 not_configured` naming the
  variable, and so does a deployment not running `PLAYTEST_DISPATCH=pool`.
  Half-configuration is a `ServerConfigError` at boot: a workflow or ref pin
  without a repository pin, or any of these variables outside pool placement.
  The pin is deployment-wide, so a deployment hosting projects for mutually
  untrusting teams leaves it unset until per-project pins exist.
- The registration is **ephemeral**: `expires_at` is `now + PLAYTEST_POOL_OIDC_TTL_S`
  (default 3600, floor 60, ceiling 21600 — GitHub's own per-job limit, because a
  credential outliving its job is a credential nobody is watching). An expired
  credential is refused at poll, claim and exchange exactly like a revoked one,
  with its own message. Expiry never interrupts work in flight: an exchanged
  group runs on under its already-issued scoped bearer.
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
[`docs/hosted-runners.md`](../hosted-runners.md) with a copyable workflow under
`examples/ci-github-actions/`. The unique label is load-bearing, not cosmetic:
two concurrent pull requests sharing one label would claim each other's jobs and
report green against the wrong build.

**The claim board.** A `requested` dispatch row plus its labels snapshot IS the
board entry; posting to the board performs no network call and writes no new
entity. The labels snapshot is written in the same transaction as the ledger
row, so an entry is never readable before its routing is durable. The three
runner-credential-authenticated routes are:

1. `GET /runner/pool/claims?wait=true[&labels=…]` — check in and long-poll. The
   answer is the oldest unclaimed dispatch in the runner's project whose label
   set is a subset of the runner's, of kind `group` **or** `mint` (session
   minting places through the same path and must be served). An empty job label
   set matches any runner in the project. Held reads follow the event feed's
   discipline: post-commit wake, bounded rescan, correctness from the durable
   row. The poll only offers; two runners woken by one signal both see it. A
   runner that already holds a claim is offered nothing and is handed that claim
   back instead, which is how an agent restarted mid-group finds its work.
2. `POST /runner/pool/claims/:dispatch` — claim it. One `BEGIN IMMEDIATE`
   transaction restates the whole precondition in the mutating `WHERE` (still
   `requested`, still unclaimed, not canceled, runner live and in this project,
   labels still a subset), so exactly one concurrent runner wins and the loser
   receives `409 conflict` and returns to polling. The winning claim stamps the
   runner, moves the dispatch to `scheduled`, and emits the same `run.status`
   provisioning event GitHub dispatch emits.
3. `POST /runner/pool/claims/:dispatch/heartbeat` — coarse group-level liveness
   between claim and completion, on the order of tens of seconds. Case-level
   telemetry remains the progress route. Only the claim holder may heartbeat it.

Delivery order is oldest-first per project; v1 makes no stronger fairness
promise. One runner executes one group at a time: holding an active claim is
part of the claim precondition, so a runner cannot take a second job and starve
the fleet, while re-claiming the job it already holds is idempotent.

**Claiming assigns, exchanging authorizes.** A credential alone resolves no
dispatch, so it can never fetch a snapshot, a blob, a session grant, or post a
report. After winning a claim the runner enters the unchanged protocol at
`POST /runner/exchange` with its credential and `dispatch_id`, and receives the
same short-lived bearer scoped to that one run group or mint claim. A runner
that did not claim a dispatch cannot exchange for it. Because that boundary is
the pool's whole security model, `PLAYTEST_DISPATCH=pool` refuses to boot with
`PLAYTEST_RUNNER_INSECURE_EXCHANGE=1` (`ServerConfigError`), and pool mode
disables the development insecure exchange even under `PLAYTEST_AUTH=dev`.

**Liveness and loss.** The adapter reports claim and heartbeat state as run
status, which is what lets the existing reconciler treat a dead self-hosted
runner exactly like a vanished GitHub workflow. It has two loss shapes:

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
`attempt`, the `isolation` its executor reported, the `runner` that claimed it
(`null` for adapters that place work without a registered runner), and the
`labels` that attempt was placed on with their `labels_source`
(`launch` when the launch pinned them, `environment` otherwise).

### The pool runner process

`runner-agent pool --server <url> [--labels a,b] [--isolation process|container]
[--work-dir <dir>] [--credential-file <path>]` is the long-lived agent, beside
the existing per-group `exec` and `mint` entries. Its loop is check in →
long-poll → claim → exchange → execute through the unchanged group or mint
executor → complete → poll again.

- **The credential never rides argv.** It arrives in `PLAYTEST_RUNNER_CREDENTIAL`
  or in a file named by `--credential-file` / `PLAYTEST_RUNNER_CREDENTIAL_FILE`,
  so it cannot be read out of a process list. Offering it as an argument is
  refused with the remedy.
- **The first check-in does not hold**, so a misconfigured runner is diagnosable
  at once: startup output states the runner name, project, server, labels,
  isolation, work directory, and that it is waiting for work. Later check-ins
  long-poll.
- **A refused credential stops the process** with one actionable line (401/403 —
  unknown, or revoked). Any other failure to reach the control plane is retried
  with exponential backoff and jitter, reported once per outage rather than once
  per attempt. A lost claim race (`409`) is not an error and is not backed off.
- **One group at a time**, and a runner restarted mid-group resumes the claim the
  board still says it holds instead of abandoning it.
- **Cancellation and shutdown share one path.** A `canceled` heartbeat aborts the
  group exactly as `SIGTERM` does: stop starting cases, stop what is in flight,
  report what exists, post a best-effort completion. `SIGTERM` while idle exits
  immediately; `SIGTERM` mid-group finishes that teardown first, then exits.
- **A failed group never takes the runner down.** The executor posts its own
  completion carrying the error; the agent reports one actionable line — never a
  stack — and returns to the board.

## Script authoring jobs

Authoring is a **runner-agent job type**, dispatched like a run group and
isolated by the same boundary. It is not a run: it produces no trajectory, no
baseline, and no grade — it produces one script artifact bundle
([Script contracts: the authoring bundle](scripts.md#the-authoring-bundle)).

| Property | Value |
|---|---|
| dispatch | one job per suite, never concurrent with another authoring job for the same suite |
| input | the resolved environment (target + secret references), the recorded target authorization, the spec provisioning declaration, the approved rule statements with their notes, and the budgets |
| model | the environment's configured actor model, reached through the ordinary gateway; no agent SDK, no tools ([Model selection](#model-selection)) |
| output | the bundle, uploaded whole: script, transcript, final HAR, final report, and the handout it was authored from |
| terminal states | `sound` — the suite is sound and ready for review — or one of `iterations`, `requests`, `wall_clock`, `model_error`, each naming the budget it hit |
| events | turn, rejection, and completion arrive on the feed like any other job progress; no polling |

Three refusals belong to the control plane, before any job is dispatched:

- **no recorded target authorization for the exact resolved origin** — the job
  is refused with the actionable configuration error, and nothing reaches the
  target ([Script contracts: target authorization](scripts.md#target-authorization));
- **no resolvable OpenAPI document** — spec provisioning is a configuration
  error, never a degraded job
  ([Script contracts: spec provisioning](scripts.md#spec-provisioning));
- **an unapproved rule statement** — only human-approved sentences reach a
  handout, enforced structurally rather than by prompt (`DESIGN` N6; see
  [Rule cards](#rule-cards)).

The authored suite arrives **pending**, never approved: authoring produces
content for review, and the approval lifecycle (S4) is what licenses it to run
again. A failing check in the bundle is a candidate finding for the reviewer,
not a failed job.

## Rule cards

Level 1 of the invariant ladder
([Script contracts: invariant levels](scripts.md#invariant-levels)) as hosted
state and a review surface. Level 0 has no storage and no switch: the four
default policies are code, always on, and reported here read-only so a person
can see what their suite is judged against before deciding anything.

**The shipped claim is assisted authoring, not zero input.** S0's proposal trial
cleared precision and detection but its suite found 8 of 13 sealed faults
against 11–12 for suites given the rules (`DESIGN` §7.1), so the surface says
*"review and confirm your API's rules"* and never that the platform discovered
them. The console's copy lives DOM-free in `packages/platform/web/src/lib/rule-cards.ts`
and the offline gate asserts the sentences that carry that promise — a change
that re-inflates the claim fails a test rather than a review.

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

**Only human-approved sentences are enforced, and the rule is a query rather
than a convention** (`DESIGN` N6). `approvedRuleCards(db, suiteId)` is the only
path from this table to an authoring handout; its predicate is
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
| `GET /suites/:s/rule-cards/handout` | viewer | the approved statements exactly as an authoring job will receive them — the same function, not a parallel rendering |
| `POST /suites/:s/rule-cards/propose` | editor | the model call; drafting, so it is an editor act |
| `POST /suites/:s/rule-cards` | reviewer | add-your-own: a sentence a person wrote lands `approved`, because writing it is approving it |
| `PATCH /rule-cards/:rc` | reviewer | statement, applicability, exceptions, note |
| `POST /rule-cards/:rc/approve` \| `/deny` | reviewer | the state change, with an optional note in the same call |
| `DELETE /rule-cards/:rc` | reviewer | `authored` cards only; a proposed card is denied |

Every mutation writes its audit row and its `rule_card.*` platform event inside
the same transaction, and the console repaints off the feed — no polling.

The proposal call takes the OpenAPI document as an upload or a paste. **The
control plane does not fetch a spec URL and does not auto-discover:** reaching a
user's target belongs behind the runner-agent boundary, and spec provisioning
from environment configuration arrives with the hosted authoring job. A
deployment without the LLM gateway answers `503 not_configured` and the console
says so while still offering write-your-own.

## Script execution boundary

Script suites ([Script contracts](scripts.md)) execute in the runner-agent, and
their isolation is a contract with escape tests rather than an assumption. Two
processes, and the split is the whole guarantee:

- The **proxy process** is the runner-agent job itself. It resolves the
  environment's secret references, owns the only socket to the target, and
  enforces the wire tier — origin lock, the read-only default, the request
  budget, secret substitution, and HAR recording.
- The **script process** is a child with no credential in its environment, no
  ambient network, no filesystem, no subprocess, and no dependency resolution.
  It reaches the target only through the proxy's loopback control channel,
  authenticated with a per-run token, and it writes no artifact: the HAR and the
  report are produced by the proxy process.

Network isolation of the script process — that it cannot bypass the proxy and
open its own socket — is the runner-agent sandbox's responsibility, delivered by
the same per-case container isolation the [Runner protocol](#runner-protocol)
already requires. The substrate's unconditional guarantee is narrower and
stronger: such an escape yields no credential, because none is present in the
child, and the proxy's guards are unaffected by anything happening inside it.

A mutating script suite is dispatched only against a target whose write grant is
recorded and current; without one the client refuses every non-`GET`/`HEAD`
request at the wire. The grant is target authorization, never script content.

The adversarial battery that proves this boundary ships with the package that
owns it (`packages/platform/runner-agent/tests/unit/`) and covers ambient `fetch`,
`node:http`/`node:net`, alternate-origin and DNS access, `process.env` reads,
filesystem escape, `child_process`, direct report fabrication, and credential
exfiltration through URLs, bodies, logs, and thrown exceptions. Each attempt
must be blocked or provably credential-free; a change that weakens one is a
contract change here.

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
suite settings. Consolidation — which now also runs automatically per project
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
the shared environment overlay so one concurrent case cannot restore it while
another is still running; persistent runners keep per-case container isolation.

## Environments, secrets, and target authentication

An environment supplies a named overlay, runner capability labels, secret
references, auth-provider bindings, and whether discovery is allowed. The
runner materializes the overlay and delegates merge precedence to core.

For a mobile suite the overlay also carries the device target — `config.app`'s
`platform`, `app`, `device`, and `appium_url` — because all four belong to the
machine the device is attached to rather than to the suite. `app` is a plain
path on that runner's own disk: the platform never uploads, stores, or ships an
app binary, and the suite snapshot carries only the authored suite files. A
mobile environment is therefore only launchable on a runner whose labels reach
the machine holding that build.

An environment is owned either by the project or by one suite. A project-owned
environment (`suite_id` null) is a deployment ring every suite may launch
against. A suite-owned environment is visible and launchable from its own suite
only, is refused for any other suite at launch and at preview, and is deleted
with the suite. Both are the same row, the same API, and the same
`run_groups.environment_id`: ownership decides who may choose it, never how it
is materialized. Names are unique per project across both scopes, because the
name is the `app.envs.<name>` overlay key and the CLI's `--env` argument, and
one name must mean one target inside a project.

Every project has an environment named `default` — created with the project,
backfilled for existing ones that had none. It carries no URL of its own, so a
launch against it resolves to whatever `app.base_url` each suite declares. That
is what makes a suite's own base URL selectable at launch rather than a fourth
thing to reason about, and it is why a project with no rings configured can
still run.

Secret values are encrypted at rest and write-only through the API. The root
encryption key is external to the database. Losing it makes stored secrets and
minted sessions unreadable; changing it does not re-encrypt existing values.

Auth providers have three supported forms:

- `storage_state_secret` reads an existing Playwright storage-state secret.
- `token_endpoint` exchanges provider credentials for a session.
- `script` executes trusted login code in runner isolation.

Session artifacts are encrypted, expiring, and cached per provider and
identity. Concurrent requests for the same missing session share one pending
mint. Stories select identities with core `app.auth`; `auth: none` always means
signed out and cannot be replaced by a default environment identity.

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
into the finding it duplicates. There are no candidate routes: the former
`/api/v1/bug-candidates/*` and `.../confirm-suggestion` endpoints are removed,
and the console reaches unreviewed findings as a filter of the Findings list
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

Retrieval thresholds are server configuration, not constants: the right value is
a property of a project's candidate corpus, not of the algorithm. The defaults
below were measured against the fixture corpus
(`tests/support/findings/README.md` records the scored pairs and the baseline).
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

Two of those carry rationale worth keeping. The **floor** is the midpoint of the
measured gap between duplicates and everything else on the P0 corpus (weakest
duplicate 0.316, strongest unrelated pair 0.175), so it holds the same margin
against a slightly weaker duplicate as against a slightly stronger coincidence.
The **auto-suggest threshold** deliberately sits above every measured duplicate
(maximum 0.495): in the first release, word overlap alone never bypasses
verification — a duplicate either matched a deterministic exact key at intake or
it goes to a reviewed cluster call. Changing either is a measurement rather than
a guess, because `consolidation_labels` records every reviewer confirmation,
edit, and rejection together with the deterministic score that produced it.

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

**Resolution is per (suite, environment, case).** One finding's evidence
legitimately spans suites and environments, and one story fans out into one
case per persona, so the affected set is *derived* from evidence — the
distinct `(run_groups.suite_id, run_groups.environment_id, runs.case_id)`
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
audit log exactly as its console equivalent. A concrete first-party tracker
integration may return later only with measured demand and its own design.

## Authoring and study synthesis

Story authoring uses inline, stateless AI drafting. The story form offers **Help
me draft**: one editor-authorized request (`POST /api/v1/suites/:s/story-draft`)
drafts or improves stories from a plain-language goal, a short browser-held
clarification transcript, and — when improving — the existing story path and
YAML. The server derives context from current suite state (defaults, compact
story summaries, personas, and environment names/base URLs) and never sends
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
(`packages/core/src/public/api-suite-scripts.ts`) so the CLI and a future runner-agent job share
one instrument. Like every other model call here it decides nothing:
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
   operator action. This is the property the removed in-process flag could not
   provide.
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

- `full`: the complete bundle, including heavy media and traces;
- `core`: manifest, trajectory, grade, text evidence, and timing captions;
- `meta`: database projections only.

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

Objects whose owning rows were dropped by a schema migration are **not** covered
by that cleanup, and no shipped tool enumerates or retires them. The
simplification dropped the `insights` table, so any Markdown report object a
pre-simplification deployment stored under an `insights.report_key` is now
unreferenced and stays in the object store. Retiring those keys is an operator
responsibility: enumerate the keys from
a pre-migration database dump and delete them individually. Blind prefix deletion
of the object store is never acceptable.

The same conservatism binds the migration that creates such orphans: never
silently drop a non-empty feature table or the objects it references. Census
first. The simplification's unconditional drops were permitted only by an
explicit operator waiver of data preservation for one deployment, which is not
precedent for the next.

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
  and a suite table showing latest result and open-finding count. The legacy
  suites-index URL redirects to this project home;
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
  and nowhere to go. The narration that used to open the dashboard
  ("provisioning capacity…", "executor connected…", the plain-words verdict
  once it ends) heads the expanded stories. A run's own URL
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
- Settings exposes exactly six sections: **Test targets** (environments —
  discovery permission, runner labels, browser cookies (`config.app.cookies`,
  sent on every web run against the ring), auth identities, and secret
  references, with the fallback base URL, provider, and raw environment JSON
  behind Advanced; a suite's own environments are listed here too, marked with the
  suite that owns them), **Runners** (`developer`: register a self-hosted runner,
  list what each advertises and when it last checked in, revoke), **Runs**
  (project concurrency), **Models**
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
- A suite's mobile **App binary** field is optional and means a file inside the
  suite tree (a small fixture app). Real builds exceed the suite upload caps, so
  the copy directs the usual case to the environment instead — a path on the
  runner that executes the suite.
- Every page's `nav:` value resolves to exactly one rail item through
  `railFor` (`packages/platform/web/src/lib/nav.ts`). Surfaces that live under a rail
  item say so: the suite page, story editor, suite settings, Versions and run
  history map to Suites; the changed-stories queue maps to Runs. A page that
  lights up no rail item is a bug, and the hermetic gate asserts the mapping.
- System health is a status bar, not a page. Inside a project, a thin always-on
  footer (`packages/platform/web/src/lib/statusbar.ts`) states whether this console is
  live and — for developers — dispatch depth against the cap, GHA queue wait,
  reconciler liveness, and model spend; the dispatch ledger opens in a drawer
  over the page. It replaces the folded "Operations" section that used to sit
  under the Runs table, because health that has to be opened is health nobody is
  watching, and it is needed wherever a person happens to be when a run feels
  slow. The words and tones are DOM-free in `lib/ops-status.ts`. Nothing here is
  a new API surface: the bar reads `GET /projects/:p/ops` and
  `GET /projects/:p/dispatches`, both still developer-only, and non-developers
  see only the feed indicator. It stays live off the event feed (§ Events and
  long polling) — a refetch when anything moves, plus a slow safety refresh,
  paused while the tab is hidden, for the numbers that decay with the clock
  rather than with events (a dead reconciler emits nothing, which is exactly
  when its lag matters).
- Below the supported minimum width the console shows a desktop-requirement
  message instead of a clipped rail and tables. It keeps the top bar and offers
  "Continue anyway", which sets `data-scope="wide"` and renders the console at
  that width. Responsive/mobile redesign of the admin console remains out of
  scope; the applications Playtest tests may still be mobile.
- The console authors stories and the suite's shared defaults; it is not a file
  manager. A suite's `playtest.yaml` is edited on **Suite settings**
  (`/p/:key/suites/:slug/settings`) as a form with a YAML view of the identical
  bytes — the same discipline as the story editor, applied through
  `packages/platform/web/src/lib/defaults-form.ts`, so comments and unedited keys survive.
  Personas, hooks and assertions are code-tier files: they arrive and leave as a
  `.tar` (Import/Export) and are edited with the CLI. The raw file tree
  (`/p/:key/suites/:slug/files`) is gone and redirects to Suite settings.
- **API rules** (`/p/:key/suites/:slug/rules`) is the suite's rule cards
  ([Rule cards](#rule-cards)), reached from the suite's overflow menu. It is not
  gated on anyone having approved a card: every suite already has the Level 0
  set, and the page's first job is to say so. The page opens with what is
  enforced today, then the cards to review, then approved, then denied — the
  order a person reads them in — and each card carries its one-line provenance,
  approve / not-a-rule / edit, and a note field that travels to the test author.
- A suite declares where it runs; an environment declares the ring it runs in.
  An environment owns the credentials, runner pool and discovery permission
  shared by every suite pointed at that ring; its base URL is a *fallback* for
  projects that test one app, edited behind Advanced. Which host a given suite
  reaches inside a ring is the suite's to set, on Suite settings, as one row per
  environment writing `app.envs.<name>.base_url` — and, for a web suite, the
  cookies it sends there (`app.envs.<name>.cookies`, applied by core wholesale
  over the suite-default `app.cookies`; the default row edits `app.cookies`
  itself). Each row states the URL it resolves to and why, mirroring the
  dispatcher's precedence — which is unchanged, and which cookies follow:
  `suite env overlay` → `environment fallback` → `suite default`.
  The launch dialog names the resolved target and which of the three won.
- Suite settings holds one **Environments** table rather than a base-URL field
  and a separate per-environment list: the suite's own URL (`app.base_url`) is
  the `default` row, the project's rings follow under "Shared with every suite",
  and the suite's own environments follow under "This suite only" with the
  control that adds and removes them. Every URL field on that page writes this
  suite's `playtest.yaml` and lands with Save, including the ones for suite-owned
  environments; the environment record itself is a project-level object and is
  created or deleted immediately, which the confirmation and the toast say out
  loud. Adding or removing an environment needs the developer role even though
  the rest of Suite settings is an editor's, because an environment can
  reference credentials.
- The launch dialog offers only the environments the chosen suite may use, and
  each option names the host it resolves to (`staging · staging.acme.test ·
  discovery`) rather than the environment's own URL, which is not necessarily
  the one a launch will use. Switching suites re-derives the choice, since a
  selection can belong to a suite that no longer applies. Directly beneath that
  control — as the answer to what the chosen name means here — the dialog states
  the full resolved URL, which of the three sources won, and, for a suite-owned
  environment, that no other suite can launch against it.
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
- `app.base_url` is a suite-level setting and the New suite dialog collects it
  (or, for the mobile driver, the app binary), because core resolves every case
  against the suite's defaults: until one exists no story in the suite can be
  saved or run. A suite that lacks one says so on the suite page and in the
  story editor's checks, with a link to Suite settings.
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
  API resource stays `candidates`). "Suspected bugs" and "bug candidate" are
  retired words: a machine-filed defect claim is a finding that needs review.

## Web experience invariants

- Primary copy says story, suite, and run. "Journey" is reserved for the
  recorded path being compared, and "case" and "run group" do not appear in the
  interface at all — a person launches a run, of some stories, against an
  environment.
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
  dialog's action. The launch dialog never preselects an environment named like
  production: it defaults to where the suite last ran, else one that allows
  discovery, else the first non-production one — preferring, among those, an
  environment this suite actually resolves a URL for, since one it doesn't
  cannot run at all.
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
  application — which environment, and whether the agent drives — with the plan
  and the estimate beside Launch itself. Which suite and which stories are
  context under the title, not controls: a launch scoped from a story row or the
  story editor (`selection.ids`) says so and stays scoped, since widening it to
  the whole suite is a different launch a click away on the suite. Per-story
  step and timeout overrides are a disclosure whose summary already states the
  limits in force, so folding them away hides no budget.
- A run that produced no verdict (`infra`, `canceled`, `lost`) is presented as
  "didn't run" in amber with a plain-English cause and a retry, never as a
  product failure, and does not offer to file a finding.
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
- Where a screen repeats a control — Delete per environment, Run per story —
  each instance names its object with an `aria-label`. Every input has an
  accessible name from a `<label>` or an `aria-label`; a placeholder is never
  the only name.

These invariants are authored and reviewed by hand. The repository has no
browser harness that loads the hosted SPA and no accessibility (axe) harness, so
nothing here about rendering, keyboard operation, contrast, or focus is
machine-verified. What *is* asserted hermetically, in
`packages/platform/web/tests/web-ia.test.ts`, is the information
architecture above: the four nav items and their targets, the rail item every
page's `nav:` value resolves to, the Settings sections and their role
disclosure, the finding buckets and their state mapping, the display vocabulary
for every engine enum a person can see, redirect targets for removed surfaces,
and secret masking. `tests/unit/web-run-stats.test.ts` asserts the run
arithmetic and its words: that the three payload shapes agree on the same run,
that a changed pass is counted once rather than twice, that an unsettled run
reports no wall clock, and that a run holding a failure never reads as a plain
"done". `tests/unit/web-statusbar.test.ts` does the same for the
status bar's vocabulary — including the rule that every unhealthy state (a
silent reconciler, a queue at its cap) is legible as words and not only as a
colour. `tests/web-runners.test.ts` pins the runner surface's two load-bearing
properties: the exact start command (credential in the environment, never in an
argument) and the one-time reveal. Treat any claim of verified accessibility as unmade until
such a harness exists.

`tools/ux-lab` is the manual counterpart: it boots the control plane against a
throwaway data root, seeds it through the public API and the real runner
protocol, and walks every surface with Playwright in both themes. It is a
workbench for looking at the console, not a gate — nothing in CI runs it.

That inventory is assertable only because the IA is DOM-free by design: nav,
Settings sections, redirects, finding buckets, display vocabulary, status-bar
vocabulary, and secret masking live in plain modules under
`packages/platform/web/src/lib/`. Keep them there.

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
