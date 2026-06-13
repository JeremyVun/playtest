// `playtest new` scaffolding: cases, personas, and the agent skill. cli.js
// stays wiring.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DummyConfigError } from "./config.js";

const CASE_TEMPLATE = `tags: []
description: One-line summary for run lists.
story: |
  Describe what the user should do.

success:
  - assert: Describe what should be true when the task is complete.

perf:
  console_errors: 0
`;

// The scaffolded defaults file is the documentation: active base_url,
// everything else present but commented.
const DEFAULTS_TEMPLATE = `app:
  base_url: http://localhost:3000
  # compose: ./docker-compose.test.yml   # Playtest boots/tears down the app
  # init: ./seed/reset.sh                # runs before each case
  # storage_state: ./seed/anon.json      # pre-built browser session
# actor_model: claude-haiku-4-5
# grader_model: claude-sonnet-4-6
`;

/**
 * "Login flow!" -> "login-flow". Sanitized to [a-z0-9._-] so the result is
 * YAML-safe: lowercase, any other character run becomes "-", leading/trailing
 * "-" trimmed. Path separators are rejected explicitly first, never nested.
 */
function slugify(kind, name) {
  if (/[/\\]/.test(name)) {
    throw new DummyConfigError(
      `${kind} name ${JSON.stringify(name)} must not contain path separators; pass the target directory as a separate argument`,
    );
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new DummyConfigError(
      `${kind} name ${JSON.stringify(name)} has no usable characters (slugs keep only a-z, 0-9, ".", "_", "-")`,
    );
  }
  return slug;
}

/** cwd-relative with a ./ prefix — creation output always prints relative paths. */
function rel(abs) {
  const r = path.relative(process.cwd(), abs) || ".";
  return r.startsWith(".") ? r : `./${r}`;
}

const isSuiteDir = (dir) => fs.existsSync(path.join(dir, "playtest.yaml"));

function writeGuarded(file, content, force) {
  if (fs.existsSync(file) && !force) {
    throw new DummyConfigError(`${rel(file)} already exists (use --force to overwrite)`);
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    if (e.code === "EEXIST" || e.code === "ENOTDIR") {
      throw new DummyConfigError(`cannot create ${rel(file)}: ${rel(path.dirname(file))} is not a directory`);
    }
    throw e;
  }
  fs.writeFileSync(file, content);
}

/**
 * Create `<dir>/<slug>.yaml`. The target dir is the positional `[dir]`, else
 * the nearest ancestor suite, else a unique suite below cwd, else ./tests/.
 * When no directory from the target up to the repo root has a playtest.yaml,
 * one is scaffolded next to the case (ancestor-aware: a suite subtree never
 * gets a shadowing defaults file).
 * @param {{ force?: boolean }} [opts]
 */
export function newCase(name, dirArg, { force = false } = {}) {
  const slug = slugify("case", name);
  // Reserved: <slug>.yaml would BE the defaults file, and discovery would
  // forever treat it as config, never as a case.
  if (slug === "playtest") {
    throw new DummyConfigError(
      `case name ${JSON.stringify(name)} collides with the playtest.yaml defaults file — pick a different name`,
    );
  }
  const targetDir = dirArg ? path.resolve(dirArg) : findTargetDir();
  const file = path.join(targetDir, `${slug}.yaml`);
  writeGuarded(file, CASE_TEMPLATE, force);
  console.log(`Created case: ${rel(file)}`);
  if (!hasAncestorDefaults(targetDir)) {
    const defaults = path.join(targetDir, "playtest.yaml");
    writeGuarded(defaults, DEFAULTS_TEMPLATE, force);
    console.log(`Created defaults: ${rel(defaults)}`);
  }
  console.log(`Next: playtest ${rel(file)}`);
}

/** Create `./personas/<slug>.yaml` (actor.js finds personas/ dirs upward from the case). */
export function newPersona(name, { force = false } = {}) {
  const slug = slugify("persona", name);
  const file = path.resolve("personas", `${slug}.yaml`);
  writeGuarded(file, `name: ${slug}\ndescription: |\n  Describe how this user approaches the app.\n`, force);
  console.log(`Created persona: ${rel(file)}`);
  console.log(`Next: set "persona: ${slug}" in a case file or playtest.yaml`);
}

/**
 * `playtest install-skill`: copy the packaged fix-loop skill into the
 * project's `.claude/skills/playtest/SKILL.md`, so the skill versions in
 * lockstep with the installed harness and its --json contract. Idempotent: a
 * byte-identical install is a quiet success; differing content needs --force
 * (the `new` guard wording), so local edits are never clobbered silently.
 * @param {{ force?: boolean }} [opts]
 */
export function installSkill({ force = false } = {}) {
  const src = fileURLToPath(new URL("../../skills/playtest/SKILL.md", import.meta.url));
  const content = fs.readFileSync(src, "utf8");
  const dest = path.join(findProjectRoot(), ".claude", "skills", "playtest", "SKILL.md");
  if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === content) {
    console.log(`Skill already installed (up to date): ${rel(dest)}`);
    return;
  }
  writeGuarded(dest, content, force);
  console.log(`Installed skill: ${rel(dest)}`);
  console.log("Agents with skill support pick it up from .claude/skills/ automatically.");
}

/** Nearest ancestor containing .git (the repo root), else cwd — the same walk
 *  the scaffolders use, so "the project" means the same thing everywhere. */
function findProjectRoot() {
  for (let dir = process.cwd(); ; ) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Does any dir from `start` up to the repo root (incl. both ends) hold a playtest.yaml? */
function hasAncestorDefaults(start) {
  for (let dir = start; ; ) {
    if (isSuiteDir(dir)) return true;
    const parent = path.dirname(dir);
    // The dir containing .git is the repo root: check it, then stop.
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) return false;
    dir = parent;
  }
}

/** Nearest ancestor suite (cwd upward to the repo root) > unique suite below cwd > ./tests/. */
function findTargetDir() {
  for (let dir = process.cwd(); ; ) {
    if (isSuiteDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  const found = [];
  scanForSuites(process.cwd(), found);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new DummyConfigError(
      `multiple suites found: ${found.map(rel).join(", ")} — pass a directory: playtest new <name> <dir>`,
    );
  }
  return path.resolve("tests"); // greenfield: scaffolding adds the defaults file
}

// Same skip rules as config.js walkYaml: dotdirs, node_modules, personas.
// A suite dir is not descended into: nested defaults belong to that suite.
function scanForSuites(dir, out) {
  if (isSuiteDir(dir)) {
    out.push(dir);
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const n = entry.name;
    if (!entry.isDirectory() || n.startsWith(".") || n === "node_modules" || n === "personas") continue;
    scanForSuites(path.join(dir, n), out);
  }
}
