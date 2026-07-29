// playtest.yaml inheritance and case resolution: the defaults chain, the merge,
// and every cross-field rule the schemas cannot express.
// See docs/contracts/engine.md#discovery-and-configuration.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ValidateFunction } from "ajv";
import { assertionSchemaKeys } from "../assertions.ts";
import { normalizeBindPaths } from "../bindings.ts";
import { normalizeMatch } from "../match.ts";
import { parseInvariantPolicy, policyNeedsSpec } from "../invariants.ts";
import { parseOperationSelector } from "../openapi.ts";
import { normalizeSecretHeaders, normalizeRedact } from "../secrets.ts";
import { VISION_DRIFT_DEFAULT } from "../trajectory.ts";
import { DummyConfigError } from "./errors.ts";
import { caseValidatorFor, describeSchemaErrors, validateCaseBase, validateDefaults } from "./schema.ts";
import type {
  AppConfig,
  AssertionRegistry,
  AuthoredCaseConfig,
  CaseMode,
  DriverId,
  DurationInput,
  EnvironmentOverlay,
  MatchConfig,
  ParallelConfig,
  PerfConfig,
  RedactConfig,
  ResolutionMode,
  ResolvedViewport,
  RuntimeTarget,
} from "../types.ts";

type SuccessEntry = Record<string, unknown> & { label?: string; invariant?: unknown };
type BuiltinSuccessKind =
  | "url_matches"
  | "element_exists"
  | "screen_shows"
  | "api_called"
  | "response_status"
  | "response_matches"
  | "console_errors"
  | "accessibility_violations"
  | "invariant"
  | "assert";

interface InternalAppConfig extends Omit<AppConfig, "compose" | "storage_state"> {
  [key: string]: unknown;
  compose?: string | null;
  storage_state?: string | null;
  auth_unresolved?: boolean;
  envs?: Record<string, EnvironmentOverlay>;
}

interface InternalConfig extends Omit<
  AuthoredCaseConfig,
  "app" | "mode" | "persona" | "story" | "success" | "observe"
> {
  [key: string]: unknown;
  env: InternalAppConfig;
  mode: CaseMode;
  persona: Exclude<AuthoredCaseConfig["persona"], undefined>;
  story?: string;
  actor_model: string;
  grader_model: string;
  success?: SuccessEntry[];
  observe?: SuccessEntry[];
  parallel?: ParallelConfig;
  perf?: PerfConfig;
  match?: MatchConfig;
  redact?: RedactConfig;
}

interface YamlDocument extends Partial<InternalConfig> {
  [key: string]: unknown;
  app?: InternalAppConfig;
}

export interface ResolvedCaseDraft {
  id: string;
  storyId: string;
  file: string;
  name: string;
  _assertions: AssertionRegistry;
  story: string;
  mode: CaseMode;
  persona: string;
  personas?: string[];
  tags: string[];
  [key: string]: unknown;
}

export const DEFAULTS_FILE = "playtest.yaml";

const DEFAULTS: Pick<InternalConfig, "actor_model" | "grader_model" | "persona" | "mode"> = {
  actor_model: "gpt5_4_mini",
  grader_model: "gpt5_5",
  persona: "tester",
  mode: "journey",
};

// The engine's built-in model choices, exported (via core/public/llm.ts) so a
// consumer that layers its own defaults UNDER the file chain — the hosted
// project-level models — can say "using the engine default gpt5_4_mini"
// without hardcoding a copy that drifts from DEFAULTS above.
export const defaultModels = Object.freeze({
  actor_model: DEFAULTS.actor_model,
  grader_model: DEFAULTS.grader_model,
});

// max_steps/timeout are mode-aware, so they're resolved after merge (once the
// case's mode is known) rather than living in DEFAULTS: a journey is a tight
// regression (50 steps / 4m), a discovery run explores freely (300 / 30m). An
// explicit case/defaults value still wins — these only fill an unset budget.
const STEP_BUDGET: Record<CaseMode, number> = { journey: 50, discovery: 300 };
const TIME_BUDGET: Record<CaseMode, DurationInput> = { journey: "4m", discovery: "30m" };

// Per-driver success-criterion validity. The schemas accept every kind; this
// table is the cross-field rule the schema cannot express — a kind used under
// the wrong driver is a DummyConfigError naming the file (same shape as the
// discovery/vision rules). api_called omits mobile on purpose: the mobile driver
// has no network capture in v1 (docs/contracts/engine.md#mobile-driver), so it would otherwise
// FAIL the gate against an empty list — a config error is louder and truthful.
const SUCCESS_KIND_DRIVERS: Record<BuiltinSuccessKind, DriverId[]> = {
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
  // Tier-1/2 invariant policies (docs/contracts/engine.md#invariant-policies).
  // Every policy reads an HTTP request/response trace, and both the api and web
  // drivers record one — the api driver's IS the journey's program, the web
  // driver's is what the page asked for on the journey's behalf (har.json). So
  // the same policies answer "the UI looked fine; did the API underneath
  // behave?" on web. Not mobile: no network capture there
  // (docs/contracts/engine.md#mobile-driver), so a policy would report
  // not-exercised — i.e. FAIL — on every run.
  //
  // Web evaluation is PASSIVE ONLY: no observation phase (the rule is enforced
  // below, where `invariant.observe` is rejected on web).
  invariant: ["api", "web"],
  assert: ["web", "mobile", "api"],
};
// Per-driver perf-key validity. Web vitals are web-only; mobile and api perf
// (cold-start/jank, latency) are deferred — any perf key on them is a config
// error, so no run silently lacks a threshold it declared
// (docs/contracts/engine.md#cross-field-validation).
const PERF_KEY_DRIVERS: Record<string, DriverId[]> = {
  lcp_ms: ["web"],
  input_to_paint_ms: ["web"],
};
// Per-driver app.* key validity. The app schema is flat (every key allowed for
// every driver), so this is the cross-field rule it cannot express: a key set
// under the wrong driver is silently ignored at run time, which a config error
// naming the file makes loud instead (same shape as the perf-key rule). Keyed
// off the user-authored app.* keys only — derived keys (base_url/compose from
// --base-url) are applied after this check.
const APP_KEY_DRIVERS: Record<string, DriverId[]> = {
  // base_url is required for web/api and optional for mobile (it is not used to
  // reach the device — that is appium_url — but it feeds the init script's
  // BASE_URL, the mobile pre-auth/seed path the schemas document for any driver).
  base_url: ["web", "mobile", "api"],
  compose: ["web", "mobile", "api"],
  init: ["web", "mobile", "api"],
  storage_state: ["web"],
  // Per-story identity (v1 web-only, like storage_state — the label resolves to a
  // storage-state file). Widening to mobile/api changes the driver matrix.
  auth: ["web"],
  auth_states: ["web"],
  driver: ["web", "mobile", "api"],
  platform: ["mobile"],
  app: ["mobile"],
  device: ["mobile"],
  appium_url: ["mobile"],
  preserve_session: ["mobile"],
  // The enriched spec drives the Tier-1 invariant policies. On the api driver it
  // ALSO describes the surface to the actor; on web it is gate-only — the spec
  // never reaches a web actor's prompt, because a web journey is written in
  // clicks, not operations (docs/contracts/engine.md#openapi-ingestion).
  openapi: ["api", "web"],
  allowed_origins: ["api"],
  // Request headers merged UNDER the actor's own action headers, values either
  // literal or a { $secret: NAME } reference resolved at driver launch
  // (docs/contracts/engine.md#secrets-and-redaction).
  headers: ["api"],
  settle: ["web", "mobile"],
  viewport: ["web"],
  device_scale_factor: ["web"],
  cookies: ["web"],
};
const DURATION_UNITS: Record<"ms" | "s" | "m", number> = { ms: 1, s: 1000, m: 60000 };

// The PHYSICAL target fields — the ones that say WHERE a case runs rather than
// WHAT it does (docs/contracts/engine.md#runtime-target). A host that owns
// placement (the hosted runner) replaces this whole set after the authored
// merge; which of them a driver actually uses is read off APP_KEY_DRIVERS
// above, so there is one source of truth for the driver matrix.
const RUNTIME_TARGET_KEYS = ["base_url", "app", "platform", "device", "appium_url"] as const;
type RuntimeTargetKey = (typeof RUNTIME_TARGET_KEYS)[number];
const MOBILE_PLATFORMS = ["ios", "android"] as const;

/**
 * Validate a caller-supplied runtime target. Shape errors are the caller's
 * (a runner assembling an override), so they surface as DummyConfigError with
 * the offending key named — never a raw TypeError deep in resolution. Returns
 * null when no override was supplied. Pure; exported for test.
 */
export function normalizeRuntimeTarget(value: unknown): RuntimeTarget | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DummyConfigError(
      `runtimeTarget must be an object of ${RUNTIME_TARGET_KEYS.join("/")} (got ${JSON.stringify(value)})`,
    );
  }
  const entries = value as Record<string, unknown>;
  const unknown = Object.keys(entries).filter((k) => !(RUNTIME_TARGET_KEYS as readonly string[]).includes(k));
  if (unknown.length) {
    throw new DummyConfigError(
      `runtimeTarget: unknown key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — a runtime target replaces only the physical fields ${RUNTIME_TARGET_KEYS.join(", ")}`,
    );
  }
  // A supplied field must be a real value; null/undefined means "clear it", which
  // is what an absent key already means — so both forms are accepted and drop out.
  const str = (key: RuntimeTargetKey): string | undefined => {
    const v = entries[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || !v.trim()) {
      throw new DummyConfigError(
        `runtimeTarget.${key} must be a non-empty string (omit the key to clear it; got ${JSON.stringify(v)})`,
      );
    }
    return v;
  };
  const platform = str("platform");
  if (platform !== undefined && !(MOBILE_PLATFORMS as readonly string[]).includes(platform)) {
    throw new DummyConfigError(
      `runtimeTarget.platform must be one of ${MOBILE_PLATFORMS.join("/")} (got ${JSON.stringify(platform)})`,
    );
  }
  return {
    base_url: str("base_url"),
    app: str("app"),
    platform: platform as RuntimeTarget["platform"], // SAFETY: checked against MOBILE_PLATFORMS above
    device: str("device"),
    appium_url: str("appium_url"),
  };
}

/**
 * Apply the runtime target to a merged `app` accumulator: a WHOLE-TARGET
 * replacement discriminated by driver, never a partial merge. Every physical
 * field the driver uses takes the override's value or is cleared (an override
 * that omits `device` means the driver's default, never the authored device);
 * physical fields the driver does not use are cleared outright; and `compose`
 * is cleared, because an authored compose block must not boot a different
 * application under the caller's target (`--base-url` already nulls it to
 * force external mode).
 */
function applyRuntimeTarget(env: InternalAppConfig, target: RuntimeTarget, driver: DriverId): void {
  const uses = (key: RuntimeTargetKey): boolean => (APP_KEY_DRIVERS[key] ?? []).includes(driver);
  env.base_url = uses("base_url") ? target.base_url ?? undefined : undefined;
  env.app = uses("app") ? target.app ?? undefined : undefined;
  env.platform = uses("platform") ? target.platform ?? undefined : undefined;
  env.device = uses("device") ? target.device ?? undefined : undefined;
  env.appium_url = uses("appium_url") ? target.appium_url ?? undefined : undefined;
  env.compose = null;
}

/**
 * app.allowed_origins (api only): the egress allowlist — origins the driver may
 * reach besides base_url's own. Entries must be BARE http(s) origins
 * (scheme://host[:port]); a path, query, hash, or credentials is a config error
 * rather than a silent normalization, because an allowed origin admits the
 * WHOLE origin — accepting "https://api.example/v2" would imply a path scoping
 * the guard does not perform. Returns deduped origin strings, or null when the
 * key is absent. Pure; exported for test.
 */
export function normalizeAllowedOrigins(value: unknown, file: string): string[] | null {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) return null;
  const out: string[] = [];
  for (const entry of list) {
    let u;
    try {
      u = new URL(String(entry));
    } catch {
      throw new DummyConfigError(
        `${file}: app.allowed_origins entry ${JSON.stringify(entry)} is not an absolute URL (expected scheme://host[:port])`,
      );
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new DummyConfigError(
        `${file}: app.allowed_origins entry ${JSON.stringify(entry)} must be http or https`,
      );
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash)
      throw new DummyConfigError(
        `${file}: app.allowed_origins entry ${JSON.stringify(entry)} must be a bare origin (scheme://host[:port], no path/query/credentials) — an allowed origin admits the whole origin`,
      );
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}

/** "5m" | "90s" | "250ms" | number → milliseconds. */
export function parseDuration(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
    if (m) return Math.round(Number(m[1]) * DURATION_UNITS[m[2] as "ms" | "s" | "m" ?? "ms"]);
  }
  throw new DummyConfigError(
    `invalid duration ${JSON.stringify(v)} (use "5m", "90s", "250ms", or a number of ms)`,
  );
}

/**
 * Drop only the first (leftmost) `stories` segment from a split path. Migrated
 * suites have exactly one, so this is identical to dropping all of them; but a
 * deeper `stories/stories/` keeps its inner segment, so the two files stay
 * distinct instead of colliding on one id/baseline. Returns a new array.
 */
function dropFirstStories(parts: string[]): string[] {
  const i = parts.indexOf("stories");
  if (i === -1) return parts;
  return parts.slice(0, i).concat(parts.slice(i + 1));
}

export interface ResolveCaseOptions {
  baseUrl?: string | null;
  registry?: AssertionRegistry;
  env?: string | null;
  runtimeTarget?: RuntimeTarget | null;
  resolution?: ResolutionMode;
}

export async function resolveCase(
  file: string,
  namedRoot: string,
  {
    baseUrl = null,
    registry = { routing: new Map(), assertions: [] },
    env = null,
    runtimeTarget = null,
    resolution = "executable",
  }: ResolveCaseOptions = {}
): Promise<ResolvedCaseDraft> {
  const caseDir = path.dirname(file);
  const top = findRepoRoot(caseDir); // null → no .git ancestor: every ancestor contributes
  // Assertion-owned success keys this suite registered; the case validator clones
  // the schema with them injected (defaults files never carry success, so the
  // defaults validator stays the singleton).
  const assertionKeys = assertionSchemaKeys(registry.routing);
  const validateCase = caseValidatorFor(assertionKeys);
  const merged: InternalConfig = { ...DEFAULTS, env: {} };
  const chain = defaultsChain(top, caseDir);
  const loadedChain: Array<[string, YamlDocument]> = [];
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
  const envs: Record<string, EnvironmentOverlay> = merged.env.envs ?? {};
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
  // The placing host's physical target, applied LAST over the complete authored
  // merge (defaults chain → case → --env overlay). Authored physical fields stay
  // valid for direct CLI use and are simply inert here — the suite can no longer
  // redirect which application a placed run reaches
  // (docs/contracts/engine.md#runtime-target). Applied after the authored-key
  // driver-scope check above, so an authored `app.app` on a web case is still
  // the config error it always was, override or not.
  if (runtimeTarget) applyRuntimeTarget(merged.env, runtimeTarget, driver);
  // app.auth: the per-story identity label, resolved through app.auth_states
  // AFTER the full merge (defaults chain → case → env overlay), so the label is
  // environment-agnostic and the selected env supplies the map. "none" explicitly
  // clears any inherited storage_state (a signup story starts signed out); absent
  // keeps today's behavior (whatever storage_state resolves to). The resolved
  // file wins over any inherited storage_state.
  const authLabel = merged.env.auth ?? null;
  const authStates = merged.env.auth_states ?? null;
  delete merged.env.auth_states; // resolution input, never on the final ResolvedCase env
  if (authLabel !== null) {
    if (authLabel === "none") {
      merged.env.storage_state = null;
    } else if (authStates === null) {
      // No auth_states map is declared anywhere in this merged view. The map
      // normally lives in an env overlay (hosted: generated by the executor;
      // laptop: a local overlay) — so listing/validating the suite WITHOUT an
      // env selected must not die here (the suite files are env-agnostic by
      // docs/contracts/engine.md#web-identity). Resolution defers to run start:
      // prepareEnv fails the
      // case as infra naming the label (env.ts) — a run never silently starts
      // under the wrong identity. A DECLARED map missing the label is still
      // the immediate config error below (it catches typos where they happen).
      merged.env.auth_unresolved = true;
    } else {
      if (!Object.prototype.hasOwnProperty.call(authStates, authLabel)) {
        const labels = Object.keys(authStates).sort();
        const avail = labels.length
          ? `available: ${labels.join(", ")}`
          : "the declared app.auth_states map is empty";
        throw new DummyConfigError(`${file}: app.auth "${authLabel}" has no entry in app.auth_states (${avail})`);
      }
      merged.env.storage_state = authStates[authLabel];
    }
  }

  // base_url is required for web/api (they reach an HTTP origin); mobile reaches
  // a device/Appium server and only needs the app binary. Both are
  // EXECUTABLE-only requirements: structural resolution validates the case and
  // its logical configuration for a host whose physical target arrives
  // elsewhere — at placement, not in the suite
  // (docs/contracts/engine.md#resolution-modes). Faking a target here instead
  // would mask real errors, and for mobile there is no app path to fake.
  if (resolution === "executable" && driver !== "mobile" && !merged.env.base_url) {
    // When envs are declared, name them as the recovery (the CLI also offers an
    // interactive picker off err.availableEnvs on a TTY); else the plain hint.
    const envHint = envNames.length ? ` (or pass --env <name>; available: ${envNames.join(", ")})` : "";
    const err = new DummyConfigError(
      `${file}: no app.base_url configured (set it in a playtest.yaml, the case file, or pass --base-url)${envHint}`,
    );
    err.availableEnvs = envNames;
    throw err;
  }
  if (resolution === "executable" && driver === "mobile" && !merged.env.app) {
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
    const authoredPersonas = persona;
    if (merged.mode === "discovery") {
      personas = authoredPersonas;
      persona = authoredPersonas[0]!; // SAFETY: the schema requires at least one authored persona
    } else {
      persona = authoredPersonas[0]!; // SAFETY: the schema requires at least one inherited persona
      if (authoredPersonas.length > 1) {
        console.warn(
          `playtest: ${path.relative(process.cwd(), file)}: a journey runs one persona — using "${persona}", ignoring ${authoredPersonas.slice(1).join(", ")} (set mode: discovery to run every persona).`,
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
  // artifacts: how much this run writes to disk
  // (docs/contracts/artifacts.md#artifact-profiles). "core" is the default
  // because the extras "debug" adds — the Playwright trace, MHTML, the native
  // a11y tree — are read by nothing in the harness, the gate, the grader, or the
  // viewer, yet they are the majority of a web run's bytes and of its close
  // time. The schema's enum normally rejects a typo first; this guard also
  // covers programmatic callers that build a case object without Ajv.
  const artifacts = merged.artifacts ?? "core";
  if (artifacts !== "core" && artifacts !== "debug") {
    throw new DummyConfigError(
      `${file}: "artifacts: ${JSON.stringify(merged.artifacts)}" is not a profile — use "core" (the default: a11y text, step screenshots, video, HAR, trajectory) or "debug" (core plus the Playwright trace, MHTML, and the native a11y tree)`,
    );
  }
  // `observe:` is the ADVISORY sibling of `success:`
  // (docs/contracts/engine.md#invariant-policies): the same entry shapes, but
  // its results never gate. Case-only and journey-only, exactly like success.
  if (merged.mode === "discovery" && merged.observe !== undefined) {
    throw new DummyConfigError(
      `${file}: discovery cases have no gate, so there is nothing for "observe" to advise on — remove it (ask "report" questions instead)`,
    );
  }
  const success = merged.success ?? [];
  if (!Array.isArray(success)) throw new DummyConfigError(`${file}: "success" must be an array`);
  const observe = merged.observe ?? [];
  if (!Array.isArray(observe)) throw new DummyConfigError(`${file}: "observe" must be an array`);
  for (const [key, entries] of [["success", success], ["observe", observe]] as Array<[string, SuccessEntry[]]>) {
    for (const c of entries) {
      // Each entry carries one check kind plus an OPTIONAL cosmetic `label`
      // (schema maxProperties: 2). The schema can no longer enforce exactly one
      // kind, once a label is allowed alongside it, so do it here — the kind is the
      // sole "non-label" key. Zero or two+ kinds is a config error, naming the file.
      const kindKeys = Object.keys(c).filter((k) => k !== "label");
      if (kindKeys.length !== 1) {
        throw new DummyConfigError(
          `${file}: each "${key}" entry needs exactly one check kind` +
          (kindKeys.length ? ` (got ${kindKeys.length}: ${kindKeys.join(", ")})` : "") +
          ` — "label" is an optional name, not a kind`,
        );
      }
      const kind: keyof typeof SUCCESS_KIND_DRIVERS = kindKeys[0] as keyof typeof SUCCESS_KIND_DRIVERS;
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
      // The structured operation selector (docs/contracts/engine.md#gates-and-custom-assertions):
      // method + OpenAPI-style path template, an occurrence, and the check's own
      // value. Parsed HERE so a malformed selector names the case file instead of
      // failing the gate at the end of a run. A bare string parses to null and
      // keeps today's any-request / last-body semantics.
      if (kind === "response_status" || kind === "response_matches") {
        try {
          parseOperationSelector(kind, c[kind]);
        } catch (e: any) { // SAFETY: selector validation may throw non-Error values
          throw new DummyConfigError(`${file}: ${e.message}`);
        }
      }
      // An invariant policy is validated the same way, and one cross-field rule
      // the policy module cannot see is applied here: a Tier-1 spec check with no
      // app.openapi would report "not applicable" at the end of every run, which
      // under `success:` is a failure. Naming it now is far louder.
      if (kind === "invariant") {
        let policy;
        try {
          policy = parseInvariantPolicy(c[kind]);
        } catch (e: any) { // SAFETY: policy validation may throw non-Error values
          throw new DummyConfigError(`${file}: ${e.message}`);
        }
        if (policyNeedsSpec(policy.policy) && !merged.env?.openapi) {
          throw new DummyConfigError(
            `${file}: the "${policy.policy}" invariant policy is driven by the OpenAPI document — set app.openapi, or use a Tier-2 policy that reads the trace alone`,
          );
        }
        // Passive only on web (docs/contracts/engine.md#invariant-policies). The
        // observation phase issues its own read-only GET, which is an api-driver
        // capability: a browser page's requests carry session state — cookies,
        // headers, an in-page token — that a synthetic request from the harness
        // would not reproduce, so its answer would be about a different caller.
        // Refused at discovery rather than silently reported as "no observation
        // channel on this driver" at the end of a run.
        if (policy.observe && driver !== "api") {
          throw new DummyConfigError(
            `${file}: "invariant.observe" issues the gate's own read-only request, which is api-only (this case runs the ${driver} driver)` +
              " — a web run evaluates policies passively over the requests the page actually made, so put the read-back in the story instead",
          );
        }
      }
    }
  }
  if (observe.length && !["api", "web"].includes(driver)) {
    throw new DummyConfigError(
      `${file}: "observe" declares advisory invariant policies, which need a recorded request trace (api or web; this case runs the ${driver} driver)`,
    );
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
  } catch (e: any) { // SAFETY: duration validation may throw non-Error values
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
  // mirror this — see trajectory.ts baselinePaths). Only the first (leftmost)
  // `stories/` is dropped: a deeper `stories/` segment stays, so nested cases keep
  // distinct ids (and distinct baselines) rather than colliding.
  const baseId = dropFirstStories(path.relative(namedRoot, file).replace(/\.yaml$/, "").split(path.sep)).join("/");
  return {
    id: baseId,
    // The stable, persona-INDEPENDENT base id (same as `id` here). `id` becomes
    // `<storyId>@<persona>` for a fanned-out discovery persona (discoverCases
    // below); storyId stays the base so a before_each hook can key one shared
    // seeded entity per study across every persona, vs `id` (caseId) for
    // per-persona isolation (docs/contracts/engine.md#resolved-cases).
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
    // Advisory invariant policies (docs/contracts/engine.md#invariant-policies):
    // same shapes as `success`, reported in the manifest's gate block as a
    // separate `advisory` array, never affecting pass/fail. Always an array, so
    // the gate needs no presence check.
    observe,
    perf: merged.perf ?? {},
    report: merged.report ?? [],
    // Which request-template and response-projection fields carry
    // application-sensitive values (docs/contracts/engine.md#secrets-and-redaction).
    // null when nothing is declared, so a suite that never redacts is unchanged.
    redact: normalizeRedact(merged.redact, file),
    // The volatile-field vocabulary API drift comparison is normalized through
    // (docs/contracts/engine.md#match-rules): which response fields are excluded,
    // which are compared by value, how they are normalized, and which statuses a
    // case declares interchangeable. null when nothing is declared.
    match: normalizeMatch(merged.match, file),
    // Response field paths a suite declares bindable when the conservative
    // producer heuristic would not recognize them
    // (docs/contracts/engine.md#bindings). null when nothing is declared.
    bind: normalizeBindPaths(merged.bind, file),
    vision,
    visual_regression: visualRegression,
    visual_regression_drift: visualRegressionDrift,
    // The recording profile the drivers gate their debug captures on
    // (docs/contracts/artifacts.md#artifact-profiles). Not a comparability pin:
    // it changes what is written BESIDE the evidence, never the evidence — the
    // snapshot text, the actions, and the gate see exactly the same run.
    artifacts,
    limits: { max_steps, timeout_ms },
    // Run-wide concurrency from playtest.yaml (CLI --parallel/--parallel-record
    // override it). int n | true (default pool) | { total, record } | null (auto).
    // The object form caps how many cases may RECORD at once (checks fill the
    // rest). Surfaced per-case because config resolves every defaults value
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
      // The abstract identity label this case ran as ("member" / "none" / null =
      // not declared). Informational for the manifest/viewer/platform — the
      // actionable output is storage_state above, already resolved through
      // app.auth_states. Not a comparability pin (a session input, like cookies).
      auth: authLabel,
      // True when the label could not be resolved because NO auth_states map is
      // declared anywhere (env-agnostic listing/validation) — prepareEnv
      // refuses to run such a case (docs/contracts/engine.md#web-identity).
      ...(merged.env.auth_unresolved === true ? { auth_unresolved: true } : {}),
      // mobile (Appium) keys; null on web/api
      platform: merged.env.platform ?? null,
      app: merged.env.app ?? null,
      device: merged.env.device ?? null,
      appium_url: merged.env.appium_url ?? null,
      // mobile only: keep the app installed + its data across runs (Appium
      // noReset) instead of the default reinstall-and-wipe, so an already
      // signed-in build stays authenticated. null on web/api
      preserve_session: merged.env.preserve_session ?? null,
      // api + web key; null on mobile. On api it describes the surface to the
      // actor AND drives the Tier-1 invariant policies; on web it is gate-only
      // (docs/contracts/engine.md#openapi-ingestion).
      openapi: merged.env.openapi ?? null,
      // Extra origins the api driver may reach besides base_url's own — the
      // egress allowlist (docs/contracts/engine.md#api-driver). Normalized to
      // bare origins here so the driver compares origin-to-origin. A session
      // input like cookies — NOT a manifest pin.
      allowed_origins: normalizeAllowedOrigins(merged.env.allowed_origins, file),
      // api key; null on web/mobile. Standing request headers (auth, tenant,
      // api-version) whose values may be `{ $secret: NAME }` references. Only the
      // SHAPE is validated here — resolution happens at driver launch so a
      // resolved credential never lands on the ResolvedCase or the manifest.
      // A session input like cookies — NOT a manifest pin.
      headers: normalizeSecretHeaders(merged.env.headers, file),
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
  } as ResolvedCaseDraft; // SAFETY: Ajv and the driver checks above establish the discriminated resolved-case draft
}

// Default web viewport. width 1280; height 720 captures viewport-only stills
// (what the user saw). An EXPLICIT height: null means full-page stills (whole
// scroll). These must mirror DEFAULT_VIEWPORT in drivers/web.ts.
const VIEWPORT_DEFAULT_WIDTH = 1280;
const VIEWPORT_DEFAULT_HEIGHT = 720;

/**
 * Resolve app.viewport into { width, height } with per-field defaults. An ABSENT
 * height inherits the default (720, viewport-only); an EXPLICIT height: null is
 * preserved (full-page capture). `undefined` input (no app.viewport) yields the
 * full default. Exported for unit test.
 */
export function resolveViewport(vp?: { width?: number; height?: number | null }): ResolvedViewport {
  const width = vp?.width ?? VIEWPORT_DEFAULT_WIDTH;
  // Distinguish "no height key" (=> default) from "height: null" (=> full page).
  const height: number | null = vp && "height" in vp ? vp.height as number | null : VIEWPORT_DEFAULT_HEIGHT;
  return { width, height };
}

/** Nearest ancestor dir containing .git, or null. */
function findRepoRoot(fromDir: string): string | null {
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
function defaultsChain(top: string | null, caseDir: string): string[] {
  const files: string[] = [];
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

async function loadYaml(
  file: string,
  validateCase: ValidateFunction = validateCaseBase
): Promise<YamlDocument> {
  let doc: any; // SAFETY: YAML.parse returns untrusted data narrowed by Ajv below
  try {
    doc = YAML.parse(await fs.readFile(file, "utf8"));
  } catch (e: any) { // SAFETY: YAML may throw non-Error values
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
    const resolvePaths = (obj: any, keys: string[]): void => { // SAFETY: mutates schema-validated app and environment overlay maps
      for (const k of keys)
        if (typeof obj[k] === "string") obj[k] = path.resolve(path.dirname(file), obj[k]);
    };
    resolvePaths(doc.app, ["compose", "init", "storage_state", "app", "openapi"]);
    // auth_states values are storage-state paths — resolved against the declaring
    // file like every other path-bearing key.
    const resolveAuthStates = (obj: InternalAppConfig | EnvironmentOverlay): void => {
      if (obj.auth_states && typeof obj.auth_states === "object") {
        for (const label of Object.keys(obj.auth_states)) {
          if (typeof obj.auth_states[label] === "string") {
            obj.auth_states[label] = path.resolve(path.dirname(file), obj.auth_states[label]);
          }
        }
      }
    };
    resolveAuthStates(doc.app);
    // Per-env overlays carry the same path-bearing keys (init/storage_state/
    // app/auth_states), resolved against the declaring file too so an env's path
    // is portable. `app` is the mobile binary: per-env because the build lives on
    // whichever machine the device is attached to, and usually written absolute
    // (path.resolve leaves an absolute path alone).
    if (doc.app.envs && typeof doc.app.envs === "object") {
      for (const overlay of Object.values(doc.app.envs)) {
        if (overlay && typeof overlay === "object") {
          resolvePaths(overlay, ["init", "storage_state", "app"]);
          resolveAuthStates(overlay);
        }
      }
    }
  }
  return doc;
}

/** Nearest-wins merge; app merges per-key (into the internal env accumulator).
 *  Case-only keys (success/tags/report/personas) never arrive from a defaults
 *  file — defaults.schema.json rejects them at load. */
function mergeDoc(target: InternalConfig, doc: YamlDocument): void {
  for (const [k, v] of Object.entries(doc)) {
    if (k === "app") {
      if (v && typeof v === "object") Object.assign(target.env, v);
    } else target[k] = v;
  }
}
