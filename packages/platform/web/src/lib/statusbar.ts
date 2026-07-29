// The system status bar: a thin, always-on footer under every project page.
//
// It replaces the "Operations" fold that used to sit at the bottom of Runs.
// System health is not something you go and open — it is either on screen or it
// is not being watched, and the one place it must be visible is wherever you
// happen to be when a run feels slow.
//
// A bar that is on screen all day earns its space by saying little: whether
// this console is live, what is running right now, anything that is actually
// wrong, and what the models have cost. Machinery that is behaving — the
// watchdog's heartbeat, queue percentiles, the concurrency cap — says nothing
// here and waits in the drawer, together with the dispatch ledger, which is a
// table and could never fit in a bar.
//
// Live without polling the API: one event-feed subscription (the platform's
// push channel — a held long-poll; hosted.md, "Events and long polling")
// refetches /ops when anything moves. The
// numbers that decay with the clock rather than with events — watchdog lag
// above all, whose whole point is that a dead loop emits nothing — also get a
// slow safety refresh, paused while the tab is hidden and taken immediately
// when it comes back.
import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { subscribeFeed } from "./feed.js";
import { ago } from "./labels.js";
import { preserveFocus } from "./live-page.js";
import { link } from "./router.js";
import { runName } from "./run-stats.js";
import { hasRole } from "./state.js";
import { statusChip } from "./ui.js";
import { opsSummary, feedIndicator } from "./ops-status.js";

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
  activity: null, alerts: null, spend: null, spendLabel: null, spendValue: null, toggle: null, chev: null,
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
 *
 * Activity is deliberately NOT a live region. It changes with every run that
 * starts or finishes, and a screen reader reading the footer aloud each time
 * would make the console unusable; the connection state, which changes rarely
 * and matters when it does, is the only thing that speaks.
 */
function buildBar() {
  ctl.dot = h("span.sb-dot", {});
  ctl.liveText = h("span.sb-v", {});
  ctl.live = h("span.sb-live", { role: "status" }, ctl.dot, ctl.liveText);
  ctl.activity = h("span.sb-activity", { hidden: true });
  ctl.alerts = h("span.sb-alerts", {});
  ctl.spendLabel = h("span.sb-k", {});
  ctl.spendValue = h("span.sb-v", {});
  ctl.spend = h("span.sb-spend", { hidden: true }, ctl.spendLabel, ctl.spendValue);
  ctl.chev = h("span.sb-chev", { "aria-hidden": "true" });
  ctl.toggle = h("button.sb-toggle#sb-toggle", {
    type: "button",
    onclick: toggleDrawer,
    "aria-controls": "sb-panel",
    title: "System detail and the dispatch ledger — every attempt to place a run on a runner",
  }, "Details", ctl.chev);
  ctl.bar = h("div.sb-bar", {},
    ctl.live, ctl.activity, ctl.alerts, h("span.sb-spacer", {}), ctl.spend, ctl.toggle);
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
  ctl.live.className = `sb-live ${feed.tone}`;
  // Only ever written when it differs: this is the live region.
  if (ctl.liveText.textContent !== feed.value) ctl.liveText.textContent = feed.value;
  ctl.live.title = feed.note;

  const sum = ctl.dev ? opsSummary(ctl.ops) : null;
  const sig = JSON.stringify(sum && [sum.activity, sum.alerts, sum.spend]);
  if (sig !== ctl.barSig) {
    ctl.barSig = sig;
    ctl.activity.hidden = ctl.spend.hidden = !sum;
    if (sum) {
      ctl.activity.className = `sb-activity ${sum.activity.tone}`;
      ctl.activity.textContent = sum.activity.value;
      ctl.activity.title = sum.activity.note;
      ctl.spendLabel.textContent = sum.spend.label;
      ctl.spendValue.textContent = sum.spend.value;
      ctl.spend.title = sum.spend.note;
    }
    // A fault is a sentence, not a colour: the chip reads on its own, and the
    // note behind it says what to do about it.
    mount(ctl.alerts, ...(sum?.alerts ?? []).map((a: WebDynamic) =>
      h("span.sb-alert", { title: a.note }, a.value)));
  }
  ctl.toggle.hidden = !ctl.dev;
  ctl.toggle.setAttribute("aria-expanded", ctl.open ? "true" : "false");
  ctl.chev.textContent = ctl.open ? "▾" : "▴";
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
 * The drawer: the numbers the bar deliberately leaves out, each with the
 * sentence behind it (a tooltip is unreachable by keyboard and invisible on
 * touch, so the notes need a home on screen), then the dispatch ledger. It
 * repaints only when something in it actually changes, so reading it is never
 * interrupted by the refresh timer.
 */
function paintPanel() {
  if (!ctl.el || !ctl.open) return;
  const rows = ctl.dispatches;
  const details = opsSummary(ctl.ops)?.details ?? [];
  const sig = JSON.stringify([
    // `null` (still loading) and `[]` (a project that has never dispatched) say
    // different things, so they must never share a signature. Ages are in the
    // signature as the WORDS they render: a row whose "2 min ago" has become
    // "3 min ago" has changed on screen, and one whose hasn't, has not.
    rows == null ? "loading" : rows.map((d: WebDynamic) => `${d.id}:${d.status}:${ago(stampOf(d))}`),
    details,
  ]);
  if (sig === ctl.panelSig) return;
  ctl.panelSig = sig;
  // A reader may be tabbed onto a row's link when a refresh lands.
  preserveFocus(() => mount(ctl.panel, h("div.sb-inner", {},
    h("div.sb-stats", {}, ...details.map(statCell)),
    h("div.sb-head", {},
      h("h2.section-title", {}, "Dispatches"),
      h("span.sb-note", {}, "every attempt to place a run on a runner"),
    ),
    rows == null
      ? h("div.sb-empty", {}, "Loading…")
      : rows.length
        ? h("div.card", {}, h("table.rows", {},
            h("thead", {}, h("tr", {}, h("th", {}, "Placed"), h("th", {}, "Status"), h("th", {}, "Isolation"), h("th", {}, "Updated"))),
            h("tbody", {}, ...rows.map(dispatchRow)),
          ))
        : h("div.sb-empty", {}, "Nothing has been dispatched in this project yet."),
  )));
}

// What a dispatch was placing. `ref_id` points at a different thing per kind, so
// only a group dispatch has a name and a page to follow it to; the other two
// say what they are, which is all there is to say about them.
const KINDS: WebDynamic = { media: "Clip", mint: "Runner mint" };

/** The last thing that happened to a dispatch, whatever stage it reached. */
const stampOf = (d: WebDynamic) => d.concluded_at || d.last_report_at || d.requested_at;

/** One drawer number: what it is, what it reads, and what that means. */
function statCell(item: WebDynamic) {
  return h("div.sb-stat", {},
    h("div.sb-k", {}, item.label),
    h(`div.sb-statv.${item.tone}`, {}, item.value),
    h("div.sb-note", {}, item.note),
  );
}

function dispatchRow(d: WebDynamic) {
  const at = stampOf(d);
  // The ledger outlives what it placed: a group swept by retention leaves its
  // row behind with nothing to join to, and a link there would lead to a 404.
  const group = d.kind === "group" && d.group_created_at != null;
  // Named the way the run itself is named everywhere else in the console — the
  // note whoever launched it wrote, else its trigger and start time.
  const what = group
    ? runName({ trigger: d.group_trigger, created_at: d.group_created_at })
    : d.kind === "group" ? "Run group, since deleted" : KINDS[d.kind] ?? d.kind;
  const to = group ? link(`/p/${ctl.projectKey}/runs/${d.ref_id}`, what) : null;
  to?.setAttribute("data-fk", `sb-dispatch-${d.id}`);
  return h("tr", {},
    h("td", {},
      to ?? what,
      // A first attempt is the norm and says nothing; a second is the story.
      d.attempt > 1 ? h("span.dim", {}, ` · attempt ${d.attempt}`) : null,
    ),
    h("td", {}, statusChip(d.status === "reconciled_dead" ? "infra" : d.status === "concluded" ? "pass" : "running", d.status)),
    h("td", {}, d.isolation || "—"),
    // How long ago, not which wall-clock instant: the ledger is read to see what
    // has just moved. The exact stamp stays a hover away.
    h("td.dim", { title: at ? new Date(at).toLocaleString() : "" }, at ? ago(at) : "—"),
  );
}
