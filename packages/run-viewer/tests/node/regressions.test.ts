// Regression pins for two silent failure classes: absent optional knobs must
// not become undefined/NaN, and the history-entry shape must stay shared
// between CLI and viewer consumers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { initialQuietMs } from "@playtest/core/artifacts";
import { manifestToHistoryEntry } from "../../src/node/index.ts";

test("initialQuietMs derives a first-settle window when override is absent", () => {
  assert.equal(initialQuietMs(500, undefined), 1000);
});

test("manifestToHistoryEntry returns the movement history shape", () => {
  const pins = { step_schema_version: 7 };
  const entry = manifestToHistoryEntry(
    {
      run_id: "2026-07-04T0000-abcd",
      started_at: "2026-07-04T00:00:00Z",
      result: { status: "pass" },
      mode: "record",
      healed: true,
      duration_ms: 1234,
      totals: { steps: 4, lcp_ms: 321 },
      pins,
    },
    90,
  );

  assert.deepEqual(Object.keys(entry), [
    "run_id",
    "started_at",
    "status",
    "mode",
    "healed",
    "duration_ms",
    "steps",
    "score",
    "lcp_ms",
    "pins",
  ]);
  assert.deepEqual(entry, {
    run_id: "2026-07-04T0000-abcd",
    started_at: "2026-07-04T00:00:00Z",
    status: "pass",
    mode: "record",
    healed: true,
    duration_ms: 1234,
    steps: 4,
    score: 90,
    lcp_ms: 321,
    pins,
  });
});
