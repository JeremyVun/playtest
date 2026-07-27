# BELIEFS — v2-policy round 1 (from findings-round-0)

Deduped issue-classes from MATRIX-v2 discovery majors (+ confirming minors).
Evidence ids are finding ids from `findings-round-0.md`. Root causes from
reading `v2-policy/{server,pages,data}.js` against SPEC.md.

| # | Issue-class | Conf | Evidence | Root cause in code | Decision |
|---|---|---|---|---|---|
| 1 | Cart quantity not editable; copy promises updates | high | buy#f4, change-mind×2, checkout-hiccup×2, club-order×2, outfit×2, risk-card-unspaced#f2, first-impressions@weekend#f3 | `pageCart` renders qty as plain `<span>`, no stepper/input (C3.2) | **fix-now** |
| 2 | Remove does nothing | high | buy#f5, change-mind×2, checkout-hiccup×2, club-order, outfit×2, risk-card-unspaced | JS click handler always read `.qty` before remove branch; missing input → TypeError; no stepper UI | **fix-now** (same class as #1) |
| 3 | Add-to-cart silent: no toast, badge stays 0 → duplicate qty | high | buy#f3, change-mind#f2, checkout-hiccup@gift#f1, club-order, outfit×2, risk-last-unit#f3, risk-cart-local#f1 | product submit `.then(cart => {})` empty; never `setCartBadge` / `toast` (C2.3, C7.1) | **fix-now** |
| 4 | Search box missing; Search button no-op | high | risk-no-results#f0–f1, gift-rusher search notes, checkout-hiccup@gift#f0 | catalog form has Sort + submit only; no `name=q` input (C1.2) | **fix-now** |
| 5 | Clear search leaves empty state / keeps `?q=` | high | risk-no-results#f4 | clear link is `catalogHref({ q, … })` — keeps the query | **fix-now** |
| 6 | Empty-results jargon | med | risk-no-results#f5 | copy: “Query returned no product rows…” (C1.5 / C7.2) | **fix-now** |
| 7 | Sort label/URL change but grid order fixed | high | risk-sort-order×2, first-impressions@weekend#f2 | `filteredProducts` skips sort (“temporarily disabled”) (C1.4) | **fix-now** |
| 8 | OOS product says “In stock” while CTA disabled | high | risk-oos-copy×2 | OOS branch stock-line text wrong (C2.2) | **fix-now** |
| 9 | Empty-cart checkout shows live payment form | high | risk-empty-checkout#f1–f3 | `/checkout` falls through with empty cart (C3.4) | **fix-now** |
| 10 | Shipping labeled “Free shipping” while $6 charged | high | change-mind q1, first-impressions@weekend#f4 | checkout summary label (C4.2 honesty) | **fix-now** |
| 11 | Unspaced 16-digit card rejected | high | risk-card-unspaced#f4 | client regex requires `#### #### #### ####`; server already strips spaces (C4.3) | **fix-now** |
| 12 | Postcode must be 5 digits; saved 4-digit rejected | high | moving-house#f2, club-order@weekend#f7, risk-card-unspaced#f3 | client `/^\d{5}$/` vs server presence-only; seed postcode is 4 digits | **fix-now** |
| 13 | Validation wipes card fields | high | moving-house#f3, club-order@weekend q2 | submit clears card/expiry/cvc on any field error (C4.3 “never lost”) | **fix-now** |
| 14 | Decline / order errors silent; no place-order progress | high | checkout-hiccup cells never reached pay; code has empty catch | catch doesn’t set banner; no disabled/in-progress on submit (C4.4) | **fix-now** |
| 15 | Save profile dead; email never persists | high | moving-house×2, risk-invalid-email#f1–f3 | button `type="button"` (no submit); email validator `null`; catch swallows; no signed-in update (C6.1) | **fix-now** |
| 16 | Account validation resets fields | med | risk-invalid-email (kept values after invalid — mixed); code resets on client fail | on bad client validation, form resets to defaults | **fix-now** (class-generalize with #15) |
| 17 | Order history absent; past receipts unreachable | high | wheres-my-order×, risk-receipt-eta× | account builds `rows` but body omits orders section (C6.3, C5.3) | **fix-now** |
| 18 | Receipt “Continue shopping” → `/checkout` dead end | high | risk-receipt-continue#f0 | href `/checkout` not `/` (C5.3) | **fix-now** |
| 19 | Cannot buy last in-stock unit | high | risk-last-unit#f2–f4 | add uses `already + qty >= stock` (off-by-one) | **fix-now** |
| 20 | Empty cart jargon | med | (empty path; sibling of #9) | “Cart collection returned 0 rows” | **fix-now** |
| 21 | No cart-body continue-shopping link | high | risk-cart-local-continue#f0 | cart foot only Checkout (C3.5) | **fix-now** |
| 22 | Product missing back-to-catalog crumb | med | SPEC C2.4; findings less loud | product page had no category-preserving crumb | **fix-now** (proactive/SPEC) |
| 23 | Receipt ETA contradicts shipped/delivered status | med | risk-receipt-eta (blocked by #17); code always “confirmed · arrives in 3–5 days” | fixed string ETA (C5.1) | **fix-now** (with #17) |
| 24 | Error / price text low contrast | med | first-impressions axe notes; field-error `#e4c7c7`, card price `#c3cdc6` | CSS colors fail AA; errors hard to read (C7.3 / C7.2) | **fix-now** |
| 25 | Trust/policy pages, returns, privacy, About, Help | — | first-impressions majors on trust content | not in SPEC capabilities | **reject** — out of SPEC |
| 26 | Footer `@example` domain / demo account prefill | — | first-impressions#f3–f4 | fixture mechanics (SPEC out of scope) | **reject** |
| 27 | Listing cards lack add / stock counts | — | change-mind#f5, club-order#f2 | C1.1 only requires card→detail; OOS mark exists | **reject** soft-ux / not required |
| 28 | Compare / recommendations | — | outfit@weekend#f3 | SPEC out of scope | **reject** |
| 29 | Soft-ux: quiet nav, contrast polish beyond errors, sort below fold | — | various minors | taste-only | **reject** |
| 30 | Checkout order-summary in-place edit | — | change-mind#f1, club-order#f6 | SPEC: edit on cart (C3); recovery is #1–#2 | **reject** as separate feature — cart edit is the fix |
| 31 | Stock on product page not reduced by cart reservation | low | risk-last-unit#f5 | SPEC stock is inventory, not cart-aware display | **reject** — inventory truth is at order time (C4.5); add messaging already states room |

## Fix packing (code)

| Pack | Classes | Files |
|---|---|---|
| A cart edit | 1, 2, 20, 21 | pages.js |
| B add feedback | 3 | pages.js |
| C catalog search/clear/jargon | 4, 5, 6 | pages.js |
| D sort | 7 | server.js |
| E OOS honesty | 8 | pages.js |
| F empty checkout | 9 | server.js |
| G shipping label | 10 | pages.js |
| H checkout validation honesty | 11, 12, 13, 14 | pages.js |
| I profile save | 15, 16 | pages.js |
| J order history + ETA | 17, 23 | pages.js |
| K receipt continue | 18 | pages.js |
| L last unit | 19 | server.js |
| M product crumb | 22 | pages.js |
| N contrast | 24 | pages.js |
