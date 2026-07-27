// Secrets. Write-only from the UI: GET lists names and
// timestamps only — the ciphertext is never returned and the plaintext is never
// re-displayed (UX Settings: "secrets are write-only"). Encrypted at rest with the
// platform KMS key (AES-256-GCM). Admin role throughout. Secrets are delivered to
// runners for test-target auth; they are never returned to the UI.
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { created, noContent, readJsonBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, stringField } from "./util.ts";
import { encryptSecret } from "../crypto/secrets.ts";
import { notFound } from "../errors.ts";

/** GET /projects/:p/secrets -> names only. */
export async function listSecrets(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const { rows } = await ctx.db.query(
    `SELECT name, created_at, updated_at FROM secrets WHERE project_id = $1 ORDER BY name`,
    [project.id],
  );
  return { items: rows };
}

/** POST /projects/:p/secrets {name, value} — create or replace. */
export async function putSecret(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const body = await readJsonBody(ctx.req);
  const name: HostedDynamic = stringField(body, "name", {
    required: true,
    max: 128,
    pattern: /^[A-Za-z0-9_.-]+$/,
    patternHint: "may contain letters, digits, and _ . -",
  });
  const value: HostedDynamic = stringField(body, "value", { required: true, max: 1024 * 1024 });
  const ciphertext = encryptSecret(ctx.config.kmsKey, value); // throws config_error if no key

  const { isNew, row } = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const existing = await tx.query(`SELECT 1 FROM secrets WHERE project_id = $1 AND name = $2`, [
      project.id,
      name,
    ]);
    const upserted = await tx.query(
      `INSERT INTO secrets (id, project_id, name, ciphertext, created_by)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, name)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
       RETURNING created_at, updated_at`,
      [ulid(), project.id, name, ciphertext, p.kind === "user" ? p.userId : null],
    );
    // Audit records the NAME and rotation, never the value.
    await audit(tx, {
      actor: actorOf(p),
      action: existing.rows.length ? "secret.rotated" : "secret.created",
      entityType: "secret",
      entityId: `${project.id}:${name}`,
      projectId: project.id,
      detail: { name },
    });
    return { isNew: existing.rows.length === 0, row: upserted.rows[0] };
  });
  // Real timestamps from the row — created_at is the original creation on a rotation.
  const result: HostedDynamic = { name, created_at: row.created_at, updated_at: row.updated_at };
  return isNew ? created(result) : result;
}

/** DELETE /projects/:p/secrets/:name */
export async function deleteSecret(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const name = ctx.params.name;
  const found = await ctx.db.query(`SELECT 1 FROM secrets WHERE project_id = $1 AND name = $2`, [
    project.id,
    name,
  ]);
  if (!found.rows.length) throw notFound(`no secret "${name}"`);
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`DELETE FROM secrets WHERE project_id = $1 AND name = $2`, [project.id, name]);
    await audit(tx, {
      actor: actorOf(p),
      action: "secret.deleted",
      entityType: "secret",
      entityId: `${project.id}:${name}`,
      projectId: project.id,
      detail: { name },
    });
  });
  return noContent();
}
