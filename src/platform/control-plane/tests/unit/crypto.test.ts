import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "../../src/crypto/secrets.ts";
import { AppError } from "../../src/errors.ts";

const key = randomBytes(32);

test("secrets: AES-256-GCM round-trip", () => {
  const plain = "s3cr3t token: a/b+c=";
  const ct = encryptSecret(key, plain);
  assert.ok(Buffer.isBuffer(ct));
  assert.notEqual(ct.toString("utf8"), plain);
  assert.equal(decryptSecret(key, ct), plain);
});

test("secrets: each encryption uses a fresh IV (ciphertexts differ)", () => {
  const a = encryptSecret(key, "same");
  const b = encryptSecret(key, "same");
  assert.notDeepEqual(a, b);
  assert.equal(decryptSecret(key, a), decryptSecret(key, b));
});

test("secrets: tampering fails authentication", () => {
  const ct: HostedDynamic = Buffer.from(encryptSecret(key, "hello"));
  ct[ct.length - 1] ^= 0xff;
  assert.throws(() => decryptSecret(key, ct), (e) => e instanceof AppError);
});

test("secrets: wrong key fails to decrypt", () => {
  const ct = encryptSecret(key, "hello");
  assert.throws(() => decryptSecret(randomBytes(32), ct), (e) => e instanceof AppError);
});

test("secrets: missing KMS key is a friendly config_error", () => {
  assert.throws(() => encryptSecret(null, "x"), (e) => e instanceof AppError && e.code === "config_error" && /PLAYTEST_KMS_KEY/.test(e.message));
});
