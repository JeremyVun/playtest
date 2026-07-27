// Driver-aware preflight (preflightFor, docs/contracts/engine.md#driver-contract):
// the detect-and-install
// gate keyed on the resolved driver. Offline — no browser launch, no device.
// Covers the two non-web branches that have no install step of their own:
//   - mobile: webdriverio is an optionalDependency, so whether it is present in
//     any given node_modules is not something a hermetic test may depend on —
//     both branches are driven through __setMobileClientProbe. A missing client
//     must become a friendly DummyConfigError naming the package (never a raw
//     MODULE_NOT_FOUND); a present one is a no-op.
//   - api: nothing to install, so the gate is a no-op resolving to { channel: null }.
// The web branch (ensureBrowser → pinned chromium) is exercised by the e2e and
// by preflight's own install-prompt path elsewhere; this file owns the seam.
import { test } from "node:test";
import assert from "node:assert/strict";

import { preflightFor, __setMobileClientProbe } from "../../src/cli/preflight.ts";
import { DummyConfigError } from "../../src/core/config.ts";

test("preflightFor('mobile') rejects with a DummyConfigError naming webdriverio (client absent)", async (t) => {
  t.after(() => __setMobileClientProbe(null));
  __setMobileClientProbe(() => {
    const e: LegacyTestValue = new Error("Cannot find package 'webdriverio'");
    e.code = "ERR_MODULE_NOT_FOUND";
    throw e;
  });
  await assert.rejects(
    () => preflightFor("mobile"),
    (e) => e instanceof DummyConfigError && /webdriverio/.test(e.message),
  );
});

test("preflightFor('mobile') is a no-op when the client is present", async (t) => {
  t.after(() => __setMobileClientProbe(null));
  __setMobileClientProbe(async () => ({ remote: () => {} }));
  assert.deepEqual(await preflightFor("mobile"), { channel: null });
});

test("preflightFor('api') is a no-op that resolves to { channel: null }", async () => {
  assert.deepEqual(await preflightFor("api"), { channel: null });
});
