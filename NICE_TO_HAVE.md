# Playtest Nice-To-Haves

Ideas deliberately descoped from the improvement planning (now
IMPROVEMENTS_FOLLOWUP.md). Nothing here blocks the main plan; revisit once
the core workflow has settled.

## Interactive `playtest new`

The scripted forms (`playtest new suite <name> [dir]`,
`playtest new case <name> --suite <dir>`) cover the workflow. The interactive
layer on top of them:

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
GitHub Actions + the PR journey-diff bot + the agent skill + `playtest
check` (see IMPROVEMENTS_FOLLOWUP.md §6–8) form the same loop with zero
backend. A hosted service is a productization decision — multi-tenant,
SaaS, non-GitHub users — not a prerequisite for the loop.

Design constraints to honor when this is revisited:

- **The case schema is the stable contract; transport is orthogonal.** The
  API accepts the same case spec as the YAML, as a JSON body plus a target
  URL. Git vs platform DB is a storage decision, not a format change. Keep
  the schema clean and versioned and file-mode and API-mode stay the same
  engine.
- **The read side already exists** as the durable history backend
  (IMPROVEMENTS_FOLLOWUP.md §12): control plane in Postgres, artifacts in
  object storage. The service adds the write side: a queue plus run
  workers.
- **Workers are CI-runner-shaped, not lambda-shaped** — stateful,
  minutes-long browser sessions with pinned chromium.
- **The trust boundary survives the move to an API.** Success criteria are
  authored and reviewed by humans; baseline acceptance stays an explicit
  human action. The agent fixing the code never mutates the spec and never
  accepts its own work — otherwise the loop "closes" by weakening the
  assertions instead of fixing the app.
