# Playtest core

`@playtest/core` is the shared journey engine behind both the local CLI and the
hosted runner. It turns plain-language test cases into recorded journeys against
web apps, mobile apps, or HTTP APIs, then evaluates the result and writes the
artifacts used by the viewer and findings systems.

This package contains product behavior, not a command-line interface or a
server. Its consumers use the public `@playtest/core/*` exports declared in
`package.json`.

## How a run moves through core

```text
case YAML + suite defaults
            |
            v
    discover and validate
            |
            v
  web / mobile / API driver <----> application under test
            |
            v
 recorded or replayed trajectory
            |
            +----> deterministic gates
            +----> LLM grader
            |
            v
 manifest, evidence, grade, baseline candidate, reports
```

On a case's first run, the actor works out a path and records it. Later runs
replay that saved path without calling the actor. If the application has
changed, the actor can heal the journey from the point of failure; the healed
path remains a review candidate until a person accepts it.

## What this package owns

- Suite discovery, YAML validation, personas, and linting.
- The actor loop and the web, mobile, and API drivers.
- Recording, replay, healing, deterministic assertions, and grading.
- Trajectory, manifest, baseline, bundle, media, and reporting formats.
- Model configuration and the shared chat-completions client.
- The local findings ledger and executable API-suite machinery.
- Stable browser helpers shared with the two browser applications.

The main supported entry points are grouped by job: `run`, `suite`,
`artifacts`, `analysis`, `findings`, `media`, `llm`, `reporting`, and
`api-suite-scripts`. `testing` is only for first-party tests. Do not import
private files below `src/` from another package.

## Source map

```text
src/public/             supported package entry points
src/drivers/            web, mobile, API, and capture adapters
src/schemas/            case, step, grade, and script schemas
src/prompts/            actor, grader, discovery, and authoring prompts
src/findings/           local finding intake, lifecycle, and consolidation
src/api-suite-scripts/  executable API-suite authoring and sandboxing
src/shared/             small browser-safe modules
tests/unit/             fast engine and contract tests
tests/integration/      multi-module runs using local fixtures
tests/browser/          Playwright-backed browser tests
tests/mobile/           Appium and iOS Simulator tests
```

## Development

Run these from the repository root:

```sh
npm run typecheck --workspace=@playtest/core
npm test --workspace=@playtest/core
npm run test:browser --workspace=@playtest/core
npm run test:mobile --workspace=@playtest/core
```

The regular test suite is hermetic and does not need a browser, model, network,
or external service. Browser and mobile tests are separate because they require
their respective runtimes.

The conceptual overview is in
[`docs/playtest-design.md`](../../docs/playtest-design.md). Engine, artifact,
and script behavior is specified under
[`docs/contracts/`](../../docs/contracts/).
