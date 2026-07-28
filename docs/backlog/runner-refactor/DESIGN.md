# Runner refactor: applications, rings, and one placement model

**Status:** designed, 2026-07-28. Supersedes the earlier
`docs/backlog/runner-resolved-targets.md` proposal, which is deleted; where the
two disagree, this document wins. Until the build plan ships,
[`docs/contracts/hosted.md`](../../contracts/hosted.md) remains authoritative
for current behavior.

The product decision behind everything here: **the console talks about
applications; runner setup is an operational task documented separately.** A
person using the hosted product creates an application target and gives each
ring a URL. They never see the words "binding", "dispatch adapter", or
"Appium" in the product's first-run path. The machine-level facts that only a
runner can know — a mobile build's path, the Appium server, the device — live
in a config file on the runner, described in
[`docs/guidance/hosted-runners.md`](../../guidance/hosted-runners.md).

There is no migration. The deployment is greenfield: legacy schemas, adapters,
and routes are deleted, and an existing `.playtest-data` directory from before
this change is reset rather than converted.

## What broke, concretely

The shipped model fails in ways that all trace to one boundary error —
machine-local facts stored in platform records — plus one accidental
complexity — three placement implementations. The evidence:

1. **Environment names are one project-wide namespace, and the project-owned
   rows are shared by every suite.**
   `environments` rows (migration `0001`, extended by `0006`/`0017`) are unique
   by `(project_id, name)` and carry a free-form `config` holding `base_url`
   *and* the mobile fields (`platform`, `app`, `device`, `appium_url`). The
   suite page's "Where does this app run?" card writes target config into those
   shared rows, so setting up a mobile suite corrupted the ring a web suite was
   launching against. The uncommitted `0020_environment_drivers.sql` +
   `requireEnvironmentDriver` work is a band-aid on this; this design removes
   the disease instead.
2. **The mobile binary has three competing sources** — the suite's
   `app.envs.<name>.app`, the environment (uploaded artifact or runner-disk
   path), and the suite's top-level `app.app` — with a precedence chain
   hand-written twice — `dispatch/dispatcher.ts` (`resolveAppTarget`, the
   launch preview and validation copy) and `runner-agent/src/workspace.ts`
   (`mergeOverlay`, the copy that actually runs) — aligned by comments, not
   code, plus a client-side vocabulary (`suite-target.ts` `BINARY_SOURCES`,
   `env-config.ts` mobile fields) that renders the server's resolution.
3. **The suite holds a trump card over hosted targets.** In `mergeOverlay`,
   suite-declared keys win over the environment overlay, so a suite edit can
   silently redirect which binary or URL a hosted run uses, and the pinned
   environment artifact is silently not even downloaded.
4. **An absolute path stored in the platform is interpreted on whichever
   machine claims the run.** `requireResolvableApp` deliberately never checks
   absolute paths; the failure surfaces as a mid-case infra error on a machine
   the person who typed the path cannot see.
5. **Nothing in the hosted path starts or checks Appium.** Core's mobile
   driver dials `appium_url` (default `127.0.0.1:4723`) and reports "the app
   did not launch" when nothing answers. No earlier diagnosis exists
   anywhere in the hosted path — and the CLI is only slightly better: its
   `preflightFor()` merely probes that `webdriverio` is importable, so
   Appium, driver, and device problems surface at session creation there
   too.
6. **Container isolation silently breaks mobile.** `runInContainer` mounts
   only the workspace, so an outside-workspace app path does not exist in the
   container, and a loopback `appium_url` dials the container, not the host.
7. **Three placement adapters** (`github`, `local`, `pool`) implement one
   interface, but only the pool matches the product's direction. GitHub
   dispatch duplicates exchange logic and workflow correlation; local dispatch
   is a dev-only shim whose own comments defer to the future pool as the real
   model.

What already works and is kept: the pool claim board (registration, hashed
credentials, labels, atomic claims, heartbeats, crash-resume, ephemeral
GitHub-OIDC CI runners), the dispatch ledger and reconciler, the runner
executor protocol (exchange, group spec, snapshot materialization, live
staging, bundle upload), and core's config resolution.

## Decisions

1. **Delete, don't migrate.** No compatibility window, no legacy adapters, no
   temporary export routes. A pre-refactor data root is reset.
2. **Applications and rings replace environments.** An application is one
   executable test surface (`web`, `api`, or `mobile` + `platform`). Rings are
   application-owned. A suite belongs to exactly one application and may
   launch only against that application's rings. Suite-owned environments and
   the implicit `default` environment are gone.
3. **A web/API ring holds one base URL.** `local` is `http://127.0.0.1:4173`;
   `prod` is `https://www.myapp.com`. The stated semantic: **the URL is
   evaluated from the claiming runner's network position.** A loopback URL
   therefore means "on the runner's own machine", and ring `runner_labels`
   are how you route such a ring to the right machine. This deliberately
   softens the superseded proposal, which pushed even public URLs into runner
   files; a public URL is not a machine-local fact and forcing it onto a
   runner's disk was ceremony without a payoff.
4. **Mobile physical facts are runner configuration.** The `.app`/`.apk`
   path, the Appium backend, and the device are read from the runner's local
   config file, keyed by immutable `(application key, ring key)`. No
   platform-managed record stores, serves, or displays them; verbatim
   authored suite source is the one stated exception (gate 9). Environment app-artifact
   upload and the three-source precedence are deleted. (In a real deployment
   the binary comes from an internal artifactory; a runner-side artifact
   provider is the v2 seam for that — the platform still never holds bytes.)
5. **The claim board is the only placement.** GitHub and local dispatch are
   deleted along with `PLAYTEST_DISPATCH`. CI starts an ephemeral runner via
   the shipped OIDC registration path. `npm run hosted` starts the control
   plane plus one peer local runner that polls the board like any other
   runner; the control plane never spawns work in response to a launch.
6. **The runner manages Appium.** `mode: managed` (default) spawns, health
   checks, supervises, and stops a local Appium on a free loopback port;
   `mode: external` points at an existing endpoint. Hosted mobile stops
   meaning "remember to hand-start Appium".
7. **Hosted physical fields always win.** Core gains one final resolution
   input — a runtime target override applied after the complete authored
   merge — closing the suite-trump-card hole. Authored `playtest.yaml`
   physical fields stay valid for direct CLI use and are inert under hosted
   execution.
8. **Keep the shipped board mechanics; do not rebuild them.** No pagination,
   cursors, or board versions. One addition is required (see "Offers and
   claim compatibility"): the poll returns a small bounded page instead of a
   single offer, because claim-side compatibility checks introduce
   head-of-line blocking that the labels-only board never had.

## The model

### Application

A project-scoped executable surface:

```json
{ "id": "app_…", "key": "todo-web",  "name": "Todo Web",  "driver": "web",    "platform": null }
{ "id": "app_…", "key": "todo-ios",  "name": "Todo iOS",  "driver": "mobile", "platform": "ios" }
```

`driver` is `web | api | mobile`; mobile additionally requires
`platform: ios | android` because core must pick XCUITest or UiAutomator2.
Keys are unique per project and immutable (runner config and evidence use
them); names are editable. `driver` and `platform` are immutable too, as are
a ring's application and a suite's application binding — v1 has no rebind or
migrate. An application owns its rings and its suites.
`Todo Web` and `Todo iOS` are two applications even when users think of them
as one product.

Deletion is refuse-not-cascade: an application is deletable only when it has
no rings, no suites, and no run groups; a ring only when no run group
references it and no auth provider binds it. The provider link is enforced
`RESTRICT`, never `SET NULL` — silently promoting a ring-bound provider to
project-wide would move secrets policy without anyone deciding it. Every
refusal names the referrers. Because keys are immutable,
delete-and-recreate is the stated remedy for a mistyped key on an entity
nothing has used yet — with one stated consequence: a runner config still
binding the old key will bind the recreated entity. v1 accepts and tests
that behavior; key tombstones are deferred.

### Ring

An application-owned test environment:

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

- `key` is unique within its application and immutable. Every application may
  have its own `local`, `staging`, `prod`.
- `base_url` is required for web/API rings and refused for mobile rings.
- `config` keeps the existing logical overlay document — auth identities and
  defaults, `secret_env`, cookies/headers, setup inputs. Ring authorization
  works exactly as environment authorization does today (providers, identity
  maps, secret references, session minting); it is rehomed, not redesigned.
  Auth-provider rows keep their own link: `auth_providers.environment_id`
  becomes a nullable `ring_id`, and a provider with no ring remains
  project-wide and mints with empty labels, exactly as today. Resolving a
  ring's session references accepts a provider only when its `ring_id` is
  null or that exact ring — today's lookup is by `(project, name)` alone,
  which would let one ring borrow another ring's provider. A suite may
  select identities the ring defines and nothing else; `auth: none` still
  always means signed out.
- A ring never contains a mobile path, application bytes, a device
  identifier, or an Appium URL — and not merely by convention: ring `config`
  is validated against an **allowlisted** logical schema, with the five
  physical keys rejected at the overlay positions where they would take
  effect. A property-name blacklist applied at every depth is explicitly the
  wrong tool — it would reject the logical `app` container itself and
  legitimate data that merely happens to be named `device`. The ring's own
  URL lives only in the first-class `base_url` column.

### Suite binding

A suite belongs to one application (`suites.application_id`), chosen at suite
creation; the suite's driver is the application's driver. The hosted launch
selector is `(suite, ring)`, so a suite can never launch against another
surface's ring. One check remains at launch and preview: each resolved case's
driver must equal the application's driver — a suite has no driver column,
its case files do, so a `driver: mobile` case inside a web application's
suite stays expressible and must be refused. That check replaces the `0020`
driver-column band-aid.

The suite's authored `app.envs.<ring-key>` overlay remains the test-specific
override surface for **logical** settings only. Under hosted execution the
physical fields — `base_url`, `app`, `platform`, `device`, `appium_url` — are
always replaced by the resolved runtime target (decision 7).

### Run group and launch

A launch resolves `(suite, application, ring)`, validates ring authorization,
pins the suite snapshot, and posts the dispatch to the board with labels from
the ring (or the existing per-launch label pin). Each dispatch attempt
records a **non-secret target snapshot** — application and ring ids and
keys, driver, platform, ring URL, labels, and the logical overlay — and its
offer and group spec serve that snapshot, so a ring edit between preview,
poll, claim, and exchange cannot make them disagree. A retry attempt
snapshots current ring state, which is the documented retry behavior.
Secrets are never in the snapshot; they are resolved when the group spec is
served after exchange. The group records `application_id` and `ring_id`
(checked at launch to agree with the suite's application and the ring's); `run_groups.environment_id`,
`run_groups.app_artifact`, and app-binary resolution at launch are deleted.
The launch preview states the ring, the base URL (web/API), the labels, and
whether a label-matching runner is online; for mobile it says the claiming
runner supplies the build — it never claims the platform inspected a binary
or a device.

### Offers and claim compatibility

The board keeps its shipped shape — a `requested` dispatch row plus its
labels snapshot is the entry; claims are one `BEGIN IMMEDIATE` transaction;
heartbeats and the reconciler are unchanged. Three additions:

1. **Every offer names its project on the envelope and carries a nullable
   target block**:
   `offer { project_id, project_key, …, target: { application_id,
   application_key, ring_id, ring_key, driver, platform, base_url } | null }`.
   The project fields live on the envelope, not inside the target, because a
   site-scoped runner needs them on *every* offer — including a project-wide
   mint, which has no target at all. Ring-bound groups and mints carry the
   target; it holds the non-secret fields a runner needs to decide
   compatibility locally. No suite files or secrets
   before claim, as today.
2. **The poll returns a bounded page** (oldest first, small fixed cap, e.g.
   8) instead of exactly one offer, and the runner claims the first
   compatible entry. Why: today's single-oldest-offer board is safe because
   label subsetting is the only filter and the server applies it. This design
   adds a claim-side check the server cannot apply (does this runner hold a
   binding for `todo-ios/local`?), so one unclaimable mobile job at the head
   would otherwise starve every newer job for every runner.
3. **The poll accepts a session-local `skip` list.** Today the server holds
   a long-poll only when its query returns no rows; a page containing only
   incompatible offers would return immediately and the agent would
   immediately re-poll — a tight request loop. So a runner that can take
   nothing on a page re-polls naming those dispatch ids in `skip` (bounded,
   in-memory, never persisted, carrying no reason); the server excludes
   them, and holds when nothing else remains. This also removes page-cap
   starvation in the common case. Skips expire: the agent clears its list
   whenever a long-poll wait times out (~25 s), so an offer whose
   incompatibility was transient — an external backend back online, a
   platform driver installed mid-session — is reconsidered without
   restarting the agent. Beyond the skip cap the agent applies explicit
   backoff rather than re-entering a tight loop; the residual delay of
   newer work is accepted for v1 — ring `runner_labels` remain the primary
   routing tool and the unclaimed-timeout diagnostic still names what
   nothing checked in to serve.

A runner claims a group only when: labels match (server-enforced, as today);
the driver is one it can execute; and — for mobile — its config file has a
binding for the offered `(application_key, ring_key)` whose platform
matches, and its named backend is **startable**: for managed mode, the
Appium binary and platform driver are present (checked once and briefly
cached) — real health is only knowable after claim, when the backend
spawns; for external mode, a cached reachability probe. Web/API offers need
no binding: the ring's URL travels in the group spec and the runner uses it
as-is. An incompatible runner logs one deduplicated, actionable reason
locally, names the offer in its next poll's `skip` list, and sends nothing
else to the control plane; the advertisement itself is never mutated, so a
capable runner claims it unaffected.

`kind: mint` offers ride the same board. A ring-bound auth provider's mint
carries the ring's labels and target block; a project-wide provider (null
`ring_id`) keeps today's empty-label mint with a null target — its project
still named on the envelope. Mint compatibility is labels only — no binding
is required to claim a mint.

### Runner configuration file

`runner-agent pool --server <url> --config <path> --credential-file <path>`.
The file is validated at startup against a versioned schema and is never
uploaded; the startup banner reports non-secret keys, backends, and labels.

```yaml
version: 1

labels: [macbook, ios]

targets:
  todo-ios:
    local:
      platform: ios
      app: /Users/jeremy/build/Todo.app
      backend: local-ios
      device: iPhone 16          # optional; Appium's default otherwise

mobile:
  backends:
    local-ios:
      platform: ios
      appium:
        mode: managed            # or: mode: external, url: http://…, credential_file: …
```

- `targets` is keyed by immutable application and ring keys. v1 supports only
  driver `mobile` entries with a local filesystem `app` path; web/API targets
  need no entry. An artifact-provider `app` kind (artifactory et al.) is the
  v2 extension seam and changes nothing about the platform.
- `mode: managed` spawns Appium on an unused loopback port, health-checks it,
  and tears it down; it verifies the platform driver (XCUITest/UiAutomator2)
  is installed and refuses with the install command when it is not. It never
  installs or mutates Appium drivers itself.
- One backend serves one session at a time: mobile execution is serial per
  backend in v1 whatever the suite's `parallel` says — two concurrent cases
  cannot share a simulator or device.
- External-mode credentials reach the Appium client through a local-only
  driver input (files or process environment), never through `runtimeTarget`
  or any recorded config shape, so they cannot enter manifests or error
  responses. The current driver ignores URL userinfo entirely, so this is a
  small new core seam, owned by `engine.md`.
- A site-scoped runner (see "The local peer runner") must project-qualify
  its targets unconditionally (`projects.<project-key>.targets…`). Ambiguity
  cannot be validated once at startup, because a colliding project can be
  created afterwards and silently rebind a flat key that has already
  executed another project's runs. Flat `targets` keys remain the form for
  project-scoped runners, whose scope makes them unambiguous.
- Duplicate targets, unknown backends, platform mismatches, and missing paths
  are startup errors with actionable messages. Literal credentials in the
  YAML are refused; credentials come from files or process environment.
- Labels come from exactly one place per invocation: the config file's
  `labels`, or the existing `--labels`/environment forms when no config file
  is given (the ephemeral CI path needs no file). Supplying both is a
  startup error, not a merge.
- v1 loads configuration at startup; reload is a restart. (Atomic hot reload
  is deferred.)

### The local peer runner

`npm run hosted` (via `scripts/hosted-server.sh`) starts the control plane
and one peer pool runner on the same machine:

- Runner scope is a trust decision, not a capability one: a claiming runner
  receives suite files and secrets and executes suite hooks, so *which
  projects trust this machine* must be explicit. Project-scoped registration
  stays the default. But trust may legitimately span projects, so the model
  gains **site-scoped runners**: one runner row with no project, registered
  by a site operator, polling one board across every project and claiming
  under the same rules — credential hashes stay globally unique and resolve
  to exactly one row, and offers name their project. Capability
  routing stays with labels and bindings either way. v1 site scope means
  "all projects"; per-project grants are deferred.
- The rest of the site-runner discipline, stated so it is built and tested
  rather than assumed: the exchanged bearer is scoped to the claimed
  dispatch's project exactly like any other; one active claim globally;
  site-runner names are unique via a partial index over
  `project_id IS NULL`; project Runners pages list applicable site runners
  read-only — project developers cannot revoke them. Long-poll wakes are
  keyed per project today, so an idle cross-project site poll falls back to
  the existing one-second rescan; the MVP accepts that bounded latency
  instead of building a multi-project waker.
- Site runners have a **minimal lifecycle API** — register, list, revoke —
  gated to a site-admin principal and writing audit rows; a console surface
  is optional, the security lifecycle is not. The current code explicitly
  reserves site-scoped API tokens for a later ops flow, so the MVP does not
  pretend they exist: under dev auth the admin bypass *is* the site-admin
  principal, and a non-dev deployment simply has no site runners until the
  deferred trust follow-up provisions that authority. Revocation matters
  more than registration — a credential trusted by every project must be
  killable — and follows project-runner semantics: future polls, claims,
  and exchanges refused, in-flight work finishing under its already-issued
  bearer, all tested.
- Projection is **tenant-shaped even though the MVP is single-operator**,
  because retrofitting redaction is harder than shaping it now. A project's
  runner list shows a site runner's presence and busy state, but a claim
  belonging to another project appears only as "busy in another project" —
  never that project's dispatch or run identifiers (today's list view joins
  those ids straight in). Platform events require a project, so site-runner
  presence and registry edges — rare and edge-triggered — fan out one event
  per project at emit time, while a claim event lands only in the claimed
  project's feed.
- Under dev auth the control plane idempotently ensures one site-scoped
  runner named `local` and writes its credential to a `0600` file under the
  data root; the orchestrator starts `runner-agent pool` with that
  credential file and a seeded config file (created with commented examples
  if absent) also under the data root. Every project's launches are
  claimable by it with zero per-project ceremony.
- The runner polls the board like every other runner. The control plane
  never contacts it. Killing the distinction between "how local placement
  works" and "how real placement works" is the point.
- With this in place the insecure exchange is deleted whole: the
  `PLAYTEST_RUNNER_INSECURE_EXCHANGE` variable, the dev-auth auto-enable
  inside `allowInsecureRunnerExchange` (which turns the exchange on under
  `PLAYTEST_AUTH=dev` even without the variable), and the runner-agent's
  `local-dev` sentinel. A grep for the variable name alone would miss the
  dev-auth path; the removal targets the config symbol.

A first web run locally is therefore: create application, create ring `local`
with `http://127.0.0.1:4173`, launch. No runner file is touched. A first
mobile run additionally needs three lines in the seeded runner config —
which the runner operations guide owns, not the product's first-run guide.

### Core materialization

Hosted resolution order:

1. ring logical defaults (`config` overlay, materialized as `app.envs.<ring-key>`);
2. authored suite/defaults/case configuration, including `app.envs.<ring-key>`
   logical overrides — suite wins on **logical** keys exactly as today;
3. ring-managed authorization state and secret materialization
   (`auth_states` stay operator-owned and unshadowable, as today);
4. the resolved runtime target, applied last and only to
   `base_url`, `app`, `platform`, `device`, `appium_url`.

Layer 4 is one new core seam:

```ts
discoverCases(roots, { env: ringKey, runtimeTarget: { base_url?, app?, platform?, device?, appium_url? } });
```

absent for CLI discovery, applied after the complete authored merge. The
override is a **whole-target replacement discriminated by driver, not a
partial merge**: it replaces the driver's entire physical field set, clears
any physical field it does not supply (a binding that omits `device` means
Appium's default, never the suite's authored device), clears physical fields
that do not belong to the driver, and clears `compose` — the existing
`--base-url` already forces external mode by nulling `compose`, and an
authored compose block must not be able to boot a different application
under the ring's name. `runtimeTarget` generalizes that `baseUrl` option:
the flag becomes sugar for `runtimeTarget.base_url`, and passing both forms
is a config error rather than a precedence puzzle. The runner assembles the
override from the group spec (web/API: the ring URL) or its own binding plus
its managed backend (mobile: local app path, chosen device, spawned Appium's
URL).

Core also gains a **structural resolution mode** for hosted editing. Commit,
import, listing, preview, authoring, lint, review and synthesis reads, and
Playwright export all resolve suites through core today, and core refuses a
web/API suite without `base_url` and a mobile suite without `app` — but
under this design a hosted suite legitimately authors neither. Structural
resolution validates cases and logical configuration without requiring
physical-target completeness; executable resolution — the runner path and
the CLI — keeps requiring a complete target. Faking a target during
validation is not an alternative: it would mask real errors, and for mobile
the platform deliberately does not know an app path to fake. Two consumers
need particular care: `lintTree` currently swallows a resolution failure and
returns zero findings, so under target-free suites lint would silently never
run; and Playwright export embeds a resolved default URL a URL-less suite
does not have — the MVP decision is to emit the spec with only the
`PLAYTEST_BASE_URL` environment override and no baked-in default. The
emitted spec narrows that value and fails fast: a missing
`PLAYTEST_BASE_URL` throws one actionable error rather than leaving
`string | undefined` to produce an invalid navigation. The runner does not rewrite authored physical fields
into `playtest.yaml`; core stays the single resolver. Direct CLI semantics —
`playtest.yaml`, `app.envs`, `--env`, `--base-url` — are untouched.

Mobile cases run with process isolation. A runner configured for container
isolation refuses mobile offers with a local reason (the simulator, Appium
loopback, and outside-workspace app path are all unreachable from a
container); this is stated, not silently broken.

### Preflight and failure semantics

Preflight is runner-side diagnosis of runner-local setup — it belongs to the
runner and to the operations guide, not to the hosted product; the platform's
only involvement is receiving one actionable infra failure instead of a
mid-case driver stack. Sizing honesty: the CLI's existing `preflightFor()`
only probes that `webdriverio` is importable, so the runner's preflight is
mostly new code — the import probe moves to a core export for reuse, and the
real checks (path exists, Appium answering via its status endpoint, platform
driver installed) are built in the runner. The preflight deliberately stops
short of creating a session: an Appium session is not a harmless probe —
creating one installs and launches the app, so a viability session would run
the install/wipe/launch dance twice and collide with `preserve_session`
semantics. The first real execution session is the final preflight boundary,
its failure classified infra, and a one-case group creates exactly one
Appium session (tested). Before claiming, the runner does a brief cached
compatibility check; after claiming, the full preflight fails fast with the
runner-side remedy in the message.

| Failure | Result |
|---|---|
| No runner claims before timeout | group fails with the existing named-labels diagnostic; never re-posted to an empty board |
| Runner lacks a binding / backend / driver for an offer | local skip with one logged reason; another runner can claim |
| App path missing or Appium/driver unhealthy after claim | infra failure naming the runner-local remedy, without paths leaking into platform errors beyond the runner's own log detail |
| Managed Appium dies mid-group | infra failure with redacted diagnostics |
| Claim race lost | rescan, not an error (unchanged) |
| Ring or runner config changes before a retry | the retry uses current state; explicit v1 behavior |

Product test failures remain distinct from placement and infra failures.

## Product surfaces

- **Applications** becomes a first-class project section: create/rename
  applications, see the immutable key, manage rings (key, name, URL for
  web/API, labels, discovery, authorization), see linked suites. No URL,
  binary, device, or Appium control exists anywhere for mobile — the ring
  page for a mobile application states that the runner supplies the build and
  links the operations guide.
- **Suite creation** asks for the application (offering to create one
  inline — for web that is "name + a ring URL", nothing more). Roles:
  application and ring management is `developer`, like environments today,
  while suite creation stays `editor` — so the inline-create affordance
  appears only for developers, an editor picks from existing applications,
  and an empty project tells an editor that a developer must create the
  first application. The suite-settings target card and the "Where does this
  app run?" onboarding card are replaced by the application/ring selector;
  the card never writes into shared ring records again.
- **Launch dialog** shows suite, application, ring, resolved URL (web/API) or
  "build supplied by the claiming runner" (mobile), labels, and
  label-matching runner presence.
- **Runners settings** keeps registration/revocation/presence and gains the
  config-file flag in the generated start command. It never shows a target
  inventory. With one placement model, `capabilities.pool_dispatch` is
  deleted and the Runners section is always present.
- **First-run guide** gains only "create an application target". Runner
  operations — config file reference, mobile setup, Appium, artifactory
  futures — live in `docs/guidance/hosted-runners.md`.

## Deleted outright

- `dispatch/github.ts`, `dispatch/local.ts`, `PLAYTEST_DISPATCH`, the GitHub
  App configuration, workflow correlation, and the GitHub-dispatch exchange
  path (OIDC *ephemeral runner registration* stays).
- The insecure runner exchange whole: the environment variable, the
  `allowInsecureRunnerExchange` dev-auth auto-enable, and the `local-dev`
  sentinel.
- `environments` (table, API, UI), suite-owned environments, the `default`
  environment, and the uncommitted `0020` driver band-aid (superseded).
- Environment app artifacts: upload/delete routes, `run_groups.app_artifact`
  pins, `GET /runner/artifacts/:sha256`, `PLAYTEST_APP_ARTIFACT_MAX_MB`,
  `capabilities.app_artifact_max_mb`, runner-side artifact download/unzip,
  and blob-GC pinning for app artifacts.
- The three-source binary precedence: both implementations
  (`resolveAppTarget`/`requireResolvableApp`; the `workspace.ts` artifact
  branch) and the client-side vocabulary that renders it
  (`suite-target.ts` `BINARY_SOURCES`/`AppTarget`, `env-config.ts` mobile
  fields).
- The runner-agent `exec`/`mint` one-shot CLI entrypoints (the pool loop is
  the only arrival; the internal executor machinery stays).

## Security

Unchanged: hashed runner credentials, claim-then-exchange as the authority
boundary, scoped short-lived bearers, secrets only after claim, labels route
and never authorize, archive-safety on the runner, secret redaction.
New: platform-managed records — offers, dispatch snapshots, groups, audit
rows, evidence projections, browser-visible state — carry no runner-resolved
physical facts (web/API ring URLs are deliberately platform state; verbatim
authored suite source is the stated gate-9 exception); runner config credentials never appear inline
in YAML; managed Appium binds loopback only; external-Appium credentials are
a local-only driver input outside every recorded shape; a site-scoped runner
is a deliberate site-operator grant, never a default.

## Sharp edges this design must not forget

Named here so the build plan tests them rather than rediscovering them:

1. **Head-of-line blocking** arrives the moment claim-side compatibility
   exists; the bounded offer page is load-bearing, not polish.
2. **Deleting the insecure exchange breaks every integration test that used
   it.** The harness must register real runners (or drive the executor API
   with real exchanges) before that deletion lands.
3. **The suite trump card is currently load-bearing in tests** that exercise
   suite-wins merge behavior; inverting physical-field precedence must be a
   deliberate, tested contract change in core, not a runner-side hack.
4. **`npm run hosted` boot order**: the peer runner must tolerate the control
   plane not being up yet (existing backoff covers this) and must not race
   credential creation.
5. **Mint dispatches ride the board too**; the peer runner must serve
   `kind: mint`, or session minting silently dies with local dispatch.
6. **Mobile + container isolation is refused, not broken** — the refusal is a
   tested behavior with a stated reason.
7. **Reconciler expectations**: with one adapter, either keep the
   `DispatchClient` interface with a single implementation or inline it — but
   the reconciler's dead-executor and never-claimed semantics must survive
   verbatim.
8. **Hosted validation must not require what hosting removed**: commit,
   import, listing, preview, and authoring must all go through structural
   resolution — one call site left on executable resolution reintroduces
   "cannot save a suite without a URL", the failure mode that motivated
   the mode split.
9. **Data reset has a concrete mechanism**: the migration set is
   rebaselined — the `0001`–`0020` lineage is replaced by one new
   baseline — and boot compares the data root's applied-migration ledger
   against the shipped set, failing a ledger that names retired migrations
   with an actionable `ServerConfigError` ("reset `PLAYTEST_DATA_DIR`").
   Without the probe, the forward-only migrator would silently convert an
   old root; without the rebaseline, a fresh root would build the legacy
   schema only to drop it.

## Acceptance gates

1. A project owns independent web, API, iOS applications, each with its own
   rings; keys are immutable and unique in scope.
2. A suite binds to one application at creation and can only launch against
   that application's rings; cross-application identities are refused, and a
   ring's session references cannot borrow a provider bound to another ring.
3. A web ring is exactly "a base URL plus logical policy"; creating one and
   launching needs no runner-side configuration beyond a polling runner.
4. A mobile launch is claimable only by a runner whose config binds the
   offered application/ring; an unbound runner skips locally and a bound one
   claims the same offer.
5. One unclaimable offer does not starve newer compatible offers, proven
   past the page cap (more incompatible offers than one page holds), and an
   all-incompatible page holds the long-poll instead of hot-looping.
6. The control plane starts no process in response to a launch; local, CI,
   and remote runners all arrive through poll → claim → exchange.
7. Managed Appium: a hosted mobile run on a correctly configured runner
   needs no hand-started Appium; external mode works from config.
8. Hosted execution replaces authored `base_url`, `app`, `platform`,
   `device`, `appium_url` via the core runtime target; CLI behavior is
   byte-for-byte unchanged without the override.
9. No hosted route accepts or serves application bytes; no
   platform-managed record — application, ring, offer, dispatch target
   snapshot, group, audit row, evidence projection — carries a mobile path,
   device id, or Appium endpoint. Authored suite files are the one stated
   exception: they are stored and exported verbatim for CLI use and may
   contain physical fields, which hosted execution provably ignores
   (gate 8).
10. Post-claim mobile preflight failures produce one actionable infra error,
    not a mid-case driver stack.
11. Session minting works end to end through the board under `npm run hosted`.
12. A pre-refactor data root fails boot with an actionable message.
13. Deleting an application is refused while rings, suites, or run groups
    exist under it; deleting a ring is refused while run groups or auth
    providers reference it. Refusals name the referrers, unreferenced
    entities delete cleanly, and nothing cascades.
14. A hosted suite authoring no physical target commits, validates, lints,
    lists, previews, reviews, and exports cleanly (structural resolution) —
    lint reporting real findings rather than swallowing a resolution
    failure; executable resolution on a runner still refuses an incomplete
    target.
15. Revoking a site runner blocks poll, claim, and exchange while in-flight
    work finishes under its issued bearer; a project's runner list and feed
    never expose another project's dispatch or run identifiers through a
    site runner.

## Deferred

- Runner-side artifact providers (artifactory download of mobile builds).
- Immutable target pins, build/release registries, revision verification.
- Device profiles or any platform-visible device selection.
- Runner config hot reload; multi-group concurrency per runner; board
  pagination beyond the bounded page.
- Web/API rings resolved from runner config (private URLs a ring cannot
  state); revisit only with a concrete need.
- Manifest-recorded device/backend facts beyond application/ring/runner ids.
- Runner trust and administration follow-up (its own backlog item when the
  internal-tool phase ends): console CRUD for site-scoped runners,
  production site-admin token provisioning (the ops flow today's code
  reserves), per-project runner grants, hardened runner enrolment (e.g. key-based
  registration so an arbitrary machine cannot join and receive secrets),
  and a multi-project long-poll waker replacing the accepted one-second
  rescan.

## Contract ownership

| Behavior | Owner |
|---|---|
| Applications, rings, suite binding, board/offer/claim changes, peer runner, deletions | `docs/contracts/hosted.md` |
| `runtimeTarget` override, resolution order, and the core preflight-probe export | `docs/contracts/engine.md` |
| Runner CLI, config-file schema, managed Appium, runner preflight | `docs/contracts/interfaces.md` |
| Group/evidence application/ring/runner facts | `docs/contracts/artifacts.md` |
| Operational runner setup (local, CI, fleet, mobile) | `docs/guidance/hosted-runners.md` |
