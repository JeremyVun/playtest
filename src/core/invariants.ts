// Tier-1/2 API invariant policies (docs/contracts/engine.md#invariant-policies).
//
// The gate's `invariant:` kind dispatches here. Two tiers ship:
//
//   Tier 1 — protocol/spec checks driven by the enriched OpenAPI document
//     (openapi.ts): documented statuses, response schema, content type, and
//     "no unexpected 5xx". Table stakes, free once a spec is configured.
//   Tier 2 — opt-in parameterized metamorphic policies: round-trip,
//     idempotency, lifecycle/delete, pagination, and error-shape consistency.
//     Each declares WHERE it applies and its preconditions; none is universal.
//
// Three rules hold for every policy, and they are the whole design:
//
//   1. **Deterministic.** A policy reads the recorded trace (and, at most, its
//      own read-only observations). No model is ever consulted, so a policy can
//      never author CI truth from a guess.
//   2. **Passive plus read-only observation.** A policy validates what the story
//      already did. It may declare read-only observation requests executed in
//      the gate's observe phase; it NEVER issues a mutation. Sequences needing
//      extra mutations (an idempotency repeat, a second DELETE) are checked only
//      when the story's own trace contains them.
//   3. **Applicability is an outcome.** Every evaluation reports `applicable`
//      separately from `pass`. Declared under `success:`, a policy with no
//      qualifying trace FAILS with an actionable detail — a declared invariant
//      that was never exercised has not held, and a heal that went green without
//      exercising it would have proven nothing. Declared under `observe:`, the
//      same result is advisory and never gates.
//
// None of the three mentions a transport, and none of them may: the same
// policies evaluate over a WEB run's recorded HAR — "the UI looked fine; did the
// API underneath behave?" — where the trace is what the page's own requests
// produced rather than what the story typed
// (docs/contracts/engine.md#invariant-policies). Web evaluation is strictly
// passive: `ctx.observe` is an api-driver capability, because a page's requests
// carry session state a synthetic GET would not reproduce.
//
// A violating result also carries `requests` — the recorded entries the verdict
// is about — so the gate can cite the STEP whose action produced them. Policies
// never format that link themselves; gate.js maps requests to steps through the
// step envelope's `artifacts.har_entries`.
//
// Everything here is pure except `evaluate`, which may call `ctx.observe` (a
// read-only GET issuer the runner supplies for the api driver).
import Ajv from "ajv";

import { pathSegments, readAt, statusMatchesPattern, statusesEquivalent } from "./match.ts";
import type { MatchNode, PathSegment } from "./match.ts";
import { pathTemplateToRegExp } from "./openapi.ts";
import type { EnrichedOpenApi, OpenApiOperation, OpenApiSchema } from "./openapi.ts";
import type {
  InvariantPolicyName,
  ResolvedMatch,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface OperationRef {
  method: string;
  path: string;
  template: RegExp;
}

export interface ParsedInvariantPolicy {
  policy: InvariantPolicyName;
  tier: number;
  scope?: OperationRef;
  op: OperationRef;
  create: OperationRef;
  read: OperationRef;
  delete: OperationRef;
  fields: string[];
  require: string[];
  ignore?: string[];
  identity: string;
  cursor?: string;
  state?: string;
  key_header?: string;
  after?: number[];
  exclude_status?: number[];
  compare?: string[];
  consistency?: "snapshot" | "eventual";
  read_from: Record<string, string>;
  observe?: boolean;
}

export interface InvariantTraceRequest {
  index: number;
  method: string;
  path: string;
  status: number;
  mime: string;
  body?: MatchNode;
  requestBody?: MatchNode;
  requestHeaders?: Record<string, string>;
  observation?: boolean;
  [key: string]: unknown;
}

export interface InvariantResult {
  applicable: boolean;
  pass: boolean;
  detail: string;
  requests?: InvariantTraceRequest[];
}

export interface InvariantContext {
  trace: InvariantTraceRequest[];
  spec: EnrichedOpenApi | null;
  match: ResolvedMatch | null;
  observe:
    | ((request: { method: string; path: string }) => Promise<{
        status: number;
        body?: MatchNode;
      } | null>)
    | null;
}

interface PolicyDefinition {
  tier: number;
  keys: string[];
  required: string[];
  spec: boolean;
  observation?: boolean;
  evaluate: (
    config: ParsedInvariantPolicy,
    ctx: InvariantContext
  ) => InvariantResult | Promise<InvariantResult>;
}

/** Statuses excluded from error-shape checks by default: auth and throttling. */
export const ERROR_SHAPE_DEFAULT_EXCLUSIONS = [401, 403, 407, 429];
/** Statuses a lifecycle policy accepts after a delete unless the case declares otherwise. */
export const LIFECYCLE_DEFAULT_AFTER = [404, 410];
/** Consistency models the pagination policy accepts. */
export const PAGINATION_CONSISTENCY = ["snapshot", "eventual"];

// Response schemas come from the resolved OpenAPI document, which legitimately
// carries OpenAPI-only keywords (nullable, example, discriminator) and, for a
// recursive model, openapi.ts's `$ref_cycle` marker. strict:false makes Ajv
// ignore the vocabulary it does not own instead of refusing to compile; a schema
// carrying a cycle marker is skipped outright (see schemaIsValidatable).
// @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor as a module namespace.
const schemaAjv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const compiledSchemas = new Map<string, ReturnType<typeof schemaAjv.compile>>();

// ---- policy registry ----

/**
 * Every policy: its tier, the keys it accepts, the keys it requires, whether it
 * needs an OpenAPI document, and its evaluator. `evaluate` returns
 * `{ applicable, pass, detail }` — `pass` is the verdict GIVEN applicability, so
 * a not-applicable result reports `pass: true` here and the gate turns it into a
 * failure only when the policy was declared under `success:`.
 */
const POLICIES: Record<InvariantPolicyName, PolicyDefinition> = {
  // ---- Tier 1: protocol and spec ----
  no_server_error: {
    tier: 1,
    keys: ["scope"],
    required: [],
    spec: false,
    evaluate: (config, ctx) => {
      const reqs = inScope(ctx.trace, config.scope);
      if (!reqs.length) return notApplicable(`no request matched ${scopeLabel(config.scope)}, so "no unexpected 5xx" was never exercised`);
      const broken: InvariantTraceRequest[] & { 0: InvariantTraceRequest } = reqs.filter((r) => r.status >= 500) as InvariantTraceRequest[] & { 0: InvariantTraceRequest }; // TODO(ts): broken[0] is read only on the non-empty branch below
      return {
        applicable: true,
        pass: broken.length === 0,
        requests: broken,
        detail: broken.length
          ? `${broken.length} server error(s), e.g. ${broken[0].method} ${broken[0].path} → ${broken[0].status}`
          : `${reqs.length} response(s), none 5xx`,
      };
    },
  },

  documented_status: {
    tier: 1,
    keys: ["scope"],
    required: [],
    spec: true,
    evaluate: (config, ctx) => {
      const operations = ctx.spec?.operations;
      if (!Array.isArray(operations)) return notApplicable("no OpenAPI document is configured (app.openapi), so no status is documented");
      const checked = [];
      const undocumented = [];
      for (const r of inScope(ctx.trace, config.scope)) {
        const op = operationFor(operations, r);
        if (!op || !op.status_codes.length) continue; // the spec says nothing: nothing to check
        checked.push(r);
        if (!op.status_codes.some((code) => statusMatchesPattern(code, r.status))) {
          undocumented.push({ r, op });
        }
      }
      if (!checked.length) {
        return notApplicable(
          `no recorded request matched a spec operation${config.scope ? ` under ${scopeLabel(config.scope)}` : ""} that declares status codes` +
            " — the story never called a documented operation",
        );
      }
      const first = undocumented[0];
      return {
        applicable: true,
        pass: undocumented.length === 0,
        requests: undocumented.map((u) => u.r),
        detail: first
          ? `${first.r.method} ${first.r.path} answered ${first.r.status}, which the spec does not declare for ${first.op.method} ${first.op.path}` +
            ` (declared: ${first.op.status_codes.join(", ")})`
          : `${checked.length} response(s) carried a documented status`,
      };
    },
  },

  response_schema: {
    tier: 1,
    keys: ["scope"],
    required: [],
    spec: true,
    evaluate: (config, ctx) => {
      const operations = ctx.spec?.operations;
      if (!Array.isArray(operations)) return notApplicable("no OpenAPI document is configured (app.openapi), so no response schema is declared");
      const checked = [];
      const failures = [];
      for (const r of inScope(ctx.trace, config.scope)) {
        const op = operationFor(operations, r);
        const schema = responseSchemaFor(op, r);
        if (!schema || r.body == null) continue;
        let json;
        try {
          json = JSON.parse(r.body as string);
        } catch {
          continue; // a non-JSON body has no JSON schema to validate against
        }
        checked.push(r);
        const errors = validateAgainst(schema, json);
        if (errors) failures.push({ r, errors });
      }
      if (!checked.length) {
        return notApplicable(
          `no recorded response matched a spec operation${config.scope ? ` under ${scopeLabel(config.scope)}` : ""} that declares a JSON response schema`,
        );
      }
      const first = failures[0];
      return {
        applicable: true,
        pass: failures.length === 0,
        requests: failures.map((f) => f.r),
        detail: first
          ? `${first.r.method} ${first.r.path} → ${first.r.status} does not match its declared schema: ${first.errors}`
          : `${checked.length} response(s) matched their declared schema`,
      };
    },
  },

  content_type: {
    tier: 1,
    keys: ["scope"],
    required: [],
    spec: true,
    evaluate: (config, ctx) => {
      const operations = ctx.spec?.operations;
      if (!Array.isArray(operations)) return notApplicable("no OpenAPI document is configured (app.openapi), so no media type is declared");
      const checked = [];
      const wrong = [];
      for (const r of inScope(ctx.trace, config.scope)) {
        const op = operationFor(operations, r);
        const declared = Object.keys(op?.responses?.[String(r.status)]?.content ?? {});
        if (!declared.length) continue;
        checked.push(r);
        if (!declared.includes(r.mime)) wrong.push({ r, declared });
      }
      if (!checked.length) {
        return notApplicable(`no recorded response matched a spec operation${config.scope ? ` under ${scopeLabel(config.scope)}` : ""} that declares a media type`);
      }
      const first = wrong[0];
      return {
        applicable: true,
        pass: wrong.length === 0,
        requests: wrong.map((w) => w.r),
        detail: first
          ? `${first.r.method} ${first.r.path} → ${first.r.status} answered ${first.r.mime || "(no content-type)"}, not the declared ${first.declared.join(", ")}`
          : `${checked.length} response(s) carried a declared media type`,
      };
    },
  },

  // ---- Tier 2: metamorphic policies ----
  round_trip: {
    tier: 2,
    keys: ["create", "read", "fields", "read_from", "observe"],
    required: ["create", "read", "fields"],
    spec: false,
    observation: true,
    evaluate: async (config, ctx) => {
      const creates = matching(ctx.trace, config.create).filter((r) => r.status >= 200 && r.status < 300 && jsonOf(r.requestBody) !== undefined);
      if (!creates.length) {
        return notApplicable(
          `the story never made a successful ${opLabel(config.create)} carrying a JSON body, so the round-trip policy was never exercised` +
            " — add that write to the story, or move this policy under observe:",
        );
      }
      const create = creates[creates.length - 1]!; // TODO(ts): the non-empty check above proves the last create exists
      const sent = jsonOf(create.requestBody);
      // Passive first: a read of the same operation later in the story.
      let read = matching(ctx.trace, config.read).find((r) => r.index > create.index && r.status >= 200 && r.status < 300 && r.body != null);
      let observed = false;
      if (!read && config.observe) {
        const request = observationRequest(config, create);
        if (!request) {
          return notApplicable(
            `the round-trip read-back could not be addressed: read_from did not resolve ${opLabel(config.read)}'s parameters from the ${opLabel(config.create)} response`,
          );
        }
        if (typeof ctx.observe !== "function") {
          return notApplicable("this policy declares a read-only observation, but the gate has no observation channel on this driver");
        }
        const res = await ctx.observe(request);
        observed = true;
        if (!res || res.status < 200 || res.status >= 300 || res.body == null) {
          return notApplicable(`the observation ${request.method} ${request.path} answered ${res?.status ?? "(no response)"}, so there was nothing to read back`);
        }
        read = { method: request.method, path: request.path, status: res.status, body: res.body, observation: true } as InvariantTraceRequest;
      }
      if (!read) {
        return notApplicable(
          `the story never read ${opLabel(config.read)} back after ${opLabel(config.create)}, so the round-trip policy was never exercised` +
            " — add the read-back to the story, or declare observe: true on this policy",
        );
      }
      const got = jsonOf(read.body);
      if (got === undefined) return notApplicable(`the ${opLabel(config.read)} read-back did not answer JSON, so no field could be compared`);
      const mismatches = [];
      for (const field of config.fields) {
        const segs = pathSegments(field);
        const want = readAt(sent, segs);
        if (want === undefined) continue; // the write never carried this client-owned field
        const have = readAt(got, segs);
        if (JSON.stringify(want) !== JSON.stringify(have)) mismatches.push({ field, want, have });
      }
      const compared = config.fields.filter((f) => readAt(sent, pathSegments(f)) !== undefined);
      if (!compared.length) {
        return notApplicable(`the recorded ${opLabel(config.create)} body carried none of the declared fields (${config.fields.join(", ")}), so nothing round-tripped`);
      }
      const first = mismatches[0];
      return {
        applicable: true,
        pass: mismatches.length === 0,
        // The write and, when the story itself contained it, the read-back. An
        // OBSERVATION read-back belongs to no step, so it is left out rather
        // than attributed to one.
        requests: mismatches.length ? [create, ...(read.observation ? [] : [read])] : [],
        detail: first
          ? `${first.field} was written as ${JSON.stringify(first.want)} but read back as ${first.have === undefined ? "(absent)" : JSON.stringify(first.have)}`
          : `${compared.length} client-owned field(s) survived ${opLabel(config.create)} → ${opLabel(config.read)}${observed ? " (read back by observation)" : ""}`,
      };
    },
  },

  idempotency: {
    tier: 2,
    keys: ["op", "key_header", "compare", "ignore"],
    required: ["op"],
    spec: false,
    evaluate: (config, ctx) => {
      const calls = matching(ctx.trace, config.op);
      // A "repeat" is the same operation sent with the same request body and,
      // when the case names one, the same idempotency key header. Two unrelated
      // POSTs to the same path are not a repeat, so they never make the policy
      // applicable — this is what keeps it from passing on an unexercised story.
      const groups = new Map();
      for (const r of calls) {
        const key = repeatKey(r, config.key_header);
        if (key === null) continue;
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
      }
      const repeats = [...groups.values()].filter((g) => g.length > 1);
      if (!repeats.length) {
        const keyed = config.key_header ? ` with the same ${config.key_header}` : " with the same body";
        return notApplicable(
          `the story never repeats ${opLabel(config.op)}${keyed}, so the idempotency policy was never exercised` +
            " — repeat the call in the story, or move this policy under observe:",
        );
      }
      const compare = config.compare ?? ["status", "body"];
      for (const group of repeats) {
        const first = group[0];
        for (const later of group.slice(1)) {
          if (compare.includes("status") && !statusesEquivalent(first.status, later.status, ctx.match)) {
            return {
              applicable: true,
              pass: false,
              requests: [first, later],
              detail:
                `repeating ${opLabel(config.op)} answered ${later.status} where the first call answered ${first.status}` +
                " — declare them interchangeable under match.status_equivalent if that is the API's intent",
            };
          }
          if (compare.includes("body")) {
            const a = normalizedBody(first.body, config.ignore);
            const b = normalizedBody(later.body, config.ignore);
            if (JSON.stringify(a) !== JSON.stringify(b)) {
              return {
                applicable: true,
                pass: false,
                requests: [first, later],
                detail: `repeating ${opLabel(config.op)} reached a different normalized state: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
              };
            }
          }
        }
      }
      return { applicable: true, pass: true, detail: `${repeats.length} repeated ${opLabel(config.op)} call(s) reached an equivalent normalized state` };
    },
  },

  lifecycle: {
    tier: 2,
    keys: ["delete", "read", "after", "state"],
    required: ["delete", "read"],
    spec: false,
    evaluate: (config, ctx) => {
      const after = (config.after ?? LIFECYCLE_DEFAULT_AFTER).map(String);
      const deletes = matching(ctx.trace, config.delete).filter((r) => r.status >= 200 && r.status < 300);
      if (!deletes.length) {
        return notApplicable(
          `the story never completed a ${opLabel(config.delete)}, so the lifecycle policy was never exercised` +
            " — delete the resource in the story, or move this policy under observe:",
        );
      }
      const gone = deletes[deletes.length - 1]!; // TODO(ts): the non-empty check above proves the last delete exists
      const reads = matching(ctx.trace, config.read).filter((r) => r.index > gone.index && samePath(r.path, gone.path));
      if (!reads.length) {
        return notApplicable(
          `the story never read ${opLabel(config.read)} back after ${opLabel(config.delete)}, so the lifecycle policy was never exercised` +
            " — read the resource back after deleting it",
        );
      }
      for (const r of reads) {
        if (!after.some((code) => statusMatchesPattern(code, r.status))) {
          return {
            applicable: true,
            pass: false,
            requests: [gone, r],
            detail:
              `${r.method} ${r.path} answered ${r.status} after the delete, which is not one of the declared ${after.join(", ")}` +
              " — soft-delete, tombstones, and retention are legitimate; declare them with after: and state:",
          };
        }
        if (config.state && r.status >= 200 && r.status < 300) {
          const json = jsonOf(r.body);
          const verdict = matchExpression(config.state, json);
          if (!verdict.pass) {
            return { applicable: true, pass: false, requests: [gone, r], detail: `${r.method} ${r.path} survived the delete but ${verdict.detail}` };
          }
        }
      }
      return { applicable: true, pass: true, detail: `${reads.length} read(s) after ${opLabel(config.delete)} answered ${after.join("/")} as declared` };
    },
  },

  pagination: {
    tier: 2,
    keys: ["op", "identity", "cursor", "consistency"],
    required: ["op", "identity"],
    spec: false,
    evaluate: (config, ctx) => {
      const pages = matching(ctx.trace, config.op).filter((r) => r.status >= 200 && r.status < 300 && r.body != null);
      if (pages.length < 2) {
        return notApplicable(
          `the story walked ${pages.length} page(s) of ${opLabel(config.op)}; a pagination policy needs at least two` +
            " — follow the cursor in the story, or move this policy under observe:",
        );
      }
      const consistency = config.consistency ?? "snapshot";
      const segs = pathSegments(config.identity);
      const seen = new Map<string, number>(); // identity -> page ordinal
      const duplicates: Array<{ id: MatchNode; first: number; again: number }> = [];
      pages.forEach((page, i) => {
        for (const id of collectAt(jsonOf(page.body), segs)) {
          const key = JSON.stringify(id);
          if (seen.has(key)) duplicates.push({ id, first: seen.get(key)!, again: i + 1 }); // TODO(ts): has() proves the first-seen page exists
          else seen.set(key, i + 1);
        }
      });
      // Cursor progression: each page's cursor must be new, and the enumeration
      // must terminate (the last page carries none).
      const cursorProblems: Array<{ detail: string; request: InvariantTraceRequest | undefined }> = []; // { detail, request } — the page the problem is about
      if (config.cursor) {
        const cursorSegs = pathSegments(config.cursor);
        const cursors = pages.map((p) => readAt(jsonOf(p.body), cursorSegs));
        const cursorSeen = new Set();
        cursors.forEach((c, i) => {
          if (c === undefined || c === null) return;
          const key = JSON.stringify(c);
          if (cursorSeen.has(key)) cursorProblems.push({ detail: `page ${i + 1} repeated cursor ${key} — the enumeration does not progress`, request: pages[i] });
          cursorSeen.add(key);
        });
        const last = cursors[cursors.length - 1];
        if (last !== undefined && last !== null) {
          cursorProblems.push({
            detail: `the last page still carries cursor ${JSON.stringify(last)} — the enumeration never terminated`,
            request: pages[pages.length - 1],
          });
        }
      }
      // Under an eventual-consistency model a concurrent write may legitimately
      // repeat a boundary item; only non-termination is a violation there.
      const dupFails = consistency === "snapshot" && duplicates.length > 0;
      if (dupFails) {
        const d = duplicates[0]!; // TODO(ts): this branch is guarded by duplicates.length
        return {
          applicable: true,
          pass: false,
          requests: [pages[d.first - 1]!, pages[d.again - 1]!], // TODO(ts): duplicate page numbers were recorded from these same array indices
          detail:
            `identity ${JSON.stringify(d.id)} appeared on page ${d.first} and again on page ${d.again} of ${opLabel(config.op)}` +
            ` — under the declared "snapshot" consistency an enumeration never repeats an item (declare consistency: eventual if it may)`,
        };
      }
      if (cursorProblems.length) return { applicable: true, pass: false, requests: [cursorProblems[0]!.request!], detail: cursorProblems[0]!.detail }; // TODO(ts): the length guard and problem construction prove both values exist
      const note = duplicates.length ? ` (${duplicates.length} boundary repeat(s) allowed under "eventual" consistency)` : "";
      return { applicable: true, pass: true, detail: `${pages.length} page(s), ${seen.size} distinct identities, no violation${note}` };
    },
  },

  error_shape: {
    tier: 2,
    keys: ["require", "scope", "exclude_status"],
    required: ["require"],
    spec: false,
    evaluate: (config, ctx) => {
      const excluded = (config.exclude_status ?? ERROR_SHAPE_DEFAULT_EXCLUSIONS).map(String);
      const errors = inScope(ctx.trace, config.scope).filter(
        (r) => r.status >= 400 && r.status < 500 && !excluded.some((code) => statusMatchesPattern(code, r.status)),
      );
      if (!errors.length) {
        return notApplicable(
          `the story produced no 4xx response outside the excluded ${excluded.join(", ")}, so the error-shape policy was never exercised` +
            " — make the story provoke a refusal, or move this policy under observe:",
        );
      }
      for (const r of errors) {
        const json = jsonOf(r.body);
        if (json === undefined) {
          return { applicable: true, pass: false, requests: [r], detail: `${r.method} ${r.path} → ${r.status} did not answer a JSON error body` };
        }
        for (const field of config.require) {
          const value = readAt(json, pathSegments(field));
          if (value === undefined || value === null || value === "") {
            return { applicable: true, pass: false, requests: [r], detail: `${r.method} ${r.path} → ${r.status} is missing ${field} from the declared error envelope` };
          }
        }
      }
      return { applicable: true, pass: true, detail: `${errors.length} 4xx response(s) carried ${config.require.join(", ")}` };
    },
  },
};

/** Every policy name, in registry order. */
export const POLICY_NAMES = Object.keys(POLICIES);
/** Which tier each policy belongs to (DESIGN §5.2). */
export const POLICY_TIERS = Object.fromEntries(Object.entries(POLICIES).map(([name, p]) => [name, p.tier]));

// ---- configuration ----

const OP_RE = /^([A-Za-z]+)\s+(\/\S*)$/;

function parseOp(raw: unknown, field: string): OperationRef {
  const m = String(raw ?? "").trim().match(OP_RE);
  if (!m) {
    throw new Error(`"invariant.${field}" must be a method and an OpenAPI-style path, e.g. "POST /accounts/{accountId}/close" (got ${JSON.stringify(raw ?? null)})`);
  }
  return { method: m[1]!.toUpperCase(), path: m[2]!, template: pathTemplateToRegExp(m[2]!) }; // TODO(ts): the successful regex match guarantees both capture groups
}

function stringList(value: unknown, field: string): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.length || list.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`"invariant.${field}" must be a non-empty list of strings (got ${JSON.stringify(value ?? null)})`);
  }
  return list.map((v) => v.trim());
}

function statusList(value: unknown, field: string): number[] {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) throw new Error(`"invariant.${field}" must list at least one status`);
  return list.map((s) => {
    if (!/^\d{3}$/.test(String(s).trim())) throw new Error(`"invariant.${field}" has ${JSON.stringify(s)}, which is not a three-digit status`);
    return Number(String(s).trim());
  });
}

/**
 * Validate and normalize an `invariant:` value into the config a policy
 * evaluates. Throws a plain Error naming the problem; config.ts wraps it into a
 * DummyConfigError naming the case file, so a malformed policy is caught at
 * discovery rather than at the end of a run. Pure; exported for test.
 * @returns {{ policy: string, tier: number, ... }}
 */
export function parseInvariantPolicy(value: unknown): ParsedInvariantPolicy {
  if (!isRecord(value)) {
    throw new Error(`"invariant" takes a policy object, e.g. { policy: no_server_error } (got ${JSON.stringify(value ?? null)})`);
  }
  const name: InvariantPolicyName = value.policy as InvariantPolicyName;
  const policy = POLICIES[name];
  if (!policy) {
    throw new Error(`unknown invariant policy ${JSON.stringify(name ?? null)} — the vocabulary is ${POLICY_NAMES.join(", ")}`);
  }
  const allowed = new Set(["policy", ...policy.keys]);
  const extra = Object.keys(value).filter((k) => !allowed.has(k));
  if (extra.length) throw new Error(`unknown key(s) ${extra.join(", ")} on invariant policy "${name}" (expected ${[...allowed].join(", ")})`);
  for (const key of policy.required) {
    if (value[key] === undefined) throw new Error(`invariant policy "${name}" needs "${key}"`);
  }
  const out: Partial<ParsedInvariantPolicy> = { policy: name, tier: policy.tier };
  if (value.scope !== undefined) out.scope = parseOp(value.scope, "scope");
  for (const key of ["op", "create", "read", "delete"] as Array<"op" | "create" | "read" | "delete">) {
    if (value[key] !== undefined) out[key] = parseOp(value[key], key);
  }
  if (value.fields !== undefined) out.fields = stringList(value.fields, "fields");
  if (value.require !== undefined) out.require = stringList(value.require, "require");
  if (value.ignore !== undefined) out.ignore = stringList(value.ignore, "ignore");
  if (value.identity !== undefined) out.identity = stringList(value.identity, "identity")[0]!; // TODO(ts): stringList rejects an empty list
  if (value.cursor !== undefined) out.cursor = stringList(value.cursor, "cursor")[0]!; // TODO(ts): stringList rejects an empty list
  if (value.state !== undefined) out.state = stringList(value.state, "state")[0]!; // TODO(ts): stringList rejects an empty list
  if (value.key_header !== undefined) out.key_header = stringList(value.key_header, "key_header")[0]!; // TODO(ts): stringList rejects an empty list
  if (value.after !== undefined) out.after = statusList(value.after, "after");
  if (value.exclude_status !== undefined) out.exclude_status = statusList(value.exclude_status, "exclude_status");
  if (value.compare !== undefined) {
    out.compare = stringList(value.compare, "compare");
    const bad = out.compare.filter((c) => !["status", "body"].includes(c));
    if (bad.length) throw new Error(`"invariant.compare" accepts status and/or body (got ${bad.join(", ")})`);
  }
  if (value.consistency !== undefined) {
    if (typeof value.consistency !== "string" || !PAGINATION_CONSISTENCY.includes(value.consistency)) {
      throw new Error(`"invariant.consistency" must be one of ${PAGINATION_CONSISTENCY.join(", ")} (got ${JSON.stringify(value.consistency)})` +
        " — exact totals and no-skips hold only under a promised snapshot model");
    }
    out.consistency = value.consistency as "snapshot" | "eventual";
  }
  if (value.read_from !== undefined) {
    if (!isRecord(value.read_from)) {
      throw new Error('"invariant.read_from" maps each read path parameter to a field of the create response, e.g. { accountId: "$.id" }');
    }
    out.read_from = { ...value.read_from } as Record<string, string>; // SAFETY: config schema validation requires string-valued read mappings.
  }
  if (value.observe !== undefined) {
    if (typeof value.observe !== "boolean") throw new Error('"invariant.observe" is a boolean: may this policy issue its own read-only GET when the story did not?');
    if (!policy.observation && value.observe) throw new Error(`invariant policy "${name}" declares no observation request, so "observe" does not apply to it`);
    out.observe = value.observe;
  }
  if (out.observe && !out.read_from) {
    throw new Error(`invariant policy "${name}" with observe: true needs "read_from" so the observation request can be addressed, e.g. { accountId: "$.id" }`);
  }
  return out as ParsedInvariantPolicy; // TODO(ts): policy-specific required fields were checked against the selected definition above
}

/** A stable, readable one-line spec string used as the gate check's key. */
export function policySpec(value: unknown): string {
  if (!isRecord(value)) return `invariant: ${value}`;
  const parts = [String(value.policy ?? "?")];
  for (const key of ["scope", "op", "create", "read", "delete"]) {
    if (value[key] !== undefined) parts.push(`${key}=${String(value[key]).trim()}`);
  }
  if (value.identity !== undefined) parts.push(`identity=${value.identity}`);
  if (value.fields !== undefined) {
    const fields = Array.isArray(value.fields) ? value.fields : [value.fields];
    parts.push(`fields=${fields.join("+")}`);
  }
  return `invariant: ${parts.join(" ")}`;
}

/** Does this policy read the enriched OpenAPI document? (Tier-1 checks do.) */
export function policyNeedsSpec(name: InvariantPolicyName): boolean {
  return Boolean(POLICIES[name]?.spec);
}

// ---- evaluation ----

/**
 * Evaluate one parsed policy against the recorded trace.
 * @param {object} config parseInvariantPolicy output
 * @param {{ trace: object[], spec: object|null, match: object|null,
 *          observe: ((req: {method:string, path:string}) => Promise<object>)|null }} ctx
 * @returns {Promise<{ applicable: boolean, pass: boolean, detail: string,
 *                     requests?: object[] }>} `requests` are the recorded trace
 *   entries a violation is about; gate.js turns them into the check's step
 *   citation and never persists them.
 */
export async function evaluateInvariant(
  config: ParsedInvariantPolicy,
  ctx: InvariantContext
): Promise<InvariantResult> {
  const policy = POLICIES[config.policy];
  if (!policy) return { applicable: false, pass: false, detail: `unknown invariant policy "${config.policy}"` };
  return policy.evaluate(config, ctx);
}

// ---- helpers ----

function notApplicable(detail: string): InvariantResult {
  return { applicable: false, pass: true, detail };
}

function scopeLabel(scope: OperationRef | undefined): string {
  return scope ? `${scope.method} ${scope.path}` : "any recorded request";
}

function opLabel(op: OperationRef | undefined): string {
  return op ? `${op.method} ${op.path}` : "(no operation)";
}

/** Requests matching an operation selector (method + path template). */
function matching(
  trace: InvariantTraceRequest[],
  op: OperationRef | undefined
): InvariantTraceRequest[] {
  if (!op) return [];
  return trace.filter((r) => r.method === op.method && op.template.test(r.path));
}

/** Requests inside an optional scope; no scope means the whole recorded trace. */
function inScope(
  trace: InvariantTraceRequest[],
  scope: OperationRef | undefined
): InvariantTraceRequest[] {
  return scope ? matching(trace, scope) : trace;
}

/** The spec operation a recorded request belongs to. */
function operationFor(
  operations: OpenApiOperation[],
  request: InvariantTraceRequest
): OpenApiOperation | null {
  return operations.find((op) => op.method === request.method && pathTemplateToRegExp(op.path).test(request.path)) ?? null;
}

function responseSchemaFor(
  op: OpenApiOperation | null,
  request: InvariantTraceRequest
): OpenApiSchema | null {
  const response = op?.responses?.[String(request.status)] ?? op?.responses?.default;
  const content = response?.content ?? {};
  const media = content[request.mime] ?? content["application/json"] ?? Object.values(content)[0];
  const schema = media?.schema ?? null;
  return schemaIsValidatable(schema) ? schema : null;
}

/**
 * A resolved schema is validatable unless it carries openapi.ts's `$ref_cycle`
 * marker — a recursive model expands to a marker rather than looping, and
 * validating against the marker would report a spurious violation.
 */
function schemaIsValidatable(schema: unknown): schema is OpenApiSchema {
  if (!schema || typeof schema !== "object") return false;
  const seen = new Set<object>();
  const walk = (node: any // TODO(ts): recursively traverses arbitrary OpenAPI schema nodes
  ): boolean => {
    if (!node || typeof node !== "object" || seen.has(node)) return true;
    seen.add(node);
    if (node.$ref_cycle !== undefined) return false;
    return Object.values(node).every(walk);
  };
  return walk(schema);
}

function validateAgainst(schema: OpenApiSchema, json: MatchNode): string | null {
  const key = JSON.stringify(schema);
  let validate = compiledSchemas.get(key);
  if (!validate) {
    try {
      validate = schemaAjv.compile(schema);
    } catch {
      validate = () => true; // an un-compilable schema cannot condemn a response
    }
    compiledSchemas.set(key, validate);
  }
  return validate(json) ? null : schemaAjv.errorsText(validate.errors ?? []);
}

function jsonOf(text: MatchNode): MatchNode {
  if (text == null) return undefined;
  if (typeof text === "object") return text;
  try {
    return JSON.parse(text as string);
  } catch {
    return undefined;
  }
}

/** Every value at a field path, including all elements under `[*]`. */
function collectAt(
  node: MatchNode,
  segs: PathSegment[],
  out: MatchNode[] = []
): MatchNode[] {
  if (!segs.length) {
    if (node !== undefined) out.push(node);
    return out;
  }
  const [head, ...tail] = segs as [PathSegment, ...PathSegment[]];
  if (head.each) {
    if (Array.isArray(node)) for (const v of node) collectAt(v, tail, out);
    return out;
  }
  if (head.index !== undefined) {
    if (Array.isArray(node)) collectAt(node[head.index], tail, out);
    return out;
  }
  if (node && typeof node === "object" && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, head.key)) {
    collectAt(node[head.key], tail, out);
  }
  return out;
}

/**
 * The grouping key for an idempotency repeat: the request body plus, when the
 * case names one, the idempotency key header. `null` means "not a candidate for
 * a repeat" (no body and no declared key), so unrelated calls never fabricate
 * applicability.
 */
function repeatKey(
  request: InvariantTraceRequest,
  keyHeader: string | undefined
): string | null {
  if (keyHeader) {
    const value = headerOf(request, keyHeader);
    return value == null ? null : `${request.path}\0${keyHeader}=${value}`;
  }
  if (request.requestBody == null) return null;
  const json = jsonOf(request.requestBody);
  return `${request.path}\0${JSON.stringify(json === undefined ? request.requestBody : json)}`;
}

function headerOf(request: InvariantTraceRequest, name: string): string | null {
  const headers = request.requestHeaders ?? {};
  const key = Object.keys(headers).find((h) => h.toLowerCase() === String(name).toLowerCase());
  return key === undefined ? null : headers[key]!; // TODO(ts): key is selected from Object.keys on this headers object
}

/** A response body reduced to what an idempotency comparison should see. */
function normalizedBody(body: MatchNode, ignore: string[] = []): MatchNode {
  const json = jsonOf(body);
  if (json === undefined) return body ?? null;
  let out: MatchNode = json;
  for (const p of ignore) out = stripAt(out, pathSegments(p));
  return sortKeys(out);
}

function stripAt(node: MatchNode, segs: PathSegment[]): MatchNode {
  if (!segs.length) return undefined;
  const [head, ...tail] = segs as [PathSegment, ...PathSegment[]];
  if (head.each) return Array.isArray(node) ? node.map((v) => stripAt(v, tail)) : node;
  if (head.index !== undefined) {
    if (!Array.isArray(node)) return node;
    const out = node.slice();
    out[head.index] = stripAt(node[head.index], tail);
    return out;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  if (!Object.prototype.hasOwnProperty.call(node, head.key)) return node;
  const out: { [key: string]: MatchNode } = { ...node };
  if (!tail.length) delete out[head.key];
  else out[head.key] = stripAt(node[head.key], tail);
  return out;
}

function sortKeys(value: MatchNode): MatchNode {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: { [key: string]: MatchNode } = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/** Do two concrete paths address the same resource, up to the read template? */
function samePath(readPath: string, deletePath: string): boolean {
  return readPath === deletePath || deletePath.startsWith(`${readPath}/`) || readPath.startsWith(`${deletePath}/`);
}

/**
 * The read-only observation a round-trip policy issues when the story contains
 * no read-back: the declared read template with each parameter filled from the
 * create response through `read_from`. Deterministic and explicit — no inference,
 * so a wrong mapping is a not-applicable report rather than a request to a
 * guessed URL. Returns null when a parameter cannot be resolved.
 */
function observationRequest(
  config: ParsedInvariantPolicy,
  create: InvariantTraceRequest
): { method: string; path: string } | null {
  const body = jsonOf(create.body);
  let path = config.read.path;
  for (const [param, expr] of Object.entries(config.read_from ?? {})) {
    const value = readAt(body, pathSegments(expr));
    if (value === undefined || value === null || typeof value === "object") return null;
    path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
  }
  if (/\{[^}]+\}/.test(path)) return null;
  return { method: config.read.method, path };
}

/**
 * The same minimal `<path> (==|!=) <literal>` grammar `response_matches` uses,
 * for a lifecycle policy's declared post-delete `state:`. Kept here rather than
 * imported from gate.js so this module has no cycle back into the gate.
 */
function matchExpression(
  expr: string,
  json: MatchNode
): { pass: boolean; detail: string } {
  const m = String(expr).match(/^\s*(\$?[\w.[\]'"*-]*?)\s*(==|!=|=)\s*(.+?)\s*$/);
  if (!m) return { pass: false, detail: `cannot parse state ${JSON.stringify(expr)} (expected: path == value)` };
  const [, rawPath, op, rawVal] = m;
  const actual = readAt(json, pathSegments(rawPath));
  const expected = parseLiteral(rawVal);
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  const pass = op === "!=" ? !eq : eq;
  const shown = actual === undefined ? "(no value at path)" : JSON.stringify(actual);
  return { pass, detail: pass ? `${rawPath} = ${shown}` : `${rawPath} = ${shown}, expected ${op} ${JSON.stringify(expected)}` };
}

function parseLiteral(raw: unknown): MatchNode {
  const t = String(raw).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}
