# PLAN — verification round after r1 fixes

## Preflight

```bash
node studies/hillclimb/arms/v2-policy-workspace/_hash-app.mjs
# writes app_hash into arms/v2-policy/.fault-set.json and node --checks sources
```

## Discovery (instrument v2)

Re-run the full **MATRIX-v2** discovery matrix (28 cells: trunk + forced-risk)
against `studies/hillclimb/arms/v2-policy/` after `POST /api/reset`, same
actor/grader as round 0 (Grok 4.5 actor, gpt5_5 grader, suite personas).

Expect cart/add/search/sort/OOS/checkout/account/order paths that blocked
round-0 majors to complete; residual majors should only be rejected classes
(trust-policy content, soft-ux) if anything.

## Regression suite (all stories)

Run every story under `studies/hillclimb/arms/v2-policy-regression/stories/`:

1. `cart-edit-and-remove.yaml`
2. `add-to-cart-feedback.yaml`
3. `catalog-search-and-clear.yaml`
4. `catalog-sort.yaml`
5. `oos-stock-honesty.yaml`
6. `empty-checkout-guard.yaml`
7. `checkout-shipping-label.yaml`
8. `checkout-validation-honesty.yaml`
9. `profile-save.yaml`
10. `order-history-and-receipt.yaml`
11. `receipt-continue-shopping.yaml`
12. `buy-full-stock.yaml`
13. `cart-continue-and-empty-copy.yaml`
14. `product-category-back-link.yaml`

Suite config: `studies/hillclimb/arms/v2-policy-regression/playtest.yaml`
(init `./reset.mjs`, base_url `http://127.0.0.1:4183`).

## Gate

- All regression stories: report answers affirmative / no broken controls.
- MATRIX-v2: no recurrence of fixed issue-classes 1–24 from BELIEFS.md.
- If a new major appears, open round-2 beliefs; do not silently expand scope
  past SPEC.
