// Browser preflight: make sure Playwright's pinned chromium exists before any
// command launches a browser, so a fresh install gets a one-time download
// offer instead of the raw "browser not installed" stack trace (§3).
//
// Channel policy: the pinned chromium build is part of the instrument —
// measured runs (`run`, `refresh`) call ensureBrowser() without fallback and
// always use it, because system Chrome versions vary per machine and would
// contaminate perf trends. A command where nothing durable is measured
// (`playtest demo` — see demo.js) may pass { allowChromeFallback: true } to
// receive { channel: "chrome" } when chromium is missing but a system Chrome
// exists.
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import { DummyConfigError } from "./config.js";

const INSTALL_CMD = "npx playwright install chromium";

/** Resolved chromium executable, or null when not installed. */
function chromiumExecutable() {
  try {
    const p = chromium.executablePath();
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null; // playwright couldn't even compute a path: treat as missing
  }
}

// Well-known system Chrome locations (demo fallback only; see policy above).
const CHROME_PATHS = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

const systemChrome = () => (CHROME_PATHS[process.platform] ?? []).find((p) => fs.existsSync(p)) ?? null;

// Download stream goes to stderr under --json so stdout stays one JSON object.
function installChromium({ json = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["playwright", "install", "chromium"], {
      stdio: ["ignore", json ? 2 : 1, 2],
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function confirmInstall({ input = process.stdin, output = process.stdout }) {
  const rl = readline.createInterface({ input, output });
  try {
    output.write("Playtest needs a browser (one-time download, ~120 MB).\n");
    const a = (await rl.question("Install Chromium now? [Y/n] ")).trim().toLowerCase();
    return a === "" || a === "y" || a === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Call before any command that launches Playwright. Happy path (chromium
 * already installed) is synchronous-cheap: one existsSync. When missing:
 * interactive sessions get the one-time install prompt (--yes is prior
 * consent and skips the question); non-interactive ones fail with the exact
 * install command. Throws DummyConfigError (-> exit 2 via the cli wrapper).
 * @param {{ yes?: boolean, ci?: boolean, json?: boolean, allowChromeFallback?: boolean,
 *           input?: import("node:stream").Readable, output?: import("node:stream").Writable }} opts
 * @returns {Promise<{ channel: string|null }>} channel to pass to launch
 *   (null = pinned chromium; "chrome" only under allowChromeFallback)
 */
export async function ensureBrowser(opts = {}) {
  // The demo-child opt-in: demo.js sets this for its children and browser.js
  // already honors it at launch, so an inherited channel satisfies preflight.
  if (process.env.PLAYTEST_BROWSER_CHANNEL) return { channel: process.env.PLAYTEST_BROWSER_CHANNEL };
  if (chromiumExecutable()) return { channel: null };
  if (opts.allowChromeFallback && systemChrome()) return { channel: "chrome" };
  if (!opts.yes) {
    const interactive = process.stdout.isTTY && process.stdin.isTTY && !opts.ci && !opts.json;
    if (!interactive) {
      throw new DummyConfigError(`Playwright's Chromium browser is not installed. Run: ${INSTALL_CMD}`);
    }
    if (!(await confirmInstall(opts))) {
      throw new DummyConfigError(`browser install declined. Run: ${INSTALL_CMD}`);
    }
  }
  if (!(await installChromium({ json: opts.json })) || !chromiumExecutable()) {
    throw new DummyConfigError(`browser install failed. Run: ${INSTALL_CMD}`);
  }
  return { channel: null };
}

/**
 * Driver-aware preflight (docs/CONTRACTS.md §16): detect-and-install on demand,
 * keyed on the resolved driver, exactly like ensureBrowser does for chromium.
 * cli.js calls this AFTER case discovery (so only the drivers actually selected
 * are checked — an api/mobile-only run never prompts for an unused Chromium).
 * - web    → ensureBrowser (pinned chromium; today's flow, unchanged)
 * - api    → nothing to install (no-op)
 * - mobile → the Appium client + platform driver + a reachable device (P1)
 * @param {"web"|"mobile"|"api"} driver
 * @returns {Promise<{ channel: string|null }>}
 */
// webdriverio is an optionalDependency, lazy-imported by the mobile driver. A
// missing client becomes a friendly, actionable error here (never a raw
// MODULE_NOT_FOUND from deep inside a run). The Appium server, platform driver,
// and a reachable device are checked when the driver creates its session —
// failures there surface as InfraError with the Appium message.
async function preflightMobile() {
  try {
    await import("webdriverio");
  } catch {
    throw new DummyConfigError(
      "the mobile driver needs the Appium client. Run: npm i webdriverio (and ensure an Appium server + platform driver + a device/simulator are available)",
    );
  }
  return { channel: null };
}

export async function preflightFor(driver, opts = {}) {
  switch (driver ?? "web") {
    case "web":
      return ensureBrowser(opts);
    case "api":
      return { channel: null };
    case "mobile":
      return preflightMobile();
    default:
      return { channel: null };
  }
}
