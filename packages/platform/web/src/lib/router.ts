// History-API router. Routes are `/p/:key/suites/:slug` style patterns; every route
// is a shareable deep link (UX IA). navigate() pushes state; link() makes an <a>
// that routes without a full reload. The matcher is the same shape as the server's.

type RouteParams = Record<string, string>;
type RouteHandler = (params: RouteParams, query: URLSearchParams) => void | Promise<void>;
type Cleanup = () => void;

interface Route {
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];
let notFound: RouteHandler | null = null;
let onNavigate: ((pathname: string) => void) | null = null;

function compile(pattern: string) {
  const keys: string[] = [];
  const rx = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${rx}/?$`), keys };
}

export function route(pattern: string, handler: RouteHandler) {
  routes.push({ ...compile(pattern), handler });
}
export const setNotFound = (handler: RouteHandler) => (notFound = handler);
export const setOnNavigate = (handler: (pathname: string) => void) => (onNavigate = handler);

// Pages with live state (feed subscriptions, timers, key handlers) register a
// cleanup that the router runs before dispatching the next route — the one
// unmount hook, so no page needs its own location-string guards.
const pageCleanups: Cleanup[] = [];
export function onPageLeave(fn: Cleanup) {
  pageCleanups.push(fn);
  return () => {
    const index = pageCleanups.indexOf(fn);
    if (index >= 0) pageCleanups.splice(index, 1);
  };
}

export function resolve(pathname: string = location.pathname) {
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params: RouteParams = {};
    r.keys.forEach((key, index) => (params[key] = decodeURIComponent(m[index + 1] ?? "")));
    return { handler: r.handler, params };
  }
  return notFound ? { handler: notFound, params: {} } : null;
}

export function render() {
  while (pageCleanups.length) {
    try {
      const cleanup = pageCleanups.pop();
      cleanup?.();
    } catch { /* a failed cleanup must not block navigation */ }
  }
  const match = resolve();
  if (match) match.handler(match.params, new URLSearchParams(location.search));
  if (onNavigate) onNavigate(location.pathname);
}

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"]({}, "", to);
  render();
  document.getElementById("main")?.scrollTo(0, 0);
}

export function link(to: string, ...content: unknown[]) {
  const a = document.createElement("a");
  a.href = to;
  a.append(...content.map((item) => item instanceof Node ? item : document.createTextNode(String(item))));
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
