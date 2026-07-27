// Built-in persona resolution (docs/contracts/engine.md#personas-and-prompt).
// Offline, no LLM/browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPersona, listPersonas, builtinPersonas } from "../../../src/core/actor.ts";

test("built-in personas resolve: tester, exploratory, adversarial", () => {
  for (const name of ["tester", "exploratory", "adversarial"]) {
    const p = loadPersona(name);
    assert.equal(p.name, name);
    assert.ok(p.description.length > 40, `${name} description should be non-trivial`);
  }
});

test("adversarial persona encodes boundary / re-read / contradiction contract", () => {
  const { description } = loadPersona("adversarial");
  assert.match(description, /invalid or boundary/i);
  assert.match(description, /re-read/i);
  assert.match(description, /contradiction/i);
  assert.match(description, /not a security red-teamer/i);
});

test("listPersonas includes built-ins with file: null", () => {
  const listed = listPersonas();
  const byName = Object.fromEntries(listed.map((p) => [p.name, p]));
  for (const name of ["tester", "exploratory", "adversarial"]) {
    assert.ok(byName[name], `missing built-in ${name}`);
    assert.equal(byName[name].file, null);
  }
});

test("builtinPersonas carries the prose the actor is given, for the hosted picker", () => {
  const listed = builtinPersonas();
  assert.deepEqual(listed.map((p) => p.name), ["tester", "exploratory", "adversarial"]);
  for (const p of listed) {
    // Same bytes loadPersona injects as the prompt's ## Persona section — the
    // picker must never show a second, drifting copy of a built-in's wording.
    assert.equal(p.description, loadPersona(p.name).description);
    assert.ok(p.description.length > 40, `${p.name} description should be non-trivial`);
  }
});

test("unknown persona names the missing id and suggests playtest new persona", () => {
  assert.throws(
    () => loadPersona("no-such-persona-xyz"),
    (err: LegacyTestValue) => {
      assert.match(String(err.message), /no-such-persona-xyz/);
      assert.match(String(err.message), /playtest new persona/);
      return true;
    },
  );
});
