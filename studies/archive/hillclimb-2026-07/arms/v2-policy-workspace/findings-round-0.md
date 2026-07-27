# User-testing findings — Fern & Fog storefront (instrument v2)

One full MATRIX-v2 discovery round (28 cells: trunk + forced-risk, Grok 4.5 actor,
adversarial + core personas) was run against the broken shop. Below is every finding
and grader report answer adjudicated as non-duplicate, grouped by cell.
Severity tags are the grader's. Reference finding ids in your fixes manifest.

**Blindness rules (non-negotiable):** You may read this file, the app directory
(`studies/hillclimb/arms/v2-policy/`), and that app's `SPEC.md` only. You must
**not** open `faults.json`, `tests/`, `ledger/`, study docs under
`docs/backlog/`, or other arms (`naive/`, `policy/`, `subject/`). Do not grep
the repo for fault ids or read manifestation tests.

**Policy (six points):**
1. Dedup findings into a **belief table** of issue-classes (`BELIEFS.md`).
2. **Probe before fixing** anything ambiguous (or reject with a written why if
   clearly out of SPEC / taste-only / harness-timing).
3. Pin a **regression story per fix** under `v2-policy-regression/stories/`
   (story body must **force** the precondition it protects).
4. Evidence-gate: fix confirmed/likely classes; do not fire-hose soft-ux.
5. No actor-tier escalation needed in this fix phase.
6. Promote proven paths to pinned journeys.

**Deliverables in this workspace:**
- `BELIEFS.md` — issue-class table (conf / evidence / root cause / decision)
- edits under `studies/hillclimb/arms/v2-policy/` only
- `fixes-r1.json` — array of {description, files, finding_ids, regression_story, skipped}
- regression stories + suite config under `studies/hillclimb/arms/v2-policy-regression/`


## buy-a-specific-gift@cautious-first-timer

- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#f3` [major] The silent add behavior created a duplicate order: the cart later contained quantity 2 and subtotal $76, even though the user wanted exactly one plant and had only repeated the click because no success state appeared.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#f4` [major] The cart promised editable quantities with “Quantities update as you change them,” but the quantity cell was inert text with no spinbox, +/- control, or editable field.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#f5` [major] The only apparent corrective action, Remove, did nothing: repeated clicks left quantity 2, subtotal $76, and the Cart badge at 2, blocking checkout for the intended single item.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#f0` [info] The product was highly discoverable: Monstera Deliciosa appeared top-left in the initial product grid, exactly where the user expected to find it under the main shop area.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#f1` [info] The product detail page supported fast evaluation: price, stock count, quantity default, and Add to cart were visually prominent and aligned with the expected purchase path.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#f6` [info] No axe-core accessibility violations were reported across the run, so the observed failure was product behavior and affordance clarity rather than automated WCAG issues.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#q0` [info] Q: How did the user try to find the monstera, and how directly did the shop take them to it?
    A: They found it directly from the shop grid: Monstera Deliciosa was the first visible product card, then the product page showed the expected item, price, stock, and default quantity without detours.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#q1` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: Confusion started after Add to cart appeared to do nothing: no badge update or confirmation. It continued in the cart, where quantity 2 appeared with no quantity editor despite helper text claiming quantities update, and Remove did not change the row.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#q2` [info] Q: Did every action produce a visible confirmation it had worked? Name any that did not.
    A: No. Add to cart had no visible success confirmation on the product page, even though both clicks later affected cart quantity. Remove also produced no visible change: quantity, subtotal, and badge remained unchanged.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#q3` [info] Q: Could the user prove to themselves the order was placed? How?
    A: No. They never reached a completed order or confirmation page; the final provable state was only an incorrect cart with two Monsteras and a Checkout link, so closing the tab would not leave evidence that an order went through.
- `2026-07-13T0812-23cf/buy-a-specific-gift@cautious-first-timer#q4` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes: silent add-to-cart feedback, duplicate quantity caused by that silence, misleading quantity-update helper text, missing quantity controls, and a nonfunctional Remove button. Together these blocked a shopper from safely correcting the cart before payment.

## buy-a-specific-gift@gift-rusher

- `2026-07-13T0812-23cf/buy-a-specific-gift@gift-rusher#f3` [major] The page gave no explanation for the failed cart action, such as required login, unavailable selection, validation error, loading state, or alternate buy/checkout route, so the shopper had no recoverable next step.
- `2026-07-13T0812-23cf/buy-a-specific-gift@gift-rusher#f0` [info] Product discovery was strong once the user reached the shop grid: Monstera Deliciosa appeared first and was easy to spot, though the user initially expected a free-text search field and only saw Sort plus a Search button.
- `2026-07-13T0812-23cf/buy-a-specific-gift@gift-rusher#f1` [info] The product page hierarchy matched shopper expectations: price, stock, quantity, and a prominent green Add to cart button sat together with little competing clutter.
- `2026-07-13T0812-23cf/buy-a-specific-gift@gift-rusher#f4` [info] No axe-core accessibility violations were reported across the run, so the observed failure is functional/feedback-related rather than an accessibility scanner issue.
- `2026-07-13T0812-23cf/buy-a-specific-gift@gift-rusher#q0` [info] Q: How did the user try to find the monstera, and how directly did the shop take them to it?
    A: They expected to search by typing "monstera," but there was no visible text field. The shop still got them there directly because Monstera Deliciosa was the first product card and easy to select.
- `2026-07-13T0812-23cf/buy-a-specific-gift@gift-rusher#q4` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: The Add to cart control looked like the correct next step but behaved as a dead CTA. Also missing were a visible search input on the listing page and any inline explanation if login, validation, or another prerequisite was required before adding to cart.

## change-your-mind@cautious-first-timer

- `2026-07-13T0812-ade1/change-your-mind@cautious-first-timer#f0` [major] Cart editing failed at the primary expected location: the cart promised “Quantities update as you change them,” but quantities rendered as plain text and both visible Remove buttons left the cart unchanged, blocking budget trimming.
- `2026-07-13T0812-ade1/change-your-mind@cautious-first-timer#f1` [major] Checkout did not offer a recovery path: the user expected edit/remove controls or an “Edit cart” link beside the order summary, but only payment and place-order controls were available while the total remained over budget.
- `2026-07-13T0812-ade1/change-your-mind@cautious-first-timer#f2` [major] Add-to-cart actions gave no immediate confirmation: header cart counts stayed stale on product pages, leading the user to click Add twice and unintentionally create duplicate line quantities.
- `2026-07-13T0812-ade1/change-your-mind@cautious-first-timer#f4` [minor] Product discovery was otherwise clear: prices, stock, quantity default, and the Add to cart button were easy to find on product detail pages.
- `2026-07-13T0812-ade1/change-your-mind@cautious-first-timer#f5` [minor] Listing cards showed prices but no add buttons, forcing a detail-page detour for every item the user wanted to add.
- `2026-07-13T0812-ade1/change-your-mind@cautious-first-timer#q0` [info] Q: Could the user change quantities and remove items where they expected to? Describe any edit that fought back.
    A: No. The expected cart Quantity column had only static “2” values despite copy promising updates, and both row-level Remove buttons failed to change the cart. Checkout also lacked edit/remove controls.
- `2026-07-13T0812-ade1/change-your-mind@cautious-first-timer#q1` [info] Q: After each cart change, did every number on screen (line totals, subtotal, cart badge, checkout total) stay consistent? Note any lag or mismatch.
    A: No. Add clicks silently succeeded while the product-page cart badge lagged, which caused duplicate quantities. Later, Remove clicks produced no numeric change. Checkout also showed a $134 total from $128 subtotal plus $6 shipping while labeling that charge “Free shipping.”
- `2026-07-13T0812-ade1/change-your-mind@cautious-first-timer#q2` [info] Q: Did the user trust the final total matched their budget arithmetic? Why or why not?
    A: No. The arithmetic showed the order was over budget, but the bigger trust failure was that the user could not edit the cart and checkout displayed contradictory shipping copy, so they refused to place the $134 order.

## change-your-mind@weekend-browser

- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#f0` [major] Cart editing failed at the point the user most expected it: the cart promised “Quantities update as you change them,” but the Quantity column showed only static numbers with no inputs or steppers, so the user could not reduce item counts.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#f1` [major] Every visible Remove control in the cart fought back: the user clicked Remove for Monstera, Snake Plant, Terracotta Pot, and Golden Pothos, but rows, subtotal, and cart badge stayed unchanged at $137 / Cart 6.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#f2` [major] Checkout did not offer a recovery path: the order summary exposed the over-budget $143 total but was read-only, with no edit, remove, or quantity controls near the line items.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#f3` [minor] Product-page Add to cart actions worked but gave no immediate confirmation: the header cart badge stayed stale on the product page, leading the user to repeat Add clicks and accidentally create duplicate quantities.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#f4` [minor] The cart copy was misleading relative to the UI: “Quantities update as you change them” made the user search for editable quantity controls that were not visually or programmatically apparent in the captured page.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#f6` [info] Browsing and adding products were discoverable: sort, product cards, product detail pages, Add to cart, Shop, Cart, and Checkout all appeared where the user expected them.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#q0` [info] Q: Could the user change quantities and remove items where they expected to? Describe any edit that fought back.
    A: No. The user expected editable quantity controls in the cart table because the page said quantities update as changed, but only static numbers were visible. Remove buttons looked actionable, but every attempted removal left the cart unchanged.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#q1` [info] Q: After each cart change, did every number on screen (line totals, subtotal, cart badge, checkout total) stay consistent? Note any lag or mismatch.
    A: Add-to-cart changes eventually appeared in the cart badge and cart totals, but not immediately on product pages, which made successful adds look failed. During removal attempts, all numbers stayed internally consistent only because nothing changed: line totals, subtotal, and badge remained stuck at the over-budget state.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: Confusion first came from stale product-page cart badges after Add clicks. The main hesitation happened in the cart, where static quantity numbers contradicted the editable-quantity copy and Remove buttons appeared enabled but had no effect. The user then backtracked from checkout because the order summary offered no edit path.
- `2026-07-13T0812-ade1/change-your-mind@weekend-browser#q4` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes: Remove buttons were broken, quantity controls were missing, cart copy promised an interaction that was not present, product-page Add lacked confirmation or badge refresh, checkout line items were not editable, and the shipping label contradicted the charged amount.

## checkout-hiccup@cautious-first-timer

- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#f3` [major] The only recovery affordance, Remove, appeared clickable but produced no page, DOM, request, subtotal, or badge change across repeated attempts, leaving the cart stuck at quantity 2 and $52.
- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#f4` [major] The checkout/payment recovery scenario was never reached because the shopper refused to proceed with an incorrect cart total and broken cart controls.
- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#f0` [info] Product discovery worked: the Snake Plant card was easy to spot on the homepage, and the product page put price, stock, quantity 1, and Add to cart where the user expected them.
- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#f5` [info] No axe-core accessibility violations were reported across the run, so the blockers were behavioral and discoverability issues rather than detected WCAG failures.
- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#q0` [info] Q: When the payment failed, what exactly did the shop tell the user, and did they understand what had happened and whether they'd been charged?
    A: Payment was never reached, so the shop never displayed a payment failure or any charge status. The only uncertainty was earlier: cart state changed invisibly after Add to cart, which damaged trust before checkout.
- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#q1` [info] Q: How much did the user have to re-enter to try again? Name anything the form forgot.
    A: No retry form appeared because the user stopped at the cart. The relevant forgotten state was not payment data; it was cart-editing state/controls, since quantity could not be changed and Remove did not clear the line.
- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#q2` [info] Q: Did the user finish the purchase, and how sure were they that it succeeded exactly once?
    A: No. They were sure it would not be exactly once because the cart showed two Snake Plants, subtotal $52, and Cart2, with no working way to reduce or remove the duplicate.
- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: They hesitated after Add to cart because the page stayed put and Cart still looked like 0; then backtracked to Cart, where static quantity text contradicted the “Quantities update as you change them” copy and Remove did nothing.
- `2026-07-13T0812-23cf/checkout-hiccup@cautious-first-timer#q4` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes: Add to cart lacked feedback while still adding items; the cart copy promised editable quantities but no control existed; Remove was nonfunctional; the header badge/subtotal confirmed an incorrect stuck cart.

## checkout-hiccup@gift-rusher

- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#f1` [major] Add to cart gave no clear success feedback and the header badge still appeared to show 0, so the user repeated the action and unintentionally created a quantity-2 cart.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#f2` [major] Cart quantity was not editable despite copy saying quantities update as changed; the Quantity column showed static text, so the user could not correct Snake Plant from 2 to 1.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#f3` [major] Remove in the cart Actions column appeared to be the only way to recover, but two clicks had no visible effect, leaving the duplicate item and badge unchanged.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#f4` [major] Checkout preserved the unwanted duplicate with no edit link or quantity control in the order summary, forcing a $58 order for two plants instead of the intended one.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#f0` [minor] The homepage search affordance was misleading: the user expected a text search box near Sort/Search, but the target was not fillable; product grid visibility saved the flow because Snake Plant was immediately visible.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#f5` [info] Core product discovery and primary shopping CTAs were otherwise clear: the Snake Plant card, product detail page, Add to cart, Cart, and Checkout controls were easy to locate visually.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#q0` [info] Q: When the payment failed, what exactly did the shop tell the user, and did they understand what had happened and whether they'd been charged?
    A: Payment was never submitted, so there was no failed-payment message and no evidence about whether the app explains charge status after a decline. The user stopped before entering card details because the order was already wrong.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#q1` [info] Q: How much did the user have to re-enter to try again? Name anything the form forgot.
    A: No retry occurred. At the final checkout snapshot, delivery details were still prefilled, while payment fields were empty because the user had not attempted the temperamental card.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#q2` [info] Q: Did the user finish the purchase, and how sure were they that it succeeded exactly once?
    A: No. They explicitly gave up and were sure the only available order would be wrong: two Snake Plants for $58, not one plant, so there was no successful purchase to trust exactly once.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: They hesitated at search because the apparent search control was not a text field; repeated Add to cart because the page looked unchanged and Cart still read 0; then backtracked between cart, shop, product, and checkout because cart quantity was static text and Remove did nothing.
- `2026-07-13T0812-ade1/checkout-hiccup@gift-rusher#q4` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes: add-to-cart feedback/badge update was misleading, Remove appeared broken, quantity editing was missing despite copy promising it, checkout lacked an edit path, and the final Place order button would only buy the unintended duplicate order.

## club-order@returning-regular

- `2026-07-13T0825-64e7/club-order@returning-regular#f4` [major] Cart copy promised “Quantities update as you change them,” but quantity was static text with no stepper or input, blocking the obvious fix from 16 back to 8.
- `2026-07-13T0825-64e7/club-order@returning-regular#f5` [major] The only cart correction control, Remove, did not remove the line after two clicks, leaving the user unable to clear the duplicate item and re-add the right quantity.
- `2026-07-13T0825-64e7/club-order@returning-regular#f6` [major] Checkout offered no recovery path: the order summary was static ×16 and the only forward action was placing a $198 order, so the user abandoned rather than buy double the requested amount.
- `2026-07-13T0825-64e7/club-order@returning-regular#f1` [minor] Account worked for saved profile and shipping details, but lacked the order history or past-purchase shortcut the returning customer expected for reordering a familiar care item.
- `2026-07-13T0825-64e7/club-order@returning-regular#f2` [minor] Category cards did not show stock or add controls, so the user had to open the product detail page before knowing whether eight units were possible.
- `2026-07-13T0825-64e7/club-order@returning-regular#f0` [info] Care & Tools matched the user's mental model for small care items, and the product page clearly exposed stock, price, and a quantity field; the user found Gentle Plant Food and confirmed 18 available without trial-and-error.
- `2026-07-13T0825-64e7/club-order@returning-regular#q0` [info] Q: How did the user discover how many of an item they could actually buy, and was the shop upfront about it or did they find out the hard way?
    A: They discovered it on the Gentle Plant Food product page, where “In stock — 18 available” appeared near the price and quantity control. That part was upfront once they opened the detail page, though not visible from the category card.
- `2026-07-13T0825-64e7/club-order@returning-regular#q1` [info] Q: When the shop couldn't meet the request, what did it offer the user to work with, and how did they adapt?
    A: The shop actually could meet the eight-item request by stock, but after the duplicate add it offered no usable adaptation tools: no quantity edit, non-working Remove, and no checkout edit. The user tried Cart, reload, Checkout, and back to Cart before giving up.
- `2026-07-13T0825-64e7/club-order@returning-regular#q2` [info] Q: Did the user lose any work (cart contents, typed input) at any point while adapting? Describe it.
    A: They did not lose typed checkout/account data; saved delivery details carried through. The loss was control over cart state: the intended quantity 8 became 16 because both add clicks registered despite stale feedback, and the user could not undo it.
- `2026-07-13T0825-64e7/club-order@returning-regular#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: Confusion centered on the product-page badge staying at 0 after Add to cart, then on Cart showing static quantity text under a promise that quantities update. Backtracking followed through Cart reloads and Checkout because the expected edit/remove controls were absent or broken.

## club-order@weekend-browser

- `2026-07-13T0856-2a58/club-order@weekend-browser#f3` [major] Add to cart gave no immediate success feedback and appeared not to update the cart badge, leading the user to retry and ultimately discover an unexpected cart quantity of 17.
- `2026-07-13T0856-2a58/club-order@weekend-browser#f4` [major] The cart trapped the user with the wrong quantity: “17” was plain text, “Remove” did nothing, and the copy “Quantities update as you change them” promised controls that were not present.
- `2026-07-13T0856-2a58/club-order@weekend-browser#f5` [major] Checkout offered no edit path in the order summary, so the user could not correct the cart after the cart page failed.
- `2026-07-13T0856-2a58/club-order@weekend-browser#f1` [minor] Listing cards did not show stock or quantity limits, so the user had to open product pages to learn whether buying eight was possible.
- `2026-07-13T0856-2a58/club-order@weekend-browser#f7` [minor] The checkout form rejected the prefilled 4-digit postcode and required five digits, which conflicted with the user’s expectation for the shown address format.
- `2026-07-13T0856-2a58/club-order@weekend-browser#f0` [info] The category model worked: the user expected small bundle-friendly items under “Care & Tools” and found that category immediately in the filter pills.
- `2026-07-13T0856-2a58/club-order@weekend-browser#f2` [info] The product page did disclose usable stock with “In stock — 18 available,” letting the user determine that eight Gentle Plant Food should have been possible.
- `2026-07-13T0856-2a58/club-order@weekend-browser#q0` [info] Q: How did the user discover how many of an item they could actually buy, and was the shop upfront about it or did they find out the hard way?
    A: They found the real stock only after opening the product page; Gentle Plant Food showed “In stock — 18 available,” so the shop was upfront there but not on the listing cards. The hard-way part was not stock discovery, but discovering that cart behavior did not let them actually control the intended quantity.
- `2026-07-13T0856-2a58/club-order@weekend-browser#q1` [info] Q: When the shop couldn't meet the request, what did it offer the user to work with, and how did they adapt?
    A: It did not offer an alternative, max-quantity suggestion, or cart correction tool. The user adapted by accepting the cart’s forced 17× Gentle Plant Food because it still produced enough matching care items, rather than switching to a second product.
- `2026-07-13T0856-2a58/club-order@weekend-browser#q2` [info] Q: Did the user lose any work (cart contents, typed input) at any point while adapting? Describe it.
    A: Yes. The cart accumulated or exposed 17 items instead of the intended 8 and could not be edited down. Later, checkout validation repeatedly appeared to clear or fail to retain card number, expiry, and CVV, requiring repeated re-entry.
- `2026-07-13T0856-2a58/club-order@weekend-browser#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: The main hesitation was in the cart: quantity appeared as non-editable text, Remove had no effect, and the page copy claimed quantities would update. The second confusion cluster was checkout payment, where red card errors persisted after valid-looking input and fields appeared visually filled while the form state treated them as empty.
- `2026-07-13T0856-2a58/club-order@weekend-browser#q4` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Broken: Remove did nothing, cart quantity was not editable, add-to-cart feedback/cart count was unreliable, and payment fields lost input across validation. Misleading: cart copy promised quantity updates without controls. Missing: stock hints on listing cards and an edit-order link in checkout.

## first-impressions@cautious-first-timer

- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#f2` [major] Standard trust and purchase-decision information was absent from every place the user checked: footer, header, Account, product detail, and the attempted cart path had no shipping rates, returns, privacy, About, or Help links.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#f3` [major] The footer actively eroded trust because it contained only a tagline and `hello@fernandfog.example`; the placeholder domain read as unfinished for a shop asking for payment details.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#f4` [major] Account opened into a prefilled demo user profile and shipping address, which felt inappropriate for a first-time visitor and reinforced that the shop might be a mock/demo rather than a real checkout experience.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#f1` [minor] Out-of-stock status was clear in the product grid, which helped the shop feel orderly and honest at first glance.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#f6` [minor] Cart and Account existed in the header but were visually quiet enough that the user did not notice them until reaching the product page; the product grid dominated the first impression.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#f7` [minor] Accessibility scan found repeated color-contrast violations, which is consistent with the visually soft, low-contrast UI described during the run and may make quiet trust links or feedback even easier to miss.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#f0` [info] The catalog communicated the core assortment immediately: houseplants, pots/planters, and care tools with visible prices, enough for the user to estimate a starter setup at about $40–60 before shipping.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#q0` [info] Q: What did the user conclude the shop sells, and how quickly was that clear?
    A: They concluded almost immediately that Fern & Fog sells houseplants, pots/planters, and basic care tools. Prices on the homepage were clear enough by step 1 for a rough starter-cost estimate, refined by step 2 to about $40–60 before shipping.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#q1` [info] Q: Which pages or details built trust, and which — if any — eroded it? Quote the specifics.
    A: Trust builders were the clean catalog, visible prices, stock counts, care specs, and clear out-of-stock label. Trust eroders were stronger: the footer only had `hello@fernandfog.example`, Account showed a `demo account` with prefilled profile/address, and the product page/cart path still gave no shipping or returns information.
- `2026-07-13T0812-a709/first-impressions@cautious-first-timer#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: They backtracked through expected trust locations after failing to find shipping/returns: footer, header, product page, Account, then cart/checkout. The only explicit confusion event was the repeated Add to cart click, caused by the unchanged Cart badge and lack of confirmation or error.

## first-impressions@weekend-browser

- `2026-07-13T0812-a709/first-impressions@weekend-browser#f2` [major] Sorting repeatedly undermined confidence: after selecting “Price: low to high,” the user saw the grid remain out of order on Plants, Pots, and Care, making the control feel cosmetic rather than functional.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#f3` [major] Cart editing failed on the user’s natural recovery path: the cart showed static quantities despite copy promising updates, and the red Remove control did not remove the accidental duplicate after repeated attempts.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#f4` [major] Checkout created a hard trust break by labeling shipping “Free shipping” while charging $6.00, making the final total feel internally inconsistent even though the arithmetic added up.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#f5` [minor] Add-to-cart feedback lagged or failed to update in place: the user clicked twice because the product page badge stayed at 0, accidentally creating two Pothos items before the cart later showed them.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#f6` [minor] Trust content was thin where the user looked for it: product pages, cart, checkout, and footer lacked real product photos, reviews, returns policy, shipping policy, guarantee, or trust badges.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#f7` [minor] The UI relied on emoji-style product icons throughout; visually clean, but the user read the absence of real plant/product photography as making the shop feel less credible for card entry.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#f0` [info] The shop’s core catalog was clear immediately: the user understood on first view that it sold plants, pots/planters, and care tools, with category pills exactly where expected under the hero copy.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#f1` [info] Product pricing was scannable enough for the user to estimate a starter setup: Golden Pothos $19, Terracotta Pot $14, and Gentle Plant Food $12, for about $45 before shipping.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#q0` [info] Q: What did the user conclude the shop sells, and how quickly was that clear?
    A: It was clear on the first screen: plants, pots/planters, and care tools for indoor plants. By the end, the user had sized the ranges as plants about $19-$52, pots $14-$32, and care tools $12-$22.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#q1` [info] Q: Which pages or details built trust, and which — if any — eroded it? Quote the specifics.
    A: Trust came from clean product pages, visible stock/details, and math that matched in cart. It eroded around specifics the user called out: “sort never reorders the grid,” Remove “never worked,” checkout labels shipping “Free” while charging “$6,” and there were “no real photos/reviews” or returns/shipping policy where expected.
- `2026-07-13T0812-a709/first-impressions@weekend-browser#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: The hesitation clustered around the cart and checkout. The user backtracked from product to cart because the badge did not update, repeatedly tried Remove because the only visible quantity value was static text, and went to checkout looking for shipping/returns clarity after the cart could not be corrected.

## moving-house@cautious-first-timer

- `2026-07-13T0812-a709/moving-house@cautious-first-timer#f0` [major] Profile email update was exactly where the user expected it, but Save profile appeared to do nothing after repeated clicks: no toast, no signed-in identity update, and no visible error, so the account was never trusted as updated.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#f2` [major] Checkout rejected the saved four-digit postcode with “Enter a 5-digit postcode,” contradicting the Account save flow and blocking a legitimate order to 7 Alder Court, Kingsbridge, 6220.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#f3` [major] Failed checkout wiped the payment fields after validation, increasing recovery cost and reinforcing the user’s decision not to retry with card details.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#f4` [minor] Add to cart succeeded but gave no immediate confirmation; the user clicked twice, then discovered the cart contained two pots instead of one.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#f5` [minor] Cart showed quantity as plain text with only Remove available, so the user could not easily correct the accidental quantity 2 before checkout.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#f1` [info] Shipping address editing was discoverable on Account: the user found Street, City, Postcode, and Save address under the Shipping address card and received a clear “Address saved.” confirmation.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#f6` [info] Checkout did carry the saved shipping address through visibly, and it provided an editable receipt email field that let the user work around the broken Account profile save.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#q0` [info] Q: Did saving the new details visibly succeed, and did the user believe it? What convinced them?
    A: Only the shipping address visibly succeeded: the user saw an “Address saved.” toast and the new address remained in the fields. The email/profile save did not convince them because the signed-in line stayed `riley@example.com` and no profile confirmation appeared.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#q1` [info] Q: When the user reached checkout, did their updated details carry through, or did they have to re-enter anything?
    A: The updated shipping address carried through to checkout. The updated email did not carry through from Account, so the user re-entered `riley.chen@fastmail.example` in Checkout’s receipt email field.
- `2026-07-13T0812-a709/moving-house@cautious-first-timer#q2` [info] Q: Could the user confirm the finished order was headed to the new address? How?
    A: They could confirm the checkout form showed the new delivery address before submitting, but they never got a finished order confirmation because postcode validation blocked submission.

## moving-house@returning-regular

- `2026-07-13T0856-2a58/moving-house@returning-regular#f0` [major] The Profile email field was exactly where the user expected it, but Save profile gave no visible success state, never changed “Signed in as riley@example.com,” and reloads reverted the field to the old email, so the account email could not be updated.
- `2026-07-13T0856-2a58/moving-house@returning-regular#f2` [minor] Account verification depended on noticing the quiet “Signed in as” line and scrolling between Profile and Shipping; the UI did not provide a prominent persisted-vs-unsaved state for profile changes.
- `2026-07-13T0856-2a58/moving-house@returning-regular#f1` [info] The Shipping address section matched the user’s mental model: street/city/postcode were grouped under Account, Save address was visible, a toast confirmed success, and reload verification showed 7 Alder Court, Kingsbridge, 6220 persisted.
- `2026-07-13T0856-2a58/moving-house@returning-regular#f4` [info] Checkout did carry the saved delivery address through and exposed an order-level receipt email field, letting the user correct the email for this order even though account profile save was broken.
- `2026-07-13T0856-2a58/moving-house@returning-regular#q0` [info] Q: Did saving the new details visibly succeed, and did the user believe it? What convinced them?
    A: Shipping visibly succeeded: the “Address saved.” toast and later reload showing 7 Alder Court / Kingsbridge / 6220 convinced the user. Email did not: there was no profile confirmation, “Signed in as” stayed riley@example.com, and reloads reverted the email field.
- `2026-07-13T0856-2a58/moving-house@returning-regular#q1` [info] Q: When the user reached checkout, did their updated details carry through, or did they have to re-enter anything?
    A: The saved delivery address carried through to checkout correctly. The account email did not, so the user re-entered riley.chen@fastmail.example in Checkout’s order-level receipt email field.
- `2026-07-13T0856-2a58/moving-house@returning-regular#q2` [info] Q: Could the user confirm the finished order was headed to the new address? How?
    A: No finished order existed to confirm. Before submission, checkout displayed the new delivery address, but Place order was blocked by postcode and card validation, so there was no receipt/order history confirmation.
- `2026-07-13T0856-2a58/moving-house@returning-regular#q4` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Broken: profile email persistence, checkout postcode validation for 6220, and card-number validation/reset. Misleading/missing: Add to cart lacked feedback, profile save lacked success/error messaging, and Account allowed an address that Checkout later rejected.

## outfit-a-shelf@returning-regular

- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f3` [major] Product-page Add to cart had no visible confirmation and the cart badge did not update promptly, so the user repeated clicks and accidentally added multiples of each selected item.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f4` [major] The cart promised “Quantities update as you change them,” but quantity values were static text with no stepper, input, or +/- controls, blocking correction from 3/2/2 to one of each.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f5` [major] Remove buttons appeared to be the only recovery path, but repeated clicks on multiple lines produced no DOM, URL, or cart changes, leaving the user unable to clear or rebuild the order.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f6` [major] The cart contents and subtotal diverged from the chosen budget order: the intended ~$45 set became 3 Pothos, 2 pots, and 2 plant foods for $109, so the user refused checkout.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f2` [minor] The Account page matched saved-profile expectations but lacked the order history the user expected below shipping, causing an early detour before shopping began.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f7` [minor] Care & Tools existed but was visually quiet as an outline pill; the user initially searched below the fold in the Everything grid before using the category.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f8` [minor] Color contrast violations were present across captured steps, which may further reduce scannability of low-emphasis controls such as category pills and Remove links.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f0` [info] The user found the price sort exactly where expected above the product grid, and it supported the price-conscious comparison by surfacing low-cost plant, pot, and care candidates.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#f1` [info] Care supplies were discoverable under the expected Care & Tools category, and the category grid made the cheapest care item, Gentle Plant Food at $12, easy to compare against mister, shears, and watering can options.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#q0` [info] Q: Which tools for narrowing and comparing (categories, sorting, search) did the user find, and did each behave as they expected?
    A: They found sorting and categories, not search. Price low-to-high behaved as expected and helped identify budget picks. Care & Tools also behaved as expected once opened, though the user first looked for care items further down the all-products grid. Search was visible in the shop toolbar but not used because sorting/categories were enough.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#q1` [info] Q: Did the user compare options before choosing? What information did they lean on, and was any of it missing or unclear?
    A: Yes. They compared by price first, then used card blurbs and product details/specs: Pothos vs Snake Plant, Terracotta vs other pots, Plant Food vs mister/shears/watering can. The main missing merchandise expectation was soil or potting mix; Care & Tools showed tools and food, but no soil.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#q2` [info] Q: As the cart grew, did its contents and totals always match what the user had chosen? Note any mismatch.
    A: No. The user chose one Pothos, one Terracotta Pot, and one Gentle Plant Food, but repeated Add-to-cart clicks produced quantities 3, 2, and 2. The intended ~$45 order became $109, with badge 7, which directly caused give-up.
- `2026-07-13T0856-2a58/outfit-a-shelf@returning-regular#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: Confusion clustered around cart feedback and correction: Cart stayed at 0/3/5 after add attempts, no toast appeared, quantities rendered as plain text despite the update promise, and Remove links produced no visible change. Earlier hesitation was smaller: the user checked Account for order history and searched the all-products list before switching to Care & Tools.

## outfit-a-shelf@weekend-browser

- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#f5` [major] The cart promised 'Quantities update as you change them' but displayed quantities as static text with no spinner, input, plus/minus, or clear-cart path, leaving the shopper unable to reduce 2x Golden Pothos to 1x.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#f6` [major] The only visible cart correction control, Remove, did not change the cart after multiple attempts, so the shopper could not repair the order and abandoned checkout with an incorrect $74 subtotal.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#f1` [minor] Sort by price was discoverable and useful, but it reset to Featured after returning from product pages, forcing repeated sorting and weakening price comparison continuity.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#f2` [minor] Product detail pages supplied the key decision data the shopper expected: pot size, light/water needs, difficulty, dimensions/materials, drainage, and care specs under the description.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#f3` [minor] There was no side-by-side compare or related-product guidance, so comparison happened through repetitive open-read-back navigation across plants, pots, and care items.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#f7` [minor] The cart's primary Checkout button and subtotal visually pulled attention even while the quantity problem remained unresolved, increasing the risk that a real shopper proceeds with a wrong order or loses trust.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#f0` [info] Category pills for Plants, Pots & Planters, and Care & Tools were found exactly where expected under the sort controls, letting the shopper narrow each product group without hunting.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#q0` [info] Q: Which tools for narrowing and comparing (categories, sorting, search) did the user find, and did each behave as they expected?
    A: They found category pills and price sorting quickly and used them for Plants, Pots & Planters, and Care & Tools. Categories behaved as expected; sorting worked but did not persist after product-page round trips. Search was present visually but not used because categories and sort met the narrowing need.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#q1` [info] Q: Did the user compare options before choosing? What information did they lean on, and was any of it missing or unclear?
    A: Yes. They compared Pothos vs Snake Plant, Terracotta vs Hanging Planter, and Plant Food vs Watering Can. Decisions leaned on price, shelf fit, pot size, drainage/saucer, light/water/difficulty, and care usefulness. Missing piece: no side-by-side comparison or recommendation flow, so comparison depended on memory and backtracking.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#q2` [info] Q: As the cart grew, did its contents and totals always match what the user had chosen? Note any mismatch.
    A: No. The cart eventually contained the chosen Pothos, Terracotta Pot, and Watering Can, but it held 2x Golden Pothos after a repeated add prompted by missing feedback. The subtotal was mathematically correct for the broken cart state, $74, but wrong for the shopper's intended order of one plant.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#q3` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: Confusion centered on cart state. The cart badge did not update after Add, so the shopper retried and then checked Cart. In Cart, static quantity text conflicted with the 'Quantities update as you change them' copy, and Remove was the only visible correction path but had no effect.
- `2026-07-13T0825-51dc/outfit-a-shelf@weekend-browser#q4` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Broken: Remove did not remove or reduce the Pothos line. Misleading: cart copy promised editable quantities where no controls existed. Missing: immediate add confirmation, quantity controls, clear-cart or decrement path, persistent sort/category state, and lightweight comparison support.

## risk/risk-card-unspaced@adversarial-tester

- `2026-07-13T0856-2a58/risk/risk-card-unspaced@adversarial-tester#f2` [major] Cart recovery failed: quantity was plain text despite copy saying "Quantities update as you change them," and repeated Remove clicks did not remove the line or change the badge.
- `2026-07-13T0856-2a58/risk/risk-card-unspaced@adversarial-tester#f4` [major] The unspaced 16-digit card was treated as invalid even though the user had typed exactly sixteen digits; the message "Enter the 16-digit number on the card" did not explain that spaces were required.
- `2026-07-13T0856-2a58/risk/risk-card-unspaced@adversarial-tester#f3` [minor] Checkout delivery looked prefilled, but the prefilled postcode was invalid for the form, so the user discovered a hidden delivery validation issue only after submitting payment.
- `2026-07-13T0856-2a58/risk/risk-card-unspaced@adversarial-tester#f0` [info] Product discovery was straightforward: in-stock status and Add to cart were where the user expected on the Monstera detail page.

## risk/risk-cart-local-continue@adversarial-tester

- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#f0` [major] The cart body has no page-local continue-shopping equivalent; after the line item, subtotal, and Checkout, the only catalog paths left are the global header Shop link and brand link.
- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#f1` [major] Add to cart appeared not to work on the product page because repeated clicks left the header badge showing 0 and no success toast or cart feedback appeared, even though the cart later contained Snake Plant qty 2.
- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#f2` [minor] The user first expected add-to-cart on catalog cards but found only product links, forcing a product-detail detour before adding an in-stock item.
- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#f3` [info] Once on the product detail page, the in-stock state, quantity field, and green Add to cart button were visually prominent and matched the user's expected location for the primary purchase action.
- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#f4` [info] The cart page itself was sparse and scannable, which made the absence of a local keep-shopping link easy to verify rather than ambiguous.
- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#f5` [info] No axe-core accessibility violations or console errors were recorded during the run.
- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#q1` [info] Q: If yes, where did it go? If no, what options remained to keep shopping?
    A: Only global navigation remained: the header Shop link and the Fern & Fog brand link. The user correctly did not treat either as a cart-body control.
- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#q2` [info] Q: Did the cart contents and badge stay consistent while checking?
    A: No. On the product page the badge still read 0 after add attempts, but /cart later showed Snake Plant in the cart with quantity 2 and subtotal $52, and the final header badge read Cart2.
- `2026-07-13T0825-64e7/risk/risk-cart-local-continue@adversarial-tester#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Two shopper-visible issues stood out: missing local continue-shopping from the cart body, and misleading add-to-cart feedback that made the shopper think the add failed while duplicate quantity accumulated. The catalog also lacked direct add controls, which added one navigation step but did not block the task.

## risk/risk-empty-checkout@adversarial-tester

- `2026-07-13T0856-2a58/risk/risk-empty-checkout@adversarial-tester#f1` [major] Empty-cart checkout did not recover or block: /checkout showed a full delivery/payment flow with account-prefilled delivery details and a live `Place order — $6.00` button despite Cart 0.
- `2026-07-13T0856-2a58/risk/risk-empty-checkout@adversarial-tester#f3` [major] No empty-cart recovery was visible on the checkout page: no empty-cart message, no continue-shopping CTA, and no back-to-cart guidance beyond the general header navigation.
- `2026-07-13T0856-2a58/risk/risk-empty-checkout@adversarial-tester#f0` [info] The header did not expose a Checkout control where the user initially expected one next to Cart; direct URL navigation to /checkout still worked immediately.
- `2026-07-13T0856-2a58/risk/risk-empty-checkout@adversarial-tester#f4` [info] The run had no console errors and no axe-core accessibility violations, so the observed failure is product logic/content rather than page instability or baseline accessibility breakage.
- `2026-07-13T0856-2a58/risk/risk-empty-checkout@adversarial-tester#q0` [info] Q: With an empty cart, where did opening checkout send the user?
    A: Opening `/checkout` kept the user on the Checkout page at `http://127.0.0.1:4183/checkout`; it did not redirect to cart, shop, or an error page.
- `2026-07-13T0856-2a58/risk/risk-empty-checkout@adversarial-tester#q2` [info] Q: Was recovery (back to cart or shop) obvious and correct?
    A: No. The checkout page showed no empty-cart recovery message or purpose-built CTA; only the ordinary header navigation was available.

## risk/risk-invalid-email@adversarial-tester

- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#f1` [major] Invalid email save produced no visible validation, success, field reset, or navigation change; the user expected inline Email feedback, a toast/banner, or a message near Save profile.
- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#f3` [major] Valid email save was also visually silent: no confirmation appeared, no DOM/request change was detected, and the account summary still showed "Signed in as riley@example.com" instead of the new email.
- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#f4` [minor] The unchanged "Signed in as" line conflicts with the edited Email field after saving, leaving shoppers unable to tell whether the profile update was accepted, pending, or ignored.
- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#f0` [info] Account was found in the expected header location and led directly to a focused Profile form with Full name, Email, and Save profile visible above the fold.
- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#f2` [info] After the invalid save, the form preserved both fields: Full name stayed "Riley Chen" and Email stayed "not-an-email", so the app did not blank the form or snap back to the previous email.
- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#f5` [info] No axe-core accessibility violations or console errors were recorded, so the observed failure is interaction feedback/state handling rather than baseline accessibility breakage.
- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#q0` [info] Q: After saving the invalid email, what exactly appeared on screen (error, success, nothing)?
    A: Nothing appeared: no inline error, success message, toast, banner, or visible state change after clicking Save profile with "not-an-email".
- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#q1` [info] Q: Did the form keep the invalid email the user typed, reset to the old value, or clear fields?
    A: It kept the invalid email. Full name stayed "Riley Chen" and Email stayed "not-an-email"; fields did not reset or clear.
- `2026-07-13T0856-2a58/risk/risk-invalid-email@adversarial-tester#q2` [info] Q: After the valid email save, was success visible, and did the field show the new address?
    A: Success was not visible. The Email field showed "riley.fixed@example.com", but there was no confirmation and the signed-in line still showed the old email.

## risk/risk-last-unit@adversarial-tester

- `2026-07-13T0856-2a58/risk/risk-last-unit@adversarial-tester#f2` [major] Adding the full visible stock count of 5 failed even though the message said “Only 5 in stock — you can add 5 more,” which reads like the requested quantity should be allowed; cart stayed empty.
- `2026-07-13T0856-2a58/risk/risk-last-unit@adversarial-tester#f3` [major] The product page did not confirm the successful stock-minus-one add: adding 4 produced no success feedback and the header badge stayed at Cart0 until the user opened the cart, where 4 units were present.
- `2026-07-13T0856-2a58/risk/risk-last-unit@adversarial-tester#f4` [major] Remaining-stock messaging contradicted actual behavior after 4 were in cart: the page claimed “you can add 1 more,” but clicking Add to cart with quantity 1 left the cart at 4.
- `2026-07-13T0856-2a58/risk/risk-last-unit@adversarial-tester#f5` [major] The stock line stayed “In stock — 5 available” even after 4 units were in the cart, making the product page look authoritative while showing inventory that did not account for the cart.
- `2026-07-13T0856-2a58/risk/risk-last-unit@adversarial-tester#f6` [minor] Feedback placement was predictable but visually quiet: the pink stock message appeared under the controls, yet the user noted it was easy to miss against the page and competed with the louder Add to cart button and stock line.
- `2026-07-13T0856-2a58/risk/risk-last-unit@adversarial-tester#f0` [info] Product discoverability was strong: Calathea Orbifolia was visible in the main product grid, and the user reached the detail page in the first step without hunting.
- `2026-07-13T0856-2a58/risk/risk-last-unit@adversarial-tester#f1` [info] The stock count and add controls were where the user expected them: “In stock — 5 available” appeared under the price, with the quantity spinbutton beside Add to cart.
- `2026-07-13T0856-2a58/risk/risk-last-unit@adversarial-tester#q2` [info] Q: After maxing the cart, what happened when they tried one more unit?
    A: After 4 units were in cart, the product page still showed quantity 1 as addable and said “you can add 1 more,” but the add was refused or ignored and the cart remained at 4.

## risk/risk-no-results-clear@adversarial-tester

- `2026-07-13T0825-51dc/risk/risk-no-results-clear@adversarial-tester#f0` [major] Catalog search was not discoverable in the expected place: the user repeatedly expected a text field beside Sort and the green Search button, but only found a Sort combobox and Search button with no visible place to type.
- `2026-07-13T0825-51dc/risk/risk-no-results-clear@adversarial-tester#f1` [major] The Search button was misleading: clicking it changed the URL to `?sort=` but exposed no query field, submitted no search term, and left the full product grid unchanged.
- `2026-07-13T0825-51dc/risk/risk-no-results-clear@adversarial-tester#f4` [major] The only recovery control was broken: clicking “Clear the search” twice left the URL on `?q=zxqq9-no-such-plant-ever` and kept the same empty state instead of restoring products.
- `2026-07-13T0825-51dc/risk/risk-no-results-clear@adversarial-tester#f2` [minor] The user exhausted secondary discovery paths that a shopper might plausibly try: header, product grid, footer, and Account all lacked a catalog search entry point.
- `2026-07-13T0825-51dc/risk/risk-no-results-clear@adversarial-tester#f5` [minor] The empty-results copy mixed shopper-facing language with implementation jargon: “No matches…” and “Clear the search…” were clear, but “Query returned no product rows for the given term” reads like a database/debug message.
- `2026-07-13T0825-51dc/risk/risk-no-results-clear@adversarial-tester#f3` [info] The empty state itself was reachable via URL query and clearly included the nonce term plus an in-context recovery affordance labeled “Clear the search.”

## risk/risk-oos-copy@adversarial-tester

- `2026-07-13T0825-51dc/risk/risk-oos-copy@adversarial-tester#f2` [major] Purchase messaging contradicted itself: the stock line said "In stock — more arriving daily" while the main CTA was a disabled "Out of stock" button and the surrounding copy said the next batch was not ready.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@adversarial-tester#f0` [info] The Fiddle-Leaf Fig product was discoverable from the shop grid without visiting other products first; the card link was visible and led directly to the required URL.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@adversarial-tester#f1` [info] On the product page, the availability copy and purchase button were placed directly under the title and price, matching the shopper’s expectation for where purchase-critical status should live.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@adversarial-tester#f3` [info] The disabled CTA correctly refused interaction when tried once, so the contradiction did not result in an accidental cart add or hidden purchase path.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@adversarial-tester#q1` [info] Q: What did the purchase button say, and was it enabled or disabled?
    A: The main purchase button said "Out of stock" and was disabled.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@adversarial-tester#q2` [info] Q: Did label and control state agree, or contradict each other?
    A: The button label and disabled state agreed with each other, but they contradicted the stock line’s "In stock" claim.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@adversarial-tester#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes. A real shopper would see an in-stock claim beside a disabled out-of-stock CTA, plus copy saying the next batch is still coming, making availability unclear and blocking purchase.

## risk/risk-oos-copy@cautious-first-timer

- `2026-07-13T0825-51dc/risk/risk-oos-copy@cautious-first-timer#f2` [minor] Supporting copy reinforced the out-of-stock state (“next batch is on its way” / sold out in the description), making the green in-stock line look like the erroneous and trust-damaging element.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@cautious-first-timer#f0` [info] The Fiddle-Leaf Fig card was discoverable on the shop grid and already showed “Out of stock,” so the user reached the requested product without trying other products.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@cautious-first-timer#f3` [info] The disabled button behaved consistently with its own label: the attempted click was refused because the control was disabled.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@cautious-first-timer#f4` [info] No axe-core accessibility violations were reported across the run.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@cautious-first-timer#q1` [info] Q: What did the purchase button say, and was it enabled or disabled?
    A: The main purchase button said “Out of stock” and was disabled.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@cautious-first-timer#q2` [info] Q: Did label and control state agree, or contradict each other?
    A: The button label and disabled state agreed with each other, but they contradicted the stock line’s “In stock” claim.
- `2026-07-13T0825-51dc/risk/risk-oos-copy@cautious-first-timer#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes. A shopper would notice the page claims availability while refusing purchase; the surrounding copy also says the plant sold out, so the in-stock line is misleading and undermines confidence.

## risk/risk-receipt-continue@adversarial-tester

- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#f0` [major] The receipt's own Continue shopping control sent the user to `/checkout` with Cart 0 and an empty order summary, creating a post-purchase dead end instead of returning them to the catalog.
- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#f3` [minor] Checkout was blocked by an invalid prefilled 4-digit postcode, which a real shopper would experience as the shop's saved delivery data preventing payment until manually corrected.
- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#f4` [minor] Payment fields showed confusing red states/residual-looking values during validation; the user could not easily tell whether typed card details had stuck or been cleared.
- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#f5` [info] The cheap suggested item was discoverable in the catalog: Gentle Plant Food appeared in the product grid at $12 and was easy to identify as an in-stock care item.
- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#f6` [info] On the receipt page, Continue shopping was visually easy to find under the order summary and clearly separate from the header Shop link.
- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#q0` [info] Q: Did the order complete, and what did the receipt show?
    A: Yes. The order completed as FF-1053 and the receipt showed Gentle Plant Food ×3, total $42, with Cart 0 after purchase.
- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#q1` [info] Q: Where did the receipt's "Continue shopping" control take the user?
    A: It took the user to Checkout at `http://127.0.0.1:4184/checkout`, not the catalog.
- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#q2` [info] Q: Was that destination appropriate after a finished order, or a loop / dead end?
    A: It was inappropriate: checkout had an empty cart state, prefilled delivery fields, and an order summary showing $0 subtotal but $6 total, so it functioned like a confusing dead end rather than a shopping recovery path.
- `2026-07-13T0825-51dc/risk/risk-receipt-continue@adversarial-tester#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes: add-to-cart feedback/badge lag caused accidental quantity 3; cart quantity could not be edited; checkout started with invalid saved postcode; payment validation states looked sticky or misleading. These are separate from the final Continue shopping routing bug.

## risk/risk-receipt-eta@adversarial-tester

- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#f1` [major] The app’s main navigation did not provide a fallback path: the header exposed only Shop, Cart, and Account, so there was no visible Orders or Order history entry after Account failed.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#f2` [major] Common order-history and receipt routes all returned 404s, including /account/orders, /orders, /order/FF-1041, /account/order/FF-1041, /orders/FF-1041, /account/history, and /account/order-history, leaving no reachable receipt for seeded past orders.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#f3` [major] The /order/FF-1041 404 message said “Your order history lives in your account,” but returning to Account still revealed no order-history affordance; the only breadcrumb contradicted the UI.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#f4` [minor] The Account page visually read as finished after the Shipping card and quiet footer, making repeated scrolling feel necessary but unproductive because there was no secondary nav or signpost for hidden account areas.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#f5` [info] No axe-core accessibility violations were recorded across the run, so the failure appears to be information architecture/linking rather than basic accessibility exposure.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#q0` [info] Q: Which past order did the user open, and what status did the shop show?
    A: None. The user never reached FF-1041, FF-1052, or any receipt page, so no order status was shown.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#q1` [info] Q: What exact delivery estimate / ETA text appeared on the receipt?
    A: No ETA text appeared because no receipt loaded.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#q2` [info] Q: Did status and ETA agree for a shipped or delivered order?
    A: Not assessable. Since no shipped or delivered receipt was reachable, there was no status/ETA pair to compare.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@adversarial-tester#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes: Account lacked any visible order-history section or link; header/footer lacked Orders navigation; every plausible order-history or receipt URL 404ed; and one 404 misleadingly said history lives in Account even though Account exposed only Profile and Shipping.

## risk/risk-receipt-eta@cautious-first-timer

- `2026-07-13T0825-64e7/risk/risk-receipt-eta@cautious-first-timer#f1` [major] Common order-history and receipt URLs all dead-ended: /account/orders, /orders, /orders/FF-1041, /account/orders/FF-1041, and /order/FF-1041 did not expose a past order, preventing the user from reaching status or ETA details.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@cautious-first-timer#f2` [major] The /order/FF-1041 error copy told the user “Your order history lives in your account,” but returning to Account still showed no history; that contradiction made the product feel misleading, not merely incomplete.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@cautious-first-timer#f4` [info] Accessibility did not add friction in this run: axe reported no WCAG 2.0 A/AA or 2.1 AA violations across the journey.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@cautious-first-timer#q0` [info] Q: Which past order did the user open, and what status did the shop show?
    A: No past order was opened. The user tried FF-1041 via several plausible receipt paths, but every route failed before any status could be shown.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@cautious-first-timer#q1` [info] Q: What exact delivery estimate / ETA text appeared on the receipt?
    A: No receipt was reachable, so no delivery estimate or ETA text appeared.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@cautious-first-timer#q2` [info] Q: Did status and ETA agree for a shipped or delivered order?
    A: This could not be evaluated because neither a shipped/delivered receipt nor its ETA copy was available through the UI or tried URLs.
- `2026-07-13T0825-64e7/risk/risk-receipt-eta@cautious-first-timer#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes: Account was missing any order-history entry point, common order-history URLs returned 404s, and the /order/FF-1041 error claimed order history lives in Account even though Account only showed Profile and Shipping address.

## risk/risk-sort-order@adversarial-tester

- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#f1` [major] Selecting Price: low to high changed the combobox label and URL to ?sort=price-asc, but the grid stayed in Featured order; the first row remained $38, $26, $19 instead of starting with the visible $14 Terracotta Pot.
- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#f2` [major] Selecting Price: high to low also changed the label and URL but did not reorder the grid; Monstera, Snake Plant, and Golden Pothos still led even though Fiddle-Leaf Fig at $52 was visible lower in the grid.
- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#f3` [minor] The UI gives no failure signal when sort is a no-op: the selected state appears valid, so a shopper would likely trust a misleading sort label unless they manually compared prices.
- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#f4` [minor] The Sort control is present but visually quiet beneath a dominant hero; discoverable for a deliberate tester, but less prominent for casual shoppers scanning the product grid.
- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#f0` [info] The catalog grid and Sort control were discoverable in the expected place: the user looked on the main Shop catalog with Everything selected and found Sort in the toolbar under the hero, next to Search.
- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#q0` [info] Q: What were the first three products/prices before sorting?
    A: Monstera Deliciosa — $38.00; Snake Plant — $26.00; Golden Pothos — $19.00.
- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#q1` [info] Q: What were the first three after sorting Price low to high?
    A: The same three in the same order: Monstera Deliciosa — $38.00; Snake Plant — $26.00; Golden Pothos — $19.00.
- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#q2` [info] Q: Did the grid order actually change to match the selected sort?
    A: No. The label and URL changed to price-asc, but the grid stayed in Featured order; the visible $14 Terracotta Pot did not move to the first position. The optional high-to-low check also failed to reorder.
- `2026-07-13T0825-64e7/risk/risk-sort-order@adversarial-tester#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes: price sorting is broken while appearing active. A shopper selecting low-to-high or high-to-low would see the selected option reflected in the control and URL, but product cards remain unsorted with no warning or feedback.

## risk/risk-sort-order@cautious-first-timer

- `2026-07-13T0825-64e7/risk/risk-sort-order@cautious-first-timer#f2` [major] Selecting `Price: high to low` also left the grid unchanged; the control appeared active but did not reverse the order or move the $52 Fiddle-Leaf Fig to the front.
- `2026-07-13T0825-64e7/risk/risk-sort-order@cautious-first-timer#f3` [minor] Because the control visibly accepts the new sort state without changing results or showing an error, the failure is misleading rather than merely missing; a shopper would likely assume the catalog data is unreliable.
- `2026-07-13T0825-64e7/risk/risk-sort-order@cautious-first-timer#f0` [info] The Sort combobox was exactly where the user expected it, above the product grid and easy to notice; the baseline first three cards were clearly readable in top-left order.
- `2026-07-13T0825-64e7/risk/risk-sort-order@cautious-first-timer#q0` [info] Q: What were the first three products/prices before sorting?
    A: Monstera Deliciosa — $38.00; Snake Plant — $26.00; Golden Pothos — $19.00.
- `2026-07-13T0825-64e7/risk/risk-sort-order@cautious-first-timer#q1` [info] Q: What were the first three after sorting Price low to high?
    A: The same three remained first: Monstera Deliciosa — $38.00; Snake Plant — $26.00; Golden Pothos — $19.00.
- `2026-07-13T0825-64e7/risk/risk-sort-order@cautious-first-timer#q2` [info] Q: Did the grid order actually change to match the selected sort?
    A: No. The order did not change, and $38, $26, $19 is not ascending; cheaper products remained later in the grid.
- `2026-07-13T0825-64e7/risk/risk-sort-order@cautious-first-timer#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Yes. The Sort control looked functional because its label and the URL changed, but the product grid never reordered for either low-to-high or high-to-low. That makes the sort feel decorative and undermines trust in the catalog.

## wheres-my-order@returning-regular

- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#f0` [major] Account was the user’s first and strongest expected location for order history, but it exposed only Profile and Shipping address, leaving no way to see past orders, totals, shipment state, receipt, or tracking.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#f1` [major] The global navigation offered only Shop, Cart, and Account; there was no Orders, Order history, Track order, or Help entry point after Account failed.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#f2` [major] The user could infer a likely product from Shop > Care & Tools > Gentle Plant Food at $12.00, but the product page did not connect that item to any past purchase, paid total, receipt, or shipping status.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#f3` [minor] Cart was a reasonable but unproductive recovery path: the empty-cart state clearly communicated no active cart items, but gave no bridge to previous orders or receipts.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#f4` [minor] Footer contact was the only apparent escalation path, but it provided only an email address and no order lookup, tracking link, or guidance on what order facts to include.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#f5` [info] The visual hierarchy consistently emphasized profile forms, product browsing, and add-to-cart actions; order-management affordances were not merely hidden low on the page, they appeared absent from every checked surface.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#q0` [info] Q: Could the user find the order at all, and how many wrong turns did it take?
    A: No. They made five distinct wrong turns after the expected Account page failed: rechecking Account/footer, trying Shop, filtering to Care & Tools, opening the plant-food product page, and checking Cart. The repeated Account revisit was confirmation, not success.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#q1` [info] Q: What did the user conclude about the order's contents, cost, and status — and does the shop back each conclusion with something on screen?
    A: They could only conclude that the likely item was Gentle Plant Food and that its current shelf price is $12.00; the shop backed that on the product listing/page. It did not back any conclusion about the actual order, amount paid after taxes/shipping, or shipment status because no order record appeared.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#q2` [info] Q: Where, if anywhere, did the user hesitate, backtrack, or get confused — and what on the screen caused it?
    A: The hesitation centered on Account: the page looked complete with Profile and Shipping address cards, so the user scrolled and rechecked instead of immediately knowing orders were unavailable. The sparse nav and footer then forced backtracking because there was no obvious next order-related path.
- `2026-07-13T0825-51dc/wheres-my-order@returning-regular#q3` [info] Q: Was anything broken, misleading, or missing that a real shopper would notice? Be specific.
    A: Missing: a customer order history, order-detail page, paid total, fulfillment/shipping status, tracking, and any Orders/Track order navigation. Misleading: Account feels like the right signed-in place for receipts but only manages profile/address data. Nothing appears technically broken; the product is browsable and cart loads, but the post-purchase workflow is absent.
