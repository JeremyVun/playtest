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

## Quickstart (the bundled todo app)

```sh
npm install
npx playwright install chromium

# 1. start the app under test
npm run todo-app                 # http://localhost:4173

# 2. point Playtest at a model — either the offline mock:
npm run mock-llm                 # http://localhost:4175, no key needed
export PLAYTEST_LLM_BASE_URL=http://localhost:4175
#    ...or a real one:
# export ANTHROPIC_API_KEY=sk-ant-...

# 3. run and watch
node src/harness/cli.js tests/   # checks the bundled saved paths — fast and ~free
node src/harness/cli.js view     # open the GUI on the latest runs
```

The example suite ships with committed saved paths (`tests/todos/*.baseline.*`),
so the first run already checks them. To watch the agent record a journey from
scratch, add a fresh case (`playtest new case <name> tests/`) or delete a case's
`.baseline.jsonl`/`.baseline.json` pair and run again.

Installed as a package the bin is `playtest`, so those last lines read
`playtest tests/` and `playtest view`. For your own app: `playtest new suite
<name>`, then `playtest new case <name>`.

## Commands

| Command | What it does |
|---|---|
| `playtest [paths...]` | Run cases (paths default to `.`). `--tag <t>`, `--base-url <url>`, `--mode agent`, `--parallel [n]`, `--junit <path>`, `--headed`, `--runs-root <dir>` |
| `playtest new suite <name> [dir]` | Create a suite: a directory with a `playtest.yaml` (`--compose <file>` for a managed Docker env) |
| `playtest new case <name> [suite_dir]` | Create a case file inside a suite (`--suite <dir>` when several exist) |
| `playtest new persona <name>` | Create a custom persona in `./personas/` |
| `playtest view [run_or_root]` | Open the GUI: run picker, trajectory playback, changed-journey review. `--latest`, `--changed`, `--failed`, `--case <id>`, `--port`, `--no-open`; `--json` prints the run (or `--changed`) list as a JSON array instead of serving |
| `playtest refresh <paths...>` | Re-record journeys from scratch and save passing runs as the new paths |
| `playtest list [paths...]` | Show what a selection resolves to (id, tags, persona, next run) |
| `playtest personas` | List built-in and custom personas |

Exit codes: `0` pass, `1` gate failure, `2` environment/infra error.

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
| `recording` | Fresh agentic run; a passing recording is saved as the journey's path. |
| `checking` | Re-executing the saved path step for step. The actor makes no model calls, but `assert:` success criteria still call the model at the gate. |
| `healing` | A checked step failed (the UI changed) and the agent is recovering from that point; shown when the healed run still failed. |
| `changed` | A healed run that passed: the app changed but the journey survived. Awaiting review. |
| `accepted` | A changed journey you approved — now the saved path. |

## Suites and cases

A suite is a directory with a `playtest.yaml` holding defaults (models, limits,
`env.base_url`, optional `env.compose` for a managed Docker environment); every
other `*.yaml` below it is a case. Nested `playtest.yaml` files override per
subtree, nearest file wins. The old defaults filename `dummy.yaml` is still
read (with a once-per-run deprecation note); `playtest.yaml` wins where both
exist.

## Environment variables

| Variable | Meaning |
|---|---|
| `PLAYTEST_LLM_BASE_URL` | OpenAI-compatible chat-completions endpoint (default `https://api.anthropic.com/v1`). Any explicit override counts as "available" with no key — mock servers welcome. |
| `PLAYTEST_LLM_API_KEY` | API key; falls back to `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`. |

The old `DUMMY_LLM_BASE_URL` / `DUMMY_LLM_API_KEY` names are still honored as
fallbacks.

## Repo layout

```
src/harness/      the CLI, runner, browser session, actor/grader, gate, viewer server
src/schemas/      step + grade JSON schemas (the pinned contracts)
src/viewer/       standalone static trajectory viewer (zero deps)
src/todo-app/     zero-dep test subject app
tests/            example suite targeting the todo app
personas/         example custom persona
runs/             run output (gitignored)
```
