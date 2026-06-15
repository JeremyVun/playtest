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
playtest new my-user-story [dir]  # Create  playtest story (my-user-story.yaml). Edit manually
playtest [dir]                    # Run the test to record the journey
playtest view                     # Launch trajectory viewer app to see run results
```

`playtest new` scaffolds a `web` playtest story by default. For mobile or api, use the `--driver` flag.

```sh
playtest new --driver mobile login-flow    # native iOS/Android over Appium
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
  compose: docker-compose.yml      # optional: harness boots & tears the app down per run
  init: ./seed.sh                  # optional: script run before each story to reset state
mode: journey                      # journey (regression) · or discovery (VLM exploration)
persona: tester                    # tester · exploratory · or a personas/*.yaml slug
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
persona: first-time-shopper             # the actor role; a list here fans out (discovery)
success:                                # journey gate — every criterion must pass
  - url_matches: "/cart*"               # the address bar
  - api_called: "POST /api/cart"        # assert that an api call was made
  - console_errors: 0                   # assert no js console errors
  - assert: the basket shows one item   # natural language, checked by the grader
report:     # Natural language questions answered by the grader
  - Did anything in the checkout flow confuse them?
  - Could the task have been done in less steps?
```

##### Success assertions

The `success:` block is the **journey gate**: every criterion must pass for the run to be green.
All are checked deterministically from the recorded run except `assert`, which states a claim in
natural language for the grader agent to judge.

| Key | Example | Drivers | Passes when |
|---|---|---|---|
| `url_matches` | `"/cart*"` | web, api | The final URL (full or pathname) matches the glob. |
| `element_exists` | `"[data-testid=basket-item]"` | web | A Playwright locator matches on the final page — CSS by default, or `xpath=` / `text=` / `role=`. |
| `screen_shows` | `"~basket-item"` | mobile | An Appium native selector matches on the final screen — accessibility id (`~`), XPath, or iOS/Android predicate. The mobile analog of `element_exists`. |
| `api_called` | `"POST /api/cart"` | web, api | Some request matched the `METHOD /path-glob`. |
| `response_status` | `"2xx"` | api | Some response had this status — an exact code or an `Nxx` class. |
| `response_matches` | `"$.items[0].qty == 2"` | api | A dot/bracket JSON path over the last response body compares true (`==`, `!=`). A minimal subset — no wildcards or filters. |
| `console_errors` | `0` | web | The run finished with at most N browser console errors. |
| `assert` | `the basket shows one item` | web, mobile, api | The grader judges the claim true against the final page / screen / response. One model call per `assert`, even on replayed runs. |

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

A story's **baseline** — its *saved path* — is the trajectory the actor recorded the first
time the story passed (`results/<story>.baseline.jsonl`). There is no separate script:
later runs replay that path, and the agent re-records it when the UI moves. That's the
`record → act → heal` lifecycle behind the statuses above:

```
first run, or a refresh
       │
       ▼
record ─▶ saves the passing run as the baseline (the "saved path")
       │
       │   every later run re-executes that saved path, step for step:
       ▼
check  ─▶ all steps pass ─────────────▶ status: checked          ✓ green
       │
       │   a step fails — an element is gone, the UI changed
       ▼
heal   ─▶ the agent wakes at the failure point and finishes the task
       │
       ├─ finishes green ─▶ status: changed ─▶ review the heal diff:
       │                      accept → healed run becomes the new baseline
       │                      reject → discarded, baseline unchanged
       │
       └─ still fails ────▶ status: tried to heal                 ✗ broke
```

**Reviewing a changed journey.** An interactive run that heals ends at a review prompt.
Inspect the diff (old baseline vs. healed run) with `playtest view --changed`, then
`playtest accept <runDir>` to promote it or `playtest reject <runDir>` to discard it.
Non-interactive runs (CI) don't prompt — they print those `accept` / `reject` lines so you
can resume later, and `--fail-on-changed` turns a `changed` result into a failed build.

**CLI note.** `accept`, `reject`, `grade <runDir>`, and `run` (the explicit name for the
default command) are stable but hidden from `--help`. A subcommand name always wins over a
path argument — to run a path that collides with one, use `playtest ./view` or
`playtest run view`.


## Playtest CLI Commands

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
