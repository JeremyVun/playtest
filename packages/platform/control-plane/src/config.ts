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
 * grader defaults to (`packages/core/src/llm.ts`), so hosted drafting and synthesis cost
 * and behave like grading unless an operator deliberately pins one of them.
 */
const GRADER_TIER_MODEL = "sonnet";

/** Placement adapters (`PLAYTEST_DISPATCH`); unset means GitHub workflow dispatch. */
const DISPATCH_MODES = ["github", "local", "pool"];

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
  } catch (e: any /* SAFETY: Retention validation attaches structured details to Error. */) {
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

  // Placement: which adapter starts (or, for the pool, does not start) runners.
  // An unrecognized value is a boot error rather than a silent fall back to
  // GitHub dispatch, which would look like "my runners never get work".
  const dispatchMode = env.PLAYTEST_DISPATCH || "github";
  if (!DISPATCH_MODES.includes(dispatchMode)) {
    throw new ServerConfigError(
      `PLAYTEST_DISPATCH must be one of ${DISPATCH_MODES.join(", ")} ` +
        `(got ${JSON.stringify(env.PLAYTEST_DISPATCH)}); leave it unset for GitHub workflow dispatch`,
    );
  }

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
    // Upload ceilings that are a DEPLOYMENT decision rather than a protocol
    // constant. The suite-file (4 MiB) and suite-import (64 MiB) caps in
    // http.ts stay fixed, because a suite is text; an environment's app
    // artifact is a real build and needs its own, much larger, operator-set
    // ceiling. Exceeding it is an actionable 413 naming this variable, never a
    // truncated blob.
    uploads: {
      appArtifactMaxBytes: num(env.PLAYTEST_APP_ARTIFACT_MAX_MB, 512) * 1024 * 1024,
    },
    // Open-run live staging (docs/contracts/hosted.md, "Live runs"). The per-run
    // budget bounds transient serving state a run holds before it seals; the
    // sealed bundle limit is its ceiling, because staging can never be allowed
    // to cost more than the bundle it precedes. Exhausting it is an explicit
    // refusal ack the uploader acts on — the recording never notices.
    live: {
      runBudgetBytes: num(env.PLAYTEST_LIVE_BUDGET_MB, 512) * 1024 * 1024,
    },
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
      // Pool placement never rides it: a pooled runner is off-premises by
      // definition, so it always presents its own registration credential and
      // the insecure exchange is forced off below whatever the auth mode.
      allowInsecureRunnerExchange:
        dispatchMode !== "pool" && (env.PLAYTEST_RUNNER_INSECURE_EXCHANGE === "1" || authMode === "dev"),
      // PLAYTEST_DISPATCH=local runs launches through the in-process
      // LocalDispatchClient (spawns the real runner-agent on this machine)
      // instead of GitHub. Dev auth only: its exchange rides the insecure
      // runner exchange, which production must never enable.
      local: dispatchMode === "local",
      // PLAYTEST_DISPATCH=pool places runs on self-hosted runners that claim
      // work outbound (docs/contracts/hosted.md, "Runner pool"). The control
      // plane starts nothing and connects to nothing.
      pool: {
        enabled: dispatchMode === "pool",
        // How long a job may sit unclaimed on the board before the group fails
        // with an error naming the labels nothing checked in to serve.
        claimTimeoutMs: num(env.PLAYTEST_POOL_CLAIM_TIMEOUT_S, 600) * 1000,
        // How long a claimed job may go without a heartbeat before its runner
        // counts as gone (the reconciler's existing dead-executor path).
        heartbeatTimeoutMs: num(env.PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S, 120) * 1000,
        // Ephemeral CI registration (`POST /runner/pool/register-oidc`): a CI
        // job presents its GitHub OIDC token instead of a long-lived credential
        // and gets a runner that expires with the job. The pins are the SAME
        // discipline the GitHub-dispatch exchange applies, but they are their
        // own variables, because the repository whose pipelines register runners
        // is not necessarily the repository a deployment dispatches workflows
        // into — and because a pool deployment configures no GITHUB_APP_* at
        // all, so inheriting a null repository pin would accept a token from
        // ANY repository on GitHub. The route refuses to serve without
        // `repository` for exactly that reason (validated below, reported as
        // `503 not_configured` at the route).
        //
        // Key names match `dispatch.github` so both callers hand the same shape
        // to the one verifier (auth/github-oidc.ts).
        oidc: {
          repository: env.PLAYTEST_POOL_OIDC_REPOSITORY || null,
          // Unset means "any workflow in the pinned repository". Pinning it
          // narrows registration to one workflow file, which is what a
          // repository with untrusted-fork or unrelated pipelines wants.
          workflowId: env.PLAYTEST_POOL_OIDC_WORKFLOW || null,
          ref: env.PLAYTEST_POOL_OIDC_REF || null,
          oidcAudience: env.PLAYTEST_POOL_OIDC_AUDIENCE || env.GITHUB_OIDC_AUDIENCE || "playtest",
          oidcIssuer: env.GITHUB_OIDC_ISSUER || "https://token.actions.githubusercontent.com",
          // How long an ephemeral credential stays usable. It only has to
          // outlive the pipeline's own run group, and GitHub caps a job at six
          // hours, so an hour is a generous default and six hours is the
          // ceiling: a credential that outlives its job is a credential nobody
          // is watching. Expiry never interrupts work in flight — the run group
          // already holds its own short-lived scoped bearer.
          ttlMs: num(env.PLAYTEST_POOL_OIDC_TTL_S, 3600) * 1000,
        },
      },
    },
    auth: { mode: authMode } as {
      mode: "dev" | "oidc";
      oidc?: { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scope: string };
      devUser?: { subject: string; email: string; name: string };
    }, // SAFETY: The validated auth mode determines which optional branch is populated below.
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
  // A whole build is buffered in memory to hash it, so the ceiling is bounded at
  // both ends: below 1 MiB no real binary fits, and above 4 GiB the buffer is
  // past what a Node Buffer and this deployment's memory can honestly promise.
  const appArtifactMb = config.uploads.appArtifactMaxBytes / (1024 * 1024);
  if (!Number.isInteger(appArtifactMb) || appArtifactMb < 1 || appArtifactMb > 4096) {
    throw new ServerConfigError(
      `PLAYTEST_APP_ARTIFACT_MAX_MB must be a whole number of megabytes between 1 and 4096 ` +
        `(got ${JSON.stringify(env.PLAYTEST_APP_ARTIFACT_MAX_MB)}); leave it unset for 512`,
    );
  }
  const liveBudgetMb = config.live.runBudgetBytes / (1024 * 1024);
  if (!Number.isInteger(liveBudgetMb) || liveBudgetMb < 1 || liveBudgetMb > 512) {
    throw new ServerConfigError(
      `PLAYTEST_LIVE_BUDGET_MB must be a whole number of megabytes between 1 and 512 — the sealed bundle ` +
        `limit is its ceiling (got ${JSON.stringify(env.PLAYTEST_LIVE_BUDGET_MB)}); leave it unset for 512`,
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

  // The pool's whole security model is that placement grants nothing and the
  // exchange authorizes: a runner presents its registration credential bound to
  // a dispatch it actually claimed. The insecure exchange would let anyone who
  // learns a run-group id skip the board entirely and collect a scoped bearer,
  // so the two must never be enabled together. Dev auth stays usable with the
  // pool — it silently drops the insecure exchange rather than the placement —
  // but asking for it out loud is a boot error, not a silently ignored variable.
  if (config.dispatch.pool.enabled && env.PLAYTEST_RUNNER_INSECURE_EXCHANGE === "1") {
    throw new ServerConfigError(
      `PLAYTEST_DISPATCH=pool cannot run with PLAYTEST_RUNNER_INSECURE_EXCHANGE=1: pooled runners always ` +
        `present their registration credential, and the insecure exchange would let an unauthenticated ` +
        `caller take a run group's scoped token. Unset PLAYTEST_RUNNER_INSECURE_EXCHANGE, or use ` +
        `PLAYTEST_DISPATCH=local for a single-machine development loop.`,
    );
  }
  // Ephemeral CI registration is opt-in, but a HALF-configured opt-in is the
  // dangerous state: a workflow or ref pin without a repository pin would accept
  // that workflow name from any repository on GitHub, and pins set on a
  // deployment that does not run pool placement do nothing at all while looking
  // like they do. Both are boot errors rather than a surprise at 3 a.m.
  const poolOidc = config.dispatch.pool.oidc;
  const poolOidcVars = [
    ["PLAYTEST_POOL_OIDC_REPOSITORY", env.PLAYTEST_POOL_OIDC_REPOSITORY],
    ["PLAYTEST_POOL_OIDC_WORKFLOW", env.PLAYTEST_POOL_OIDC_WORKFLOW],
    ["PLAYTEST_POOL_OIDC_REF", env.PLAYTEST_POOL_OIDC_REF],
    ["PLAYTEST_POOL_OIDC_AUDIENCE", env.PLAYTEST_POOL_OIDC_AUDIENCE],
    ["PLAYTEST_POOL_OIDC_TTL_S", env.PLAYTEST_POOL_OIDC_TTL_S],
  ].filter(([, value]) => value);
  if (poolOidcVars.length && !config.dispatch.pool.enabled) {
    throw new ServerConfigError(
      `${poolOidcVars.map(([name]) => name).join(", ")} configure ephemeral CI runner registration, which ` +
        `only exists under PLAYTEST_DISPATCH=pool (this deployment dispatches with "${dispatchMode}"). ` +
        `Set PLAYTEST_DISPATCH=pool, or unset these variables.`,
    );
  }
  if ((poolOidc.workflowId || poolOidc.ref) && !poolOidc.repository) {
    throw new ServerConfigError(
      `PLAYTEST_POOL_OIDC_${poolOidc.workflowId ? "WORKFLOW" : "REF"} needs PLAYTEST_POOL_OIDC_REPOSITORY too: ` +
        `a workflow or ref pin without a repository pin would accept that workflow name from any repository ` +
        `on GitHub. Name the repository whose pipelines may register runners, e.g. acme/storefront.`,
    );
  }
  const MAX_OIDC_TTL_MS = 6 * 60 * 60 * 1000; // GitHub's own per-job ceiling.
  if (!Number.isFinite(poolOidc.ttlMs) || poolOidc.ttlMs < 60_000 || poolOidc.ttlMs > MAX_OIDC_TTL_MS) {
    throw new ServerConfigError(
      `PLAYTEST_POOL_OIDC_TTL_S must be between 60 and ${MAX_OIDC_TTL_MS / 1000} seconds — an ephemeral ` +
        `credential only has to outlive its own CI job, and GitHub caps a job at six hours ` +
        `(got ${JSON.stringify(env.PLAYTEST_POOL_OIDC_TTL_S)})`,
    );
  }
  for (const [name, ms, minS] of [
    ["PLAYTEST_POOL_CLAIM_TIMEOUT_S", config.dispatch.pool.claimTimeoutMs, 1],
    ["PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S", config.dispatch.pool.heartbeatTimeoutMs, 1],
  ] as Array<[string, number, number]>) {
    // 0 is allowed only for tests that want an immediately-expired window; a
    // negative or non-numeric value is always a misconfiguration.
    if (!Number.isFinite(ms) || ms < 0) {
      throw new ServerConfigError(
        `${name} must be a number of seconds >= 0 (${minS} or more in a real deployment) ` +
          `(got ${JSON.stringify(env[name])})`,
      );
    }
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
      issuer: env.OIDC_ISSUER!.replace(/\/$/, ""), // SAFETY: The missing-variable guard above narrows this dynamic env value.
      clientId: env.OIDC_CLIENT_ID!, // SAFETY: The missing-variable guard above narrows this dynamic env value.
      clientSecret: env.OIDC_CLIENT_SECRET!, // SAFETY: The missing-variable guard above narrows this dynamic env value.
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
