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
   `activeTags` (a Set) filters by tag (OR — a run matches if it has ANY active
   tag); it persists across the full re-render a toggle triggers, and rides the
   ?tags= URL param so a filtered picker is shareable and composes with the
   ?filter= / ?case= flags. `allRuns` is the unfiltered set the chip bar derives
   the tag universe + per-tag counts from, so chips don't vanish as you narrow. */
function renderPicker(runs, filterNote = null, activeTags = pickerTagsFromUrl()) {
  const el = $("#picker");
  el.hidden = false;
  const allRuns = runs;
  const caseKey = (r) => r.case_id ?? "?";
  // tag universe + counts come from the pre-tag-filter set so the bar is stable.
  // the picker lists one row per STORY, so a tag's count is the number of distinct
  // stories carrying it (dedupe by case_id), not the run total.
  const tagStories = new Map();
  for (const r of allRuns) for (const t of Array.isArray(r.tags) ? r.tags : []) {
    if (!tagStories.has(t)) tagStories.set(t, new Set());
    tagStories.get(t).add(caseKey(r));
  }
  const tagCount = (t) => tagStories.get(t)?.size ?? 0;
  const allTags = [...tagStories.keys()].sort();
  // drop any active tag that no longer exists (stale URL), then OR-filter
  for (const t of [...activeTags]) if (!tagStories.has(t)) activeTags.delete(t);
  if (activeTags.size) runs = runs.filter((r) => (Array.isArray(r.tags) ? r.tags : []).some((t) => activeTags.has(t)));

  const byCase = new Map();
  for (const r of runs) {
    const k = caseKey(r);
    if (!byCase.has(k)) byCase.set(k, []);
    byCase.get(k).push(r);
  }
  // groups sort on the latest run's values; mode_label sorts by what's shown
  const groups = [...byCase.values()].map((list) => {
    list.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
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
  const href = (r) => "?run=" + encodeURIComponent(r.path ?? `${r.run_id}/${r.case_id}`);

  const cells = (r, caseCell) => [caseCell,
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
  const storyLine = (r) => {
    const description = typeof r.description === "string" ? r.description.trim() : "";
    const story = typeof r.story === "string" ? r.story.trim() : "";
    const text = description || story;
    if (!text) return null;
    return h("div", {
      class: "case-story" + (description ? "" : " clamp"),
      title: text,
    }, text.replace(/\s+/g, " "));
  };
  const tagChips = (r) => (Array.isArray(r.tags) ? r.tags : []).map((t) => h("span", { class: "tag" }, t));
  const rowsFor = (g, redraw) => {
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
      h("td", { class: "td-case" }, h("a", { class: "case-link", href: href(r) }, "↳ " + (r.case_id ?? "?"))))))]; // [reconstruction: balancing a gap; original code not recoverable]
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
  // a filter bar only earns its space once tags are actually in use (>=2 distinct)
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
// [UNREADABLE lines 812-881: scrolled past, not captured in any frame]
  // they read as "still at 90" rather than as a grade of their own. The y-axis
  // is the quality score when ≥2 runs are graded; else duration — except a
  // journey leads with the status band, so an ungraded journey just shows pips.
  const graded = hist.filter((r) => r.score !== null);
  const useScore = graded.length >= 2;
  const yMetric = useScore ? "score" : journey ? null : "duration";
  const own = hist.map((r) => (yMetric === "score" ? r.score : yMetric === "duration" ? r.duration_ms : null));
  const known = own.filter((v) => v !== null);
  if (!journey && !known.length) return note("not enough comparable runs to chart yet");

  const W = 300, H = 76, L = 12, R = 12, T = 18, B = 14;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, hist.length - 1);
  const esc = (s) => s.replace(/&/g, "&").replace(/</g, "<");
  const clampX = (px) => Math.min(Math.max(px, 16), W - 16);
  const cur = (r) => (state.runPath ? r.path === state.runPath : r.run_id === state.manifest.run_id);
  const curIdx = hist.findIndex(cur);
  const link = (i, r, inner) =>
    state.rootMode && r.path ? `<a href="?run=${encodeURIComponent(r.path)}">${inner}</a>` : inner;

  let svgBody, subtitle;
  if (journey) {
    // STATUS BAND — the headline. A prominent row of pass/fail pips along a
    // fixed top line; the highest-value signal is "did the journey stay green".
    const BAND_Y = T;
    const band = hist.map((r, i) => {
      const color = HIST_COLOR[r.status] ?? "var(--dim)";
      const isCur = cur(r);
      const cx = x(i).toFixed(1);
      const title = `${r.run_id} · ${r.status}` +
        (r.score !== null ? ` · quality ${r.score}` : ` · ungraded`) +
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
      let carry = own.find((v) => v !== null);
      const plotted = own.map((v) => (v !== null ? (carry = v) : carry));
      const min = Math.min(...known), max = Math.max(...known);
      const span = max - min;
      const QT = T + 22, QB = H - B; // overlay lives below the band
      const qy = (v) => (span === 0 ? (QT + QB) / 2 : QB - ((v - min) / span) * (QB - QT));
      const pts = plotted.map((v, i) => `${x(i).toFixed(1)},${qy(v).toFixed(1)}`);
      const dots = plotted.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${qy(v).toFixed(1)}" r="${own[i] === null ? 1.5 : 2}" fill="var(--faint)"/>`).join("");
      overlay = `<polyline class="hist-overlay" points="${pts.join(" ")}" fill="none" stroke="var(--faint)" stroke-width="1"/>${dots}`;
    }
    svgBody = overlay + band;
    subtitle = `${hist.length} runs · pass/fail` + (useScore ? " · quality overlay" : "");
  } else {
    // DISCOVERY (and journey never reaches here); score is the y-axis.
    const firstKnown = own.find((v) => v !== null);
    let carry = firstKnown;
    const plotted = own.map((v) => (v !== null ? (carry = v) : carry));
    const min = Math.min(...known), max = Math.max(...known);
    const span = max - min;
// [UNREADABLE lines 941-998: scrolled past, not captured in any frame]
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
    if (env.confusion) flags.push(h("span", { class: "flag warn", title: "confusion: " + env.confusion.type }, icon("i-warn")));
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
    if (on) {
      c.scrollIntoView({ block: "nearest", inline: "nearest", behavior: instant ? "auto" : "smooth" });
      // keep DOM focus on the active cell for manual navigation (arrows/Home/End)
      // so a subsequent Space plays from THIS cell — otherwise focus
      // lingers on a previously-clicked cell and Space fires its native click.
      if (document.activeElement?.closest("#strip")) c.focus({ preventScroll: true });
    }
  });

  // A state-drift step's app changed under the recorded action — nudge the user toward
  // the Diff tab by gently pulsing them.
  const drift = env.confusion?.type === "state_drift";
  document.querySelectorAll('.tab[data-view="diff"], #tab-diff').forEach((t) => t.classList.toggle("drift", drift));
  document.querySelectorAll('.tab[data-view="a11y"], #tab-diff').forEach((t) => t.classList.toggle("drift", drift));
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
  // [reconstruction: an orphaned tail (a diff.replaceChildren(h("div.a11y-cols",
  //  ...)) call) of the unreadable statement above was removed so the file parses;
  //  its head fell in the gap and is not recoverable]
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

// The Context tab shows exactly what the model was sent that turn: a collapsed
// SYSTEM card (the persona prompt, constant across steps) and any TOOLS card up
// top, then one card per message in the turn's context window. The SYSTEM/TOOLS
// cards are folded by default (they repeat every step); the message cards open.
// A card's open/closed state is keyed by a STABLE identity (ctxCardState) so it
// survives the full rebuild we do on every step change — otherwise a card you
// opened would snap shut the moment you moved to the next step. The key is just
// "system" / "tools" / the message label.
const ctxCardState = new Map(); // key → { open }
function ctxState(key, dflt) {
  if (!ctxCardState.has(key))
    ctxCardState.set(key, { ...dflt });
  return ctxCardState.get(key);
}

function showContext(env) {
  const body = $("#ctx-body");
  body.replaceChildren();
  const ctx = state.context;
  const entry = ctx?.byStep.get(env.step) ?? null;
  const system = ctx?.system ?? null;

  const msgs = entry?.messages ?? [];
  const total = (system ? system.length : 0) + msgs.reduce((n, m) => n + ctxContentText(m.content).length, 0);
  const model = entry?.model ?? state.manifest?.pins?.actor_model ?? "model";
  const inTok = env.tokens?.in;
  const tokPart = inTok !== null ? ` · ${fmtTokens(inTok)} tok` : "";
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
  const addCard = (key, label, text, fill, { open = false, fixed = false, glyph = null } = {}) => {
    const st = ctxState(key, { open });
    const pre = h("pre", {});
    fill(pre);
    const head = h("summary", { class: "ctx-card-h" },
      glyph ? icon(glyph) : null,
      h("span", {}, `${label} · ${kb(text.length)}`));
    const card = h("details", { class: fixed ? "ctx-card ctx-fixed" : "ctx-card" }, head, pre);
    // set the OPEN PROPERTY (not via setAttribute — a present open
    // attribute opens a <details> regardless of its value) so open:false
    // cards honestly render closed and ignore the persisted fold state.
    card.open = st.open;
    card.addEventListener("toggle", () => { st.open = card.open; });
    body.append(card);
  };

  // SYSTEM: the persona prompt, identical every step — folded by default.
  if (system !== null) {
    addCard("system", "SYSTEM · persona prompt", system,
      (pre) => { pre.textContent = system; }, { fixed: true, glyph: "i-persona" });
  }

  // TOOLS: the function tool(s) the actor could call this turn, also constant
  // every step — folded by default, pretty-printed JSON.
  const tools = ctx?.tools ?? null;
  if (Array.isArray(tools) && tools.length) {
    const names = tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean).join(", ");
    const json = JSON.stringify(tools, null, 2);
    addCard("tools", `TOOLS · ${names || "available tools"}`, json,
      (pre) => { pre.textContent = json; }, { fixed: true, glyph: "i-token" });
  }

  // Per-step message cards: open by default.
  for (const m of msgs) {
    const text = ctxContentText(m.content);
    const role = (m.role ?? "msg").toUpperCase();
    const isSnapshot = text.startsWith("Current page snapshot");
    const label = isSnapshot
      ? `${role} · current snapshot`
      : `${role} · steps so far`;
    addCard(label, label, text,
      (pre) => { if (isSnapshot) colorizeSnapshot(pre, text); else pre.textContent = text; },
      { open: true });
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
async function wireCaptionTrack(video) {
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
  state.videoOk = false;
  $(".video-box").hidden = true;
  const el = $("#video-missing");
  el.hidden = false;
  el.replaceChildren(icon("i-play", ""), "no video recorded for this run");
}
// [UNREADABLE lines 1592-1649: scrolled past, not captured in any frame]
function seekVideo(env) {
  const video = $("#video");
  const vsa = state.manifest.video_started_at;
  const slideshow = isSlideshow();
  if (state.videoOk && (vsa || slideshow) && env.ts != null) {
    // A step's video time is its caption cue's exact START—for a slideshow
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
  document.querySelectorAll(".vmark").forEach((m) => m.classList.toggle("on", Number(m.dataset.i) === state.cur));
}

/* ---------- stage: diff (standalone LCS over action signatures) ---------- */
function isExecutable(env) {
  const t = env.type;
  return env.resolution && env.result?.ok && t !== "done" && t !== "give_up";
}

function signature(env) {
  const a = actionOf(env);
  // A step's action signature (CONTRACTS §3): type, locator/url, the typed
  // text or selected value, and the scroll direction. Collapsing a
  // reordered step into a changed step instead of collapsing to a same. This is
  // the sole implementation (the harness has no separate copy).
  return (a?.type ?? "") + "|" + (env.resolution?.locator ?? a?.url ?? "") + "|" + (a?.text ?? a?.value ?? "") + "|" + (a?.direction ?? "");
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
  // baseline-side envelopes aren't in state.steps — only this run's cells navigate.
  // Clicking opens the step in Stills (a visible jump) rather than re-selecting
  // under the run-level diff pane, where nothing would appear to change.
  const idx = op === "del" ? -1 : state.steps.indexOf(env);
  return h(idx >= 0 ? "button" : "div", {
    class: "dcell " + op + (idx >= 0 ? " clickable" : ""),
    onclick: idx >= 0 ? () => { setView("stills"); select(idx); } : null,
  },
    h("div", { class: "d-act" },
      h("span", { class: "d-num" }, String(env.step).padStart(2, "0")),
      icon(d.icon),
      h("span", {}, `${d.verb} ${d.arg ?? ""}`)),
    env.resolution?.locator ? h("div", { class: "d-loc" }, env.resolution.locator) : null,
  );
}
// [UNREADABLE lines 1723-1841: scrolled past, not captured in any frame]
  // [reconstruction: orphaned fragment folded into this gap so the file parses; head not recoverable]
  // [reconstruction: orphaned fragment folded into this gap so the file parses; head not recoverable]
  setInspTab(state.itab);
  reflectInspWide();
}

function setInspTab(name) {
  state.itab = name;
  try { sessionStorage.setItem("playtest.itab", name); } catch {}
  document.querySelectorAll(".itab").forEach((t) => t.classList.toggle("on", t.dataset.itab === name));
  $("#ipane-step").hidden = name !== "step";
  $("#ipane-run").hidden = name !== "run";
}

function setInspWide(on) {
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
  function onEnd(e) {
    if (e.target === layout && e.propertyName === "grid-template-columns") fit();
  }
  layout.addEventListener("transitionend", onEnd);
  // fallback if the transition is interrupted or coalesced (no event fires)
  setTimeout(fit, 220);
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

function renderInspectorStep(env) {
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
  const put = (k, v, cls) => { if (v !== null && v !== "") kv.append(h("dt", { class: cls ?? "" }, k), h("dd", { class: cls ?? "" }, v)); };
  put("element", env.resolution?.locator);
  if (a?.type === "done") put("summary", a.summary, "prose");
  if (a?.type === "give_up") put("reason", a.reason, "prose");
  if (env.confusion) put("confusion", `${env.confusion.type}${env.confusion.note ? " — " + env.confusion.note : ""}`, "err");

  const heal = isHealStep(env);
  // Right slot shows the actor model (e.g. "GPT5_4_MINI") — the mode
  // (replayed / healed / agent) is still spelled out in the step-src line below.
  // A replayed step made no model call, so it gets no model chip.
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
  const netEntries = (env.artifacts?.har_entries ?? []).map((i) => state.har[i]).filter(Boolean);
  const embedded = env.network?.requests ?? [];
  const useEmbedded = !netEntries.length && embedded.length > 0;
  const count = useEmbedded ? embedded.length : netEntries.length;
  const netLabel = count > MAX_WF_ROWS ? `${MAX_WF_ROWS} of ${count} req` : `${count} req`;
  $("#sec-net").replaceChildren(sec("i-net", "network", netLabel,
    useEmbedded ? renderNetRequests(embedded) : renderWaterfall(netEntries)));

  // accessibility (axe-core) — defensive: only renders when this step carried a
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
function axeDocsUrl(rule) {
  if (rule?.help_url) return rule.help_url;
  return rule?.id ? `https://dequeuniversity.com/rules/axe/${AXE_DOCS_VERSION}/${rule.id}` : null;
}

// "↗ how to fix — Deque docs" external link (opens in a new tab). null when
// there's no rule id to point at.
function axeDocsLink(rule) {
  const url = axeDocsUrl(rule);
  if (!url) return null;
  return h("a", { class: "a11y-docs", href: url, target: "_blank", rel: "noopener noreferrer" },
    icon("i-nav"), "how to fix — Deque docs");
}

// One offending element: its outer HTML (the developer's handle on WHAT to fix)
// over its CSS selector path (WHERE), and an optional deep link to the step it
// was seen on (run-level view). Either html or target may be absent on older
// captures.
function axeNodeCell(node, { step = null } = {}) {
  const target = node.target?.length ? node.target.join(" ") : null;
  return h("div", { class: "a11y-node" },
    step !== null ? h("div", { class: "a11y-node-head" }, stepLink(step)) : null,
    node.html ? h("code", { class: "a11y-html" }, node.html) : null,
    target ? h("div", { class: "a11y-target", title: target }, target) : null);
}

/* Per-step axe-core a11y capture. Returns null when no axe data is present, so
   the section simply doesn't appear. Each violation is an expandable row listing
   every offending element + the fix guidance. The full-page violation count gates
   accessibility_violations. */
function renderStepAxe(env) {
  const axe = env.axe;
  if (!axe || !Array.isArray(axe.violations)) return null;
  const { total = 0 } = axe.counts ?? {};
  if (total === 0) {
    return sec("i-check", "accessibility", h("span", { class: "chip pass" }, "0 violations"),
      h("div", { class: "empty-note" }, "no WCAG violations on this step"));
  const rows = axe.violations.map((v) => {
    const nodes = v.nodes ?? [];
    const head = h("summary", { class: "a11y-rule-h" },
      icon("i-warn"),
      h("span", { class: "a11y-rule-id" }, v.id),
      v.impact ? h("span", { class: "chip warn" }, v.impact) : null,
      h("span", { class: "a11y-nodecount", title: `${nodes.length} offending element${nodes.length === 1 ? "" : "s"}` }, String(nodes.length)));
    const body = h("div", { class: "a11y-rule-body" },
      v.help ? h("div", { class: "a11y-help" }, v.help) : null,
      ...nodes.map((n) => axeNodeCell(n)),
      axeDocsLink(v));
    return h("details", { class: "a11y-rule" }, head, body);
  });
  return sec("i-check", "accessibility", `${total} violation${total === 1 ? "" : "s"}`,
    h("span", { class: "chip warn" }, `${total} violation${total === 1 ? "" : "s"}`),
    ...rows);
}
// [UNREADABLE lines 2053-2178: scrolled past, not captured in any frame]
function renderEnv() {
  const e = state.env.manifest.env ?? {};
  const right = e.env_name ? modelChip(e.env_name) : null; // reuse the truncating chip helper
  const kv = h("dl", { class: "kv" });
  const put = (k, v) => { if (v !== null && v !== "") kv.append(h("dt", {}, k), h("dd", {}, v)); };
  if (e.env_name) put("env", String(e.env_name));
  if (e.base_url)
    put("url", h("a", { href: e.base_url, target: "_blank", rel: "noopener noreferrer" }, e.base_url));
  put("driver", e.driver);
  const cookies = e.cookies && typeof e.cookies === "object" ? Object.entries(e.cookies) : [];
  if (cookies.length) {
    kv.append(h("dt", {}, "cookies"),
      h("dd", {}, ...cookies.map(([name, val]) =>
        h("span", { class: "chip", title: `${name}=${val}` }, name))));
  }
  // before_each hook (§6): additive line, only when a hook ran this run. The
  // returned setup context is never persisted (maybe a secret) — we only show
  // WHETHER one was provided, plus how long the seed took.
  const setup = state.manifest.setup;
  if (setup?.ran) {
    const ms = typeof setup.duration_ms === "number" ? ` (${setup.duration_ms} ms)` : "";
    put("setup", setup.returned_context ? `ran, context provided${ms}` : `ran${ms}`);
  }
  return sec("i-net", "environment", right, kv);
}

function renderGate() {
  const gate = state.manifest.result?.gate;
  if (!gate) return sec("i-check", "gate", null, h("div", { class: "empty-note" }, "no gate result in manifest"));
  const rows = (gate.checks ?? []).map((c) => {
    // A failed SOFT check (console errors / perf) failed the run but didn't
    // block the baseline — render it as a warning, not a hard fail.
    const softFail = !c.pass && c.severity === "soft";
    // An inherited check (assert / opted-in custom assertion on a clean act replay)
    // reused the baseline's saved verdict instead of re-running — flag it so the
    // viewer is honest that no fresh model/observe call ran this time.
    return h("div", { class: "gate-row" },
      icon(c.pass ? "i-check" : "i-x", "ic " + (c.pass ? "g-pass" : softFail ? "g-warn" : "g-fail")),
      h("div", {},
        h("div", { class: "gate-spec" }, c.spec ?? c.kind,
          // assert checks show the grader model that judged it.
          c.kind === "assert" ? graderModelLabel() : null,
          c.inherited ? h("span", { class: "chip accent", title: "Checked replay: the trajectory was unchanged, so this verdict was reused from the baseline (no fresh model call)." }, "checked") : null),
        c.detail ? h("div", { class: "gate-detail" }, c.detail) : null,
        // a failed console_errors check carries the captured messages — show them
        // folded so the count line stays scannable but the detail is one click away.
        c.errors?.length ? consoleErrorList(c.errors) : null));
  });
  return sec("i-check", "gate", null,
    h("div", { style: "margin-bottom:8px" }, gate.pass
      ? h("span", { class: "chip pass" }, icon("i-check"), "gate pass")
      : h("span", { class: "chip fail" }, icon("i-x"), "gate fail")),
    ...rows);
}

// A folded <details> listing captured console/page errors ({type,text}[]) — the
// gate row's run-total and the per-step perf panel both use it. Folded by default
// so it never crowds the panel; each line is the error type + its message
// (createTextNode keeps app-controlled text XSS-safe). Empty/absent => caller
// renders nothing (defensive; legacy runs carry no errors field).
function consoleErrorList(errors) {
  if (!errors?.length) return null;
  return h("details", { class: "err-disclosure" },
    h("summary", {}, `show ${errors.length} error${errors.length === 1 ? "" : "s"}`),
    h("div", { class: "err-list" },
      ...errors.map((e) => h("div", { class: "err-item" },
        h("span", { class: "err-kind" }, e.type === "pageerror" ? "page" : "console"),
        h("span", { class: "err-text" }, e.text ?? "")))));
}

// Grader prose normally carries real newlines, which `.grade-summary` /
// [UNREADABLE lines 2250-2400: scrolled past, not captured in any frame]
  // [reconstruction: orphaned fragment folded into this gap so the file parses; head not recoverable]
  const detail = axeDetailByRule();
  const rules = (a.top_rules ?? []).length
    ? h("div", {},
      h("div", { class: "label", style: "margin-top:8px" }, "top rules"),
      ...a.top_rules.map((r) => a11yRuleRow(r, detail.get(r.id))))
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
    } }, h("span", { class: "brief-chevron" }), "the brief");
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
      ? h("div", { class: "nav-vitals" }, ...(c.tags ?? []).map((t) => h("span", { class: "chip" }, "#" + t)))
      : null,
  ].filter(Boolean));
  // toggle if the clamp actually hides something (scrollHeight
  // exceeds clientHeight after toggle.hidden = false)
  if (storyEl.scrollHeight > storyEl.clientHeight + 1) toggle.hidden = false;
}

/* ---------- tabs + keys ---------- */
function setView(view) {
  if (view === "diff" && $("#tab-diff").hidden) return;
  if (view === "context" && $("#tab-context").hidden) return;
  state.view = view;
  // stills autoplay belongs to the step-following views; video plays itself
/* ?? */
/* ?? */
/* ?? */
  const canPlay = view === "stills" || view === "a11y" || view === "context";
  if (!canPlay) setPlaying(false);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === view));
  $("#pane-stills").hidden = view === "stills";
  $("#pane-a11y").hidden = view === "a11y";
  $("#pane-context").hidden = view === "context";
  $("#pane-video").hidden = view === "video";
  $("#pane-diff").hidden = view === "diff";
  $("#caption").hidden = view === "diff"; // diff is run-level; the step thought panel would mislead
  if (state.steps.length) updateStage(state.steps[state.cur]);
}

function initTabs() {
  // blur after switching so focus doesn't linger on the tab — otherwise space
  // would activate the focused tab button instead of toggling stills autoplay
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => { setView(t.dataset.view); t.blur(); }));
  initA11yMode();
}

// Agent-view Custom|Playwright toggle: flips state.a11yMode and re-renders the
// current step's a11y pane (the toggle itself only shows when a pw_a11y artifact
// exists — see showA11y).
function initA11yMode() {
  document.querySelectorAll("#a11y-mode button").forEach((b) => {
    b.addEventListener("click", () => {
      state.a11yMode = b.dataset.mode;
      document.querySelectorAll("#a11y-mode button").forEach((x) => x.classList.toggle("on", x === b));
      if (state.steps.length) showA11y(state.steps[state.cur]);
    });
  });
}

function initKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "VIDEO" || e.metaKey || e.ctrlKey || e.altKey) return;
    // Keyboard nav scrolls instantly: smooth-scrolling animates across the whole
    // strip on a Home/End jump (and lags rapid arrow presses), which reads as slow.
    if (e.key === "ArrowLeft") { select(state.cur - 1, { instant: true }); e.preventDefault(); }
    else if (e.key === "ArrowRight") { select(state.cur + 1, { instant: true }); e.preventDefault(); }
    else if (e.key === "Home") { select(0, { instant: true }); e.preventDefault(); }
  });  // [reconstruction: tail closers appended to balance open blocks; original tail not recoverable]
}
}
}
}
