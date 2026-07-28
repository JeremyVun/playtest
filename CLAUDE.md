# Playtest

Playtest is an AI-driven user-journey regression harness for web, mobile, and
HTTP APIs. An actor follows a plain-language story against a real application;
deterministic gates and an LLM grader evaluate the recorded trajectory. The
repository contains the local CLI and engine, a trajectory viewer, and the
hosted product.

## Start here

- `README.md` — user-facing CLI usage, configuration, and examples.
- `docs/playtest-design.md` — product concepts and terminology.
- `docs/CONTRACTS.md` — index of the thematic contracts under
  `docs/contracts/`.
- `docs/contracts/hosted.md` — hosted system boundaries and cross-component
  contracts.
- `docs/ROADMAP.md` — index of future work. Put new plans under
  `docs/backlog/` and link them from the roadmap.

## Technology and package boundaries

- Use Node.js 24 LTS (24.18.0 or newer) and ESM.
- The root package is a private orchestration-only npm workspace root. The six
  product packages under `packages/` own their direct dependencies, exports,
  executables, and scripts; the repository has one root `package-lock.json`.
- Maintained first-party source is strict TypeScript using erasable syntax.
  Node-side `.ts` files run directly through Node's native type stripping; do
  not add emitted twins or a `dist/` tree.
- Node-side imports name real `.ts` files. Relative browser imports under
  `packages/platform/web/src/`, `packages/run-viewer/src/web/`, and
  `packages/core/src/shared/` keep browser-facing `.js` specifiers; cross-package
  imports use package exports.
  The two browser packages build with their package-local Vite configs;
  keep `envDir: false` so Vite never loads `.env` files. `npm run build:web`
  creates self-contained, gitignored builds under the run-viewer and
  platform-web packages; it does not emit twins beside source.
- Run `npm run typecheck` for every TypeScript project. Do not convert or
  hand-edit `packages/platform/web/src/vendor/`.

## Repository map

```text
packages/
  core/                      Journey engine, drivers, grading, schemas, artifacts
  cli/                       Commander CLI, shipped skills, and terminal UX
  run-viewer/                Static trajectory viewer and local read-only host
  platform/
    control-plane/           Hosted API, auth, persistence, dispatch, and migrations
    runner-agent/            Isolated hosted run executor
    web/                     Hosted browser UI and complete hosted web build
tests/                       Cross-package and shared repository test infrastructure
  repository/                Workspace, export, and dependency-boundary tests
  fixtures/                  Test-owned applications and Playtest suites
  support/                   Support and corpora shared by multiple packages
examples/                    Standalone user examples; never a test or product dependency
studies/                     Self-contained research and evaluation projects
docs/backlog/                Forward-looking designs indexed by `docs/ROADMAP.md`
runs/                        Local run artifacts; gitignored
```

`packages/platform/` is grouping only; its three children are peer workspaces.
Cross-package code must use the owning workspace's documented package exports,
never a relative path into another package. Tests live under the package they
exercise; root tests are reserved for repository boundaries, shared support,
and true cross-package behavior.

## Install and run

```sh
npm install
npm link --workspace=@playtest/cli    # optional: expose `playtest` on PATH
node packages/cli/src/cli.ts --help   # run the CLI without linking
PORT=4173 node examples/todo-app/server.js
```

`npm install` runs `npm run build:web`, producing a self-contained viewer build
under `packages/run-viewer/build/` and a hosted-console build (including that
viewer) under `packages/platform/web/build/`. Browser tests and the hosted
server rebuild them automatically.

Registry distribution is descoped. The supported install remains a repository
checkout plus `npm link`; do not add publishing configuration unless that
product decision is explicitly reopened.

Real browser runs require Chromium once:

```sh
npx playwright install chromium
```

Real iOS Simulator runs (`npm run test:mobile`) need Xcode and, once:

```sh
APPIUM_HOME="$HOME/.appium" npx appium driver install xcuitest
```

The hosted product needs no database service. Metadata is one `node:sqlite`
file under the data root, with the object store beside it; the repository-wide
Node 24.18 floor applies. `PLAYTEST_DATA_DIR` is the single storage knob and
defaults to `.playtest-data`.

```sh
npm run hosted                        # complete local platform at http://127.0.0.1:4177
npm run hosted:migrate                # optional; the server migrates on boot
```

`npm run hosted` is the sole local startup command. It builds both Vite
applications, starts the control plane that serves the API and web UI, and uses
local dispatch so the control plane spawns runner-agent jobs on demand. Do not
start the web or runner-agent workspaces as separate services.

The CLI does not load `.env`. Never read any `.env` file without the user's
explicit permission.

## Test

```sh
npm test                              # dependency-free workspace suites + repository gate
npm run test:core
npm run test:cli
npm run test:viewer
npm run test:repository
npm run test:browser                  # explicit Playwright suites
npm run test:mobile                   # explicit Appium / iOS Simulator suite
npm run test:all                      # hermetic and browser suites
npm run hosted:test                   # control-plane unit tests
npm run test:integration --workspace=@playtest/control-plane
npm run runner:test
```

`npm test` must remain offline, Node-only, and independent of browsers, model
credentials, databases, and Docker, with zero skipped tests. Control-plane
integration tests intentionally remain an explicit tier because they require
integration dependencies; each boots the whole control plane against its own
temporary SQLite data root. Their clip case does need
`PLAYTEST_FFMPEG` pointed at an ffmpeg built with the `drawtext` and `subtitles`
filters.

## Change rules

- Keep changes small and preserve existing behavior unless the task changes a
  contract.
- Record engine, configuration, artifact, schema, and public API contract
  changes in the owning file under `docs/contracts/`.
- Surface local CLI configuration and user-input failures as
  `DummyConfigError` (`packages/core/src/config.ts`); hosted startup configuration
  failures use `ServerConfigError`
  (`packages/platform/control-plane/src/config.ts`). Messages must be actionable and
  must not expose raw stacks or `MODULE_NOT_FOUND`.
- Keep the web driver compatible with existing prompts, envelopes, manifests,
  and baselines unless the relevant contract and version pins change.
- Do not add external network, model, database, Docker, or browser dependencies
  to the hermetic root test gate.
