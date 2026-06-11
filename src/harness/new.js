// `playtest new` scaffolding: suites, cases, personas. cli.js stays wiring.
import fs from "node:fs";
import path from "node:path";
import { DummyConfigError } from "./config.js";

// dummy.yaml still marks a suite during the playtest.yaml migration (config.js).
const SUITE_FILES = ["playtest.yaml", "dummy.yaml"];

const CASE_TEMPLATE = `tags: []
story: |
  Describe what the user should do.

success:
  - assert: Describe what should be true when the task is complete.

perf:
  console_errors: 0
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

const isSuiteDir = (dir) => SUITE_FILES.some((f) => fs.existsSync(path.join(dir, f)));

function writeGuarded(file, content, force) {
  if (fs.existsSync(file) && !force) {
    throw new DummyConfigError(`${rel(file)} already exists (use --force to overwrite)`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Create `<dir>/playtest.yaml` (dir defaults to ./<slug>).
 * @param {{ force?: boolean, compose?: string|null }} [opts] --compose writes a
 *   managed-mode suite; the compose path (cwd-relative as usual) is rebased to
 *   be relative to the suite dir, because config.js resolves env.compose
 *   against the declaring file's directory, not the cwd.
 */
export function newSuite(name, dir, { force = false, compose = null } = {}) {
  const slug = slugify("suite", name);
  const target = path.resolve(dir ?? slug);
  const file = path.join(target, "playtest.yaml");
  let env = `env:\n  base_url: http://localhost:3000\n`;
  if (compose) {
    const composeAbs = path.resolve(compose);
    const r = path.relative(target, composeAbs);
    env = `env:\n  base_url: http://app:3000\n  compose: ${r.startsWith(".") ? r : `./${r}`}\n`;
    if (!fs.existsSync(composeAbs)) {
      console.error(`warning: compose file ${rel(composeAbs)} does not exist yet`);
    }
  }
  writeGuarded(file, `name: ${slug}\n${env}`, force);
  console.log(`Created suite: ${rel(file)}`);
  console.log(`Next: playtest new case add-todo ${rel(target)}`);
}

/**
 * Create `<suite>/<slug>.yaml`. The suite is `--suite`, the positional
 * suite_dir, or discovered (nearest ancestor suite, else a unique suite below cwd).
 * @param {{ force?: boolean, suite?: string|null }} [opts]
 */
export function newCase(name, suiteDirArg, { force = false, suite = null } = {}) {
  const slug = slugify("case", name);
  const given = suite ?? suiteDirArg ?? null;
  const suiteDir = given ? validateSuiteDir(given) : findSuiteDir();
  const file = path.join(suiteDir, `${slug}.yaml`);
  writeGuarded(file, CASE_TEMPLATE, force);
  console.log(`Created case: ${rel(file)}`);
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

function validateSuiteDir(given) {
  const abs = path.resolve(given);
  let ok = false;
  try {
    ok = fs.statSync(abs).isDirectory() && isSuiteDir(abs);
  } catch {}
  if (!ok) {
    throw new DummyConfigError(`${given} is not a Playtest suite. Expected ${path.join(given, "playtest.yaml")}.`);
  }
  return abs;
}

/** Nearest ancestor suite (cwd upward to the repo root), else a unique suite below cwd. */
function findSuiteDir() {
  for (let dir = process.cwd(); ; ) {
    if (isSuiteDir(dir)) return dir;
    const parent = path.dirname(dir);
    // The dir containing .git is the repo root: check it, then stop.
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  const found = [];
  scanForSuites(process.cwd(), found);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new DummyConfigError(
      `multiple suites found: ${found.map(rel).join(", ")} — pass --suite <dir> to pick one`,
    );
  }
  throw new DummyConfigError("no Playtest suite found under the current directory. Create one with: playtest new suite <name>");
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
