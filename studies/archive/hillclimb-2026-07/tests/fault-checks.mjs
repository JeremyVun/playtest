// Per-fault manifestation checks for the hill-climb study catalog.
// Each check answers "is this fault LIVE on the app at `url`?" — true on the
// injected copy, false on the clean reference. Checks are deterministic and
// offline (plain fetch against a local instance; no browser). For client-JS
// behavior faults the served page bytes ARE the behavior (no build step), so
// asserting on the inline script is an honest liveness check.
//
// Manifestation ≠ reachability: masked faults (see faults.json masked_by)
// are checked via direct URLs on purpose — they must be live in the
// fully-broken baseline even when no UI path reaches them.

async function text(url, path) {
  const res = await fetch(url + path);
  return res.text();
}

async function api(url, method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function reset(url) {
  await api(url, "POST", "/api/reset");
}

async function seedCart(url) {
  await reset(url);
  await api(url, "POST", "/api/cart/items", { product_id: "monstera", qty: 2 });
}

export const CHECKS = {
  "f-price-contrast": async (url) => (await text(url, "/")).includes("color: #c3cdc6"),

  "f-error-text-contrast": async (url) => (await text(url, "/")).includes(".field-error { color: #e4c7c7"),

  "f-oos-says-in-stock": async (url) =>
    (await text(url, "/product/fiddle-leaf-fig")).includes("In stock — more arriving daily"),

  "f-free-shipping-label": async (url) => {
    await seedCart(url);
    return (await text(url, "/checkout")).includes("<span>Free shipping</span>");
  },

  // Masked fault: checked via direct URL to a seeded DELIVERED order.
  "f-receipt-eta-wrong": async (url) => {
    await reset(url);
    return (await text(url, "/order/o-1041")).includes("arrives in 3–5 days");
  },

  "f-empty-cart-jargon": async (url) => {
    await reset(url);
    return (await text(url, "/cart")).includes("Cart collection returned 0 rows.");
  },

  "f-no-results-jargon": async (url) =>
    (await text(url, "/?q=zzzqqx")).includes("Query returned no product rows"),

  // Behavioral: sorted-by-price must NOT put the cheapest product first.
  "f-sort-inert": async (url) => {
    const { body } = await api(url, "GET", "/api/products?sort=price-asc");
    return body.products[0].id !== "plant-food";
  },

  "f-save-profile-dead": async (url) =>
    (await text(url, "/account")).includes('type="button">Save profile'),

  "f-add-cart-silent": async (url) =>
    (await text(url, "/product/monstera")).includes(".then(function (cart) {})"),

  "f-place-order-no-feedback": async (url) => {
    await seedCart(url);
    return !(await text(url, "/checkout")).includes("Placing your order…");
  },

  "f-postcode-validation": async (url) => {
    await seedCart(url);
    return (await text(url, "/checkout")).includes("Enter a 5-digit postcode.");
  },

  "f-card-spaces-validation": async (url) => {
    await seedCart(url);
    return (await text(url, "/checkout")).includes("( \\d{4}){3}");
  },

  "f-decline-swallowed": async (url) => {
    await seedCart(url);
    return !(await text(url, "/checkout")).includes("banner.textContent = e.message");
  },

  "f-account-error-swallowed": async (url) =>
    (await text(url, "/account")).includes('["email", null]'),

  "f-validation-wipes-payment": async (url) => {
    await seedCart(url);
    return (await text(url, "/checkout")).includes('$("#card_number").value = ""');
  },

  "f-account-form-resets": async (url) =>
    (await text(url, "/account")).includes("input.defaultValue"),

  // Behavioral where possible: place a real order, follow its receipt link.
  "f-continue-shopping-loop": async (url) => {
    await seedCart(url);
    const order = await api(url, "POST", "/api/orders", {
      name: "Riley Chen", email: "riley@example.com", street: "14 Foxglove Lane",
      city: "Millbrook", postcode: "5041", card_number: "4242 4242 4242 4242",
      expiry: "12/28", cvc: "123",
    });
    return (await text(url, `/order/${order.body.id}`)).includes('href="/checkout">Continue shopping');
  },

  "f-clear-search-self-link": async (url) =>
    (await text(url, "/?q=zzzqqx")).includes('<a href="/?q=zzzqqx">Clear the search</a>'),

  // Behavioral: buying the entire stock of an item must fail on broken.
  "f-cant-buy-last-unit": async (url) => {
    await reset(url);
    const { status } = await api(url, "POST", "/api/cart/items", { product_id: "monstera", qty: 7 });
    return status === 400;
  },

  // Behavioral: GET /checkout with an empty cart must render (200) instead of redirecting (303).
  "f-checkout-empty-guard-gone": async (url) => {
    await reset(url);
    const res = await fetch(url + "/checkout", { redirect: "manual" });
    return res.status === 200;
  },

  "f-search-removed": async (url) => !(await text(url, "/")).includes('type="search"'),

  "f-qty-edit-removed": async (url) => {
    await seedCart(url);
    return !(await text(url, "/cart")).includes('class="dec"');
  },

  "f-order-history-removed": async (url) => !(await text(url, "/account")).includes("Order history"),

  "f-product-crumb-removed": async (url) =>
    !(await text(url, "/product/monstera")).includes('class="crumb"'),

  "f-cart-continue-removed": async (url) => {
    await seedCart(url);
    return !(await text(url, "/cart")).includes("← Continue shopping");
  },
};
