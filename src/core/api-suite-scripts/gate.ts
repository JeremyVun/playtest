import type { DynamicValue } from "./types.ts";

// The HAR column of a script verdict (docs/contracts/scripts.md#verdict).
//
// N10: a script execution is judged in two columns — deterministic oracles over
// the recorded HAR, and the script's own check report — because P1 showed a
// single column is biased in whichever direction its applicability window
// happens to point (studies/api-probe/REPORT.md §3). This module is the first
// column, and it is the SHIPPED machinery: the Tier-1/2 invariant policies of
// ../invariants.ts, evaluated over a trace built from the HAR the proxy
// recorded. No new oracle vocabulary, no model, nothing the script can reach.
import { evaluateInvariant, parseInvariantPolicy, policyNeedsSpec, policySpec } from "../invariants.ts";
import { DummyConfigError } from "../config.ts";
import { policyObligationId } from "./obligations.ts";

/**
 * **Level 0** (DESIGN N6, S3 scope item 1): the spec-derived Tier-1/2 policy set
 * every script suite is judged against, on by default, with zero user input.
 * A user who approves no rule card at all still gets a real suite — these four
 * are its floor, they carry obligations into the manifest like any rule, and no
 * card, prompt, or model can switch one off.
 *
 * `no_server_error` needs nothing; the other three read the OpenAPI document, so
 * they are declared only when the run resolved a spec. Spec provisioning is a
 * configuration error rather than a degraded mode, so in practice all four are
 * always on.
 */
export const LEVEL_0_POLICIES: DynamicValue = Object.freeze(["no_server_error", "documented_status", "response_schema", "content_type"]);

/** The Level 0 policies that need no OpenAPI document. */
export const LEVEL_0_SPEC_FREE_POLICIES: DynamicValue = Object.freeze(["no_server_error"]);

/** @see LEVEL_0_POLICIES */
export function defaultScriptPolicies({ spec = null }: DynamicValue = {}) {
  const withSpec = spec?.operations?.length;
  return LEVEL_0_POLICIES.filter((policy: DynamicValue) => withSpec || LEVEL_0_SPEC_FREE_POLICIES.includes(policy)).map((policy: DynamicValue) => ({ policy }));
}

/**
 * HAR 1.2 (or the drivers' reduced shape) → the request trace the invariant
 * policies consume. Accepting both shapes keeps one adapter for scripts and for
 * any HAR a user hands the CLI.
 */
export function traceFromHar(entries: DynamicValue) {
  const out: DynamicValue = [];
  (entries ?? []).forEach((entry: DynamicValue, index: DynamicValue) => {
    const request = entry?.request ?? {};
    const response = entry?.response ?? {};
    const headers: DynamicValue = {};
    if (Array.isArray(request.headers)) {
      for (const header of request.headers) if (header?.name) headers[String(header.name).toLowerCase()] = String(header.value ?? "");
    } else if (request.headers && typeof request.headers === "object") {
      for (const [name, value] of Object.entries(request.headers)) headers[String(name).toLowerCase()] = String(value ?? "");
    }
    const responseHeaders: DynamicValue = {};
    if (Array.isArray(response.headers)) {
      for (const header of response.headers) if (header?.name) responseHeaders[String(header.name).toLowerCase()] = String(header.value ?? "");
    } else if (response.headers && typeof response.headers === "object") {
      for (const [name, value] of Object.entries(response.headers)) responseHeaders[String(name).toLowerCase()] = String(value ?? "");
    }
    let path = String(request.url ?? "");
    try {
      path = new URL(request.url).pathname;
    } catch {
      path = path.split("?")[0]!; // TODO(ts): splitting a string always yields a first segment
    }
    out.push({
      index,
      method: String(request.method ?? "GET").toUpperCase(),
      path,
      url: String(request.url ?? ""),
      status: Number(response.status ?? 0),
      mime: (response.content?.mimeType ?? response.mimeType ?? responseHeaders["content-type"] ?? "").split(";")[0].trim(),
      body: typeof response.body === "string" ? response.body : (response.content?.text ?? null),
      requestBody: typeof request.body === "string" ? request.body : (request.postData?.text ?? null),
      requestHeaders: headers,
      step: null,
    });
  });
  return out;
}

/**
 * Parse the declared policy list. A malformed declaration is user input, so it
 * is a DummyConfigError naming the policy — never a mid-run surprise.
 */
export function parseScriptPolicies(declarations: DynamicValue, { where = "gate.policies", spec = null }: DynamicValue = {}) {
  const out: DynamicValue = [];
  for (const declaration of declarations ?? []) {
    let parsed;
    try {
      parsed = parseInvariantPolicy(declaration);
    } catch (error: DynamicValue) {
      throw new DummyConfigError(`${where}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
    if (policyNeedsSpec(parsed.policy) && !spec?.operations?.length) {
      throw new DummyConfigError(
        `${where}: the ${parsed.policy} policy reads the OpenAPI document, so this run needs a resolved spec`,
      );
    }
    out.push({ declaration, parsed, spec: policySpec(declaration), obligation: policyObligationId(declaration) });
  }
  return out;
}

/**
 * Evaluate the HAR column. Applicability is an outcome: a declared policy that
 * matched no traffic FAILS, exactly as it does under `success:` in a journey
 * gate — and its obligation stays unaccounted, which is what makes an
 * under-exercised suite unsound rather than green.
 *
 * @returns {Promise<{ pass: boolean, checks: object[] }>}
 */
export async function evaluateScriptGate({ harEntries = [], policies = [], spec = null, match = null, trace = null }: DynamicValue) {
  const requests = trace ?? traceFromHar(harEntries);
  const checks: DynamicValue = [];
  for (const entry of policies) {
    let result;
    try {
      result = await evaluateInvariant(entry.parsed, { trace: requests, spec, match, observe: null });
    } catch (error: DynamicValue) {
      result = { applicable: true, pass: false, detail: `policy error: ${String(error?.message ?? error).split("\n")[0]}` };
    }
    const applicable = result.applicable !== false;
    checks.push({
      policy: entry.parsed.policy,
      tier: entry.parsed.tier,
      spec: entry.spec,
      obligation: entry.obligation,
      applicable,
      pass: applicable && result.pass !== false,
      detail: result.detail ?? "",
      // Evidence keyed into the HAR, the same handle a script's own checks use.
      har_entries: (result.requests ?? []).map((request) => request.index).filter((index) => Number.isInteger(index)),
    });
  }
  return { pass: checks.every((check: DynamicValue) => check.pass), checks };
}
