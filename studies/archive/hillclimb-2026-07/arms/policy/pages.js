// Server-rendered pages for Fern & Fog. Each page* function returns a full
// HTML document string; interactive behavior is plain inline client JS in the
// todo-app style (no build step, no dependencies).

import { CATEGORIES, SHIPPING_CENTS } from "./data.js";

export function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function money(cents) {
  return "$" + (cents / 100).toFixed(2);
}

function art(product, size) {
  return `<span class="art" style="--art-bg:${product.hue};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.52)}px" aria-hidden="true">${product.glyph}</span>`;
}

const STYLE = `
  :root {
    --ink: #24312a; --muted: #4e5f55; --line: #ddd8cc; --bg: #faf8f3;
    --card: #ffffff; --brand: #2e6b4f; --brand-dark: #245540; --accent: #f3ede1;
    --danger: #a83232; --ok: #2e6b4f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: var(--brand); }
  a:hover { color: var(--brand-dark); }
  :focus-visible { outline: 3px solid #7fb59a; outline-offset: 2px; border-radius: 4px; }
  header.site { background: var(--card); border-bottom: 1px solid var(--line); }
  header.site .inner { max-width: 960px; margin: 0 auto; padding: 14px 20px;
    display: flex; align-items: center; gap: 24px; }
  .brand { font-weight: 700; font-size: 20px; color: var(--ink); text-decoration: none; letter-spacing: .2px; }
  .brand .leaf { color: var(--brand); }
  nav.site { margin-left: auto; display: flex; gap: 18px; align-items: center; }
  nav.site a { text-decoration: none; color: var(--ink); font-weight: 500; padding: 4px 2px; }
  nav.site a[aria-current="page"] { color: var(--brand); border-bottom: 2px solid var(--brand); }
  .cart-link { position: relative; }
  .badge { display: inline-block; min-width: 20px; padding: 1px 6px; margin-left: 6px;
    background: var(--brand); color: #fff; border-radius: 999px; font-size: 13px;
    font-weight: 600; text-align: center; }
  .badge[data-count="0"] { background: #5c6a62; }
  main { max-width: 960px; margin: 0 auto; padding: 28px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  footer.site { border-top: 1px solid var(--line); color: var(--muted);
    max-width: 960px; margin: 0 auto; padding: 18px 20px 32px; font-size: 14px; }
  .art { display: inline-flex; align-items: center; justify-content: center;
    background: var(--art-bg, var(--accent)); border-radius: 12px; flex: none; }

  /* catalog */
  form.finder { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 18px; }
  form.finder input[type=search] { flex: 1 1 220px; padding: 9px 12px; font-size: 16px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 22px; padding: 0; list-style: none; }
  .chips a { display: inline-block; padding: 6px 14px; border-radius: 999px; text-decoration: none;
    border: 1px solid var(--line); color: var(--ink); background: var(--card); font-size: 14px; }
  .chips a[aria-current="true"] { background: var(--brand); border-color: var(--brand); color: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px;
    padding: 0; margin: 0; list-style: none; }
  .card { display: block; background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 16px; text-decoration: none; color: var(--ink); }
  .card:hover { border-color: var(--brand); }
  .card .art { margin-bottom: 10px; }
  .card h2 { font-size: 16px; margin: 0 0 2px; }
  .card .price { font-weight: 600; color: var(--ink); }
  .card .blurb { color: var(--muted); font-size: 14px; margin: 4px 0 0; }
  .stock-note { display: inline-block; margin-top: 8px; font-size: 13px; font-weight: 600;
    color: var(--danger); }
  .empty { background: var(--card); border: 1px dashed var(--line); border-radius: 12px;
    padding: 36px 24px; text-align: center; color: var(--muted); }
  .empty a { font-weight: 600; }

  /* buttons + forms */
  .btn { display: inline-block; padding: 10px 20px; border-radius: 8px; border: 1px solid var(--brand);
    background: var(--brand); color: #fff; font-size: 16px; font-weight: 600; cursor: pointer;
    text-decoration: none; text-align: center; }
  .btn:hover { background: var(--brand-dark); }
  .btn[disabled] { background: #9aa8a0; border-color: #9aa8a0; cursor: not-allowed; }
  .btn.secondary { background: var(--card); color: var(--brand); }
  .btn.secondary:hover { background: var(--accent); }
  .btn.small { padding: 5px 12px; font-size: 14px; }
  label { display: block; font-weight: 600; margin: 14px 0 4px; }
  input[type=text], input[type=email], input[type=number] { padding: 9px 12px; font-size: 16px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--card); width: 100%; max-width: 380px; }
  input[aria-invalid="true"] { border-color: var(--danger); }
  .field-error { color: var(--danger); font-size: 14px; margin: 4px 0 0; }
  .banner { border-radius: 10px; padding: 12px 16px; margin: 0 0 18px; font-weight: 500; }
  .banner.error { background: #f7e4e4; color: var(--danger); border: 1px solid #e3bcbc; }
  .banner.info { background: var(--accent); border: 1px solid var(--line); }

  /* product */
  .product { display: flex; gap: 28px; flex-wrap: wrap; }
  .product .info { flex: 1 1 320px; max-width: 520px; }
  .crumb { margin: 0 0 18px; font-size: 14px; }
  .price-line { font-size: 22px; font-weight: 700; margin: 6px 0 2px; }
  .stock-line { margin: 0 0 16px; color: var(--muted); }
  .stock-line.out { color: var(--danger); font-weight: 600; }
  .buy { display: flex; gap: 12px; align-items: flex-end; margin: 18px 0 8px; }
  .buy .qty { width: 90px; }
  dl.details { display: grid; grid-template-columns: max-content 1fr; gap: 4px 18px; margin: 22px 0 0;
    border-top: 1px solid var(--line); padding-top: 16px; }
  dl.details dt { font-weight: 600; } dl.details dd { margin: 0; color: var(--muted); }

  /* cart */
  table.cart { width: 100%; border-collapse: collapse; background: var(--card);
    border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  table.cart th { text-align: left; font-size: 13px; text-transform: uppercase; letter-spacing: .4px;
    color: var(--muted); padding: 12px 14px; border-bottom: 1px solid var(--line); }
  table.cart td { padding: 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  table.cart tr:last-child td { border-bottom: 0; }
  .item-cell { display: flex; gap: 12px; align-items: center; }
  .item-cell a { font-weight: 600; text-decoration: none; }
  .stepper { display: inline-flex; align-items: center; gap: 6px; }
  .stepper button { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--card); font-size: 18px; cursor: pointer; line-height: 1; }
  .stepper button:hover { border-color: var(--brand); color: var(--brand); }
  .stepper input { width: 56px; text-align: center; }
  .remove { background: none; border: none; color: var(--danger); font-size: 14px; cursor: pointer;
    text-decoration: underline; padding: 2px; }
  .cart-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 20px;
    flex-wrap: wrap; gap: 14px; }
  .subtotal { font-size: 18px; } .subtotal strong { font-size: 22px; }

  /* checkout + order */
  .checkout { display: flex; gap: 36px; flex-wrap: wrap; }
  .checkout form { flex: 1 1 340px; max-width: 460px; }
  .summary { flex: 1 1 260px; max-width: 340px; background: var(--card); border: 1px solid var(--line);
    border-radius: 12px; padding: 18px 20px; align-self: flex-start; }
  .summary h2 { font-size: 17px; margin: 0 0 12px; }
  .summary ul { list-style: none; margin: 0 0 12px; padding: 0; }
  .summary li { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 15px; }
  .summary .totals { border-top: 1px solid var(--line); padding-top: 10px; }
  .summary .grand { font-weight: 700; font-size: 17px; }
  fieldset { border: none; margin: 26px 0 0; padding: 0; }
  legend { font-size: 18px; font-weight: 700; padding: 0; margin-bottom: 2px; }
  .row2 { display: flex; gap: 14px; } .row2 > div { flex: 1; }
  .confirm-hero { text-align: center; padding: 20px 0 4px; }
  .confirm-hero .mark { display: inline-flex; width: 56px; height: 56px; border-radius: 50%;
    background: var(--brand); color: #fff; font-size: 30px; align-items: center; justify-content: center; }
  .order-box { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 20px 24px; max-width: 560px; margin: 22px auto; text-align: left; }
  .order-box ul { list-style: none; padding: 0; margin: 0 0 12px; }
  .order-box li { display: flex; justify-content: space-between; padding: 6px 0; }
  .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 10px; }

  /* account */
  section.panel { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 20px 24px; margin: 0 0 22px; max-width: 640px; }
  section.panel h2 { margin: 0 0 4px; font-size: 19px; }
  section.panel p.hint { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
  table.orders { width: 100%; border-collapse: collapse; }
  table.orders th { text-align: left; font-size: 13px; text-transform: uppercase; letter-spacing: .4px;
    color: var(--muted); padding: 8px 10px 8px 0; border-bottom: 1px solid var(--line); }
  table.orders td { padding: 10px 10px 10px 0; border-bottom: 1px solid var(--line); }
  table.orders tr:last-child td { border-bottom: 0; }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .chip.delivered { background: #e0ece4; color: var(--brand-dark); }
  .chip.shipped { background: #e3e9f3; color: #2d4a75; }
  .chip.confirmed { background: var(--accent); color: var(--ink); }

  /* toast */
  #toasts { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; gap: 8px; z-index: 50; width: min(440px, 92vw); }
  .toast { background: var(--ink); color: #fff; border-radius: 10px; padding: 12px 16px;
    box-shadow: 0 6px 24px rgba(0,0,0,.22); display: flex; gap: 14px; align-items: center;
    justify-content: space-between; }
  .toast a { color: #bfe3d0; font-weight: 600; }
`;

// Shared client helpers, inlined on every page.
const SHARED_JS = `
  function $(sel, root) { return (root || document).querySelector(sel); }
  function money(cents) { return "$" + (cents / 100).toFixed(2); }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || ("request failed (" + res.status + ")")); e.status = res.status; throw e; }
        return data;
      });
    });
  }
  function setCartBadge(count) {
    var b = $("#cart-badge");
    if (!b) return;
    b.textContent = String(count);
    b.setAttribute("data-count", String(count));
    b.setAttribute("aria-label", count === 1 ? "1 item in cart" : count + " items in cart");
  }
  function toast(message, action) {
    var region = $("#toasts");
    var el = document.createElement("div");
    el.className = "toast";
    var span = document.createElement("span");
    span.textContent = message;
    el.appendChild(span);
    if (action) {
      var a = document.createElement("a");
      a.href = action.href; a.textContent = action.label;
      el.appendChild(a);
    }
    region.appendChild(el);
    setTimeout(function () { el.remove(); }, 20000);
  }
`;

function layout({ title, active, cartCount, body, script = "" }) {
  const navLink = (href, label, key, extra = "") =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ""}${extra}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Fern &amp; Fog</title>
<style>${STYLE}</style>
</head>
<body>
<header class="site">
  <div class="inner">
    <a class="brand" href="/"><span class="leaf">❦</span> Fern &amp; Fog</a>
    <nav class="site" aria-label="Site">
      ${navLink("/", "Shop", "shop")}
      ${navLink("/cart", `Cart<span class="badge" id="cart-badge" data-count="${cartCount}" aria-label="${cartCount === 1 ? "1 item in cart" : cartCount + " items in cart"}">${cartCount}</span>`, "cart", ' class="cart-link"')}
      ${navLink("/account", "Account", "account")}
    </nav>
  </div>
</header>
<main>
${body}
</main>
<footer class="site">Fern &amp; Fog — houseplants and the things they need. Questions? hello@fernandfog.example</footer>
<div id="toasts" role="status" aria-live="polite"></div>
<script>${SHARED_JS}${script}</script>
</body>
</html>`;
}

function catalogHref({ q, category, sort }) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  if (sort) params.set("sort", sort);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

export function pageCatalog({ products, q, category, sort, cartCount }) {
  const chips = [{ id: "", label: "Everything" }, ...CATEGORIES]
    .map((c) => `<li><a href="${esc(catalogHref({ q, category: c.id, sort }))}" aria-current="${(category || "") === c.id ? "true" : "false"}">${esc(c.label)}</a></li>`)
    .join("\n      ");

  const stateQs = catalogHref({ q, category, sort }).replace(/^\/\??/, "");
  const cards = products
    .map(
      (p) => `<li><a class="card" href="/product/${esc(p.id)}${stateQs ? `?${esc(stateQs)}` : ""}">
        ${art(p, 72)}
        <h2>${esc(p.name)}</h2>
        <span class="price">${money(p.price)}</span>
        <p class="blurb">${esc(p.blurb)}</p>
        ${p.stock === 0 ? '<span class="stock-note">Out of stock</span>' : ""}
      </a></li>`
    )
    .join("\n      ");

  const activeCat = CATEGORIES.find((c) => c.id === category);
  const heading = activeCat ? activeCat.label : "Everything for your indoor jungle";
  const results = q
    ? `<p class="sub">${products.length === 0 ? "No matches" : products.length === 1 ? "1 match" : products.length + " matches"} for “${esc(q)}”.</p>`
    : `<p class="sub">Hardy plants, handsome pots, and the tools to keep both thriving.</p>`;

  const empty = `<div class="empty">
      <p>We couldn’t find anything matching “${esc(q)}”.</p>
      <p><a href="${esc(catalogHref({ category, sort }))}">Clear the search</a> to browse everything${activeCat ? " in this category" : ""}.</p>
    </div>`;

  const body = `
  <h1>${esc(heading)}</h1>
  ${results}
  <form class="finder" method="get" action="/" role="search">
    ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ""}
    <input type="search" name="q" value="${esc(q)}" placeholder="Search plants, pots, and tools" aria-label="Search products">
    <label for="sort" style="margin:0">Sort</label>
    <select id="sort" name="sort" onchange="this.form.requestSubmit()" style="padding:9px 10px;font-size:15px;border:1px solid var(--line);border-radius:8px;background:var(--card)">
      <option value="" ${!sort ? "selected" : ""}>Featured</option>
      <option value="price-asc" ${sort === "price-asc" ? "selected" : ""}>Price: low to high</option>
      <option value="price-desc" ${sort === "price-desc" ? "selected" : ""}>Price: high to low</option>
      <option value="name" ${sort === "name" ? "selected" : ""}>Name A–Z</option>
    </select>
    <button class="btn small secondary" type="submit">Search</button>
  </form>
  <ul class="chips" aria-label="Categories">
      ${chips}
  </ul>
  ${products.length === 0 ? empty : `<ul class="grid">\n      ${cards}\n  </ul>`}`;

  return layout({ title: activeCat ? activeCat.label : "Shop", active: "shop", cartCount, body });
}

export function pageProduct({ product: p, cartCount, catalogState = {} }) {
  const cat = CATEGORIES.find((c) => c.id === p.category);
  // The way back preserves where the shopper came from — search, category,
  // and sort all survive the round trip; a direct visit falls back to the
  // product's own category.
  const hasState = Boolean(catalogState.q || catalogState.category || catalogState.sort);
  const backCategory = hasState ? catalogState.category : p.category;
  const backCat = CATEGORIES.find((c) => c.id === backCategory);
  const backHref = catalogHref({
    q: hasState ? catalogState.q : "",
    category: backCategory,
    sort: hasState ? catalogState.sort : "",
  });
  const backLabel = backCat ? backCat.label : "the shop";
  const details = Object.entries(p.details)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join("\n      ");

  const buy =
    p.stock === 0
      ? `<p class="stock-line">In stock — more arriving daily</p>
         <p class="sub" id="stock-reason">The next batch is on its way from the greenhouse — check back soon.</p>
         <button class="btn" disabled aria-describedby="stock-reason">Out of stock</button>`
      : `<p class="stock-line">In stock — ${p.stock} available</p>
         <form id="buy" class="buy">
           <div>
             <label for="qty">Quantity</label>
             <input class="qty" id="qty" name="qty" type="number" inputmode="numeric" min="1" max="${p.stock}" value="1">
           </div>
           <button class="btn" id="add" type="submit">Add to cart</button>
         </form>
         <p class="field-error" id="buy-error" hidden></p>`;

  const body = `
  <div class="product">
    ${art(p, 180)}
    <div class="info">
      <p class="crumb"><a href="${esc(backHref)}">← Back to ${esc(backLabel)}</a></p>
      <h1>${esc(p.name)}</h1>
      <p class="price-line">${money(p.price)}</p>
      ${buy}
      <p>${esc(p.description)}</p>
      <dl class="details">
      ${details}
      </dl>
    </div>
  </div>`;

  const script =
    p.stock === 0
      ? ""
      : `
  $("#buy").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var qtyInput = $("#qty");
    var err = $("#buy-error");
    var qty = parseInt(qtyInput.value, 10);
    err.hidden = true;
    qtyInput.removeAttribute("aria-invalid");
    if (!(qty >= 1)) {
      err.textContent = "Enter a quantity of at least 1.";
      err.hidden = false; qtyInput.setAttribute("aria-invalid", "true"); qtyInput.focus();
      return;
    }
    var btn = $("#add");
    btn.disabled = true;
    var name = ${JSON.stringify(p.name)};
    api("POST", "/api/cart/items", { product_id: ${JSON.stringify(p.id)}, qty: qty })
      .then(function (cart) {
        setCartBadge(cart.count);
        toast((qty > 1 ? qty + " × " + name : name) + " added to your cart.", { href: "/cart", label: "View cart" });
      })
      .catch(function (e) {
        err.textContent = e.message;
        err.hidden = false; qtyInput.setAttribute("aria-invalid", "true");
      })
      .then(function () { btn.disabled = false; });
  });`;

  return layout({ title: p.name, active: "shop", cartCount, body, script });
}

export function pageCart({ cart, notice, cartCount }) {
  if (cart.items.length === 0) {
    const banner =
      notice === "empty-checkout"
        ? `<div class="banner info">Your cart is empty — add something before checking out.</div>`
        : "";
    const body = `
  <h1>Your cart</h1>
  ${banner}
  <div class="empty">
    <p>Your cart is empty for now — nothing added yet.</p>
    <p><a href="/">Browse the shop</a> to find it a plant or two.</p>
  </div>`;
    return layout({ title: "Cart", active: "cart", cartCount, body });
  }

  const rows = cart.items
    .map(
      (it) => `<tr data-product="${esc(it.product_id)}" data-unit="${it.unit_price}">
      <td><div class="item-cell">${art(it, 48)}<a href="/product/${esc(it.product_id)}">${esc(it.name)}</a></div></td>
      <td>${money(it.unit_price)}</td>
      <td>
        <div class="stepper">
          <button type="button" class="dec" aria-label="Decrease quantity of ${esc(it.name)}">−</button>
          <input class="qty" type="number" inputmode="numeric" min="1" max="${it.stock}" value="${it.qty}" aria-label="Quantity of ${esc(it.name)}">
          <button type="button" class="inc" aria-label="Increase quantity of ${esc(it.name)}">+</button>
        </div>
      </td>
      <td class="line">${money(it.line_total)}</td>
      <td><button type="button" class="remove">Remove</button></td>
    </tr>`
    )
    .join("\n    ");

  const body = `
  <h1>Your cart</h1>
  <p class="sub">Quantities update as you change them.</p>
  <table class="cart">
    <thead><tr><th scope="col">Item</th><th scope="col">Price</th><th scope="col">Quantity</th><th scope="col">Total</th><th scope="col"><span style="position:absolute;left:-9999px">Actions</span></th></tr></thead>
    <tbody id="cart-rows">
    ${rows}
    </tbody>
  </table>
  <div class="cart-foot">
    <span></span>
    <div style="display:flex;align-items:center;gap:20px">
      <span class="subtotal">Subtotal <strong id="subtotal">${money(cart.subtotal)}</strong></span>
      <a class="btn" href="/checkout">Checkout</a>
    </div>
  </div>`;

  const script = `
  (function () {
    function refresh(cartData) {
      setCartBadge(cartData.count);
      $("#subtotal").textContent = money(cartData.subtotal);
      if (cartData.items.length === 0) { location.reload(); return; }
      cartData.items.forEach(function (it) {
        var row = document.querySelector('tr[data-product="' + it.product_id + '"]');
        if (!row) return;
        var q = row.querySelector(".qty"); if (q) q.value = it.qty;
        row.querySelector(".line").textContent = money(it.line_total);
      });
    }
    function setQty(row, qty, revertTo) {
      var id = row.getAttribute("data-product");
      api("PATCH", "/api/cart/items/" + id, { qty: qty })
        .then(refresh)
        .catch(function (e) {
          toast(e.message);
          if (revertTo) row.querySelector(".qty").value = revertTo;
        });
    }
    $("#cart-rows").addEventListener("click", function (ev) {
      var row = ev.target.closest("tr[data-product]");
      if (!row) return;
      var input = row.querySelector(".qty");
      var current = parseInt(input.value, 10) || 1;
      if (ev.target.classList.contains("inc")) setQty(row, current + 1, current);
      if (ev.target.classList.contains("dec")) {
        if (current > 1) setQty(row, current - 1, current);
      }
      if (ev.target.classList.contains("remove")) {
        var name = row.querySelector(".item-cell a").textContent;
        api("DELETE", "/api/cart/items/" + row.getAttribute("data-product"))
          .then(function (cartData) {
            row.remove();
            toast("Removed " + name + " from your cart.");
            refresh(cartData);
          })
          .catch(function (e) { toast(e.message); });
      }
    });
    $("#cart-rows").addEventListener("change", function (ev) {
      if (!ev.target.classList.contains("qty")) return;
      var row = ev.target.closest("tr[data-product]");
      var qty = parseInt(ev.target.value, 10);
      if (!(qty >= 1)) { ev.target.value = 1; qty = 1; }
      setQty(row, qty);
    });
  })();`;

  return layout({ title: "Cart", active: "cart", cartCount, body, script });
}

export function pageCheckout({ cart, account, cartCount }) {
  const lines = cart.items
    .map((it) => `<li><span>${esc(it.name)}${it.qty > 1 ? ` ×${it.qty}` : ""}</span><span>${money(it.line_total)}</span></li>`)
    .join("\n      ");

  const field = (id, label, value, attrs = "") => `
    <div>
      <label for="${id}">${label}</label>
      <input id="${id}" name="${id}" value="${esc(value || "")}" ${attrs}>
      <p class="field-error" id="${id}-error" hidden></p>
    </div>`;

  const body = `
  <h1>Checkout</h1>
  <p class="sub">Delivery details are prefilled from your account — check them and pay.</p>
  <div class="checkout">
    <form id="checkout" novalidate>
      <div class="banner error" id="checkout-error" role="alert" hidden></div>
      <fieldset>
        <legend>Delivery</legend>
        ${field("name", "Full name", account.name, 'type="text" autocomplete="name"')}
        ${field("email", "Email (for the receipt)", account.email, 'type="email" autocomplete="email"')}
        ${field("street", "Street address", account.street, 'type="text" autocomplete="street-address"')}
        <div class="row2">
          ${field("city", "City", account.city, 'type="text" autocomplete="address-level2"')}
          ${field("postcode", "Postcode", account.postcode, 'type="text" inputmode="numeric" autocomplete="postal-code"')}
        </div>
      </fieldset>
      <fieldset>
        <legend>Payment</legend>
        <p class="hint" style="color:var(--muted);font-size:14px;margin:2px 0 0">This is a demo shop — no real charge is made.</p>
        ${field("card_number", "Card number", "", 'type="text" inputmode="numeric" autocomplete="cc-number" placeholder="1234 5678 9012 3456"')}
        <div class="row2">
          ${field("expiry", "Expiry (MM/YY)", "", 'type="text" inputmode="numeric" autocomplete="cc-exp" placeholder="08/28"')}
          ${field("cvc", "Security code", "", 'type="text" inputmode="numeric" autocomplete="cc-csc" placeholder="123"')}
        </div>
      </fieldset>
      <p style="margin-top:24px"><button class="btn" id="place" type="submit">Place order — ${money(cart.total)}</button></p>
    </form>
    <aside class="summary" aria-label="Order summary">
      <h2>Order summary</h2>
      <ul>
      ${lines}
      </ul>
      <ul class="totals">
        <li style="padding:2px 0"><span>Subtotal</span><span>${money(cart.subtotal)}</span></li>
        <li style="padding:2px 0"><span>Shipping</span><span>${money(SHIPPING_CENTS)}</span></li>
        <li class="grand" style="padding:6px 0 0"><span>Total</span><span>${money(cart.total)}</span></li>
      </ul>
    </aside>
  </div>`;

  const script = `
  (function () {
    var form = $("#checkout");
    var submitting = false;
    var checks = [
      ["name", function (v) { return v.trim() ? "" : "Enter the name the order should be delivered to."; }],
      ["email", function (v) { return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v.trim()) ? "" : "Enter a valid email address, like riley@example.com."; }],
      ["street", function (v) { return v.trim() ? "" : "Enter a street address."; }],
      ["city", function (v) { return v.trim() ? "" : "Enter a city."; }],
      ["postcode", function (v) { return v.trim() ? "" : "Enter a postcode."; }],
      ["card_number", function (v) { return /^\\d{15,16}$/.test(v.replace(/[\\s-]/g, "")) ? "" : "Enter the 15- or 16-digit number on the card."; }],
      ["expiry", function (v) {
        var m = v.trim().match(/^(0[1-9]|1[0-2])\\/(\\d{2})$/);
        if (!m) return "Use MM/YY, like 08/28.";
        var now = new Date();
        var yy = 2000 + parseInt(m[2], 10);
        if (yy < now.getFullYear() || (yy === now.getFullYear() && parseInt(m[1], 10) < now.getMonth() + 1)) return "That card has expired.";
        return "";
      }],
      ["cvc", function (v) { return /^\\d{3,4}$/.test(v.trim()) ? "" : "Enter the 3-digit code on the back of the card."; }],
    ];
    function setError(id, message) {
      var input = $("#" + id);
      var err = $("#" + id + "-error");
      err.textContent = message; err.hidden = !message;
      if (message) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", id + "-error"); }
      else { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); }
    }
    checks.forEach(function (c) {
      $("#" + c[0]).addEventListener("blur", function () { setError(c[0], this.value ? c[1](this.value) : ""); });
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (submitting) return;
      var firstBad = null;
      var payload = {};
      checks.forEach(function (c) {
        var input = $("#" + c[0]);
        payload[c[0]] = input.value;
        var msg = c[1](input.value);
        setError(c[0], msg);
        if (msg && !firstBad) firstBad = input;
      });
      var banner = $("#checkout-error");
      banner.hidden = true;
      if (firstBad) { firstBad.focus(); return; }
      submitting = true;
      var btn = $("#place");
      var label = btn.textContent;
      btn.disabled = true; btn.textContent = "Placing your order…";
      api("POST", "/api/orders", payload)
        .then(function (order) { location.assign("/order/" + order.id); })
        .catch(function (e) {
          submitting = false; btn.disabled = false; btn.textContent = label;
          banner.textContent = e.message; banner.hidden = false;
          banner.scrollIntoView({ block: "center" });
        });
    });
  })();`;

  return layout({ title: "Checkout", active: "cart", cartCount, body, script });
}

export function pageOrder({ order, account, cartCount }) {
  const lines = order.items
    .map((it) => `<li><span>${esc(it.name)}${it.qty > 1 ? ` ×${it.qty}` : ""}</span><span>${money(it.unit_price * it.qty)}</span></li>`)
    .join("\n      ");
  const firstName = (order.deliver_to?.name || account.name).split(" ")[0];
  const placed = new Date(order.placed_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const headline =
    order.status === "delivered"
      ? `Order ${esc(order.number)} was delivered.`
      : order.status === "shipped"
        ? `Order ${esc(order.number)} is on its way.`
        : `Thanks, ${esc(firstName)} — order ${esc(order.number)} is confirmed.`;
  const eta = "confirmed · arrives in 3–5 days";

  const body = `
  <div class="confirm-hero">
    <span class="mark" aria-hidden="true">✓</span>
    <h1>${headline}</h1>
    <p class="sub">Placed ${esc(placed)} · ${esc(eta)}.</p>
  </div>
  <div class="order-box">
    <ul>
    ${lines}
    </ul>
    <ul style="border-top:1px solid var(--line);padding-top:10px">
      <li><span>Subtotal</span><span>${money(order.subtotal)}</span></li>
      <li><span>Shipping</span><span>${money(order.shipping)}</span></li>
      <li style="font-weight:700"><span>Total</span><span>${money(order.total)}</span></li>
    </ul>
    ${order.deliver_to ? `<p style="color:var(--muted);margin:12px 0 0">Delivering to ${esc(order.deliver_to.name)}, ${esc(order.deliver_to.street)}, ${esc(order.deliver_to.city)} ${esc(order.deliver_to.postcode)}. A receipt is on its way to ${esc(order.deliver_to.email)}.</p>` : ""}
  </div>
  <div class="actions">
    <a class="btn secondary" href="/checkout">Continue shopping</a>
    <a class="btn secondary" href="/account#orders">View your orders</a>
  </div>`;

  return layout({ title: `Order ${order.number}`, active: "shop", cartCount, body });
}

export function pageAccount({ account, orders, cartCount }) {
  const rows = orders
    .map(
      (o) => `<tr>
      <td><a href="/order/${esc(o.id)}">${esc(o.number)}</a></td>
      <td>${esc(new Date(o.placed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</td>
      <td>${o.items.reduce((n, it) => n + it.qty, 0)}</td>
      <td>${money(o.total)}</td>
      <td><span class="chip ${esc(o.status)}">${esc(o.status)}</span></td>
    </tr>`
    )
    .join("\n    ");

  const field = (id, label, value, attrs = "") => `
    <div>
      <label for="${id}">${label}</label>
      <input id="${id}" name="${id}" value="${esc(value || "")}" ${attrs}>
      <p class="field-error" id="${id}-error" hidden></p>
    </div>`;

  const body = `
  <h1>Your account</h1>
  <p class="sub">Signed in as ${esc(account.email)} (demo account).</p>

  <section class="panel" aria-labelledby="profile-h">
    <h2 id="profile-h">Profile</h2>
    <p class="hint">Your name and where receipts go.</p>
    <form id="profile-form" novalidate>
      ${field("name", "Full name", account.name, 'type="text" autocomplete="name"')}
      ${field("email", "Email", account.email, 'type="email" autocomplete="email"')}
      <p style="margin-top:16px"><button class="btn small" type="submit">Save profile</button></p>
    </form>
  </section>

  <section class="panel" aria-labelledby="address-h">
    <h2 id="address-h">Shipping address</h2>
    <p class="hint">Checkout starts from this address.</p>
    <form id="address-form" novalidate>
      ${field("street", "Street address", account.street, 'type="text" autocomplete="street-address"')}
      <div class="row2">
        ${field("city", "City", account.city, 'type="text" autocomplete="address-level2"')}
        ${field("postcode", "Postcode", account.postcode, 'type="text" inputmode="numeric" autocomplete="postal-code"')}
      </div>
      <p style="margin-top:16px"><button class="btn small" type="submit">Save address</button></p>
    </form>
  </section>

  <section class="panel" id="orders" aria-labelledby="orders-h">
    <h2 id="orders-h">Order history</h2>
    <p class="hint">Every order you have placed. Select one to see its receipt.</p>
    ${orders.length === 0
      ? `<p class="sub">You haven’t placed any orders yet.</p>`
      : `<table class="orders">
      <thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Items</th><th scope="col">Total</th><th scope="col">Status</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>`}
  </section>
`;

  const script = `
  (function () {
    function setError(id, message) {
      var input = $("#" + id);
      var err = $("#" + id + "-error");
      err.textContent = message; err.hidden = !message;
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    function wire(formId, fields, successMessage) {
      $("#" + formId).addEventListener("submit", function (ev) {
        ev.preventDefault();
        var payload = {};
        var bad = null;
        fields.forEach(function (f) {
          var input = $("#" + f[0]);
          payload[f[0]] = input.value;
          var msg = f[1] ? f[1](input.value) : "";
          setError(f[0], msg);
          if (msg && !bad) bad = input;
        });
        if (bad) { fields.forEach(function (f) { var input = $("#" + f[0]); input.value = input.defaultValue; }); bad.focus(); return; }
        var btn = this.querySelector("button");
        btn.disabled = true;
        api("PATCH", "/api/account", payload)
          .then(function () { toast(successMessage); })
          .catch(function (e) {})
          .then(function () { btn.disabled = false; });
      });
    }
    wire("profile-form", [
      ["name", function (v) { return v.trim() ? "" : "Enter your name."; }],
      ["email", null],
    ], "Profile saved.");
    wire("address-form", [
      ["street", function (v) { return v.trim() ? "" : "Enter a street address."; }],
      ["city", function (v) { return v.trim() ? "" : "Enter a city."; }],
      ["postcode", function (v) { return v.trim() ? "" : "Enter a postcode."; }],
    ], "Address saved.");
  })();`;

  return layout({ title: "Account", active: "account", cartCount, body, script });
}

export function pageNotFound({ cartCount, message }) {
  const body = `
  <div class="empty" style="margin-top:40px">
    <h1>We can’t find that page.</h1>
    <p>${esc(message || "It may have been moved, or the link is out of date.")}</p>
    <p><a href="/">Back to the shop</a></p>
  </div>`;
  return layout({ title: "Not found", active: "", cartCount, body });
}
