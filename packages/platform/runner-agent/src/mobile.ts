// Post-claim mobile preflight and runtime-target assembly
// (docs/contracts/interfaces.md, "Mobile preflight").
//
// Preflight is runner-side diagnosis of runner-local setup. The platform's only
// involvement is receiving ONE actionable infra error instead of a mid-case
// driver stack forty minutes into a group, so everything here is shaped around
// two outputs:
//
//   error  — what the run page says. It names the remedy and the config key,
//            and it carries NO physical fact: no build path, no device id, no
//            Appium endpoint. Those are exactly the facts this refactor keeps
//            on the runner.
//   detail — what this machine's own terminal says, where the path IS the
//            answer to "which file did you mean".
//
// What preflight deliberately does NOT do is create an Appium session. Creating
// one installs and launches the app; a viability session would run the
// install/wipe/launch dance twice and collide with `preserve_session`. So the
// first REAL execution session is the final preflight boundary — its failure
// classified infra by the executor — and a one-case group creates exactly one
// Appium session.
import fs from "node:fs";
import { probeMobileClient } from "@playtest/core/suite";
import { PLATFORM_DRIVER, probeAppiumStatus } from "./appium.ts";
import type { AppiumHandle, AppiumDeps } from "./appium.ts";
import type { MobileBinding } from "./runner-config.ts";

export interface MobilePreflightFailure {
  /** One line, safe to send: the remedy, with no path, device or endpoint. */
  error: string;
  /** The same finding for this machine's log, where paths are the point. */
  detail: string;
}

export interface MobilePreflightDeps {
  exists?: (file: string) => boolean;
  probeClient?: () => Promise<void>;
  statusOk?: AppiumDeps["statusOk"];
  installedDrivers?: () => Promise<string[]>;
}

const STATUS_TIMEOUT_MS = 5_000;

/**
 * Everything that can be known without starting a session, in the order a
 * person would check it. Returns null when the group may proceed.
 */
export async function preflightMobile(
  binding: MobileBinding,
  handle: AppiumHandle,
  deps: MobilePreflightDeps = {},
): Promise<MobilePreflightFailure | null> {
  const exists = deps.exists ?? ((file: string) => fs.existsSync(file));
  const probeClient = deps.probeClient ?? probeMobileClient;
  const statusOk = deps.statusOk ?? probeAppiumStatus;
  const bound = `${binding.applicationKey}/${binding.ringKey}`;
  const key = `targets.${binding.applicationKey}.${binding.ringKey}.app`;

  if (!exists(binding.app)) {
    return {
      error:
        `the app build this runner binds to "${bound}" is not on the runner's disk — the claiming runner supplies the ` +
        `build, so rebuild it or correct ${key} in that runner's config file`,
      detail: `mobile preflight: ${key} points at "${binding.app}", which does not exist`,
    };
  }
  try {
    await probeClient();
  } catch (e: RunnerDynamic) {
    return {
      error: `this runner cannot drive a mobile case: ${firstLine(e)}`,
      detail: `mobile preflight: the Appium client is not usable on this runner — ${firstLine(e)}`,
    };
  }
  if (!(await statusOk(handle.url, STATUS_TIMEOUT_MS))) {
    return {
      error:
        `the Appium backend "${handle.name}" this runner is configured with is not answering — check that backend in the ` +
        `runner's config file (mobile.backends.${handle.name})`,
      detail: `mobile preflight: nothing answered ${handle.url}/status for backend "${handle.name}"`,
    };
  }
  if (deps.installedDrivers) {
    const driver = PLATFORM_DRIVER[binding.platform];
    const installed = await deps.installedDrivers();
    if (!installed.includes(driver)) {
      return {
        error: `the Appium "${driver}" driver is not installed on this runner — run: appium driver install ${driver}`,
        detail: `mobile preflight: backend "${handle.name}" has no ${driver} driver (installed: ${installed.join(", ") || "none"})`,
      };
    }
  }
  return null;
}

/**
 * The runtime target one mobile binding and its live backend produce
 * (docs/contracts/engine.md, "Runtime target"). It is a WHOLE-target
 * replacement, so an omitted `device` means Appium's default — never the device
 * the suite happened to author.
 */
export function mobileRuntimeTarget(binding: MobileBinding, handle: AppiumHandle): Record<string, string> {
  return {
    app: binding.app,
    platform: binding.platform,
    appium_url: handle.url,
    ...(binding.device ? { device: binding.device } : {}),
  };
}

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
