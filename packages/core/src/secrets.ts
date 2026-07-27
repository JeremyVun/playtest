// Secret references, resolution, and redaction
// (docs/contracts/engine.md#secrets-and-redaction).
//
// A secret reference is the object `{ $secret: "NAME" }` — the same convention
// the hosted layer already uses for its own refs
// (packages/platform/runner-agent/src/workspace.ts). Core resolves a reference from
// exactly two sources, in this order:
//
//   1. an explicitly registered provider (the seam the hosted runner-agent uses
//      to hand core values from the control plane's secret store), then
//   2. the process environment variable `PLAYTEST_SECRET_<NAME>`.
//
// The CLI still never loads `.env` — nothing here reads a file.
//
// Every value core resolves is recorded in the known-secret registry, so
// `redactSecrets(text)` can scrub it out of anything the harness persists or
// shows (snapshots, har.json, logs, the actor's own view). Registration happens
// at resolution time, which is what makes redaction automatic for every value
// core injected.
import { DummyConfigError } from "./config.ts";
import type {
  RedactConfig,
  ResolvedRedact,
  SecretHeader,
  SecretReference,
} from "./types.ts";

/** Environment-variable prefix a `{ $secret: "NAME" }` reference resolves from. */
export const SECRET_ENV_PREFIX = "PLAYTEST_SECRET_";

// A reference name doubles as the tail of an environment variable name, so it is
// restricted to the identifier characters a shell can export.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Values shorter than this are NOT scrubbed from free text: a 1–3 character
// needle matches unrelated content everywhere and would shred artifacts far more
// than it protects. Real credentials are longer; the leak scan still reports a
// short value it finds in a committed baseline.
export const MIN_REDACTABLE_LENGTH = 4;

type SecretProvider = (name: string) => string | null | undefined;
interface KnownSecret {
  name: string;
  template: boolean;
}

let provider: SecretProvider | null = null;
/** resolved value -> { name, template }. `template: false` marks a DERIVED value
 *  (see registerSecretValue): scrubbed from artifacts, but never turned back into
 *  a reference — resolving that reference would yield the full value, not this
 *  fragment. */
const known = new Map<string, KnownSecret>();

// A header value is often the whole `Bearer <token>` string, because a reference
// substitutes a value, not part of one. When it is, the bare credential is a
// secret too: a server that echoes the token back echoes it WITHOUT the scheme.
const AUTH_SCHEME_RE = /^(Bearer|Basic|Token|ApiKey|Digest)\s+(\S+)$/i;

/**
 * Install the explicit provider consulted before the environment. Pass null to
 * clear it. `fn(name)` returns a string or null/undefined for "not mine".
 */
export function setSecretProvider(fn: SecretProvider | null): void {
  if (fn !== null && typeof fn !== "function") throw new TypeError("secret provider must be a function or null");
  provider = fn;
}

/** Test/host seam: drop the provider and every registered value. */
export function resetSecrets(): void {
  provider = null;
  known.clear();
}

/** Is this a `{ $secret: "NAME" }` reference? */
export function isSecretRef(value: unknown): value is SecretReference {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && "$secret" in value
    && typeof value.$secret === "string";
}

/** The stable placeholder token redaction leaves behind. */
export function secretPlaceholder(name: string): string {
  return `[secret:${name}]`;
}

/** Every reference name inside an arbitrary config value, sorted and deduped. */
export function collectSecretRefNames(
  value: unknown,
  out = new Set<string>()
): string[] {
  if (isSecretRef(value)) out.add(value.$secret);
  else if (Array.isArray(value)) for (const v of value) collectSecretRefNames(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectSecretRefNames(v, out);
  return [...out].sort();
}

/**
 * Resolve one secret by name. Provider first, then `PLAYTEST_SECRET_<NAME>`.
 * A missing value is a DummyConfigError naming both the secret and the exact
 * variable to set — never an empty string, never a silent skip.
 * @param {string} name
 * @param {{ where?: string }} [opts] `where` prefixes the error (usually the case file)
 */
export function resolveSecret(
  name: string,
  { where = "" }: { where?: string } = {}
): string {
  const at = where ? `${where}: ` : "";
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new DummyConfigError(
      `${at}invalid secret reference { $secret: ${JSON.stringify(name)} } — a secret name is letters, digits and underscores` +
        ` (it names the ${SECRET_ENV_PREFIX}<NAME> environment variable)`,
    );
  }
  let value = null;
  if (provider) {
    try {
      value = provider(name);
    } catch (e: any) { // SAFETY: providers may throw non-Error values
      throw new DummyConfigError(`${at}secret "${name}" could not be resolved: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  if (typeof value !== "string" || value === "") value = process.env[`${SECRET_ENV_PREFIX}${name}`];
  if (typeof value !== "string" || value === "") {
    throw new DummyConfigError(
      `${at}secret "${name}" has no value — export ${SECRET_ENV_PREFIX}${name} in the environment that runs playtest` +
        ` (playtest never reads .env files)`,
    );
  }
  registerSecretValue(value, name);
  return value;
}

/**
 * Record an already-resolved value so redaction covers it. Used by resolveSecret
 * and by hosts that inject their own values through the provider seam. An
 * `<auth-scheme> <credential>` value also registers its credential half for
 * redaction only.
 */
export function registerSecretValue(value: unknown, name?: unknown): void {
  if (typeof value !== "string" || !value) return;
  const label = typeof name === "string" && name ? name : "secret";
  known.set(value, { name: label, template: true });
  const scheme: (RegExpMatchArray & { 2: string }) | null = value.match(AUTH_SCHEME_RE) as (RegExpMatchArray & { 2: string }) | null;
  if (scheme && scheme[2].length >= MIN_REDACTABLE_LENGTH && !known.has(scheme[2])) {
    known.set(scheme[2], { name: label, template: false });
  }
}

/**
 * Best-effort registration of named secrets from the environment, for a process
 * that did not run the case (`playtest baseline accept` in a later shell): a
 * value that is present can be scanned for, a value that is absent is simply not
 * checked. Never throws — this is not a resolution path.
 */
export function registerSecretsFromEnv(names: Iterable<unknown> | null | undefined): void {
  for (const name of names ?? []) {
    if (typeof name !== "string" || !NAME_RE.test(name)) continue;
    registerSecretValue(process.env[`${SECRET_ENV_PREFIX}${name}`], name);
  }
}

/** Deep-resolve every `{ $secret: … }` reference in a config value. */
export function resolveSecretRefs(
  value: unknown,
  { where = "" }: { where?: string } = {}
): unknown {
  if (isSecretRef(value)) return resolveSecret(value.$secret, { where });
  if (Array.isArray(value)) return value.map((v) => resolveSecretRefs(v, { where }));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveSecretRefs(v, { where });
    return out;
  }
  return value;
}

/** Registered values, longest first, as [value, name] pairs. */
export function knownSecretValues(): Array<[string, string]> {
  return [...known.entries()]
    .filter(([value]) => value.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([value, entry]) => [value, entry.name]);
}

/** True when at least one scrubbable value is registered (a cheap fast path). */
export function hasKnownSecrets(): boolean {
  return knownSecretValues().length > 0;
}

/**
 * The reference name a literal value came from, or null. Lets a recorder turn an
 * injected literal back into the `{ $secret: … }` template it was resolved from.
 */
export function secretNameForValue(value: unknown): string | null {
  const entry = typeof value === "string" ? known.get(value) : null;
  return entry?.template ? entry.name : null;
}

/**
 * Replace every known secret value in `text` with its stable placeholder. Both
 * the raw value and its JSON-escaped form are replaced, so scrubbing a
 * serialized document (har.json, a JSONL line) catches values containing quotes
 * or backslashes.
 */
export function redactSecrets(text: string): string;
export function redactSecrets<T>(text: T): T;
export function redactSecrets(text: unknown): unknown {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [value, name] of knownSecretValues()) {
    const token = secretPlaceholder(name);
    if (out.includes(value)) out = out.split(value).join(token);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value && out.includes(escaped)) out = out.split(escaped).join(token);
  }
  return out;
}

/**
 * Header maps carrying secret references: `{ "Authorization": { $secret: "TOKEN" } }`
 * or a literal string value. Validated at config time (shape, names) so a typo is
 * a DummyConfigError naming the file; values are resolved later, at driver launch.
 * Returns a normalized copy, or null when the key is absent.
 * Pure; exported for test.
 */
export function normalizeSecretHeaders(
  value: unknown,
  file: string,
  key = "app.headers"
): Record<string, SecretHeader> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DummyConfigError(`${file}: ${key} must be a map of header name to a string or { $secret: NAME }`);
  }
  const out: Record<string, SecretHeader> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!name.trim() || /[\s:]/.test(name)) {
      throw new DummyConfigError(`${file}: ${key} name ${JSON.stringify(name)} is not a valid HTTP header name`);
    }
    if (typeof entry === "string") {
      out[name] = entry;
      continue;
    }
    if (isSecretRef(entry)) {
      if (!NAME_RE.test(entry.$secret)) {
        throw new DummyConfigError(
          `${file}: ${key}.${name} has an invalid secret name ${JSON.stringify(entry.$secret)}` +
            ` — use letters, digits and underscores (it names ${SECRET_ENV_PREFIX}<NAME>)`,
        );
      }
      out[name] = { $secret: entry.$secret };
      continue;
    }
    throw new DummyConfigError(
      `${file}: ${key}.${name} must be a string or a secret reference { $secret: NAME }` +
        ` (got ${entry === null ? "null" : Array.isArray(entry) ? "a list" : typeof entry})`,
    );
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The `redact:` block: which request-template and projection fields carry
 * application-sensitive values (docs/contracts/engine.md#secrets-and-redaction).
 *
 *   redact:
 *     request:
 *       - path: body.owner_email
 *         secret: OWNER_EMAIL
 *     projection:
 *       - $.balances_by_email
 *
 * A request entry commits as a `{ $secret: … }` placeholder and is resolved again
 * at act time, so acting keeps working from the committed form — which is why the
 * `secret` naming its value source is required. A projection entry is only ever
 * omitted/shape-normalized: a projection is an observation, never resolved.
 * Returns null when nothing is declared. Pure; exported for test.
 */
export function normalizeRedact(
  value: RedactConfig | null | undefined,
  file: string
): ResolvedRedact | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DummyConfigError(`${file}: redact must be a map with "request" and/or "projection" lists`);
  }
  const request: ResolvedRedact["request"] = [];
  for (const entry of value.request ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DummyConfigError(`${file}: redact.request entries are { path: <field path>, secret: NAME } objects`);
    }
    const path = entry.path;
    if (typeof path !== "string" || !/^(headers|body)\b/.test(path.trim())) {
      throw new DummyConfigError(
        `${file}: redact.request path ${JSON.stringify(path)} must start with "headers." or "body" — ` +
          `only request-template fields can be redacted and re-resolved`,
      );
    }
    if (typeof entry.secret !== "string" || !NAME_RE.test(entry.secret)) {
      throw new DummyConfigError(
        `${file}: redact.request ${JSON.stringify(path)} needs "secret: NAME" naming the value to re-resolve at act time` +
          ` (from ${SECRET_ENV_PREFIX}NAME) — a request template with no value source could never be acted`,
      );
    }
    request.push({ path: path.trim(), secret: entry.secret });
  }
  const projection: string[] = [];
  for (const entry of value.projection ?? []) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new DummyConfigError(`${file}: redact.projection entries are field paths, e.g. "$.customer.email"`);
    }
    projection.push(entry.trim());
  }
  const extra = Object.keys(value).filter((k) => k !== "request" && k !== "projection");
  if (extra.length) throw new DummyConfigError(`${file}: unknown redact key(s) ${extra.join(", ")} (expected request, projection)`);
  return request.length || projection.length ? { request, projection } : null;
}
