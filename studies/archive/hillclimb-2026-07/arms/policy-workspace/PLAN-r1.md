# Verification-round spend plan (Phase 1 → run for Phase 2)

Goal of the next round: confirm the 16 fixes hold, catch any regression, and
resolve the 2 probes. Default actor tier is **gpt5_4_mini**; escalations noted.

## Persona marginal-detection read (from the two rounds)

- **returning-regular** — the *only* persona that surfaced order-history-absent
  (its `wheres-my-order` journey) and consistently drove profile-save + club-order
  overfill. Highest unique yield. **Keep, heaviest use.**
- **cautious-first-timer** — uniquely surfaced the trust/policy gap and was the most
  thorough on checkout recovery (field-wipe, decline-silence, contrast). **Keep.**
- **weekend-browser** — uniquely surfaced cart edit/remove (`change-your-mind`),
  sort reset, and Place-order-silent. **Keep.**
- **gift-rusher** — mostly duplicated add-to-cart/checkout findings others already
  caught; its one distinctive edge is fast repeat-clicking (the sharpest test of the
  B1 add-to-cart feedback fix) and noticing the missing search box. **Retire from the
  checkout/moving-house cells it duplicated; keep on a single cell** to stress the
  headline fix from the fast-click angle.

## Journey → persona allocation (all 8 discovery journeys)

| Journey | Persona | Why this persona (marginal detection) | Fixes it verifies |
|---|---|---|---|
| buy-a-specific-gift | gift-rusher | Fast repeat-clicker — the toughest test that B1 feedback now stops accidental ×2. Its only non-duplicative role this round. | B1, B14 |
| change-your-mind | weekend-browser | Sole surfacer of cart edit/remove failure. | B2, B3 |
| checkout-hiccup | cautious-first-timer | Most thorough checkout-recovery reader; surfaced decline-silence + field-wipe. | B4, B5, B6, B13 |
| club-order | returning-regular | Hit the ×16 overfill and the correction dead-end. | B1, B2, B3, B14 |
| first-impressions | cautious-first-timer | Sole surfacer of the trust gap + the free-shipping label. Carries probe P1. | B7, B11 (+ probe P1) |
| moving-house | returning-regular | Consistently exposed profile-save + email-to-checkout + postcode. | B4, B5, B8 |
| outfit-a-shelf | weekend-browser | Surfaced sort reset + add-to-cart duplicates. Carries probe P2. | B1, B10, B12 (+ probe P2) |
| wheres-my-order | returning-regular | The only cell that tests order history at all. | B9 |

Distribution: returning-regular ×3, cautious-first-timer ×2, weekend-browser ×2,
gift-rusher ×1 — spend rotated toward the three highest-yield personas, gift-rusher
narrowed to its one non-duplicative use (policy point 4).

## Regression set (runs every round, pinned per fix)

All 11 stories in `policy-regression/stories/` run each round:
add-to-cart-feedback, cart-edit-and-remove, checkout-recovery,
checkout-summary-shipping, account-profile-save, account-order-history,
catalog-sort, catalog-search, accessibility-contrast, empty-cart-and-back-link,
sort-persists-round-trip (added phase 2 after probe P2 confirmed B17).
(These are the promoted, pinned journeys — policy point 6.)

## Phase-2 probe outcomes (settled)

- P2 sort persistence: **confirmed** → fixed (B17) + pinned regression story.
- P1 trust content: **confirmed-real, out of contract** → reject held; escalated
  to study owners as a SPEC gap ("Who it serves" trust goal has no capability).

## Probes (run once, to settle the two ambiguous beliefs)

- `probe-trust-policy-content.yaml` — does missing shipping/returns/security policy
  content actually block a first-time purchase, or is it a nice-to-have? Decides
  whether to build trust content or hold the reject.
- `probe-sort-persistence.yaml` — after B10, does the sort survive navigating into a
  product and back? Decides whether sort state needs to ride the back link / URL.

## Tier escalation requests (policy point 5)

- **ESCALATE `first-impressions@cautious-first-timer` (the trust probe P1) to gpt5_5.**
  Justification: the belief hinges on a nuanced judgment — whether the *absence of
  policy content* blocks purchase versus a general "demo shop feels unfinished"
  impression. In both rounds the mini actor conflated the two (`f2`/`f6`), which is
  exactly the distinction the probe must separate. This is evidence-ambiguous and
  tester-judgment-bound, the two conditions for escalation. All other cells stay on
  gpt5_4_mini — their fixes are crisp functional checks (badge updates, Remove works,
  order history present) the default tier reads reliably.
