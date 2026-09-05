// Unit tests for coerceStringifiedArgs (packages/core/src/llm.ts): real gateways
// sometimes JSON-encode a nested object tool argument as a STRING, which then
// fails object-shaped schema validation. The helper un-stringifies only the
// top-level values that parse to an object/array and leaves everything else
// untouched. No network or API key is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceStringifiedArgs, forcedToolCall, LlmError } from "../../src/llm.ts";
import { startJsonServer, toolCompletion } from "../../../../tests/support/json-server.ts";

test("a stringified-object action becomes an object", () => {
  const args = {
    thought: "I'll type the text.",
    action: '{"type":"type","ref":"e1","text":"buy milk"}',
    expectation: "the input shows the text",
  };
  const out = coerceStringifiedArgs(args);
  assert.deepEqual(out.action, { type: "type", ref: "e1", text: "buy milk" });
  // The genuine string fields are left exactly as-is.
  assert.equal(out.thought, "I'll type the text.");
  assert.equal(out.expectation, "the input shows the text");
});

test("a stringified-array value becomes an array", () => {
  const out = coerceStringifiedArgs({ evidence_steps: "[1, 2, 3]" });
  assert.deepEqual(out.evidence_steps, [1, 2, 3]);
});

test("a normal object action is untouched", () => {
  const action = { type: "click", ref: "e2" };
  const out = coerceStringifiedArgs({ thought: "go", action, expectation: "ok" });
  assert.deepEqual(out.action, { type: "click", ref: "e2" });
});

test("a genuine string field is left alone", () => {
  const out = coerceStringifiedArgs({
    thought: "Marking it done.",
    expectation: "the checkbox shows as checked",
  });
  assert.equal(out.thought, "Marking it done.");
  assert.equal(out.expectation, "the checkbox shows as checked");
});

test("a non-JSON string that looks bracket-y is left alone", () => {
  // Starts with { but is not valid JSON — must not throw, must stay a string.
  const out = coerceStringifiedArgs({ note: "{not json at all" });
  assert.equal(out.note, "{not json at all");
});

test("a plain string that is not object/array JSON is left alone", () => {
  // "42" and '"hi"' parse as JSON but not to an object/array, so stay strings.
  const out = coerceStringifiedArgs({ count: "42", greeting: '"hi"' });
  assert.equal(out.count, "42");
  assert.equal(out.greeting, '"hi"');
});

test("non-object input is returned unchanged", () => {
  assert.equal(coerceStringifiedArgs(null as LegacyTestValue), null); // SAFETY: deliberately invalid input pins runtime tolerance
  assert.equal(coerceStringifiedArgs("x" as LegacyTestValue), "x"); // SAFETY: deliberately invalid input pins runtime tolerance
  const arr = [1, 2];
  assert.equal(coerceStringifiedArgs(arr as LegacyTestValue), arr); // SAFETY: deliberately invalid input pins runtime tolerance
});

test("the result is a new object (no mutation of the input)", () => {
  const args = { action: '{"type":"done"}' };
  const out = coerceStringifiedArgs(args);
  assert.notEqual(out, args);
  assert.equal(args.action, '{"type":"done"}'); // input unchanged
});

test("a terminal validation failure retains usage from both model attempts", async () => {
  const server = await startJsonServer(() => toolCompletion("step", { action: { type: "wait", seconds: 0 } }));
  const saved = {
    base: process.env.PLAYTEST_LLM_BASE_URL,
    key: process.env.PLAYTEST_LLM_API_KEY,
  };
  process.env.PLAYTEST_LLM_BASE_URL = server.url;
  delete process.env.PLAYTEST_LLM_API_KEY;

  try {
    await assert.rejects(
      () => forcedToolCall({
        model: "mock",
        messages: [{ role: "user", content: "wait" }],
        tool: {
          type: "function",
          function: { name: "step", parameters: { type: "object" } },
        },
        validate: () => "seconds must be >= 0.1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof LlmError);
        assert.deepEqual(error.tokens, { in: 2, out: 2, cache_read: 0 });
        assert.deepEqual(error.retries, ["seconds must be >= 0.1"]);
        assert.equal(error.rawAttempts?.length, 2);
        return true;
      },
    );
    assert.equal(server.requests().length, 2);
  } finally {
    saved.base == null ? delete process.env.PLAYTEST_LLM_BASE_URL : (process.env.PLAYTEST_LLM_BASE_URL = saved.base);
    saved.key == null ? delete process.env.PLAYTEST_LLM_API_KEY : (process.env.PLAYTEST_LLM_API_KEY = saved.key);
    await server.close();
  }
});
