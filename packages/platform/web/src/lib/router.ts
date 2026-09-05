// History-API router. Routes are `/p/:key/suites/:slug` style patterns; every route
// is a shareable deep link (UX IA). navigate() pushes state; link() makes an <a>
// that routes without a full reload. The matcher is the same shape as the server's.

type RouteParams = Record<string, string>;
type RouteHandler = (params: RouteParams, query: URLSearchParams) => void | Promise<void>;
type Cleanup = () => void;

interface NavigationBlocker {
  shouldBlock: () => boolean;
  confirm: () => boolean | Promise<boolean>;
}

type RegisteredBlocker = NavigationBlocker & { owner: object };

interface NavigateTransition {
  kind: "navigate";
  originIndex: number;
  blocker: RegisteredBlocker;
  to: string;
  replace: boolean;
  confirmed: boolean | null;
  restoring: boolean;
}

interface PopTransition {
  kind: "pop";
  originIndex: number;
  targetIndex: number;
  delta: number;
  blocker: RegisteredBlocker;
  phase: "restoring" | "confirming" | "allowing";
  confirmed: boolean | null;
  restoring: boolean;
}

type PendingTransition = NavigateTransition | PopTransition;

interface Route {
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];
let notFound: RouteHandler | null = null;
let onNavigate: ((pathname: string) => void) | null = null;
let activeBlocker: RegisteredBlocker | null = null;
let currentHistoryIndex = 0;
let pendingTransition: PendingTransition | null = null;
const HISTORY_INDEX = "__playtestRouterIndex";

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

export function setNavigationBlocker(owner: object, blocker: NavigationBlocker) {
  const registration = { owner, ...blocker };
  activeBlocker = registration;
  return () => {
    if (activeBlocker === registration) activeBlocker = null;
  };
}

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
  activeBlocker = null;
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

function historyIndex(state: unknown) {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[HISTORY_INDEX];
  return typeof value === "number" ? value : null;
}

function indexedState(index: number) {
  const state = history.state;
  return {
    ...(state && typeof state === "object" ? state : {}),
    [HISTORY_INDEX]: index,
  };
}

function blocker() {
  return activeBlocker?.shouldBlock() ? activeBlocker : null;
}

async function confirmNavigation(active: NavigationBlocker) {
  try {
    return await active.confirm();
  } catch {
    return false;
  }
}

function confirmationStillApplies(asked: RegisteredBlocker) {
  const current = blocker();
  return !current || current.owner === asked.owner;
}

function commitNavigation(to: string, replace: boolean) {
  const nextIndex = replace ? currentHistoryIndex : currentHistoryIndex + 1;
  history[replace ? "replaceState" : "pushState"](indexedState(nextIndex), "", to);
  currentHistoryIndex = nextIndex;
  render();
  document.getElementById("main")?.scrollTo(0, 0);
}

export function navigate(to: string, { replace = false, guard = true }: { replace?: boolean; guard?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (pendingTransition) return;
  const active = guard ? blocker() : null;
  if (!active) return commitNavigation(to, replace);
  const transition: NavigateTransition = {
    kind: "navigate", originIndex: currentHistoryIndex, blocker: active,
    to, replace, confirmed: null, restoring: false,
  };
  pendingTransition = transition;
  return finishNavigateConfirmation(transition);
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
  const initialIndex = historyIndex(history.state);
  currentHistoryIndex = initialIndex ?? 0;
  if (initialIndex === null) history.replaceState(indexedState(currentHistoryIndex), "");
  window.addEventListener("popstate", onPopState);
  window.addEventListener("beforeunload", onBeforeUnload);
  render();
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!blocker()) return;
  event.preventDefault();
  event.returnValue = "";
}

function onPopState(event: PopStateEvent) {
  const eventIndex = historyIndex(event.state);
  if (pendingTransition) return handlePendingPop(pendingTransition, eventIndex);

  const targetIndex = eventIndex ?? currentHistoryIndex - 1;
  const delta = targetIndex - currentHistoryIndex;
  if (delta === 0) return;
  const active = blocker();
  if (!active) {
    currentHistoryIndex = targetIndex;
    if (eventIndex === null) history.replaceState(indexedState(currentHistoryIndex), "");
    render();
    return;
  }

  const transition: PopTransition = {
    kind: "pop", originIndex: currentHistoryIndex, targetIndex, delta,
    blocker: active, phase: "restoring", confirmed: null, restoring: true,
  };
  pendingTransition = transition;
  // A pop changes the URL first, so restore the draft entry before asking.
  history.go(-delta);
}

function handlePendingPop(transition: PendingTransition, eventIndex: number | null) {
  if (transition.kind === "navigate") {
    if (eventIndex === transition.originIndex) {
      transition.restoring = false;
      finishNavigateTransition(transition);
    } else {
      transition.restoring = true;
      history.go(transition.originIndex - (eventIndex ?? transition.originIndex - 1));
    }
    return;
  }

  if (transition.phase === "allowing") {
    if (eventIndex === transition.targetIndex || eventIndex === null) {
      pendingTransition = null;
      currentHistoryIndex = transition.targetIndex;
      if (eventIndex === null) history.replaceState(indexedState(currentHistoryIndex), "");
      render();
    } else {
      history.go(transition.targetIndex - (eventIndex ?? transition.originIndex));
    }
    return;
  }

  if (eventIndex !== transition.originIndex) {
    transition.restoring = true;
    history.go(transition.originIndex - (eventIndex ?? transition.targetIndex));
    return;
  }

  transition.restoring = false;
  if (transition.phase === "restoring") {
    transition.phase = "confirming";
    void finishPopConfirmation(transition);
  } else {
    finishPopTransition(transition);
  }
}

async function finishNavigateConfirmation(transition: NavigateTransition) {
  const confirmed = await confirmNavigation(transition.blocker);
  if (pendingTransition !== transition) return;
  transition.confirmed = confirmed && confirmationStillApplies(transition.blocker);
  finishNavigateTransition(transition);
}

function finishNavigateTransition(transition: NavigateTransition) {
  if (transition.confirmed === null || transition.restoring) return;
  pendingTransition = null;
  if (transition.confirmed) commitNavigation(transition.to, transition.replace);
}

async function finishPopConfirmation(transition: PopTransition) {
  const confirmed = await confirmNavigation(transition.blocker);
  if (pendingTransition !== transition) return;
  transition.confirmed = confirmed && confirmationStillApplies(transition.blocker);
  finishPopTransition(transition);
}

function finishPopTransition(transition: PopTransition) {
  if (transition.confirmed === null || transition.restoring) return;
  if (!transition.confirmed) {
    pendingTransition = null;
    return;
  }
  transition.phase = "allowing";
  history.go(transition.delta);
}
