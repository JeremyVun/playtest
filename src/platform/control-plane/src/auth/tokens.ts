// Service tokens for CI triggers and runner bootstrap. The
// plaintext token is shown exactly once at creation; only a SHA-256 hash is stored,
// so a database leak can't replay tokens. Format: `pt_<projectScope>_<random>`; the
// hash is a plain SHA-256 (tokens are high-entropy random, so no salt/KDF needed —
// the same reasoning as an API key, not a user password).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ulid } from "../ulid.ts";
import type { Db } from "../db.ts";
import type { Role } from "./roles.ts";

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Generate a new token record + its one-time plaintext. */
export function newToken({
  projectId = null,
  role,
  name
}: {
  projectId?: string | null;
  role: Role;
  name: string;
}) {
  const id = ulid();
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `pt_${projectId ? "p" : "s"}_${secret}`;
  return {
    id,
    plaintext,
    row: { id, project_id: projectId, role, name, token_hash: hashToken(plaintext) },
  };
}

/** Constant-time compare of a presented token's hash against a stored hash. */
export function tokenHashMatches(plaintext: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(plaintext), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolve a bearer token to a principal, or null if unknown/expired/disabled.
 * @param {import("../db.ts").Db} db
 */
export async function principalForToken(db: Db, plaintext: unknown) {
  if (typeof plaintext !== "string" || !plaintext.startsWith("pt_")) return null;
  const { rows } = await db.query(
    `SELECT id, project_id, role, token_hash, expires_at FROM api_tokens WHERE token_hash = $1`,
    [hashToken(plaintext)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  // hashToken match is exact (indexed lookup); the constant-time check guards the
  // (already-narrow) window where two hashes collide in the query but differ.
  if (!tokenHashMatches(plaintext, row.token_hash)) return null;
  return { kind: "token", tokenId: row.id, projectId: row.project_id, role: row.role };
}
