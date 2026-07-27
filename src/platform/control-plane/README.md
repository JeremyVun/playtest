# src/platform/control-plane — hosted Playtest control plane

The REST API + web-app host for hosted Playtest. Plain JS, ESM, Node >= 22.5
(for the built-in `node:sqlite`), **zero npm dependencies**, no build step. It
consumes core through the supported `../../core/public/*` entry points,
never by importing implementation files. Cross-component behavior is defined in
`docs/contracts/hosted.md`.

It owns the hosted API, authentication, persistence, dispatch, viewer adapter,
inline story drafting, findings (including discovery study synthesis), and
retention. The browser UI and runner agent are sibling components of the same
hosted product under `src/platform/`.

## Run it

No database service and nothing to install:

```sh
scripts/hosted-server.sh         # from the repo root; same as `npm run hosted`
# → http://127.0.0.1:4177  (web app + /api/v1)

scripts/hosted-server.sh migrate # apply pending migrations and exit (deploy hook)
```

The launcher is the local path: it checks the Node version, sources the
gitignored repo-root `.env` (anything you set on the command line still wins),
keeps one data root and one generated KMS key, reclaims port 4177 from a Playtest
server left running by an earlier session, and prints what is switched on —
including whether the model gateway is configured, which is the difference
between "Help me draft" working and answering `503 not_configured`. It is a
convenience, not a contract: the server itself reads only the environment, so a
deployment starts it directly.

```sh
PLAYTEST_DATA_DIR=./.playtest-data \
PLAYTEST_AUTH=dev \
PLAYTEST_KMS_KEY=$(openssl rand -base64 32) \
node src/index.ts
```

`PLAYTEST_DATA_DIR` (default `.playtest-data`) is the one storage knob: it holds
`playtest.sqlite` and the `objects/` store on the same durable volume. Exactly one
process may write that database — see `docs/contracts/hosted.md`, "Storage,
deployment topology, and transactions". `OBJECT_STORE_URL` and `PLAYTEST_DB_FILE`
are expert overrides that split state across locations.

`PLAYTEST_AUTH=dev` is a single-user bypass (a fixed dev admin, admin of every
project) — never in production.

`PLAYTEST_DISPATCH=local` (dev auth only, and the launcher's default there) makes
**Launch actually execute
locally**: instead of dispatching a GitHub workflow, the server spawns the real
runner-agent (`src/platform/runner-agent`, process isolation) against itself — the full
executor protocol, browser and all. The child inherits the server's env, so set
`PLAYTEST_LLM_BASE_URL` (+ `PLAYTEST_LLM_TIMEOUT_MS` for slow gateways) on the
server process. Local children are tracked in-memory: restart the server and the
reconciler declares orphaned dispatches dead, same as a vanished GHA workflow.
OIDC mode uses `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`.
`src/config.ts` owns the complete configuration surface and reports every
failure as a friendly `ServerConfigError` naming the offending variable.

### Model tiers

Two control-plane jobs call the gateway: **inline story drafting** (the story
form's Help me draft) and **discovery study synthesis** (studies becoming cited
bug candidates in findings intake). Both default to the grader tier, `sonnet`,
and each has its own override so pinning one never moves the other:

| Variable | Job | Default |
|---|---|---|
| `PLAYTEST_AUTHORING_MODEL` | inline story drafting | `sonnet` |
| `PLAYTEST_SYNTHESIS_MODEL` | discovery study synthesis | `sonnet` |

Leave both unset unless a deployment has measured a reason to pin one.

## Test tiers

```sh
npm test                         # unit, hermetic
npm run test:integration         # whole control plane, no database service
```

- `tests/unit/` — offline, service-free (ulid, tar, router, object-store, crypto,
  roles/paths, the core-bridge resolver, config, and the SQLite schema, constraint,
  transaction, one-winner, and startup-failure suites, each against a temporary
  database file under `mkdtemp`).
- `tests/integration/` — each test boots the whole control plane on an ephemeral
  port against its own temporary data root (one SQLite file plus its object store,
  removed on teardown), so suites parallelize and leave no residue. No PostgreSQL,
  no Docker. On-demand clip tests additionally need a full `ffmpeg` (with the
  `subtitles` and `drawtext` filters). Includes an import round trip: import
  `examples/todos` → edit → commit → export → run the exported tree with the local
  CLI, asserting identical resolved cases (`playtest list --json` parity). There
  is no environment gate: every integration test runs wherever `npm install` does.

The root `npm test` covers core, CLI, viewer, and dependency-boundary contracts.

## Module map (`src/`)

```
index.js  app.js        entrypoint + the createApp() factory (tests reuse it)
config.ts               env → validated config, friendly failures
db.ts  migrate.ts       SQLite connection + pragmas + withTx; plain-SQL migrations runner
server.js  router.ts    request pipeline + pattern router; error-envelope mapping
routes.js  http.ts      route table (§2); request/response plumbing
errors.ts  ulid.ts  audit.ts  logging.ts
leases.ts               named leases for background cycles: one winner, expiry, crash recovery
store/     object-store seam: fs-store (default) + s3-store (skeleton)
crypto/    AES-256-GCM secret encryption
auth/      oidc + sessions + roles + api tokens + the principal resolver
suites/    paths · tar · snapshots (content-addressed) · resolve (the core bridge)
api/       projects · suites · environments · secrets · tokens · audit · auth-routes
migrations/  forward-only numbered SQL migrations
```

The one place the platform meets core: `suites/resolve.js` materializes a suite's files
to a temp dir in exact CLI layout and runs core `discoverCases`/`lintCase` — the ONE
resolver. Everything else is storage, transport, and authz around that.
