// The `mobile` driver: a native iOS/Android app over Appium (W3C WebDriver),
// behind the same Driver interface as web
// (docs/contracts/engine.md#mobile-driver). The AX tree maps
// 1:1 onto the web model — page-source → the same [eN] text (mobile-snapshot.ts),
// accessibility-id/predicate → the opaque resolution.locator, element rect →
// bbox for the ghost cursor — so record→act→heal and the viewer work unchanged.
//
// webdriverio is an optionalDependency (web/api installs never pull it) and is
// lazy-imported here; preflightFor("mobile") turns a missing client into a
// friendly DummyConfigError, never a raw MODULE_NOT_FOUND.
//
// v1 ships without network capture (docs/contracts/engine.md#mobile-driver):
// network.requests is always
// empty and api_called on a mobile case is a config error (config.ts), so the
// gate never sees an empty list. Perf is null (no web vitals; gate perf keys are
// config-errored on mobile). Both lift when a proxy sub-milestone lands.
import fs from "node:fs";
import path from "node:path";
import { firstLine, actionOf, initialQuietMs } from "../trajectory.ts";
import { parsePageSource, alertSnapshot, nativePageSourceTree, normalizeSnapshot as normalizeAxSnapshot, SNAPSHOT_FORMAT, ALERT_LOCATOR_PREFIX } from "./mobile-snapshot.ts";
import { overlayFor } from "./overlay.ts";
import { DummyConfigError } from "../config.ts";
import { PerfSidecar } from "../perf.ts";
import type { Browser as WebdriverBrowser, ChainablePromiseElement, remote as webdriverRemote } from "webdriverio";
import type { Driver, DriverResolution, DriverResult, DriverSnapshot } from "../driver.ts";
import type { StepAction, StepEnvelope } from "../trajectory.ts";
import type { ResolvedEnvironment, SettleConfig } from "../types.ts";
import type { MobileSnapshot, MobileSnapshotElement } from "./mobile-snapshot.ts";

type MobileEnvironment = Extract<ResolvedEnvironment, { driver: "mobile" }>;
type RemoteOptions = Parameters<typeof webdriverRemote>[0];
type MobileClientFactory = (opts: RemoteOptions) => Promise<WebdriverBrowser>;

interface MobileSettlePolicy {
  name: string;
  source_quiet_ms: number;
  max_ms: number;
  initial_quiet_ms?: number;
}

// settle-mobile-v1 (design R6): AX-tree stable for source_quiet_ms, capped at
// max_ms. Pinned in manifest.pins.settle; tuning it is a deliberate refresh.
// Overridable per case via app.settle (source_quiet_ms/max_ms) — the merged
// value rides pins.settle (comparability key), same as the web driver.
export const SETTLE_MOBILE = { name: "settle-mobile-v1", source_quiet_ms: 400, max_ms: 10000 };
const POLL_MS = 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Test seam: swap the webdriverio client factory so the offline self-test drives
// a fake Appium app. Defaults to the real Appium remote().
let clientFactory: MobileClientFactory = defaultConnect;
export function __setMobileClientFactory(fn: MobileClientFactory | null | undefined): void {
  clientFactory = fn ?? defaultConnect;
}

async function defaultConnect(opts: RemoteOptions): Promise<WebdriverBrowser> {
  let wdio: typeof import("webdriverio") & { default?: typeof import("webdriverio") };
  try {
    wdio = await import("webdriverio");
  } catch {
    throw new DummyConfigError("the 'webdriverio' package is required for the mobile driver — run: npm i webdriverio");
  }
  return (wdio.remote ?? wdio.default?.remote)(opts);
}

// Exported for unit test (offline; no device). The app.preserve_session config
// key maps 1:1 onto Appium's `noReset`: default (false) preinstalls the binary
// and wipes its data before every session — a clean install each run — while
// true leaves the app installed with its data intact, so a build that is
// already signed in stays authenticated across runs. app is still required (the
// first launch installs it); only the between-run teardown is skipped.
export function capabilitiesFor(env: MobileEnvironment): Record<string, string | boolean> {
  const ios = env.platform === "ios";
  const caps: Record<string, string | boolean> = {
    platformName: ios ? "iOS" : "Android",
    "appium:automationName": ios ? "XCUITest" : "UiAutomator2",
    "appium:app": env.app,
  };
  if (env.device) caps["appium:deviceName"] = env.device;
  if (env.preserve_session) caps["appium:noReset"] = true;
  return caps;
}

// Client members left untouched by the timing proxy — see timedClient below.
const UNWRAPPED_CLIENT_COMMANDS = new Set(["$", "$$"]);

/**
 * Time every Appium command this driver issues, centrally, by proxying the
 * WebDriver client once (perf.ts). Appium round-trips are the mobile driver's
 * dominant cost and the thing Phase 1 removes, so the sidecar records one
 * `appium` span per command with `meta.command` — count and duration by name
 * fall straight out of the JSONL.
 *
 * Only plain CLIENT commands are wrapped. `$`/`$$` return webdriverio's own
 * chainable element thenables, which resolve on first `then` by rules the
 * library owns — timing those would mean intercepting them, and an instrument
 * must never risk changing behavior. Element lookups and element commands
 * (click, setValue, isExisting, getLocation) are therefore attributed to the
 * enclosing action_dispatch / snapshot span instead.
 *
 * A disabled sidecar returns the client untouched: no proxy, no overhead.
 */
function timedClient(client: WebdriverBrowser, perf: PerfSidecar): WebdriverBrowser {
  if (!perf.enabled) return client;
  return new Proxy(client, {
    get(target, prop) {
      // `target` (not the proxy) is the receiver so any accessor on the client
      // still sees its own instance.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (UNWRAPPED_CLIENT_COMMANDS.has(prop)) return value.bind(target);
      return function timed(this: unknown, ...args: unknown[]) {
        const at = perf.now();
        // `execute("mobile: swipe", …)` and friends all arrive as `execute`, so
        // fold the mobile-command name in: it is the part that identifies the
        // round-trip. Nothing else about the call is recorded.
        const command = prop === "execute" && typeof args[0] === "string" ? `execute ${args[0]}` : prop;
        let result: unknown;
        try {
          result = value.apply(target, args);
        } catch (e) {
          perf.span("appium", at, null, { command, ok: false });
          throw e;
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => {
              perf.span("appium", at, null, { command, ok: true });
              return v;
            },
            (e) => {
              perf.span("appium", at, null, { command, ok: false });
              throw e;
            },
          );
        }
        perf.span("appium", at, null, { command, ok: true });
        return result;
      };
    },
  });
}

export class MobileDriver implements Driver {
  static async launch({ env, runDir, perf = PerfSidecar.off() }: { env: MobileEnvironment; runDir: string; perf?: PerfSidecar }): Promise<MobileDriver> {
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
    return new MobileDriver({ client, runDir, settle: env.settle, perf });
  }

  #client: WebdriverBrowser;
  #runDir: string;
  #refs = new Map<string, MobileSnapshotElement>(); // ref ("e3") → parsed element { locator, bbox, role, typable }
  #screen = "";
  // The parsed [eN] digest of the LATEST full page source read (by captureSnapshot
  // or #settle). effectToken() reuses it instead of firing its own getPageSource:
  // every effectToken call is immediately preceded by one of those reads with
  // nothing mutating the device in between (only the actor's LLM call), so the
  // digest is current. Saves two full source dumps per step — the heaviest Appium
  // round-trip. null before the first read (effectToken then falls back to a fetch).
  #lastSourceDigest: string | null = null;
  // The page source #settle() finished on, kept so the captureSnapshot that
  // immediately follows does not refetch and reparse the very screen settle just
  // proved stable (docs/backlog/perf/BUILD_PLAN.md, T1.1). `seq` is the device
  // operation counter (#seq) at the moment settle returned: the entry is
  // consumable only while it still matches, so ANY device command in between
  // (tap, type, swipe, back, alert action) invalidates it. Consumed at most once
  // — cleared on read — because a second capture of the same step is a fresh
  // question about a screen that may have moved on its own since.
  // Never covers alert state: a system alert is drawn by another process and is
  // absent from page source, so captureSnapshot always probes for one live.
  #settleSource: { seq: number; raw: string; parsed: MobileSnapshot } | null = null;
  // Monotonic count of device-MUTATING operations this driver has issued. Every
  // one of them runs through #run() (execute/executeLocator are the only callers
  // and both funnel there), which bumps this before performing; a future direct
  // device command must bump it too or #settleSource could go stale unnoticed.
  // Read-only traffic (getPageSource, screenshots, alert probes, finalPageCheck,
  // bbox reads) deliberately does not bump: it cannot change the screen.
  #seq = 0;
  // Device window size in POINTS ({ w, h }), read once at start() from Appium's
  // getWindowSize. Two uses: (1) bounds the visibility rescue to on-screen
  // controls (parsePageSource screen — a scrolled-out list row has a real but
  // off-screen bbox and must NOT be surfaced); (2) rides manifest.pins.viewport
  // as { width, height } so the viewer can scale the point-space bbox onto the
  // device-pixel screenshot for the ghost cursor. null until read (getWindowSize
  // unavailable/failed) — then the rescue falls back to a non-zero-box test and
  // the viewport pin is omitted (wildcard).
  #screenSize: { w: number; h: number } | null = null;
  // Resolved settle policy: settle-mobile-v1 defaults with any app.settle
  // (quiet_ms/max_ms) merged in. Rides manifest.pins.settle.
  #settlePolicy: MobileSettlePolicy;
  // The first #settle() of a session (initial screen load) uses a longer quiet
  // window (initialQuietMs) so a lagging app doesn't settle on a half-built screen.
  #firstSettle = true;
  // The run's diagnostic timing sidecar (perf.ts); no-op outside a run.
  #perf: PerfSidecar;
  constructor({ client, runDir, settle = null, perf = PerfSidecar.off() }: { client: WebdriverBrowser; runDir: string; settle?: SettleConfig | null; perf?: PerfSidecar }) {
    this.#perf = perf;
    // Every Appium round-trip this driver makes goes through the timed client;
    // wrapping here is the single central seam the plan asks for.
    this.#client = timedClient(client, perf);
    this.#runDir = runDir;
    this.#settlePolicy = settle ? { ...SETTLE_MOBILE, ...settle } : SETTLE_MOBILE;
  }

  // ---- pinned descriptors ----
  get id(): "mobile" {
    return "mobile";
  }

  get settle() {
    return this.#settlePolicy;
  }

  get snapshotFormat() {
    return SNAPSHOT_FORMAT;
  }

  get viewport() {
    return this.#screenSize ? { width: this.#screenSize.w, height: this.#screenSize.h } : null;
  }
  get overlay() {
    return overlayFor("mobile");
  }

  normalizeSnapshot(text: string): string {
    return normalizeAxSnapshot(text);
  }

  async start(): Promise<DriverResult> {
    let src: string;
    try {
      src = String(await this.#client.getPageSource());
    } catch (e) {
      return this.#fail(`the app did not launch (Appium session unreachable): ${firstLine(e)}`);
    }
    if (!src.trim()) return this.#fail("the app launched but exposed no UI (empty page source)");
    try {
      const size = await (this.#client.getWindowSize?.() ?? this.#client.getWindowRect?.());
      const w = Number(size?.width), h = Number(size?.height);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) this.#screenSize = { w, h };
    } catch {}
    // Seed the first settle with the source just read: the launch probe and the
    // first settle poll are the same question about the same screen, microseconds
    // apart, so fetching twice only paid for one page source that is thrown away.
    const { ms: settle_ms, title } = await this.#settle(src);
    this.#screen = title || "";
    return { ok: true, error: null, resolution: null, settle_ms, url: this.#screen, perf: null, network: { requests: [] }, har_entries: [] };
  }

  location(): string | null {
    return this.#screen || null;
  }

  consoleErrors(): number {
    return 0;
  }

  consoleErrorLog(): Array<{ type: string; text: string }> {
    return [];
  }

  async effectToken(): Promise<string | null> {
    try {
      // Fold the alert digest in: dismissing an alert that returns to an unchanged
      // underlying screen must NOT read as no_effect — the alert's presence IS the
      // change. When one is up, the alertSnapshot digest is the whole fingerprint
      // (its page source behind is inert); otherwise the page-source digest.
      // The alert probe stays LIVE (the action may have raised/dismissed one, and
      // it is a cheap getAlertText, not a tree dump); the page-source digest is
      // REUSED from the latest captureSnapshot/#settle read that always precedes
      // this call, avoiding a redundant getPageSource (the heavy round-trip). Only
      // when no read has happened yet (#lastSourceDigest null) do we fetch.
      const alert = await this.#alertState();
      if (alert) return alertSnapshot(alert).text;
      if (this.#lastSourceDigest !== null) return this.#lastSourceDigest;
      return this.#parse(String(await this.#client.getPageSource())).text;
    } catch {
      return null;
    }
  }

  /** screen_shows gate support: an accessibility id / predicate resolves now. */
  async finalPageCheck(query: string): Promise<boolean> {
    try {
      const els = await this.#client.$$(query);
      if (Array.isArray(els)) return els.length > 0;
      const el = await this.#client.$(query);
      return Boolean(await el.isExisting());
    } catch {
      return false;
    }
  }

  async captureSnapshot(stepNum: number): Promise<DriverSnapshot> {
    // The page source, the alert probe, and the screenshot are three independent
    // Appium round-trips (each a slow device call); fire them concurrently so the
    // step waits on the slowest, not their sum. A system alert (an iOS permission
    // dialog / Android runtime prompt) is drawn by a SEPARATE process (SpringBoard
    // on iOS) and never appears in the page source — the actor would see only the
    // dimmed, inert screen behind it and have no affordance to answer. When one is
    // up, its buttons ARE the actor's affordances, so they replace the page-source.
    // When settle already holds this exact screen (no device operation since), its
    // source and parse are reused and only the alert probe and screenshot go to
    // the device — the two things that genuinely cannot be cached.
    const reused = this.#takeSettleSource();
    const perf = this.#perf;
    let at = perf.now();
    const [xml, alert, b64] = await Promise.all([
      reused ? reused.raw : this.#client.getPageSource().then((s) => String(s), () => ""),
      this.#alertState(),
      this.#client.takeScreenshot().then((b) => b, () => null),
    ]);
    // One span for the concurrent fetch trio; the per-command `appium` spans
    // from timedClient break out which of the three actually cost the wait.
    perf.span("snapshot_source", at, stepNum, { chars: xml.length, alert: Boolean(alert), reused: Boolean(reused) });
    // Parse the page source once; reuse it for the snapshot (no-alert case) AND
    // for the cached digest effectToken reads. Even under an alert we cache the
    // (inert) behind-screen digest so an effectToken AFTER the alert is dismissed
    // compares against the right underlying screen without a fresh getPageSource.
    at = perf.now();
    const parsed = reused ? reused.parsed : this.#parse(xml);
    perf.span("snapshot_parse", at, stepNum, { reused: Boolean(reused) });
    this.#lastSourceDigest = parsed.text;
    const snap = alert ? alertSnapshot(alert) : parsed;
    this.#screen = snap.title || this.#screen;
    this.#refs = new Map(snap.elements.map((e) => [e.ref, e]));
    const p = this.#stepPaths(stepNum);
    at = perf.now();
    try {
      fs.writeFileSync(p.a11y, snap.text + "\n");
    } catch {}
    perf.span("snapshot_write", at, stepNum, { artifact: "a11y" });
    // Debug-only: the FULL, unfiltered Appium page-source tree (the mobile analog
    // of the web driver's native AX tree, web.ts#nativeAxTree). Reuse the `xml`
    // already fetched — no second getPageSource(). Flattened to the same
    // `role "name"` shape so the viewer diffs it against our custom snapshot;
    // never seen by the agent. Best-effort — a throw is swallowed, no artifact.
    at = perf.now();
    try {
      const tree = nativePageSourceTree(xml);
      if (tree) fs.writeFileSync(p.pw_a11y, tree + "\n");
    } catch {}
    perf.span("snapshot_native_ax", at, stepNum);
    // Screenshot fetched above (concurrently with the source); just decode + write.
    let screenshot: Buffer | null = null;
    at = perf.now();
    try {
      if (b64) {
        const buf = Buffer.from(b64, "base64");
        // Only claim the artifact after a successful write — otherwise a failed
        // write (ENOSPC/read-only run dir) would leave the envelope advertising a
        // steps/NNN.png that is not on disk (mirrors the web driver's guard).
        fs.writeFileSync(p.screenshot, buf);
        screenshot = buf;
      }
    } catch {}
    perf.span("snapshot_write", at, stepNum, { artifact: "png", bytes: screenshot?.length ?? 0 });
    // screenshotHash: explicit null documents the visual_regression Driver seam
    // (web-only); the runner already guards on its presence.
    return { text: snap.text, url: this.#screen || null, title: this.#screen, refCount: snap.refCount, truncated: snap.truncated, screenshot, screenshotHash: null };
  }

  /** Agent mode: resolve the ref to its durable locator, validate, act. */
  async execute(action: StepAction): Promise<DriverResult> {
    const type = action?.type;
    if (type === "back") return this.#run(() => this.#client.back(), { locator: null, bbox: null });
    if (type === "wait") return this.#run(() => sleep(Math.min(10, Math.max(0.1, Number(action.seconds) || 1)) * 1000), { locator: null, bbox: null });
    if (type === "scroll" && !action.ref) return this.#run(() => this.#swipe(action.direction === "up" ? "down" : "up"), { locator: null, bbox: null });
    if (type === "swipe" && !action.ref) return this.#run(() => this.#swipe(action.direction), { locator: null, bbox: null });

    const el = this.#refs.get(String(action.ref ?? ""));
    if (!el) return this.#fail(`unknown ref "${action.ref}": not in the latest snapshot`);
    // A system-alert button (alertSnapshot) has no queryable element — its locator
    // is answered through the alert API, not element resolution. Route it there.
    if (el.alertButton) {
      return this.#run(() => this.#tapAlertButton(el.name), { ref: action.ref, locator: el.locator, bbox: null });
    }
    let handle: ChainablePromiseElement;
    try {
      handle = await this.#client.$(el.locator);
      // Existence is the reliable gate; we do NOT re-check isDisplayed() here. On
      // XCUITest that returns the same unreliable `visible` flag the snapshot walk
      // already reasoned about (mobile-snapshot.ts isActionableInteractive) — a
      // real, tappable nav-bar button is reported not-displayed, so re-gating here
      // would re-drop exactly the control we intentionally surfaced. Appium's tap
      // drives the element's rect regardless of the flag.
      if (!(await handle.isExisting())) return this.#fail(`ref "${action.ref}" (${el.locator}) is no longer on screen`);
    } catch (e) {
      return this.#fail(`validation failed for ref "${action.ref}": ${firstLine(e)}`);
    }
    return this.#run(() => this.#perform(action, handle), { ref: action.ref, locator: el.locator, bbox: el.bbox });
  }

  /** Act mode: drive straight from the baseline's durable locator. */
  async executeLocator(actedStep: StepEnvelope): Promise<DriverResult> {
    const action = actionOf(actedStep);
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
    // Replay a system-alert tap through the alert API (see execute()): the baseline
    // locator is `alert-button:<label>`, which resolves to no element.
    if (locator.startsWith(ALERT_LOCATOR_PREFIX)) {
      const label = locator.slice(ALERT_LOCATOR_PREFIX.length);
      return this.#run(() => this.#tapAlertButton(label), { locator: null, bbox: null });
    }
    let handle: ChainablePromiseElement;
    try {
      handle = await this.#client.$(locator);
      // Existence-only gate, mirroring execute() — the XCUITest `visible` flag is
      // unreliable for on-screen nav-bar controls, so isDisplayed() is not checked.
      const ok = await handle.isExisting();
      if (!ok) return this.#fail(`baseline locator matched nothing: ${locator}`);
    } catch (e) {
      return this.#fail(`baseline locator failed: ${locator}: ${firstLine(e)}`);
    }
    return this.#run(() => this.#perform(action, handle), { locator, bbox: await this.#bbox(handle) });
  }

  async close(): Promise<void> {
    try {
      await this.#client.deleteSession?.();
    } catch {}
  }

  // ---- internals ----

  // parsePageSource with the device screen size folded in, so the visibility
  // rescue is bounded to on-screen controls (mobile-snapshot.ts). #screenSize is
  // null until start() reads it — then parsePageSource keeps its non-zero-box
  // fallback, so a pre-start parse is never wrong, just less precise.
  #parse(xml: string): MobileSnapshot {
    return parsePageSource(xml, { screen: this.#screenSize });
  }

  /**
   * Publish what settle finished holding: the digest effectToken compares
   * against, plus the source and its parse for the captureSnapshot that follows.
   */
  #settled(digest: string | null, raw: string | null, parsed: MobileSnapshot | null): void {
    this.#lastSourceDigest = digest; // reused by effectToken (after) — no fresh read
    this.#settleSource = raw !== null && parsed !== null ? { seq: this.#seq, raw, parsed } : null;
  }

  /**
   * The settle source, if it is still the current screen. Always clears the
   * entry: a retained source is good for exactly one capture, and a stale one
   * (some device command ran since) is good for none.
   */
  #takeSettleSource(): { raw: string; parsed: MobileSnapshot } | null {
    const held = this.#settleSource;
    this.#settleSource = null;
    return held && held.seq === this.#seq ? held : null;
  }

  async #perform(action: StepAction, handle: ChainablePromiseElement): Promise<unknown> {
    switch (action.type) {
      case "tap":
        return handle.click();
      case "type":
        await handle.click().catch(() => {});
        if (typeof handle.clearValue === "function") await handle.clearValue().catch(() => {});
        await handle.setValue(action.text as string);
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
  async #submit(handle: ChainablePromiseElement): Promise<void> {
    try {
      await this.#client.execute("mobile: performEditorAction", { action: "done" });
      return;
    } catch {}
    try {
      await handle.addValue("\n");
    } catch {}
  }

  // Read the on-screen system alert (iOS permission dialog / Android runtime
  // prompt) via Appium's dedicated alert API — NOT the page source, which never
  // includes it (drawn by a separate process, see captureSnapshot). Returns
  // { text, buttons } when an alert is up, else null. Best-effort and tolerant:
  // no alert throws (getAlertText → NoSuchAlert), which we read as "none". Button
  // labels come from `mobile: alert{action:'getButtons'}`; a platform/driver that
  // can't enumerate them degrades to an empty list (the actor still sees the
  // dialog text and can `back`/`swipe`).
  async #alertState(): Promise<{ text: string; buttons: string[] } | null> {
    let text: unknown;
    try {
      text = await this.#client.getAlertText();
    } catch {
      return null; // no alert present
    }
    if (text == null) return null;
    let buttons: string[] = [];
    try {
      const got = await this.#client.execute("mobile: alert", { action: "getButtons" });
      if (Array.isArray(got)) buttons = got.map((b) => String(b));
    } catch {}
    return { text: String(text), buttons };
  }

  async #tapAlertButton(label: string): Promise<void> {
    try {
      await this.#client.execute("mobile: alert", { action: "accept", buttonLabel: label });
      return;
    } catch {}
    await this.#client.execute("mobile: alert", { action: "accept" });
  }

  async #swipe(direction: unknown, handle?: ChainablePromiseElement): Promise<void> {
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
  async #run(perform: () => unknown | Promise<unknown>, resolution: DriverResolution): Promise<DriverResult> {
    this.#seq += 1; // the screen is about to change: any retained settle source is now stale
    let error: string | null = null;
    try {
      await perform();
    } catch (e) {
      error = firstLine(e);
    }
    const { ms: settle_ms, title } = await this.#settle();
    this.#screen = title || "";
    return {
      ok: !error,
      error,
      resolution,
      settle_ms,
      url: this.#screen || null,
      perf: null, // no mobile perf yet; config rejects perf keys for this driver
      har_entries: [],
      network: { requests: [] }, // no mobile network capture in v1
    };
  }

  async #fail(error: string): Promise<DriverResult> {
    return { ok: false, error, resolution: null, settle_ms: 0, url: this.#screen || null, perf: null, har_entries: [], network: { requests: [] } };
  }

  // settle-mobile-v1: poll the page source until the PARSED snapshot is unchanged
  // for source_quiet_ms, capped at max_ms. Returns { ms, title } — the elapsed
  // wait plus the screen title read off the final poll, so the caller reuses this
  // last getPageSource for #screen instead of firing another round-trip.
  // The FIRST settle (initial screen load, in start()) requires a longer quiet
  // window (initialQuietMs, capped at max_ms) so a lagging app doesn't settle on
  // a half-built screen.
  async #settle(seed: string | null = null): Promise<{ ms: number; title: string }> {
    const first = this.#firstSettle;
    this.#firstSettle = false;
    const perfAt = this.#perf.now();
    try {
      return await this.#settleLoop(first, seed);
    } finally {
      this.#perf.span("settle", perfAt, null, { first });
    }
  }

  /**
   * The settle poll itself; #settle wraps it only to time the whole wait.
   * `seed`, when given, is a page source the caller has ALREADY read (start()'s
   * launch probe) and stands in for the first poll's fetch.
   */
  async #settleLoop(first: boolean, seed: string | null): Promise<{ ms: number; title: string }> {
    const { source_quiet_ms, max_ms, initial_quiet_ms } = this.#settlePolicy;
    const sourceWin = first ? Math.min(initialQuietMs(source_quiet_ms, initial_quiet_ms), max_ms) : source_quiet_ms;
    const start = Date.now();
    let lastRaw: string | null = null; // raw page source of the previous poll (parsed for the title)
    let lastDigest: string | null = null; // the parsed [eN] digest — the churn-free quiet surface
    let lastParsed: MobileSnapshot | null = null; // the parse behind lastDigest, retained for the next captureSnapshot
    let title = this.#screen;
    let quietSince = Date.now();
    let pending = seed; // the caller's already-read source; stands in for the first fetch
    for (;;) {
      let raw: string = lastRaw ?? ""; // a transient getPageSource failure counts as "no change", not a reset
      if (pending !== null) {
        raw = pending;
        pending = null;
      } else {
        try {
          raw = String(await this.#client.getPageSource());
        } catch {}
      }
      const now = Date.now();
      // Compare the PARSED [eN] digest, NOT raw XML: raw page source carries
      // volatile attributes (focus, indexes, animation state) that change every
      // poll and would keep the quiet timer from ever advancing, spinning settle
      // to max_ms on an idle screen (the same reasoning effectToken documents).
      // Parse only when the raw source actually changed — a stable screen parses
      // once, not every poll.
      let digest: string | null = lastDigest;
      if (raw !== lastRaw) {
        const snap = this.#parse(raw);
        digest = snap.text;
        title = snap.title || title;
        lastRaw = raw;
        lastParsed = snap;
      }
      if (digest !== lastDigest) {
        lastDigest = digest;
        quietSince = now;
      } else if (now - quietSince >= sourceWin) {
        this.#settled(lastDigest, lastRaw, lastParsed); // digest for effectToken, source+parse for captureSnapshot
        return { ms: now - start, title };
      }
      if (now - start >= max_ms) {
        this.#settled(lastDigest, lastRaw, lastParsed);
        return { ms: now - start, title };
      }
      await sleep(POLL_MS);
    }
  }

  async #bbox(handle: ChainablePromiseElement): Promise<{ x: number; y: number; w: number; h: number } | null> {
    try {
      const [loc, size] = await Promise.all([handle.getLocation(), handle.getSize()]);
      if (loc && size) return { x: Math.round(loc.x), y: Math.round(loc.y), w: Math.round(size.width), h: Math.round(size.height) };
    } catch {}
    return null;
  }

  #stepPaths(n: number): { screenshot: string; a11y: string; pw_a11y: string } {
    const nnn = String(n).padStart(3, "0");
    const dir = path.join(this.#runDir, "steps");
    return { screenshot: path.join(dir, `${nnn}.png`), a11y: path.join(dir, `${nnn}.a11y.txt`), pw_a11y: path.join(dir, `${nnn}.pw-a11y.txt`) };
  }
}
