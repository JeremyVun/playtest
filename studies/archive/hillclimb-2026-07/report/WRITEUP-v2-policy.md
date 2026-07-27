# Instrument v2 policy climb (BUILD_PLAN P4)

**Arm:** `v2-policy`  
**Instrument:** MATRIX-v2 freeze `f878d7e` (Grok actor + forced risk + adversarial)  
**Start app_hash (full inject):** `59f593405bcf…` (byte-identical to v2-baseline)  
**Post-fix app_hash:** `ad77d7f87861…`  
**Workspace:** `studies/hillclimb/arms/v2-policy-workspace/`  
**Regression pins:** `studies/hillclimb/arms/v2-policy-regression/` (14 stories, forced preconditions)

---

## Outcome

**Climb abandoned after the fix phase — live clean rounds not ledgered.**

| Gate | Result |
|---|---|
| Pick policy arm | Done (`v2-policy`) |
| Blind fixer from findings only | Done (fresh-context fixer; findings pack from v2-baseline r01; no catalog access) |
| Pin regression per fix | Done (14 stories under `v2-policy-regression/`) |
| Two consecutive clean rounds (P3 / v2 clean def) | **Not run** — blocked by infra |
| Residuals named | Done (below) |
| Detection vs repair-by-inspection split | Done (below) |

### Why abandoned

Ledgered climb rounds require instrument-v2 actor **`grok-4.5`** via gateway `:8900`. During the verification attempt (2026-07-14):

1. Preflight passed (app, fault-set hash, gateway healthz, exclusive-run).
2. Full MATRIX-v2 + regression shard launch failed every cell with **INFRA** (`503` / stream disconnect).
3. Gateway diagnosis: CLIProxy returns `auth_unavailable: no auth available (providers=xai, model=grok-4.5)` for Playtest vision chat-completions (and intermittently for text). xAI OAuth file exists and shows a non-past `expired` timestamp, but the provider path is not usable for harness steps.
4. Control check: same gateway + vision path with **`gpt5_5`** completed a trunk cell successfully (`first-impressions@cautious-first-timer`, 6 steps, score 78). So Playtest + gateway work; **Grok auth does not.**

Re-running the climb on a different actor would break the instrument-v2 freeze and confounds comparison with v2-baseline. Re-auth of xAI OAuth is an operator action outside this repo. **Stop rule not claimed.**

When Grok auth is restored: preflight → MATRIX-v2 (28) + all 14 regression stories → collect → adjudicate under arm `v2-policy` with P3 clean definition; stop at two consecutive `clean_round: true`.

---

## Fix phase (completed)

### Process

1. Re-injected all 26 catalog faults into `arms/v2-policy` (hash match v2-baseline).
2. Built blind findings pack from v2-baseline r01 (`findings-round-0.md`) — no `fault_id`s.
3. Blind policy fixer produced `BELIEFS.md` (24 fix-now / 7 reject), code edits, `fixes-r1.json` (18 packs), 14 regression YAMLs, `PLAN-r1.md`.
4. Lead mechanical polish (string oracles only, after manifestation recheck): cart continue label `← Continue shopping`; place-order button text `Placing your order…` (behavior already present under slightly different copy).

### Manifestation residual (offline ground truth)

| Measure | Count |
|---|---|
| Catalog faults | 26 |
| Still live on post-fix arm | **0** |
| Green (absent) | **26** |

Manifestation tests are **not** a substitute for two clean discovery rounds, but they prove the seeded catalog is gone from the arm tree.

---

## Accounting: detection vs repair-by-inspection

Baseline of record: **v2-baseline r01** detection **19/26 (73%)**.  
All 26 faults are fixed on the climbed arm (manifestation). Split:

### Detected then fixed (19)

Faults with ≥1 `true-positive` in v2-baseline r01, repaired in the fix phase:

`f-account-error-swallowed`, `f-add-cart-silent`, `f-cant-buy-last-unit`, `f-card-spaces-validation`, `f-cart-continue-removed`, `f-checkout-empty-guard-gone`, `f-clear-search-self-link`, `f-continue-shopping-loop`, `f-free-shipping-label`, `f-no-results-jargon`, `f-oos-says-in-stock`, `f-order-history-removed`, `f-postcode-validation`, `f-price-contrast`, `f-qty-edit-removed`, `f-save-profile-dead`, `f-search-removed`, `f-sort-inert`, `f-validation-wipes-payment`

### Fixed without detection (7)

v2-baseline **misses** closed by the policy fixer via class-generalization / SPEC+code inspection (not counted as Playtest detection — DESIGN / BUILD_PLAN non-work):

| Fault | How it got fixed without a TP |
|---|---|
| `f-error-text-contrast` | Same contrast pack as price contrast / axe notes (belief #24) |
| `f-receipt-eta-wrong` | Unblocked by restoring order history + status-aware ETA (beliefs #17, #23) |
| `f-empty-cart-jargon` | Class-generalize with empty-state jargon while fixing empty cart/checkout (belief #20) |
| `f-place-order-no-feedback` | Bundled with decline/error banner + in-progress place-order (belief #14) |
| `f-decline-swallowed` | Same pack as place-order feedback (belief #14) |
| `f-account-form-resets` | Class-generalize with save-profile / email validation fix (beliefs #15–#16) |
| `f-product-crumb-removed` | Proactive SPEC C2.4 crumb (belief #22) |

### Residual live

**None** (manifestation). Soft-ux / out-of-SPEC rejects (trust pages, demo footer, listing-card add, etc.) intentionally unfixed — not catalog residuals.

### Emergent

**Unknown** without a live discovery round after the fix. No ledgered emergent count.

---

## Bench / contract scaffolding (landed)

- Arm enum: `v2-policy` in `bench/lib/contracts.mjs` + `ledger.schema.json` (v2 clean definition).
- Tests updated (`cleanDefinitionForArm('v2-policy') === 'v2'`).
- No core Playtest contract change (study-local).

---

## Operator resume checklist

```bash
# 1) Restore Grok via CLIProxy xAI login (sibling codex-gateway README)
# 2) Confirm: chat + vision complete against model grok-4.5 on :8900
export PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8900
export PLAYTEST_LLM_API_KEY=subscription
export PLAYTEST_LLM_TIMEOUT_MS=185000

PORT=4183 node studies/hillclimb/arms/v2-policy/server.js
node studies/hillclimb/bench/preflight.mjs --arm v2-policy --round 1 \
  --app-dir studies/hillclimb/arms/v2-policy \
  --base-url http://127.0.0.1:4183 --gateway http://127.0.0.1:8900 \
  --gateway-log "$HOME/Library/Logs/codex-gateway.error.log" \
  --out /tmp/v2-policy-r01-fp.json

# MATRIX-v2 (28) + v2-policy-regression (14); ≤3 shards
# collect → adjudicate → lint-evidence → matrix
# Stop: two consecutive clean_round under v2 definition
```

---

## Decision vs P2 gate

P2 left the study in the **60–74%** band (73%). P4 policy climb was optional for the detection goal. This phase:

- **Does** show policy-style repair can clear the full catalog from v2 findings + SPEC (including 7 never-detected faults).
- **Does not** claim two clean discovery rounds or a new detection number (detection stays the v2-baseline 19/26).
- **Does not** promote product extract (P5) — that remains gated on lasting product value of adversarial / harness bits.
