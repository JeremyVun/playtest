// Response bindings: what turns an acted API journey from a replay of literal
// bytes into a parameterized program (docs/contracts/engine.md#bindings).
//
// A recorded request that names the id the previous response invented is only
// replayable against the instance that invented it. A binding records the edge
// instead of the value: the consumer's action carries `{{name}}`, and the step
// envelope records where the value comes from —
//
//   { name: "id_2", from_step: 2, from: "$.id", into: ["path"] }
//
// — so act time re-reads the FRESH response at that path and substitutes the
// fresh value. Every substitution therefore cites its producer step, and a
// baseline recorded against one instance runs against a new one.
//
// Inference is deliberately timid. An over-eager binding corrupts a replay
// silently, which is worse than a brittle replay that fails loudly, so a value
// is bindable only when all of the following hold:
//
//   1. it is a STRING at least MIN_BINDABLE_LENGTH long (numbers and booleans
//      are never bound — "2" is as likely a page number as an id);
//   2. it is server-generated: it appears in a response and NOT anywhere in the
//      request that produced that response, so echoed client input (a name, an
//      idempotency key, an email) is never mistaken for a produced id;
//   3. it is identifier-shaped: its response key ends in an id-ish word, or the
//      value itself is a UUID/ULID;
//   4. it is not a value core injected from a secret reference;
//   5. the consumer's literal matches it WHOLE — a whole path segment, a whole
//      query value, a whole header value, or a whole JSON string leaf. Nothing
//      is ever templated into the middle of a longer string.
//
// Anything else keeps its literal value and, if that breaks against a fresh
// target, fails loudly.
import { DummyConfigError } from "./config/errors.ts";
import { pathSegments, readAt } from "./match.ts";
import { isSecretRef, secretNameForValue } from "./secrets.ts";

export interface ApiRequestAction {
  type?: string;
  path?: string;
  headers?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

export interface BindingProducer {
  step: number;
  path: string;
}

export interface BindingRecord {
  name: string;
  from_step: number;
  from: string;
  into: string[];
}

interface BindingContext {
  producers: Map<string, BindingProducer>;
  names: Map<string, string>;
  byName?: Map<string, BindingProducer>;
}

type BindValue = (
  value: string,
  into: string,
  opts?: { urlSafe?: boolean },
) => string | null;

/** `{{name}}` — the substitution token a recorded action carries. */
export const BINDING_TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/** The same token as an entire value (a whole path segment, header, or leaf). */
const WHOLE_TOKEN_RE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/** Shorter values match unrelated content everywhere; real ids are longer. */
export const MIN_BINDABLE_LENGTH = 4;

// A response key is identifier-ish when its last word is one of these. camelCase
// is normalized to snake_case first, so `accountId` and `account_id` agree.
const ID_KEY_RE = /(^|[_\-.])(id|ids|uuid|guid|key|token|slug|ref|href|url|location|cursor)$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// A value may only be templated into a URL path segment or query value when it
// needs no percent-encoding; otherwise the fresh value could reshape the URL.
const URL_SAFE_RE = /^[A-Za-z0-9._~-]+$/;

const snake = (key: unknown): string => String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** `$.items[3].ref` -> `$.items[*].ref`, so one declared path covers a list. */
const wildcarded = (p: string): string => p.replace(/\[\d+\]/g, "[*]");

/**
 * Is this response key/value pair an identifier a later request could echo?
 * `declared` are the `bind:` paths a suite named explicitly; they widen WHICH
 * fields are producers (past the key-name heuristic), never the value rules
 * that keep an over-eager binding from corrupting a replay.
 */
function bindable(
  key: string,
  value: unknown,
  path: string,
  declared: string[] | null
): value is string {
  if (typeof value !== "string" || value.length < MIN_BINDABLE_LENGTH) return false;
  if (secretNameForValue(value)) return false;
  if (declared?.length && declared.includes(wildcarded(path))) return true;
  if (UUID_RE.test(value) || ULID_RE.test(value)) return true;
  return ID_KEY_RE.test(snake(key));
}

/**
 * The `bind:` block: response field paths a suite declares bindable when the
 * conservative heuristic would not recognize them (an id under a key like
 * `reference`). Returns null when nothing is declared. Pure; exported for test.
 */
export function normalizeBindPaths(value: unknown, file: string): string[] | null {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new DummyConfigError(`${file}: bind entries are response field paths, e.g. "$.data.reference"`);
    }
    const p = entry.trim();
    if (!/^\$?[.[]?[A-Za-z0-9_$\-[\]*.]*$/.test(p)) {
      throw new DummyConfigError(`${file}: bind path ${JSON.stringify(entry)} is not a field path — write "$.a.b" or "$.items[*].ref"`);
    }
    out.push(wildcarded(p.startsWith("$") ? p : `$.${p.replace(/^\./, "")}`));
  }
  return out.length ? out : null;
}

/**
 * Every string literal a request carried, so an echo of the client's own input
 * is never mistaken for something the server produced. Pure; exported for test.
 */
export function requestLiterals(
  action: ApiRequestAction | null | undefined,
  out = new Set<string>()
): Set<string> {
  if (typeof action?.path === "string") {
    for (const seg of action.path.split(/[/?&=#]/)) if (seg) out.add(seg);
    out.add(action.path);
  }
  collectStrings(action?.headers, out);
  collectStrings(action?.body, out);
  return out;
}

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object" && !isSecretRef(value)) for (const v of Object.values(value)) collectStrings(v, out);
}

/**
 * Index one response's bindable values into `producers` (value -> producer).
 * The EARLIEST producer wins, so the provenance a substitution cites is stable
 * no matter how often a later response repeats the same id.
 * @param {Map<string, {step: number, path: string}>} producers
 * @param {{ step: number, body: unknown, sent: Set<string>, declared?: string[] }} response
 */
export function indexProducers(
  producers: Map<string, BindingProducer>,
  {
    step,
    body,
    sent,
    declared = null
  }: { step: number; body: unknown; sent: Set<string>; declared?: string[] | null }
): Map<string, BindingProducer> {
  walk(body, "$", (path: string, key: string, value: unknown) => {
    if (!bindable(key, value, path, declared)) return;
    if (sent?.has(value)) return; // the client sent it; the server only echoed it
    if (!producers.has(value)) producers.set(value, { step, path });
  });
  return producers;
}

function walk(
  node: unknown,
  path: string,
  visit: (path: string, key: string, value: unknown) => void,
  depth = 0
): void {
  if (depth > 12) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, visit, depth + 1));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    const child = `${path}.${k}`;
    if (v && typeof v === "object") walk(v, child, visit, depth + 1);
    else visit(child, k, v);
  }
}

/**
 * Rewrite an action's literals into `{{name}}` tokens wherever a producer is
 * unambiguous, returning the templated action plus the binding records the step
 * envelope persists. When nothing binds, the SAME action object is returned, so
 * an unaffected step is byte-identical to one recorded before bindings existed.
 * @param {object} action a `request` action, post-redaction
 * @param {{ producers: Map, names: Map, byName?: Map }} ctx `names` carries
 *   assigned variable names across steps (keyed `step|path`) so a repeated
 *   producer keeps one name per trajectory; `byName` is its inverse.
 * @returns {{ action: object, bindings: object[] }}
 */
export function inferBindings(
  action: ApiRequestAction,
  { producers, names, byName = new Map<string, BindingProducer>() }: BindingContext
): { action: ApiRequestAction; bindings: BindingRecord[] } {
  if (action?.type !== "request" || (!producers?.size && !byName.size)) return { action, bindings: [] };
  const found = new Map<string, BindingRecord>(); // name -> { name, from_step, from, into: [] }

  const nameFor = (producer: BindingProducer): string => {
    const key = `${producer.step}|${producer.path}`;
    if (names.has(key)) return names.get(key) as string;
    const leaf = snake(producer.path.split(".").pop()!.replace(/\[\d+\]$/, "")) || "value"; // SAFETY: splitting a string always yields at least one segment
    const base = `${leaf.replace(/[^a-z0-9_]/g, "_")}_${producer.step}`;
    let name = base;
    for (let n = 2; byName.has(name); n++) name = `${base}_${n}`;
    names.set(key, name);
    byName.set(name, producer);
    return name;
  };

  const bind: BindValue = (value, into, { urlSafe = false } = {}) => {
    // An action may already carry a token: the actor sees its own history, so it
    // can reuse a substitution it made earlier. Treat that as a first-class
    // binding rather than an unresolvable token — the alternative is a recorded
    // request that fails on its own replay.
    const reused: (RegExpExecArray & { 1: string }) | null = WHOLE_TOKEN_RE.exec(String(value ?? "")) as (RegExpExecArray & { 1: string }) | null;
    const producer = reused ? byName.get(reused[1]) : producers.get(value);
    if (!producer) return null;
    if (!reused && urlSafe && !URL_SAFE_RE.test(value)) return null;
    const name = reused ? reused[1] : nameFor(producer);
    const record = found.get(name) ?? { name, from_step: producer.step, from: producer.path, into: [] };
    if (!record.into.includes(into)) record.into.push(into);
    found.set(name, record);
    return `{{${name}}}`;
  };

  const path = typeof action.path === "string" ? templatizePath(action.path, bind) : action.path;
  const headers = templatizeHeaders(action.headers, bind);
  const body = templatizeBody(action.body, bind, "body");
  // Keyed on what BOUND, not on what changed: re-binding a token the action
  // already carried is a real binding whose substitution is textually identity.
  if (!found.size) return { action, bindings: [] };
  const rewritten = path !== action.path || headers !== action.headers || body !== action.body;
  return {
    action: rewritten
      ? { ...action, path, ...(action.headers !== undefined ? { headers } : {}), ...(action.body !== undefined ? { body } : {}) }
      : action,
    bindings: [...found.values()],
  };
}

/** Whole path segments and whole query values only — never a substring. */
function templatizePath(raw: string, bind: BindValue): string {
  const hash = raw.indexOf("#");
  const tail = hash === -1 ? "" : raw.slice(hash);
  const head = hash === -1 ? raw : raw.slice(0, hash);
  const q = head.indexOf("?");
  const pathname = q === -1 ? head : head.slice(0, q);
  const query = q === -1 ? "" : head.slice(q + 1);
  let changed = false;
  const segs = pathname.split("/").map((seg) => {
    const t = seg && bind(seg, "path", { urlSafe: true });
    if (!t) return seg;
    changed = true;
    return t;
  });
  const params = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const t = value && bind(value, `query.${key}`, { urlSafe: true });
      if (!t) return pair;
      changed = true;
      return `${key}=${t}`;
    })
    .join("&");
  return changed ? `${segs.join("/")}${query ? `?${params}` : ""}${tail}` : raw;
}

function templatizeHeaders(headers: unknown, bind: BindValue): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return headers;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    const t = typeof value === "string" ? bind(value, `headers.${name}`) : null;
    out[name] = t ?? value;
    if (t) changed = true;
  }
  return changed ? out : headers;
}

function templatizeBody(node: unknown, bind: BindValue, path: string): unknown {
  if (typeof node === "string") return bind(node, path) ?? node;
  if (Array.isArray(node)) {
    const out = node.map((v, i) => templatizeBody(v, bind, `${path}[${i}]`));
    return out.some((v, i) => v !== node[i]) ? out : node;
  }
  if (node && typeof node === "object") {
    if (isSecretRef(node)) return node;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = templatizeBody(v, bind, `${path}.${k}`);
      if (out[k] !== v) changed = true;
    }
    return changed ? out : node;
  }
  return node;
}

/**
 * Resolve a step's bindings against the responses already seen this run.
 * A binding that cannot be resolved is NEVER silently left as a literal: the
 * caller turns the reported problem into a failed step, because a replay that
 * quietly sends `{{id_2}}` (or a stale id) is a corrupted one.
 * @param {object[]} bindings the step envelope's binding records
 * @param {Map<number, unknown>} ledger run step -> that step's parsed response body
 * @returns {{ vars: Map<string,string>, problems: string[] }}
 */
export function resolveBindings(
  bindings: BindingRecord[] | null | undefined,
  ledger: Map<number, unknown>
): { vars: Map<string, string>; problems: string[] } {
  const vars = new Map<string, string>();
  const problems: string[] = [];
  for (const b of bindings ?? []) {
    if (!ledger.has(b.from_step)) {
      problems.push(`{{${b.name}}} cites step ${b.from_step}, which recorded no response body to read`);
      continue;
    }
    const value = readAt(ledger.get(b.from_step) as import("./match.ts").MatchNode, pathSegments(b.from));
    if (value === undefined || value === null || typeof value === "object") {
      problems.push(`{{${b.name}}} reads ${b.from} of step ${b.from_step}'s response, which no longer carries a value there`);
      continue;
    }
    vars.set(b.name, String(value));
  }
  return { vars, problems };
}

/**
 * Substitute `{{name}}` tokens through an action's path, headers, and body.
 * Reports every unresolved token and every value that would reshape the URL, so
 * the caller can fail the step loudly instead of sending a corrupted request.
 * @returns {{ path, headers, body, missing: string[], unsafe: string[] }}
 */
export function applyBindings(
  action: ApiRequestAction | null | undefined,
  vars: Map<string, string>
): { path: unknown; headers: unknown; body: unknown; missing: string[]; unsafe: string[] } {
  const missing: string[] = [];
  const unsafe: string[] = [];
  const sub = (text: unknown, { url = false }: { url?: boolean } = {}): string =>
    String(text).replace(BINDING_TOKEN_RE, (token, name) => {
      if (!vars.has(name)) {
        missing.push(name);
        return token;
      }
      const value = vars.get(name);
      if (url && !URL_SAFE_RE.test(value as string)) unsafe.push(`${name}=${value}`);
      return value as string;
    });
  const deep = (node: unknown): unknown => {
    // Cheap literal pre-check rather than BINDING_TOKEN_RE.test(): the token
    // pattern is global, and `test` on a /g regex carries lastIndex between calls.
    if (typeof node === "string") return node.includes("{{") ? sub(node) : node;
    if (Array.isArray(node)) {
      const out: unknown[] = node.map(deep);
      return out.some((v, i) => v !== node[i]) ? out : node;
    }
    if (node && typeof node === "object") {
      if (isSecretRef(node)) return node;
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = deep(v);
        if (out[k] !== v) changed = true;
      }
      return changed ? out : node;
    }
    return node;
  };
  const path = typeof action?.path === "string" ? sub(action.path, { url: true }) : action?.path;
  return { path, headers: deep(action?.headers), body: deep(action?.body), missing, unsafe };
}
