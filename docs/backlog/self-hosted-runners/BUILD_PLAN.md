# Self-hosted runners build plan

Date: 2026-07-27
Source: [`DESIGN.md`](./DESIGN.md). Verified against current source before
writing: the placement-adapter interface (`dispatchWorkflow`,
`findDispatchRun`, `getRunStatus`, `cancelRun`) is the seam
(`src/platform/control-plane/src/dispatch/dispatcher.js:280`,
`dispatch/local.js`, `dispatch/github.js`); `environments.runner_labels`
exists since migration `0001` and rides every dispatch attempt
(`dispatcher.js:109`, `:317`); the reconciler already degrades a vanished
executor to infrastructure failure with bounded redispatch; the GitHub OIDC
verifier lives in `src/platform/control-plane/src/auth/oidc.js`;
`GET /api/v1/run-groups/:id?wait=true` is the shipped automation long-poll.

## Definition of done (the benchmark)

From `DESIGN.md` § The benchmark, and binding on this plan: after R1, a
person with a remotely hosted control plane can, from their laptop,

1. register a runner in the console and start it with **one pasted
   command** (credential via env or file, never argv);
2. launch, from the web UI, a mobile suite whose `app:` is an `.apk`/`.app`
   on that laptop's disk, and watch it execute on the laptop's own
   simulator/emulator;
3. launch, the same way, an API suite resolving to `http://127.0.0.1:…` on
   that laptop.

R2–R4 refine this path; they must not be prerequisites for it. Any phase
scope that does not serve the benchmark is cuttable.

Rules for every phase:

- `npm test` and `npm run hosted:test` stay offline, Node-only, zero-skip.
  Control-plane integration tests keep booting the whole plane against a
  temporary SQLite data root — the pool needs no new service.
- New modules are strict TypeScript per repo direction; edits inside existing
  `.js` files stay `.js` unless the module is being migrated as a coherent
  slice, and a pool change is never mixed with a TS migration of the same
  file in one commit.
- Each phase lands as its own reviewable change with its tests and its
  contract deltas (`docs/contracts/hosted.md`, and `engine.md` where named).
- Runner-facing failures are actionable errors, never raw stacks or
  `MODULE_NOT_FOUND`; startup misconfiguration is `ServerConfigError`.
- No new inbound connection to any runner, anywhere, in any phase.

## Phase R0 — Runner registry and claim board (control plane)

The server side of the pool, exercisable without the real agent.

- Migration: `runners` table (id, project_id, name unique per project,
  labels TEXT_JSON, credential_hash, ephemeral flag, created_by/at,
  last_seen_at, revoked_at). `dispatches` gains claim columns
  (runner_id, claimed_at, heartbeat_at) — nullable, unused by the existing
  adapters.
- Registry API: `POST`/`GET`/`DELETE` under
  `/api/v1/projects/:p/runners` per DESIGN (roles: developer, viewer,
  developer). Credential minted once, stored hashed like API tokens; audit
  rows on register/revoke.
- `PoolDispatchClient` implementing the adapter interface.
  `dispatchWorkflow` writes no network call — the `requested` dispatch row
  plus a labels snapshot is the board entry; `getRunStatus` derives
  status from claim + heartbeat freshness; `cancelRun` marks the claim
  canceled. `PLAYTEST_DISPATCH=pool` selects it; config validation rejects
  pool + dev-insecure-exchange combinations that would let an
  unauthenticated claimer in.
- Claim surface: `GET /runner/pool/claims?wait=true` (held read on the feed's
  discipline: post-commit wake, bounded rescan),
  `POST /runner/pool/claims/:dispatch` (BEGIN IMMEDIATE, precondition
  restated in the WHERE, single winner, conflict for the loser),
  `POST .../heartbeat`. Serves kinds `group` **and** `mint`. Label subset
  matching, oldest-first, project-scoped by the presenting credential.
- Exchange: extend `POST /runner/exchange` with the runner-credential grant
  bound to a claimed dispatch. Scoped-bearer semantics unchanged.
- Reconciler: teach the pool status source its two loss shapes — claimed but
  heartbeat-stale (dead executor path, unchanged downstream) and never
  claimed within `PLAYTEST_POOL_CLAIM_TIMEOUT_S` (fail the group with the
  error naming the unmatched labels).

**Gate:** control-plane unit + integration tests drive the full lifecycle
with a scripted claimer (register → poll → claim race with two claimers, one
winner → exchange → execute the existing executor protocol → report →
complete), plus: revoked credential refused at poll/claim/exchange; label
subset matching; mint claim; unclaimed timeout fails the group with the
actionable message; heartbeat-stale claim reconciles to infra failure and
bounded redispatch; cancel observed at heartbeat. Contract delta lands in
`hosted.md`.

## Phase R1 — Runner-agent pool mode (end to end)

- New entry in the runner agent beside `exec`/`mint`
  (`src/platform/runner-agent/src/exec-group.ts`): long-lived loop —
  check in, long-poll, claim, exchange, execute via the existing group
  executor, complete, poll again. Flags: `--server`, `--labels`,
  credential via env/file (never argv), `--isolation` as today.
- Backoff with jitter on server unavailability; SIGTERM finishes the active
  case teardown and posts best-effort completion (the local adapter's
  existing shape); cancellation from heartbeat/poll runs the same path.
- Report the runner's isolation mode in the exchange so the run records what
  produced its evidence.
- Setup ergonomics are in scope, not polish: registering in the console must
  yield the exact one-line start command to paste (credential delivered via
  env or file), and the agent's startup output must state server, project,
  labels, and "waiting for work" so a misconfigured runner is diagnosable in
  one glance. The laptop walkthrough in the docs **is** the benchmark
  script: register → start agent → label environment → launch from the web
  UI, once for a local-APK mobile suite, once for a localhost API suite.
- **Benchmark-critical console slice, pulled forward from R4.** The
  environment form already carries first-class runner-labels editing and an
  Advanced raw-config escape hatch that admits the mobile `app:` /
  `platform` / `appium_url` keys (`src/platform/web/pages/settings.js:330`),
  so rings need nothing new for the benchmark. What has no affordance at all
  is runner registration: R1 ships a **minimal** Settings → Runners
  section — register (name + labels) showing the credential and the exact
  one-line start command exactly once, a list with labels and last-seen,
  and revoke. Live presence, claimed state, feed repaint, and launch-dialog
  placement warnings stay in R4. Taste bar applies: this is front-door UI.
- One copy repair rides this slice because it sits on the benchmark's
  walkthrough: the New suite modal and suite settings "App binary" field
  (`src/platform/web/pages/projects.js:442`, `suite-settings.js:205`)
  currently implies committing the binary into the suite tree, which the
  4 MiB / 64 MiB upload caps refuse for any real APK (DESIGN § Three
  sources). The field becomes optional with "or provide it from the
  environment" guidance; the full source-aware affordance waits for R3/R4.

**Gate:** the benchmark, mechanized at two tiers.

- Hermetic: an integration test boots the control plane with
  `PLAYTEST_DISPATCH=pool`, starts the real runner agent in pool mode as a
  separate process, launches through the public API a fixture suite using
  the **API driver against a localhost fixture server** — benchmark path 3
  end to end — and gets the verdict through
  `GET /api/v1/run-groups/:id?wait=true`. Kill-the-runner-mid-group
  reconciles per R0's rules.
- Mobile: the explicit `test:mobile` tier gains a pool-mode case — the
  existing mobile fixture app with `app:` as a plain path on the runner's
  own disk, dispatched through the claim board — benchmark path 2. It stays
  out of the hermetic root gate like the rest of that tier.
- Console: web tests cover the minimal Runners surface — register renders
  the credential and start command exactly once and never again, the list
  shows labels and last-seen, revoke works.

## Phase R2 — Ephemeral CI runners

- `POST /runner/pool/register-oidc`: GitHub OIDC token in, validated by the
  existing verifier's issuer/audience/repository/workflow/ref/run checks,
  short-lived ephemeral runner registration out (auto-expiring, excluded
  from the standing-runner list, flagged in audit).
- Per-launch label pinning: settle DESIGN's open choice — prefer adding
  optional `runner_labels` to the launch request (overriding the
  environment's labels for that group) over per-pipeline environments;
  record the choice and its authorization implications in `hosted.md`.
- A reference workflow under `examples/` (never a product/test dependency):
  build → start app on localhost → start pool runner with
  `ci-run-${{ github.run_id }}` → launch via API → `?wait=true` → exit with
  the verdict.
- Docs: the CI recipe, including the concurrency trap the unique label
  prevents.

**Gate:** control-plane tests cover OIDC registration (accepted, wrong
audience/repo refused, expiry enforced, ephemeral runners never listed
standing) and per-launch label override (authorization, precedence over
environment labels, pinning recorded on the group). The example workflow is
lint-checked in repository tests; live GitHub execution is demonstrated, not
gated (network).

## Phase R3 — Environment app artifacts

- `PUT`/`DELETE /api/v1/environments/:e/app-artifact` (`developer`):
  content-addressed store write, environment reference
  `{sha256, size, filename, uploaded_at, uploaded_by}`, deployment-config
  size cap (`413` with the cap named), audit rows.
- Launch pins the artifact hash into the group spec; re-upload never changes
  an in-flight or historical group.
- Runner: `GET /runner/artifacts/:sha256` (group-token authorized,
  hash-verified on download), materialize into the workspace, write the
  local path into the overlay's `app:` before core discovery. A zipped
  `.app` directory materializes unpacked. Precedence and launch-preview
  reporting per DESIGN § Three sources: suite-env `app:` > environment
  (artifact or path) > suite top-level `app:`, with the preview's `target`
  block gaining an `app` entry that states the resolved value and source.
- Launch guardrail: a mobile launch whose resolved `app:` is a
  suite-relative path absent from the pinned snapshot is refused at launch
  with the actionable error naming the three sources, never a runner-side
  crash.
- Retention: unreferenced artifact blobs enter the existing GC; a pruned
  artifact behind a historical group degrades like a pruned bundle —
  actionable, never a 500.
- Contract deltas: `hosted.md` (artifacts, pinning, runner route),
  `engine.md` (one sentence: hosted may materialize `app:`; the
  engine-visible value stays an absolute local path).

**Gate:** integration tests cover upload/replace/delete, cap refusal,
launch pinning across a mid-flight re-upload, runner materialization with a
corrupted-blob refusal (hash mismatch), zipped-`.app` unpacking, all three
precedence orders including the launch preview's `app` source entry, the
missing-suite-relative-binary launch refusal, and GC of an unreferenced
blob. The mobile fixture suite runs against a materialized artifact in the
process-isolation path.

## Phase R4 — Console surfaces

Taste bar per working preferences: hosted web UI is the front door; UX on
this path is lead-agent work, not bulk-model work.

- Settings → Runners: enrich R1's minimal surface with online/claimed state
  repainted off the feed (no polling) and each runner's current claim
  linked to its run group.
- Environment settings: app-artifact upload/replace/clear with size cap
  stated; runner-labels copy that explains matching ("runs on runners
  advertising all of these labels"); first-class mobile fields (`app:`
  path, platform, Appium URL) so the benchmark's mobile ring no longer
  requires the Advanced raw-config JSON.
- New suite flow realigned to rings (replaces R1's copy-level fix). The
  modal asks identity only — name and driver; target questions move out
  entirely, because the platform's own model says where an app lives
  belongs to an environment ring, and suite-owned environments already
  exist as the "create one just for this suite" concept. Progressive
  disclosure lands on the empty-suite page: a "where does this app run?"
  card offering (a) pick an existing project ring or (b) create one
  inline — driver-aware, so `mobile` asks where the binary comes from
  (runner-machine path + label / uploaded artifact / small suite file for
  fixtures: DESIGN § Three sources rendered as a choice), while `web`/`api`
  accept a bare URL (today's suite `base_url` + the `default` ring). The
  card is skippable; the launch path backstops it with the R3 refusal and
  the preview's `app`/`base_url` source lines. Open decision for
  implementation: inline-created rings default suite-owned with a
  promote-to-project toggle; names are unique per project across both
  scopes, so the inline form surfaces collisions.
- Launch dialog / run-group view: placement said out loud — which labels the
  group needs, whether a matching runner is checked in *before* launch, and
  the unclaimed-timeout error rendered with the runner-setup remedy.
- `GET /api/v1/me` capabilities: whether this deployment runs pool dispatch,
  so the console offers runner setup only where it exists
  (`503 not_configured` discipline elsewhere).

**Gate:** web tests for the new surfaces; the offline gate asserts the
no-matching-runner launch warning and the credential-shown-once behavior;
feed-driven repaint (no tight polls) per the live-updates contract.

## Sequencing and independence

R0 → R1 are strictly ordered and together deliver the laptop use case. R2
needs R0/R1. R3 is independent of R2 and needs only R0/R1 for its runner
path (the upload API and pinning are testable against the local adapter
first if landed earlier — acceptable, but the runner route gate belongs with
the pool). R4 trails whichever surfaces exist and may land in slices behind
each earlier phase.
