// Driver toolchain probes core owns, so every host asks the same question the
// same way and reports the same actionable answer
// (docs/contracts/engine.md#driver-contract).
//
// Scope note, so this file is not mistaken for more than it is: the only probe
// here is "is the Appium client importable". The real mobile diagnosis — the
// build path exists, an Appium server answers, the platform driver is
// installed — is runner-local knowledge and belongs to whoever owns the
// machine, not to core.
import { DummyConfigError } from "./config.ts";
import { firstLine } from "./trajectory.ts";

type MobileClientProbe = () => Promise<unknown>;

// webdriverio is an optionalDependency, lazy-imported by the mobile driver, so
// a web/api install never pulls it. Probing it through the same dynamic import
// the driver uses is the point: a missing client becomes a friendly, actionable
// error HERE instead of a raw MODULE_NOT_FOUND from deep inside a run.
const defaultMobileClientProbe: MobileClientProbe = () => import("webdriverio");
let mobileClientProbe: MobileClientProbe = defaultMobileClientProbe;

/**
 * Test seam (mirrors drivers/mobile.ts's __setMobileClientFactory): swap how the
 * mobile client is probed so an offline self-test can exercise both the
 * absent-client and present-client branches WITHOUT depending on whether
 * webdriverio is actually installed. Passing null restores the real import.
 */
export function __setMobileClientProbe(fn: MobileClientProbe | null | undefined): void {
  mobileClientProbe = fn ?? defaultMobileClientProbe;
}

/**
 * Resolve when the Appium client is importable; throw a DummyConfigError naming
 * the install command when it is not. Headless and side-effect free — it starts
 * nothing, dials nothing, and prompts for nothing.
 */
export async function probeMobileClient(): Promise<void> {
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
}
