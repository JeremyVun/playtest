# Hosted Playtest

The hosted service uses PostgreSQL 18, private S3-compatible object storage, one
control plane and one runner. Case containers use a matching job image. Start
with a fresh database and object prefix; local SQLite data is not imported.

## Local stack

Use Node 24.18+ and Docker with at least 10 GiB assigned for the initial resource
limits. This is the configured budget; full-workload and VM capacity acceptance
remain required. From the checkout:

```sh
npm run hosted
# If another service occupies 4177:
PLAYTEST_LOCAL_PORT=24177 npm run hosted
npm run hosted:logs
npm run hosted:down
```

The helper hashes image inputs, builds three matching release images, creates an
absolute workspace path and starts Compose. It never loads an env file. Only
the UI is published, on loopback. Disposable local credentials are explicit in
`compose.yaml`; they are unsuitable for a remotely accessible deployment.
The sample target is reachable from jobs at `http://test-target:4173`.

Local Compose defaults to the host's codex-gateway at
`http://host.docker.internal:8900` on Docker Desktop. Override
`PLAYTEST_LLM_BASE_URL` and, if needed, `PLAYTEST_LLM_API_KEY` before startup to
use another gateway. The endpoint must be reachable from the control plane,
runner and job networks; Linux installations must supply a reachable endpoint.
An explicitly empty `PLAYTEST_LLM_BASE_URL` disables model-backed features.
Production requires its own explicit gateway configuration.
Local story drafting defaults to `gpt5_6_sol`; `PLAYTEST_AUTHORING_MODEL`
overrides it. This selects the gateway's explicit GPT route rather than its
fallback Codex SDK model.

`down` preserves metadata and objects. `up` rebuilds changed images. For an
already-built release, `node scripts/hosted/compose.ts start` starts services.
Do not delete the named volumes to redeploy. The original `.playtest-data`
directories are untouched. Direct development remains available with
`npm run hosted:direct` against explicitly configured Postgres/storage.

## Deployment inputs

| Service | Required inputs |
|---|---|
| Control plane | `DATABASE_URL`; S3 settings below; `PLAYTEST_KMS_KEY`; `PLAYTEST_AUTH=proxy`; HTTPS `PUBLIC_URL`; `PLAYTEST_PROXY_SECRET`; HTTPS `PLAYTEST_AUTH_LOGOUT_URL`; stable `PLAYTEST_SITE_RUNNER_NAME` and `PLAYTEST_SITE_RUNNER_CREDENTIAL` |
| Runner | `PLAYTEST_SERVER_URL` (internal control-plane origin); `PLAYTEST_RUNNER_CREDENTIAL` or private credential file; `PLAYTEST_RUNNER_ISOLATION=container`; absolute `PLAYTEST_RUNNER_WORKDIR`; matching `PLAYTEST_JOB_IMAGE`; `PLAYTEST_JOB_NETWORK`; numeric non-root `PLAYTEST_JOB_UID` and `PLAYTEST_JOB_GID` |
| Case/mint job | Only the assigned workspace or mint directory, explicitly delivered target secrets, and configured model-gateway settings |

S3 settings: `OBJECT_STORE_URL` is the regional HTTPS endpoint,
`OBJECT_STORE_BUCKET`, `OBJECT_STORE_PREFIX` is a nonempty installation path,
`OBJECT_STORE_REGION`, `OBJECT_STORE_ACCESS_KEY`, and `OBJECT_STORE_SECRET_KEY`.
DigitalOcean recommends `us-east-1` as the SDK region; the endpoint selects the
Spaces location. Use virtual-host addressing for Spaces. Local service tests
explicitly set `OBJECT_STORE_ALLOW_HTTP=1` and
`OBJECT_STORE_FORCE_PATH_STYLE=1`. Requests default to a 60-second deadline and
three attempts; `OBJECT_STORE_TIMEOUT_MS` and `OBJECT_STORE_MAX_ATTEMPTS` override
these within validated bounds. [DigitalOcean SDK configuration](https://docs.digitalocean.com/products/spaces/reference/aws-sdks/)

Store the 32-byte KMS key and runner credential durably before first startup.
Restart never regenerates the configured runner credential or resurrects a
revoked registration. A mismatch fails startup. The KMS key is required to
recover target secrets and session artifacts. Browsers and jobs receive neither
S3 credentials nor database/KMS/ingress secrets.

Optional model configuration is explicit per service:
`PLAYTEST_LLM_BASE_URL` and `PLAYTEST_LLM_API_KEY` (or the supported provider-key
alias) enable authoring on the control plane and model work in jobs. Add them
only to the services that need them. No repository env file is inherited.

## Authentication and networking

Caddy admits users through the existing Authelia policy. Strip incoming
`Remote-User`, `Remote-Email`, `Remote-Name`, `Remote-Groups`, and
`X-Playtest-Proxy-Key` before forward authentication. Copy only Authelia's verified
identity headers, then inject the generated stable ingress key. The control
plane validates that key and gives every admitted human site-admin access while
retaining individual audit identities. Browser writes must originate at
`PUBLIC_URL`. API and runner bearers keep their own scope.

Supply the same ingress key to the edge-proxy environment and reference it as
`{env.PLAYTEST_PROXY_SECRET}` in labels. Do not interpolate its value into labels:
Caddy's generated configuration is logged. The registration candidate lists
the required mirrored key and restart in `deploy/playtest/README.md`.

Caddy exposes `/healthz`, blocks `/readyz` and public `/api/v1/runner/*`, and gates
the remaining browser/API surface. Runner traffic uses the private origin.
`/readyz` is loopback-only and checks cached dependency status. Startup verifies
Postgres ownership/migrations/bootstrap and S3 put/read/range/list/delete;
periodic readiness reads a stable sentinel. A lost database connection stops
admission and requires restart to reacquire the writer lock.

The runner's host workspace must be mounted at the **same absolute path** in
its container. Jobs mount only their own directory. Startup launches a probe
job that reads and writes that mount and checks the image revision. The Docker
socket reaches the agent alone. On Docker Desktop for macOS its daemon-side
socket group is 0; Linux uses the host socket group. Nested Compose targets are
unsupported; attach targets to the named job network.

Defaults: one group per runner; `PLAYTEST_RUNNER_MAX_TOTAL=1` and
`PLAYTEST_RUNNER_MAX_RECORD=1` cap suite/project concurrency. Jobs use 2 GiB,
2 CPUs, 512 PIDs and 512 MiB shared memory, configurable through
`PLAYTEST_CASE_MEMORY`, `PLAYTEST_CASE_CPUS`, `PLAYTEST_CASE_PIDS`, and
`PLAYTEST_CASE_SHM`. The control plane is limited to 4 GiB and the runner to
1 GiB. Include Postgres, object service, active job and other VM services in
capacity planning. Logs rotate at 10 MiB × 3 per service.

Local measurement on release `58d604245bffcf64c5cc`: a 510 MiB sealed bundle
uploaded through the runner, followed by overlapping retry/download/clip work,
peaked at 2.26 GiB in the control plane, 586 MiB RSS in the upload subprocess,
and 510 MiB of control-plane scratch. The runner reached its 1 GiB cgroup limit
while reclaiming file cache, with zero OOM events. These numbers cover transport
and clipping; near-limit sanitization/sealing, sustained model workloads and
headroom beside other VM services remain unverified.

## Publication and retention

The sealed bundle ceiling remains 512 MiB. Heavy upload/view/clip operations
serialize; the existing bundle cache can retain one bundle above its nominal
256 MiB budget. Objects publish under immutable keys before a short, fenced
metadata transaction. Failed publication leaves an orphan; it never eagerly
deletes another request's accepted evidence.

Collection waits for readers/publishers, enumerates all references, and deletes
at most 1,000 orphan objects per cycle after a one-day age grace. References
include current suite content, snapshots, personas, artifacts, live reservations,
and independent baseline/candidate bundle pointers. Set
`PLAYTEST_RETENTION_INTERVAL_S` and `PLAYTEST_RECONCILE_INTERVAL_S` explicitly;
local Compose uses 3600 and 10 seconds. Retention defaults are 14 days for
events, 90 full, 365 core. Full/core can be `forever`.

## Maintenance backup and restore

Schedule a maintenance window. Stop the runner first, then the control plane;
allow their 45-second Compose stop grace. This stops admission, cancels current
work and drains server operations. Keep database and object services available.
Use the same control-plane image/environment for the maintenance command with
a private writable backup directory mounted into it:

```sh
node packages/platform/control-plane/maintenance.ts backup /backups/unique-set
```

The command acquires the application's database writer lock, refuses a live
control plane, uses PostgreSQL 18 `pg_dump`, and copies every referenced object
with verified hashes. It checks decryption with the supplied KMS key. Each set
gets its own directory; only a verified manifest gets `COMPLETE`. Failed sets
remain incomplete and cannot replace an older complete backup. The key itself
is stored separately in the operator's secret recovery system.

Restore uses a **fresh empty tenant database and a fresh empty object prefix**,
with the original KMS key. Preserve the source:

```sh
node packages/platform/control-plane/maintenance.ts restore /backups/complete-set
```

Restore validates the completion marker, dump and object hashes, copies objects,
restores metadata transactionally with `pg_restore`, checks migration checksums,
reference completeness and secret decryption. A failed restore is not a usable
installation; retry into fresh destinations after correcting the failure.
Start the control plane and runner only after the command succeeds. Verify
suite/persona reads, findings, playback and target authentication before opening
admission. Resume the original stack after backup, even if the copy failed.

## Verification tiers

`npm test` stays offline and Node-only. Database tests require an explicitly
named disposable loopback admin database `/playtest_test_admin`; the fixture
creates and removes ordinary tenant roles/databases. Never point it at a real
installation. S3 tests require a disposable loopback MinIO service using the
credentials in their fixture.

```sh
npm run typecheck
npm test
npm run test:postgres --workspace=@playtest/control-plane
npm run test:integration --workspace=@playtest/control-plane
npm run test:s3 --workspace=@playtest/control-plane
npm run test:containers --workspace=@playtest/runner-agent
node --test --test-concurrency=1 packages/platform/control-plane/tests/containers/*.test.ts
```

Required test inputs: `PLAYTEST_TEST_POSTGRES_URL`, `PLAYTEST_TEST_S3_URL`;
container tests also take `PLAYTEST_TEST_JOB_IMAGE` and
`PLAYTEST_TEST_RUNNER_WORKDIR`. Clip tests need ffmpeg with `drawtext` and
`subtitles` via `PLAYTEST_FFMPEG`. Real Spaces, Authelia admission, live model
execution and VM resource/recovery acceptance remain separate deployment gates;
a mocked gateway is not proof of those integrations.

Control-plane container probes also require `PLAYTEST_TEST_COMPOSE_URL` pointing
at the disposable loopback UI. Keep those files sequential: recreation tests
intentionally stop local Postgres and object storage, then restore readiness.
