# VERSION_1.1.md — Talk Assets + Fix-Loop Package

The package after VERSION_1, which has **fully landed** (verified
2026-06-12; its doc has been deleted). The planning doc this package was
selected from, `IMPROVEMENTS_FOLLOWUP.md`, has also been dismantled
(2026-06-13): implemented sections live on as code and tests, the CI
track moved to `CI_INTEGRATION.md`, accessibility is parked in
`ACCESSIBILITY.md`, deferred ideas went to `NICE_TO_HAVE.md`, and the
design detail this package needs is folded into the items below — **each
item is self-contained**. §N labels are kept only as historical
identifiers of that doc's sections. This document fixes the order,
records the verified current state (re-audited against the post-V1 tree,
2026-06-12), and sets acceptance criteria.

**Every item here consumes VERSION_1's output**, all of which exists: the
demo command (`playtest demo`, `src/harness/demo.js`) produces the runs
items 1–2 work on; the self-test (`npm test` → `test/*.test.js`) froze the
`--json`/exit-code contract item 3 encodes; the final CLI names
(`playtest new`, `app:`) are what items 3–4 print; and the package.json
`files` allowlist (which already includes `skills/`) is where item 3's
skill ships.

## What this package is

The remainder of Milestone A (execution-order items 3 and 4) plus the agent
skill (item 8, a.k.a. optional act five) and the talk's slide collateral.
Theme: make the demo's story *visible* (viewer), *durable* (clips), and
*convertible* (skill + slides).

| # | Item | Source | Net effect |
|---|------|--------|-----------|
| 1 | Demo-path viewer polish (scoped audit) | order item 3 | audit + targeted fixes |
| 2 | `playtest clip` journey renderer + demo backup clips | §11 (clip half) | new command |
| 3 | Agent skill + `playtest install-skill` | §7 | new, ships in package |
| 4 | Talk collateral: slide answers + mock PR comment | order notes + §6 format | docs only, timeboxed |
| 5 | Viewer self-test: data contract + UI smoke | new (2026-06-12) | new tests |
| 6 | Shared comparability module | §5 / order item 10 | refactor, net deletion |
| 7 | Vision for discovery mode | §9 (vision half) | new, additive |

Items 5–7 were added 2026-06-13: they are not talk assets, but they share
the package's theme of consolidating what V1 and discovery mode produced
(5 freezes the viewer surface, 6 deduplicates the trend logic both
consumers grew, 7 completes discovery's core promise).

**Why this subset:** items 1–2 were explicitly excluded from VERSION_1 as
the audit/timebox items that need demo runs in hand — V1 produced those
runs. The skill's two dependencies (final CLI names from V1 item 1, the
contract frozen by V1 item 3) are now satisfied, and the execution order
calls it "highest leverage per unit cost in the list"; building it now also
keeps the optional act-five live segment available for the talk. The slide
answers are flagged "no code, but mandatory for this audience" — they
belong with the talk-asset work, not after it.

**Why nothing more:** §6 (PR journey-diff bot — now specced in
`CI_INTEGRATION.md`) is the documented swap alternative to the skill
("swappable by appetite: 8↔9" — solo loop vs team visibility); it is the
natural headline of the *next* package, where item 2's `--burn` clips
embed into its comment format and item 4's mock comment becomes real.
`playtest docs` (the other former-§11 renderer) has been demoted to
`NICE_TO_HAVE.md` — a separate docs toolchain consuming playtest
artifacts is the likelier shape than a built-in renderer. `playtest
check` is likewise deferred there.

## Current state (verified against the post-V1 tree, 2026-06-12)

**The §11 "verify first" question is answered — the per-step-timestamped
screencast IS implemented.** Do not rebuild any of this:

- Every step envelope carries `ts` (epoch ms, `runner.js:321`;
  `schema_version: 2`, `trajectory.js:7`). The manifest carries
  `video_started_at` (epoch ms, `runner.js:496`) and
  `artifacts.video: "video.webm"` (`runner.js:521`); the webm is saved per
  case (`browser.js:383`).
- The viewer already does the timestamp arithmetic the clip renderer
  needs: `seekVideo` sets `currentTime = (env.ts - video_started_at)/1000`
  (`src/viewer/app.js:950`) and `renderVideoMarks` places per-step marks
  on the timeline (`app.js:1089`).

**Viewer features that already exist** (item 1 is an audit, not a build):

- Thought captions per step (`#cap-thought`, `app.js:921-928`), including
  the acted-step fallback text ("Replayed from the saved recording — …").
- A diff tab gated on baseline presence (`#tab-diff`, `app.js:1172`) with
  `baselineByStep` mapping (`app.js:274`); acted envelopes resolve
  their action/locator from the baseline step (`app.js:165-190`).
- Changed-journey review list (`/changed.json`), per-case history
  (`/history.json`), mode/status chips with healed semantics, accept
  command display. View-server routes: `/runs.json`, `/changed.json`,
  `/history.json`, `/run/<path>` (`src/harness/view-server.js:72-79`).

**Not yet done — this package's work:**

- No ffmpeg usage anywhere in the repo (clip `--burn` and the slideshow
  fallback introduce it as an *optional, system-installed* dependency).
- No WebVTT anywhere; the viewer's `<video>` has no `<track>` wiring.
- No `clip` or `install-skill` command in cli.js. A `skills/` directory
  exists but holds only the discovery-mode skills (`playtest-discovery`,
  `playtest-stories`) — unrelated to this package; the fix-loop skill at
  `skills/playtest/SKILL.md` does not exist. Do not modify the two
  discovery skills.
- The four-verdict triage table the skill must encode exists at
  `docs/playtest-design.md:512` (verbatim source for the skill body).
- No talk/slide collateral anywhere.

**Working-tree caveat:** the repo currently has an uncommitted change to
`src/viewer/app.js`. Resolve or commit that in-flight work *before*
starting item 1's audit, so polish fixes diff against a clean baseline.

## Work items

Order: item 1 first (its audit produces the fix list and the runs get
reused), then 2; item 3 is independent and parallel-friendly; item 5's
contract half is independent but its UI smoke should land after item 1
(it freezes the polished path); item 6 after item 5 (refactor under the
freshly frozen contract); item 7 is independent; item 4 last (its mock
comment wants a real run and final clip/skill names).

### 1. Demo-path viewer polish (execution-order item 3 — scoped)

The narrative path, exactly as the demo tells it: **replay with thought
captions → heal-diff view with divergence screenshots**. Method:

- Generate fresh runs with V1's `playtest demo --keep` (all three acts) and
  walk that path in the viewer (`playtest view`) for each act's run.
- Audit only what the story touches: the record run's live thoughts, the
  act run's replay captions, the heal run's changed-journey entry, the diff
  tab's step alignment, and the divergence screenshots (baseline step N vs
  healed step N side by side — verify this view exists and reads clearly;
  it is the finale's money shot).
- Fix only what the audit finds on that path. **No general viewer work** —
  any tempting refactor or off-path bug gets a note in the commit message,
  not a fix.

Acceptance: a written audit checklist (act → screen → finding → fixed/won't
fix) committed alongside the fixes; the three demo acts each present
cleanly in the viewer with no blank panels, broken images, or misaligned
diff steps on the talk path.

### 2. `playtest clip` — subtitled journey video (§11, clip half only)

Cut and caption the *existing* screencast; no stitching, no re-encoding on
the default path.

- `playtest clip <runDir|case>` produces the webm plus a WebVTT sidecar.
  Cue timing from step data: cue N starts at `(ts_N − video_started_at)`,
  ends at the next step's start (last cue: video end). Check the capture
  point of `ts` (`runner.js:321` records it at envelope write — verify
  whether that is action-start or action-end and align cue edges so
  captions lead the action, not trail it).
- Two caption styles: **action captions** (`Click "Checkout"` — derived
  from action + resolved locator name, same derivation the viewer's
  caption code already does) for docs/PR clips; **thought captions**
  (`thought`/`expectation` from the agent block) for research-style clips.
  A `--captions action|thought` flag; action is the default.
- Default output is zero-dependency (webm + `.vtt` sidecar). Wire a
  `<track>` element into the viewer's video stage so sidecars play there;
  any browser plays the pair natively.
- `--burn` invokes **system ffmpeg** (spawn, clear error if absent): hard
  subtitles + status watermark top-left (green pass / amber changed /
  red fail) + case id and step counter. This is the self-contained variant
  the future PR bot (§6) embeds — treat its output as a publishable asset.
- Fallback when the screencast is missing: slideshow assembled from the
  per-step screenshots (ffmpeg required; same absent-ffmpeg error).
- **Recorded backups deliverable:** after item 1's polish lands, cut burned
  clips of all three demo acts and commit them (or their generation script)
  as the talk's safety net. The execution order is explicit: never present
  without the recording. Timebox: if `--burn` fights ffmpeg filters too
  long, a hand-recorded screen capture of the demo is the acceptable
  fallback for the first deck — the sidecar path must still land.

Acceptance: `playtest clip` on a demo act run yields a webm+vtt pair whose
captions match steps when played in Chrome and in the viewer; `--burn`
yields a single self-contained webm with watermark and captions; clip of a
healed run carries the amber watermark; absent ffmpeg, `--burn` exits 2
with an install hint while the default path still works.

### 3. Agent skill: close the fix loop (§7)

Why a skill and not an MCP server (decided): skills are portable across
harnesses, token-efficient (name + description until triggered), and need
no server process. The MCP advantage — exposing screenshots as resources —
evaporates locally, where coding agents read image files off disk
natively. The expensive part of closing the loop is workflow knowledge,
and a skill is exactly that. (MCP is revisited only if a no-shell surface
demands access — see NICE_TO_HAVE.md.)

- Ship `skills/playtest/SKILL.md` in the npm package (the `files`
  allowlist already includes `skills/`). `playtest install-skill` copies
  it into the project's
  `.claude/skills/` so the skill versions in lockstep with the installed
  harness and its `--json` contract.
- Skill body: triggers (changed UI code, "did I break any
  journeys?", red journey in CI); the loop (run `playtest <paths> --json`;
  per failure read `manifest.json`, trajectory tail, failing step's
  screenshot + a11y snapshot); classify with the four-verdict table from
  `docs/playtest-design.md:512`; per-verdict actions (app bug → fix code,
  rerun that case file; app changed → summarize heal diff, print
  `playtest accept <runDir>` for the human; agent flake → rerun once, then
  suggest story tuning; env flake / exit 2 → report, don't touch code).
- **Hard rule encoded verbatim in the skill: never run `accept` or
  `reject` autonomously.** Acceptance rewrites a versioned baseline and
  stays a human action.
- The skill prints only post-V1 surface (`playtest new <name>`, `app:`,
  current `--json` field names). The V1 self-test is the guard: if the
  skill's documented contract drifts from the tested one, the same commit
  must touch both.
- Later extension (not this package): a discovery-findings fix loop, once
  vision-on discovery runs (item 7) produce richer findings to act on.

Acceptance: `playtest install-skill` lands the file in `.claude/skills/`
(idempotent, `--force` semantics consistent with `new`); `npm pack
--dry-run` includes `skills/`; a dry read-through of SKILL.md against a
real failing run resolves every referenced file path and command verbatim
(no invented flags); the accept/reject prohibition is stated in the skill's
hard-rules section.

### 4. Talk collateral (timeboxed, docs only)

One `docs/talk/` directory (or single `TALK.md`) with the slide-ready
answers the execution order calls mandatory for this audience:

- **Cost:** cents per heal, zero in the steady state (act runs make no
  model calls — cite the self-test's zero-call assertion; price a heal from
  a real demo-act-three run if a key is available, else from token counts
  in the trajectory).
- **Safety:** hermetic environments — the agent *will* click buy; staging
  with test rails, never prod.
- **Gateway fit:** `PLAYTEST_LLM_BASE_URL` points at the org's
  LiteLLM/Portkey proxy — no new vendor relationship.
- **The four-verdict triage table** (lift from `docs/playtest-design.md`).
- **Exit-code/CI contract:** 0 pass / 1 gate / 2 infra, `--fail-on-changed`
  as the gating knob.
- **Mock PR-bot comment** generated by hand from a local run, in the exact
  comment format from `CI_INTEGRATION.md` §6 (sticky-comment markdown with
  the journey table and changed-journey callout) — the CI story as a slide
  before the action exists, and a de-risk of that package to follow.

Acceptance: every claim in the collateral is reproducible from a command or
file in the repo (no aspirational numbers); the mock comment's table values
come from a real local run's `--json` output.

### 5. Viewer self-test: freeze the data contract, smoke the UI

`npm test` exercises the harness end to end (journey regression in
`test/harness.test.js`, discovery mode in `test/*-discovery.test.js`, both
against the bundled todo app + mock-llm) but the viewer has zero coverage —
and the viewer is half this package's surface (item 1 polishes it, item 2
wires `<track>` into it). Two layers, same offline/no-keys conventions as
the existing tests:

- **View-server contract tests** (node:test, in-process —
  `src/harness/view-server.js` already exports `serveRun({ port })` and the
  scanners `listRuns`/`changed`/`findManifests`): over a runs root the test
  produces with the existing fixtures, assert the shapes of `/runs.json`,
  `/changed.json`, `/history.json?case=` and `/run/<path>` file serving —
  presence + types of the load-bearing fields, the same freeze discipline
  the V1 self-test applies to `--json`. This is the contract a standalone
  viewer or future backend data source must keep.
- **Viewer UI smoke in pinned chromium** (playwright is already a
  dependency): load the viewer page against (a) a recorded run, (b) a
  healed run, (c) a discovery run; assert the film strip, step captions,
  the diff tab (healed run), and the report answers panel (discovery run)
  render with content and the page logs no console errors. This is the
  regression suite for item 1's polish and the proof that discovery mode
  renders end to end.
- Generate the three runs once per test file (record → variant-flip heal →
  explore), reusing the `start({ port })` fixtures; nothing outside the
  test's temp dir is touched.

Acceptance: `npm test` stays offline, keyless, and within a sane runtime;
changing a view-server route's shape or blanking one of the asserted viewer
panels fails the suite; all three run kinds render in the smoke test.

### 6. Shared comparability module (§5 / order item 10, boundary amended)

The trend/movement logic exists twice: `computeTrend` in
`src/harness/cli.js:111` and `computeMovement` in `src/viewer/app.js:569`
(whose own comment says "mirrors cli.js trend"). Extract once — but with a
different boundary than §5's "runs root + case id": the viewer will
eventually run standalone against a backend data source, so the module
must not know where history comes from.

- **Pure comparison module**, browser-safe plain ESM (no Node imports), at
  e.g. `src/shared/movement.js`: input is an ordered list of history
  entries plus the current run's numbers; output is deltas vs previous
  comparable run and vs median of the last 5, status movement, and the
  regression/improved badge. Both cli.js and the viewer call it (the
  viewer imports it over HTTP via view-server; add the path to the `files`
  allowlist).
- **Comparability is decided here, once:** comparable = same case id,
  started earlier, non-infra, non-explored, not a same-run-id sibling,
  **and same pin set + headed flag** — the pin rule is currently
  unenforced in the viewer's filter; closing that gap is part of this
  item. This key is also what `CI_INTEGRATION.md` §12's schema inherits
  unchanged.
- **Badge thresholds live in the module, one config spot** (defaults:
  score ±5, duration/LCP ±20% vs median, any status movement) — the
  viewer's `SCORE_DELTA_BADGE`/`DURATION_RATIO_BADGE` constants move in
  rather than staying scattered.
- While there, check the sparkline against the original spec: hover a
  point for that run's numbers, click to open the run. Add if missing —
  small, and this is the last planned pass over this code.
- The data access stays with the callers (cli.js's history scan,
  view-server's `/history.json`) — that seam is where a SQLite index or
  remote API plugs in later (see `CI_INTEGRATION.md` §12); do not build
  those providers now.
- Contract freeze applies: if extraction changes any `--json` field or
  CLI trend-line output, the V1 self-test updates in the same commit; the
  item-5 UI smoke guards the viewer side.

Acceptance: one implementation of the comparison rules, no trend logic
left in cli.js or app.js beyond formatting; the pin rule provably excludes
a run with different pins from comparisons (unit test in the new module's
test file); `npm test` green; net lines deleted.

### 7. Vision for discovery mode (§9, vision half — scoped to discovery)

Discovery personas are defined by *visual* behavior — prominence,
skimming, where the eye lands — which the a11y tree cannot convey. Add
vision as a discovery-mode capability; the regression instrument
(record/act/heal) stays a11y-only by construction.

- **Config:** `vision: true|false` lives at the same level as
  `mode: discovery` in playtest.yaml, **defaulting to true when
  `mode: discovery`** and false otherwise; per-case override allowed.
  Setting `vision: true` on a non-discovery suite or case is a schema
  error (the validation rule *is* the policy — no measured run can ever
  send images).
- **Plumbing:** image content blocks in `llm.js` (Anthropic models,
  including Haiku, accept images through the same chat-completions path —
  no new transport); each actor step sends the current **viewport**
  screenshot (downscaled, longest edge capped) alongside the a11y
  snapshot — alongside, not replacing: the agent still acts on refs.
  Side benefit to keep in mind while building: the same content-block
  work is the future answer for canvas-heavy or semantically empty pages
  in regression runs — out of scope here, but don't design it out.
- **Richer output, not just richer input:** when vision is on, the actor's
  step schema gains an optional visual-observation field (what drew the
  eye, what competed, what was missed) and the system prompt instructs the
  richer looking; the discovery grader prompt is extended to mine those
  observations for findings and report answers. Additive schema change —
  decide whether it bumps `STEP_SCHEMA_VERSION` (`trajectory.js:7`).
- **Pins:** the vision flag is recorded in manifest pins. Explored runs
  carry no trend, but the comparability key (item 6) must still see it.
- **Offline:** mock-llm accepts and ignores image blocks and can emit the
  visual-observation field, so the discovery self-tests cover a
  vision-on run with no keys and no network.

Acceptance: a vision-on discovery run sends one image per actor step
(assert by inspecting requests captured by the mock); envelopes carry the
visual observations and the viewer renders them with the existing thought
captions; `vision: true` on a journey case exits 2 with a config error;
`npm test` stays offline and green.

## Cross-cutting constraints

- **Scope discipline on the viewer.** Item 1 is the only viewer work, and
  only on the demo path. The known off-path gaps (deltas/badges,
  sparkline navigation) are Milestone C — leave them.
- **Clips are consumers, not capturers.** Item 2 reads existing run
  artifacts; if a needed signal is missing (e.g. ts capture-point is wrong
  for caption timing), fix it in the runner *minimally* and update the V1
  self-test in the same commit (the contract freeze applies).
- **ffmpeg stays optional.** The default clip path and everything else in
  the product must work without it; only `--burn` and the slideshow
  fallback may require it, with a clean exit-2 error when absent.
- **The skill never weakens specs.** Per §8's design rule (the YAML is
  spec, not config): the skill fixes code, never edits a case's story or
  assertions to make a failure pass, and never runs accept/reject. Encode
  this; do not soften it.
- Verify each item with a real invocation: the viewer walk on actual demo
  runs, clips played in an actual browser, the skill exercised against a
  real failing run.

## Definition of done

The three demo acts present cleanly in the viewer with the divergence view
as the finale; `playtest clip` produces playable sidecar and burned
variants from demo runs and the three backup clips exist; `playtest
install-skill` ships a skill whose every command resolves against the V1
surface; the talk collateral answers all five mandatory questions with
reproducible numbers and includes the mock comment in the format specced
by `CI_INTEGRATION.md` §6; the view-server's JSON routes and the viewer's
render path for recorded, healed, and discovery runs are frozen by
`npm test`; one shared comparability module serves cli.js and the viewer
with the pin rule enforced; a keyless discovery run can use vision against
the mock and the observations surface in the viewer.
