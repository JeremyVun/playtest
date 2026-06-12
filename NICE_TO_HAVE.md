# Playtest Nice-To-Haves

Ideas deliberately descoped from the improvement planning (formerly
IMPROVEMENTS_FOLLOWUP.md, dismantled 2026-06-13 — the active package is
`VERSION_1.1.md`, the CI track is `CI_INTEGRATION.md`, accessibility is
parked in `ACCESSIBILITY.md`). Nothing here blocks the main plan; revisit
once the core workflow has settled.

## Interactive `playtest new`

(Written pre-V1: the scripted surface is now `playtest new <name> [dir]` /
`new persona <name>`, and suite creation no longer exists — the prompts
below would need rethinking against that surface.) The interactive layer
on top of the scripted forms:

- Bare `playtest new` chooser:

```txt
What would you like to create?
> Suite
  Case
```

- Suite prompts:

```txt
Suite name: checkout
Directory: ./checkout
Base URL: http://localhost:3000
```

- Case prompts:

```txt
Case name: add-todo
Suite: tests/todos
Story: Add a todo called "buy milk"
Success assertion: The list shows a todo called "buy milk"
Tags: smoke
```

- Suite picker when multiple suites exist (scripted form requires `--suite`).
- Persona picker in `playtest new case`:

```txt
Persona:
> tester
  exploratory
  curious-newcomer
```

- Environment chooser in `playtest new suite` (scripted form uses
  `--compose <file>`):

```txt
How should Playtest reach your app?
> Already running at a URL
  Start with Docker Compose
```

- `--yes` for non-interactive defaults (only meaningful once prompts exist).

## Accept/Reject Inside The GUI

Descoped to keep the viewer strictly read-only. Accept/reject buttons would
require the view server — deliberately GET-only today — to expose write
endpoints that modify versioned baseline files, plus origin checks or a
session token (any local webpage can POST to localhost). The read-only review
list showing copy-pasteable `playtest accept|reject <runDir>` commands covers
the workflow.

If revisited, acceptance must stay an explicit per-candidate action; the GUI
should make review easy, not hide the decision.

## Full-Screen Run TUI

The implemented live per-case status line (live.js) covers the "is it
stuck?" problem. A richer multi-pane TUI could add a whole-run dashboard:

```txt
Playtest

Run: 2026-06-10T1325-cd37
Target: http://localhost:3000

Cases
  PASS  todos/add-todo        act      4 steps    3.2s    $0.00
  RUN   todos/clear-completed heal     step 6     8.7s    $0.02
  WAIT  checkout/guest        record

Current
  Case: todos/clear-completed
  Mode: heal
  Step: 6 / 30
  Action: click "Clear completed"
  Last result: action failed, asking agent to recover

Totals
  1 passed, 0 failed, 0 infra, 1 running, 1 queued
```

Extra information beyond the status line: per-case queue state, token totals,
browser/env status, artifact links, outstanding accepts at the end. Use a
small TUI dependency only if it earns its keep.

## `playtest accept --latest`

Removed from the plan: accepting rewrites a baseline, so it should always name
the exact run directory. `view --latest` remains.

## Hosted Run Service (Playtest Behind An API)

The closed-loop "software factory" vision: an agent pushes code, a preview
environment deploys, a hosted Playtest service runs the journeys against it,
structured findings come back (webhook or poll), the agent fixes, and a
human accepts the journey diff at the end.

Deferred because the v0 of this loop already exists on rented rails:
GitHub Actions + the PR journey-diff bot (`CI_INTEGRATION.md` §6) + the
agent skill (`VERSION_1.1.md` item 3) + `playtest check` (below) form the
same loop with zero backend. A hosted service is a productization
decision — multi-tenant, SaaS, non-GitHub users — not a prerequisite for
the loop.

Design constraints to honor when this is revisited:

- **The case schema is the stable contract; transport is orthogonal.** The
  API accepts the same case spec as the YAML, as a JSON body plus a target
  URL. Git vs platform DB is a storage decision, not a format change. Keep
  the schema clean and versioned and file-mode and API-mode stay the same
  engine.
- **The read side already exists** as the durable history backend
  (`CI_INTEGRATION.md` §12): control plane in Postgres, artifacts in
  object storage. The service adds the write side: a queue plus run
  workers.
- **Workers are CI-runner-shaped, not lambda-shaped** — stateful,
  minutes-long browser sessions with pinned chromium.
- **The trust boundary survives the move to an API.** Success criteria are
  authored and reviewed by humans; baseline acceptance stays an explicit
  human action. The agent fixing the code never mutates the spec and never
  accepts its own work — otherwise the loop "closes" by weakening the
  assertions instead of fixing the app.

## `playtest check`: Ephemeral Cases

(Moved here 2026-06-13 from the improvement planning, where it ranked
below the agent skill because the skill already closes the loop for
existing case files.)

A one-shot inline case for probing — no file, no baseline, always a fresh
agentic run:

```txt
playtest check --base-url https://pr-417.preview.example.com \
  --story "Add a todo called 'buy milk'" \
  --assert "the list shows a todo called 'buy milk'"
```

- `--assert` is repeatable; `--json` and the exit-code contract apply as
  usual; artifacts land in `runs/` like any run.
- `--save tests/todos/add-todo.yaml` materializes a passing probe as a real
  case file — the promotion path from exploration to regression. Reuses
  `new`'s scaffolding.

Design rule this feature must not erode — **the YAML is spec, not config**:
the story and success criteria are the fixed point that makes a closed
agent loop trustworthy. If the agent fixing the code can also weaken the
assertions, the loop has a degenerate solution ("fix" the failure by
gutting the spec). Ephemeral checks are for probing; durable regression
requires a case file in git, reviewed by humans. `check` never writes
baselines and `--save` never overwrites an existing case without `--force`.

## `playtest docs`: Static Walkthrough Pages

(Demoted 2026-06-13: rendering documentation is a different product with a
different audience, and an open-ended maintenance surface — formats, index
pages, wiki integrations. The likelier shape is a **separate toolchain
that consumes playtest artifacts** — the run directory, plus the caption
derivation `playtest clip` builds — alongside other sources.)

Design ideas worth preserving if this is ever revisited, in playtest or in
that separate tool:

- **Act, then render:** for each case with a baseline, act it against the
  app (zero LLM calls, seconds) capturing fresh screenshots, then render
  the walkthrough from that just-verified run. Screenshots always match
  the current UI, and a broken journey fails the docs build —
  documentation that *refuses to lie*. An external tool gets this by
  invoking `playtest run` (exit codes are the contract) before reading
  artifacts.
- Captions are user-facing instructions derived from action + resolved
  locator (`Click "Checkout"`), not agent thoughts; an optional cheap LLM
  pass can polish phrasing.
- Page per case (story as intro, numbered steps, success criteria as
  "what you should see"), index per suite; Markdown + images as the
  portable format.
- Heal diffs double as "what changed in this flow" release-note material.

## Research-Mode Remainder: Persona Comparison + Findings Report

Discovery mode (implemented) covers the core of the original research-mode
idea; vision support is VERSION_1.1 item 7. What remains deferred:

- `--compare`: run multiple personas over the same journeys and report the
  delta — completed-by, steps taken, where each diverged or gave up.
- A findings report artifact (`runs/<run>/findings.md`) synthesized by a
  grader variant: per-journey narrative, hesitation/confusion moments with
  step screenshots, expectation-vs-outcome mismatches, verbatim agent
  thoughts as user quotes.
- Research-style clips (thought captions — `playtest clip --captions
  thought` once VERSION_1.1 item 2 lands) embedded in that report.

Revisit when a research audience (designers, PMs) concretely asks.

## Rename "case" To "scenario"

Decided against, recorded so it isn't relitigated cheaply: **scenario**
had the best metaphor fit (actors improvising from a scenario is literally
record mode, and it's Gherkin-familiar); **story** collides with the
`story:` field ("the story's story"); **journey** is reserved for the
in-app concept a case *checks*. "Case" stays because the glossary
deliberately runs two registers — theatrical where it explains mechanics
(actor, act, heal), conventional on the CI-facing surface (suite, case,
run, tag) — and `case_id`/`--case` make a rename expensive for marginal
gain. If the appetite ever firms up, pre-1.0 is the only cheap window.

## MCP Server

Superseded by the agent skill (VERSION_1.1 item 3) for shell-capable
agents. Revisit only if a no-shell surface (claude.ai web, restricted IDE
sandboxes) demands Playtest access; it would be a thin wrapper over the
CLI and the `CI_INTEGRATION.md` §12 API at that point.

## Compose-Based Example Suite

Superseded by `playtest demo` as the first-run path. Do it only if managed
mode needs a living exercise: point `tests/playtest.yaml` at
`docker-compose.test.yml` via the `app:` block.
