# Instrument v2 matrix freeze

**Status:** historical instrument-v2 freeze.
**Do not start a ledgered detection round until the freeze commit exists.**  
**Authority:** case YAML persona lists + this file. Historical ops:
[`../OPERATOR.md`](../OPERATOR.md).

| Pin | Value |
|---|---|
| Suite | `studies/hillclimb/suite/` |
| Mode | `discovery` |
| Actor | `grok-4.5` (pass-through) |
| Grader | `gpt5_5` |
| Gateway | `http://127.0.0.1:8900` |
| App | arm under test on `4183` (+ shards `4184`…), `POST /api/reset` via `reset.mjs` |
| Design record | [`../README.md`](../README.md) |

---

## Persona panel

| Role | Personas | Use |
|---|---|---|
| **Core discovery** | `cautious-first-timer`, `weekend-browser`, `returning-regular` | Trunk stories (same selective lists as v1) |
| **Stress only** | `gift-rusher` | `buy-a-specific-gift`, `checkout-hiccup` only — not a full-matrix persona |
| **Adversarial** | `adversarial-tester` (study-local `personas/adversarial-tester.yaml`) | All forced-risk cells; not promoted to core built-ins until P5 |

---

## Trunk cells (15) — continuity with v1 baseline

Same eight stories and persona fan-out as ledger baseline round-01 (v1).  
Gift-rusher stays only on the two speed/checkout stress stories.

| Cell id |
|---|
| `first-impressions@cautious-first-timer` |
| `first-impressions@weekend-browser` |
| `moving-house@cautious-first-timer` |
| `moving-house@returning-regular` |
| `outfit-a-shelf@returning-regular` |
| `outfit-a-shelf@weekend-browser` |
| `wheres-my-order@returning-regular` |
| `buy-a-specific-gift@cautious-first-timer` |
| `buy-a-specific-gift@gift-rusher` |
| `checkout-hiccup@cautious-first-timer` |
| `checkout-hiccup@gift-rusher` |
| `change-your-mind@weekend-browser` |
| `change-your-mind@cautious-first-timer` |
| `club-order@returning-regular` |
| `club-order@weekend-browser` |

---

## Risk cells (13) — DESIGN.md §4.1 minimum set

Files under `suite/risk/`; case ids are `risk/<story>@<persona>`.  
Every story has `tags: [risk]`. Story text forces the precondition.

| Cell id | Forces | Catalog targets |
|---|---|---|
| `risk/risk-invalid-email@adversarial-tester` | Submit known-bad email on profile | `f-account-error-swallowed`, `f-account-form-resets` |
| `risk/risk-card-unspaced@adversarial-tester` | 16 digits, no spaces | `f-card-spaces-validation` |
| `risk/risk-last-unit@adversarial-tester` | Add full Calathea stock (5), then +1 | `f-cant-buy-last-unit` |
| `risk/risk-empty-checkout@adversarial-tester` | Open `/checkout` with empty cart | `f-checkout-empty-guard-gone` |
| `risk/risk-no-results-clear@adversarial-tester` | Nonce search + Clear the search | `f-no-results-jargon`, `f-clear-search-self-link` |
| `risk/risk-receipt-continue@adversarial-tester` | Order → receipt Continue shopping | `f-continue-shopping-loop` |
| `risk/risk-oos-copy@adversarial-tester` | Fiddle-leaf fig stock line vs button | `f-oos-says-in-stock` |
| `risk/risk-oos-copy@cautious-first-timer` | same (human-like trust reaction) | `f-oos-says-in-stock` |
| `risk/risk-sort-order@adversarial-tester` | First-three prices → sort low-high | `f-sort-inert` |
| `risk/risk-sort-order@cautious-first-timer` | same (re-read discipline) | `f-sort-inert` |
| `risk/risk-cart-local-continue@adversarial-tester` | Cart body continue-shopping path | `f-cart-continue-removed` |
| `risk/risk-receipt-eta@adversarial-tester` | Past shipped/delivered receipt ETA | `f-receipt-eta-wrong` |
| `risk/risk-receipt-eta@cautious-first-timer` | same (status vs copy) | `f-receipt-eta-wrong` |

Adversarial on every risk story; **cautious-first-timer** only on the three recognition-heavy cells (OOS copy, sort order, receipt ETA).

---

## Totals

| Block | Cells |
|---|---|
| Trunk | 15 |
| Risk | 13 |
| **Full MATRIX-v2** | **28** |

Filter helpers:

```bash
# Full freeze matrix (default when running the suite root)
node src/cli/cli.js studies/hillclimb/suite/ --parallel 1

# Risk only
node src/cli/cli.js studies/hillclimb/suite/ --tag risk --parallel 1
```

---

## Cost cap and shard plan

**Concurrency:** ≤ **3** Playwright shards on 24 GB machines (same hard cap as v1; six browsers OOMed on 2026-07-10).

**Rough $ budget (one full baseline-style round):**

| Basis | Estimate |
|---|---|
| v1 baseline (15 cells, `gpt5_4_mini` actor) | ≈ **$7.7** ledgered |
| Per-cell v1 average | ≈ **$0.51** |
| v2 cells | 28 (≈1.87×) |
| Actor tier | Grok 4.5 via gateway; price ≠ mini — budget **1.5–3×** per-cell vs v1 mini until measured |
| **Planning band for one full round** | **~$20–45** all-in (actor + grader); re-forecast after first 3 cells |
| Two stability rounds (P2 prefers 2) | **~$40–90** |

Stop or thin the matrix only via a **ledger amendment** + this file edit after freeze — not mid-round silent cuts.

**Suggested 3-shard split** (one app process per port; disjoint `--id` lists):

| Shard | Port | Cells (examples) |
|---|---|---|
| A | 4183 | 5 trunk + ~4 risk |
| B | 4184 | 5 trunk + ~4 risk |
| C | 4185 | 5 trunk + ~5 risk |

Launch all shards only after a single preflight passes. One run process per app instance — no shared-port cross-contamination.

---

## Explicit non-matrix (do not run as v2 detection)

- Full 4-persona × all stories Cartesian product  
- gift-rusher on non-stress trunk stories  
- adversarial-tester on every trunk story (optional later; not in freeze)  
- Any change to `faults.json` without amendment rules  

---

## Freeze record

| Field | Value |
|---|---|
| Freeze commit | `f878d7efa4aacd599b888d1ed9635337cdeb6717` (`f878d7e`) |
| Role | Same as v1 story freeze before `faults.json` (`87bab35`) — instrument before ledgered detection |
| Result | 21/26 detection in v2 round 2; see `report/WRITEUP-v2-r02.md` |
