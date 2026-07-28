// An environment's `config` document, as the form sees it.
//
// A ring's config is one JSON object the server stores verbatim, and the
// console shows two views of it: named fields for the keys people actually set,
// and the raw document behind Advanced. Those two must never be able to
// disagree — the form's rule is the story editor's rule, applied to JSON: the
// FIELDS write into the document, the document is what saves, and a key no
// field knows about survives untouched.
//
// DOM-free on purpose, so the offline gate can assert the surgery and the
// upload guardrails without a browser.

/** `config.app` keys the environment form owns as named fields. */
export const ENV_APP_FIELDS = ["base_url", "platform", "app", "appium_url", "device"] as const;

export type EnvAppField = (typeof ENV_APP_FIELDS)[number];

/**
 * What a mobile ring needs beyond a URL. These live on the ENVIRONMENT rather
 * than the suite because all three describe the machine the device is attached
 * to (hosted.md, § Environments): which platform its simulator runs, which
 * build to install, and where its Appium server listens.
 */
export const MOBILE_FIELDS: EnvAppField[] = ["platform", "app", "appium_url"];

export const PLATFORMS = ["ios", "android"];

/** Does this ring already say anything about a device? */
export function hasMobileConfig(config: EnvConfig | null | undefined): boolean {
  const app = config?.app || {};
  return MOBILE_FIELDS.some((k) => typeof app[k] === "string" && app[k].trim() !== "");
}

export interface EnvConfig {
  app?: Record<string, unknown> & { base_url?: string };
  [key: string]: unknown;
}

/**
 * The explicit driver, with the same one-release fallback as migration 0020
 * for a console briefly talking to a pre-migration server during a restart.
 */
export function environmentDriver(environment: {
  driver?: string;
  config?: EnvConfig | null;
  app_artifact?: unknown;
}): "web" | "api" | "mobile" {
  if (environment.driver === "api" || environment.driver === "mobile") return environment.driver;
  if (environment.driver === "web") return "web";
  const baseUrl = environment.config?.app?.base_url;
  return !(typeof baseUrl === "string" && baseUrl.trim()) &&
    (hasMobileConfig(environment.config) || !!environment.app_artifact)
    ? "mobile"
    : "web";
}

/** The named fields' current values, as strings a form input can hold. */
export function readEnvApp(config: EnvConfig | null | undefined): Record<EnvAppField, string> {
  const app: Record<string, unknown> = (config?.app as Record<string, unknown>) || {};
  const out = {} as Record<EnvAppField, string>;
  for (const key of ENV_APP_FIELDS) out[key] = typeof app[key] === "string" ? (app[key] as string) : "";
  return out;
}

/**
 * Write the named fields back into the document. A blank field DELETES its key
 * (that is what "no platform set" means; an empty string is not a platform),
 * and an emptied `app` map is removed rather than left as `"app": {}` for the
 * next reader to wonder about. Everything else in the document is returned
 * exactly as it arrived.
 */
export function applyEnvApp(config: EnvConfig | null | undefined, values: Partial<Record<EnvAppField, string | null>>): EnvConfig {
  const next: EnvConfig = { ...(config || {}) };
  const app: Record<string, unknown> = { ...((next.app as Record<string, unknown>) || {}) };
  for (const [key, raw] of Object.entries(values)) {
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (value) app[key] = value;
    else delete app[key];
  }
  if (Object.keys(app).length) next.app = app;
  else delete next.app;
  return next;
}

// ---------- app artifacts ----------

/** What an uploaded binary may be called (control plane: api/environments.ts). */
export const APP_ARTIFACT_EXTENSIONS = [".apk", ".aab", ".ipa", ".zip"];

export interface AppArtifact {
  sha256: string;
  size: number;
  filename?: string | null;
  uploaded_at?: string | null;
}

/** MiB with one decimal below 10, whole numbers above — the size of a build. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

/** The stored artifact in one line: what it is, how big, and how old. */
export function artifactSummary(artifact: AppArtifact | null | undefined, agoOf: (ts: unknown) => string): string | null {
  if (!artifact) return null;
  const parts = [artifact.filename || "app binary", fmtBytes(artifact.size)];
  if (artifact.uploaded_at) parts.push(`uploaded ${agoOf(artifact.uploaded_at)}`);
  return parts.join(" · ");
}

/**
 * Why this file cannot be uploaded — checked in the browser, in the server's
 * own words, BEFORE four minutes of upload end in a 413. The cap is the
 * deployment's (`/me` capabilities), never a number this module invents.
 */
export function appArtifactProblem(
  file: { name?: string; size?: number } | null | undefined,
  maxBytes: number,
): string | null {
  if (!file || !file.name) return "Choose the app binary to upload.";
  const name = file.name;
  if (!APP_ARTIFACT_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e))) {
    return `“${name}” is not an app binary this platform can install (expected ${APP_ARTIFACT_EXTENSIONS.join(", ")}). `
      + "An iOS .app is a directory, so zip it first — the runner unpacks it.";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return `“${name}” needs a plain file name — letters, digits, dot, dash and underscore only. Rename it and try again.`;
  }
  if (Number.isFinite(maxBytes) && (file.size ?? 0) > maxBytes) {
    return `“${name}” is ${fmtBytes(file.size ?? 0)}, past this deployment's ${fmtBytes(maxBytes)} cap for app binaries. `
      + "An operator can raise PLAYTEST_APP_ARTIFACT_MAX_MB, or leave the build on the runner's own disk and point this ring's app path at it instead.";
  }
  if (!(file.size ?? 0)) return `“${name}” is empty.`;
  return null;
}
