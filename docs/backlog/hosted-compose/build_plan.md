# Hosted Compose build plan

Status: P0–P6 implemented and locally verified. P7 is incomplete: real Spaces,
Authelia/browser admission, real-model execution, sustained active-run recovery,
and VM capacity remain unverified. P8 is a validated registration candidate in
`deploy/playtest/`, not registered infrastructure. P9 has not started.
Owner choices remain fresh data, all admitted humans as site admins, and simple
forwarded authentication. See [acceptance.md](acceptance.md) for exact evidence
and outstanding gates. No production rollout or backlog closeout is claimed.

P0 is global preparation. P1–P3 establish storage, P4–P5 identity/execution,
P6 packaging, P7 local verification/recovery, P8 infra preparation, P9 rollout.
After the owner's auth ruling, P4's independent proxy-identity work precedes P1;
runner bootstrap and resource scoping remain in P4 after storage lands.
Do not introduce parallel agents unless authorized. Preserve unrelated user
changes and the intentional deletion of previous backlog folders.

Run `npm run typecheck` for TypeScript changes. `npm test` remains offline,
Node-only and zero-skip. Postgres, S3, Docker, browser and proxy-auth tests belong in
explicit required tiers; unavailable dependencies leave their gate incomplete,
not skipped-successful. Gate names below are work to add, not existing commands.

## P0 — Inventory and async seams

- [x] Done

Owns: control-plane `src/db.ts`, `src/types.ts`, database consumers, test helpers
and placement, package test scripts, `tests/repository/`, and a temporary
`inventory.md` beside this plan.

Inventory schema/constraints, JSON/boolean/timestamp SQL, direct connection/exec
users, dialect-specific errors, parameter assumptions, and SQL-backed tests.
Make transaction queries consistently promise-based while preserving behavior;
audit dynamically typed call sites explicitly. Enumerate all object publishers,
references and deletes, including current suite files and personas. Inventory
per-image environment variables, dev-admin checks, runner URLs and Docker mounts.

Seam: every DB result is awaited; nested operations join the existing transaction.
No storage/SQL semantics change in this preparation.

Verify: typecheck, hermetic suites and current hosted integration tests. Record
the destination of every moved DB-backed test; no coverage disappears in a move.

Historical P0 checkpoint (superseded by final local checkpoint), 2026-09-05:

- Added [inventory.md](inventory.md): 37 tables, dialect/constraint audit,
  reference publishers/deleters, auth/container inputs and planned test moves.
  No tests have moved yet. Corrected the design's reference mapping for inline
  suite content and baseline/candidate bundle-entry pointers.
- Made Tx.query and migration script execution promise-based and narrowed the
  dispatch Queryable contract. Existing query callers already await results,
  including dynamically typed transaction callbacks. No storage dialect changed.
- Node 24.18.0: `npm run typecheck` passes. `npm test` runs 1,070 tests:
  1,068 pass, two fail, zero skips. All six workspace suites pass; the repository
  failures are `bundled skill schemas and personas match their runtime sources`
  (bundled case.schema.json differs) and `one root lockfile links every first-party
  workspace` (tracked tools/presentation/package-lock.json). Both conflicts are
  present in HEAD and unrelated to these changes; left intact.
- `PLAYTEST_FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg npm run
  test:integration --workspace=@playtest/control-plane` passes all 222 tests on
  Node 24.18.0. ffmpeg-full 8.1.2 supplies drawtext and subtitles. The 18 storage
  tests also pass after proving the new Promise assertion fails with the old
  synchronous transaction implementation and restoring the async adapter.
- Full logs: `/tmp/playtest-hosted-compose-node24-typecheck.log`,
  `/tmp/playtest-hosted-compose-node24-tests.log`,
  `/tmp/playtest-hosted-compose-node24-integration.log`, and
  `/tmp/playtest-hosted-compose-storage.log`. Node 24 was invoked with
  `/Users/jeremy/.npm/_npx/4aa47c519def57bc/node_modules/node/bin` prepended to PATH;
  the workstation default is Node 25.8.2. Docker server 29.2.1 is available.
- Owner questions were resolved after P0: start empty, all admitted users as
  site admins, and Caddy/Authelia forwarded identity. P1–P9 have not started. No env files read, production
  changes made, or old data opened.

## P1 — Postgres runtime and migrations

- [x] Done

Owns: control-plane `src/{db,migrate,config,app,index,ulid}.ts`, `migrations/`,
all inventoried SQL callers, package dependencies/root lockfile, Postgres test
helpers, and hosted storage/transaction contracts.

Add `pg`, require `DATABASE_URL`, and implement the queued owned client,
promise-based queries, nested transactions and post-commit callbacks. Acquire
the application writer lock on that client before migrations/bootstrap; fail
closed on connection loss. Implement the Postgres migration lineage from the
current effective schema, checksummed ledger and transactional migration errors.

Port JSON, booleans, timestamps, UTC buckets, query parameter numbering/encoding,
safe numeric results and SQLSTATE/named-constraint handling. Handled uniqueness
errors need `ON CONFLICT` or savepoints: Postgres cannot continue a transaction
after a failed statement without recovery. Preserve all constraints and event
cursor ordering across restart/clock rollback. Remove hosted SQLite runtime
support and move real SQL tests into the required Postgres tier.

Seam: query methods return `{rows, rowCount}` promises; API JSON/Date/boolean and
numeric meanings remain stable. State/audit/event commit together. A fresh DB
boots; old local data is untouched. A second application writer is refused.

Verify: Postgres 18 adapter/schema tests; nested rollback/no-wake; migration
rollback; unique-conflict recovery; JSON array/null fidelity; dates/counts;
ownership lock; disconnect during commit; feed reconnect ordering; preserved
state-machine tests against the actual database.

Historical P1 checkpoint (superseded by final local checkpoint), 2026-09-05: Postgres 18 runtime, owned-client lock, checksummed
migrations, millisecond timestamps, JSON/boolean/numeric SQL port and fail-closed
connection handling are implemented. SQL unit coverage moved to tests/postgres;
six pure pool configuration/label/placement tests remain in tests/unit. Existing
integration paths now use isolated tenant databases through a local-only fixture.
The final broad Postgres/integration pass is green: 276 tests, zero skips
(/tmp/playtest-compose-pg-final.log). Dispatch age uses database time.
All workspace hermetic suites pass; the root gate retains the two documented
pre-existing repository failures. No production services have been changed.

## P2 — S3 adapter

- [x] Done

Owns: control-plane `src/store/`, object-store types, config/dependencies,
unit tests and explicit S3 integration fixtures.

Implement AWS SDK v3 operations with explicit endpoint, bucket, prefix, region,
credentials, retries/timeouts and Spaces-compatible checksum configuration.
Implement inclusive ranges, byte hashes, missing-vs-denied errors, idempotent
delete, complete pagination and a metadata-page iterator. Extend the filesystem
adapter for hermetic tests. Add startup permission probes and client teardown.

Seam: the byte-oriented ObjectStore contract remains intact. No public objects
or bucket credentials reach browsers/runners. Failed listings never become empty
success. Keys remain within the installation namespace.

Verify: injected-transport tests offline; real S3-service checks for >1,000
objects, prefixes, binary/range correctness, denied/missing/timeout responses,
retries and duplicate puts/deletes. Real Spaces verification is P7.

## P3 — Publication, GC and memory limits

- [x] Done

Owns: control-plane suites/personas APIs and helpers, executor/live APIs,
project deletion, media, retention, run storage, new lifecycle/reference helpers,
and hosted/artifact contracts.

Move remote object I/O outside DB transactions. Publish immutable keys only
after ownership/sequence checks; retain live budgets and bundle/report checks.
Replace eager failed-publication deletes with reference-aware collection.
Implement shared publication/read and exclusive deletion guards, fixed lock
order, bounded GC batches and orphan age grace. Reuse one complete reference
enumerator for GC, backup and restore verification. Include personas, current
files, snapshots, artifacts and live reservations.

Bound heavy byte operations and account for the existing full-bundle cache,
multiple buffers and clip/retention scratch space. Preserve the 512 MiB ceiling
unless the owner explicitly changes it; missing/corrupt evidence is never empty
success.

Seam: failed/retried uploads cannot overwrite or remove accepted evidence; GC
cannot delete bytes still being published. No object call runs in a DB transaction.

Verify: real DB/S3 tests pause at upload/publication/GC boundaries; equal and
different-byte retries; stale executor after write; rollback; persona/current
file preservation; full→core→meta; project deletion; live-only grace; failed list
or delete; orphan recovery. Test publication/deletion lock ordering for deadlocks.

## P4 — Production identity and initial runner

- [x] Done

Owner rulings are recorded in design.md. Owns control-plane
auth, principal types, auth routes, project/site-role guards, site-runner APIs,
bootstrap/config/app, affected web auth handling, and auth contracts/tests.

Implement `PLAYTEST_AUTH=proxy` with authenticated ingress key and validated
forwarded identity, disabled-user rejection, no session fallback, same-origin
checks for proxy browser writes, safe return paths and Authelia logout. Introduce
production `isSiteAdmin` independently of dev auth; apply it consistently to
project listing/guards and site-runner administration while retaining audit identity.
No new OIDC client or OIDC flow is part of this deployment.

Proxy identity implemented on 2026-09-05. Configuration, HTTP identity/audit,
spoofed/duplicate headers, disabled users, ignored sessions, CSRF, safe returns,
logout and bearer scope pass 23 focused tests alongside site-runner coverage.
Production ingress and real Authelia verification remain P7/P8 gates.

Bootstrap an explicitly named site runner from a stable sealed credential:
create once, compare thereafter, refuse mismatch/revocation without resurrection.
Harden runner snapshot/blob/baseline reads to the claimed group's resources;
reject unrelated group and mint-scoped bearers.

Seam: Caddy admission does not replace application authorization. Forwarded
identity grants access only with the trusted ingress key. Tokens/runners inherit no human site-admin
capability. Restart neither rotates nor reactivates a runner credential.

Verify: hermetic token/identity tests; real-DB role guards; missing/wrong ingress key, duplicate/spoofed identity headers,
CSRF, disabled users, safe return paths; bootstrap twice, mismatch,
revocation, runner resource scoping. Actual Authelia/browser proof is P7/P9.

## P5 — Runner transport and container execution

- [x] Done

Owns: runner pool/options/client, exec-group, case-runner, mint, janitor,
evidence/live uploads, server group-spec URL generation and runner/interface
contracts/tests.

Emit relative runner upload paths, resolve against the configured client origin
and enforce safe absolute-template compatibility. Add total/record ceilings
using minima against suite/project settings. Keep one claimed group per agent.
Specify job network, CPU/memory/PID/shm limits, non-root ownership, matched image
and same-absolute-path host mounts. Add mount/image preflight and private
credential-file setup. The agent alone gets the Docker socket; nested Compose
is unsupported in this profile. Use ownership labels for janitor/restart cleanup
and preserve cancellation/fencing on bounded shutdown.

Seam: credentials never follow cross-origin URLs. Jobs see only their workspace
and delivered secrets. Deployment limits cannot be bypassed by suite settings.
Cleanup never touches another runner's resources.

Verify: transport/Docker-argument tests plus actual containers for workspace
read/write, target networking, absent platform secrets/socket, resource ceilings,
cancel/kill, surviving-container recovery and two runner identities. Preserve
report/group completion idempotency.

## P6 — Images and local Compose

- [x] Done

Owns: root Dockerfile/dockerignore/Compose/bake/version files, scripts/local
helpers, package scripts, control-plane health/drain, runner health, fixtures,
README/CLAUDE and `docs/guidance/hosted-deployment.md`.

Build three targets from one revision: control-plane, runner, job. Preserve
native TS and self-contained browser assets. Install matching Chromium/system
libraries and ffmpeg filters/fonts at build time. Compose local Postgres 18,
pinned S3 test service/bucket initializer, control plane, runner and opt-in test
target. Supply disposable local credentials explicitly; do not read an existing
repository env file. Publish only the local UI on loopback.

Add dependency ordering, `/healthz`, internal `/readyz`, bounded probes and drain.
Provide normal-local and production-parity commands, named storage volumes,
explicit limits/retention/log rotation and target-network instructions.
Update `npm run hosted` to the documented Compose startup and preserve direct
developer entrypoints against configured dependencies.

Seam: one documented command boots a fresh local stack. Recreation preserves
metadata, objects and keys. Startup does not build/install, silently select a
storage backend, or regenerate persistent credentials.

Verify: builds and placeholder-only Compose validation; image contents/excluded
secrets/data; local startup/recreation; missing DB/S3/image prevents readiness;
runner idle health; graceful restart and forced dependency loss. Typecheck and root gate.
Sustained active-case health and whole-stack crash recovery remain combined P7
acceptance, alongside real-model execution; they are not claimed by these local probes.

## P7 — Local acceptance, Spaces and restore

- [ ] Done

Owns: explicit DB/S3/container/browser orchestration, reusable backup/restore
tooling, operator guide, concise verification record in this backlog folder.

Run the complete preserved hosted integration tier against Postgres. Drive real
web/API runs through live evidence, reporting, findings, sealed viewing and clips.
Include target-auth secrets and verify decryption after container recreation.

Exercise production parity with a dedicated real Spaces prefix and configured
Authelia forwarded authentication. Prove SDK compatibility/private objects, login/deep links and
internal runner uploads. Missing operator credentials leave this gate incomplete.
Exercise competing claims/retries/review, report-vs-cancel, upload-vs-GC, DB
disconnect, Spaces failure, runner SIGTERM/SIGKILL and abrupt stack shutdown.

Measure peak RSS/CPU/scratch with a near-512-MiB bundle and overlapping upload,
view and clip work. Record the actual supported resource envelope and VM headroom.
Do not report synthetic model/browser tests as real-flow evidence.

Implement maintenance backup: stop admission/writers, acquire the writer lock,
tenant dump plus referenced object copies/manifest, verify, mark complete, resume.
Inject a failed copy; incomplete sets cannot replace older complete backups.
Restore into fresh DB/prefix with the preserved KMS key and verify hashes, suites,
personas, findings, playback and secret decryption. Leave the source intact.

Gate output: exact commands, versions, image revision, outcomes/resource numbers,
restore evidence and explicit unresolved failures. This phase is verification,
not a reason to expand unrelated features.

## P8 — Reviewable infra registration

- [ ] Done

Owns, after reading infra agent instructions: `projects/stacks/playtest/`
Compose/config/key-template/README; shared-Postgres tenant provision SQL and
password forwarding; host assignment; narrowly scoped Authelia routing/policy
config. No changes to `stacks/authelia/auth/`.

Use existing edge/shared-db networks, no production host ports, tenant-role
migrations, explicit per-service env and required-secret guards. Prepare Caddy
ordered labels for gated browser/API, minimal public health and refused public
runner routes. Register the chosen Authelia access policy. Expose bucket/region,
DNS, matching image release, mount/resource and backup-schedule inputs.

Follow deploy-stack: never read plaintext env, never render resolved secrets,
never SSH-deploy, never redefine injected `REGISTRY_DOMAIN`. User enters supplied
secrets locally; generated values are written without reading/printing. Mirror
the tenant password and seal/verify when values exist. Use explicit complete
file lists; avoid leaving half-built files for the infra auto-committer.

Seam: P8 prepares concrete desired-state files and checks; image publication,
registration push and live deployment belong to rollout authorization.

Verify: infra checks, placeholder-only Compose and generated Caddy ordering;
secret key-map parity, external dependency and one-shot/readiness compatibility
with deployctl. P7 must already provide local evidence.

## P9 — Authorized VM rollout and closeout

- [ ] Done

Prerequisites: owner choices resolved, P7 green, P8 reviewable, deployment
inputs/secrets provisioned, and rollout authorized. This design task itself
does not authorize production actions.

Publish matching images; commit/push desired state; provision shared Postgres
before/with Playtest; restart Authelia for config changes; deploy via deployctl.
Verify external health/TLS, authenticated real run, anonymous denial/public
runner refusal, private uploads, persistence after redeploy, retention heartbeat
and a completed backup. Rollback requires schema-compatible images or an explicit
recovery set; arbitrary image rollback after migrations is not guaranteed.

Update durable hosted/runner/interface/artifact contracts, `docs/playtest-design.md`,
CLAUDE/startup docs and operator guide. Remove obsolete SQLite/dev-supervisor
claims and references to intentionally deleted backlog items. Move useful
verification evidence into durable docs. Only after acceptance ships, mark the
roadmap complete and perform backlog closeout; this folder is ephemeral.

## Intermediate build checkpoint — 2026-09-05

P2 adapter and its startup probe pass injected transport tests and real MinIO
checks (1,010 objects, binary/ranges, isolation, denial, retries/timeouts).
P3 implements publication/deletion guards, rejects object I/O in transactions,
immutable bundle/clip/core keys, complete reference enumeration and one-day
orphan grace. PostgreSQL/S3 publication and restore tests pass; resource-envelope
verification is still pending. P4 bootstrap preserves stable credentials and
refuses mismatch/revocation; runner reads are constrained to their claim.
P5 implements safe relative transport, job profiles, ownership cleanup and
host-mount/revision preflight. P6's three images build; local Compose is healthy
on port 24177 (4177 is occupied by an existing service, left intact).

The first container probe exposed Docker Desktop's socket group (0) differing
from the macOS socket group; the helper now uses the daemon-side group on macOS.
A quoted local KMS key prevents YAML numeric coercion. PostgreSQL's local app
role is an ordinary tenant; only the initializer uses the disposable admin.

The two inherited root-gate defects are repaired without deleting the standalone
presentation tool: bundled schema copies now match their runtime sources, and
the lockfile check covers the product workspaces it claims to govern. The
presentation package explicitly declares itself outside the npm workspace.
Final root/typecheck/full integration checks remain required after packaging.

P7 real Spaces endpoint/bucket/test-prefix inputs were requested and remain
pending. No env files have been read and no production changes have been made.

## Final local checkpoint — 2026-09-05

Owner follow-up: local Compose must use the existing co-located codex-gateway.
The local default now names `host.docker.internal:8900`; explicit empty URL
still disables model work. Authoring defaults to `gpt5_6_sol` to use the working
gateway route. Real drafting returned HTTP 200 with a validated draft; see
acceptance.md. Production gateway settings remain explicit and unchanged.

Node 24.18 typechecking passes. The offline root gate passes 1,035 tests; the
Postgres/integration tier passes 277; the real S3 tier passes 5. All have zero
skips. Matching images `58d604245bffcf64c5cc` boot healthy on loopback port 24177.
Real containers verify Chromium, target networking, mount ownership, resource
limits, platform credential isolation, two-runner cleanup, and bounded force-stop
of a child that ignores SIGTERM. Recreation preserves objects, runner credential
identity and secret decryption. S3 loss removes readiness; DB connection loss
requires process restart and writer-lock reacquisition.

Near-limit acceptance uploads a 534,775,984-byte bundle through the real runner
container, then overlaps a same-byte retry, download and clip. Control-plane
peak is 2,427,375,616 bytes; upload-process RSS is 614,019,072 bytes. Runner cgroup
usage reaches its 1 GiB cap while reclaiming file cache, with zero OOM events.
The full measured envelope and its limits are in acceptance.md; large-run
sanitization/sealing and VM headroom remain P7, not inferred from transport.

The live regression exposed a cancelled upload queued before body reading: an
already-destroyed request could hold the heavy-operation queue forever. Body
reading now rejects early and on premature close; a real HTTP regression detects
the missing guard. Heavy-operation admission now lasts through response completion.
The existing real runner/scripted-gateway live test and full integration tier pass.

P8 preparation is deliberately staged in the product repo to avoid the infra
auto-committer publishing incomplete desired state. Placeholder-only production
Compose/bake checks and Caddy adaptation pass. The ingress key uses a Caddy env
placeholder, with mirrored edge-proxy setup documented, so config logs do not
contain its value. Live Docker-label generation, secret parity and infra checks
remain pending actual registration. No env file was read; no infra commit, image
push, database provision, DNS change or live deployment was performed.
