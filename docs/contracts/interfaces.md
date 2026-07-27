# Interface contracts

This file is authoritative for supported package imports, CLI behavior,
reporting, and the local viewer's HTTP and URL protocols. Engine behavior is
defined in [Engine contracts](engine.md); persisted data is defined in
[Artifact contracts](artifacts.md).

## Supported package imports

Consumers, including hosted packages, import core behavior only through the
package export map:

| Specifier | Facade | Purpose |
|---|---|---|
| `@playtest/core/run` | `packages/core/src/public/run.ts` | Run cases and grade artifacts |
| `@playtest/core/suite` | `packages/core/src/public/suite.ts` | Discover and lint cases; list personas and read built-in text |
| `@playtest/core/artifacts` | `packages/core/src/public/artifacts.ts` | Baselines, bundles, run history, roots, and storage providers |
| `@playtest/core/analysis` | `packages/core/src/public/analysis.ts` | Run movement analysis and deterministic anomaly signals |
| `@playtest/core/findings` | `packages/core/src/public/findings.ts` | Local findings identity, intake, lifecycle, consolidation, and export |
| `@playtest/core/media` | `packages/core/src/public/media.ts` | Clip generation |
| `@playtest/core/llm` | `packages/core/src/public/llm.ts` | Model configuration, calls, coercion, and cost helpers |
| `@playtest/core/reporting` | `packages/core/src/public/reporting.ts` | Status labels, case lines, summaries, and JUnit |
| `@playtest/core/api-suite-scripts` | `packages/core/src/public/api-suite-scripts.ts` | API-suite authoring, execution, and review contracts |
| `@playtest/core/browser/movement` | `packages/core/src/shared/movement.ts` | Browser-safe movement projections |
| `@playtest/core/browser/timing` | `packages/core/src/shared/timing.ts` | Browser-safe trajectory timing |
| `@playtest/run-viewer/node` | `packages/run-viewer/src/node/index.ts` | Local read-only viewer host |
| `@playtest/run-viewer/browser` | `packages/run-viewer/src/web/app.ts` | Viewer browser-build entry |
| `@playtest/run-viewer/assets` | `packages/run-viewer/src/assets.ts` | Completed local-viewer build locator |
| `@playtest/web/assets` | `packages/platform/web/src/assets.ts` | Completed hosted-web build locator |

The facade modules use explicit named exports; only those names are public.
Each package also exports its own `package.json`. `@playtest/core/testing` is a
repository-only test seam, not a production integration surface. Internal file
paths are unsupported.

Notable behavioral seams include `willRecord` for record-pool dispatch and the
reporting exports `healDigest` and `PHASE_DOING`. Model aliases are resolved
inside the LLM facade; the internal `resolveModel` helper is not a supported
specifier export. The LLM facade also exports `modelTiers()` — the shipped
short tier enums — and `defaultModels`, the engine's built-in
`actor_model`/`grader_model` defaults, so a consumer that layers its own
defaults under the file chain (hosted project models) can describe the
built-ins without duplicating them.

Public entry points are ESM and resolve directly to TypeScript source.
Renaming, removing, or changing the arguments or return shape of a facade
export is a public contract change.

## CLI conventions

The bin is `playtest`. The human-facing commands are `new`, `view`, `clip`,
`install-skill`, the `findings` ledger group, and the
`baseline accept|reject|refresh` lifecycle. `run` is the hidden default
command:

```text
playtest [paths...] = playtest run [paths...]
```

Exact subcommand names win over path arguments. To run a colliding path, use
an explicit relative path such as `playtest ./view` or the explicit default
form `playtest run view`.

Agent commands `list`, `lint`, and `personas` are supported but hidden from
top-level help. `run` is hidden because it implements the default command.
`grade <runDir>` is a hidden single-run repair command.

### Exit codes and errors

| Code | Meaning |
|---|---|
| `0` | Pass or completed discovery; lint warnings are also advisory |
| `1` | Gate failure, or changed journey under `--fail-on-changed` |
| `2` | Configuration, user input, or infrastructure failure |
| `130` | User interruption by `SIGINT` |

For multi-case runs, mixed gate and infrastructure failures return 1.
User-facing configuration errors print `playtest: <actionable message>` and do
not expose a raw stack, `MODULE_NOT_FOUND`, credentials, or tokens.

`--base-url` forces external mode and ignores compose. Configuration discovery
and validation happen before driver-specific preflight, so only selected
drivers are checked.

### Run selection and output

```text
playtest [paths...]
  [--tag <tag>...] [--id <id>...]
  [--fresh]
  [--base-url <url>] [--env <name>]
  [--parallel [n]] [--parallel-record <n>]
  [--junit <path>] [--no-grade] [--headed]
  [--runs-root <dir>]
  [--json] [--fail-on-changed]
```

Paths default to `.`. Tags match any selected tag. IDs filter exact resolved
case IDs. `--fresh` records from scratch without replacing the saved path. CLI
concurrency overrides suite defaults. Help shows invocation-level options;
exact-ID selection, concurrency, storage, and changed-journey policy remain
accepted but hidden.

When every selected case has the same environment, human output names its
external base URL or managed compose file on the following line. The run
header is:

```text
run · N case(s) → <runs-root>/<id>
```

In an interactive terminal, if no top-level base URL is usable and named
environments exist, `run` prompts for one unless `--env` selected it.
`--json` suppresses every prompt.

TTY output uses `LiveReporter` unless `--json` applies. Non-TTY output uses
plain reporting. `--json` reserves stdout for its single result object;
warnings and `--fail-on-changed` diagnostics use stderr.

With no discovered suite, `run` exits 2 and suggests `playtest new
<case-name>`. `list` prints the same hint but exits 0. If ID or tag filtering
selected nothing, both commands name the filters instead of suggesting suite
creation. Under JSON modes, the empty machine value remains on stdout and
hints go to stderr.

After a non-JSON run, output provides viewer and CI-artifact commands. A
passing healed run remains pending until accepted or rejected. Interactive
TTY sessions may offer to open review and then accept all. Every non-JSON
session with pending candidates prints resumable `view` and exact
`baseline accept` commands. Shell arguments containing characters outside
`[A-Za-z0-9@%+=:,./_-]` use single-quote escaping.

`playtest baseline refresh <paths...>` forces fresh recording and grading, then
replaces each eligible journey baseline. It requires the normal model and
environment configuration, has no JSON mode, and supports ID/tag selection,
environment and base-URL overrides, both concurrency controls, headed mode,
runs-root selection, and normal TTY/plain reporting. Refresh removes any healed
candidate based on the baseline it replaced.

### Run JSON

A local `playtest run ... --json` writes exactly one object:

```js
{
  run_id,
  runs_root,                       // absolute
  exit_code,
  cases: [{
    id,
    status,
    mode: "record" | "act" | "heal" | "explore",
    healed,
    changed,                       // pending candidate from this run
    run_dir,
    duration_ms,
    steps,
    cost_usd,
    score: number | null,
    duration_delta_ms: number | null,
    score_delta: number | null,
    status_streak: string | null,
    gate_failures: [{ spec, detail, severity }]
  }]
}
```

No progress, summary, or resume text may reach stdout in JSON mode.

### History and movement

Before a run, the CLI scans the runs root once. Comparison uses the standard
[artifact pin rules](artifacts.md#versions-and-comparability), excludes
explored and interrupted runs, and prefers fully comparable
non-infrastructure history.

Duration deltas compare to the prior comparable run. Score deltas reach back
to the last graded comparable run. Streaks appear only after a status change.
Infrastructure, interrupted, and first-ever runs have no trend. Duration is
display context, not by itself a regression/improvement badge signal.

### Baseline review and grading

`baseline accept`, `baseline reject`, and `grade` resolve each case file from
`manifest.case.file`.

`baseline accept <runDir>` and `grade <runDir>` require an exact run directory.
They do not resolve mutable “latest run” aliases or perform batch mutations.

For the named run, `baseline accept` checks, in order:

1. `manifest.json` exists.
2. `trajectory.jsonl` exists.
3. `manifest.result.status` is `pass`.
4. `manifest.case.file` is a string and still exists.

If the named run owns the pending candidate, accept promotes it. If another
run owns the candidate, accept names the superseded run, writes a baseline
from the explicitly named passing run, and removes the old candidate. There is
no `--force`; baseline replacement names that exact run.

`playtest baseline reject <runDir>` requires that run to own the pending
candidate and removes only candidate files. It never deletes run artifacts.

#### Acceptance leak scan

A committed baseline is source code, so acceptance scans the trajectory first
and reports what would be committed:

| Rule | Finding | Scope |
|---|---|---|
| `secret` | a value core injected from a secret reference appears literally | every driver |
| `redaction` | a `redact.request`/`redact.projection` field still holds a literal | every driver |
| `entropy` | a credential-shaped token (long, mixed case with digits, or JWT-shaped) | API request templates and response projections |
| `data` | an email address — application data, not a registered secret | API request templates and response projections |

The `entropy` and `data` rules are deliberately not applied to web and mobile
trajectories, which are full of hashes, locators, and user-visible text.
Ordinary identifiers — UUIDs, ULIDs — do not satisfy the credential rule.

The scan changes the baseline lifecycle in one place, automatic acceptance:

- A clean scan accepts exactly as before, a passing first record included.
- Findings block automatic acceptance. The run leaves a pending candidate, its
  metadata records the findings, `manifest.baseline_scan.blocked` is `true`, and
  the run warns with each finding and the command that would approve it.
- `playtest baseline accept <runDir>` is the approval. It never blocks: it
  prints each finding, promotes or writes the baseline, and records
  `scan_approved` with the SHA-256 of exactly the bytes approved. A later
  trajectory that hashes differently is not covered and is gated again.

A pending candidate from a blocked scan is listed, reviewed, rejected, and
accepted exactly like a healed one, and counts for `--fail-on-changed`.

`playtest grade <runDir>` requires a configured model, rewrites `grade.json`,
and updates `manifest.artifacts.grade`.

### Playwright export

```text
playtest export [paths...]
  [--out <dir>] [--tag <tag>] [--base-url <url>] [--env <name>]
```

Renders each selected **web** case's accepted baseline as a standalone
`@playwright/test` spec at `<out>/<case-id>.spec.ts` (default `--out
playwright-export`). Paths resolve exactly as `list` resolves them.

The export is **one way**. Playtest writes the file and never reads it back:
it is not an execution mode, it is not an input to any run, and it does not
heal. Re-running `export` after the baseline changes overwrites the file at a
stable path; the emitted header states all of this.

Skips are printed and never fail the command:

| Case | Message |
|---|---|
| No accepted baseline | `no saved path yet — run the case first` |
| Non-web driver | `export supports web cases; this one uses driver "<driver>"` |
| `mode: discovery` | `discovery studies explore rather than replay a saved path` |

A pending healed candidate does **not** block the export — the accepted
baseline is still the truth — but it is reported as a note.

The emitted file is TypeScript with no `playtest` imports: an
`@playwright/test` import, a `BASE_URL` const defaulting to the case's
`app.base_url` and overridable via `PLAYTEST_BASE_URL`, and a header carrying
the case id, story, baseline run id, `story_hash`, and pins. `app.cookies`
become a `context.addCookies` call before the first navigation. Request and
console-error collectors are emitted only when the gate needs them, so the file
holds no unused bindings.

Each recorded step emits a comment (step number, verb, and the actor's thought)
followed by the action. Locators are the **raw saved strings** passed to
`page.locator()`, byte-identical to what act mode replays. Steps excluded from
the action track — terminal `done`/`give_up`, and any step that did not execute
— do not appear. Verbs translate as:

| Envelope action | Emitted |
|---|---|
| `click` | `.click()` |
| `type` | `.fill(text)`, plus `.press("Enter")` when `submit` |
| `select` | `.selectOption({ label })` with a `.catch()` fallback to the raw value, mirroring the driver |
| `scroll` with a locator | `.evaluate((el, d) => el.scrollBy(0, d), ±600)` |
| `scroll` with none | `page.mouse.wheel(0, ±600)`, flagged `APPROXIMATE` (the driver first picks a dialog/largest-scrollable target) |
| `navigate` | `page.goto(new URL(url, BASE_URL).href)` |
| `back` | `page.goBack()` |
| `wait` | `page.waitForTimeout(ms)`, clamped to the driver's 0.1s–10s window |

A verb with no translation becomes a `NOT EXPORTED` comment carrying the raw
action, never a silent omission. Success criteria translate as:

| Criterion | Emitted |
|---|---|
| `url_matches` | `expect.poll` over the same glob→regex rules, matching full URL or pathname |
| `element_exists` | `expect(locator).not.toHaveCount(0)` (the gate's `count() > 0`, not visibility) |
| `api_called` | `expect.poll` over a `page.on("request")` collector, method + pathname glob |
| `console_errors` | `expect(count).toBeLessThanOrEqual(n)` — soft in Playtest, hard here |
| `assert` | a `playtest-assert` test annotation plus an `UNCHECKED` comment |
| `accessibility_violations`, `perf.*`, custom assertion keys | a comment naming what was not exported |

Every declared criterion reaches the file as an assertion or a visible comment.
There are no silent drops: a thinner gate than the case declares would make the
export a trust liability rather than a trust feature.

Hosted exposes the same generator over HTTP:

```text
GET /api/v1/suites/:s/playwright-export?story=<story_id>
```

It returns the spec as a `text/plain` attachment for the story's live
(non-superseded) baseline, with generator notes base64-encoded in
`x-playtest-export-notes`. It requires the `viewer` role and refuses an unknown
story (404), a non-web story (400), and a story with no accepted baseline (404).
The web UI surfaces it as an **Export Playwright** button on the story page,
which is itself behind the `editor` role — so a viewer can reach the endpoint
but not the button.

### Viewing

```text
playtest view [run-or-root]
  [--latest] [--changed|--failed]
  [--case <id>]
  [--json]
  [--port <n>] [--no-open]
```

Only `--latest`, `--changed`, `--failed`, and `--case` appear in normal help.
The remaining server and machine-listing options are supported advanced
controls.

Runs-root resolution precedence is:

1. Explicit positional path, validated without walking.
2. `./runs`.
3. The nearest ancestor containing `runs/`, bounded by the Git root or ten
   levels.
4. Exit 2 with example commands.

`--latest` selects by manifest `started_at`, not directory name, and may be
narrowed by case. `--changed` and `--failed` are mutually exclusive and reject
`--latest`. Filters become viewer query parameters.

`view --json` does not start a server. It prints the same entries as
`/runs.json` or `/changed.json`; `--failed` retains fail and infra, while
`--case` and `--latest` further filter the array. Port and browser-opening
flags are ignored.

### Listing, linting, and scaffolding

```text
playtest list [paths...] [--tag <tag>...] [--id <id>...] [--json]
playtest lint [paths...] [--tag <tag>...] [--id <id>...] [--json]
playtest personas
playtest new <name> [dir] [--driver web|mobile|api] [--force]
playtest new persona <name> [--force]
```

`list`, `lint`, and `personas` are agent-oriented commands hidden from
top-level help. Their behavior and machine contracts remain supported.

`list` reports `explore` for discovery, `check` when a journey baseline exists,
and `record` otherwise. JSON is:

```js
[{ id, tags, persona, next_run }]
```

`lint` reuses full discovery and schema validation. Configuration errors exit
2. Quality findings—empty or duplicate assertions, missing journey gates, and
claims better expressed as deterministic checks—are advisory and exit 0. JSON
is:

```js
[{ id, file, level, message }]
```

`new` defaults to case creation. Exact `persona` and reserved `suite`
subcommands win; a case with either name requires `new case <name>`. The slug
uses lowercase `[a-z0-9._-]`, converts other runs to `-`, trims outer `-`, and
rejects separators, an empty result, and `playtest`.

Case destination precedence is explicit directory, nearest ancestor suite,
the sole suite below cwd, then `./test-stories/`. Without an ancestor
`playtest.yaml`, it also creates defaults. Driver selection creates a matching
case and defaults shape. Existing files require `--force`. Output paths are
cwd-relative.

### Local findings ledger

```text
playtest findings list [--candidates] [--state <state>] [--status <status>] [--json]
playtest findings show <id> [--json]
playtest findings consolidate [--runs-root <dir>] [--plan <file>]
                              [--apply-plan <file>] [--only <id>...]
                              [--no-cluster-model] [--json]
playtest findings accept <id> [--title <title>] [--note <note>] [--json]
playtest findings reject <id> [--reason <reason>] [--note <note>] [--json]
playtest findings resolve <id> [--note <note>] [--json]
playtest findings export [--out <file>] [--json]
```

Every subcommand accepts a hidden `--suite <dir>`. Without it, the suite is the
nearest ancestor of the working directory holding a `playtest.yaml`; with no
such ancestor the command exits 2 and names `--suite`. `list` is the default
subcommand.

The ledger is one SQLite database per suite at
`<suite>/.playtest/findings.db`, created on first `consolidate` together with a
`.playtest/.gitignore` that ignores the directory. The location is deliberately
outside `runs/`: a runs root is disposable evidence, the ledger is durable
identity. The ledger file is local state and is never portable; the portable
form is `findings export` (artifacts.md). It stores opaque ids,
algorithm-versioned keys, candidates, evidence *references*, lifecycle
transitions, and merge tombstones — never artifact bytes, `.ptrun` payloads, or
copies of `grade.json`. No findings command reads, writes, moves, or deletes any
run artifact, and no ledger failure may.

`consolidate` has two layers:

- Intake is deterministic and self-applying. It reads `bug_candidates` from
  `grade.json` under the runs root, derives each candidate's deterministic
  signal type and locus from that run's recorded envelopes, and applies the
  shared exact-key rules (engine.md): a strict hit appends evidence to the
  existing record, a loose hit becomes a pre-attached suggestion, a rejected
  candidate's exact recurrence is absorbed and counted. Re-scanning a run
  already taken in changes nothing.
- Grouping is a proposal. Score routing and, when a model is configured, one
  forced-tool call per ambiguous cluster produce a plan file (default
  `<suite>/.playtest/consolidation-plan.json`). Writing a plan mutates nothing.
  With no model configured, or with `--no-cluster-model`, clusters are reported
  unresolved and no call is made. A plan applies only after an explicit human
  confirmation: an interactive answer in a TTY session, or a later
  `--apply-plan <file>`. Applying re-validates every id against the live ledger
  and refuses a stale plan, a plan from another workspace, or an unknown id
  without partial mutation.

`accept <id>` promotes an unassigned candidate into an accepted finding carrying
all of its evidence, or accepts an existing finding. `reject <id>` dismisses a
candidate and records its keys as suppressions, or rejects a finding, which then
absorbs matching evidence silently. `resolve <id>` applies to findings; an exact
recurrence reopens a resolved finding with no review. Merged findings leave a
tombstone: triaging a merged id names its live target instead of splitting
state.

`--json` reserves stdout for one machine-readable value:

```js
// list                       findings, or bug candidates with --candidates
[{ id, state, severity, title, evidence_count, ... }]
// show                       kind: "finding" | "candidate", plus evidence[] and transitions[]
{ kind, id, evidence: [{ run_id, run_dir, case_id, step_from, step_to }], ... }
// consolidate                intake counts, plan location, and what was applied
{ runs_root, ledger, intake: { scanned, actions }, plan_file, model,
  proposals, unresolved, applied, stats }
// accept | reject | resolve  the resulting record
{ kind, finding?, candidate?, from_state?, evidence_added?, suppressed? }
// export --out <file>
{ written, findings, candidates }
```

`findings export` with no `--out` writes the export document itself to stdout.

Exit codes follow the CLI contract: 0 on success, 2 for configuration and user
input — an unreadable or newer-schema ledger, a missing ledger for a reading
command, an unknown id, a bad `--reason`, a missing runs root, a stale or
foreign plan, or a runtime without `node:sqlite`. The package requires Node
24.18.0 or newer; the explicit ledger check still produces an actionable
message if the command is invoked outside that supported install constraint.
Findings commands never exit 1: they carry no gate authority.

### Skill installation

`playtest install-skill [--force]` discovers every packaged directory under
`skills/` and copies it to the current project's `.agents/skills/`, with the
corresponding `.claude/skills/` links used by supported clients. The project is
the nearest Git ancestor or cwd.

Identical content is a quiet no-op. Any differing destination aborts before
remaining skills unless `--force` is present. The command discovers skills
rather than maintaining a hardcoded name list.

### Clips

```text
playtest clip <target>
  [--captions action|thought]
  [--burn]
  [--out <directory>]
```

The target is an exact run directory or a case ID resolved to its latest run.
Default output is `video.mp4` plus `video.vtt` in that run. `--burn` writes
self-contained `clip.mp4` and
`clip.vtt`, including an intro, status watermark, case ID, and step counter.

The shared slideshow timeline gives one flat beat to each screenshotted step;
screenshot-less steps fold into the previous frame. Caption cues span their
frame. `PLAYTEST_FFMPEG` overrides the binary and is trusted verbatim. Without
the override, a PATH `ffmpeg` that is missing or too slim for burn-in falls
back to the conventional Homebrew `ffmpeg-full` keg locations
(`/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`, `/usr/local/opt/...`) before
failing. No usable binary anywhere, or missing burn-in filters everywhere, is
exit 2 with an install fix.

Legacy runs with non-null `video_started_at` clip from `video.webm` using
envelope wall-clock offsets. `--out` is always a directory and produces
case-ID-based filenames.

## Reporting API

Reporters implement:

```js
{
  onEvent(event),
  done(results)
}
```

Every call is guarded. `runAll` never prints directly.

Finished mode labels are `recorded`, `checked`, `tried to heal`, `changed`, and
`explored`. In-progress labels are `recording`, `checking`, `healing`, and
`exploring`. Explored result lines describe the terminal reason instead of
repeating the status.

`caseLine()` contains status, case ID, mode, steps, duration, score, cost,
movement, and indented failure details. `summary()` counts pass, fail, infra,
explored, and interrupted separately. `junitXml()` emits one testsuite per case
directory; explored cases are successful testcases and interrupted cases are
errors.

`LiveReporter` maintains one updating line per active case and prints completed
case lines in completion order. Healing, gate failures, and warnings become
permanent scrollback. `done()` clears the live region and prints the standard
summary.

## Viewer server

```js
serveRun(dir, { port = 0, open = true, query = "" })
```

The server binds `127.0.0.1`; `PLAYTEST_VIEW_HOST=0.0.0.0` opts into other
interfaces. Startup prints `Playtest viewer: <url>` and appends the supplied
query to the printed and opened URL.

All run data uses the
[StorageProvider contract](artifacts.md#storage-providers-and-run-bundles).
Local directories use `LocalFsProvider`; `.ptrun` files use `BundleProvider`.

Only GET and HEAD are allowed; other methods return 405. The server is
read-only and never creates a runs root or changes a baseline. A missing root
is a valid empty picker. An existing non-bundle file is an error. Every path is
contained under its owning static or run root; traversal is rejected.

### Routes

- `/` and viewer static assets come from the completed
  `packages/run-viewer/build/` asset directory.
- `/run/*` serves artifact files in single-run mode.
- `/run/<run_id>/<case_id>/*` serves artifacts in runs-root mode.
- `/runs.json` lists runs.
- `/changed.json` lists passing runs awaiting an explicit accept: healed
  journeys and recordings the acceptance leak scan held back.
- `/history.json?case=<case_id>` lists case history.

In single-run mode, `/runs.json` is not a picker and returns 404. For a local
run directory, `/changed.json` resolves the surrounding runs root and returns
its review list; a bundle remains scoped to its provider.

`/runs.json`, newest first:

```js
[{
  run_id,
  case_id,
  path,
  status,
  mode,
  healed,
  started_at,
  duration_ms,
  story: string | null,
  description: string | null,
  tags
}]
```

`/changed.json`, newest first:

```js
[{
  case_id,
  run_id,
  started_at,
  score: number | null,
  path,
  run_dir_rel,
  pending
}]
```

`pending` requires candidate metadata to resolve to that run directory.
`run_id` equality is only the legacy fallback.

`/history.json`, oldest first:

```js
[{
  run_id,
  started_at,
  status,
  mode,
  healed,
  duration_ms,
  steps,
  score: number | null,
  lcp_ms: number | null,
  cost_usd,
  pins: object | null,
  path
}]
```

`path` is navigable only in runs-root mode. Unknown cases return an empty
array. Run discovery uses one bounded manifest walk, shared with runs-root
history.

Range requests are supported when the provider supports them. MIME handling
must include JSON, JSONL, PNG, MP4, WebM, MHTML, ZIP, and text; unknown
extensions use `application/octet-stream`.

## Viewer URL contract

Every data URL resolves relative to the viewer's own served base path so a
host may mount it under a project prefix.

| Query | Behavior |
|---|---|
| `run=<path>` | Open a run from a runs root |
| `step=<n>` | Open the 1-based envelope step once, then resume normal navigation |
| `view=diff` | Open diff when a baseline exists |
| `embed=1` | Hide viewer-owned top chrome, and suppress CLI accept/reject instructions — the host owns those decisions |
| `theme=light|dark` | Force palette; otherwise use the viewer default/OS preference |
| `filter=failed` | Interactive picker shows fail, infra, and interrupted |
| `filter=changed` | Show the changed-journey review list |
| `case=<id>` | Filter picker by case ID |

Unknown values degrade to the normal picker or run view.

## Viewer behavior and degradation

The viewer must render useful output from `manifest.json` and
`trajectory.jsonl` alone. Missing optional artifacts suppress their panel
rather than failing the run:

- No grade hides grading.
- No tokens hides token and cost detail.
- No HAR falls back to embedded stable network requests.
- No video shows the explicit no-video state.
- API and mobile omit unsupported screenshot or performance surfaces.

When present, the viewer supports step stills and referenced text, action and
expectation captions, actor visual observations and raises, confusion markers,
network and performance detail, gate and grade results, discovery report
answers linked to evidence steps, and action-track diffs. The Diff view
follows the film strip: the selected step's track row is highlighted, track
cells select their step in place, and a per-step panel diffs the selected
step's page snapshot against its aligned baseline step (LCS pairing on the
action track; `acted_from` for replayed and failed-replay steps), collapsing
long unchanged runs.

A pending healed pass displays exact accept and reject commands. A resolved or
superseded run displays no mutation command. The viewer itself remains
read-only.

History movement uses the standard comparable-pin rules. It displays duration,
step, LCP, and score deltas when both sides provide them. Regression/improvement
badges use status transitions and score changes of at least five points;
duration is not a badge signal. Infra, explored, and interrupted current runs
have no movement.

New slideshow video uses the shared frame timeline. Legacy video with a
non-null `video_started_at` seeks by envelope timestamp minus that origin.
When `video.vtt` is present it is attached as default-on captions.
