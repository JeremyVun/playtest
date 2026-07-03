// The `mobile` driver: a native iOS/Android app over Appium (W3C WebDriver),
// behind the same Driver interface as web (CONTRACTS.md §16). The AX tree maps
// 1:1 onto the web model — page-source → the same [eN] text (mobile-snapshot.js),
// accessibility-id/predicate → the opaque resolution.locator, element rect →
// bbox for the ghost cursor — so record→act→heal and the viewer work unchanged.
//
// webdriverio is an optionalDependency (web/api installs never pull it) and is
// lazy-imported here; preflightFor("mobile") turns a missing client into a
// friendly DummyConfigError, never a raw MODULE_NOT_FOUND.
//
// v1 ships WITHOUT network capture (design §10.1): network.requests is always
// empty and api_called on a mobile case is a config error (config.js), so the
// gate never sees an empty list. Perf is null (no web vitals; gate perf keys are
// config-errored on mobile). Both lift when a proxy sub-milestone lands.
import fs from "node:fs";
import path from "node:path";
import { firstLine } from "../trajectory.js";
import { parsePageSource, SNAPSHOT_FORMAT } from "./mobile-snapshot.js";
import { overlayFor } from "./overlay.js";

// settle-mobile-v1 (design R6): AX-tree stable for source_quiet_ms, capped at
// max_ms. Pinned in manifest.pins.settle; tuning it is a deliberate refresh.
export const SETTLE_MOBILE = { name: "settle-mobile-v1", source_quiet_ms: 400, max_ms: 10000 };
const POLL_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test seam: swap the webdriverio client factory so the offline self-test drives
// a fake Appium app. Defaults to the real Appium remote().
let clientFactory = defaultConnect;
export function __setMobileClientFactory(fn) {
  clientFactory = fn ?? defaultConnect;
}

async function defaultConnect(opts) {
  let wdio;
  try {
    wdio = await import("webdriverio");
  } catch {
    throw new Error("the 'webdriverio' package is required for the mobile driver — run: npm i webdriverio");
  }
  return (wdio.remote ?? wdio.default?.remote)(opts);
}

function capabilitiesFor(env) {
  const ios = env.platform === "ios";
  const caps = {
    platformName: ios ? "iOS" : "Android",
    "appium:automationName": ios ? "XCUITest" : "UiAutomator2",
    "appium:app": env.app,
  };
  if (env.device) caps["appium:deviceName"] = env.device;
  return caps;
}

export class MobileDriver {
  /** @returns {Promise<MobileDriver>} */
  static async launch({ env, runDir }) {
    fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
    const url = new URL(env.appium_url || "http://127.0.0.1:4723");
    const client = await clientFactory({
      hostname: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 4723,
      path: url.pathname && url.pathname !== "/" ? url.pathname : "/",
      protocol: url.protocol.replace(":", ""),
      logLevel: "silent",
      capabilities: capabilitiesFor(env),
    });
    return new MobileDriver({ client, runDir });
  }

  #client;
  #runDir;
  #refs = new Map(); // ref ("e3") -> parsed element { locator, bbox, role, typable }
  #screen = "";

  constructor({ client, runDir }) {
    this.#client = client;
    this.#runDir = runDir;
  }

  // ---- pinned descriptors ----
  get id() {
    return "mobile";
  }
  get settle() {
    return SETTLE_MOBILE;
  }
  get snapshotFormat() {
    return SNAPSHOT_FORMAT;
  }
  get overlay() {
    return overlayFor("mobile");
  }

  // ---- lifecycle ----

  /**
   * Session creation already launched the app; confirm it actually came up
   * (page source is reachable + non-empty) so a crashed/blank launch is an
   * InfraError (the runner turns !ok into one), not a mislabeled product failure.
   */
  async start() {
    let src;
    try {
      src = String(await this.#client.getPageSource());
    } catch (e) {
      return this.#fail(`the app did not launch (Appium session unreachable): ${firstLine(e)}`);
    }
    if (!src.trim()) return this.#fail("the app launched but exposed no UI (empty page source)");
    const settle_ms = await this.#settle();
    this.#screen = await this.#screenId();
    return { ok: true, error: null, resolution: null, settle_ms, url: this.#screen, perf: null, network: { requests: [] }, har_entries: [] };
  }

  location() {
    return this.#screen || null;
  }

  consoleErrors() {
    return 0; // native logcat/console errors are a later sub-milestone
  }

  /**
   * no_effect fingerprint (design §2.2 — transport-defined): the PARSED snapshot
   * text, not the raw page source — raw XML carries volatile attributes (focus,
   * indexes, animation state) that change every poll and would make the token
   * never match, killing no_effect. The [eN] digest is the stable surface.
   */
  async effectToken() {
    try {
      return parsePageSource(String(await this.#client.getPageSource())).text;
    } catch {
      return null;
    }
  }

  /** screen_shows gate support: an accessibility id / predicate resolves now. */
  async finalPageCheck(query) {
    try {
      const els = await this.#client.$$(query);
      if (Array.isArray(els)) return els.length > 0;
      const el = await this.#client.$(query);
      return Boolean(await el.isExisting());
    } catch {
      return false;
    }
  }

  async captureSnapshot(stepNum) {
    let xml = "";
    try {
      xml = await this.#client.getPageSource();
    } catch {}
    const snap = parsePageSource(String(xml));
    this.#screen = snap.title || this.#screen;
    this.#refs = new Map(snap.elements.map((e) => [e.ref, e]));
    const p = this.#stepPaths(stepNum);
    try {
      fs.writeFileSync(p.a11y, snap.text + "\n");
    } catch {}
    let screenshot = null;
    try {
      const b64 = await this.#client.takeScreenshot();
      if (b64) {
        screenshot = Buffer.from(b64, "base64");
        fs.writeFileSync(p.screenshot, screenshot);
      }
    } catch {}
    return { text: snap.text, url: this.#screen || null, title: this.#screen, refCount: snap.refCount, truncated: snap.truncated, screenshot };
  }

  /** Agent mode: resolve the ref to its durable locator, validate, act. */
  async execute(action) {
    const type = action?.type;
    if (type === "back") return this.#run(() => this.#client.back(), { locator: null, bbox: null });
    if (type === "wait") return this.#run(() => sleep(Math.min(10, Math.max(0.1, Number(action.seconds) || 1)) * 1000), { locator: null, bbox: null });
    if (type === "scroll" && !action.ref) return this.#run(() => this.#swipe(action.direction === "up" ? "down" : "up"), { locator: null, bbox: null });
    if (type === "swipe" && !action.ref) return this.#run(() => this.#swipe(action.direction), { locator: null, bbox: null });

    const el = this.#refs.get(String(action.ref ?? ""));
    if (!el) return this.#fail(`unknown ref "${action.ref}": not in the latest snapshot`);
    let handle;
    try {
      handle = await this.#client.$(el.locator);
      if (!(await handle.isExisting())) return this.#fail(`ref "${action.ref}" (${el.locator}) is no longer on screen`);
      if (!(await handle.isDisplayed())) return this.#fail(`ref "${action.ref}" is not visible`);
    } catch (e) {
      return this.#fail(`validation failed for ref "${action.ref}": ${firstLine(e)}`);
    }
    return this.#run(() => this.#perform(action, handle), { ref: action.ref, locator: el.locator, bbox: el.bbox });
  }

  /** Act mode: drive straight from the baseline's durable locator. */
  async executeLocator(actedStep) {
    const action = actedStep.agent?.action ?? actedStep.action;
    if (!action) return this.#fail("acted step has no action");
    if (action.type === "back") return this.#run(() => this.#client.back(), { locator: null, bbox: null });
    if (action.type === "wait") return this.#run(() => sleep(Math.min(10, Math.max(0.1, Number(action.seconds) || 1)) * 1000), { locator: null, bbox: null });
    const locator = actedStep.resolution?.locator ?? null;
    if (!locator) {
      if (action.type === "swipe" || action.type === "scroll") {
        const dir = action.type === "scroll" ? (action.direction === "up" ? "down" : "up") : action.direction;
        return this.#run(() => this.#swipe(dir), { locator: null, bbox: null });
      }
      return this.#fail(`acted step has no locator for ${action.type}`);
    }
    let handle;
    try {
      handle = await this.#client.$(locator);
      const ok = await handle.isExisting();
      if (!ok) return this.#fail(`baseline locator matched nothing: ${locator}`);
      if (!(await handle.isDisplayed())) return this.#fail(`baseline locator is not visible: ${locator}`);
    } catch (e) {
      return this.#fail(`baseline locator failed: ${locator}: ${firstLine(e)}`);
    }
    return this.#run(() => this.#perform(action, handle), { locator, bbox: await this.#bbox(handle) });
  }

  async close() {
    try {
      await this.#client.deleteSession?.();
    } catch {}
  }

  // ---- internals ----

  async #perform(action, handle) {
    switch (action.type) {
      case "tap":
        return handle.click();
      case "type":
        await handle.click().catch(() => {});
        if (typeof handle.clearValue === "function") await handle.clearValue().catch(() => {});
        await handle.setValue(action.text);
        if (action.submit) await this.#submit(handle); // honor submit:true (the prompt advertises it)
        return;
      case "swipe":
        return this.#swipe(action.direction, handle);
      case "scroll":
        return this.#swipe(action.direction === "up" ? "down" : "up", handle);
      default:
        throw new Error(`unknown mobile action type "${action.type}"`);
    }
  }

  // Press the field's submit/return after typing. Best-effort across platforms:
  // Appium's editor action first, then appending a newline.
  async #submit(handle) {
    try {
      await this.#client.execute("mobile: performEditorAction", { action: "done" });
      return;
    } catch {}
    try {
      await handle.addValue("\n");
    } catch {}
  }

  // Swipe/scroll gesture, cross-platform best-effort: iOS XCUITest `mobile: swipe`
  // then Android UiAutomator2 `mobile: scrollGesture`. Navigational, not
  // load-bearing for act-mode determinism, so a platform that lacks both no-ops.
  async #swipe(direction, handle) {
    const el = handle ? { elementId: handle.elementId } : {};
    try {
      await this.#client.execute("mobile: swipe", { direction, ...el });
      return;
    } catch {}
    try {
      const area = handle ? el : { left: 100, top: 200, width: 200, height: 400 };
      await this.#client.execute("mobile: scrollGesture", { direction, percent: 1.0, ...area });
    } catch {}
  }

  /** Run one action inside the mobile settle window; always an ExecResult. */
  async #run(perform, resolution) {
    let error = null;
    try {
      await perform();
    } catch (e) {
      error = firstLine(e);
    }
    const settle_ms = await this.#settle();
    this.#screen = await this.#screenId();
    return {
      ok: !error,
      error,
      resolution,
      settle_ms,
      url: this.#screen || null,
      perf: null, // no web vitals on mobile (design §10.2); gate perf keys are config-errored here
      har_entries: [],
      network: { requests: [] }, // no capture in v1 (design §10.1)
    };
  }

  async #fail(error) {
    return { ok: false, error, resolution: null, settle_ms: 0, url: this.#screen || null, perf: null, har_entries: [], network: { requests: [] } };
  }

  // settle-mobile-v1: poll the page source until it is unchanged for
  // source_quiet_ms, capped at max_ms. Returns elapsed ms.
  async #settle() {
    const { source_quiet_ms, max_ms } = SETTLE_MOBILE;
    const start = Date.now();
    let last = null;
    let quietSince = Date.now();
    for (;;) {
      let src = last ?? ""; // a transient getPageSource failure counts as "no change", not a reset
      try {
        src = String(await this.#client.getPageSource());
      } catch {}
      const now = Date.now();
      if (src !== last) {
        last = src;
        quietSince = now;
      } else if (now - quietSince >= source_quiet_ms) {
        return now - start;
      }
      if (now - start >= max_ms) return now - start;
      await sleep(POLL_MS);
    }
  }

  async #screenId() {
    try {
      const snap = parsePageSource(String(await this.#client.getPageSource()));
      return snap.title || this.#screen || "";
    } catch {
      return this.#screen || "";
    }
  }

  async #bbox(handle) {
    try {
      const [loc, size] = await Promise.all([handle.getLocation(), handle.getSize()]);
      if (loc && size) return { x: Math.round(loc.x), y: Math.round(loc.y), w: Math.round(size.width), h: Math.round(size.height) };
    } catch {}
    return null;
  }

  #stepPaths(n) {
    const nnn = String(n).padStart(3, "0");
    const dir = path.join(this.#runDir, "steps");
    return { screenshot: path.join(dir, `${nnn}.png`), a11y: path.join(dir, `${nnn}.a11y.txt`) };
  }
}
