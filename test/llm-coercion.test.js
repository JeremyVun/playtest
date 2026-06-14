// Unit tests for coerceStringifiedArgs (src/harness/llm.js): real gateways
// sometimes JSON-encode a nested object tool argument as a STRING, which then
// fails object-shaped schema validation. The helper un-stringifies only the
// top-level values that parse to an object/array and leaves everything else
// untouched. No network or API key is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceStringifiedArgs } from "../src/harness/llm.js";

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
  assert.equal(coerceStringifiedArgs(null), null);
  assert.equal(coerceStringifiedArgs("x"), "x");
  const arr = [1, 2];
  assert.equal(coerceStringifiedArgs(arr), arr);
});

test("the result is a new object (no mutation of the input)", () => {
  const args = { action: '{"type":"done"}' };
  const out = coerceStringifiedArgs(args);
  assert.notEqual(out, args);
  assert.equal(args.action, '{"type":"done"}'); // input unchanged
});
