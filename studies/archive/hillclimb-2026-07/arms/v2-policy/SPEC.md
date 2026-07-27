# Fern & Fog — product spec (the clean reference)

Fern & Fog is a small online houseplant shop: plants, pots, and care tools.
This document is the product spec for the hill-climb study's subject app. It
defines what the app **does when it is seamless** — the top of the hill. The
committed app in this directory must satisfy every capability below; study
stories and personas are authored from this spec alone; a capability listed
here that the running app lacks is a defect, not a matter of taste.

It is a fixture, not a product: one demo shopper (no sign-up or sign-in),
in-memory state, mock payment. Those are scope boundaries, not defects.

## Who it serves

Ordinary online shoppers, not developers:

- someone who arrives **knowing what they want** (a named plant, a gift) and
  wants to find it, buy it, and get out in a few minutes;
- someone **browsing without a goal**, comparing options by category and price
  before committing;
- a **returning customer** checking on a past order or updating their details;
- a **first-time visitor** deciding in a minute whether this shop is
  trustworthy and worth their card number.

No capability may require jargon, a manual, or knowledge of how the shop is
built. Every mistake a shopper can make must be recoverable from where they
made it.

## Structure

Six pages, one consistent header on all of them:

| Route | Page |
|---|---|
| `/` | Catalog — the shop front |
| `/product/:id` | Product detail |
| `/cart` | Cart |
| `/checkout` | Checkout |
| `/order/:id` | Order confirmation / receipt |
| `/account` | Account: profile, address, order history |

**Header (every page):** the shop name (links home), Shop, Cart — with a
count badge that always reflects how many items are in the cart — and
Account. The current section is visibly marked. Unknown URLs get a friendly
not-found page with a way back to the shop; they never dead-end.

## Capabilities

### C1. Catalog (`/`)

- **C1.1 Browse**: every product appears as a card — image, name, price —
  linking to its detail page. Out-of-stock products are visibly marked on
  the card.
- **C1.2 Search**: a search box finds products by words in their name or
  description. Results state what was searched and how many matched.
- **C1.3 Filter by category**: one click narrows the catalog to Plants,
  Pots & Planters, or Care & Tools; the active category is visibly selected;
  one click returns to everything. Search and category compose.
- **C1.4 Sort**: by price (both directions) and name; the active sort is
  visible in the control.
- **C1.5 Empty results recover**: a search with no matches says so in plain
  words and offers one-click recovery (clear the search), never a blank grid.

### C2. Product detail (`/product/:id`)

- **C2.1 Full picture**: name, price, image, prose description, and a short
  table of practical details (size, light, material — whatever fits the
  product).
- **C2.2 Stock honesty**: in-stock products say how many are available;
  out-of-stock products say so plainly, explain, and disable purchase — the
  page never pretends it can sell what it can't.
- **C2.3 Add to cart**: choose a quantity (bounded 1..stock) and add. The
  action gives an immediate receipt: a confirmation message naming the item,
  a link to the cart, and the header badge updating — without leaving the
  page. Asking for more than stock is refused with the exact number that fits.
- **C2.4 Way back**: a link returns to the catalog, preserving the product's
  category.

### C3. Cart (`/cart`)

- **C3.1 Legible lines**: each line shows the item (linked back to its detail
  page), unit price, quantity, and line total; the subtotal is always
  current.
- **C3.2 Edit quantity in place**: stepper and direct entry, bounded by
  stock; totals and the header badge update immediately, no page reload
  needed.
- **C3.3 Remove**: one action per line, with a confirmation message naming
  what was removed.
- **C3.4 Empty state**: an empty cart says so warmly and links back to the
  shop. Reaching checkout with an empty cart routes back here with an
  explanation instead of showing a broken form.
- **C3.5 Onward paths**: checkout is one obvious primary action; continuing
  to shop is one link.

### C4. Checkout (`/checkout`)

- **C4.1 One form, prefilled**: delivery details start from the account
  profile, so a returning shopper mostly confirms rather than types.
- **C4.2 Order summary in sight**: items, subtotal, flat $6.00 shipping, and
  total are visible beside the form; the pay button restates the total.
- **C4.3 Validation that helps**: every field is checked (presence; email
  shape; 15–16 digit card; MM/YY future expiry; 3–4 digit code) with a
  specific message under the exact field, on leaving the field and on
  submit; focus moves to the first problem. **Nothing the shopper typed is
  ever lost** to a validation round-trip.
- **C4.4 Honest submission**: submitting shows a visible in-progress state,
  can't be double-submitted, and either lands on the confirmation page or
  shows the server's plain-language reason (e.g. card declined) with the
  form intact and editable. A declined card clearly states no charge was
  made.
- **C4.5 Server-side truth**: the server re-validates everything the client
  checks and re-checks stock at order time, so the client can never place an
  order the shop can't honor.

### C5. Order confirmation (`/order/:id`)

- **C5.1 Receipt**: order number, each item with quantity and price,
  subtotal/shipping/total, the delivery address, and a delivery estimate.
- **C5.2 Effects are real**: placing the order emptied the cart (badge shows
  0) and reduced product stock by what was bought.
- **C5.3 Onward paths**: continue shopping and view-your-orders are both one
  click; the receipt stays reachable from order history forever (within the
  session).

### C6. Account (`/account`)

- **C6.1 Profile**: view and edit name and email, with validation and a
  visible save confirmation.
- **C6.2 Shipping address**: view and edit street/city/postcode, same
  standard; checkout prefills reflect saved changes immediately.
- **C6.3 Order history**: every order — seeded and newly placed — listed
  newest-first with number, date, item count, total, and status; each links
  to its receipt.

### C7. System-wide guarantees

- **C7.1 Receipts everywhere**: every state-changing action (add, edit,
  remove, save, order) produces an immediate visible acknowledgment near
  where the shopper is looking.
- **C7.2 Errors surface, in English**: no failure is ever silent, and no
  raw error code or stack reaches the shopper; every error names what to do
  next, and never costs the shopper their work.
- **C7.3 Accessible by default**: all controls are labeled and keyboard
  reachable, focus is visible, dynamic confirmations are announced
  (aria-live), text contrast meets WCAG AA. An axe scan of any page reports
  no violations.
- **C7.4 No dead ends**: every page — including not-found and error states —
  offers a next step.
- **C7.5 URL honesty**: catalog state (search/category/sort) lives in the
  URL and survives reload/back; product, order, and account pages are
  directly linkable.

## Out of scope (not defects)

Sign-up/sign-in (one demo account, always "signed in"); real payment
processing (mock card; `4000 0000 0000 0002` always declines — a test
affordance); inventory restocking UI; wishlists/reviews/promo codes;
product recommendations and related-item suggestions; email sending
(receipts are claimed, not sent); persistence across server restarts.

## Mechanics (for operators, not shoppers)

Zero-dependency Node >= 20 ESM; `node server.js` binds `PORT` (default
4183); `start({ port })` is importable for tests; state is in-memory and
per-instance; `POST /api/reset` restores the seed (products, one demo
account, two past orders, empty cart). JSON API under `/api/*` mirrors every
page capability (products with search/category/sort params, cart CRUD,
orders, account) and is what the pages' client JS calls.
