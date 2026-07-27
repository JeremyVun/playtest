# Test map

Tests are grouped first by the project they exercise, then by execution tier.

```
tests/
  core/
    unit/          pure engine, configuration, schema, and driver-contract tests
    integration/   core components working together without simulated model behavior
    browser/       real Chromium tests
    mobile/        real Appium / iOS Simulator tests
  cli/             local commands
  run-viewer/
    node/          viewer server and artifact projections
    browser/       real Chromium rendering
  fixtures/        test-owned applications and Playtest suites
    todo-app/      the web journey app
    todos/         its Playtest suite
    auth-api/      an authenticated API, for the secrets path
    replay-api/    fresh-ids-per-instance API, for semantic replay
    invariant-api/ ledger-shaped API whose every fault is an option, for the
                   invariant policies and heal triage
    api-example/   a COMMITTED api suite: spec, stories, and a real recorded
                   baseline — the worked example the README points at
    web-invariants/ a COMMITTED web suite that gates on the API underneath the
                   todo-app UI — the worked example for passive cross-layer
                   assertions (invariant policies over a web run's har.json)
    script-api/    a loopback API for the script substrate, deliberately
                   echoing its own Authorization header back
    script-suites/ scripts written against docs/contracts/scripts.md, one
                   behaviour of the substrate each
    todo-app-swiftui/ a SwiftUI iOS Simulator todo app, built by its own
                   build.sh — the mobile driver's XCUITest subject
  repository/      dependency boundaries, import hygiene, and hermeticity
  support/         shared deterministic fixtures
```

Run the hermetic root gate with `npm test`. Individual groups are available as
`npm run test:core`, `npm run test:cli`, `npm run test:viewer`, and
`npm run test:repository`. Browser tests use `npm run test:browser`; `npm run
test:all` runs both tiers.

## Mobile suite

`npm run test:mobile` drives the mobile driver against a real Appium/XCUITest
session: it builds the `todo-app-swiftui` fixture, spawns the Appium server from
the local devDependency on port 4823, and runs one iOS Simulator session through
`MobileDriver`. It is an explicit opt-in tier — not in `npm test`, not in
`npm run test:all` — and a missing prerequisite fails loudly with the command to
run rather than skipping.

One-time setup on a Mac with Xcode and an iOS Simulator runtime installed:

```sh
npm install
APPIUM_HOME="$HOME/.appium" npx appium driver install xcuitest
```

The `APPIUM_HOME` pin matters: with `appium` installed as a project
devDependency, `appium driver install` otherwise treats this repository as its
home and writes the 138 MB iOS-only driver into `package.json` and
`node_modules`, where every platform's `npm install` would pull it. The suite
reads the same `APPIUM_HOME` (default `~/.appium`) for its preflight and for the
server it spawns.

Unlike the other tiers this suite does **not** load `tests/support/hermetic.ts`:
that bootstrap propagates its `--import` through `NODE_OPTIONS` into child node
processes, which here would wrap the third-party Appium server in our test guard.
The suite still only talks to `127.0.0.1` and needs no model credentials.

The whole run takes about 90 seconds once warm, most of it session creation. The
very first session ever created on a machine also builds WebDriverAgent (a few
minutes) inside webdriverio's own session timeout; if that first run times out,
rerun it — the build is cached afterwards. The suite shuts down any simulator it
booted and kills the server it spawned.

Hosted packages own their tests:

- `src/platform/control-plane/tests/{unit,integration}`
- `src/platform/runner-agent/tests/unit`

The archived July 2026 hill-climb project owns historical standalone suites
under `studies/archive/hillclimb-2026-07/{tests,bench/tests}`. They are not part
of the current hermetic gate; reproduce them from the archive's recorded
worktree.

Hermetic tests may record an HTTP request and return a response declared by the
test. They must not implement a parallel actor or grader and count agreement with
that implementation as product evidence.
