import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const copies = [
  ["packages/core/src/schemas/case.schema.json", "packages/cli/skills/playtest-stories/schemas/case.schema.json"],
  ["packages/core/src/schemas/defaults.schema.json", "packages/cli/skills/playtest-stories/schemas/defaults.schema.json"],
  ["packages/core/src/schemas/case.schema.json", "packages/cli/skills/playtest-bughunt/schemas/case.schema.json"],
  ["packages/core/src/schemas/defaults.schema.json", "packages/cli/skills/playtest-bughunt/schemas/defaults.schema.json"],
  ["packages/core/src/personas/persona-exploratory.md", "packages/cli/skills/playtest-stories/persona-exploratory.md"],
  ["packages/core/src/personas/persona-adversarial.md", "packages/cli/skills/playtest-bughunt/persona-adversarial.md"],
  ["packages/core/src/prompts/story-authoring.md", "packages/cli/skills/playtest-stories/SKILL.md"],
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
