# CLAUDE.md — working in this repo

Playtest: user-journey regression testing. An AI actor role-plays a user against a real
surface (web/mobile/api) and the harness scores whether the app let it succeed. See
`README.md` (usage), `docs/playtest-design.md` (why), `docs/CONTRACTS.md` (the module +
data contracts — **the live spec**).

## Ground rules

- **Plain JS, ESM, Node >= 20, no build step, no TypeScript.** Run files directly.
- **`npm test` is the gate** (`node --test test/*.test.js`): offline, in-process, drives the
  real CLI through record → act → heal → accept/reject + discovery + viewer smoke. Keep it
  green and **0 skipped**. The web path is the control and **must never regress** — same
  prompts (golden-bytes test pins `prompts_version`), same envelopes, same manifests.
- **User-facing errors go through `DummyConfigError`** (`src/harness/config.js`) — friendly,
  actionable, naming the offending file. Never surface a raw stack trace / `MODULE_NOT_FOUND`.
- **Contract changes must be recorded in `docs/CONTRACTS.md`** — "silent contract drift is
  the one unforgivable sin" (its preamble). Schema/`pins` bumps, new keys, new artifacts.
- **No speculative abstraction.** Prefer the smallest change that preserves behavior.
- **`playtest demo` is a tour, not onboarding.** It is for demos/exploration/testing
  against the bundled todo app only. Never steer a new user to it as a first real step —
  to onboard someone, scaffold their own suite against their own app (`playtest new`,
  `--driver web|mobile|api`). Demo is the only command that runs with no model key.

## Distribution: local registry (Verdaccio), not public npm

`@jeremyvun/playtest` is **not on the public npm registry** — `npm i -g @jeremyvun/playtest`
and `npx @jeremyvun/playtest` only resolve against a local **Verdaccio** registry. To
develop, use a clone + `npm link`. To smoke-test the *packaged* global install (catches bugs
`npm link` can't — a missing `files` entry, a broken `bin`): `npm pack --dry-run` to inspect
the tarball, then publish to a throwaway Verdaccio under `/tmp/pt-verdaccio` and
`npm i -g --prefix` from it. The exact command sequence is pre-allowed for agents in
`.claude/settings.local.json`; bump `package.json` `version` before re-publishing (Verdaccio
rejects a duplicate version).

The CLI does **not** load `.env`. Export `ANTHROPIC_API_KEY` (or `PLAYTEST_LLM_API_KEY` /
`OPENAI_API_KEY`) into the shell to use a real model; otherwise commands fall back to the
bundled offline mock (`src/harness/testing/mock-llm.js`), which only drives the web demo.

## VERSION_2 state (drivers / transport seam)

Implemented in the working tree: the `Driver` seam (`src/harness/driver.js`) + `web`,
`mobile`, `api` drivers (`src/harness/drivers/`), selected by one defaulted key
`app.driver`. The live contract is `docs/CONTRACTS.md` §16; `docs/driver-interface.md` is the
design rationale/handoff. Mobile runs against a fake Appium client in tests
(`__setMobileClientFactory`) — `webdriverio` is an `optionalDependency`; real-device
validation, mobile network capture (§10.1), and mobile perf (§10.2) are deferred by design.

## Repo layout

```
src/harness/          the CLI, runner, browser session, actor/grader, gate, viewer server
src/harness/drivers/  web / mobile / api transports behind the Driver seam (driver.js)
src/schemas/          case + defaults + step + grade JSON schemas (the pinned contracts)
src/shared/           code shared across processes (e.g. movement.js trend math)
src/viewer/           standalone static trajectory viewer (zero deps)
src/todo-app/         zero-dep fixture app — the demo's and the self-test's subject
src/demo/             the suite `playtest demo` copies into its temp dir
tests/                example suite targeting the todo app (committed saved paths)
test/                 offline self-tests (npm test)
skills/               agent skills: stories (interview/author), run, discovery study
personas/             example custom persona
runs/                 run output (gitignored)
```
