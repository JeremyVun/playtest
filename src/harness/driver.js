// The transport seam (docs/CONTRACTS.md §16). `runner.js` depends only on this
// factory and the Driver interface it returns — it never imports a concrete
// driver and never reaches into a transport client. One defaulted config key,
// `app.driver` (web | mobile | api; absent ⇒ web), selects the implementation;
// this switch is the entire dispatch — no registry, no driver discovery.
//
// A Driver implements: start(), captureSnapshot(stepNum), execute(action),
// executeLocator(actedStep), finalPageCheck(query), location(), effectToken(),
// consoleErrors(), close(); and exposes id, settle, overlay. ExecResult/Snapshot
// shapes per §4 (the envelope field stays named `url`; it holds a screen/route
// id under the mobile driver). resolution.locator is an opaque durable handle
// (Playwright selector / Appium accessibility-id / "METHOD /path"); diffTracks
// and act mode treat it as a string.
import { DummyConfigError } from "./config.js";
import { WebDriver } from "./drivers/web.js";

/**
 * @param {object} rc ResolvedCase (rc.env.driver picks the transport)
 * @param {{ baseUrl: string, managed: boolean }} env from prepareEnv
 * @param {{ runDir: string, headed?: boolean }} opts
 * @returns {Promise<object>} a live Driver
 */
export async function createDriver(rc, env, { runDir, headed = false } = {}) {
  const driver = rc.env?.driver ?? "web";
  switch (driver) {
    case "web":
      return WebDriver.launch({
        baseUrl: env.baseUrl,
        runDir,
        storageState: rc.env.storage_state,
        headed,
      });
    case "mobile": {
      // Dynamic import keeps the Appium/webdriverio module graph out of web/api
      // runs; webdriverio itself is an optionalDependency, lazy-imported deeper.
      const { MobileDriver } = await import("./drivers/mobile.js");
      return MobileDriver.launch({ env: rc.env, runDir });
    }
    case "api": {
      const { ApiDriver } = await import("./drivers/api.js");
      // base_url is the prepareEnv-resolved origin (compose port rewrite et al.);
      // openapi + the rest ride on rc.env.
      return ApiDriver.launch({ env: { ...rc.env, base_url: env.baseUrl }, runDir });
    }
    default:
      throw new DummyConfigError(`unknown app.driver "${driver}" (expected web | mobile | api)`);
  }
}
