# Dummy

**Agentic regression testing for web apps.** Dummy performs *dummy runs* of your
application: an AI agent role-plays a user, attempts real tasks in a real browser,
and the harness scores whether the app let it succeed. Test cases are natural-language
stories with machine-checkable success criteria — no selectors, no scripts to rot;
passing runs are blessed as baselines and re-executed deterministically (and for free)
until the UI changes, at which point the agent heals the path.

Read [docs/dummy-design.md](docs/dummy-design.md) for the why and
[docs/CONTRACTS.md](docs/CONTRACTS.md) for the module contracts.

## Quickstart (the bundled todo app)

```sh
npm install
npx playwright install chromium

# 1. start the app under test
npm run todo-app                 # http://localhost:4173

# 2. point Dummy at a model — either the offline mock:
npm run mock-llm                 # http://localhost:4175, no key needed
export DUMMY_LLM_BASE_URL=http://localhost:4175
#    ...or a real one:
# export ANTHROPIC_API_KEY=sk-ant-...

# 3. run and watch
node src/harness/cli.js run tests/          # first run records + blesses baselines
node src/harness/cli.js run tests/          # subsequent runs act them (no model calls)
node src/harness/cli.js view runs/<run-id>/todos/add-todo
```

## Commands

| Command | What it does |
|---|---|
| `dummy run <paths...>` | Run cases. `--tag smoke`, `--mode agent`, `--base-url <url>`, `--parallel [n]`, `--junit <path>`, `--no-grade`, `--headed`, `--runs-root <dir>` |
| `dummy list <paths...>` | Show what a selection resolves to (id, tags, persona, act/record) |
| `dummy view <dir>` | Open the trajectory viewer on a run dir, or a runs root for a picker. `--port`, `--no-open` |
| `dummy diff <runDir>` | Action-track diff of a run vs. its case's current baseline |
| `dummy bless <runDir>` | Bless a run's trajectory as its case's baseline |
| `dummy rebaseline <paths...>` | Force fresh agentic runs and bless on pass |
| `dummy grade <runDir>` | (Re)grade an existing run |

Exit codes: `0` pass, `1` gate failure, `2` environment/infra error.

## Environment variables

| Variable | Meaning |
|---|---|
| `DUMMY_LLM_BASE_URL` | OpenAI-compatible chat-completions endpoint (default `https://api.anthropic.com/v1`). Any explicit override counts as "available" with no key — mock servers welcome. |
| `DUMMY_LLM_API_KEY` | API key; falls back to `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`. |

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
