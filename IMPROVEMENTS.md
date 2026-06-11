# Playtest CLI and Developer Experience Improvements

This document captures proposed improvements to the CLI contract, day-to-day
developer workflow, and adjacent product surfaces. It is intentionally kept as
one planning input for LLM planner agents. The goal is to make Playtest feel
like a simple user-journey testing tool, while keeping baseline, healing,
grading, and review mechanics available under clearer names.

## Goals

- Make the common path short: `playtest tests/`.
- Avoid exposing implementation-heavy words like `bless`, `rebaseline`, `diff`,
  and `grade` as user commands.
- Make review and acceptance obvious after a changed journey succeeds.
- Reduce typing of timestamped run directories.
- Add richer status feedback while runs are executing.
- Preserve expert/debug commands where useful, but move them out of the main
  documented workflow.

## Proposed CLI

```txt
playtest new                  # create a suite or case interactively
playtest new suite <name> [dir]
playtest new case <name> [suite_dir]
playtest <paths...>          # run tests
playtest view [run_or_root]  # open the GUI to inspect runs and review changes
playtest refresh <paths...>  # force fresh recordings and accept passing ones
playtest list [paths...]     # show selected suites/cases
```

Hidden or advanced commands:

```txt
playtest accept <runDir>     # accept a specific changed journey
playtest grade <runDir>      # re-grade an existing run
```

Compatibility alias can remain during transition:

```txt
playtest run <paths...>      # alias for playtest <paths...>
```

## Naming Model

Use user-facing words that describe the decision being made:

- **Run**: execute the selected playtests. This is the action users perform with
  `playtest <paths...>`; `playtest run` can remain as a compatibility alias.
- **View**: open the GUI to inspect runs and decide whether changed journeys
  should become saved paths.
- **Accept**: approve a specific changed journey as the new saved path. This is
  a deliberate action inside the GUI, plus an advanced scriptable command.
- **Refresh**: create fresh saved paths from scratch.
- **Suite**: a directory with `playtest.yaml` defaults. During migration,
  `dummy.yaml` can still be read for backward compatibility.
- **Case**: a YAML user journey file inside a suite.
- **Changed journey**: a successful healed run awaiting review and acceptance.

Avoid making users learn these terms first:

- **Bless**: old internal name for accepting a run as the baseline.
- **Rebaseline**: old internal name for refreshing saved paths.
- **Diff**: an implementation detail that belongs inside the GUI.
- **Grade**: normally part of a run; separate grading is a repair/debug action.

## How To Explain It

Playtest records a known-good way to complete a task.

The first run lets the AI figure out the task and saves the path it used. That
saved path is the baseline.

Later runs follow the saved path because it is faster, cheaper, and more stable
than asking the AI to improvise every time.

If the app changes and the saved path breaks, Playtest asks the AI to continue
from the broken point. If the AI still completes the task, the run is marked as
a healed run.

A healed run means:

> The app changed, but the user journey still works.

The developer then reviews the run and accepts it if the new path is correct.
Accepting makes that run the new saved path.

## `playtest new`

`playtest new` should be the first-time suite and case creation flow. A separate
`playtest init` is probably unnecessary if Playtest is already installed as a
JavaScript bin and the only project artifacts are suite and case YAML files.

The interactive command should start with a clear choice:

```txt
What would you like to create?
> Suite
  Case
```

### Suite Creation

A suite is just a directory containing `playtest.yaml`.

Rules:

- `playtest new suite checkout` creates `./checkout/playtest.yaml`.
- `playtest new suite checkout tests/checkout` creates
  `tests/checkout/playtest.yaml`.
- The suite name should be written into the config if a `name` field exists.
- If `suite_dir` is omitted in interactive mode, default to `.` or to a
  slugified directory based on the suite name, depending on the prompt answer.
- Do not overwrite an existing `playtest.yaml` unless `--force` is passed.

Initial suite config should stay small:

```yaml
name: checkout
env:
  base_url: http://localhost:3000
```

Interactive prompts:

```txt
Suite name: checkout
Directory: ./checkout
Base URL: http://localhost:3000
```

After creation, print the created path and next command:

```txt
Created suite: ./checkout/playtest.yaml
Next: playtest new case add-todo ./checkout
```

### Case Creation

A case is a YAML file inside a suite.

Rules:

- `playtest new case add-todo tests/todos` creates
  `tests/todos/add-todo.yaml`.
- `suite_dir` must point at a suite directory containing `playtest.yaml`.
- If `suite_dir` is omitted and the current directory is inside a suite, use
  the nearest suite.
- If exactly one suite exists under the current directory, use it.
- If multiple suites exist, show a picker with relative paths.
- If no suites exist, offer to create one first.
- Do not overwrite an existing case unless `--force` is passed.

Support a clearer scripted form as well:

```txt
playtest new case add-todo --suite tests/todos
```

Initial case file should be readable and teach the contract:

```yaml
tags: []
story: |
  Describe what the user should do.

success:
  - assert: Describe what should be true when the task is complete.

perf:
  console_errors: 0
```

Interactive prompts:

```txt
Case name: add-todo
Suite: tests/todos
Story: Add a todo called "buy milk"
Success assertion: The list shows a todo called "buy milk"
Tags: smoke
```

Generated example:

```yaml
tags: [smoke]
story: |
  Add a todo called "buy milk".

success:
  - assert: The list shows a todo called "buy milk".

perf:
  console_errors: 0
```

After creation, print the created path and next command:

```txt
Created case: ./tests/todos/add-todo.yaml
Next: playtest ./tests/todos/add-todo.yaml
```

### `new` Edge Cases

- If a case name contains spaces, slugify it predictably:
  `"Login flow"` -> `login-flow.yaml`.
- If a case name contains path separators, either reject it with a clear message
  or treat it as a nested path consistently.
- If multiple suites share the same display name, show relative paths.
- If a provided suite directory lacks `playtest.yaml`, fail clearly:

```txt
tests/e2e is not a Playtest suite. Expected tests/e2e/playtest.yaml.
```

- Prefer relative paths in all creation output.
- Add `--yes` for non-interactive defaults and `--force` for explicit
  overwrites.

## `playtest <paths...>`

The default command should run cases.

Examples:

```txt
playtest tests/
playtest tests/ --tag smoke
playtest tests/checkout/guest-checkout.yaml
playtest tests/ --base-url https://pr-417.preview.example.com
```

`playtest` with no paths should do something useful:

1. If the current directory is inside a suite, run that suite.
2. Else if suites are discovered below the current directory, run them.
3. Else print a precise onboarding hint:

```txt
No Playtest suites found. Create one with: playtest new
```

Behavior:

- First run of a case records a baseline if the run passes.
- Later runs act the existing baseline.
- If acting fails and a model is available, Playtest attempts to heal.
- If a heal passes, Playtest should create an outstanding acceptance item.
- Grading should happen as part of runs where it is useful and possible.
- Separate `playtest grade` should remain only as an advanced backfill/repair
  command.

### End-Of-Run Prompts

When running interactively and there are changed journeys, prompt the user:

```txt
2 changed journeys passed and need review.

Open review? [Y/n]
Accept all?  [y/N]
```

The exact prompt should be conservative:

- Do not auto-accept without explicit confirmation.
- Do not prompt in CI or non-TTY output.
- Do not prompt when `--yes`, `--ci`, or similar non-interactive flags are set.
- Provide the exact command to resume later:

```txt
Review and accept later with: playtest view --changed
```

End every run with concise next actions:

```txt
View results:     playtest view
Review changes:  playtest view --changed
CI artifacts:    runs/2026-06-10T1325-cd37
```

If there are failures:

```txt
Open failed runs: playtest view --failed
```

Avoid printing a long timestamped path unless it is needed.

## `playtest view [run_or_root]`

`playtest view` opens the GUI for inspecting runs, opening artifacts, and
accepting or rejecting changed journeys.

Proposed resolution order:

1. `--runs-root`, if provided.
2. Config value, if added later.
3. `./runs`.
4. Nearest ancestor containing `runs`.
5. Clear error with examples.

Avoid silently scanning huge parent directories.

Examples:

```txt
playtest view
playtest view runs/
playtest view runs/2026-06-10T1325-cd37/todos/add-todo
```

`playtest view` should usually open the run picker, not require a timestamped
run directory. This avoids the most annoying part of the current workflow. It
should also surface changed journeys so users can inspect the diff and accept or
reject without leaving the GUI.

Possible flags:

```txt
playtest view --case todos/add-todo
playtest view --failed
playtest view --changed
```

See "Latest Run Helpers" for `--latest` selectors.

## `playtest accept <run_dir>`

`playtest accept <run_dir>` is the advanced, scriptable form for approving a
specific changed journey as the new saved path:

```txt
playtest accept runs/2026-06-10T1325-cd37/todos/add-todo
```

The primary human workflow should be `playtest view`, where acceptance is an
explicit action after inspection:

```txt
playtest view --changed
```

This keeps the normal CLI focused on one GUI surface while preserving a
load-bearing direct command for automation, CI repair workflows, and exact-run
approval.

### Outstanding Acceptance Items

An outstanding acceptance item is a successful run that changed the saved path
and has not yet been accepted.

Initial implementation can treat these as:

- Runs where `manifest.healed === true` and `manifest.result.status === "pass"`.
- Existing `<case>.healed.jsonl` and `<case>.healed.json` candidates.

Later, this can be expanded to include fresh agent runs that differ from the
current baseline.

### Changed-Journey Review In The GUI

`playtest view --changed` should open the GUI focused on changed journeys that
need review.

Suggested layout:

```txt
Changed journeys awaiting review

  Status  Case              Run                      Started              Score
> pass    todos/add-todo    2026-06-10T1325-cd37     2026-06-10 13:25     92
  pass    checkout/guest    2026-06-10T1410-ab12     2026-06-10 14:10     88

Actions: Enter view | a accept | r reject | q quit
```

Useful actions:

- `Enter`: open artifacts for the selected run.
- `a`: accept the selected run.
- `A`: accept all selected runs after confirmation.
- `r`: reject/dismiss the candidate after confirmation.
- `space`: select/unselect.
- `q`: quit.

Acceptance should still be explicit. The GUI should make review easy, not hide
the decision.

### Rejecting

There should be a way to reject or dismiss an outstanding changed journey inside
the GUI:

```txt
r reject selected
```

Rejecting should remove the pending changed-journey marker files, but should not
delete the run artifacts. The run remains available for inspection.

## `playtest refresh <paths...>`

`refresh` means:

> Ignore the old saved path, ask the AI to perform the journey from scratch,
> and if it passes, save that fresh path as the new baseline.

Examples:

```txt
playtest refresh tests/
playtest refresh tests/todos/add-todo.yaml
playtest refresh tests/ --tag smoke
```

Use cases:

- The old path still works but is no longer the path users actually take.
- The app went through a redesign.
- The saved path accumulated awkward detours.
- Prompt, model, locator, or harness behavior changed enough that old baselines
  should be regenerated.

This is different from `accept`:

- `accept` approves a specific already-run changed journey.
- `refresh` creates new journeys from scratch.

Possible alternate names:

- `rerecord`: very explicit, but a little technical.
- `record`: clear, but might sound like it only creates and does not validate.
- `update`: short, but too vague.

Current preference: `refresh`.

## TUI During Runs

The current line-by-line report is useful for CI, but interactive local runs
could show richer status.

Use a TUI only when stdout is a TTY. Keep plain output for CI.

Suggested run TUI:

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

Information worth showing:

- Current run id and run root.
- Per-case status: queued, running, pass, fail, infra.
- Mode: record, act, heal.
- Current step count and max steps.
- Current action summary.
- Gate failures as they happen.
- Token and cost totals.
- Browser/env status.
- Links or commands for viewing artifacts.
- Outstanding accepts at the end.

Implementation notes:

- Keep the existing reporter for non-TTY output.
- Add structured progress events from the runner instead of scraping logs.
- Use a small TUI dependency only if it earns its keep.
- Avoid hiding important errors behind animation.
- Make `--plain` or `--no-tui` available.

## Suggested Implementation Phases

### Phase 1: CLI Contract

- Rename package/bin from `dummy` to `playtest`.
- Make root `playtest <paths...>` run cases.
- Keep `playtest run` as a hidden compatibility alias.
- Add command routing for `playtest new`, `playtest new suite`, and
  `playtest new case`.
- Keep `view` as the primary GUI inspection and changed-journey review command.
- Add `accept` as an advanced direct approval command.
- Add `refresh` as the replacement for the old rebaseline workflow.
- Remove standalone `diff`; show changed action tracks inside the GUI instead.
- Hide `grade` from normal help.
- Update README and contracts.

### Phase 2: Creation Workflow

- Implement suite discovery using `playtest.yaml`.
- Implement interactive `playtest new`.
- Generate small suite and case YAML files.
- Print created files and next commands.
- Add `--suite`, `--yes`, and `--force`.

### Phase 3: Zero-Argument View

- Use shared runs-root discovery for `playtest view`.
- Add `--latest` once latest-run discovery is reliable.
- Improve post-run output with `playtest view` suggestions.

### Phase 4: Acceptance Workflow

- Track outstanding changed journeys.
- Implement `playtest view --changed` as a GUI review list.
- Add reject/dismiss support.
- Add end-of-run prompts for changed journeys in interactive sessions.

### Phase 5: Interactive Run TUI

- Add structured progress events from runner/session/actor.
- Implement TTY-only TUI renderer.
- Keep current plain reporter for CI and logs.
- Add `--plain` / `--no-tui`.

## Additional Improvement Ideas

### No-Arg List

Make `playtest list` useful without paths:

```txt
playtest list
```

Resolution should mirror no-arg `playtest`:

1. If inside a suite, list that suite.
2. Else list discovered suites and cases below the current directory.
3. Else suggest `playtest new`.

This helps first-time users see what Playtest found before they run anything.

### Clearer Case File Naming

Today defaults live in `dummy.yaml`. After the rename, consider:

```txt
playtest.yaml
```

Migration path:

- Read both `playtest.yaml` and `dummy.yaml`.
- Prefer `playtest.yaml` when both exist.
- Warn once when only `dummy.yaml` is present.

### Latest Run Helpers

Add convenient selectors:

```txt
playtest view --latest
playtest view --latest --case todos/add-todo
playtest accept --latest
```

These should select based on manifest timestamps, not directory-name sorting
alone. `accept --latest` should remain an advanced shortcut and require clear
confirmation unless non-interactive confirmation is explicitly provided.

### CI Mode

Make CI behavior explicit:

```txt
playtest tests/ --ci
```

CI mode should:

- Disable prompts.
- Disable TUI.
- Use stable plain output.
- Print artifact paths.
- Optionally fail if there are unaccepted changed journeys.

### Better Help Text

The top-level help should teach the same workflow as the proposed CLI:

```txt
Usage:
  playtest new               create a suite or case
  playtest new suite <name>  create a suite
  playtest new case <name>   create a case in a suite
  playtest <paths...>        run user journey tests
  playtest view              open the GUI for runs and changed journeys
  playtest refresh <paths>   create fresh saved paths
  playtest list              list discovered suites and cases
```

Keep advanced commands in `playtest help advanced` or hidden help.

### Status Terms

Use consistent user-facing labels:

- `recording`: first-time or fresh AI run.
- `checking`: following the saved path.
- `healing`: recovering from a changed UI.
- `changed`: successful healed run awaiting review and acceptance.
- `accepted`: saved as the new path.

Internally the code can keep `record`, `act`, and `heal`.

### Acceptance Safety

Before accepting a run, validate:

- The run exists and has `manifest.json`.
- The run passed.
- The run has a case file in `manifest.case.file`.
- The trajectory exists.
- The case file still exists.
- If accepting a changed journey, it matches the current pending item or
  clearly explains if it does not.

### Runs Root Discovery

Use the same runs-root discovery order for `view`, advanced `accept`,
latest-run selectors, and any other command that accepts an optional run path.
See `playtest view [run_or_root]` above for the canonical order.

### Plain JSON Output

For editor integrations and future automation:

```txt
playtest tests/ --json
playtest view --json
```

This should emit machine-readable events or summaries without TUI formatting.

### Historical Trends And Regression Signals

One of the main values of storing run artifacts is building a history for each
user journey. A developer should be able to make a change, run a suite, and see
quickly whether a scenario got worse compared with prior runs.

Current state:

- `view-server.js` already exposes `/history.json?case=<case_id>`.
- The history endpoint scans sibling run directories and returns
  `run_id`, `started_at`, `status`, `mode`, `duration_ms`, `steps`,
  `score`, `lcp_ms`, and `cost_usd`.
- The viewer already renders a small sparkline using score when available,
  otherwise duration.
- The CLI summary does not currently show movement or regression context.
- The viewer sparkline is present, but it is small and does not explain
  meaningful movement at a glance.

Improve this into a first-class feature:

- Treat run history as a core product surface, not a viewer extra.
- Show movement indicators in the viewer:
  - score delta vs previous comparable run,
  - score delta vs recent median,
  - duration delta,
  - LCP delta,
  - step-count delta,
  - status movement such as pass -> fail or pass -> healed.
- Add hover/click affordances to the sparkline so a developer can jump to older
  runs.
- Add a clear "regression" or "improved" badge when movement crosses thresholds.
- Show trend context in the CLI after each case:

```txt
PASS  todos/add-todo  checking  4 steps  score 92 (+3)  duration 3.2s (-0.4s)
FAIL  checkout/guest  checking  score 61 (-24)  regression vs recent runs
```

- In the run TUI, include a compact trend column:

```txt
Case                 Status  Score      Duration    Trend
todos/add-todo       PASS    92 +3      3.2s -0.4s  improving
checkout/guest       FAIL    61 -24     9.8s +4.1s  regression
```

Implementation notes:

- Compute trend summaries from manifests and `grade.json` files under the runs
  root.
- Use manifest timestamps for ordering, not directory-name sorting alone.
- Compare only the same case id.
- Prefer recent successful non-infra runs for baseline trend comparisons.
- Keep raw history available via JSON for future dashboards.
- Consider persisting an index later if scanning `runs/` becomes slow.

### Actor Context Window And Prompt Caching

The actor currently builds messages like this:

```txt
system: stable actor prompt + persona + story
user: rendered log of all prior steps
user: current page snapshot
```

The stable system prefix is cache-friendly, but `renderLog(history)` rebuilds
the whole history into one changing user message every turn. That means a large
chunk of otherwise old context can appear as a new block to the model gateway on
each step.

The desired shape is closer to:

```txt
system/tail: stable instructions, persona, story
log chain: append-only prior steps
head: current fully observed page state
```

Only the newest observation and the newest appended step should change each
turn. Older steps should remain byte-identical and position-stable where the
model/provider can cache them.

Proposed direction:

- Represent prior steps as an append-only chain of messages instead of one
  regenerated log block.
- Keep the current page snapshot as the final head message.
- On each turn, append only the previous step summary to the read-only log
  chain, then replace the current snapshot head.
- Keep compaction deterministic:
  - no compaction for short runs,
  - once long, compact older steps into stable checkpoint messages,
  - avoid rewriting the whole log every turn.
- Preserve enough detail for the actor:
  - action,
  - result,
  - error,
  - expectation,
  - confusion signal,
  - useful URL/state changes.
- Consider provider-specific prompt cache controls later, but first fix the
  message shape so it is naturally cacheable.

This should reduce repeated input tokens and improve latency on long recorded
or healed runs.

### Persona Ergonomics

Current state:

- Built-in personas are `tester` and `exploratory`.
- Custom personas are YAML files in a `personas/` directory.
- `loadPersona(name, caseFile)` searches from the case file's directory upward
  to the repo root for `personas/*.yaml`.
- A custom persona is selected by setting `persona: <name>` in the case file or
  inherited suite config.

Improve the UX:

- Document custom personas prominently in the new suite/case flow.
- Add `playtest list personas` or `playtest personas` to show available
  built-in and custom personas.
- Do not add a `--persona` CLI override. Persona selection should live in suite
  or case config so the run contract is visible in versioned test files.
- In `playtest new case`, let the user pick a persona:

```txt
Persona:
> tester
  exploratory
  curious-newcomer
```

- If a persona is not found, include the searched locations and suggest:

```txt
Create one with: playtest new persona curious-newcomer
```

Possible future command:

```txt
playtest new persona <name>
```

This would create `personas/<name>.yaml` with a small template:

```yaml
name: curious-newcomer
description: |
  Describe how this user approaches the app.
```

### Managed Docker Environment UX

Current state:

- The harness supports managed Docker Compose environments when `env.compose`
  is configured.
- If `env.compose` is present, Playtest runs
  `docker compose -f <file> -p <project> up -d --wait`, resolves service host
  names in `base_url` to published localhost ports, probes the app, runs
  `env.init`, and tears the stack down afterward.
- If `env.compose` is absent, Playtest treats `base_url` as an external app and
  expects it to already be running.
- The example `tests/dummy.yaml` currently uses external mode and explicitly
  says to start the todo app manually.
- The repo has `docker-compose.test.yml`, but the example suite does not point
  at it.

Improve the UX:

- In `playtest new suite`, ask whether Playtest should manage the app:

```txt
How should Playtest reach your app?
> Already running at a URL
  Start with Docker Compose
```

- For external mode, write:

```yaml
env:
  base_url: http://localhost:3000
```

- For managed mode, write:

```yaml
env:
  base_url: http://app:3000
  compose: ./docker-compose.test.yml
```

- If a compose file exists in the project root, offer it as the default.
- If the compose service name is known, guide the user to use that hostname in
  `base_url`, not `localhost`.
- Before running, if `base_url` points at localhost and health probing fails,
  provide a targeted hint:

```txt
Could not reach http://localhost:4173.
Start the app yourself, or add env.compose to playtest.yaml so Playtest can
manage it.
```

- If `docker-compose.test.yml` exists but `env.compose` is missing, suggest the
  exact config to add.
- In the run TUI, show whether the environment is external or managed:

```txt
Environment: managed compose ./docker-compose.test.yml
Environment: external http://localhost:4173
```

Potential example-suite fix for later implementation:

```yaml
env:
  base_url: http://app:4173
  compose: ../docker-compose.test.yml
  init: ./seed/reset.sh
```

This would make the demo exercise the managed-environment feature instead of
requiring `npm run todo-app` in a separate terminal.

### Portable Network Data In The Trajectory

Reports should be portable. A run directory can contain rich artifacts, but the
core pass/fail record should not depend on too many sidecar files.

Current state:

- `browser.js` records a run-level `har.json`.
- Each step envelope stores `artifacts.har_entries`, an array of numeric indexes
  into `har.json`.
- The viewer reads `har.json` and uses those indexes to render the per-step
  network waterfall.
- `api_called` currently checks `ctx.harEntries`, which `runner.js` loads from
  `har.json`.

That means an important hard assertion depends on a sidecar artifact. If
`trajectory.jsonl` is copied alone, the run is no longer fully auditable for
API-call assertions.

Prefer this direction:

- Add compact structured network data directly to each step envelope.
- Make `api_called` search the trajectory's embedded network data.
- Keep `har.json` as an optional deep-debug artifact, not the source of truth
  for pass/fail checks.
- Keep `artifacts.har_entries` temporarily for backward compatibility.

Example envelope shape:

```json
{
  "step": 2,
  "network": {
    "requests": [
      {
        "method": "POST",
        "url": "http://localhost:4173/api/todos",
        "path": "/api/todos",
        "status": 201,
        "mime_type": "application/json",
        "body_size": 84,
        "duration_ms": 42,
        "failed": false
      }
    ]
  }
}
```

Keep the embedded form intentionally compact:

- method
- full URL
- pathname/search or normalized path
- status
- duration
- failed flag
- response mime type
- response size when known

Do not embed full request/response bodies by default. They are noisy, sensitive,
and can make trajectory files hard to review. If payload capture is added later,
it should be opt-in and redacted.

Benefits:

- `trajectory.jsonl` becomes much more self-contained.
- `api_called` can be a structured search over envelopes, not a sidecar HAR
  lookup.
- Baselines and changed journeys carry enough network evidence to explain why
  they passed.
- The viewer can render a useful network panel even when `har.json` is absent.
- `har.json` can remain available for richer debugging without being required.

Suggested migration:

1. Add `network.requests` to new envelopes while still writing `har.json`.
2. Update the viewer to prefer `env.network.requests`, falling back to
   `artifacts.har_entries` plus `har.json`.
3. Update `api_called` to search `ctx.trajectory.flatMap(e =>
   e.network?.requests ?? [])`.
4. Keep reading old runs that only have `har_entries`.
5. Once stable, make `har.json` optional or behind a `--full-har` flag.
