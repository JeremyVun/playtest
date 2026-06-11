// Playwright session: snapshot, execute, settle-v1, telemetry, artifacts. See docs/CONTRACTS.md §4.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { SETTLE, firstLine } from "./trajectory.js";
import { SNAPSHOT_SOURCE } from "./snapshot-injected.js";

const ACTION_TIMEOUT_MS = 5000;
const NAV_TIMEOUT_MS = 15000;
const SETTLE_POLL_MS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {object} ExecResult
 * @property {boolean} ok
 * @property {string|null} error
 * @property {{ref?: string, locator: string|null, bbox: object|null}|null} resolution
 * @property {number} settle_ms
 * @property {string|null} url page URL after the action settled
 * @property {{input_to_paint_ms: number|null, long_tasks_ms: number, requests: number,
 *             js_errors: number, nav: object|null}} perf
 * @property {number[]} har_entries
 */

// Init script, installed on every document: mutation timestamp for dom-quiet,
// longtask totals, and buffered nav-vitals (LCP/CLS) collectors. TTFB comes
// from the navigation timing entry at read time.
function initInstrumentation() {
  const d = (window.__dummy = { lastMutationAt: 0, longTasksMs: 0, lcp: null, cls: 0 });
  try {
    new MutationObserver(() => {
      d.lastMutationAt = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {}
  // The first input event after a perf window opens arms the input-to-paint
  // measurement: the double rAF then resolves at the first paint AFTER the
  // action's input, not at whatever frame happened to follow window-open.
  const arm = () => {
    const w = window.__dummyWin;
    if (!w || w.inputAt != null) return;
    w.inputAt = performance.now();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (window.__dummyWin === w) w.paint = performance.now() - w.inputAt;
      });
    });
  };
  for (const t of ["pointerdown", "mousedown", "keydown", "input", "wheel", "scroll"]) {
    window.addEventListener(t, arm, { capture: true, passive: true });
  }
  const observe = (type, fn) => {
    try {
      new PerformanceObserver(fn).observe({ type, buffered: true });
    } catch {}
  };
  observe("longtask", (l) => {
    for (const e of l.getEntries()) d.longTasksMs += e.duration;
  });
  observe("largest-contentful-paint", (l) => {
    const es = l.getEntries();
    if (es.length) d.lcp = es[es.length - 1].startTime;
  });
  observe("layout-shift", (l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) d.cls += e.value;
  });
}

// Per-action perf window, page side. The marker object doubles as a
// same-document token (gone after navigation -> the step navigated). The
// input-to-paint measurement itself is armed by the init script's input
// listeners (see initInstrumentation), so it spans input dispatch -> paint.
function openWindowInPage() {
  window.__dummyWin = { inputAt: null, paint: null };
  return window.__dummy ? window.__dummy.longTasksMs : 0;
}

function readWindowInPage() {
  const d = window.__dummy || {};
  const w = window.__dummyWin || null;
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    sameDoc: !!w,
    paint: w ? w.paint : null,
    longTasksMs: d.longTasksMs || 0,
    lcp: d.lcp == null ? null : d.lcp,
    cls: d.cls || 0,
    ttfb: nav ? nav.responseStart : null,
  };
}

// Durable locator candidates for an element, best first: testid > role+name >
// exact text > css path. Verified node-side; never throws into the page.
function locatorCandidatesInPage(el) {
  try {
    const out = [];
    const attrEsc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const seg = (n) => {
      let i = 1;
      let sib = n;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === n.tagName) i++;
      return n.tagName.toLowerCase() + ":nth-of-type(" + i + ")";
    };
    const pathFrom = (root, n) => {
      const segs = [];
      while (n && n !== root) {
        segs.unshift(seg(n));
        n = n.parentElement;
      }
      return segs.join(" > ");
    };

    const ownTid = el.getAttribute("data-testid");
    if (ownTid) out.push('[data-testid="' + attrEsc(ownTid) + '"]');

    const tag = el.tagName.toLowerCase();
    let role = (el.getAttribute("role") || "").trim().split(/\s+/)[0] || null;
    if (!role) {
      if (tag === "a") role = "link";
      else if (tag === "button") role = "button";
      else if (tag === "select") role = "combobox";
      else if (tag === "textarea") role = "textbox";
      else if (/^h[1-6]$/.test(tag)) role = "heading";
      else if (tag === "input") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "checkbox" || t === "radio") role = t;
        else if (t === "button" || t === "submit" || t === "reset" || t === "image") role = "button";
        else if (t === "range") role = "slider";
        else if (t === "number") role = "spinbutton";
        else if (t === "search") role = "searchbox";
        else role = "textbox";
      }
    }
    let name = el.getAttribute("aria-label") || "";
    if (!name && el.labels && el.labels.length) name = el.labels[0].textContent || "";
    if (!name) name = el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("title") || "";
    if (!name && tag === "input" && ["button", "submit", "reset"].includes(el.type)) name = el.value || "";
    if (!name) name = el.innerText || "";
    name = name.replace(/\s+/g, " ").trim();
    if (role && name && name.length <= 80 && !name.includes('"')) {
      out.push("role=" + role + '[name="' + name + '"]');
    }

    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text && text.length <= 80 && !text.includes('"')) out.push('text="' + text + '"');

    // Positional, so ranked below the semantic candidates: a path scoped to a
    // testid ancestor would silently re-resolve to a sibling after reordering.
    if (!ownTid) {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const tid = a.getAttribute("data-testid");
        if (tid) {
          out.push('[data-testid="' + attrEsc(tid) + '"] > ' + pathFrom(a, el));
          break;
        }
      }
    }

    if (el.id) {
      out.push("#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id));
    } else {
      const p = document.body ? pathFrom(document.body, el) : "";
      out.push(p ? "body > " + p : tag);
    }
    return out;
  } catch {
    return [];
  }
}

export class Session {
  /** @returns {Promise<Session>} */
  static async launch({ baseUrl, runDir, storageState = null, headed = false }) {
    fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
    const browser = await chromium.launch({ headless: !headed });
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        recordVideo: { dir: runDir, size: { width: 1280, height: 800 } },
        ...(storageState ? { storageState } : {}),
      });
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.addInitScript(initInstrumentation);
      const page = await context.newPage();
      const session = new Session({ baseUrl, runDir, browser, context, page });
      session.#cdp = await context.newCDPSession(page);
      return session;
    } catch (e) {
      // No Session exists yet for the caller to close; don't leak the process.
      await browser.close().catch(() => {});
      throw e;
    }
  }

  #browser;
  #context;
  #cdp = null;
  #runDir;
  #har = [];
  #reqInfo = new Map(); // request -> { index, startMs }
  #inflight = new Set();
  #lastNetAt = 0;
  #errors = 0; // console errors + pageerrors, run total

  constructor({ baseUrl, runDir, browser, context, page }) {
    this.baseUrl = baseUrl;
    this.page = page;
    this.#browser = browser;
    this.#context = context;
    this.#runDir = runDir;

    context.on("request", (req) => {
      this.#reqInfo.set(req, { index: this.#har.length, startMs: Date.now() });
      this.#har.push({
        startedDateTime: new Date().toISOString(),
        time: -1,
        request: { method: req.method(), url: req.url() },
        response: { status: 0, bodySize: -1, mimeType: "" },
        _failed: false,
      });
      this.#inflight.add(req);
      this.#lastNetAt = Date.now();
    });
    context.on("response", (resp) => {
      const info = this.#reqInfo.get(resp.request());
      if (!info) return;
      const e = this.#har[info.index];
      const headers = resp.headers();
      e.response.status = resp.status();
      e.response.mimeType = (headers["content-type"] || "").split(";")[0].trim();
      const len = parseInt(headers["content-length"], 10);
      e.response.bodySize = Number.isFinite(len) ? len : -1;
      this.#lastNetAt = Date.now();
    });
    const finish = (failed) => (req) => {
      const info = this.#reqInfo.get(req);
      if (info) {
        const e = this.#har[info.index];
        e.time = Date.now() - info.startMs;
        if (failed) e._failed = true;
      }
      this.#inflight.delete(req);
      this.#lastNetAt = Date.now();
    };
    context.on("requestfinished", finish(false));
    context.on("requestfailed", finish(true));

    page.on("console", (msg) => {
      if (msg.type() === "error") this.#errors++;
    });
    page.on("pageerror", () => {
      this.#errors++;
    });
  }

  /** Navigate relative to baseUrl; same measured path as a `navigate` action. */
  async goto(urlOrPath) {
    return this.#run({ type: "navigate", url: urlOrPath }, null, { locator: null, bbox: null });
  }

  /**
   * Inject the snapshot script (fresh data-dummy-ref numbering), write the
   * step's a11y text + screenshot + MHTML.
   * @returns {Promise<{text: string, url: string, title: string, refCount: number, truncated: boolean}>}
   */
  async captureSnapshot(stepNum) {
    const snap = await this.page.evaluate(SNAPSHOT_SOURCE);
    const url = this.page.url();
    const title = await this.page.title().catch(() => "");
    const p = this.#stepPaths(stepNum);
    fs.writeFileSync(p.a11y, snap.text + "\n");
    await this.page.screenshot({ path: p.screenshot }).catch(() => {});
    try {
      const { data } = await this.#cdp.send("Page.captureSnapshot", { format: "mhtml" });
      fs.writeFileSync(p.mhtml, data);
    } catch {}
    return { text: snap.text, url, title, refCount: snap.refCount, truncated: snap.truncated };
  }

  /**
   * Agent mode: validate the ref (exists/visible/enabled), compute the durable
   * locator + bbox, then execute inside a perf window. Never throws for
   * per-action problems.
   * @returns {Promise<ExecResult>}
   */
  async execute(action) {
    const type = action?.type;
    const needsElement = type === "click" || type === "type" || type === "select";
    if (!needsElement && !(type === "scroll" && action.ref)) {
      if (type === "scroll" || type === "navigate" || type === "wait") {
        return this.#run(action, null, { locator: null, bbox: null });
      }
      return this.#fail(`action type "${type}" is not executable`);
    }

    const ref = String(action.ref ?? "");
    if (!/^e\d+$/.test(ref)) return this.#fail(`invalid ref "${ref}"`);
    const loc = this.page.locator(`[data-dummy-ref="${ref}"]`);
    try {
      if ((await loc.count()) === 0) return this.#fail(`unknown ref "${ref}": not in the latest snapshot`);
      if (!(await loc.isVisible())) return this.#fail(`ref "${ref}" is not visible`);
      if (needsElement && !(await loc.isEnabled())) return this.#fail(`ref "${ref}" is disabled`);
    } catch (e) {
      if (this.page.isClosed()) throw e;
      return this.#fail(`validation failed for ref "${ref}": ${firstLine(e)}`);
    }
    const resolution = { ref, locator: await this.#durableLocator(loc, ref), bbox: await this.#bbox(loc) };
    return this.#run(action, loc, resolution);
  }

  /**
   * Act mode: re-execute a baseline envelope from its resolved locator.
   * @returns {Promise<ExecResult>}
   */
  async executeLocator(actedStep) {
    const action = actedStep.agent?.action ?? actedStep.action;
    if (!action) return this.#fail("acted step has no action");
    const locatorStr = actedStep.resolution?.locator ?? null;
    if (!locatorStr) {
      // navigate / wait / page-scroll steps carry no element locator
      return this.#run(action, null, { locator: null, bbox: null });
    }
    const loc = this.page.locator(locatorStr);
    try {
      const count = await loc.count();
      if (count === 0) return this.#fail(`baseline locator matched nothing: ${locatorStr}`);
      if (count > 1) return this.#fail(`baseline locator is ambiguous (${count} matches): ${locatorStr}`);
      if (!(await loc.isVisible())) return this.#fail(`baseline locator is not visible: ${locatorStr}`);
      if (["click", "type", "select"].includes(action.type) && !(await loc.isEnabled())) {
        return this.#fail(`baseline locator is disabled: ${locatorStr}`);
      }
    } catch (e) {
      if (this.page.isClosed()) throw e;
      return this.#fail(`baseline locator failed: ${firstLine(e)}`);
    }
    return this.#run(action, loc, { locator: locatorStr, bbox: await this.#bbox(loc) });
  }

  /** Total console errors + pageerrors so far (gate console_errors). */
  consoleErrors() {
    return this.#errors;
  }

  /** element_exists gate support. */
  async finalPageCheck(selector) {
    try {
      return (await this.page.locator(selector).count()) > 0;
    } catch {
      return false;
    }
  }

  async close() {
    this.#flushHar();
    const video = this.page.video();
    try {
      await this.#context.tracing.stop({ path: path.join(this.#runDir, "trace.zip") });
    } catch {}
    await this.#context.close().catch(() => {});
    if (video) {
      try {
        fs.renameSync(await video.path(), path.join(this.#runDir, "video.webm"));
      } catch {}
    }
    await this.#browser.close().catch(() => {});
  }

  // ---- internals ----

  /** Perform one action inside a perf window; always returns an ExecResult. */
  async #run(action, locator, resolution) {
    const harStart = this.#har.length;
    const errStart = this.#errors;
    let longTasksStart = 0;
    try {
      longTasksStart = await this.page.evaluate(openWindowInPage);
    } catch {}

    let error = null;
    try {
      await this.#perform(action, locator);
    } catch (e) {
      if (this.page.isClosed()) throw e;
      error = firstLine(e);
    }

    const settle_ms = await this.#settle();
    const win = await this.#readWindow();
    const navigated = action.type === "navigate" || !win.sameDoc;
    const harEntries = [];
    for (let i = harStart; i < this.#har.length; i++) harEntries.push(i);
    this.#flushHar();

    return {
      ok: !error,
      error,
      resolution,
      settle_ms,
      url: this.#pageUrl(),
      perf: {
        input_to_paint_ms: navigated || win.paint == null ? null : Math.round(win.paint),
        long_tasks_ms: Math.round(navigated ? win.longTasksMs : Math.max(0, win.longTasksMs - longTasksStart)),
        requests: harEntries.length,
        js_errors: this.#errors - errStart,
        nav: navigated
          ? {
              lcp_ms: win.lcp == null ? null : Math.round(win.lcp),
              cls: Math.round(win.cls * 1000) / 1000,
              ttfb_ms: win.ttfb == null ? null : Math.round(win.ttfb),
            }
          : null,
      },
      har_entries: harEntries,
    };
  }

  async #perform(action, locator) {
    switch (action.type) {
      case "click":
        return locator.click();
      case "type":
        await locator.fill(action.text);
        if (action.submit) await locator.press("Enter");
        return;
      case "select":
        try {
          await locator.selectOption({ label: action.value });
        } catch {
          await locator.selectOption(action.value);
        }
        return;
      case "scroll": {
        const dy = action.direction === "up" ? -600 : 600;
        if (locator) return locator.evaluate((el, d) => el.scrollBy(0, d), dy);
        return this.page.mouse.wheel(0, dy);
      }
      case "navigate":
        return this.page.goto(new URL(action.url, this.baseUrl).href, { waitUntil: "domcontentloaded" });
      case "wait": {
        const s = Math.min(10, Math.max(0.1, Number(action.seconds) || 1));
        return sleep(s * 1000);
      }
      default:
        throw new Error(`unknown action type "${action.type}"`);
    }
  }

  /**
   * settle-v1: wait until no tracked in-flight requests for net_quiet_ms AND
   * no DOM mutations for dom_quiet_ms, capped at max_ms. Returns elapsed ms.
   */
  async #settle() {
    const { dom_quiet_ms, net_quiet_ms, max_ms } = SETTLE;
    const start = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - start >= max_ms) return now - start;
      let domQuiet = false;
      try {
        const since = await this.page.evaluate(() => {
          const d = window.__dummy;
          return d ? performance.now() - d.lastMutationAt : 1e9;
        });
        domQuiet = since >= dom_quiet_ms;
      } catch (e) {
        if (this.page.isClosed()) throw e;
        // execution context destroyed mid-navigation: not quiet yet
      }
      // Net-quiet is checked AFTER the async DOM probe so a request that
      // started during the probe can't slip past a stale earlier reading.
      const netQuiet = this.#inflight.size === 0 && Date.now() - this.#lastNetAt >= net_quiet_ms;
      if (netQuiet && domQuiet) return Date.now() - start;
      await sleep(SETTLE_POLL_MS);
    }
  }

  async #readWindow() {
    try {
      let w = await this.page.evaluate(readWindowInPage);
      if (w.sameDoc && w.paint == null) {
        // double-rAF hasn't fired yet (instant settle); give it one frame
        await sleep(80);
        w = await this.page.evaluate(readWindowInPage);
      }
      return w;
    } catch {
      return { sameDoc: false, paint: null, longTasksMs: 0, lcp: null, cls: 0, ttfb: null };
    }
  }

  /** Best verified candidate: unique in the document and resolves to this ref. */
  async #durableLocator(loc, ref) {
    let candidates = [];
    try {
      candidates = await loc.evaluate(locatorCandidatesInPage);
    } catch {}
    for (const cand of candidates) {
      try {
        const l = this.page.locator(cand);
        if ((await l.count()) === 1 && (await l.getAttribute("data-dummy-ref")) === ref) return cand;
      } catch {}
    }
    if (candidates.length) return candidates[candidates.length - 1];
    // Last resort: a structural css path. Never data-dummy-ref — refs die with
    // the snapshot, so a baseline carrying one could never be replayed.
    try {
      return await loc.evaluate((el) => {
        const seg = (n) => {
          let i = 1;
          let sib = n;
          while ((sib = sib.previousElementSibling)) if (sib.tagName === n.tagName) i++;
          return n.tagName.toLowerCase() + ":nth-of-type(" + i + ")";
        };
        const segs = [];
        for (let n = el; n && n !== document.body; n = n.parentElement) segs.unshift(seg(n));
        return segs.length ? "body > " + segs.join(" > ") : "body";
      });
    } catch {
      return null;
    }
  }

  async #bbox(loc) {
    const b = await loc.boundingBox().catch(() => null);
    return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
  }

  #stepPaths(n) {
    const nnn = String(n).padStart(3, "0");
    const dir = path.join(this.#runDir, "steps");
    return {
      screenshot: path.join(dir, `${nnn}.png`),
      mhtml: path.join(dir, `${nnn}.mhtml`),
      a11y: path.join(dir, `${nnn}.a11y.txt`),
    };
  }

  #flushHar() {
    fs.writeFileSync(path.join(this.#runDir, "har.json"), JSON.stringify({ log: { entries: this.#har } }) + "\n");
  }

  #pageUrl() {
    try {
      return this.page.url();
    } catch {
      return null;
    }
  }

  #fail(error) {
    return {
      ok: false,
      error,
      resolution: null,
      settle_ms: 0,
      url: this.#pageUrl(),
      perf: { input_to_paint_ms: null, long_tasks_ms: 0, requests: 0, js_errors: 0, nav: null },
      har_entries: [],
    };
  }
}
