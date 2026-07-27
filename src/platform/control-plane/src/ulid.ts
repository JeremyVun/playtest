// ULID — sortable, 26-char, lexicographically ordered by time (Crockford base32).
// In-repo (~40 lines) because the control plane has no npm dependencies at all
// (docs/contracts/hosted.md). 48-bit ms timestamp + 80-bit randomness;
// monotonic within a millisecond so a burst of ids stays strictly increasing and
// the event-feed cursor (§4a) never re-orders same-ms inserts.
import { randomBytes } from "node:crypto";

// Crockford base32 alphabet (no I, L, O, U — ambiguity-free).
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10; // 48 bits / 5 bits-per-char, ceil
const RAND_LEN = 16; // 80 bits / 5

let lastTime = 0;
let lastRand: Uint8Array | null = null; // Uint8Array(RAND_LEN) of base32 digit values, incremented on collision

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod] as string + out;
    now = (now - mod) / 32;
  }
  return out;
}

function randomDigits() {
  // 16 base32 digits (5 bits each). randomBytes gives whole bytes; take the low 5
  // bits of each of 16 bytes — uniform over 0..31, which is what we want.
  const bytes = randomBytes(RAND_LEN);
  const digits = new Uint8Array(RAND_LEN);
  for (let i = 0; i < RAND_LEN; i++) digits[i] = bytes[i]! & 0x1f; // TODO(ts): The fixed byte count guarantees this typed-array index exists.
  return digits;
}

function incrementDigits(digits: Uint8Array): Uint8Array {
  // Add 1 with carry from the least-significant (rightmost) digit. Overflow of the
  // whole 80-bit field in one ms is astronomically unlikely; if it ever happened we
  // fall back to fresh randomness (still monotone because time will have advanced by
  // the next call).
  for (let i = RAND_LEN - 1; i >= 0; i--) {
    if (digits[i]! < 31) { // TODO(ts): The loop bounds guarantee this typed-array index exists.
      digits[i]!++; // TODO(ts): The loop bounds guarantee this typed-array index exists.
      return digits;
    }
    digits[i] = 0;
  }
  return randomDigits();
}

/**
 * A new ULID. Strictly increasing within a process, including across a backwards
 * clock step (NTP correction, VM resume): ids are the platform-event feed cursor,
 * and one id below a cursor a consumer already passed is an event that consumer
 * never sees. So a non-advancing clock is treated exactly like a same-millisecond
 * collision — reuse the last timestamp and increment the random field.
 */
export function ulid(now = Date.now()): string {
  let digits: Uint8Array;
  if (now <= lastTime && lastRand) {
    now = lastTime;
    digits = incrementDigits(lastRand);
  } else {
    digits = randomDigits();
    lastTime = now;
  }
  lastRand = digits;
  let rand = "";
  for (let i = 0; i < RAND_LEN; i++) rand += ENCODING[digits[i] as number];
  return encodeTime(now) + rand;
}

/** True for a well-formed 26-char Crockford-base32 ULID. */
export function isUlid(s: unknown): s is string {
  if (typeof s !== "string" || s.length !== TIME_LEN + RAND_LEN) return false;
  for (const ch of s) if (!ENCODING.includes(ch)) return false;
  return true;
}
