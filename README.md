# Playtest

**User-journey regression testing for web apps.** An AI agent role-plays a user,
attempts real tasks in a real browser, and the harness scores whether the app let
it succeed. Test cases are natural-language stories with machine-checkable success
criteria — no selectors, no scripts to rot. A passing recording becomes the
journey's saved path, re-executed deterministically on later runs until the UI
changes — at which point the agent heals the journey and asks you to review the
change.

Read [docs/playtest-design.md](docs/playtest-design.md) for the why and
[docs/CONTRACTS.md](docs/CONTRACTS.md) for the module contracts.

## Quickstart

```sh
npx @jeremyvun/playtest demo
```

One command — no API keys, no docker, no second terminal. The demo runs a small
suite against the bundled todo app (everything in a temp directory, on
ephemeral ports) and plays three acts:

1. **Recording** — the agent improvises each case from its natural-language story;
   passing recordings become the saved paths.
2. **Checking** — the same cases re-run by following the saved paths step for
   step: zero model calls, a few seconds.
3. **Healing** — the app's UI changes underneath the tests (the Add button
   becomes "Save"); the saved path misses, the agent recovers, and the run ends
   with changed journeys awaiting your review — open the diff in the viewer
   right from the prompt.

With a real API key in the environment (`PLAYTEST_LLM_API_KEY`,
`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`) the demo uses the real model —
genuine narration, three cases cost cents. Without one it falls back to the
bundled offline mock. `--headed` shows the browser; `--keep` retains the temp
directory. If Playwright's Chromium isn't installed yet, the CLI offers a
one-time download on first run (the demo can also borrow a system Chrome).

## Point it at your own app

```sh
playtest new add-item    # first case also scaffolds playtest.yaml
playtest                 # record the journey, then check it on later runs
```

`playtest new <case-name>` creates a case file — a story plus success
criteria — and, on first use, a `playtest.yaml` whose `app:` block tells the
harness how to reach your app: `base_url` for a server you run yourself,
optional `compose` for a managed docker compose environment, optional `init`
for a seed script run before each case.

## Commands

| Command | What it does |
|---|---|
| `playtest [paths...]` | Run cases (paths default to `.`). `--tag <t>`, `--base-url <url>`, `--mode agent`, `--parallel [n]`, `--junit <path>`, `--headed`, `--runs-root <dir>` |
| `playtest demo` | Three-act tour against the bundled todo app: record → act (0 model calls) → heal. `--keep` retains the temp dir, `--headed` shows the browser |
| `playtest new <name> [dir]` | Create a case file (default dir: the nearest suite, else `./tests/`); scaffolds a `playtest.yaml` when no ancestor has one |
| `playtest new persona <name>` | Create a custom persona in `./personas/` |
| `playtest view [run_or_root]` | Open the GUI: run picker, trajectory playback, changed-journey review. `--latest`, `--changed`, `--failed`, `--case <id>`, `--port`, `--no-open`; `--json` prints the run (or `--changed`) list as a JSON array instead of serving |
| `playtest refresh <paths...>` | Re-record journeys from scratch and save passing runs as the new paths |
| `playtest list [paths...]` | Show what a selection resolves to (id, tags, persona, next run) |
| `playtest personas` | List built-in and custom personas |

Exit codes: `0` pass, `1` gate failure, `2` environment/infra error.

Discovery studies need no commands of their own: a suite whose `playtest.yaml`
sets `mode: discovery` runs as a study and its cases end `explored` instead of
pass/fail — see [Discovery studies](docs/playtest-design.md#discovery-studies)
in the design doc and the agent skills under `skills/`.

When a run heals a journey — the UI changed but the task still works — the run
is reported as **changed**, and an interactive run ends with a review prompt.
Inspect with `playtest view --changed`, then `playtest accept <runDir>` or
`playtest reject <runDir>`; non-interactive runs print those commands to resume
later. For CI and automation: `--ci` (plain output, no prompts), `--json` (one
machine-readable summary object on stdout), `--plain`/`--no-tui` (disable the
live status region), `--fail-on-changed` (exit 1 while changed journeys await
review).

Advanced commands, hidden from help but stable: `accept <runDir>`,
`reject <runDir>`, `grade <runDir>` (re-grade a run), and `run` (explicit
spelling of the default command).
Subcommand names win over path arguments: run a conflicting path as
`playtest ./view` or `playtest run view`.

## Status terms

| Term | Meaning |
|---|---|
| `recorded` | Fresh agentic run; a passing recording is saved as the journey's path. |
| `checked` | Re-executed the saved path step for step. The actor makes no model calls, but `assert:` success criteria still call the model at the gate. |
| `tried to heal` | A checked step failed (the UI changed) and the agent tried to recover from that point; shown when the healed run still failed. |
| `changed` | A healed run that passed: the app changed but the journey survived. Awaiting review. |
| `accepted` | A changed journey you approved — now the saved path. |
| `explored` | A finished discovery-study run (`mode: discovery`): no pass/fail — the trajectory and the graded report are the product. |

While a run is in flight, the live display uses the in-progress forms `recording` /
`checking` / `healing` / `exploring`, and `playtest list`'s NEXT-RUN column says what
the next run will do: `check` / `record` / `explore`.

## Suites and cases

A suite is a directory with a `playtest.yaml` holding defaults (models, limits,
`app.base_url`, optional `app.compose` for a managed Docker environment); every
other `*.yaml` below it is a case. Nested `playtest.yaml` files override per
subtree, nearest file wins.

The repo's example suite (`tests/`) targets the bundled todo app and ships with
committed saved paths (`tests/todos/*.baseline.*`), so a run against it checks
the paths rather than recording fresh ones.

## Environment variables

| Variable | Meaning |
|---|---|
| `PLAYTEST_LLM_BASE_URL` | OpenAI-compatible chat-completions endpoint (default `https://api.anthropic.com/v1`). Any explicit override counts as "available" with no key — mock servers welcome. |
| `PLAYTEST_LLM_API_KEY` | API key; falls back to `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`. |

## Development

`npm test` runs the offline self-tests: they boot the fixtures in-process and
drive the real CLI through record → act → heal → accept/reject (plus the
discovery suites), freezing the exit-code and `--json` contracts. The test
script's `test/*.test.js` glob assumes a POSIX shell; on Windows use Node >= 21,
whose test runner expands the pattern itself. The fixtures also run standalone when you
want to poke at them: `npm run todo-app` (the test subject on
http://localhost:4173) and `npm run mock-llm` (an offline OpenAI-compatible
endpoint on http://localhost:4175 — point `PLAYTEST_LLM_BASE_URL` at it).

## Repo layout

```
src/harness/      the CLI, runner, browser session, actor/grader, gate, viewer server
src/schemas/      case + defaults + step + grade JSON schemas (the pinned contracts)
src/viewer/       standalone static trajectory viewer (zero deps)
src/todo-app/     zero-dep fixture app — the demo's and the self-test's subject
src/demo/         the suite `playtest demo` copies into its temp dir
tests/            example suite targeting the todo app (committed saved paths)
test/             offline self-tests (npm test)
skills/           agent skills: run a discovery study, interview/author stories
personas/         example custom persona
runs/             run output (gitignored)
```
