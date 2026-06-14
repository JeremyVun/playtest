# Playtest

**Automated regression harness** for,
- Web (Playwright)
- Mobile (Appium)
- REST APIs**

An `actor` role-plays as a user persona and attempts to complete a plain language story/task against
a specificed surface (browser, mobile, app). The trajectory result is then evaluated against programmatic
rules and LLM `grader` agents to form a regression history.

```
 playtest story (YAML)             ┌─────────────────────┐
 "do task x as a tester"     ┌────►│ App under test      │
        │                    │     │ (docker-compose     │
        ▼                    │     │  or deployed URL)   │
 ┌─────────────┐      act    │     └──────────────┬──────┘
 │ Actor agent │─────────────┘                    │ a11y, screenshots,
 │ (Haiku)     │◄─────────────────────────────────┘ telemetry,
 └─────┬───────┘
       │  trajectory: thoughts + actions + state + metrics
       ├──────────────────────────────────┐
       ▼                                   ▼
 ┌─────────────────┐         ┌──────────────────────┐
 │ Gate            │         │ Grader               │
 │ assertions →    │         │ (Sonnet) →           │
 │ pass / fail     │         │ score + findings     │
 └────────┬────────┘         └──────────┬───────────┘
          │            result           │
          └──────────────┬──────────────┘
                         ▼
             ┌────────────────────────┐
             │ Trajectory viewer      │
             │ playback + trends      │
             └────────────────────────┘
```

## Usage

Install the `playtest` cli and run `install-skill` to teach your claude how to use it

```sh
npm i -g @jeremyvun/playtest && playtest install-skill
```

Example Prompt to get claude to create a set of regression playtest stories for you
> "Use Playtest to create a regression suite for my (web app | mobile app | api) at http://localhost:3000"

Or to discover insights / validate assumptions, use it in "discovery" mode. Example Prompt,
> "I have an idea for a new feature X, but I'm not sure if/where it makes sense within our test app at (t2.myapp.com). Create some playtest stories for user persona Y that are trying to do task Z to discover where the pressure points are in the current user flow"

### CLI

Using the CLI directly is also fairly straightforward

```sh
playtest new add-item [dir]   # Create a playtest story (add-item.yaml). Edit it manually
playtest [dir]                # Run the test to record the journey
playtest view                 # Launch trajectory viewer app to see run results
```

`playtest new` scaffolds a `web` playtest story by default. For mobile or api, use the `--driver` flag.

```sh
playtest new --driver mobile login-flow   # native iOS/Android over Appium
playtest new --driver api    orders-api    # REST API over HTTP
```

For more on configuring playtest story yaml files, see [Suites & Stories](#suites-and-stories)

## Environment variables

The first playtest story run needs a model. Ensure you have your API key and LLM gateway configured in your environment variables

| Variable | Meaning |
|---|---|
| `PLAYTEST_LLM_API_KEY` | API key; falls back to `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`. |
| `PLAYTEST_LLM_BASE_URL` | OpenAI-compatible chat-completions endpoint (default `https://api.anthropic.com/v1`). Any explicit override counts as "available" with no key — point it at a mock or gateway. |

## Trajectory Viewer


## Suites and Stories

A **Suite** is a bundle of playtest stories and represented as a directory with a `playtest.yaml`.

A **Stories** is an individual task description in a `stories/` subdir (or in the suite root dir)

```
checkout/                          # a suite
├── playtest.yaml                  # shared defaults: app.base_url, models, limits
├── stories/
│   ├── add-to-cart.yaml           # a story: a task + its success criteria
│   └── checkout.yaml
└── results/                       # saved paths, written when a story first records green
    ├── add-to-cart.baseline.json  #   run metadata
    ├── add-to-cart.baseline.jsonl #   the step-by-step path later runs replay
    ├── checkout.baseline.json
    └── checkout.baseline.jsonl
```

### Configuration
#### Suite

```yaml
# checkout/playtest.yaml
app:
  driver: web                      # web (default playwright) · mobile (Appium) · api (HTTP)
  base_url: http://localhost:3000  # where the app runs — required for web/api (or --base-url)
  # compose: docker-compose.yml    # optional: harness boots & tears the app down per run
  # init: ./seed.sh                # optional: script run before each story to reset state
mode: [journey | discovery ]       # journey (regression) or discovery (VLM exploration)
persona: [tester | exploratory]    # actor role. or use custom personas e.g. `personas/*.yaml`
actor_model: claude-haiku-4-5      # role-plays the user (cheap by default)
grader_model: claude-sonnet-4-6    # scores runs and checks `assert:` gates
max_steps: 50                      # per-run limit on actor steps
timeout: 4m                        # per-run wall-clock limit
```

#### Story

Inherits configs from parent `playtest.yaml`

```yaml
# checkout/stories/add-to-cart.yaml
description: Add item to cart and see it in the basket  # one-line label in run lists
story: |    # the actor's goal in plain language
  You're buying a gift. Pick a product you like, add two of them to your
  cart, check that it shows up in your basket, then remove one and check
  if the price changed
tags: [smoke]                           # optional, for --tag filtering
personas: [first-time-shopper, bargain-hunter]   # runs once per persona
success:                                # journey gate — every criterion must pass
  - url_matches: "/cart*"               # the address bar
  - api_called: "POST /api/cart"        # assert that an api call was made
  - assert: the basket shows one item   # natural language, checked by the grader
report:     # Natural language questions answered by the grader
  - Did anything in the checkout flow confuse them?
  - Could the task have been done in less steps?
```

Each finished run carries a **status**:

| Status | Meaning |
|---|---|
| `recorded` | Fresh agentic run; a passing recording is saved as the journey's path. |
| `checked` | Re-executed the saved path step for step — no actor model calls (`assert:` gates still call the grader). |
| `tried to heal` | A checked step failed (UI changed), the agent tried to recover, and the healed run still failed. |
| `changed` | A healed run that passed: the app changed but the journey survived. Awaiting review. |
| `accepted` | A changed journey you approved — now the saved path. |
| `explored` | A finished discovery run: no pass/fail; the trajectory and graded report are the product. |


#### Story Baselines and Healing

When a run heals a journey, an interactive run ends with a review prompt; inspect with
`playtest view --changed`, then `playtest accept <runDir>` or `playtest reject <runDir>`
(non-interactive runs print those lines to resume later). Hidden but stable: `accept`,
`reject`, `grade <runDir>`, and `run` (the explicit spelling of the default). Subcommand
names beat path arguments — run a conflicting path as `playtest ./view` or
`playtest run view`.


## Commands

| Command | What it does |
|---|---|
| `playtest [paths...]` | Run cases (default `.`). `--tag`, `--base-url`, `--mode agent`, `--parallel [n]`, `--junit <path>`, `--headed`, `--runs-root <dir>`, `--ci`, `--json`, `--plain`/`--no-tui`, `--fail-on-changed` |
| `playtest new <name> [dir]` | Create a case (scaffolds `playtest.yaml` on first use). `--driver web\|mobile\|api`, `--force` |
| `playtest new persona <name>` | Create a custom persona in `./personas/` |
| `playtest view [run_or_root]` | Open the GUI: run picker, trajectory playback, changed-journey review. `--latest`, `--changed`, `--failed`, `--case <id>`, `--port`, `--no-open`, `--json` |
| `playtest clip <run\|case>` | Cut a subtitled clip from a run's screencast. `--captions action\|thought`, `--burn`, `--out` |
| `playtest refresh <paths...>` | Re-record journeys from scratch and save passing runs as the new paths |
| `playtest list [paths...]` | Show what a selection resolves to (id, tags, persona, next run). `--tag`, `--json` |
| `playtest personas` | List built-in and custom personas |
| `playtest demo` | Three-act tour against the bundled todo app (record → check → heal). `--keep`, `--headed` |

Exit codes:
- `0` pass/explored
- `1` gate failure
- `2` environment/infra error.

## Development

`npm test` runs the offline self-tests: they boot the fixtures in-process and drive the
real CLI through record → act → heal → accept/reject (plus discovery and a viewer smoke),
freezing the exit-code and `--json` contracts — keep it green and 0-skipped. The
`test/*.test.js` glob assumes a POSIX shell (on Windows use Node ≥ 21). The fixtures also
run standalone: `npm run todo-app` (the test subject on http://localhost:4173) and
`npm run mock-llm` (an offline OpenAI-compatible endpoint on http://localhost:4175 — point
`PLAYTEST_LLM_BASE_URL` at it).
