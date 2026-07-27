import { test } from "node:test";
import assert from "node:assert/strict";

test("the test bootstrap strips model credentials and blocks external fetch", () => {
  for (const key of [
    "PLAYTEST_LLM_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ]) {
    assert.equal(process.env[key], undefined, `${key} must not reach tests`);
  }
  assert.throws(
    () => fetch("https://example.com/would-spend-money"),
    /hermetic test blocked external request/,
  );
});
