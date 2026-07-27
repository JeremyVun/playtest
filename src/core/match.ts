// Match rules: the field-path vocabulary API drift comparison is normalized
// through (docs/contracts/engine.md#match-rules).
//
// The committed API snapshot is a normalized RESPONSE PROJECTION — status plus
// body shape, never raw values (docs/contracts/artifacts.md#step-envelope).
// Shape alone already absorbs fresh ids and timestamps, but two things still
// read as drift on a healthy app: a volatile *structure* (a list whose length
// varies, a debug block whose keys change) and a value a suite genuinely wants
// compared. Match rules name both:
//
//   match:
//     exclude:  ["$.debug"]          # value -> "[excluded]"; the KEY stays
//     compare:  ["$.status"]         # the literal value enters the projection
//     normalize:
//       - path: "$.items"
//         rule: length               # arrays -> their length
//     status_equivalent:
//       - [201, 202]                 # declared step-scoped status equivalence
//
// The one invariant every rule obeys: **key structure always survives**. An
// excluded, normalized, or redacted node keeps its key and reports a marker, so
// a renamed response field still changes the projection and still triggers
// drift. A rule can widen or quiet a value; no rule can hide that a field was
// renamed, added, or removed.
import { DummyConfigError } from "./config.ts";
import type { MatchConfig, ResolvedMatch } from "./types.ts";

export type PathSegment =
  | { key: string; each?: never; index?: never }
  | { each: true; key?: never; index?: never }
  | { index: number; key?: never; each?: never };

export type MatchNode =
  | string
  | number
  | boolean
  | null
  | undefined
  | MatchNode[]
  | { [key: string]: MatchNode }
  | Verbatim
  | Normalized;

/** Sentinel for a `redact.projection` field: the value is application data. */
export const REDACTED = { $redacted: true };
/** Sentinel for a `match.exclude` field: the value is volatile, the key is not. */
export const EXCLUDED = { $excluded: true };

/** A node whose literal value enters the projection (`match.compare`). */
class Verbatim {
  [key: string]: MatchNode;
  declare value: MatchNode;

  constructor(value: MatchNode) {
    this.value = value;
  }
}

/** A node rewritten by a `match.normalize` rule before shaping. */
class Normalized {
  [key: string]: MatchNode;
  declare rule: "sorted" | "length";
  declare value: MatchNode;

  constructor(rule: "sorted" | "length", value: MatchNode) {
    this.rule = rule;
    this.value = value;
  }
}

/** The closed normalization vocabulary. Unknown rules are config errors. */
export const NORMALIZE_RULES: Array<"sorted" | "length"> = ["sorted", "length"];

// ---- field paths ----

/**
 * Parse a field path into walk segments. `$.a.b`, `a.b`, `a[*].b`, and
 * `a[0].b` are all accepted; `[*]` steps into every element of a list, `[n]`
 * into one. A bare `$` (or `body`, for a request path) selects the whole node.
 * Pure; exported for test.
 */
export function pathSegments(
  expr: unknown,
  { strip = "" }: { strip?: string } = {}
): PathSegment[] {
  let s = String(expr ?? "").trim();
  if (s.startsWith("$")) s = s.slice(1);
  if (s.startsWith(".")) s = s.slice(1);
  if (strip && (s === strip || s.startsWith(`${strip}.`) || s.startsWith(`${strip}[`))) s = s.slice(strip.length).replace(/^\./, "");
  const segs: PathSegment[] = [];
  for (const raw of s.split(".")) {
    if (!raw) continue;
    const m = raw.match(/^([^[\]]*)((?:\[(?:\*|\d+)\])*)$/) as RegExpMatchArray & { 1: string; 2: string };
    if (!m) {
      segs.push({ key: raw });
      continue;
    }
    if (m[1]) segs.push({ key: m[1] });
    for (const step of m[2].match(/\[(?:\*|\d+)\]/g) ?? []) {
      segs.push(step === "[*]" ? { each: true } : { index: Number(step.slice(1, -1)) });
    }
  }
  return segs;
}

/** Replace the node at `segs` with `replacement`, structurally sharing the rest. */
export function replaceAt(
  node: MatchNode,
  segs: PathSegment[],
  replacement: MatchNode | ((value: MatchNode) => MatchNode)
): MatchNode {
  if (!segs.length) return typeof replacement === "function" ? replacement(node) : replacement;
  const [head, ...tail] = segs as [PathSegment, ...PathSegment[]];
  if (head.each) {
    if (!Array.isArray(node)) return node;
    return node.map((v) => replaceAt(v, tail, replacement));
  }
  if (head.index !== undefined) {
    if (!Array.isArray(node) || head.index >= node.length) return node;
    const out = node.slice();
    out[head.index] = replaceAt(node[head.index], tail, replacement);
    return out;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  if (!Object.prototype.hasOwnProperty.call(node, head.key)) return node;
  return { ...node, [head.key]: replaceAt(node[head.key], tail, replacement) };
}

/** Read the node at `segs`, or undefined. `[*]` yields the first element that resolves. */
export function readAt(node: MatchNode, segs: PathSegment[]): MatchNode {
  let cur: MatchNode = node;
  for (let i = 0; i < segs.length; i++) {
    const head = segs[i] as PathSegment;
    if (head.each) {
      if (!Array.isArray(cur)) return undefined;
      for (const v of cur) {
        const found = readAt(v, segs.slice(i + 1));
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (head.index !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[head.index];
      continue;
    }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, head.key)) return undefined;
    cur = cur[head.key];
  }
  return cur;
}

/** Read the node at `segs`. Arrays under `[*]` yield their elements. */
export function existsAt(node: MatchNode, segs: PathSegment[]): boolean {
  if (!segs.length) return node !== undefined;
  const [head, ...tail] = segs as [PathSegment, ...PathSegment[]];
  if (head.each) return Array.isArray(node) && node.some((v) => existsAt(v, tail));
  if (head.index !== undefined) return Array.isArray(node) && existsAt(node[head.index], tail);
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  if (!Object.prototype.hasOwnProperty.call(node, head.key)) return false;
  return existsAt(node[head.key], tail);
}

// ---- projection shaping ----

/**
 * The shape of a parsed JSON value: key structure and types, never raw values.
 * Arrays keep their length (a missing list entry IS behavioral drift). Object
 * keys survive because they are structure — which is why the leak scan reads
 * projections, and why a rule-marked path reports a marker instead of dropping.
 * Pure; exported for test.
 */
export function shapeOf(value: MatchNode): unknown {
  if (value === REDACTED) return "[redacted]";
  if (value === EXCLUDED) return "[excluded]";
  if (value instanceof Verbatim) return verbatimOf(value.value);
  if (value instanceof Normalized) return normalizedOf(value, shapeOf);
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k]);
    return out;
  }
  return typeof value; // "string" | "number" | "boolean"
}

/** A compared node renders literally — but a sentinel nested inside it still wins. */
function verbatimOf(value: MatchNode): unknown {
  if (value === REDACTED) return "[redacted]";
  if (value === EXCLUDED) return "[excluded]";
  if (value instanceof Verbatim) return verbatimOf(value.value);
  if (value instanceof Normalized) return normalizedOf(value, verbatimOf);
  if (Array.isArray(value)) return value.map(verbatimOf);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = verbatimOf(value[k]);
    return out;
  }
  return value;
}

/**
 * `render` is the projection the normalized node sits inside — shape by default,
 * verbatim when a `compare` rule encloses it. Without that, `sorted` inside a
 * `compare` would sort SHAPES and quietly discard the values the case asked to
 * compare.
 */
function normalizedOf(
  { rule, value }: Normalized,
  render: (value: MatchNode) => unknown
): unknown {
  if (rule === "length") {
    if (Array.isArray(value) || typeof value === "string") return { length: value.length };
    return render(value);
  }
  if (rule === "sorted" && Array.isArray(value)) {
    return value.map(render).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  return render(value);
}

/**
 * Apply the redaction list and the case's match rules to a parsed response body,
 * yielding the value `shapeOf` projects. Order is load-bearing: redaction and
 * exclusion run FIRST, on the raw parse, so a later `compare` covering the same
 * subtree cannot resurrect a value they suppressed. Pure; exported for test.
 */
export function applyMatchRules(
  parsed: MatchNode,
  {
    redact = [],
    match = null
  }: { redact?: string[]; match?: ResolvedMatch | null } = {}
): MatchNode {
  let out = parsed;
  for (const p of redact ?? []) out = replaceAt(out, pathSegments(p), REDACTED);
  for (const p of match?.exclude ?? []) out = replaceAt(out, pathSegments(p), EXCLUDED);
  for (const { path: p, rule } of match?.normalize ?? []) {
    out = replaceAt(out, pathSegments(p), (node: MatchNode) => (node === REDACTED || node === EXCLUDED ? node : new Normalized(rule, node)));
  }
  for (const p of match?.compare ?? []) {
    out = replaceAt(out, pathSegments(p), (node: MatchNode) => (node === REDACTED || node === EXCLUDED ? node : new Verbatim(node)));
  }
  return out;
}

// ---- step-scoped status normalization ----

/** "201" exact, or a "2xx" class. Shared with the gate's status matching. */
export function statusMatchesPattern(pattern: unknown, status: unknown): boolean {
  const p = String(pattern).trim();
  if (/^[1-5]xx$/i.test(p)) return new RegExp(`^${p[0]}\\d\\d$`).test(String(status));
  return p === String(status);
}

/**
 * Are two observed statuses the same *for drift purposes*? Exact equality
 * always; anything wider only because the case declared it under
 * `match.status_equivalent`. There is deliberately no default class match: a
 * silent 201 -> 202 or 200 -> 204 is exactly the contract change step-scoped
 * expectations exist to catch (docs/contracts/engine.md#act-and-heal).
 * Pure; exported for test.
 */
export function statusesEquivalent(
  a: unknown,
  b: unknown,
  match: ResolvedMatch | null = null
): boolean {
  if (String(a) === String(b)) return true;
  for (const group of match?.status_equivalent ?? []) {
    if (typeof group === "string") {
      if (statusMatchesPattern(group, a) && statusMatchesPattern(group, b)) return true;
      continue;
    }
    const set = group.map(String);
    if (set.includes(String(a)) && set.includes(String(b))) return true;
  }
  return false;
}

/**
 * The comparison-time stand-in for an observed status: the LOWEST member of the
 * equivalence group it belongs to (or the group's class string), so two statuses
 * a case declared interchangeable normalize to one token before the snapshot
 * oracle compares them. Authoring order is irrelevant, and a status in no group
 * is returned unchanged. Applied when comparing, never when persisting — a
 * baseline always records the status that actually happened.
 * Pure; exported for test.
 */
export function canonicalStatus(
  status: unknown,
  match: ResolvedMatch | null = null
): string {
  const s = String(status);
  for (const group of match?.status_equivalent ?? []) {
    if (typeof group === "string") {
      if (statusMatchesPattern(group, s)) return group;
      continue;
    }
    const set = group.map(String);
    if (set.includes(s)) return [...set].sort()[0] as string;
  }
  return s;
}

// ---- configuration ----

const FIELD_PATH_RE = /^\$?[.[]?[A-Za-z0-9_$\-[\]*.]*$/;

function checkPath(p: unknown, file: string, where: string): string {
  if (typeof p !== "string" || !p.trim()) {
    throw new DummyConfigError(`${file}: ${where} entries are field paths, e.g. "$.items[*].id"`);
  }
  const s = p.trim();
  if (!FIELD_PATH_RE.test(s)) {
    throw new DummyConfigError(
      `${file}: ${where} path ${JSON.stringify(p)} is not a field path — write "$.a.b", "a.b", "a[*].b", or "$" for the whole body`,
    );
  }
  return s;
}

/**
 * The `match:` block (docs/contracts/engine.md#match-rules). Returns null when
 * nothing is declared, so a suite that never matches is byte-identical to one
 * from before match rules existed. Pure; exported for test.
 */
export function normalizeMatch(
  value: MatchConfig | null | undefined,
  file: string
): ResolvedMatch | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DummyConfigError(`${file}: match must be a map with "exclude", "compare", "normalize", and/or "status_equivalent"`);
  }
  const known = new Set(["exclude", "compare", "normalize", "status_equivalent"]);
  const extra = Object.keys(value).filter((k) => !known.has(k));
  if (extra.length) {
    throw new DummyConfigError(`${file}: unknown match key(s) ${extra.join(", ")} (expected ${[...known].join(", ")})`);
  }
  const exclude = (value.exclude ?? []).map((p) => checkPath(p, file, "match.exclude"));
  const compare = (value.compare ?? []).map((p) => checkPath(p, file, "match.compare"));
  const normalize: NonNullable<ResolvedMatch["normalize"]> = [];
  for (const entry of value.normalize ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DummyConfigError(`${file}: match.normalize entries are { path: <field path>, rule: ${NORMALIZE_RULES.join("|")} } objects`);
    }
    const p = checkPath(entry.path, file, "match.normalize");
    if (!NORMALIZE_RULES.includes(entry.rule)) {
      throw new DummyConfigError(
        `${file}: match.normalize ${JSON.stringify(p)} has rule ${JSON.stringify(entry.rule ?? null)} —` +
          ` the vocabulary is ${NORMALIZE_RULES.join(", ")}`,
      );
    }
    normalize.push({ path: p, rule: entry.rule });
  }
  const statusEquivalent: NonNullable<ResolvedMatch["status_equivalent"]> = [];
  for (const group of value.status_equivalent ?? []) {
    if (typeof group === "string" && /^[1-5]xx$/i.test(group.trim())) {
      statusEquivalent.push(group.trim().toLowerCase());
      continue;
    }
    if (!Array.isArray(group) || group.length < 2) {
      throw new DummyConfigError(
        `${file}: match.status_equivalent entries are a class like "2xx" or a list of at least two statuses like [201, 202] —` +
          ` a status class is never the default, because a silent 201 -> 202 is exactly the contract change this catches`,
      );
    }
    const set = group.map((s) => {
      if (!/^\d{3}$/.test(String(s).trim())) {
        throw new DummyConfigError(`${file}: match.status_equivalent has ${JSON.stringify(s)}, which is not a three-digit status`);
      }
      return String(s).trim();
    });
    statusEquivalent.push(set);
  }
  if (!exclude.length && !compare.length && !normalize.length && !statusEquivalent.length) return null;
  return {
    ...(exclude.length ? { exclude } : {}),
    ...(compare.length ? { compare } : {}),
    ...(normalize.length ? { normalize } : {}),
    ...(statusEquivalent.length ? { status_equivalent: statusEquivalent } : {}),
  };
}
