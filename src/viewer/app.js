/* Dummy trajectory viewer. Loads /run/manifest.json (or /runs.json -> picker) and
   renders the recording. Every artifact is optional: missing files degrade to
   placeholders, never a blank app. */

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
  cur: 0,
  view: "stills",
  a11yCache: new Map(),
  videoOk: false,
};

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
  const runParam = new URLSearchParams(location.search).get("run");
  if (runParam) state.base = "/run/" + runParam.replace(/^\/+|\/+$/g, "");

  state.manifest = await fetchJson(state.base + "/manifest.json");
  if (state.manifest) return loadRun();

  if (!runParam) {
    const runs = await fetchJson("/runs.json");
    if (Array.isArray(runs) && runs.length) return renderPicker(runs);
  }
  renderFatal("No run found here. Point `dummy view` at a run directory (or a runs root), or check the ?run= parameter.");
}

async function loadRun() {
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

  state.steps = parseJsonl(trajText);
  state.har = har?.log?.entries ?? [];
  state.grade = grade;
  state.baseline = baseText ? parseJsonl(baseText) : null;
  if (state.baseline) for (const env of state.baseline) state.baselineByStep.set(env.step, env);
  state.history = Array.isArray(history) ? history : [];

  document.title = `Dummy — ${caseId || "run"}`;
  $("#app").hidden = false;

  renderHeader();
  renderSparkline();
  renderStrip();
  renderInspectorStatic();
  renderDiff();
  initVideo();
  initTabs();
  initKeys();

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

function renderFatal(msg) {
  const el = $("#fatal");
  el.hidden = false;
  el.replaceChildren(
    h("div", { class: "picker-brand" }, "Dummy"),
    h("p", {}, msg),
  );
}

function renderPicker(runs) {
  const el = $("#picker");
  el.hidden = false;
  const list = runs.map((r) =>
    h("a", { class: "run-link", href: "?run=" + encodeURIComponent(`${r.run_id}/${r.case_id}`) },
      statusChip(r.status),
      h("span", { class: "chip" }, r.mode ?? "?"),
      h("span", { class: "r-case" }, r.case_id ?? "?"),
      h("span", { class: "r-id" }, `${r.run_id ?? ""}  ·  ${r.started_at ?? ""}`),
    ),
  );
  el.replaceChildren(
    h("div", { class: "picker-inner" },
      h("div", { class: "picker-brand" }, "Dummy"),
      h("div", { class: "picker-sub" }, `${runs.length} recorded performance${runs.length === 1 ? "" : "s"} — choose one`),
      ...list,
    ),
  );
}

/* ---------- header ---------- */

function statusChip(status) {
  if (status === "pass") return h("span", { class: "chip pass" }, icon("i-check"), "pass");
  if (status === "fail") return h("span", { class: "chip fail" }, icon("i-x"), "fail");
  if (status === "infra") return h("span", { class: "chip warn" }, icon("i-warn"), "infra");
  return h("span", { class: "chip" }, status ?? "?");
}

function renderHeader() {
  const m = state.manifest;
  $("#case-id").replaceChildren(
    m.case?.id ?? "unknown case",
    h("span", { class: "run-id" }, `  ·  ${m.run_id ?? ""}`),
  );

  const badges = [statusChip(m.result?.status), h("span", { class: "chip" }, m.mode ?? "?")];
  if (m.healed) badges.push(h("span", { class: "chip accent" }, icon("i-branch"), "healed"));
  const reason = m.result?.end_reason;
  if (reason && reason !== "done") badges.push(h("span", { class: "chip warn" }, reason.replace("_", " ")));
  badges.push(h("span", { class: "chip" }, `${state.steps.length} steps`));
  badges.push(h("span", { class: "chip" }, fmtMs(m.duration_ms)));
  const conf = m.totals?.confusion_events ?? 0;
  if (conf > 0) badges.push(h("span", { class: "chip warn" }, icon("i-warn"), `${conf} confusion`));
  $("#run-badges").replaceChildren(...badges);

  const t = m.totals?.tokens ?? {};
  const cost = m.totals?.cost_usd;
  const el = $("#cost-strip");
  if (!t.in && !t.out && !cost) {
    el.replaceChildren(
      h("div", { class: "cost-usd" }, h("b", {}, "$0.00")),
      h("div", {}, "no model calls"),
    );
  } else {
    const cachePct = t.in ? Math.round(((t.cache_read ?? 0) / t.in) * 100) : 0;
    el.replaceChildren(
      h("div", { class: "cost-usd" }, "this run ", h("b", {}, "$" + (cost ?? 0).toFixed(4))),
      h("div", {}, `${fmtTokens(t.in)} in · ${fmtTokens(t.out)} out · ${cachePct}% cached`),
    );
  }
}

/* ---------- cross-run sparkline ---------- */

function renderSparkline() {
  const hist = state.history;
  if (!hist || hist.length < 2) return;
  const W = 150, H = 30, PAD = 4;
  const scores = hist.map((r) => r.score);
  const useScore = scores.some((s) => s != null);
  const vals = hist.map((r) => (useScore ? r.score : r.duration_ms));
  const known = vals.filter((v) => v != null);
  if (!known.length) return;
  const min = Math.min(...known), max = Math.max(...known);
  const span = max - min || 1;
  const x = (i) => PAD + (i * (W - 2 * PAD)) / Math.max(1, hist.length - 1);
  const y = (v) => v == null ? H / 2 : H - PAD - ((v - min) / span) * (H - 2 * PAD);

  const pts = vals.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
  const color = { pass: "var(--pass)", fail: "var(--fail)", infra: "var(--warn)" };
  const dots = hist.map((r, i) => {
    const cur = r.run_id === state.manifest.run_id;
    const title = `${r.run_id} · ${r.status}${r.score != null ? " · score " + r.score : ""} · ${fmtMs(r.duration_ms)}`;
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(vals[i]).toFixed(1)}" r="${cur ? 3.4 : 2.2}" fill="${color[r.status] ?? "var(--dim)"}" ${cur ? 'stroke="var(--ink)" stroke-width="1"' : ""}><title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title></circle>`;
  }).join("");

  $("#spark-svg").innerHTML =
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<polyline points="${pts.join(" ")}" fill="none" stroke="var(--line2)" stroke-width="1.2"/>${dots}</svg>`;
  $("#spark-label").textContent = `${hist.length} runs · ${useScore ? "grade" : "duration"}`;
  $("#spark").hidden = false;
}

/* ---------- film strip ---------- */

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
    const dots = [];
    if (env.result?.ok === false) dots.push(h("span", { class: "dot fail", title: "step failed" }));
    if (env.confusion) dots.push(h("span", { class: "dot warn", title: "confusion: " + env.confusion.type }));
    if (dots.length) thumb.append(h("div", { class: "dots" }, ...dots));

    const settle = env.result?.settle_ms ?? 0;
    const tele = h("div", { class: "cell-tele" },
      h("div", { class: "settle-lane" },
        h("div", { class: "settle-bar", style: `width:${Math.min(100, (settle / MAX_SETTLE_BAR) * 100)}%` })),
      h("span", { class: "cell-ms" }, fmtMs(settle)),
      (env.perf?.js_errors ?? 0) > 0 ? icon("i-warn") : null,
    );

    strip.append(h("button", { class: "cell", "data-i": i, onclick: () => select(i) },
      thumb,
      h("div", { class: "cell-cap" },
        h("div", { class: "cell-line" },
          h("span", { class: "n" }, String(env.step).padStart(2, "0")),
          icon(d.icon),
          h("span", { class: "t" }, `${d.verb} ${d.arg ?? ""}`)),
        tele,
      ),
    ));
  });
}

/* ---------- selection ---------- */

function select(i, { instant = false } = {}) {
  if (!state.steps.length) return;
  state.cur = Math.max(0, Math.min(i, state.steps.length - 1));
  const env = state.steps[state.cur];

  document.querySelectorAll("#strip .cell").forEach((c) => {
    const on = Number(c.dataset.i) === state.cur;
    c.classList.toggle("on", on);
    if (on) c.scrollIntoView({ block: "nearest", inline: "nearest", behavior: instant ? "auto" : "smooth" });
  });

  updateCaption(env, instant);
  updateStage(env);
  renderInspectorStep(env);
}

function updateCaption(env, instant) {
  const fade = $("#cap-fade");
  const apply = () => {
    const meta = [h("span", { class: "cap-step" }, `step ${env.step} / ${state.steps.length}`)];
    meta.push(h("span", { class: "chip" }, env.mode === "act" ? `acted · baseline ${env.acted_from ?? "?"}` : "agent"));
    if (env.result?.ok === false) meta.push(h("span", { class: "chip fail" }, icon("i-x"), "failed"));
    if (env.confusion) meta.push(h("span", { class: "chip warn" }, icon("i-warn"), "confusion · " + env.confusion.type.replace("_", " ")));
    $("#cap-meta").replaceChildren(...meta);

    const thought = $("#cap-thought");
    if (env.agent?.thought) {
      thought.textContent = `“${env.agent.thought}”`;
      thought.className = "cap-thought";
    } else {
      const d = describe(env);
      thought.textContent = `Acted from the baseline — ${d.verb} ${d.arg ?? ""}. No narration on acted steps.`;
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
  };
  if (instant) { apply(); return; }
  fade.classList.add("fading");
  setTimeout(() => { apply(); fade.classList.remove("fading"); }, 150);
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

function initVideo() {
  const video = $("#video");
  const missing = () => {
    $(".video-box").hidden = true;
    const el = $("#video-missing");
    el.hidden = false;
    el.replaceChildren(icon("i-play", ""), "no video recorded for this run");
  };
  const rel = state.manifest.artifacts?.video === null ? null : (state.manifest.artifacts?.video ?? "video.webm");
  if (!rel) return missing();
  video.addEventListener("error", missing);
  video.addEventListener("loadedmetadata", () => {
    state.videoOk = true;
    renderVideoMarks(video.duration);
  });
  video.src = state.base + "/" + rel;
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
    marks.append(h("span", {
      class: "vmark", "data-i": i, title: `step ${env.step} @ ${fmtClock(t)}`,
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
  const cls = "dcell " + op + (op !== "del" ? " clickable" : "");
  const cell = h("div", { class: cls },
    h("div", { class: "d-act" },
      h("span", { class: "d-num" }, String(env.step).padStart(2, "0")),
      icon(d.icon),
      h("span", {}, `${d.verb} ${d.arg ?? ""}`)),
    env.resolution?.locator ? h("div", { class: "d-loc" }, env.resolution.locator) : null,
  );
  if (op !== "del") {
    const idx = state.steps.indexOf(env);
    if (idx >= 0) cell.addEventListener("click", () => select(idx));
  }
  return cell;
}

function renderDiff() {
  if (!state.baseline) return; // tab stays hidden
  $("#tab-diff").hidden = false;

  const A = state.baseline.filter(isExecutable);
  const B = state.steps.filter(isExecutable);
  const ops = lcsDiff(A, B, A.map(signature), B.map(signature));
  const sum = { same: 0, del: 0, add: 0 };
  for (const o of ops) sum[o.op]++;

  const body = $("#diff-body");
  body.replaceChildren(
    h("div", { class: "diff-head" },
      h("span", { class: "diff-title" }, "Action track vs. baseline"),
      h("span", { class: "diff-sub" },
        h("span", { class: "d-same" }, `${sum.same} same`), " · ",
        h("span", { class: "d-del" }, `${sum.del} removed`), " · ",
        h("span", { class: "d-add" }, `${sum.add} added`),
        state.manifest.baseline?.run_id ? `  ·  baseline ${state.manifest.baseline.run_id}` : ""),
    ),
    h("div", { class: "diff-cols" },
      h("div", { class: "diff-colhead" }, "baseline recording"),
      h("div", { class: "diff-colhead" }, "this performance"),
      ...ops.flatMap((o) => [diffCell(o.a, o.op === "add" ? "empty" : o.op), diffCell(o.b, o.op === "del" ? "empty" : o.op)]),
    ),
  );

  // divergence frame: first changed op that has a step in this run with a screenshot
  const div = ops.find((o) => o.op !== "same");
  if (div) {
    const frameEnv = ops.find((o) => o.op !== "same" && o.b?.artifacts?.screenshot)?.b;
    const note = sum.del || sum.add
      ? "The journey diverges here: the baseline action no longer matched, and the agent found a new path. If the run is green, the UI changed but the journey survived — review and bless."
      : "";
    if (frameEnv) {
      const img = h("img", { src: state.base + "/" + frameEnv.artifacts.screenshot, alt: "divergence frame" });
      img.addEventListener("error", () => img.remove());
      body.append(h("div", { class: "diff-frame" }, img,
        h("div", {},
          h("div", { class: "label" }, `first divergence — step ${frameEnv.step} of this run`),
          h("p", {}, note))));
    }
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

function renderInspectorStatic() {
  const insp = $("#inspector");
  insp.replaceChildren(
    h("div", { id: "sec-step" }),
    h("div", { id: "sec-tele" }),
    h("div", { id: "sec-net" }),
    h("div", { id: "sec-tok" }),
    renderGate(),
    renderGrade(),
    renderBrief(),
  );
}

function renderEmptyRun() {
  $("#sec-step").replaceChildren(sec("i-film", "steps", null,
    h("div", { class: "empty-note" }, "trajectory.jsonl is missing or empty — run-level panels below still apply")));
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

  // step section
  const kv = h("dl", { class: "kv" });
  const put = (k, v, cls) => { if (v != null && v !== "") kv.append(h("dt", {}, k), h("dd", { class: cls ?? "" }, v)); };
  put("result", env.result?.ok === false ? "failed" : "ok", env.result?.ok === false ? "err" : "ok");
  if (env.result?.error) put("error", env.result.error, "err");
  put("locator", env.resolution?.locator);
  if (env.agent?.action?.ref) put("ref", env.agent.action.ref);
  if (env.acted_from != null) put("acted from", "baseline step " + env.acted_from);
  if (a?.type === "done") put("summary", a.summary);
  if (a?.type === "give_up") put("reason", a.reason);
  if (env.confusion) put("confusion", `${env.confusion.type}${env.confusion.note ? " — " + env.confusion.note : ""}`, "err");

  $("#sec-step").replaceChildren(sec("i-film", `step ${env.step}`, env.mode === "act" ? "acted" : "agent",
    h("div", { class: "act-line" }, icon(d.icon), h("span", { class: "verb" }, d.verb), h("span", { class: "act-arg", title: d.arg ?? "" }, d.arg ?? "")),
    kv));

  // telemetry
  const p = env.perf ?? {};
  const grid = h("div", { class: "stat-grid" },
    stat("settle", fmtMs(env.result?.settle_ms)),
    stat("in → paint", p.input_to_paint_ms != null ? fmtMs(p.input_to_paint_ms) : "—", null, p.input_to_paint_ms == null ? "dim" : ""),
    stat("long tasks", p.long_tasks_ms != null ? fmtMs(p.long_tasks_ms) : "—", null, p.long_tasks_ms ? "" : "dim"),
    stat("requests", p.requests ?? 0, null, p.requests ? "" : "dim"),
    stat("js errors", p.js_errors ?? 0, null, (p.js_errors ?? 0) > 0 ? "bad" : "dim"),
    stat("mode", env.mode ?? "—", null, "dim"),
  );
  const teleKids = [grid];
  if (p.nav) {
    teleKids.push(h("div", { class: "nav-vitals" },
      h("span", { class: "chip accent" }, "navigation"),
      h("span", { class: "chip" }, `LCP ${fmtMs(p.nav.lcp_ms)}`),
      h("span", { class: "chip" }, `CLS ${p.nav.cls ?? "—"}`),
      h("span", { class: "chip" }, `TTFB ${fmtMs(p.nav.ttfb_ms)}`)));
  }
  $("#sec-tele").replaceChildren(sec("i-gauge", "telemetry", null, ...teleKids));

  // network waterfall
  $("#sec-net").replaceChildren(sec("i-net", "network", `${(env.artifacts?.har_entries ?? []).length} req`,
    renderWaterfall(env.artifacts?.har_entries ?? [])));

  // tokens
  $("#sec-tok").replaceChildren(renderTokens(env));
}

function renderWaterfall(indices) {
  const entries = indices.map((i) => state.har[i]).filter(Boolean);
  if (!entries.length) return h("div", { class: "empty-note" }, "no requests in this step’s window");

  const starts = entries.map((e) => Date.parse(e.startedDateTime) || 0);
  const t0 = Math.min(...starts);
  const total = Math.max(1, ...entries.map((e, i) => starts[i] - t0 + (e.time ?? 0)));

  const rows = entries.slice(0, 24).map((e, i) => {
    const bad = e._failed || (e.response?.status ?? 0) >= 400;
    const slow = !bad && (e.time ?? 0) > 500;
    const left = ((starts[i] - t0) / total) * 100;
    const width = Math.max(1.5, ((e.time ?? 0) / total) * 100);
    let path;
    try { path = new URL(e.request?.url ?? "", "http://x").pathname + (new URL(e.request?.url ?? "", "http://x").search || ""); }
    catch { path = e.request?.url ?? "?"; }
    return h("div", { class: "wf-row" },
      h("div", { class: "wf-top" },
        h("span", { class: "wf-method" }, e.request?.method ?? "GET"),
        h("span", { class: "wf-status" + (bad ? " bad" : "") }, String(e.response?.status ?? (e._failed ? "✕" : ""))),
        h("span", { class: "wf-url", title: e.request?.url ?? "" }, "‎" + path),
        h("span", { class: "wf-time" }, `${fmtBytes(e.response?.bodySize)} · ${fmtMs(e.time)}`)),
      h("div", { class: "wf-lane" },
        h("div", { class: "wf-bar" + (bad ? " bad" : slow ? " slow" : ""), style: `left:${left}%;width:${width}%` })));
  });
  return h("div", { class: "wf" }, ...rows);
}

function renderTokens(env) {
  if (!env.tokens) {
    return sec("i-token", "tokens", null,
      h("div", { class: "empty-note" }, env.mode === "act" ? "acted step — no model call" : "no token usage recorded"));
  }
  // cumulative through the current step
  const upto = state.steps.slice(0, state.cur + 1).reduce((acc, s) => {
    if (s.tokens) { acc.in += s.tokens.in ?? 0; acc.out += s.tokens.out ?? 0; acc.cache += s.tokens.cache_read ?? 0; }
    return acc;
  }, { in: 0, out: 0, cache: 0 });
  return sec("i-token", "tokens", `Σ ${fmtTokens(upto.in)} in / ${fmtTokens(upto.out)} out`,
    h("div", { class: "stat-grid" },
      stat("in", fmtTokens(env.tokens.in)),
      stat("out", fmtTokens(env.tokens.out)),
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

function renderGrade() {
  const g = state.grade;
  if (!g) return sec("i-gauge", "grade", null, h("div", { class: "empty-note" }, "not graded — grade.json absent"));
  const sevCls = { major: "fail", minor: "warn", info: "" };
  const findings = (g.findings ?? []).map((f) =>
    h("div", { class: "finding" },
      h("span", { class: "chip " + (sevCls[f.severity] ?? "") }, f.severity),
      h("p", {}, f.note + " ",
        f.step != null ? h("span", { class: "f-step", onclick: () => {
          const i = state.steps.findIndex((s) => s.step === f.step);
          if (i >= 0) select(i);
        } }, `→ step ${f.step}`) : null)));
  return sec("i-gauge", "grade", g.model ?? null,
    h("div", { class: "grade-top" },
      h("div", { class: "grade-score" }, String(Math.round(g.score)), h("small", {}, " / 100")),
      h("div", {},
        h("div", { style: "margin-bottom:4px" }, h("span", { class: "chip " + (g.completion === "full" ? "pass" : g.completion === "none" ? "fail" : "warn") }, "completion · " + g.completion)),
        g.efficiency?.wasted_steps != null ? h("div", { class: "empty-note" }, `${g.efficiency.wasted_steps} wasted step${g.efficiency.wasted_steps === 1 ? "" : "s"}`) : null)),
    g.efficiency?.assessment ? h("div", { class: "gate-detail", style: "margin-bottom:6px" }, g.efficiency.assessment) : null,
    ...findings,
    g.summary ? h("p", { class: "grade-summary" }, "“" + g.summary + "”") : null);
}

function renderBrief() {
  const c = state.manifest.case ?? {};
  return sec("i-eye", "the brief", c.persona ?? null,
    h("p", { class: "brief-story" }, (c.story ?? "").trim()),
    h("div", { class: "nav-vitals" },
      ...(c.tags ?? []).map((t) => h("span", { class: "chip" }, "#" + t))));
}

/* ---------- tabs + keys ---------- */

function setView(view) {
  if (view === "diff" && $("#tab-diff").hidden) return;
  state.view = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === view));
  $("#pane-stills").hidden = view !== "stills";
  $("#pane-a11y").hidden = view !== "a11y";
  $("#pane-video").hidden = view !== "video";
  $("#pane-diff").hidden = view !== "diff";
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
    else if (e.key === "v" || e.key === "V") setView(state.view === "a11y" ? "stills" : "a11y");
  });
}

boot();
