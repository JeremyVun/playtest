# VERSION_1.1.md — Talk Assets + Fix-Loop Package

The package after `VERSION_1.md`. Source of truth for design detail:
`IMPROVEMENTS_FOLLOWUP.md` (§N references point there). Same conventions as
VERSION_1: this document selects the subset, fixes the order, records the
verified current state (audited 2026-06-12), and sets acceptance criteria.
The implementing agent should read the referenced § sections in full before
planning each item.

**Hard prerequisite: VERSION_1 has fully landed.** Every item here consumes
its output — the demo command produces the runs items 1–2 work on, the
self-test froze the `--json`/exit-code contract item 3 encodes, the final
CLI names (`playtest new`, `app:`) are what items 3–4 print, and the
package.json `files` allowlist is where item 3's skill ships. The audit
below describes today's pre-V1 tree; expect line numbers to have drifted
once V1's edits land.

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

**Why this subset:** items 1–2 were explicitly excluded from VERSION_1 as
the audit/timebox items that need demo runs in hand — V1 produced those
runs. The skill's two dependencies (final CLI names from V1 item 1, the
contract frozen by V1 item 3) are now satisfied, and the execution order
calls it "highest leverage per unit cost in the list"; building it now also
keeps the optional act-five live segment available for the talk. The slide
answers are flagged "no code, but mandatory for this audience" — they
belong with the talk-asset work, not after it.

**Why nothing more:** §6 (PR journey-diff bot) is the documented swap
alternative to the skill ("swappable by appetite: 8↔9" — solo loop vs team
visibility); it is the natural headline of the *next* package, where item
2's `--burn` clips embed into its comment format and item 4's mock comment
becomes real. `playtest docs` (the other §11 renderer) is Milestone D item
14 — explicitly the static-pages half, different audience, not pulled
forward. Milestones C and D otherwise untouched.

## Current state (verified against the pre-V1 tree, 2026-06-12)

**The §11 "verify first" question is answered — the per-step-timestamped
screencast IS implemented.** Do not rebuild any of this:

- Every step envelope carries `ts` (epoch ms, `runner.js:308`;
  `step_schema_version: 2`). The manifest carries `video_started_at`
  (epoch ms, `runner.js:144,477`) and `artifacts.video: "video.webm"`
  (`runner.js:502`); the webm is saved per case (`browser.js:369-376`).
- The viewer already does the timestamp arithmetic the clip renderer
  needs: `seekVideo` sets `currentTime = (env.ts - video_started_at)/1000`
  and `renderVideoMarks` places per-step marks on the timeline
  (`src/viewer/app.js:1050-1083`).

**Viewer features that already exist** (item 1 is an audit, not a build):

- Thought captions per step (`#cap-thought`, `app.js:878-884`), including
  the acted-step fallback text ("Replayed from the saved recording — …").
- A diff tab gated on baseline presence (`#tab-diff`, `app.js:1133`) with
  `baselineByStep` mapping (`app.js:259-273`); acted envelopes resolve
  their action/locator from the baseline step (`app.js:159-188`).
- Changed-journey review list (`/changed.json`), per-case history
  (`/history.json`), mode/status chips with healed semantics, accept
  command display. View-server routes: `/runs.json`, `/changed.json`,
  `/history.json`, `/run/<path>` (`view-server.js:72-85`).

**Not yet done — this package's work:**

- No ffmpeg usage anywhere in the repo (clip `--burn` and the slideshow
  fallback introduce it as an *optional, system-installed* dependency).
- No WebVTT anywhere; the viewer's `<video>` has no `<track>` wiring.
- No `skills/` directory, no `install-skill` command.
- The four-verdict triage table the skill must encode exists at
  `docs/playtest-design.md:436` (verbatim source for the skill body).
- No talk/slide collateral anywhere.

**Working-tree caveat:** the repo currently has uncommitted viewer changes
(eight `src/viewer/fonts/*.woff2` deleted, `style.css` modified). Resolve
or commit that in-flight work *before* starting item 1's audit, so polish
fixes diff against a clean baseline.

## Work items

Order: item 1 first (its audit produces the fix list and the runs get
reused), then 2; item 3 is independent and parallel-friendly; item 4 last
(its mock comment wants a real run and final clip/skill names).

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
  point of `ts` (`runner.js:308` records it at envelope write — verify
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

### 3. Agent skill: close the fix loop (§7 — read it in full)

- Ship `skills/playtest/SKILL.md` in the npm package (extend V1's `files`
  allowlist). `playtest install-skill` copies it into the project's
  `.claude/skills/` so the skill versions in lockstep with the installed
  harness and its `--json` contract.
- Skill body per §7's outline: triggers (changed UI code, "did I break any
  journeys?", red journey in CI); the loop (run `playtest <paths> --json`;
  per failure read `manifest.json`, trajectory tail, failing step's
  screenshot + a11y snapshot); classify with the four-verdict table from
  `docs/playtest-design.md:436`; per-verdict actions (app bug → fix code,
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
- **Mock PR-bot comment** generated by hand from a local run, in §6's exact
  comment format (sticky-comment markdown with the journey table and
  changed-journey callout) — the CI story as a slide before the action
  exists, and a de-risk of the §6 package to follow.

Acceptance: every claim in the collateral is reproducible from a command or
file in the repo (no aspirational numbers); the mock comment's table values
come from a real local run's `--json` output.

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
reproducible numbers and includes the §6-format mock comment.
