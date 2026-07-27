// OpenAPI ingestion for the API driver
// (docs/contracts/engine.md#openapi-ingestion).
//
// The driver used to read `paths` shallowly and keep only each operation's
// summary, so `$ref`-heavy documents — which is to say every real one —
// described nothing. This module resolves the document into a flat, enriched
// operation list: parameters, request and response schemas, declared statuses,
// response links, and security schemes. Two consumers depend on it: the actor's
// snapshot (an operation line that says what a call actually needs) and the
// gate, which gets the whole enriched document as Tier-1 material.
//
// Resolution has a hermetic boundary, because ingestion happens inside a run:
//
//   * internal pointers (`#/components/...`) always resolve;
//   * file refs resolve only WITHIN the spec file's own directory tree, so a
//     suite-local `./components.yaml#/schemas/Money` works and `../../etc` does
//     not;
//   * a network ref (`https://…`) is refused outright — a run must not fetch;
//   * documents are size- and node-capped, so a `$ref` expansion bomb reports a
//     config error instead of exhausting memory;
//   * a recursive schema resolves to a `$ref_cycle` marker and is reported in
//     `diagnostics` rather than looping forever.
//
// Everything that goes wrong is a DummyConfigError naming the file and the ref.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { DummyConfigError } from "./config.ts";
import type {
  JsonObject,
  Occurrence,
  ResponseMatchSelector,
  ResponseStatusSelector,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface OpenApiSchema extends Record<string, unknown> {
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
}

export interface OpenApiMedia {
  schema: OpenApiSchema | null;
}

export interface OpenApiResponse {
  description: string;
  content: Record<string, OpenApiMedia>;
  links: Record<string, unknown>;
}

export interface OpenApiParameter {
  name: string;
  in: string;
  required: boolean;
  description: string;
  schema: OpenApiSchema | null;
}

export interface OpenApiOperation {
  method: string;
  path: string;
  operation_id: string | null;
  summary: string;
  description: string;
  parameters: OpenApiParameter[];
  request_body: {
    required: boolean;
    description: string;
    content: Record<string, OpenApiMedia>;
  } | null;
  responses: Record<string, OpenApiResponse>;
  status_codes: string[];
  security: unknown[] | null;
}

export interface OpenApiDocument {
  paths: Record<string, OpenApiPathItem>;
  security?: unknown[];
  info?: { title?: string; version?: string };
  components?: { securitySchemes?: Record<string, unknown> };
  [key: string]: unknown;
}

interface OpenApiLinkSource {
  operationId?: unknown;
  operationRef?: unknown;
  parameters?: unknown;
}

interface OpenApiResponseSource {
  description?: string;
  content?: Record<string, OpenApiMediaSource | null | undefined>;
  links?: Record<string, OpenApiLinkSource | null | undefined>;
}

interface OpenApiMediaSource {
  schema?: OpenApiSchema | null;
}

interface OpenApiRequestBodySource {
  required?: unknown;
  description?: string;
  content?: Record<string, OpenApiMediaSource | null | undefined>;
}

interface OpenApiParameterSource {
  name?: unknown;
  in?: string;
  required?: unknown;
  description?: string;
  schema?: OpenApiSchema | null;
}

interface OpenApiOperationSource {
  operationId?: unknown;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameterSource[];
  requestBody?: OpenApiRequestBodySource | null;
  responses?: Record<string, OpenApiResponseSource | null | undefined>;
  security?: unknown;
}

interface OpenApiPathItem extends Record<string, unknown> {
  parameters?: unknown[];
}

export interface EnrichedOpenApi {
  file: string;
  title: string;
  version: string;
  operations: OpenApiOperation[];
  security_schemes: Record<string, unknown>;
  links: Array<Record<string, unknown>>;
  diagnostics: Array<{ kind: string; ref: string }>;
  document: OpenApiDocument;
}

interface ResolveContext {
  at: string;
  rootDir: string;
  read: (target: string) => OpenApiNode & Record<string, OpenApiNode>;
  maxNodes: number;
  budget: { n: number };
  diagnostics: Array<{ kind: string; ref: string }>;
  docPath: string;
  doc: OpenApiNode & Record<string, OpenApiNode>;
}

type OpenApiNode =
  | string
  | number
  | boolean
  | null
  | undefined
  | OpenApiNode[]
  | { [key: string]: OpenApiNode };

export interface ParsedOperationSelector {
  method: string;
  path: string;
  template: RegExp;
  status: string | null;
  match: string | null;
  occurrence: Occurrence;
}

/** Largest spec document (per file) ingestion will read. */
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;
/** Largest number of nodes ref expansion may produce, before it is a config error. */
export const MAX_SPEC_NODES = 200_000;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const NETWORK_REF_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/**
 * Load and enrich an OpenAPI document.
 * @param {string} file absolute path to the spec (YAML or JSON)
 * @param {{ maxBytes?: number, maxNodes?: number, where?: string }} [opts]
 * @returns {{ file, title, version, operations, security_schemes, links, diagnostics, document }}
 * @throws {DummyConfigError}
 */
export function loadOpenApi(
  file: string,
  {
    maxBytes = MAX_SPEC_BYTES,
    maxNodes = MAX_SPEC_NODES,
    where = "app.openapi"
  }: { maxBytes?: number; maxNodes?: number; where?: string } = {}
): EnrichedOpenApi {
  const abs = path.resolve(file);
  const rootDir = path.dirname(abs);
  const at = `${where} (${path.basename(abs)})`;
  const docs = new Map<string, OpenApiNode & Record<string, OpenApiNode>>();
  const read = (target: string): OpenApiNode & Record<string, OpenApiNode> =>
    readDocument(target, { at, maxBytes, docs });
  const ctx = { at, rootDir, read, maxNodes, budget: { n: 0 }, diagnostics: [] };

  const root = read(abs);
  const resolved = resolveNode(root, { ...ctx, docPath: abs, doc: root }, new Set<string>()) as OpenApiNode & { paths?: Record<string, OpenApiPathItem> }; // SAFETY: the runtime document guard below narrows the resolved root
  if (!resolved || typeof resolved !== "object" || !resolved.paths || typeof resolved.paths !== "object") {
    throw new DummyConfigError(
      `${at}: no "paths" object — this does not look like an OpenAPI document (expected OpenAPI 3.x with a paths map)`,
    );
  }
  return enrich(resolved as OpenApiDocument, { file: abs, diagnostics: ctx.diagnostics });
}

function readDocument(
  target: string,
  {
    at,
    maxBytes,
    docs
  }: {
    at: string;
    maxBytes: number;
    docs: Map<string, OpenApiNode & Record<string, OpenApiNode>>;
  }
): OpenApiNode & Record<string, OpenApiNode> {
  const abs = path.resolve(target);
  if (docs.has(abs)) return docs.get(abs) as OpenApiNode & Record<string, OpenApiNode>;
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new DummyConfigError(`${at}: cannot read ${abs} — check the path (it resolves relative to the file that declares it)`);
  }
  if (!stat.isFile()) throw new DummyConfigError(`${at}: ${abs} is not a file`);
  if (stat.size > maxBytes) {
    throw new DummyConfigError(
      `${at}: ${abs} is ${Math.round(stat.size / 1024)}KB, over the ${Math.round(maxBytes / 1024)}KB ingestion cap —` +
        ` split the document or trim it to the operations under test`,
    );
  }
  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(abs, "utf8"));
  } catch (e: any) { // SAFETY: YAML may throw non-Error values
    throw new DummyConfigError(`${at}: ${abs} is not valid YAML or JSON — ${String(e?.message ?? e).split("\n")[0]}`);
  }
  if (!doc || typeof doc !== "object") throw new DummyConfigError(`${at}: ${abs} parsed to ${doc === null ? "null" : typeof doc}, not a document`);
  docs.set(abs, doc as OpenApiNode & Record<string, OpenApiNode>);
  return doc as OpenApiNode & Record<string, OpenApiNode>;
}

/** Deep-resolve `$ref`s. `stack` holds the refs currently being expanded (cycle guard). */
function resolveNode(node: OpenApiNode, ctx: ResolveContext, stack: Set<string>): OpenApiNode {
  if (ctx.budget.n++ > ctx.maxNodes) {
    throw new DummyConfigError(
      `${ctx.at}: resolving $refs produced more than ${ctx.maxNodes} nodes — the document is either enormous or has a self-multiplying $ref`,
    );
  }
  if (Array.isArray(node)) return node.map((n) => resolveNode(n, ctx, stack));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    const { docPath, doc, pointer, ref } = refTarget(node.$ref, ctx);
    const key = `${docPath}#${pointer}`;
    if (stack.has(key)) {
      // A recursive schema is legal and common; expanding it is not. Mark it and
      // keep going — an actionable diagnostic beats a stack overflow.
      ctx.diagnostics.push({ kind: "cycle", ref: key });
      return { $ref_cycle: ref };
    }
    const target = pointerInto(doc, pointer, ref, ctx);
    const next = new Set(stack);
    next.add(key);
    const expanded = resolveNode(target, { ...ctx, docPath, doc }, next);
    // Sibling keys alongside $ref (a 3.1 description override) stay, resolved.
    const siblings = Object.entries(node).filter(([k]) => k !== "$ref");
    if (!siblings.length || !expanded || typeof expanded !== "object" || Array.isArray(expanded)) return expanded;
    const out: Record<string, OpenApiNode> = { ...expanded };
    for (const [k, v] of siblings) out[k] = resolveNode(v, ctx, stack);
    return out;
  }
  const out: Record<string, OpenApiNode> = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolveNode(v, ctx, stack);
  return out;
}

function refTarget(
  ref: string,
  ctx: ResolveContext
): { docPath: string; doc: OpenApiNode & Record<string, OpenApiNode>; pointer: string; ref: string } {
  if (NETWORK_REF_RE.test(ref)) {
    throw new DummyConfigError(
      `${ctx.at}: $ref "${ref}" points off the machine — a run resolves internal (#/…) and suite-local file refs only,` +
        ` never the network. Vendor the document into the suite and reference it by relative path.`,
    );
  }
  const hash = ref.indexOf("#");
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  if (!filePart) return { docPath: ctx.docPath, doc: ctx.doc, pointer, ref };
  const target = path.resolve(path.dirname(ctx.docPath), filePart);
  const rel = path.relative(ctx.rootDir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new DummyConfigError(
      `${ctx.at}: $ref "${ref}" escapes the spec's own directory — a file ref must stay inside ${ctx.rootDir}`,
    );
  }
  return { docPath: target, doc: ctx.read(target), pointer, ref };
}

function pointerInto(
  doc: OpenApiNode,
  pointer: string,
  ref: string,
  ctx: ResolveContext
): OpenApiNode {
  if (!pointer || pointer === "/") return doc;
  if (!pointer.startsWith("/")) {
    throw new DummyConfigError(`${ctx.at}: $ref "${ref}" is not a JSON pointer — write "#/components/schemas/Name"`);
  }
  let cur: any = doc; // SAFETY: JSON Pointer traversal narrows each dynamic document segment at runtime
  for (const raw of pointer.slice(1).split("/")) {
    const seg = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur == null || typeof cur !== "object" || !(seg in cur)) {
      throw new DummyConfigError(`${ctx.at}: $ref "${ref}" does not resolve — nothing at that pointer`);
    }
    cur = cur[seg];
  }
  return cur;
}

function enrich(
  doc: OpenApiDocument,
  {
    file,
    diagnostics
  }: { file: string; diagnostics: Array<{ kind: string; ref: string }> }
): EnrichedOpenApi {
  const operations: OpenApiOperation[] = [];
  const links: Array<Record<string, unknown>> = [];
  const rootSecurity = Array.isArray(doc.security) ? doc.security : null;
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op: OpenApiOperationSource | null | undefined = item[method] as OpenApiOperationSource | null | undefined; // SAFETY: OpenAPI method members are dynamically keyed and narrowed below
      if (!op || typeof op !== "object") continue;
      const responses: Record<string, OpenApiResponseSource | null | undefined> = op.responses && typeof op.responses === "object" ? op.responses : {};
      const operation = {
        method: method.toUpperCase(),
        path: p,
        operation_id: typeof op.operationId === "string" ? op.operationId : null,
        summary: op.summary ?? "",
        description: op.description ?? "",
        parameters: mergeParameters(shared, op.parameters),
        request_body: requestBodyOf(op.requestBody),
        responses: responsesOf(responses),
        // Declared statuses: the Tier-1 input P4 checks "documented status code"
        // against, and the source of a spec-derived status normalization.
        status_codes: Object.keys(responses).filter((k) => /^\d{3}$/.test(k)).sort(),
        security: Array.isArray(op.security) ? op.security : rootSecurity,
      };
      for (const [status, response] of Object.entries(responses)) {
        for (const [name, link] of Object.entries(response?.links ?? {})) {
          links.push({
            from: `${operation.method} ${p}`,
            status,
            name,
            operation_id: link?.operationId ?? null,
            operation_ref: link?.operationRef ?? null,
            parameters: link?.parameters ?? {},
          });
        }
      }
      operations.push(operation);
    }
  }
  return {
    file,
    title: doc.info?.title ?? "",
    version: doc.info?.version ?? "",
    operations,
    security_schemes: doc.components?.securitySchemes ?? {},
    links,
    diagnostics,
    document: doc,
  };
}

function mergeParameters(shared: unknown[], own: unknown): OpenApiParameter[] {
  const out: OpenApiParameter[] = [];
  const seen = new Set<string>();
  for (const p of [...(Array.isArray(own) ? own : []), ...shared] as OpenApiParameterSource[]) { // SAFETY: each untrusted parameter is shape-checked before its fields are consumed
    if (!p || typeof p !== "object" || typeof p.name !== "string") continue;
    const key = `${p.in}:${p.name}`;
    if (seen.has(key)) continue; // an operation-level parameter overrides the path-level one
    seen.add(key);
    out.push({
      name: p.name,
      in: p.in ?? "query",
      required: p.in === "path" ? true : Boolean(p.required),
      description: p.description ?? "",
      schema: p.schema ?? null,
    });
  }
  return out;
}

function requestBodyOf(
  body: OpenApiRequestBodySource | null | undefined
): OpenApiOperation["request_body"] {
  if (!body || typeof body !== "object") return null;
  return { required: Boolean(body.required), description: body.description ?? "", content: contentOf(body.content) };
}

function responsesOf(
  responses: Record<string, OpenApiResponseSource | null | undefined>
): Record<string, OpenApiResponse> {
  const out: Record<string, OpenApiResponse> = {};
  for (const [status, response] of Object.entries(responses)) {
    if (!response || typeof response !== "object") continue;
    out[status] = {
      description: response.description ?? "",
      content: contentOf(response.content),
      links: response.links ?? {},
    };
  }
  return out;
}

function contentOf(
  content: Record<string, OpenApiMediaSource | null | undefined> | null | undefined
): Record<string, OpenApiMedia> {
  const out: Record<string, OpenApiMedia> = {};
  for (const [mime, media] of Object.entries(content ?? {})) {
    if (!media || typeof media !== "object") continue;
    out[mime] = { schema: media.schema ?? null };
  }
  return out;
}

// ---- operation lines and selectors ----

const MAX_LISTED_FIELDS = 8;

/**
 * One `[eN]` snapshot line per operation: what to call, what it needs, and what
 * it may answer. This is the actor's whole view of the surface, so it names
 * required parameters and body fields (`*`) rather than leaving them implicit.
 * Pure; exported for test.
 */
export function operationLine(op: OpenApiOperation, index: number): string {
  const parts = [`[e${index + 1}] ${op.method} ${op.path}`];
  if (op.summary) parts.push(`— ${op.summary}`);
  const params = op.parameters.filter((p) => p.in === "path" || p.in === "query");
  if (params.length) parts.push(`[${listFields(params.map((p) => `${p.name}${p.required ? "*" : ""}`))}]`);
  const schema = op.request_body?.content?.["application/json"]?.schema ?? Object.values(op.request_body?.content ?? {})[0]?.schema;
  const fields = bodyFields(schema);
  if (fields.length) parts.push(`[body: ${listFields(fields)}]`);
  else if (op.request_body) parts.push("[body]");
  if (op.status_codes.length) parts.push(`→ ${op.status_codes.join(", ")}`);
  return parts.join(" ");
}

function bodyFields(schema: OpenApiSchema | null | undefined): string[] {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(props).map((name) => `${name}${required.has(name) ? "*" : ""}`);
}

function listFields(names: string[]): string {
  if (names.length <= MAX_LISTED_FIELDS) return names.join(", ");
  return `${names.slice(0, MAX_LISTED_FIELDS).join(", ")}, +${names.length - MAX_LISTED_FIELDS} more`;
}

/**
 * Compile an OpenAPI-style path template into an anchored matcher: `{id}`
 * matches one path segment. A template with no parameters matches literally.
 * Pure; exported for test.
 */
export function pathTemplateToRegExp(template: unknown): RegExp {
  const source = String(template)
    .split(/(\{[^{}/]+\})/)
    .map((part) => (/^\{[^{}/]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

/** `occurrence` values a structured operation selector accepts. */
export const OCCURRENCES: Occurrence[] = ["all", "any", "first", "last"];

/**
 * Parse the structured operation selector `response_status` / `response_matches`
 * accept (docs/contracts/engine.md#gates-and-custom-assertions):
 *
 *   response_status: { op: "POST /accounts/{id}/close", status: "204", occurrence: all }
 *   response_matches: { op: "GET /accounts/{id}", match: "$.balance == 90", occurrence: last }
 *
 * A bare string keeps today's any-request / last-body semantics and parses to
 * null, so existing suites are untouched. Throws a plain Error naming the
 * problem; config.ts wraps it into a DummyConfigError naming the file.
 * Pure; exported for test.
 * @returns {{ method, path, template, status, match, occurrence } | null}
 */
export function parseOperationSelector(
  kind: "response_status" | "response_matches",
  value: unknown
): ParsedOperationSelector | null {
  if (!isRecord(value)) return null;
  const raw = String(value.op ?? "").trim();
  const m: (RegExpMatchArray & { 1: string; 2: string }) | null = raw.match(/^([A-Za-z]+)\s+(\/\S*)$/) as (RegExpMatchArray & { 1: string; 2: string }) | null;
  if (!m) {
    throw new Error(`"${kind}.op" must be a method and an OpenAPI-style path, e.g. "POST /accounts/{accountId}/close" (got ${JSON.stringify(value.op ?? null)})`);
  }
  const occurrence: Occurrence = value.occurrence as Occurrence ?? (kind === "response_matches" ? "last" : "all");
  if (!OCCURRENCES.includes(occurrence)) {
    throw new Error(`"${kind}.occurrence" must be one of ${OCCURRENCES.join(", ")} (got ${JSON.stringify(occurrence)})`);
  }
  if (kind === "response_status" && value.status === undefined) {
    throw new Error('"response_status" needs a "status" — an exact code like "201", or a class like "2xx" if that is genuinely the intent');
  }
  if (kind === "response_matches" && typeof value.match !== "string") {
    throw new Error('"response_matches" needs a "match" expression, e.g. "$.balance == 90"');
  }
  const extra = Object.keys(value).filter((k) => !["op", "status", "match", "occurrence"].includes(k));
  if (extra.length) throw new Error(`unknown ${kind} key(s) ${extra.join(", ")} (expected op, status, match, occurrence)`);
  return {
    method: m[1].toUpperCase(),
    path: m[2],
    template: pathTemplateToRegExp(m[2]),
    status: value.status === undefined ? null : String(value.status),
    match: typeof value.match === "string" ? value.match : null,
    occurrence,
  };
}

/** A stable one-line spec string for a selector, used as the gate check's key. */
export function selectorSpec(
  kind: string,
  value: unknown
): string {
  if (!isRecord(value)) return `${kind}: ${value}`;
  const parts = [String(value.op ?? "").trim()];
  if (value.status !== undefined) parts.push(String(value.status));
  if (typeof value.match === "string") parts.push(value.match);
  parts.push(`(${value.occurrence ?? (kind === "response_matches" ? "last" : "all")})`);
  return `${kind}: ${parts.join(" ")}`;
}
