// History-API router. Routes are `/p/:key/suites/:slug` style patterns; every route
// is a shareable deep link (UX IA). navigate() pushes state; link() makes an <a>
// that routes without a full reload. The matcher is the same shape as the server's.

const routes: WebDynamic = [];
let notFound: WebDynamic = null;
let onNavigate: WebDynamic = null;

function compile(pattern: WebDynamic) {
  const keys: WebDynamic = [];
  const rx = pattern
    .split("/")
    .map((seg: WebDynamic) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${rx}/?$`), keys };
}

export function route(pattern: WebDynamic, handler: WebDynamic) {
  routes.push({ ...compile(pattern), handler });
}
export const setNotFound = (h: WebDynamic) => (notFound = h);
export const setOnNavigate = (h: WebDynamic) => (onNavigate = h);

// Pages with live state (feed subscriptions, timers, key handlers) register a
// cleanup that the router runs before dispatching the next route — the one
// unmount hook, so no page needs its own location-string guards.
const pageCleanups: WebDynamic = [];
export const onPageLeave = (fn: WebDynamic) => pageCleanups.push(fn);

export function resolve(pathname: WebDynamic = location.pathname) {
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params: WebDynamic = {};
    r.keys.forEach((k: WebDynamic, i: WebDynamic) => (params[k] = decodeURIComponent(m[i + 1])));
    return { handler: r.handler, params };
  }
  return notFound ? { handler: notFound, params: {} } : null;
}

export function render() {
  while (pageCleanups.length) {
    try { pageCleanups.pop()(); } catch { /* a failed cleanup must not block navigation */ }
  }
  const match = resolve();
  if (match) match.handler(match.params, new URLSearchParams(location.search));
  if (onNavigate) onNavigate(location.pathname);
}

export function navigate(to: WebDynamic, { replace = false }: WebDynamic = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"]({}, "", to);
  render();
  document.getElementById("main")?.scrollTo(0, 0);
}

export function link(to: WebDynamic, ...content: WebDynamic) {
  const a = document.createElement("a");
  a.href = to;
  a.append(...content.map((c: WebDynamic) => (c?.nodeType ? c : document.createTextNode(String(c)))));
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(to);
  });
  return a;
}

export function startRouter() {
  window.addEventListener("popstate", render);
  render();
}
