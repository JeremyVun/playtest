# Instrument v2 detection re-measure — round 02 (post-study pins)

**Arm:** `v2-baseline` · **Round:** 02 · **Ledger:** `studies/hillclimb/ledger/v2-baseline/round-02.json`  
**Suite freeze:** `f878d7e` (MATRIX-v2 stories/personas)  
**Harness pins (instrument change vs r01):** `prompts_version: prompts-v8`, `step_schema_version: 7`, actor **raises[]** (`confusion`|`finding`) live on trajectories  
**App:** all 26 faults re-injected into `arms/naive` (hash `59f593405bcf…`, same as r01)  
**Actor / grader / gateway:** `grok-4.5` / `gpt5_5` / `http://127.0.0.1:8900`  
**Cells:** 28 explored (15 trunk + 13 risk) · **Cost:** ≈ **$2.83** all-in · **Steps:** 418  

One INFRA cell (`outfit-a-shelf@weekend-browser`, LLM 500×4) re-queued and explored under `2026-07-14T1212-ebcc`. Shard B exclusion note records the failed attempt.

Adjudication uses ledger verdicts with DESIGN.md §3.2 labels in rationales. Catalog detection = unique `true-positive` fault ids. Judgments were **manually curated** against catalog oracles (auto keyword draft over-counted and was discarded for TPs).

**Clean definition (P3):** v2 arm → clean ⇔ zero seeded-tp, zero emergent, zero new-real-issue, regressions green. This baseline inject has seeded-tp > 0 → `clean_round: false` (expected).

---

## Headline

| Instrument | Detected | Recall |
|---|---|---|
| **v1** (gpt5_4_mini, :8899, trunk-only) | **14 / 26** | **54%** |
| **v2 r01** (grok-4.5, :8900, MATRIX-v2) | **19 / 26** | **73%** |
| **v2 r02** (same suite + prompts-v8 / raises) | **21 / 26** | **81%** |

**+2 faults** vs r01; **+7** vs v1. Decision-gate band: **≥75% → success for detection re-measure** (BUILD_PLAN P2 preferred band was 60–74% “inspect”; crossing 75% clears the upper gate).

No climb on this arm → **fixed-without-detection = 0**.

---

## Accounting split (v2-baseline r02) — not one “FP” dump

| Bucket | Count | Notes |
|---|---|---|
| **Detected** (catalog TP, distinct faults) | **21** | 21/26 recall |
| **Fixed without detection** | **0** | Detection-only re-measure |
| **Residual live** | **5** | Misses below |
| **Emergent** | **0** | No climb / no fix-induced bugs |
| **soft-ux** | 9 | Prominence / fold / taste |
| **spec-gap** | 0 | — |
| **subject-quirk** | 0 | — |
| **harness-artifact** | 0 | (none tagged this round) |
| **false** | 146 | Non-catalog claims / noise under schema FP verdict |

---

## Recall by level (v2-baseline r02)

| Level | Found / total | Rate |
|---|---|---|
| L1 | 5 / 7 | 71% |
| L2 | 7 / 8 | 88% |
| L3 | 5 / 6 | 83% |
| L4 | 4 / 5 | 80% |
| **All** | **21 / 26** | **81%** |

---

## Per-fault side-by-side (v1 · r01 · r02)

| Fault | L | v1 | r01 | r02 | First r02 cell (if hit) |
|---|---|---|---|---|---|
| `f-price-contrast` | L1 | Y | Y | **Y** | `first-impressions@cautious-first-timer` |
| `f-error-text-contrast` | L1 | Y | n | **n** | — |
| `f-oos-says-in-stock` | L1 | n | Y | **Y** | `risk/risk-oos-copy@adversarial-tester` |
| `f-free-shipping-label` | L1 | Y | Y | **Y** | `first-impressions@cautious-first-timer` |
| `f-receipt-eta-wrong` | L1 | n | n | **n** | — (order history still masks) |
| `f-empty-cart-jargon` | L1 | Y | n | **Y** | `wheres-my-order@returning-regular` |
| `f-no-results-jargon` | L1 | n | Y | **Y** | `risk/risk-no-results-clear@adversarial-tester` |
| `f-sort-inert` | L2 | n | Y | **Y** | `risk/risk-sort-order@adversarial-tester` |
| `f-save-profile-dead` | L2 | Y | Y | **Y** | `moving-house@cautious-first-timer` |
| `f-add-cart-silent` | L2 | Y | Y | **Y** | `buy-a-specific-gift@cautious-first-timer` |
| `f-place-order-no-feedback` | L2 | Y | n | **n** | — |
| `f-postcode-validation` | L2 | Y | Y | **Y** | `risk/risk-card-unspaced@adversarial-tester` |
| `f-card-spaces-validation` | L2 | n | Y | **Y** | `risk/risk-card-unspaced@adversarial-tester` |
| `f-decline-swallowed` | L2 | Y | n | **Y** | `checkout-hiccup@gift-rusher` |
| `f-account-error-swallowed` | L2 | n | Y | **Y** | `risk/risk-invalid-email@adversarial-tester` |
| `f-validation-wipes-payment` | L3 | Y | Y | **Y** | `checkout-hiccup@gift-rusher` |
| `f-account-form-resets` | L3 | n | n | **n** | — (invalid email **kept** fields) |
| `f-continue-shopping-loop` | L3 | n | Y | **Y** | `risk/risk-receipt-continue@adversarial-tester` |
| `f-clear-search-self-link` | L3 | n | Y | **Y** | `risk/risk-no-results-clear@adversarial-tester` |
| `f-cant-buy-last-unit` | L3 | n | Y | **Y** | `risk/risk-last-unit@adversarial-tester` |
| `f-checkout-empty-guard-gone` | L3 | n | Y | **Y** | `risk/risk-empty-checkout@adversarial-tester` |
| `f-search-removed` | L4 | Y | Y | **Y** | `risk/risk-no-results-clear@adversarial-tester` |
| `f-qty-edit-removed` | L4 | Y | Y | **Y** | `outfit-a-shelf@returning-regular` |
| `f-order-history-removed` | L4 | Y | Y | **Y** | `wheres-my-order@returning-regular` |
| `f-product-crumb-removed` | L4 | Y | n | **n** | — |
| `f-cart-continue-removed` | L4 | n | Y | **Y** | `risk/risk-cart-local-continue@adversarial-tester` |

**New vs r01 (2):** `f-empty-cart-jargon`, `f-decline-swallowed`.  
**Regressions vs r01:** none.  
**Still silent (5):** error-text contrast as distinct claim; receipt ETA (masked); place-order feedback; account form reset (opposite manifestation on invalid email); product crumb.

---

## Residual misses (5)

| Fault | Why still silent |
|---|---|
| `f-error-text-contrast` | Axe contrast lumped as general contrast; no distinct “error text unreadable” claim |
| `f-receipt-eta-wrong` | Masked by missing order history; risk cells could not open shipped/delivered receipts |
| `f-place-order-no-feedback` | Successful place-order path rarely completed cleanly enough to observe missing spinner/progress |
| `f-account-form-resets` | Invalid email **kept** field values (error swallowed); form-reset seed not observed |
| `f-product-crumb-removed` | No finding claimed missing product breadcrumb |

---

## Ops notes

- 3 Playwright shards (ports 4183–4185), ≤3 concurrency; `nohup` launchers (avoids prior SIGPIPE loss).
- Wall-clock ~52 min main wave + ~6 min INFRA re-queue.
- Raises active: e.g. multi sticky findings on free-shipping / silent cart / demo-shop disclaimer.
- Grok cost still reported as priced where gateway provides usage; totals ~$2.83 (r01 ~$3.17).
- Preflight: `repo_dirty: true` (expected for prompts-v8/raises worktree); fault hash matched inject.
- Lint-evidence OK for r02 ledger against `/tmp/hillclimb-r02/runs` (symlinked into `runs/`).

---

## Decision

**81%** → **≥75% detection gate cleared** under MATRIX-v2 + post-study harness pins.

Suggested next (human):

1. Optional: policy climb (P4) from a fresh full inject — prior climb was abandoned after fixes when Grok auth died; auth is green now.
2. Residual 5 are mostly coverage/masking/recognition class — not worth thrashing stories before climb or targeted P5 recognition work.
3. Do **not** claim r02 is identical instrument to r01 freeze-only; ledger amendment documents prompts-v8/raises.

---

*Ledger path: `studies/hillclimb/ledger/v2-baseline/round-02.json`. Matrix: bench `matrix.mjs` over full `ledger/`.*
