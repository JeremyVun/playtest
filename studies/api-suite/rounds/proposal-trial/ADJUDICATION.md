# Proposal-trial adjudication — 2026-07-26

Adjudicator: the study maintainer (orchestrating session), per
`PREREGISTRATION.md` §7.3. Reference: the frozen statement handout
(`../../INVARIANTS.md`), the served OpenAPI document, the fixture's clean-build
behavior verified by hand where a card rested on observation. Phase-1
submission: `PROPOSALS.md` in the trial scratch directory (8 cards, 42 of 60
observation requests).

Clock: adjudication proper took **21 minutes** wall (card checks below). The
card 8 verification additionally triggered ~25 minutes of instrument
maintenance (reproducing and fixing a real fixture defect, commit `12cba1d`,
and re-sealing fallout) — that is recorded as instrument time, not
adjudication time, and is a tuning-log row.

| # | Card | Decision | Time | Basis |
|---|---|---|---|---|
| 1 | `fee-schedule` | **approve** | 3 min | Formula, rounding (half away from zero: `floor(v+0.5)`), charged-on-top, per-currency fee account all confirmed against the spec extensions and reference rule 2. The card's `amount=1000 → 27` worked example is correct. |
| 2 | `ledger-arithmetic` | **approve** | 3 min | Reference rules 12 (balance agreement) + 1 (conservation) merged into one card, accurately: three entries summing to zero, deposit exception, canceled/failed write nothing, no-intervening-write reading condition. |
| 3 | `ownership` | **approve** | 3 min | Reference rule 6, including all three declared exceptions (fee accounts readable/actable-by-none, destination need not be owned, transfer visible from either side) and admin-only `owner_principal`. Its observed 404-before-403 note is consistent with reference rule 11's split. |
| 4 | `lifecycle-legality` | **approve** | 2 min | Reference rule 4 with the correct status mapping (409 state, 410 tombstone) per rule 11; history-after-closure exception correctly kept. |
| 5 | `idempotency` | **approve** | 2 min | Reference rule 3 including the per-principal scope and the different-body 409 conflict rule. |
| 6 | `settlement` | **approve** | 2 min | Reference rule 5 including `settle_limit` exception, creation order, settle-time re-check, failed-writes-nothing. |
| 7 | `daily-limit` | **approve** | 2 min | Reference rule 10. The card asked for a ruling on whether the fee consumes allowance: it does not — usage counts amounts, not fees (reference rule 10 states this). Ruling recorded on the card as a note. |
| 8 | `pagination-completeness` | **approve** | 4 min | Reference rule 7's completeness half, scoped to quiescent enumerations. The observed anomaly (limit=1 walk over `/accounts` dropping `acc_fee_eur`) reproduced by hand on the clean build — a genuine fixture defect under §6.3's fixture-defect rule, fixed publicly in `12cba1d`. The card's own deny-if-intended hedge is resolved: completeness is intended; the tie-drop was a bug. |

**Denied: none. Edited: none.** Eight of eight approved as written; notes
added to cards 7 (fee excluded from allowance) and 8 (defect confirmed and
fixed; rule stands).

The adjudicated statement set handed to phase 2 is
`INVARIANTS-ADJUDICATED.md` beside this file: the eight cards, restated in
the handout's rule/applies/exceptions shape with the two adjudication notes
folded in, and nothing the trial did not itself propose.

Precision/recall scoring against §9.2 happens at report time, not here; for
the record, the phase-1 submission contained no proposal the adjudicator
found unsupported or harmful, and one card (8) was grounded in a live
anomaly that proved to be a real defect the study's own clean-build
verification had missed.
