import type { DynamicValue } from "./types.ts";

// The mechanical risk profile (docs/contracts/scripts.md#risk-profile).
//
// What a human needs before approving a program that will run against their
// environment on every build: what it touches, what it changes, what it creates,
// whose credentials it borrows, and whether it ever tried to leave. Computed
// from the static script text plus a recorded HAR — no model, ever, so the
// approval screen and the CLI show the same numbers and neither can hallucinate
// a reassurance.
import { traceFromHar } from "./gate.ts";

/** Profile shape version, carried in the profile and the report. */
export const RISK_PROFILE_VERSION = 1;

const MUTATING_METHODS: DynamicValue = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DELETE_METHODS: DynamicValue = new Set(["DELETE"]);
// Segment shapes that are identifiers rather than route names: numeric ids,
// uuid/ulid-shaped tokens, and `prefix_<random>` handles (the ledger fixture's
// shape, and the common one).
const ID_SHAPES = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9A-HJKMNP-TV-Z]{26}$/,
  /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]{6,}$/,
];

/** Collect every `id`-ish value a response body announced. */
function announcedIds(trace: DynamicValue) {
  const ids: DynamicValue = new Set();
  const walk = (value: DynamicValue, depth: DynamicValue) => {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && /(^|_)id$/i.test(key) && item.length >= 4) ids.add(item);
      else walk(item, depth + 1);
    }
  };
  for (const request of trace) {
    if (!request.body) continue;
    try {
      walk(JSON.parse(request.body), 0);
    } catch {}
  }
  return ids;
}

/**
 * Collapse a concrete path to its route template using the ids the API itself
 * announced, then the shape heuristics. Pure; exported for test.
 */
export function templatePath(path: DynamicValue, ids = new Set()) {
  return (
    "/" +
    String(path)
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        const decoded = (() => {
          try {
            return decodeURIComponent(segment);
          } catch {
            return segment;
          }
        })();
        if (ids.has(decoded) || ids.has(segment)) return "{id}";
        return ID_SHAPES.some((shape) => shape.test(decoded)) ? "{id}" : segment;
      })
      .join("/")
  );
}

/** Secret references and imports visible in the script text. Pure. */
export function staticProfile(source = "") {
  const text = String(source ?? "");
  const secretReferences: DynamicValue = new Set();
  for (const match of text.matchAll(/\$secret\s*:\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g)) secretReferences.add(match[1]);
  for (const match of text.matchAll(/\.secret\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/g)) secretReferences.add(match[1]);
  const imports: DynamicValue = new Set();
  for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) imports.add(match[1]);
  return {
    secret_references: [...secretReferences].sort(),
    imports: [...imports].sort(),
    lines: text ? text.split("\n").length : 0,
    bytes: Buffer.byteLength(text),
  };
}

/**
 * @param {{ source?: string, harEntries?: object[], trace?: object[],
 *           guardEvents?: object[], secretNames?: string[], budget?: number }} input
 */
export function profileScript({ source = "", harEntries = [], trace = null, guardEvents = [], secretNames = [], budget = null }: DynamicValue = {}) {
  const requests = trace ?? traceFromHar(harEntries);
  const ids = announcedIds(requests);
  const methods: DynamicValue = {};
  const endpoints: DynamicValue = new Map();
  const collections: DynamicValue = new Map();
  const created: DynamicValue = [];
  const usedSecrets: DynamicValue = new Set();

  for (const request of requests) {
    methods[request.method] = (methods[request.method] ?? 0) + 1;
    const template = templatePath(request.path, ids);
    const key = `${request.method} ${template}`;
    const endpoint = endpoints.get(key) ?? { method: request.method, path: template, count: 0, statuses: {} };
    endpoint.count += 1;
    endpoint.statuses[request.status] = (endpoint.statuses[request.status] ?? 0) + 1;
    endpoints.set(key, endpoint);

    const collection = "/" + (template.split("/").filter(Boolean)[0] ?? "");
    const resource = collections.get(collection) ?? { collection, reads: 0, writes: 0, deletes: 0, created: 0 };
    if (DELETE_METHODS.has(request.method)) resource.deletes += 1;
    else if (MUTATING_METHODS.has(request.method)) resource.writes += 1;
    else resource.reads += 1;

    // Data created: a 2xx answer to a non-idempotent write that announced an id.
    if (request.method === "POST" && request.status >= 200 && request.status < 300 && request.body) {
      try {
        const body = JSON.parse(request.body);
        const id = typeof body?.id === "string" ? body.id : null;
        if (id) {
          resource.created += 1;
          created.push({ collection, id, entry: request.index });
        }
      } catch {}
    }
    collections.set(collection, resource);

    // A secret the proxy substituted is visible in the recorded header only as
    // its placeholder — that is the profile's evidence that a credential was used.
    for (const value of Object.values(request.requestHeaders ?? {})) {
      const match = /^\[secret:([A-Za-z_][A-Za-z0-9_]*)\]/.exec(String(value)) ?? /\[secret:([A-Za-z_][A-Za-z0-9_]*)\]/.exec(String(value));
      if (match) usedSecrets.add(match[1]);
    }
  }

  const writes = Object.entries(methods).reduce((total: DynamicValue, [method, count]: DynamicValue) => (MUTATING_METHODS.has(method) && !DELETE_METHODS.has(method) ? total + count : total), 0);
  const deletes = methods.DELETE ?? 0;
  const refused: DynamicValue = { off_origin: 0, read_only: 0, budget_exhausted: 0, undeclared_secret: 0, invalid_path: 0, other: 0 };
  const outOfOrigin: DynamicValue = [];
  for (const event of guardEvents ?? []) {
    if (event?.code in refused) refused[event.code] += 1;
    else refused.other += 1;
    if (event?.code === "off_origin") outOfOrigin.push({ method: event.method, path: event.path, detail: event.detail });
  }

  const statics = staticProfile(source);
  return {
    profile_version: RISK_PROFILE_VERSION,
    requests: {
      total: requests.length,
      budget,
      methods: Object.fromEntries(Object.entries(methods).sort(([a], [b]) => a.localeCompare(b))),
    },
    endpoints: [...endpoints.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    resources: [...collections.values()].sort((a, b) => a.collection.localeCompare(b.collection)),
    mutation: {
      // The single line a reviewer reads first.
      classification: deletes > 0 ? "deletes" : writes > 0 ? "writes" : "read-only",
      writes,
      deletes,
      reads: requests.length - writes - deletes,
    },
    data_created: {
      count: created.length,
      by_collection: Object.fromEntries([...collections.values()].filter((r) => r.created).map((r) => [r.collection, r.created])),
      ids: created.map((entry: DynamicValue) => entry.id),
    },
    secret_references: {
      declared: [...(secretNames ?? [])].sort(),
      in_source: statics.secret_references,
      used: [...usedSecrets].sort(),
    },
    out_of_origin_attempts: outOfOrigin,
    refused,
    static: statics,
  };
}
