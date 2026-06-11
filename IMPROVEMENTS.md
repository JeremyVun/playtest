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
playtest [paths...]          # run tests (paths default to .)
playtest new suite <name> [dir]
playtest new case <name> [suite_dir]
playtest view [run_or_root]  # open the GUI to inspect runs and review changes
playtest refresh <paths...>  # force fresh recordings and accept passing ones
playtest list [paths...]     # show selected suites/cases
```

Hidden or advanced commands:

```txt
playtest accept <runDir>     # accept a specific changed journey
playtest reject <runDir>     # dismiss a pending changed journey
playtest grade <runDir>      # re-grade an existing run
```

Compatibility alias can remain during transition:

```txt
playtest run <paths...>      # alias for playtest <paths...>
```

On a name conflict, subcommands win: `playtest view` is always the `view`
command even if a `./view` directory exists. Run a conflicting path with
`playtest ./view` or `playtest run view`.

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

`playtest new` is the suite and case creation flow. A separate `playtest init`
is probably unnecessary if Playtest is already installed as a JavaScript bin
and the only project artifacts are suite and case YAML files.

Ship the scripted forms with good error messages; the interactive layer (bare
`playtest new` chooser, prompts, pickers) is deferred — see NICE_TO_HAVE.md.

### Suite Creation

A suite is just a directory containing `playtest.yaml`.

Rules:

- `playtest new suite checkout` creates `./checkout/playtest.yaml`.
- `playtest new suite checkout tests/checkout` creates
  `tests/checkout/playtest.yaml`.
- The suite name should be written into the config if a `name` field exists.
- If `dir` is omitted, default to a slugified directory based on the suite
  name.
- Do not overwrite an existing `playtest.yaml` unless `--force` is passed.

Initial suite config should stay small:

```yaml
name: checkout
env:
  base_url: http://localhost:3000
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
- If multiple suites exist, require `--suite` (a picker is deferred to
  NICE_TO_HAVE.md).
- If no suites exist, suggest `playtest new suite <name>`.
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
- Add `--force` for explicit overwrites.

## `playtest [paths...]`

The default command should run cases. Paths default to `.`.

Examples:

```txt
playtest tests/
playtest tests/ --tag smoke
playtest tests/checkout/guest-checkout.yaml
playtest tests/ --base-url https://pr-417.preview.example.com
```

Bare `playtest` is simply `playtest .`: discover suites and cases below the
current directory and run them. If nothing is found, print a precise
onboarding hint:

```txt
No Playtest suites found. Create one with: playtest new suite <name>
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
Review later with:  playtest view --changed
Accept later with:  playtest accept <runDir>
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

The primary human workflow is: review in the GUI (`playtest view --changed`),
then accept from the CLI — via the end-of-run prompt or
`playtest accept <runDir>`. The viewer stays read-only and never writes
baselines.

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
need review: a read-only list of pending candidates (status, case, run,
started, score) linking to each run's artifacts and its action-track diff.

The viewer stays read-only. For each pending candidate, display the exact
copy-pasteable commands:

```txt
playtest accept runs/2026-06-10T1325-cd37/todos/add-todo
playtest reject runs/2026-06-10T1325-cd37/todos/add-todo
```

Accept/reject buttons inside the GUI are deferred (see NICE_TO_HAVE.md): they
would require the view server — deliberately GET-only today — to accept writes
against versioned baseline files.

### Rejecting

`playtest reject <runDir>` dismisses a pending changed journey. It removes the
pending candidate marker files (`<case>.healed.jsonl` / `<case>.healed.json`)
but does not delete the run artifacts. The run remains available for
inspection.

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

## Live Progress During Runs

Today the reporter prints one line per case only after the case finishes, so a
multi-minute agentic run produces no output at all and the harness can look
stuck or frozen with no diagnostic information.

The need is liveness, not a full-screen TUI. Chosen design: a live region at
the bottom of normal output, in the style of vitest or cargo. When stdout is
a TTY, each active case gets one updating line; when a case finishes, its
line leaves the live region and its final report line prints permanently
above it, so scrollback reads exactly like today's output:

```txt
run 2026-06-10T1325-cd37 — 3 case(s) → runs/2026-06-10T1325-cd37
Environment: external http://localhost:4173

 PASS todos/add-todo  checking · 4 steps · 3.2s
⠹ RUN  todos/clear-completed  healing   step 6/50  click "Clear completed"  8.7s  $0.02
⠸ RUN  checkout/guest         checking  step 2/50  open /checkout           1.1s
```

Each live line shows: spinner, case id, mode (recording/checking/healing),
step k of max, current action summary, elapsed time, and cost so far. Heal
transitions and gate failures print as permanent lines the moment they
happen, not only at the end.

Implementation notes:

- Keep the existing reporter for non-TTY output; CI behavior is unchanged.
- Add structured progress events from the runner/session/actor (case_start,
  step_start, step_result, heal_start, gate_fail, case_end) instead of
  scraping logs. This is the load-bearing piece; renderers are cheap after it.
- No new dependency: `report.js` already writes raw ANSI; the live region
  needs only cursor-up/erase-line escapes and a redraw throttle (~10 fps or
  on event).
- Parallel runs fall out naturally: one live line per active case, completed
  lines flush in completion order.
- Errors always print as permanent lines — never hidden behind animation.
- Make `--plain` or `--no-tui` available.

A richer multi-pane full-screen TUI is deferred — see NICE_TO_HAVE.md.

## Suggested Implementation Phases

### Phase 1: CLI Contract

- Rename the package to `@<scope>/playtest` for the private registry (the bare
  name `playtest` is squatted on the public npm registry, and a scoped name
  also prevents dependency confusion) and the bin to `playtest`.
- Make root `playtest [paths...]` run cases, with paths defaulting to `.`.
- Subcommand names win over path arguments on conflict.
- Keep `playtest run` as a hidden compatibility alias.
- Add command routing for `playtest new suite` and `playtest new case`.
- Keep `view` as the primary GUI inspection and changed-journey review command.
- Add `accept` and `reject` as advanced direct commands.
- Add `refresh` as the replacement for the old rebaseline workflow.
- Remove standalone `diff`; the viewer already renders an action-track diff
  stage, so the GUI replacement exists today.
- Hide `grade` from normal help.
- Update README and contracts.
- Preserve the exit-code contract: 0 pass, 1 gate failure, 2 infra/config.

### Phase 2: Creation Workflow

- Implement suite discovery using `playtest.yaml`.
- Implement scripted `playtest new suite` and `playtest new case`.
- Generate small suite and case YAML files.
- Print created files and next commands.
- Add `--suite` and `--force`.

### Phase 3: Zero-Argument View

- Use shared runs-root discovery for `playtest view`.
- Add `--latest` once latest-run discovery is reliable.
- Improve post-run output with `playtest view` suggestions.

### Phase 4: Acceptance Workflow

- Track outstanding changed journeys.
- Implement `playtest view --changed` as a read-only GUI review list that
  shows the exact accept/reject commands.
- Add `playtest reject <runDir>`.
- Add end-of-run prompts for changed journeys in interactive sessions.

### Phase 5: Live Run Progress

- Add structured progress events from runner/session/actor.
- Implement a TTY-only live status renderer.
- Keep current plain reporter for CI and logs.
- Add `--plain` / `--no-tui`.

## Additional Improvement Ideas

### No-Arg List

Make `playtest list` useful without paths:

```txt
playtest list
```

Resolution should mirror no-arg `playtest`: default paths to `.`, list
discovered suites and cases below the current directory, else suggest
`playtest new suite <name>`.

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
```

These should select based on manifest timestamps, not directory-name sorting
alone. `accept` deliberately has no `--latest`: accepting rewrites a baseline,
so it must always name the exact run directory.

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
- Optionally fail if there are unaccepted changed journeys (exit code 1).
- Preserve the existing exit-code contract: 0 pass, 1 gate failure,
  2 infra/config.

### Better Help Text

The top-level help should teach the same workflow as the proposed CLI:

```txt
Usage:
  playtest [paths...]        run user journey tests (default: .)
  playtest new suite <name>  create a suite
  playtest new case <name>   create a case in a suite
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
- Show trend context in the CLI after each case. Checking (act) runs are not
  graded by default, so their trends use duration/steps/LCP/status; score
  deltas appear only on graded runs (recording, healing, refresh):

```txt
PASS  todos/add-todo   checking  4 steps  3.2s (-0.4s)
FAIL  checkout/guest   checking  9.8s (+4.1s)  first fail after 5 passes
PASS  todos/add-todo   healing   6 steps  score 88 (-4 vs last graded run)
```

- In the live progress output, include a compact trend column (score cells
  only when the run was graded):

```txt
Case                 Status  Score      Duration    Trend
todos/add-todo       PASS    -          3.2s -0.4s  improving
checkout/guest       FAIL    -          9.8s +4.1s  regression
```

Implementation notes:

- Compute trend summaries from manifests and `grade.json` files under the runs
  root.
- Use manifest timestamps for ordering, not directory-name sorting alone.
- Compare only the same case id.
- Compare scores only between graded runs; checking (act) runs are ungraded by
  default, so their movement signal is status, duration, steps, and LCP.
- Prefer recent successful non-infra runs for baseline trend comparisons.
- Keep raw history available via JSON for future dashboards.
- Consider persisting an index later if scanning `runs/` becomes slow.
- There is no stored history structure: the runs root itself is the history,
  scanned on demand per `/history.json` request. `runs/` is gitignored, so
  history is local to each developer's machine and sparklines only show that
  developer's runs. If trends become a core product surface, decide where
  durable shared history lives (CI artifact retention, a shared runs root)
  before building more on top of local scans.

### Actor Context Window And Prompt Caching

The actor currently builds messages like this:

```txt
system: stable actor prompt + persona + story
user: rendered log of all prior steps
user: current page snapshot
```

Past snapshots are dropped entirely; only the current page is sent. The log
is append-only except for `renderLog`'s batch folding: steps older than the
last 15-24 lose their thoughts, folded in batches of 10 so the prefix stays
byte-stable between rewrites.

Proposed simplification: remove the folding, and raise the default
`max_steps` from 30 to 50 at the same time. A journey is bounded by
`max_steps`; even a fully verbose 50-step log is a few thousand tokens (a
step line plus thought is a few dozen), and the per-turn page snapshot dwarfs
the log anyway — the savings never justify periodically rewriting the prefix. Without folding the log is permanently
append-only and byte-stable, the best possible shape for prefix caching, and
`VERBOSE_STEPS`, `FOLD_BATCH`, and the fold logic in `actor.js` are deleted.

Revisit compaction only if journeys ever grow to hundreds of steps. If cache
hit rates still look poor afterwards (check `cache_read`, already returned by
`llm.js`), the remaining lever is provider-side cache breakpoints (e.g.
native Anthropic `cache_control`), not reshaping the log.

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
- A persona picker in `playtest new case` is deferred with the other
  interactive flows (see NICE_TO_HAVE.md).
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

- `playtest new suite` writes external mode by default; `--compose <file>`
  writes managed mode (the interactive chooser is deferred to NICE_TO_HAVE.md).
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
- failed flag
- response mime type

Timing and sizes stay in `har.json`, which lives only in the (gitignored)
run directory. The file where churn matters is different: accepting a run
copies its `trajectory.jsonl` — including these embedded `network.requests` —
to `<case>.baseline.jsonl` next to the case file (the small
`<case>.baseline.json` sidecar holds only bless metadata), and those
baselines are tracked in git and replaced wholesale on every accept or
refresh. Their diff is how a reviewer sees what changed about the
saved path. Fields that differ between two behaviorally identical runs
(`duration_ms: 42` vs `38` on every request) would fill that diff with jitter
and bury the real deviations — a new endpoint, a changed status. Embed only
fields that are identical when behavior is identical.

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
