// [UNREADABLE lines 1-88: scrolled past, not captured in any frame]
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

// context.jsonl: a {type:"header", system} first line (system hoisted out once,
// byte-identical every step) — one {step, messages} line per turn. We tolerate
// the legacy no-header format too (system carried per-line inside `messages`);
// fall back to the first message that looks like the system/persona prompt.
// Any parse trouble returns null so the Context tab simply stays hidden.
function parseContext(text) {
  if (!text) return null;
  try {
    const lines = parseJsonl(text);
    if (!lines.length) return null;
    let system = null;
    let tools = null;
    const byStep = new Map();
    for (const l of lines) {
      if (l.type === "header") { system = l.system ?? null; tools = l.tools ?? null; continue; }
      if (l.step == null || !Array.isArray(l.messages)) continue;
      let messages = l.messages;
      // legacy no-header: the system message rides inside messages
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

// Relative age for history dots/footer: "just now", "2 hours ago", "3 days ago",
// "2 weeks ago". Calendar-day based so a run from late yesterday reads "1 day
// ago", not "18 hours ago". Full datetime stays in fmtDate (hover/title).
function relTime(iso, now = new Date()) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
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
const shortRunId = (id) => (id === null ? "—" : String(id).split("-").at(-1));

// Persona descriptions are authored with hard line wraps for source-editing
// readability. Reflow for display: collapse runs of single newlines (soft
// wraps within a paragraph) into spaces, but keep blank-line paragraph breaks.
function reflow(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

// Copy-paste safety for displayed commands: quote a path for POSIX shells
// when it contains anything outside the safe set ('\'' escapes embedded
// quotes). Inline copy of cli.js shellQuote (the viewer has no bundler).
function shellQuote(s) {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Internal run mode → user-facing label (inline copy of report.js modeLabel —
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
  if (env.acted_from !== null) return state.baselineByStep.get(env.acted_from)?.agent?.action ?? null;
  return null;
}

const ACTION_ICONS = {
  click: "i-click", type: "i-type", select: "i-select", scroll: "i-scroll",
  navigate: "i-nav", wait: "i-wait", done: "i-done", give_up: "i-giveup",
  // mobile + api verbs reuse existing glyphs (the ?? "i-film" fallback covers any gap)
  tap: "i-click", swipe: "i-scroll", back: "i-back", request: "i-net",
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
    ?? (env.acted_from !== null ? state.baselineByStep.get(env.acted_from)?.resolution?.locator : null);
  return locatorName(locator) ?? (a?.ref ? `ref ${a.ref}` : null);
}

// → { icon, verb, arg } for captions, strip cells and the inspector
function describe(env) {
  const a = actionOf(env);
  if (env.mode === "error") return { icon: "i-warn", verb: "actor error", arg: "" };
  const type = a?.type ?? (env.acted_from !== null ? "acted" : "step");
  const ic = ACTION_ICONS[type] ?? "i-film";
  const name = targetName(env);
  switch (type) {
    case "click": return { icon: ic, verb: "click", arg: name ?? "?" };
    case "type": return { icon: ic, verb: "type", arg: `"${a.text}"${name ? " → " + name : ""}` };
    case "select": return { icon: ic, verb: "select", arg: `"${a.value}"${name ? " in " + name : ""}` };
    case "scroll": return { icon: ic, verb: "scroll", arg: a.direction };
    case "navigate": return { icon: ic, verb: "go to", arg: a.url };
    case "wait": return { icon: ic, verb: "wait", arg: `${a.seconds}s` };
    case "done": return { icon: ic, verb: "done", arg: a.summary };
// [UNREADABLE lines 297-312: scrolled past, not captured in any frame]
  }
}

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
          runs = runs.filter((r) => r.status === "fail" || r.status === "infra" || r.status === "interrupted");
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
  // context.jsonl is only fetched when the manifest advertises it (record/heal)
// [UNREADABLE lines 357-432: scrolled past, not captured in any frame]
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
    steps: [], baseline: null, har: [], grade: null, inheritedGrade: null, history: [],
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

/* One row per story (latest run), older runs expandable beneath it.
// [UNREADABLE lines 560-638: scrolled past, not captured in any frame]
        h("a", { class: "case-link", href: href(g) }, k),
        ...tagChips(g),
        older > 0
          ? h("button", {
              class: "expand" + (open ? " on" : ""),
              title: (open ? "hide" : "show") + " this story's older runs",
              onclick: (e) => {
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
  return [main, ...g.runs.slice(1).map((r) => runRow(href(r), "sub", ...cells(r,
    h("td", { class: "td-case" }, h("a", { class: "case-link", href: href(r) }, "↳ " + (r.case_id ?? "?")))))];
};
// re-render with the new tag selection, syncing it into the URL (back/forward
// restores it; reload keeps it). a fresh Set keeps the closed-over one immutable.
const setTags = (next) => {
  const params = new URLSearchParams(location.search);
  next.size ? params.set("tags", [...next].join(",")) : params.delete("tags");
  const qs = params.toString();
  history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  renderPicker(allRuns, filterNote, next);
};
// a filter bar only earns its space once tags are actually in use (≥2 distinct)
const tagBar = allTags.length >= 2
  ? h("div", { class: "tag-filter" },
      ...allTags.map((t) => h("button", {
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
  return new Set(raw ? raw.split(",").map((t) => t.trim()).filter(Boolean) : []);
}

/* Read-only changed-journey review list (?filter=changed). Pending rows show
 * the latest changed-mode run; healed passes stay listed, dimmed, as history. */
function renderChanged(entries) {
  el.hidden = false;
  const pending = entries.filter((e) => e.pending);
  // pending (the review queue) first, then healed passes as dimmed history
  const items = [...pending, ...entries.filter((e) => !e.pending)]
    .map((e) => ({ ...e, pending: e.pending ? "changed" : "historical" }));
  /* cols mirrors the picker: identity first, run id last */
  const cols = [
    { key: "case_id", label: "case" },
    { key: "state", label: "state" },
    { key: "score", label: "score", num: true, desc: true },
    { key: "started_at", label: "started", desc: true },
    { key: "run_id", label: "run id" },
  ];
  const rowsFor = (e) => {
    const run = "?run=" + encodeURIComponent(e.path);
    const row = runRow(run, e.pending ? "" : "hist", ...cells(e,
      h("td", { class: "td-case" + (e.pending ? " pending" : "") }, h("a", { class: "case-link", href: run }, e.case_id ?? "?")),
      h("td", {},
        e.pending
          ? h("span", { class: "chip accent" }, icon("i-branch"), "changed")
          : h("span", { class: "chip" }, "historical")),
      h("td", { class: "td-num", title: e.score == null ? "ungraded" : null }, e.score !== null ? String(e.score) : "—"),
      h("td", { class: "td-date", title: e.started_at }, fmtDate(e.started_at)),
      h("td", { class: "td-id", title: e.run_id }, shortRunId(e.run_id))));
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

/**
 * Deltas of this run vs its history. The comparability rules — pin set
 * included — and the badge thresholds live in the shared module (served at
 * /shared/movement.js, the same code the CLI uses); this maps the viewer's state
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

// Only the distilled regression/improved verdict goes in the topbar. No
// statusMove chip either: "pass → healed" duplicates the "changed" mode chip
// and "pass→fail" duplicates the fail status + regression badge.
function movementBadge() {
  const mv = state.movement;
  if (!mv?.badge) return null;
  return h("span", { class: "chip " + (mv.badge === "regression" ? "fail" : "pass") },
    icon(mv.badge === "regression" ? "i-warn" : "i-check"), mv.badge);
}

/* ---------- header ---------- */

function statusChip(status) {
  if (status === "pass") return h("span", { class: "chip pass" }, icon("i-check"), "pass");
  if (status === "fail") return h("span", { class: "chip fail" }, icon("i-x"), "fail");
  if (status === "infra") return h("span", { class: "chip warn" }, icon("i-warn"), "infra");
  if (status === "interrupted") return h("span", { class: "chip warn" }, icon("i-warn"), "interrupted");
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
  badges.push(h("span", { class: "chip", title: "How many steps the agent took — one action (click, type, navigate, …) per step." }, `${state.steps.length} steps`));
  badges.push(h("span", { class: "chip", title: "Wall-clock time for the whole run, start to finish." }, fmtMs(m.duration_ms)));
  const conf = m.totals?.confusion_events ?? 0;
  if (conf > 0) badges.push(h("span", { class: "chip warn", title: "Confusion events — moments the agent floundered: an action failed, repeated against an unchanged page, or had no visible effect, or the agent itself flagged that it was stuck." }, icon("i-warn"), `${conf} confusion`));
  const move = movementBadge();
  if (move) badges.push(move);
  // The targeted environment (app.envs.<name> via --env). The default env has no
  // name — Name[DEFAULT] would only confuse, so it's omitted there.
// [UNREADABLE lines 812-999: scrolled past, not captured in any frame]
// [reconstruction: inserted to balance block; original line(s) not recoverable]
}

// Step envelopes never carry mode "heal" — the runner writes "agent" for the
// heal continuation — so a step is a heal step when the agent was driving in a
// run that healed: everything after the replayed track broke.
const isHealStep = (env) => env.mode === "agent" && !!state.manifest?.healed;

const MAX_SETTLE_BAR = 2000; // ms that fills the little settle lane

// settle_ms always includes the settle quiet floor we deliberately wait out, so
// the raw number is dominated by that constant and tells you little about the
// app. Subtract the floor to get the real tail: how long the page kept changing
// AFTER the action before going quiet. The floor is max(dom,net): #settle exits
// only when BOTH the DOM and the network have been quiet for their windows, so
// even an instantly-quiet page waits out the longer of the two. Floor comes from
// manifest.pins.settle; old runs without it fall back to the raw value. Clamped
// at 0 (a sub-floor settle means "instantly quiet").
function settleTail(env) {
  const raw = env.result?.settle_ms ?? 0;
  const s = state.manifest?.pins?.settle;
  if (!s || s.dom_quiet_ms == null || s.net_quiet_ms == null) return raw;
  return Math.max(0, raw - Math.max(s.dom_quiet_ms, s.net_quiet_ms));
}

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
    if (env.confusion) flags.push(h("span", { class: "flag warn", title: "confusion · " + env.confusion.type }, icon("i-warn")));
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
// [UNREADABLE lines 1067-1145: scrolled past, not captured in any frame]
// [reconstruction: inserted to balance block; original line(s) not recoverable]
        ))));
    });
  }

function renderCaption(env) {
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
        ? `${d.verb === "done" ? "finished" : "gave up"}: “${String(d.arg ?? "").replace(/[.\s]+$/, "")}”`
        : `${d.verb} ${d.arg ?? ""}`.trim();
    thought.textContent = `Replayed from the saved recording — ${what}. The agent doesn't narrate replayed steps.`;
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
}

/* ---------- stage: stills + ghost cursor ---------- */

let ghostTimer = null;

function updateStage(env) {
  if (state.view === "stills") showStill(env);
  else if (state.view === "a11y") showA11y(env);
  else if (state.view === "context") showContext(env);
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
  // bbox is in the driver's layout unit — web: CSS px (Playwright boundingBox);
  // mobile: iOS points / Android px (the same unit getWindowSize reports). The
  // still PNG is device px = layout unit × device_scale_factor. Derive the factor
  // from the known viewport width the run pins (the still is viewport.width ×
  // dsf wide) and scale the bbox into device px (so the % matches the
  // image). This is unit-agnostic: iOS points→pixels yields the retina scale,
  // Android px→px yields 1, web CSS px→device px yields the DPR — each correct.
  // Absent a viewport pin (old runs / a driver that doesn't report it) ⇒ dsf 1, no-op.
  const vpw = state.manifest?.pins?.viewport?.width;
  const dsf = (vpw && img.naturalWidth) ? img.naturalWidth / vpw : 1;
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
async function showA11y(env) {
  const pre = $("#a11y-pre");
  const diff = $("#a11y-diff");
  // The Custom / Playwright toggle only appears when this step has the (web-only,
  // on-debug) native tree we can diff against; without it we force the custom view.

  const pwRel = env.artifacts?.pw_a11y;
  const mode = $("#a11y-mode");
  // the native tree comes from Playwright (web) or Appium (mobile); name the
  // toggle for whichever produced it.
  const pwBtn = mode.querySelector('button[data-mode="pw"]');
  if (pwBtn) pwBtn.textContent = state.manifest.pins?.driver === "mobile" ? "Appium" : "Playwright";
  mode.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.a11yMode));
  mode.hidden = !pwRel;

  if (state.a11yMode === "pw" && pwRel) {
    // Custom (left) vs native browser tree (right), as an eyeballable side-by-side
    // diff: the only thing the native tree has that we synthesize — the browser doesn't expose.
    const customRel = env.artifacts?.a11y;
    if (customRel && !state.a11yCache.has(customRel)) state.a11yCache.set(customRel, await fetchText(state.base + "/" + customRel));
    if (!state.pwA11yCache.has(pwRel)) state.pwA11yCache.set(pwRel, await fetchText(state.base + "/" + pwRel));
    showA11yNativeDiff(pre, diff, state.a11yCache.get(customRel) ?? "", state.pwA11yCache.get(pwRel) ?? "");
    return;
  }
  const rel = env.artifacts?.a11y;
  if (!rel) { showA11ySingle(pre, diff, null, env); return; }
  if (!state.a11yCache.has(rel)) state.a11yCache.set(rel, await fetchText(state.base + "/" + rel));
  // selection may have moved while fetching
  if (state.steps[state.cur] !== env) return;
  const current = state.a11yCache.get(rel);
  // visual drift: the a11y snapshot can read [IDENTICAL] but the screenshot diverged
  // (visual regression) — a pixel channel differs. There is no a11y diff to show — the
// [UNREADABLE lines 1309-1395: scrolled past, not captured in any frame]
  // [reconstruction: inserted to balance block; original line(s) not recoverable]
  diff.replaceChildren(
    h("div", { class: "a11y-cols" },
      h("div", { class: "diff-colhead" }, "custom snapshot"),
      h("div", { class: "diff-colhead" }, nativeHead),
      ...ops.flatMap((o) => [
        a11yLineCell(o.a, o.op === "add" ? "empty" : o.op),
        a11yLineCell(o.b, o.op === "del" ? "empty" : o.op),
      ]),
    ),
  );
  diff.hidden = false;
}

function renderA11yText(pre, text, env) {
  pre.replaceChildren();
  if (!text) {
    pre.append(h("span", { class: "head" }, `no snapshot text captured for step ${env.step}`));
    return;
  }
  colorizeSnapshot(pre, text);
}

// Append a snapshot's text into `pre`, colorizing [eN] element refs and the
// Page: header line; everything else stays literal. Shared by the Agent-view
// pane and the Context tab's current-snapshot card.
function colorizeSnapshot(pre, text) {
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
function ctxContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p?.type === "image_url" || p?.image_url) return "[screenshot elided — see Stills]";
      return p?.text ?? "";
    })
    .join("\n");
}

function kb(chars) {
  return (chars / 1024).toFixed(1) + " KB";
}
