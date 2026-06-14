// install-skill copies EVERY packaged agent skill into <project>/.claude/skills/
// <name>/SKILL.md, is idempotent per skill, and guards locally-modified skills
// behind --force. Freezes the broadened contract (CONTRACTS §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installSkill } from "../src/harness/new.js";
import { DummyConfigError } from "../src/harness/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "skills");

// The packaged skill set, discovered the same way installSkill does.
const skillNames = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, "SKILL.md")))
  .map((e) => e.name)
  .sort();

// Run installSkill with cwd pointed at a throwaway project (a .git marker makes
// findProjectRoot resolve there), silencing its console.log. Restores cwd.
function inProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-skill-"));
  fs.writeFileSync(path.join(dir, ".git"), ""); // marks the project root
  const cwd = process.cwd();
  const log = console.log;
  console.log = () => {};
  try {
    process.chdir(dir);
    return fn(dir);
  } finally {
    console.log = log;
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const destOf = (dir, name) => path.join(dir, ".claude", "skills", name, "SKILL.md");

test("install-skill installs every packaged skill, byte-for-byte", () => {
  assert.ok(skillNames.length >= 3, `expected the three shipped skills, found ${skillNames.join(", ")}`);
  assert.ok(
    ["playtest", "playtest-discovery", "playtest-stories"].every((n) => skillNames.includes(n)),
    `missing an expected skill among ${skillNames.join(", ")}`,
  );
  inProject((dir) => {
    installSkill();
    for (const name of skillNames) {
      const dest = destOf(dir, name);
      assert.ok(fs.existsSync(dest), `expected ${name} installed at ${dest}`);
      assert.equal(
        fs.readFileSync(dest, "utf8"),
        fs.readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8"),
        `${name} content must match the packaged skill`,
      );
    }
  });
});

test("install-skill is idempotent: a byte-identical rerun is a quiet success", () => {
  inProject(() => {
    installSkill();
    assert.doesNotThrow(() => installSkill(), "a second install of unchanged skills must not throw");
  });
});

test("install-skill guards a locally-modified skill behind --force", () => {
  inProject((dir) => {
    installSkill();
    const dest = destOf(dir, skillNames[0]);
    fs.writeFileSync(dest, "locally edited\n");
    assert.throws(() => installSkill(), DummyConfigError, "a modified skill must refuse without --force");
    assert.doesNotThrow(() => installSkill({ force: true }), "--force overwrites the local edit");
    assert.equal(
      fs.readFileSync(dest, "utf8"),
      fs.readFileSync(path.join(SKILLS_DIR, skillNames[0], "SKILL.md"), "utf8"),
      "--force restores the packaged content",
    );
  });
});
