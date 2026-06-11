// Case discovery and playtest.yaml inheritance. See docs/CONTRACTS.md §1-2.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export class DummyConfigError extends Error {}

// Suite defaults live in playtest.yaml; dummy.yaml is the deprecated old name.
const DEFAULTS_FILES = ["playtest.yaml", "dummy.yaml"];

const DEFAULTS = {
  actor_model: "claude-haiku-4-5",
  grader_model: "claude-sonnet-4-6",
  max_steps: 50,
  timeout: "4m",
  runs_per_case: 1,
  persona: "tester",
};

const SUCCESS_KINDS = ["url_matches", "element_exists", "api_called", "assert"];
const DURATION_UNITS = { ms: 1, s: 1000, m: 60000 };

/** "5m" | "90s" | "250ms" | number -> milliseconds. */
export function parseDuration(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
    if (m) return Math.round(Number(m[1]) * DURATION_UNITS[m[2] ?? "ms"]);
  }
  throw new DummyConfigError(
    `invalid duration ${JSON.stringify(v)} (use "5m", "90s", "250ms", or a number of ms)`,
  );
}

/**
 * Discover and resolve test cases.
 * @param {string[]} paths dirs and/or .yaml case files
 * @param {{ tags?: string[], baseUrl?: string|null }} [opts]
 * @returns {Promise<object[]>} ResolvedCase[] sorted by id
 */
export async function discoverCases(paths, { tags = [], baseUrl = null } = {}) {
  const found = new Map(); // abs case file -> suite root the user named
  for (const p of paths) {
    const abs = path.resolve(p);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new DummyConfigError(`no such path: ${p}`);
    }
    if (st.isDirectory()) {
      for (const f of await walkYaml(abs)) if (!found.has(f)) found.set(f, abs);
    } else {
      if (DEFAULTS_FILES.includes(path.basename(abs))) {
        throw new DummyConfigError(`${p} is a defaults file, not a test case`);
      }
      if (!found.has(abs)) found.set(abs, path.dirname(abs));
    }
  }

  const cases = [];
  for (const [file, root] of found) {
    const c = await resolveCase(file, root, baseUrl);
    if (tags.length === 0 || c.tags.some((t) => tags.includes(t))) cases.push(c);
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

async function walkYaml(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      // personas/ holds persona definitions (actor.js loadPersona), not cases.
      if (name === "personas") continue;
      out.push(...(await walkYaml(full)));
    } else if (
      name.endsWith(".yaml") &&
      !DEFAULTS_FILES.includes(name) &&
      !name.includes(".baseline.") &&
      !name.includes(".healed.")
    ) {
      out.push(full);
    }
  }
  return out;
}

async function resolveCase(file, namedRoot, baseUrl) {
  const caseDir = path.dirname(file);
  const top = findRepoRoot(caseDir); // null -> no .git ancestor: every ancestor contributes

  const merged = { ...DEFAULTS, env: {} };
  for (const f of defaultsChain(top, caseDir)) mergeDoc(merged, await loadYaml(f), false);
  mergeDoc(merged, await loadYaml(file), true);

  if (typeof merged.story !== "string" || !merged.story.trim()) {
    throw new DummyConfigError(`${file}: missing required "story"`);
  }
  if (baseUrl) {
    merged.env.base_url = baseUrl; // --base-url forces external mode
    merged.env.compose = null;
  }
  if (!merged.env.base_url) {
    throw new DummyConfigError(
      `${file}: no env.base_url configured (set it in a playtest.yaml, the case file, or pass --base-url)`,
    );
  }

  const success = merged.success ?? [];
  if (!Array.isArray(success)) throw new DummyConfigError(`${file}: "success" must be an array`);
  for (const c of success) {
    const keys = c && typeof c === "object" ? Object.keys(c) : [];
    if (keys.length !== 1 || !SUCCESS_KINDS.includes(keys[0])) {
      throw new DummyConfigError(
        `${file}: each success entry must have exactly one of ${SUCCESS_KINDS.join("/")} (got ${JSON.stringify(c)})`,
      );
    }
  }

  const tags = merged.tags ?? [];
  if (!Array.isArray(tags)) throw new DummyConfigError(`${file}: "tags" must be an array`);

  let timeout_ms;
  try {
    timeout_ms = parseDuration(merged.timeout);
  } catch (e) {
    throw new DummyConfigError(`${file}: ${e.message}`);
  }

  return {
    id: path.relative(namedRoot, file).replace(/\.yaml$/, "").split(path.sep).join("/"),
    file,
    name: path.basename(file, ".yaml"),
    story: merged.story,
    persona: merged.persona,
    tags,
    success,
    perf: merged.perf ?? {},
    limits: { max_steps: merged.max_steps, timeout_ms },
    actor_model: merged.actor_model,
    grader_model: merged.grader_model,
    runs_per_case: merged.runs_per_case,
    env: {
      base_url: merged.env.base_url,
      compose: merged.env.compose ?? null,
      init: merged.env.init ?? null,
      storage_state: merged.env.storage_state ?? null,
    },
  };
}

/** Nearest ancestor dir containing .git, or null. */
function findRepoRoot(fromDir) {
  let dir = fromDir;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let warnedDeprecatedDefaults = false; // deprecation note prints once per process

/**
 * Existing defaults files from `top` down to `caseDir`, top first. Walks UP
 * from the case dir so ancestor defaults are found even when the user named a
 * path below them; with no repo root (`top` null) it walks to the fs root.
 * Each level contributes playtest.yaml, else dummy.yaml — never both.
 */
function defaultsChain(top, caseDir) {
  const files = [];
  let dir = caseDir;
  for (;;) {
    const preferred = path.join(dir, "playtest.yaml");
    const legacy = path.join(dir, "dummy.yaml");
    if (existsSync(preferred)) files.unshift(preferred);
    else if (existsSync(legacy)) {
      files.unshift(legacy);
      if (!warnedDeprecatedDefaults) {
        warnedDeprecatedDefaults = true;
        console.error(`note: ${path.relative(process.cwd(), legacy)} is deprecated; rename it to playtest.yaml`);
      }
    }
    if (dir === top) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

async function loadYaml(file) {
  let doc;
  try {
    doc = YAML.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    throw new DummyConfigError(`${file}: ${e.message}`);
  }
  if (doc == null) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new DummyConfigError(`${file}: expected a YAML mapping at the top level`);
  }
  // Case files may nest max_steps/timeout under `limits`; normalize to top-level.
  if (doc.limits && typeof doc.limits === "object") {
    if (doc.limits.max_steps !== undefined) doc.max_steps = doc.limits.max_steps;
    if (doc.limits.timeout !== undefined) doc.timeout = doc.limits.timeout;
    delete doc.limits;
  }
  // Relative paths resolve against the file that declared them.
  if (doc.env && typeof doc.env === "object") {
    for (const k of ["compose", "init", "storage_state"]) {
      if (typeof doc.env[k] === "string") doc.env[k] = path.resolve(path.dirname(file), doc.env[k]);
    }
  }
  return doc;
}

/** Nearest-wins merge; env merges per-key; success/tags are case-only. */
function mergeDoc(target, doc, isCaseFile) {
  for (const [k, v] of Object.entries(doc)) {
    if ((k === "success" || k === "tags") && !isCaseFile) continue;
    if (k === "env") {
      if (v && typeof v === "object") Object.assign(target.env, v);
    } else target[k] = v;
  }
}
