import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const copies = [
  ["src/core/schemas/case.schema.json", "skills/playtest-stories/schemas/case.schema.json"],
  ["src/core/schemas/defaults.schema.json", "skills/playtest-stories/schemas/defaults.schema.json"],
  ["src/core/schemas/case.schema.json", "skills/playtest-bughunt/schemas/case.schema.json"],
  ["src/core/schemas/defaults.schema.json", "skills/playtest-bughunt/schemas/defaults.schema.json"],
  ["src/core/personas/persona-exploratory.md", "skills/playtest-stories/persona-exploratory.md"],
  ["src/core/personas/persona-adversarial.md", "skills/playtest-bughunt/persona-adversarial.md"],
] as const;

test("bundled skill schemas and personas match their runtime sources", () => {
  for (const [source, bundled] of copies) {
    assert.equal(
      fs.readFileSync(path.join(ROOT, bundled), "utf8"),
      fs.readFileSync(path.join(ROOT, source), "utf8"),
      `${bundled} must match ${source}`,
    );
  }
});
