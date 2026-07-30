// Loanpoint browser application: routing, chrome, and view dispatch.

import { get } from "./lib/api.js";
import { clear, el } from "./lib/dom.js";
import { banner } from "./lib/ui.js";

import * as overview from "./views/overview.js";
import * as equipmentList from "./views/equipment-list.js";
import * as equipmentDetail from "./views/equipment-detail.js";
import * as loanList from "./views/loan-list.js";
import * as loanDetail from "./views/loan-detail.js";
import * as newLoan from "./views/new-loan.js";
import * as approvals from "./views/approvals.js";
import * as notFound from "./views/not-found.js";

const ROUTES = [
  { pattern: "/", view: overview, nav: "/" },
  { pattern: "/equipment", view: equipmentList, nav: "/equipment" },
  { pattern: "/equipment/:id", view: equipmentDetail, nav: "/equipment" },
  { pattern: "/loans", view: loanList, nav: "/loans" },
  { pattern: "/loans/:id", view: loanDetail, nav: "/loans" },
  { pattern: "/new-loan", view: newLoan, nav: null },
  { pattern: "/approvals", view: approvals, nav: "/approvals" },
];

const main = document.getElementById("main");
let session = null;
let flash = null;

function matchRoute(pathname) {
  for (const route of ROUTES) {
    const expected = route.pattern.split("/");
    const actual = pathname.split("/");
    if (expected.length !== actual.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i].startsWith(":")) params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
      else if (expected[i] !== actual[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

export function navigate(path, options = {}) {
  const url = new URL(path, window.location.origin);
  const target = `${url.pathname}${url.search}`;
  if (options.replace) window.history.replaceState({}, "", target);
  else window.history.pushState({}, "", target);
  return render();
}

function setFlash(tone, message) {
  flash = { tone, message };
}

function takeFlash() {
  const current = flash;
  flash = null;
  return current;
}

function setTitle(title) {
  document.title = `${title} · Loanpoint`;
}

function markNav(navPath) {
  for (const link of document.querySelectorAll(".nav a[data-nav]")) {
    if (link.dataset.nav === navPath) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function refreshApprovalsBadge() {
  const badge = document.getElementById("approvals-badge");
  if (!badge) return;
  try {
    const data = await get("/api/approvals");
    badge.textContent = String(data.count);
    badge.hidden = data.count === 0;
    badge.setAttribute("aria-label", `${data.count} awaiting approval`);
  } catch {
    badge.hidden = true;
  }
}

async function render() {
  const pathname =
    window.location.pathname.length > 1
      ? window.location.pathname.replace(/\/+$/, "")
      : window.location.pathname;
  const query = Object.fromEntries(new URL(window.location.href).searchParams.entries());
  const found = matchRoute(pathname);

  clear(main);
  main.appendChild(el("p", { class: "muted", text: "Loading…" }));

  const ctx = {
    params: found ? found.params : {},
    query,
    session,
    navigate,
    setFlash,
    takeFlash,
    setTitle,
    refreshChrome: refreshApprovalsBadge,
  };

  markNav(found ? found.route.nav : null);

  const view = found ? found.route.view : notFound;
  try {
    const content = await view.render(ctx);
    clear(main);
    const pendingFlash = takeFlash();
    if (pendingFlash) main.appendChild(banner(pendingFlash.tone, pendingFlash.message));
    main.appendChild(content);
  } catch (error) {
    clear(main);
    main.appendChild(el("h1", { text: "Something went wrong" }));
    main.appendChild(banner("error", error.message || "The desk system is not responding."));
    setTitle("Something went wrong");
  }
  await refreshApprovalsBadge();
}

function onLinkClick(event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
  const link = event.target.closest("a[href]");
  if (!link) return;
  const href = link.getAttribute("href");
  if (!href || !href.startsWith("/") || link.target === "_blank") return;
  event.preventDefault();
  navigate(href);
}

async function boot() {
  document.addEventListener("click", onLinkClick);
  window.addEventListener("popstate", () => {
    render();
  });

  try {
    session = await get("/api/session");
    const operator = document.getElementById("operator");
    operator.textContent = `${session.operator.name} · ${session.operator.role}`;
    document.getElementById("desk-time").textContent = `Desk time ${session.deskTime.formatted}`;
  } catch {
    session = null;
  }

  await render();
}

boot();
