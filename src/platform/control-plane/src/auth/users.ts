// User records and their per-project memberships. Users are created on first login
// (OIDC callback) or bootstrapped for the dev bypass; identity is the OIDC `subject`.
import { ulid } from "../ulid.ts";
import type { Db } from "../db.ts";

/** Upsert a user by OIDC subject; returns the row. */
export async function ensureUser(
  db: Db,
  { subject, email, name }: { subject: string; email: string; name?: string | null }
) {
  const { rows } = await db.query(
    `INSERT INTO users (id, subject, email, name)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (subject) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, updated_at = now()
     RETURNING id, subject, email, name, disabled`,
    [ulid(), subject, email, name ?? null],
  );
  return rows[0];
}

/** projectId -> role for every project the user belongs to. */
export async function loadMemberships(db: Db, userId: string): Promise<Map<string, string>> {
  const { rows } = await db.query(`SELECT project_id, role FROM memberships WHERE user_id = $1`, [
    userId,
  ]);
  return new Map(rows.map((r) => [r.project_id, r.role])) as Map<string, string>; // SAFETY: The selected membership columns are both TEXT.
}
