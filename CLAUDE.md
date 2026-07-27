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

## Technology and migration direction

- Use Node.js 24 LTS (24.18.0 or newer) and ESM.
- The root package remains the CLI/core package and is also the npm workspace
  root. Hosted components under `src/platform/` are private workspaces; each
  owns its direct dependencies and scripts, while the repository has one root
  `package-lock.json`.
- Maintained first-party source is strict TypeScript using erasable syntax.
  Node-side `.ts` files run directly through Node's native type stripping; do
  not add emitted twins or a `dist/` tree.
- Node-side imports name real `.ts` files. Browser TypeScript under
  `src/platform/web/`, `src/run-viewer/web/`, and `src/core/shared/` keeps
  browser-facing `.js` specifiers. `npm run build:web` emits viewer and shared
  modules in place, and bundles the hosted console into
  `src/platform/web/build/`; all generated files are gitignored.
- Run `npm run typecheck` for every TypeScript project. Do not convert or
  hand-edit `src/platform/web/vendor/`.

## Repository map

```text
src/core/                    Journey engine, drivers, grading, schemas, artifacts
  public/                    Supported entry points for CLI and hosted components
  drivers/                   Web (Playwright), mobile (Appium), and HTTP API drivers
src/cli/                     Commander CLI, preflight, prompts, and terminal output
src/run-viewer/              Static trajectory viewer and its local Node host
src/platform/
  control-plane/             Hosted API, auth, persistence, dispatch, and migrations
  runner-agent/              Isolated hosted run executor
  web/                       Hosted browser UI
tests/                       Root core, CLI, viewer, and repository tests
  core/{unit,integration}/   Hermetic engine tests
  core/browser/              Real Chromium engine tests
  run-viewer/{node,browser}/ Viewer contract and rendering tests
  fixtures/                  Test-owned applications and Playtest suites
examples/                    Standalone user examples; never a test or product dependency
skills/                      Agent workflows shipped with Playtest
studies/                     Self-contained research and evaluation projects
docs/backlog/                Forward-looking designs indexed by `docs/ROADMAP.md`
runs/                        Local run artifacts; gitignored
```

Hosted code must import the engine through `src/core/public/`, not private core
implementation files. Tests live with the project they exercise:
`src/platform/control-plane/tests/` and `src/platform/runner-agent/tests/` are
owned by those packages; `tests/README.md` maps the root suites.

## Install and run

```sh
npm install
npm link                              # optional: expose `playtest` on PATH
node src/cli/cli.ts --help            # run the CLI without linking
PORT=4173 node examples/todo-app/server.js
```

`npm install` runs `npm run build:web`, emitting viewer modules beside their
TypeScript sources and the hosted-console bundle under
`src/platform/web/build/`. The viewer/browser test commands and hosted server
rebuild it automatically; run `npm run build:web` directly after browser-source
edits when using another static server.

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

The hosted product needs no database service. Metadata is one SQLite file
(`node:sqlite`, Node >= 22.5) under the data root, with the object store beside
it; `PLAYTEST_DATA_DIR` is the single storage knob and defaults to
`.playtest-data`.

```sh
npm run hosted:migrate                # optional; the server migrates on boot
npm run hosted                        # http://127.0.0.1:4177
```

The CLI does not load `.env`. Never read any `.env` file without the user's
explicit permission.

## Test

```sh
npm test                              # fast hermetic root gate
npm run test:core
npm run test:cli
npm run test:viewer
npm run test:repository
npm run test:browser                  # explicit Playwright suites
npm run test:mobile                   # explicit Appium / iOS Simulator suite
npm run test:all                      # hermetic and browser suites
npm run hosted:test                   # control-plane unit tests
npm run test:integration --workspace=@jeremyvun/playtest-control-plane
npm run runner:test
```

`npm test` must remain offline, Node-only, and independent of browsers, model
credentials, databases, and Docker, with zero skipped tests. Control-plane
integration tests need no database service either: each boots the whole control
plane against its own temporary SQLite data root. Their clip case does need
`PLAYTEST_FFMPEG` pointed at an ffmpeg built with the `drawtext` and `subtitles`
filters.

## Change rules

- Keep changes small and preserve existing behavior unless the task changes a
  contract.
- Record engine, configuration, artifact, schema, and public API contract
  changes in the owning file under `docs/contracts/`.
- Surface local CLI configuration and user-input failures as
  `DummyConfigError` (`src/core/config.ts`); hosted startup configuration
  failures use `ServerConfigError`
  (`src/platform/control-plane/src/config.ts`). Messages must be actionable and
  must not expose raw stacks or `MODULE_NOT_FOUND`.
- Keep the web driver compatible with existing prompts, envelopes, manifests,
  and baselines unless the relevant contract and version pins change.
- Do not add external network, model, database, Docker, or browser dependencies
  to the hermetic root test gate.
