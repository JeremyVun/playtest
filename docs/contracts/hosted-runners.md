# Hosted runner contracts

This file owns placement, claim, executor, isolation, upload, and runner trust
boundaries. [Hosted platform contracts](hosted.md) own run and target state;
[Interface contracts](interfaces.md) own the runner CLI and configuration file.
Operational setup belongs in
[Self-hosted runner guidance](../guidance/hosted-runners.md).

The route inventory in `control-plane/src/routes.ts`, executor error registry,
and runner protocol types remain executable sources of truth. This contract
records behavior shared across those components. Abbreviated runner paths below
are relative to `/api/v1`.

## Placement and dispatch

The claim board is the only placement model. A launch writes a `requested`
dispatch with immutable label and target snapshots. The control plane starts no
process and opens no connection to a runner. Local, CI, and fleet runners poll
outbound, claim, exchange, execute, and report through the same protocol.

One dispatch-state module owns dispatch creation, exchange, reconciliation,
cancellation, and terminal transitions. Every transition is a compare-and-set
from named states; a loser reads the state that won. Terminal dispatch and
group states are monotonic except for an editor's explicit in-place retry of an
eligible finished group.

Attempt allocation and dispatch creation are one transaction. `attempt` is the
generation of `(kind, ref_id)`. SQLite enforces:

- unique `(kind, ref_id, attempt)`; and
- at most one active group dispatch, where active means `requested`,
  `scheduled`, or `running`.

Changing the active-state definition requires changing the partial index and
state machine together.

## Executor exchange and fencing

A runner can exchange only a dispatch it claimed. It presents its registration
credential and dispatch id; the server returns a short-lived bearer scoped to
one run group or mint claim. A registration credential alone grants no suite,
secret, session, or report access. Group and mint bearers are not
interchangeable, and no auth mode bypasses exchange.

An exchange atomically inserts an executor, binds it immutably to the dispatch,
sets the dispatch's mutable current-executor pointer, and advances dispatch and
group state. Eligibility is revalidated inside the transaction. A second
exchange by a crash-resumed claim holder installs a new executor and immediately
fences the old bearer.

Every executor route shares one current-owner guard. It verifies:

1. the executor and dispatch exist and are linked;
2. the bearer scope matches the route and group;
3. the dispatch state permits the operation;
4. the dispatch still points to this executor; and
5. the group has not settled.

Writes reassert the same facts inside their transaction. Replacement, cancel,
or reconciliation landing after the route guard therefore fences the stale
write. Bundle uploads use attempt-specific object keys and publish the artifact
row only inside this fenced transaction; refused publication removes its staged
object.

All stale-ownership refusals are `409 executor_conflict` with a
machine-readable `details.reason`:

| Reason | Meaning |
|---|---|
| `unknown_executor` | The bearer names no executor. |
| `scope_mismatch` | Mint and group scopes were crossed. |
| `executor_replaced` | A later exchange installed another executor. |
| `dispatch_not_active` | The attempt ended or was canceled. |
| `group_settled` | The group is done or canceled. |
| `run_not_owned` | Another executor owns the story. |

A bearer for another group remains `403 forbidden`. On
`executor_conflict`, the runner stops that work without retry, report, or
completion and returns to the board.

`runs.executor_id` records story ownership. Case start claims a queued story by
compare-and-set. Progress, bundle upload, and report require that owner. A
started story is never handed to a replacement executor; reconciliation or
completion resolves abandoned work. A terminal report may claim a never-started
story so an executor can report pre-execution infrastructure failure.

Completion remains idempotent for the current owner after its dispatch
concludes, but not after reconciliation declares it dead or the group is
canceled.

## Group execution protocol

After exchange, the runner uses HTTP to read the group spec, materialize its
pinned snapshot and baselines, resolve sessions, start stories, optionally post
progress and live evidence, upload bundles, report stories, and complete the
group.

The group spec contains only selected cases, pinned references, the attempt's
application and ring snapshots, resolved secrets, session requirements,
limits, concurrency, models, and upload policy. The target snapshot cannot
change when its ring is edited mid-run; only secrets resolve at serve time.
Executors never receive database credentials or platform-wide secrets.

The runner materializes the ring overlay as `app.envs.<ring key>` and applies
its URL as a core [runtime target](engine.md#runtime-target). Hosted execution
replaces authored physical target fields. Per-launch `max_steps` and
`timeout_ms` replace resolved story limits in executor memory without changing
the snapshot.

Case execution is isolated:

- fresh development and ephemeral machines may use process isolation;
- persistent shared runners use one container per case;
- a case sees only its image, workspace, and delivered environment;
- root auth-provider credentials exist only during minting; and
- cases receive derived sessions, not provider credentials.

Every case runs as a child process through one JSON/NDJSON protocol: one payload
on stdin, progress events, then one result. Container mode translates the
workspace to its mount; process mode uses host paths. Per-case environment is
delivered through spawn environment or structured input, never argv or mutation
of the agent's process environment.

### Cancellation and shutdown

Group cancellation, agent `SIGTERM`, and `executor_conflict` share teardown:

- container cases receive bounded `docker stop` then `docker kill`;
- process cases lead detached process groups and receive `SIGTERM`, then
  `SIGKILL` after the five-second grace period;
- mobile Appium remains agent-owned for the group and is reached over loopback;
- stopped cases are `canceled`, regardless of a racing child exit; and
- dispatch conclusion fences later upload and report writes.

The runner releases listeners, timers, workspaces, and active-case registry
entries on every exit path. Shutdown while idle exits immediately; shutdown
during a group completes teardown first. A group-level failure is reported and
the long-lived agent returns to polling.

Case progress is optional telemetry. The executor folds engine events into a
small redacted snapshot: current step and budget, reporting mode/phase, latest
actor action, cost, token counts, and active model. It posts at a throttled
cadence. The control plane whitelists and clamps the shape, stores only the
latest value, and publishes a progress event. Terminal transitions clear it.
Progress never affects verdicts or protocol correctness.
The event is `run.event` with `payload.type: "progress"`.

Case start, upload, report, and completion are idempotent for the current
executor. A completion may be partial when the executor approaches its runtime
budget; only queued remainder is dispatched again. A report is accepted only
for its group, run id, and recorded executor owner.

## The platform evidence boundary

Every textual byte a runner sends is sanitized by one implementation, including
manifests, events, trajectories, grades, accessibility text, HAR bodies,
progress, and errors.

- Raw run directories stay unchanged on the runner.
- Bundles are sealed from sanitized staging trees; their index, sizes, and
  hashes describe the transmitted bytes.
- Artifact media type decides text versus binary. Unknown bytes containing NUL
  or invalid UTF-8 are binary; other unknown entries are sanitized.
- Live and sealed versions of the same entry must be byte-identical.
- Sanitization is deterministic and leaves unaffected bytes unchanged.

Secret needles include ring secrets, mint environments, external Appium
credentials, and every leaf value in a minted storage state. They become
`[redacted]`. Location keys such as cookie name/domain/path, origin, and URL are
not secret values. No non-empty configured secret is ignored for being short.

Runner-resolved build paths, devices, and Appium endpoints are physical facts,
not platform state. They become `<path>`, `<device>`, and `<endpoint>` and use a
minimum needle length to avoid destroying ordinary diagnostics.

Needles are matched in raw and JSON-escaped forms so rewritten JSON remains
valid. Secret values must not appear in logs, events, bundles, manifests, or
client errors.

## Live evidence

Live upload is optional and never load-bearing. A conforming runner may omit it,
making a run visible only after sealing. The routes share the group bearer,
current-executor fence, run-owner check, and evidence sanitizer:

| Operation | Meaning |
|---|---|
| `POST /runner/groups/:g/cases/:run_id/open` | `{ manifest }`: store the placeholder or current manifest snapshot. |
| `PUT /runner/runs/:r/live/<entry-path>` | Store one immutable `steps/<name>` artifact as bytes. |
| `POST /runner/runs/:r/live/trajectory` | `{ from_line, lines }`: append whole trajectory lines. |

Every answer is an explicit acknowledgement: `{ accepted: true, ... }` or
`{ accepted: false, reason, message, ... }`. Refusal reasons are `terminal`,
`not_open`, `shape`, `immutable`, `budget`, `gap`, `divergent`, and
`line_too_large`. Malformed envelopes use ordinary `bad_request`.
`executor_conflict` is checked before any acknowledgement.

Open is idempotent. It sets `live_opened_at`; its returned
`manifest_generation` changes only when bytes change and does not alter run
state. Entry paths cannot traverse, nest, or target `manifest.json`,
`trajectory.jsonl`, or end-of-run files. Repeating identical entry bytes
replays the acknowledgement without charging budget again; different bytes at
the same path are refused.

The trajectory ledger owns its next line count and returns it on every answer.
An append at the count succeeds. Overlap is hash-verified and deduplicated; gaps
and divergence are refused with the authoritative count. Body and line limits
refuse rather than truncate.

The group spec advertises live route templates and every limit under
`uploads.live`. A runner may reuse their paths against its configured server
origin.

Each case has one serialized upload queue. It sends completed artifacts,
trajectory lines that reference only acknowledged artifacts, then changed
manifest bytes. A transport error pauses at the same position. Gap or divergence
rewinds to the server count. An unrecoverable refusal or hopeless backlog stops
live upload without inventing skips; the sealed bundle remains complete.
Shutdown aborts the queue before reporting and workspace cleanup. Live upload
cannot change run outcome, order, timing, or sealed artifacts.

## Runner registry

Runner identity and routing are separate:

- A one-time registration credential proves identity. It is stored hashed,
  scopes the runner to one project or the whole site, and is the only long-lived
  runner secret.
- Labels route work. They grant no authority and may be re-advertised at
  check-in. Every accepting surface shares one validator: at most 32 labels,
  64 characters each, using letters, digits, `.`, `_`, and `-`.

Project registration requires `developer`; listing requires `viewer`.
Registration returns the credential once. Revocation is an idempotent timestamp,
not deletion: future polls, claims, and exchanges fail, while an already
exchanged group may finish and heartbeat under its scoped bearer. Names are
unique among live project runners, so revocation frees a name. Registration,
revocation, and claims are audited.

### Ephemeral CI registration

A GitHub Actions job may exchange a verified OIDC token for an expiring project
runner credential. No long-lived runner secret is required in repository
settings.

The deployment pins issuer, audience, repository, and optional workflow/ref.
The route is unavailable until a repository is pinned; partial configuration
fails startup. Signature, expiry, and all configured claims are verified.

Ephemeral credentials default to one hour, with a one-minute floor and six-hour
ceiling. Expiry blocks poll, claim, and exchange but does not interrupt work
already exchanged.
Ephemeral runners are excluded from standing-runner lists. Their names derive
from verified workflow-run claims, and stored/audited provenance includes
repository, workflow, ref, SHA, run id, and attempt. One workflow run may hold
at most eight live registrations per project.

CI should use a label unique to the pipeline run. Sharing a label between
concurrent builds can execute a run against the wrong build. The copyable flow
lives in [runner guidance](../guidance/hosted-runners.md).

## Claim board

The board entry is the dispatch row and its immutable snapshots. The runner
uses three credential-authenticated operations:

1. **Poll.** Check in and long-poll for at most eight oldest-first
   unclaimed group and mint dispatches whose required labels are a subset of
   the runner's advertised labels. A runner already holding a claim receives it
   as `current` and no offers. A page permits local compatibility checks without
   letting one unclaimable mobile offer starve later work.
2. **Claim.** In one `BEGIN IMMEDIATE` transaction, recheck dispatch state,
   cancellation, runner scope, credential liveness, labels, and absence of
   another claim. Exactly one caller wins; losers receive `409 conflict`.
3. **Heartbeat.** The current claim holder updates coarse liveness and learns
   cancellation. A revoked or expired runner may heartbeat only work already
   exchanged, preserving the promise that revocation grants no new work but
   does not kill accepted work.

Every offer and `current` entry has this wire shape. The target contains exactly
the seven fields shown and no runner-resolved build, device, or Appium fact:

```json
{
  "dispatch_id": "…",
  "kind": "group | mint",
  "ref_id": "…",
  "run_group_id": "… | null",
  "mint_claim_id": "… | null",
  "attempt": 1,
  "labels": [],
  "requested_at": "…Z",
  "claimed_at": "…Z | null",
  "project_id": "…",
  "project_key": "acme",
  "target": {
    "application_id": "app_…",
    "application_key": "todo-web",
    "ring_id": "ring_…",
    "ring_key": "local",
    "driver": "web | api | mobile",
    "platform": "ios | android | null",
    "base_url": "http://127.0.0.1:4173 | null"
  }
}
```

`target` is nullable. A project-wide mint has `target: null`; a ring-bound mint
carries that ring’s labels and target. Suite files and secrets never travel
before exchange.

A runner declines locally by including offered dispatch ids in its next poll's
bounded `skip` list. The server excludes them for that held read without
mutating or persisting the offer. Poll responses advertise the cap. The runner
clears skips after an empty poll so transient incompatibility is reconsidered.
The current cap is 64; sending more returns 400. Agents use the advertised
`skip_cap` and assume 64 only when talking to an older server that omitted it.

Delivery is oldest-first per project with no stronger fairness promise. One
runner holds one active claim. Claiming assigns work; exchange authorizes access.

### Presence and loss

Poll and heartbeat update `last_seen_at`, but the event feed publishes only
visible `runner.status` edges: `registered`, `revoked`, `online` or label
change, and `claimed`. Every payload names the runner and scope; claimed events
also name dispatch and group. Steady polling and silence emit nothing. Presence
is derived from
`last_seen_at` and the server-published check-in window, so console and
reconciler use the same threshold.

Heartbeat-stale claims are dead executors after 120 seconds by default:
unreported work becomes infrastructure failure and queued remainder may be
continued once. Dispatches never claimed within 600 seconds by default fail
with an actionable diagnostic distinguishing no registered runner, label
mismatch, no polling runner, and a silent claim holder.
The same reconciliation pass repairs a terminal group with any nonterminal
story rows: `done` groups resolve them as infrastructure failure, canceled
groups resolve them as canceled, stale progress is cleared, and the exit
summary is recomputed.

Loss and continuation mutations reassert their preconditions. A late executor
that completes before reconciliation wins. At most one group attempt is active,
so completion and reconciliation cannot create duplicate board entries.

Cancellation marks the claim canceled; the runner observes it on heartbeat and
tears down. Reports already accepted remain accepted.

Run-group placement names the newest attempt’s `dispatch_id`, `attempt`,
reported `isolation`, claiming runner, labels, and `labels_source`
(`launch` or `ring`). Reviewers can therefore tell which machine and isolation
produced the evidence.

## Site-scoped runners

Runner scope is a trust decision because a claimant receives suite files,
secrets, and executable hooks. Project scope is the default and the only scope a
project developer may grant. A site-scoped runner is explicitly trusted by a
site operator with every project; v1 has no per-project grants.

- It polls one board across all projects; every offer names its project.
- Its exchanged bearer still scopes to one claimed group or mint.
- It may hold one claim globally.
- Live site-runner names are unique in their own namespace.
- Revocation blocks future work across all projects but permits current work to
  finish.
- It counts as presence for every project it can serve.

Site runner lifecycle routes require the development-mode site-admin principal.
A project admin is insufficient, production site-admin provisioning and
site-scoped API tokens are deferred, and non-development deployments therefore
have no site runner administration.

Project runner lists include live project and applicable site runners. Revoked
runners disappear unless still executing, in which case they remain marked
revoked until the claim lands. Site-runner claims in another project are shown
as busy with claim identifiers redacted. Project users cannot revoke site
runners.

The project runner projection keeps one shape for project and site scope:

```jsonc
{
  "id": "…",
  "project_id": null,
  "scope": "site | project",
  "managed_here": false,
  "name": "local",
  "labels": [],
  "ephemeral": false,
  "created_at": "…Z",
  "last_seen_at": "…Z | null",
  "revoked_at": "…Z | null",
  "expires_at": "…Z | null",
  "claim": {
    "foreign": true,
    "dispatch_id": null,
    "kind": null,
    "run_group_id": null,
    "mint_claim_id": null,
    "claimed_at": "…Z",
    "heartbeat_at": "…Z"
  }
}
```

For a claim in another project, `foreign` is true and every claim identifier is
null; claim and heartbeat times remain because they describe machine liveness.
The site operator’s site-wide list may expose the claim’s project key.

Site registry and presence edges fan out to project event feeds; claim events
go only to the claimed project's feed. Every runner event identifies scope.

## Development peer runner

Under development auth, startup ensures one site-scoped runner named `local`
and writes its credential atomically with mode `0600` under the data root. This
registers identity only; the control plane still starts no runner.

The supported `npm run hosted` script supervises a peer `runner-agent pool`,
restarts it, and stops it with the server. Ensuring the registration is
idempotent. If the credential file no longer matches the stored hash, startup
reissues the credential on the same runner row, invalidating the old value
without losing runner history. An absent runner configuration file is seeded
from the documented schema.

Web and API runs therefore need no local runner setup while using the same
claim and exchange path as CI and fleet runners.

## Pool agent behavior

`runner-agent pool` is the package's sole executable mode. Its loop is poll,
claim, exchange, execute group or mint, complete, and repeat. Exact flags and
configuration live in
[Interface contracts](interfaces.md#runner-agent-cli).

- Credentials arrive through environment or a credential file, never argv.
- The first check-in does not hold, allowing immediate startup diagnostics.
- Unknown or revoked credentials stop the process with one actionable error.
  Transport failures use jittered exponential backoff and one message per
  outage; a lost claim race is normal.
- Restarting during a group resumes the board's current claim.
- The agent claims the first offer it can execute and skips incompatible offers
  locally.
- Cancellation and shutdown share teardown.
- A failed group does not stop the pool.

Runner-facing errors must be actionable and must not expose credentials, secret
values, or raw stacks.

## Standalone mint recovery

A forced script-provider refresh is a mint dispatch. Recovery uses ordinary
executor fencing:

- Re-exchange by the claim holder installs a new executor and rebinds the
  pending session claim atomically, fencing the previous bearer.
- Resume stays within the same dispatch attempt.
- Refused exchange and reconciliation share one terminal cleanup path.
- A pending forced mint always has a live attempt or posts a new one.
- Completion by the current executor is idempotent and redelivers the stored
  session with `redelivered: true` after a lost response; another executor is
  refused.

The runner executes a mint script once and retries only delivery. A transport
failure after successful minting is not reported as a script failure. A 4xx is
final. Failed mint errors are sanitized with every grant value before upload.

## Contract changes

Update this file for changes to placement, dispatch states, executor ownership,
runner scope, claim behavior, isolation, cancellation, session-mint recovery,
live upload, or the platform evidence boundary. CLI syntax and runner
configuration belong in [Interface contracts](interfaces.md).
