// Fern & Fog — the hill-climb study's subject storefront.
// A zero-dependency fixture app in the todo-app style: single-process Node
// server, server-rendered pages + vanilla client JS, in-memory state,
// POST /api/reset seed hook, no build step. It is a fixture, not a product.
// The committed version is the CLEAN REFERENCE — the top of the hill; see
// SPEC.md for what "seamless" means here.

import http from "node:http";
import { URL, pathToFileURL } from "node:url";
import { PRODUCTS, CATEGORIES, ACCOUNT, PAST_ORDERS, SHIPPING_CENTS } from "./data.js";
import {
  pageCatalog,
  pageProduct,
  pageCart,
  pageCheckout,
  pageOrder,
  pageAccount,
  pageNotFound,
} from "./pages.js";

const DECLINED_TEST_CARD = "4000000000000002";

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function html(res, status, page) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function seedState() {
  const products = PRODUCTS.map((p) => ({ ...p, details: { ...p.details } }));
  let nextOrder = 1053;
  const orders = PAST_ORDERS.map((o, i) => {
    const subtotal = o.items.reduce((n, it) => n + it.unit_price * it.qty, 0);
    return {
      id: `o-${1041 + i * 11}`,
      ...o,
      items: o.items.map((it) => ({ ...it })),
      subtotal,
      shipping: SHIPPING_CENTS,
      total: subtotal + SHIPPING_CENTS,
      deliver_to: null,
    };
  });
  return {
    products,
    cart: [], // [{ product_id, qty }]
    orders,
    account: { ...ACCOUNT },
    nextOrder,
  };
}

// --- validation ------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function checkoutErrors(body, now = new Date()) {
  const errors = {};
  const str = (k) => String(body[k] ?? "").trim();
  if (!str("name")) errors.name = "Enter the name the order should be delivered to.";
  if (!EMAIL_RE.test(str("email"))) errors.email = "Enter a valid email address.";
  if (!str("street")) errors.street = "Enter a street address.";
  if (!str("city")) errors.city = "Enter a city.";
  if (!str("postcode")) errors.postcode = "Enter a postcode.";
  const digits = str("card_number").replace(/[\s-]/g, "");
  if (!/^\d{15,16}$/.test(digits)) errors.card_number = "Enter the 16-digit number on the card.";
  const m = str("expiry").match(/^(0[1-9]|1[0-2])\/(\d{2})$/);
  if (!m) {
    errors.expiry = "Use MM/YY for the expiry, like 08/28.";
  } else {
    const yy = 2000 + Number(m[2]);
    if (yy < now.getFullYear() || (yy === now.getFullYear() && Number(m[1]) < now.getMonth() + 1)) {
      errors.expiry = "That card has expired.";
    }
  }
  if (!/^\d{3,4}$/.test(str("cvc"))) errors.cvc = "Enter the 3-digit code on the back of the card.";
  return { errors, cardDigits: digits };
}

// --- server ----------------------------------------------------------------

export function start({ port = 0 } = {}) {
  // Per-instance state: two concurrent starts never share anything.
  let state = seedState();

  const findProduct = (id) => state.products.find((p) => p.id === id);

  function cartView() {
    const items = state.cart
      .map((line) => {
        const p = findProduct(line.product_id);
        if (!p) return null;
        return {
          product_id: p.id,
          name: p.name,
          glyph: p.glyph,
          hue: p.hue,
          unit_price: p.price,
          stock: p.stock,
          qty: line.qty,
          line_total: p.price * line.qty,
        };
      })
      .filter(Boolean);
    const subtotal = items.reduce((n, it) => n + it.line_total, 0);
    const count = items.reduce((n, it) => n + it.qty, 0);
    return { items, subtotal, shipping: SHIPPING_CENTS, total: subtotal + SHIPPING_CENTS, count };
  }

  function filteredProducts(params) {
    const q = (params.get("q") || "").trim().toLowerCase();
    const category = params.get("category") || "";
    const sort = params.get("sort") || "";
    let list = [...state.products];
    if (category && CATEGORIES.some((c) => c.id === category)) {
      list = list.filter((p) => p.category === category);
    }
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.blurb.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q)
      );
    }
    if (sort === "price-asc") list.sort((a, b) => a.price - b.price);
    else if (sort === "price-desc") list.sort((a, b) => b.price - a.price);
    else if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    return { list, q: params.get("q") || "", category, sort };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    try {
      // ---- API ----
      if (path === "/api/reset" && method === "POST") {
        state = seedState();
        return json(res, 200, { ok: true });
      }

      if (path === "/api/products" && method === "GET") {
        const { list } = filteredProducts(url.searchParams);
        return json(res, 200, { products: list });
      }

      const productApi = path.match(/^\/api\/products\/([\w-]+)$/);
      if (productApi && method === "GET") {
        const p = findProduct(productApi[1]);
        if (!p) return json(res, 404, { error: "no such product" });
        return json(res, 200, p);
      }

      if (path === "/api/cart" && method === "GET") {
        return json(res, 200, cartView());
      }

      if (path === "/api/cart/items" && method === "POST") {
        const body = await readBody(req);
        const p = findProduct(String(body.product_id || ""));
        const qty = Number(body.qty ?? 1);
        if (!p) return json(res, 400, { error: "no such product" });
        if (!Number.isInteger(qty) || qty < 1) return json(res, 400, { error: "Quantity must be a whole number of at least 1." });
        if (p.stock === 0) return json(res, 400, { error: `${p.name} is out of stock.` });
        const line = state.cart.find((l) => l.product_id === p.id);
        const already = line ? line.qty : 0;
        if (already + qty > p.stock) {
          const room = p.stock - already;
          return json(res, 400, {
            error:
              room <= 0
                ? `You already have all ${p.stock} in stock in your cart.`
                : `Only ${p.stock} in stock — you can add ${room} more.`,
          });
        }
        if (line) line.qty += qty;
        else state.cart.push({ product_id: p.id, qty });
        return json(res, 201, cartView());
      }

      const cartItem = path.match(/^\/api\/cart\/items\/([\w-]+)$/);
      if (cartItem && (method === "PATCH" || method === "DELETE")) {
        const line = state.cart.find((l) => l.product_id === cartItem[1]);
        if (!line) return json(res, 404, { error: "that item is not in your cart" });
        if (method === "DELETE") {
          state.cart = state.cart.filter((l) => l !== line);
          return json(res, 200, cartView());
        }
        const body = await readBody(req);
        const qty = Number(body.qty);
        const p = findProduct(line.product_id);
        if (!Number.isInteger(qty) || qty < 1) return json(res, 400, { error: "Quantity must be a whole number of at least 1." });
        if (qty > p.stock) return json(res, 400, { error: `Only ${p.stock} of ${p.name} in stock.` });
        line.qty = qty;
        return json(res, 200, cartView());
      }

      if (path === "/api/orders" && method === "GET") {
        return json(res, 200, { orders: state.orders });
      }

      if (path === "/api/orders" && method === "POST") {
        const body = await readBody(req);
        const cart = cartView();
        if (cart.items.length === 0) return json(res, 400, { error: "Your cart is empty." });
        const { errors, cardDigits } = checkoutErrors(body);
        if (Object.keys(errors).length > 0) {
          return json(res, 400, { error: Object.values(errors)[0], fields: errors });
        }
        if (cardDigits === DECLINED_TEST_CARD) {
          return json(res, 402, {
            error: "Your card was declined. No charge was made — try a different card.",
          });
        }
        for (const it of cart.items) {
          const p = findProduct(it.product_id);
          if (it.qty > p.stock) {
            return json(res, 409, {
              error: `Only ${p.stock} of ${p.name} left in stock — adjust your cart and try again.`,
            });
          }
        }
        const order = {
          id: `o-${state.nextOrder}`,
          number: `FF-${state.nextOrder}`,
          placed_at: new Date().toISOString(),
          status: "confirmed",
          items: cart.items.map((it) => ({
            product_id: it.product_id,
            name: it.name,
            qty: it.qty,
            unit_price: it.unit_price,
          })),
          subtotal: cart.subtotal,
          shipping: cart.shipping,
          total: cart.total,
          deliver_to: {
            name: String(body.name).trim(),
            email: String(body.email).trim(),
            street: String(body.street).trim(),
            city: String(body.city).trim(),
            postcode: String(body.postcode).trim(),
          },
        };
        state.nextOrder += 1;
        for (const it of cart.items) findProduct(it.product_id).stock -= it.qty;
        state.cart = [];
        state.orders.push(order);
        return json(res, 201, order);
      }

      const orderApi = path.match(/^\/api\/orders\/([\w-]+)$/);
      if (orderApi && method === "GET") {
        const order = state.orders.find((o) => o.id === orderApi[1]);
        if (!order) return json(res, 404, { error: "no such order" });
        return json(res, 200, order);
      }

      if (path === "/api/account" && method === "GET") {
        return json(res, 200, state.account);
      }

      if (path === "/api/account" && method === "PATCH") {
        const body = await readBody(req);
        const next = { ...state.account };
        for (const key of ["name", "email", "street", "city", "postcode"]) {
          if (key in body) next[key] = String(body[key]).trim();
        }
        if (!next.name) return json(res, 400, { error: "Enter your name." });
        if (!EMAIL_RE.test(next.email)) return json(res, 400, { error: "Enter a valid email address." });
        if (!next.street || !next.city || !next.postcode) {
          return json(res, 400, { error: "Address fields can’t be empty." });
        }
        state.account = next;
        return json(res, 200, state.account);
      }

      if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });

      // ---- pages ----
      const cartCount = cartView().count;

      if (path === "/" && method === "GET") {
        const { list, q, category, sort } = filteredProducts(url.searchParams);
        return html(res, 200, pageCatalog({ products: list, q, category, sort, cartCount }));
      }

      const productPage = path.match(/^\/product\/([\w-]+)$/);
      if (productPage && method === "GET") {
        const p = findProduct(productPage[1]);
        if (!p) {
          return html(res, 404, pageNotFound({ cartCount, message: "That product isn’t in our catalogue. It may have retired — the shop moves with the seasons." }));
        }
        const catalogState = {
          q: url.searchParams.get("q") || "",
          category: url.searchParams.get("category") || "",
          sort: url.searchParams.get("sort") || "",
        };
        return html(res, 200, pageProduct({ product: p, cartCount, catalogState }));
      }

      if (path === "/cart" && method === "GET") {
        return html(res, 200, pageCart({ cart: cartView(), notice: url.searchParams.get("notice"), cartCount }));
      }

      if (path === "/checkout" && method === "GET") {
        const cart = cartView();
        if (cart.items.length === 0) return redirect(res, "/cart?notice=empty-checkout");
        return html(res, 200, pageCheckout({ cart, account: state.account, cartCount }));
      }

      const orderPage = path.match(/^\/order\/([\w-]+)$/);
      if (orderPage && method === "GET") {
        const order = state.orders.find((o) => o.id === orderPage[1]);
        if (!order) {
          return html(res, 404, pageNotFound({ cartCount, message: "We couldn’t find that order. Your order history lives in your account." }));
        }
        return html(res, 200, pageOrder({ order, account: state.account, cartCount }));
      }

      if (path === "/account" && method === "GET") {
        const orders = [...state.orders].sort((a, b) => (a.placed_at < b.placed_at ? 1 : -1));
        return html(res, 200, pageAccount({ account: state.account, orders, cartCount }));
      }

      return html(res, 404, pageNotFound({ cartCount }));
    } catch (err) {
      if (path.startsWith("/api/")) return json(res, 400, { error: err.message });
      return html(res, 500, pageNotFound({ cartCount: 0, message: "Something went wrong on our end. Please try again." }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Run directly: bind PORT (default 4183).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4183);
  start({ port }).then(({ url }) => {
    console.log(`Fern & Fog listening on ${url}`);
  });
}
