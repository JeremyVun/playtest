# Hosted Playtest control plane

`@playtest/control-plane` is the server for hosted Playtest. It serves the web
console and REST API, authenticates people and runners, stores product state,
dispatches work, and turns completed run evidence into reviewable journeys and
durable findings.

It coordinates runs but does not execute user journeys. Execution belongs to
the sibling runner-agent package, which calls the same `@playtest/core` engine
as the local CLI.

```text
 browser
    |
    v
control plane ----serves----> web console + embedded run viewer
    |
    +----> SQLite metadata
    +----> run/object storage
    +----> dispatcher ----> runner agent ----> application under test
    ^                           |
    +------ reports + bundles --+
```

## What it owns

- The `/api/v1` HTTP API and its error, caching, and authorization conventions.
- Development and OIDC authentication, roles, sessions, and API tokens.
- Projects, suite snapshots, applications and rings, personas, secrets, and rule cards.
- Run placement, runner exchange, progress, reconciliation, and cancellation.
- Baseline review, findings intake, consolidation, and automatic resolution.
- Audit events, retention, health and operations status, and media export.
- SQLite migrations and the filesystem or S3-compatible object-store seam.

The server consumes engine behavior only through `@playtest/core/*` package
exports and serves only the completed `@playtest/web/assets` build.

## Run it locally

Use the repository launcher from the repository root:

```sh
npm run hosted
# http://127.0.0.1:4177
```

This is the complete local platform. It builds both browser applications,
defaults the control plane to development auth, and supervises one peer
`runner-agent pool` process beside the server — a launch posts to the claim
board and that runner claims it, exactly as a CI or fleet runner would. Do not
start the web or runner-agent workspaces as separate local services.

The server needs no separate database service. `PLAYTEST_DATA_DIR` defaults to
`.playtest-data` and contains both `playtest.sqlite` and the local object store.
Only one process may write a given database file.

For deployment or focused server work, the package entry point is:

```sh
npm start --workspace=@playtest/control-plane
npm run migrate --workspace=@playtest/control-plane
```

`src/config.ts` is the complete configuration inventory and validates all
settings at startup. Important groups include storage, auth, dispatch, OIDC,
model access, retention, reconciliation, and rate limits. `PLAYTEST_AUTH=dev`
is a single-user development bypass and must not be used in production.

## Source map

```text
src/index.ts          process entry and migration command
src/app.ts            application assembly and background workers
src/server.ts         HTTP server and static web host
src/routes.ts         complete route table
src/config.ts         environment configuration and validation
src/db.ts             SQLite connection and transactions
src/auth/             people, roles, sessions, tokens, and OIDC
src/api/              human-facing API handlers and the runner claim board
src/dispatch/         launch placement, target snapshots, and reconciliation
src/dev-runner.ts     dev-auth seeding of the site-scoped `local` runner
src/suites/           safe suite storage, snapshots, export, and core resolution
src/findings/         finding intake, deduplication, synthesis, and resolution
src/events/           event feed and outbox
src/live/             open-run ingest, staging, and serving
src/media/            clip and media export
src/authoring/        story authoring and assistance
src/store/            filesystem and S3-compatible object stores
src/retention/        evidence-retention policy and worker
migrations/           the single baseline SQLite migration
```

## Development

Run these from the repository root:

```sh
npm run typecheck --workspace=@playtest/control-plane
npm test --workspace=@playtest/control-plane
npm run test:integration --workspace=@playtest/control-plane
```

Unit and integration tests use temporary SQLite data roots and need no database
service or Docker. A clip integration case additionally needs `ffmpeg` with the
`drawtext` and `subtitles` filters.

Cross-component guarantees, deployment topology, and API conventions are
defined in [`docs/contracts/hosted.md`](../../../docs/contracts/hosted.md).
Runner placement and execution are defined in
[`docs/contracts/hosted-runners.md`](../../../docs/contracts/hosted-runners.md).
