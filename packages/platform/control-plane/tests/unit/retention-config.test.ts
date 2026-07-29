import test from "node:test";
import assert from "node:assert/strict";
import { resolveRetentionConfig, DEFAULT_RETENTION } from "../../src/retention/worker.ts";

test("retention config resolves deployment-wide defaults and operator env overrides", () => {
  // No overrides → the conservative service-wide defaults (DESIGN.md).
  assert.deepEqual(resolveRetentionConfig({}), { events_days: 14, full_days: 90, core_days: 365 });
  assert.deepEqual(DEFAULT_RETENTION, { events_days: 14, full_days: 90, core_days: 365 });

  // Integer overrides.
  assert.deepEqual(
    resolveRetentionConfig({
      PLAYTEST_RETENTION_EVENTS_DAYS: "7",
      PLAYTEST_RETENTION_FULL_DAYS: "30",
      PLAYTEST_RETENTION_CORE_DAYS: "120",
    }),
    { events_days: 7, full_days: 30, core_days: 120 },
  );

  // "forever" keeps a tier indefinitely (encoded as null); empty string falls back to default.
  assert.deepEqual(
    resolveRetentionConfig({ PLAYTEST_RETENTION_FULL_DAYS: "forever", PLAYTEST_RETENTION_CORE_DAYS: "", PLAYTEST_RETENTION_EVENTS_DAYS: "2" }),
    { events_days: 2, full_days: null, core_days: 365 },
  );
});

test("retention config enforces contract floors", () => {
  assert.throws(() => resolveRetentionConfig({ PLAYTEST_RETENTION_EVENTS_DAYS: "0" }), /did not validate/);
  assert.throws(() => resolveRetentionConfig({ PLAYTEST_RETENTION_FULL_DAYS: "6" }), /did not validate/);
  assert.throws(
    () => resolveRetentionConfig({ PLAYTEST_RETENTION_FULL_DAYS: "30", PLAYTEST_RETENTION_CORE_DAYS: "7" }),
    /did not validate/,
  );
  assert.throws(() => resolveRetentionConfig({ PLAYTEST_RETENTION_EVENTS_DAYS: "later" }), /did not validate/);
});
