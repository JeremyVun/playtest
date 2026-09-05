# Hosted UI refresh

## Owner intent

1. “The UI was built a while ago and probably could do with a refresh.”
2. “I think it's in a fairly good state usability wise.”
3. “Looking for your help to see if you can take it to the next level.”
4. “I like all the little small UI polish and improvements in B compared to the current reference, but i dont like the addition of the new ‘triage desk’ panels.”

Status: approved fixes implemented locally. Final verification is recorded in
[build_plan.md](build_plan.md). Selected B polish remains the visual reference.

## Implementation ruling — 5 September 2026

The owner approved unsaved-edit protection, concise complete finding titles
(including the generating agent's prompt), simple Findings search/filter controls,
and the copy cleanup. Replay's initial step is explicitly accepted as-is and
must not change. Story-list search is outside this implementation. Preserve B's
compact rail, selected-menu treatment and rounded tables without the rejected
right-hand panels. See [build_plan.md](build_plan.md) for implementation status.

## Design ruling — 5 September 2026, round 01

Workshop: `/tmp/playtest-design-round-01`. Sheet: `http://127.0.0.1:49191/`. Report: `OPTIONS.md`; running-product review: `current/observations.md` in that workshop.

- **Suites:** “I like B. It keeps the menu selection design, compacts the menu width, and keeps the table borders rounded.” Carry forward B's selected-menu treatment, narrower global rail, rounded tables and small visual improvements.
- **Runs:** “Again i like B, except for the ‘needs attention’ panel that's been added on the right.” Remove the added right-hand panel and return that space to the existing run table.
- **Findings:** “Again i like B, but there's no need for the ‘selected claim’ panel on the right.” Remove the added right-hand panel and return that space to the finding list.
- The chosen direction is B's polish. A was the agent recommendation, not the owner's choice. C's second rail is not selected. Do not revive the rejected panels as an optional default or move them elsewhere.

## Scope and invariants

Preserve the current six navigation sections, project switcher, user menu, footer status, light/dark themes, desktop-width gate, in-place run expansion, and evidence links. Current source and the running UI have Applications in the rail; `docs/contracts/hosted-web.md` still describes five sections and needs reconciliation before implementation.

Use B's round-01 screenshots as the comparison exemplar. Round 02 inherits the screenshot instrument, real materials and scenario definitions into `/tmp/playtest-design-round-02`. Refine this one selected direction; do not restart divergent exploration. Standard frames are 1440×900 and 1024×768 CSS pixels at 2×, both schemes, plus the existing 860px width gate. Preserve full failure reasons, accessible controls, visible danger at rest, sticky table context, and cost access at smaller supported widths.

Suites and Findings use the observed ilovetrains project: 28 stories, 59 findings awaiting review, no graded stories in the last seven days. Findings comps use an eight-row excerpt; they do not test the entire 59-row list. Runs uses the declared UX-lab fixture to exercise live, queued, failed, interrupted and historical states. Synthetic changes remain explicitly documented in the workshop.

## Usability and copy review

The owner asked: “did you find any issues with usability or user flows anywhere? any copy elsewhere that needs to be tidied up or removed?” Record verified findings and proposed changes in this folder. Review recommendations are not automatically approved behavior changes.

Verified findings and proposed wording are recorded in [review.md](review.md).

Known issues from the audit:

- Unsaved story changes are silently lost when navigating via the rail. Reproduced in a disposable browser context without saving data.
- Interrupted Replay opens at successful step 1 while the terminal actor error is at step 5. A future initial-step policy must preserve explicit step links.
- Stored finding titles are hard-cut at 180 characters, including mid-word. CSS cannot repair stored summaries.
- Findings (59 records) and suite stories (28 records) have no search/filter controls. Consider small list controls before adding layout or navigation.
- Story editor shows an unknown-to-project persona beside “valid story.” Verify suite-local persona resolution before treating this as an invalid story.
- Repeated lifecycle explanations, internal “ring” vocabulary, and “Live / Idle” footer wording need a targeted copy pass.

## Verification

Verify the approved changes against the revised B reference in both themes and
supported desktop widths. Keep Replay behavior and existing run/evidence flows.

## Calibration — 5 September 2026, round 02

Workshop: `/tmp/playtest-design-round-02`; sheet: `http://127.0.0.1:49192/#key`.
Original B is paired with revised B. Both rejected panels are removed, Suites
is unchanged, and the 188px rail, selected-menu treatment and rounded tables
remain. At 1440px, Runs gains 266px of table width and Findings gains 300px.
All 22 revised captures pass the instrument's overflow, target and text-spill
checks. The owner subsequently authorized the scoped fixes above.
