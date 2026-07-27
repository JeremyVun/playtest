// The `web` driver: Playwright session — snapshot, execute, settle-v1,
// telemetry, artifacts. The web implementation of the Driver interface
// (docs/contracts/engine.md#web-driver).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, CDPSession, Locator, Page, Request, Response } from "playwright";
import { SETTLE, SNAPSHOT_FORMATS, firstLine, VISION_DRIFT_DEFAULT, actionOf, initialQuietMs } from "../trajectory.ts";
import { SNAPSHOT_SOURCE } from "../snapshot-injected.ts";
import { runAxeInPage } from "../axe-source.ts";
import { overlayFor } from "./overlay.ts";
import { loadOpenApi } from "../openapi.ts";
import { PerfSidecar } from "../perf.ts";
import { MAX_BODY_CHARS, MAX_BODY_READ, capBody, isTextualMime, pathnameOf, createHarFlusher, relativizeUrls, stripRefLines } from "./har.ts";
import type { AxeCapture } from "../axe-source.ts";
import type { Driver, DriverResolution, DriverResult, DriverSnapshot } from "../driver.ts";
import type { EnrichedOpenApi } from "../openapi.ts";
import type { StepAction, StepEnvelope } from "../trajectory.ts";
import type { ResolvedViewport, SettleConfig } from "../types.ts";

interface WebInstrumentation {
  lastMutationAt: number;
  longTasksMs: number;
  lcp: number | null;
  cls: number;
  fcp: number | null;
}

interface WebPerfWindow {
  inputAt: number | null;
  paint: number | null;
}

declare global {
  interface Window {
    __dummy?: WebInstrumentation;
    __dummyWin?: WebPerfWindow;
  }
}

interface WebHarEntry {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; headers: Record<string, string>; body: string | null };
  response: {
    status: number;
    bodySize: number;
    mimeType: string;
    headers: Record<string, string> | null;
    body: string | null;
  };
  _failed: boolean;
}

interface PageSnapshot {
  text: string;
  refCount: number;
  truncated: boolean;
}

interface PerfWindowResult {
  sameDoc: boolean;
  paint: number | null;
  longTasksMs: number;
  lcp: number | null;
  fcp: number | null;
  cls: number;
  ttfb: number | null;
}

interface WebSettlePolicy {
  name: string;
  dom_quiet_ms: number;
  net_quiet_ms: number;
  max_ms: number;
  initial_quiet_ms?: number;
}

type SnapshotHTMLElement = HTMLElement & {
  control?: SnapshotHTMLElement | null;
  labels?: NodeListOf<HTMLLabelElement> | HTMLLabelElement[];
  type?: string;
  value?: string;
};

type AddCookie = Parameters<BrowserContext["addCookies"]>[0][number];
type IndexedPixels = Uint8ClampedArray & Record<number, number>;

interface AxValue {
  value?: unknown;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value?: AxValue }>;
  childIds?: string[];
}

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function normalizeWebSnapshot(text: unknown, base: string | null | undefined = undefined): string {
  let s = String(text ?? "");
  if (base !== undefined) s = relativizeUrls(s, base);
  return stripRefLines(s);
}

export function cookiesFor(cookies: Record<string, string> | null | undefined, baseUrl: string): AddCookie[] {
  if (!cookies || typeof cookies !== "object") return [];
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return [];
  }
  return Object.entries(cookies).map(([name, value]) => ({ name, value: String(value), domain: host, path: "/" }));
}

/** PNG IHDR dimensions (width/height at bytes 16-23, big-endian); null when not a PNG. */
export function pngDimensions(buf: Buffer | null | undefined): { width: number; height: number } | null {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The second drift channel's tuning knob default (re-exported so the driver's
// own home and config.ts can both import VISION_DRIFT_DEFAULT from here).
export { VISION_DRIFT_DEFAULT };

/**
 * Hamming distance between two 16-hex-char dHash strings (a 64-bit perceptual
 * hash): the count of differing bits, 0-64. Returns 64 (maximally different) on
 * any malformed input — a missing/short/non-hex hash reads as full drift rather
 * than a silent match. Pure; exported for test.
 */
export function hammingDistance(a: unknown, b: unknown): number {
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

/** Visual-drift decision for the act-replay loop's pixel channel
 * (docs/contracts/engine.md#act-and-heal): null
 * (NO drift) when EITHER hash is absent — the no-oracle guard, mirroring the
 * a11y snapshot_text legacy guard so a baseline recorded without a pixel oracle
 * skips the channel — else a human note when the Hamming distance EXCEEDS the
 * threshold. Quantized (threshold, not pixel-exact) so antialiasing / cursor /
 * compositor jitter doesn't read as drift. Pure; exported for test.
 */
export function visualDriftReason(nowHash: unknown, wasHash: unknown, threshold = VISION_DRIFT_DEFAULT): string | null {
  if (typeof nowHash !== "string" || typeof wasHash !== "string") return null;
  const dist = hammingDistance(nowHash, wasHash);
  if (dist <= threshold) return null;
  return `the page looks different under the recorded action: the screenshot diverged from the baseline visually (perceptual-hash distance ${dist} > ${threshold})`;
}

/**
 * Compute the visual-regression dHash and the model-facing downscaled PNG in one
 * browser evaluate call. The on-disk screenshot remains the original bytes; this
 * returns the optional downscaled copy for vision prompts.
 */
export async function processScreenshotImage(
  page: Page,
  buf: Buffer,
  maxEdge = VISION_MAX_EDGE
): Promise<{ screenshotHash: string | null; screenshot: Buffer }> {
  const dim = pngDimensions(buf);
  const downscale = Boolean(dim && Math.max(dim.width, dim.height) > maxEdge);
  try {
    const processed = await page.evaluate(async ({ src, cap, downscale }: { src: string; cap: number; downscale: boolean }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = src;
      });

      const dhashCanvas = document.createElement("canvas");
      const W = 9;
      const H = 8;
      dhashCanvas.width = W;
      dhashCanvas.height = H;
      const dhashCtx = dhashCanvas.getContext("2d") as CanvasRenderingContext2D;
      dhashCtx.drawImage(img, 0, 0, W, H);
      const { data }: { data: IndexedPixels } = dhashCtx.getImageData(0, 0, W, H);
      const gray = (x: number, y: number): number => {
        const i = (y * W + x) * 4;
        return (data[i]! + data[i + 1]! + data[i + 2]!) / 3; // SAFETY: calculated RGBA offsets are inside the 9x8 image data
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
      const hex = (v: number): string => (v >>> 0).toString(16).padStart(8, "0");
      let downscaledDataUrl: string | null = null;
      if (downscale) {
        const scale = cap / Math.max(img.width, img.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height); // SAFETY: a freshly created canvas provides a 2D context
        downscaledDataUrl = canvas.toDataURL("image/png");
      }
      return { dHash: hex(hi) + hex(lo), downscaledDataUrl };
    }, { src: `data:image/png;base64,${buf.toString("base64")}`, cap: maxEdge, downscale });
    const image = processed?.downscaledDataUrl
      ? Buffer.from(processed.downscaledDataUrl.split(",")[1] as string, "base64")
      : buf;
    return { screenshotHash: typeof processed?.dHash === "string" ? processed.dHash : null, screenshot: image };
  } catch {
    return { screenshotHash: null, screenshot: buf };
  }
}
// Init script, installed on every document: mutation timestamp for dom-quiet,
// longtask totals, and buffered nav-vitals (LCP/FCP/CLS) collectors. TTFB comes
// from the navigation timing entry at read time.
function initInstrumentation(): void {
  const d: WebInstrumentation = (window.__dummy = { lastMutationAt: 0, longTasksMs: 0, lcp: null, cls: 0, fcp: null });
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
        if (window.__dummyWin === w) w.paint = performance.now() - w.inputAt!; // SAFETY: arm assigned inputAt before scheduling this callback
      });
    });
  };
  for (const t of ["pointerdown", "mousedown", "keydown", "input", "wheel", "scroll"]) {
    window.addEventListener(t, arm, { capture: true, passive: true });
  }
  const observe = (type: string, fn: (list: PerformanceObserverEntryList) => void): void => {
    try {
      new PerformanceObserver(fn).observe({ type, buffered: true });
    } catch {}
  };
  observe("longtask", (l) => {
    for (const e of l.getEntries()) d.longTasksMs += e.duration;
  });
  observe("largest-contentful-paint", (l) => {
    const es = l.getEntries();
    if (es.length) d.lcp = es[es.length - 1]!.startTime; // SAFETY: es.length proves the last performance entry exists
  });
  observe("paint", (l) => {
    for (const e of l.getEntries()) if (e.name === "first-contentful-paint") d.fcp = e.startTime;
  });
  observe("layout-shift", (l) => {
    for (const e of l.getEntries() as Array<PerformanceEntry & { hadRecentInput: boolean; value: number }>) if (!e.hadRecentInput) d.cls += e.value;
  });
}

// Per-action perf window, page side. The marker object doubles as a
// same-document token (gone after navigation → the step navigated). The
// input-to-paint measurement itself is armed by the init script's input
// listeners (see initInstrumentation), so it spans input dispatch → paint.
function openWindowInPage(): number {
  window.__dummyWin = { inputAt: null, paint: null };
  return window.__dummy ? window.__dummy.longTasksMs : 0;
}

function readWindowInPage(): PerfWindowResult {
  const d: Partial<WebInstrumentation> = window.__dummy || {};
  const w = window.__dummyWin || null;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return {
    sameDoc: !!w,
    paint: w ? w.paint : null,
    longTasksMs: d.longTasksMs! || 0, // SAFETY: instrumentation initializes the field before this reader is installed
    lcp: d.lcp === null ? null : d.lcp!, // SAFETY: instrumentation initializes the field before this reader is installed
    fcp: d.fcp === null ? null : d.fcp!, // SAFETY: instrumentation initializes the field before this reader is installed
    cls: d.cls! || 0, // SAFETY: instrumentation initializes the field before this reader is installed
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
function pickScrollTarget(dy: number): boolean {
  const canScroll = (el: HTMLElement | null): boolean => {
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
  const bestIn = (root: HTMLElement): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let bestArea = 0;
    const walk = (el: HTMLElement): void => {
      if (canScroll(el)) {
        const a = el.clientWidth * el.clientHeight;
        if (a > bestArea) {
          best = el;
          bestArea = a;
        }
      }
      for (const c of el.children as HTMLCollectionOf<HTMLElement>) walk(c);
    };
    walk(root);
    return best;
  };
  // Topmost open dialog first (last in DOM order ~ stacked on top).
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')];
  let target: HTMLElement | null = null;
  for (let i = dialogs.length - 1; i >= 0 && !target; i--) target = bestIn(dialogs[i] as HTMLElement);
  // Else the largest scrollable element overlapping the viewport centre.
  if (!target) {
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    for (const el of document.elementsFromPoint(cx, cy) as HTMLElement[]) {
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

// Ref'd scroll, page side: the ref is an anchor, not a hard target. Walk from
// the element to its nearest scrollable ancestor (self included) and scroll
// that by `dy`. Element.scrollBy on a non-scrollable node (a label, heading,
// or choice card) is a silent no-op that does NOT bubble to the document — the
// shape of a "26 scrolls, zero movement" stuck run. Returns false when nothing
// in the chain can move, so the caller falls back to the page-level path.
// Injected via locator.evaluate: everything it needs must live inside it.
function scrollFromElement(el: HTMLElement, dy: number): boolean {
  const canScroll = (node: HTMLElement | null): boolean => {
    if (!node || node === document.documentElement || node === document.body) return false;
    if (node.scrollHeight - node.clientHeight <= 1) return false;
    const s = getComputedStyle(node);
    if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
    // Pinned at the limit in this direction can't move — keep walking up.
    if (dy > 0) return node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    return node.scrollTop > 0;
  };
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (canScroll(node)) {
      node.scrollBy(0, dy);
      return true;
    }
  }
  return false;
}

// Durable locator candidates for an element, best first: testid > role+name >
// exact text > css path. Verified node-side; never throws into the page.
function locatorCandidatesInPage(el: SnapshotHTMLElement): string[] {
  try {
    const out: string[] = [];
    const attrEsc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const seg = (n: Element): string => {
      let i = 1;
      let sib: Element | null = n;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === n.tagName) i++;
      return n.tagName.toLowerCase() + ":nth-of-type(" + i + ")";
    };
    const pathFrom = (root: Element, n: Element | null): string => {
      const segs: string[] = [];
      while (n && n !== root) {
        segs.unshift(seg(n));
        n = n.parentElement;
      }
      return segs.join(" > ");
    };

    const ownTid = el.getAttribute("data-testid");
    if (ownTid) out.push('[data-testid="' + attrEsc(ownTid) + '"]');

    const tag = el.tagName.toLowerCase();
    // Hidden radios/checkboxes are surfaced through their visible <label>
    // (snapshot-injected.ts puts the temporary ref there). Generate semantic
    // candidates from the associated control, while keeping text/CSS fallbacks
    // on the element that is actually clicked.
    const semantic: SnapshotHTMLElement = tag === "label" && el.control ? el.control : el;
    const semanticTag = semantic.tagName.toLowerCase();
    let role = (semantic.getAttribute("role") || "").trim().split(/\s+/)[0] || null;
    if (!role) {
      if (semanticTag === "a") role = "link";
      else if (semanticTag === "button") role = "button";
      else if (semanticTag === "select") role = "combobox";
      else if (semanticTag === "textarea") role = "textbox";
      else if (/^h[1-6]$/.test(semanticTag)) role = "heading";
      else if (semanticTag === "input") {
        const t = (semantic.getAttribute("type") || "text").toLowerCase();
        if (t === "checkbox" || t === "radio") role = t;
        else if (t === "button" || t === "submit" || t === "reset" || t === "image") role = "button";
        else if (t === "range") role = "slider";
        else if (t === "number") role = "spinbutton";
        else if (t === "search") role = "searchbox";
        else role = "textbox";
      }
    }
    let name = semantic.getAttribute("aria-label") || "";
    if (!name && semantic.labels && semantic.labels.length) name = semantic.labels[0]!.textContent || ""; // SAFETY: labels.length proves the first associated label exists
    if (!name) name = semantic.getAttribute("placeholder") || semantic.getAttribute("alt") || semantic.getAttribute("title") || "";
    if (!name && semanticTag === "input" && ["button", "submit", "reset"].includes(semantic.type as string)) name = semantic.value || "";
    if (!name) name = semantic.innerText || "";
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

export class WebDriver implements Driver {
  static async launch({
    baseUrl,
    runDir,
    storageState = null,
    headed = false,
    settle = null,
    viewport = null,
    deviceScaleFactor = null,
    cookies = null,
    openapi = null,
    caseFile = null,
    perf = PerfSidecar.off()
  }: {
    baseUrl: string;
    runDir: string;
    storageState?: string | null;
    headed?: boolean;
    settle?: SettleConfig | null;
    viewport?: ResolvedViewport | null;
    deviceScaleFactor?: number | null;
    cookies?: Record<string, string> | null;
    openapi?: string | null;
    caseFile?: string | null;
    perf?: PerfSidecar;
  }): Promise<WebDriver> {
    fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
    // Spec ingestion is CONFIGURATION, exactly as on the api driver
    // (docs/contracts/engine.md#openapi-ingestion): a declared app.openapi that
    // cannot be resolved is a DummyConfigError naming the case file, raised
    // BEFORE the browser starts rather than as a mystery not-applicable policy
    // at the end of the run.
    const spec = openapi ? loadOpenApi(openapi, { where: `${caseFile ?? "app.openapi"}: app.openapi` }) : null;
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
    // PLAYTEST_BROWSER_CHANNEL: explicit browser-channel override (e.g. "chrome");
    // unset = pinned chromium. No live
    // screencast is recorded at all — the shareable video.mp4 is a post-run
    // slideshow stitched from the per-step stills (runner.ts + clip.ts), so the
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
      const session = new WebDriver({ baseUrl, runDir, browser, context, page, settle, viewport: vp, spec, perf });
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

  declare baseUrl: string;
  declare page: Page;
  #browser: Browser;
  #context: BrowserContext;
  #cdp: CDPSession | null = null;
  #runDir: string;
  #har: WebHarEntry[] = [];
  #harFlusher: ({ force }?: { force?: boolean }) => boolean;
  #harCursor = 0; // end of the previous step's HAR window (see #run)
  #reqInfo = new Map<Request, { index: number; startMs: number }>(); // request → { index, startMs }
  #inflight = new Set<Request>();
  #lastNetAt = 0;
  // Console errors + pageerrors. #errorCount is the authoritative run total the
  // gate compares against (console_errors: N) — always exact. #errorLog retains
  // the messages so the gate/viewer can show them expandably ({type:
  // "console"|"pageerror", text}), but is bounded (text-capped, MAX_ERROR_LOG
  // entries) so a runaway error loop can't bloat the trajectory — past the cap we
  // keep counting but stop retaining. Each step slices its own errors off #errorLog.
  #errorCount = 0;
  #errorLog: Array<{ type: string; text: string }> = [];
  #recordingStopped = false;
  #finalSnapshot: { text: string; url: string | null } | null = null;
  // After stopRecording the gate's element_exists/finalUrl are served from a
  // check page that re-hosts the final captured DOM (the live page keeps
  // running for the slow gate/grader/manifest tail — see
  // docs/contracts/engine.md#post-execution-phases).
  #checkPage: Page | null = null;
  #checkContext: BrowserContext | null = null;
  #checkUrl: string | null = null;
  // Resolved settle policy: settle-v1 defaults with any app.settle overrides
  // merged in. Rides manifest.pins.settle (part of the comparability key).
  #settlePolicy: WebSettlePolicy;
  // The first #settle() of a session (initial page load) uses a longer quiet
  // window (initialQuietMs) so a lagging SPA doesn't settle on a blank page.
  #firstSettle = true;
  // Resolved Chromium viewport (app.viewport or DEFAULT_VIEWPORT). Rides
  // manifest.pins.viewport (part of the comparability key).
  #viewport: ResolvedViewport;
  #warmReload = false;
  #cookies: Record<string, string> | null = null;
  // The enriched OpenAPI document (app.openapi), or null. Gate-only on web: the
  // Tier-1 invariant policies read it to judge the requests the PAGE made
  // (docs/contracts/engine.md#invariant-policies). It never reaches the actor —
  // a web journey is written in clicks, not operations — so the prompt, the
  // snapshot, and the pins are all unchanged by configuring one.
  #spec: EnrichedOpenApi | null = null;

  // The run's diagnostic timing sidecar (perf.ts); the shared no-op recorder
  // when the driver is constructed outside a run (unit tests, external callers).
  #perf: PerfSidecar;

  constructor({
    baseUrl,
    runDir,
    browser,
    context,
    page,
    settle = null,
    viewport = DEFAULT_VIEWPORT,
    spec = null,
    perf = PerfSidecar.off()
  }: {
    baseUrl: string;
    runDir: string;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    settle?: SettleConfig | null;
    viewport?: ResolvedViewport;
    spec?: EnrichedOpenApi | null;
    perf?: PerfSidecar;
  }) {
    this.baseUrl = baseUrl;
    this.page = page;
    this.#spec = spec ?? null;
    this.#browser = browser;
    this.#context = context;
    this.#runDir = runDir;
    this.#perf = perf;
    this.#harFlusher = createHarFlusher(runDir, this.#har, { perf });
    this.#settlePolicy = settle ? { ...SETTLE, ...settle } : SETTLE;
    this.#viewport = viewport;

    context.on("request", (req) => {
      this.#reqInfo.set(req, { index: this.#har.length, startMs: Date.now() });
      let body = null;
      try {
        body = req.postData();
      } catch {}
      this.#har.push({
        startedDateTime: new Date().toISOString(),
        time: -1,
        request: { method: req.method(), url: req.url(), headers: req.headers(), body: capBody(body) },
        response: { status: 0, bodySize: -1, mimeType: "", headers: null, body: null },
        _failed: false,
      });
      this.#inflight.add(req);
      this.#lastNetAt = Date.now();
    });
    context.on("response", (resp) => {
      const info = this.#reqInfo.get(resp.request());
      if (!info) return;
      const e = this.#har[info.index] as WebHarEntry;
      const headers = resp.headers();
      e.response.status = resp.status();
      e.response.mimeType = (headers["content-type"] || "").split(";")[0]!.trim(); // SAFETY: split always yields a first segment
      const len = parseInt(headers["content-length"]!, 10); // SAFETY: parseInt historically receives undefined when the header is absent
      e.response.bodySize = Number.isFinite(len) ? len : -1;
      e.response.headers = headers;
      if (isTextualMime(e.response.mimeType) && (e.response.bodySize < 0 || e.response.bodySize <= MAX_BODY_READ)) {
        this.#captureBody(resp, e);
      }
      this.#lastNetAt = Date.now();
    });
    const finish = (failed: boolean) => (req: Request): void => {
      const info = this.#reqInfo.get(req);
      if (info) {
        const e = this.#har[info.index] as WebHarEntry;
        e.time = Date.now() - info.startMs;
        if (failed) e._failed = true;
      }

      this.#reqInfo.delete(req);
      this.#inflight.delete(req);
      this.#lastNetAt = Date.now();
    };
    context.on("requestfinished", finish(false));
    context.on("requestfailed", finish(true));

    page.on("console", (msg) => {
      if (msg.type() === "error") this.#pushError("console", msg.text());
    });
    page.on("pageerror", (err) => {
      this.#pushError("pageerror", firstLine(err?.message ?? String(err)));
    });
  }

  get id(): "web" {
    return "web";
  }

  /**
   * The enriched OpenAPI document (docs/contracts/engine.md#openapi-ingestion),
   * or null when the suite configured no spec. Same seam the api driver exposes:
   * the gate reads it for the spec-driven Tier-1 invariant policies, here
   * applied to the requests the page made on the journey's behalf.
   */
  get spec() {
    return this.#spec;
  }

  get settle() {
    return this.#settlePolicy;
  }

  get viewport() {
    return this.#viewport;
  }

  get snapshotFormat() {
    return SNAPSHOT_FORMATS.web;
  }

  normalizeSnapshot(text: string, base: string | null = this.baseUrl): string {
    return normalizeWebSnapshot(text, base);
  }

  /** Actor system overlay + the action sub-schemas valid for this transport. */
  get overlay() {
    return overlayFor("web");
  }

  // ---- Driver interface: lifecycle ----

  /** Open the app to its entry state; the returned perf+network seed the gate. */
  async start(): Promise<DriverResult> {
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
  async #reseedForLandedHost(): Promise<boolean> {
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

  location(): string | null {
    return this.#checkUrl ?? this.#pageUrl();
  }

  async effectToken(): Promise<string | null> {
    try {
      return await this.page.evaluate(() => {
        const vals = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"), (el) => el.value).join("\u0000");
        const d = window.__dummy;
        return `${d ? d.lastMutationAt : 0}|${vals}|${location.href}`;
      });
    } catch {
      return null;
    }
  }

  async goto(urlOrPath: string): Promise<DriverResult> {
    return this.#run({ type: "navigate", url: urlOrPath }, null, { locator: null, bbox: null });
  }

  async captureSnapshot(stepNum: number): Promise<DriverSnapshot> {
    // Timing sub-splits (perf.ts): the runner records the `snapshot` total, and
    // each independent piece of capture work reports its own span so a later
    // phase can see which one it moved. Diagnostic only — no behavior changes,
    // and a disabled sidecar makes every perf call a single null check.
    //
    // Shape (BUILD_PLAN T2.2): the custom snapshot runs FIRST and alone, because
    // it is what assigns the `[eN]` refs every later step resolves against.
    // Everything after it — title, screenshot (+dHash/downscale), MHTML, the
    // native AX tree — is an independent read of the same settled page, so they
    // run CONCURRENTLY and their artifact writes go through fs.promises. The
    // screenshot is 80% of the span, so the debug artifacts now hide behind it
    // rather than adding to it. One awaited barrier below joins every write: no
    // envelope may ever advertise a file that is not yet on disk.
    const perf = this.#perf;
    const p = this.#stepPaths(stepNum);
    let at = perf.now();
    const snap = await this.page.evaluate(SNAPSHOT_SOURCE) as PageSnapshot;
    const url = this.page.url();
    perf.span("snapshot_source", at, stepNum, { refs: snap.refCount, truncated: snap.truncated });

    // One step-artifact write, timed and tolerant of failure.
    const write = (file: string, data: string | Buffer, artifact: string): Promise<boolean> => {
      const started = perf.now();
      const size = typeof data === "string" ? { chars: data.length } : { bytes: data.length };
      const done = (ok: boolean): boolean => {
        perf.span("snapshot_write", started, stepNum, { artifact, ...size, ...(ok ? null : { failed: true }) });
        return ok;
      };
      return fs.promises.writeFile(file, data).then(() => done(true), () => done(false));
    };

    // The agent-facing text: the one artifact whose write failure is fatal (it is
    // the run's evidence, not a debug aid), so this promise stays unguarded and
    // the barrier below rethrows exactly as the synchronous write used to.
    at = perf.now();
    const a11yWrite = fs.promises.writeFile(p.a11y, snap.text + "\n").then(() => perf.span("snapshot_write", at, stepNum, { artifact: "a11y" }));

    const titleTask = this.page.title().catch(() => "");

    // Capture mode follows app.viewport.height: a null height => fullPage (the
    // whole scrollable page - good for debugging scroll / marketing shots); a
    // number => viewport-only (exactly what the user saw, content below the fold
    // cut off). Drives BOTH this on-disk PNG and the vision image returned below.
    const fullPage = this.#viewport.height == null;
    const screenshotTask = (async (): Promise<{ screenshot: Buffer | null; screenshotHash: string | null }> => {
      const shotAt = perf.now();
      const bytes = await this.page.screenshot({ fullPage }).catch(() => null);
      perf.span("snapshot_screenshot", shotAt, stepNum, { full_page: fullPage, bytes: bytes?.length ?? 0 });
      if (!bytes) return { screenshot: null, screenshotHash: null };
      // The perceptual hash (visual regression's pixel oracle) is computed from
      // the FULL-SIZE bytes BEFORE #capImage downscales them, so the hash is
      // stable regardless of whether a vision run also shrinks the model-facing
      // image. It comes from the in-memory bytes regardless of the disk write —
      // but if the PNG write FAILS, drop screenshot so artifactFlags (runner.ts)
      // doesn't claim artifacts/screenshots for a file that isn't on disk,
      // otherwise the viewer/clip would seek to a missing frame.
      const wroteTask = write(p.screenshot, bytes, "png");
      const imageAt = perf.now();
      const processed = await processScreenshotImage(this.page, bytes);
      perf.span("snapshot_image", imageAt, stepNum);
      // The vision prompt reads these bytes, so the model call can never start
      // before the PNG is durable: this await is inside the barrier below.
      const wrote = await wroteTask;
      return { screenshot: wrote ? processed.screenshot : null, screenshotHash: processed.screenshotHash };
    })();

    const mhtmlTask = (async (): Promise<void> => {
      const mhtmlAt = perf.now();
      try {
        const { data } = await this.#cdp!.send("Page.captureSnapshot", { format: "mhtml" }); // SAFETY: launch initializes CDP before returning a WebDriver
        await write(p.mhtml, data, "mhtml");
      } catch {}
      perf.span("snapshot_mhtml", mhtmlAt, stepNum);
    })();

    // Debug-only: the browser's NATIVE a11y tree (Chromium's full AX tree via
    // CDP — nothing filtered, so gaps in OUR custom snapshot show up). Flattened
    // into the SAME `role "name"` line shape as snap.text so the viewer can diff
    // the two side-by-side. Never seen by the agent, never part of snap.text or
    // the return value — best-effort, never breaks a run. (page.accessibility was
    // removed in modern Playwright, hence CDP.)
    const nativeAxTask = (async (): Promise<void> => {
      const axAt = perf.now();
      try {
        const tree = await this.#nativeAxTree();
        if (tree) await write(p.pw_a11y, tree + "\n", "pw_a11y");
      } catch {}
      perf.span("snapshot_native_ax", axAt, stepNum);
    })();

    // The persistence barrier: every artifact of this step is on disk before the
    // caller gets a snapshot it can put in an envelope.
    const [title, { screenshot, screenshotHash }] = await Promise.all([titleTask, screenshotTask, a11yWrite, mhtmlTask, nativeAxTask]);
    return { text: snap.text, url, title, refCount: snap.refCount, truncated: snap.truncated, screenshot, screenshotHash };
  }

  /**
   * Agent mode: validate the ref (exists/visible/enabled), compute the durable
   * locator + bbox, then execute inside a perf window. Never throws for
   * per-action problems.
   * @returns {Promise<ExecResult>}
   */
  async execute(action: StepAction): Promise<DriverResult> {
    const type = action?.type;
    const needsElement = type === "click" || type === "type" || type === "select";
    if (!needsElement && !(type === "scroll" && action.ref)) {
      if (type === "scroll" || type === "navigate" || type === "wait" || type === "back") {
        return this.#run(action, null, { locator: null, bbox: null });
      }
      return this.#fail(`action type "${type}" is not executable`);
    }

    const ref = String(action.ref ?? "");
    if (!/^e\d+$/.test(ref)) return this.#fail(`invalid ref "${ref}"`);
    const loc = this.page.locator(`[data-dummy-ref="${ref}"]`);
    // action_resolve (perf.ts): the serial browser round-trips that validate the
    // ref and derive the durable locator + bbox, measured as one span so the
    // grouping candidate in the plan (T2.3) can be judged against the settle floor.
    const resolveAt = this.#perf.now();
    try {
      if ((await loc.count()) === 0) return this.#fail(`unknown ref "${ref}": not in the latest snapshot`);
      if (!(await loc.isVisible())) return this.#fail(`ref "${ref}" is not visible`);
      if (needsElement && !(await loc.isEnabled())) return this.#fail(`ref "${ref}" is disabled`);
    } catch (e) {
      if (this.page.isClosed()) throw e;
      return this.#fail(`validation failed for ref "${ref}": ${firstLine(e)}`);
    }
    const resolution = { ref, locator: await this.#durableLocator(loc, ref), bbox: await this.#bbox(loc) };
    this.#perf.span("action_resolve", resolveAt, null, { mode: "record", type });
    return this.#run(action, loc, resolution);
  }

  /**
   * Act mode: re-execute a baseline envelope from its resolved locator.
   * @returns {Promise<ExecResult>}
   */
  async executeLocator(actedStep: StepEnvelope): Promise<DriverResult> {
    const action = actionOf(actedStep);
    if (!action) return this.#fail("acted step has no action");
    const locatorStr = actedStep.resolution?.locator ?? null;
    if (!locatorStr) {
      // navigate / page-scroll steps carry no element locator
      return this.#run(action, null, { locator: null, bbox: null });
    }
    const loc = this.page.locator(locatorStr);
    let act = loc; // the surface #perform acts on (label redirection below)
    const resolveAt = this.#perf.now();
    try {
      const count = await loc.count();
      if (count === 0) return this.#fail(`baseline locator matched nothing: ${locatorStr}`);
      if (count > 1) return this.#fail(`baseline locator is ambiguous (${count} matches): ${locatorStr}`);
      if (!(await loc.isVisible())) {
        // #durableLocator deliberately records a semantic locator that resolves
        // to a HIDDEN native control when the snapshot ref lived on its visible
        // label (the custom-radio pattern: a zero-size input behind a styled
        // label). The recorder clicked that label, so a replayed click must
        // too — both this pre-check and Playwright's own actionability wait
        // reject a zero-size target. A scroll needs no redirection at all:
        // the ref is only an anchor for the nearest scrollable ancestor, a
        // chain the hidden control shares with its visible label, so it
        // proceeds on the hidden node. Anything else still needs the control
        // itself (fill/selectOption cannot act through a label).
        if (action.type === "click") {
          const label = await this.#visibleLabelFor(loc);
          if (!label) return this.#fail(`baseline locator is not visible: ${locatorStr}`);
          act = label;
        } else if (action.type !== "scroll") {
          return this.#fail(`baseline locator is not visible: ${locatorStr}`);
        }
      }
      if (["click", "type", "select"].includes(action.type as string) && !(await loc.isEnabled())) {
        return this.#fail(`baseline locator is disabled: ${locatorStr}`);
      }
    } catch (e) {
      if (this.page.isClosed()) throw e;
      return this.#fail(`baseline locator failed: ${firstLine(e)}`);
    }
    const resolution = { locator: locatorStr, bbox: await this.#bbox(act) };
    this.#perf.span("action_resolve", resolveAt, null, { mode: "act", type: action.type });
    return this.#run(action, act, resolution);
  }

  /**
   * The visible <label> associated with a hidden form control, as a locator a
   * click can target — the replay-side mirror of #durableLocator's label
   * association. Marks the label with a transient attribute (the same
   * page-mutation technique the snapshotter uses for refs) so a locator can
   * address it; any mark from a previous step is cleared first, keeping the
   * match unique. Returns null when the control has no visible label.
   */
  async #visibleLabelFor(loc: Locator): Promise<Locator | null> {
    const attr = "data-dummy-replay-label";
    const found = await loc.evaluate((node: SnapshotHTMLElement, a: string) => {
      for (const old of document.querySelectorAll(`[${a}]`)) old.removeAttribute(a);
      const label = [...(node.labels ?? [])].find((l) => l.getClientRects().length > 0);
      if (!label) return false;
      label.setAttribute(a, "1");
      return true;
    }, attr).catch(() => false);
    if (!found) return null;
    const label = this.page.locator(`[${attr}]`);
    return (await label.isVisible()) ? label : null;
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
  async captureAxe(): Promise<AxeCapture | null> {
    const axeAt = this.#perf.now();
    try {
      const result = await runAxeInPage(this.page);
      if (result && Array.isArray(result.violations)) return result;
    } catch {
      // best-effort, as before: a failed capture simply yields no `axe`
    } finally {
      this.#perf.span("axe", axeAt, null, { terminal: true });
    }
    return null;
  }

  /** Total console errors + pageerrors so far (gate console_errors). */
  consoleErrors(): number {
    return this.#errorCount;
  }

  /** The captured console/page error messages so far (gate detail + viewer). */
  consoleErrorLog(): Array<{ type: string; text: string }> {
    return this.#errorLog;
  }

  // Record one console/page error. The count is always exact; messages are
  // retained text-capped up to MAX_ERROR_LOG entries (past that we keep counting
  // but stop retaining, so a runaway error loop can't bloat the trajectory).
  #pushError(type: string, text: string): void {
    this.#errorCount++;
    if (this.#errorLog.length < MAX_ERROR_LOG) this.#errorLog.push({ type, text: capBody(text ?? "") as string });
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
  async stopRecording(): Promise<{ text: string; url: string | null } | null> {
    if (this.#recordingStopped) return this.#finalSnapshot;
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
      const snap = await this.page.evaluate(SNAPSHOT_SOURCE) as PageSnapshot;
      fs.writeFileSync(path.join(this.#runDir, "final.a11y.txt"), snap.text + "\n");
      this.#finalSnapshot = { text: snap.text, url: this.#checkUrl };
    } catch {}
    try {
      const { data } = await this.#cdp!.send("Page.captureSnapshot", { format: "mhtml" }); // SAFETY: launch initializes CDP before returning a WebDriver
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
    return this.#finalSnapshot;
  }

  /** element_exists gate support. After stopRecording, prefer the check page that
   *  re-hosts the captured final DOM; else fall back to the live page (which stays
   *  open through the gate tail — channel/no-video path, or one that never called
   *  stopRecording). */
  async finalPageCheck(selector: string): Promise<boolean> {
    const target = this.#checkPage ?? this.page;
    try {
      return (await target.locator(selector).count()) > 0;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.#flushHar(true);
    const traceAt = this.#perf.now();
    try {
      await this.#context.tracing.stop({ path: path.join(this.#runDir, "trace.zip") });
    } catch {}
    // The single biggest artifact in a retained web run (3.7 MB p50 / 18.9 MB
    // p90); Phase 3 makes it conditional and is accepted against this span.
    this.#perf.span("trace_stop", traceAt);
    await this.#checkContext?.close().catch(() => {});
    await this.#context.close().catch(() => {});
    await this.#browser.close().catch(() => {});
  }

  async flushHar(): Promise<void> {
    this.#flushHar(true);
  }

  // ---- internals ----

  /** Perform one action inside a perf window; always returns an ExecResult. */
  async #run(action: StepAction, locator: Locator | null, resolution: DriverResolution): Promise<DriverResult> {
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

      let error: string | null = null;
      const performAt = this.#perf.now();
      try {
        await this.#perform(action, locator);
      } catch (e) {
        if (this.page.isClosed()) throw e;
        error = firstLine(e);
      }
      this.#perf.span("action_perform", performAt, null, { type: action.type });

      const settle_ms = await this.#settle();
      // Always-on a11y capture: run axe-core full-page against the freshly-settled
      // page (the user-visible state AFTER the action), counting every WCAG
      // violation on the page. Best-effort — never throws out, never enters the
      // actor prompt, so the web golden control stays byte-identical (axe rides
      // only the ExecResult, attached by the runner).
      let axe: AxeCapture | null = null;
      const axeAt = this.#perf.now();
      try {
        const result = await runAxeInPage(this.page);
        if (result && Array.isArray(result.violations)) axe = result;
      } catch {}
      this.#perf.span("axe", axeAt, null, { violations: axe?.violations?.length ?? null });
      const win = await this.#readWindow();
      // A back that actually changed documents is nav-attributed via !sameDoc; a
      // no-op / same-document back keeps windowed perf (no stale page-load vitals).
      const navigated = action.type === "navigate" || !win.sameDoc;
      // Embedded network data carries stable fields only (no timings/sizes —
      // they jitter committed baselines); har.json keeps the rich detail. Known
      // freeze: a request still pending at settle embeds status 0 even if it
      // completes later — har.json shows the real status.
      const harEntries: number[] = [];
      const requests: Array<{
        method: string;
        url: string;
        path: string;
        status: number;
        mime_type: string;
        failed: boolean;
      }> = [];
      const harEnd = this.#har.length;
      for (let i = harStart; i < harEnd; i++) {
        harEntries.push(i);
        const e = this.#har[i] as WebHarEntry;
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

  async #perform(action: StepAction, locator: Locator | null): Promise<unknown> {
    switch (action.type) {
      case "click":
        return locator!.click(); // SAFETY: click actions reach #perform only after locator validation
      case "type":
        await locator!.fill(action.text as string); // SAFETY: type actions reach #perform only after locator validation
        if (action.submit) await locator!.press("Enter"); // SAFETY: type actions reach #perform only after locator validation
        return;
      case "select": {
        // `select` is the semantic verb "choose this option", not the <select>
        // tag: an actor pointing it at a radio, option card, or menu item means
        // the same thing, and only a real <select> understands selectOption.
        // Anything else is chosen by clicking the ref itself.
        const tag = await locator!.evaluate((el: Element) => el.tagName); // SAFETY: select actions reach #perform only after locator validation
        if (tag !== "SELECT") return locator!.click(); // SAFETY: select actions reach #perform only after locator validation
        try {
          await locator!.selectOption({ label: action.value }); // SAFETY: select actions reach #perform only after locator validation
        } catch {
          await locator!.selectOption(action.value as string); // SAFETY: select actions reach #perform only after locator validation
        }
        return;
      }
      case "scroll": {
        const dy = action.direction === "up" ? -600 : 600;
        // A ref anchors the scroll to its nearest scrollable ancestor (a list
        // or modal body). When the whole chain is inert — the actor anchored
        // on a heading or an option card in a document-scrolled page — fall
        // through to the page-level path instead of silently doing nothing.
        if (locator && (await locator.evaluate(scrollFromElement, dy).catch(() => false))) return;
        // No ref (or an inert ref chain): scroll the element the user would
        // actually scroll. A modal's content lives in its own overflow
        // container, so window-level wheel events move nothing (the page that
        // produced this code's "five scrolls, zero change" repeated-action
        // confusion). Pick the topmost open dialog's scroller, else the largest
        // scrollable element over the viewport centre, else the window.
        // Returns false only when nothing scrollable was found.
        const scrolled = await this.page.evaluate(pickScrollTarget, dy);
        if (!scrolled) await this.page.mouse.wheel(0, dy);
        return;
      }
      case "navigate":
        return this.page.goto(new URL(action.url as string, this.baseUrl).href, { waitUntil: "domcontentloaded" });
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
  async #settle(): Promise<number> {
    const first = this.#firstSettle;
    this.#firstSettle = false;
    const perfAt = this.#perf.now();
    try {
      return await this.#settleLoop(first);
    } finally {
      this.#perf.span("settle", perfAt, null, { first });
    }
  }

  /** The settle poll itself; #settle wraps it only to time the whole wait. */
  async #settleLoop(first: boolean): Promise<number> {
    const { dom_quiet_ms, net_quiet_ms, max_ms, initial_quiet_ms } = this.#settlePolicy;
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

  async #readWindow(): Promise<PerfWindowResult> {
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
  async #durableLocator(loc: Locator, ref: string): Promise<string | null> {
    let candidates: string[] = [];
    try {
      candidates = await loc.evaluate(locatorCandidatesInPage);
    } catch {}
    for (const cand of candidates) {
      try {
        const l = this.page.locator(cand);
        if ((await l.count()) !== 1) continue;
        const sameTarget = await l.evaluate((node: SnapshotHTMLElement, expectedRef: string) => {
          if (node.getAttribute("data-dummy-ref") === expectedRef) return true;
          // A semantic role locator resolves the hidden input, while the
          // snapshot ref deliberately lives on its visible label. Treat that
          // association as the same verified actionable control.
          if (node.labels) {
            for (const label of node.labels) {
              if (label.getAttribute("data-dummy-ref") === expectedRef) return true;
            }
          }
          return node.control?.getAttribute("data-dummy-ref") === expectedRef;
        }, ref);
        if (sameTarget) return cand;
      } catch {}
    }
    if (candidates.length) return candidates[candidates.length - 1] as string;
    // Last resort: a structural css path. Never data-dummy-ref — refs die with
    // the snapshot, so a baseline carrying one could never be replayed.
    try {
      return await loc.evaluate((el: Element) => {
        const seg = (n: Element): string => {
          let i = 1;
          let sib: Element | null = n;
          while ((sib = sib.previousElementSibling)) if (sib.tagName === n.tagName) i++;
          return n.tagName.toLowerCase() + ":nth-of-type(" + i + ")";
        };
        const segs: string[] = [];
        for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) segs.unshift(seg(n));
        return segs.length ? "body > " + segs.join(" > ") : "body";
      });
    } catch {
      return null;
    }
  }

  async #bbox(loc: Locator): Promise<{ x: number; y: number; w: number; h: number } | null> {
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
  async #nativeAxTree(): Promise<string | null> {
    if (!this.#cdp) return null;
    await this.#cdp.send("Accessibility.enable").catch(() => {});
    const { nodes } = await this.#cdp.send("Accessibility.getFullAXTree") as { nodes: AxNode[] };
    if (!Array.isArray(nodes) || nodes.length === 0) return null;
    const byId = new Map<string, AxNode>(nodes.map((n) => [n.nodeId, n]));
    const prop = (n: AxNode, name: string): unknown => (n.properties ?? []).find((p) => p.name === name)?.value?.value;
    const clean = (s: unknown): string => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim().replace(/"/g, "'");
    // Roles dropped entirely: InlineTextBox/LineBreak are sub-text fragments that
    // duplicate their StaticText parent. Unnamed structural containers (generic/
    // none/presentation) have no counterpart in the custom (interactive/text-only)
    // snapshot, so dropping them keeps the diff honest.
    const DROP = new Set(["InlineTextBox", "LineBreak"]);
    const SKIP_UNNAMED = new Set(["generic", "none", "presentation", "GenericContainer"]);

    const lines: string[] = [];
    let lastText = "";
    const visit = (n: AxNode | undefined): void => {
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
    const root: AxNode = nodes.find((n) => !childOf.has(n.nodeId)) ?? nodes[0]!; // SAFETY: the empty-node case returns above
    visit(root);
    if (lines.length === 0) return null;
    const header = `Page: ${clean(root.name?.value)} — ${this.page.url()}`;
    return [header, ...lines].join("\n");
  }

  #stepPaths(n: number): { screenshot: string; mhtml: string; a11y: string; pw_a11y: string } {
    const nnn = String(n).padStart(3, "0");
    const dir = path.join(this.#runDir, "steps");
    return {
      screenshot: path.join(dir, `${nnn}.png`),
      mhtml: path.join(dir, `${nnn}.mhtml`),
      a11y: path.join(dir, `${nnn}.a11y.txt`),
      pw_a11y: path.join(dir, `${nnn}.pw-a11y.txt`),
    };
  }

  #flushHar(force = false): void {
    this.#harFlusher({ force });
  }

  // Pull a textual response body into its HAR entry, capped and guarded — many
  // responses (redirects, 204s, aborted, navigated-away) have no readable body.
  // Async by nature; har.json is rewritten on every flush, so a late body lands
  // in a subsequent flush or at close.
  #captureBody(resp: Response, entry: WebHarEntry): void {
    resp.body().then(
      (buf) => {
        entry.response.body = capBody(buf.toString("utf8"));
      },
      () => {},
    );
  }

  #pageUrl(): string | null {
    try {
      return this.page.url();
    } catch {
      return null;
    }
  }

  #fail(error: string): DriverResult {
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
