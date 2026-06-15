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

// Per-driver success-criterion validity. The schemas accept every kind; this
// table is the cross-field rule the schema cannot express — a kind used under
// the wrong driver is a DummyConfigError naming the file (same shape as the
// discovery/vision rules). api_called omits mobile on purpose: the mobile driver
// has no network capture in v1 (driver-interface §10.1), so it would otherwise
// FAIL the gate against an empty list — a config error is louder and truthful.
const SUCCESS_KIND_DRIVERS = {
  url_matches: ["web", "api"],
  element_exists: ["web"],
  screen_shows: ["mobile"],
  api_called: ["web", "api"],
  response_status: ["api"],
  response_matches: ["api"],
  // No-console-errors is a deterministic correctness gate; web-only (it needs the
  // browser console). It used to live under perf — a latency bucket it never fit.
  console_errors: ["web"],
  assert: ["web", "mobile", "api"],
};
// Per-driver perf-key validity. Web vitals are web-only; mobile and api perf
// (cold-start/jank, latency) are deferred — any perf key on them is a config
// error, so no run silently lacks a threshold it declared (design §10.2).
const PERF_KEY_DRIVERS = {
  lcp_ms: ["web"],
  input_to_paint_ms: ["web"],
};
// Per-driver app.* key validity. The app schema is flat (every key allowed for
// every driver), so this is the cross-field rule it cannot express: a key set
// under the wrong driver is silently ignored at run time, which a config error
// naming the file makes loud instead (same shape as the perf-key rule). Keyed
// off the user-authored app.* keys only — derived keys (base_url/compose from
// --base-url) are applied after this check.
const APP_KEY_DRIVERS = {
  // base_url is required for web/api and optional for mobile (it is not used to
  // reach the device — that is appium_url — but it feeds the init script's
  // BASE_URL, the mobile pre-auth/seed path the schemas document for any driver).
  base_url: ["web", "mobile", "api"],
  compose: ["web", "api"],
  init: ["web", "mobile", "api"],
  storage_state: ["web"],
  driver: ["web", "mobile", "api"],
  platform: ["mobile"],
  app: ["mobile"],
  device: ["mobile"],
  appium_url: ["mobile"],
  openapi: ["api"],
};
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
  const strays = new Set(); // case-shaped yamls outside any suite root / stories/ dir
  for (const p of paths) {
    const abs = path.resolve(p);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new DummyConfigError(`no such path: ${p}`);
    }
    if (st.isDirectory()) {
      const walked = await walkCases(abs, abs);
      for (const f of walked.cases) if (!found.has(f)) found.set(f, abs);
      for (const s of walked.strays) strays.add(s);
    } else {
      // An explicitly named file is always a case, wherever it lives — naming it is intent.
      if (path.basename(abs) === DEFAULTS_FILE) {
        throw new DummyConfigError(`${p} is a defaults file, not a test case`);
      }
      if (!found.has(abs)) found.set(abs, path.dirname(abs));
    }
  }
  await warnStrays(strays, found);

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

/**
 * Case files under a named directory, split into { cases, strays }. A *.yaml is
 * a case only when it sits directly in a suite root (the named dir, or any
 * descendant holding a playtest.yaml) or anywhere under a `stories/` directory.
 * Other directories are still traversed — to find nested suites and their
 * stories — but a case-shaped *.yaml found loose in one is a STRAY: reported by
 * warnStrays, never run. personas/ and results/ are skipped entirely.
 */
async function walkCases(dir, namedRoot) {
  const cases = [];
  const strays = [];
  // Naming a stories/ dir directly means "everything under here is a case".
  if (path.basename(dir) === "stories") await collectStories(dir, cases);
  else await collectFrom(dir, dir === namedRoot, cases, strays);
  return { cases, strays };
}

async function collectFrom(dir, collectRoot, cases, strays) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".") || name === "node_modules" || name === "personas" || name === "results") continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (name === "stories") await collectStories(full, cases);
      else await collectFrom(full, existsSync(path.join(full, DEFAULTS_FILE)), cases, strays);
    } else if (isCaseFile(name)) {
      (collectRoot ? cases : strays).push(full);
    }
  }
}

/** Every case file beneath a stories/ subtree, at any depth. */
async function collectStories(dir, cases) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".") || name === "node_modules" || name === "personas" || name === "results") continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) await collectStories(full, cases);
    else if (isCaseFile(name)) cases.push(full);
  }
}

function isCaseFile(name) {
  return (
    name.endsWith(".yaml") &&
    name !== DEFAULTS_FILE &&
    !name.includes(".baseline.") &&
    !name.includes(".healed.")
  );
}

/**
 * A misplaced case must be loud, never silently skipped: warn (don't throw) for
 * each case-shaped yaml that sits outside a suite root / stories/ dir. Files
 * that don't parse as a case (no string `story`) are left alone — they aren't ours.
 */
async function warnStrays(strays, found) {
  for (const file of strays) {
    if (found.has(file)) continue;
    let doc;
    try {
      doc = YAML.parse(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object" || typeof doc.story !== "string") continue;
    console.warn(
      `playtest: ${path.relative(process.cwd(), file)} looks like a case but is outside the suite root and stories/ — it will not run. Move it under <suite>/stories/ to include it.`,
    );
  }
}

/**
 * Drop only the first (leftmost) `stories` segment from a split path. Migrated
 * suites have exactly one, so this is identical to dropping all of them; but a
 * deeper `stories/stories/` keeps its inner segment, so the two files stay
 * distinct instead of colliding on one id/baseline. Returns a new array.
 */
function dropFirstStories(parts) {
  const i = parts.indexOf("stories");
  if (i === -1) return parts;
  return parts.slice(0, i).concat(parts.slice(i + 1));
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
  // User-authored app.* keys, snapshotted before --base-url adds derived ones.
  const authoredAppKeys = Object.keys(merged.env);
  if (baseUrl) {
    merged.env.base_url = baseUrl; // --base-url forces external mode
    merged.env.compose = null;
  }
  const driver = merged.env.driver ?? "web";
  // app.* keys are driver-scoped (like success kinds / perf keys): a key set
  // under the wrong driver is otherwise ignored silently at run time, so it is
  // a config error naming the file. Only the user-authored keys are checked.
  for (const key of authoredAppKeys) {
    if (merged.env[key] == null) continue; // bare key (null) -> treated as absent
    const valid = APP_KEY_DRIVERS[key];
    if (valid && !valid.includes(driver)) {
      // Most common cause on the minimal-config path: a mobile/api case whose
      // author forgot to switch app.driver off its web default. Name that
      // recovery, the way the personas/vision/api_called errors below do.
      const hint =
        driver === "web" && valid.length === 1
          ? ` (set app.driver: ${valid[0]} if this case targets ${valid[0]})`
          : "";
      throw new DummyConfigError(
        `${file}: app.${key} is not valid for the ${driver} driver (valid: ${valid.join("/")})${hint}`,
      );
    }
  }
  // base_url is required for web/api (they reach an HTTP origin); mobile reaches
  // a device/Appium server and only needs the app binary.
  if (driver !== "mobile" && !merged.env.base_url) {
    throw new DummyConfigError(
      `${file}: no app.base_url configured (set it in a playtest.yaml, the case file, or pass --base-url)`,
    );
  }
  if (driver === "mobile" && !merged.env.app) {
    throw new DummyConfigError(
      `${file}: the mobile driver needs app.app — the path to the .app/.ipa/.apk to install`,
    );
  }

  // Cross-field rules the schemas cannot express. success is case-only, so
  // "declared" means "declared in this case file".
  if (merged.mode === "discovery" && merged.success !== undefined) {
    throw new DummyConfigError(
      `${file}: discovery cases have no pass/fail gate — remove "success" (ask "report" questions instead)`,
    );
  }

  // persona is a scalar (one actor) or a list (run several). A discovery case
  // fans out one run per persona (discoverCases); a journey has a single recorded
  // path, so a list there collapses to the first actor — loudly, not silently.
  let persona = merged.persona;
  let personas; // the discovery fan-out list; never lands on a final ResolvedCase
  if (Array.isArray(persona)) {
    if (merged.mode === "discovery") {
      personas = persona;
      persona = persona[0];
    } else {
      persona = persona[0];
      if (merged.persona.length > 1) {
        console.warn(
          `playtest: ${path.relative(process.cwd(), file)}: a journey runs one persona — using "${persona}", ignoring ${merged.persona.slice(1).join(", ")} (set mode: discovery to run every persona).`,
        );
      }
    }
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
    // The schema guarantees each entry is an object with exactly one key, and
    // that key is a known success kind (minProperties/maxProperties +
    // additionalProperties:false), so we key off it directly — no shape check.
    const kind = Object.keys(c)[0];
    // Driver-aware: a criterion used under the wrong transport is a config error
    // naming the file, never a silent gate FAIL (cross-field, like vision above).
    if (!SUCCESS_KIND_DRIVERS[kind].includes(driver)) {
      const where = `the ${driver} driver`;
      const hint =
        kind === "api_called" && driver === "mobile"
          ? `${file}: "api_called" needs network capture, which the mobile driver does not have yet — gate on screen_shows/assert instead`
          : `${file}: "${kind}" is not valid for ${where} (valid: ${SUCCESS_KIND_DRIVERS[kind].join("/")})`;
      throw new DummyConfigError(hint);
    }
  }

  // Perf thresholds are likewise driver-scoped (web vitals are web-only).
  for (const key of Object.keys(merged.perf ?? {})) {
    if (!(PERF_KEY_DRIVERS[key] ?? []).includes(driver)) {
      throw new DummyConfigError(
        `${file}: perf.${key} is not valid for the ${driver} driver (valid: ${(PERF_KEY_DRIVERS[key] ?? []).join("/") || "none"})`,
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
    // A `stories/` grouping directory is structural, not part of the id, so
    // `<suite>/stories/foo.yaml` and `<suite>/foo.yaml` both id as "foo"
    // (baselines mirror this — see trajectory.js baselinePaths). Only the first
    // (leftmost) `stories/` is dropped: a deeper `stories/` segment stays, so
    // nested cases keep distinct ids (and distinct baselines) rather than colliding.
    id: dropFirstStories(path.relative(namedRoot, file).replace(/\.yaml$/, "").split(path.sep)).join("/"),
    file,
    name: path.basename(file, ".yaml"),
    story: merged.story,
    description: merged.description ?? null, // human-facing summary; never reaches the actor prompt
    mode: merged.mode,
    persona,
    personas, // consumed by the fan-out in discoverCases, never on a final ResolvedCase
    tags,
    success,
    perf: merged.perf ?? {},
    report: merged.report ?? [],
    vision,
    limits: { max_steps: merged.max_steps, timeout_ms },
    actor_model: merged.actor_model,
    grader_model: merged.grader_model,
    env: {
      driver,
      base_url: merged.env.base_url ?? null,
      compose: merged.env.compose ?? null,
      init: merged.env.init ?? null,
      storage_state: merged.env.storage_state ?? null,
      // mobile (Appium) keys; null on web/api
      platform: merged.env.platform ?? null,
      app: merged.env.app ?? null,
      device: merged.env.device ?? null,
      appium_url: merged.env.appium_url ?? null,
      // api key; null on web/mobile
      openapi: merged.env.openapi ?? null,
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
  if ("personas" in doc) {
    throw new DummyConfigError(
      `personas: is now persona: — a scalar runs one actor, a list (e.g. [a, b]) fans out (update ${path.relative(process.cwd(), file)})`,
    );
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
  // Relative paths resolve against the file that declared them. `app` is the
  // mobile binary, `openapi` the api spec — both path-bearing like compose/init.
  if (doc.app && typeof doc.app === "object") {
    for (const k of ["compose", "init", "storage_state", "app", "openapi"]) {
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
