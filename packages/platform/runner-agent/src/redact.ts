// What may not leave this process in the words it arrived in. Two kinds of
// needle, one primitive:
//
//   secrets        — a ring's resolved values, a mint grant's env, an external
//                    Appium credential, the individual values inside a minted
//                    session's storage state. There is nothing safe to say about
//                    them, so they become "[redacted]".
//   physical facts — the build path, the device and the Appium endpoint a
//                    mobile group resolved from THIS runner's config file
//                    (design gate 9: no platform-managed record carries a
//                    runner-resolved physical fact). A placeholder naming the
//                    KIND of fact is what keeps the remaining text a
//                    diagnosis — "connect ECONNREFUSED <endpoint>" still says
//                    what happened. Same approach as appium.ts's `tail()`.
//
// The two kinds have deliberately different policies about what is worth
// masking, because they answer different questions. A physical mask exists to
// keep a diagnosis readable, so a degenerate one-character needle is dropped:
// masking it would shred unrelated text and protect nothing anyone chose. A
// secret mask exists to keep a configured value off the platform, so it has no
// minimum at all — a four-character API key is a poor key, but silently
// declining to redact it is a leak, and security outranks pretty output.

/** One needle and the text that replaces every occurrence of it. */
export interface Mask {
  value: unknown;
  with: string;
  /**
   * The shortest needle worth masking. Defaults to 1 — every non-empty value.
   * Physical masks raise it; secret masks never do.
   */
  min?: number;
}

/**
 * The floor a PHYSICAL needle must clear. A one-character device name or a
 * single-letter directory is the degenerate case where masking would shred
 * unrelated text instead of protecting anything.
 */
export const MIN_PHYSICAL_NEEDLE = 4;

/**
 * Keys under which a string is a LOCATION rather than a secret. Cookie names,
 * their domains and paths, and an origin say what a value was for; they are not
 * confidential, they appear in unrelated text constantly, and masking them would
 * shred a diagnosis for nothing. Every other string leaf under a secret source
 * is treated as a value worth protecting.
 */
const STRUCTURAL_KEYS = new Set(["name", "domain", "path", "origin", "sameSite", "url"]);

/**
 * Replace each needle with its own mask, longest needle first so a value that
 * contains another (a build path and its directory) is masked as the whole
 * thing rather than in pieces.
 *
 * Every needle is registered twice: as it was configured, and as it appears
 * inside a JSON document. A value holding a quote or a backslash is written
 * escaped in `trajectory.jsonl` or a manifest and would otherwise pass straight
 * through the mask that was supposed to catch it. Longest-first ordering also
 * makes the escaped form win where both could match, which is what keeps the
 * rewritten document parseable.
 */
export function makeMasker(masks: Mask[] = []): (input: unknown) => string {
  const seen = new Set<string>();
  const needles: Array<[string, string]> = [];
  const add = (needle: string, mask: string) => {
    if (seen.has(needle)) return;
    seen.add(needle);
    needles.push([needle, mask]);
  };
  for (const mask of masks) {
    if (typeof mask.value !== "string" || mask.value.length < Math.max(1, mask.min ?? 1)) continue;
    add(mask.value, mask.with);
    add(jsonEscaped(mask.value), mask.with);
  }
  needles.sort((a, b) => b[0].length - a[0].length);
  return (input: unknown) => {
    let out = String(input ?? "");
    for (const [needle, mask] of needles) out = out.split(needle).join(mask);
    return out;
  };
}

/** A string as it is spelled inside a JSON document, without its quotes. */
function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function makeRedactor(values: unknown[] = []): (input: unknown) => string {
  return makeMasker(secretMasks(values));
}

/** Secret values as masks, for composing with the physical ones. */
export function secretMasks(values: unknown[] = []): Mask[] {
  return values.map((value) => ({ value, with: "[redacted]" }));
}

/**
 * Every configured secret VALUE a group carries: the ring's resolved secrets,
 * and each leaf value inside a minted session's storage state.
 *
 * A storage state is a structured document — cookies with names and values,
 * origins with local-storage entries — and the thing worth protecting is the
 * values inside it, one needle each. Serializing the whole document as a single
 * needle protects nothing: that exact byte sequence never appears in a run's
 * evidence, while the session cookie inside it appears in every request the
 * driver made.
 */
export function collectSecretValues(spec: RunnerDynamic, sessions: Record<string, RunnerDynamic> = {}): unknown[] {
  const vals: unknown[] = Object.values(spec.ring?.resolved_secrets || {});
  for (const s of Object.values(sessions)) collectLeafValues(s.storage_state, vals);
  return vals;
}

/**
 * Push every non-empty string leaf of `value` onto `out`, skipping the keys that
 * name a location rather than a secret (`STRUCTURAL_KEYS`). Recursive, because a
 * token can sit two levels down inside `origins[].localStorage[]` as readily as
 * on a top-level cookie.
 */
export function collectLeafValues(value: unknown, out: unknown[] = [], key: string | null = null): unknown[] {
  if (typeof value === "string") {
    if (value && !(key !== null && STRUCTURAL_KEYS.has(key))) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeafValues(item, out, key);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, item] of Object.entries(value as Record<string, unknown>)) collectLeafValues(item, out, k);
  }
  return out;
}

/**
 * Every string inside `value`, masked. Used on the whole case report before it
 * is posted: a physical fact reaches the platform through the manifest's
 * `result.error` as readily as through the report's own error line, and a
 * report carries only metadata (the evidence bundle travels as bytes on its own
 * route), so there is nothing large to walk.
 */
export function redactDeep<T>(value: T, redact: (input: unknown) => string): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(item, redact);
    return out as unknown as T;
  }
  return value;
}
