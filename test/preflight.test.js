// Driver-aware preflight (preflightFor, CONTRACTS.md §16): the detect-and-install
// gate keyed on the resolved driver. Offline — no browser launch, no device.
// Covers the two non-web branches that have no install step of their own:
//   - mobile: webdriverio is an optionalDependency and is genuinely absent in
//     this repo's install, so the gate must turn the missing client into a
//     friendly DummyConfigError naming the package (never a raw MODULE_NOT_FOUND).
//   - api: nothing to install, so the gate is a no-op resolving to { channel: null }.
// The web branch (ensureBrowser → pinned chromium) is exercised by the e2e and
// by preflight's own install-prompt path elsewhere; this file owns the seam.
import { test } from "node:test";
import assert from "node:assert/strict";

import { preflightFor } from "../src/harness/preflight.js";
import { DummyConfigError } from "../src/harness/config.js";

test("preflightFor('mobile') rejects with a DummyConfigError naming webdriverio (client absent)", async () => {
  await assert.rejects(
    () => preflightFor("mobile"),
    (e) => e instanceof DummyConfigError && /webdriverio/.test(e.message),
  );
});

test("preflightFor('api') is a no-op that resolves to { channel: null }", async () => {
  assert.deepEqual(await preflightFor("api"), { channel: null });
});
