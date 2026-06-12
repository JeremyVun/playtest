/* Playtest trajectory viewer. Loads /run/manifest.json (or /runs.json -> picker,
   /changed.json -> review list) and renders the recording. Every artifact is
   optional: missing files degrade to placeholders, never a blank app.
   Strictly read-only: accepting/rejecting changed journeys happens in the CLI. */

import { movement } from "./shared/movement.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  base: "/run",          // url prefix of the run dir
  manifest: null,
  steps: [],             // trajectory envelopes
  baseline: null,        // baseline envelopes or null
  baselineByStep: new Map(),
  har: [],
  grade: null,
  history: [],
  movement: null,        // this run vs its history (computeMovement)
  rootMode: false,       // serving a runs root (?run= used) — sibling links resolve
  runPath: null,         // normalized ?run= value (root mode), null in single-run mode
  acceptCmd: null,       // exact "playtest accept <dir>" for this run, when pending
  cur: 0,
  view: "stills",
  itab: "step",          // inspector tab: "step" | "run"
  playing: false,        // stills autoplay (strip play button / space)
  a11yCache: new Map(),
  videoOk: false,
};

let wired = false; // one-time listeners (tabs, keys, run links); loadRun re-runs on run switches
let loadSeq = 0;   // bails a stale loadRun when rapid pager clicks overlap mid-fetch
let navSeq = 0;

/* ---------- tiny DOM + fetch helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

function icon(name, cls = "ic") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#" + name);
  svg.append(use);
  return svg;
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchText(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

function parseJsonl(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip bad line */ }
  }
  return out;
}

/* ---------- formatting ---------- */

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function fmtTokens(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + "k";
}

function fmtBytes(n) {
  if (n == null || n < 0) return "—";
  if (n < 1024) return n + " B";
  return (n / 1024).toFixed(1) + " kB";
}

function fmtClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

// Readable local datetime for run lists: "today 14:23", "yesterday 09:01",
// "Jun 10, 14:23" (year appended when it isn't this year). Callers put the
// full ISO string in the title attribute for hover.
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return `today ${hm}`;
  if (sameDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `yesterday ${hm}`;
  const month = d.toLocaleString(undefined, { month: "short" });
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${month} ${d.getDate()}${year}, ${hm}`;
}

// "2026-06-11T0422-d926" → "d926": the random suffix is the readable part;
// the timestamp half duplicates the started column (and is UTC besides).
const shortRunId = (id) => (id == null ? "—" : String(id).split("-").at(-1));

// Copy-paste safety for displayed commands: quote a path for POSIX shells
// when it contains anything outside the safe set ('\'' escapes embedded
// quotes). Inline copy of cli.js shellQuote (the viewer has no bundler).
function shellQuote(s) {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Internal run mode -> user-facing label (inline copy of report.js modeLabel —
// the viewer has no bundler). Past tense: these surfaces describe finished
// runs. A healed pass is a "changed" journey.
function modeLabel(mode, healed, status) {
  if (healed && status === "pass") return "changed";
  return { record: "recorded", act: "checked", heal: "tried to heal", explore: "explored" }[mode] ?? mode ?? "?";
}

// One chip carries both mode and healed-ness: healed runs keep the accent +
// branch icon ("changed" when passing, "tried to heal" when not).
function modeChip(mode, healed, status) {
  const label = modeLabel(mode, healed, status);
  return healed
    ? h("span", { class: "chip accent" }, icon("i-branch"), label)
    : h("span", { class: "chip" }, label);
}

/* ---------- action helpers ---------- */

// Acted envelopes carry no agent block; their action lives on the baseline step
// they re-execute (acted_from). Returns null when unknowable.
function actionOf(env) {
  if (env.agent?.action) return env.agent.action;
  if (env.acted_from != null) return state.baselineByStep.get(env.acted_from)?.agent?.action ?? null;
  return null;
}

const ACTION_ICONS = {
  click: "i-click", type: "i-type", select: "i-select", scroll: "i-scroll",
  navigate: "i-nav", wait: "i-wait", done: "i-done", give_up: "i-giveup",
};

// "Add" out of role=button[name="Add"], "todo-input" out of [data-testid="todo-input"], etc.
function locatorName(locator) {
  if (!locator) return null;
  let m = locator.match(/name="((?:[^"\\]|\\.)*)"/);
  if (m) return m[1];
  m = locator.match(/data-testid=["']?([\w-]+)/);
  if (m) return m[1];
  m = locator.match(/^text="((?:[^"\\]|\\.)*)"$/);
  if (m) return m[1];
  return locator;
}

function targetName(env) {
  const a = actionOf(env);
  // a failed acted step has no resolution of its own; name it from the baseline's
  const locator = env.resolution?.locator
    ?? (env.acted_from != null ? state.baselineByStep.get(env.acted_from)?.resolution?.locator : null);
  return locatorName(locator) ?? (a?.ref ? `ref ${a.ref}` : null);
}

// -> { icon, verb, arg } for captions, strip cells and the inspector
function describe(env) {
  const a = actionOf(env);
  const type = a?.type ?? (env.acted_from != null ? "acted" : "step");
  const ic = ACTION_ICONS[type] ?? "i-film";
  const name = targetName(env);
  switch (type) {
    case "click": return { icon: ic, verb: "click", arg: name ?? "?" };
    case "type": return { icon: ic, verb: "type", arg: `“${a.text}”${name ? " → " + name : ""}` };
    case "select": return { icon: ic, verb: "select", arg: `“${a.value}”${name ? " in " + name : ""}` };
    case "scroll": return { icon: ic, verb: "scroll", arg: a.direction };
    case "navigate": return { icon: ic, verb: "go to", arg: a.url };
    case "wait": return { icon: ic, verb: "wait", arg: `${a.seconds}s` };
    case "done": return { icon: ic, verb: "done", arg: a.summary };
    case "give_up": return { icon: ic, verb: "gave up", arg: a.reason };
    default:
      return { icon: ic, verb: "acted", arg: name ?? `baseline step ${env.acted_from ?? "?"}` };
  }
}

/* ---------- boot ---------- */

async function boot() {
  const params = new URLSearchParams(location.search);
  const runParam = params.get("run");
  if (runParam) {
    state.runPath = runParam.replace(/^\/+|\/+$/g, "");
    state.base = "/run/" + state.runPath;
  }
  state.rootMode = Boolean(runParam);

  state.manifest = await fetchJson(state.base + "/manifest.json");
  if (state.manifest) return loadRun();

  if (!runParam) {
    // ?filter=changed|failed and ?case=<id> come from `playtest view` flags.
    if (params.get("filter") === "changed") {
      const entries = await fetchJson("/changed.json");
      if (Array.isArray(entries)) return renderChanged(entries);
    } else {
      let runs = await fetchJson("/runs.json");
      if (Array.isArray(runs) && runs.length) {
        const notes = [];
        if (params.get("filter") === "failed") {
          runs = runs.filter((r) => r.status === "fail" || r.status === "infra");
          notes.push("failed runs only");
        }
        const caseId = params.get("case");
        if (caseId) {
          runs = runs.filter((r) => r.case_id === caseId);
          notes.push("case " + caseId);
        }
        return renderPicker(runs, notes.join(" · ") || null);
      }
    }
  }
  renderFatal("No run found here. Point `playtest view` at a run directory (or a runs root), or check the ?run= parameter.");
}

async function loadRun() {
  const seq = ++loadSeq;
  const m = state.manifest;
  const caseId = m.case?.id ?? "";

  // an explicit null in manifest.artifacts means "this run has none" — don't probe
  const gradeRel = m.artifacts?.grade === null ? null : (m.artifacts?.grade ?? "grade.json");
  const baseRel = m.artifacts?.baseline_copy === null ? null : (m.artifacts?.baseline_copy ?? "baseline.jsonl");
  const [trajText, har, grade, baseText, history] = await Promise.all([
    fetchText(state.base + "/" + (m.artifacts?.trajectory ?? "trajectory.jsonl")),
    fetchJson(state.base + "/" + (m.artifacts?.har ?? "har.json")),
    gradeRel ? fetchJson(state.base + "/" + gradeRel) : null,
    baseRel ? fetchText(state.base + "/" + baseRel) : null,
    fetchJson("/history.json?case=" + encodeURIComponent(caseId)),
  ]);
  if (seq !== loadSeq) return; // superseded by a newer run switch

  state.steps = parseJsonl(trajText);
  state.har = har?.log?.entries ?? [];
  state.grade = grade;
  state.baseline = baseText ? parseJsonl(baseText) : null;
  if (state.baseline) for (const env of state.baseline) state.baselineByStep.set(env.step, env);
  state.history = Array.isArray(history) ? history : [];
  state.movement = computeMovement();

  // a healed pass may be awaiting acceptance: the changed list knows this
  // run's cwd-relative dir, which makes the accept command copy-pasteable.
  // Match THIS run's entry — by root-relative path in root mode (repeat-run
  // siblings share run_id), by run_id+case_id when serving a single run —
  // and only offer the command while that entry is still pending.
  if (m.healed && m.result?.status === "pass") {
    const changed = await fetchJson("/changed.json");
    if (seq !== loadSeq) return;
    const mine = Array.isArray(changed)
      ? changed.find((e) =>
          state.rootMode ? e.path === state.runPath : e.run_id === m.run_id && e.case_id === caseId)
      : null;
    if (mine?.pending) state.acceptCmd = "playtest accept " + shellQuote(mine.run_dir_rel);
  }

  document.title = `Playtest — ${caseId || "run"}`;
  $("#app").hidden = false;
  $("#back").hidden = !state.rootMode; // the picker only exists when serving a runs root

  // The chosen inspector tab survives moving between runs (run-nav pager,
  // history dots). Fresh sessions: a failed run opens on the verdict.
  let stored = null;
  try { stored = sessionStorage.getItem("playtest.itab"); } catch {}
  state.itab = !state.steps.length ? "run" : (stored ?? (m.result?.status === "fail" ? "run" : "step"));

  renderHeader();
  renderRunNav();
  renderBrief();
  renderStrip();
  renderInspectorStatic();
  renderSparkline();
  renderDiff();
  initVideo();
  if (!wired) {
    wired = true;
    initTabs();
    initKeys();
    initRunLinks();
    $("#play").addEventListener("click", () => setPlaying(!state.playing));
  }

  if (state.steps.length) {
    // open on the first failed/confused step when the run went wrong, else step 1
    let start = 0;
    if (m.result?.status === "fail" || m.mode === "heal") {
      const i = state.steps.findIndex((s) => s.result?.ok === false || s.confusion);
      if (i >= 0) start = i;
    }
    select(start, { instant: true });
  } else {
    renderEmptyRun();
  }
}

/* In-place switch to a sibling run (pager, history dots). A full page
   navigation tears the document down, and the browser drops mouse input on
   the new document until the pointer moves again — so paging through runs by
   repeatedly clicking a stationary mouse needs the document to survive. */
async function navigate(path, { push = true } = {}) {
  const seq = ++navSeq;
  const base = "/run/" + path;
  const manifest = await fetchJson(base + "/manifest.json");
  if (seq !== navSeq) return; // a newer click superseded this navigation
  if (!manifest) { location.href = "?run=" + encodeURIComponent(path); return; }
  if (push) history.pushState(null, "", "?run=" + encodeURIComponent(path));
  setPlaying(false);
  state.runPath = path;
  state.base = base;
  state.manifest = manifest;
  // reset run-scoped state; rootMode and the chosen view/itab survive
  Object.assign(state, {
    steps: [], baseline: null, har: [], grade: null, history: [],
    movement: null, acceptCmd: null, cur: 0, videoOk: false,
  });
  state.baselineByStep.clear();
  state.a11yCache.clear();
  await loadRun();
}

// Plain left-clicks on ?run= links (pager, history dots, expanded picker rows
// never get here — the picker isn't the app view) switch runs in place;
// modified clicks (new tab, etc.) keep native navigation.
function initRunLinks() {
  document.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = e.target.closest?.("a")?.getAttribute("href");
    if (!href?.startsWith("?run=") || !state.manifest) return;
    e.preventDefault();
    navigate(new URLSearchParams(href).get("run").replace(/^\/+|\/+$/g, ""));
  });
  window.addEventListener("popstate", () => {
    const p = new URLSearchParams(location.search).get("run");
    if (p && state.manifest) navigate(p.replace(/^\/+|\/+$/g, ""), { push: false });
    else location.reload(); // leaving the run view (e.g. back to the picker): boot fresh
  });
}

function renderFatal(msg) {
  const el = $("#fatal");
  el.hidden = false;
  el.replaceChildren(
    h("div", { class: "picker-brand" }, "Playtest"),
    h("p", {}, msg),
  );
}

/* ---------- run tables (picker + changed list) ---------- */

// Sortable table over run-list items. cols: { key, label, num?, desc? } —
// desc marks columns whose first click sorts descending (dates, numbers).
// rowsFor(item, redraw) returns that item's <tr>(s); rebuilt on every re-sort,
// and rows may call redraw() themselves (the picker's expand/collapse does).
function runsTable(items, cols, rowsFor, initKey) {
  const sort = { key: initKey, dir: cols.find((c) => c.key === initKey)?.desc ? -1 : 1 };
  const table = h("table", { class: "runs-table" });
  const cmp = (a, b) => {
    const va = a[sort.key], vb = b[sort.key];
    if (va == null || vb == null) return (va == null) - (vb == null); // nulls last either way
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return c * sort.dir;
  };
  const draw = () => {
    table.replaceChildren(
      h("thead", {}, h("tr", {}, ...cols.map((c) =>
        h("th", {
          class: c.num ? "num" : null,
          "aria-sort": sort.key === c.key ? (sort.dir > 0 ? "ascending" : "descending") : null,
        }, h("button", {
          class: "th-btn" + (sort.key === c.key ? " on" : ""),
          onclick: () => {
            sort.dir = sort.key === c.key ? -sort.dir : c.desc ? -1 : 1;
            sort.key = c.key;
            draw();
          },
        }, c.label, h("span", { class: "th-arrow" }, sort.key !== c.key ? "" : sort.dir > 0 ? "↑" : "↓"))),
      ))),
      h("tbody", {}, ...[...items].sort(cmp).flatMap((it) => rowsFor(it, draw))),
    );
  };
  draw();
  return h("div", { class: "table-card" }, table);
}

// whole row navigates; the case cell stays a real link for middle-click / a11y
function runRow(href, cls, ...cells) {
  return h("tr", {
    class: "run-row" + (cls ? " " + cls : ""),
    onclick: (e) => { if (!e.target.closest("a")) location.href = href; },
  }, ...cells);
}

/* One row per story (latest run), older runs expandable beneath it. */
function renderPicker(runs, filterNote = null) {
  const el = $("#picker");
  el.hidden = false;
  const storyKey = (r) => r.case_id ?? "?";
  const byStory = new Map();
  for (const r of runs) {
    const k = storyKey(r);
    if (!byStory.has(k)) byStory.set(k, []);
    byStory.get(k).push(r);
  }
  // groups sort on the latest run's values; mode_label sorts by what's shown
  const groups = [...byStory.entries()].map(([story, list]) => {
    list.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    return { story, runs: list, ...list[0], mode_label: modeLabel(list[0].mode, list[0].healed, list[0].status) };
  });
  const expanded = new Set();

  // story first (what you scan for), then outcome, then recency; run id last —
  // it's a random suffix, useful only for cross-referencing.
  const cols = [
    { key: "story", label: "story" },
    { key: "status", label: "status" },
    { key: "mode_label", label: "type" },
    { key: "started_at", label: "started", desc: true },
    { key: "duration_ms", label: "duration", num: true, desc: true },
    { key: "run_id", label: "run id" },
  ];
  const href = (r) => "?run=" + encodeURIComponent(r.path ?? `${r.run_id}/${r.case_id}`);
  const cells = (r, caseCell) => [
    caseCell,
    h("td", {}, statusChip(r.status)),
    h("td", {}, modeChip(r.mode, r.healed, r.status)),
    h("td", { class: "td-date", title: r.started_at ?? "" }, fmtDate(r.started_at)),
    h("td", { class: "num" }, fmtMs(r.duration_ms)),
    h("td", { class: "td-id", title: r.run_id ?? "" }, shortRunId(r.run_id)),
  ];
  const rowsFor = (g, redraw) => {
    const older = g.runs.length - 1;
    const open = expanded.has(g.story);
    const main = runRow(href(g), null, ...cells(g,
      h("td", { class: "td-case" },
        h("a", { class: "case-link", href: href(g) }, g.story),
        older > 0
          ? h("button", {
              class: "expand" + (open ? " on" : ""),
              title: (open ? "hide" : "show") + " this story's older runs",
              onclick: (e) => {
                e.stopPropagation();
                open ? expanded.delete(g.story) : expanded.add(g.story);
                redraw();
              },
            }, `${open ? "▾" : "▸"} ${older} older`)
          : null,
      )));
    if (!open) return [main];
    return [main, ...g.runs.slice(1).map((r) => runRow(href(r), "sub", ...cells(r,
      h("td", { class: "td-case" }, h("a", { class: "case-link", href: href(r) }, "↳ " + (r.case_id ?? "?"))))))];
  };
  el.replaceChildren(
    h("div", { class: "picker-inner" },
      h("div", { class: "picker-brand" }, "Playtest"),
      h("div", { class: "picker-sub" },
        `${groups.length} stor${groups.length === 1 ? "y" : "ies"} · ${runs.length} run${runs.length === 1 ? "" : "s"}${filterNote ? " · " + filterNote : ""}`),
      runs.length
        ? runsTable(groups, cols, rowsFor, "started_at")
        : h("p", { class: "empty-note" }, "no runs match this filter"),
    ),
  );
}

/* Read-only changed-journey review list (?filter=changed). Pending rows show
   the exact CLI commands; older healed passes stay listed, dimmed, as history. */
function renderChanged(entries) {
  const el = $("#picker");
  el.hidden = false;
  const pending = entries.filter((e) => e.pending);
  const items = entries.map((e) => ({ ...e, state: e.pending ? "changed" : "historical" }));
  // column order mirrors the picker: identity first, run id last
  const cols = [
    { key: "case_id", label: "case" },
    { key: "state", label: "state" },
    { key: "score", label: "score", num: true, desc: true },
    { key: "started_at", label: "started", desc: true },
    { key: "run_id", label: "run id" },
  ];
  const rowsFor = (e) => {
    const href = "?run=" + encodeURIComponent(e.path);
    const row = runRow(href, e.pending ? null : "dim",
      h("td", { class: "td-case" }, h("a", { class: "case-link", href }, e.case_id ?? "?")),
      h("td", {}, e.pending
        ? h("span", { class: "chip accent" }, icon("i-branch"), "changed")
        : h("span", { class: "chip" }, "historical")),
      h("td", { class: "num", title: e.score == null ? "ungraded" : null }, e.score != null ? String(e.score) : "—"),
      h("td", { class: "td-date", title: e.started_at ?? "" }, fmtDate(e.started_at)),
      h("td", { class: "td-id", title: e.run_id ?? "" }, shortRunId(e.run_id)),
    );
    if (!e.pending) return [row];
    const dir = shellQuote(e.run_dir_rel);
    return [row, h("tr", { class: "cmds-row" },
      h("td", { colspan: "5" }, h("pre", { class: "cmds" }, `playtest accept ${dir}\nplaytest reject ${dir}`)))];
  };
  el.replaceChildren(
    h("div", { class: "picker-inner" },
      h("div", { class: "picker-brand" }, "Playtest"),
      h("div", { class: "picker-sub" },
        `${pending.length} changed journey${pending.length === 1 ? "" : "s"} awaiting review`),
      entries.length
        ? runsTable(items, cols, rowsFor, "started_at")
        : h("p", { class: "empty-note" }, "no changed journeys — passing healed runs will appear here"),
    ),
  );
}

/* ---------- run movement vs history ---------- */

const signedMs = (ms) => (ms < 0 ? "-" : "+") + fmtMs(Math.abs(ms));
const signedInt = (n) => (n < 0 ? "-" : "+") + Math.round(Math.abs(n));

/**
 * Deltas of this run vs its history. The comparability rules — pin set
 * included — and the badge thresholds live in the shared module (served at
 * /shared/movement.js, same code cli.js uses); this maps the viewer's state
 * onto its inputs. The current run's worst LCP comes from the step envelopes,
 * like the server computes it for history entries.
 */
function computeMovement() {
  const m = state.manifest;
  const lcps = state.steps.map((s) => s.perf?.nav?.lcp_ms).filter((v) => typeof v === "number");
  return movement(state.history, {
    run_id: m.run_id,
    started_at: m.started_at,
    status: m.mode === "explore" ? "explored" : (m.result?.status ?? null),
    healed: m.healed ?? false,
    duration_ms: m.duration_ms ?? null,
    steps: m.totals?.steps ?? null,
    lcp_ms: lcps.length ? Math.max(...lcps) : null,
    score: state.grade?.score ?? null,
    pins: m.pins ?? null,
  });
}

/* compact "<metric> <Δ vs prev> · med <Δ vs last-5 median>" chip, or null */
function deltaChip(label, d, fmt) {
  if (d.prev == null) return null;
  if (d.prev === 0 && !d.med) return null; // zero movement is noise, not signal
  return h("span", {
    class: "chip",
    title: `${label} vs previous comparable run (${state.movement.prev.run_id ?? "?"})` +
      (d.med != null ? "; med = vs median of the last 5 runs" : ""),
  }, `${label} ${fmt(d.prev)}${d.med != null ? ` · med ${fmt(d.med)}` : ""}`);
}

// Only the distilled regression/improved verdict goes in the topbar. No
// statusMove chip either: "pass → healed" duplicates the "changed" mode chip
// and "pass → fail" duplicates the fail status + regression badge.
function movementBadge() {
  const mv = state.movement;
  if (!mv?.badge) return null;
  return h("span", { class: "chip " + (mv.badge === "regression" ? "fail" : "pass") },
    icon(mv.badge === "regression" ? "i-warn" : "i-check"), mv.badge);
}

// raw deltas vs history; rendered next to the history chart, where they have context
function movementDeltas() {
  const mv = state.movement;
  if (!mv) return [];
  return [
    deltaChip("time", mv.duration, signedMs),
    deltaChip("steps", mv.steps, signedInt),
    deltaChip("lcp", mv.lcp, signedMs),
    deltaChip("score", mv.score, signedInt),
  ].filter(Boolean);
}

/* ---------- header ---------- */

function statusChip(status) {
  if (status === "pass") return h("span", { class: "chip pass" }, icon("i-check"), "pass");
  if (status === "fail") return h("span", { class: "chip fail" }, icon("i-x"), "fail");
  if (status === "infra") return h("span", { class: "chip warn" }, icon("i-warn"), "infra");
  if (status === "explored") return h("span", { class: "chip accent" }, icon("i-eye"), "explored");
  return h("span", { class: "chip" }, status ?? "?");
}

function renderHeader() {
  const m = state.manifest;
  $("#case-id").replaceChildren(
    m.case?.id ?? "unknown case",
    h("span", { class: "run-id" }, `  ·  ${m.run_id ?? ""}`),
  );

  const badges = [statusChip(m.result?.status), modeChip(m.mode, m.healed, m.result?.status)];
  const reason = m.result?.end_reason;
  if (reason && reason !== "done") badges.push(h("span", { class: "chip warn" }, reason.replace("_", " ")));
  badges.push(h("span", { class: "chip" }, `${state.steps.length} steps`));
  badges.push(h("span", { class: "chip" }, fmtMs(m.duration_ms)));
  const conf = m.totals?.confusion_events ?? 0;
  if (conf > 0) badges.push(h("span", { class: "chip warn" }, icon("i-warn"), `${conf} confusion`));
  const move = movementBadge();
  if (move) badges.push(move);
  $("#run-badges").replaceChildren(...badges);

  const t = m.totals?.tokens ?? {};
  const cost = m.totals?.cost_usd;
  const el = $("#cost-strip");
  const cachePct = t.in ? Math.round(((t.cache_read ?? 0) / t.in) * 100) : 0;
  el.replaceChildren(
    h("div", { class: "cost-label" }, "run cost"),
    h("div", { class: "cost-usd" }, "$" + (cost ?? 0).toFixed(4)),
    h("div", { class: "cost-sub" },
      !t.in && !t.out && !cost
        ? "no model calls"
        : `${fmtTokens(t.in)} in · ${fmtTokens(t.out)} out · ${cachePct}% cached`),
  );
}

/* ---------- run pager: ‹ 3 / 6 › through this story's history ---------- */

// Topbar pager over the case's runs, oldest → newest. Root mode only —
// sibling run links don't resolve when serving a single run directory.
// Repeat-run siblings share run_id, so the current run is matched by path.
function renderRunNav() {
  const el = $("#run-nav");
  const hist = state.history;
  const idx = hist.findIndex((r) =>
    state.runPath ? r.path === state.runPath : r.run_id === state.manifest.run_id);
  if (!state.rootMode || hist.length < 2 || idx < 0) { el.hidden = true; return; }
  const btn = (r, glyph, label) => r?.path
    ? h("a", { class: "rn-btn", href: "?run=" + encodeURIComponent(r.path),
        title: `${label}: ${r.run_id} · ${fmtDate(r.started_at)}` }, glyph)
    : h("span", { class: "rn-btn off" }, glyph);
  el.hidden = false;
  el.replaceChildren(
    h("div", { class: "rn-label" }, "this story"),
    h("div", { class: "rn-row" },
      btn(hist[idx - 1], "‹", "older run"),
      // space-pad the index to the total's width (mono + white-space:pre) so
      // the pager doesn't change width while stepping through runs
      h("span", { class: "rn-pos" }, `${String(idx + 1).padStart(String(hist.length).length)} / ${hist.length}`),
      btn(hist[idx + 1], "›", "newer run"),
    ),
  );
}

/* ---------- cross-run history chart (Run tab) ---------- */

const HIST_COLOR = { pass: "var(--pass)", fail: "var(--fail)", infra: "var(--warn)", explored: "var(--accent)" };

function renderSparkline() {
  const el = $("#sec-history");
  const note = (msg) =>
    el.replaceChildren(sec("i-gauge", "history", null, h("div", { class: "empty-note" }, msg)));
  const hist = state.history;
  if (!hist || hist.length < 2) return note("first recorded run of this case — history will accrue here");
  // Every run of the case sits on the trend line. Ungraded runs (checking runs
  // have no grade.json) carry the last known score forward — drawn hollow so
  // they read as "still at 90" rather than as a grade of their own. Score is
  // charted when at least 2 runs are graded, else duration.
  const graded = hist.filter((r) => r.score != null);
  const useScore = graded.length >= 2;
  const own = hist.map((r) => (useScore ? r.score : r.duration_ms));
  const known = own.filter((v) => v != null);
  if (!known.length) return note("not enough comparable runs to chart yet");

  // carry forward; leading ungraded runs inherit the first real value
  const firstKnown = own.find((v) => v != null);
  let carry = firstKnown;
  const plotted = own.map((v) => (v != null ? (carry = v) : carry));

  const W = 300, H = 76, L = 12, R = 12, T = 18, B = 14;
  const min = Math.min(...known), max = Math.max(...known);
  const span = max - min;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, hist.length - 1);
  // a flat series sits mid-chart, not pinned to the bottom edge
  const y = (v) => (span === 0 ? (T + H - B) / 2 : H - B - ((v - min) / span) * (H - T - B));
  const fmtVal = (v) => (useScore ? String(Math.round(v)) : fmtMs(v));
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const clampX = (px) => Math.min(Math.max(px, 16), W - 16);

  const pts = plotted.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const marks = hist.map((r, i) => {
    const ghost = own[i] == null;
    const cur = r.run_id === state.manifest.run_id;
    const color = HIST_COLOR[r.status] ?? "var(--dim)";
    const title = `${r.run_id} · ${r.status}` +
      (r.score != null ? ` · score ${r.score}` : useScore ? ` · ungraded (last score ${fmtVal(plotted[i])})` : "") +
      ` · ${fmtMs(r.duration_ms)} · ${fmtDate(r.started_at)}`;
    const cx = x(i).toFixed(1), cy = y(plotted[i]).toFixed(1);
    const shape = ghost
      ? `<circle class="hd" cx="${cx}" cy="${cy}" r="${cur ? 4 : 3}" fill="var(--bg1)" stroke="${cur ? "var(--ink)" : color}" stroke-width="1.4"/>`
      : `<circle class="hd" cx="${cx}" cy="${cy}" r="${cur ? 4 : 3}" fill="${color}" ${cur ? 'stroke="var(--ink)" stroke-width="1.2"' : ""}/>`;
    // invisible r=9 circle widens the hover/click target around the mark
    const mark = `<g><circle cx="${cx}" cy="${cy}" r="9" fill="transparent"/>${shape}<title>${esc(title)}</title></g>`;
    // marks jump to older runs — sibling paths only resolve when serving a runs root
    return state.rootMode && r.path ? `<a href="?run=${encodeURIComponent(r.path)}">${mark}</a>` : mark;
  }).join("");

  // annotate the best real value, and the current run when its real value differs
  const maxIdx = own.findIndex((v) => v === max);
  const labels = [`<text class="hist-val" x="${clampX(x(maxIdx)).toFixed(1)}" y="${(y(max) - 8).toFixed(1)}" text-anchor="middle">${fmtVal(max)}</text>`];
  const curIdx = hist.findIndex((r) => r.run_id === state.manifest.run_id);
  const curVal = curIdx >= 0 ? own[curIdx] : null;
  if (curVal != null && curVal !== max) {
    labels.push(`<text class="hist-val cur" x="${clampX(x(curIdx)).toFixed(1)}" y="${Math.min(H - 2, y(curVal) + 14).toFixed(1)}" text-anchor="middle">${fmtVal(curVal)}</text>`);
  }

  const chart = h("div", { class: "hist-chart" });
  chart.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="hist-svg">` +
    `<polyline points="${pts.join(" ")}" fill="none" stroke="var(--line2)" stroke-width="1.5"/>` +
    marks + labels.join("") + `</svg>`;

  const hasGhosts = own.some((v) => v == null);
  const foot = h("div", { class: "hist-foot" },
    h("span", { title: "oldest → newest" }, `${fmtDate(hist[0].started_at)} → ${fmtDate(hist.at(-1).started_at)}`),
    h("span", { class: "hist-legend" },
      ...[...new Set(hist.map((r) => r.status))].map((s) =>
        h("span", { class: "lg" }, h("span", { class: "lg-dot", style: `background:${HIST_COLOR[s] ?? "var(--dim)"}` }), s ?? "?")),
      hasGhosts
        ? h("span", { class: "lg", title: "hollow = ungraded run, shown at the last graded score" },
            h("span", { class: "lg-ghost" }), "ungraded")
        : null),
  );
  const deltas = movementDeltas();
  const deltaRow = deltas.length
    ? h("div", { class: "hist-deltas" }, h("span", { class: "label" }, "vs prev"), ...deltas)
    : null;
  el.replaceChildren(sec("i-gauge", "history",
    useScore ? `${graded.length} of ${hist.length} graded · score` : `${hist.length} runs · duration`,
    chart, foot, deltaRow));
}

/* ---------- film strip ---------- */

// Step envelopes never carry mode "heal" — the runner writes "agent" for the
// heal continuation — so a step is a heal step when the agent was driving in a
// run that healed: everything after the replayed track broke.
const isHealStep = (env) => env.mode === "agent" && !!state.manifest?.healed;

const MAX_SETTLE_BAR = 2000; // ms that fills the little settle lane

function renderStrip() {
  const strip = $("#strip");
  strip.replaceChildren();
  if (!state.steps.length) {
    strip.append(h("div", { class: "empty-note", style: "padding:18px" }, "no steps recorded"));
    return;
  }
  state.steps.forEach((env, i) => {
    const d = describe(env);
    const thumb = h("div", { class: "cell-thumb" });
    if (env.artifacts?.screenshot) {
      const img = h("img", { src: state.base + "/" + env.artifacts.screenshot, alt: "", loading: "lazy" });
      img.addEventListener("error", () => img.replaceWith(h("div", { class: "nopic" }, icon("i-film"))));
      thumb.append(img);
    } else {
      thumb.append(h("div", { class: "nopic" }, icon("i-film")));
    }
    const flags = [];
    if (env.result?.ok === false) flags.push(h("span", { class: "flag fail", title: "step failed" }, icon("i-x")));
    if (env.confusion) flags.push(h("span", { class: "flag warn", title: "confusion: " + env.confusion.type }, icon("i-warn")));
    if (isHealStep(env)) flags.push(h("span", { class: "flag heal", title: "healed — the agent found a new path here" }, icon("i-branch")));
    if (flags.length) thumb.append(h("div", { class: "flags" }, ...flags));

    const settle = env.result?.settle_ms ?? 0;
    const tele = h("div", { class: "cell-tele" },
      h("div", { class: "settle-lane" },
        h("div", { class: "settle-bar", style: `width:${Math.min(100, (settle / MAX_SETTLE_BAR) * 100)}%` })),
      h("span", { class: "cell-ms" }, fmtMs(settle)),
      (env.perf?.js_errors ?? 0) > 0 ? icon("i-warn") : null,
    );

    // border tint mirrors the flags so trouble spots read from across the room
    const cellCls = "cell" +
      (env.result?.ok === false ? " c-fail" : env.confusion ? " c-warn" : isHealStep(env) ? " c-heal" : "");
    strip.append(h("button", { class: cellCls, "data-i": i, onclick: () => select(i) },
      thumb,
      h("div", { class: "cell-cap" },
        h("div", { class: "cell-line" },
          h("span", { class: "n" }, String(env.step).padStart(2, "0")),
          icon(d.icon),
          h("span", { class: "t" }, `${d.verb} ${d.arg ?? ""}`)),
        tele,
      ),
      h("div", { class: "cell-prog" }), // autoplay countdown bar; animates while #strip.playing
    ));
  });
}

/* ---------- autoplay: walk the steps like a slideshow ---------- */

const AUTOPLAY_MS = 1200;
let playTimer = null;

function setPlaying(on) {
  if (on && !state.steps.length) return;
  state.playing = on;
  clearInterval(playTimer);
  playTimer = null;
  const btn = $("#play");
  btn.replaceChildren(icon(on ? "i-pause" : "i-play"), on ? "Pause" : "Play");
  btn.title = on ? "pause (space)" : "play through the steps (space)";
  btn.setAttribute("aria-label", on ? "pause" : "play through the steps");
  btn.classList.toggle("on", on);
  // the active cell's countdown bar animates only while this class is on
  const strip = $("#strip");
  strip.classList.toggle("playing", on);
  strip.style.setProperty("--autoplay-ms", AUTOPLAY_MS + "ms");
  if (!on) return;
  if (state.cur >= state.steps.length - 1) select(0, { auto: true }); // play at the end restarts
  playTimer = setInterval(() => {
    if (state.cur >= state.steps.length - 1) setPlaying(false);
    else select(state.cur + 1, { auto: true });
  }, AUTOPLAY_MS);
}

/* ---------- selection ---------- */

function select(i, { instant = false, auto = false } = {}) {
  if (!state.steps.length) return;
  if (!auto && state.playing) setPlaying(false); // manual navigation pauses the slideshow
  state.cur = Math.max(0, Math.min(i, state.steps.length - 1));
  const env = state.steps[state.cur];

  document.querySelectorAll("#strip .cell").forEach((c) => {
    const on = Number(c.dataset.i) === state.cur;
    c.classList.toggle("on", on);
    if (on) c.scrollIntoView({ block: "nearest", inline: "nearest", behavior: instant ? "auto" : "smooth" });
  });

  updateCaption(env);
  updateStage(env);
  renderInspectorStep(env);
}

function updateCaption(env) {
  const meta = [h("span", { class: "cap-step" }, `step ${env.step} / ${state.steps.length}`)];
  meta.push(env.mode === "act"
    ? h("span", { class: "chip" }, `replayed · step ${env.acted_from ?? "?"}`)
    : isHealStep(env)
      ? h("span", { class: "chip accent" }, icon("i-branch"), "healed · agent took over")
      : h("span", { class: "chip" }, "agent"));
  if (env.result?.ok === false) meta.push(h("span", { class: "chip fail" }, icon("i-x"), "failed"));
  if (env.confusion) meta.push(h("span", { class: "chip warn" }, icon("i-warn"), "confusion · " + env.confusion.type.replace("_", " ")));
  $("#cap-meta").replaceChildren(...meta);

  const thought = $("#cap-thought");
  if (env.agent?.thought) {
    thought.textContent = env.agent.thought;
    thought.className = "cap-thought";
  } else {
    const d = describe(env);
    // done/give_up args are full sentences: quote them instead of splicing
    // them after the verb (avoids "— done I added x.." double-period reads).
    const what =
      d.verb === "done" || d.verb === "gave up"
        ? `${d.verb === "done" ? "finished" : "gave up"}: “${String(d.arg ?? "").replace(/[.\s]+$/, "")}”`
        : `${d.verb} ${d.arg ?? ""}`.trim();
    thought.textContent = `Replayed from the saved recording — ${what}. The agent doesn't narrate replayed steps.`;
    thought.className = "cap-thought quiet";
  }

  const exp = $("#cap-expect");
  if (env.agent?.expectation) {
    exp.replaceChildren(h("b", {}, "expects"), env.agent.expectation);
    exp.hidden = false;
  } else if (env.confusion?.note) {
    exp.replaceChildren(h("b", {}, "note"), env.confusion.note);
    exp.hidden = false;
  } else {
    exp.hidden = true;
  }
}

/* ---------- stage: stills + ghost cursor ---------- */

let ghostTimer = null;

function updateStage(env) {
  if (state.view === "stills") showStill(env);
  else if (state.view === "a11y") showA11y(env);
  else if (state.view === "video") seekVideo(env);
  // diff view is run-level; nothing to update per step
}

function showStill(env) {
  const img = $("#shot");
  const wrap = $("#shot-wrap");
  const missing = $("#shot-missing");
  const src = env.artifacts?.screenshot ? state.base + "/" + env.artifacts.screenshot : null;
  if (!src) return stillMissing(env);

  missing.hidden = true;
  wrap.hidden = false;
  const place = () => { sizeShotWrap(); placeGhost(env); };
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    img.onerror = () => stillMissing(env);
    img.onload = place;
    img.src = src;
    if (img.complete && img.naturalWidth) place();
  } else if (img.complete && !img.naturalWidth) {
    stillMissing(env); // this src already failed to load — keep the placeholder
  } else {
    place();
  }
}

// fit the wrap to the largest box with the image's aspect ratio inside the pane
function sizeShotWrap() {
  const img = $("#shot");
  const pane = $("#pane-stills");
  if (!img.naturalWidth || !pane.clientWidth) return;
  const r = img.naturalWidth / img.naturalHeight;
  const cs = getComputedStyle(pane);
  const availW = pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = pane.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const w = Math.min(availW, availH * r);
  const wrap = $("#shot-wrap");
  wrap.style.width = w + "px";
  wrap.style.height = w / r + "px";
}
window.addEventListener("resize", () => { if (state.view === "stills") sizeShotWrap(); });

function stillMissing(env) {
  $("#shot-wrap").hidden = true;
  const el = $("#shot-missing");
  el.hidden = false;
  el.replaceChildren(icon("i-film", ""), `no frame — screenshot missing for step ${env.step}`);
}

function placeGhost(env) {
  const ghost = $("#ghost");
  const img = $("#shot");
  const bbox = env.resolution?.bbox;
  if (!bbox || !img.naturalWidth) {
    ghost.classList.remove("show");
    return;
  }
  const cx = ((bbox.x + (bbox.w ?? 0) / 2) / img.naturalWidth) * 100;
  const cy = ((bbox.y + (bbox.h ?? 0) / 2) / img.naturalHeight) * 100;
  const wasShown = ghost.classList.contains("show");
  ghost.style.left = cx.toFixed(2) + "%";
  ghost.style.top = cy.toFixed(2) + "%";
  ghost.classList.add("show");
  clearTimeout(ghostTimer);
  const ring = $("#ghost-ring");
  ring.classList.remove("pulse");
  ghostTimer = setTimeout(() => {
    void ring.offsetWidth; // restart the pulse animation
    ring.classList.add("pulse");
  }, wasShown ? 620 : 200);
}

/* ---------- stage: a11y text ---------- */

async function showA11y(env) {
  const pre = $("#a11y-pre");
  const rel = env.artifacts?.a11y;
  if (!rel) { renderA11yText(pre, null, env); return; }
  if (!state.a11yCache.has(rel)) state.a11yCache.set(rel, await fetchText(state.base + "/" + rel));
  // selection may have moved while fetching
  if (state.steps[state.cur] === env) renderA11yText(pre, state.a11yCache.get(rel), env);
}

function renderA11yText(pre, text, env) {
  pre.replaceChildren();
  if (!text) {
    pre.append(h("span", { class: "head" }, `no snapshot text captured for step ${env.step}`));
    return;
  }
  // colorize [eN] refs and the Page: line, keep everything else literal
  for (const line of text.split("\n")) {
    const m = line.match(/^(\[e\d+\])(.*)$/);
    if (m) {
      pre.append(h("span", { class: "ref" }, m[1]), m[2] + "\n");
    } else if (line.startsWith("Page:")) {
      pre.append(h("span", { class: "head" }, line + "\n"));
    } else {
      pre.append(line + "\n");
    }
  }
}

/* ---------- stage: video ---------- */

let videoWired = false;

function initVideo() {
  const video = $("#video");
  // re-entrant: undo a previous run's missing-state before loading this one
  $(".video-box").hidden = false;
  $("#video-missing").hidden = true;
  $("#vmarks").replaceChildren();
  if (!videoWired) {
    videoWired = true;
    video.addEventListener("error", videoMissing);
    video.addEventListener("loadedmetadata", () => {
      state.videoOk = true;
      renderVideoMarks(video.duration);
      // the user may have opened the tab (and picked a step) before metadata arrived
      if (state.view === "video" && state.steps.length) seekVideo(state.steps[state.cur]);
    });
  }
  const rel = state.manifest.artifacts?.video === null ? null : (state.manifest.artifacts?.video ?? "video.webm");
  if (!rel) {
    video.removeAttribute("src");
    video.load(); // release the previous run's video; fires error -> videoMissing
    return videoMissing();
  }
  video.src = state.base + "/" + rel;
  wireCaptionTrack(video);
}

// `playtest clip` leaves a video.vtt sidecar next to the webm; when present,
// surface it as a native captions track (probed like the other optional
// artifacts — most runs have none).
async function wireCaptionTrack(video) {
  video.querySelector("track")?.remove();
  const base = state.base;
  const text = await fetchText(base + "/video.vtt");
  if (base !== state.base) return; // run switched while probing
  if (!text || !text.startsWith("WEBVTT")) return;
  const track = h("track", { kind: "captions", label: "captions", src: base + "/video.vtt", default: "" });
  video.append(track);
  track.track.mode = "showing";
}

function videoMissing() {
  $(".video-box").hidden = true;
  const el = $("#video-missing");
  el.hidden = false;
  el.replaceChildren(icon("i-play", ""), "no video recorded for this run");
}

function renderVideoMarks(duration) {
  const vsa = state.manifest.video_started_at;
  if (!vsa || !duration) return;
  const marks = $("#vmarks");
  marks.replaceChildren();
  state.steps.forEach((env, i) => {
    if (env.ts == null) return;
    const t = (env.ts - vsa) / 1000;
    if (t < 0 || t > duration) return;
    marks.append(h("button", {
      class: "vmark", "data-i": i, title: `step ${env.step} @ ${fmtClock(t)}`,
      "aria-label": `step ${env.step} @ ${fmtClock(t)}`,
      style: `left:${(t / duration) * 100}%`,
      onclick: () => select(i),
    }));
  });
}

// keep the step-marker lane exactly as wide as the rendered video
function syncVmarks() {
  const w = $("#video").clientWidth;
  if (w) $("#vmarks").style.width = w + "px";
}
window.addEventListener("resize", () => { if (state.view === "video") syncVmarks(); });

function seekVideo(env) {
  const video = $("#video");
  const vsa = state.manifest.video_started_at;
  if (state.videoOk && vsa && env.ts != null) {
    video.currentTime = Math.max(0, (env.ts - vsa) / 1000);
  }
  syncVmarks();
  document.querySelectorAll(".vmark").forEach((m) => m.classList.toggle("on", Number(m.dataset.i) === state.cur));
}

/* ---------- stage: diff (standalone LCS over action signatures) ---------- */

function isExecutable(env) {
  const t = actionOf(env)?.type;
  return env.resolution && env.result?.ok && t !== "done" && t !== "give_up";
}

function signature(env) {
  const a = actionOf(env);
  return (a?.type ?? "?") + "|" + (env.resolution?.locator ?? a?.url ?? "") + "|" + (a?.text ?? "");
}

function lcsDiff(A, B, sigA, sigB) {
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = sigA[i] === sigB[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (sigA[i] === sigB[j]) ops.push({ op: "same", a: A[i++], b: B[j++] });
    else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ op: "del", a: A[i++], b: null });
    else ops.push({ op: "add", a: null, b: B[j++] });
  }
  while (i < n) ops.push({ op: "del", a: A[i++], b: null });
  while (j < m) ops.push({ op: "add", a: null, b: B[j++] });
  return ops;
}

function diffCell(env, op) {
  if (!env) return h("div", { class: "dcell empty" });
  const d = describe(env);
  // baseline-side envelopes aren't in state.steps — only this run's cells navigate
  const idx = op === "del" ? -1 : state.steps.indexOf(env);
  return h(idx >= 0 ? "button" : "div", {
    class: "dcell " + op + (idx >= 0 ? " clickable" : ""),
    onclick: idx >= 0 ? () => select(idx) : null,
  },
    h("div", { class: "d-act" },
      h("span", { class: "d-num" }, String(env.step).padStart(2, "0")),
      icon(d.icon),
      h("span", {}, `${d.verb} ${d.arg ?? ""}`)),
    env.resolution?.locator ? h("div", { class: "d-loc" }, env.resolution.locator) : null,
  );
}

// The failed replay attempt behind a removed baseline row: not part of the
// LCS track (it executed nothing), but it is the heal point — name it.
function failedReplayCell(env) {
  const idx = state.steps.indexOf(env);
  return h("button", { class: "dcell fail-note clickable", onclick: () => select(idx) },
    h("div", { class: "d-act" },
      h("span", { class: "d-num" }, String(env.step).padStart(2, "0")),
      icon("i-x"),
      h("span", {}, "replay attempt failed — agent took over")),
  );
}

function renderDiff() {
  $("#tab-diff").hidden = !state.baseline;
  if (!state.baseline) {
    $("#diff-body").replaceChildren();
    if (state.view === "diff") setView("stills"); // run switched under an open diff tab
    return;
  }

  const A = state.baseline.filter(isExecutable);
  const B = state.steps.filter(isExecutable);
  const ops = lcsDiff(A, B, A.map(signature), B.map(signature));
  const sum = { same: 0, del: 0, add: 0 };
  for (const o of ops) sum[o.op]++;

  // A removed baseline row usually has a story: this run *tried* it and the
  // replay failed (the heal point). Show that attempt in the empty cell so
  // the strip's step numbers stay accountable in the track.
  const failedReplayBy = new Map(
    state.steps
      .filter((e) => e.mode === "act" && e.result?.ok === false && e.acted_from != null)
      .map((e) => [e.acted_from, e]),
  );

  const body = $("#diff-body");
  body.replaceChildren(
    h("div", { class: "diff-head" },
      h("span", { class: "diff-title" }, "Action track vs. baseline"),
      h("span", { class: "diff-sub" },
        h("span", { class: "d-same" }, `${sum.same} same`), " · ",
        h("span", { class: "d-del" }, `${sum.del} removed`), " · ",
        h("span", { class: "d-add" }, `${sum.add} added`),
        "  ·  executed UI actions only",
        state.manifest.baseline?.run_id ? `  ·  baseline ${state.manifest.baseline.run_id}` : ""),
    ),
    h("div", { class: "diff-cols" },
      h("div", { class: "diff-colhead" }, "baseline recording"),
      h("div", { class: "diff-colhead" }, "this run"),
      ...ops.flatMap((o) => [
        diffCell(o.a, o.op === "add" ? "empty" : o.op),
        o.op === "del" && failedReplayBy.has(o.a?.step)
          ? failedReplayCell(failedReplayBy.get(o.a.step))
          : diffCell(o.b, o.op === "del" ? "empty" : o.op),
      ]),
    ),
  );

  // divergence frame: first changed op that has a step in this run with a screenshot
  const frameEnv = ops.find((o) => o.op !== "same" && o.b?.artifacts?.screenshot)?.b;
  if (frameEnv) {
    const img = h("img", {
      src: state.base + "/" + frameEnv.artifacts.screenshot,
      alt: "divergence frame",
      title: "open this step in Stills",
      onclick: () => { setView("stills"); select(state.steps.indexOf(frameEnv)); },
    });
    img.addEventListener("error", () => img.remove());
    // a healed pass with no acceptCmd is not the pending candidate (a sibling
    // superseded it, or it was already accepted/rejected) — no command then
    const resolvedHealedPass =
      !state.acceptCmd && state.manifest.healed && state.manifest.result?.status === "pass";
    body.append(h("div", { class: "diff-frame" }, img,
      h("div", {},
        h("div", { class: "label" }, `first divergence — step ${frameEnv.step} of this run`),
        resolvedHealedPass
          ? h("p", {}, "The journey diverged here and survived: the baseline action no longer matched, and the agent found a new path. This run is no longer the pending changed journey — it was superseded by a later healed run or already resolved (accepted or rejected), so there is nothing to accept from here.")
          : [
              h("p", {}, "The journey diverges here: the baseline action no longer matched, and the agent found a new path. If the run is green, the UI changed but the journey survived — review it, then accept this run as the new saved path:"),
              h("pre", { class: "cmds" }, state.acceptCmd ?? "playtest accept <run-dir>"),
            ])));
  }
}

/* ---------- inspector ---------- */

function sec(iconName, title, right, ...children) {
  return h("section", { class: "sec" },
    h("div", { class: "sec-h" }, icon(iconName), title, right ? h("span", { class: "right" }, right) : null),
    ...children);
}

function stat(label, value, unit, cls = "") {
  return h("div", { class: "stat " + cls },
    h("div", { class: "v" }, value, unit ? h("small", {}, unit) : null),
    h("div", { class: "k" }, label));
}

/* Two panes: what this step did, and how the run as a whole went. Step-level
   sections re-render on every select(); run-level sections render once. */
function renderInspectorStatic() {
  const insp = $("#inspector");
  insp.replaceChildren(
    h("div", { class: "insp-tabs" },
      h("button", { class: "itab", "data-itab": "step", onclick: () => setInspTab("step") }, "This step"),
      h("button", { class: "itab", "data-itab": "run", onclick: () => setInspTab("run") }, "Run"),
    ),
    h("div", { id: "ipane-step" },
      h("div", { id: "sec-step" }),
      h("div", { id: "sec-tele" }),
      h("div", { id: "sec-net" }),
      h("div", { id: "sec-tok" }),
    ),
    h("div", { id: "ipane-run" },
      renderGate(),
      renderGrade(),
      h("div", { id: "sec-history" }),
    ),
  );
  setInspTab(state.itab);
}

function setInspTab(name) {
  state.itab = name;
  try { sessionStorage.setItem("playtest.itab", name); } catch {}
  document.querySelectorAll(".itab").forEach((t) => t.classList.toggle("on", t.dataset.itab === name));
  $("#ipane-step").hidden = name !== "step";
  $("#ipane-run").hidden = name !== "run";
}

function renderEmptyRun() {
  $("#sec-step").replaceChildren(sec("i-film", "steps", null,
    h("div", { class: "empty-note" }, "trajectory.jsonl is missing or empty — run-level results are under the Run tab")));
  $("#cap-thought").textContent = "No steps were recorded for this run.";
  $("#cap-thought").className = "cap-thought quiet";
  $("#a11y-pre").textContent = "no steps — nothing was seen";
  $("#shot-wrap").hidden = true;
  const miss = $("#shot-missing");
  miss.hidden = false;
  miss.replaceChildren(icon("i-film", ""), "no frames");
}

function renderInspectorStep(env) {
  const d = describe(env);
  const a = actionOf(env);
  const replayed = env.acted_from != null || env.mode === "act";
  const failed = env.result?.ok === false;

  // What happened: the action, where it came from, whether it worked, and on
  // what element — in that order, in words rather than field names.
  const status = h("div", { class: "step-status" },
    failed
      ? h("span", { class: "chip fail" }, icon("i-x"), "failed")
      : h("span", { class: "chip pass" }, icon("i-check"), "succeeded"),
    env.result?.error ? h("div", { class: "step-err" }, env.result.error) : null);

  const kv = h("dl", { class: "kv" });
  const put = (k, v, cls) => { if (v != null && v !== "") kv.append(h("dt", {}, k), h("dd", { class: cls ?? "" }, v)); };
  put("element", env.resolution?.locator);
  if (a?.type === "done") put("summary", a.summary);
  if (a?.type === "give_up") put("reason", a.reason);
  if (env.confusion) put("confusion", `${env.confusion.type}${env.confusion.note ? " — " + env.confusion.note : ""}`, "err");

  const heal = isHealStep(env);
  $("#sec-step").replaceChildren(sec("i-film", `step ${env.step}`, replayed ? "replayed" : heal ? "healed" : "agent",
    h("div", { class: "act-line" }, icon(d.icon), h("span", { class: "verb" }, d.verb), h("span", { class: "act-arg", title: d.arg ?? "" }, d.arg ?? "")),
    replayed
      ? h("div", { class: "step-src" }, `re-running step ${env.acted_from ?? "?"} of the saved recording`)
      : heal
        ? h("div", { class: "step-src" }, "the saved recording broke — the agent took over and chose this action")
        : h("div", { class: "step-src" }, "the agent chose this action itself"),
    status,
    kv.childElementCount ? kv : null));

  // performance
  $("#sec-tele").replaceChildren(renderPerf(env));

  // network: the rich waterfall needs har.json; when it is missing/empty fall
  // back to the compact env.network.requests embedded in newer envelopes, so a
  // bare trajectory still gets a useful panel (old runs keep the waterfall).
  const netEntries = (env.artifacts?.har_entries ?? []).map((i) => state.har[i]).filter(Boolean);
  const embedded = env.network?.requests ?? [];
  const useEmbedded = !netEntries.length && embedded.length > 0;
  const count = useEmbedded ? embedded.length : netEntries.length;
  const netLabel = count > MAX_WF_ROWS ? `${MAX_WF_ROWS} of ${count} req` : `${count} req`;
  $("#sec-net").replaceChildren(sec("i-net", "network", netLabel,
    useEmbedded ? renderNetRequests(embedded) : renderWaterfall(netEntries)));

  // tokens
  $("#sec-tok").replaceChildren(renderTokens(env));
}

/* Performance of the app under test, in plain language. Four cells, no
   disclosure — each metric makes sense on sight, with a tooltip for depth.
   Navigation steps show Lighthouse's heavyweights (LCP, CLS); interaction
   steps show responsiveness (INP-style) and time-to-idle. "UI blocked"
   (long tasks) is the Total Blocking Time idea. Bands follow web vitals. */
function renderPerf(env) {
  const p = env.perf ?? {};
  const band = (v, good, poor) => (v == null ? "dim" : v < good ? "" : v < poor ? "warn" : "bad");
  const cell = (label, value, cls, title) =>
    h("div", { class: "stat " + cls, title },
      h("div", { class: "v" }, value),
      h("div", { class: "k" }, label));

  const cells = p.nav
    ? [
        cell("page load · lcp", fmtMs(p.nav.lcp_ms), band(p.nav.lcp_ms, 2500, 4000),
          "Largest Contentful Paint — when the new page showed its main content. Lighthouse's headline load metric (good < 2.5s)."),
        cell("layout shift · cls", p.nav.cls == null ? "—" : Number(p.nav.cls).toFixed(2), band(p.nav.cls, 0.1, 0.25),
          "Cumulative Layout Shift — how much the page jumped around while loading (good < 0.1)."),
      ]
    : [
        cell("reacted in", fmtMs(p.input_to_paint_ms), band(p.input_to_paint_ms, 100, 300),
          "How long before the app visibly reacted to the click or keystroke — anything on screen changing (good < 100ms)."),
        cell("finished in", fmtMs(env.result?.settle_ms), "",
          "How long until the page finished updating after this action — network and content went quiet, ready for the next thing."),
      ];
  const errs = p.js_errors ?? 0;
  cells.push(
    cell("ui frozen for", p.long_tasks_ms != null ? fmtMs(p.long_tasks_ms) : "—",
      p.long_tasks_ms ? band(p.long_tasks_ms, 200, 600) : "dim",
      "Total time the page couldn't respond because JavaScript was busy — the Total Blocking Time idea (good < 200ms)."),
    cell("js errors", errs, errs > 0 ? "bad" : "dim",
      "Uncaught exceptions and console errors during this step."),
  );
  return sec("i-gauge", "performance", p.nav ? "page navigation" : null,
    h("div", { class: "stat-grid two" }, ...cells));
}

const MAX_WF_ROWS = 24;

function renderWaterfall(entries) {
  if (!entries.length) return h("div", { class: "empty-note" }, "no requests in this step’s window");

  const starts = entries.map((e) => Date.parse(e.startedDateTime) || 0);
  const t0 = Math.min(...starts);
  const total = Math.max(1, ...entries.map((e, i) => starts[i] - t0 + Math.max(0, e.time ?? 0)));

  const rows = entries.slice(0, MAX_WF_ROWS).map((e, i) => {
    const failed = !!e._failed;
    const pending = !failed && (e.time ?? -1) < 0; // never finished within the run
    const status = e.response?.status ?? 0;
    const bad = failed || status >= 400;
    const slow = !bad && !pending && (e.time ?? 0) > 500;
    const left = ((starts[i] - t0) / total) * 100;
    const width = pending
      ? Math.max(1.5, 100 - left) // open-ended bar to the lane's edge
      : Math.max(1.5, (Math.max(0, e.time ?? 0) / total) * 100);
    let path;
    try { path = new URL(e.request?.url ?? "", "http://x").pathname + (new URL(e.request?.url ?? "", "http://x").search || ""); }
    catch { path = e.request?.url ?? "?"; }
    return h("div", { class: "wf-row" },
      h("div", { class: "wf-top" },
        h("span", { class: "wf-method" }, e.request?.method ?? "GET"),
        h("span", { class: "wf-status" + (bad ? " bad" : "") },
          status > 0 ? String(status) : failed ? "✕ failed" : pending ? "… pending" : "?"),
        h("span", { class: "wf-url", title: e.request?.url ?? "" }, "‎" + path),
        h("span", { class: "wf-time" }, `${fmtBytes(e.response?.bodySize)} · ${pending ? "—" : fmtMs(Math.max(0, e.time ?? 0))}`)),
      h("div", { class: "wf-lane" },
        h("div", { class: "wf-bar" + (bad ? " bad" : pending ? " pending" : slow ? " slow" : ""), style: `left:${left}%;width:${width}%` })));
  });
  return h("div", { class: "wf" }, ...rows);
}

// Compact list for embedded network.requests (stable fields only — no
// timings/sizes by design, so no waterfall lane): method, status, path, mime.
function renderNetRequests(requests) {
  const rows = requests.slice(0, MAX_WF_ROWS).map((r) => {
    const status = r.status ?? 0;
    const bad = r.failed || status >= 400;
    return h("div", { class: "wf-row" },
      h("div", { class: "wf-top" },
        h("span", { class: "wf-method" }, r.method ?? "GET"),
        h("span", { class: "wf-status" + (bad ? " bad" : "") },
          status > 0 ? String(status) : r.failed ? "✕ failed" : "… pending"),
        h("span", { class: "wf-url", title: r.url ?? "" }, "‎" + (r.path ?? r.url ?? "?")),
        h("span", { class: "wf-time" }, r.mime_type || "—")));
  });
  return h("div", { class: "wf" }, ...rows);
}

// what this step cost in model tokens ("tokens" alone read as jargon)
function renderTokens(env) {
  if (!env.tokens) {
    return sec("i-token", "model usage", null,
      h("div", { class: "empty-note" }, env.mode === "act" ? "replayed step — no model call" : "no model usage recorded"));
  }
  // cumulative through the current step
  const upto = state.steps.slice(0, state.cur + 1).reduce((acc, s) => {
    if (s.tokens) { acc.in += s.tokens.in ?? 0; acc.out += s.tokens.out ?? 0; acc.cache += s.tokens.cache_read ?? 0; }
    return acc;
  }, { in: 0, out: 0, cache: 0 });
  return sec("i-token", "model usage", `Σ ${fmtTokens(upto.in)} in / ${fmtTokens(upto.out)} out`,
    h("div", { class: "stat-grid" },
      stat("tokens in", fmtTokens(env.tokens.in)),
      stat("tokens out", fmtTokens(env.tokens.out)),
      stat("cache read", fmtTokens(env.tokens.cache_read))));
}

function renderGate() {
  const gate = state.manifest.result?.gate;
  if (!gate) return sec("i-check", "gate", null, h("div", { class: "empty-note" }, "no gate result in manifest"));
  const rows = (gate.checks ?? []).map((c) =>
    h("div", { class: "gate-row" },
      icon(c.pass ? "i-check" : "i-x", "ic " + (c.pass ? "g-pass" : "g-fail")),
      h("div", {},
        h("div", { class: "gate-spec" }, c.spec ?? c.kind),
        c.detail ? h("div", { class: "gate-detail" }, c.detail) : null)));
  return sec("i-check", "gate", null,
    h("div", { style: "margin-bottom:8px" }, gate.pass
      ? h("span", { class: "chip pass" }, icon("i-check"), "gate pass")
      : h("span", { class: "chip fail" }, icon("i-x"), "gate fail")),
    ...rows);
}

// deep-link button into the step timeline (grade findings + report evidence)
function stepLink(n) {
  return h("button", { class: "f-step", onclick: () => {
    const i = state.steps.findIndex((s) => s.step === n);
    if (i >= 0) select(i);
  } }, `→ step ${n}`);
}

function renderGrade() {
  const g = state.grade;
  if (!g) return sec("i-gauge", "grade", null, h("div", { class: "empty-note" }, "not graded — grade.json absent"));
  const sevCls = { major: "fail", minor: "warn", info: "" };
  const findings = (g.findings ?? []).map((f) =>
    h("div", { class: "finding" },
      h("span", { class: "chip " + (sevCls[f.severity] ?? "") }, f.severity),
      h("p", {}, f.note + " ", f.step != null ? stepLink(f.step) : null)));
  // discovery report answers (grade.json `report`) — the study's data product
  const report = (g.report ?? []).map((r, i) =>
    h("div", { class: "report-entry" },
      h("div", { class: "report-q" }, `${i + 1}. ${r.question}`),
      h("p", { class: "report-a" }, r.answer,
        ...(r.evidence_steps ?? []).flatMap((n) => [" ", stepLink(n)]))));
  return sec("i-gauge", "grade", g.model ?? null,
    h("div", { class: "grade-top" },
      h("div", { class: "grade-score" }, String(Math.round(g.score)), h("small", {}, " / 100")),
      h("div", {},
        h("div", { style: "margin-bottom:4px" }, h("span", { class: "chip " + (g.completion === "full" ? "pass" : g.completion === "none" ? "fail" : "warn") }, "completion · " + g.completion)),
        g.efficiency?.wasted_steps != null ? h("div", { class: "empty-note" }, `${g.efficiency.wasted_steps} wasted step${g.efficiency.wasted_steps === 1 ? "" : "s"}`) : null)),
    g.efficiency?.assessment ? h("div", { class: "gate-detail", style: "margin-bottom:6px" }, g.efficiency.assessment) : null,
    ...(report.length ? [h("div", { class: "label", style: "margin-top:10px" }, "report"), ...report] : []),
    ...findings,
    g.summary ? h("p", { class: "grade-summary" }, "“" + g.summary + "”") : null);
}

/* The brief sits pinned to the bottom of the left panel, below the step
   thought — the "what the user was trying to do" context belongs next to
   "what the agent was thinking", but the live thought reads first. */
function renderBrief() {
  const c = state.manifest.case ?? {};
  // YAML block scalars arrive hard-wrapped: collapse single newlines to spaces
  // (blank lines stay paragraph breaks) so the story reads as prose.
  const story = (c.story ?? "").trim().replace(/([^\n])\n(?!\n)/g, "$1 ");
  // replaceChildren stringifies null to a literal "null" text node (unlike h())
  $("#cap-brief").replaceChildren(...[
    h("div", { class: "label" }, "the brief"),
    h("p", { class: "brief-story" }, story),
    c.persona
      ? h("div", { class: "brief-persona" },
          h("b", {}, "persona"),
          h("span", { class: "bp-name" }, icon("i-persona"), c.persona))
      : null,
    (c.tags ?? []).length
      ? h("div", { class: "nav-vitals" }, ...(c.tags ?? []).map((t) => h("span", { class: "chip" }, "#" + t)))
      : null,
  ].filter(Boolean));
}

/* ---------- tabs + keys ---------- */

function setView(view) {
  if (view === "diff" && $("#tab-diff").hidden) return;
  state.view = view;
  // stills autoplay belongs to the step-following views; video plays itself
  // and diff is run-level, so the control hides (and stops) on both
  const canPlay = view === "stills" || view === "a11y";
  $("#play").hidden = !canPlay;
  if (!canPlay) setPlaying(false);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === view));
  $("#pane-stills").hidden = view !== "stills";
  $("#pane-a11y").hidden = view !== "a11y";
  $("#pane-video").hidden = view !== "video";
  $("#pane-diff").hidden = view !== "diff";
  $("#caption").hidden = view === "diff"; // diff is run-level; the step thought panel would mislead
  if (state.steps.length) updateStage(state.steps[state.cur]);
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
}

function initKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "VIDEO" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft") { select(state.cur - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { select(state.cur + 1); e.preventDefault(); }
    else if (e.key === "Tab") {
      // cycle every visible stage tab (diff only exists with a baseline);
      // shift+tab cycles backwards. This claims tab from focus traversal.
      const views = ["stills", "a11y", "video", "diff"].filter((v) => v !== "diff" || !$("#tab-diff").hidden);
      const dir = e.shiftKey ? -1 : 1;
      setView(views[(views.indexOf(state.view) + dir + views.length) % views.length]);
      e.preventDefault();
    }
    // space toggles autoplay where the control is visible — except on focused
    // controls, where it must stay a click
    else if (e.key === " " && !$("#play").hidden && !e.target.closest("button, a, input, select, textarea")) {
      setPlaying(!state.playing);
      e.preventDefault();
    }
  });
}

boot();
