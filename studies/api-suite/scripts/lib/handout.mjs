// Shared study configuration for S0's trial harness.
//
// Three tools have to agree exactly or the study is not measuring one thing:
// `make-handout.mjs` (what a trial agent is given), `trial-run.mjs` (what
// `./run.sh` executes), and `replay-round.mjs` (how an authored suite is
// replayed against every build of a round). This module is the single place
// their shared decisions live — the budgets, the timeout, how invariant
// statements become rule obligations, and the recorded target authorization
// the write grant cites.
//
// Nothing here names the fixture: `studies/**` source may not mention the
// standalone examples tree (tests/repository/boundaries.test.js), so every
// fixture path comes from `LEDGER_FIXTURE_DIR` or a base URL.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The engine's supported script surface. `loadOpenApi` has no facade of its
// own; a study is not hosted code, and the spec loader is the same one the
// runner's own policies read documents through.
import {
  defaultScriptPolicies,
  deriveObligations,
  loadOpenApi,
} from "@playtest/core/api-suite-scripts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** studies/api-suite */
export const STUDY_DIR = path.resolve(HERE, "../..");
/** the repository root */
export const REPO_ROOT = path.resolve(STUDY_DIR, "../..");
/** studies/api-suite/scripts */
export const SCRIPTS_DIR = path.resolve(HERE, "..");
/** the handout sources a trial is assembled from */
export const HANDOUT_SRC_DIR = path.join(STUDY_DIR, "handout-src");
/** the statement set, authored separately; treated as an input that may not exist yet */
export const INVARIANTS_FILE = path.join(STUDY_DIR, "INVARIANTS.md");
export const BRIEF_FILE = path.join(STUDY_DIR, "BRIEF.md");
export const PROPOSAL_BRIEF_FILE = path.join(STUDY_DIR, "PROPOSAL-BRIEF.md");
export const CLIENT_DOC_FILE = path.join(HANDOUT_SRC_DIR, "CLIENT.md");

const integer = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
};

/**
 * The preregistered execution configuration (PREREGISTRATION.md §7).
 *
 * `budget` and `observationBudget` are §7.2 and §7.3 verbatim. `timeoutMs` is
 * the per-execution wall-clock ceiling the runner needs and the prereg does not
 * yet state; it is proposed here and must be finalized in §7.2 at the freeze.
 * The environment overrides exist for development rounds only — a measured
 * round runs on the defaults, which is what the fingerprint pins.
 */
export const STUDY = Object.freeze({
  budget: integer(process.env.S0_BUDGET, 360),
  observationBudget: integer(process.env.S0_OBSERVATION_BUDGET, 60),
  timeoutMs: integer(process.env.S0_TIMEOUT_MS, 600_000),
  requestTimeoutMs: integer(process.env.S0_REQUEST_TIMEOUT_MS, 15_000),
  seed: process.env.LEDGER_SEED ?? "ledger-dev-seed",
  authoring: Object.freeze({
    executions: 12,
    wallClockHours: 3,
    requests: 1500,
    observationRequests: 60,
    observationMinutes: 30,
  }),
});

/**
 * The DESIGN §4 step 2 target authorization, recorded in
 * `studies/api-suite/TARGET-AUTHORIZATION.md`. The runner refuses a grant that
 * does not name the origin the run resolves, so the origin is filled per run.
 */
export const TARGET_AUTHORIZATION = Object.freeze({
  record: "studies/api-suite/TARGET-AUTHORIZATION.md",
  approved_by: "S0 study owner — disposable loopback ledger fixture (studies/api-suite/TARGET-AUTHORIZATION.md)",
  approved_at: "2026-07-26",
});

/** The write grant for one run against `baseUrl`. */
export function writeGrantFor(baseUrl) {
  return {
    origin: new URL(baseUrl).origin,
    approved_by: TARGET_AUTHORIZATION.approved_by,
    approved_at: TARGET_AUTHORIZATION.approved_at,
  };
}

export const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
export const sha256File = (file) => sha256(fs.readFileSync(file));

/** Lowercase, hyphenated, alphanumeric — the fallback rule-id derivation. */
export const slug = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Turn an invariant-statement document into approved rule records.
 *
 * The statement set is authored as prose (the P1 shape: rule + applicability +
 * declared exceptions, one `##` section per rule), so this parser is
 * deliberately tolerant and deliberately mechanical — no model, no judgement:
 *
 *   heading   `## 3. Lifecycle legality`            → id `lifecycle-legality`
 *             `## 3. Lifecycle legality {#lifecycle}` → id `lifecycle`
 *             ``## 3. Lifecycle (`rule:lifecycle`)``  → id `lifecycle`
 *   statement the section's first paragraph
 *   applicability the remaining paragraphs
 *
 * A derived id is never something a trial agent has to guess: the resolved
 * obligation ids are written into the handout as `handout/obligations.json`.
 * A statement set that wants explicit ids, approved skip reasons, or an
 * `unsupported` marker ships a sibling `INVARIANTS.rules.json` instead, which
 * takes precedence over the prose.
 */
export function parseInvariantRules(markdown) {
  const rules = [];
  const sections = String(markdown).split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const lines = section.split("\n");
    const heading = (lines.shift() ?? "").trim();
    if (!heading) continue;
    const body = lines.join("\n").trim();

    let id = null;
    const anchor = heading.match(/\{#([A-Za-z0-9_.-]+)\}/);
    const explicit = heading.match(/`rule:([A-Za-z0-9_.-]+)`/);
    if (anchor) id = anchor[1];
    else if (explicit) id = explicit[1];
    const title = heading
      .replace(/\{#[A-Za-z0-9_.-]+\}/, "")
      .replace(/`rule:[A-Za-z0-9_.-]+`/, "")
      .replace(/^\s*\d+[.)]\s*/, "")
      .replace(/\s*\(\s*\)\s*$/, "")
      .trim();
    if (!id) id = slug(title);
    if (!id) continue;

    const paragraphs = body.split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim()).filter(Boolean);
    rules.push({
      id,
      title,
      statement: paragraphs[0] ?? title,
      ...(paragraphs.length > 1 ? { applicability: paragraphs.slice(1).join(" ") } : {}),
    });
  }
  return rules;
}

/**
 * Load approved rule statements for a run.
 * @param {string} invariantsFile path to an INVARIANTS.md (may not exist)
 * @returns {{ rules: object[], source: string|null }}
 */
export function loadRules(invariantsFile) {
  if (!invariantsFile) return { rules: [], source: null };
  const sidecar = invariantsFile.replace(/\.md$/, ".rules.json");
  if (fs.existsSync(sidecar)) {
    const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    const rules = Array.isArray(parsed) ? parsed : (parsed.rules ?? []);
    return { rules, source: path.basename(sidecar) };
  }
  if (!fs.existsSync(invariantsFile)) return { rules: [], source: null };
  return { rules: parseInvariantRules(fs.readFileSync(invariantsFile, "utf8")), source: path.basename(invariantsFile) };
}

/** Resolve an OpenAPI document for a run. */
export function loadSpec(file) {
  return loadOpenApi(file, { where: "S0 handout openapi" });
}

/**
 * The obligation manifest a run will be judged against, derived exactly as the
 * runner derives it: the default policy set for this spec, every spec
 * operation, and every approved rule statement.
 */
export function studyObligations({ spec = null, rules = [] } = {}) {
  return deriveObligations({ policies: defaultScriptPolicies({ spec }), spec, rules });
}

/**
 * The credentials every measured run declares, by name and in this order.
 *
 * Three principals, three references. The second customer is not a convenience:
 * the `authorization` taxonomy category is *act as the wrong principal on
 * someone else's resource*, and with one customer token that category is
 * unreachable — the only authorization a suite could exercise would be the
 * admin/customer role split. Both customer references therefore ship in every
 * handout, and the preregistration records that the category is measured
 * because they do (PREREGISTRATION.md §4.3).
 *
 * A reference substitutes a whole header value, never part of one, so the value
 * is the complete `Bearer <token>` string. `token` is the bare credential the
 * fixture is started with; the published defaults are the fixture's own, which
 * is deliberate — this target is a disposable loopback fixture whose tokens
 * authorize nothing (`TARGET-AUTHORIZATION.md`).
 *
 * Nothing here tells a trial *which* principal a customer reference is. That is
 * learnable only by acting — open an account under each and read back the
 * owner — which is the point: identity is a property of the API's behaviour,
 * not of the handout.
 */
export const STUDY_SECRETS = Object.freeze([
  Object.freeze({
    name: "LEDGER_ADMIN_TOKEN",
    env: "LEDGER_ADMIN_TOKEN",
    token: "admin-token-dev",
    role: "the administrator principal; the only one the /admin/* routes accept",
  }),
  Object.freeze({
    name: "LEDGER_CUSTOMER_TOKEN",
    env: "LEDGER_CUSTOMER_TOKEN",
    token: "customer-token-dev",
    role: "one customer principal",
  }),
  Object.freeze({
    name: "LEDGER_CUSTOMER_B_TOKEN",
    env: "LEDGER_CUSTOMER_B_TOKEN",
    token: "customer-b-token-dev",
    role: "a second, different customer principal",
  }),
]);

/** `Bearer <token>` unless the value already carries an auth scheme. */
const asHeaderValue = (value) => (/^(bearer|basic|token|apikey|digest)\s+\S/i.test(String(value).trim()) ? String(value).trim() : `Bearer ${String(value).trim()}`);

/**
 * Make every declared credential resolvable, and return the names.
 *
 * Precedence per reference: an explicit `PLAYTEST_SECRET_<NAME>` already in the
 * environment (an operator's secrets file, loaded before this runs), then the
 * matching `LEDGER_*` variable, then the fixture's published default. A value
 * given without an auth scheme is sent as `Bearer <value>`, because a reference
 * has to be the entire header value.
 *
 * Injection is the harness's job, not a trial's: a measured run that silently
 * declared two of the three references would make the authorization category
 * unreachable and the miss would look like a suite's.
 */
export function resolveStudySecrets(env = process.env) {
  const names = [];
  for (const secret of STUDY_SECRETS) {
    const key = `PLAYTEST_SECRET_${secret.name}`;
    const explicit = env[key];
    const supplied = explicit !== undefined && explicit !== "" ? explicit : (env[secret.env] || secret.token);
    env[key] = asHeaderValue(supplied);
    names.push(secret.name);
  }
  return names;
}

/** The `PLAYTEST_SECRET_<NAME>` tails present in an environment. */
export function secretNamesFrom(env = process.env) {
  return Object.keys(env)
    .filter((key) => key.startsWith("PLAYTEST_SECRET_") && key.length > "PLAYTEST_SECRET_".length)
    .map((key) => key.slice("PLAYTEST_SECRET_".length))
    .sort();
}

/**
 * Load a study secrets file into the environment. Study-operator material, not
 * a project `.env`: `NAME=value` lines, `#` comments, `PLAYTEST_SECRET_` prefix
 * optional. Values never reach the script process — the proxy substitutes them
 * on the wire — and never reach `run.sh`, which only carries this file's path.
 */
export function loadSecretsFile(file, env = process.env) {
  const loaded = [];
  if (!file) return loaded;
  if (!fs.existsSync(file)) throw new Error(`no such secrets file: ${file}`);
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split < 1) continue;
    const rawName = trimmed.slice(0, split).trim().replace(/^export\s+/, "");
    const value = trimmed.slice(split + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    const name = rawName.startsWith("PLAYTEST_SECRET_") ? rawName : `PLAYTEST_SECRET_${rawName}`;
    env[name] = value;
    loaded.push(name.slice("PLAYTEST_SECRET_".length));
  }
  return loaded.sort();
}

/** `--name value` from argv. */
export const argOf = (name, fallback = null, argv = process.argv) => {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? (argv[index + 1] ?? fallback) : fallback;
};
/** `--name` presence in argv. */
export const flagOf = (name, argv = process.argv) => argv.includes(`--${name}`);
