# Hill-climb matrix

## Detection matrix

| fault | adversarial-tester | cautious-first-timer | gift-rusher | returning-regular | weekend-browser |
| --- | ---: | ---: | ---: | ---: | ---: |
| f-account-error-swallowed | 2 | 0 | 0 | 0 | 0 |
| f-account-form-resets | 0 | 0 | 0 | 0 | 0 |
| f-add-cart-silent | 0 | 11 | 4 | 5 | 8 |
| f-cant-buy-last-unit | 2 | 0 | 0 | 0 | 0 |
| f-card-spaces-validation | 2 | 0 | 0 | 0 | 0 |
| f-cart-continue-removed | 2 | 0 | 0 | 0 | 0 |
| f-checkout-empty-guard-gone | 2 | 0 | 0 | 0 | 0 |
| f-clear-search-self-link | 2 | 0 | 0 | 0 | 0 |
| f-continue-shopping-loop | 2 | 0 | 0 | 0 | 0 |
| f-decline-swallowed | 0 | 2 | 3 | 0 | 0 |
| f-empty-cart-jargon | 0 | 0 | 0 | 1 | 1 |
| f-error-text-contrast | 0 | 1 | 1 | 1 | 0 |
| f-free-shipping-label | 0 | 2 | 1 | 0 | 1 |
| f-no-results-jargon | 2 | 0 | 0 | 0 | 0 |
| f-oos-says-in-stock | 2 | 0 | 0 | 0 | 0 |
| f-order-history-removed | 0 | 0 | 0 | 6 | 0 |
| f-place-order-no-feedback | 0 | 2 | 1 | 0 | 3 |
| f-postcode-validation | 1 | 6 | 3 | 6 | 4 |
| f-price-contrast | 0 | 10 | 3 | 6 | 8 |
| f-product-crumb-removed | 0 | 0 | 0 | 0 | 1 |
| f-qty-edit-removed | 0 | 6 | 1 | 3 | 7 |
| f-receipt-eta-wrong | 0 | 0 | 0 | 0 | 0 |
| f-save-profile-dead | 0 | 5 | 0 | 3 | 0 |
| f-search-removed | 2 | 0 | 3 | 1 | 1 |
| f-sort-inert | 2 | 0 | 0 | 0 | 0 |
| f-validation-wipes-payment | 0 | 7 | 5 | 6 | 3 |

## Arms

| arm | clean-def | rounds-to-clean | cost-per-detected-fault | detected | fixed-w/o-detect | residual | emergent | soft-ux | spec-gap | subject-quirk | harness-artifact |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | v1 |  | 1.1661279769230768 | 13 | 0 | 26 | 0 | 0 | 0 | 0 | 0 |
| naive | v1 | 2 |  | 0 | 16 | 10 | 11 | 0 | 0 | 0 | 0 |
| policy | v1 | 3 | 12.763337250000001 | 1 | 19 | 6 | 0 | 0 | 0 | 0 | 0 |
| shakedown | v1 |  |  | 0 | 0 | 26 | 1 | 0 | 0 | 0 | 0 |
| v2-baseline | v2 |  | 0.285729 | 21 | 0 | 26 | 0 | 25 | 0 | 0 | 1 |

