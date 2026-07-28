# Runner refactor build plan

Executes [`DESIGN.md`](DESIGN.md). Six phases, each landing green
(`npm test` hermetic and zero-skip throughout; `npm run hosted:test` and the
explicit integration tier green at every phase boundary). Hosted mobile is
intentionally dark between R1 and R3 — the legacy mobile path is deleted
before its replacement exists; that is acceptable greenfield and is called
out below rather than bridged. The explicit `test:mobile` tier is stood
down — deliberately not run — from R1 until its R3 rework; stated here once.
While it is stood down, R1's launch refusal keeps broken mobile jobs from
ever reaching a runner.

Standing rules for every phase: record contract changes in the owning file
under `docs/contracts/` in the same change; actionable `ServerConfigError` /
`DummyConfigError` messages, never raw stacks; no new dependencies in the
hermetic root gate.

## R0 — Checkpoint and core seams

Goal: safe base plus the three core-owned pieces everything later consumes.

1. **Checkpoint the working tree.** Commit the pending live-runs doc tidy and
   the `0020` driver band-aid as-is (they are the current state; R1 deletes
   the band-aid with the schema it patched). Nothing in this plan builds on
   uncommitted state.
2. **`runtimeTarget` override in core.** `discoverCases` (and the resolution
   path under it) accepts an optional
   `{ base_url?, app?, platform?, device?, appium_url? }` applied after the
   complete defaults/case/env merge; absent means byte-for-byte current
   behavior. Present, it is a whole-target replacement discriminated by
   driver: the driver's full physical field set is replaced, unsupplied
   physical fields are cleared (an omitted `device` never inherits the
   authored one), non-applicable drivers' physical fields are cleared, and
   `compose` is cleared — `--base-url` already nulls `compose` to force
   external mode. The existing `baseUrl` option becomes sugar for
   `runtimeTarget.base_url`; passing both is a config error. Tests: override
   replaces at every authoring level (root, env overlay, case); omitted
   optional fields cleared, not inherited; `compose` cleared; logical keys
   unaffected; the `baseUrl` pair; CLI snapshots unchanged without the
   option. Contract: `engine.md`.
3. **Preflight probe moves to core.** The CLI's `preflightFor()` is only an
   is-`webdriverio`-importable probe — the real Appium/driver/device
   diagnosis does not exist anywhere yet. Extract the probe into a core
   export the CLI consumes unchanged; the runner's full preflight is new R3
   work and is sized as such. Tests: CLI behavior identical; export callable
   headlessly. Contract: `engine.md` (driver contract).
4. **Structural resolution mode.** Hosted commit, import, listing, preview,
   authoring, lint, review/synthesis reads (`resolveCases`,
   `resolveCaseByStory`), and Playwright export resolve suites through core
   (`suites/resolve.ts` → `discoverCases`), and core refuses web/API suites
   without `base_url` and mobile suites without `app` — which target-free
   hosted suites will legitimately lack. Add a resolution mode that
   validates cases and logical configuration without requiring
   physical-target completeness; executable resolution (runner and CLI)
   keeps requiring it. `lintTree` currently swallows a resolution failure
   and returns zero findings — under target-free suites it must lint, not
   silently skip. Playwright export of a URL-less suite emits only the
   `PLAYTEST_BASE_URL` environment override, no baked-in default — and the
   emitted spec guards it (throw one actionable error when unset, never
   `string | undefined`). Tests: a
   URL-less web suite and an app-less mobile suite validate, lint with real
   findings, and export structurally, and are refused executably (gate 14).
   Contract: `engine.md`.

Exit: `npm test`, `test:core`, `test:cli` green; no hosted behavior changed.

## R1 — Platform model: applications and rings

Goal: the new entities replace environments end to end for web/API; legacy
target machinery deleted.

1. **Schema.** Rebaseline the migration set: replace the `0001`–`0020`
   lineage with one new baseline holding `applications` (project-scoped,
   immutable `key`, `driver`, `platform`), `rings` (application-scoped,
   immutable `key`, `base_url` nullable, `runner_labels`,
   `discovery_allowed`, `config`), `suites.application_id` (required),
   `run_groups.application_id` + `ring_id`, `auth_providers.ring_id`
   (nullable, replacing `environment_id`, with `ON DELETE RESTRICT` — never
   `SET NULL`), ring-keyed auto-resolve stamp tables (the `0013`/`0014`
   primary keys embed `environment_id` today), and `runners.project_id`
   nullable for site-scoped runners (R2). Launch enforces in its transaction
   that the group's suite, ring, and application agree. `driver`,
   `platform`, ring ownership, and suite binding are immutable alongside
   keys. No `environments`, no `run_groups.app_artifact`. Boot compares the
   applied-migration ledger against the shipped set and fails a root naming
   retired migrations with an actionable reset message (gate 12) — the
   forward-only migrator would otherwise silently convert an old root.
2. **API.** Applications/rings CRUD (`developer`), immutability of keys
   enforced, ring `base_url` required for web/API and refused for mobile,
   ring authorization/secrets/discovery rehomed verbatim from environment
   config, with ring `config` validated against an allowlisted logical
   schema rejecting the five physical keys at the overlay positions where
   they would take effect (a property-name blacklist at every depth would
   reject the logical `app` container itself). Session resolution accepts a
   provider only when its `ring_id` is null or the launching ring (gate 2 —
   today's `(project, name)` lookup would let rings borrow each other's
   providers). Deletion refuses
   while referenced — an application by rings, suites, or run groups; a
   ring by run groups or auth providers — naming the referrers, and
   succeeds when unreferenced; no cascade (gate 13). The auth-provider API
   gains the missing project-ownership check on its ring reference. Delete the environments API, suite-owned environments, the
   `default`-environment backfill, and all app-artifact routes, caps, and
   `capabilities.app_artifact_max_mb`.
3. **Launch.** `(suite, ring)` selection; ring must belong to the suite's
   application; preview reports ring/URL/labels/presence (case resolution in
   preview and commit runs the R0 structural mode). Each dispatch attempt
   stores the non-secret target snapshot its offer and group spec will
   serve; a retry snapshots current ring state. Mobile launches are refused
   with an actionable "mobile placement lands with runner bindings" error —
   tested, and removed in R3 — so nothing dispatchable can claim a mobile
   group while the binding model does not exist yet. Replace
   `requireEnvironmentDriver` with a resolved-case-driver versus
   application-driver check (a suite has no driver column; its cases do);
   delete `resolveAppTarget`, `requireResolvableApp`, and binary-source
   resolution. Group spec carries the ring (key, URL, config overlay,
   labels, `resolved_secrets`) plus the unchanged session requirements
   instead of the environment block.
4. **Runner-agent (web/API only).** Workspace materializes the ring overlay
   under `app.envs.<ring-key>`; the executor passes
   `runtimeTarget: { base_url }` from the group spec — hosted physical
   precedence now runs through the R0 seam, retiring the suite trump card.
   Delete artifact download/unzip and the suite-wins-app branch.
5. **Console (minimal, working).** Applications section (create app, create
   ring with URL, labels, discovery, auth), suite creation binds an
   application, launch dialog uses ring selection. Legacy target controls
   (`suite-target.ts` binary sources, `env-config.ts` mobile fields, the
   settings "Test targets" form, the suite onboarding target card) deleted;
   polish waits for R4.
6. **`environment_id` consumer sweep.** Launch is not the only reader:
   findings failure-retirement ("same suite and environment" becomes same
   ring), auto-resolve verification stamps (primary keys embedding
   `environment_id` — a schema change, covered by the rebaseline),
   run-index/trend projections and filters, `auth_providers`, and
   standalone-mint label sourcing all key off environments today; map each
   to `ring_id` in this phase, not opportunistically later. Retention's
   blob GC is different: its app-artifact pin source is deleted with the
   artifact columns, not remapped.
7. **Tests.** Integration: gates 1, 2, 3, 8-platform-side, 12. Unit sweeps
   for deleted routes. Every integration/browser test that launched anything
   relied on the `default` environment falling back to the suite's authored
   `base_url`; that fallback is gone, so add one shared fixture helper
   (create application + ring with URL) and convert the tests through it —
   this is the widest mechanical churn in the phase.

Exit: web/API hosted runs work end to end on the new model under the
existing dispatch adapters (still present until R2); mobile hosted is dark.

## R2 — One placement model

Goal: the board is the only way work is placed; local dev is a peer runner.

1. **Delete GitHub and local dispatch.** Remove `dispatch/github.ts`,
   `dispatch/local.ts`, `PLAYTEST_DISPATCH`, GitHub App config, workflow
   correlation, and the GitHub exchange path. Pool is unconditional;
   `capabilities.pool_dispatch` deleted; Runners UI always present. Keep the
   ephemeral OIDC runner registration and its pins. Keep the reconciler's
   dead-executor and never-claimed semantics verbatim (single-implementation
   `DispatchClient` or inlined — reconciler tests unchanged either way).
2. **Site-scoped runners and the peer local runner.** Add site-scoped
   registration: one runner row with null `project_id`, a partial unique
   index over site-runner names, and a minimal audited lifecycle API —
   register, list, revoke — gated to a site-admin principal. Under dev auth
   the admin bypass is that principal; site-scoped API tokens remain
   reserved for the later ops flow, so a non-dev deployment has no site
   runners until the trust follow-up (no console CRUD in the MVP). The poll
   spans all projects — the idle cross-project poll rides the existing
   one-second rescan, an accepted MVP latency with the multi-project waker
   deferred; offers name their project on the envelope; the exchanged
   bearer is scoped to the claimed dispatch's project; one active claim
   globally; project Runners pages list applicable site runners read-only,
   with a foreign claim redacted to "busy in another project" (today's list
   view joins claim dispatch/ref ids in — that projection must be shaped
   per viewer). Site-runner presence and registry `runner.status` edges fan
   out one platform event per project (the event row requires a project);
   claim events land only in the claimed project's feed. Under dev auth the
   control plane idempotently ensures one site-scoped runner named `local`
   with its credential written (`0600`) under the data root; site-scoped
   runner configs project-qualify targets unconditionally. Tests: a project
   runner cannot poll or exchange outside its project; a site bearer is
   project-scoped after claim; one-claim-globally holds across projects;
   revoking a site runner blocks poll/claim/exchange while in-flight work
   finishes (gate 15); project B sees a site runner's presence flips but
   never project A's identifiers (gate 15).
   `scripts/hosted-server.sh` seeds a commented runner config if absent and
   supervises `runner-agent pool` beside the server (backoff covers boot
   order; clean shutdown of both).
3. **Delete the insecure exchange.** First convert the integration harness
   to register real runners / perform real credential exchanges, then remove
   the whole mechanism: `PLAYTEST_RUNNER_INSECURE_EXCHANGE`, the dev-auth
   auto-enable inside `allowInsecureRunnerExchange`, and the runner-agent's
   `local-dev` sentinel — target the config symbol, not just the variable
   name, or the dev-auth path survives a grep.
4. **Bounded offer page.** `GET /runner/pool/claims` returns up to N oldest
   compatible-by-label offers, each carrying `project_id` and `project_key`
   on the envelope plus a nullable target block (`application_id`,
   `application_key`, `ring_id`, `ring_key`, `driver`, `platform`,
   `base_url`; null for a project-wide mint — the exact shape the design
   states, since gate 9 makes it contractual); the agent claims the first
   it can. The poll also accepts a bounded, session-local `skip` list of
   dispatch ids: the server excludes them and **holds the long-poll when
   nothing else remains** — today it holds only on an empty query, so an
   all-incompatible page would otherwise hot-loop the agent against the
   database. Skip entries expire when a long-poll wait times out, and the
   agent backs off explicitly past the skip cap rather than looping. Claim
   transaction unchanged. Tests: gate 5 (starvation proven past the page
   cap; all-incompatible page holds instead of looping), a recovered
   external backend's still-pending offer is later claimed (skip expiry),
   multi-offer claim race, `current`-claim resume unchanged, deduplicated
   incompatibility diagnostics.
5. **Runner-agent entrypoints.** Delete `exec`/`mint` one-shot CLI modes;
   pool loop serves `kind: mint` (tested under the peer runner — gate 11).
   Mint offers for ring-bound auth providers carry the ring's labels and
   target block; a project-wide provider (null `ring_id`) keeps today's
   empty-label mint with a null target, its project still named on the
   envelope. Mint compatibility is labels only.
6. **CI recipe and top-level docs.** Update `docs/guidance/hosted-runners.md`
   and `examples/ci-github-actions/` to the ephemeral-runner recipe only.
   Update `CLAUDE.md` ("Install and run") and `README.md`, both of which
   document local dispatch today.

Exit: gates 5, 6, 11; `npm run hosted` gives launch-to-verdict web runs with
zero manual steps; all integration tests run through real claims.

## R3 — Mobile through runner configuration

Goal: a mobile suite against a local `.app` works hosted, one config file
and one launch.

1. **Runner config file v1.** `--config` flag; schema-versioned parse and
   startup validation (duplicate targets, unknown backends, platform
   mismatch, missing paths, inline credentials refused — all actionable);
   startup banner lists non-secret targets/backends/labels.
2. **Claim compatibility.** Mobile offers claimed only with a matching
   binding and a *startable* backend — managed mode checks the Appium
   binary and platform driver are present (brief, cached); real health is
   checked after claim when the backend spawns; external mode uses a cached
   reachability probe. Local skip logs one deduplicated reason and sends
   nothing beyond the poll's `skip` ids. Container-isolation runners refuse mobile
   offers with a stated reason. Tests: gate 4, the skip/claim pair, the
   refusal.
3. **Managed Appium.** Spawn on a free loopback port, health check, verify
   platform driver installed (refuse with install command), supervise, tear
   down with the case scheduler; external mode dials a configured URL with
   optional credential file, delivered to the driver through the local-only
   core input (the current driver ignores URL userinfo — small core seam,
   `engine.md`). Mobile execution is serial per backend regardless of
   `parallel`. Redacted diagnostics on death mid-group.
4. **Execution.** Post-claim preflight — new runner-side code around the R0
   core import probe: path exists, Appium answering via its status
   endpoint, platform driver installed → one actionable infra error on
   failure (gate 10). No probe session: creating an Appium session installs
   and launches the app, so the first real execution session is the final
   preflight boundary, its failure classified infra, and a one-case group
   creates exactly one Appium session (tested); `runtimeTarget` assembled from binding + backend
   (`app`, `platform`, `device`, `appium_url`); process isolation enforced
   for mobile cases.
5. **Evidence.** Group projections and `placement` carry application/ring
   (ids and keys) and the claiming runner; no runner-resolved physical fact
   in any platform-managed record or response, authored suite source
   excepted (gate 9 sweep test).
6. **Tests.** Rework `tests/mobile/pool-mobile.test.ts` to the binding
   model; unit tests for config parsing, backend lifecycle (Appium faked),
   compatibility cache. Real-simulator coverage stays in the explicit
   `test:mobile` tier.

Exit: gates 4, 7, 9, 10 — the scenario that motivated this refactor works:
bind `todo-ios/local` to a `.app` in the seeded config, launch from the
console, get a verdict.

## R4 — Console and guides

Goal: the product speaks only applications; operations live in guidance.

1. Applications section polish: application pages with rings and linked
   suites, immutable-key presentation, mobile ring page stating the runner
   supplies the build (link to guidance), auth/identity editing per ring.
2. Suite creation flow: inline "create application" (web: name + ring URL);
   suite settings show binding and ring overrides (logical only).
3. Launch dialog: resolved URL or "build supplied by the claiming runner",
   labels, live presence line.
4. Runners settings: start command with `--config`, config-file explainer,
   no target inventory.
5. First-run guide: add "create an application target"; remove every
   operational mention. Rewrite `docs/guidance/hosted-runners.md` as the
   operational home (local peer runner, standing runners, ephemeral CI,
   mobile setup, managed/external Appium, artifactory as the stated v2).
6. Browser tests for the new journeys; delete legacy-surface tests.

Exit: hosted UX evidence pass on the two core journeys (new web suite to
verdict; new mobile suite to verdict) without a confusion event.

## R5 — Contracts, sweep, and gates

1. Final contract audit — not the first write, since the standing rule
   lands authoritative contract changes with each phase. Verify
   `docs/contracts/hosted.md` fully reflects applications, rings,
   board-only placement, and the runner protocol (offer page, target
   block, site scope), verify `engine.md` (`runtimeTarget`, structural
   resolution, preflight probe), `interfaces.md` (runner CLI + config
   schema), and `artifacts.md` (placement facts), and sweep dead
   vocabulary and config-variable documentation from all four.
2. Dead-code and config sweep: grep-level proof that deleted variables,
   routes, and modules are gone (`PLAYTEST_DISPATCH`,
   `PLAYTEST_APP_ARTIFACT_MAX_MB`, `PLAYTEST_RUNNER_INSECURE_EXCHANGE`,
   `allowInsecureRunnerExchange`, GitHub App vars, artifact routes,
   `environments`) — including docs beyond contracts
   (`tools/ux-lab/README.md` names `PLAYTEST_DISPATCH`).
3. Acceptance-gate audit: map each of the fifteen design gates to a named
   test; add any missing.
4. `docs/ROADMAP.md`: check off phases as they land; when R5 completes,
   remove the entry and the `docs/backlog/runner-refactor/` documents per
   repo convention (completed work lives in contracts), keeping any still-
   deferred items in the roadmap.

Exit: contracts authoritative again; every design gate names its test;
roadmap clean.
