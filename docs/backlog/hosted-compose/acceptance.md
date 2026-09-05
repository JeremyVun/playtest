# Hosted Compose acceptance — 2026-09-05

Local implementation is verified. Production acceptance and rollout are pending;
this record does not claim real Spaces, Authelia, model or VM verification.

## Verified build

- Release: `58d604245bffcf64c5cc`, shared by control-plane, runner and job images.
- Node 24.18.0; PostgreSQL server/client 18.6; Playwright 1.60.0 with Chromium.
- Local Compose: `http://127.0.0.1:24177`; target: `http://test-target:4173`.
  Port 4177 belongs to an existing service and was left alone.
- Images retain native TypeScript and built browser assets, run non-root, and
  exclude env files, repository history, tests and local run data.
- Empty production database/prefix; all admitted humans are site admins through
  verified forwarded identity. No OIDC client or data import was added.

## Gates

| Check | Result | Log |
|---|---|---|
| `npm run typecheck` | Pass | `/tmp/playtest-compose-typecheck-last.log` |
| `npm test` | 1,035 pass, zero skips | `/tmp/playtest-compose-root-verified.log` |
| Postgres + hosted integration | 277 pass, zero skips | `/tmp/playtest-compose-pg-verified.log` |
| Real S3 service | 5 pass, zero skips | `/tmp/playtest-compose-s3-verified.log` |
| Real job profile, ownership cleanup, forced cancellation | 3 pass | `/tmp/playtest-compose-profile-final.log` |
| Container recreation and dependency failure | Pass | `/tmp/playtest-compose-recreation-verified.log` |
| Near-limit runner upload + overlapping retry/download/clip | Pass | `/tmp/playtest-compose-envelope-verified.log` |
| Matching image builds and healthy startup | Pass | `/tmp/playtest-compose-build-verified.log` |
| Production Compose/bake with placeholders only | Pass | Recorded in build session |
| Ordered label values adapted by Caddy 2.12 proxy image | Pass | `/tmp/playtest-compose-caddy-adapt.log` |

The S3 service is disposable MinIO. Tests cover 1,010-object pagination, ranges,
binary fidelity, namespace isolation, denied/missing/timeout responses, bounded
retries, publication/GC exclusion, immutable retry identity, independent baseline
references and backup/restore. Backup refuses the live writer; failed dump and
failed object-copy sets never receive COMPLETE or replace an older complete set.
Fresh restore verifies object hashes, references and secret decryption.

The real job probe launches Chromium against the target and verifies host mount
read/write, non-root UID, CPU/memory/PID limits and absence of platform credentials
and the Docker socket. Cleanup preserves another runner's surviving container.
The cancellation probe uses the real isolation/teardown path with an intentionally
uncooperative child; it is force-stopped in under six seconds.

Recreation preserves persona bytes, runner registration identity and target-secret
decryption. Stopping S3 removes readiness and recovery restores it. Stopping
Postgres removes admission and requires a fresh control-plane process to reacquire
the application writer lock. The production initializer separately passed first
creation, stable restart, credential-mismatch refusal and mode 0600 checks.

The hosted live-flow integration uses a real runner and API driver with a scripted
model gateway. It proves live evidence and sealing, not real-model behavior.
A cancelled request queued before body reading exposed a hang; the new real HTTP
regression passes with the guard and hangs when the guard is removed. The guard
was restored before the full passing suites and final image build.

## Measured local envelope

| Measurement | Result |
|---|---:|
| Bundle size | 534,775,984 bytes (510 MiB plus bundle metadata) |
| Control-plane cgroup peak | 2,427,375,616 bytes (2.26 GiB), limit 4 GiB |
| Upload subprocess peak RSS | 614,019,072 bytes (586 MiB) |
| Runner cgroup peak | 1,073,741,824 bytes (1 GiB), equal to its limit |
| Runner OOM / OOM-kill events | 0 / 0 |
| Control-plane CPU for the test | 8.42 CPU-seconds |
| Sampled control-plane scratch peak | 534,810,624 bytes (510 MiB) |
| Fixture workspace | 1,069,549,744 bytes (about 1 GiB) |
| Overlapping retry/download/clip completion | 8.67 seconds |

The runner reclaimed file cache at its cap; these results do not establish spare
runner memory. The fixture constructs a sealed bundle, then uses the production
ApiClient inside the running runner container. Near-limit sanitizer/sealer memory,
real-model/browser workload peaks and shared-VM headroom remain unverified.
The local 10 GiB Docker recommendation is a configured budget, not a VM capacity
approval. The artifact ceiling remains 512 MiB.

## Reproduction

Use Node 24.18+ on PATH. The database fixture requires an explicit disposable
loopback admin URL ending in `/playtest_test_admin`. S3 tests require the
disposable loopback MinIO URL and credentials documented in their helper.
Neither tier loads an env file.

```sh
npm run typecheck
npm test
node --import ./tests/support/hermetic.ts --test --test-concurrency=6 \
  packages/platform/control-plane/tests/postgres/*.test.ts \
  packages/platform/control-plane/tests/integration/*.test.ts
node --test packages/platform/control-plane/tests/s3/*.test.ts
PLAYTEST_LOCAL_PORT=24177 npm run hosted
node --test packages/platform/runner-agent/tests/containers/profile.test.ts
node --test --test-concurrency=1 packages/platform/control-plane/tests/containers/*.test.ts
```

Export `PLAYTEST_TEST_POSTGRES_URL`, `PLAYTEST_TEST_S3_URL`, and
`PLAYTEST_FFMPEG` for their respective tiers. Container probes require
`PLAYTEST_TEST_JOB_IMAGE=playtest-job:58d604245bffcf64c5cc`,
`PLAYTEST_TEST_RUNNER_WORKDIR=<absolute checkout>/.playtest-compose/runner` and
`PLAYTEST_TEST_COMPOSE_URL=http://127.0.0.1:24177`. Run the control-plane container
files sequentially: recreation deliberately stops local dependencies.

## Remaining acceptance and rollout

Local gateway follow-up: Compose now defaults to the co-located codex-gateway
at `http://host.docker.internal:8900`, with `gpt5_6_sol` for story authoring.
The owner reported the disabled Help me draft control; the missing gateway URL
caused the capability to be false. Health checks pass from control-plane, runner
and job containers. A real story-draft request returned HTTP 200 and one validated
draft after three model calls. The temporary verification project was removed.
The previous authoring default fell through to the gateway's Codex SDK, which
rejected its configured `gpt-6-astra` model as requiring a newer Codex version.
The explicit Sol route succeeds without modifying or restarting the gateway.
This verifies local drafting, not model-backed journey or production acceptance.

1. Supply the real Spaces endpoint, bucket and dedicated test prefix; provision
   credentials locally. Verify private objects and SDK compatibility there.
2. Exercise real Authelia admission, login/deep links/logout and denied public
   runner routes. Caddy adaptation above uses the ordered candidate label values;
   actual Docker-label generation and live routing remain unverified.
3. Run model-backed web/API journeys, sustained active-run health, runner
   SIGTERM/SIGKILL and abrupt whole-stack recovery. Verify restored suites,
   findings, playback and target authentication through the application.
4. Measure the complete large-run sanitizer/sealer and proposed VM headroom.
5. Complete registration inputs and sealed-key parity, infra checks, shared-DB
   provisioning, edge-proxy key mirroring, Authelia rule, host assignment and DNS.
   Review candidates are in `deploy/playtest/`; the infra repo is unchanged.
6. After these gates and rollout authorization: publish matching images, register
   and deploy through deployctl, verify external acceptance and a maintenance
   backup, then close the backlog.

No env file was read. No production infrastructure, DNS, image registry or old
SQLite/object data was changed. Existing unrelated workspace edits are preserved.
