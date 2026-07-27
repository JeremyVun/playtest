// Deterministic pseudo-random source for the ledger fixture.
//
// The fixture must produce the same identifiers for the same seed on every
// boot and after every `POST /admin/reset`, so nothing here reads the clock or
// `Math.random`. mulberry32 over an FNV-1a seed hash is enough: identifiers
// only need to look opaque, not to be unpredictable.

/** FNV-1a 32-bit hash of a string. Pure. */
export function hashSeed(seed) {
  let h = 0x811c9dc5;
  const text = String(seed ?? "");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small, fast, fully deterministic 32-bit PRNG. */
export function makeRng(seed) {
  let a = hashSeed(seed);
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Crockford-ish base32 without vowels or ambiguous glyphs: identifiers stay
// copy-pasteable into a story or a bug report.
const ALPHABET = "0123456789bcdfghjkmnpqrstvwxyz";

/** Deterministic opaque token of `length` characters drawn from `rng`. */
export function token(rng, length = 10) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}
