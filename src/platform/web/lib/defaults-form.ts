// The suite-defaults form's model (playtest.yaml), the sibling of caseform.js.
// Same discipline: edits are applied to the parsed source document IN PLACE via
// the vendored `yaml` Document API, so comments, key order, quoting and every
// key the form does not know about survive verbatim. The server's core
// validators stay the source of truth — this module never validates.
//
// DOM-free on purpose: the hermetic gate asserts the YAML surgery without a
// browser (see tests/unit/web-ia.test.ts).
import { parseDocument, stringify } from "../vendor/yaml/dist/index.js";

// No line folding (a long URL stays on one line). Flow padding keeps the
// library default here — unlike a case file, a playtest.yaml commonly holds
// hand-written flow maps (`viewport: { width: 1366, height: 768 }`) that an
// unrelated edit must not reformat.
const EMIT_OPTS: WebDynamic = { lineWidth: 0 };

/** Transports a suite can target, in the order the form offers them. */
export const DRIVERS: WebDynamic = ["web", "api", "mobile"];

/**
 * The environment every project starts with. It carries no URL of its own, so a
 * launch against it resolves to whatever base URL each suite declares — which
 * is how `app.base_url` becomes selectable at launch instead of being a
 * fourth thing to reason about. Its row edits `app.base_url` itself, never an
 * `app.envs.default` overlay: core resolves a case with no `--env` at all, so
 * the suite's own URL has to live at the top level to be found.
 */
export const DEFAULT_ENV_NAME = "default";

/**
 * An environment name is the `app.envs.<name>` overlay key and the CLI's
 * `--env` argument, so it stays a plain YAML-safe token, not a sentence.
 */
export const ENV_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

const DRIVER_LABELS: WebDynamic = {
  web: "web — a browser app (Chromium)",
  api: "api — an HTTP API",
  mobile: "mobile — a native app (Appium)",
};
export const driverLabel = (d: WebDynamic) => DRIVER_LABELS[d] || d;

/**
 * Set (or, with `value === null`, delete) one `app.<key>` in a playtest.yaml
 * source string. An empty source grows the `app:` map; deleting the last key
 * under `app` removes the now-empty map rather than leaving `app: {}` behind.
 * An object value (app.cookies) replaces the stored one wholesale — the same
 * semantics core gives an env overlay's cookies.
 * @param {string} text  current playtest.yaml bytes ("" for a file that doesn't exist yet)
 * @param {string} key   an app.* key, e.g. "base_url"
 * @param {string|number|object|null} value
 * @returns {string} the new bytes
 */
export function setAppKey(text: WebDynamic, key: WebDynamic, value: WebDynamic) {
  const doc = parseDocument(text || "");
  if (doc.errors?.length) throw doc.errors[0];
  if (!doc.contents || typeof doc.getIn !== "function" || !doc.contents.items) {
    // Empty or non-map source: build a fresh document.
    return value === null ? (text || "") : stringify({ app: { [key]: value } }, EMIT_OPTS);
  }
  if (value === null) {
    doc.deleteIn(["app", key]);
    const app = doc.get("app");
    if (app && Array.isArray(app.items) && app.items.length === 0) doc.delete("app");
    // An emptied document is an EMPTY file, not "{}" — the suite simply has no
    // defaults again, which is exactly what an absent playtest.yaml means.
    if (doc.contents.items.length === 0) return "";
  } else {
    doc.setIn(["app", key], value);
  }
  return doc.toString(EMIT_OPTS);
}

/**
 * Set (or, with `value === null`, delete) one dimension under `app.viewport`.
 * Editing width must not rebuild the viewport object: doing that would lose an
 * explicitly-null height (full-page capture), comments, or the source's flow
 * map style. Clearing the final dimension prunes the empty viewport/app maps.
 *
 * @param {string} text
 * @param {"width"|"height"} key
 * @param {number|null} value
 * @returns {string}
 */
export function setViewportDimension(text: WebDynamic, key: WebDynamic, value: WebDynamic) {
  if (!["width", "height"].includes(key)) throw new Error(`unknown viewport dimension "${key}"`);
  const doc = parseDocument(text || "");
  if (doc.errors?.length) throw doc.errors[0];
  if (!doc.contents || !doc.contents.items) {
    return value === null ? (text || "") : stringify({ app: { viewport: { [key]: value } } }, EMIT_OPTS);
  }
  if (value !== null) {
    doc.setIn(["app", "viewport", key], value);
    return doc.toString(EMIT_OPTS);
  }
  doc.deleteIn(["app", "viewport", key]);
  for (const path of [["app", "viewport"], ["app"]]) {
    const node = doc.getIn(path);
    if (node && Array.isArray(node.items) && node.items.length === 0) doc.deleteIn(path);
  }
  if (doc.contents.items.length === 0) return "";
  return doc.toString(EMIT_OPTS);
}

/**
 * Set one suite-level execution limit while preserving whichever supported
 * spelling the file already uses (`max_steps` / `timeout`, or
 * `limits.max_steps` / `limits.timeout`). Clearing a value removes both
 * spellings so the mode-aware engine default becomes effective again.
 *
 * @param {string} text
 * @param {"max_steps"|"timeout"} key
 * @param {string|number|null} value
 * @returns {string}
 */
export function setLimitKey(text: WebDynamic, key: WebDynamic, value: WebDynamic) {
  const doc = parseDocument(text || "");
  if (doc.errors?.length) throw doc.errors[0];
  if (!["max_steps", "timeout"].includes(key)) throw new Error(`unknown limit "${key}"`);
  if (!doc.contents || !doc.contents.items) {
    return value === null ? (text || "") : stringify({ [key]: value }, EMIT_OPTS);
  }
  if (value === null) {
    doc.delete(key);
    doc.deleteIn(["limits", key]);
    const limits = doc.get("limits");
    if (limits && Array.isArray(limits.items) && limits.items.length === 0) doc.delete("limits");
    if (doc.contents.items.length === 0) return "";
    return doc.toString(EMIT_OPTS);
  }
  if (doc.getIn(["limits", key]) !== undefined) doc.setIn(["limits", key], value);
  else doc.set(key, value);
  return doc.toString(EMIT_OPTS);
}

/**
 * Set or remove the suite's run-wide concurrency override. Removing it hands
 * the whole budget back to the hosted project default; setting it writes the
 * same `parallel` value core consumes.
 *
 * @param {string} text
 * @param {true|number|{total:number|true,record?:number}|null} value
 * @returns {string}
 */
export function setParallelValue(text: WebDynamic, value: WebDynamic) {
  const doc = parseDocument(text || "");
  if (doc.errors?.length) throw doc.errors[0];
  if (!doc.contents || !doc.contents.items) {
    return value === null ? (text || "") : stringify({ parallel: value }, EMIT_OPTS);
  }
  if (value === null) {
    doc.delete("parallel");
    if (doc.contents.items.length === 0) return "";
  } else {
    doc.set("parallel", value);
  }
  return doc.toString(EMIT_OPTS);
}

/**
 * Set (or delete, with `value === null`) a suite-level model choice —
 * `actor_model` or `grader_model`, the two top-level playtest.yaml keys that
 * pick which model plays the user and which grades. Deleting one hands the
 * role back down the precedence chain (the project default, else the engine
 * default), which is why clearing must really remove the key rather than
 * write an empty string core would reject.
 * @param {string} text
 * @param {"actor_model"|"grader_model"} key
 * @param {string|null} value
 * @returns {string}
 */
export function setModelKey(text: WebDynamic, key: WebDynamic, value: WebDynamic) {
  if (!["actor_model", "grader_model"].includes(key)) throw new Error(`unknown model key "${key}"`);
  const doc = parseDocument(text || "");
  if (doc.errors?.length) throw doc.errors[0];
  if (!doc.contents || !doc.contents.items) {
    return value === null ? (text || "") : stringify({ [key]: value }, EMIT_OPTS);
  }
  if (value === null) {
    doc.delete(key);
    if (doc.contents.items.length === 0) return "";
  } else {
    doc.set(key, value);
  }
  return doc.toString(EMIT_OPTS);
}

/**
 * Set (or delete, with `value === null`) `app.envs.<name>.base_url` — the
 * suite's own URL for one project environment. This overlay is what makes an
 * environment a RING (credentials, runner pool, discovery permission) rather
 * than a single host: two suites in the same project can point "staging" at two
 * different services. It outranks the environment's own URL at dispatch
 * (dispatcher.js resolveTarget).
 *
 * Deleting prunes upward — an emptied env map, an emptied `envs`, an emptied
 * `app` — so removing an override leaves no `envs: { staging: {} }` residue for
 * the next reader to wonder about.
 * @param {string} text
 * @param {string} envName  a project environment's name
 * @param {string|null} value
 * @returns {string}
 */
export function setEnvBaseUrl(text: WebDynamic, envName: WebDynamic, value: WebDynamic) {
  return setEnvKey(text, envName, "base_url", value);
}

/**
 * Set (or delete, with `value === null`) `app.envs.<name>.cookies` — the
 * suite's own cookies inside one ring. Core applies an env overlay's cookies
 * wholesale (no merge with the top-level `app.cookies`), so this is a true
 * override, not an addition.
 * @param {string} text
 * @param {string} envName
 * @param {Record<string,string>|null} cookies
 * @returns {string}
 */
export function setEnvCookies(text: WebDynamic, envName: WebDynamic, cookies: WebDynamic) {
  return setEnvKey(text, envName, "cookies", cookies);
}

function setEnvKey(text: WebDynamic, envName: WebDynamic, key: WebDynamic, value: WebDynamic) {
  const doc = parseDocument(text || "");
  if (doc.errors?.length) throw doc.errors[0];
  if (!doc.contents || !doc.contents.items) {
    return value === null ? (text || "") : stringify({ app: { envs: { [envName]: { [key]: value } } } }, EMIT_OPTS);
  }
  if (value !== null) {
    doc.setIn(["app", "envs", envName, key], value);
    return doc.toString(EMIT_OPTS);
  }
  doc.deleteIn(["app", "envs", envName, key]);
  for (const path of [["app", "envs", envName], ["app", "envs"], ["app"]]) {
    const node = doc.getIn(path);
    if (node && Array.isArray(node.items) && node.items.length === 0) doc.deleteIn(path);
  }
  if (doc.contents.items.length === 0) return "";
  return doc.toString(EMIT_OPTS);
}

/**
 * "slot=blue; feature_x=on" → { slot: "blue", feature_x: "on" } — the flat
 * string map core's `app.cookies` takes. Entries split on semicolons or
 * newlines; a value may itself contain `=`. Blank input is null (no cookies),
 * and a malformed entry throws with the entry named, so a form can show the
 * reason instead of silently dropping it.
 * @param {string} text
 * @returns {Record<string,string>|null}
 */
export function parseCookieList(text: WebDynamic) {
  const entries = String(text || "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return null;
  const out: WebDynamic = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const name = eq > 0 ? entry.slice(0, eq).trim() : "";
    if (!name || /[\s,]/.test(name)) {
      throw new Error(`"${entry}" isn't a cookie — write name=value pairs separated by semicolons`);
    }
    out[name] = entry.slice(eq + 1).trim();
  }
  return out;
}

/** The inverse of parseCookieList, for prefilling a form field. */
export function formatCookieList(cookies: WebDynamic) {
  return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Which cookies a launch against `envName` actually carries, and why — the
 * same three-way precedence as resolveEnvTarget, because the runner merges the
 * environment record under the suite's own `app.envs.<name>` keys and core
 * applies an overlay's cookies wholesale over the suite default.
 * @param {{cookies?: object, envs?: object}} app  the parsed `app` block
 * @param {string} envName
 * @param {Record<string,string>|null} envCookies  the environment record's own cookies
 * @returns {{cookies: Record<string,string>|null, source: "suite-env"|"environment"|"suite"|null}}
 */
export function resolveEnvCookies(app: WebDynamic, envName: WebDynamic, envCookies: WebDynamic) {
  const map = (v: WebDynamic) => (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length ? v : null);
  const suiteEnv = map(app?.envs?.[envName]?.cookies);
  const env = map(envCookies);
  const suite = map(app?.cookies);
  if (suiteEnv) return { cookies: suiteEnv, source: "suite-env" };
  if (env) return { cookies: env, source: "environment" };
  if (suite) return { cookies: suite, source: "suite" };
  return { cookies: null, source: null };
}

/**
 * Where a launch against `envName` will actually point, and why — the browser's
 * copy of the dispatcher's precedence (suite's env overlay → the environment's
 * own URL → the suite's default). Suite settings shows this per environment so
 * "what happens if I leave this blank" is answered on the page rather than
 * discovered in the launch dialog.
 * @param {{base_url?: string, envs?: object}} app  the parsed `app` block
 * @param {string} envName
 * @param {string|null} envBaseUrl  the environment record's own base URL
 * @returns {{url: string|null, source: "suite-env"|"environment"|"suite"|null}}
 */
export function resolveEnvTarget(app: WebDynamic, envName: WebDynamic, envBaseUrl: WebDynamic) {
  const str = (v: WebDynamic) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const suiteEnv = str(app?.envs?.[envName]?.base_url);
  const env = str(envBaseUrl);
  const suite = str(app?.base_url);
  if (suiteEnv) return { url: suiteEnv, source: "suite-env" };
  if (env) return { url: env, source: "environment" };
  if (suite) return { url: suite, source: "suite" };
  return { url: null, source: null };
}

/**
 * The playtest.yaml a newly created suite starts with. A suite with no defaults
 * file cannot resolve a single story (core requires app.base_url for web/api),
 * so the New suite dialog collects the target up front and commits this.
 * @param {{driver?: string, baseUrl?: string, appBinary?: string}} opts
 * @returns {string} YAML bytes, or "" when there is nothing to write
 */
export function initialDefaultsYaml({ driver = "web", baseUrl = "", appBinary = "" }: WebDynamic = {}) {
  const app: WebDynamic = {};
  if (driver && driver !== "web") app.driver = driver;
  if (driver === "mobile") {
    if (appBinary.trim()) app.app = appBinary.trim();
  } else if (baseUrl.trim()) {
    app.base_url = baseUrl.trim();
  }
  return Object.keys(app).length ? stringify({ app }, EMIT_OPTS) : "";
}

/**
 * Is this a usable app URL? The form asks for one before a suite exists, so the
 * check is the browser's own parser plus the two schemes the drivers speak —
 * core's own error arrives much later, at first save.
 * @returns {string|null} the reason it is unusable, or null when it is fine
 */
export function baseUrlProblem(value: WebDynamic) {
  const v = String(value || "").trim();
  if (!v) return "Add the URL where this app runs.";
  let u;
  try { u = new URL(v); } catch { return "That isn't a URL — it needs a scheme and a host, e.g. https://staging.example.com."; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "The URL must start with http:// or https://.";
  return null;
}
