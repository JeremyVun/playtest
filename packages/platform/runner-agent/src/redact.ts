// What may not leave this process in the words it arrived in. Two kinds of
// needle, one primitive:
//
//   secrets        — a ring's resolved values, a mint grant's env, an external
//                    Appium credential. There is nothing safe to say about
//                    them, so they become "[redacted]".
//   physical facts — the build path, the device and the Appium endpoint a
//                    mobile group resolved from THIS runner's config file
//                    (design gate 9: no platform-managed record carries a
//                    runner-resolved physical fact). A placeholder naming the
//                    KIND of fact is what keeps the remaining text a
//                    diagnosis — "connect ECONNREFUSED <endpoint>" still says
//                    what happened. Same approach as appium.ts's `tail()`.

/** One needle and the text that replaces every occurrence of it. */
export interface Mask {
  value: unknown;
  with: string;
}

/**
 * Needles shorter than this are dropped. They are the degenerate values — a
 * one-character device name, an empty secret — where masking would shred
 * unrelated text instead of protecting anything.
 */
const MIN_NEEDLE = 4;

/**
 * Replace each needle with its own mask, longest needle first so a value that
 * contains another (a build path and its directory) is masked as the whole
 * thing rather than in pieces.
 */
export function makeMasker(masks: Mask[] = []): (input: unknown) => string {
  const seen = new Set<string>();
  const needles: Array<[string, string]> = [];
  for (const mask of masks) {
    if (typeof mask.value !== "string" || mask.value.length < MIN_NEEDLE || seen.has(mask.value)) continue;
    seen.add(mask.value);
    needles.push([mask.value, mask.with]);
  }
  needles.sort((a, b) => b[0].length - a[0].length);
  return (input: unknown) => {
    let out = String(input ?? "");
    for (const [needle, mask] of needles) out = out.split(needle).join(mask);
    return out;
  };
}

export function makeRedactor(values: unknown[] = []): (input: unknown) => string {
  return makeMasker(values.map((value) => ({ value, with: "[redacted]" })));
}

/** Secret values as masks, for composing with the physical ones. */
export function secretMasks(values: unknown[] = []): Mask[] {
  return values.map((value) => ({ value, with: "[redacted]" }));
}

export function collectSecretValues(spec: RunnerDynamic, sessions: Record<string, RunnerDynamic> = {}): unknown[] {
  const vals: unknown[] = Object.values(spec.ring?.resolved_secrets || {});
  for (const s of Object.values(sessions)) vals.push(JSON.stringify(s.storage_state || {}));
  return vals;
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
