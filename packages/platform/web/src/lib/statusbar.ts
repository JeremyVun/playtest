// The system status bar: a thin, always-on footer under every project page.
//
// It replaces the "Operations" fold that used to sit at the bottom of Runs.
// System health is not something you go and open — it is either on screen or it
// is not being watched, and the one place it must be visible is wherever you
// happen to be when a run feels slow. Dispatch depth, queue wait, reconciler
// liveness and model spend read at a glance; the dispatch ledger, which is a
// table and can never fit in a bar, opens in a drawer above it.
//
// Live without polling the API: one event-feed subscription (the platform's
// push channel — a held long-poll; hosted.md, "Events and long polling")
// refetches /ops when anything moves. The
// numbers that decay with the clock rather than with events — reconciler lag
// above all, whose whole point is that a dead loop emits nothing — also get a
// slow safety refresh, paused while the tab is hidden and taken immediately
// when it comes back.
import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { subscribeFeed } from "./feed.js";
import { hasRole } from "./state.js";
import { statusChip } from "./ui.js";
import { opsItems, feedIndicator } from "./ops-status.js";

// Anything that moves dispatch depth, spend, or reconciler state. Findings and
// candidate traffic would only wake a refetch that reads the same numbers back.
const OPS_EVENTS: WebDynamic = ["run.status", "run.finished", "run.failed", "dispatch.dead"];
const REFRESH_MS = 30_000;   // the reconciler beats every 30s by default
const DEBOUNCE_MS = 400;     // a burst of run events is one refetch
const OPEN_KEY = "pt-ops-drawer";

const ctl: WebDynamic = {
  projectKey: null,
  dev: false,
  ops: null,
  dispatches: null,
  feed: "live",
  open: false,
  // Rebuilt with the frame on every navigation (see buildBar).
  el: null, bar: null, panel: null, live: null, liveText: null, dot: null,
  items: null, toggle: null, chev: null,
  barSig: null,
  panelSig: null,
  sub: null,
  timer: null,
  debounce: null,
};

/**
 * Paint (and keep alive) the status bar for a project.
 * The frame is re-rendered on every navigation, so this hands back a fresh
 * element each time while the subscription, the cached numbers and the drawer
 * state survive underneath — the bar must never blink empty between pages.
 * @param {string} projectKey
 * @param {string|null} projectId
 */
export function statusBar(projectKey: WebDynamic, projectId: WebDynamic) {
  const dev = hasRole(projectId, "developer");
  if (ctl.projectKey !== projectKey || ctl.dev !== dev) {
    stop();
    Object.assign(ctl, { projectKey, dev, ops: null, dispatches: null, feed: "live" });
    ctl.open = dev && readOpen();
    start();
  }
  ctl.barSig = ctl.panelSig = null;
  buildBar();
  ctl.panel = h("div.sb-panel#sb-panel", { hidden: !ctl.open });
  ctl.el = h("footer#statusbar", { role: "contentinfo", "aria-label": "System status", onkeydown: onKeydown },
    ctl.panel, ctl.bar);
  paint();
  return ctl.el;
}

/**
 * The bar's skeleton. Every part that a repaint could disturb is built once and
 * then only has its text swapped: the drawer button keeps its focus ring
 * through a refresh, and the connection line — a live region — is never
 * replaced, so a screen reader announces it when it CHANGES and not every time
 * a number beside it moves.
 */
function buildBar() {
  ctl.dot = h("span.sb-dot", {});
  ctl.liveText = h("span.sb-v", {});
  ctl.live = h("span.sb-live", { role: "status" }, ctl.dot, ctl.liveText);
  ctl.items = h("span.sb-items", {});
  ctl.chev = h("span.sb-chev", { "aria-hidden": "true" });
  ctl.toggle = h("button.sb-toggle#sb-toggle", {
    type: "button",
    onclick: toggleDrawer,
    "aria-controls": "sb-panel",
    title: "The dispatch ledger — every attempt to place a run on an executor",
  }, "Dispatches", ctl.chev);
  ctl.bar = h("div.sb-bar", {}, ctl.live, ctl.items, h("span.sb-spacer", {}), ctl.toggle);
}

/** Leaving the project scope (the project index, sign-out) — nothing to watch. */
export function stopStatusBar() {
  stop();
  Object.assign(ctl, { projectKey: null, dev: false, ops: null, dispatches: null, el: null, bar: null, panel: null });
}

// ---------- live wiring ----------

function start() {
  if (!ctl.projectKey) return;
  ctl.sub = subscribeFeed(ctl.projectKey, {
    types: OPS_EVENTS,
    onEvent: schedule,
    onState: (s: WebDynamic) => { ctl.feed = s; paint(); },
  });
  if (!ctl.dev) return;
  refresh();
  ctl.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

function stop() {
  ctl.sub?.stop();
  clearInterval(ctl.timer);
  clearTimeout(ctl.debounce);
  document.removeEventListener("visibilitychange", onVisibility);
  ctl.sub = ctl.timer = ctl.debounce = null;
}

// A tab in the background is a tab nobody is reading; come back to fresh
// numbers rather than to whatever the clock left behind.
function onVisibility() { if (!document.hidden) refresh(); }

function schedule() {
  if (!ctl.dev) return;
  clearTimeout(ctl.debounce);
  ctl.debounce = setTimeout(refresh, DEBOUNCE_MS);
}

async function refresh() {
  if (!ctl.dev || !ctl.projectKey) return;
  const key = ctl.projectKey;
  try {
    const [ops, dispatches] = await Promise.all([
      api.get(`/projects/${key}/ops`),
      ctl.open ? api.get(`/projects/${key}/dispatches`).then((r: WebDynamic) => r.items) : Promise.resolve(ctl.dispatches),
    ]);
    if (ctl.projectKey !== key) return;
    ctl.ops = ops;
    ctl.dispatches = dispatches ?? null;
    paint();
  } catch (err: WebDynamic) {
    if (ctl.projectKey !== key) return;
    // A role this session does not actually hold: stop asking rather than
    // knocking on a 403 every 30 seconds, and drop back to the feed indicator.
    if (err?.status === 403 || err?.status === 404) {
      ctl.dev = false;
      ctl.open = false;
      clearInterval(ctl.timer);
      ctl.timer = null;
      paint();
    }
    // Anything else is transient — the next event or tick retries, and a status
    // bar is the last thing that should interrupt the page with an error.
  }
}

// ---------- painting ----------

function paint() {
  if (!ctl.el) return;
  paintBar();
  paintPanel();
}

function paintBar() {
  const feed = feedIndicator(ctl.feed);
  ctl.dot.className = `sb-dot ${feed.tone}`;
  // Only ever written when it differs: this is the live region.
  if (ctl.liveText.textContent !== feed.value) ctl.liveText.textContent = feed.value;
  ctl.live.title = feed.note;

  const items = ctl.dev ? opsItems(ctl.ops) : [];
  const sig = JSON.stringify(items.map((i: WebDynamic) => [i.label, i.value, i.tone]));
  if (sig !== ctl.barSig) {
    ctl.barSig = sig;
    mount(ctl.items, ...items.map(barItem));
  }
  ctl.toggle.hidden = !ctl.dev;
  ctl.toggle.setAttribute("aria-expanded", ctl.open ? "true" : "false");
  ctl.chev.textContent = ctl.open ? "▾" : "▴";
}

function barItem(item: WebDynamic) {
  return h("span.sb-item", { title: item.note },
    h("span.sb-k", {}, item.label),
    h(`span.sb-v.${item.tone}`, {}, item.value),
  );
}

function toggleDrawer() {
  ctl.open = !ctl.open;
  try { localStorage.setItem(OPEN_KEY, ctl.open ? "1" : "0"); } catch { /* private mode */ }
  ctl.panel.hidden = !ctl.open;
  paintBar();
  paintPanel();
  // The ledger is fetched when it is first asked for, not on every page load.
  if (ctl.open && ctl.dispatches == null) refresh();
}

const readOpen = () => {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
};

function onKeydown(e: WebDynamic) {
  if (e.key !== "Escape" || !ctl.open) return;
  toggleDrawer();
  document.getElementById("sb-toggle")?.focus();
}

/**
 * The drawer: the dispatch ledger, plus the sentence behind each number in the
 * bar (a tooltip is unreachable by keyboard, so the notes need a home on
 * screen). Repainted only when the ledger actually changes, so reading it is
 * never interrupted by the refresh timer.
 */
function paintPanel() {
  if (!ctl.el || !ctl.open) return;
  const rows = ctl.dispatches;
  const sig = JSON.stringify([
    // `null` (still loading) and `[]` (a project that has never dispatched) say
    // different things, so they must never share a signature.
    rows == null ? "loading" : rows.map((d: WebDynamic) => `${d.id}:${d.status}`),
    opsItems(ctl.ops).map((i: WebDynamic) => i.note),
  ]);
  if (sig === ctl.panelSig) return;
  ctl.panelSig = sig;
  mount(ctl.panel,
    h("div.sb-notes", {}, ...opsItems(ctl.ops).map((i: WebDynamic) =>
      h("div", {}, h("b", {}, i.label), " — ", i.note))),
    h("h2.section-title", {}, "Dispatches"),
    rows == null
      ? h("div.dim", {}, "Loading…")
      : rows.length
        ? h("div.card", {}, h("table.rows", {},
            h("thead", {}, h("tr", {}, h("th", {}, "Attempt"), h("th", {}, "Status"), h("th", {}, "Isolation"), h("th", {}, "Updated"))),
            h("tbody", {}, ...rows.map(dispatchRow)),
          ))
        : h("div.card.pad.dim", {}, "No dispatches yet."),
  );
}

function dispatchRow(d: WebDynamic) {
  const at = d.concluded_at || d.last_report_at || d.requested_at;
  return h("tr", {},
    h("td.mono", {}, `${d.kind} ${d.attempt}`),
    h("td", {}, statusChip(d.status === "reconciled_dead" ? "infra" : d.status === "concluded" ? "pass" : "running", d.status)),
    h("td", {}, d.isolation || "—"),
    h("td.dim", {}, at ? new Date(at).toLocaleString() : "—"),
  );
}
