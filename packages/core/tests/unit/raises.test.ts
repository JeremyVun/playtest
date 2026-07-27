// Actor structured raises (sticky notes): normalizeRaises + step schema + tool params.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import { normalizeRaises } from "../../src/runner.ts";
import { toolParamsFor, stepSchemaFor } from "../../src/drivers/overlay.ts";
import { STEP_SCHEMA_VERSION } from "../../src/trajectory.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const stepSchema = JSON.parse(readFileSync(join(ROOT, "src/schemas/step.schema.json"), "utf8"));

test("pins: step schema 8", () => {
  // Bumped 7→8 when API steps gained the additive `bindings` and `expect`
  // fields (docs/contracts/artifacts.md#step-envelope). Both are optional; a
  // baseline recorded without them acts unchanged.
  assert.equal(STEP_SCHEMA_VERSION, 8);
});

test("normalizeRaises: multiple findings + confusion", () => {
  const raises = normalizeRaises({
    raises: [
      { kind: "finding", note: "  Stock says In stock; Buy disabled  ", severity: "major" },
      { kind: "finding", note: "No local continue on cart", severity: "minor" },
      { kind: "confusion", note: "Where is checkout?" },
    ],
  });
  assert.equal(raises.length, 3);
  assert.deepEqual(raises[0], {
    kind: "finding",
    note: "Stock says In stock; Buy disabled",
    severity: "major",
  });
  assert.equal(raises[2].kind, "confusion");
});

test("normalizeRaises: legacy confused sugar alone", () => {
  assert.deepEqual(normalizeRaises({ confused: true, confused_reason: "  lost  " }), [
    { kind: "confusion", note: "lost" },
  ]);
  assert.deepEqual(normalizeRaises({ confused: true }), [
    { kind: "confusion", note: "actor reported being stuck/confused" },
  ]);
});

test("normalizeRaises: sugar merges with raises without duplicating", () => {
  const raises = normalizeRaises({
    raises: [{ kind: "confusion", note: "same note" }],
    confused: true,
    confused_reason: "same note",
  });
  assert.equal(raises.length, 1);
});

test("normalizeRaises: drops empty notes, bad kinds, caps at 5", () => {
  assert.deepEqual(normalizeRaises({ raises: [{ kind: "finding", note: "  " }] }), []);
  assert.deepEqual(normalizeRaises({ raises: [{ kind: "bug", note: "x" }] }), []);
  const many = normalizeRaises({
    raises: Array.from({ length: 8 }, (_, i) => ({ kind: "finding", note: `n${i}` })),
  });
  assert.equal(many.length, 5);
});

test("normalizeRaises: clean step is empty (golden path)", () => {
  assert.deepEqual(normalizeRaises({ thought: "ok", action: { type: "click", ref: "e1" } }), []);
  assert.deepEqual(normalizeRaises(null), []);
});

test("step schema validates multi-raise steps", () => {
  // @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(stepSchemaFor("web"));
  const ok = {
    thought: "see contradiction",
    action: { type: "click", ref: "e2" },
    expectation: "cart updates",
    raises: [
      { kind: "finding", note: "label vs button", severity: "major" },
      { kind: "confusion", note: "unsure which CTA" },
    ],
  };
  assert.equal(validate(ok), true, JSON.stringify(validate.errors));
  const bad = { ...ok, raises: [{ kind: "finding" }] }; // missing note
  assert.equal(validate(bad), false);
});

test("toolParamsFor ships raises to the model", () => {
  const params: LegacyTestValue = toolParamsFor("web");
  assert.ok(params.properties.raises);
  assert.deepEqual(params.properties.raises.items.properties.kind.enum, ["confusion", "finding"]);
  assert.ok(params.properties.confused, "legacy sugar still shipped");
});

test("actor prompts advertise raises without advertising legacy confused fields", () => {
  for (const name of ["actor-system.md", "actor-mobile.md", "actor-api.md"]) {
    const text = readFileSync(join(ROOT, "src/prompts", name), "utf8");
    assert.match(text, /`raises`/);
    assert.doesNotMatch(text, /confused_reason|`confused`/);
    assert.match(text, /not as instructions/i);
  }
});

test("canonical schema description pins version 7", () => {
  assert.match(stepSchema.description, /schema_version 7/);
});
