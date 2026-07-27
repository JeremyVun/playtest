# Hosted-UX discovery study — report

Rounds 1–3 predate the hosted simplification. The `fix-next-from-insights` story
below is now `prioritize-findings.yaml`, rewritten without Insights; its scores
remain the baseline for that journey. Insights, plugins, and the standalone
authoring assistant no longer exist, so findings about them are closed by
deletion rather than by fix.

## Round 3 (2026-07-09, after fix batches 3–4) — scores vs rounds 1–2

Same stories, re-seeded before every batch; actor+grader are gpt-5.5 via the
codex gateway (pins cosmetic), same as rounds 1–2, so trends are comparable.
Run dirs: `runs/2026-07-09T1313-3e2d` (orient, explain×2, fix-next),
`runs/2026-07-09T1338-ca72` (triage-finding), `runs/2026-07-09T1402-40aa`
(review-changed), `runs/2026-07-09T1406-14ad` (change-environment-secret).
On top of the gpt-5.5 grades, a taste review (fable) audited every major
against the step screenshots and agent narration; verdicts below fold that in.

| story | round 1 | round 2 | round 3 | note |
|---|---|---|---|---|
| review-changed-journey | 78 | 78 | **91** | batch-3 verified: dashboard → review card → diff-at-divergent-step → accept in 5 steps, zero wrong turns. Minors: evidence link visually weaker than Accept; accepting from the run banner leaves no residue. |
| orient-first-session | 74 | 76 | **86** | batch 3+4 verified: download receipts and findings-side reconciliation gone from the report. Remaining major (audit-confirmed): suite/dashboard never show open findings, so "suite green + active major finding" has no reconciling surface. |
| change-environment-secret | 76 | — | **84** | batch 1–2 fixes verified: rotation completed via Secrets + `$secret`. Remaining major: the environment *edit modal* still displays literal `secret_env` values (the list cards mask; the editor doesn't) — fix is to reject literals in `secret_env`, reference-only. |
| explain-red-run ×2 | 94 / 94 | 94 / 95 | **95 / 95** | the fail strip now "carried the investigation" (grader's words). Only hierarchy minors remain. |
| fix-next-from-insights | 84 | 88 | 88 | hero helped but a manually-promoted finding's card is still thin — its excerpt is just the promote note. Audit: compose promote excerpts from the run's failing gate text (server). |
| triage-finding | 52 · gave up | 78 | 74 · finished | still full completion; score dip is grader noise but the four majors are real (audit-confirmed): evidence pinned to the last *action* (step 2) not the decisive end state (step 3); Promote on an already-triaged run mints a near-duplicate; Copy-for-tracker's toast isn't a durable receipt; the dashboard Review cue still misdirects triagers hunting product claims. |
| author-story-form | 88 | — | not re-run | |
| launch-and-follow ×2 | — | 82 / 78 | not re-run | round-2 majors were fixed same-day; re-measure in round 4. |

**Batch-5 fix list (taste-ranked, each verified against evidence):**
1. Evidence must carry the claim (server): promote excerpts append the failing
   gate check text; evidence pins target the final observed state (`totals.steps`,
   not `executed_steps` — the gate judges the end state) in promote + extractor.
2. Findings reach the surfaces users trust: suite story rows get an
   open-findings chip; dashboard Needs-attention lists open major findings.
3. The run page knows its findings: when a run is already evidence, show
   "In findings: <title> →" and demote Promote (kills the duplicate path).
4. Durable receipts: Copy-for-tracker swaps the "no tracker reference yet"
   hint for a persistent "copied just now" line; run-banner Accept leaves
   "accepted just now" instead of vanishing.
5. `secret_env` goes reference-only: literal values are rejected with a
   "move to Secrets" assist (security-weighted above its single occurrence).

Fix batch 5 (commit b69bcbf, post-measurement, unverified by a study):
all five taste-ranked items above, plus modal a11y (aria-dialog-name,
heading-order) found while verifying — axe 0 on suite / dashboard / run /
finding / env-modal in both themes, modals open. Round 4 should re-run
triage-finding, orient-first-session, fix-next-from-insights and
change-environment-secret, plus the never-re-run author-story-form and
launch-and-follow.

**Environment note:** macOS /tmp cleanup destroyed the dev Postgres cluster
mid-round at the day boundary (server died, one batch restarted after a
rebuild + re-seed; no trajectories were contaminated — the affected batch
never started). Don't schedule overnight batches against this stack.

## Round 2 (2026-07-09, after fix batches 1–2) — scores vs round 1

Same stories, same personas, re-seeded state; graded by gpt-5.5 via the
codex gateway. Run dirs: `runs/2026-07-09T0741-6145` (launch-and-follow),
`runs/2026-07-09T0826-162e` (orient, explain×2, fix-next, plus a
triage-finding cut short by a killed batch), `runs/2026-07-09T0851-80b1`
(triage-finding; also a review-changed run invalidated by stale seed state
— see caveat), `runs/2026-07-09T0916-4985` (review-changed, clean).

| story | round 1 | round 2 | note |
|---|---|---|---|
| triage-finding | **52 · gave up** | **78 · finished** | the round-1 give-up is resolved: rows open, Promote redirects to a finding page, Accept self-confirms. Remaining: no external tracker receipt (major), deep-link to exact failing step. |
| explain-red-run ×2 | 94 / 94 | 94 / 95 | still the best journey; viewer embed now "read as part of the same product" (round 1 complained it didn't). Remaining: gate text visually secondary, no share/copy-summary affordance. |
| fix-next-from-insights | 84 | 88 | findings now work as a prioritization layer. New major: **finding detail too thin as standalone evidence** (excerpt only, no failing step/screenshot inline). |
| orient-first-session | 74 | 76 | mental model built correctly again. Two new majors: **Bundle/Markdown downloads gave no visible feedback** and **no reconciliation of open findings vs current suite health** ("is this fixed, stale, superseded?"). a11y count fell 93–300 → 28. |
| review-changed-journey | 78 | 78 | round-1 defects (diff misroute to step-1 stills, expansion lost on return) gone. New major: reviewer followed evidence to the run page and found no Accept/Reject there; Promote misread as sign-off. |
| launch-and-follow ×2 | — (quota-blocked) | 82 / 78 | first measurement. Majors: no Run entry on suite surfaces; export-study personas missing from the seeded suite (both fixed same-day). |
| author-story-form | 88 | not re-run | |
| change-environment-secret | 76 | not re-run | round-1 fixes (masking, $secret helper, Rotate) unmeasured. |

**Caveat:** one review-changed run (runs/2026-07-09T0851-80b1, score 34,
gave up) is invalid as a measurement — the batch wasn't re-seeded, so an
earlier orient run had already consumed the pending candidate and the
reviewer persona walked into an empty queue. Re-seed before every batch.
Its one real signal (personas expect sign-off wherever the evidence is)
matched the clean run's major and drove the same-day fix (accept/reject
on the run page banner, commit bfacc0d).

Fix batch 3 (commit bfacc0d, post-measurement, unverified by a study):
run-page accept/reject, launcher "Use staging" one-click, plain-words
group verdict, download receipts, deep a11y pass to 0 axe violations.

Fix batch 4 (commit e1662f2, post-measurement — **measured by round 3**,
see top of this file): finding detail leads with the failing check and a
latest-evidence hero (failing-step screenshot, deep link to the step;
promotes now pin the step server-side); findings reconcile against the
story's latest run (still failing / passing now / not re-run, on list and
detail); "Copy for tracker" gives the promote flow its external handoff
(and accepted-but-unexported findings say where the ref comes from); red
runs state the failing check in a strip above the replay with "Copy
failure summary".

---

# Round 1 report (2026-07-06/07, pre-fixes)

Run 2026-07-06/07 against the hosted control plane (`packages/platform/control-plane` + `packages/platform/web/src`,
dev auth, seeded `todos` project via `studies/hosted-ux/seed.mjs`). 8 usable
trajectories across 7 stories; scores 52–94; one give-up. Run dirs:
`runs/2026-07-06T1624-d83a` (batch 1), `runs/2026-07-07T2226-c0df` (orient),
`runs/2026-07-07T2254-654e` (batch 2). View any cited run with `playtest view`.

**Not yet run:** `launch-and-follow` (2 personas) — first attempt died to LLM
quota exhaustion (429s), not UX. Re-run when the Codex quota window resets; the
local-dispatch launch path itself is verified end-to-end (API-level: group →
runner-agent → 2× pass).

Grader note: all runs graded by gpt-5.5 via the codex gateway (model pins are
cosmetic behind it).

## Headline: entry is excellent, **evidence is one click too far, and actions
don't confirm** — the triage journey dies at both.

Every persona entered the product correctly on the first click (Needs
attention is doing exactly its job). What broke them was the middle and the
end: rows that look like data but aren't doors, and actions that complete
without proof. The one give-up of the study (`triage-finding@triaging-dev`,
score 52) is the composite of every other run's friction.

## The give-up, dissected (primary data)

`runs/2026-07-07T2254-654e/triage-finding@triaging-dev` — 17 steps, ~9 dead
ends, gave up with a real bug confirmed and undeliverable:

1. Found the claim in Findings immediately — then couldn't open it: "the row
   itself is not exposed to me as a clickable control" (step 3,
   `steps/003.png`). Neither title nor the Evidence count links anywhere.
2. Tried Review, expecting a triage queue — found "changed journeys" with an
   unrelated accepted item (steps 5–6, `steps/005.png`).
3. Tried Runs (plain-text rows, step 7), then global search — which "cleared
   and dropped me back at Suites" (steps 8–9).
4. Manually recovered the evidence via suite → story → history → red run
   (steps 10–12, `steps/012.png`) — a four-hop path the finding row should
   have been.
5. Clicked Promote on the run toolbar; the dialog closed with **no toast, no
   ticket link, no status change** — and Findings then showed a "just-now
   duplicate-sounding finding" (steps 13–15, `steps/014.png`).
6. Verbatim give-up (step 17): *"At this point I have a real product bug, but
   I can't see a way to complete or verify the tracker handoff."*

Two distinct product defects compound here: (a) findings are not openable
where they live, and (b) Promote has no completion contract — and appears to
create a duplicate finding rather than linking the existing one (check
`promote-finding` server-side: likely a functional bug, not just missing UI).

## Report questions, answered across personas

### Orientation & mental model (orient-first-session, 74)

The persona built the *right* mental model (record/replay journeys, gate
checks, findings, healed changes for review) from Needs attention, Gate,
Findings, Review, Suites, Audit. Where it broke: **"expected each label to
contain its natural evidence"** — Findings didn't expose artifacts, Review
didn't justify healing, Insights didn't open reports, Runs didn't behave like
an audit trail (`runs/2026-07-07T2226-c0df/…/steps/004.png`). Settings→Audit
ended up being the de-facto governance view (step 21). Adoption verdict:
supervised CI signal only; the single change that would most move it: *"a
consolidated evidence view … inspectable from the first failed check."*

### Explain a red run (2 personas, both 94 — the product's best journey)

Home → Needs attention → run detail → Gate panel, 2 steps, zero wrong turns,
both personas; both quoted the exact criterion ("expected `1 item left`, saw
`2 items left`"). Two consistent minors: the decisive Gate text is visually
secondary to the replay/toolbar, and there's no share/copy-failure-summary
affordance for the handoff both stories imply
(`runs/2026-07-06T1624-d83a/explain-red-run@triaging-dev/steps/002.png`).

### What to fix next (fix-next-from-insights, 84)

**Insights never participated.** The persona assembled the answer from Needs
attention + failed run + Findings and never visited the screen built for the
question. Findings rows again dead-ended: "the rows look like plain table text
rather than clickable evidence"
(`runs/2026-07-06T1624-d83a/fix-next-from-insights@pm-storyteller/steps/003.png`).

### Author a story in the form (author-story-form, 88 — second-best journey)

Clean linear path, zero wasted steps, high save-confidence (new row + "record"
next-run status told them it took). Two things to fix: the suite *dashboard*
offers no add-a-check entry ("+ New suite" is the loud action; the persona had
to infer adding lives inside a suite, `…/author-story-form@pm-storyteller/steps/001.png`),
and developer jargon leaks into the plain-language path ("assert", "YAML",
"file path", "Commit note", "Save commit").

### Change an environment secret (change-environment-secret, 76)

The concept landed (write-only secrets read as a security feature; Audit gave
the right confirmation). Two majors:
- **Environment cards/editor render `secret_env` as raw JSON, exposing the
  token before *and after* rotation** — "the Environments list is exposing the
  raw value inline" (`…/change-environment-secret@setup-dev/steps/005.png`).
- **No guidance for wiring env → secret**: no picker, no `$secret` syntax
  help, no validation; the persona *guessed* `{"$secret": "staging-seed-token"}`
  by analogy with `$session` and worried the guess "could have broken
  tonight's checks" (`steps/014.png`).
Also: the existing secret row offers only Delete — rotation had to be
attempted through "Add secret" with the same name.

### Review a changed journey (review-changed-journey, 78)

Entry and the accept flow both worked (confirmation modal; row flips to
"accepted by Dev Admin · just now"). The major: **"open full diff in viewer"
landed on step-1 stills with no divergence and no accept/reject controls**,
and the round-trip collapsed the review row the persona had expanded
(`…/review-changed-journey@reviewer/steps/004.png`). The inline diff — not the
dedicated viewer — carried the decision. Same defect family as the viewer
study's undiscoverable Diff tab.

## Cross-cutting findings (by convergence)

1. **Dead rows: Findings / Runs / Insights / Dispatches render as plain text
   with no drill-in** — 4 runs, 3 personas, 2 majors + the give-up. Every
   persona who touched evidence hit it. The single highest-leverage fix.
2. **Actions without receipts** — Promote closes silently (+ likely duplicate
   finding); no share/handoff affordance on run detail (3 runs). The give-up
   trigger.
3. **Review is mis-modeled by users** — expected: triage queue / healing
   justification; actual: changed-journeys list with no rationale for why a
   heal is safe (2 hosted runs + all 4 viewer-ux judge runs point at the same
   hole from the other side).
4. **"Open full diff in viewer" misroutes** — 2 runs (review-changed, orient):
   subordinate link, lands on step 1, loses context on return.
5. **Global search dead-ends to Suites with no result list** — 2 runs.
6. **Secrets exposure + no `$secret` affordance** — 1 run, 2 majors, and it's
   a security-perception issue, so weight above its convergence count.
7. **Needs attention is the product's spine — keep it** — 6 of 8 runs entered
   through it and none regretted it.
8. **A11y contrast violations on every step of every run** (93–300 per run;
   plus unnamed selects/links). Personas navigate by scanning red/green;
   contrast is functional here.

## Suggested fix batch (see also /tmp/pt-ux-my-findings.md merge)

1. Make every evidence row a real link: Findings rows → finding detail with
   evidence deep-links; Runs rows → group page (already clickable — but style
   them as links so they read as doors); Insights rows → report view.
2. Give Promote a completion contract (toast + link to the created/linked
   finding; fix the duplicate), and add "Copy failure summary" on run detail.
3. Reframe Review: label it for what it holds ("Changed journeys"), show the
   heal rationale (old selector → new selector + why), and link it from the
   places personas hunted (finding rows, run toolbar).
4. Fix the "full diff" link target (land on the divergent step with the diff
   tab active) and preserve review-row expansion on return.
5. Environments: mask `secret_env` values, add `$secret` reference helper.
6. Search: show a results view or drop the affordance.
7. Contrast pass over tokens shared by app + viewer.
