// Browser preflight: make sure Playwright's pinned chromium exists before any
// command launches a browser, so a fresh install gets a one-time download
// offer instead of the raw "browser not installed" stack trace
// (docs/contracts/interfaces.md#exit-codes-and-errors).
//
// The pinned chromium build is part of the instrument. System Chrome versions
// vary per machine and would contaminate perf trends, so every web run uses the
// Playwright-managed build unless the caller explicitly selects a channel.
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import type { Readable, Writable } from "node:stream";
import type { DriverId } from "../core/types.ts";
import { DummyConfigError } from "../core/public/suite.ts";
import { firstLine } from "../core/public/artifacts.ts";

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

// Download stream goes to stderr under --json so stdout stays one JSON object.
interface PreflightOptions {
  json?: boolean;
  input?: Readable;
  output?: Writable;
}

type MobileClientProbe = () => Promise<unknown>;

function installChromium({ json = false }: Pick<PreflightOptions, "json"> = {}) {
  return new Promise<boolean>((resolve) => {
    const child = spawn("npx", ["playwright", "install", "chromium"], {
      stdio: ["ignore", json ? 2 : 1, 2],
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function confirmInstall({ input = process.stdin, output = process.stdout }: PreflightOptions) {
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
 * interactive sessions get the one-time install prompt; non-interactive ones
 * fail with the exact
 * install command. Throws DummyConfigError (→ exit 2 via the cli wrapper).
 * @param {{ json?: boolean,
 *           input?: import("node:stream").Readable, output?: import("node:stream").Writable }} opts
 * @returns {Promise<{ channel: string|null }>} channel to pass to launch
 *   (null = pinned chromium)
 */
export async function ensureBrowser(opts: PreflightOptions = {}) {
  // An explicit inherited channel satisfies preflight; the web driver applies
  // the same channel at launch.
  if (process.env.PLAYTEST_BROWSER_CHANNEL) return { channel: process.env.PLAYTEST_BROWSER_CHANNEL };
  if (chromiumExecutable()) return { channel: null };
  const interactive = process.stdout.isTTY && process.stdin.isTTY && !opts.json;
  if (!interactive) {
    throw new DummyConfigError(`Playwright's Chromium browser is not installed. Run: ${INSTALL_CMD}`);
  }
  if (!(await confirmInstall(opts))) {
    throw new DummyConfigError(`browser install declined. Run: ${INSTALL_CMD}`);
  }
  if (!(await installChromium({ json: opts.json })) || !chromiumExecutable()) {
    throw new DummyConfigError(`browser install failed. Run: ${INSTALL_CMD}`);
  }
  return { channel: null };
}

/**
 * Driver-aware preflight (docs/contracts/engine.md#driver-contract):
 * detect-and-install on demand,
 * keyed on the resolved driver, exactly like ensureBrowser does for chromium.
 * cli.ts calls this AFTER case discovery (so only the drivers actually selected
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

// Test seam (mirrors mobile.js's __setMobileClientFactory): swap how the mobile
// client is probed so the offline self-test can exercise both the absent-client
// and present-client branches WITHOUT depending on whether webdriverio is
// actually installed in the test environment. Defaults to the real lazy import.
const defaultMobileClientProbe = () => import("webdriverio");
let mobileClientProbe: MobileClientProbe = defaultMobileClientProbe;
export function __setMobileClientProbe(fn: MobileClientProbe | null | undefined) {
  mobileClientProbe = fn ?? defaultMobileClientProbe;
}

async function preflightMobile() {
  try {
    await mobileClientProbe();
  } catch (e: any) { // SAFETY: lazy-import failures are Error-like objects with optional Node module codes
    // A genuine not-installed error → the install hint. Any OTHER import failure
    // (a broken native binding, a version/syntax error in a present package) gets
    // its real cause appended, so we don't tell the user to reinstall a package
    // that is already there.
    const missing = e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND";
    throw new DummyConfigError(
      missing
        ? "the mobile driver needs the Appium client. Run: npm i webdriverio (and ensure an Appium server + platform driver + a device/simulator are available)"
        : `the 'webdriverio' client failed to load: ${firstLine(e)}`,
    );
  }
  return { channel: null };
}

export async function preflightFor(driver: DriverId | null | undefined, opts: PreflightOptions = {}) {
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
