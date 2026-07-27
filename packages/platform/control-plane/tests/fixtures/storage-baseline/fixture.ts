// S0 storage baseline fixture — a database-neutral seed for the whole post-0009
// control-plane schema (docs/backlog/storage/S0-INVENTORY.md).
//
// Nothing here imports `pg`, `node:sqlite`, or any driver. Every value is plain
// JS: strings, numbers, booleans, `null`, POJOs/arrays for JSON columns, and
// `{ $base64 }` envelopes for byte columns. `COLUMN_TYPES` declares the neutral
// type of every column so a phase-specific loader can bind each value the way
// its database wants (Postgres `timestamptz` + `jsonb` + `bytea`, or SQLite
// INTEGER epoch-ms + canonical-JSON TEXT + BLOB).
//
// The companion `expected-projections.json` freezes the observable consequences
// of this data — row counts, relationship shapes, canonical JSON strings,
// timestamp epochs, and object hashes — so S1/S4 can prove SQLite reproduces
// them byte for byte. Regenerate it with `node build-expectations.mjs` and
// review the diff; `tests/unit/storage-fixture.test.ts` guards it.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------- primitives

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, ULID alphabet

function encodeTime(ms: HostedDynamic, len = 10) {
  let out = "";
  let n = ms;
  for (let i = 0; i < len; i += 1) {
    out = B32[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeSeed(seed: HostedDynamic, len = 16) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += B32[h % 32];
    h = Math.imul(h ^ (h >>> 13), 16777619) >>> 0;
  }
  return out;
}

/**
 * A deterministic, lexicographically time-ordered ULID. Same shape and ordering
 * guarantees as `src/ulid.ts` (feed cursors and audit keyset pagination both
 * depend on `id > $cursor` ordering by time), but reproducible from the fixture.
 */
export function fid(iso: HostedDynamic, seed: HostedDynamic) {
  return encodeTime(Date.parse(iso)) + encodeSeed(seed);
}

/** Canonical JSON: object keys sorted recursively, no insignificant whitespace. */
export function canonicalJson(value: HostedDynamic): HostedDynamic {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export const sha256Hex = (data: HostedDynamic) =>
  createHash("sha256").update(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8")).digest("hex");

export const bytes = (base64: HostedDynamic) => ({ $base64: base64 });

/** Materialize a `{ $base64 }` envelope. Loaders call this; the fixture data does not. */
export const toBuffer: HostedDynamic = (value: HostedDynamic) => (value == null ? null : Buffer.from(value.$base64, "base64"));

// -------------------------------------------------------------------- clock

const T = {
  accountsCreated: "2026-06-01T09:00:00.000Z",
  suiteCreated: "2026-06-01T10:00:00.000Z",
  snapshot1: "2026-06-02T08:00:00.000Z",
  snapshot2: "2026-06-03T08:00:00.000Z",
  group1: "2026-06-03T09:00:00.000Z",
  run1Start: "2026-06-03T09:00:30.000Z",
  run1End: "2026-06-03T09:02:10.000Z",
  run2Start: "2026-06-03T09:02:15.000Z",
  run2End: "2026-06-03T09:04:05.000Z",
  run3Start: "2026-06-03T09:04:10.000Z",
  run3End: "2026-06-03T09:05:40.000Z",
  triage: "2026-06-04T11:00:00.000Z",
  retention: "2026-06-10T03:00:00.000Z",
  group2: "2026-06-11T12:00:00.000Z",
  now: "2026-06-11T12:05:00.000Z",
  sessionExpiry: "2026-06-18T12:00:00.000Z",
  sessionExpired: "2026-06-02T12:00:00.000Z",
  tokenExpiry: "2026-12-31T00:00:00.000Z",
  mintExpiry: "2026-06-11T13:00:00.000Z",
  claimExpiry: "2026-06-11T12:10:00.000Z",
};

// ---------------------------------------------------------------------- ids

export const IDS: HostedDynamic = {
  userAdmin: fid(T.accountsCreated, "user:ada"),
  userReviewer: fid(T.accountsCreated, "user:rex"),
  userDisabled: fid(T.accountsCreated, "user:dana"),

  projectMain: fid(T.accountsCreated, "project:acme-web"),
  projectArchived: fid(T.accountsCreated, "project:legacy"),

  sessionLive: fid(T.now, "session:live"),
  sessionExpired: fid(T.snapshot1, "session:expired"),

  tokenProject: fid(T.suiteCreated, "token:ci"),
  tokenSite: fid(T.suiteCreated, "token:site"),

  suiteCheckout: fid(T.suiteCreated, "suite:checkout"),
  suiteArchived: fid(T.suiteCreated, "suite:admin"),

  snapshot1: fid(T.snapshot1, "snapshot:1"),
  snapshot2: fid(T.snapshot2, "snapshot:2"),
  snapshotArchived: fid(T.snapshot1, "snapshot:admin"),

  envStaging: fid(T.suiteCreated, "env:staging"),
  envProd: fid(T.suiteCreated, "env:prod"),
  envSuitePreview: fid(T.suiteCreated, "env:preview"),

  personaGrumpy: fid(T.suiteCreated, "persona:grumpy-shopper"),

  ruleCardApproved: fid(T.suiteCreated, "rule-card:checkout-total"),
  ruleCardCandidate: fid(T.suiteCreated, "rule-card:cart-merge"),
  ruleCardDenied: fid(T.suiteCreated, "rule-card:carts-expire"),

  secretApiToken: fid(T.suiteCreated, "secret:api"),
  secretDbPassword: fid(T.suiteCreated, "secret:db"),

  providerToken: fid(T.suiteCreated, "provider:token"),
  providerScript: fid(T.suiteCreated, "provider:script"),
  sessionArtifact: fid(T.group2, "session-artifact:shopper"),
  sessionClaim: fid(T.group2, "session-claim:script"),

  group1: fid(T.group1, "group:1"),
  group2: fid(T.group2, "group:2"),

  executorGroup: fid(T.group1, "executor:group"),
  executorMedia: fid(T.triage, "executor:media"),
  executorMint: fid(T.group2, "executor:mint"),

  run1: fid(T.group1, "run:checkout-pass"),
  run2: fid(T.group1, "run:refund-fail"),
  run3: fid(T.group1, "run:checkout-healed"),
  run4: fid(T.group2, "run:explore"),
  run5: fid(T.group2, "run:queued"),

  dispatchGroup1: fid(T.group1, "dispatch:group1"),
  dispatchMedia: fid(T.triage, "dispatch:media"),
  dispatchMint: fid(T.group2, "dispatch:mint"),

  artifactBundleFull: fid(T.run1End, "artifact:run1-bundle"),
  artifactIndex: fid(T.run1End, "artifact:run1-index"),
  artifactClip: fid(T.triage, "artifact:run1-clip"),
  artifactClipVtt: fid(T.triage, "artifact:run1-clip-vtt"),
  artifactBundleCore: fid(T.retention, "artifact:run2-core-bundle"),

  baselineV1: fid(T.snapshot1, "baseline:checkout-v1"),
  baselineV2: fid(T.run1End, "baseline:checkout-v2"),
  candidatePending: fid(T.run3End, "candidate:pending"),
  candidateAccepted: fid(T.run1End, "candidate:accepted"),

  finding1: fid(T.run2End, "finding:refund-total"),
  finding2: fid(T.run2End, "finding:slow-checkout"),
  finding3Merged: fid(T.triage, "finding:duplicate"),
  evidence1: fid(T.run2End, "evidence:refund-1"),
  evidence2: fid(T.triage, "evidence:refund-2"),
  evidence3: fid(T.run1End, "evidence:slow-1"),

  // Machine-filed findings: `new` is unreviewed intake, `rejected` is the
  // standing rejection that absorbs its own exact recurrences.
  finding4New: fid(T.run2End, "finding:refund-total-claim"),
  finding5Rejected: fid(T.triage, "finding:intended-404"),
  evidence4: fid(T.run2End, "evidence:refund-claim-1"),
  evidence5: fid(T.run2End, "evidence:refund-claim-2"),
  intakeKeyRefund: fid(T.run2End, "intake-key:refund-total"),

  consolidationPlanApplied: fid(T.triage, "consolidation-plan:applied"),
  consolidationPlanProposed: fid(T.group2, "consolidation-plan:proposed"),
  consolidationLabelConfirmed: fid(T.triage, "consolidation-label:confirmed"),
  consolidationLabelRejected: fid(T.triage, "consolidation-label:rejected"),

  event1: fid(T.run1End, "event:run-status-pass"),
  event2: fid(T.run2End, "event:run-event"),
  event3: fid(T.run2End, "event:finding-created"),
  event4: fid(T.triage, "event:candidate-superseded"),
  event5: fid(T.group2, "event:dispatch-dead"),

  audit1: fid(T.snapshot2, "audit:suite-committed"),
  audit2: fid(T.suiteCreated, "audit:secret-created"),
  audit3: fid(T.triage, "audit:finding-accepted"),
  audit4: fid(T.group2, "audit:session-minted"),
  audit5: fid(T.group2, "audit:site-token-created"),
};

// ------------------------------------------------------------ suite content

// Live suite-file bytes. Every distinct byte string is one content-addressed
// blob at `blobs/<sha256>`; a snapshot `tree` maps path -> sha256.
const CHECKOUT_V1 = [
  "id: checkout",
  "story: A shopper completes checkout with a saved card.",
  "gates:",
  "  - order confirmation is shown",
  "",
].join("\n");

const CHECKOUT_V2 = [
  "id: checkout",
  "story: A shopper completes checkout with a saved card and sees the order total.",
  "gates:",
  "  - order confirmation is shown",
  "  - the order total matches the cart total",
  "",
].join("\n");

const SUITE_FILE_CONTENT = {
  "playtest.yaml": ["app:", "  base_url: https://staging.acme.test", "model: sonnet", ""].join("\n"),
  "stories/checkout.yaml": CHECKOUT_V2,
  "stories/refund.yaml": [
    "id: refund",
    "story: A shopper refunds a delivered order and the balance returns.",
    "gates:",
    "  - the refund total equals the order total",
    "",
  ].join("\n"),
  "personas/shopper.yaml": ["id: shopper", "traits:", "  - patient", "  - reads labels", ""].join("\n"),
  "hooks/reset.mjs": ["export default async function reset() {", "  // fixture hook", "}", ""].join("\n"),
};

const ARCHIVED_SUITE_FILE_CONTENT = {
  "assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>\n',
};

// A project-scoped persona (personas table) is a project-level object, distinct
// from a suite-committed `personas/*.yaml` file (suite_files above): its
// rendered YAML is still a content-addressed blob, but keyed off the persona
// row rather than a suite snapshot tree.
const PERSONA_GRUMPY_YAML = [
  "name: Grumpy Shopper",
  "description: An impatient shopper who complains about slow pages and abandons carts easily.",
  "",
].join("\n");

const treeOf = (files: HostedDynamic) =>
  Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha256Hex(c)]));

const TREE_SNAPSHOT_2 = treeOf(SUITE_FILE_CONTENT);
const TREE_SNAPSHOT_1 = { ...TREE_SNAPSHOT_2, "stories/checkout.yaml": sha256Hex(CHECKOUT_V1) };
const TREE_ARCHIVED = treeOf(ARCHIVED_SUITE_FILE_CONTENT);

// -------------------------------------------------------------- run bundles

// Object payloads are opaque to the metadata layer: SQLite/Postgres store only
// key/sha256/size/tier. These deterministic strings stand in for real `.ptrun`
// tar bytes so hashes and sizes are reproducible without a bundle writer.
const BUNDLE_FULL = `playtest-fixture-bundle:${IDS.run1}:full:${"x".repeat(512)}\n`;
const BUNDLE_INDEX = canonicalJson({
  version: 1,
  entries: { "manifest.json": { offset: 512, size: 384 }, "trajectory.jsonl": { offset: 1024, size: 2048 } },
});
const CLIP_MP4 = `playtest-fixture-clip:${IDS.run1}:${"m".repeat(256)}\n`;
const CLIP_VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nopen the cart\n";
const BUNDLE_CORE = `playtest-fixture-bundle:${IDS.run2}:core:${"y".repeat(192)}\n`;

const KEY = {
  bundleFull: `runs/${IDS.group1}/${IDS.run1}.ptrun`,
  bundleIndex: `runs/${IDS.group1}/${IDS.run1}.ptrun.idx.json`,
  clip: `runs/${IDS.group1}/${IDS.run1}.clip.mp4`,
  clipVtt: `runs/${IDS.group1}/${IDS.run1}.clip.vtt`,
  bundleCore: `runs/${IDS.group1}/${IDS.run2}.core.ptrun`,
};

/**
 * Object-store contents referenced by the metadata rows. `key` is the store key,
 * `text` the exact UTF-8 bytes. Tier semantics live on the artifact row, not here.
 */
export const OBJECTS: HostedDynamic = [
  ...Object.entries(SUITE_FILE_CONTENT).map(([path, text]) => ({
    key: `blobs/${sha256Hex(text)}`,
    text,
    role: "suite-blob",
    note: `snapshot 2 — ${path}`,
  })),
  { key: `blobs/${sha256Hex(CHECKOUT_V1)}`, text: CHECKOUT_V1, role: "suite-blob", note: "snapshot 1 — stories/checkout.yaml" },
  ...Object.entries(ARCHIVED_SUITE_FILE_CONTENT).map(([path, text]) => ({
    key: `blobs/${sha256Hex(text)}`,
    text,
    role: "suite-blob",
    note: `archived suite — ${path}`,
  })),
  { key: KEY.bundleFull, text: BUNDLE_FULL, role: "run-bundle", note: "tier full" },
  { key: KEY.bundleIndex, text: BUNDLE_INDEX, role: "run-index", note: "rebuildable sidecar" },
  { key: KEY.clip, text: CLIP_MP4, role: "run-clip", note: "on-demand media" },
  { key: KEY.clipVtt, text: CLIP_VTT, role: "run-clip-vtt", note: "on-demand media" },
  { key: KEY.bundleCore, text: BUNDLE_CORE, role: "run-bundle", note: "tier core (retention rewrite)" },
  {
    key: `runs/${IDS.group2}/orphan-${IDS.run5}.ptrun`,
    text: "playtest-fixture-orphan\n",
    role: "orphan",
    note: "referenced by no artifact row — the grace-period sweep target",
  },
];

const OBJECT_BY_KEY: HostedDynamic = new Map(OBJECTS.map((o: HostedDynamic) => [o.key, o]));
const objSize = (key: HostedDynamic) => Buffer.byteLength(OBJECT_BY_KEY.get(key).text, "utf8");
const objSha = (key: HostedDynamic) => sha256Hex(OBJECT_BY_KEY.get(key).text);

// ------------------------------------------------------------- neutral types

/**
 * Neutral column types. `ts` values are ISO-8601 UTC strings with millisecond
 * precision; `json` values are POJOs/arrays; `bytes` values are `{ $base64 }`;
 * `text[]` values are arrays of strings. Everything else is a JS primitive.
 */
export const COLUMN_TYPES: HostedDynamic = {
  schema_migrations: { filename: "text", applied_at: "ts" },
  users: { id: "text", subject: "text", email: "text", name: "text", disabled: "bool", created_at: "ts", updated_at: "ts" },
  projects: { id: "text", key: "text", name: "text", archived: "bool", created_at: "ts", updated_at: "ts" },
  memberships: { user_id: "text", project_id: "text", role: "text", created_at: "ts", updated_at: "ts" },
  sessions: { id: "text", user_id: "text", expires_at: "ts", created_at: "ts" },
  api_tokens: { id: "text", project_id: "text", role: "text", name: "text", token_hash: "text", expires_at: "ts", created_at: "ts" },
  suites: { id: "text", project_id: "text", slug: "text", name: "text", archived: "bool", created_at: "ts", updated_at: "ts" },
  suite_files: {
    id: "text", suite_id: "text", path: "text", kind: "text", content: "text",
    updated_by: "text", created_at: "ts", updated_at: "ts",
  },
  suite_snapshots: { id: "text", suite_id: "text", seq: "int", tree: "json", created_by: "text", note: "text", created_at: "ts" },
  environments: {
    id: "text", project_id: "text", suite_id: "text", name: "text", config: "json", discovery_allowed: "bool",
    runner_labels: "text[]", created_at: "ts", updated_at: "ts",
  },
  personas: {
    id: "text", project_id: "text", slug: "text", name: "text", description: "text",
    blob_sha256: "text", created_by: "text", created_at: "ts", updated_at: "ts",
  },
  rule_cards: {
    id: "text", project_id: "text", suite_id: "text", rule_id: "text", state: "text", origin: "text",
    title: "text", statement: "text", applicability: "text", exceptions: "text", provenance: "text",
    note: "text", proposed_statement: "text", prompt_version: "text", decided_by: "text",
    decided_at: "ts", created_at: "ts", updated_at: "ts",
  },
  secrets: { id: "text", project_id: "text", name: "text", ciphertext: "bytes", created_by: "text", created_at: "ts", updated_at: "ts" },
  audit_log: {
    id: "text", ts: "ts", project_id: "text", actor: "json", action: "text",
    entity_type: "text", entity_id: "text", detail: "json",
  },
  auth_providers: {
    id: "text", project_id: "text", environment_id: "text", name: "text", kind: "text", config: "json",
    code: "text", identities: "json", ttl_minutes: "int", enabled: "bool", updated_by: "text",
    created_at: "ts", updated_at: "ts",
  },
  session_artifacts: {
    id: "text", provider_id: "text", identity: "text", ciphertext: "bytes", minted_at: "ts",
    expires_at: "ts", minted_by_job: "text", created_at: "ts",
  },
  session_claims: { id: "text", provider_id: "text", identity: "text", executor_id: "text", status: "text", created_at: "ts", expires_at: "ts" },
  run_groups: {
    id: "text", project_id: "text", suite_id: "text", snapshot_id: "text", environment_id: "text",
    trigger: "json", selection: "json", status: "text", exit_summary: "json", created_at: "ts", updated_at: "ts",
  },
  executors: {
    id: "text", run_group_id: "text", kind: "text", workflow_run_url: "text", versions: "json",
    isolation: "text", registered_at: "ts", last_report_at: "ts", concluded_at: "ts", created_at: "ts",
  },
  runs: {
    id: "text", run_group_id: "text", case_id: "text", story_id: "text", run_id: "text", status: "text",
    mode: "text", healed: "bool", changed: "bool", manifest: "json", totals: "json", score: "int",
    gate: "json", pins: "json", duration_ms: "int", started_at: "ts", finished_at: "ts", baseline_id: "text",
    executor_id: "text", error: "text", created_at: "ts", updated_at: "ts", artifact_tier: "text",
    retention_pruned_at: "ts", retention_provenance: "json",
  },
  dispatches: {
    id: "text", project_id: "text", kind: "text", ref_id: "text", attempt: "int", workflow_run_id: "text",
    workflow_run_url: "text", executor_id: "text", status: "text", requested_at: "ts", concluded_at: "ts",
    error: "text", created_at: "ts",
  },
  run_events: { run_id: "text", seq: "int", ts: "ts", type: "text", payload: "json" },
  artifacts: {
    id: "text", run_id: "text", kind: "text", key: "text", sha256: "text", size: "bigint",
    tier: "text", verified_at: "ts", created_at: "ts",
  },
  baselines: {
    id: "text", project_id: "text", suite_id: "text", story_id: "text", version: "int", trajectory_key: "text",
    meta: "json", accepted_by: "text", accepted_from_run_id: "text", superseded_by: "text",
    created_at: "ts", updated_at: "ts",
  },
  candidates: {
    id: "text", project_id: "text", suite_id: "text", story_id: "text", run_id: "text", trajectory_key: "text",
    meta: "json", status: "text", resolved_by: "text", resolved_at: "ts", created_at: "ts", updated_at: "ts",
    diff_summary: "json",
  },
  platform_events: { id: "text", project_id: "text", type: "text", entity: "json", payload: "json", ts: "ts" },
  findings: {
    id: "text", project_id: "text", fingerprint: "text", title: "text", summary: "json", severity: "text",
    state: "text", reject_reason: "text", external_ref: "text", merged_into: "text", first_seen: "ts",
    last_seen: "ts", evidence_count: "int",
    category: "text", source: "text", signal_type: "text", locus: "json", normalized_locus: "text",
    strict_key: "text", loose_key: "text", key_algo_version: "text", locus_norm_version: "text",
    match_text: "text", match_text_version: "text", suggested_finding_id: "text", suggestion_kind: "text",
    recurrence_count: "int", first_run_id: "text",
    created_at: "ts", updated_at: "ts",
  },
  finding_evidence: {
    id: "text", finding_id: "text", run_id: "text", case_id: "text", step_from: "int", step_to: "int",
    excerpt: "text", created_at: "ts",
  },
  finding_intake_keys: {
    id: "text", project_id: "text", intake_key: "text", finding_id: "text", created_at: "ts",
  },
  finding_resolution_stamps: {
    finding_id: "text", suite_id: "text", environment_id: "text", case_id: "text",
    run_id: "text", method: "text", stamped_at: "ts",
  },
  consolidation_plans: {
    id: "text", project_id: "text", status: "text", thresholds: "json",
    shortlist_version: "text", match_text_version: "text", plan: "json", scope: "json",
    usage: "json", prompt_version: "text", model: "text", candidate_digest: "text",
    created_by: "json", applied_by: "json", created_at: "ts", applied_at: "ts", updated_at: "ts",
  },
  consolidation_labels: {
    id: "text", project_id: "text", plan_id: "text", subject_finding_id: "text", finding_id: "text",
    origin: "text", score: "float", confidence: "text", decision: "text", detail: "json",
    actor: "json", created_at: "ts",
  },
  service_heartbeats: { name: "text", beat_at: "ts", detail: "json" },
};

/**
 * Insert order. Parents precede children so a loader can seed with foreign keys
 * enforced. `baselines.superseded_by` and `runs.baseline_id` are intentionally
 * unconstrained columns in the schema, so no second pass is needed.
 */
export const TABLE_ORDER: HostedDynamic = [
  "schema_migrations",
  "users",
  "projects",
  "memberships",
  "sessions",
  "api_tokens",
  "suites",
  "suite_files",
  "suite_snapshots",
  "environments",
  "personas",
  "rule_cards",
  "secrets",
  "auth_providers",
  "run_groups",
  "executors",
  "runs",
  "dispatches",
  "session_artifacts",
  "session_claims",
  "run_events",
  "artifacts",
  "baselines",
  "candidates",
  "findings",
  "finding_evidence",
  "finding_resolution_stamps",
  "finding_intake_keys",
  "platform_events",
  "audit_log",
  "consolidation_plans",
  "consolidation_labels",
  "service_heartbeats",
];

/** The KMS key (base64, 32 bytes) the `bytes` ciphertexts were sealed under. */
export const FIXTURE_KMS_KEY_BASE64 = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=";

/** Plaintexts behind the sealed `bytes` columns, for round-trip assertions. */
export const FIXTURE_SECRET_PLAINTEXTS = {
  [`${IDS.secretApiToken}`]: "sk-fixture-acme-web-api-token",
  [`${IDS.secretDbPassword}`]: "fixture-db-password",
  [`${IDS.sessionArtifact}`]:
    '{"cookies":[{"name":"sid","value":"fixture-session","domain":"staging.acme.test","path":"/","expires":-1,"httpOnly":true,"secure":true,"sameSite":"Lax"}],"origins":[]}',
};

// ------------------------------------------------------------------- rows

export const TABLES: HostedDynamic = {
  // Every migration the post-0009 schema is built from, recorded as applied.
  schema_migrations: [
    { filename: "0001_phase1_control_plane.sql", applied_at: T.accountsCreated },
    { filename: "0002_phase2_execution_plane.sql", applied_at: T.accountsCreated },
    { filename: "0003_session_claims.sql", applied_at: T.accountsCreated },
    { filename: "0004_candidate_diff_summary.sql", applied_at: T.accountsCreated },
    { filename: "0005_phase4_authoring_insights.sql", applied_at: T.accountsCreated },
    { filename: "0006_phase5_media_retention.sql", applied_at: T.accountsCreated },
    { filename: "0007_phase6_findings_plugins.sql", applied_at: T.accountsCreated },
    { filename: "0008_phase7_ops.sql", applied_at: T.accountsCreated },
    { filename: "0009_platform_simplification.sql", applied_at: T.accountsCreated },
  ],

  users: [
    { id: IDS.userAdmin, subject: "oidc|ada", email: "ada@acme.test", name: "Ada Admin", disabled: false, created_at: T.accountsCreated, updated_at: T.accountsCreated },
    { id: IDS.userReviewer, subject: "oidc|rex", email: "rex@acme.test", name: "Rex Reviewer", disabled: false, created_at: T.accountsCreated, updated_at: T.accountsCreated },
    // NULL `name` and a disabled account: the nullable/boolean edge rows.
    { id: IDS.userDisabled, subject: "oidc|dana", email: "dana@acme.test", name: null, disabled: true, created_at: T.accountsCreated, updated_at: T.triage },
  ],

  projects: [
    { id: IDS.projectMain, key: "acme-web", name: "Acme Web", archived: false, created_at: T.accountsCreated, updated_at: T.accountsCreated },
    { id: IDS.projectArchived, key: "legacy", name: "Legacy Storefront", archived: true, created_at: T.accountsCreated, updated_at: T.triage },
  ],

  memberships: [
    { user_id: IDS.userAdmin, project_id: IDS.projectMain, role: "admin", created_at: T.accountsCreated, updated_at: T.accountsCreated },
    { user_id: IDS.userReviewer, project_id: IDS.projectMain, role: "reviewer", created_at: T.accountsCreated, updated_at: T.accountsCreated },
    { user_id: IDS.userDisabled, project_id: IDS.projectMain, role: "viewer", created_at: T.accountsCreated, updated_at: T.accountsCreated },
    { user_id: IDS.userAdmin, project_id: IDS.projectArchived, role: "admin", created_at: T.accountsCreated, updated_at: T.accountsCreated },
  ],

  sessions: [
    { id: IDS.sessionLive, user_id: IDS.userAdmin, expires_at: T.sessionExpiry, created_at: T.now },
    { id: IDS.sessionExpired, user_id: IDS.userReviewer, expires_at: T.sessionExpired, created_at: T.snapshot1 },
  ],

  api_tokens: [
    { id: IDS.tokenProject, project_id: IDS.projectMain, role: "developer", name: "ci-trigger", token_hash: sha256Hex("fixture-ci-token"), expires_at: T.tokenExpiry, created_at: T.suiteCreated },
    // project_id NULL = site-scoped; expires_at NULL = never expires.
    { id: IDS.tokenSite, project_id: null, role: "viewer", name: "status-page", token_hash: sha256Hex("fixture-site-token"), expires_at: null, created_at: T.suiteCreated },
  ],

  suites: [
    { id: IDS.suiteCheckout, project_id: IDS.projectMain, slug: "checkout", name: "Checkout journeys", archived: false, created_at: T.suiteCreated, updated_at: T.snapshot2 },
    { id: IDS.suiteArchived, project_id: IDS.projectMain, slug: "admin", name: "Admin console", archived: true, created_at: T.suiteCreated, updated_at: T.triage },
  ],

  suite_files: [
    ...Object.entries(SUITE_FILE_CONTENT).map(([path, content], i) => ({
      id: fid(T.snapshot2, `suite-file:${path}`),
      suite_id: IDS.suiteCheckout,
      path,
      kind: path === "playtest.yaml" ? "defaults" : path.startsWith("stories/") ? "case" : path.startsWith("personas/") ? "persona" : "hook",
      content,
      updated_by: i === 0 ? IDS.userAdmin : IDS.userReviewer,
      created_at: T.suiteCreated,
      updated_at: T.snapshot2,
    })),
    {
      id: fid(T.snapshot1, "suite-file:assets/logo.svg"),
      suite_id: IDS.suiteArchived,
      path: "assets/logo.svg",
      kind: "asset",
      content: ARCHIVED_SUITE_FILE_CONTENT["assets/logo.svg"],
      updated_by: null, // nullable FK to users
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
  ],

  suite_snapshots: [
    { id: IDS.snapshot1, suite_id: IDS.suiteCheckout, seq: 1, tree: TREE_SNAPSHOT_1, created_by: IDS.userAdmin, note: "initial import", created_at: T.snapshot1 },
    { id: IDS.snapshot2, suite_id: IDS.suiteCheckout, seq: 2, tree: TREE_SNAPSHOT_2, created_by: IDS.userReviewer, note: null, created_at: T.snapshot2 },
    { id: IDS.snapshotArchived, suite_id: IDS.suiteArchived, seq: 1, tree: TREE_ARCHIVED, created_by: IDS.userAdmin, note: "archived", created_at: T.snapshot1 },
  ],

  environments: [
    {
      id: IDS.envStaging,
      project_id: IDS.projectMain,
      suite_id: null,
      name: "staging",
      config: {
        app: { base_url: "https://staging.acme.test", viewport: { width: 1280, height: 720 } },
        auth: { provider: "staging-login", identity: "shopper" },
        secret_env: { ACME_API_TOKEN: "API_TOKEN", ACME_DB_PASSWORD: { $secret_file: "DB_PASSWORD" } },
      },
      discovery_allowed: true,
      runner_labels: ["linux", "chromium"], // Postgres text[]
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
    {
      id: IDS.envProd,
      project_id: IDS.projectMain,
      suite_id: null,
      name: "production",
      config: {},
      discovery_allowed: false,
      runner_labels: [], // empty array, not NULL
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
    {
      // Suite-owned: launchable from one suite, deleted with it. The URL a suite
      // uses lives in its own playtest.yaml, so the config here stays empty —
      // this row carries identity and permission, nothing else.
      id: IDS.envSuitePreview,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      name: "preview",
      config: {},
      discovery_allowed: true,
      runner_labels: [],
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
  ],

  personas: [
    {
      id: IDS.personaGrumpy,
      project_id: IDS.projectMain,
      slug: "grumpy-shopper",
      name: "Grumpy Shopper",
      description: "An impatient shopper who complains about slow pages and abandons carts easily.",
      blob_sha256: sha256Hex(PERSONA_GRUMPY_YAML),
      created_by: IDS.userAdmin,
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
  ],

  // One card per state, which is what makes the approved-only filter (DESIGN N6)
  // provable against a restored database rather than only against live writes.
  rule_cards: [
    {
      id: IDS.ruleCardApproved,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      rule_id: "order-total-matches-lines",
      state: "approved",
      origin: "proposed",
      title: "An order's total is the sum of its lines",
      statement: "An order's total always equals the sum of its line amounts plus tax and shipping.",
      applicability: "POST /orders and GET /orders/{id}, including an order with a discount applied.",
      exceptions: "A refunded line stays on the order and still counts toward the total.",
      provenance: "POST /orders \u00b7 Order.total \u00b7 OrderLine.amount",
      note: "Finance reconciles against this nightly.",
      proposed_statement: "An order's total always equals the sum of its line amounts plus tax and shipping.",
      prompt_version: "rule-proposal-v1",
      decided_by: IDS.userReviewer,
      decided_at: T.triage,
      created_at: T.suiteCreated,
      updated_at: T.triage,
    },
    {
      id: IDS.ruleCardCandidate,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      rule_id: "carts-merge-on-sign-in",
      state: "candidate",
      origin: "proposed",
      title: "Signing in merges the guest cart",
      statement: "Signing in merges the guest cart into the account's cart rather than replacing it.",
      applicability: "POST /sessions, for a guest cart holding at least one line.",
      exceptions: null,
      provenance: "POST /sessions \u00b7 Cart.owner",
      note: null,
      proposed_statement: "Signing in merges the guest cart into the account's cart rather than replacing it.",
      prompt_version: "rule-proposal-v1",
      decided_by: null,
      decided_at: null,
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
    {
      id: IDS.ruleCardDenied,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      rule_id: "carts-expire-after-a-week",
      state: "denied",
      origin: "proposed",
      title: "Carts expire",
      statement: "A cart untouched for seven days is emptied automatically.",
      applicability: "GET /carts/{id}.",
      exceptions: null,
      provenance: "GET /carts/{id} \u00b7 Cart.updated_at",
      note: "We keep carts forever \u2014 it is a deliberate retention choice.",
      proposed_statement: "A cart untouched for seven days is emptied automatically.",
      prompt_version: "rule-proposal-v1",
      decided_by: IDS.userReviewer,
      decided_at: T.triage,
      created_at: T.suiteCreated,
      updated_at: T.triage,
    },
  ],

  secrets: [
    {
      id: IDS.secretApiToken,
      project_id: IDS.projectMain,
      name: "API_TOKEN",
      ciphertext: bytes("ERERERERERERERERs+9v+grfTFqy27jaZVhXE6SoVECZkM+Mz6rR1E8mj6dZO3lMxbQWSf9USjYx"),
      created_by: IDS.userAdmin,
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
    {
      id: IDS.secretDbPassword,
      project_id: IDS.projectMain,
      name: "DB_PASSWORD",
      ciphertext: bytes("IiIiIiIiIiIiIiIiVCi2Yw4CINtFl5CDRDYYkMK6pvVJvCGAWTxs6mfrZTxtpe4="),
      created_by: null,
      created_at: T.suiteCreated,
      updated_at: T.triage,
    },
  ],

  auth_providers: [
    {
      id: IDS.providerToken,
      project_id: IDS.projectMain,
      environment_id: IDS.envStaging,
      name: "staging-login",
      kind: "token_endpoint",
      config: { url: "https://staging.acme.test/api/session", method: "POST" },
      code: null,
      identities: { shopper: { username: "shopper@acme.test", password_secret: "API_TOKEN" } },
      ttl_minutes: 60,
      enabled: true,
      updated_by: IDS.userAdmin,
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
    {
      id: IDS.providerScript,
      project_id: IDS.projectMain,
      environment_id: null, // nullable FK with ON DELETE SET NULL
      name: "script-login",
      kind: "script",
      config: {},
      code: "export default async function mint({ page }) { await page.goto('/login'); }\n",
      identities: { admin: { username: "ada@acme.test" } },
      ttl_minutes: 30,
      enabled: true,
      updated_by: null,
      created_at: T.suiteCreated,
      updated_at: T.suiteCreated,
    },
  ],

  run_groups: [
    {
      id: IDS.group1,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      snapshot_id: IDS.snapshot2,
      environment_id: IDS.envStaging,
      trigger: { kind: "ci", ref: "refs/heads/main", sha: "b7f2c1d9e0a4", actor: { user_id: IDS.userAdmin } },
      selection: { mode: "act", stories: ["checkout", "refund"], refresh: false },
      status: "done",
      exit_summary: { pass: 2, fail: 1, infra: 0, changed: 1, exit_code: 1 },
      created_at: T.group1,
      updated_at: T.run3End,
    },
    {
      id: IDS.group2,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      snapshot_id: IDS.snapshot2,
      environment_id: IDS.envStaging,
      trigger: { kind: "manual", actor: { user_id: IDS.userReviewer } },
      selection: { mode: "explore", stories: ["checkout"], refresh: true },
      status: "running",
      exit_summary: null,
      created_at: T.group2,
      updated_at: T.group2,
    },
  ],

  executors: [
    {
      id: IDS.executorGroup,
      run_group_id: IDS.group1,
      kind: "group",
      workflow_run_url: "https://github.com/acme/playtest-runs/actions/runs/900100",
      versions: { playtest: "0.1.0", node: "20.11.1", playwright: "1.53.0" },
      isolation: "container",
      registered_at: T.group1,
      last_report_at: T.run3End,
      concluded_at: T.run3End,
      created_at: T.group1,
    },
    {
      id: IDS.executorMedia,
      run_group_id: null, // ON DELETE SET NULL column, and media executors are group-free
      kind: "media",
      workflow_run_url: null,
      versions: {},
      isolation: "process",
      registered_at: T.triage,
      last_report_at: null,
      concluded_at: null,
      created_at: T.triage,
    },
    {
      id: IDS.executorMint,
      run_group_id: null,
      kind: "mint",
      workflow_run_url: "https://github.com/acme/playtest-runs/actions/runs/900211",
      versions: { playtest: "0.1.0" },
      isolation: null, // nullable CHECK column
      registered_at: T.group2,
      last_report_at: T.group2,
      concluded_at: null,
      created_at: T.group2,
    },
  ],

  runs: [
    {
      id: IDS.run1,
      run_group_id: IDS.group1,
      case_id: "checkout",
      story_id: "checkout",
      run_id: "2026-06-03T09-00-30",
      status: "pass",
      mode: "act",
      healed: false,
      changed: false,
      manifest: {
        run_id: "2026-06-03T09-00-30",
        mode: "act",
        healed: false,
        started_at: T.run1Start,
        duration_ms: 100000,
        case: { id: "checkout", story: "A shopper completes checkout with a saved card and sees the order total.", description: "checkout happy path", tags: ["smoke", "revenue"] },
        result: { status: "pass", end_reason: "gates_met" },
      },
      totals: { steps: 12, tokens_in: 18400, tokens_out: 2100, cost_usd: 0.1842 },
      score: 96,
      gate: { pass: true, checks: [{ spec: "order confirmation is shown", kind: "assert", pass: true, detail: null }] },
      pins: { model: "sonnet", browser: "chromium-1.53.0" },
      duration_ms: 100000,
      started_at: T.run1Start,
      finished_at: T.run1End,
      baseline_id: IDS.baselineV2,
      executor_id: IDS.executorGroup,
      error: null,
      created_at: T.group1,
      updated_at: T.run1End,
      artifact_tier: "full",
      retention_pruned_at: null,
      retention_provenance: {},
    },
    {
      id: IDS.run2,
      run_group_id: IDS.group1,
      case_id: "refund",
      story_id: "refund",
      run_id: "2026-06-03T09-02-15",
      status: "fail",
      mode: "act",
      healed: false,
      changed: false,
      manifest: {
        run_id: "2026-06-03T09-02-15",
        mode: "act",
        healed: false,
        started_at: T.run2Start,
        duration_ms: 110000,
        case: { id: "refund", story: "A shopper refunds a delivered order and the balance returns.", description: null, tags: ["revenue"] },
        result: { status: "fail", end_reason: "gate_failed" },
      },
      totals: { steps: 9, tokens_in: 15200, tokens_out: 1800, cost_usd: 0.1533 },
      score: 41,
      gate: { pass: false, checks: [{ spec: "the refund total equals the order total", kind: "assert", pass: false, detail: "refund total was 0.00" }] },
      pins: { model: "sonnet", browser: "chromium-1.53.0" },
      duration_ms: 110000,
      started_at: T.run2Start,
      finished_at: T.run2End,
      baseline_id: null,
      executor_id: IDS.executorGroup,
      error: null,
      created_at: T.group1,
      updated_at: T.retention,
      artifact_tier: "core", // tiered down by retention
      retention_pruned_at: T.retention,
      retention_provenance: { from: "full", to: "core", policy_days: 90, dropped: ["media/step-03.webm", "media/step-04.webm"] },
    },
    {
      id: IDS.run3,
      run_group_id: IDS.group1,
      case_id: "checkout-healed",
      story_id: "checkout",
      run_id: "2026-06-03T09-04-10",
      status: "pass",
      mode: "heal",
      healed: true,
      changed: true,
      manifest: {
        run_id: "2026-06-03T09-04-10",
        mode: "heal",
        healed: true,
        started_at: T.run3Start,
        duration_ms: 90000,
        case: { id: "checkout-healed", story: "A shopper completes checkout with a saved card and sees the order total.", description: null, tags: [] },
        result: { status: "pass", end_reason: "gates_met" },
      },
      totals: { steps: 14, tokens_in: 21000, tokens_out: 3300, cost_usd: 0.2411 },
      score: 88,
      gate: { pass: true, checks: [{ spec: "order confirmation is shown", kind: "assert", pass: true, detail: null }] },
      pins: { model: "sonnet", browser: "chromium-1.53.0" },
      duration_ms: 90000,
      started_at: T.run3Start,
      finished_at: T.run3End,
      baseline_id: IDS.baselineV1,
      executor_id: IDS.executorGroup,
      error: null,
      created_at: T.group1,
      updated_at: T.retention,
      artifact_tier: "meta", // fully pruned: no artifact rows remain
      retention_pruned_at: T.retention,
      retention_provenance: { from: "core", to: "meta", policy_days: 365 },
    },
    {
      id: IDS.run4,
      run_group_id: IDS.group2,
      case_id: "checkout-explore",
      story_id: "checkout",
      run_id: "2026-06-11T12-00-00",
      status: "explored",
      mode: "explore",
      healed: false,
      changed: false,
      manifest: {
        run_id: "2026-06-11T12-00-00",
        mode: "explore",
        healed: false,
        started_at: T.group2,
        duration_ms: 60000,
        case: { id: "checkout-explore", story: "Explore the checkout flow as an impatient shopper.", description: null, tags: ["discovery"] },
        result: { status: "explored", end_reason: "budget_exhausted" },
      },
      totals: { steps: 20, tokens_in: 30000, tokens_out: 5000, cost_usd: 0.3702 },
      score: null, // discovery runs are ungraded
      gate: null,
      pins: { model: "sonnet" },
      duration_ms: 60000,
      started_at: T.group2,
      finished_at: T.now,
      baseline_id: null,
      executor_id: null,
      error: null,
      created_at: T.group2,
      updated_at: T.now,
      artifact_tier: "full",
      retention_pruned_at: null,
      retention_provenance: {},
    },
    {
      // All-null projection row: queued work that has never reported.
      id: IDS.run5,
      run_group_id: IDS.group2,
      case_id: "refund",
      story_id: null,
      run_id: "2026-06-11T12-00-05",
      status: "queued",
      mode: "act",
      healed: false,
      changed: false,
      manifest: null,
      totals: null,
      score: null,
      gate: null,
      pins: null,
      duration_ms: null,
      started_at: null,
      finished_at: null,
      baseline_id: null,
      executor_id: null,
      error: null,
      created_at: T.group2,
      updated_at: T.group2,
      artifact_tier: "full",
      retention_pruned_at: null,
      retention_provenance: {},
    },
  ],

  dispatches: [
    {
      id: IDS.dispatchGroup1,
      project_id: IDS.projectMain,
      kind: "group",
      ref_id: IDS.group1,
      attempt: 1,
      workflow_run_id: "900100",
      workflow_run_url: "https://github.com/acme/playtest-runs/actions/runs/900100",
      executor_id: IDS.executorGroup,
      status: "concluded",
      requested_at: T.group1,
      concluded_at: T.run3End,
      error: null,
      created_at: T.group1,
    },
    {
      id: IDS.dispatchMedia,
      project_id: IDS.projectMain,
      kind: "media",
      ref_id: IDS.run1,
      attempt: 1,
      workflow_run_id: null,
      workflow_run_url: null,
      executor_id: IDS.executorMedia,
      status: "concluded",
      requested_at: T.triage,
      concluded_at: T.triage,
      error: null,
      created_at: T.triage,
    },
    {
      id: IDS.dispatchMint,
      project_id: IDS.projectMain,
      kind: "mint",
      ref_id: IDS.sessionClaim,
      attempt: 2, // a second attempt after a reconciled-dead first try
      workflow_run_id: "900211",
      workflow_run_url: "https://github.com/acme/playtest-runs/actions/runs/900211",
      executor_id: IDS.executorMint,
      status: "running",
      requested_at: T.group2,
      concluded_at: null,
      error: null,
      created_at: T.group2,
    },
  ],

  session_artifacts: [
    {
      id: IDS.sessionArtifact,
      provider_id: IDS.providerToken,
      identity: "shopper",
      ciphertext: bytes(
        "MzMzMzMzMzMzMzMzOuCXw/NEe0DXjYluTAHsvjXRQSe7FWQ0B9r3VmCK0sc4NQupVe4e+pSX3Qrf7dyMeozMEge0OsjLu/7KUStKqvAZmCacu3BjPJ23k/nraosrz3imF2TGpWfShdUQWPzZDwaD1A/zsRfp28YRKLl68jKLBhhHbRMrjZzSAw6vmq37bCV0QJf08LbM9qNGohBHJPVz5cQCDE0nkLxSs5qdkmIf6ZzrFjUWgr9YaYrjNCpmDOm6u1AZ",
      ),
      minted_at: T.group2,
      expires_at: T.mintExpiry,
      minted_by_job: IDS.executorGroup,
      created_at: T.group2,
    },
  ],

  session_claims: [
    {
      id: IDS.sessionClaim,
      provider_id: IDS.providerScript,
      identity: "admin",
      executor_id: IDS.executorMint,
      status: "pending", // the single-flight grant the partial index guards
      created_at: T.group2,
      expires_at: T.claimExpiry,
    },
  ],

  run_events: [
    { run_id: IDS.run1, seq: 1, ts: T.run1Start, type: "run.started", payload: { case_id: "checkout" } },
    { run_id: IDS.run1, seq: 2, ts: "2026-06-03T09:01:00.000Z", type: "step", payload: { step: 4, action: "click", target: "Place order" } },
    { run_id: IDS.run1, seq: 3, ts: T.run1End, type: "run.finished", payload: { status: "pass", score: 96 } },
    { run_id: IDS.run2, seq: 1, ts: T.run2End, type: "run.finished", payload: { status: "fail", score: 41 } },
  ],

  artifacts: [
    { id: IDS.artifactBundleFull, run_id: IDS.run1, kind: "bundle", key: KEY.bundleFull, sha256: objSha(KEY.bundleFull), size: objSize(KEY.bundleFull), tier: "full", verified_at: T.retention, created_at: T.run1End },
    { id: IDS.artifactIndex, run_id: IDS.run1, kind: "index", key: KEY.bundleIndex, sha256: objSha(KEY.bundleIndex), size: objSize(KEY.bundleIndex), tier: "full", verified_at: T.retention, created_at: T.run1End },
    { id: IDS.artifactClip, run_id: IDS.run1, kind: "clip", key: KEY.clip, sha256: objSha(KEY.clip), size: objSize(KEY.clip), tier: "full", verified_at: T.retention, created_at: T.triage },
    { id: IDS.artifactClipVtt, run_id: IDS.run1, kind: "clip_vtt", key: KEY.clipVtt, sha256: objSha(KEY.clipVtt), size: objSize(KEY.clipVtt), tier: "full", verified_at: T.retention, created_at: T.triage },
    { id: IDS.artifactBundleCore, run_id: IDS.run2, kind: "bundle", key: KEY.bundleCore, sha256: objSha(KEY.bundleCore), size: objSize(KEY.bundleCore), tier: "core", verified_at: T.retention, created_at: T.retention },
  ],

  baselines: [
    {
      id: IDS.baselineV1,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      story_id: "checkout",
      version: 1,
      trajectory_key: `${KEY.bundleFull}#trajectory.jsonl`,
      meta: { accepted_from: "recording", steps: 11 },
      accepted_by: IDS.userAdmin,
      accepted_from_run_id: null,
      superseded_by: IDS.baselineV2,
      created_at: T.snapshot1,
      updated_at: T.run1End,
    },
    {
      id: IDS.baselineV2,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      story_id: "checkout",
      version: 2,
      trajectory_key: `${KEY.bundleFull}#trajectory.jsonl`,
      meta: { accepted_from: "heal", steps: 12, diff: { same: 10, added: 2, removed: 1 } },
      accepted_by: IDS.userReviewer,
      accepted_from_run_id: IDS.run1,
      superseded_by: null,
      created_at: T.run1End,
      updated_at: T.run1End,
    },
  ],

  candidates: [
    {
      id: IDS.candidatePending,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      story_id: "checkout",
      run_id: IDS.run3,
      trajectory_key: `${KEY.bundleFull}#healed.jsonl`,
      meta: { steps: 14, healed_from: 12 },
      status: "pending",
      resolved_by: null,
      resolved_at: null,
      created_at: T.run3End,
      updated_at: T.run3End,
      diff_summary: { same: 7, added: 2, removed: 1, changed: 4 },
    },
    {
      id: IDS.candidateAccepted,
      project_id: IDS.projectMain,
      suite_id: IDS.suiteCheckout,
      story_id: "checkout",
      run_id: IDS.run1,
      trajectory_key: `${KEY.bundleFull}#healed.jsonl`,
      meta: { steps: 12 },
      status: "accepted",
      resolved_by: IDS.userReviewer,
      resolved_at: T.triage,
      created_at: T.run1End,
      updated_at: T.triage,
      diff_summary: null, // legacy row: readers fall back to a live compute
    },
  ],

  findings: [
    {
      id: IDS.finding1,
      project_id: IDS.projectMain,
      fingerprint: sha256Hex("acme-webrefundrefund total mismatch"),
      title: "Refund total does not match the order total",
      summary: { story_id: "refund", case_id: "refund", gate: { spec: "the refund total equals the order total", kind: "assert", detail: "refund total was 0.00" } },
      severity: "major",
      state: "new",
      reject_reason: null,
      external_ref: null,
      merged_into: null,
      first_seen: T.run2End,
      last_seen: T.triage,
      evidence_count: 2,
      category: null,
      source: null,
      signal_type: null,
      locus: null,
      normalized_locus: null,
      strict_key: null,
      loose_key: null,
      key_algo_version: null,
      locus_norm_version: null,
      match_text: null,
      match_text_version: null,
      suggested_finding_id: null,
      suggestion_kind: null,
      recurrence_count: 0,
      first_run_id: null,
      created_at: T.run2End,
      updated_at: T.triage,
    },
    {
      id: IDS.finding2,
      project_id: IDS.projectMain,
      fingerprint: sha256Hex("acme-webcheckoutslow confirmation"),
      title: "Order confirmation takes over eight seconds",
      summary: {
        story_id: "checkout",
        case_id: "checkout",
        confirmed_at: T.triage,
        confirmed_by: { user_id: IDS.userReviewer },
      },
      severity: "minor",
      state: "accepted",
      reject_reason: null,
      external_ref: "ACME-4821",
      merged_into: null,
      first_seen: T.run1End,
      last_seen: T.run1End,
      evidence_count: 1,
      category: "perf_regression",
      source: "reviewer",
      signal_type: "perf_budget",
      locus: { route: "/checkout/confirm", step_locus: "lcp_ms 8400 violates < 2500", status_class: "ok" },
      normalized_locus: "/checkout/confirm lcp_ms <num> violates < <num> ok",
      strict_key: sha256Hex("acme-webcheckoutperf_budget/checkout/confirm lcp_ms <num> violates < <num> ok"),
      loose_key: sha256Hex("acme-webperf_budget/checkout/confirm lcp_ms <num> violates < <num> ok"),
      key_algo_version: "key-v1",
      locus_norm_version: "locus-norm-v1",
      match_text: "perf_regression /checkout/confirm the confirmation renders within the perf budget the confirmation appeared after <num> s order confirmation takes over eight seconds",
      match_text_version: "match-text-v1",
      suggested_finding_id: null,
      suggestion_kind: null,
      recurrence_count: 0,
      first_run_id: IDS.run1,
      created_at: T.run1End,
      updated_at: T.triage,
    },
    {
      // Merge tombstone: excluded from the partial unique/queue indexes.
      id: IDS.finding3Merged,
      project_id: IDS.projectMain,
      fingerprint: sha256Hex("acme-webrefundrefund total mismatch"), // duplicate fingerprint, legal only because merged
      title: "Refund shows zero",
      summary: { story_id: "refund", case_id: "refund" },
      severity: "major",
      state: "rejected",
      reject_reason: "not_a_bug",
      external_ref: null,
      merged_into: IDS.finding1,
      first_seen: T.run2End,
      last_seen: T.triage,
      evidence_count: 0,
      category: null,
      source: null,
      signal_type: null,
      locus: null,
      normalized_locus: null,
      strict_key: null,
      loose_key: null,
      key_algo_version: null,
      locus_norm_version: null,
      match_text: null,
      match_text_version: null,
      suggested_finding_id: null,
      suggestion_kind: null,
      recurrence_count: 0,
      first_run_id: null,
      created_at: T.run2End,
      updated_at: T.triage,
    },
    {
      // Machine-filed and unreviewed: a typed, cited claim in state `new`,
      // grounded in a deterministic signal so it carries both exact keys. Its
      // fingerprint IS its strict key, so a later exact recurrence converges.
      id: IDS.finding4New,
      project_id: IDS.projectMain,
      fingerprint: sha256Hex("acme-webrefundexpectation_contradiction/orders/ <num> /refund refund-total ok"),
      title: "Refund total does not match the order total",
      summary: {
        story_id: "refund",
        case_id: "refund",
        claim: {
          expected: "the refund total equals the order total",
          observed: "the refund total rendered as 0.00",
          signals: ["expectation_contradiction"],
        },
      },
      severity: "major",
      state: "new",
      reject_reason: null,
      external_ref: null,
      merged_into: null,
      first_seen: T.run2End,
      last_seen: T.run2End,
      evidence_count: 2,
      category: "data_mismatch",
      source: "synthesis",
      signal_type: "expectation_contradiction",
      locus: { route: "/orders/8842/refund", step_locus: "refund-total", status_class: "ok" },
      normalized_locus: "/orders/ <num> /refund refund-total ok",
      strict_key: sha256Hex("acme-webrefundexpectation_contradiction/orders/ <num> /refund refund-total ok"),
      loose_key: sha256Hex("acme-webexpectation_contradiction/orders/ <num> /refund refund-total ok"),
      key_algo_version: "key-v1",
      locus_norm_version: "locus-norm-v1",
      match_text: "data_mismatch /orders/ <num> /refund the refund total equals the order total the refund total rendered as <num> refund total does not match the order total",
      match_text_version: "match-text-v1",
      suggested_finding_id: null,
      suggestion_kind: null,
      recurrence_count: 0,
      first_run_id: IDS.run2,
      created_at: T.run2End,
      updated_at: T.run2End,
    },
    {
      // A standing rejection IS the suppression ledger: exact recurrences are
      // absorbed and counted instead of returning to review.
      id: IDS.finding5Rejected,
      project_id: IDS.projectMain,
      fingerprint: sha256Hex("acme-webexplorehttp_error/this-page-does-not-exist navigate 4xx"),
      title: "Unknown route returns 404",
      summary: {
        story_id: "explore",
        case_id: "explore",
        claim: {
          expected: "n/a — the actor probed a nonexistent route",
          observed: "the unknown route returned a friendly 404 page",
          signals: ["http_4xx"],
        },
      },
      severity: "info",
      state: "rejected",
      reject_reason: "not_a_bug",
      external_ref: null,
      merged_into: null,
      first_seen: T.triage,
      last_seen: T.group2,
      evidence_count: 0,
      category: "http_error",
      source: "synthesis",
      signal_type: "http_error",
      locus: { route: "/this-page-does-not-exist", step_locus: "navigate", status_class: "4xx" },
      normalized_locus: "/this-page-does-not-exist navigate 4xx",
      strict_key: sha256Hex("acme-webexplorehttp_error/this-page-does-not-exist navigate 4xx"),
      loose_key: sha256Hex("acme-webhttp_error/this-page-does-not-exist navigate 4xx"),
      key_algo_version: "key-v1",
      locus_norm_version: "locus-norm-v1",
      match_text: "http_error /this-page-does-not-exist n/a the actor probed a nonexistent route the unknown route returned a friendly <num> page unknown route returns <num>",
      match_text_version: "match-text-v1",
      suggested_finding_id: null,
      suggestion_kind: null,
      recurrence_count: 2,
      first_run_id: IDS.run4,
      created_at: T.triage,
      updated_at: T.group2,
    },
  ],

  finding_evidence: [
    { id: IDS.evidence1, finding_id: IDS.finding1, run_id: IDS.run2, case_id: "refund", step_from: 6, step_to: 9, excerpt: "refund total rendered as 0.00 — the refund total equals the order total", created_at: T.run2End },
    { id: IDS.evidence2, finding_id: IDS.finding1, run_id: IDS.run2, case_id: "refund", step_from: null, step_to: null, excerpt: null, created_at: T.triage },
    { id: IDS.evidence3, finding_id: IDS.finding2, run_id: IDS.run1, case_id: "checkout", step_from: 11, step_to: 12, excerpt: "confirmation appeared after 8.4s", created_at: T.run1End },
    { id: IDS.evidence4, finding_id: IDS.finding4New, run_id: IDS.run2, case_id: "refund", step_from: 6, step_to: 6, excerpt: "refund total rendered as 0.00", created_at: T.run2End },
    { id: IDS.evidence5, finding_id: IDS.finding4New, run_id: IDS.run2, case_id: "refund", step_from: 9, step_to: 9, excerpt: null, created_at: T.run2End },
  ],

  // The auto-resolve resolution ledger (0013): a later passing run stamped the
  // key-less slow-checkout finding's (suite, environment, case) triple. Stamps
  // are never deleted; they go stale by timestamp comparison.
  finding_resolution_stamps: [
    {
      finding_id: IDS.finding2,
      suite_id: IDS.suiteCheckout,
      environment_id: IDS.envStaging,
      case_id: "checkout",
      run_id: IDS.run3,
      method: "case_pass",
      stamped_at: T.run3End,
    },
  ],

  // A finding absorbs many intake keys: a runner retry re-presenting one appends
  // evidence instead of filing twice.
  finding_intake_keys: [
    { id: IDS.intakeKeyRefund, project_id: IDS.projectMain, intake_key: "study:fixture:refund-total", finding_id: IDS.finding4New, created_at: T.run2End },
  ],

  // A consolidation plan is a PROPOSAL over supplied ids: one already applied by
  // a reviewer, one still awaiting review. The applied plan's labeled pairs are
  // the calibration record for the shortlist thresholds.
  consolidation_plans: [
    {
      id: IDS.consolidationPlanApplied,
      project_id: IDS.projectMain,
      status: "applied",
      thresholds: { k: 5, floor: 0.25, auto_suggest: 0.6, max_cluster_items: 15, max_prompt_bytes: 24000, max_clusters: 20 },
      shortlist_version: "shortlist-v1",
      match_text_version: "match-text-v1",
      plan: {
        items: [
          {
            id: "it_01HZCONSOLIDATIONITEM0001",
            origin: "model_cluster",
            cluster_id: "cl1",
            candidate_ids: [IDS.finding2],
            finding_id: IDS.finding2,
            proposed_title: null,
            confidence: "high",
            reason: "the same slow checkout confirmation, reported by a second persona",
            score: null,
          },
        ],
        unresolved: [],
      },
      scope: {
        unassigned_candidates: 2, findings_compared: 2, suggestions: 0, proposed_new: 0,
        clustered_candidates: 1, clusters: 1, clusters_dropped_by_cap: 0,
        prompt_bytes: 412, est_input_tokens: 103, max_cluster_size: 1, model_calls_planned: 1,
      },
      usage: { calls: 1, in: 980, out: 120, cache_read: 0, cost_usd: 0.0042 },
      prompt_version: "consolidate-v1",
      model: "sonnet",
      candidate_digest: sha256Hex("consolidation-digest:applied"),
      created_by: { user_id: IDS.userReviewer },
      applied_by: { user_id: IDS.userReviewer },
      created_at: T.triage,
      applied_at: T.triage,
      updated_at: T.triage,
    },
    {
      id: IDS.consolidationPlanProposed,
      project_id: IDS.projectMain,
      status: "proposed",
      thresholds: { k: 5, floor: 0.25, auto_suggest: 0.6, max_cluster_items: 15, max_prompt_bytes: 24000, max_clusters: 20 },
      shortlist_version: "shortlist-v1",
      match_text_version: "match-text-v1",
      plan: {
        items: [
          {
            id: "it_01HZCONSOLIDATIONITEM0002",
            origin: "shortlist_new",
            cluster_id: null,
            candidate_ids: [IDS.finding4New],
            finding_id: null,
            proposed_title: "Refund total does not match the order total",
            confidence: null,
            reason: "no neighbor scored above the similarity floor",
            score: null,
          },
        ],
        unresolved: [],
      },
      scope: {
        unassigned_candidates: 1, findings_compared: 2, suggestions: 0, proposed_new: 1,
        clustered_candidates: 0, clusters: 0, clusters_dropped_by_cap: 0,
        prompt_bytes: 0, est_input_tokens: 0, max_cluster_size: 0, model_calls_planned: 0,
      },
      usage: { calls: 0, in: 0, out: 0, cache_read: 0, cost_usd: 0 },
      prompt_version: null,
      model: null,
      candidate_digest: sha256Hex("consolidation-digest:proposed"),
      created_by: { user_id: IDS.userReviewer },
      applied_by: null,
      created_at: T.group2,
      applied_at: null,
      updated_at: T.group2,
    },
  ],

  consolidation_labels: [
    {
      id: IDS.consolidationLabelConfirmed,
      project_id: IDS.projectMain,
      plan_id: IDS.consolidationPlanApplied,
      subject_finding_id: IDS.finding2,
      finding_id: IDS.finding2,
      origin: "model_cluster",
      score: null,
      confidence: "high",
      decision: "confirmed",
      detail: { proposed_finding_id: IDS.finding2, created: false },
      actor: { user_id: IDS.userReviewer },
      created_at: T.triage,
    },
    {
      id: IDS.consolidationLabelRejected,
      project_id: IDS.projectMain,
      plan_id: IDS.consolidationPlanApplied,
      subject_finding_id: IDS.finding4New,
      finding_id: IDS.finding1,
      origin: "shortlist_suggestion",
      score: 0.61,
      confidence: null,
      decision: "rejected",
      detail: { reason: "reviewer left it unresolved" },
      actor: { user_id: IDS.userReviewer },
      created_at: T.triage,
    },
  ],

  platform_events: [
    { id: IDS.event1, project_id: IDS.projectMain, type: "run.status", entity: { run_group_id: IDS.group1, run_id: IDS.run1 }, payload: { status: "pass", score: 96 }, ts: T.run1End },
    { id: IDS.event2, project_id: IDS.projectMain, type: "run.event", entity: { run_id: IDS.run2 }, payload: { seq: 1, type: "run.finished", status: "fail" }, ts: T.run2End },
    { id: IDS.event3, project_id: IDS.projectMain, type: "finding.created", entity: { finding_id: IDS.finding1 }, payload: { severity: "major", state: "new" }, ts: T.run2End },
    { id: IDS.event4, project_id: IDS.projectMain, type: "candidate.superseded", entity: { story_id: "checkout", run_group_id: IDS.group1 }, payload: { candidate_ids: [IDS.candidateAccepted], story_id: "checkout" }, ts: T.triage },
    { id: IDS.event5, project_id: IDS.projectMain, type: "dispatch.dead", entity: { dispatch_id: IDS.dispatchMint }, payload: { kind: "mint", reason: "workflow concluded without fulfilling the claim" }, ts: T.group2 },
  ],

  audit_log: [
    { id: IDS.audit2, ts: T.suiteCreated, project_id: IDS.projectMain, actor: { user_id: IDS.userAdmin }, action: "secret.created", entity_type: "secret", entity_id: `${IDS.projectMain}:API_TOKEN`, detail: { name: "API_TOKEN" } },
    { id: IDS.audit1, ts: T.snapshot2, project_id: IDS.projectMain, actor: { user_id: IDS.userReviewer }, action: "suite.committed", entity_type: "suite", entity_id: IDS.suiteCheckout, detail: { snapshot_id: IDS.snapshot2, seq: 2, changed: ["stories/checkout.yaml"] } },
    { id: IDS.audit3, ts: T.triage, project_id: IDS.projectMain, actor: { user_id: IDS.userReviewer }, action: "finding.accepted", entity_type: "finding", entity_id: IDS.finding2, detail: { from: "new", to: "accepted", severity: "minor" } },
    { id: IDS.audit4, ts: T.group2, project_id: IDS.projectMain, actor: { system: "session-broker" }, action: "session.minted", entity_type: "session_artifact", entity_id: IDS.sessionArtifact, detail: { provider: "staging-login", identity: "shopper" } },
    // project_id NULL = a site-level action, the nullable-scope edge row.
    { id: IDS.audit5, ts: T.group2, project_id: null, actor: { token_id: IDS.tokenSite }, action: "token.created", entity_type: "api_token", entity_id: IDS.tokenSite, detail: { name: "status-page", scope: "site" } },
  ],

  service_heartbeats: [
    { name: "reconciler", beat_at: T.now, detail: { reconciled: 3, dead: 1, interval_s: 30 } },
  ],
};

/** The whole fixture: ordered tables plus the object-store contents they reference. */
export const fixture: HostedDynamic = Object.freeze({
  tableOrder: TABLE_ORDER,
  columnTypes: COLUMN_TYPES,
  tables: TABLES,
  objects: OBJECTS,
  kmsKeyBase64: FIXTURE_KMS_KEY_BASE64,
  secretPlaintexts: FIXTURE_SECRET_PLAINTEXTS,
});

export default fixture;
