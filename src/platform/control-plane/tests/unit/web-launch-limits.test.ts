import { test } from "node:test";
import assert from "node:assert/strict";

import { launchLimitPlaceholders } from "../../../web/lib/launch-limits.js";

test("launch limits show effective defaults in the empty override fields", () => {
  assert.deepEqual(launchLimitPlaceholders([
    { limits: { max_steps: 100, timeout_ms: 600_000 } },
  ]), {
    maxSteps: "100",
    timeoutSeconds: "600",
  });
});

test("launch limits show the inherited range when story settings vary", () => {
  assert.deepEqual(launchLimitPlaceholders([
    { limits: { max_steps: 300, timeout_ms: 1_800_000 } },
    { limits: { max_steps: 50, timeout_ms: 240_000 } },
    { limits: { max_steps: 50, timeout_ms: 240_000 } },
  ]), {
    maxSteps: "50–300",
    timeoutSeconds: "240–1800",
  });
});

test("launch limits retain a useful placeholder when preview limits are absent", () => {
  assert.deepEqual(launchLimitPlaceholders([]), {
    maxSteps: "Default",
    timeoutSeconds: "Default",
  });
});
