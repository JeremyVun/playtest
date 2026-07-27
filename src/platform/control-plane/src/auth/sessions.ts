// Cookie-backed sessions. The cookie value is an opaque
// random id; the row maps it to a user with an expiry. No JWT — a server-side row
// means revocation is a DELETE, and there is nothing to forge. Cookie flags:
// HttpOnly (JS can't read it), SameSite=Lax (OIDC redirect returns survive),
// Secure over https (from PUBLIC_URL).
import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";

const COOKIE_NAME = "pt_session";
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export async function createSession(db: Db, userId: string, { ttlMs = DEFAULT_TTL_MS }: { ttlMs?: number } = {}) {
  const id = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [
    id,
    userId,
    expiresAt,
  ]);
  return { id, expiresAt };
}

export async function destroySession(db: Db, id: string) {
  await db.query(`DELETE FROM sessions WHERE id = $1`, [id]);
}

/** The session's user row, or null if the session is missing/expired. */
export async function userForSession(db: Db, id: string | undefined) {
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.subject, u.email, u.name, u.disabled, s.id AS session_id, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await destroySession(db, id);
    return null;
  }
  if (row.disabled) return null;
  return row;
}

export function parseCookies(header = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookie(id: string, { expiresAt, secure }: { expiresAt: Date; secure: boolean }) {
  const attrs = [
    `${COOKIE_NAME}=${id}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedSessionCookie({ secure }: { secure: boolean }) {
  const attrs = [`${COOKIE_NAME}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export { COOKIE_NAME };
