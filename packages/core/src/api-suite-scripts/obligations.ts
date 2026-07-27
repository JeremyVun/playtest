import type { DynamicValue } from "./types.ts";

// The coverage-obligation manifest and its accounting
// (docs/contracts/scripts.md#coverage-obligation-manifest).
//
// N5 in docs/backlog/api-testing/DESIGN.md: a suite terminates on SOUNDNESS, and
// soundness includes SUFFICIENCY. "Every authored check was exercised" certifies
// nothing if the suite authored two checks; what makes the claim honest is a
// manifest derived mechanically from the handout — approved rules, the Level 0
// policy set, and operation coverage — against which every obligation must end
// up covered, skipped for an approved reason, or marked unsupported. Anything
// else is UNACCOUNTED and the suite is unsound regardless of how many checks it
// ran.
//
// Nothing here consults a model, and nothing here is authored by the script: the
// manifest is an input to execution and the accounting is computed by the parent
// from the manifest, the recorded traffic, and the report.
import { pathTemplateToRegExp } from "../openapi.ts";
import { policySpec } from "../invariants.ts";
import { DummyConfigError } from "../config.ts";

interface AccountedObligation {
  [key: string]: DynamicValue;
  approved_skip_reasons: DynamicValue[];
}

/** Manifest shape version, carried in the report. */
export const OBLIGATION_MANIFEST_VERSION = 1;
/** Where an obligation came from. */
export const OBLIGATION_SOURCES: DynamicValue = Object.freeze(["policy", "operation", "rule"]);
/** Terminal accounting statuses. Only the first three are sound. */
export const OBLIGATION_STATUSES: DynamicValue = Object.freeze(["covered", "skipped", "unsupported", "unaccounted"]);

/** `policy:` id for one Level 0 policy declaration. */
export const policyObligationId = (declaration: DynamicValue) => `policy:${policySpec(declaration).replace(/^invariant:\s*/, "")}`;
/** `operation:` id for one spec operation. */
export const operationObligationId = (method: DynamicValue, path: DynamicValue) => `operation:${String(method).toUpperCase()} ${path}`;
/** `rule:` id for one approved rule statement. */
export const ruleObligationId = (id: DynamicValue) => `rule:${id}`;

/**
 * Derive the manifest mechanically from the handout inputs. No model, no
 * judgement: the same inputs always produce the same obligation ids, which is
 * what lets an approval screen say "9 of 9 operations, 6 of 6 rules".
 *
 * @param {{ policies?: object[], spec?: object|null, rules?: object[],
 *           operations?: {method: string, path: string}[] }} handout
 * @returns {object[]} manifest entries
 */
export function deriveObligations({ policies = [], spec = null, rules = [], operations = null }: DynamicValue = {}) {
  const out: DynamicValue = [];
  const seen: DynamicValue = new Set();
  const add = (entry: DynamicValue) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const declaration of policies ?? []) {
    add({
      id: policyObligationId(declaration),
      source: "policy",
      statement: `the ${declaration.policy} policy holds over this execution's traffic`,
    });
  }

  const ops = operations ?? spec?.operations ?? [];
  for (const op of ops) {
    if (!op?.method || !op?.path) continue;
    add({
      id: operationObligationId(op.method, op.path),
      source: "operation",
      statement: `${String(op.method).toUpperCase()} ${op.path} is exercised`,
    });
  }

  for (const rule of rules ?? []) {
    const id = rule?.id ?? rule?.statement;
    if (!id) continue;
    add({
      id: ruleObligationId(id),
      source: "rule",
      statement: String(rule.statement ?? id),
      ...(rule.applicability ? { applicability: String(rule.applicability) } : {}),
      ...(Array.isArray(rule.approved_skip_reasons) ? { approved_skip_reasons: [...rule.approved_skip_reasons] } : {}),
      ...(rule.unsupported ? { unsupported: true } : {}),
    });
  }
  return out;
}

/**
 * Validate a manifest supplied by a caller. Shape problems are user input, so
 * they surface as DummyConfigError rather than as a mid-run failure.
 */
export function normalizeObligations(entries: DynamicValue, { where = "obligations" }: DynamicValue = {}) {
  if (entries === null || entries === undefined) return [];
  if (!Array.isArray(entries)) throw new DummyConfigError(`${where} must be a list of obligation entries`);
  const out: DynamicValue = [];
  const seen: DynamicValue = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DummyConfigError(`${where}: each entry is an object { id, source, statement }`);
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new DummyConfigError(`${where}: each entry needs a non-empty "id"`);
    if (seen.has(id)) throw new DummyConfigError(`${where}: duplicate obligation id ${JSON.stringify(id)}`);
    seen.add(id);
    const source = entry.source ?? id.split(":")[0];
    if (!OBLIGATION_SOURCES.includes(source)) {
      throw new DummyConfigError(`${where}: obligation ${JSON.stringify(id)} has source ${JSON.stringify(source)} (expected ${OBLIGATION_SOURCES.join(", ")})`);
    }
    if (entry.approved_skip_reasons !== undefined && !Array.isArray(entry.approved_skip_reasons)) {
      throw new DummyConfigError(`${where}: obligation ${JSON.stringify(id)} approved_skip_reasons must be a list of strings`);
    }
    out.push({
      id,
      source,
      statement: String(entry.statement ?? id),
      ...(entry.applicability ? { applicability: String(entry.applicability) } : {}),
      ...(entry.approved_skip_reasons ? { approved_skip_reasons: entry.approved_skip_reasons.map(String) } : {}),
      ...(entry.unsupported ? { unsupported: true } : {}),
    });
  }
  return out;
}

const normalizeReason = (reason: DynamicValue) => String(reason ?? "").trim().toLowerCase();

/**
 * Account every obligation. Pure.
 *
 * @param {{ obligations: object[], records: object[], trace: {method: string, path: string}[],
 *           gateChecks?: {obligation?: string, applicable: boolean}[] }} input
 * @returns {{ entries: object[], summary: object, sound: boolean, reasons: string[],
 *             unknown: {obligation: string, from: string}[] }}
 *   `unknown` lists report records citing an obligation id the manifest does not
 *   contain — a script defect, because every report entry must trace to one.
 */
export function accountObligations({ obligations = [], records = [], trace = [], gateChecks = [] }: DynamicValue) {
  const state: DynamicValue = new Map(
    obligations.map((entry: DynamicValue) => [
      entry.id,
      {
        ...entry,
        status: entry.unsupported ? "unsupported" : "unaccounted",
        checks: [],
        ...(entry.unsupported ? { reason: "declared unsupported by the manifest" } : {}),
      },
    ]),
  );
  const unknown: DynamicValue = [];

  // 1. Report records. Every record that names an obligation must name a real one.
  for (const record of records ?? []) {
    if (!record?.obligation) continue;
    const entry: AccountedObligation | undefined = state.get(record.obligation);
    if (!entry) {
      unknown.push({ obligation: record.obligation, from: record.kind === "check" ? `check "${record.id}"` : `${record.kind} record` });
      continue;
    }
    if (record.kind === "check") {
      entry.checks.push(record.id);
      if (record.exercised !== false && entry.status !== "covered") {
        entry.status = "covered";
        delete entry.reason;
      }
      continue;
    }
    if (record.kind === "skip" || record.kind === "unsupported") {
      if (entry.status === "covered") continue;
      const approved = (entry.approved_skip_reasons ?? []).map(normalizeReason);
      if (approved.includes(normalizeReason(record.reason))) {
        entry.status = record.kind === "skip" ? "skipped" : "unsupported";
        entry.reason = record.reason;
      } else {
        entry.status = "unaccounted";
        entry.reason =
          `${record.kind === "skip" ? "skipped" : "marked unsupported"} with the unapproved reason ${JSON.stringify(record.reason)}` +
          (approved.length ? ` (approved: ${entry.approved_skip_reasons.map((r) => JSON.stringify(r)).join(", ")})` : " — this obligation approves no skip reason");
      }
    }
  }

  // 2. Policy obligations are covered by the gate finding them APPLICABLE: a
  //    policy that matched no traffic has not been exercised (the P4 rule).
  for (const check of gateChecks ?? []) {
    const entry = check?.obligation ? state.get(check.obligation) : null;
    if (!entry) continue;
    if (check.applicable) {
      entry.status = "covered";
      delete entry.reason;
    } else if (entry.status === "unaccounted") {
      entry.reason = `the policy matched no recorded request, so it was never exercised: ${check.detail ?? ""}`.trim();
    }
  }

  // 3. Operation obligations are covered by traffic: the HAR is the evidence.
  const templates: DynamicValue = [];
  for (const entry of state.values()) {
    if (entry.source !== "operation" || entry.status === "covered") continue;
    const match = entry.id.replace(/^operation:/, "").match(/^([A-Z]+)\s+(\/\S*)$/);
    if (!match) continue;
    templates.push({ entry, method: match[1], template: pathTemplateToRegExp(match[2]) });
  }
  if (templates.length) {
    for (const request of trace ?? []) {
      for (const candidate of templates) {
        if (candidate.entry.status === "covered") continue;
        if (request.method === candidate.method && candidate.template.test(request.path)) {
          candidate.entry.status = "covered";
          delete candidate.entry.reason;
        }
      }
    }
  }

  const entries = [...state.values()];
  const summary: DynamicValue = { total: entries.length, covered: 0, skipped: 0, unsupported: 0, unaccounted: 0 };
  for (const entry of entries) summary[entry.status] += 1;
  const reasons: DynamicValue = [];
  for (const entry of entries) {
    if (entry.status !== "unaccounted") continue;
    reasons.push(`obligation ${entry.id} is unaccounted — ${entry.reason ?? "no check traced to it and it was not skipped with an approved reason"}`);
  }
  for (const miss of unknown) {
    reasons.push(`${miss.from} traces to obligation ${JSON.stringify(miss.obligation)}, which is not in the manifest`);
  }
  return { entries, summary, sound: reasons.length === 0, reasons, unknown };
}
