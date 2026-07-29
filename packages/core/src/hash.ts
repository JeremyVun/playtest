// The one SHA-256 hex digest helper. Every fingerprint, content address, and
// identity key in this package hashes through here so the algorithm can never
// drift between call sites.
import crypto from "node:crypto";

export function sha256Hex(input: string | NodeJS.ArrayBufferView): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
