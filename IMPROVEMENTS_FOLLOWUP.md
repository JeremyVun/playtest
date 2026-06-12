# Playtest Follow-Up Improvements

## Execution Order

Ranked for picking items up one at a time, dependencies included. §N refers
to the sections below (section numbers are stable; this list is the order).
The order is shaped by one strategic constraint: the real demo is a **guild
presentation in a corporate engineering space**. That talk is the deadline
that forces both the wow (the story must land on an app the audience
recognizes) and distribution-readiness (the talk converts only if the
follow-up is one command that survives thirty engineers trying it that
afternoon). Milestone A is everything the talk needs; B is the post-talk
follow-through; C and D deepen the product.

### Milestone A — the guild talk (talk assets + conversion path)

0. **One creation command + `app:` block (§13)** — the surface-naming
   pass: `playtest new <name>` with lazy `playtest.yaml` scaffolding
   replaces `new suite`/`new case`, and the `env:` block becomes `app:`.
   Goes first because it renames exactly what the rest of the milestone
   freezes and publishes: 1's self-test pins the CLI/JSON contract, 2's
   demo and 8's skill print the commands, 7's README documents them.
   Cheapest now; public after the talk.
1. **Harness self-test (§1)** — first, with a sharper reason: it is the
   insurance that nothing breaks the night before the talk, it freezes the
   contracts later items parse (exit codes, `--json`), and its
   app-mutation hook (UI-variant env flag in the todo app) **is** the heal
   act's trigger. The `start({ port })` fixture refactor is shared with
   the demo command.
2. **`playtest demo`, three acts (§4)** — record (watch the AI improvise)
   → act (0 model calls, seconds) → **heal** (flip the UI variant, an
   acted step fails, the agent recovers, the heal diff opens for review).
   Act three is the product's core claim made visible. In the talk, this
   command's role is the **closing-slide call to action**
   (`npx … demo`) and the rehearsal rig; the live segments themselves
   should lead with item 5. Use a real model when a key is present —
   genuine thoughts are the magic; the mock stays for the zero-key path.
3. **Demo-path viewer polish (scoped)** — the narrative runs through the
   viewer: replay with thought captions, then the heal-diff view with
   divergence screenshots. Audit exactly that path on the runs the talk
   will show and fix only what the story touches. No general viewer work.
4. **Journey clip renderer (§11, pulled forward) + recorded backups** —
   clips are double-duty here: deck assets that travel after the talk, and
   the safety net for every live segment (corporate networks, VPNs, and
   gateways fail mid-presentation; never present without the recording).
   Verify the per-step-timestamped screencast is actually implemented
   first; timebox — a hand-recorded screen capture is the acceptable
   fallback for the first deck. In particular, these journey clips will add direct value as part of PR review bots
5. **Browser preflight (§3)** — the call to action triggers dozens of
   simultaneous first-runs; none of them may hit a raw Playwright stack
   trace.
6. **Pre-1.0 cruft removal + README (§2)** — engineers browse the repo
   *during* the talk; a README documenting dead commands kills credibility
   faster than any bug.

Slide-ready answers to prepare (no code, but mandatory for this audience):
cost (cents per heal, zero in the steady state), safety (hermetic envs —
the agent *will* click buy; staging with test rails, never prod), gateway
fit (`PLAYTEST_LLM_BASE_URL` points at the org's LiteLLM/Portkey proxy —
no new vendor relationship needed), the four-verdict triage table, and the
exit-code/CI contract. A mock PR-bot comment generated from a local run
(§6's format) makes the CI story a slide before the action exists.

Optional act five, for an engineering-guild audience specifically: the
agent skill (§7) live — a coding agent breaks a journey, reads the
failure, fixes it, reruns green. Highest-wow, highest-risk segment; only
attempt it with the clip backup ready.

### Milestone B — post-talk follow-through (convert the interest)

8. **Agent skill (§7)** — if not built as act five. Highest leverage per
   unit cost in the list; needs the final CLI names (0, 7) and the
   contract frozen by 1.
9. **PR journey-diff bot v1 (§6)** — the first team that says "we want
   this on our PRs" after the talk is the pilot; this is what they adopt.
   Scope guard: v1 deltas compare against the baseline only (step count,
   baseline duration) — no run history exists in ephemeral CI until 16;
   clip embeds (4) slot in whenever both exist.

### Milestone C — the regression product (retention value)

Trend features cannot wow a fresh audience — a sparkline needs weeks of
history to say anything. They are why users *stay*, not why they *look*.

10. **Shared comparability module** (the CLI trend lines themselves have
    landed) — extract cli.js's `computeTrend` into the shared module §5
    specs and add the vs-recent-median comparison; the entry ticket
    for 11. Decide the **comparability key** (full pin set + headed flag)
    here — 16's schema inherits it unchanged.
11. **Viewer deltas + badges (§5)** — presentation over 10's module.
12. **`playtest check` (§8)** — completes the agent loop (probe → fix →
    promote); reuses `new`'s scaffolding for `--save`. Below 10/11 because
    the skill already closes the loop for existing case files.

### Milestone D — new surfaces

13. **A11y, signals layer first (§10)** — surface already-captured signals
    in grade.json and the viewer; axe-core injection second.
14. **Static docs renderer (§11)** — the other half of §11; act-then-render
    walkthrough pages.
15. **Research mode (§9)** — biggest new-code bet (vision plumbing, explore
    command, findings report) for a new audience; the vision work doubles
    as the canvas-fallback for regression runs.
16. **History backend (§12)** — last as a build, not as a decision: v0
    (workflow-artifact upload) lands free with 9; the schema's
    comparability key is decided at 10. Build the API/DB only when
    cross-run trends in CI or team dashboards are concretely demanded.

IMPROVEMENTS.md leftovers: the actor log-folding removal and portable
network data have both landed — envelopes embed compact `network.requests`
(stable fields only, no timings or sizes, so committed-baseline diffs stay
jitter-free; `har.json` remains the deep-debug fallback for old runs). The
compose-based example suite is superseded by the demo as the first-run
path; do it only if managed mode needs a living exercise (the change:
point tests/playtest.yaml at docker-compose.test.yml via the app block).

Swappable by appetite: 8↔9 (solo loop vs team visibility), 10+11↔12
(regression trends vs agent-loop completion). Milestone A's chain
0→1→2→3→4 is fixed (0 settles the names 1 freezes, 1 builds the hook 2
needs, 2 produces the runs 3 polishes, 3 makes the footage 4 cuts); 5–7
are parallel-friendly and only need to land before the talk date.

## 1. Harness Self-Test

The harness has no tests of its own (no `npm test`, no `*.test.js`). All the
pieces for an offline end-to-end exist: the bundled todo app, the mock LLM
(`src/harness/testing/mock-llm.js`), and the example suite.

Add `npm test` that, with no network and no keys:

- Boots todo-app and mock-llm on ephemeral ports.
- Runs the example suite once → asserts every case records and blesses a
  baseline (exit 0).
- Runs it again → asserts every case acts with zero model calls (assert no
  requests hit the mock during the second pass).
- Mutates the app (e.g. rename a button label via a test hook or env flag)
  and runs again → asserts a heal happens, the run is marked changed, and
  `accept` then `reject` behave per contract.
- Asserts the exit-code contract: 0 pass, 1 gate failure, 2 infra (point a
  case at a dead URL for the 2).
- Asserts `--json` output shape on each pass.

Keep it dependency-light: node's built-in `node:test` runner is enough.

## 2. Pre-1.0 Cruft Removal

This is a 0.1.0 package with no external users; compatibility shims are pure
cost until 1.0. Remove now:

- The `bless` alias for `accept` and the hidden `rebaseline` command for
  `refresh` (keep the hidden `run` alias — one routing line, genuinely used).
- `DUMMY_LLM_*` env fallbacks in `llm.js` (keep `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` fallbacks — those are provider conventions, not legacy).
- The `dummy.yaml` read path in config discovery, if present.
- The `playtest list personas` magic-path special case in `cli.js`; keep the
  `playtest personas` command as the one way.

Also fix documentation drift in the same pass: README still documents
`dummy run`, the removed `diff` command, `DUMMY_LLM_*` vars, and links
`docs/dummy-design.md` (the file is `docs/playtest-design.md`).

## 3. Browser Preflight

The classic first-run death for Playwright-based tools is the raw "browser
not installed" stack trace. Never show it.

Before any command that launches a browser:

- Resolve the chromium executable (`chromium.executablePath()` /
  `existsSync`). If present, proceed — zero overhead on the happy path.
- If missing and stdout is a TTY:

```txt
Playtest needs a browser (one-time download, ~120 MB).
Install Chromium now? [Y/n]
```

  On yes, spawn `npx playwright install chromium` with output streamed; on
  no or non-TTY, exit 2 with the exact command to run.

System-Chrome note: Playwright's `channel: "chrome"` can use an existing
Chrome install and skip the download entirely. But the design pins the
browser as part of the instrument — system Chrome versions vary per machine
and would contaminate perf trends. Policy: pinned chromium for real runs;
`channel: "chrome"` is acceptable as an automatic fallback **only for
`playtest demo`** (and possibly `--headed`), where nothing durable is being
measured.

## 4. `playtest demo`

One command, zero keys, zero docker, zero second terminal:

```txt
npx @jeremyvun/playtest demo
```

What it does:

1. Browser preflight (above); system Chrome accepted here.
2. Copies the bundled demo suite **without baselines** into a temp directory
   (never write into the installed package; baselines omitted so the user
   watches the record→act story unfold).
3. Starts the bundled todo app and mock-llm on ephemeral ports, in-process
   or forked with `PORT=0`.
4. Points the run at them (base_url override + LLM base-url override).
5. Act one — records: the live region shows the agent improvising.
6. Act two — acts: print the punchline explicitly:

```txt
Second run followed the saved paths: 0 model calls, 3 cases in 4.1s.
```

7. Act three — heals: flip the todo app's UI variant (the same env-flag
   mutation hook §1's self-test uses), rerun; an acted step fails, the
   agent recovers, and the run lands as a changed journey. The finale is
   the end-of-run prompt opening the heal diff in the viewer: *the UI
   changed, the journey survived, here is the review*.
8. Cleans up on exit; `--keep` retains the directory, `--headed` shows the
   browser live.

Model selection: if a real API key is configured, the demo uses the real
model — genuine thoughts narrating the page are the magic in front of an
audience, and a three-case demo costs cents. The mock keeps the zero-key
`npx` path working; its canned thoughts are fine for "does it run", flat
for "wow".

Implementation notes:

- `src/todo-app/server.js` and `mock-llm.js` currently call `listen` at
  module top level. Refactor each to export `start({ port = 0 })` returning
  `{ url, close }`, keeping CLI behavior behind a main-module check. This
  also serves the self-test (§1) — demo and `npm test` share the fixture
  harness.
- Add an explicit `files` allowlist to package.json so the published
  package deliberately includes `src/todo-app`, the demo suite, and the
  viewer (today everything ships by accident of no allowlist).
- The demo suite can be the existing `tests/` fixture or a copy under
  `src/demo/`; prefer relocating so published-package contents don't depend
  on the repo's working test tree.
- README's first lines become: the npx demo command, then "point it at your
  own app" with `playtest new <case-name>` (§13).

## 5. Viewer Movement Indicators (Deltas + Badges)

The CLI trend lines exist (`computeTrend` in cli.js encodes the comparison
rules: order by manifest timestamps, compare only the same case id, scores
only graded-to-graded, prefer non-infra runs, exclude same-run-id
siblings). Extract that logic into a **shared module** (input: runs root +
case id; output: deltas vs previous comparable run and vs recent median),
then surface it in the viewer:

- Per-case deltas: score (graded runs only), duration, LCP, step count —
  each vs previous comparable run and vs recent median (median resists
  one-off flakes).
- Status movement called out explicitly: pass → fail, pass → healed,
  fail → pass.
- A "regression" / "improved" badge when a delta crosses thresholds
  (suggested defaults: score ±5, duration/LCP ±20% vs median, any status
  movement). Thresholds in one config spot, not scattered.
- Sparkline becomes navigation: hover a point for that run's numbers, click
  to open the run.
- Comparisons respect the pin rule: never compare across baseline
  boundaries (different harness/model/prompt pins), and never mix headed
  and headless timings.
- History stays scan-on-demand over the runs root (`/history.json` already
  serves it raw for future dashboards); persist an index only if scanning
  gets slow. Durable shared history is §12's problem.

## 6. PR Journey-Diff Bot

The problem it solves: attaching screenshots and screen recordings to PRs by
hand to prove "the journey still works." A trusted regression badge backed by
a visual playthrough replaces all of that.

Shape: a GitHub Action (`playtest-action`) that:

1. Runs the smoke tag against the PR's preview deployment
   (`--base-url $PREVIEW_URL --ci --json`).
2. Uploads the run directory as a workflow artifact (the viewer already
   works from an artifact download).
3. Posts/updates one sticky PR comment:

```md
### Playtest — user journeys on this PR

| Journey | Result | Steps | Duration |
|---|---|---|---|
| todos/add-todo | ✅ pass (checked) | 4 | 3.2s (−0.2s) |
| checkout/guest | 🔶 changed — healed at step 6 | 9 (+2) | 8.7s (+1.4s) |

**checkout/guest changed:** the journey survived a UI change.
[screenshot at divergence: before → after] · [download run artifact]
Review locally: `playtest view --changed` · accept: `playtest accept <runDir>`
```

Implementation notes:

- Everything load-bearing exists: `--json`, exit codes, heal detection,
  `--fail-on-changed` as the gating knob, per-step screenshots for the
  before/after pair at the divergence step.
- Divergence screenshots: baseline step N screenshot vs healed run step N —
  both already on disk; the bot just picks the first diverging step from the
  action-track diff.
- Comment is regenerated, not appended (sticky comment keyed by a marker).
- Once journey clips exist (§11), the comment embeds the subtitled clip for
  changed and failed journeys — the self-contained burned-in variant.
- v1 needs only: a composite action wrapping the CLI + a small comment
  script. No backend. The durable-history backend (§12) later upgrades the
  table with cross-run trends.

## 7. Agent Skill: Close The Fix Loop

Playtest finds issues; a builder agent needs the playbook to fetch and fix
them. Deliver that playbook as an **agent skill**, not an MCP server: skills
are portable across harnesses, token-efficient (name + description until
triggered), and need no server process. The MCP advantage — exposing
screenshots as resources — evaporates locally, since coding agents read
image files off disk natively. The expensive part of closing the loop is
workflow knowledge, and a skill is exactly that.

Packaging:

- Ship `skills/playtest/SKILL.md` inside the npm package.
- `playtest install-skill` copies it into the project's `.claude/skills/`,
  so the skill versions in lockstep with the installed harness and its
  `--json` contract.

Skill body outline:

- **Triggers:** the user changed UI code; asks "did I break any journeys?";
  a journey is red in CI.
- **Loop:** run `playtest <paths> --json`; for each failure read
  `manifest.json`, the trajectory tail, and the failing step's screenshot +
  a11y snapshot; classify with the four-verdict table from
  docs/playtest-design.md (app bug / app changed / agent flake /
  environment flake).
- **Per verdict:** app bug → fix the code, rerun that single case file.
  App changed → summarize the heal diff and print
  `playtest accept <runDir>` for the human. Agent flake → rerun once; if
  persistent, suggest story tuning. Env flake (exit 2) → report it, don't
  touch code.
- **Hard rule encoded in the skill:** never run `accept` or `reject`
  autonomously. Acceptance rewrites a versioned baseline and stays a human
  action.

Later: extend the skill with the explore/a11y findings fix loops (§9, §10).

## 8. `playtest check`: Ephemeral Cases

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
  case file — the promotion path from exploration to regression.

Design rule this feature must not erode — **the YAML is spec, not config**:
the story and success criteria are the fixed point that makes a closed
agent loop trustworthy. If the agent fixing the code can also weaken the
assertions, the loop has a degenerate solution ("fix" the failure by
gutting the spec). Ephemeral checks are for probing; durable regression
requires a case file in git, reviewed by humans. `check` never writes
baselines and `--save` never overwrites an existing case without `--force`.

## 9. Synthetic User Research Mode (Personas + Vision)

Personas were designed for this: the tester/exploratory delta — "the feature
works but users won't find it" — is a UX research finding, and the audience
is designers, PMs, and product owners, not CI.

New run intent, separate from regression:

```txt
playtest explore tests/checkout --persona curious-newcomer
playtest explore tests/checkout --personas tester,curious-newcomer --compare
```

- Always fresh agentic runs; never touches baselines; never gates CI.
- Output is a findings report, not pass/fail: per-journey narrative,
  hesitation and confusion moments with the step screenshot, expectation-vs-
  outcome mismatches, verbatim agent thoughts as user quotes ("I expected an
  undo here"), completion and step-count stats per persona.
- `--compare` runs multiple personas over the same journeys and reports the
  delta: completed-by, steps taken, where each diverged or gave up.

Vision support (the enabler):

- Today the actor navigates by a11y tree; screenshots are only a fallback.
  But exploratory personas are defined by *visual* behavior — prominence,
  skimming — which an a11y tree cannot convey.
- Add `vision: true` (persona- or case-level): the current screenshot is
  sent alongside the a11y snapshot. Anthropic models (including Haiku)
  accept images through the same chat-completions path; no new plumbing
  beyond image content blocks in `llm.js`.
- Policy: the regression instrument (tester persona, record/act/heal) stays
  a11y-only — deterministic, cheap, cacheable. Vision is default-on for
  `explore` runs and off elsewhere. Image tokens dominate cost; an explore
  run is a deliberate, occasional spend.
- Side benefit: vision mode is also the answer for canvas-heavy or
  semantically empty pages in regression runs (already noted as a fallback
  in the design doc) — the same content-block work serves both.

Report packaging: `runs/<run>/findings.md` + a findings panel in the viewer;
the grader prompt gets a findings-synthesis variant for explore runs.
Research-style journey clips (§11) — captioned with thoughts rather than
actions — embed in the findings report.

## 10. Accessibility As A First-Class Output

The agent navigates by accessibility tree, so every run is implicitly an
a11y probe — and journey-level a11y evidence ("a screen-reader-class user
cannot complete checkout") carries legal weight under EAA/WCAG that
element-level lint output does not.

Two layers:

- **Signals already captured, just not reported:** ref-resolution failures,
  semantically sparse snapshots, unlabeled elements the agent guessed at,
  screenshot-fallback steps. Surface these as an `a11y` section in
  `grade.json` and the viewer, attributed to steps.
- **Add axe-core injection per step** (industry-standard, runs in-page,
  cheap): collect violations per step into the envelope's artifacts.
  Weight by relevance: a violation on an element the journey actually used
  is "blocking-path"; elsewhere on the page is "incidental". This
  distinction is what makes the report actionable rather than a wall of
  noise.

Gate integration stays opt-in and deterministic:

```yaml
perf:
  console_errors: 0
a11y:
  blocking_violations: 0   # axe criticals on elements the journey used
```

Report: per-journey a11y evidence page (journey, persona, violations on
path, screenshots) — exportable for compliance review.

## 11. Living Documentation And Journey Clips

Every green baseline is a current, verified walkthrough of a user journey.
One lightweight act-run produces the raw material; **two renderers** consume
it, serving different audiences:

### `playtest docs` — static walkthrough pages

For people *learning* a flow: skimmable, searchable, jump-to-step-4,
copy-paste-the-field-value. Video can't do any of that, so docs proper are
pages, not clips.

```txt
playtest docs tests/ --out docs/journeys/ [--format md|html]
```

Mechanism — **act, then render** (the key design choice):

1. For each case with a baseline, act it against the app (zero LLM calls,
   seconds), capturing fresh screenshots.
2. Render the walkthrough from that just-verified run.

Consequences: screenshots always match the current UI (run artifacts are
gitignored, so rendering from old runs would be stale or impossible); and if
the journey is broken, the docs build fails — documentation that *refuses to
lie* is the feature.

Rendering:

- Captions are user-facing instructions derived from the action + resolved
  locator name — `Click "Checkout"`, `Type "buy milk" into "What needs to be
  done?"` — not raw agent thoughts (internal monologue reads wrong in docs).
  Optional `--polish` runs one cheap LLM pass to smooth phrasing.
- Page per case: title + story as intro, numbered steps with screenshot and
  caption, final state with the success criteria rendered as "what you
  should see." Index page grouped by suite.
- Formats: plain Markdown + images directory (drops into any wiki /
  Docusaurus / README) and a self-contained HTML option.
- CI shape: regenerate on every accepted baseline change; heal diffs double
  as "what changed in this flow" release-note material.

### `playtest clip` — subtitled journey video

For surfaces where *watching a 15-second proof* beats reading: PR comments,
Slack, demos, research findings.

- No stitching needed: the run already captures a screencast with per-step
  timestamps; the clip renderer cuts and captions the existing video.
- Captions from step data, two styles: action captions (`Click "Checkout"`)
  for docs/PR clips; `thought`/`expectation` captions for research clips —
  which read like a narrated usability session.
- Default output is zero-dependency: the webm plus a WebVTT subtitle
  sidecar keyed to step timestamps (plays in the viewer and any browser, no
  re-encoding).
- `--burn` invokes ffmpeg for self-contained sharing: hard subtitles plus a
  status watermark top-left — green pass / amber changed (healed) / red
  fail — with case id and step counter. This is the variant the PR bot
  embeds.
- Fallback when the screencast is unavailable: slideshow assembled from the
  per-step screenshots (ffmpeg required).

## 12. Durable Run History Backend

`runs/` is local and gitignored, so all trend features are currently
per-machine. Target: CI (GitHub Actions) uploads runs to a persistent
store; dashboards and the viewer read from it.

Architecture — split the run into two planes; never serve reads from zips:

- **Control plane (hot, tiny):** `manifest.json` + `grade.json` + gate
  results — a few KB per run, and everything trends/history/dashboards
  query. The `--json` run summary is already the exact ingestion payload.
  A CI step POSTs it to a small API backed by Postgres. All list/trend
  reads are indexed DB queries; no cache warming, because hot data never
  lives inside an archive.
- **Data plane (cold, heavy):** webm, MHTML, screenshots, HAR — needed only
  when a human opens one specific run. Store as individual objects under a
  run-id prefix in object storage (not one zip); the DB row holds the
  prefix. The viewer (already a static app) reads history from the API and
  lazy-loads artifacts via signed URLs per run.

If org policy mandates a single archive in Artifactory, two escape hatches:

1. **Sidecar uploads** (preferred): push the zip for archival AND the three
   small files as separate artifacts; ingestion reads only the sidecars.
2. **Range-read the zip:** zip's central directory is at the file's end and
   Artifactory/S3 honor HTTP range requests, so a client can fetch the
   directory then range-get individual entries without downloading the
   archive. Works, but more machinery than (1).

Design rules:

- CQRS / cache-aside is deferred: write volume is one POST per case per
  run; plain Postgres + object store carries this far. Add read models when
  a real query gets slow.
- The schema's load-bearing column is the **comparability key**: store the
  full pin set (harness/model/prompt/schema/settle versions, headed flag)
  on every row. The harness's rule — never compare trends across baseline
  boundaries — must be enforced in queries too, or trend lines silently lie
  after every harness upgrade.
- Retention tiers: summaries kept indefinitely (trends want a long horizon,
  rows are tiny); artifacts on a 30–90 day TTL.
- v0 needs no backend at all: workflow-artifact upload (data plane) + a
  POST step can come later; the PR bot (§6) works from artifacts alone.
- This backend is also the read side of the hosted run service deferred in
  NICE_TO_HAVE.md — design the schema with that in mind.

## 13. One Creation Command + `app:` Config Block

Settled design (June 2026 discussion); supersedes the `new suite` /
`new case` split. Three coupled decisions, the first two net deletions.
Lands at the top of the order: §1's self-test freezes the CLI/JSON
contract, and §2/§4/§7 print these names in the README, the demo's call
to action, and the skill — every one gets more expensive once the
surface is public.

### `playtest new <name> [dir]` is the only creation entry point

`playtest.yaml` is optional shared config, not a registration. `DEFAULTS`
in config.js covers everything except `base_url`, and a case file or
`--base-url` can supply that (the config error already names all three
sources — case files run through the same load/merge path as defaults
files, including relative-path resolution). Creating a suite is therefore
not a user intent; adding a case is. Consolidate:

- `case` becomes the default subcommand of `new` (the same `isDefault`
  routing the top-level `run` command uses), so
  `playtest new guest-checkout ./checkout` just works. `new persona <name>`
  keeps its explicit form; a case literally named "persona" needs
  `new case persona` — acceptable.
- **Lazy defaults scaffolding, ancestor-aware.** If no directory from the
  target up to the repo root contains a `playtest.yaml` (the upward walk
  `findSuiteDir` already implements), write one next to the new case. The
  ancestor check is the load-bearing rule: without it, running `new`
  inside a subtree would sprinkle defaults files that shadow ancestors via
  nearest-wins.
- The scaffolded `playtest.yaml` is the documentation — active `base_url`,
  everything else present but commented:

```yaml
app:
  base_url: http://localhost:3000
  # compose: ./docker-compose.test.yml   # Playtest boots/tears down the app
  # init: ./seed/reset.sh                # runs before each case
  # storage_state: ./seed/anon.json      # pre-built browser session
# actor_model: claude-haiku-4-5
# grader_model: claude-sonnet-4-6
```

- `[dir]` omitted: nearest ancestor suite, else the existing
  unique-suite-below-cwd search, else (greenfield) `./tests/` — matches
  every example in the docs and keeps a repo-root invocation from
  littering the root.
- Deleted outright: `newSuite`, `validateSuiteDir`, the `--suite` flag,
  the "multiple suites found — pass --suite" error path, `new suite`'s
  `--compose` flag (now a commented template line), and the dead `name:`
  key the suite scaffold writes (`resolveCase` derives names from
  filenames and ignores it).
- Touchpoints: `NO_SUITES_HINT` and the workflow help epilogue in cli.js,
  README, docs/CONTRACTS.md §12, the §4 demo's closing-slide command.
  docs/playtest-design.md documents `new suite` and is a stable input —
  flag the divergence to its owners rather than edit it.

### `env:` → `app:`

The block describes the app under test — where it is (`base_url`), how to
boot it (`compose`), how to seed it (`init`) — and `env:` collides with
the strongest convention in YAML-config land (compose `environment:`,
GitHub Actions `env:`: environment *variables*). Users will try to put
vars there; and if Playtest ever passes real env vars to `init`/compose,
it will want the `env:` key free. Renaming the key does not rename the
concept: "managed/external environment", "environment flake", and exit
code 2 stay as they are.

- Surface-only rename: config.js reads `app:`; the resolved-case `.env`
  field and env.js internals can follow in a later pass or never.
- Pre-1.0, no read shim (per §2's philosophy). A file using `env:` gets a
  config error naming the rename —
  `env: was renamed to app: (update tests/playtest.yaml)` — clear beats
  compatible while there are no external users.
- `storage_state` is the one awkward resident (a browser-session artifact,
  not app config). Keep it under `app:` anyway; a third top-level section
  costs more than the impurity.

### The noun stays "case"

Considered: **scenario** (best metaphor fit — commedia dell'arte actors
improvising from a scenario is literally record mode — and
Gherkin-familiar), **story** (rejected: collides with the `story:` field
inside the file — "the story's story"), **journey** (rejected: reserved
for the in-app concept; a case *checks* a journey, and "changed journey"
must keep meaning the path changed, not the YAML file). Decision: keep
**case**. The glossary deliberately runs two registers — theatrical words
where they explain mechanics (actor, act, heal), conventional words on the
CI-facing surface (suite, case, run, tag) — and `case_id` and `--case`
make a rename expensive for marginal gain. If the
appetite for "scenario" ever firms up, this pre-1.0 window is the only
cheap time.

## Out Of Scope / Deferred

- **Hosted run service ("playtest behind an API")** — moved to
  NICE_TO_HAVE.md with its design constraints. The closed loop ships first
  on existing rails: PR bot (§6) + skill (§7) + `playtest check` (§8).
- **MCP server** — superseded by the skill (§7) for shell-capable agents.
  Revisit only if a no-shell surface (claude.ai web, restricted IDE
  sandboxes) demands Playtest access; it would be a thin wrapper over the
  CLI and the §12 API at that point.
- Everything in NICE_TO_HAVE.md remains deferred as documented there.
