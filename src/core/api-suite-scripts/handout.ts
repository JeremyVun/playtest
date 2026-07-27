import type { DynamicValue } from "./types.ts";

// The authoring handout (docs/contracts/scripts.md#the-handout).
//
// DESIGN §5 item 2: the enriched spec (P3) + the approved rule statements with
// their card notes (S3; hand-written statements until then) + the client
// contract + the authoring brief. This is the product version of the S0 study's
// `make-handout.mjs`, which produced byte-identical handouts across four trials;
// the study's fixture-specific decisions are parameters here and its scratch
// directory / `run.sh` apparatus is gone, because the product's loop executes
// each draft itself.
//
// One study finding is load-bearing enough to be a rule rather than a habit: the
// resolved obligation manifest ships WITH the handout, as `obligations.json`.
// Without it an author has to guess obligation ids and spend an execution
// finding out which ones exist — a whole turn of a small budget, burned on the
// harness rather than on the API.
//
// Nothing here consults a model, and nothing here is authored by a model: given
// the same spec, rules, and budgets, this module writes the same bytes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DummyConfigError } from "../config.ts";
import { deriveObligations } from "./obligations.ts";

interface RenderRule {
  [key: string]: DynamicValue;
  approved_skip_reasons?: DynamicValue[];
}

/** Handout shape version, carried in the manifest and the transcript. */
export const HANDOUT_VERSION = 2;

/** The maintained protocol assets (DESIGN §5 item 8). */
const ASSETS = fileURLToPath(new URL("./handout/", import.meta.url));
export const BRIEF_ASSET = path.join(ASSETS, "BRIEF.md");
export const CLIENT_ASSET = path.join(ASSETS, "CLIENT.md");

const sha256 = (value: DynamicValue) => crypto.createHash("sha256").update(value).digest("hex");

/** Lowercase, hyphenated, alphanumeric — the fallback rule-id derivation. */
export const slugifyRuleId = (text: DynamicValue) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Turn an invariant-statement document into approved rule records.
 *
 * Statement sets are authored as prose — one `##` section per rule, the first
 * paragraph the rule itself, the rest its applicability and declared exceptions
 * — so this parser is deliberately tolerant and deliberately mechanical: no
 * model, no judgement.
 *
 *   `## 3. Lifecycle legality`             → id `lifecycle-legality`
 *   `## 3. Lifecycle legality {#lifecycle}` → id `lifecycle`
 *   ``## 3. Lifecycle (`rule:lifecycle`)``  → id `lifecycle`
 *
 * S3 replaces this path with approved rule cards carrying explicit ids. Until
 * then a hand-written `INVARIANTS.md` is the supported input, and the ids it
 * derives are never something an author has to guess — they are written into the
 * handout's `obligations.json`.
 */
export function parseInvariantRules(markdown: DynamicValue) {
  const rules: DynamicValue = [];
  for (const section of String(markdown ?? "").split(/^##\s+/m).slice(1)) {
    const lines = section.split("\n");
    const heading = (lines.shift() ?? "").trim();
    if (!heading) continue;

    const anchor = heading.match(/\{#([A-Za-z0-9_.-]+)\}/);
    const explicit = heading.match(/`rule:([A-Za-z0-9_.-]+)`/);
    const title = heading
      .replace(/\{#[A-Za-z0-9_.-]+\}/, "")
      .replace(/`rule:[A-Za-z0-9_.-]+`/, "")
      .replace(/^\s*\d+[.)]\s*/, "")
      .replace(/\s*\(\s*\)\s*$/, "")
      .trim();
    const id = anchor?.[1] ?? explicit?.[1] ?? slugifyRuleId(title);
    if (!id) continue;

    const paragraphs = section
      .split("\n")
      .slice(1)
      .join("\n")
      .trim()
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
      .filter(Boolean);
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
 * Validate approved rule statements. Only human-approved sentences reach a
 * handout (N6); this function does not create, edit, or infer one — it checks
 * the shape of what was approved and fails as user input when it is wrong.
 *
 * @param {object[]|string} rules records, or an INVARIANTS.md document to parse
 * @returns {object[]}
 */
export function normalizeRules(rules: DynamicValue, { where = "rules" }: DynamicValue = {}) {
  if (rules === null || rules === undefined) return [];
  const list = typeof rules === "string" ? parseInvariantRules(rules) : rules;
  if (!Array.isArray(list)) throw new DummyConfigError(`${where} must be a list of approved rule statements, or an INVARIANTS.md document`);
  const out: DynamicValue = [];
  const seen: DynamicValue = new Set();
  for (const rule of list) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new DummyConfigError(`${where}: each entry is an object { id, statement }`);
    const id = typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : slugifyRuleId(rule.title ?? rule.statement);
    if (!id) throw new DummyConfigError(`${where}: a rule needs an id, a title, or a statement to derive one from`);
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new DummyConfigError(`${where}: rule id ${JSON.stringify(id)} must be letters, digits, dot, dash, or underscore`);
    if (seen.has(id)) throw new DummyConfigError(`${where}: duplicate rule id ${JSON.stringify(id)} — an obligation id identifies one rule`);
    seen.add(id);
    const statement = String(rule.statement ?? rule.title ?? "").trim();
    if (!statement) throw new DummyConfigError(`${where}: rule ${JSON.stringify(id)} has no statement — an approved rule is a sentence a human approved`);
    const notes = rule.notes === undefined || rule.notes === null ? [] : (Array.isArray(rule.notes) ? rule.notes : [rule.notes]).map((note: DynamicValue) => String(note).trim()).filter(Boolean);
    out.push({
      id,
      ...(rule.title ? { title: String(rule.title).trim() } : {}),
      statement,
      ...(rule.applicability ? { applicability: String(rule.applicability).trim() } : {}),
      // A declared exception NARROWS its rule; it never cancels it. S0's
      // proposal trial produced a card whose exceptions line overrode its own
      // applicability line, which made the rule unenforceable and cost a real
      // detection — so the two ride in separate fields and render separately.
      ...(rule.exceptions ? { exceptions: String(rule.exceptions).trim() } : {}),
      ...(notes.length ? { notes } : {}),
      ...(Array.isArray(rule.approved_skip_reasons) ? { approved_skip_reasons: rule.approved_skip_reasons.map(String) } : {}),
      ...(rule.unsupported ? { unsupported: true } : {}),
      ...(rule.provenance ? { provenance: String(rule.provenance) } : {}),
    });
  }
  return out;
}

/**
 * Render approved rule statements as the handout's `INVARIANTS.md`. Card notes
 * (S3) ride with their rule so an author sees the owner's steering next to the
 * sentence it steers, and the transcript shows what it was given.
 */
export function renderInvariants(rules: DynamicValue, { title = "Approved rules" }: DynamicValue = {}) {
  const lines = [
    `# ${title}`,
    "",
    "These sentences were approved by the API's owner. They are the declared truth",
    "about this system: where one and the OpenAPI document disagree, the rule wins",
    "and the conflict is a finding.",
    "",
    "Each rule's obligation id is `rule:<id>`, and every id is listed in",
    "`obligations.json`.",
    "",
    "A **declared exception** narrows its rule; it never cancels it. Where an exception",
    "and its rule would contradict each other, the rule stands and the contradiction is",
    "a finding for the owner — not a licence to skip the check.",
    "",
  ];
  if (!rules.length) {
    lines.push("*No rule statements were approved for this suite. The run is judged against its", "Level 0 policy set and its operation coverage alone.*", "");
    return lines.join("\n");
  }
  rules.forEach((rule: RenderRule, index: DynamicValue) => {
    lines.push(`## ${index + 1}. ${rule.title ?? rule.statement} (\`rule:${rule.id}\`)`, "");
    lines.push(rule.statement, "");
    if (rule.applicability) lines.push(`**Applies:** ${rule.applicability}`, "");
    if (rule.exceptions) lines.push(`**Declared exception:** ${rule.exceptions}`, "");
    for (const note of rule.notes ?? []) lines.push(`**Owner's note:** ${note}`, "");
    if (rule.approved_skip_reasons?.length) {
      lines.push(`**Approved skip reasons:** ${rule.approved_skip_reasons.map((reason) => JSON.stringify(reason)).join(", ")}`, "");
    }
    if (rule.unsupported) lines.push("**Marked unsupported** by the owner: no check is expected for it.", "");
  });
  return lines.join("\n");
}

const humanMs = (ms: DynamicValue) => {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}`;
  if (ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
};

/** `{{key}}` substitution with no silent misses: an unknown key is a bug, not a blank. */
export function fillTemplate(template: DynamicValue, values: DynamicValue, { where = "handout template" }: DynamicValue = {}) {
  return String(template).replace(/\{\{([a-z_]+)\}\}/g, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`${where}: no value for {{${key}}}`);
    return String(values[key]);
  });
}

function secretsSection(secrets: DynamicValue) {
  if (!secrets.length) {
    return "This run declares **no credential references**: every request is unauthenticated.\n`client.secretNames` is empty.";
  }
  const rows = secrets.map((secret: DynamicValue) =>
    typeof secret === "string" ? { name: secret, role: "declared by this run" } : { name: secret.name, role: secret.role ?? "declared by this run" },
  );
  return [
    `This run declares ${rows.length} reference${rows.length === 1 ? "" : "s"}, usable as a whole header value:`,
    "",
    "| Reference | Who it authenticates |",
    "|---|---|",
    ...rows.map((row: DynamicValue) => `| \`${row.name}\` | ${row.role} |`),
    "",
    "```js",
    `const answer = await client.get("/", {`,
    `  headers: { authorization: client.secret(${JSON.stringify(rows[0].name)}) },`,
    "});",
    "```",
  ].join("\n");
}

/** What this target does with what a run leaves behind (docs/contracts/scripts.md#test-data-lifecycle). */
function cleanupSection(cleanup: DynamicValue) {
  const policy = typeof cleanup === "string" ? cleanup : (cleanup?.policy ?? (cleanup?.reset ? "reset" : "teardown"));
  if (policy === "none") return "This run creates nothing: it is read-only.";
  if (policy === "reset") {
    return [
      "This target is **reset by the harness** after every execution, so accumulation is not",
      "your problem. Namespacing still is: two replays can overlap before either resets.",
    ].join("\n");
  }
  const cap = cleanup?.accumulation_cap;
  return [
    "Cleanup here is **best-effort teardown**: whatever you create, you delete.",
    `The harness counts what survived and fails the run past ${cap ?? "this target's"} outstanding resource${cap === 1 ? "" : "s"}.`,
  ].join("\n");
}

function resetSection(reset: DynamicValue) {
  if (!reset) {
    return [
      "This target declares **no reset affordance**. Make the suite idempotent under",
      "repetition: namespace what you create, and never assume the environment is",
      "empty or that it is the same as it was last turn.",
    ].join("\n");
  }
  return [
    "**Start every execution from a known state.** This target declares a reset:",
    "",
    `> ${reset}`,
  ].join("\n");
}

/**
 * Assemble one authoring handout.
 *
 * @param {{ spec: object, specSource?: object, rules?: object[], target: object,
 *           secrets?: (string|object)[], budget: object, params?: object,
 *           reset?: string|null, policies?: object[], obligations?: object[],
 *           title?: string }} input
 * @returns {{ version, files: {path: string, contents: string}[], manifest: object,
 *             obligations: object[], rules: object[] }}
 */
export function buildHandout({
  spec,
  specSource = null,
  rules = [],
  target,
  secrets = [],
  budget,
  params = {},
  reset = null,
  policies = [],
  obligations = null,
  title = "Approved rules",
}: DynamicValue = {}) {
  if (!spec || typeof spec !== "object") throw new DummyConfigError("handout: a resolved OpenAPI document is required");
  if (!target?.base_url) throw new DummyConfigError("handout: target.base_url is required");
  const approvedRules = normalizeRules(rules, { where: "handout: rules" });
  const manifestEntries = obligations ?? deriveObligations({ policies, spec, rules: approvedRules });

  const secretNames = secrets.map((secret: DynamicValue) => (typeof secret === "string" ? secret : secret.name));
  const values: DynamicValue = {
    target: target.base_url,
    mode: target.mode ?? "read-write",
    allowed_origins: target.allowed_origins?.length
      ? `This run also allows ${target.allowed_origins.join(", ")} — and no credential is ever sent there.`
      : "This run allows no other origin.",
    params: JSON.stringify(params ?? {}),
    secrets: secretsSection(secrets),
    reset: resetSection(reset),
    cleanup: cleanupSection(target.cleanup ?? null),
    execution_budget: budget.execution_budget,
    execution_timeout: humanMs(budget.execution_timeout_ms),
    request_timeout: humanMs(budget.request_timeout_ms ?? 15_000),
    iterations: budget.iterations,
    requests: budget.requests,
    wall_clock: humanMs(budget.wall_clock_ms),
  };

  const brief = fillTemplate(fs.readFileSync(BRIEF_ASSET, "utf8"), values, { where: "handout BRIEF.md" });
  const client = fillTemplate(fs.readFileSync(CLIENT_ASSET, "utf8"), values, { where: "handout CLIENT.md" });
  const invariants = renderInvariants(approvedRules, { title });
  const obligationsDoc = `${JSON.stringify(
    {
      note: "Every obligation this run is judged against. A check's `obligation` must be one of these ids (CLIENT.md §6).",
      total: manifestEntries.length,
      obligations: manifestEntries,
    },
    null,
    2,
  )}\n`;
  const specDoc = `${JSON.stringify(spec.document ?? spec, null, 2)}\n`;

  const files = [
    { path: "BRIEF.md", contents: brief },
    { path: "CLIENT.md", contents: client },
    { path: "INVARIANTS.md", contents: invariants },
    { path: "obligations.json", contents: obligationsDoc },
    { path: "openapi.json", contents: specDoc },
  ].sort((a, b) => a.path.localeCompare(b.path));

  const manifest: DynamicValue = {
    handout_version: HANDOUT_VERSION,
    target: { base_url: target.base_url, mode: values.mode, allowed_origins: target.allowed_origins ?? [] },
    spec: {
      title: spec.title ?? null,
      version: spec.version ?? null,
      operations: spec.operations?.length ?? 0,
      source: specSource ? { kind: specSource.kind, detail: specSource.detail } : null,
    },
    rules: { count: approvedRules.length, ids: approvedRules.map((rule: DynamicValue) => rule.id) },
    secrets: secretNames,
    budget: { ...budget },
    obligations: {
      total: manifestEntries.length,
      policy: manifestEntries.filter((entry: DynamicValue) => entry.source === "policy").length,
      operation: manifestEntries.filter((entry: DynamicValue) => entry.source === "operation").length,
      rule: manifestEntries.filter((entry: DynamicValue) => entry.source === "rule").length,
    },
    files: files.map((file) => ({ path: file.path, sha256: sha256(file.contents), bytes: Buffer.byteLength(file.contents) })),
  };
  manifest.sha256 = sha256(JSON.stringify(manifest.files));

  return { version: HANDOUT_VERSION, files, manifest, obligations: manifestEntries, rules: approvedRules };
}

/** Write a built handout to disk, manifest included. Returns the absolute paths written. */
export function writeHandout(dir: DynamicValue, handout: DynamicValue) {
  fs.mkdirSync(dir, { recursive: true });
  const written: DynamicValue = [];
  for (const file of handout.files) {
    const target = path.join(dir, file.path);
    fs.writeFileSync(target, file.contents);
    written.push(target);
  }
  const manifestPath = path.join(dir, "handout-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(handout.manifest, null, 2)}\n`);
  written.push(manifestPath);
  return written;
}

/**
 * The handout as one prompt document. The loop sends this as a single stable
 * message so a gateway that supports prompt caching can cache the whole thing:
 * it is identical on every turn of a job.
 */
export function handoutPrompt(handout: DynamicValue) {
  const order = ["BRIEF.md", "CLIENT.md", "INVARIANTS.md", "obligations.json", "openapi.json"];
  const byPath: DynamicValue = new Map(handout.files.map((file: DynamicValue) => [file.path, file.contents]));
  const parts: DynamicValue = [];
  for (const name of order) {
    const contents = byPath.get(name);
    if (contents === undefined) continue;
    const fence = name.endsWith(".json") ? "json" : "markdown";
    parts.push(`===== ${name} =====\n\n\`\`\`${fence}\n${contents.trimEnd()}\n\`\`\``);
  }
  return parts.join("\n\n");
}
