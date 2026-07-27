/* Playtest trajectory viewer. Loads /run/manifest.json (or /runs.json → picker,
   /changed.json → review list) and renders the recording. Every artifact is
   optional: missing files degrade to placeholders, never a blank app.
   Strictly read-only: accepting/rejecting changed journeys happens in the CLI. */

import { movement } from "./shared/movement.js";
import { AUTOPLAY_MS } from "./shared/timing.js";

type ViewerDynamic = any; // SAFETY: Viewer inputs are unvalidated artifact JSON and heterogeneous DOM content.
type RunMode = "record" | "act" | "heal" | "explore";

const $ = (sel: ViewerDynamic): ViewerDynamic => document.querySelector(sel);

// Data-URL base: the directory this page was served from ("/" under `playtest
// view`, a project-scoped prefix under the hosted viewer adapter). All data
// routes (run/, runs.json, changed.json, history.json) resolve against it, so
// the viewer works from any static server providing the URL shape under
// its own base path (docs/contracts/interfaces.md#viewer-url-contract).
const ROOT = location.pathname.replace(/[^/]*$/, "");

// When a still-click seeks the video to a step's `ts`, land this far PAST the
// caption cue boundary so the playhead sits inside the step's own cue (a seek
// onto the exact boundary renders two stacked cues). Tiny vs the smallest step
// gap, so it never bleeds into the next cue. See seekVideo().
const SEEK_NUDGE_S = 0.05;

const state: ViewerDynamic = {
  base: ROOT + "run",      // url prefix of the run dir
  manifest: null,
  steps: [],               // trajectory envelopes
  baseline: null,          // baseline envelopes or null
  baselineByStep: new Map(),
  har: [],
  grade: null,
  drift: null,             // drift-report.json on an API heal, else null
  inheritedGrade: null,    // {grade, from} — a checked run's quality carried from the last graded run
  history: [],
  movement: null,          // this run vs its history (computeMovement)
  rootMode: false,         // serving a runs root (?run= used) — sibling links resolve
  runPath: null,           // normalized ?run= value (root mode), null in single-run mode
  acceptCmd: null,         // exact "playtest baseline accept <dir>" for this run, when pending
  rejectCmd: null,         // its "playtest baseline reject <dir>" twin
  deepStep: null,          // ?step=N deep-link — consumed by the first loadRun, then null
  deepView: null,          // ?view=diff deep-link — consumed by the first loadRun, then null
  cur: 0,
  view: "stills",
  itab: "step",            // inspector tab: "step" | "run"
  inspWide: false,         // inspector widened to ~half the screen (long grade reports)
  capWide: false,          // left caption panel widened for long briefs/thoughts
  playing: false,          // stills autoplay (strip play button / space)
  a11yCache: new Map(),
  diffPair: new Map(),     // this-run envelope -> { op, base } from the diff track LCS
  a11yMode: "custom",      // Agent view: "custom" (our snapshot) | "pw" (Playwright native a11y, debug)
  pwA11yCache: new Map(),
  context: null,           // { system, byStep:Map<step,{messages}> } from context.jsonl, or null
  videoOk: false,
};

let wired = false; // one-time listeners (tabs, keys, run links); loadRun re-runs on run switches
let loadSeq = 0;   // bails a stale loadRun when rapid pager clicks overlap mid-fetch
let navSeq = 0;

/* ---------- tiny DOM + fetch helpers ---------- */

function h(tag: ViewerDynamic, attrs = {}, ...children: ViewerDynamic) {
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

function icon(name: ViewerDynamic, cls = "ic") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#" + name);
  svg.append(use);
  return svg;
}

async function fetchJson(url: ViewerDynamic) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchText(url: ViewerDynamic) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

function parseJsonl(text: ViewerDynamic) {
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip bad line */ }
  }
  return out;
}

// context.jsonl: a {type:"header", system} first line (system hoisted out once,
// byte-identical every step) + one {step, messages} line per turn. We tolerate
// the legacy no-header format too (system carried per-line inside `messages`):
// fall back to the first message that looks like the system/persona prompt.
// Any parse trouble returns null so the Context tab simply stays hidden.
function parseContext(text: ViewerDynamic) {
  if (!text) return null;
  try {
    const lines = parseJsonl(text);
    if (!lines.length) return null;
    let system = null;
    let tools = null;
    const byStep = new Map();
    for (const l of lines) {
      if (l.type === "header") { system = l.system ?? null; tools = l.tools ?? null; continue; }
      if (l.step === null || !Array.isArray(l.messages)) continue;
      let messages = l.messages;
      // legacy: no header line → the system message rides inside messages
      if (system == null && messages[0]?.role === "system") {
        system = messages[0].content ?? null;
      }
      // never show the system message twice (header path already has it)
      if (messages[0]?.role === "system") messages = messages.slice(1);
      byStep.set(l.step, { messages, model: l.model ?? null });
    }
    if (!byStep.size) return null;
    return { system, tools, byStep };
  } catch { return null; }
}

/* ---------- formatting ---------- */
function fmtMs(ms: ViewerDynamic) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function fmtTokens(n: ViewerDynamic) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + "k";
}

function fmtBytes(n: ViewerDynamic) {
  if (n == null || n < 0) return "—";
  if (n < 1024) return n + " B";
  return (n / 1024).toFixed(1) + " kB";
}

function fmtClock(seconds: ViewerDynamic) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}
  // full ISO string in the title attribute for hover.
function fmtDate(iso: ViewerDynamic) {
  if (!iso) return "—";
  const d: ViewerDynamic = new Date(iso);
  if (isNaN(d)) return String(iso);
  const now: ViewerDynamic = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = (a: ViewerDynamic, b: ViewerDynamic) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return `today ${hm}`;
  if (sameDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `yesterday ${hm}`;
  const month = d.toLocaleString(undefined, { month: "short" });
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${month} ${d.getDate()}${year}, ${hm}`;
}

// Relative age for history dots/footer: "just now", "2 hours ago", "3 days ago",
// "2 weeks ago". Calendar-day based so a run from late yesterday reads "1 day
// ago", not "18 hours ago". Full datetime stays in fmtDate (hover/title).
function relTime(iso: ViewerDynamic, now: ViewerDynamic = new Date()) {
  if (!iso) return "—";
  const d: ViewerDynamic = new Date(iso);
  if (isNaN(d)) return String(iso);
  const startOfDay = (x: ViewerDynamic): ViewerDynamic => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) {
    const mins = Math.round((now - d) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.round(days / 7);
    return `${w} week${w === 1 ? "" : "s"} ago`;
  }
  if (days < 365) {
    const mo = Math.round(days / 30);
    return `${mo} month${mo === 1 ? "" : "s"} ago`;
  }
  const y = Math.round(days / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

// "2026-06-11T0422-d926" → "d926": the random suffix is the readable part;
// the timestamp half duplicates the started column (and is UTC besides).
const shortRunId = (id: ViewerDynamic) => (id == null ? "—" : String(id).split("-").at(-1));

// Persona descriptions are authored with hard line wraps for source-editing
// readability. Reflow for display: collapse runs of single newlines (soft
// wraps within a paragraph) into spaces, but keep blank-line paragraph breaks.
function reflow(text: ViewerDynamic) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p: ViewerDynamic) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

// Copy-paste safety for displayed commands: quote a path for POSIX shells
// when it contains anything outside the safe set ('\'' escapes embedded
// quotes). Inline copy of cli.ts shellQuote (the viewer has no bundler).
function shellQuote(s: ViewerDynamic) {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Internal run mode → user-facing label (inline copy of report.ts modeLabel —
// the viewer has no bundler). Past tense: these surfaces describe finished
// runs. A healed pass is a "changed" journey.
function modeLabel(mode: ViewerDynamic, healed: ViewerDynamic, status: ViewerDynamic) {
  if (healed && status === "pass") return "changed";
  return { record: "recorded", act: "checked", heal: "tried to heal", explore: "explored" }[mode as RunMode] ?? mode ?? "?";
}

// One chip carries both mode and healed-ness: healed runs keep the accent +
// branch icon ("changed" when passing, "tried to heal" when not).
function modeChip(mode: ViewerDynamic, healed: ViewerDynamic, status: ViewerDynamic) {
  const label = modeLabel(mode, healed, status);
  return healed
    ? h("span", { class: "chip accent" }, icon("i-branch"), label)
    : h("span", { class: "chip" }, label);
}

/* ---------- action helpers ---------- */

// Acted envelopes carry no agent block; their action lives on the baseline step
// they re-execute (acted_from). Returns null when unknowable.
function actionOf(env: ViewerDynamic) {
  if (env.agent?.action) return env.agent.action;
  if (env.acted_from !== null) return state.baselineByStep.get(env.acted_from)?.agent?.action ?? null;
  return null;
}

const ACTION_ICONS: ViewerDynamic = {
  click: "i-click", type: "i-type", select: "i-select", scroll: "i-scroll",
  navigate: "i-nav", wait: "i-wait", done: "i-done", give_up: "i-giveup",
  // mobile verbs reuse web icons where sensible (the ?? fallback covers any gap)
  tap: "i-click", swipe: "i-scroll", back: "i-back", request: "i-net",
};

// "Add" out of role=button[name="Add"], "todo-input" out of [data-testid="todo-input"], etc.
function locatorName(locator: ViewerDynamic) {
  if (!locator) return null;
  let m = locator.match(/name="((?:[^"\\]|\\.)*)"/);
  if (m) return m[1];
  m = locator.match(/\[data-testid=["']?([\w-]+)/);
  if (m) return m[1];
  m = locator.match(/^text="((?:[^"\\]|\\.)*)"$/);
  if (m) return m[1];
  return locator;
}

function targetName(env: ViewerDynamic) {
  const a = actionOf(env);
  // a failed action has no resolution of its own; name it from the baseline's
  const locator = env.resolution?.locator
    ?? (env.acted_from != null ? state.baselineByStep.get(env.acted_from)?.resolution?.locator : null);
  const fromLocator = locatorName(locator);
  // A structural replay locator is useful to the harness but hostile as an
  // action caption. The pre-action snapshot already records the semantic role
  // and accessible name the actor chose; use that for the human-facing label.
  if (fromLocator && !/:nth-of-type\(/.test(fromLocator)) return fromLocator;
  if (a?.ref && env.snapshot_text) {
    const escaped = a.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^\\[${escaped}\\]\\s+\\S+\\s+"([^"]+)"`, "m").exec(env.snapshot_text);
    if (match) return match[1];
  }
  return fromLocator ?? (a?.ref ? `ref ${a.ref}` : null);
}

// → { icon, verb, arg } for captions, strip cells and the inspector
function describe(env: ViewerDynamic) {
  const a = actionOf(env);
  if (env.mode === "error") return { icon: "i-warn", verb: "actor error", arg: "" };
  const type = a?.type ?? (env.acted_from != null ? "acted" : "step");
  const ic = ACTION_ICONS[type] ?? "i-film";
  const name = targetName(env);
  switch (type) {
    case "click": return { icon: ic, verb: "click", arg: name ?? "?" };
    case "type": return { icon: ic, verb: "type", arg: `${a.text}${name ? " → " + name : ""}` };
    case "select": return { icon: ic, verb: "select", arg: `${a.value}${name ? " in " + name : ""}` };
    case "scroll": return { icon: ic, verb: "scroll", arg: a.direction };
    case "navigate": return { icon: ic, verb: "go to", arg: a.url };
    case "wait": return { icon: ic, verb: "wait", arg: `${a.seconds}s` };
    case "done": return { icon: ic, verb: "done", arg: a.summary };
    case "give_up": return { icon: ic, verb: "gave up", arg: a.reason };
    // mobile verbs
    case "tap":      return { icon: ic, verb: "tap",    arg: name ?? "?" };
    case "swipe": return { icon: ic, verb: "swipe", arg: `${a.direction}${name ? " on " + name : ""}` };
    case "back": return { icon: ic, verb: "back", arg: "" };
    case "api_request": return { icon: ic, verb: a.method ?? "request", arg: a.path ?? "" };
    case "request": return { icon: ic, verb: a.method ?? "request", arg: a.path ?? "" };
    default: return { icon: ic, verb: "acted", arg: name ?? `baseline step ${env.acted_from ?? "?"}` };
  }
}

/* ---------- boot ---------- */
async function boot() {
  const params = new URLSearchParams(location.search);
  const runParam = params.get("run");
  if (runParam) {
    state.runPath = runParam.replace(/^\/+|\/+$/g, "");
    state.base = ROOT + "run/" + state.runPath;
  }
  // ?step=N (1-based envelope step) opens the run on that step — evidence
  // deep-links from hosted study reports land on the cited moment. Absent or
  // unparseable, behavior is unchanged.
  const stepParam = Number(params.get("step"));
  state.deepStep = Number.isInteger(stepParam) && stepParam > 0 ? stepParam : null;
  // ?view=diff opens the Diff tab when the run has a baseline (review-queue
  // deep-links). Other values are ignored.
  state.deepView = params.get("view") === "diff" ? "diff" : null;
  // ?embed=1 — a host page (the hosted app's run detail) wraps the viewer in
  // its own chrome and owns identity/navigation, so the topbar (brand, run
  // title, story pager) is hidden and only the instrument renders. ?theme=
  // forces a palette when the host's theme differs from the OS preference.
  if (params.get("embed") === "1") document.documentElement.dataset.embed = "1";
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  state.rootMode = Boolean(runParam);
  state.manifest = await fetchJson(state.base + "/manifest.json");
  if (state.manifest) return loadRun();
  if (!runParam) {
    // ?filter=changed|failed and ?case=<id> come from `playtest view` flags.
    if (params.get("filter") === "changed") {
      const entries = await fetchJson(ROOT + "changed.json");
      if (Array.isArray(entries)) return renderChanged(entries);
    } else {
      let runs = await fetchJson(ROOT + "runs.json");
      if (Array.isArray(runs) && runs.length) {
        const notes = [];
        if (params.get("filter") === "failed") {
          runs = runs.filter((r: ViewerDynamic) => r.status === "fail" || r.status === "infra" || r.status === "interrupted");
          notes.push("failed runs only");
        }
        const caseId = params.get("case");
        if (caseId) {
          runs = runs.filter((r: ViewerDynamic) => r.case_id === caseId);
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
  const contextRel = m.artifacts?.context ?? null;
  // The heal's drift report, only when the manifest advertises one (an API heal).
  const driftRel = m.artifacts?.drift_report ?? null;
  // context.jsonl is only fetched when the manifest advertises it (record/heal)
  const [trajText, har, grade, baseText, history, contextText, drift] = await Promise.all([
    fetchText(state.base + "/" + (m.artifacts?.trajectory ?? "trajectory.jsonl")),
    fetchJson(state.base + "/" + (m.artifacts?.har ?? "har.json")),
    gradeRel ? fetchJson(state.base + "/" + gradeRel) : null,
    baseRel ? fetchText(state.base + "/" + baseRel) : null,
    fetchJson(ROOT + "history.json?case=" + encodeURIComponent(caseId)),
    contextRel ? fetchText(state.base + "/" + contextRel) : null,
    driftRel ? fetchJson(state.base + "/" + driftRel) : null,
  ]);
  if (seq !== loadSeq) return; // superseded by a newer run switch

  state.steps = parseJsonl(trajText);
  state.har = har?.log?.entries ?? [];
  state.grade = grade;
  state.drift = drift;
  state.inheritedGrade = null;
  state.baseline = baseText ? parseJsonl(baseText) : null;
  state.baselineByStep.clear();
  if (state.baseline) for (const env of state.baseline) state.baselineByStep.set(env.step, env);
  state.history = Array.isArray(history) ? history : [];
  state.context = parseContext(contextText);
  if (!state.context && state.view === "context") state.view = "stills";
  $("#tab-context").hidden = !state.context;
  state.movement = computeMovement();

  // a healed pass may be awaiting acceptance: the changed list knows this
  // run's cwd-relative dir, which makes the accept command copy-pasteable.
  // Match THIS run's entry — by root-relative path in root mode (repeat-run
  // siblings share run_id), by run_id+case_id when serving a single run —
  // and only offer the command while that entry is still pending.
  if (m.healed && m.result?.status === "pass") {
    const changed = await fetchJson(ROOT + "changed.json");
    if (seq !== loadSeq) return;
    const mine = Array.isArray(changed)
      ? changed.find((e: ViewerDynamic) =>
          state.rootMode ? e.path === state.runPath : e.run_id === m.run_id && e.case_id === caseId)
      : null;
    if (mine?.pending) {
      state.acceptCmd = "playtest baseline accept " + shellQuote(mine.run_dir_rel);
      state.rejectCmd = "playtest baseline reject " + shellQuote(mine.run_dir_rel);
    }
  }

  document.title = `Playtest — ${caseId || "run"}`;
  $("#app").hidden = false;
  $("#back").hidden = !state.rootMode; // the picker only exists when serving a runs root

  // The chosen inspector tab survives moving between runs (run-nav pager,
  // history dots). Fresh sessions: a failed run opens on the verdict.
  let stored = null;
  try { stored = sessionStorage.getItem("playtest.itab"); } catch {}
  try { state.inspWide = sessionStorage.getItem("playtest.inspWide") === "1"; } catch {}
  try { state.capWide = sessionStorage.getItem("playtest.capWide") === "1"; } catch {}
  reflectCapWide();
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
    $("#cap-wide-btn").addEventListener("click", () => setCapWide(!state.capWide));
  }

  if (state.steps.length) {
    // open on the first failed/confused step when the run went wrong, else step 1
    let start = 0;
    if (m.result?.status === "fail" || m.mode === "heal") {
      const i = state.steps.findIndex((s: ViewerDynamic) => s.result?.ok === false || s.confusion);
      if (i >= 0) start = i;
    }
    // A ?step= deep-link wins, once — pager/history moves after that are normal.
    if (state.deepStep != null) {
      const i = state.steps.findIndex((s: ViewerDynamic) => s.step === state.deepStep);
      if (i >= 0) start = i;
      state.deepStep = null;
    }
    select(start, { instant: true });
  } else {
    renderEmptyRun();
  }
  // A ?view=diff deep-link opens the Diff tab, once — review-queue "open full
  // diff" links land on the divergence instead of step-1 stills. Ignored when
  // the run has no baseline (the tab stays hidden and stills remain).
  if (state.deepView) {
    setView(state.deepView);
    state.deepView = null;
  }
}

/* In-place switch to a sibling run (pager, history dots). A full page
   navigation tears the document down, and the browser drops mouse input on
   the new document until the pointer moves again — so paging through runs by
   repeatedly clicking a stationary mouse needs the document to survive. */
async function navigate(path: ViewerDynamic, { push = true } = {}) {
  const seq = ++navSeq;
  const base = ROOT + "run/" + path;
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
    steps: [], baseline: null, har: [], grade: null, inheritedGrade: null, history: [],
    movement: null, acceptCmd: null, rejectCmd: null, cur: 0, context: null, videoOk: false,
  });
  state.baselineByStep.clear();
  state.diffPair.clear();
  state.a11yCache.clear();
  state.pwA11yCache.clear();
  await loadRun();
}

// Plain left-clicks on ?run= links (pager, history dots, expanded picker rows
// never get here — the picker isn't the app view) switch runs in place;
// modified clicks (new tab, etc.) keep native navigation.
function initRunLinks() {
  document.addEventListener("click", (e: ViewerDynamic) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = e.target.closest?.("a")?.getAttribute("href");
    if (!href?.startsWith("?run=") || !state.manifest) return;
    e.preventDefault();
    navigate(new URLSearchParams(href).get("run")!.replace(/^\/+|\/+$/g, "")); // SAFETY: The startsWith guard guarantees the run query parameter exists.
  });
  window.addEventListener("popstate", () => {
    const p = new URLSearchParams(location.search).get("run");
    if (p && state.manifest) navigate(p.replace(/^\/+|\/+$/g, ""), { push: false });
    else location.reload(); // leaving the run view (e.g. back to the picker): boot fresh
  });
}

function renderFatal(msg: ViewerDynamic) {
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
function runsTable(items: ViewerDynamic, cols: ViewerDynamic, rowsFor: ViewerDynamic, initKey: ViewerDynamic) {
  const sort = { key: initKey, dir: cols.find((c: ViewerDynamic) => c.key === initKey)?.desc ? -1 : 1 };
  const table = h("table", { class: "runs-table" });
  const cmp = (a: ViewerDynamic, b: ViewerDynamic) => {
    const va = a[sort.key], vb = b[sort.key];
    if (va == null || vb == null) return ((va == null) as unknown as number) - ((vb == null) as unknown as number); // SAFETY: JavaScript boolean subtraction deliberately orders nulls last.
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return c * sort.dir;
  };
  const draw = () => {
    table.replaceChildren(
      h("thead", {}, h("tr", {}, ...cols.map((c: ViewerDynamic) =>
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
      h("tbody", {}, ...[...items].sort(cmp).flatMap((it: ViewerDynamic) => rowsFor(it, draw))),
    );
  };
  draw();
  return h("div", { class: "table-card" }, table);
}

// whole row navigates; the case cell stays a real link for middle-click / a11y
function runRow(href: ViewerDynamic, cls: ViewerDynamic, ...cells: ViewerDynamic) {
  return h("tr", {
    class: "run-row" + (cls ? " " + cls : ""),
    onclick: (e: ViewerDynamic) => { if (!e.target.closest("a")) location.href = href; },
  }, ...cells);
}

/* One row per story (latest run), older runs expandable beneath it.
   `activeTags` (a Set) filters by tag (OR — a run matches if it has ANY active
   tag); it persists across the full re-render a toggle triggers, and rides the
   ?tags= URL param so a filtered picker is shareable and composes with the
   ?filter= / ?case= flags. `allRuns` is the unfiltered set the chip bar derives
   the tag universe + per-tag counts from, so chips don't vanish as you narrow. */
function renderPicker(runs: ViewerDynamic, filterNote: ViewerDynamic = null, activeTags: ViewerDynamic = pickerTagsFromUrl()) {
  const el = $("#picker");
  el.hidden = false;
  const allRuns = runs;
  const caseKey = (r: ViewerDynamic) => r.case_id ?? "?";
  // tag universe + counts come from the pre-tag-filter set so the bar is stable.
  // the picker lists one row per STORY, so a tag's count is the number of distinct
  // stories carrying it (dedupe by case_id), not the run total.
  const tagStories = new Map();
  for (const r of allRuns) for (const t of Array.isArray(r.tags) ? r.tags : []) {
    if (!tagStories.has(t)) tagStories.set(t, new Set());
    tagStories.get(t).add(caseKey(r));
  }
  const tagCount = (t: ViewerDynamic) => tagStories.get(t)?.size ?? 0;
  const allTags = [...tagStories.keys()].sort();
  // drop any active tag that no longer exists (stale URL), then OR-filter
  for (const t of [...activeTags]) if (!tagStories.has(t)) activeTags.delete(t);
  if (activeTags.size) runs = runs.filter((r: ViewerDynamic) => (Array.isArray(r.tags) ? r.tags : []).some((t: ViewerDynamic) => activeTags.has(t)));

  const byCase = new Map();
  for (const r of runs) {
    const k = caseKey(r);
    if (!byCase.has(k)) byCase.set(k, []);
    byCase.get(k).push(r);
  }
  // groups sort on the latest run's values; mode_label sorts by what's shown
  const groups = [...byCase.values()].map((list: ViewerDynamic) => {
    list.sort((a: ViewerDynamic, b: ViewerDynamic) => String(b.started_at).localeCompare(String(a.started_at)));
    return { ...list[0], runs: list, mode_label: modeLabel(list[0].mode, list[0].healed, list[0].status) };
  });
  const expanded = new Set();
  // story first (what you scan for), then outcome, then recency; run id last —
  // it names nothing you would search by, it's just
  // a random suffix, useful only for cross-referencing.
  const cols = [
    { key: "case_id", label: "story" },
    { key: "status", label: "status" },
    { key: "mode_label", label: "type", desc: true },
    { key: "started_at", label: "started", desc: true },
    { key: "duration_ms", label: "duration", num: true, desc: true },
    { key: "run_id", label: "run id" },
  ];
  const href = (r: ViewerDynamic) => "?run=" + encodeURIComponent(r.path ?? `${r.run_id}/${r.case_id}`);

  const cells = (r: ViewerDynamic, caseCell: ViewerDynamic) => [caseCell,
    h("td", {}, statusChip(r.status)),
    h("td", {}, modeChip(r.mode, r.healed, r.status)),
    h("td", { class: "td-date" }, fmtDate(r.started_at)),
    h("td", { class: "td-num" }, fmtMs(r.duration_ms)),
    h("td", { class: "td-id", title: r.run_id ?? "" }, shortRunId(r.run_id)),
  ];
  // The id alone stops meaning anything in a big suite: a line under the name
  // says what each story does without leaving the picker. The authored
  // description shows (it's a one-liner by contract); a case without one
  // falls back to its story prose, clamped — stories can run long — with the
  // full text on hover.
  const storyLine = (r: ViewerDynamic) => {
    const description = typeof r.description === "string" ? r.description.trim() : "";
    const story = typeof r.story === "string" ? r.story.trim() : "";
    const text = description || story;
    if (!text) return null;
    return h("div", {
      class: "case-story" + (description ? "" : " clamp"),
      title: text,
    }, text.replace(/\s+/g, " "));
  };
  const tagChips = (r: ViewerDynamic) => (Array.isArray(r.tags) ? r.tags : []).map((t: ViewerDynamic) => h("span", { class: "tag" }, t));
  const rowsFor = (g: ViewerDynamic, redraw: ViewerDynamic) => {
    const k = caseKey(g);
    const older = g.runs.length - 1;
    const open = expanded.has(k);
    const main = runRow(href(g), null, ...cells(g,
      h("td", { class: "td-case" },
        h("div", { class: "case-line" },
          h("a", { class: "case-link", href: href(g) }, k),
          ...tagChips(g),
          older > 0
            ? h("button", {
              class: "expand" + (open ? " on" : ""),
              title: (open ? "hide" : "show") + " this story's older runs",
              onclick: (e: ViewerDynamic) => {
                e.stopPropagation();
                open ? expanded.delete(k) : expanded.add(k);
                redraw();
              },
            }, `${open ? "▾" : "▸"} ${older} older`)
            : null,
        ),
        storyLine(g),
      )));
    if (!open) return [main];
    return [main, ...g.runs.slice(1).map((r: ViewerDynamic) => runRow(href(r), "sub", ...cells(r,
      h("td", { class: "td-case" }, h("a", { class: "case-link", href: href(r) }, "↳ " + (r.case_id ?? "?"))))))];
  };
  // re-render with the new tag selection, syncing it into the URL (back/forward
  // restores it; reload keeps it). a fresh Set keeps the closed-over one immutable.
  const setTags = (next: ViewerDynamic) => {
    const params = new URLSearchParams(location.search);
    next.size ? params.set("tags", [...next].join(",")) : params.delete("tags");
    const qs = params.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
    renderPicker(allRuns, filterNote, next);
  };
  // a filter bar only earns its space once tags are actually in use (>=2 distinct)
  const tagBar = allTags.length >= 2
    ? h("div", { class: "tag-filter" },
        ...allTags.map((t: ViewerDynamic) => h("button", {
          class: "tag-chip" + (activeTags.has(t) ? " on" : ""),
          "aria-pressed": activeTags.has(t) ? "true" : "false",
          onclick: () => {
            const next = new Set(activeTags);
            next.has(t) ? next.delete(t) : next.add(t);
            setTags(next);
          },
      }, t, h("span", { class: "tag-count" }, String(tagCount(t))))),
      activeTags.size
        ? h("button", { class: "tag-clear", onclick: () => setTags(new Set()) }, "clear")
        : null,
    )
  : null;
  el.replaceChildren(
    h("div", { class: "picker-inner" },
      h("div", { class: "picker-brand" }, "Playtest"),
      h("div", { class: "picker-sub" },
        `${groups.length} stor${groups.length === 1 ? "y" : "ies"} · ${runs.length} run${runs.length === 1 ? "" : "s"}${filterNote ? " · " + filterNote : ""}`),
      tagBar,
      runs.length
        ? runsTable(groups, cols, rowsFor, "started_at")
        : h("p", { class: "empty-note" }, "no runs match this filter"),
    ),
  );
}

// active tag filter from the URL (?tags=a,b) — the source of truth across reloads.
function pickerTagsFromUrl() {
  const raw = new URLSearchParams(location.search).get("tags");
  return new Set(raw ? raw.split(",").map((t: ViewerDynamic) => t.trim()).filter(Boolean) : []);
}

/* Read-only changed-journey review list (?filter=changed). Pending rows show
 * the latest changed-mode run; healed passes stay listed, dimmed, as history. */
function renderChanged(entries: ViewerDynamic) {
  const el = $("#picker");
  el.hidden = false;
  const pending = entries.filter((e: ViewerDynamic) => e.pending);
  const items = entries.map((e: ViewerDynamic) => ({ ...e, state: e.pending ? "changed" : "historical" }));
  // column order mirrors the picker: identity first, run id last
  const cols = [
    { key: "case_id", label: "case" },
    { key: "state", label: "state" },
    { key: "score", label: "score", num: true, desc: true },
    { key: "started_at", label: "started", desc: true },
    { key: "run_id", label: "run id" },
  ];
  const rowsFor = (e: ViewerDynamic) => {
    const href = "?run=" + encodeURIComponent(e.path);
    const row = runRow(href, e.pending ? null : "dim",
      h("td", { class: "td-case" }, h("a", { class: "case-link", href }, e.case_id ?? "?")),
      h("td", {}, e.pending
        ? h("span", { class: "chip accent" }, icon("i-branch"), "changed")
        : h("span", { class: "chip" }, "historical")),
      h("td", { class: "num", title: e.score === null ? "ungraded" : null }, e.score !== null ? String(e.score) : "—"),
      h("td", { class: "td-date", title: e.started_at ?? "" }, fmtDate(e.started_at)),
      h("td", { class: "td-id", title: e.run_id ?? "" }, shortRunId(e.run_id)),
    );
    if (!e.pending) return [row];
    const dir = shellQuote(e.run_dir_rel);
    return [row, h("tr", { class: "cmds-row" },
      h("td", { colspan: "5" }, h("pre", { class: "cmds" }, `playtest baseline accept ${dir}\nplaytest baseline reject ${dir}`)))];
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

/**
 * Deltas of this run vs its history. The comparability rules — pin set
 * included — and the badge thresholds live in the shared module (served at
 * /shared/movement.js, same code cli.ts uses); this maps the viewer's state
 * onto its inputs. The current run's worst LCP comes from the step envelopes,
 * like the server computes it for history entries.
 */
function computeMovement() {
  const m = state.manifest;
  const lcps = state.steps.map((s: ViewerDynamic) => s.perf?.nav?.lcp_ms).filter((v: ViewerDynamic) => typeof v === "number");
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

// Only the distilled regression/improved verdict goes in the topbar. No
// statusMove chip either: "pass → healed" duplicates the "changed" mode chip
// and "pass → fail" duplicates the fail status + regression badge.
function movementBadge() {
  const mv = state.movement;
  if (!mv?.badge) return null;
  return h("span", { class: "chip " + (mv.badge === "regression" ? "fail" : "pass") },
    icon(mv.badge === "regression" ? "i-warn" : "i-check"), mv.badge);
}

/* ---------- header ---------- */

function statusChip(status: ViewerDynamic) {
  if (status === "pass") return h("span", { class: "chip pass" }, icon("i-check"), "pass");
  if (status === "fail") return h("span", { class: "chip fail" }, icon("i-x"), "fail");
  if (status === "infra") return h("span", { class: "chip warn" }, icon("i-warn"), "infra");
  if (status === "interrupted") return h("span", { class: "chip warn" }, icon("i-warn"), "interrupted");
  if (status === "explored") return h("span", { class: "chip accent" }, icon("i-eye"), "explored");
  return h("span", { class: "chip" }, status ?? "—");
}

function renderHeader() {
  const m = state.manifest;
  $("#case-id").replaceChildren(
    m.case?.id ?? "unknown case",
    h("span", { class: "run-id" }, ` · ${m.run_id ?? ""}`),
  );

  const badges = [statusChip(m.result?.status), modeChip(m.mode, m.healed, m.result?.status)];
  const reason = m.result?.end_reason;
  if (reason && reason !== "done") badges.push(h("span", { class: "chip warn" }, reason.replace("_", " ")));
  badges.push(h("span", { class: "chip", title: "How many steps the agent took — one action (click, type, navigate, …) per step." }, `${state.steps.length} steps`));
  badges.push(h("span", { class: "chip", title: "Wall-clock time for the whole run, start to finish." }, fmtMs(m.duration_ms)));
  const conf = m.totals?.confusion_events ?? 0;
  if (conf > 0) badges.push(h("span", { class: "chip warn", title: "Confusion events — moments the agent floundered: an action failed, repeated against an unchanged page, or had no visible effect, or the agent itself flagged that it was stuck." }, icon("i-warn"), `${conf} confusion`));
  const findings = m.totals?.finding_events ?? 0;
  if (findings > 0) badges.push(h("span", { class: "chip", title: "Actor findings — structured sticky notes the agent raised about the product (kind: finding), separate from free-form thoughts." }, icon("i-warn"), `${findings} finding${findings === 1 ? "" : "s"}`));
  const move = movementBadge();
  if (move) badges.push(move);
  // The targeted environment (app.envs.<name> via --env). The default env has no
  // name — a "[DEFAULT]" chip would only confuse, so it's omitted there.
  const envName = m.env?.env_name;
  if (envName) badges.push(h("span", { class: "chip", title: m.env?.base_url ?? "" }, String(envName).toUpperCase()));
  $("#run-badges").replaceChildren(...badges);

  const t = m.totals?.tokens ?? {};
  const cost = m.totals?.cost_usd;
  const el = $("#cost-strip");
  const cachePct = t.in ? Math.round(((t.cache_read ?? 0) / t.in) * 100) : 0;
  el.replaceChildren(
    h("div", { class: "cost-label", title: "Estimated US-dollar cost of the model (LLM) API calls for this whole run. Checked/replayed runs make no model calls, so they cost about nothing." }, "run cost"),
    h("div", { class: "cost-usd" }, "$" + (cost ?? 0).toFixed(4)),
    h("div", { class: "cost-sub", title: "Total input / output tokens for the run, and the share of input served from the prompt cache (higher means cheaper)." },
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
  const idx = hist.findIndex((r: ViewerDynamic) =>
    state.runPath ? r.path === state.runPath : r.run_id === state.manifest.run_id);
  if (!state.rootMode || hist.length < 2 || idx < 0) { el.hidden = true; return; }
  const btn = (r: ViewerDynamic, glyph: ViewerDynamic, label: ViewerDynamic) => r?.path
    ? h("a", { class: "rn-btn", href: "?run=" + encodeURIComponent(r.path),
        title: `${label}: ${r.run_id} · ${fmtDate(r.started_at)}` }, glyph)
    : h("span", { class: "rn-btn off" }, glyph);
  el.hidden = false;
  el.replaceChildren(
    h("div", { class: "rn-label" }, "this story"),
    h("div", { class: "rn-row" },
      btn(hist[idx - 1], "<", "older run"),
      // space-pad the index to the total's width (mono + white-space:pre) so
      // the pager doesn't change width while stepping through runs
      h("span", { class: "rn-pos" }, `${String(idx + 1).padStart(String(hist.length).length)} / ${hist.length}`),
      btn(hist[idx + 1], ">", "newer run"),
    ),
  );
}

/* ---------- cross-run history chart (Run tab) ---------- */

const HIST_COLOR: ViewerDynamic = { pass: "var(--pass)", fail: "var(--fail)", infra: "var(--warn)", explored: "var(--accent)", interrupted: "var(--warn)" };

// A journey is a deterministic pass/fail run — the gate is the verdict and the
// grader's 0-100 score is only advisory "quality". Discovery has no gate, so
// its score IS the data product. Mode rides the manifest; runner stamps
// "explore" for discovery (see app.js:651). The per-row guard keeps a (not
// expected) mixed history honest.
const isJourney = () => state.manifest.mode !== "explore";

function renderSparkline() {
  const el = $("#sec-history");
  const note = (msg: ViewerDynamic) =>
    el.replaceChildren(sec("i-gauge", "history", null, h("div", { class: "empty-note" }, msg)));
  const hist = state.history;
  if (!hist || hist.length < 2) return note("first recorded run of this case — history will accrue here");

  // A journey leads with the pass/fail status sequence (the verdict), with the
  // grader score as a faint advisory "quality" overlay. Discovery has no gate,
  // so its score is the y-axis and the data product — rendered exactly as before.
  const journey = isJourney();

  // Every run of the case sits on the trend line. Ungraded runs (checking runs
  // have no grade.json) carry the last known score forward — drawn hollow so
  // they read as "still at 90" rather than as a grade of their own. The y-axis
  // is the quality score when ≥2 runs are graded; else duration — except a
  // journey leads with the status band, so an ungraded journey just shows pips.
  const graded = hist.filter((r: ViewerDynamic) => r.score != null);
  const useScore = graded.length >= 2;
  const yMetric = useScore ? "score" : journey ? null : "duration";
  const own = hist.map((r: ViewerDynamic) => (yMetric === "score" ? r.score : yMetric === "duration" ? r.duration_ms : null));
  const known = own.filter((v: ViewerDynamic) => v != null);
  if (!journey && !known.length) return note("not enough comparable runs to chart yet");

  const W = 300, H = 76, L = 12, R = 12, T = 18, B = 14;
  const x = (i: ViewerDynamic) => L + (i * (W - L - R)) / Math.max(1, hist.length - 1);
  const esc = (s: ViewerDynamic) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const clampX = (px: ViewerDynamic) => Math.min(Math.max(px, 16), W - 16);
  const cur = (r: ViewerDynamic) => (state.runPath ? r.path === state.runPath : r.run_id === state.manifest.run_id);
  const curIdx = hist.findIndex(cur);
  const link = (i: ViewerDynamic, r: ViewerDynamic, inner: ViewerDynamic) =>
    state.rootMode && r.path ? `<a href="?run=${encodeURIComponent(r.path)}">${inner}</a>` : inner;

  let svgBody, subtitle;
  if (journey) {
    // STATUS BAND — the headline. A prominent row of pass/fail pips along a
    // fixed top line; the highest-value signal is "did the journey stay green".
    const BAND_Y = T;
    const band = hist.map((r: ViewerDynamic, i: ViewerDynamic) => {
      const color = HIST_COLOR[r.status] ?? "var(--dim)";
      const isCur = cur(r);
      const cx = x(i).toFixed(1);
      const title = `${r.run_id} · ${r.status}` +
        (r.score != null ? ` · quality ${r.score}` : ` · ungraded`) +
        ` · ${fmtMs(r.duration_ms)} · ${relTime(r.started_at)}`;
      const pip = `<circle class="hd" cx="${cx}" cy="${BAND_Y}" r="${isCur ? 5 : 4}" fill="${color}" ${isCur ? 'stroke="var(--ink)" stroke-width="1.4"' : ""}/>`;
      const mark = `<g><circle cx="${cx}" cy="${BAND_Y}" r="9" fill="transparent"/>${pip}<title>${esc(title)}</title></g>`;
      return link(i, r, mark);
    }).join("");
    // QUALITY OVERLAY — faint backdrop trend, only when there's a score to show.
    // Carry the last known score forward; plot in the lower band so it sits
    // clearly beneath the status pips and reads as a subtle degradation line.
    let overlay = "";
    if (useScore) {
      let carry = own.find((v: ViewerDynamic) => v != null);
      const plotted = own.map((v: ViewerDynamic) => (v != null ? (carry = v) : carry));
      const min = Math.min(...known), max = Math.max(...known);
      const span = max - min;
      const QT = T + 22, QB = H - B; // overlay lives below the band
      const qy = (v: ViewerDynamic) => (span === 0 ? (QT + QB) / 2 : QB - ((v - min) / span) * (QB - QT));
      const pts = plotted.map((v: ViewerDynamic, i: ViewerDynamic) => `${x(i).toFixed(1)},${qy(v).toFixed(1)}`);
      const dots = plotted.map((v: ViewerDynamic, i: ViewerDynamic) => `<circle cx="${x(i).toFixed(1)}" cy="${qy(v).toFixed(1)}" r="${own[i] === null ? 1.5 : 2}" fill="var(--faint)"/>`).join("");
      overlay = `<polyline class="hist-overlay" points="${pts.join(" ")}" fill="none" stroke="var(--faint)" stroke-width="1"/>${dots}`;
    }
    svgBody = overlay + band;
    // the rollup both assess-stability personas hunted for: pass count up front
    const passes = hist.filter((r: ViewerDynamic) => r.status === "pass").length;
    subtitle = `${passes}/${hist.length} passed` + (useScore ? " · quality overlay" : "");
  } else {
    // DISCOVERY (and journey never reaches here): score is the y-axis.
  const firstKnown = own.find((v: ViewerDynamic) => v != null);
  let carry = firstKnown;
  const plotted = own.map((v: ViewerDynamic) => (v != null ? (carry = v) : carry));
  const min = Math.min(...known), max = Math.max(...known);
  const span = max - min;
  // a flat series sits mid-chart, not pinned to the bottom edge
  const y = (v: ViewerDynamic) => (span === 0 ? (T + H - B) / 2 : H - B - ((v - min) / span) * (H - T - B));
  const fmtVal = (v: ViewerDynamic) => (useScore ? String(Math.round(v)) : fmtMs(v));
  const pts = plotted.map((v: ViewerDynamic, i: ViewerDynamic) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const marks = hist.map((r: ViewerDynamic, i: ViewerDynamic) => {
    const ghost = own[i] === null;
    const isCur = cur(r);
    const color = HIST_COLOR[r.status] ?? "var(--dim)";
    const title = `${r.run_id} · ${r.status}` +
      (r.score != null ? ` · score ${r.score}` : useScore ? ` · ungraded (last score ${fmtVal(plotted[i])})` : "") +
      ` · ${fmtMs(r.duration_ms)} · ${relTime(r.started_at)}`;
    const cx = x(i).toFixed(1), cy = y(plotted[i]).toFixed(1);
    const shape = ghost
      ? `<circle class="hd" cx="${cx}" cy="${cy}" r="${isCur ? 4 : 3}" fill="var(--bg1)" stroke="${isCur ? "var(--ink)" : color}" stroke-width="1.4"/>`
      : `<circle class="hd" cx="${cx}" cy="${cy}" r="${isCur ? 4 : 3}" fill="${color}" ${isCur ? 'stroke="var(--ink)"' : ""}/>`;
    // invisible r=9 circle widens the hover/click target around the mark
    const mark = `<g><circle cx="${cx}" cy="${cy}" r="9" fill="transparent"/>${shape}<title>${esc(title)}</title></g>`;
    return link(i, r, mark);
  }).join("");
  // annotate the BEST real value — highest score, but lowest (fastest) duration —
  // and the current run when its real value differs
  const best = useScore ? max : min;
  const bestIdx = own.findIndex((v: ViewerDynamic) => v === best);
  const bestY = y(best) - 8 < T ? y(best) + 14 : y(best) - 8; // keep the label on-canvas
  const labels = [`<text class="hist-val" x="${clampX(x(bestIdx)).toFixed(1)}" y="${bestY.toFixed(1)}" text-anchor="middle">${fmtVal(best)}</text>`];
  const curVal = curIdx >= 0 ? own[curIdx] : null;
  if (curVal != null && curVal !== best) {
    labels.push(`<text class="hist-val cur" x="${clampX(x(curIdx)).toFixed(1)}" y="${Math.min(H - 2, y(curVal) + 14).toFixed(1)}" text-anchor="middle">${fmtVal(curVal)}</text>`);
  }
  svgBody = `<polyline points="${pts.join(" ")}" fill="none" stroke="var(--line2)" stroke-width="1.5"/>${marks}${labels.join("")}`;
  subtitle = useScore ? `${graded.length} of ${hist.length} graded · score` : `${hist.length} runs · duration`;
  }

  const chart = h("div", { class: "hist-chart" });
  chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="hist-svg">${svgBody}</svg>`;

  const hasGhosts = own.some((v: ViewerDynamic) => v === null);
  // oldest → newest framed in relative time ("3 weeks ago → today"); the
  // absolute datetimes ride the hover title. Per-dot relative age lives in each
  // mark's <title> above.
  const foot = h("div", { class: "hist-foot" },
    h("span", { title: `${fmtDate(hist[0].started_at)} → ${fmtDate(hist.at(-1).started_at)}` },
      `${relTime(hist[0].started_at)} → ${relTime(hist.at(-1).started_at)}`),
    h("span", { class: "hist-legend" },
      ...[...new Set(hist.map((r: ViewerDynamic) => r.status))].map((s: ViewerDynamic) =>
        h("span", { class: "lg" }, h("span", { class: "lg-dot", style: `background:${HIST_COLOR[s] ?? "var(--dim)"}` }), s ?? "?")),
      // a journey's pips are solid even when ungraded — the score is just a faint
      // overlay — so the "hollow = ungraded" legend only applies to discovery.
      !journey && hasGhosts
        ? h("span", { class: "lg", title: "hollow = ungraded run, shown at the last graded score" },
            h("span", { class: "lg-ghost" }), "ungraded")
        : null),
  );
  el.replaceChildren(sec("i-gauge", "history", subtitle, chart, foot));
}

/* ---------- film strip ---------- */

// Step envelopes never carry mode "heal" — the runner writes "agent" for the
// heal continuation — so a step is a heal step when the agent was driving in a
// run that healed: everything after the replayed track broke.
const isHealStep = (env: ViewerDynamic) => env.mode === "agent" && !!state.manifest?.healed;

const MAX_SETTLE_BAR = 2000; // ms that fills the little settle lane

// settle_ms always includes the settle quiet floor we deliberately wait out, so
// the raw number is dominated by that constant and tells you little about the
// app. Subtract the floor to get the real tail: how long the page kept changing
// AFTER the action before going quiet. The floor is max(dom,net): #settle exits
// only when BOTH the DOM and the network have been quiet for their windows, so
// even an instantly-quiet page waits out the longer of the two. Floor comes from
// manifest.pins.settle; old runs without it fall back to the raw value. Clamped
// at 0 (a sub-floor settle means "instantly quiet").
function settleTail(env: ViewerDynamic) {
  const raw = env.result?.settle_ms ?? 0;
  const s = state.manifest?.pins?.settle;
  if (!s || s.dom_quiet_ms === null || s.net_quiet_ms === null) return raw;
  return Math.max(0, raw - Math.max(s.dom_quiet_ms, s.net_quiet_ms));
}

function renderStrip() {
  const strip = $("#strip");
  strip.replaceChildren();
  if (!state.steps.length) {
    strip.append(h("div", { class: "empty-note", style: "padding:18px" }, "no steps recorded"));
    return;
  }
  state.steps.forEach((env: ViewerDynamic, i: ViewerDynamic) => {
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
    if (Array.isArray(env.raises) && env.raises.some((r: ViewerDynamic) => r.kind === "finding")) {
      flags.push(h("span", { class: "flag", title: "actor finding raise" }, icon("i-warn")));
    }
    if (isHealStep(env)) flags.push(h("span", { class: "flag heal", title: "healed — the agent found a new path here" }, icon("i-branch")));
    // a11y flag: this step's page carried axe-core WCAG violations (full-page
    // run — what accessibility_violations gates on). See the step's a11y panel.
    const axeTotal = env.axe?.counts?.total ?? 0;
    if (axeTotal > 0) {
      flags.push(h("span", { class: "flag a11y",
        title: `${axeTotal} WCAG violation${axeTotal === 1 ? "" : "s"} — see the step's accessibility panel` },
        icon("i-check")));
    }
    if (flags.length) thumb.append(h("div", { class: "flags" }, ...flags));

    const settle = settleTail(env);
    const tele = h("div", { class: "cell-tele", title: `still working ${fmtMs(settle)} — how long the page kept changing (network + page updates) after this step's action, beyond the settle quiet-window` },
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

  let playTimer: ViewerDynamic = null;

  function setPlaying(on: ViewerDynamic) {
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

function select(i: ViewerDynamic, { instant = false, auto = false } = {}) {
  if (!state.steps.length) return;
  if (!auto && state.playing) setPlaying(false); // manual navigation pauses the slideshow
  state.cur = Math.max(0, Math.min(i, state.steps.length - 1));
  const env = state.steps[state.cur];

  document.querySelectorAll("#strip .cell").forEach((c: ViewerDynamic) => {
    const on = Number(c.dataset.i) === state.cur;
    c.classList.toggle("on", on);
    if (on) {
      c.scrollIntoView({ block: "nearest", inline: "nearest", behavior: instant ? "auto" : "smooth" });
      // Keep DOM focus on the active cell for manual navigation (arrows/Home/End)
      // click) so a subsequent Space plays from THIS still — otherwise focus
      // lingers on a previously-clicked cell and Space fires its native click,
      // snapping selection back. Never on autoplay ticks (would steal focus).
      if (!auto && document.activeElement?.closest("#strip")) c.focus({ preventScroll: true });
    }
  });

  // A state-drift step's app changed under the recorded action — nudge the user toward
  // the Agent view (recorded-vs-now a11y diff) and the Diff tab by gently pulsing them.
  const drift = env.confusion?.type === "state_drift";
  document.querySelectorAll('.tab[data-view="a11y"], #tab-diff').forEach((t: ViewerDynamic) => t.classList.toggle("drift", drift));

  updateCaption(env);
  updateStage(env);
  renderInspectorStep(env);
}

function updateCaption(env: ViewerDynamic) {
  const meta = [h("span", { class: "cap-step" }, `step ${env.step} / ${state.steps.length}`)];
  meta.push(env.mode === "act"
    ? h("span", { class: "chip" }, `replayed · step ${env.acted_from ?? "?"}`)
    : isHealStep(env)
    ? h("span", { class: "chip accent" }, icon("i-branch"), "healed · agent took over")
    : h("span", { class: "chip" }, "agent"));
  if (env.result?.ok === false) meta.push(h("span", { class: "chip fail" }, icon("i-x"), "failed"));
  if (env.confusion) meta.push(h("span", { class: "chip warn" }, icon("i-warn"), "confusion · " + env.confusion.type.replace("_", " ")));
  if (Array.isArray(env.raises) && env.raises.length) {
    const nFind = env.raises.filter((r: ViewerDynamic) => r.kind === "finding").length;
    const nConf = env.raises.filter((r: ViewerDynamic) => r.kind === "confusion").length;
    if (nFind) meta.push(h("span", { class: "chip" }, icon("i-warn"), `raise · ${nFind} finding${nFind === 1 ? "" : "s"}`));
    if (nConf && !env.confusion) meta.push(h("span", { class: "chip warn" }, icon("i-warn"), `raise · ${nConf} confusion`));
  }
  $("#cap-meta").replaceChildren(...meta);

  const thought = $("#cap-thought");
  if (env.agent?.thought) {
    thought.textContent = env.agent.thought;
    thought.className = "cap-thought";
  } else if (env.mode === "error") {
    thought.textContent = `The actor couldn't produce a valid step here, so the run stopped. ${env.error ?? env.result?.error ?? ""}`.trim();
    thought.className = "cap-thought quiet";
  } else {
    const d = describe(env);
    // done/give_up args are full sentences: quote them instead of splicing
    // them after the verb (avoids "— done I added x.." double-period reads).
    const what =
      d.verb === "done" || d.verb === "gave up"
        ? `${d.verb === "done" ? "finished" : "gave up"}: "${String(d.arg ?? "").replace(/[.\s]+$/, "")}"`
        : `${d.verb} ${d.arg ?? ""}`.trim();
    thought.textContent = `Playing baseline trajectory against live app:\n\n${what}`;
    thought.className = "cap-thought quiet";
  }

  const vis = $("#cap-visual");
  if (env.agent?.visual) {
    vis.replaceChildren(h("b", {}, "saw"), env.agent.visual);
    vis.hidden = false;
  } else {
    vis.hidden = true;
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

  // Structured actor raises (sticky notes) — list under the caption when present.
  const raiseEl = $("#cap-raises");
  if (raiseEl) {
    if (Array.isArray(env.raises) && env.raises.length) {
      const parts = env.raises
        .filter((r: ViewerDynamic) => r?.kind && r?.note)
        .map((r: ViewerDynamic) => h("div", { class: "cap-raise" }, h("b", {}, r.kind), r.note));
      raiseEl.replaceChildren(...parts);
      raiseEl.hidden = false;
    } else {
      raiseEl.replaceChildren();
      raiseEl.hidden = true;
    }
  }
}

/* ---------- stage: stills + ghost cursor ---------- */

let ghostTimer: ViewerDynamic = null;

function updateStage(env: ViewerDynamic) {
  if (state.view === "stills") showStill(env);
  else if (state.view === "a11y") showA11y(env);
  else if (state.view === "context") showContext(env);
  else if (state.view === "video") seekVideo(env);
  else if (state.view === "diff") updateDiffStep(env);
}

function showStill(env: ViewerDynamic) {
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
function stillMissing(env: ViewerDynamic) {
  $("#shot-wrap").hidden = true;
  const el = $("#shot-missing");
  el.hidden = false;
  el.replaceChildren(icon("i-film", ""), `no frame — screenshot missing for step ${env.step}`);
}

function placeGhost(env: ViewerDynamic) {
  const ghost = $("#ghost");
  const img = $("#shot");
  const bbox = env.resolution?.bbox;
  if (!bbox || !img.naturalWidth) {
    ghost.classList.remove("show");
    return;
  }
  // bbox is in the driver's layout unit — web: CSS px (Playwright boundingBox);
  // mobile: iOS points / Android px (the same unit getWindowSize reports). The
  // still PNG is device px = layout unit x device_scale_factor. Derive the factor
  // from the known viewport width that rides pins.viewport (naturalWidth =
  // viewport.width x dsf) and scale the bbox into device px so the % matches the
  // image. This is unit-agnostic: iOS points→pixels yields the retina scale,
  // Android px→px yields 1, web CSS px→device px yields the DPR — each correct.
  // Absent viewport (old runs / a driver that couldn't report it) => dsf 1, no-op.
  const vpw = state.manifest?.pins?.viewport?.width;
  const dsf = vpw ? img.naturalWidth / vpw : 1;
  const cx = (((bbox.x + (bbox.w ?? 0) / 2) * dsf) / img.naturalWidth) * 100;
  const cy = (((bbox.y + (bbox.h ?? 0) / 2) * dsf) / img.naturalHeight) * 100;
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

async function showA11y(env: ViewerDynamic) {
  const pre = $("#a11y-pre");
  const diff = $("#a11y-diff");
  // The Custom|Playwright toggle only appears when this step has the (web-only,
  // debug) native tree on disk; without it we force the custom view.
  const pwRel = env.artifacts?.pw_a11y;
  const mode = $("#a11y-mode");
  mode.hidden = !pwRel;
  if (!pwRel && state.a11yMode === "pw") state.a11yMode = "custom";
  mode.querySelectorAll("button").forEach((b: ViewerDynamic) => b.classList.toggle("on", b.dataset.mode === state.a11yMode));
  if (state.a11yMode === "pw" && pwRel) {
    // Custom (left) vs native browser tree (right), as an eyeballable side-by-side
    // only the custom side has = something we synthesize the browser doesn't expose.
    const customRel = env.artifacts?.a11y;
    if (customRel && !state.a11yCache.has(customRel)) state.a11yCache.set(customRel, await fetchText(state.base + "/" + customRel));
    if (!state.pwA11yCache.has(pwRel)) state.pwA11yCache.set(pwRel, await fetchText(state.base + "/" + pwRel));
    if (state.steps[state.cur] !== env) return;
    showA11yNativeDiff(pre, diff, state.a11yCache.get(customRel) ?? "", state.pwA11yCache.get(pwRel) ?? "");
    return;
  }
  const rel = env.artifacts?.a11y;
  if (!rel) { showA11ySingle(pre, diff, null, env); return; }
  if (!state.a11yCache.has(rel)) state.a11yCache.set(rel, await fetchText(state.base + "/" + rel));
  // selection may have moved while fetching
  if (state.steps[state.cur] !== env) return;
  const current = state.a11yCache.get(rel);
  // Visual drift: the a11y tree was IDENTICAL but the screenshot diverged
  // (visual_regression's pixel channel). There is no a11y diff to show — the
  // signal lives in the pixels — so surface the confusion note and point at the
  // Stills tab (where the run's screenshot already renders).
  if (env.confusion?.type === "state_drift" && /visually/.test(env.confusion?.note ?? "")) {
    showVisualDriftNote(pre, diff, current, env);
    return;
  }
  // State drift: the agent saw something different on replay than the baseline
  // recorded. The baseline step the action came from (acted_from) carries the
  // recorded a11y inline (snapshot_text), so we can show what the agent saw THEN
  // vs NOW as a two-column line diff — the visual form of the drift signal.
  const baseline = env.confusion?.type === "state_drift" && env.acted_from !== null
    ? state.baselineByStep.get(env.acted_from)?.snapshot_text
    : null;
  if (typeof baseline === "string") showA11yDrift(pre, diff, baseline, current, env);
  else showA11ySingle(pre, diff, current, env);
}

function renderA11yText(pre: ViewerDynamic, text: ViewerDynamic, env: ViewerDynamic) {
  pre.replaceChildren();
  if (!text) {
    pre.append(h("span", { class: "head" }, `no snapshot text captured for step ${env.step}`));
    return;
  }
  colorizeSnapshot(pre, text);
}

/** Custom snapshot beside the browser-native accessibility tree. */
function showA11yNativeDiff(pre: ViewerDynamic, diff: ViewerDynamic, customText: ViewerDynamic, nativeText: ViewerDynamic) {
  pre.hidden = true;
  const A = String(customText ?? "").split("\n");
  const B = String(nativeText ?? "").split("\n");
  const ops = lcsDiff(A, B, A, B);
  diff.replaceChildren(
    h("div", { class: "a11y-cols" },
      h("div", { class: "diff-colhead" }, "custom snapshot"),
      h("div", { class: "diff-colhead" }, "native tree"),
      ...ops.flatMap((o: ViewerDynamic) => [
        a11yLineCell(o.a, o.op === "add" ? "empty" : o.op),
        a11yLineCell(o.b, o.op === "del" ? "empty" : o.op),
      ]),
    ),
  );
  diff.hidden = false;
}

/** Visual-only drift: a11y identical, pixels diverged. Show the note + Stills pointer. */
function showVisualDriftNote(pre: ViewerDynamic, diff: ViewerDynamic, current: ViewerDynamic, env: ViewerDynamic) {
  diff.hidden = true;
  diff.replaceChildren();
  pre.hidden = false;
  pre.replaceChildren(
    h("span", { class: "head" }, "visual drift: the a11y tree is unchanged but the screenshot diverged from the baseline — see the Stills tab"),
    "\n\n",
  );
  if (env.confusion?.note) pre.append(env.confusion.note + "\n\n");
  if (current) colorizeSnapshot(pre, current);
}

/** Normal single-panel a11y view (every step except a drift step). */
function showA11ySingle(pre: ViewerDynamic, diff: ViewerDynamic, text: ViewerDynamic, env: ViewerDynamic) {
  diff.hidden = true;
  diff.replaceChildren();
  pre.hidden = false;
  renderA11yText(pre, text, env);
}

/** Two-column line diff: baseline recording (what the agent saw) vs this run. */
function showA11yDrift(pre: ViewerDynamic, diff: ViewerDynamic, baseText: ViewerDynamic, nowText: ViewerDynamic, env: ViewerDynamic) {
  pre.hidden = true;
  const A = String(baseText).split("\n");
  const B = String(nowText ?? "").split("\n");
  const ops = lcsDiff(A, B, A, B); // signatures ARE the lines (exact-line LCS)
  diff.replaceChildren(
    h("div", { class: "a11y-cols" },
      h("div", { class: "diff-colhead" }, "baseline recording"),
      h("div", { class: "diff-colhead" }, "this run"),
      ...ops.flatMap((o: ViewerDynamic) => [
        a11yLineCell(o.a, o.op === "add" ? "empty" : o.op),
        a11yLineCell(o.b, o.op === "del" ? "empty" : o.op),
      ]),
    ),
  );
  diff.hidden = false;
}

/** One a11y line in a drift column; null line = an empty (added/removed) slot. */
function a11yLineCell(line: ViewerDynamic, op: ViewerDynamic) {
  if (line === null) return h("div", { class: "acell empty" });
  const m = line.match(/^(\[e\d+\])(.*)$/);
  const inner = m
    ? [h("span", { class: "ref" }, m[1]), m[2]]
    : line.startsWith("Page:")
    ? [h("span", { class: "head" }, line)]
    : [line];
  return h("div", { class: "acell " + op }, ...inner);
}

// Append a snapshot's text into `pre`, colorizing [eN] element refs and the
// Page: header line; everything else stays literal. Shared by the Agent-view
// pane and the Context tab's current-snapshot card.
function colorizeSnapshot(pre: ViewerDynamic, text: ViewerDynamic) {
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

/* ---------- stage: context window ---------- */

// A message's content is either a string or an array of parts (vision runs).
// Flatten to plain text; image_url parts were already elided to a placeholder
// string by the harness (sanitizeContext), so we surface that on its own line.
function ctxContentText(content: ViewerDynamic) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: ViewerDynamic) => {
      if (typeof p === "string") return p;
      if (p?.type === "image_url" || p?.image_url) return "[screenshot elided — see Stills]";
      return p?.text ?? "";
    })
    .join("\n");
}

function kb(chars: ViewerDynamic) {
  return (chars / 1024).toFixed(1) + " KB";
}

// Per-step Context tab: shows exactly what the model was sent that turn — a
// collapsed SYSTEM card (constant persona prompt) + one card per per-step
// cards are folded by default (they repeat every step); the message cards open.
// A card's open/closed state is keyed by a STABLE identity (ctxCardState) so it
// survives the full rebuild we do on every step change — otherwise a card you
// opened would snap shut the moment you moved to the next step. The key is just
// "system" / "tools" / the message label.
const ctxCardState = new Map(); // key → { open }
function ctxState(key: ViewerDynamic, dflt: ViewerDynamic) {
  if (!ctxCardState.has(key))
    ctxCardState.set(key, { ...dflt });
  return ctxCardState.get(key);
}

function showContext(env: ViewerDynamic) {
  const body = $("#ctx-body");
  body.replaceChildren();
  const ctx = state.context;
  const entry = ctx?.byStep.get(env.step) ?? null;
  const system = ctx?.system ?? null;

  const msgs = entry?.messages ?? [];
  const total = (system ? system.length : 0) + msgs.reduce((n: ViewerDynamic, m: ViewerDynamic) => n + ctxContentText(m.content).length, 0);
  const model = entry?.model ?? state.manifest?.pins?.actor_model ?? "model";
  const inTok = env.tokens?.in;
const retries = env.llm_retries ?? [];
// A validation retry re-sends the whole prompt, so the step's token figure can
// be a multiple of the prompt size shown here — surface the call count beside
// it so the number reads as spend across calls, not a corrupt context.
const callPart = retries.length ? ` · ${retries.length + 1} calls` : "";
const tokPart = inTok != null ? ` · ${fmtTokens(inTok)} tok${callPart}` : "";
body.append(h("div", { class: "ctx-head" },
  `Context · step ${env.step} · ${model} · ${kb(total)}${tokPart}`));

if (!entry) {
  body.append(h("div", { class: "placeholder" }, `no context captured for step ${env.step}`));
  return;
}

// A collapsible card whose fold state persists across steps (ctxCardState).
// The header carries the body's size in KB. `fixed` cards (SYSTEM, TOOLS) are
// the constant scaffolding hoisted out of every turn — set apart with a quiet
// tint + accent rail + a labelling icon, not a "locked" metaphor (nothing here
// is gated; the whole viewer is read-only).
const addCard = (key: ViewerDynamic, label: ViewerDynamic, text: ViewerDynamic, fill: ViewerDynamic, { open = false, fixed = false, retry = false, glyph = null }: ViewerDynamic = {}) => {
  const st = ctxState(key, { open });
  const pre = h("pre", {});
  fill(pre);
  const head = h("summary", { class: "ctx-card-h" },
    glyph ? icon(glyph) : null,
    h("span", {}, `${label} · ${kb(text.length)}`));
  const card = h("details", { class: `ctx-card${fixed ? " ctx-fixed" : ""}${retry ? " ctx-retry" : ""}` }, head, pre);
  // set the OPEN PROPERTY (not via h()'s setAttribute — a present `open`
  // attribute opens a <details> regardless of its value, so `open:false`
  // would still render open and ignore the persisted fold state).
  card.open = st.open;
  card.addEventListener("toggle", () => { st.open = card.open; });
  body.append(card);
};

// SYSTEM: the persona prompt, identical every step — folded by default.
if (system !== null) {
  addCard("system", "SYSTEM · persona prompt", system,
    (pre: ViewerDynamic) => { pre.textContent = system; }, { fixed: true, glyph: "i-persona" });
}

// TOOLS: the function tool(s) the actor could call this turn, also constant
// every step — folded by default, pretty-printed JSON.
const tools = ctx?.tools ?? null;
if (Array.isArray(tools) && tools.length) {
  const names = tools.map((t: ViewerDynamic) => t?.function?.name ?? t?.name).filter(Boolean).join(", ");
      const json = JSON.stringify(tools, null, 2);
      addCard("tools", `TOOLS · ${names || "available tools"}`, json,
        (pre: ViewerDynamic) => { pre.textContent = json; }, { fixed: true, glyph: "i-token" });
    }

    // Per-step message cards: open by default.
    for (const m of msgs) {
      const text = ctxContentText(m.content);
      const role = (m.role ?? "msg").toUpperCase();
      const isSnapshot = text.startsWith("Current page snapshot");
      const label = m.role === "user"
        ? (isSnapshot ? `${role} · current snapshot` : `${role} · steps so far`)
        : role;
      addCard(label, label, text,
        (pre: ViewerDynamic) => { if (isSnapshot) colorizeSnapshot(pre, text); else pre.textContent = text; },
        { open: true });
    }

    // RETRIED: the model's tool call failed schema validation, so this whole
    // prompt was re-sent with the error appended — real spend, hence the
    // doubled token figure above. Chronologically last, so it sits last.
    if (retries.length) {
      const text = [
        `The model's step call failed validation ${retries.length === 1 ? "once" : `${retries.length} times`}; the full prompt was re-sent each time with the error below, so this step paid for ${retries.length + 1} model calls.`,
        ...retries.map((r: ViewerDynamic, i: ViewerDynamic) => `\nAttempt ${i + 1} rejected:\n${r}`),
      ].join("\n");
      addCard("retry", `RETRIED · invalid tool call · ${retries.length + 1} calls`, text,
        (pre: ViewerDynamic) => { pre.textContent = text; }, { retry: true, glyph: "i-token" });
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
  // drop the previous run's <video>/track first so a re-run doesn't inherit it
  video.removeAttribute("src");
  video.querySelector("track")?.remove(); // don't inherit the prior run's captions
  video.load(); // release the previous run's video; fires error → videoMissing
  if (!rel) return videoMissing();
  video.src = state.base + "/" + rel;

  wireCaptionTrack(video);
}

// playtest clip leaves a video.vtt sidecar next to the webm; when present,
// surface it as a native captions track (probed like the other optional
// artifacts on the run).
async function wireCaptionTrack(video: ViewerDynamic) {
  video.querySelector("track")?.remove();
  const base = state.base;
  const text = await fetchText(base + "/video.vtt");
  if (base !== state.base) return; // switched while probing
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

// The slideshow timeline (docs/contracts/artifacts.md#run-directory): a new
// run's video.mp4 is a stills
// slideshow paced at AUTOPLAY_MS/frame, so a step's video time is NOT its
// wall-clock ts — it's its frame's start offset. Inlines the EXACT fold formula
// clip.js's slideshowFrames uses (advance t += AUTOPLAY_MS for a step WITH a
// screenshot, fold a screenshot-less step into the previous frame), so the
// viewer's marks/seek line up with the cues and the mp4 frame boundaries.
// Returns a Map<stepIndex, seconds>; only steps with their own frame appear.
function slideshowStepTimes() {
  const times = new Map();
  let t = 0;
  state.steps.forEach((env: ViewerDynamic, i: ViewerDynamic) => {
    if (env.ts === null) return;
    if (env.artifacts?.screenshot) {
      times.set(i, t / 1000);
      t += AUTOPLAY_MS;
    } else if (times.size) {
      // Fold a screenshot-less step into the previous frame — clip.js's
      // slideshowFrames grows frames[last].ms by AUTOPLAY_MS here, so the mp4
      // frame boundaries advance by the same amount. Guarded on times.size so a
      // LEADING frameless step (no previous frame yet) advances nothing.
      t += AUTOPLAY_MS;
    }
  });
  return times;
}

// New runs have video_started_at null (slideshow) yet still carry a built mp4;
// old runs scrub by wall-clock from a non-null video_started_at.
const isSlideshow = () =>
  state.manifest.video_started_at === null && state.manifest.artifacts?.video !== null;

function renderVideoMarks(duration: ViewerDynamic) {
  const vsa = state.manifest.video_started_at;
  const slideshow = isSlideshow();
  if ((!vsa && !slideshow) || !duration) return;
  const times: ViewerDynamic = slideshow ? slideshowStepTimes() : null;
  const marks = $("#vmarks");
  marks.replaceChildren();
  state.steps.forEach((env: ViewerDynamic, i: ViewerDynamic) => {
    if (env.ts === null) return;
    const t = slideshow ? times.get(i) : (env.ts - vsa) / 1000;
    if (t == null || t < 0 || t > duration) return;
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

function seekVideo(env: ViewerDynamic) {
  const video = $("#video");
  const vsa = state.manifest.video_started_at;
  const slideshow = isSlideshow();
  if (state.videoOk && (vsa || slideshow) && env.ts != null) {
    // A step's video time is its caption cue's exact START — for a slideshow
    // run that's the step's frame offset (slideshowStepTimes); for a legacy
    // webm run it's `ts - video_started_at`. Seeking to that precise boundary
    // makes the native TextTrack render BOTH the cue ending there and the cue
    // starting there (the paused-seek cue-activation edge case — two stacked
    // captions). Nudge a hair PAST the boundary so the playhead lands
    // unambiguously inside this step's own cue. SEEK_NUDGE_S << the smallest
    // step gap, so it never spills into the next cue.
    const base = slideshow
      ? slideshowStepTimes().get(state.steps.indexOf(env))
      : (env.ts - vsa) / 1000;
    if (base != null) video.currentTime = Math.max(0, base) + SEEK_NUDGE_S;
  }
  syncVmarks();
  document.querySelectorAll(".vmark").forEach((m: ViewerDynamic) => m.classList.toggle("on", Number(m.dataset.i) === state.cur));
}

/* ---------- stage: diff (standalone LCS over action signatures) ---------- */
function isExecutable(env: ViewerDynamic) {
  const t = actionOf(env)?.type;
  return env.resolution && env.result?.ok && t !== "done" && t !== "give_up";
}

function signature(env: ViewerDynamic) {
  const a = actionOf(env);
  // The action-track step signature
  // (docs/contracts/artifacts.md#trajectory-projections): type, locator/url, the typed
  // text or selected value, and the scroll/swipe direction — so a changed option
  // or direction diffs as a changed step instead of collapsing to "same". Inline
  // copy of trajectory.ts stepSignature (diffTracks) — the two must not drift.
  return (a?.type ?? "?") + "|" + (env.resolution?.locator ?? a?.url ?? "") + "|" + (a?.text ?? a?.value ?? "") + "|" + (a?.direction ?? "");
}

function lcsDiff(A: ViewerDynamic, B: ViewerDynamic, sigA: ViewerDynamic, sigB: ViewerDynamic): ViewerDynamic {
  const n = A.length, m = B.length;
  const L: ViewerDynamic = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = sigA[i] === sigB[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: ViewerDynamic = [];
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

function diffCell(env: ViewerDynamic, op: ViewerDynamic) {
  if (!env) return h("div", { class: "dcell empty" });
  const d = describe(env);
  // baseline-side envelopes aren't in state.steps — only this run's cells navigate.
  // Clicking selects the step in place; the per-step panel above follows, and the
  // film strip tracks the same selection.
  const idx = op === "del" ? -1 : state.steps.indexOf(env);
  return h(idx >= 0 ? "button" : "div", {
    class: "dcell " + op + (idx >= 0 ? " clickable" : ""),
    "data-step": idx >= 0 ? String(env.step) : null,
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
function failedReplayCell(env: ViewerDynamic) {
  const idx = state.steps.indexOf(env);
  return h("button", { class: "dcell fail-note clickable", "data-step": String(env.step), onclick: () => select(idx) },
    h("div", { class: "d-act" },
      h("span", { class: "d-num" }, String(env.step).padStart(2, "0")),
      icon("i-x"),
      h("span", {}, "replay attempt failed — agent took over")),
  );
}

/* ---------- per-step diff detail (follows the film strip selection) ---------- */

// Baseline counterpart of a step in this run: its LCS pairing when the step is
// on the executed action track, else the replayed source step (acted_from) for
// act-mode rows — the failed replay behind a heal has no track row but a clear
// counterpart, and its recorded-vs-now diff is the heal's "why".
function baselinePairOf(env: ViewerDynamic) {
  const pair = state.diffPair.get(env);
  if (pair) return pair;
  if (env.mode === "act" && env.acted_from != null) {
    return {
      op: env.result?.ok === false ? "fail" : "replay",
      base: state.baselineByStep.get(env.acted_from) ?? null,
    };
  }
  return null;
}

async function updateDiffStep(env: ViewerDynamic) {
  const box = $("#diff-step");
  if (!box) return;
  document.querySelectorAll("#diff-body .dcell[data-step]").forEach((c: ViewerDynamic) =>
    c.classList.toggle("cur", Number(c.dataset.step) === env.step));

  const pair = baselinePairOf(env);
  const base = pair?.base ?? null;
  const relLabel =
    pair?.op === "same" ? `aligned with baseline step ${base?.step}`
    : pair?.op === "add" ? "not in the baseline — the agent added this step"
    : pair?.op === "fail" ? `replay of baseline step ${env.acted_from} failed here`
    : pair?.op === "replay" ? `replayed baseline step ${env.acted_from}`
    : "not on the executed action track";

  // this run's page snapshot: agent steps carry it inline; act steps only have
  // the a11y artifact on disk (fetched through the shared cache).
  let now = env.snapshot_text ?? null;
  const rel = env.artifacts?.a11y;
  if (!now && rel) {
    if (!state.a11yCache.has(rel)) state.a11yCache.set(rel, await fetchText(state.base + "/" + rel));
    if (state.steps[state.cur] !== env) return; // selection moved while fetching
    now = state.a11yCache.get(rel);
  }
  const baseText = typeof base?.snapshot_text === "string" && base.snapshot_text ? base.snapshot_text : null;

  let content;
  if (!base) {
    content = h("div", { class: "ds-note" },
      pair?.op === "add"
        ? "No baseline counterpart to diff against — the Agent tab has this step's snapshot."
        : "No baseline counterpart to diff against.");
  } else if (!baseText) {
    content = h("div", { class: "ds-note" },
      `The baseline recording carries no page snapshot for step ${base.step}, so there is nothing to diff.`);
  } else if (!now) {
    content = h("div", { class: "ds-note" }, `No page snapshot was captured for step ${env.step}.`);
  } else {
    content = snapshotDiffCols(baseText, now, `baseline step ${base.step}`, `this run — step ${env.step}`);
  }

  box.replaceChildren(
    h("div", { class: "ds-head" },
      h("span", { class: "ds-title" }, `step ${env.step}`),
      h("span", { class: "ds-rel" }, relLabel)),
    content,
  );
}

/** Two-column page-snapshot line diff with long unchanged runs collapsed. */
function snapshotDiffCols(baseText: ViewerDynamic, nowText: ViewerDynamic, baseLabel: ViewerDynamic, nowLabel: ViewerDynamic) {
  const A = String(baseText).split("\n");
  const B = String(nowText).split("\n");
  const ops = lcsDiff(A, B, A, B);
  if (!ops.some((o: ViewerDynamic) => o.op !== "same")) {
    return h("div", { class: "ds-note" }, icon("i-check"), " the page snapshot matches the baseline recording line-for-line");
  }
  // keep a little context around each change; fold the rest so the changed
  // lines are the panel, not a needle in two full snapshots
  const CONTEXT = 2;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o: ViewerDynamic, i: ViewerDynamic) => {
    if (o.op === "same") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const rows = [];
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      let j = i;
      while (j < ops.length && !keep[j]) j++;
      rows.push(h("div", { class: "a11y-gap" }, `⋯ ${j - i} unchanged line${j - i === 1 ? "" : "s"}`));
      i = j - 1;
      continue;
    }
    const o = ops[i];
    rows.push(
      a11yLineCell(o.a, o.op === "add" ? "empty" : o.op),
      a11yLineCell(o.b, o.op === "del" ? "empty" : o.op),
    );
  }
  return h("div", { class: "ds-cols" },
    h("div", { class: "a11y-cols" },
      h("div", { class: "diff-colhead" }, baseLabel),
      h("div", { class: "diff-colhead" }, nowLabel),
      ...rows));
}

function renderDiff() {
  const tab = $("#tab-diff");
  tab.hidden = !state.baseline;
  if (!state.baseline) {
    tab.replaceChildren(icon("i-branch"), "Diff");
    $("#diff-body").replaceChildren();
    $("#sec-diff")?.replaceChildren();
    state.diffPair.clear();
    if (state.view === "diff") setView("stills"); // run switched under an open diff tab
    return;
  }

  const A = state.baseline.filter(isExecutable);
  const B = state.steps.filter(isExecutable);
  const ops = lcsDiff(A, B, A.map(signature), B.map(signature));
  // per-step panel alignment: this run's step -> its baseline counterpart on the track
  state.diffPair = new Map(ops.filter((o: ViewerDynamic) => o.b).map((o: ViewerDynamic) => [o.b, { op: o.op, base: o.a }]));
  const sum: ViewerDynamic = { same: 0, del: 0, add: 0 };
  for (const o of ops) sum[o.op]++;

  // The tab wears the change count: 2/3 judging personas in the viewer-ux study
  // never found the Diff tab and voted on a heal from thumbnails alone — the
  // one finding that changed an outcome, not just a path.
  const changes = sum.del + sum.add;
  // replaceChildren is the raw DOM API: unlike h(), it stringifies a literal
  // null into a "null" text node, so the no-changes arm must contribute nothing
  tab.replaceChildren(icon("i-branch"), "Diff",
    ...(changes ? [h("span", { class: "tab-count" }, String(changes))] : []));
  renderDiffSummary(sum, changes);

  // A removed baseline row usually has a story: this run *tried* it and the
  // replay failed (the heal point). Show that attempt in the empty cell so
  // the strip's step numbers stay accountable in the track.
  const failedReplayBy = new Map(
    state.steps
    .filter((e: ViewerDynamic) => e.mode === "act" && e.result?.ok === false && e.acted_from !== null)
      .map((e: ViewerDynamic) => [e.acted_from, e]),
  );

  const body = $("#diff-body");
  body.replaceChildren(
    h("div", { id: "diff-step" }),
    h("div", { class: "diff-head" },
      h("span", { class: "diff-title" }, "Action track vs. baseline"),
      h("span", { class: "diff-sub" },
        h("span", { class: "d-same" }, `${sum.same} same`), " · ",
        h("span", { class: "d-del" }, `${sum.del} removed`), " · ",
        h("span", { class: "d-add" }, `${sum.add} added`),
      " · executed UI actions only",
        state.manifest.baseline?.run_id ? ` · baseline ${state.manifest.baseline.run_id}` : ""),
    ),
    h("div", { class: "diff-cols" },
      h("div", { class: "diff-colhead" }, "baseline recording"),
      h("div", { class: "diff-colhead" }, "this run"),
      ...ops.flatMap((o: ViewerDynamic) => [
        diffCell(o.a, o.op === "add" ? "empty" : o.op),
        o.op === "del" && failedReplayBy.has(o.a?.step)
          ? failedReplayCell(failedReplayBy.get(o.a.step))
          : diffCell(o.b, o.op === "del" ? "empty" : o.op),
      ]),
    ),
);

// divergence frame: first changed op that has a step in this run with a screenshot
const frameEnv = ops.find((o: ViewerDynamic) => o.op !== "same" && o.b?.artifacts?.screenshot)?.b;
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
            // Embedded, the host owns accept/reject — telling a web user to run
            // a CLI command, 600px below the Accept button that does exactly
            // that, is viewer copy leaking into the hosted context.
            document.documentElement.dataset.embed === "1"
              ? h("p", { class: "dim" }, "Use Accept at the top of this page.")
              : h("pre", { class: "cmds" }, state.acceptCmd ?? "playtest baseline accept <run-dir>"),
          ])));
  }
}

/* Run-panel echo of the diff: every persona who had to judge a heal looked for
   the verdict in the run header or the right Run panel — none looked at the tab
   row first. Summary + door here; the tab still holds the full track. In the
   hosted embed the host's review queue owns accept/reject, so the CLI commands
   only render standalone. */
function renderDiffSummary(sum: ViewerDynamic, changes: ViewerDynamic) {
  const el = $("#sec-diff");
  if (!el) return;
  const embedded = document.documentElement.dataset.embed === "1";
  const pending = !!state.acceptCmd;
  el.replaceChildren(sec("i-branch", "vs baseline",
    pending ? "pending review" : null,
    h("div", { class: "vsb-line" },
      changes
        ? h("span", { class: "chip warn" }, icon("i-branch"), `${changes} changed`)
        : h("span", { class: "chip pass" }, icon("i-check"), "same actions"),
      h("span", { class: "vsb-sum" },
        changes ? `${sum.del} removed · ${sum.add} added · ${sum.same} same` : `all ${sum.same} actions match the baseline`)),
    changes ? h("button", { class: "vsb-open", onclick: () => setView("diff") }, "Open the diff →") : null,
    pending && !embedded
      ? h("pre", { class: "cmds" }, `${state.acceptCmd}\n${state.rejectCmd}`)
      : null,
  ));
}

/* ---------- inspector ---------- */

function sec(iconName: ViewerDynamic, title: ViewerDynamic, right: ViewerDynamic, ...children: ViewerDynamic) {
  return h("section", { class: "sec" },
    h("div", { class: "sec-h" }, icon(iconName), title, right ? h("span", { class: "right" }, right) : null),
    ...children);
}

// A model name shown as a header chip: uppercased, truncated to 10 chars (with
// an ellipsis) so a long fully-qualified gateway name doesn't blow out the line.
// Full name stays in the title for hover. Returns null when no model is known.
function modelChip(name: ViewerDynamic) {
  if (!name) return null;
  const up = String(name).toUpperCase();
  const text = up.length > 10 ? up.slice(0, 9) + "…" : up;
  return h("span", { class: "chip", title: String(name) }, text);
}
const actorModelLabel = () => modelChip(state.manifest?.pins?.actor_model);
const graderModelLabel = () => modelChip(state.manifest?.pins?.grader_model);

function stat(label: ViewerDynamic, value: ViewerDynamic, unit: ViewerDynamic, cls = "", title = "") {
  return h("div", { class: "stat " + cls, title },
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
      // widen the panel for reading long grade reports (esp. discovery); the
      // timeline + stage stay visible so report → step deep-links still work
      h("button", { id: "insp-wide-btn", class: "insp-wide-btn", title: "widen panel",
        "aria-label": "widen panel", "aria-pressed": String(state.inspWide),
        onclick: () => setInspWide(!state.inspWide) }, icon("i-expand")),
    ),
    h("div", { id: "ipane-step" },
      h("div", { id: "sec-step" }),
      h("div", { id: "sec-tele" }),
      h("div", { id: "sec-net" }),
      h("div", { id: "sec-axe" }),
      h("div", { id: "sec-tok" }),
    ),
    h("div", { id: "ipane-run" },
      renderEnv(),
      renderGate(),
      renderDrift(),
      h("div", { id: "sec-diff" }),
      renderGrade(),
      renderA11y(),
      h("div", { id: "sec-history" }),
    ),
  );
  setInspTab(state.itab);
  reflectInspWide();
}

function setInspTab(name: ViewerDynamic) {
  state.itab = name;
  try { sessionStorage.setItem("playtest.itab", name); } catch {}
  document.querySelectorAll(".itab").forEach((t: ViewerDynamic) => t.classList.toggle("on", t.dataset.itab === name));
  $("#ipane-step").hidden = name !== "step";
  $("#ipane-run").hidden = name !== "run";
}

function setInspWide(on: ViewerDynamic) {
  state.inspWide = on;
  try { sessionStorage.setItem("playtest.inspWide", on ? "1" : "0"); } catch {}
  $("#layout").classList.toggle("insp-wide", on);
  reflectInspWide();
  // the stills wrap is sized in explicit pixels off the pane width and only
  // recomputes on window resize -- toggling the column width fires no resize, so
  // re-fit (and re-place the ghost) once the grid transition settles, or it
  // overflows onto the inspector with its stale width.
  refitStage();
}

// re-fit the current step's stage after a layout change that doesn't fire a
// window resize (e.g. widening the inspector). Runs after the grid transition.
function refitStage() {
  if (state.view !== "stills" || !state.steps.length) return;
  const layout = $("#layout");
  let done = false;
  const fit = () => {
    if (done) return;
    done = true;
    layout.removeEventListener("transitionend", onEnd);
    sizeShotWrap();
    placeGhost(state.steps[state.cur]);
  };
  function onEnd(e: ViewerDynamic) {
    if (e.target === layout && e.propertyName === "grid-template-columns") fit();
  }
  layout.addEventListener("transitionend", onEnd);
  // fallback if the transition is interrupted or coalesced (no event fires)
  setTimeout(fit, 220);
}

/* The caption panel's twin of setInspWide: widen the brief/thought column for
   reading long briefs and step thoughts. Same persistence convention as the
   inspector prefs; refitStage's fallback timer re-fits the stills once the
   width transition lands (the caption transition fires no layout event). */
function setCapWide(on: ViewerDynamic) {
  state.capWide = on;
  try { sessionStorage.setItem("playtest.capWide", on ? "1" : "0"); } catch {}
  reflectCapWide();
  refitStage();
}

function reflectCapWide() {
  const btn = $("#cap-wide-btn");
  if (!btn) return;
  $("#caption").classList.toggle("wide", state.capWide);
  btn.replaceChildren(icon(state.capWide ? "i-collapse" : "i-expand"));
  btn.setAttribute("aria-pressed", String(state.capWide));
  btn.title = state.capWide ? "narrow panel" : "widen panel";
  btn.setAttribute("aria-label", btn.title);
}

// keep the toggle button's icon/label in sync with the current width state
function reflectInspWide() {
  const btn = $("#insp-wide-btn");
  if (!btn) return;
  btn.replaceChildren(icon(state.inspWide ? "i-collapse" : "i-expand"));
  btn.setAttribute("aria-pressed", String(state.inspWide));
  btn.title = state.inspWide ? "narrow panel" : "widen panel";
  btn.setAttribute("aria-label", btn.title);
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

function renderInspectorStep(env: ViewerDynamic) {
  const d = describe(env);
  const a = actionOf(env);
  const replayed = env.acted_from !== null || env.mode === "act";
  const failed = env.result?.ok === false;

  // What happened: the action, where it came from, whether it worked, and on
  // what element — in that order, in words rather than field names.
  const status = h("div", { class: "step-status" },
    failed
      ? h("span", { class: "chip fail" }, icon("i-x"), "failed")
      : h("span", { class: "chip pass" }, icon("i-check"), "succeeded"),
  env.result?.error ? h("div", { class: "step-err" }, env.result.error) : null);

  const kv = h("dl", { class: "kv" });
  const put = (k: ViewerDynamic, v: ViewerDynamic, cls?: ViewerDynamic) => { if (v !== null && v !== "") kv.append(h("dt", { class: cls ?? "" }, k), h("dd", { class: cls ?? "" }, v)); };
  put("element", env.resolution?.locator);
  if (a?.type === "done") put("summary", a.summary, "prose");
  if (a?.type === "give_up") put("reason", a.reason, "prose");
  if (env.confusion) put("confusion", `${env.confusion.type}${env.confusion.note ? " — " + env.confusion.note : ""}`, "err");
  if (Array.isArray(env.raises) && env.raises.length) {
    put(
      "raises",
      env.raises.filter((r: ViewerDynamic) => r?.kind && r?.note).map((r: ViewerDynamic) => `${r.kind}: ${r.note}`).join(" · "),
      "warn",
    );
  }

  const heal = isHealStep(env);
  // Right slot shows the actor model (e.g. "GPT5_4_MINI") — the mode
  // (replayed / healed / agent) is still spelled out in the step-src line below.
  // A replayed step made no model call, so it gets no model chip.
  // everything nests INSIDE sec(): siblings of the .sec element would sit
  // outside its padding and render flush against the panel edge
  $("#sec-step").replaceChildren(sec("i-film", `step ${env.step}`, replayed ? null : actorModelLabel(),
    h("div", { class: "act-line" }, icon(d.icon), h("span", { class: "verb" }, d.verb), h("span", { class: "act-arg", title: d.arg ?? "" }, d.arg ?? "")),
    replayed
      ? h("div", { class: "step-src" }, `(no model call)`)
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
  const netEntries = (env.artifacts?.har_entries ?? []).map((i: ViewerDynamic) => state.har[i]).filter(Boolean);
  const embedded = env.network?.requests ?? [];
  const useEmbedded = !netEntries.length && embedded.length > 0;
  const count = useEmbedded ? embedded.length : netEntries.length;
  const netLabel = count > MAX_WF_ROWS ? `${MAX_WF_ROWS} of ${count} req` : `${count} req`;
  $("#sec-net").replaceChildren(sec("i-net", "network", netLabel,
    useEmbedded ? renderNetRequests(embedded) : renderWaterfall(netEntries)));

  // accessibility (axe-core) — defensive: only renders when this step carried a
  // capture (web); absent on non-web / done / give_up / failed-axe / drift).
  // capture (renderStepAxe returns null otherwise).
  $("#sec-axe").replaceChildren(...[renderStepAxe(env)].filter(Boolean));

  // tokens
  $("#sec-tok").replaceChildren(renderTokens(env));
}

/* ---------- accessibility (axe-core) detail — shared by the per-step and
   run-level panels ---------- */

// Bundled axe-core's docs version, used ONLY to construct a "how to fix" link
// for OLD runs whose captures predate help_url (new runs carry the exact
// versioned URL on each violation). Tracks the axe-core dependency in
// package.json; rule ids are stable across minor versions, so a near-miss
// version still lands on the right rule page. A version-LESS Deque URL 404s.
const AXE_DOCS_VERSION = "4.12";

// The canonical Deque docs URL for a rule: the captured help_url when present
// (exact + version-correct), else one constructed from the rule id.
function axeDocsUrl(rule: ViewerDynamic) {
  if (rule?.help_url) return rule.help_url;
  return rule?.id ? `https://dequeuniversity.com/rules/axe/${AXE_DOCS_VERSION}/${rule.id}` : null;
}

// "↗ how to fix — Deque docs" external link (opens in a new tab). null when
// there's no rule id to point at.
function axeDocsLink(rule: ViewerDynamic) {
  const url = axeDocsUrl(rule);
  if (!url) return null;
  return h("a", { class: "a11y-docs", href: url, target: "_blank", rel: "noopener noreferrer" },
    icon("i-nav"), "how to fix — Deque docs");
}

// One offending element: its outer HTML (the developer's handle on WHAT to fix)
// over its CSS selector path (WHERE), and an optional deep link to the step it
// was seen on (run-level view). Either html or target may be absent on older
// captures.
function axeNodeCell(node: ViewerDynamic, { step = null } = {}) {
  const target = node.target?.length ? node.target.join(" ") : null;
  return h("div", { class: "a11y-node" },
    step != null ? h("div", { class: "a11y-node-head" }, stepLink(step)) : null,
      node.html ? h("code", { class: "a11y-html" }, node.html) : null,
    target ? h("div", { class: "a11y-target", title: target }, target) : null);
}
/* Per-step axe-core a11y capture. Returns null when no axe data is present, so
   the section simply doesn't appear. Each violation is an expandable row listing
   every offending element + the fix guidance. The full-page violation count gates
   the chip. */

function renderStepAxe(env: ViewerDynamic) {
  const axe = env.axe;
  if (!Array.isArray(axe?.violations)) return null;
  const { total = 0 } = axe.counts ?? {};
  if (!total) return sec("i-check", "accessibility", h("span", { class: "chip pass" }, "0 violations"),
    h("div", { class: "empty-note" }, "no WCAG violations on this step"));

  const rows = axe.violations.map((v: ViewerDynamic) => {
    const nodes = v.nodes ?? [];
    const head = h("summary", { class: "a11y-rule-h" },
      icon("i-warn", "ic g-warn"),
      h("span", { class: "a11y-rule-id" }, v.id),
      v.impact ? h("span", { class: "chip warn" }, v.impact) : null,
      h("span", { class: "a11y-nodecount", title: `${nodes.length} offending element${nodes.length === 1 ? "" : "s"}` }, String(nodes.length)));
    const body = h("div", { class: "a11y-rule-body" },
      v.help ? h("div", { class: "a11y-help" }, v.help) : null,
      ...nodes.map((n: ViewerDynamic) => axeNodeCell(n)),
      axeDocsLink(v));
    return h("details", { class: "a11y-rule" }, head, body);
  });
  return sec("i-check", "accessibility",
    h("span", { class: "chip warn" }, `${total} violation${total === 1 ? "" : "s"}`),
    ...rows);
}

/* Performance of the app under test, in plain language. Four cells, no
   disclosure — each metric makes sense on sight, with a tooltip for depth.
   Navigation steps show Lighthouse's heavyweights (LCP, CLS); interaction
   steps show responsiveness (INP-style) and time-to-idle. "UI blocked"
   (long tasks) is the Total Blocking Time idea. Bands follow web vitals. */
function renderPerf(env: ViewerDynamic) {
  const p = env.perf ?? {};
  const band = (v: ViewerDynamic, good: ViewerDynamic, poor: ViewerDynamic) => (v == null ? "dim" : v < good ? "" : v < poor ? "warn" : "bad");
  const cell = (label: ViewerDynamic, value: ViewerDynamic, cls: ViewerDynamic, title: ViewerDynamic) =>
    h("div", { class: "stat " + cls, title },
      h("div", { class: "v" }, value),
      h("div", { class: "k" }, label));

  const cells = p.nav
    ? [
        cell("first paint · fcp", fmtMs(p.nav.fcp_ms), band(p.nav.fcp_ms, 1800, 3000),
          "First Contentful Paint — when the new page first showed any content (text/image). The earliest sign the load is working (good < 1.8s)."),
        cell("page load · lcp", fmtMs(p.nav.lcp_ms), band(p.nav.lcp_ms, 2500, 4000),
          "Largest Contentful Paint — when the new page showed its main content. Lighthouse's headline load metric (good < 2.5s)."
        ),
        cell("layout shift · cls", p.nav.cls == null ? "—" : Number(p.nav.cls).toFixed(2), band(p.nav.cls, 0.1, 0.25),
          "Cumulative Layout Shift — how much the page jumped around while loading (good < 0.1)."),
      ]
    : [
        cell("reacted in", fmtMs(p.input_to_paint_ms), band(p.input_to_paint_ms, 100, 300),
          "How long before the app visibly reacted to the click or keystroke — anything on screen changing (good < 100ms)."),
        cell("still working for", fmtMs(settleTail(env)), "",
          "How long the page kept changing after this action before going quiet — network and content settling — measured beyond the settle quiet-window, so it reflects the app, not the harness's wait."),
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
    h("div", { class: "stat-grid two" }, ...cells),
    // The "js errors" cell above is a count; expand it to the actual messages
    // captured this step (web only; absent on a clean step or legacy trajectory).
    consoleErrorList(env.console_errors));
}

const MAX_WF_ROWS = 24;

function renderWaterfall(entries: ViewerDynamic) {
  if (!entries.length) return h("div", { class: "empty-note" }, "no requests in this step's window");

  const starts = entries.map((e: ViewerDynamic) => Date.parse(e.startedDateTime) || 0);
  const t0 = Math.min(...starts);
  const total = Math.max(1, ...entries.map((e: ViewerDynamic, i: ViewerDynamic) => starts[i] - t0 + Math.max(0, e.time ?? 0)));

  const rows = entries.slice(0, MAX_WF_ROWS).map((e: ViewerDynamic, i: ViewerDynamic) => {
    const status = e.response?.status ?? 0;
    // A request that received a response status was answered by the server; a
    // late request failed (e.g. an aborted streamed body after a 200) must not
    // paint a successful call red. Only a request that never got any status is
    // truly "failed".
    const failed = !!e._failed && status === 0;
    const pending = !failed && status === 0 && (e.time ?? -1) < 0; // never finished within the run
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
          status > 0 ? String(status) : failed ? "× failed" : pending ? "… pending" : "?"),
        h("span", { class: "wf-url", title: e.request?.url ?? "" }, "<200e>" + path),
        h("span", { class: "wf-time" }, `${fmtBytes(e.response?.bodySize)} · ${pending ? "—" : fmtMs(Math.max(0, e.time ?? 0))}`)),
      h("div", { class: "wf-lane" },
        h("div", { class: "wf-bar" + (bad ? " bad" : pending ? " pending" : slow ? " slow" : ""), style: `left:${left}%;width:${width}%` })));
  });
  return h("div", { class: "wf" }, ...rows);
}

// Compact list for embedded network.requests (stable fields only — no
// timings/sizes by design, so no waterfall lane): method, status, path, mime.
function renderNetRequests(requests: ViewerDynamic) {
  const rows = requests.slice(0, MAX_WF_ROWS).map((r: ViewerDynamic) => {
    const status = r.status ?? 0;
    const bad = status >= 400 || (r.failed && status === 0);
    return h("div", { class: "wf-row" },
      h("div", { class: "wf-top" },
        h("span", { class: "wf-method" }, r.method ?? "GET"),
        h("span", { class: "wf-status" + (bad ? " bad" : "") },
          status > 0 ? String(status) : r.failed ? "× failed" : "… pending"),
          h("span", { class: "wf-url", title: r.url ?? "" }, "<200e>" + (r.path ?? r.url ?? "?")),
        h("span", { class: "wf-time" }, r.mime_type || "—")));
  });
  return h("div", { class: "wf" }, ...rows);
}

// what this step cost in model tokens ("tokens" alone read as jargon)
  function renderTokens(env: ViewerDynamic) {
    if (!env.tokens) {
      return sec("i-token", "model usage", null,
        h("div", { class: "empty-note" }, env.mode === "act" ? "replayed step — no model call" : "no model usage recorded"));
    }
    // cumulative through the current step
    const upto = state.steps.slice(0, state.cur + 1).reduce((acc: ViewerDynamic, s: ViewerDynamic) => {
      if (s.tokens) { acc.in += s.tokens.in ?? 0; acc.out += s.tokens.out ?? 0; acc.cache += s.tokens.cache_read ?? 0; }
      return acc;
    }, { in: 0, out: 0, cache: 0 });
    return sec("i-token", "model usage", `Σ ${fmtTokens(upto.in)} in / ${fmtTokens(upto.out)} out`,
      h("div", { class: "stat-grid" },
          stat("tokens in", fmtTokens(env.tokens.in), null, "",
            "Text sent to the model this step — the instructions, the running log of prior steps, and the current page snapshot. Billed per input token."),
          stat("tokens out", fmtTokens(env.tokens.out), null, "",
            "Text the model wrote this step — its thought, the action it chose, and what it expected to happen. Billed per output token."),
          stat("cache read", fmtTokens(env.tokens.cache_read), null, "")));
}

// Run-level "environment" section: what surface this run targeted — the named
// --env overlay (omitted for the default), the base URL, and any cookies seeded
// before the first navigation. Cookie VALUES can be session secrets, so only
// names are shown; the full name=value rides the hover title.
function renderEnv() {
  const e = state.manifest.env ?? {};
  const right = e.env_name ? modelChip(e.env_name) : null; // reuse the truncating chip helper
  const kv = h("dl", { class: "kv" });
  const put = (k: ViewerDynamic, v: ViewerDynamic) => { if (v !== null && v !== "") kv.append(h("dt", {}, k), h("dd", {}, v)); };
  if (e.env_name) put("env", String(e.env_name));
  if (e.base_url) kv.append(h("dt", {}, "url"),
    h("dd", {}, h("a", { href: e.base_url, target: "_blank", rel: "noopener noreferrer" }, e.base_url)));
  put("driver", e.driver);
  const cookies = e.cookies && typeof e.cookies === "object" ? Object.entries(e.cookies) : [];
  if (cookies.length) {
    kv.append(h("dt", {}, "cookies"),
      h("dd", {}, ...cookies.map(([name, val]) =>
        h("span", { class: "chip", title: `${name}=${val}` }, name))));
  }
  // before_each hook (docs/contracts/engine.md#environment-and-setup):
  // additive line, only when a hook ran this run. The
  // returned setup context is never persisted (may be a secret) — we only show
  // WHETHER one was provided, plus how long the seed took.
  const setup = state.manifest.setup;
  if (setup?.ran) {
    const ms = typeof setup.duration_ms === "number" ? ` (${setup.duration_ms} ms)` : "";
    put("setup", setup.returned_context ? `ran, context provided${ms}` : `ran${ms}`);
  }
  return sec("i-net", "environment", right, kv);
}

// One gate row. `advisory` rows come from the manifest's separate observe-only
// array: they carry the same shape but never affect pass/fail, so they render
// muted and never as a red X.
function gateRow(c: ViewerDynamic, { advisory = false } = {}) {
  // A failed SOFT check (console_errors / perf) failed the run but didn't
  // block the baseline — render it as a warning, not a hard fail.
  const softFail = !c.pass && c.severity === "soft";
  // Applicability is a first-class outcome for invariant policies: a policy the
  // story never exercised is not a failure to debug, it is a gap in the story.
  // Absent on legacy runs, which means "applicable".
  const notExercised = c.applicable === false;
  const tone = advisory ? "g-warn" : notExercised ? "g-warn" : c.pass ? "g-pass" : softFail ? "g-warn" : "g-fail";
  const glyph = notExercised ? "i-warn" : c.pass ? "i-check" : "i-x";
  return h("div", { class: "gate-row" },
    icon(glyph, "ic " + tone),
    h("div", {},
      h("div", { class: "gate-spec" }, c.spec ?? c.kind,
        // assert checks show the grader model that judged it.
        c.kind === "assert" ? graderModelLabel() : null,
        advisory ? h("span", { class: "chip", title: "Advisory: declared under observe:, so it is reported but never gates." }, "advisory") : null,
        notExercised ? h("span", { class: "chip", title: "The story never performed the operations this policy needs, so the invariant was never exercised." }, "not exercised") : null,
        c.inherited ? h("span", { class: "chip accent", title: "Checked replay: the trajectory was unchanged, so this verdict was reused from the baseline (no fresh model call)." }, "checked") : null),
      c.detail ? h("div", { class: "gate-detail" }, c.detail) : null,
      // An invariant violation is step-linked: the steps whose actions produced
      // the offending requests. This is what makes an API-layer failure
      // reviewable on the web driver — the policy names the request, the link
      // says which click caused it. Absent when no step owns the request (the
      // initial page load) or the check is not an invariant policy.
      c.steps?.length
        ? h("div", { class: "gate-steps" },
            h("span", { class: "gate-steps-label", title: "The step whose action produced the offending request." },
              c.steps.length === 1 ? "produced by" : "produced by steps"),
            ...c.steps.map((n: ViewerDynamic) => stepLink(n)))
        : null,
      // a failed console_errors check carries the captured messages — show them
      // folded so the count line stays scannable but the detail is one click away.
      c.errors?.length ? consoleErrorList(c.errors) : null));
}

function renderGate() {
  const gate = state.manifest.result?.gate;
  if (!gate) return sec("i-check", "gate", null, h("div", { class: "empty-note" }, "no gate result in manifest"));
  const rows = (gate.checks ?? []).map((c: ViewerDynamic) => gateRow(c));
  const advisory = gate.advisory ?? [];
  return sec("i-check", "gate", null,
    h("div", { style: "margin-bottom:8px" }, gate.pass
      ? h("span", { class: "chip pass" }, icon("i-check"), "gate pass")
      : h("span", { class: "chip fail" }, icon("i-x"), "gate fail")),
    ...rows,
    ...(advisory.length
      ? [h("div", { class: "gate-subhead", title: "Policies declared under observe:. Reported for information; they never decide pass or fail." }, "advisory"),
         ...advisory.map((c: ViewerDynamic) => gateRow(c, { advisory: true }))]
      : []));
}

// The heal's structured drift report (docs/contracts/artifacts.md#drift-report).
// Everything above the narrative is harness-computed; the narrative is the only
// model-authored part and is labelled as such, because a reviewer deciding
// whether to accept a changed journey needs to know which is which.
const DRIFT_LABEL: ViewerDynamic = {
  regression: "regression — the goal is no longer reachable",
  contract_drift: "contract drift — the surface changed",
  baseline_drift: "baseline drift — the environment moved",
};

function renderDrift() {
  const d = state.drift;
  if (!d) return null;
  const accepted = d.healed_run?.accepted;
  const chip = accepted
    ? h("span", { class: "chip pass" }, icon("i-check"), "heal accepted")
    : h("span", { class: "chip fail" }, icon("i-x"), "heal not accepted");
  const kv = h("div", { class: "kv" });
  const put = (k: ViewerDynamic, v: ViewerDynamic) => kv.append(h("div", { class: "k" }, k), h("div", { class: "v" }, v));
  put("classification", DRIFT_LABEL[d.classification] ?? String(d.classification ?? "?"));
  if (d.failed_step?.baseline_step != null) {
    put("diverged at", `baseline step ${d.failed_step.baseline_step}${d.failed_step.action ? ` — ${d.failed_step.action}` : ""}`);
  }
  if (d.failed_step?.expected_status != null || d.failed_step?.observed_status != null) {
    put("status", `${d.failed_step.expected_status ?? "?"} → ${d.failed_step.observed_status ?? "?"}`);
  }
  put("ended", d.healed_run?.end_reason ?? "?");
  if (!accepted && d.healed_run?.rejected_reason) put("refused because", d.healed_run.rejected_reason);
  const signals = (d.signals ?? []).map((s: ViewerDynamic) =>
    h("div", { class: "gate-row" }, icon("i-warn", "ic g-warn"), h("div", {}, h("div", { class: "gate-spec" }, s.kind), h("div", { class: "gate-detail" }, s.detail))));
  const narrative = d.narrative
    ? [
        h("div", { class: "gate-subhead", title: "Written by the grader model. Advisory prose only — it has no authority over the classification, the gate, the status, or the exit code." },
          `narrative${d.narrated_by ? ` · ${d.narrated_by}` : ""}`),
        ...[["what changed", d.narrative.what_changed], ["why the heal is valid", d.narrative.why_valid], ["what it breaks", d.narrative.consumer_impact]]
          .filter(([, v]) => v)
          .map(([k, v]) => h("div", {}, h("div", { class: "gate-spec" }, k), h("div", { class: "grade-summary" }, prose(v)))),
      ]
    : [];
  return sec("i-branch", "drift report", null, h("div", { style: "margin-bottom:8px" }, chip), kv, ...signals, ...narrative);
}

// A folded <details> listing captured console/page errors ({type,text}[]) — the
// gate row's run-total and the per-step perf panel both use it. Folded by default
// so it never crowds the panel; each line is the error type + its message
// (createTextNode keeps app-controlled text XSS-safe). Empty/absent → caller
// renders nothing (defensive; legacy runs carry no errors field).
function consoleErrorList(errors: ViewerDynamic) {
  if (!errors?.length) return null;
  return h("details", { class: "err-disclosure" },
    h("summary", {}, `show ${errors.length} error${errors.length === 1 ? "" : "s"}`),
    h("div", { class: "err-list" },
      ...errors.map((e: ViewerDynamic) => h("div", { class: "err-item" },
        h("span", { class: "err-kind" }, e.type === "pageerror" ? "page" : "console"),
        h("span", { class: "err-text" }, e.text ?? "")))));
}

// Grader prose normally carries real newlines, which `.grade-summary` /
// `.gate-detail` render via white-space:pre-wrap. But the model intermittently
// double-escapes them, so the field arrives with literal backslash-n (and the
// viewer paints "\n\n" verbatim). Un-escape those so pre-wrap can break them.
function prose(s: ViewerDynamic) {
  return typeof s === "string" ? s.replace(/\\r\\n|\\r|\\n/g, "\n").replace(/\\t/g, "\t") : s;
}

// deep-link button into the step timeline (grade findings + report evidence)
function stepLink(n: ViewerDynamic) {
  return h("button", { class: "f-step", onclick: () => {
    const i = state.steps.findIndex((s: ViewerDynamic) => s.step === n);
    if (i >= 0) select(i);
  } }, `→ step ${n}`);
}

function renderGrade() {
  // A checked run has no grade of its own; fall back to the quality carried from
  // the last graded run (loadRun), rendered identically but flagged as inherited.
  const inherited = !state.grade && state.inheritedGrade ? state.inheritedGrade : null;
  const g = state.grade ?? inherited?.grade ?? null;
  if (!g) return sec("i-gauge", "grade", null, h("div", { class: "empty-note" }, "not graded — grade.json absent"));
  const sevCls: ViewerDynamic = { major: "fail", minor: "warn", info: "" };
  const sevRank: ViewerDynamic = { major: 0, minor: 1, info: 2 };
  const findings = (g.findings ?? [])
    .map((f: ViewerDynamic, i: ViewerDynamic) => [f, i])
    .sort(([a, ai]: ViewerDynamic, [b, bi]: ViewerDynamic) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3) || ai - bi)
    .map(([f]: ViewerDynamic) =>
      h("div", { class: "finding" },
        h("span", { class: "chip " + (sevCls[f.severity] ?? "") }, f.severity),
        h("p", {}, prose(f.note) + " ", f.step !== null ? stepLink(f.step) : null)));
  // Typed bug candidates (grade.json `bug_candidates`) — grounded claims the app
  // malfunctioned, kept distinct from free-form UX findings. These are POTENTIAL
  // defects for review, not durable platform findings: the grader assigns no
  // cross-run identity. Absent on old grades and journey grades — `?? []` renders
  // nothing then, so legacy grade.json is unchanged.
  const candKindCls: ViewerDynamic = { major: "fail", minor: "warn", info: "" };
  const candidates = (g.bug_candidates ?? [])
    .map((c: ViewerDynamic, i: ViewerDynamic) => [c, i])
    .sort(([a, ai]: ViewerDynamic, [b, bi]: ViewerDynamic) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3) || ai - bi)
    .map(([c]: ViewerDynamic) =>
      h("div", { class: "candidate" },
        h("div", { class: "cand-head" },
          h("span", { class: "chip cand-kind" }, c.kind),
          h("span", { class: "chip " + (candKindCls[c.severity] ?? "") }, c.severity),
          h("span", { class: "cand-title" }, c.title ?? "")),
        c.expected != null ? h("p", { class: "cand-line" }, h("b", {}, "expected "), prose(c.expected)) : null,
        c.observed != null ? h("p", { class: "cand-line" }, h("b", {}, "observed "), prose(c.observed)) : null,
        h("div", { class: "cand-steps" }, ...(c.evidence_steps ?? []).flatMap((n: ViewerDynamic) => [" ", stepLink(n)]))));
  // discovery report answers (grade.json `report`) — the study's data product
  const report = (g.report ?? []).map((r: ViewerDynamic, i: ViewerDynamic) =>
    h("div", { class: "report-entry" },
      h("div", { class: "report-q" }, `${i + 1}. ${r.question}`),
      h("p", { class: "report-a" }, prose(r.answer),
        ...(r.evidence_steps ?? []).flatMap((n: ViewerDynamic) => [" ", stepLink(n)]))));
  // For a journey the score is advisory "quality", not the verdict (the gate is)
  // — demote it to a small chip beside completion and relabel the section. For
  // discovery the score IS the data product, so it stays the 32px headline.
  const journey = isJourney();
  const score = String(Math.round(g.score));
  const scoreEl = journey
    ? h("span", { class: "quality-wrap", tabindex: "0" },
      h("span", { class: "chip quality" },
        h("span", { class: "q-label" }, "quality"),
        h("span", { class: "q-num" }, score)),
      h("div", { class: "quality-tip", role: "tooltip" },
        h("p", {}, "An advisory measure of how smoothly the app let the user reach the goal — fewer detours, errors, and wasted steps score higher."),
        h("p", {}, "It reflects the journey experience, not the regression result. Pass/fail is decided by the gate above."),
          h("div", { class: "q-bands" },
          h("div", {}, h("b", {}, "90-100"), " smooth"),
          h("div", {}, h("b", {}, "70-89"), " minor friction"),
          h("div", {}, h("b", {}, "40-69"), " notable friction or partial"),
          h("div", {}, h("b", {}, "0-39"), " broken"))))
    : h("div", { class: "grade-score" }, score, h("small", {}, " / 100"));
  return sec("i-gauge", journey ? "journey quality" : "grade", g.model ?? null,
    h("div", { class: "grade-top" },
      journey ? null : scoreEl,
      h("div", {},
        journey ? h("div", { style: "margin-bottom:4px" }, scoreEl) : null,
        h("div", { style: "margin-bottom:4px" }, h("span", { class: "chip " + (g.completion === "full" ? "pass" : g.completion === "none" ? "fail" : "warn") }, "completion · " + g.completion)),
        g.efficiency?.wasted_steps != null ? h("div", { class: "empty-note" }, `${g.efficiency.wasted_steps} wasted step${g.efficiency.wasted_steps === 1 ? "" : "s"}`) : null)),
      inherited
        ? h("div", { class: "grade-inherited", title: "This run was a checked replay (no model call), so it has no grade of its own. Showing the journey quality from the last graded run." },
          icon("i-branch"),
          h("span", {}, "carried over from the last graded run", inherited.from?.started_at ? " · " + fmtDate(inherited.from.started_at) : ""))
        : null,
      g.efficiency?.assessment ? h("div", { class: "gate-detail", style: "margin-bottom:6px" }, prose(g.efficiency.assessment)) : null,
      ...(candidates.length
        ? [h("div", { class: "label label-cand", style: "margin-top:10px", title: "Grounded claims the app malfunctioned — potential defects for review, not durable platform findings." },
            `potential defect${candidates.length === 1 ? "" : "s"}`), ...candidates]
        : []),
      ...(report.length ? [h("div", { class: "label", style: "margin-top:10px" }, "report"), ...report] : []),
      ...findings,
      g.summary ? h("p", { class: "grade-summary" }, prose(g.summary)) : null);
}

/* Aggregate this run's axe captures into per-rule element detail, keyed by rule
   id. The run-level summary counts come from grade.a11y (the harness compliance
   number), but the offending ELEMENTS live only on the step envelopes — gather
   them here so the run panel can expand each rule to its concrete elements and
   deep-link to the steps they appeared on. Elements are deduped by selector
   path (or html when no target), remembering every step each was seen on.
   Returns Map<id, {...}>. */
function axeDetailByRule() {
  const byRule = new Map();
  for (const env of state.steps) {
    const violations = env.axe?.violations;
    if (!Array.isArray(violations)) continue;
    for (const v of violations) {
      let rule = byRule.get(v.id);
      if (!rule) {
        rule = { id: v.id, impact: v.impact ?? null, help: null, help_url: null, elements: new Map() };
        byRule.set(v.id, rule);
      }
      // first non-null help/impact wins (identical across a rule's firings)
      if (rule.help === null && v.help) rule.help = v.help;
      if (rule.help_url === null && v.help_url) rule.help_url = v.help_url;
      if (rule.impact === null && v.impact) rule.impact = v.impact;
      for (const n of v.nodes ?? []) {
      const target = n.target?.length ? n.target.join(" ") : null;
      const key = target ?? n.html ?? Math.random().toString(36); // keyless nodes never merge
        let el = rule.elements.get(key);
        if (!el) {
          el = { target, html: n.html ?? null, steps: new Set() };
          rule.elements.set(key, el);
        }
      if (env.step != null) el.steps.add(env.step);
      }
    }
  }
  return byRule;
}

// A run-level rule row: expandable to its offending elements, each deep-linking
// to the step(s) it was seen on, with fix guidance + the docs link. `rule` is a
// grade.a11y.top_rules entry (authoritative id/count/impact); `detail` is the
// aggregated element data from axeDetailByRule (may be undefined for an
// inherited grade whose rule this run didn't reproduce — then just the count).
function a11yRuleRow(rule: ViewerDynamic, detail: ViewerDynamic) {
  const head = h("summary", { class: "a11y-rule-h" },
    icon("i-warn", "ic g-warn"),
    h("span", { class: "a11y-rule-id" }, rule.id),
    rule.impact ? h("span", { class: "chip warn" }, rule.impact) : null,
    h("span", { class: "a11y-nodecount", title: "violation nodes across the run" }, `${rule.count}`));
  // elements sorted by earliest step
  const els = detail ? [...detail.elements.values()] : [];
  els.sort((a, b) => Math.min(...a.steps, Infinity) - Math.min(...b.steps, Infinity));
  const body = h("div", { class: "a11y-rule-body" },
    detail?.help ? h("div", { class: "a11y-help" }, detail.help) : null,
    els.length
      ? els.map((e: ViewerDynamic) => h("div", { class: "a11y-node" },
          h("div", { class: "a11y-node-head" },
            ...[...e.steps].sort((x, y) => x - y).map((s: ViewerDynamic) => stepLink(s))),
          e.html ? h("code", { class: "a11y-html" }, e.html) : null,
          e.target ? h("div", { class: "a11y-target", title: e.target }, e.target) : null))
      : h("div", { class: "empty-note" }, "no element detail captured for this run"),
    axeDocsLink(detail ?? rule));
  return h("details", { class: "a11y-rule" }, head, body);
}

/* Run-level accessibility summary — the harness-computed axe-core counts spread
   onto grade.json (grade.a11y), the high-value byproduct of the same capture the
   compliance gate uses. The headline counts are grade.a11y's (the compliance
   number); each top rule expands to the concrete offending elements gathered
   from this run's step envelopes (axeDetailByRule), with step deep-links + fix
   guidance. Defensive: returns null when no a11y data is present (non-web run,
   or grade.json absent / pre-v6. */
function renderA11y() {
  const g = state.grade ?? (state.inheritedGrade?.grade ?? null);
  const a = g?.a11y;
  if (!a) return null;
  const right = h("span", { class: "chip " + (a.total_violations ? "warn" : "pass") },
    `${a.total_violations} violation${a.total_violations === 1 ? "" : "s"}`);
  const grid = h("div", { class: "stat-grid two" },
    stat("total violations", String(a.total_violations), "", a.total_violations ? "warn" : "dim",
      "Total WCAG 2.0 A/AA + 2.1 AA violation nodes across the run (full-page axe runs) — what accessibility_violations gates on."
    ),
    stat("steps affected", String(a.steps_with_violations), "", a.steps_with_violations ? "warn" : "dim",
      "How many steps had at least one violation."));
  const detail = axeDetailByRule();
  const rules = (a.top_rules ?? []).length
    ? h("div", {},
        h("div", { class: "label", style: "margin-top:8px" }, "top rules"),
        ...a.top_rules.map((r: ViewerDynamic) => a11yRuleRow(r, detail.get(r.id))))
    : null;
  return sec("i-check", "accessibility", right, grid, rules);
}

/* The brief sits at the TOP of the left panel, above the step thought: the
   user's goal is the first thing to read, the instant context for everything
   the agent then does. It stays put while the per-step thought scrolls below. */
function renderBrief() {
  const c = state.manifest.case ?? {};
  // YAML block scalars arrive hard-wrapped: collapse single newlines to spaces
  // (blank lines stay paragraph breaks) so the story reads as prose.
  const story = (c.story ?? "").trim().replace(/([^\n])\n(?!\n)/g, "$1 ");
  // The story can be long; clamp it so it never crowds out the per-step thought
    // below. A "show more" toggle (only attached once the clamp actually elides
    // anything) lets the reader expand it in place. Persona/tags stay visible.
    const storyEl = h("p", { class: "brief-story clamped" }, story);
    const toggle = h("button", { class: "brief-more", hidden: "", onclick: () => {
      const on = storyEl.classList.toggle("clamped");
      toggle.textContent = on ? "show more" : "show less";
    } }, "show more");
    // the whole brief collapses to just its header so the reader can focus on the
    // per-step thought below. State survives run switches via sessionStorage,
    // matching the inspector-tab / inspector-width prefs.
    const brief = $("#cap-brief");
    let collapsed = false;
    try { collapsed = sessionStorage.getItem("playtest.briefCollapsed") === "1"; } catch {}
    const head = h("button", { class: "label brief-toggle", "aria-expanded": String(!collapsed),
      onclick: () => {
        const on = brief.classList.toggle("collapsed");
        head.setAttribute("aria-expanded", String(!on));
        try { sessionStorage.setItem("playtest.briefCollapsed", on ? "1" : "0"); } catch {}
      } }, h("span", { class: "brief-chevron" }, "▾"), "the brief");
    brief.classList.toggle("collapsed", collapsed);
  // replaceChildren stringifies null to a literal "null" text node (unlike h())
  brief.replaceChildren(...[
    head,
    storyEl,
    toggle,
    c.persona
      ? h("div", { class: "brief-persona" + (c.persona_description ? " has-tip" : "") },
          h("span", { class: "bp-name", tabindex: c.persona_description ? "0" : null },
            icon("i-persona"), c.persona),
          // The full resolved persona text (the actor's actual brief) is long, so
          // it lives in a hover/focus popup rather than crowding the panel. The
          // source is authored with hard line wraps for editing; reflow them
          // (collapse single newlines to spaces) so only blank-line paragraph
          // breaks survive and the popup wraps to its own width.
          c.persona_description
            ? h("div", { class: "persona-tip", role: "tooltip" }, reflow(c.persona_description))
            : null)
      : null,
    (c.tags ?? []).length
      ? h("div", { class: "nav-vitals" }, ...(c.tags ?? []).map((t: ViewerDynamic) => h("span", { class: "chip" }, "#" + t)))
      : null,
  ].filter(Boolean));
  // toggle if the clamp actually hides something (scrollHeight
  // exceeds clientHeight after toggle.hidden = false)
  if (storyEl.scrollHeight > storyEl.clientHeight + 1) toggle.hidden = false;
}

/* ---------- tabs + keys ---------- */

function setView(view: ViewerDynamic) {
  if (view === "diff" && $("#tab-diff").hidden) return;
  if (view === "context" && $("#tab-context").hidden) return;
  state.view = view;
  // stills autoplay belongs to the step-following views; video plays itself,
  // so the control hides (and stops) there
  const canPlay = view === "stills" || view === "a11y" || view === "context" || view === "diff";
  $("#play").hidden = !canPlay;
  if (!canPlay) setPlaying(false);
  document.querySelectorAll(".tab").forEach((t: ViewerDynamic) => t.classList.toggle("on", t.dataset.view === view));
  $("#pane-stills").hidden = view !== "stills";
  $("#pane-a11y").hidden = view !== "a11y";
  $("#pane-context").hidden = view !== "context";
  $("#pane-video").hidden = view !== "video";
  $("#pane-diff").hidden = view !== "diff";
  if (state.steps.length) updateStage(state.steps[state.cur]);
}

function initTabs() {
  // blur after switching so focus doesn't linger on the tab — otherwise space
  // would activate the focused tab button instead of toggling stills autoplay
  document.querySelectorAll(".tab").forEach((t: ViewerDynamic) => t.addEventListener("click", () => { setView(t.dataset.view); t.blur(); }));
  initA11yMode();
}

// Agent-view Custom|Playwright toggle: flips state.a11yMode and re-renders the
// current step's a11y pane (the toggle itself only shows when a pw_a11y artifact
// exists — see showA11y).
function initA11yMode() {
  document.querySelectorAll("#a11y-mode button").forEach((b: ViewerDynamic) => {
    b.addEventListener("click", () => {
      state.a11yMode = b.dataset.mode;
      document.querySelectorAll("#a11y-mode button").forEach((x: ViewerDynamic) => x.classList.toggle("on", x === b));
      if (state.steps.length) showA11y(state.steps[state.cur]);
    });
  });
}

function initKeys() {
  document.addEventListener("keydown", (e: ViewerDynamic) => {
    if (e.target.tagName === "VIDEO" || e.metaKey || e.ctrlKey || e.altKey) return;
    // Keyboard nav scrolls instantly: smooth-scrolling animates across the whole
    // strip on a Home/End jump (and lags rapid arrow presses), which reads as slow.
    if (e.key === "ArrowLeft") { select(state.cur - 1, { instant: true }); e.preventDefault(); }
    else if (e.key === "ArrowRight") { select(state.cur + 1, { instant: true }); e.preventDefault(); }
    else if (e.key === "Home") { select(0, { instant: true }); e.preventDefault(); }
    else if (e.key === "End") { select(state.steps.length - 1, { instant: true }); e.preventDefault(); }
    else if (e.key === "Tab") {
      // cycle every visible stage tab (diff only exists with a baseline);
      // shift+tab cycles backwards. This claims tab from focus traversal.
      const views = ["stills", "a11y", "context", "video", "diff"]
        .filter((v: ViewerDynamic) => (v !== "diff" || !$("#tab-diff").hidden) && (v !== "context" || !$("#tab-context").hidden));
      const dir = e.shiftKey ? -1 : 1;
      setView(views[(views.indexOf(state.view) + dir + views.length) % views.length]);
      e.preventDefault();
    }
    // space toggles autoplay where the control is visible — except on focused
    // controls, where it must stay a click. A focused film-strip cell is the
    // exception to the exception: Space there plays from the selected still
    // (the cell's native click would just re-select the same step), so don't
    // treat it as a plain control.
    else if (e.key === " " && !e.target.closest("a, input, select, textarea")
             && (!e.target.closest("button") || e.target.closest("#strip .cell"))) {
      if (state.view === "video") {
        // the video tab has no #play strip control; space plays/pauses the
        // native player even when it doesn't hold focus
        const vid = $("#video");
        if (vid && vid.src) { vid.paused ? vid.play() : vid.pause(); e.preventDefault(); }
      } else if (!$("#play").hidden) {
        setPlaying(!state.playing);
        e.preventDefault();
      }
    }
  });
}

boot();
