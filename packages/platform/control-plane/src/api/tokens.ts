// Project-scoped API tokens for CI triggers and the
// runner bootstrap. The plaintext is returned exactly once at creation; only its
// hash is stored (auth/tokens.ts). Admin role. Site-scoped tokens (project_id null)
// are reserved for a later ops flow; Phase 1 mints project-scoped tokens only.
import { audit, actorOf } from "../audit.ts";
import { created, noContent, readJsonBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, stringField } from "./util.ts";
import { newToken } from "../auth/tokens.ts";
import { ROLES } from "../auth/roles.ts";
import { badRequest, notFound } from "../errors.ts";

/** GET /projects/:p/tokens */
export async function listTokens(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const { rows } = await ctx.db.query(
    `SELECT id, role, name, expires_at, created_at FROM api_tokens WHERE project_id = $1 ORDER BY created_at DESC`,
    [project.id],
  );
  return { items: rows };
}

/** POST /projects/:p/tokens {role, name, expires_at?} -> { token } (shown once). */
export async function createToken(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const body = await readJsonBody(ctx.req);
  const role: HostedDynamic = stringField(body, "role", { required: true });
  if (!ROLES.includes(role)) throw badRequest(`role must be one of ${ROLES.join("/")}`);
  const name: HostedDynamic = stringField(body, "name", { required: true, max: 200 });
  const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw badRequest(`"expires_at" is not a valid date`);

  const { id, plaintext, row } = newToken({ projectId: project.id, role, name });
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `INSERT INTO api_tokens (id, project_id, role, name, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, project.id, role, name, row.token_hash, expiresAt],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "token.created",
      entityType: "api_token",
      entityId: id,
      projectId: project.id,
      detail: { name, role },
    });
  });
  // The one time the plaintext is ever revealed.
  return created({ id, name, role, token: plaintext, expires_at: expiresAt });
}

/** DELETE /tokens/:id */
export async function deleteToken(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const { rows } = await ctx.db.query(`SELECT * FROM api_tokens WHERE id = $1`, [ctx.params.id]);
  const token = rows[0];
  if (!token) throw notFound(`no token "${ctx.params.id}"`);
  guard(ctx, token.project_id, "admin");
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`DELETE FROM api_tokens WHERE id = $1`, [token.id]);
    await audit(tx, {
      actor: actorOf(p),
      action: "token.revoked",
      entityType: "api_token",
      entityId: token.id,
      projectId: token.project_id,
      detail: { name: token.name },
    });
  });
  return noContent();
}
