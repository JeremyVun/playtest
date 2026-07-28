// The runner's own configuration file (docs/contracts/interfaces.md, "Runner
// configuration file"). It holds the facts NO platform record may hold: where a
// mobile build lives on this disk, which Appium backend drives it, and which
// device it targets — keyed by the immutable application and ring keys the
// console shows.
//
// Three rules shape everything below:
//
//   1. The file is validated ONCE, at startup, into the shapes the rest of the
//      agent consumes. A binding that would fail at claim time — an unknown
//      backend, a platform that disagrees with its backend, a build that is not
//      on this disk — is a startup error with the remedy in it, because a person
//      is standing at the terminal then and nobody is standing at the run page
//      forty minutes later.
//   2. No credential is ever written here. `credential_file` names a file and
//      `credential_env` names an environment variable; a literal value, a
//      `user:password@` in a URL, or any credential-shaped key is refused with
//      the indirection to use instead.
//   3. Nothing in this file is ever uploaded. It is read, banner-printed
//      (non-secret keys only), and consulted locally; the control plane never
//      learns that it exists.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type MobilePlatform = "ios" | "android";

/** One Appium server this runner can use, `mobile.backends.<name>`. */
export interface AppiumBackend {
  name: string;
  platform: MobilePlatform;
  mode: "managed" | "external";
  /** External mode only: where the existing Appium answers. */
  url: string | null;
  /** External mode only: a file holding the credential, absolute. */
  credentialFile: string | null;
  /** External mode only: the name of an environment variable holding it. */
  credentialEnv: string | null;
}

/** One `(application key, ring key)` binding — a mobile target this runner can serve. */
export interface MobileBinding {
  /** The project it is qualified to, or null for a flat (project-scoped) key. */
  projectKey: string | null;
  applicationKey: string;
  ringKey: string;
  platform: MobilePlatform;
  /** Absolute path to the `.app`/`.apk` on this machine. */
  app: string;
  backend: AppiumBackend;
  /** Omitted means Appium's default device — never the suite's authored one. */
  device: string | null;
}

export interface RunnerConfig {
  /** Absolute path of the file, for the banner and for error messages. */
  path: string;
  /** Present only when the file declares `labels`; null means "said nothing". */
  labels: string[] | null;
  backends: Map<string, AppiumBackend>;
  bindings: MobileBinding[];
}

const TOP_KEYS = ["version", "labels", "targets", "projects", "mobile"];
const BINDING_KEYS = ["platform", "app", "backend", "device"];
const BACKEND_KEYS = ["platform", "appium"];
const APPIUM_KEYS = ["mode", "url", "credential_file", "credential_env"];
const PLATFORMS: MobilePlatform[] = ["ios", "android"];

/**
 * Keys that would only ever hold a secret. They are rejected as unknown keys
 * anyway; naming them buys the one thing a generic "unknown key" cannot — the
 * indirection to use instead of the value someone was about to paste.
 */
const CREDENTIAL_KEYS = new Set([
  "auth", "apikey", "api_key", "access_key", "credential", "credentials", "key",
  "pass", "password", "secret", "token", "user", "username",
]);

/**
 * Read and validate the configuration file. Every throw is one actionable line
 * naming the file, the position in it, and what to do — the runner's startup
 * error convention (cli.ts prints the first line and exits 2).
 *
 * A file that parses to nothing — the seeded, all-comments `runner.yaml` — is a
 * valid empty configuration, NOT an error and NOT a `labels` declaration: an
 * operator who has not uncommented anything yet keeps exactly the behavior they
 * had before the flag was passed.
 */
export function loadRunnerConfig(file: string, env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e: RunnerDynamic) {
    throw new Error(
      `cannot read the runner config file "${abs}" (${e?.code || firstLine(e)}) — point --config at an existing file, ` +
        `or omit the flag to run without one (web and API runs need no configuration)`,
    );
  }
  let doc: RunnerDynamic;
  try {
    doc = YAML.parse(raw);
  } catch (e: RunnerDynamic) {
    // The parser already catches the duplicate-target case for us: a repeated
    // application, ring, or backend key is a non-unique map key.
    throw new Error(
      `${abs} is not valid YAML: ${firstLine(e)} — each application, ring and backend may be declared exactly once`,
    );
  }
  const empty: RunnerConfig = { path: abs, labels: null, backends: new Map(), bindings: [] };
  if (doc === null || doc === undefined) return empty;

  const top = asObject(doc, abs, "the file");
  assertKeys(top, TOP_KEYS, abs, "the file");
  if (top.version !== 1) {
    throw new Error(
      `${abs}: this file must start with "version: 1" (found ${describe(top.version)}) — ` +
        `the schema is versioned so a newer runner can tell your file apart from one it does not understand`,
    );
  }
  const config: RunnerConfig = { ...empty, labels: readLabels(top, abs) };
  const mobile = asObject(top.mobile, abs, "mobile");
  assertKeys(mobile, ["backends"], abs, "mobile");
  for (const [name, value] of Object.entries(asObject(mobile.backends, abs, "mobile.backends"))) {
    config.backends.set(name, readBackend(name, value, { file: abs, dir, env }));
  }

  // Flat and project-qualified keys are two answers to the same question, and a
  // file holding both leaves "which wins" to be discovered at claim time.
  if (top.targets != null && top.projects != null) {
    throw new Error(
      `${abs}: declare targets either flat under "targets" (a project-scoped runner) or under ` +
        `"projects.<project-key>.targets" (a site-scoped runner), not both`,
    );
  }
  if (top.targets != null) {
    config.bindings.push(...readTargets(top.targets, null, { file: abs, dir, at: "targets", backends: config.backends }));
  }
  for (const [projectKey, value] of Object.entries(asObject(top.projects, abs, "projects"))) {
    const scope = asObject(value, abs, `projects.${projectKey}`);
    assertKeys(scope, ["targets"], abs, `projects.${projectKey}`);
    config.bindings.push(
      ...readTargets(scope.targets, projectKey, {
        file: abs,
        dir,
        at: `projects.${projectKey}.targets`,
        backends: config.backends,
      }),
    );
  }
  return config;
}

/**
 * The binding for one offered target, or null. A site-scoped runner's offers all
 * name their project (the envelope always carries `project_key`), so a qualified
 * binding is matched by project; a flat binding belongs to whatever single
 * project its runner is scoped to and matches any project key it is asked about
 * — `assertConfigScope` has already refused flat keys on a site runner.
 */
export function bindingFor(
  config: RunnerConfig | null,
  { projectKey, applicationKey, ringKey }: { projectKey: string | null; applicationKey: string | null; ringKey: string | null },
): MobileBinding | null {
  if (!config || !applicationKey || !ringKey) return null;
  const match = (b: MobileBinding) =>
    b.applicationKey === applicationKey && b.ringKey === ringKey && (b.projectKey === null || b.projectKey === projectKey);
  // Qualified first: an explicit project statement beats a general one.
  return config.bindings.find((b) => b.projectKey !== null && match(b)) ?? config.bindings.find((b) => match(b)) ?? null;
}

/**
 * Refuse flat target keys on a site-scoped runner. This cannot be checked while
 * parsing, because scope is the CONTROL PLANE's answer and arrives with the
 * first check-in — so it is checked the moment it is knowable, before this
 * runner claims anything, and it stops the process the way any other startup
 * error does.
 *
 * Why it matters: a site runner takes work from every project, and a colliding
 * application key created in another project TOMORROW would silently rebind a
 * flat key that has already executed today's runs.
 */
export function assertConfigScope(config: RunnerConfig | null, { siteScoped }: { siteScoped: boolean }): void {
  if (!config || !siteScoped) return;
  const flat = config.bindings.find((b) => b.projectKey === null);
  if (!flat) return;
  const sample = `${flat.applicationKey}.${flat.ringKey}`;
  throw new Error(
    `${config.path}: this runner is site-scoped — it takes work from every project on the deployment — so every target ` +
      `must name its project: move "targets.${sample}" under "projects.<project-key>.targets.${sample}". ` +
      `A flat key would silently rebind if another project later created an application with the same key.`,
  );
}

/** The non-secret half of the file, for the startup banner. Keys, not paths. */
export function configBannerLines(config: RunnerConfig | null): string[] {
  if (!config) return [];
  const lines = [`  config     ${config.path}`];
  if (!config.bindings.length && !config.backends.size) {
    lines.push("  targets    none declared — mobile offers are skipped, web and API runs need none");
    return lines;
  }
  const targets = config.bindings.map(
    (b) => `${b.projectKey ? `${b.projectKey}/` : ""}${b.applicationKey}/${b.ringKey} — ${b.platform} via backend "${b.backend.name}"`,
  );
  const backends = [...config.backends.values()].map(
    (b) => `${b.name} — ${b.platform}, ${b.mode === "managed" ? "managed Appium (started here)" : `external Appium at ${b.url}`}`,
  );
  lines.push(...block("targets", targets.length ? targets : ["none declared"]));
  lines.push(...block("backends", backends.length ? backends : ["none declared"]));
  return lines;
}

const block = (label: string, values: string[]) =>
  values.map((v, i) => `  ${(i === 0 ? label : "").padEnd(9)}  ${v}`);

// ---------- parsing ----------

function readLabels(top: RunnerDynamic, file: string): string[] | null {
  if (!("labels" in top) || top.labels == null) return null;
  if (!Array.isArray(top.labels)) {
    throw new Error(`${file}: "labels" must be a list of strings, for example: labels: [macbook, ios]`);
  }
  const labels: string[] = [];
  for (const raw of top.labels) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(`${file}: every entry of "labels" must be a non-empty string (found ${describe(raw)})`);
    }
    if (!labels.includes(raw.trim())) labels.push(raw.trim());
  }
  return labels;
}

function readTargets(
  value: RunnerDynamic,
  projectKey: string | null,
  ctx: { file: string; dir: string; at: string; backends: Map<string, AppiumBackend> },
): MobileBinding[] {
  const out: MobileBinding[] = [];
  for (const [applicationKey, rings] of Object.entries(asObject(value, ctx.file, ctx.at))) {
    for (const [ringKey, entry] of Object.entries(asObject(rings, ctx.file, `${ctx.at}.${applicationKey}`))) {
      const at = `${ctx.at}.${applicationKey}.${ringKey}`;
      const binding = asObject(entry, ctx.file, at);
      assertKeys(binding, BINDING_KEYS, ctx.file, at);
      const platform = readPlatform(binding.platform, ctx.file, `${at}.platform`);
      const backendName = readString(binding.backend, ctx.file, `${at}.backend`);
      const backend = ctx.backends.get(backendName);
      if (!backend) {
        const known = [...ctx.backends.keys()];
        throw new Error(
          `${ctx.file}: ${at}.backend names "${backendName}", which is not declared — ` +
            (known.length
              ? `declare it under mobile.backends, or use one of: ${known.join(", ")}`
              : `declare it under mobile.backends (for example: mobile: { backends: { ${backendName}: { platform: ${platform}, appium: { mode: managed } } } })`),
        );
      }
      if (backend.platform !== platform) {
        throw new Error(
          `${ctx.file}: ${at} is a ${platform} target but its backend "${backendName}" is declared ${backend.platform} — ` +
            `an Appium backend drives one platform, so correct whichever of the two is wrong`,
        );
      }
      const app = path.resolve(ctx.dir, readString(binding.app, ctx.file, `${at}.app`));
      if (!fs.existsSync(app)) {
        throw new Error(
          `${ctx.file}: ${at}.app points at "${app}", which is not on this machine — build the app first, or correct the path. ` +
            `The build is a fact only this runner knows; the platform never stores or resolves it.`,
        );
      }
      out.push({
        projectKey,
        applicationKey,
        ringKey,
        platform,
        app,
        backend,
        device: binding.device == null ? null : readString(binding.device, ctx.file, `${at}.device`),
      });
    }
  }
  return out;
}

function readBackend(name: string, value: RunnerDynamic, ctx: { file: string; dir: string; env: NodeJS.ProcessEnv }): AppiumBackend {
  const at = `mobile.backends.${name}`;
  const backend = asObject(value, ctx.file, at);
  assertKeys(backend, BACKEND_KEYS, ctx.file, at);
  const platform = readPlatform(backend.platform, ctx.file, `${at}.platform`);
  const appium = asObject(backend.appium ?? {}, ctx.file, `${at}.appium`);
  assertKeys(appium, APPIUM_KEYS, ctx.file, `${at}.appium`);
  const mode = appium.mode == null ? "managed" : readString(appium.mode, ctx.file, `${at}.appium.mode`);
  if (mode !== "managed" && mode !== "external") {
    throw new Error(
      `${ctx.file}: ${at}.appium.mode must be "managed" (this runner starts and supervises Appium itself) ` +
        `or "external" (it dials an Appium you already run) — found ${describe(appium.mode)}`,
    );
  }
  if (mode === "managed") {
    for (const key of ["url", "credential_file", "credential_env"]) {
      if (appium[key] != null) {
        throw new Error(
          `${ctx.file}: ${at}.appium.${key} applies to "mode: external" only — a managed backend starts its own Appium ` +
            `on an unused loopback port and needs no address`,
        );
      }
    }
    return { name, platform, mode, url: null, credentialFile: null, credentialEnv: null };
  }
  const url = readUrl(appium.url, ctx.file, `${at}.appium.url`);
  const credentialFile = appium.credential_file == null ? null : path.resolve(ctx.dir, readString(appium.credential_file, ctx.file, `${at}.appium.credential_file`));
  if (credentialFile && !fs.existsSync(credentialFile)) {
    throw new Error(
      `${ctx.file}: ${at}.appium.credential_file points at "${credentialFile}", which is not on this machine — ` +
        `create it (umask 077) with the credential as its only content`,
    );
  }
  const credentialEnv = appium.credential_env == null ? null : readString(appium.credential_env, ctx.file, `${at}.appium.credential_env`);
  if (credentialEnv && !String(ctx.env[credentialEnv] ?? "").trim()) {
    throw new Error(
      `${ctx.file}: ${at}.appium.credential_env names the environment variable ${credentialEnv}, which is not set for this ` +
        `runner — export it before starting the agent, or use credential_file instead`,
    );
  }
  if (credentialFile && credentialEnv) {
    throw new Error(`${ctx.file}: ${at}.appium declares both credential_file and credential_env — name exactly one source`);
  }
  return { name, platform, mode, url, credentialFile, credentialEnv };
}

function readUrl(value: RunnerDynamic, file: string, at: string): string {
  const raw = readString(value, file, at);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${file}: ${at} must be an absolute http(s) URL, for example http://127.0.0.1:4723 (found "${raw}")`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${file}: ${at} must be an http(s) URL (found "${raw}")`);
  }
  if (url.username || url.password) {
    throw new Error(
      `${file}: ${at} carries a credential in the URL — this file never holds credential values. ` +
        `Remove the "user:password@" and point ${at.replace(/\.url$/, ".credential_file")} at a file holding it ` +
        `(or name an environment variable with credential_env).`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function readPlatform(value: RunnerDynamic, file: string, at: string): MobilePlatform {
  const raw = readString(value, file, at);
  if (!PLATFORMS.includes(raw as MobilePlatform)) {
    throw new Error(`${file}: ${at} must be "ios" or "android" (found "${raw}") — v1 configuration describes mobile targets only`);
  }
  return raw as MobilePlatform;
}

function readString(value: RunnerDynamic, file: string, at: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${file}: ${at} must be a non-empty string (found ${describe(value)})`);
  }
  return value.trim();
}

function asObject(value: RunnerDynamic, file: string, at: string): Record<string, RunnerDynamic> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: ${at} must be a mapping (found ${describe(value)})`);
  }
  return value as Record<string, RunnerDynamic>;
}

function assertKeys(value: Record<string, RunnerDynamic>, allowed: string[], file: string, at: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `${file}: ${at}.${key} looks like a credential, and credential VALUES are never written in this file — ` +
          `point credential_file at a file only this user can read, or name an environment variable with credential_env`,
      );
    }
    throw new Error(`${file}: ${at}.${key} is not a known key — expected one of: ${allowed.join(", ")}`);
  }
}

const describe = (value: RunnerDynamic): string =>
  value === undefined ? "nothing" : value === null ? "null" : Array.isArray(value) ? "a list" : typeof value === "object" ? "a mapping" : JSON.stringify(value);

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
