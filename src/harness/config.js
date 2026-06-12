// Case discovery and playtest.yaml inheritance. See docs/CONTRACTS.md §1-2.
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv from "ajv";

export class DummyConfigError extends Error {}

const DEFAULTS_FILE = "playtest.yaml";

const DEFAULTS = {
  actor_model: "claude-haiku-4-5",
  grader_model: "claude-sonnet-4-6",
  max_steps: 50,
  timeout: "4m",
  persona: "tester",
  mode: "journey",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const loadSchema = (name) => JSON.parse(readFileSync(path.join(here, "../schemas", name), "utf8"));
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true }); // timeout/perf accept "90s" | 90000
const validateCase = ajv.compile(loadSchema("case.schema.json"));
const validateDefaults = ajv.compile(loadSchema("defaults.schema.json"));

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
      if (path.basename(abs) === DEFAULTS_FILE) {
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

  // Discovery personas fan-out: one instance per persona reference, id
  // <id>@<ref>, singular persona overridden.
  const expanded = [];
  for (const { personas, ...c } of cases) {
    if (personas) {
      for (const ref of personas) expanded.push({ ...c, id: `${c.id}@${ref}`, persona: ref });
    } else expanded.push(c);
  }
  return expanded.sort((a, b) => a.id.localeCompare(b.id));
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
      name !== DEFAULTS_FILE &&
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
  for (const f of defaultsChain(top, caseDir)) mergeDoc(merged, await loadYaml(f));
  mergeDoc(merged, await loadYaml(file));

  if (typeof merged.story !== "string" || !merged.story.trim()) {
    throw new DummyConfigError(`${file}: missing required "story"`);
  }
  if (baseUrl) {
    merged.env.base_url = baseUrl; // --base-url forces external mode
    merged.env.compose = null;
  }
  if (!merged.env.base_url) {
    throw new DummyConfigError(
      `${file}: no app.base_url configured (set it in a playtest.yaml, the case file, or pass --base-url)`,
    );
  }

  // Cross-field rules the schemas cannot express. success/personas are
  // case-only, so "declared" means "declared in this case file".
  if (merged.mode === "discovery" && merged.success !== undefined) {
    throw new DummyConfigError(
      `${file}: discovery cases have no pass/fail gate — remove "success" (ask "report" questions instead)`,
    );
  }
  if (merged.mode !== "discovery" && merged.personas !== undefined) {
    throw new DummyConfigError(
      `${file}: "personas" is discovery-only — set mode: discovery, or use the singular "persona"`,
    );
  }

  // Effective vision, resolved after the merge: explicit value wins; discovery
  // defaults to true. The validation rule IS the policy — no measured
  // (journey) run can ever send images, by construction.
  const vision = merged.vision ?? merged.mode === "discovery";
  if (vision && merged.mode !== "discovery") {
    throw new DummyConfigError(
      `${file}: "vision: true" is discovery-only — journey runs stay a11y-only by construction (set mode: discovery, or remove "vision")`,
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
    mode: merged.mode,
    persona: merged.persona,
    personas: merged.personas, // consumed by the fan-out in discoverCases, never on a final ResolvedCase
    tags,
    success,
    perf: merged.perf ?? {},
    report: merged.report ?? [],
    vision,
    limits: { max_steps: merged.max_steps, timeout_ms },
    actor_model: merged.actor_model,
    grader_model: merged.grader_model,
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

/**
 * Existing defaults files from `top` down to `caseDir`, top first. Walks UP
 * from the case dir so ancestor defaults are found even when the user named a
 * path below them; with no repo root (`top` null) it walks to the fs root.
 */
function defaultsChain(top, caseDir) {
  const files = [];
  let dir = caseDir;
  for (;;) {
    const file = path.join(dir, DEFAULTS_FILE);
    if (existsSync(file)) files.unshift(file);
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
  if ("env" in doc) {
    throw new DummyConfigError(`env: was renamed to app: (update ${path.relative(process.cwd(), file)})`);
  }
  // A bare key (`tags:` with no value) parses as null; treat it as absent so
  // placeholder keys keep resolving to their defaults, as before validation.
  for (const k of Object.keys(doc)) if (doc[k] === null) delete doc[k];
  // Validate the raw doc (limits still nested, app paths still relative).
  const validate = path.basename(file) === DEFAULTS_FILE ? validateDefaults : validateCase;
  if (!validate(doc)) {
    throw new DummyConfigError(`${file}: ${describeSchemaErrors(validate.errors)}`);
  }
  // Either file kind may nest max_steps/timeout under `limits`; normalize to top-level.
  if (doc.limits && typeof doc.limits === "object") {
    if (doc.limits.max_steps !== undefined) doc.max_steps = doc.limits.max_steps;
    if (doc.limits.timeout !== undefined) doc.timeout = doc.limits.timeout;
    delete doc.limits;
  }
  // Relative paths resolve against the file that declared them.
  if (doc.app && typeof doc.app === "object") {
    for (const k of ["compose", "init", "storage_state"]) {
      if (typeof doc.app[k] === "string") doc.app[k] = path.resolve(path.dirname(file), doc.app[k]);
    }
  }
  return doc;
}

/** Ajv errors -> one friendly line naming each offending key. */
function describeSchemaErrors(errors) {
  const msgs = errors.map((e) => {
    const at = e.instancePath.slice(1).split("/").join(".");
    if (e.keyword === "additionalProperties") {
      return `unknown key "${at ? `${at}.` : ""}${e.params.additionalProperty}"`;
    }
    if (e.keyword === "required") {
      return `missing required "${at ? `${at}.` : ""}${e.params.missingProperty}"`;
    }
    if (e.keyword === "enum") {
      return `"${at}" must be one of ${e.params.allowedValues.join("/")}`;
    }
    if (e.keyword === "minItems") {
      return `"${at}" must list at least ${e.params.limit} ${e.params.limit === 1 ? "entry" : "entries"}`;
    }
    if (e.keyword === "uniqueItems") {
      return `"${at}" has duplicate entries`;
    }
    return `${at ? `"${at}" ` : ""}${e.message}`;
  });
  return [...new Set(msgs)].join("; ");
}

/** Nearest-wins merge; app merges per-key (into the internal env accumulator).
 *  Case-only keys (success/tags/report/personas) never arrive from a defaults
 *  file — defaults.schema.json rejects them at load. */
function mergeDoc(target, doc) {
  for (const [k, v] of Object.entries(doc)) {
    if (k === "app") {
      if (v && typeof v === "object") Object.assign(target.env, v);
    } else target[k] = v;
  }
}
