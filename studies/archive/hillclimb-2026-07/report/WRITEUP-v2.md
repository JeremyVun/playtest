# Instrument v2 detection re-measure (BUILD_PLAN P2)

**Arm:** `v2-baseline` · **Round:** 01 · **Ledger:** `studies/hillclimb/ledger/v2-baseline/round-01.json`  
**Instrument freeze:** `f878d7e` (MATRIX-v2, `suite/playtest.yaml`)  
**App:** all 26 faults re-injected into `arms/naive` (hash `59f593405bcf…`)  
**Actor / grader / gateway:** `grok-4.5` / `gpt5_5` / `http://127.0.0.1:8900`  
**Cells:** 28 (15 trunk + 13 risk) · **Cost:** ≈ **$3.17** all-in · **Steps:** 414

Adjudication uses ledger verdicts (`true-positive` / `false-positive` / `duplicate-of`) with DESIGN.md §3.2 labels in rationales (`[seeded-tp]`, `[soft-ux]`, `[spec-gap]`, `[subject-quirk]`, `[harness-artifact]`, `[false]`). Catalog detection = unique `true-positive` fault ids.

**Clean definition (P3):** instrument-v2 arms use DESIGN.md §6 — clean ⇔ zero seeded-tp, zero emergent, zero new-real-issue, regressions green. First-study ledgers (`baseline` / `naive` / `policy` / `shakedown`) keep their original `clean_round` flags under the **v1** gate (emergent not counted); those flags are **not** retro-rewritten. Matrix/`computeCleanRound` is arm-aware so both stay valid.

---

## Headline

| Instrument | Detected | Recall |
|---|---|---|
| **v1** (gpt5_4_mini, gateway :8899, trunk-only matrix) | **14 / 26** | **54%** |
| **v2** (grok-4.5, :8900, trunk + forced-risk + adversarial) | **19 / 26** | **73%** |

**+5 faults** net vs v1 study headline. Decision-gate band (**60–74%**): inspect remaining misses; do not thrash stories before targeted risk/grader work.

One ledgered round only (exit gate is ≥1; second stability round not run). No climb yet → **fixed-without-detection = 0**.

---

## Accounting split (v2-baseline r01) — not one “FP” dump

Catalog and product-signal rows are separate (DESIGN §3.2 / BUILD_PLAN P3). Numbers from matrix `accounting_summary` + per-round `label_counts` on the ledgered round:

| Bucket | Count | Notes |
|---|---|---|
| **Detected** (catalog TP, distinct faults) | **19** | 19/26 recall |
| **Fixed without detection** | **0** | No P4 climb; no fixer commits on this arm |
| **Residual live** | **7** | Misses listed below |
| **Emergent** | **0** | No fix-induced regressions (baseline re-measure only) |
| **soft-ux** | 16 | Prominence / fold / taste — not catalog FPs |
| **spec-gap** | 0 | (none tagged this round) |
| **subject-quirk** | 0 | (none tagged; latent quirks still documented in DESIGN §3.3) |
| **harness-artifact** | 1 | Toast/timing class |
| **false** | 212 | Claim contradicted or out of catalog measurement without a richer tag |

`false-positive` **verdicts** still hold most non-TP rows for ledger schema compatibility; the **label** column is what the write-up uses. Do not report a single “~N FPs” as the product story.

Round `clean_round: false` under the **v2** definition because seeded-tp > 0 (expected on a fully injected baseline).

---

## Recall by level (v2-baseline r01)

| Level | Found / total | Rate |
|---|---|---|
| L1 | 4 / 7 | 57% |
| L2 | 6 / 8 | 75% |
| L3 | 5 / 6 | 83% |
| L4 | 4 / 5 | 80% |
| **All** | **19 / 26** | **73%** |

---

## Per-fault side-by-side

| Fault | L | v1 | v2 | First v2 cell (if new or still hit) |
|---|---|---|---|---|
| `f-price-contrast` | L1 | Y | Y | `first-impressions@cautious-first-timer` |
| `f-error-text-contrast` | L1 | Y | **n** | — |
| `f-oos-says-in-stock` | L1 | n | **Y** | `risk/risk-oos-copy@adversarial-tester` |
| `f-free-shipping-label` | L1 | Y | Y | `first-impressions@weekend-browser` |
| `f-receipt-eta-wrong` | L1 | n | **n** | — (order history still blocks past receipts) |
| `f-empty-cart-jargon` | L1 | Y | **n** | — |
| `f-no-results-jargon` | L1 | n | **Y** | `risk/risk-no-results-clear@adversarial-tester` |
| `f-sort-inert` | L2 | n | **Y** | `risk/risk-sort-order@adversarial-tester` |
| `f-save-profile-dead` | L2 | Y | Y | `moving-house@cautious-first-timer` |
| `f-add-cart-silent` | L2 | Y | Y | `buy-a-specific-gift@cautious-first-timer` |
| `f-place-order-no-feedback` | L2 | Y | **n** | — (few successful submits to observe) |
| `f-postcode-validation` | L2 | Y | Y | `moving-house@cautious-first-timer` |
| `f-card-spaces-validation` | L2 | n | **Y** | `risk/risk-card-unspaced@adversarial-tester` |
| `f-decline-swallowed` | L2 | Y | **n** | — (decline path not forced in matrix) |
| `f-account-error-swallowed` | L2 | n | **Y** | `risk/risk-invalid-email@adversarial-tester` |
| `f-validation-wipes-payment` | L3 | Y | Y | `moving-house@cautious-first-timer` |
| `f-account-form-resets` | L3 | n | **n** | — (invalid email kept fields; opposite of reset) |
| `f-continue-shopping-loop` | L3 | n | **Y** | `risk/risk-receipt-continue@adversarial-tester` |
| `f-clear-search-self-link` | L3 | n | **Y** | `risk/risk-no-results-clear@adversarial-tester` |
| `f-cant-buy-last-unit` | L3 | n | **Y** | `risk/risk-last-unit@adversarial-tester` |
| `f-checkout-empty-guard-gone` | L3 | n | **Y** | `risk/risk-empty-checkout@adversarial-tester` |
| `f-search-removed` | L4 | Y | Y | `risk/risk-no-results-clear@adversarial-tester` |
| `f-qty-edit-removed` | L4 | Y | Y | `checkout-hiccup@gift-rusher` |
| `f-order-history-removed` | L4 | Y | Y | `wheres-my-order@returning-regular` |
| `f-product-crumb-removed` | L4 | Y | **n** | — |
| `f-cart-continue-removed` | L4 | n | **Y** | `risk/risk-cart-local-continue@adversarial-tester` |

**New detections (10):** almost all from forced-risk × adversarial cells (coverage class in DESIGN §1).  
**Regressions vs v1 (5):** mostly recognition / unforced paths (decline, place-order feedback, product crumb, empty-cart jargon, error-text contrast as a distinct claim).

---

## Residual misses (7)

| Fault | Why still silent |
|---|---|
| `f-error-text-contrast` | Axe contrast lumped with price contrast; no distinct “error text unreadable” claim |
| `f-receipt-eta-wrong` | Masked by missing order history; risk cells could not open shipped/delivered receipts |
| `f-empty-cart-jargon` | Empty-cart page not forced as a dedicated risk cell |
| `f-place-order-no-feedback` | Actors rarely completed a clean submit that would expose silent place-order |
| `f-decline-swallowed` | Declined-card path not in MATRIX-v2 force set |
| `f-account-form-resets` | Invalid email **kept** fields (error swallowed instead); form-reset seed not observed |
| `f-product-crumb-removed` | No finding claimed missing product breadcrumb |

---

## Ops notes

- Round run as 3 shards then residual re-queue after SIGPIPE killed early shard shells (launcher without `nohup`). Prefer `nohup … >log 2>&1` for future multi-hour shards.
- Interrupted partial case dirs excluded at collect; final ledger has **28 explored** cells only.
- Manifestation tests green for all 26 faults on re-injected naive arm before the round.
- Bench: `v2-baseline` added to arm enum / ledger schema so `adjudicate` / `matrix` / `lint-evidence` accept the arm.

---

## Decision (BUILD_PLAN P2 gate)

**73%** → **60–74% band:** success is not yet “≥75% done.” Next steps (human):

1. Thin targeted adds only if cheap: decline-card force, empty-cart jargon force, place-order success path.  
2. Or open P5 harness items for recognition residuals (`expectation_held`, grader contradiction) before more story thrash.  
3. Optional second stability round under the same freeze before P4 climb.

P3 (clean definition / accounting taxonomy) landed: bench `computeCleanRound` is arm-aware (v2 includes emergent); matrix/site expose the split summary; v1 clean flags left frozen.
