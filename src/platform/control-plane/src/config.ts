// Control-plane configuration from the environment. This file owns the complete
// variable inventory, defaults, and validation.
// Every failure is a friendly ServerConfigError naming the offending variable —
// the DummyConfigError discipline, applied to server boot. Pure and testable:
// loadConfig(env) never reads process.env itself.
import path from "node:path";
import { resolveRetentionConfig } from "./retention/worker.ts";
import { DEFAULT_RETRIEVAL } from "./findings/shortlist.ts";

export type ObjectStoreConfig =
  | { kind: "fs"; root: string }
  | {
      kind: "s3";
      url: string;
      bucket: string | null;
      region: string | null;
      accessKeyId: string | null;
      secretAccessKey: string | null;
    };

/** A numeric override that keeps its documented default when unset or empty. */
function num(raw: string | undefined, fallback: number): number {
  if (raw == null || String(raw).trim() === "") return fallback;
  return Number(raw);
}

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

/**
 * The tier control-plane LLM work defaults to — the same short model enum core's
 * grader defaults to (`src/core/llm.ts`), so hosted drafting and synthesis cost
 * and behave like grading unless an operator deliberately pins one of them.
 */
const GRADER_TIER_MODEL = "sonnet";

/** Decode a 32-byte key given as base64 or hex; null when unset. */
function parseKmsKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new ServerConfigError(
      `PLAYTEST_KMS_KEY must decode to exactly 32 bytes (got ${buf.length}); ` +
        `use a base64 or hex AES-256 key, e.g. \`openssl rand -base64 32\``,
    );
  }
  return buf;
}

/** Resolve deployment-wide retention days, turning validation into a friendly boot error. */
function resolveRetentionDays(env: NodeJS.ProcessEnv) {
  try {
    return resolveRetentionConfig(env);
  } catch (e: any /* TODO(ts): Retention validation attaches structured details to Error. */) {
    const first = e.details?.[0];
    throw new ServerConfigError(
      first
        ? `${first.path}: ${first.message} (days, or "forever" for full/core to keep evidence indefinitely)`
        : e.message,
    );
  }
}

/**
 * Build the validated config from an env-like object.
 * @param {Record<string,string|undefined>} env
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const authMode = env.PLAYTEST_AUTH === "dev" ? "dev" : "oidc";

  // One data root holds the SQLite database and, by default, the object store,
  // so a deployment cannot accidentally split durable state across volumes
  // (docs/contracts/hosted.md, "Storage"). PLAYTEST_DATA_DIR is the single knob;
  // OBJECT_STORE_URL remains the expert override for S3 or a separate mount.
  const dataDir = path.resolve(env.PLAYTEST_DATA_DIR || path.resolve(process.cwd(), ".playtest-data"));
  const databaseFile = path.resolve(env.PLAYTEST_DB_FILE || path.join(dataDir, "playtest.sqlite"));

  // Object storage: an `s3://`/`http(s)://` OBJECT_STORE_URL selects the S3 adapter;
  // anything else (or unset) is a local filesystem root — the default so
  // `npm test` and local dev never need MinIO. `file://` and bare paths both work.
  const storeUrl = env.OBJECT_STORE_URL || "";
  let objectStore: ObjectStoreConfig;
  if (/^s3:\/\//.test(storeUrl) || /^https?:\/\//.test(storeUrl)) {
    objectStore = {
      kind: "s3",
      url: storeUrl,
      bucket: env.OBJECT_STORE_BUCKET || null,
      region: env.OBJECT_STORE_REGION || null,
      accessKeyId: env.OBJECT_STORE_ACCESS_KEY || null,
      secretAccessKey: env.OBJECT_STORE_SECRET_KEY || null,
    };
  } else {
    const root = storeUrl.replace(/^file:\/\//, "") || path.join(dataDir, "objects");
    objectStore = { kind: "fs", root: path.resolve(root) };
  }

  const config = {
    port: Number(env.PORT || 4177),
    host: env.HOST || "127.0.0.1",
    dataDir,
    databaseFile,
    objectStore,
    kmsKey: parseKmsKey(env.PLAYTEST_KMS_KEY),
    publicUrl: (env.PUBLIC_URL || `http://127.0.0.1:${Number(env.PORT || 4177)}`).replace(/\/$/, ""),
    logLevel: env.LOG_LEVEL || "info",
    dispatch: {
      maxActivePerProject: Number(env.PLAYTEST_DISPATCH_MAX_ACTIVE_PER_PROJECT || 4),
      // How long the reconciler waits for GitHub's 204 dispatch response to be
      // correlated to a workflow run (run-name scan or executor exchange) before
      // declaring the dispatch dead. Seconds; default 15 minutes.
      correlateDeadlineMs: Number(env.PLAYTEST_DISPATCH_CORRELATE_DEADLINE_S || 900) * 1000,
      github: {
        enabled: !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_REPOSITORY && env.GITHUB_WORKFLOW_ID),
        apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
        appId: env.GITHUB_APP_ID || null,
        privateKey: (env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n") || null,
        installationId: env.GITHUB_APP_INSTALLATION_ID || null,
        repository: env.GITHUB_REPOSITORY || null,
        workflowId: env.GITHUB_WORKFLOW_ID || "playtest-runner.yml",
        ref: env.GITHUB_WORKFLOW_REF || "main",
        oidcAudience: env.GITHUB_OIDC_AUDIENCE || "playtest",
        oidcIssuer: env.GITHUB_OIDC_ISSUER || "https://token.actions.githubusercontent.com",
      },
      // Test/development escape hatch for the local dispatch mock. Production
      // exchanges must validate a GitHub OIDC token against workflow_run_id.
      allowInsecureRunnerExchange: env.PLAYTEST_RUNNER_INSECURE_EXCHANGE === "1" || authMode === "dev",
      // PLAYTEST_DISPATCH=local runs launches through the in-process
      // LocalDispatchClient (spawns the real runner-agent on this machine)
      // instead of GitHub. Dev auth only: its exchange rides the insecure
      // runner exchange, which production must never enable.
      local: env.PLAYTEST_DISPATCH === "local",
    },
    auth: { mode: authMode } as {
      mode: "dev" | "oidc";
      oidc?: { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scope: string };
      devUser?: { subject: string; email: string; name: string };
    }, // TODO(ts): The validated auth mode determines which optional branch is populated below.
    // Control-plane LLM work uses the §8 gateway env (PLAYTEST_LLM_BASE_URL /
    // PLAYTEST_LLM_API_KEY, read by core llm.ts at call time). There are two
    // independent jobs — inline story drafting and discovery study synthesis —
    // and neither needs a tier of its own, so both default to the grader tier.
    // Each keeps its OWN narrow override so pinning one never silently moves the
    // other: a variable named for authoring must not decide how studies are
    // synthesized. Documented in README.md and docs/contracts/hosted.md.
    llm: {
      authoringModel: env.PLAYTEST_AUTHORING_MODEL || GRADER_TIER_MODEL,
      synthesisModel: env.PLAYTEST_SYNTHESIS_MODEL || GRADER_TIER_MODEL,
      // Consolidation verification is forced-tool extraction over short claim
      // prompts, and it now runs automatically after runs (auto-dedupe): its
      // default is the gpt5_6_terra tier, chosen for cheap, reliable same-bug
      // judgment rather than riding the grader tier. Projects may override it
      // (`PUT /projects/:p/models` consolidation_model); this deployment-wide
      // env override sits between the two.
      consolidationModel: env.PLAYTEST_CONSOLIDATION_MODEL || "gpt5_6_terra",
      // Auto-resolve fix verification is the same job shape as consolidation —
      // forced-tool extraction over a short claim-vs-page-content prompt — so
      // it defaults to the same cheap tier. Projects may override it
      // (`PUT /projects/:p/models` auto_resolve_model); this deployment-wide
      // env override sits between the two.
      autoResolveModel: env.PLAYTEST_AUTO_RESOLVE_MODEL || "gpt5_6_terra",
    },
    // Candidate consolidation retrieval thresholds (docs/contracts/hosted.md).
    // Defaults are measured against the P0 fixture corpus and their rationale is
    // recorded in tests/core/findings/README.md; they are configurable
    // because the right values are a property of a project's corpus, not of the
    // algorithm. Every one of them bounds cost: k and the floor bound how many
    // neighbors can form an edge, the cluster caps bound one call, and
    // max_clusters bounds a whole run.
    consolidation: {
      k: num(env.PLAYTEST_CONSOLIDATION_K, DEFAULT_RETRIEVAL.k),
      floor: num(env.PLAYTEST_CONSOLIDATION_FLOOR, DEFAULT_RETRIEVAL.floor),
      autoSuggest: num(env.PLAYTEST_CONSOLIDATION_AUTO_SUGGEST, DEFAULT_RETRIEVAL.autoSuggest),
      maxClusterItems: num(env.PLAYTEST_CONSOLIDATION_MAX_CLUSTER_ITEMS, DEFAULT_RETRIEVAL.maxClusterItems),
      maxPromptBytes: num(env.PLAYTEST_CONSOLIDATION_MAX_PROMPT_BYTES, DEFAULT_RETRIEVAL.maxPromptBytes),
      maxClusters: num(env.PLAYTEST_CONSOLIDATION_MAX_CLUSTERS, DEFAULT_RETRIEVAL.maxClusters),
    },
    // Automatic post-run dedupe of unreviewed findings: after reports land,
    // a debounced per-project sweep runs the SAME retrieve-then-verify
    // consolidation pipeline and auto-applies only the model's high-confidence
    // groups (docs/contracts/hosted.md, "Consolidation"). On by default when
    // the LLM gateway is configured — a sweep costs cents against a run that
    // cost dollars; PLAYTEST_AUTO_DEDUPE=off restores the manual-only flow.
    autoDedupe: {
      enabled: env.PLAYTEST_AUTO_DEDUPE !== "off",
      debounceMs: Number(env.PLAYTEST_AUTO_DEDUPE_DEBOUNCE_S ?? 20) * 1000,
    },
    // Automatic resolution of findings a later run disproves: after reports
    // land, a debounced per-project sweep stamps each affected (suite,
    // environment, case) and resolves findings whose every stamp is fresh
    // (docs/contracts/hosted.md, "Findings"). Gate and signal tiers are
    // deterministic, so the sweep is on by default everywhere; judgment-call
    // findings are additionally re-verified through the LLM gateway when one
    // is configured (llm.autoResolveModel). `pinDays` is the
    // grace window an auto-resolved finding keeps its evidence runs pinned
    // against retention, so a mistaken auto-close stays reversible with its
    // evidence intact.
    autoResolve: {
      enabled: env.PLAYTEST_AUTO_RESOLVE !== "off",
      // What a VERIFIED fix of a judgment-call finding may do: "semi" writes
      // the "looks fixed — confirm" suggestion a person resolves, "full"
      // resolves it outright. Gate and signal resolutions are deterministic
      // and ignore the mode. Per-project pin: projects.auto_resolve_mode.
      mode: env.PLAYTEST_AUTO_RESOLVE_MODE || "semi",
      debounceMs: Number(env.PLAYTEST_AUTO_RESOLVE_DEBOUNCE_S ?? 20) * 1000,
      pinDays: Number(env.PLAYTEST_AUTO_RESOLVE_PIN_DAYS ?? 90),
    },
    // Retention is one deployment-wide policy (no per-project configuration):
    // conservative defaults with optional operator env overrides
    // (PLAYTEST_RETENTION_{EVENTS,FULL,CORE}_DAYS; FULL/CORE accept "forever").
    retention: {
      intervalMs: Number(env.PLAYTEST_RETENTION_INTERVAL_S || 0) * 1000,
      days: resolveRetentionDays(env),
    },
    // Write-route rate limits (Phase 7): per-principal token bucket on
    // POST/PUT/DELETE under /api/v1 (runner protocol exempt). 0 disables.
    rateLimit: {
      writesPerMinute: Number(env.PLAYTEST_RATE_LIMIT_WRITES_PER_MIN ?? 240),
      writeBurst: Number(env.PLAYTEST_RATE_LIMIT_WRITE_BURST ?? 60),
    },
    // How often the dispatch reconciler polls GitHub for liveness (Phase 7
    // wires it into the server; earlier phases only ran it from tests). 0
    // disables — fine for dev, never for a deployment that dispatches to GHA.
    reconcile: {
      intervalMs: Number(env.PLAYTEST_RECONCILE_INTERVAL_S ?? 30) * 1000,
    },
  };

  if (Number.isNaN(config.port)) {
    throw new ServerConfigError(`PORT must be a number (got ${JSON.stringify(env.PORT)})`);
  }
  if (!Number.isFinite(config.dispatch.maxActivePerProject) || config.dispatch.maxActivePerProject < 1) {
    throw new ServerConfigError(
      `PLAYTEST_DISPATCH_MAX_ACTIVE_PER_PROJECT must be a positive number ` +
        `(got ${JSON.stringify(env.PLAYTEST_DISPATCH_MAX_ACTIVE_PER_PROJECT)})`,
    );
  }
  if (!Number.isFinite(config.dispatch.correlateDeadlineMs) || config.dispatch.correlateDeadlineMs < 60_000) {
    throw new ServerConfigError(
      `PLAYTEST_DISPATCH_CORRELATE_DEADLINE_S must be a number of seconds >= 60 ` +
        `(got ${JSON.stringify(env.PLAYTEST_DISPATCH_CORRELATE_DEADLINE_S)})`,
    );
  }
  if (!Number.isFinite(config.retention.intervalMs) || config.retention.intervalMs < 0) {
    throw new ServerConfigError(
      `PLAYTEST_RETENTION_INTERVAL_S must be a number of seconds >= 0 ` +
        `(got ${JSON.stringify(env.PLAYTEST_RETENTION_INTERVAL_S)})`,
    );
  }
  if (!Number.isFinite(config.rateLimit.writesPerMinute) || config.rateLimit.writesPerMinute < 0) {
    throw new ServerConfigError(
      `PLAYTEST_RATE_LIMIT_WRITES_PER_MIN must be a number >= 0 (0 disables) ` +
        `(got ${JSON.stringify(env.PLAYTEST_RATE_LIMIT_WRITES_PER_MIN)})`,
    );
  }
  if (!Number.isFinite(config.rateLimit.writeBurst) || config.rateLimit.writeBurst < 1) {
    throw new ServerConfigError(
      `PLAYTEST_RATE_LIMIT_WRITE_BURST must be a number >= 1 ` +
        `(got ${JSON.stringify(env.PLAYTEST_RATE_LIMIT_WRITE_BURST)})`,
    );
  }
  if (!Number.isFinite(config.reconcile.intervalMs) || config.reconcile.intervalMs < 0) {
    throw new ServerConfigError(
      `PLAYTEST_RECONCILE_INTERVAL_S must be a number of seconds >= 0 ` +
        `(got ${JSON.stringify(env.PLAYTEST_RECONCILE_INTERVAL_S)})`,
    );
  }

  for (const [name, value, min, max] of [
    ["PLAYTEST_CONSOLIDATION_K", config.consolidation.k, 1, 50],
    ["PLAYTEST_CONSOLIDATION_FLOOR", config.consolidation.floor, 0, 1],
    ["PLAYTEST_CONSOLIDATION_AUTO_SUGGEST", config.consolidation.autoSuggest, 0, 1],
    ["PLAYTEST_CONSOLIDATION_MAX_CLUSTER_ITEMS", config.consolidation.maxClusterItems, 2, 100],
    ["PLAYTEST_CONSOLIDATION_MAX_PROMPT_BYTES", config.consolidation.maxPromptBytes, 1000, 1_000_000],
    ["PLAYTEST_CONSOLIDATION_MAX_CLUSTERS", config.consolidation.maxClusters, 1, 500],
  ] as Array<[string, number, number, number]>) {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new ServerConfigError(
        `${name} must be a number between ${min} and ${max} (got ${JSON.stringify(env[name])})`,
      );
    }
  }
  if (env.PLAYTEST_AUTO_DEDUPE != null && !["on", "off"].includes(env.PLAYTEST_AUTO_DEDUPE)) {
    throw new ServerConfigError(
      `PLAYTEST_AUTO_DEDUPE must be "on" or "off" (got ${JSON.stringify(env.PLAYTEST_AUTO_DEDUPE)})`,
    );
  }
  if (!Number.isFinite(config.autoDedupe.debounceMs) || config.autoDedupe.debounceMs < 0) {
    throw new ServerConfigError(
      `PLAYTEST_AUTO_DEDUPE_DEBOUNCE_S must be a number of seconds >= 0 ` +
        `(got ${JSON.stringify(env.PLAYTEST_AUTO_DEDUPE_DEBOUNCE_S)})`,
    );
  }
  if (env.PLAYTEST_AUTO_RESOLVE != null && !["on", "off"].includes(env.PLAYTEST_AUTO_RESOLVE)) {
    throw new ServerConfigError(
      `PLAYTEST_AUTO_RESOLVE must be "on" or "off" (got ${JSON.stringify(env.PLAYTEST_AUTO_RESOLVE)})`,
    );
  }
  if (!["semi", "full"].includes(config.autoResolve.mode)) {
    throw new ServerConfigError(
      `PLAYTEST_AUTO_RESOLVE_MODE must be "semi" (verified fixes suggest, a person confirms) or ` +
        `"full" (verified fixes resolve) (got ${JSON.stringify(env.PLAYTEST_AUTO_RESOLVE_MODE)})`,
    );
  }
  if (!Number.isFinite(config.autoResolve.debounceMs) || config.autoResolve.debounceMs < 0) {
    throw new ServerConfigError(
      `PLAYTEST_AUTO_RESOLVE_DEBOUNCE_S must be a number of seconds >= 0 ` +
        `(got ${JSON.stringify(env.PLAYTEST_AUTO_RESOLVE_DEBOUNCE_S)})`,
    );
  }
  if (!Number.isFinite(config.autoResolve.pinDays) || config.autoResolve.pinDays < 0) {
    throw new ServerConfigError(
      `PLAYTEST_AUTO_RESOLVE_PIN_DAYS must be a number of days >= 0 ` +
        `(got ${JSON.stringify(env.PLAYTEST_AUTO_RESOLVE_PIN_DAYS)})`,
    );
  }
  if (config.consolidation.autoSuggest < config.consolidation.floor) {
    throw new ServerConfigError(
      `PLAYTEST_CONSOLIDATION_AUTO_SUGGEST (${config.consolidation.autoSuggest}) must be at least ` +
        `PLAYTEST_CONSOLIDATION_FLOOR (${config.consolidation.floor}): a candidate cannot auto-suggest ` +
        `at a score that never reaches the shortlist`,
    );
  }

  if (config.dispatch.local && authMode !== "dev") {
    throw new ServerConfigError(
      `PLAYTEST_DISPATCH=local is a development mode and needs PLAYTEST_AUTH=dev; ` +
        `production placement uses GitHub dispatch (GITHUB_APP_ID et al.)`,
    );
  }

  if (authMode === "oidc") {
    const missing = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"].filter((k) => !env[k]);
    if (missing.length) {
      throw new ServerConfigError(
        `OIDC login needs ${missing.join(", ")} (or set PLAYTEST_AUTH=dev for a local ` +
          `single-user bypass — never in production)`,
      );
    }
    config.auth.oidc = {
      issuer: env.OIDC_ISSUER!.replace(/\/$/, ""), // TODO(ts): The missing-variable guard above narrows this dynamic env value.
      clientId: env.OIDC_CLIENT_ID!, // TODO(ts): The missing-variable guard above narrows this dynamic env value.
      clientSecret: env.OIDC_CLIENT_SECRET!, // TODO(ts): The missing-variable guard above narrows this dynamic env value.
      redirectUri: env.OIDC_REDIRECT_URI || `${config.publicUrl}/auth/callback`,
      scope: env.OIDC_SCOPE || "openid email profile",
    };
  } else {
    config.auth.devUser = {
      subject: env.PLAYTEST_DEV_SUBJECT || "dev-admin",
      email: env.PLAYTEST_DEV_EMAIL || "dev@localhost",
      name: env.PLAYTEST_DEV_NAME || "Dev Admin",
    };
  }

  return config;
}

export type ControlPlaneConfig = ReturnType<typeof loadConfig>;
