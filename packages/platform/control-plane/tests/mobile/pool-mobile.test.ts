// Hosted mobile placement is DARK, and this tier is stood down with it.
//
// The suite that lived here proved a mobile suite could run through the claim
// board against a real iOS Simulator, with the device target riding an
// ENVIRONMENT record (`app.envs.<name>.{platform,app,device,appium_url}`) and a
// binary either uploaded to the platform or named by absolute path. Both of
// those are deleted: a mobile build's path, its device and its Appium endpoint
// are runner-local facts, and no platform-managed record stores or serves them
// (docs/contracts/hosted.md, "Applications and rings").
//
// Until the runner configuration file and its bindings land (R3 of the runner
// refactor, docs/backlog/runner-refactor/BUILD_PLAN.md), a hosted mobile launch
// is refused outright — `tests/integration/applications.test.ts` covers that
// refusal — so there is nothing here to drive. R3 reworks this file to the
// binding model: `targets.<application key>.<ring key>` in the runner's own
// config, a managed Appium backend, and claim-side compatibility.
//
// The file stays present and typechecking so the `test:mobile` script keeps
// working; it asserts only the fact that makes it empty.
import { test } from "node:test";
import assert from "node:assert/strict";

test("hosted mobile placement is stood down until runner bindings land (R3)", () => {
  assert.ok(true, "see the file header: this tier is reworked with the runner configuration file");
});
