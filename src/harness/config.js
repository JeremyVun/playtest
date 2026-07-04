// Case discovery and playtest.yaml inheritance. See docs/CONTRACTS.md §1-2.
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv from "ajv";
import { loadAssertions, assertionSchemaKeys } from "./assertions.js";
import { suiteRootFor, VISION_DRIFT_DEFAULT } from "./trajectory.js";

export class DummyConfigError extends Error {}

// Assertion imports live below DummyConfigError: assertions.js imports it from here,
// so this module is on the cycle — but neither side reads the other's exports at
// eval time (only inside functions), so the live bindings resolve fine.

const DEFAULTS_FILE = "playtest.yaml";

const DEFAULTS = {
  actor_model: "gpt5_4_mini",
  grader_model: "gpt5_5",
  persona: "tester",
  mode: "journey",
};

// max_steps/timeout are mode-aware, so they're resolved after merge (once the
// case's mode is known) rather than living in DEFAULTS: a journey is a tight
// regression (50 steps / 4m), a discovery run explores freely (300 / 30m). An
// explicit case/defaults value still wins — these only fill an unset budget.
const STEP_BUDGET = { journey: 50, discovery: 300 };
const TIME_BUDGET = { journey: "4m", discovery: "30m" };
const DISCOVERY_SKIP = new Set(["node_modules", "personas", "results"]);
const skipDiscoveryEntry = (name) => name.startsWith(".") || DISCOVERY_SKIP.has(name);

const here = path.dirname(fileURLToPath(import.meta.url));
const loadSchema = (name) => JSON.parse(readFileSync(path.join(here, "../schemas", name), "utf8"));
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true }); // timeout/perf accept "90s" | 90000
const caseSchema = loadSchema("case.schema.json");
const validateCaseBase = ajv.compile(caseSchema);
const validateDefaults = ajv.compile(loadSchema("defaults.schema.json"));

// The built-in success kinds, derived from the schema itself (its success-item
// properties minus the cosmetic `label`) so there is ONE source of truth: the
// keys an assertion may not shadow are exactly the keys case.schema.json already
// names. assertions.js imports this for its collision check (function-time read, so
// the config↔assertions cycle stays safe).
export const BUILTIN_SUCCESS_KINDS = new Set(
  Object.keys(caseSchema.properties.success.items.properties).filter((k) => k !== "label"),
);

// The case validator is per-suite, not a singleton: a suite's custom assertions
// (assertions.js) inject their owned success keys into a CLONE of case.schema.json
// (success-item properties += { <key>: ASSERTION_VALUE_TYPE }; additionalProperties
// STAYS false so a typo'd key is still a named error, not a silent no-op). With no
// assertion keys the clone is acceptance-identical to validateCaseBase, so the web
// golden is unaffected. Cached by the set of injected keys (a join), so suites
// that register the same keys share a compiled validator.

// An assertion's success value is opaque to core (the assertion owns its grammar), so we
// accept any JSON scalar — string | number | boolean — not just string. This lets
// `dummy_expect_min_steps: 3` be written unquoted, the way the built-in numeric
// `console_errors: 5` is, instead of forcing `"3"`. The assertion's verdict() still
// receives the value as-authored and coerces it (e.g. Number(value)).
const ASSERTION_VALUE_TYPE = { type: ["string", "number", "boolean"] };
const caseValidatorCache = new Map(); // keys.join("\0") → compiled Ajv validator
function caseValidatorFor(assertionKeys) {
  if (assertionKeys.length === 0) return validateCaseBase;
  const cacheKey = [...assertionKeys].sort().join("\0");
  let validate = caseValidatorCache.get(cacheKey);
  if (validate) return validate;
  // loadSchema re-reads + parses from disk, so this is already a private fresh
  // copy — safe to mutate without an extra deep clone.
  const schema = loadSchema("case.schema.json");
  // The clone carries the base schema's $id; Ajv refuses a duplicate id, so give
  // the per-suite clone its own id derived from the injected keys.
  schema.$id = `dummy/case.schema.json#assertions:${cacheKey}`;
  const props = schema.properties.success.items.properties;
  for (const key of assertionKeys) props[key] = { ...ASSERTION_VALUE_TYPE };
  validate = ajv.compile(schema);
  caseValidatorCache.set(cacheKey, validate);
  return validate;
}

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
  // Always-on a11y capture is web-only (it needs the browser/axe-core); the gate
  // sums TOTAL WCAG violations across the run (full-page). Deterministic, HARD.
  accessibility_violations: ["web"],
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
  compose: ["web", "mobile", "api"],
  init: ["web", "mobile", "api"],
  storage_state: ["web"],
  driver: ["web", "mobile", "api"],
  platform: ["mobile"],
  app: ["mobile"],
  device: ["mobile"],
  appium_url: ["mobile"],
  preserve_session: ["mobile"],
  openapi: ["api"],
  settle: ["web", "mobile"],
  viewport: ["web"],
  device_scale_factor: ["web"],
  cookies: ["web"],
};
const DURATION_UNITS = { ms: 1, s: 1000, m: 60000 };

/** "5m" | "90s" | "250ms" | number → milliseconds. */
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
 * @param {{ tags?: string[], ids?: string[], baseUrl?: string|null, env?: string|null }} [opts]
 *   env: the --env name selecting an app.envs.<name> overlay (null = top-level app.* only).
 * @returns {Promise<object[]>} ResolvedCase[] sorted by id
 */
export async function discoverCases(paths, { tags = [], ids = [], baseUrl = null, env = null } = {}) {
  const found = new Map(); // abs case file → suite root the user named
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
      if (path.basename(abs) === DEFAULTS_FILE)
        throw new DummyConfigError(`${p} is a defaults file, not a test case`);
      if (!found.has(abs)) found.set(abs, path.dirname(abs));
    }
  }

  await warnStrays(strays, found);

  const registries = new Map();
  const registryFor = async (caseFile) => {
    const root = suiteRootFor(caseFile);
    if (!registries.has(root)) registries.set(root, await loadAssertions(root));
    return registries.get(root);
  };

  const cases = [];
  for (const [file, root] of found) {
    const registry = await registryFor(file);
    const c = await resolveCase(file, root, baseUrl, registry, env);
    if (tags.length === 0 || c.tags.some((t) => tags.includes(t))) cases.push(c);
  }

  // Two files can resolve to the SAME id — a `stories/` grouping dir is dropped
  // from the id (see resolveCase), so `stories/foo.yaml` and `foo.yaml` both id as
  // "foo". They would then share one baseline + run dir and silently clobber each
  // other. Catch it loudly, naming both files (uphold "loud, never silently
  // skipped"). Checked before fan-out; a study's per-persona ids stay distinct.
  const byId = new Map();
  for (const c of cases) {
    const prior = byId.get(c.id);
    if (prior) {
      const rel = (f) => path.relative(process.cwd(), f);
      throw new DummyConfigError(
        `two case files resolve to the same id "${c.id}": ${rel(prior.file)} and ${rel(c.file)} — ` +
        `a "stories/" grouping directory is dropped from the id, so stories/${c.id}.yaml and ${c.id}.yaml collide. ` +
        `Rename or move one so they get distinct ids (baselines and run dirs are keyed on the id).`,
      );
    }
    byId.set(c.id, c);
  }

  // Discovery personas fan-out: one instance per persona reference, id
  // <id>@<ref>, singular persona overridden.
  const expanded = [];
  for (const { personas, ...c } of cases) {
    if (personas) {
      for (const ref of personas) expanded.push({ ...c, id: `${c.id}@${ref}`, persona: ref });
    } else expanded.push(c);
  }
  // --id filter runs AFTER fan-out so a discovery study's `<id>@<persona>` ids
  // exist: `--id study` matches every persona (the `<id>@` prefix), `--id
  // study@novice` matches just one. Exact-id match otherwise. AND-of-ORs not
  // needed (mirrors tags) — a case matches if its id is in the requested set.
  const selected =
    ids.length === 0
      ? expanded
      : expanded.filter((c) => ids.some((want) => c.id === want || c.id.startsWith(`${want}@`)));
  return selected.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Case files under a named directory, split into { cases, strays }. A *.yaml is
 * a case only when it sits directly in a suite root (the named dir), or any
 * descendant holding a playtest.yaml, or anywhere under a stories/ directory.
 * Other directories are still traversed — to find nested suites and their
 * stories — but a case-shaped *.yaml found loose in one is a STRAY: reported by
 * warnStrays, never run. personas/ and results/ are skipped entirely.
 *
 * A loose *.yaml at a suite root is a case only when it is case-shaped (carries a
 * string `story`, the required case-only key). A non-case yaml sitting there — a
 * repo-root lockfile, a `_RepoMetadata.yaml` — is not ours and is skipped
 * silently, NEVER validated: naming a dir that merely CONTAINS a suite (or is a
 * repo root with a nested suite) must not choke on an unrelated sibling yaml.
 * Under an explicit `stories/` dir every *.yaml is still a case (a story-less one
 * there errors — its location is the author's intent).
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
    if (skipDiscoveryEntry(name)) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (name === "stories") await collectStories(full, cases);
      else await collectFrom(full, existsSync(path.join(full, DEFAULTS_FILE)), cases, strays);
    } else if (isCaseFile(name) && (await isCaseShaped(full))) {
      // Case-shaped and at a suite root → a case; case-shaped but loose elsewhere
      // → a stray (warnStrays). A non-case yaml is neither: skipped above.
      (collectRoot ? cases : strays).push(full);
    }
  }
}

/** Every case file beneath a stories/ subtree, at any depth. */
async function collectStories(dir, cases) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (skipDiscoveryEntry(name)) continue;
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
 * Does this *.yaml carry a string `story` — the required, case-only key? That is
 * the discriminator for "is this ours": `story` is rejected in a playtest.yaml
 * (defaults.schema.json) and required in every case, so a yaml without one is not
 * a playtest case (a lockfile, a repo-metadata sidecar) and must not be validated
 * as one. A yaml that won't even parse is likewise "not recognisably ours" —
 * skipped, not thrown (a directly-named case file still errors loudly; naming it
 * is intent). Shared by collectFrom (what to collect) and warnStrays (what to warn).
 */
async function isCaseShaped(file) {
  let doc;
  try {
    doc = YAML.parse(await fs.readFile(file, "utf8"));
  } catch {
    return false;
  }
  return !!doc && typeof doc === "object" && typeof doc.story === "string";
}

/**
 * A misplaced case must be loud, never silently skipped: warn (don't throw) for
 * each case-shaped yaml that sits outside a suite root / stories/ dir. Files
 * that don't parse as a case (no string `story`) are left alone — they aren't ours.
 */
async function warnStrays(strays, found) {
  // Every entry in `strays` was already confirmed case-shaped by collectFrom
  // (it only pushes files that pass isCaseShaped), so no re-check is needed here.
  for (const file of strays) {
    if (found.has(file)) continue;
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

async function resolveCase(file, namedRoot, baseUrl, registry = { routing: new Map(), assertions: [] }, env = null) {
  const caseDir = path.dirname(file);
  const top = findRepoRoot(caseDir); // null → no .git ancestor: every ancestor contributes
  // Assertion-owned success keys this suite registered; the case validator clones
  // the schema with them injected (defaults files never carry success, so the
  // defaults validator stays the singleton).
  const assertionKeys = assertionSchemaKeys(registry.routing);
  const validateCase = caseValidatorFor(assertionKeys);
  const merged = { ...DEFAULTS, env: {} };
  const chain = defaultsChain(top, caseDir);
  const loadedChain = [];
  for (const f of chain) {
    const doc = await loadYaml(f, validateCase);
    loadedChain.push([f, doc]);
    mergeDoc(merged, doc);
  }
  mergeDoc(merged, await loadYaml(file, validateCase));

  if (typeof merged.story !== "string" || !merged.story.trim()) {
    throw new DummyConfigError(`${file}: missing required "story"`);
  }
  // app.envs: named environment overlays selected with --env <name>. Pull it off
  // the flat env accumulator (mergeDoc flattened app.envs into merged.env.envs)
  // so it never lands on the final ResolvedCase env nor trips authoredAppKeys /
  // APP_KEY_DRIVERS. With --env, the chosen overlay's keys shallow-override the
  // top-level app.* (Object.assign per key — an env's cookies/settle REPLACES the
  // top-level one wholesale). The chosen keys are then user-authored config, so
  // they ride the same APP_KEY_DRIVERS scope check below.
  const envs = merged.env.envs ?? {};
  delete merged.env.envs;
  const envNames = Object.keys(envs).sort();
  if (env !== null) {
    if (!Object.prototype.hasOwnProperty.call(envs, env)) {
      const avail = envNames.length ? envNames.join(", ") : "(none declared)";
      throw new DummyConfigError(`${file}: unknown --env "${env}" (available: ${avail})`);
    }
    Object.assign(merged.env, envs[env]);
  }
  // User-authored app.* keys, snapshotted AFTER the env overlay (its keys are
  // user-authored config for driver-scope purposes) and before --base-url adds
  // derived ones.
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
    if (merged.env[key] === null) continue; // bare key (null) → treated as absent
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
    // When envs are declared, name them as the recovery (the CLI also offers an
    // interactive picker off err.availableEnvs on a TTY); else the plain hint.
    const envHint = envNames.length ? ` (or pass --env <name>; available: ${envNames.join(", ")})` : "";
    const err = new DummyConfigError(
      `${file}: no app.base_url configured (set it in a playtest.yaml, the case file, or pass --base-url)${envHint}`,
    );
    err.availableEnvs = envNames;
    throw err;
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

  // visual_regression: a journey-allowed pixel-drift DETECTOR, distinct from
  // vision (which alone feeds screenshots to the model). It only hashes each
  // step's screenshot and compares on replay — no images reach the actor/grader,
  // no behavior/cost/prompt change. No cross-field restriction (a pure toggle);
  // meaningful only on the web driver. ON by default: the hash is free to compute
  // and the second drift channel catches purely-visual regressions the a11y tree
  // misses, so every journey gets it unless a case opts out. Inert on mobile/api
  // (their drivers return no screenshotHash, so channel 2 never fires there).
  // visual_regression_drift is its Hamming tuning knob (the threshold above which
  // a screenshot reads as pixel drift).
  const visualRegression = merged.visual_regression ?? true;
  const visualRegressionDrift = merged.visual_regression_drift ?? VISION_DRIFT_DEFAULT;
  const success = merged.success ?? [];
  if (!Array.isArray(success)) throw new DummyConfigError(`${file}: "success" must be an array`);
  for (const c of success) {
    // Each entry carries one check kind plus an OPTIONAL cosmetic `label`
    // (schema maxProperties: 2). The schema can no longer enforce exactly one
    // kind, once a label is allowed alongside it, so do it here — the kind is the
    // sole "non-label" key. Zero or two+ kinds is a config error, naming the file.
    const kindKeys = Object.keys(c).filter((k) => k !== "label");
    if (kindKeys.length !== 1) {
      throw new DummyConfigError(
        `${file}: each "success" entry needs exactly one check kind` +
        (kindKeys.length ? ` (got ${kindKeys.length}: ${kindKeys.join(", ")})` : "") +
        ` — "label" is an optional name, not a kind`,
      );
    }
    const kind = kindKeys[0];
    // A registered assertion key is journey-only (the discovery-success rule above
    // already rejects any success in a discovery case) and driver-agnostic in v1
    // — it asserts on an external side effect, not the transport — so it skips
    // the per-driver scope check (which only knows the built-in kinds).
    if (registry.routing.has(kind)) continue;
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

  // Fill the step/wall-clock budget from the resolved mode when the user set
  // neither: a journey stays a tight 50/4m, a discovery run gets room to explore
  // (300/30m). An explicit case/defaults value wins (it merged above, so it's set).
  const max_steps = merged.max_steps ?? STEP_BUDGET[merged.mode] ?? STEP_BUDGET.journey;
  const timeout = merged.timeout ?? TIME_BUDGET[merged.mode] ?? TIME_BUDGET.journey;

  let timeout_ms;
  try {
    timeout_ms = parseDuration(timeout);
  } catch (e) {
    throw new DummyConfigError(`${file}: ${e.message}`);
  }

  // Cross-field rule the schema can't express: the record cap can't exceed the
  // pool. Only checkable when total is a concrete int (true = default pool, sized
  // at runtime from the core count, so a literal record can't be compared yet —
  // runAll clamps it there).
  const par = merged.parallel;
  if (par && typeof par === "object" && typeof par.total === "number" && typeof par.record === "number" && par.record > par.total) {
    // `parallel` is a defaults-only key, so it was inherited from a playtest.yaml,
    // not `file` (the case). Name the nearest chain file that actually set it so
    // the error points where the user can fix it.
    const source = [...loadedChain].reverse().find(([, doc]) => doc?.parallel !== undefined)?.[0] ?? file;
    throw new DummyConfigError(
      `${source}: parallel.record (${par.record}) cannot exceed parallel.total (${par.total})`,
    );
  }

  // A `stories/` grouping directory is structural, not part of the id, so
  // `<suite>/stories/foo.yaml` and `<suite>/foo.yaml` both id as "foo" (baselines
  // mirror this — see trajectory.js baselinePaths). Only the first (leftmost)
  // `stories/` is dropped: a deeper `stories/` segment stays, so nested cases keep
  // distinct ids (and distinct baselines) rather than colliding.
  const baseId = dropFirstStories(path.relative(namedRoot, file).replace(/\.yaml$/, "").split(path.sep)).join("/");
  return {
    id: baseId,
    // The stable, persona-INDEPENDENT base id (same as `id` here). `id` becomes
    // `<storyId>@<persona>` for a fanned-out discovery persona (discoverCases
    // below); storyId stays the base so a before_each hook can key one shared
    // seeded entity per study across every persona, vs `id` (caseId) for
    // per-persona isolation (hooks.js ctx, §2/§5).
    storyId: baseId,
    file,
    name: path.basename(file, ".yaml"),
    // The suite's custom-assertion registry (key -> assertion), carried so the
    // runner can gather() evidence and the gate can dispatch an assertion success
    // key to its verdict(). Internal field (leading _), not a contract YAML key;
    // an empty routing Map when the suite has no assertions/.
    _assertions: registry,
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
    visual_regression: visualRegression,
    visual_regression_drift: visualRegressionDrift,
    limits: { max_steps, timeout_ms },
    // Run-wide concurrency from playtest.yaml (CLI --parallel/--parallel-record
    // override it). int n | true (default pool) | { total, record } | null (auto).
    // The object form caps how many cases may RECORD at once (checks fill the
    // rest). Surfaced per-case because config.js resolves every defaults value
    // here; runAll consumes one value (resolveBudget).
    parallel: merged.parallel ?? null,
    actor_model: merged.actor_model,
    grader_model: merged.grader_model,
    env: {
      driver,
      // The selected --env overlay name (app.envs.<name>), or null for the
      // top-level default. Carried so the manifest/viewer can name the target
      // environment; not a comparability pin (base_url already distinguishes runs).
      env_name: env ?? null,
      base_url: merged.env.base_url ?? null,
      compose: merged.env.compose ?? null,
      init: merged.env.init ?? null,
      storage_state: merged.env.storage_state ?? null,
      // mobile (Appium) keys; null on web/api
      platform: merged.env.platform ?? null,
      app: merged.env.app ?? null,
      device: merged.env.device ?? null,
      appium_url: merged.env.appium_url ?? null,
      // mobile only: keep the app installed + its data across runs (Appium
      // noReset) instead of the default reinstall-and-wipe, so an already
      // signed-in build stays authenticated. null on web/api
      preserve_session: merged.env.preserve_session ?? null,
      // api key; null on web/mobile
      openapi: merged.env.openapi ?? null,
      // web + mobile key; null on api. The driver merges this over its settle
      // defaults (web: settle-v1 dom/net windows; mobile: settle-mobile-v1
      // source_quiet_ms/max_ms); it rides manifest.pins.settle (comparability key).
      settle: merged.env.settle ?? null,
      // web key; null on mobile/api. The Chromium viewport, with per-field
      // defaults applied (width 1280; height 720, or null for full-page stills —
      // see resolveViewport). Rides manifest.pins.viewport (comparability key).
      viewport: driver === "web" ? resolveViewport(merged.env.viewport) : null,
      // web key; null on mobile/api. Chromium device scale factor (DPI) for
      // crisper step stills; null = the driver's default of 1. Purely a
      // rendering knob — deliberately NOT a manifest pin (not a comparability key).
      device_scale_factor: merged.env.device_scale_factor ?? null,
      // web key; null on mobile/api. Cookies ({name, value}) set on the browser
      // context before the first navigation, against base_url's origin. A session
      // input like storage_state — NOT a manifest pin.
      cookies: merged.env.cookies ?? null,
    },
  };
}

// Default web viewport. width 1280; height 720 captures viewport-only stills
// (what the user saw). An EXPLICIT height: null means full-page stills (whole
// scroll). These must mirror DEFAULT_VIEWPORT in drivers/web.js.
const VIEWPORT_DEFAULT_WIDTH = 1280;
const VIEWPORT_DEFAULT_HEIGHT = 720;

/**
 * Resolve app.viewport into { width, height } with per-field defaults. An ABSENT
 * height inherits the default (720, viewport-only); an EXPLICIT height: null is
 * preserved (full-page capture). `undefined` input (no app.viewport) yields the
 * full default. Exported for unit test.
 */
export function resolveViewport(vp) {
  const width = vp?.width ?? VIEWPORT_DEFAULT_WIDTH;
  // Distinguish "no height key" (=> default) from "height: null" (=> full page).
  const height = vp && "height" in vp ? vp.height : VIEWPORT_DEFAULT_HEIGHT;
  return { width, height };
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

async function loadYaml(file, validateCase = validateCaseBase) {
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
    const resolvePaths = (obj, keys) => {
      for (const k of keys)
        if (typeof obj[k] === "string") obj[k] = path.resolve(path.dirname(file), obj[k]);
    };
    resolvePaths(doc.app, ["compose", "init", "storage_state", "app", "openapi"]);
    // Per-env overlays carry the same path-bearing keys (init/storage_state),
    // resolved against the declaring file too so an env's path is portable.
    if (doc.app.envs && typeof doc.app.envs === "object") {
      for (const overlay of Object.values(doc.app.envs)) {
        if (overlay && typeof overlay === "object") resolvePaths(overlay, ["init", "storage_state"]);
      }
    }
  }
  return doc;
}

/** Ajv errors -> one friendly line naming each offending key. */
function describeSchemaErrors(errors) {
  const msgs = errors.map((e) => {
    const at = e.instancePath.slice(1).split("/").join(".");
    if (e.keyword === "additionalProperties") {
      // Success-item keys that aren't a built-in kind and no assertion claims get the
      // assertion-hint appended — the likeliest fix is a missing/misnamed assertion.
      const hint = /^\/success\/\d+$/.test(e.instancePath)
        ? ` (is the assertion under assertions/ and does it register this key?)`
        : "";
      return `unknown key "${at ? `${at}.` : ""}${e.params.additionalProperty}"${hint}`;
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
