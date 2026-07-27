# Self-hosted runners and environment app artifacts

**Status:** implemented. All phases (R0–R4) landed 2026-07-27; see
[`BUILD_PLAN.md`](./BUILD_PLAN.md) for the phases and gates.
[`docs/contracts/hosted.md`](../../contracts/hosted.md) is authoritative for
the shipped behavior; this document records the design and its rationale.

## Problem

A remotely hosted control plane cannot reach the targets people actually test:

- a web app on the developer's `localhost`;
- an app binary (`.apk` / `.app`) sitting on a developer's disk or produced by
  a CI build;
- anything behind a corporate or home firewall.

Both are the same problem. The runner agent — not the control plane — is the
component that touches the target, so the target does not need to become
reachable from the cloud; the **runner needs to run where the target already
is**. The hosted contract already states the principle: *dispatch is
placement; it is not the system of record or an artifact store.*

Mobile sharpens it: iOS Simulator requires macOS and Xcode, which generic
cloud executors do not have. For mobile suites a runner on a developer-owned
Mac is not a convenience, it is the only executor that can do the job.

## Decision

Two additions, independently shippable:

1. **A pull-based runner pool.** A new placement adapter under which the
   control plane never starts or contacts an executor. Instead, a self-hosted
   runner — a long-lived agent on a developer machine, or an ephemeral one
   inside a CI job — authenticates **outbound** to the control plane,
   advertises labels, and long-polls a claim board. Launching a run group
   posts the job to the board; the first eligible runner to claim it executes
   it through the existing, unchanged executor protocol.
2. **Environment-owned app artifacts.** For runs where the executor is *not*
   co-located with the app binary, an environment may carry an uploaded,
   content-addressed app artifact. Launch pins the artifact hash; the runner
   downloads and materializes it and rewrites the mobile `app:` path before
   core resolves the suite. Core never learns the file came from the object
   store.

A runner co-located with the target needs no artifact upload: a plain local
`app:` path in that environment's overlay keeps working. The artifact
machinery exists for cloud or shared runners, not as a new requirement.

## The benchmark

This design is done when the following is easy, with the control plane
hosted remotely and nothing but the runner agent on the laptop:

1. **One-time setup:** register a runner in the console and start it on the
   laptop with one pasted command; label an environment for it.
2. **Mobile:** a suite whose environment `app:` points at an `.apk`/`.app`
   on that laptop's disk, launched from the web UI, executes on the laptop's
   own simulator/emulator, and the trajectory lands in the console like any
   hosted run.
3. **Local API:** the same launch flow against an API suite whose resolved
   `base_url` is `http://127.0.0.1:…` on the laptop.

Anything in the build plan that does not serve this path is cuttable;
anything missing for it is a gap in this design. Both driver paths exist
today (`src/core/drivers/mobile.ts` handles iOS and Android; the API driver
needs only reachability), so the benchmark measures placement and
ergonomics, never new driver work.

## Why this fits

Nearly every hard part already exists:

- **The runner protocol is already outbound-only HTTP.** After
  `POST /runner/exchange` the executor fetches its group spec, snapshot tree,
  blobs, and baselines, and uploads bundles and reports — all client-initiated.
  No inbound connection to the runner is added anywhere in this design.
- **Placement is already an adapter.** `dispatcher.js` talks to placement
  through one interface (`dispatchWorkflow`, `findDispatchRun`,
  `getRunStatus`, `cancelRun`) with two implementations
  (`dispatch/github.js`, `dispatch/local.js`). The pool is a third
  implementation of the same interface; `dispatches` rows, the reconciler,
  and run-group lifecycle are untouched.
- **Labels already exist and already ride dispatch.**
  `environments.runner_labels` (migration `0001`, `dispatcher.js:109`) is
  passed to every dispatch attempt today. The pool gives the field its
  matching semantics instead of forwarding it to a GitHub workflow.
- **The claim race is transaction guarantee #2.** "Exactly one concurrent
  caller wins" via `BEGIN IMMEDIATE` plus a restated precondition is the
  established pattern for candidate resolution and session-claim fulfil; a
  job claim is the same shape.
- **Long-poll plumbing exists.** The event feed's held-read machinery
  (post-commit wake, bounded rescan, correctness from the durable row, not
  the signal) is exactly what the claim board's `wait=true` needs.
  `GET /api/v1/run-groups/:id?wait=true` already gives CI its verdict wait.
- **OIDC verification exists.** The GitHub exchange already validates issuer,
  audience, repository, workflow, ref, and workflow run. Ephemeral CI runners
  reuse that verification as their registration badge.
- **The object store is already content-addressed** for suite blobs, bundles,
  clips, and reports. App artifacts are one more object kind.

## The runner pool

### Identity: registration is not routing

Two concepts stay separate, deliberately:

- The **runner credential** proves identity. It is minted once at
  registration, shown once, stored hashed (like API tokens), and is the only
  long-lived secret on the runner's machine.
- **Labels** route work. They are not secrets and confer no authority; they
  appear in environment settings and console UI freely. A runner claims only
  jobs from projects its credential is registered to — the label merely
  narrows which of those jobs match.

Registration is project-scoped in v1:

- `POST /api/v1/projects/:p/runners` (`developer`) → runner row plus the
  one-time credential. Body: `name` (unique per project), `labels`.
- `GET /api/v1/projects/:p/runners` (`viewer`) → name, labels, last-seen,
  current claim if any.
- `DELETE /api/v1/projects/:p/runners/:r` (`developer`) revokes. Revocation
  refuses future check-ins and claims; an in-flight group finishes under its
  already-issued scoped token (bounded by that token's lifetime).

`runners` is one new table: id, project, name, labels, credential hash,
`ephemeral` flag, created/last-seen/revoked timestamps. Every registration,
revocation, and claim writes its audit row.

### The claim board

`PLAYTEST_DISPATCH=pool` selects the adapter. Its `dispatchWorkflow` performs
no network call: the dispatch row itself (status `requested`, plus the labels
snapshot) *is* the board entry. The adapter's `getRunStatus` reads claim and
heartbeat state, which is what lets the existing reconciler treat a dead
self-hosted runner exactly like a vanished GitHub workflow.

Runner-facing surface (runner-credential authenticated, under the runner
namespace like the rest of the protocol):

1. `GET /runner/pool/claims?wait=true` — check in and long-poll. The runner
   presents its labels; the server answers with the oldest unclaimed dispatch
   (kind `group` **or** `mint` — session minting dispatches through the same
   placement path and must be served) whose label set is a subset of the
   runner's, scoped to the runner's project. Held reads use the feed's
   discipline: woken by post-commit signal, re-scanned on a bounded interval,
   correct from the row alone.
2. `POST /runner/pool/claims/:dispatch` — claim. `BEGIN IMMEDIATE`; the
   precondition (`status = 'requested'`, labels still a subset, runner not
   revoked) is restated in the mutating `WHERE`. Exactly one runner wins; the
   loser gets the documented conflict and goes back to polling. The winning
   claim stamps the runner id, moves the dispatch to `scheduled`, and emits
   the same `run.status` provisioning event GitHub dispatch does.
3. `POST /runner/pool/claims/:dispatch/heartbeat` — group-level liveness
   between claim and completion, coarse (tens of seconds). Case-level
   telemetry remains the existing progress route; the heartbeat exists so the
   reconciler can distinguish "slow" from "gone" before the first case
   starts and after the last one ends.

After a successful claim the runner enters the **existing** protocol at
`POST /runner/exchange`, presenting its runner credential plus the claimed
dispatch. The exchange keeps its contract: it binds one executor to one
active dispatch and returns a short-lived bearer scoped to exactly that run
group or mint claim. Claiming assigns; exchanging authorizes. A runner
credential alone can never fetch a snapshot or post a report.

### Matching, fairness, and mixed fleets

- Empty `runner_labels` on an environment means any runner registered to the
  project may claim.
- Label matching is subset semantics: job labels ⊆ runner labels.
- Delivery order is oldest-first per project; v1 makes no stronger fairness
  promise.
- One runner executes one group at a time in v1 (`exec-group` is already the
  unit of execution). Concurrency inside the group is core's existing
  worker-pool scheduling.
- A deployment runs one placement adapter in v1. Mixing GitHub-dispatched
  cloud runners and pooled self-hosted runners per environment is deferred;
  the seam is an environment-level placement field, noted here so the v1
  schema does not paint over it.

### Liveness, loss, and cancellation

The reconciler already owns "a dead executor cannot strand a group": it marks
unreported work as infrastructure failure and may dispatch a bounded
remainder. The pool plugs into that unchanged:

- A dispatch claimed but with a stale heartbeat is reported by
  `getRunStatus` as dead; the reconciler does what it does today.
- A dispatch never claimed within the configured window is reported as never
  started; the group fails with an actionable infrastructure error naming the
  labels nothing checked in to serve ("no runner with label `jeremys-mac`
  has checked in for 10 minutes — is the runner process running?").
- `cancelRun` flips the claim to `canceled`; the runner observes it on its
  next heartbeat or poll and runs the same SIGTERM-equivalent teardown the
  local adapter's child receives. Case reports for already-finished cases
  remain accepted; retries never duplicate an accepted report.

### The runner process

The runner agent grows a pool mode alongside `exec` and `mint`
(`exec-group.ts`): `playtest-runner pool --server <url> --labels a,b` (final
name at implementation). The loop: check in → long-poll → claim → exchange →
execute exactly as if the local adapter had spawned it → report → complete →
poll again. Backoff on server unavailability; clean shutdown finishes the
in-flight group's active case teardown before exiting.

Isolation posture is honest per the existing contract: a developer laptop is
process isolation, which the contract already allows for local development
and fresh ephemeral machines. Persistent shared runners require per-case
containers; the console's runner view shows which isolation the runner
reported so a reviewer can see what produced the evidence.

### Ephemeral CI runners

The CI recipe the pool enables, end to end:

```text
GitHub Actions job                          Control plane
──────────────────                          ─────────────
build app; start it on localhost
start runner:  pool --oidc \
  --labels ci-run-${{ github.run_id }} ───▶ register-oidc → short-lived
                                            runner credential (ephemeral)
POST launch run group
  (environment pinned to label
   ci-run-${{ github.run_id }})  ─────────▶ dispatch posted to board
GET /run-groups/:id?wait=true    ─────────▶ (holds)
                                            runner claims, exchanges,
                                            executes against localhost,
                                            uploads, reports
long-poll resolves ◀─────────────────────── group complete
exit 0/1 from the verdict
```

Two details make this sound:

- **OIDC as the badge.** `POST /runner/pool/register-oidc` accepts a GitHub
  OIDC token and validates it with the same issuer/audience/repo/workflow
  checks the existing exchange performs, then mints a short-lived ephemeral
  runner registration (auto-expiring, never listed as a standing runner).
  No long-lived secret lands in repo settings.
- **Unique labels pin builds to their own runner.** Two concurrent PR jobs
  each register with a label containing their workflow run id and launch
  against an environment carrying that label, so neither can claim the
  other's job and test the wrong build. The launch API must therefore accept
  per-launch label overrides (or CI creates a suite-owned environment per
  pipeline); the build plan settles which.

## Environment app artifacts

### Ownership and shape

The app binary is the mobile analogue of `base_url`: it *is* the target, and
it churns per build — the wrong cadence for suite commits, which would drag a
snapshot per CI build through suite history. So the artifact belongs to the
**environment**, whose job is already "what am I testing against."

- `PUT /api/v1/environments/:e/app-artifact` (`developer`, the environment
  role) uploads the binary. Stored content-addressed in the existing object
  store; the environment records `{sha256, size, filename, uploaded_at,
  uploaded_by}`. Re-uploading the same bytes is a no-op by construction.
- `DELETE` clears the reference. The blob is garbage-collected by the
  existing retention machinery once no environment and no pinned run group
  references it.
- A size cap is deployment configuration with a sane default; exceeding it is
  an actionable `413`, not a truncated blob.

### Pinning and materialization

Launch resolves the environment as today and additionally pins the artifact
hash into the group spec, so a re-upload mid-flight cannot change what an
in-progress or historical run tested — the same immutability rule snapshots
already follow.

The runner downloads the blob through a scoped runner route
(`GET /runner/artifacts/:sha256`, group-token authorized, integrity-checked
against the pinned hash), materializes it into the case workspace, and writes
the local path into the environment overlay's `app:` key before core
discovery runs. This is the snapshot-materialization trick applied once more:
core keeps receiving `app: "/abs/path"` per the engine contract and never
learns the file's provenance.

### Three sources for the binary, one precedence

The shipped console already implies a third source this design must
reconcile: the New suite modal and suite settings offer an "App binary"
field whose value is a path relative to the suite's `playtest.yaml`
(`src/platform/web/pages/projects.js:442`, `suite-settings.js:205`) — a
suite-tree file. Core resolves `app:` against the declaring file
(`src/core/config.ts:1035`) and snapshots materialize on the runner, so a
committed binary genuinely runs. But the control plane caps single-file
writes at 4 MiB and whole-suite imports at 64 MiB
(`src/platform/control-plane/src/http.js:7`), which real APKs exceed
several times over: the field works for a small fixture app and fails for
any real build. **Today's UI affords a configuration hosted cannot
satisfy**; repairing that promise is part of this design, not a separate
polish item.

| Source | Declared as | Apt for |
|---|---|---|
| suite-tree file | `app: builds/app.apk` in suite YAML | small fixture apps; snapshot-pinned, runs on any runner |
| runner-local path | absolute `app:` in the environment overlay | a self-hosted runner co-located with the build — the benchmark |
| environment artifact | uploaded once, pinned by hash (this design) | cloud or shared runners; CI pushing per-build binaries |

All three stay supported; none is redefined. Precedence follows the
existing target-resolution rule ("say the resolution out loud"): a
suite-env `app:` beats the environment (artifact or path), which beats a
suite top-level `app:`. The launch preview's `target` block grows an `app`
entry stating the resolved value and its source, exactly as `base_url`
does today. Two guardrails complete it:

- a mobile launch whose resolved `app:` is a suite-relative path absent
  from the pinned snapshot is refused at launch with an actionable error
  naming the three sources — never discovered as a runner-side crash;
- the suite-creation and suite-settings copy stops implying hosted can
  hold a real binary: the field becomes optional with "or provide it from
  the environment" guidance, and an over-cap suite upload keeps its
  actionable `payload_too_large`.

An iOS `.app` is a directory, not a file: the artifact upload accepts it
zipped, and the runner materializes the unpacked bundle.

### Console alignment: New suite asks identity, the ring answers location

The New suite modal currently conflates suite identity (name, driver) with
target configuration (the App binary field) — against the platform's own
model, which the environments tab states as "suites declare where their app
lives inside" a ring, and which already provides suite-owned environments
as the create-a-ring-just-for-this-suite concept. The realigned flow
(BUILD_PLAN R4): the modal asks name and driver only; the empty-suite page
carries a skippable, driver-aware "where does this app run?" card — pick a
project ring or create one inline (defaulting suite-owned) — with the
three-sources choice for mobile and a bare URL sufficing for web/API. The
launch-time refusal and the preview's source lines backstop a skipped
card, so deferral is safe and a dead-end configuration is unreachable.

### What this does not change

- Co-located runners (the laptop case, the CI case) keep using plain local
  paths. No upload is required to use the pool.
- Web and API suites are untouched; the artifact slot is mobile's `app:` (and
  is shaped to admit future kinds, e.g. a compose bundle, without committing
  to any here).

## Security notes

- **No new inbound surface.** Every pool interaction is the runner dialing
  out over HTTPS. Tunnels (ngrok and friends) are explicitly not part of the
  design; they publish the dev server and fight auth for no benefit the pull
  model doesn't already deliver.
- **Credential blast radii stay tiered.** Registration credential (hashed at
  rest, revocable, project-scoped) → claim (assigns work, grants nothing) →
  exchanged bearer (short-lived, one run group). Compromising a scoped token
  burns one group; the existing contract's "executors never receive database
  credentials or platform-wide secrets" holds unchanged.
- **Labels are untrusted routing input.** A malicious runner claiming
  arbitrary labels can only reach jobs in projects it is registered to — the
  credential is the boundary, the label never is.
- **The insecure local exchange stays dev-only.** Pool runners always present
  real credentials; `allowInsecureRunnerExchange` remains refused outside dev
  auth, unchanged.
- **Evidence trust is stated, not laundered.** Runs report which runner and
  which isolation produced them; a persistent shared runner without per-case
  containers is visible as such in review.

## Contract changes

Landing phases update, in the same change as the code:

- `docs/contracts/hosted.md` — placement adapters (pool), runner registry,
  claim board semantics, claim-vs-exchange, heartbeat/reconciler behavior,
  environment app artifacts, launch pinning of artifact hashes.
- `docs/contracts/engine.md` — one sentence: hosted execution may materialize
  `app:` from a pinned artifact; the engine-visible value remains an absolute
  local path.
- `README.md` / hosted docs — runner setup on a laptop, the CI recipe, and
  the Docker volume-mount workaround for fully local hosted deployments
  (documented as the dev-only alternative it is).

## Non-goals (v1)

- Mixed placement adapters in one deployment (seam noted above).
- Site-scoped runners serving many projects with one registration.
- A device-farm integration; artifacts make it possible later, nothing more.
- Fairness/priority scheduling beyond oldest-first.
- Windows runner packaging.
