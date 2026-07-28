// The mobile client probe (docs/contracts/engine.md#driver-contract): core's
// answer to "is the Appium client importable", asked identically by the CLI's
// driver preflight and by any other host.
//
// webdriverio is an optionalDependency, so whether it is present in any given
// node_modules is not something a hermetic test may depend on — both branches
// run through __setMobileClientProbe. The probe is headless by construction: it
// starts nothing, dials nothing, and prompts for nothing, which is what makes it
// reusable outside a terminal.
import { test } from "node:test";
import assert from "node:assert/strict";

import { probeMobileClient, __setMobileClientProbe } from "../../src/preflight.ts";
import { DummyConfigError } from "../../src/config.ts";

test("a missing client becomes a DummyConfigError naming the package to install", async (t) => {
  t.after(() => __setMobileClientProbe(null));
  __setMobileClientProbe(() => {
    const e: LegacyTestValue = new Error("Cannot find package 'webdriverio'");
    e.code = "ERR_MODULE_NOT_FOUND";
    throw e;
  });
  await assert.rejects(
    () => probeMobileClient(),
    (e) =>
      e instanceof DummyConfigError &&
      /npm i webdriverio/.test(e.message) &&
      // never the raw module-resolution failure
      !/MODULE_NOT_FOUND/.test(e.message),
  );
});

test("a client that is present but broken reports its real cause, not a reinstall hint", async (t) => {
  t.after(() => __setMobileClientProbe(null));
  __setMobileClientProbe(() => {
    throw new Error("Cannot load native binding\n  at somewhere deep");
  });
  await assert.rejects(
    () => probeMobileClient(),
    (e) =>
      e instanceof DummyConfigError &&
      /failed to load: Cannot load native binding/.test(e.message) &&
      !/npm i webdriverio/.test(e.message) &&
      !/at somewhere deep/.test(e.message),
  );
});

test("a present client resolves, headlessly and with no side effect", async (t) => {
  t.after(() => __setMobileClientProbe(null));
  let calls = 0;
  __setMobileClientProbe(async () => {
    calls += 1;
    return { remote: () => {} };
  });
  assert.equal(await probeMobileClient(), undefined);
  assert.equal(calls, 1);
});
