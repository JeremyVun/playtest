import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { deriveSlug, validateSlug, personaYaml, personaPath } from "../../src/api/personas.ts";
import { AppError } from "../../src/errors.ts";

test("deriveSlug: lowercase, diacritics stripped, non-alphanumeric runs collapse to one hyphen", () => {
  assert.equal(deriveSlug("Café Régime"), "cafe-regime");
  assert.equal(deriveSlug("  Grumpy   Tester!! "), "grumpy-tester");
  assert.equal(deriveSlug("Ünïcödé Ñame"), "unicode-name");
  assert.equal(deriveSlug("---leading and trailing---"), "leading-and-trailing");
});

test("deriveSlug: caps at 50 chars and never leaves a trailing hyphen from the cut", () => {
  const long = "a".repeat(60) + " b";
  const slug = deriveSlug(long);
  assert.ok(slug.length <= 50, slug);
  assert.ok(!slug.endsWith("-"), slug);
});

test("deriveSlug: a name with no alphanumeric characters derives empty", () => {
  assert.equal(deriveSlug("!!!"), "");
});

test("validateSlug: derives from name when slug is omitted", () => {
  assert.equal(validateSlug({}, "Grumpy Tester"), "grumpy-tester");
});

test("validateSlug: an explicit slug is used verbatim when valid", () => {
  assert.equal(validateSlug({ slug: "my-persona" }, "irrelevant"), "my-persona");
});

test("validateSlug: an explicit slug failing the pattern is a friendly bad_request", () => {
  assert.throws(
    () => validateSlug({ slug: "Not_Valid!" }, "x"),
    (e) => e instanceof AppError && e.code === "bad_request",
  );
});

test("validateSlug: an empty derived slug is a friendly bad_request naming the fix", () => {
  assert.throws(
    () => validateSlug({}, "!!!"),
    (e) => e instanceof AppError && e.code === "bad_request" && /supply/.test(e.message),
  );
});

test("validateSlug: colliding with a built-in persona name is a friendly conflict", () => {
  for (const name of ["tester", "exploratory", "adversarial"]) {
    assert.throws(
      () => validateSlug({ slug: name }, "whatever"),
      (e) => e instanceof AppError && e.code === "conflict" && e.message.includes(name),
    );
    // Same collision when the slug is only derived (no explicit override).
    assert.throws(
      () => validateSlug({}, name),
      (e) => e instanceof AppError && e.code === "conflict",
    );
  }
});

test("personaPath: the suite-tree path a persona's rendered YAML occupies", () => {
  assert.equal(personaPath("grumpy-tester"), "personas/grumpy-tester.yaml");
});

test("personaYaml: round-trips name/description exactly, including tricky prose", () => {
  const persona = {
    name: "Grumpy Tester",
    description: "- acts like a bulleted list item\nnotes: this has a colon and a # hash mark\n",
  };
  const rendered = personaYaml(persona);
  const parsed = YAML.parse(rendered);
  assert.equal(parsed.name, persona.name);
  assert.equal(parsed.description, persona.description);
});
