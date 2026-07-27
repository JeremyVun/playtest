# Viewer-UX discovery study — report

Study run 2026-07-06 against the standalone trajectory viewer (seeded todo fixture).
Runs: `runs/2026-07-06T1608-f0f9` (first pass) and `runs/2026-07-06T1634-d5b3`
(re-run of judge-healed-change after an infra timeout; its fixture also had a
*real* heal, which turned out to matter — see finding 2). 7 usable trajectories
across 3 stories × 2–3 personas; no give-ups; scores 76–92. Every cited run is
viewable with `playtest view <run-dir>`.

## Headline: the evidence is good, the *actions* are undiscoverable

Every persona reached correct evidence (gate criteria, failure text, history)
— and every persona who had to **act** on that evidence (bless/reject a heal)
failed to find any way to do it. The viewer reads well and acts badly.

## Report questions, answered across personas

### Triage a red run (2 personas, both score 92, 2 steps, zero wrong turns)

**Where did they look first?** Both went straight from the runs list's red FAIL
row to the story link and stopped at the gate panel with the correct diagnosis
(`POST /api/todos` happened, `todo-item-buy-milk` never rendered) — the
badge→story→gate path is working as designed
(`runs/2026-07-06T1608-f0f9/triage-red-run@ci-triager/steps/001.png`, `002.png`).

**Did they reach the failing criteria or stop at the badge?** Both reached the
criteria. Neither, however, noticed the screenshot-vs-criteria contradiction the
story planted — both treated gate text as authoritative and read the stills as
confirming it (`triage-red-run@new-evaluator/steps/002.png`). The gate panel's
authority is high; if it's ever wrong, users won't catch it.

**Undiscovered affordances:** neither used Agent view; the overview surfaces no
failure cause inline (you must open the story).

### Judge a healed change (4 runs across 2 fixtures, scores 76–78)

**The single worst convergence in the study.** All four personas expected a
Bless/Accept control in the run header, right Run panel, or the run row. None
found one; none ever registered the CLI command as the action path. Three ended
with a decision they could not enact
(`runs/2026-07-06T1634-d5b3/judge-healed-change@reviewing-pm/steps/006.png`);
grader verdict on the last: *"the viewer made them assemble that decision from
small history/diff affordances rather than a clear review action."*

**Worse: 2 of 3 personas who judged the heal got the *answer wrong* because the
Diff tab is undiscoverable.** Both ci-triager runs compared baseline/new via the
small older/newer links and thumbnails, concluded "no meaningful path change",
and voted **reject** on a legitimate heal
(`runs/2026-07-06T1608-f0f9/judge-healed-change@ci-triager/steps/004.png`,
`runs/2026-07-06T1634-d5b3/judge-healed-change@ci-triager/steps/004.png`).
Only reviewing-pm found the Diff tab — and only because the step strip smelled
wrong ("step 02 failed on add-button, then step 03 uses submit-button")
(`…d5b3/judge-healed-change@reviewing-pm/steps/003.png`, `004.png`). The diff
itself then carried the decision cleanly (add-button red → submit-button green).

**Also:** the *old* run's diff page told reviewing-pm "nothing to accept from
here because this run was superseded" — technically true, but it bounced the
one persona who found the diff back into a fruitless hunt for the control on
the newer run (steps 4–6).

### Assess stability across runs (2 personas, 92 / 76)

**Cross-run view or one-at-a-time?** Split by persona — and that split is the
finding. new-evaluator found the `+ 5 older` history grouping and answered in
3 steps. reviewing-pm never found it, walked all six runs one-at-a-time via the
small older/newer link, and repeated the same complaint at every hop: *"still
only previous/next links, no trend chart or rollup"*
(`runs/2026-07-06T1608-f0f9/assess-stability@reviewing-pm/steps/002.png`,
`005.png`, `007.png`). The capability half-exists (grouping), isn't where
either persona expected it (near the story title/controls), and there is no
trend/stability rollup at all — both had to infer "5 passes then a fail" by eye.

**Signals treated as health:** status colors, gate pass/fail, the regression
label, completion/wasted-steps. Both ignored durations, cost, tokens, and the
advisory quality score.

## Cross-cutting findings (by convergence)

1. **No in-viewer decision action for heals** — 4/4 judge runs; 3 majors.
   Whatever the product decision (embed a bless affordance, or loudly point at
   the CLI command with copyable text), the current silence is the gap.
2. **Diff tab undiscoverable → wrong decisions** — 2/3 judging personas. This
   is the only finding in the study that changed an *outcome*, not just a path.
3. **History affordances too quiet** — 5/7 runs called the older/newer link or
   `+ N older` pill "small" / "easy to miss" (top-right story header, secondary
   to large stills).
4. **No trend/stability rollup** — 2/2 assess personas wanted it near the story
   controls; one rated it major.
5. **Decisive text is visually secondary** — 5/7 runs: large stills dominate
   while the gate/failure text that actually answers the question sits in the
   small right rail.
6. **Color-contrast violations on every step of every run** — the a11y scan
   flags them throughout; personas navigate by red/green scanning, so contrast
   is load-bearing here, not cosmetic.

## What's working (keep)

- Red-row → story → gate triage path: 2 steps, zero wrong turns, both personas.
- Gate panel content: every persona quoted its exact criteria unprompted.
- History *grouping* (once found) made "5 passes + 1 new fail" legible at a glance.
- Run counter ("1/6") let a persona stop confidently at the history boundary.

## Suggested product responses (for the fix-batch discussion)

- Put a review affordance where all four personas looked: run header / right
  Run panel of a healed-or-failed run (at minimum a copyable CLI command;
  the hosted app should link its review queue).
- Make the Diff tab impossible to miss on runs that *have* a diff (badge the
  tab, or inline a "what changed" strip in the Run panel).
- Add a compact trend/stability line near the story title (sparkline or
  pass/fail strip) — the hosted suite page needs the same thing (its TREND
  column is currently a bare "history →" link).
- Audit viewer link/text contrast on `--panel` backgrounds.
