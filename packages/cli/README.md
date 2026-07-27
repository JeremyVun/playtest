# Playtest CLI

`@playtest/cli` is the human-facing `playtest` command. It finds test suites,
checks local prerequisites, runs journeys through `@playtest/core`, prints live
progress, and opens run artifacts in `@playtest/run-viewer`.

The CLI owns command parsing, terminal output, prompts, scaffolding, and
packaged agent skills. Journey semantics and artifact formats belong to core.

```text
person at a terminal
        |
        v
   playtest CLI
     |       |
     v       v
 core engine  run viewer
```

## Use it from this repository

The repository uses Node.js 24.18 or newer. After `npm install`, either run the
entry point directly or link the workspace command:

```sh
node packages/cli/src/cli.ts --help

npm link --workspace=@playtest/cli
playtest --help
```

Common commands are:

```sh
playtest new checkout              # scaffold a case and, if needed, a suite
playtest test-stories/             # run discovered cases
playtest view                      # inspect local runs
playtest view --changed            # review journeys whose path changed
playtest baseline accept <run-dir> # promote a reviewed path
playtest export                    # make one-way Playwright specs
playtest findings                  # triage durable local findings
playtest install-skill             # install the bundled agent skills
```

`playtest <paths...>` is the normal run form; the explicit `run` command is
hidden from help. The root [`README.md`](../../README.md) documents case files,
configuration, model access, exit codes, and the complete user workflow.

## Source map

```text
src/cli.ts        command tree and top-level orchestration
src/preflight.ts  browser, mobile, and target checks
src/live.ts       live terminal reporting
src/new.ts        case, suite-default, persona, and skill scaffolding
src/findings.ts   local findings command handlers
src/script.ts     executable API-suite authoring command
skills/           agent skills shipped with this checkout
tests/            command and terminal-contract tests
```

The skills are source assets of this package. `playtest install-skill` copies
them into a project so their instructions stay matched to the installed CLI.

## Development

Run these from the repository root:

```sh
npm run typecheck --workspace=@playtest/cli
npm test --workspace=@playtest/cli
node packages/cli/src/cli.ts --help
```

CLI tests are hermetic. They use local fixtures and fake model responses rather
than browsers, external services, or credentials.
