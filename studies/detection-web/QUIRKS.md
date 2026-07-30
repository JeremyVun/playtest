# Accepted quirks — G4 adjudication (2026-07-30)

Known latent defects in the **clean** subject, discovered independently by
both arms during the clean-subject shakedown rounds and verified by the lead
on the clean reference. Adjudication: **accepted as latents, no subject
rework** — the subject froze at G1, the catalog's patch anchors depend on the
frozen source, and "latent found" is a pre-registered headline metric whose
bar (reproduces on the clean reference + violates SPEC/reasonable
expectation) these meet. The judge is never shown this list; its
classification pass independently verifies latent claims against the clean
reference at :4622.

| id | Behavior (clean subject) | SPEC ruling | Verified |
|---|---|---|---|
| Q1 | New-loan step 1: after a rejected submit, correcting the email to a valid `…@fairmont.edu` and resubmitting leaves `Must be a fairmont.edu address.` under the now-valid field (name error clears correctly; department error correctly remains) | Violates §1.6 "Fields that are now acceptable have their message cleared" | Browser repro, 2026-07-30 |
| Q2 | New-loan step 2: requesting more units than available produces no visible error message (the Units spinbutton appears to clamp/ignore silently) | §7.2 promises a specific availability message; silent refusal violates the visible-error rule | Browser repro (partial — clamping mechanics not fully pinned) |
| Q3 | New-loan step 2: a pickup date outside the allowed window (e.g. 2026-04-15) shows the stale `The desk is closed at weekends. Choose a weekday.` message instead of a date-range message | Wrong message for the actual violation; §7.2/§1.6 | Browser repro, 2026-07-30 |

Expected consequence for measured rounds: both arms are likely to re-report
some of Q1–Q3 each trial; the judge should classify them `latent` (they
reproduce on clean). They are not in the fault catalog and credit no seeded
fault. Recurrence across rounds is deduplicated by each arm's own mechanism
(arm P: findings consolidation; arm C: judge normalization marking repeats).
