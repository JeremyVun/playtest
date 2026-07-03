// The `web` driver: Playwright session — snapshot, execute, settle-v1,
// telemetry, artifacts. The web implementation of the Driver interface
// (docs/CONTRACTS.md §4, §16). Relocated from src/harness/browser.js, which now
// re-exports this file for back-compat.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { SETTLE, firstLine, VISION_DRIFT_DEFAULT, actionOf, initialQuietMs } from "../trajectory.js";
import { SNAPSHOT_SOURCE } from "../snapshot-injected.js";
import { runAxeInPage } from "../axe-source.js";
import { overlayFor } from "./overlay.js";
import { MAX_BODY_CHARS, MAX_BODY_READ, capBody, isTextualMime, pathnameOf, flushHar, relativizeUrls, stripRefLines } from "./har.js";

const ACTION_TIMEOUT_MS = 5000;
const NAV_TIMEOUT_MS = 15000;
const SETTLE_POLL_MS = 50;

// Anthropic's vision sweet spot: images beyond this longest edge are
// downscaled server-side anyway, so cap what a vision run sends.
const VISION_MAX_EDGE = 1568;

// Default Chromium viewport (and video recording size). Overridable per suite
// via app.viewport; rides manifest.pins.viewport (comparability key).
// Default Chromium viewport. height: a number ⇒ viewport-only stills (what the
// user saw); null ⇒ full-page stills (whole scrollable page). When the height is
// null the browser context still needs a concrete height for layout + video size,
// so we fall back to FULL_PAGE_FOLD_HEIGHT for those.
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const FULL_PAGE_FOLD_HEIGHT = 720;
// Retain at most this many console/page error MESSAGES per run (the count stays
// exact past the cap); bounds a runaway error loop from bloating the trajectory.
const MAX_ERROR_LOG = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HAR body capture (MAX_BODY_CHARS/MAX_BODY_READ/capBody/isTextualMime/pathnameOf)
// + flushHar live in ./har.js, shared with the api driver. har.json captures
// request/response bodies + headers — text/JSON only, capped, and ONLY in
// har.json (never the embedded network.requests, so committed baselines stay
// jitter-free); it lives under runs/ (gitignored) and may carry auth headers.
// [UNREADABLE lines 41-70: scrolled past, not captured in any frame]
/**
 * dot) is HOST-ONLY: the cookie is sent to this exact host, NOT its subdomains,
 * and NOT across a redirect to a different host — strict() re-seeds for the
 * landed host to cover that (#reseedForLandedHost). Called with the base_url at
 * seed time and with the post-redirect page_url() when re-seeding, so host is
 * whichever URL is passed. Returns [] for a null/empty map or an unparseable
 * URL. Pure; exported for test.
 */
export function cookiesFor(cookies, baseUrl) {
  if (!cookies || typeof cookies !== "object") return [];
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return [];
  }
  return Object.entries(cookies).map(([name, value]) => ({ name, value: String(value), domain: host, path: "/" }));
}

/** PNG IHDR dimensions (width/height at bytes 16-23, big-endian); null when not a PNG. */
export function pngDimensions(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The second drift channel's tuning knob default (re-exported so the driver's
// own home and config.js can both import VISION_DRIFT_DEFAULT from here).
export { VISION_DRIFT_DEFAULT };

/**
 * Hamming distance between two 16-hex-char dHash strings (a 64-bit perceptual
 * hash): the count of differing bits, 0-64. Returns 64 (maximally different) on
 * any malformed input — a missing/short/non-hex hash reads as full drift rather
 * than a silent match. Pure; exported for test.
 */
export function hammingDistance(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) {
    return 64;
  }
  let bits = 0;
  // Compare in two 32-bit halves to avoid BigInt; popcount each XORed half.
  for (const [lo, hi] of [[0, 8], [8, 16]]) {
    let x = (parseInt(a.slice(lo, hi), 16) ^ parseInt(b.slice(lo, hi), 16)) >>> 0;
    while (x) {
      bits += x & 1;
      x >>>= 1;
    }
  }
  return bits;
}

/** Visual-drift decision for the act-replay loop's pixel channel (§10): null
 * (NO drift) when EITHER hash is absent — the no-oracle guard, mirroring the
 * a11y snapshot_text legacy guard so a baseline recorded without a pixel oracle
 * skips the channel — else a human note when the Hamming distance EXCEEDS the
 * threshold. Quantized (threshold, not pixel-exact) so antialiasing / cursor /
 * compositor jitter doesn't read as drift. Pure; exported for test.
 */
export function visualDriftReason(nowHash, wasHash, threshold = VISION_DRIFT_DEFAULT) {
  if (typeof nowHash !== "string" || typeof wasHash !== "string") return null;
  const dist = hammingDistance(nowHash, wasHash);
  if (dist <= threshold) return null;
  return `the page looks different under the recorded action: the screenshot diverged from the baseline visually (perceptual-hash
  distance ${dist} > ${threshold})`;
}
/**
 * @typedef {object} ExecResult
// [UNREADABLE lines 137-148: scrolled past, not captured in any frame]
 */

// Init script, installed on every document: mutation timestamp for dom-quiet,
// longtask totals, and buffered nav-vitals (LCP/FCP/CLS) collectors. TTFB comes
// from the navigation timing entry at read time.
function initInstrumentation() {
  const d = (window.__dummy = { lastMutationAt: 0, longTasksMs: 0, lcp: null, cls: 0, fcp: null });
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
    if (!w || w.inputAt !== null) return;
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
  observe("paint", (l) => {
    for (const e of l.getEntries()) if (e.name === "first-contentful-paint") d.fcp = e.startTime;
  });
  observe("layout-shift", (l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) d.cls += e.value;
  });
}

// Per-action perf window, page side. The marker object doubles as a
// same-document token (gone after navigation → the step navigated). The
// input-to-paint measurement itself is armed by the init script's input
// listeners (see initInstrumentation), so it spans input dispatch → paint.
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
    lcp: d.lcp === null ? null : d.lcp,
    fcp: d.fcp === null ? null : d.fcp,
    cls: d.cls || 0,
    ttfb: nav ? nav.responseStart : null,
  };
}

// No-ref scroll, page side: scroll the element the user would actually scroll
// by `dy` px. A modal keeps its body in its own overflow container, so a
// window-level wheel moves nothing — we instead prefer the topmost OPEN dialog's
// scrollable subtree, then the largest scrollable element under the viewport
// centre, then the document. Returns true if it found a real scroller (an
// element whose scrollHeight exceeds its client height and that isn't pinned at
// the travel limit in the scroll direction), false to let the caller fall back.
function pickScrollTarget(dy) {
  const canScroll = (el) => {
    if (!el || el === document.documentElement || el === document.body) return false;
    if (el.scrollHeight - el.clientHeight <= 1) return false;
    const s = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
    // Pinned at the limit in this direction can't move — keep looking.
    if (dy > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    return el.scrollTop > 0;
  };
  // Largest scrollable element in a subtree (modal bodies often wrap the
  // moved-in div (one level below the [role=dialog] node itself).
  const bestIn = (root) => {
    let best = null;
    let bestArea = 0;
    const walk = (el) => {
      if (canScroll(el)) {
        const a = el.clientWidth * el.clientHeight;
        if (a > bestArea) {
          best = el;
          bestArea = a;
        }
      }
      for (const c of el.children) walk(c);
    };
    walk(root);
    return best;
  };
  // Topmost open dialog first (last in DOM order ~ stacked on top).
  const dialogs = [...document.querySelectorAll('[role="dialog"], dialog[open]')];
  let target = null;
  for (let i = dialogs.length - 1; i >= 0 && !target; i--) target = bestIn(dialogs[i]);
  // Else the largest scrollable element overlapping the viewport centre.
  if (!target) {
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    for (const el of document.elementsFromPoint(cx, cy)) {
      if (canScroll(el)) {
        target = el;
        break;
      }
    }
  }
  if (!target) target = bestIn(document.body);
  if (!target) return false;
  target.scrollBy(0, dy);
  return true;
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

export class WebDriver {
  /** @returns {Promise<WebDriver>} */
  static async launch({ baseUrl, runDir, storageState = null, headed = false, settle = null, viewport = null, deviceScaleFactor = null, cookies = null }) {
    fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
    // The viewport is the shape that decides whether height may be null (full-page
    // capture); it rides in pins.viewport (so a full-page run is
    // not comparable to a viewport-only one). The Playwright context needs a
    // concrete height regardless, so fold-height stands in when capture is full.
    const vp = viewport ?? DEFAULT_VIEWPORT;
    // A null height means full-page capture; the Playwright context still needs a
    // concrete height, so fold-height stands in (captureSnapshot re-derives the
    // full-page flag from this.#viewport.height).
    const contextViewport = { width: vp.width, height: vp.height ?? FULL_PAGE_FOLD_HEIGHT };
    // DPI multiplier for crisper step stills (app.device_scale_factor); default
    // 1. Higher = denser PNG. Not a manifest pin (pure rendering quality knob).
    const dsf = deviceScaleFactor ?? 1;
    // PLAYTEST_BROWSER_CHANNEL: opt-in system-browser channel (e.g. "chrome")
    // for unmeasured commands like the demo; unset = pinned chromium. No live
    // screencast is recorded at all — the shareable video.mp4 is a post-run
    // slideshow stitched from the per-step stills (runner.js + clip.js), so the
    // run never holds a 30-minute mostly-frozen recording.
    const channel = process.env.PLAYTEST_BROWSER_CHANNEL;
    const browser = await chromium.launch({ headless: !headed, ...(channel && { channel }) });
    try {
      const context = await browser.newContext({
        viewport: contextViewport,
        deviceScaleFactor: dsf,
        ...(storageState ? { storageState } : {}),
      });
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      // Seed app.cookies against base_url's origin BEFORE the first navigation,
      // so start() → goto(baseUrl) already carries them on the opening request
      // (no load-then-inject-then-refresh dance). The `url` form lets Playwright
      // derive domain/path; a session input like storage_state, not a pin.
      const cookieList = cookiesFor(cookies, baseUrl);
      if (cookieList.length) await context.addCookies(cookieList);
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.addInitScript(initInstrumentation);
      const page = await context.newPage();
      const session = new WebDriver({ baseUrl, runDir, browser, context, page, settle, viewport: vp });
      // When cookies route to a blue/green slot, the FIRST cold document hit can
      // serve a stale edge-cached HTML referencing chunk hashes that 404 (the
      // page renders unstyled and never hydrates); a warm second hit is correct.
      // Mirror the human "set the cookie, reload, it works" path: start() does a
      // throwaway warm-up navigation before the measured one. Gated on cookies —
      // so cookieless load (the web golden control) is byte-for-byte unchanged.
      session.#warmReload = cookieList.length > 0;
      // Keep the raw map so start() can re-seed for the post-redirect host (the
      // cookie is scoped to base_url's host only, so a redirect to another host
      // would otherwise drop it — see #reseedForLandedHost).
      session.#cookies = cookieList.length ? cookies : null;
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
  #harCursor = 0; // end of the previous step's HAR window (see #run)
  #reqInfo = new Map(); // request → { index, startMs }
  #inflight = new Set();
  #lastNetAt = 0;
  // Console errors + pageerrors. #errorCount is the authoritative run total the
  // gate compares against (console_errors: N) — always exact. #errorLog retains
  // the messages so the gate/viewer can show them expandably ({type:
  // "console"|"pageerror", text}), but is bounded (text-capped, MAX_ERROR_LOG
  // entries) so a runaway error loop can't bloat the trajectory — past the cap we
  // keep counting but stop retaining. Each step slices its own errors off #errorLog.
  #errorCount = 0;
  #errorLog = [];
  #recordingStopped = false;
  // After stopRecording the gate's element_exists/finalUrl are served from a
  // check page that re-hosts the final captured DOM (the live page keeps
  // running for the slow gate/grader/manifest tail — see CONTRACTS §10/§7).
  #checkPage = null;
  #checkContext = null;
  #checkUrl = null;
  // Resolved settle policy: settle-v1 defaults with any app.settle overrides
  // merged in. Rides manifest.pins.settle (part of the comparability key).
  #settlePolicy;
  // The first #settle() of a session (initial page load) uses a longer quiet
  // window (initialQuietMs) so a lagging SPA doesn't settle on a blank page.
  #firstSettle = true;
  // Resolved Chromium viewport (app.viewport or DEFAULT_VIEWPORT). Rides
  // manifest.pins.viewport (part of the comparability key).
  #viewport;
  #warmReload = false; // [reconstruction: inserted to balance block; original line(s) not recoverable]
  #cookies = null; // [reconstruction: inserted to balance block; original line(s) not recoverable]
// [UNREADABLE lines 450-553: scrolled past, not captured in any frame]
  /**
   * markers, text — is exactly the behavioral surface the actor chose its action
   * against, so a behaviorally-changed element diverges and heals.
   *
   * `base` lets the caller relativize against a DIFFERENT base than this live
   * driver's — the act loop passes the baseline's recording-time base for the
   * baseline side and the live base for the captured side, so a deployment path
   * prefix (t2's `/retail/netbank`) collapses on both sides. Defaults to this
   * driver's own baseUrl (the same-base case: same-run confusion checks).
   */
  normalizeSnapshot(text, base = this.baseUrl) {
    return normalizeWebSnapshot(text, base);
  }

  /** Actor system overlay + the action sub-schemas valid for this transport. */
  get overlay() {
    return overlayFor("web");
  }

  // ---- Driver interface: lifecycle ----

  /** Open the app to its entry state; the returned perf+network seed the gate. */
  async start() {
    // Cookie-routed slots: warm the document once (unmeasured) so the measured
    // navigation below sees the slot's consistent, hydrated page rather than a
    // stale cold-hit HTML whose chunk hashes 404. Best-effort; a failure here
    // just leaves the measured goto to load cold as before.
    if (this.#warmReload) {
      try {
        await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
        await this.#settle();
        // If base_url redirected to a DIFFERENT host (a www↔apex 301, a blue/green
        // slot on another subdomain), the seeded cookies — scoped host-only to
        // base_url's host — were withheld at the hop and never reached the app. Add
        // them for the landed host too, then warm once more so the measured goto
        // below rides them through the redirect onto the correctly-routed slot.
        if (await this.#reseedForLandedHost()) {
          await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
          await this.#settle();
        }
      } catch {}
      // The warm-up's requests are already in #har (auditable in har.json), but
      // they are UNMEASURED — advance the cursor past them so the first measured
      // step's network.requests starts clean at the measured goto below. In the
      // finally-position (outside the try) so a warm-up that partially loaded still
      // doesn't leak its requests into the measured window.
      this.#harCursor = this.#har.length;
    }
    return this.goto(this.baseUrl);
  }

  /**
   * After the warm-up navigation, re-seed the app.cookies for the host the page
   * actually LANDED on when base_url redirected across hosts. addCookies scopes
   * each cookie host-only (explicit domain, no leading dot), so a cookie set for
   * base_url's host is NOT sent to a different host after a redirect (www↔apex,
   * a slot on another subdomain) — the app then loads on the wrong slot. Adding
   * the same cookies for the landed host lets the next navigation carry them
   * through the redirect. Returns true when it added cookies (caller warms
   * again), false when there was nothing to do (no cookies, unparseable URL, or
   * the landed host already matches base_url's). Best-effort; never throws.
   */
  async #reseedForLandedHost() {
    if (!this.#cookies) return false;
    let landedHost, baseHost;
    try {
      landedHost = new URL(this.page.url()).hostname;
      baseHost = new URL(this.baseUrl).hostname;
    } catch {
      return false;
    }
    if (!landedHost || landedHost === baseHost) return false;
    // Reuse cookiesFor (host-only paths) against the landed URL so the
    // domain is the redirect target. Absent/empty map already returned above.
    const list = cookiesFor(this.#cookies, this.page.url());
    if (!list.length) return false;
    try {
      await this.#context.addCookies(list);
    } catch {
      return false;
    }
    return true;
  }
// [UNREADABLE lines 636-679: scrolled past, not captured in any frame]
  // [reconstruction: inserted to balance block; captureSnapshot(stepNum) opening
  // and the snap/url derivation preceding this line were lost in the UNREADABLE
  // seam above — signature restored from the Driver contract (driver.js), the
  // dropped body lines are not recoverable]
  async captureSnapshot(stepNum) {
    const title = await this.page.title().catch(() => "");
    const p = this.#stepPaths(stepNum);
    fs.writeFileSync(p.a11y, snap.text + "\n");
    // Capture mode follows app.viewport.height: a null height => fullPage (the
    // whole scrollable page - good for debugging scroll / marketing shots); a
    // number => viewport-only (exactly what the user saw, content below the fold
    // cut off). Drives BOTH this on-disk PNG and the vision image returned below.
    const fullPage = this.#viewport.height == null;
    let screenshot = await this.page.screenshot({ fullPage }).catch(() => null);
    // The perceptual hash (visual regression's pixel oracle) is computed from the
    // FULL-SIZE bytes BEFORE #capImage downscales them, so the hash is stable
    // regardless of whether a vision run also shrinks the model-facing image.
    let screenshotHash = null;
    if (screenshot) {
      // The perceptual hash is computed from the in-memory bytes regardless of the
      // disk write. But if the PNG write FAILS, drop screenshot so artifactFlags
      // (runner.js) doesn't claim artifacts/screenshots for a file that isn't on
      // disk — otherwise the viewer/clip would seek to a missing frame.
      let wrote = true;
      try {
        fs.writeFileSync(p.screenshot, screenshot);
      } catch {
        wrote = false;
      }
      screenshotHash = await this.#computeDHash(screenshot);
      screenshot = wrote ? await this.#capImage(screenshot) : null;
    }
    try {
      const { data } = await this.#cdp.send("Page.captureSnapshot", { format: "mhtml" });
      fs.writeFileSync(p.mhtml, data);
    } catch {}
    // Debug-only: the browser's NATIVE a11y tree (Chromium's full AX tree via
    // CDP — nothing filtered, so gaps in OUR custom snapshot show up). Flattened
    // into the SAME `role "name"` line shape as snap.text so the viewer can diff
    // the two side-by-side. Never seen by the agent, never part of snap.text or
    // the return value — best-effort, never breaks a run. (page.accessibility was
    // removed in modern Playwright, hence CDP.)
    try {
      const tree = await this.#nativeAxTree();
      if (tree) fs.writeFileSync(p.pw_a11y, tree + "\n");
    } catch {}
    return { text: snap.text, url, title, refCount: snap.refCount, truncated: snap.truncated, screenshot, screenshotHash };
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
      if (type === "scroll" || type === "navigate" || type === "wait" || type === "back") {
        return this.#run(action, null, { locator: null, bbox: null });
      }
      return this.#fail(`action type "${type}" is not executable`);
    }

    const ref = String(action.ref ?? "");
    if (!/^\d+$/.test(ref)) return this.#fail(`invalid ref "${ref}"`);
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
    const action = actionOf(actedStep);
    if (!action) return this.#fail("acted step has no action");
    const locatorStr = actedStep.resolution?.locator ?? null;
    if (!locatorStr) {
      // navigate / page-scroll steps carry no element locator
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

  /**
   * Run axe-core full-page against the CURRENT settled page. The done/give_up
   * terminal steps take no action so they never enter #run (where the per-action
   * axe capture lives) — yet the page the actor read to declare success/failure
   * is a real, gradeable surface. The runner calls this on those steps so their
   * WCAG state is captured too (else a run that finishes from its opening page
   * carries NO axe at all → grade.a11y is dropped). Best-effort, mirroring #run:
   * a throw is swallowed and null is returned, so the envelope simply carries no
   * `axe`.
   * @returns {Promise<{ violations: object[], counts: { total: number } }|null>}
   */
  async captureAxe() {
    try {
      const result = await runAxeInPage(this.page);
      if (result && Array.isArray(result.violations)) return result;
    } catch {}
    return null;
  }

  /** Total console errors + pageerrors so far (gate console_errors). */
  consoleErrors() {
    return this.#errorCount;
  }

  /** The captured console/page error messages so far (gate detail + viewer). */
  consoleErrorLog() {
    return this.#errorLog;
  }

  // Record one console/page error. The count is always exact; messages are
  // retained text-capped up to MAX_ERROR_LOG entries (past that we keep counting
  // but stop retaining, so a runaway error loop can't bloat the trajectory).
  #pushError(type, text) {
    this.#errorCount++;
    if (this.#errorLog.length < MAX_ERROR_LOG) this.#errorLog.push({ type, text: capBody(text ?? "") });
  }

  /**
   * Capture the final settled DOM the instant the actor loop finishes, BEFORE
   * the gate runs. No live screencast is recorded anymore (the shareable
   * video.mp4 is a post-run slideshow of the stills), so this no longer
   * finalizes a video — it only captures the run-dir-level final.* artifacts and
   * re-hosts the final DOM in a fresh check page.
   *
   * The only gate check that needs the live page is element_exists
   * (finalPageCheck), so we re-host the final settled DOM in a fresh check page
   * and repoint finalPageCheck/location at it. Idempotent; best-effort artifacts.
   */
  async stopRecording() {
    if (this.#recordingStopped) return;
    this.#recordingStopped = true;

    let html = "";
    try {
      html = await this.page.content();
    } catch {}
    try {
      this.#checkUrl = this.#pageUrl();
    } catch {}

    // Run-dir-level final.* artifacts for the viewer/debugging — NOT steps/NNN.*
    // (no step/trajectory collision). Best-effort; never throws.
    try {
      const snap = await this.page.evaluate(SNAPSHOT_SOURCE);
      fs.writeFileSync(path.join(this.#runDir, "final.a11y.txt"), snap.text + "\n");
    } catch {}
    try {
      const { data } = await this.#cdp.send("Page.captureSnapshot", { format: "mhtml" });
      fs.writeFileSync(path.join(this.#runDir, "final.mhtml"), data);
    } catch {}

    // A fresh context+page on the same browser holds the final DOM so
    // element_exists keeps the same Playwright locator engine (shadow-DOM
    // fidelity caveat: setContent rebuilds light DOM only).
    try {
      // #viewport.height may be null (full-page capture); newContext rejects a
      // null height, so fold-height stands in — the same substitution launch()
      // makes for the live context. Without this the check context throws for
      // every full-page run and #checkPage silently stays null.
      const checkViewport = { width: this.#viewport.width, height: this.#viewport.height ?? FULL_PAGE_FOLD_HEIGHT };
      this.#checkContext = await this.#browser.newContext({ viewport: checkViewport });
      this.#checkPage = await this.#checkContext.newPage();
      await this.#checkPage.setContent(html, { waitUntil: "domcontentloaded" });
    } catch {
      this.#checkPage = null;
    }
  }

  /** element_exists gate support. After stopRecording, prefer the check page that
   *  re-hosts the captured final DOM; else fall back to the live page (which stays
   *  open through the gate tail — channel/no-video path, or one that never called
   *  stopRecording). */
  async finalPageCheck(selector) {
    const target = this.#checkPage ?? this.page;
    try {
      return (await target.locator(selector).count()) > 0;
    } catch {
      return false;
    }
  }

  async close() {
    this.#flushHar();
    try {
      await this.#context.tracing.stop({ path: path.join(this.#runDir, "trace.zip") });
    } catch {}
    await this.#checkContext?.close().catch(() => {});
    await this.#context.close().catch(() => {});
    await this.#browser.close().catch(() => {});
  }

  // ---- internals ----

  /** Perform one action inside a perf window; always returns an ExecResult. */
  async #run(action, locator, resolution) {
    // HAR/network windows are contiguous: each starts where the previous
    // step's ended, so requests landing between steps (agent think time)
    // attribute to the NEXT step. Tail requests after the final step stay
    // only in har.json.
    const harStart = this.#harCursor;
    // perf.requests counts only requests started at/after action dispatch:
    // think-time requests belong in the step's HAR/network window but must not
    // mask the no_effect heuristic (perf.requests === 0) or skew perf data.
    const perfStart = this.#har.length;
    const errStart = this.#errorCount; // exact per-step count (js_errors)
    const errLogStart = this.#errorLog.length; // messages captured this step (may lag the count past the cap)
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
      // Always-on a11y capture: run axe-core full-page against the freshly-settled
      // page (the user-visible state AFTER the action), counting every WCAG
      // violation on the page. Best-effort — never throws out, never enters the
      // actor prompt, so the web golden control stays byte-identical (axe rides
      // only the ExecResult, attached by the runner).
      let axe = null;
      try {
        const result = await runAxeInPage(this.page);
        if (result && Array.isArray(result.violations)) axe = result;
      } catch {}
      const win = await this.#readWindow();
      // A back that actually changed documents is nav-attributed via !sameDoc; a
      // no-op / same-document back keeps windowed perf (no stale page-load vitals).
      const navigated = action.type === "navigate" || !win.sameDoc;
      // Embedded network data carries stable fields only (no timings/sizes —
      // they jitter committed baselines); har.json keeps the rich detail. Known
      // freeze: a request still pending at settle embeds status 0 even if it
      // completes later — har.json shows the real status.
      const harEntries = [];
      const requests = [];
      const harEnd = this.#har.length;
      for (let i = harStart; i < harEnd; i++) {
        harEntries.push(i);
        const e = this.#har[i];
        requests.push({
          method: e.request.method,
          url: e.request.url,
          // pathname only: api_called globs like "/api/todos*" match paths, not
          // full URLs. Raw string fallback when the URL doesn't parse.
          path: pathnameOf(e.request.url),
          status: e.response.status,
          mime_type: e.response.mimeType,
          failed: e._failed,
        });
      }
      this.#harCursor = harEnd;
      this.#flushHar();

      return {
        ok: !error,
        error,
        resolution,
        settle_ms,
        url: this.#pageUrl(),
        perf: {
          input_to_paint_ms: navigated || win.paint === null ? null : Math.round(win.paint),
          long_tasks_ms: Math.round(navigated ? win.longTasksMs : Math.max(0, win.longTasksMs - longTasksStart)),
          requests: Math.max(0, harEnd - perfStart),
          js_errors: this.#errorCount - errStart,
          nav: navigated
            ? { lcp_ms: win.lcp === null ? null : Math.round(win.lcp),
                fcp_ms: win.fcp === null ? null : Math.round(win.fcp),
                cls: Math.round(win.cls * 1000) / 1000,
                ttfb_ms: win.ttfb === null ? null : Math.round(win.ttfb),
              }
            : null,
        },
        har_entries: harEntries,
        network: requests,
      network: { requests },
      // web-only a11y capture; absent when axe failed/was empty-of-violations is
      // STILL present (counts: {total:0}). Conditional only on capture success so
      // a failed-axe ExecResult is shaped exactly as before.
      ...(axe ? { axe } : {}),
      // Console/page errors captured during THIS step's window (the viewer's
      // per-step expandable list). Conditional so a clean step's envelope stays
      // byte-identical — the web golden control never carries this key.
      ...(this.#errorLog.length > errLogStart ? { console_errors: this.#errorLog.slice(errLogStart) } : {}),
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
        // No ref: scroll the element the user would actually scroll. A modal's
        // content lives in its own overflow container, so window-level wheel
        // events move nothing (the page that produced this code's "five scrolls,
        // zero change" repeated-action confusion). Pick the topmost open dialog's
        // scroller, else the largest scrollable element over the viewport centre,
        // else the window. Returns false only when nothing scrollable was found.
        const scrolled = await this.page.evaluate(pickScrollTarget, dy);
        if (!scrolled) await this.page.mouse.wheel(0, dy);
        return;
      }
      case "navigate":
        return this.page.goto(new URL(action.url, this.baseUrl).href, { waitUntil: "domcontentloaded" });
      case "back":
        // Browser back button. goBack() resolves to null (no throw) at history
        // start — a benign no-op (url unchanged, ok:true), matching mobile back.
        return this.page.goBack({ waitUntil: "domcontentloaded" });
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
   * The FIRST settle of the session (initial page load) requires a longer quiet
   * window on BOTH dom and net (initialQuietMs, capped at max_ms) so a lagging
   * SPA's delayed first fetch/render can reset the timer instead of settling on
   * the blank shell.
   */
  async #settle() {
    const { dom_quiet_ms, net_quiet_ms, max_ms, initial_quiet_ms } = this.#settlePolicy;
    const first = this.#firstSettle;
    this.#firstSettle = false;
    const domWin = first ? Math.min(initialQuietMs(dom_quiet_ms, initial_quiet_ms), max_ms) : dom_quiet_ms;
    const netWin = first ? Math.min(initialQuietMs(net_quiet_ms, initial_quiet_ms), max_ms) : net_quiet_ms;
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
        domQuiet = since >= domWin;
      } catch (e) {
        if (this.page.isClosed()) throw e;
        // execution context destroyed mid-navigation: not quiet yet
      }
      // Net-quiet is checked AFTER the async DOM probe so a request that
      // started during the probe can't slip past a stale earlier reading.
      const netQuiet = this.#inflight.size === 0 && Date.now() - this.#lastNetAt >= netWin;
      if (netQuiet && domQuiet) return Date.now() - start;
      await sleep(SETTLE_POLL_MS);
    }
  }

  async #readWindow() {
    try {
      let w = await this.page.evaluate(readWindowInPage);
      if (w.sameDoc && w.paint === null) {
        // double-rAF hasn't fired yet (instant settle); give it one frame
        await sleep(80);
        w = await this.page.evaluate(readWindowInPage);
      }
      return w;
    } catch {
      return { sameDoc: false, paint: null, longTasksMs: 0, lcp: null, fcp: null, cls: 0, ttfb: null };
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

  /**
   * Downscale a PNG whose longest edge exceeds VISION_MAX_EDGE, via the live
   * page's canvas (no native image dependency). Full-page captures of a tall
   * page commonly exceed the cap, so this fires for them; falls back to the
   * original bytes on any failure.
   */
  async #capImage(buf) {
    const dim = pngDimensions(buf);
    if (!dim || Math.max(dim.width, dim.height) <= VISION_MAX_EDGE) return buf;
    try {
      const dataUrl = await this.page.evaluate(async ({ src, cap }) => {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = src;
        });
        const scale = cap / Math.max(img.width, img.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      }, { src: `data:image/png;base64,${buf.toString("base64")}`, cap: VISION_MAX_EDGE });
      return Buffer.from(dataUrl.split(",")[1], "base64");
    } catch {
      return buf;
    }
  }

  /**
   * Perceptual difference-hash (dHash) of a PNG buffer, the visual_regression
   * pixel oracle. Mirrors #capImage's page-canvas trick (no native image dep):
   * push the PNG into the live page, draw it onto a tiny 9×8 canvas, read the
   * grayscale pixels, then for each of the 8 rows compare the 8 adjacent column
   * pairs L→R (a bit set when the left pixel is brighter) — 8×8 = 64 bits. The
   * 9×8 downscale + adjacent-gradient comparison is the QUANTIZATION that makes
   * the hash robust to antialiasing / cursor / compositor jitter. Bits pack into
   * two unsigned 32-bit halves (avoid BigInt across the bridge), returned as a
   * 16-char lowercase hex string. try/catch → null; never blocks a run.
   */
  async #computeDHash(buf) {
    try {
      return await this.page.evaluate(async (src) => {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = src;
        });
        const W = 9;
        const H = 8;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, W, H);
        const { data } = ctx.getImageData(0, 0, W, H);
        const gray = (x, y) => {
          const i = (y * W + x) * 4;
          return (data[i] + data[i + 1] + data[i + 2]) / 3;
        };
        let hi = 0;
        let lo = 0;
        let n = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W - 1; x++) {
            const bit = gray(x, y) > gray(x + 1, y) ? 1 : 0;
            if (n < 32) hi = (hi << 1) | bit;
            else lo = (lo << 1) | bit;
            n++;
          }
        }
        const hex = (v) => (v >>> 0).toString(16).padStart(8, "0");
        return hex(hi) + hex(lo);
      }, `data:image/png;base64,${buf.toString("base64")}`);
    } catch {
      return null;
    }
  }

  async #bbox(loc) {
    const b = await loc.boundingBox().catch(() => null);
    return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
  }

  /**
   * Chromium's full native accessibility tree via CDP (Accessibility.getFullAXTree),
   * flattened (document order, DFS) into the SAME `role "name"` line shape our custom
   * snapshot uses — so the viewer can lay the two side-by-side as an eyeballable diff
   * and the gaps in OUR filter jump out. Debug-only, NOT seen by the agent. The native
   * tree carries no `[eN]` refs (those are ours), so lines here are ref-less. `ignored`
   * and nameless generic/none/presentation containers are dropped (pure noise that has
   * no counterpart in the custom view). value/checked/disabled states are appended like
   * the custom renderer so equivalent controls render identical strings. Best-effort:
   * returns null on any failure (never blocks a run).
   */
  async #nativeAxTree() {
    if (!this.#cdp) return null;
    await this.#cdp.send("Accessibility.enable").catch(() => {});
    const { nodes } = await this.#cdp.send("Accessibility.getFullAXTree");
    if (!Array.isArray(nodes) || nodes.length === 0) return null;
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const prop = (n, name) => (n.properties ?? []).find((p) => p.name === name)?.value?.value;
    const clean = (s) => (s === null ? "" : String(s)).replace(/\s+/g, " ").trim().replace(/"/g, "'");
    // Roles dropped entirely: InlineTextBox/LineBreak are sub-text fragments that
    // duplicate their StaticText parent. Unnamed structural containers (generic/
    // none/presentation) have no counterpart in the custom (interactive/text-only)
    // snapshot, so dropping them keeps the diff honest.
    const DROP = new Set(["InlineTextBox", "LineBreak"]);
    const SKIP_UNNAMED = new Set(["generic", "none", "presentation", "GenericContainer"]);

    const lines = [];
    let lastText = "";
    const visit = (n) => {
      if (!n) return;
      const role = n.role?.value ?? "";
      const name = clean(n.name?.value);
      const skip = n.ignored || DROP.has(role) || (!name && SKIP_UNNAMED.has(role));
      if (!skip && role) {
        // StaticText → the same `text: "..."` shape the custom snapshot uses, deduped
        // against the immediately-preceding text line (the custom renderer dedups too).
        if (role === "StaticText") {
          if (name && name !== lastText) { lines.push(`text: "${name}"`); lastText = name; }
        } else {
          let line = `${role} "${name}"`;
          const v = clean(n.value?.value);
          if (v) line += ` value="${v}"`;
          const checked = prop(n, "checked");
          if (checked === "true" || checked === true) line += " (checked)";
          else if (checked === "false" || checked === false) line += " (unchecked)";
          if (prop(n, "disabled") === true) line += " (disabled)";
          if (prop(n, "focused") === true) line += " (focused)";
          lines.push(line);
        }
      }
      for (const id of n.childIds ?? []) visit(byId.get(id));
    };
    const childOf = new Set(nodes.flatMap((n) => n.childIds ?? []));
    const root = nodes.find((n) => !childOf.has(n.nodeId)) ?? nodes[0];
    visit(root);
    if (lines.length === 0) return null;
    const header = `Page: ${clean(root.name?.value)} — ${this.page.url()}`;
    return [header, ...lines].join("\n");
  }

  #stepPaths(n) {
    const nnn = String(n).padStart(3, "0");
    const dir = path.join(this.#runDir, "steps");
    return {
      screenshot: path.join(dir, `${nnn}.png`),
      mhtml: path.join(dir, `${nnn}.mhtml`),
      a11y: path.join(dir, `${nnn}.a11y.txt`),
      pw_a11y: path.join(dir, `${nnn}.pw-a11y.txt`),
    };
  }

  #flushHar() {
    flushHar(this.#runDir, this.#har);
  }

  // Pull a textual response body into its HAR entry, capped and guarded — many
  // responses (redirects, 204s, aborted, navigated-away) have no readable body.
  // Async by nature; har.json is rewritten on every flush, so a late body lands
  // in a subsequent flush or at close.
  #captureBody(resp, entry) {
    resp.body().then(
      (buf) => {
        entry.response.body = capBody(buf.toString("utf8"));
      },
      () => {},
    );
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
      network: { requests: [] },
    };
  }
}
