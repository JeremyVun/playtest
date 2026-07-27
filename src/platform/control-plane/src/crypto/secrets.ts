// Secret encryption at rest.
// AES-256-GCM under the platform KMS key (PLAYTEST_KMS_KEY). Ciphertext layout is
// `iv(12) || authTag(16) || ciphertext` in one BLOB column; GCM authenticates so a
// tampered row fails to decrypt rather than yielding garbage. The plaintext is never
// stored, never logged, and only ever round-trips through here on its way to a
// runner for test-target auth.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../errors.ts";

const IV_LEN = 12;
const TAG_LEN = 16;

function requireKey(kmsKey: Buffer | null): Buffer {
  if (!kmsKey) {
    throw new AppError(
      "config_error",
      "PLAYTEST_KMS_KEY is not set — secrets cannot be encrypted or read " +
        "(generate one with `openssl rand -base64 32`)",
    );
  }
  return kmsKey;
}

/** Encrypt a UTF-8 secret to the on-disk buffer layout. */
export function encryptSecret(kmsKey: Buffer | null, plaintext: string): Buffer {
  const key = requireKey(kmsKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

/** Decrypt the on-disk buffer layout back to a UTF-8 string. */
export function decryptSecret(kmsKey: Buffer | null, buf: Buffer | Uint8Array): string {
  const key = requireKey(kmsKey);
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data.length < IV_LEN + TAG_LEN) throw new AppError("storage_error", "corrupt secret ciphertext");
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = data.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("storage_error", "secret failed to decrypt (wrong KMS key or tampered ciphertext)");
  }
}
