// `playtest new` scaffolding: cases, personas, and the agent skill. cli.js
// stays wiring.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DummyConfigError } from "./config.js";

const CASE_TEMPLATE = `story: |
  Describe what the user should do.

success:
  - console_errors: 0          # deterministic gate (web; no model call)
  # - assert: Describe what should be true when the task is complete.   # one grader call/run

# A bare story (empty success) already records a baseline. Add url_matches / element_exists /
# api_called for free, or the assert above (natural-language) — best from a real interview.
# tags: [smoke]                # optional, for --tag filtering
# description: One-line summary shown in run lists.
`;

// Per-driver case templates: success kinds + verbs that fit the transport, so a
// mobile/api user's first case isn't web-shaped. Selected by `new --driver`.
const CASE_TEMPLATES = {
  web: CASE_TEMPLATE,
  mobile: `story: |
  Describe what the user should do in the app.

# A bare story already records a baseline. Add a success gate once you know what
# proves the task done — screen_shows costs nothing; assert is one grader call/run.
# success:
#   - screen_shows: "~some-accessibility-id"
#   - assert: Describe what should be true on the final screen.
# tags: [smoke]                # optional, for --tag filtering
# description: One-line summary shown in run lists.
`,
  api: `story: |
  Describe what the integrator should do through the API.

# A bare story already records a baseline. Add a success gate once you know what
# proves the task done — api_called/response_status cost nothing; assert is one
# grader call per run.
# success:
#   - api_called: "POST /api/resource"
#   - response_status: "201"
#   - assert: Describe what should be true about the response.
# tags: [smoke]                # optional, for --tag filtering
# description: One-line summary shown in run lists.
`,
};

// The scaffolded defaults file is the documentation: active config for the
// driver, everything else present but commented.
const DEFAULTS_TEMPLATE = `app:
  base_url: http://localhost:3000
  # compose: ./docker-compose.yml        # Playtest boots/tears down the app
  # init: ./seed/reset.sh                # runs before each case
  # storage_state: ./seed/anon.json      # pre-built browser session
# actor_model: claude-sonnet-4-6      # the default; pin claude-haiku-4-5 to trade fidelity for cost
# grader_model: claude-sonnet-4-6
`;

const DEFAULTS_TEMPLATES = {
  web: DEFAULTS_TEMPLATE,
  mobile: `app:
  driver: mobile
  platform: ios                          # or android
  app: ./build/MyApp.app                 # the .app/.ipa/.apk to install
  # device: iPhone 15                    # target device/simulator (omit for a default)
  # appium_url: http://localhost:4723    # a running Appium server (omit for the local default)
  # init: ./seed/reset.mjs               # runs before each case (BASE_URL/RUN_ID)
# actor_model: claude-sonnet-4-6      # the default; pin claude-haiku-4-5 to trade fidelity for cost
# grader_model: claude-sonnet-4-6
`,
  api: `app:
  driver: api
  base_url: http://localhost:3000
  # openapi: ./openapi.yaml              # operations become the actor's "elements"
  # compose: ./docker-compose.yml        # Playtest boots/tears down the backend
  # init: ./seed/reset.mjs               # runs before each case (BASE_URL/RUN_ID)
# actor_model: claude-sonnet-4-6      # the default; pin claude-haiku-4-5 to trade fidelity for cost
# grader_model: claude-sonnet-4-6
`,
};

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
 * Create `<suite>/stories/<slug>.yaml` — cases live in the suite's stories/
 * container (config.js discovery + id). The suite dir is the positional `[dir]`,
 * else the nearest ancestor suite, else a unique suite below cwd, else ./tests/;
 * a `[dir]` pointing straight at a stories/ dir is used as-is (never nested).
 * When no directory from the suite root up to the repo root has a playtest.yaml,
 * one is scaffolded at the suite root (ancestor-aware: a suite subtree never
 * gets a shadowing defaults file).
 * @param {{ force?: boolean }} [opts]
 */
export function newCase(name, dirArg, { force = false, driver = "web" } = {}) {
  if (!CASE_TEMPLATES[driver]) {
    throw new DummyConfigError(`unknown --driver ${JSON.stringify(driver)} (web | mobile | api)`);
  }
  const slug = slugify("case", name);
  // Reserved: <slug>.yaml would BE the defaults file, and discovery would
  // forever treat it as config, never as a case.
  if (slug === "playtest") {
    throw new DummyConfigError(
      `case name ${JSON.stringify(name)} collides with the playtest.yaml defaults file — pick a different name`,
    );
  }
  const suiteDir = dirArg ? path.resolve(dirArg) : findTargetDir();
  const atStories = path.basename(suiteDir) === "stories";
  const suiteRoot = atStories ? path.dirname(suiteDir) : suiteDir;
  const file = path.join(atStories ? suiteDir : path.join(suiteDir, "stories"), `${slug}.yaml`);
  writeGuarded(file, CASE_TEMPLATES[driver], force);
  console.log(`Created case: ${rel(file)}`);
  if (!hasAncestorDefaults(suiteRoot)) {
    const defaults = path.join(suiteRoot, "playtest.yaml");
    writeGuarded(defaults, DEFAULTS_TEMPLATES[driver], force);
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
 * `playtest install-skill`: copy EVERY packaged agent skill into the project's
 * `.claude/skills/<name>/SKILL.md`, so a coding agent can author, run, and
 * review Playtest end to end, and the skills version in lockstep with the
 * installed harness and its --json contract. The set is discovered from the
 * packaged `skills/` dir (currently playtest, playtest-discovery,
 * playtest-stories) — no hardcoded list, so adding a skill needs no change here.
 * Per-skill idempotency: a byte-identical install is a quiet success; differing
 * content needs --force (the `new` guard wording), so local edits are never
 * clobbered silently.
 * @param {{ force?: boolean }} [opts]
 */
export function installSkill({ force = false } = {}) {
  const skillsDir = fileURLToPath(new URL("../../skills", import.meta.url));
  const names = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
  const root = findProjectRoot();
  let installed = 0;
  for (const name of names) {
    const content = fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    const dest = path.join(root, ".claude", "skills", name, "SKILL.md");
    if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === content) {
      console.log(`Skill already installed (up to date): ${rel(dest)}`);
      continue;
    }
    writeGuarded(dest, content, force); // throws the --force guard on a locally-modified skill
    console.log(`Installed skill: ${rel(dest)}`);
    installed++;
  }
  if (installed) console.log("Agents with skill support pick them up from .claude/skills/ automatically.");
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

// Same skip rules as config.js collectFrom: dotdirs, node_modules, personas, results.
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
    if (!entry.isDirectory() || n.startsWith(".") || n === "node_modules" || n === "personas" || n === "results") continue;
    scanForSuites(path.join(dir, n), out);
  }
}
