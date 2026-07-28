import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { HttpResult, created, noContent, readJsonBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, stringField } from "./util.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { forceMintSession, listProviderSessions } from "../dispatch/sessions.ts";

const KINDS = new Set(["token_endpoint", "storage_state_secret", "script"]);

export async function listAuthProviders(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  const { rows } = await ctx.db.query(
    `SELECT * FROM auth_providers WHERE project_id = $1 ORDER BY name`,
    [project.id],
  );
  return { items: rows.map(providerView) };
}

export async function createAuthProvider(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  const body = await readJsonBody(ctx.req);
  const fields = validateProviderFields(body, { nameRequired: true });
  await requireOwnRing(ctx, project.id, fields.ring_id);
  const dup = await ctx.db.query(`SELECT 1 FROM auth_providers WHERE project_id = $1 AND name = $2`, [
    project.id,
    fields.name,
  ]);
  if (dup.rows.length) throw conflict(`an auth provider named "${fields.name}" already exists`);

  const row = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const id = ulid();
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO auth_providers
           (id, project_id, ring_id, name, kind, config, code, identities, ttl_minutes, enabled, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          id,
          project.id,
          fields.ring_id,
          fields.name,
          fields.kind,
          fields.config,
          fields.code,
          fields.identities,
          fields.ttl_minutes,
          fields.enabled,
          userIdOf(p),
        ],
      ));
    } catch (e: HostedDynamic) {
      // A concurrent create/rename hits `UNIQUE (project_id, name)` — surface the
      // friendly conflict, never the raw constraint error.
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw conflict(`an auth provider named "${fields.name}" already exists`);
      }
      throw e;
    }
    await audit(tx, {
      actor: actorOf(p),
      action: "auth_provider.created",
      entityType: "auth_provider",
      entityId: id,
      projectId: project.id,
      detail: { name: fields.name, kind: fields.kind },
    });
    return rows[0];
  });
  return created(providerView(row));
}

export async function updateAuthProvider(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const existing = await getProvider(ctx);
  guard(ctx, existing.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  const fields = validateProviderFields({
    name: "name" in body ? body.name : existing.name,
    ring_id: "ring_id" in body ? body.ring_id : existing.ring_id,
    kind: "kind" in body ? body.kind : existing.kind,
    config: "config" in body ? body.config : existing.config,
    code: "code" in body ? body.code : existing.code,
    identities: "identities" in body ? body.identities : existing.identities,
    ttl_minutes: "ttl_minutes" in body ? body.ttl_minutes : existing.ttl_minutes,
    enabled: "enabled" in body ? body.enabled : existing.enabled,
  }, { nameRequired: true });
  await requireOwnRing(ctx, existing.project_id, fields.ring_id);
  const row = await ctx.db.withTx(async (tx: HostedDynamic) => {
    let rows;
    try {
      ({ rows } = await tx.query(
        `UPDATE auth_providers
            SET ring_id = $2, name = $3, kind = $4, config = $5, code = $6,
                identities = $7, ttl_minutes = $8, enabled = $9, updated_by = $10,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [
          existing.id,
          fields.ring_id,
          fields.name,
          fields.kind,
          fields.config,
          fields.code,
          fields.identities,
          fields.ttl_minutes,
          fields.enabled,
          userIdOf(p),
        ],
      ));
    } catch (e: HostedDynamic) {
      // A concurrent create/rename hits `UNIQUE (project_id, name)` — surface the
      // friendly conflict, never the raw constraint error.
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw conflict(`an auth provider named "${fields.name}" already exists`);
      }
      throw e;
    }
    await audit(tx, {
      actor: actorOf(p),
      action: "auth_provider.updated",
      entityType: "auth_provider",
      entityId: existing.id,
      projectId: existing.project_id,
      detail: { name: fields.name, kind: fields.kind, enabled: fields.enabled },
    });
    return rows[0];
  });
  return providerView(row);
}

export async function deleteAuthProvider(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const existing = await getProvider(ctx);
  guard(ctx, existing.project_id, "developer");
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`DELETE FROM auth_providers WHERE id = $1`, [existing.id]);
    await audit(tx, {
      actor: actorOf(p),
      action: "auth_provider.deleted",
      entityType: "auth_provider",
      entityId: existing.id,
      projectId: existing.project_id,
      detail: { name: existing.name },
    });
  });
  return noContent();
}

export async function mintAuthProvider(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const existing = await getProvider(ctx);
  guard(ctx, existing.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  const result = await forceMintSession(ctx, {
    providerId: existing.id,
    identity: body.identity || null,
    actor: actorOf(p),
  });
  // `script` providers mint on a runner: 202 + the dispatched claim; the
  // session appears in the provider's session list when the workflow fulfills.
  if (result?.pending) return new HttpResult({ status: 202, json: { mint: result } });
  return { session: result };
}

export async function sessions(ctx: HostedDynamic) {
  const existing = await getProvider(ctx);
  guard(ctx, existing.project_id, "viewer");
  return { items: await listProviderSessions(ctx, existing.id) };
}

/**
 * A provider may bind only a ring of ITS OWN project. Without this check the
 * reference is caller-supplied and unvalidated: a developer in project A could
 * hang a provider off project B's ring, and B's launches would then resolve A's
 * credentials. `ring_id` null keeps the provider project-wide, which is the
 * default and needs no check.
 */
async function requireOwnRing(ctx: HostedDynamic, projectId: HostedDynamic, ringId: HostedDynamic) {
  if (!ringId) return;
  const { rows } = await ctx.db.query(
    `SELECT r.id FROM rings r JOIN applications a ON a.id = r.application_id
      WHERE r.id = $1 AND a.project_id = $2`,
    [ringId, projectId],
  );
  if (!rows[0]) throw notFound(`no ring "${ringId}" in this project`);
}

async function getProvider(ctx: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM auth_providers WHERE id = $1`, [ctx.params.a]);
  if (!rows[0]) throw notFound(`no auth provider "${ctx.params.a}"`);
  return rows[0];
}

function validateProviderFields(body: HostedDynamic, { nameRequired }: HostedDynamic) {
  const name = stringField(body, "name", {
    required: nameRequired,
    max: 63,
    pattern: /^[a-z0-9][a-z0-9-]{0,62}$/,
    patternHint: "must be lowercase letters, digits and hyphens",
  });
  const kind = body.kind;
  if (!KINDS.has(kind)) throw badRequest(`"kind" must be one of ${[...KINDS].join(", ")}`);
  const config = objectField(body.config ?? {}, "config");
  const identities = objectField(body.identities ?? {}, "identities");
  const code = body.code == null ? null : stringField(body, "code", { max: 1024 * 1024 });
  const ttl_minutes = Number(body.ttl_minutes ?? 60);
  if (!Number.isInteger(ttl_minutes) || ttl_minutes < 1 || ttl_minutes > 24 * 60) {
    throw badRequest(`"ttl_minutes" must be an integer from 1 to 1440`);
  }
  const enabled = body.enabled !== false;
  const ring_id = body.ring_id == null || body.ring_id === "" ? null : stringField(body, "ring_id", { max: 64 });
  return { name, kind, config, identities, code, ttl_minutes, enabled, ring_id };
}

function objectField(value: HostedDynamic, name: HostedDynamic) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`"${name}" must be an object`);
  return value;
}

function providerView(r: HostedDynamic) {
  return {
    id: r.id,
    project_id: r.project_id,
    ring_id: r.ring_id ?? null,
    name: r.name,
    kind: r.kind,
    config: r.config,
    code: r.code,
    identities: r.identities,
    ttl_minutes: r.ttl_minutes,
    enabled: r.enabled,
    updated_at: r.updated_at,
  };
}

const userIdOf = (p: HostedDynamic) => (p.kind === "user" ? p.userId : null);
