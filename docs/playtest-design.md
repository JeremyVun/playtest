# Playtest

**Agentic regression testing for web apps.** Playtest performs play-tests of your
application: an AI agent role-plays a user, attempts real tasks in a real browser
against your app, and the harness scores whether the app let it succeed. Think
of it as an AI mystery shopper that files a report after every visit.

> We no longer have dedicated testers. Developers are responsible for testing,
> and selector-based E2E suites rot faster than anyone maintains them. Playtest
> exists so that "did the core user journeys break?" gets answered automatically,
> every night and on every release candidate — without anyone hand-maintaining
> brittle scripts.

---

## 1. The idea in one diagram

```
 test case (YAML)                      ┌──────────────────────────────┐
 "buy shoes as a guest"          ┌────►│ App under test               │
        │                        │     │ (a compose stack it boots,   │
        ▼                        │     │  or any deployed URL)        │
 ┌─────────────┐   acts via CDP  │     └──────────────┬───────────────┘
 │ Actor agent │─────────────────┘                    │ a11y snapshot,
 │ (Haiku)     │◄─────────────────────────────────────┘ telemetry
 └─────┬───────┘
       │  every thought + action + measurement recorded by the harness
       ▼
 trajectory ──► deterministic assertions (pass/fail gate)
            ──► grader agent (Sonnet) → quality score + findings
            ──► trajectory viewer, trends, CI exit code
```

Three principles run through everything:

1. **The agent is pinned; the app is the variable.** This is an eval harness
   turned inside out. We freeze the agent (model version, prompts, snapshot
   format) so that when a score moves, it's the application that changed.
2. **The harness does all the accounting.** The agent only ever sees a snapshot
   and decides one next action. Recording, token budgets, retries, timeouts,
   artifact capture, validation of actions — all harness responsibilities. The
   agent is deliberately kept stateless and dumb.
3. **The step schema is the real interface.** The actor writes into it, the
   perf instrumentation annotates it, act mode executes straight out of it,
   and the grader and viewer read it. Everything else is implementation.

---

## 2. Core concepts

### Test case

A test case is a YAML file containing a **user story in natural language** plus
machine-checkable **success criteria**. No selectors, no step-by-step script —
the agent figures out *how*; the criteria define *done*.

```yaml
# tests/checkout/guest-checkout.yaml
tags: [smoke]
story: |
  You want to buy a pair of running shoes without creating an account.
  Find a pair, add it to the cart, and complete checkout as a guest
  using the provided test credit card.
persona: tester                    # tester | exploratory | a custom persona name
success:                           # deterministic checks — all must hold
  - url_matches: "/order/confirmation/*"
  - element_exists: "[data-testid=order-number]"
  - api_called: "POST /api/orders"
  - assert: "the order total shown matches the cart total before checkout"
perf:                              # also part of the gate
  lcp_ms: "< 2500"
  console_errors: 0
limits:
  max_steps: 40
  timeout: 5m
```

The case name is the filename. Models, timeouts, and the environment are
usually inherited from directory defaults (below), so a typical case is just a
story, tags, and success criteria — but any default can be overridden per case.

Because the story is natural language, a UI refactor (renamed buttons, moved
nav, redesigned checkout) does **not** break the test — the agent re-finds its
way. The test only fails when the *task* can no longer be completed or the
success criteria no longer hold. This is the core advantage over
selector-based E2E suites.

### Suites are directories

There is no suite manifest. A suite is a directory tree; every `*.yaml` file
under it is a test case, discovered automatically. The one reserved filename is
`playtest.yaml`, which holds defaults for its subtree (the deprecated old name
`dummy.yaml` is still read, with a warning):

```
tests/
  playtest.yaml           # root defaults: models, timeouts, environment
  checkout/
    playtest.yaml         # subtree overrides: seed script, storage state
    guest-checkout.yaml   # a case — discovered, no registration anywhere
    saved-cards.yaml
  onboarding/
    signup.yaml
personas/
  first-time-admin.yaml
```

```yaml
# tests/playtest.yaml — inherited by every case below it
actor_model: claude-haiku-4-5
grader_model: claude-sonnet-4-6
max_steps: 30
timeout: 4m
runs_per_case: 1
env:
  base_url: http://app:3000
  compose: ./docker-compose.test.yml
```

```yaml
# tests/checkout/playtest.yaml — nearest file wins, like .gitignore
env:
  init: ./seed/checkout.sh
  storage_state: ./seed/anon.json
```

Selection is by **path** and by **tag**:

- Directories express *ownership and area*: `playtest tests/checkout/` runs
  one subtree.
- Tags express *selection sets that cross areas*: a case declares
  `tags: [smoke]` and CI runs `playtest tests/ --tag smoke`. Membership lives
  in the case file itself, visible in code review, instead of going stale in a
  central manifest. `playtest list --tag smoke` answers "what's in the smoke set?"

Adding a test to the suite is: drop a file in the tree. That's the whole
workflow.

### Environments: bring your own, or let Playtest boot one

`env.base_url` is the only required field — it says where the app is. `compose`
is optional and says **Playtest owns the app lifecycle**:

```yaml
env:
  base_url: http://app:3000               # required: where the app is
  compose: ./docker-compose.test.yml      # optional: Playtest boots/tears down
  init: ./seed/checkout.sh                # optional: runs before each case
  storage_state: ./seed/anon.json         # optional: pre-built browser session
```

| Mode | When `compose` is | Behaviour |
|---|---|---|
| **Managed** | present | Playtest boots an isolated compose project per case, resolves `base_url` inside it, runs `init`, tears down after. Cases run in parallel safely. |
| **External** | absent | `base_url` points at something already running: staging, a PR preview URL, a local dev server. `init` still runs, with `BASE_URL` and `RUN_ID` in its environment, so it can call a reset endpoint or create run-scoped test data. |

Rules that keep external targets honest:

- The harness **health-probes** `base_url` before each run. An unreachable or
  erroring environment exits with the infra code (`2`) — an environment flake,
  never a test failure.
- Against a shared external target, cases run **serially by default** (they may
  share mutable state); `--parallel` opts back in when cases are known to be
  data-independent.
- Isolation is the user's responsibility in external mode. The agent will
  genuinely click buy, delete, and submit on whatever URL it's given — point it
  at staging with test rails, never at production.

The motivating external-mode use case: run the smoke tag against an ephemeral
**PR preview deployment** (`playtest tests/ --tag smoke --base-url
https://pr-417.preview.example.com`) — no compose boot on the CI box at all.

### Personas

A persona is a system-prompt overlay on the actor. Two are built in:

| Persona | Behaviour | Role |
|---|---|---|
| **tester** | Competent, goal-directed, low variance. Reads the page carefully, doesn't wander. | The stable regression instrument. Its prompt is frozen with the harness version. |
| **exploratory** | A plausible real user: impatient, skims, follows visual prominence, gives up sooner. | Produces *findings* rather than pass/fail. Surfaces discoverability and UX problems. |

Defining your own persona is zero-code — a small file with a name and a
description of who the user is, referenced from a case or a `playtest.yaml`:

```yaml
# personas/first-time-admin.yaml
name: first-time-admin
description: |
  An office manager evaluating the product on a trial. Comfortable with
  computers but has never seen this app before. Reads labels, hesitates
  before destructive-sounding actions, expects an undo to exist.
```

The delta between personas is itself a signal: if the tester completes a flow
the exploratory user can't, the feature works but users won't find it.

### The actor loop

Each turn the harness:

1. Captures a **pruned accessibility snapshot** of the page — visible and
   interactable elements only, each with a stable reference ID. Typically
   1–4K tokens. (Screenshots are captured for the record but only fed to the
   model as a fallback for pages the a11y tree can't represent, e.g. canvas.)
2. Sends the agent its context: the user story and persona, a compacted log of
   everything it has done so far, and the latest snapshot(s).
3. Receives exactly one **structured step object** (see *The step contract*):
   a free-text `thought`, one `action` from a small fixed vocabulary
   (`click`, `type`, `select`, `scroll`, `navigate`, `wait`, `done(summary)`,
   `give_up(reason)`), and an `expectation` of what should happen next.
4. **Validates** the action (does that ref still exist? is it interactable?),
   executes it inside a measurement window (see Telemetry), and waits for the
   page to settle. Invalid or failed actions are returned to the agent as
   structured errors — never crashes. Repeated failures, and outcomes that
   contradict the agent's stated expectation, are recorded as **confusion
   events**.
5. Appends the step envelope to the trajectory and loops, until `done`,
   `give_up`, `max_steps`, or `timeout`.

Context is engineered for prompt-cache efficiency: the stable prefix (system
prompt, story, persona) and an append-only trajectory log come first; only the
current snapshot varies at the tail. The log is never rewritten, so the prefix
stays byte-stable between turns. The practical effect: long scenarios stay
cheap and the agent can run 40+ steps without context bloat.

### The step contract

The actor's entire turn is one schema-validated object. Only the action union
is constrained; `thought` and `expectation` are deliberately free-form strings
(over-structuring reasoning degrades it):

```json
{
  "thought": "The cart icon shows 1 item; Checkout is the prominent button.",
  "action": { "type": "click", "ref": "e42" },
  "expectation": "navigates to a checkout or sign-in choice page"
}
```

The harness wraps it in an **envelope** — one line of `trajectory.jsonl` per
step. The envelope is the index against everything too heavy for the agent's
context: full DOM snapshots, screenshots, network logs are stored on disk and
referenced by pointer, keyed by step id.

```json
{
  "step": 7,
  "schema_version": 2,
  "agent":      { "thought": "...", "action": { "type": "click", "ref": "e42" }, "expectation": "..." },
  "resolution": { "ref": "e42", "locator": "role=button[name=\"Checkout\"]" },
  "result":     { "ok": true, "settle_ms": 480 },
  "perf":       { "input_to_paint_ms": 120, "long_tasks_ms": 90, "requests": 3, "js_errors": 0 },
  "artifacts":  { "screenshot": "steps/007.png", "mhtml": "steps/007.mhtml", "a11y": "steps/007.a11y.txt", "har_entries": [123, 131] },
  "tokens":     { "in": 2100, "out": 95, "cache_read": 1840 }
}
```

The schema lives in the repo as `step.schema.json`, is versioned, and is pinned
with the harness version exactly like the prompts and snapshot format. The
extraction mechanism is an implementation detail behind this contract.

#### Model access

All model calls go through an LLM gateway (Portkey) speaking the de facto
standard **OpenAI chat-completions contract**; the gateway translates to each
provider's native API (Anthropic Messages, etc.) on the wire. Extraction of
the step object is a **forced tool call**: the step schema is registered as a
function and `tool_choice` pins it, so every actor turn is the structured
object — no free-text parsing. The harness still validates the returned
arguments against `step.schema.json` (they arrive as a JSON string) and
retries once with the validation error attached; that closes the loop without
any heavier schema-alignment machinery.

Gateway caveats that are part of the design, not afterthoughts:

- **Prompt caching must survive translation.** The cost model depends on cache
  hits on the stable prefix; verify `cache_control` passthrough and check
  `cache_read_input_tokens` in responses before trusting the economics. If the
  unified route is lossy, fall back to native passthrough (provider SDK
  pointed at the gateway's base URL) and keep the routing/observability.
- **The gateway config is part of the pinned agent.** Retries, fallbacks, and
  translation behaviour all change actor behaviour; the Portkey config version
  is stamped into every run alongside model and prompt versions.

### Execution modes: record → act → heal

Selector-based suites rot because humans maintain the scripts. Playtest has no
script at all: the agent's own recorded run is the executable path, and the
agent re-records it when the UI changes. Pure agentic execution on every run
would be slow, costly, and noisy; the baseline is what makes the steady state
fast and free:

| Mode | What happens | LLM cost | When |
|---|---|---|---|
| **Record** | The agent improvises the task from scratch. On success, its trajectory is saved as the case's **baseline**. | Full | First run of a case; after `refresh`. |
| **Act** | The harness re-executes the baseline's action track step for step as a fresh run — no actor model calls (an `assert:` success criterion still makes one model check at the gate). Deterministic, seconds-fast. Success criteria and perf assertions are still checked. | ~Zero | Default for every subsequent run. |
| **Heal** | An acted step fails (element gone — the UI changed). The agent wakes up at the failure point with full context and completes the task. The healed run's trajectory becomes the candidate baseline — a **changed journey**, held for human review before it is accepted. | Partial | Automatic when an acted step fails. |

There is no separate script artifact. The **baseline** is a pointer to a
trajectory — the case's current known-good path — and acting it means walking
its **action track**: every step that actually executed, re-run through the
same validation and measurement path as agentic actions, using the resolved
locator captured at execution time (`role=button[name="Checkout"]`, test-id),
never the raw snapshot ref — ref ids are instance-specific to one snapshot
and would not survive a week. Steps that never executed (validation failures)
are skipped at act time; detours the agent took and backed out of are kept —
deleting a "pointless" click risks deleting the one that dismissed the cookie
banner. Clearing accumulated detours is what `refresh` is for.

Collapsing the script into the trajectory keeps the mechanics honest in two
ways:

- **One schema.** Each executed step is already a versioned command — a
  `schema_version` stamp, additive-only fields, a small stable verb
  vocabulary — so the trajectory's action track *is* the command list. There
  is no second format to keep compatible. New verbs are new command types;
  old tooling skips what it doesn't know.
- **No splice logic.** A healed run's trajectory is already complete: the
  steps acted from the old baseline plus the improvised recovery, all with
  resolved locators. Promoting it is moving a pointer, not editing a file.

The vocabulary stays theatrical, completing actor / persona / role-play: act
mode is a fresh performance against the live app, following the baseline
recording — not a re-watching of it. Re-watching is the viewer's job, and
"replay" is reserved for the viewer. Every performance, improvised or acted,
produces its own recording: a new trajectory with its own measurements,
results, and artifacts.

A healed run that ends green means: *the UI changed, but the user journey
survived*. A heal that ends red means the journey itself broke. This collapses
the classic flaky-E2E problem — selector rot triggers a heal, not a red build.

### The oracle: who decides pass/fail

Two layers, deliberately separated:

1. **Deterministic gate** (decides the exit code): the `success` assertions,
   the `perf` thresholds, and hard signals like uncaught JS errors. These are
   machine-checked facts about the final state and telemetry — no model
   judgment involved. CI trusts only this layer.
2. **Grader** (advisory quality score): a Sonnet agent reads the trajectory,
   the final page, and the telemetry, and produces a structured report —
   completion quality, efficiency vs. the baseline trajectory (step count,
   backtracking, confusion events, expectation-vs-outcome mismatches), time
   taken, and free-form findings ("the error message after an invalid card
   number is blank"). Scores are tracked as a **trend over time**, and a
   regression against the rolling baseline raises a warning, not a build
   failure.

This split is what keeps the suite trustworthy: stochastic judgment never
turns a build red on its own.

### Telemetry: the action is the unit of measurement

Every executed action — improvised by the agent or acted from the baseline —
opens a measurement window at input dispatch and closes it at settle. Everything inside the window is attributed
to that step and written into its envelope:

- An INP-style responsiveness number per action: input delay + processing +
  next paint ("this click took 1.9s to produce a paint")
- JS console errors and warnings
- Failed / slow network requests, payload sizes
- Long main-thread tasks
- Time-to-settle
- Core Web Vitals per navigation (LCP, CLS, INP/TBT), TTFB, load timings

This is invisible to the agent and free on every run, because the browser is
already instrumented. It catches the regressions an agent will cheerfully
click past — the page that "works" while throwing 14 console errors, the
checkout that got 800ms slower. Perf assertions in the YAML gate on these; the
reporter trends them.

One honest engineering note: the **settle heuristic** (when is an SPA "done"?)
is the hard problem here, and it is doubly load-bearing — it closes each perf
window *and* gates act-mode progression. It is pinned with the harness version;
changing it requires a refresh, because it shifts every timing trend.

### Artifacts & the trajectory

Every run writes a self-contained, self-describing directory:

```
runs/2026-06-10T0300/guest-checkout/
  manifest.json        # schema versions, model/prompt/gateway/harness pins,
                       # per-step artifact index
  trajectory.jsonl     # one step envelope per line — the spine
  har.json             # full network log; envelopes reference entries by index
  video.webm           # CDP screencast, with per-step timestamps
  trace.zip            # native Playwright trace — known-good fallback viewer
  steps/
    007.png            # screenshot per step
    007.mhtml          # full serialized page per step
    007.a11y.txt       # the pruned snapshot the agent actually saw
  grade.json           # grader output
```

One of these trajectories per case is saved as the **baseline** — the
pointer acted runs follow. The trajectory file is self-sufficient for that
job; where the pointer lives (committed next to the case, or in CI artifact
storage) is an open question.

The **MHTML page snapshots** mean every step can be opened in a browser later,
exactly as the agent saw it — framework-irrelevant, no app needed. This makes
triage offline and fast, and lets you run *post-hoc* assertions against
historical runs ("was the banner present at step 9 last Tuesday?").

### The trajectory viewer

The viewer (`playtest view`) is a **standalone static app that consumes a run
directory** — it works from a CI artifact download, offline, with no app or
backend. `manifest.json` tells it everything it needs. The primary surfaces:

- **Film strip + ghost cursor.** The screencast sliced by step markers, with
  the agent's clicks and typing overlaid as an animated cursor. Watching the
  AI use the app is the product demo.
- **Thought captions.** Each frame narrated by the step's `thought` and
  `expectation` — it reads like a usability session, not a test log.
- **"What the agent saw" toggle.** Flip between the screenshot and the pruned
  a11y snapshot for the same step. Instantly explains failures on
  semantically-empty pages, and doubles as accessibility-finding evidence.
- **Expectation vs. outcome badges.** Steps where reality contradicted the
  agent's stated expectation are flagged — confusion events become visually
  obvious instead of inferred.
- **Heal diff view.** The old baseline and the healed run diffed on their
  action tracks, with screenshots at the divergence point. This is the
  product's core claim — *UI changed, journey survived* — made visible.
- **Per-step network waterfall.** The step's `har_entries` slice of the run's
  HAR: click a slow step, see the three requests it fired.
- **Inline telemetry.** Console errors, per-action responsiveness, and
  Web Vitals markers on the timeline; a running token/cost strip ("this whole
  run: $0.04").
- **Cross-run sparkline.** For one case: duration, step count, grader score,
  LCP across the last N runs, with regression markers — the viewer serves
  trend review, not just failure triage.

Failure triage is always one of four verdicts, and the viewer is designed to
make the call obvious in under a minute:

| Verdict | Looks like | Response |
|---|---|---|
| App bug | Task genuinely impossible / assertion fails / errors thrown | File it. This is the product working. |
| App changed | A heal succeeded, or the agent succeeded a new way | Review the heal diff, accept the changed journey. |
| Agent flake | Agent confused on an unchanged, working page | Re-run; if persistent, tune the case story. |
| Environment flake | Container/seed/network/health-probe failure | Distinct exit code; never counted as a test failure. |

---

## 3. Using it

### Day-to-day commands

```
playtest tests/                        # everything discovered under tests/
playtest tests/ --tag smoke            # PR check: checks saved paths, heals if needed
playtest tests/checkout/               # one subtree
playtest tests/checkout/guest-checkout.yaml    # single case
playtest tests/ --mode agent           # force a fresh recording (ignore the baseline)
playtest tests/ --base-url https://pr-417.preview.example.com  # external target
playtest new suite checkout            # scaffold a suite (playtest.yaml)
playtest new case guest-checkout ./checkout    # scaffold a case in a suite
playtest list --tag smoke              # show what a selection resolves to
playtest view                          # open the GUI: run picker + heal/act diffs
playtest view --changed                # review changed journeys awaiting acceptance
playtest refresh tests/                # re-record saved paths from scratch
```

Advanced (hidden from help, stable): `playtest accept <runDir>` /
`playtest reject <runDir>` approve or dismiss a changed journey from a script
or after the fact; `playtest grade <runDir>` re-grades an existing trajectory.

### Writing your first test

1. Scaffold a case (`playtest new case my-case tests/`) or copy an example into
   the tree, write the story as you'd brief a human tester, and give it the
   obvious success criteria (a URL, an element, an API call). There is nothing
   to register — files in the tree are the suite.
2. Point the nearest `playtest.yaml` at your app: just a `base_url` if it's
   already running, plus your compose file if Playtest should boot it.
3. `playtest tests/my-case.yaml` — first run records; watch it in the viewer.
4. Commit the case file (and optionally the baseline) to the repo.

### CI integration

- Exit codes: `0` pass, `1` gate failure, `2` environment/infra error.
- JUnit XML output for CI test reporting; the run directory uploads as a build
  artifact so the viewer is one click from the failed build.
- Recommended shape: **`--tag smoke` on PRs** (act mode, fast — ideally
  against the PR's preview deployment), **the full tree nightly** (with
  `runs_per_case` > 1 if you want flake statistics), grader trends reviewed
  weekly.

### Lifecycle rules

- **Pinned and stamped into every run record:** actor/grader model versions,
  prompts and built-in personas, snapshot format, `step.schema.json` version,
  the settle heuristic, and the gateway (Portkey) config version. Upgrading
  any of them is treated like a dependency upgrade: bump, `refresh`,
  review.
- The harness refuses to compare scores or perf trends across baseline
  boundaries.

---

## 4. Cost & speed expectations

- **Acted runs** (the steady state): no actor model calls (one cheap model
  check per `assert:` criterion at the gate); seconds per case plus app boot
  (zero boot in external mode).
- **Record/heal runs**: a 30-step scenario on Haiku with prompt caching lands
  at low single-digit **cents**; one Sonnet grading call adds roughly the
  same. A 100-case full record pass is a few dollars. (This assumes prompt
  caching survives the gateway — see *Model access*.)
- **Wall clock is the real budget**: minutes per agentic case. Managed-mode
  cases run in parallel, each in its own compose project, bounded by host
  capacity; external-mode cases default to serial.

---

## 5. What Playtest is not

- **Not a unit/integration test replacement.** It covers user journeys, not
  logic branches.
- **Not exhaustive.** It tests the journeys someone wrote stories for.
  Coverage is a human responsibility; maintenance is what Playtest removes.
- **Not a load-testing or security tool.**
- **Not safe against real third parties.** Environments must be hermetic:
  seeded DB, mocked external services, test payment rails. The agent *will*
  press the buy button. This applies doubly to external mode — pointing
  Playtest at a deployed URL is pointing an autonomous user at it. Staging with
  test rails, never production.
- **A11y caveat:** the agent navigates by accessibility tree. If a page is
  semantically empty (div soup, no labels), the agent struggles — that is
  reported as an accessibility finding, distinct from a functional failure,
  but very poor markup may need the screenshot/vision fallback.

---

## 6. Glossary

User-facing terms (the words the CLI and docs lead with):

| Term | Meaning |
|---|---|
| Suite | A directory with `playtest.yaml` defaults; every case YAML below it belongs to it. |
| Case | A YAML user-journey file inside a suite: a story plus success criteria. |
| Run | Execute the selected cases (`playtest [paths...]`): recording, checking, or healing as needed. |
| View | Open the GUI (`playtest view`) to inspect runs and review changed journeys. |
| Changed journey | A successful healed run awaiting review — the app changed, but the journey survived. Shown as status `changed`. |
| Accept | Approve a changed journey (or any passing run) as the case's new saved path: `playtest accept <runDir>`. `reject` dismisses it. |
| Refresh | Re-record saved paths from scratch (`playtest refresh <paths...>`); also clears accumulated detours. |
| Saved path | The user-facing word for the baseline (below). |

Display status terms: `recording` (fresh agentic run), `checking` (following the
saved path), `healing` (recovering from a changed UI), `changed` (healed pass
awaiting review), `accepted` (now the saved path). Internally the code keeps
`record`, `act`, and `heal`.

Mechanics and internal terms:

| Term | Meaning |
|---|---|
| Actor | The pinned, cheap agent (Haiku) that performs the task. |
| Grader | The smarter agent (Sonnet) that scores a finished trajectory. |
| Step envelope | The versioned per-step record: agent output + resolution + result + perf + artifact pointers. One line of `trajectory.jsonl`. |
| Trajectory | The complete recording of one run: the sequence of step envelopes. Every run produces one. |
| Baseline | A pointer to the saved trajectory a case acts from — the current known-good path (user-facing: the *saved path*). Accepted heals and refreshes move it. |
| Action track | The actable projection of a trajectory: the steps that actually executed, with their resolved locators. Computed, never stored. |
| Act | To re-execute the baseline's action track step for step as a fresh run against the live app (act mode). |
| Replay | Reserved for the viewer: re-watching the recording of a past run. Never an execution mode. |
| Tag | A label on a case used for cross-directory selection (`--tag smoke`). |
| Managed / external environment | Whether Playtest boots the app (compose) or targets an already-running `base_url`. |
| Gate | Deterministic assertions + perf thresholds; the only thing that fails CI. |
| Heal | Agentic recovery from a failed acted step; a healed run that passes is a changed journey (its trajectory becomes the candidate baseline). |
| Bless | Internal/advanced name for accepting a trajectory as the baseline. The user-facing command is `playtest accept` (`bless` remains as a hidden alias). |
| Rebaseline | Internal/advanced name for `playtest refresh`: re-record baseline trajectories after an intentional change (hidden command alias). |
| Diff | The action-track diff between a run and its baseline — an implementation detail rendered inside the viewer's diff stage (there is no standalone diff command). |
| Grade | Normally part of a run; the hidden `playtest grade <runDir>` re-grades an existing run as a repair/debug action. |
| Confusion event | Harness-detected agent floundering: failed/repeated actions, backtracking, expectation-vs-outcome mismatches. |

---
