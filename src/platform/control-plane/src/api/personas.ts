// Project-scoped personas. A persona is prose ({name, description}) a project
// keeps so its stories can reference it by slug — `persona: <slug>` — without
// every suite carrying its own `personas/<slug>.yaml`. Editor role throughout:
// authoring a persona is authoring, not infra (unlike environments/auth
// providers, which stay developer-gated).
import YAML from "yaml";
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { created, noContent, readJsonBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, stringField } from "./util.ts";
import { badRequest, notFound, conflict } from "../errors.ts";
import { putBlobs } from "../suites/snapshots.ts";
import { builtinPersonas } from "../../../../core/public/suite.ts";

const BUILTIN_NAMES = new Set(builtinPersonas().map((p) => p.name));

/** The exact suite-tree path a persona's rendered YAML would occupy. A suite
 * that commits its own `personas/<slug>.yaml` shadows the project persona of
 * the same slug — see executor-api.js snapshotTree. */
export const personaPath = (slug: HostedDynamic) => `personas/${slug}.yaml`;

/** Render a persona row's {name, description} as the exact bytes core's
 * `loadPersona` parses. `lineWidth: 0` disables line-folding so a long
 * description round-trips as one scalar rather than being wrapped mid-prose. */
export function personaYaml({ name, description }: HostedDynamic) {
  return YAML.stringify({ name, description }, { lineWidth: 0 });
}

/** GET /projects/:p/personas — built-ins first, then project personas by slug. */
export async function listPersonas(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT * FROM personas WHERE project_id = $1 ORDER BY slug`,
    [project.id],
  );
  return {
    items: [
      ...builtinPersonas().map((p) => ({
        id: null,
        slug: p.name,
        name: p.name,
        description: p.description,
        builtin: true,
        updated_at: null,
      })),
      ...rows.map(personaView),
    ],
  };
}

/** POST /projects/:p/personas */
export async function createPersona(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "editor");
  const body = await readJsonBody(ctx.req);
  const { name, description } = validatePersonaFields(body, { nameRequired: true, descriptionRequired: true });
  const slug = validateSlug(body, name);

  const dup = await ctx.db.query(`SELECT 1 FROM personas WHERE project_id = $1 AND slug = $2`, [
    project.id,
    slug,
  ]);
  if (dup.rows.length) throw conflict(`a persona named "${slug}" already exists`);

  const persona = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const bytes = personaYaml({ name, description });
    // Content-addressed + idempotent; an orphan blob on a later rollback is
    // harmless, but a row pointing at a missing blob is not — write the blob
    // (in-tx, matching applyCommit's ordering in api/suites.ts) before the row.
    const tree = await putBlobs(ctx.store, { [personaPath(slug)]: bytes });
    const id = ulid();
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO personas (id, project_id, slug, name, description, blob_sha256, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, project.id, slug, name, description, tree[personaPath(slug)], userIdOf(p)],
      ));
    } catch (e: HostedDynamic) {
      // Pre-check race: a concurrent create can slip past it and hit the
      // unique index — surface the same friendly conflict, never the raw
      // constraint error.
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw conflict(`a persona named "${slug}" already exists`);
      }
      throw e;
    }
    await audit(tx, {
      actor: actorOf(p),
      action: "persona.created",
      entityType: "persona",
      entityId: id,
      projectId: project.id,
      detail: { slug },
    });
    return rows[0];
  });
  return created(personaView(persona));
}

/** PUT /personas/:id — merge-on-update; slug is immutable. */
export async function updatePersona(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const persona = await getPersonaRow(ctx);
  guard(ctx, persona.project_id, "editor");
  const body = await readJsonBody(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a JSON object");
  if ("slug" in body && body.slug !== persona.slug) {
    throw badRequest(
      `personas can't be renamed (this one is "${persona.slug}") — stories reference personas by slug, so create a new one instead`,
    );
  }
  // Merge-on-update: an omitted field keeps its stored value, so a partial
  // PUT {description: "…"} can never silently wipe the display name.
  const { name, description } = validatePersonaFields(
    {
      name: "name" in body ? body.name : persona.name,
      description: "description" in body ? body.description : persona.description,
    },
    { nameRequired: true, descriptionRequired: true },
  );

  const updated = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const bytes = personaYaml({ name, description });
    const tree = await putBlobs(ctx.store, { [personaPath(persona.slug)]: bytes });
    const { rows } = await tx.query(
      `UPDATE personas SET name = $2, description = $3, blob_sha256 = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
      [persona.id, name, description, tree[personaPath(persona.slug)]],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "persona.updated",
      entityType: "persona",
      entityId: persona.id,
      projectId: persona.project_id,
      detail: { slug: persona.slug },
    });
    return rows[0];
  });
  return personaView(updated);
}

/** DELETE /personas/:id */
export async function deletePersona(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const persona = await getPersonaRow(ctx);
  guard(ctx, persona.project_id, "editor");
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`DELETE FROM personas WHERE id = $1`, [persona.id]);
    await audit(tx, {
      actor: actorOf(p),
      action: "persona.deleted",
      entityType: "persona",
      entityId: persona.id,
      projectId: persona.project_id,
      detail: { slug: persona.slug },
    });
  });
  return noContent();
}

async function getPersonaRow(ctx: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM personas WHERE id = $1`, [ctx.params.id]);
  if (!rows[0]) throw notFound(`no persona "${ctx.params.id}"`);
  return rows[0];
}

function validatePersonaFields(body: HostedDynamic, { nameRequired, descriptionRequired }: HostedDynamic) {
  const name = stringField(body, "name", { required: nameRequired, max: 63 });
  const description = typeof body.description === "string" ? body.description.trim() : body.description;
  if (descriptionRequired && !description) throw badRequest(`"description" is required`);
  if (description != null) {
    if (typeof description !== "string") throw badRequest(`"description" must be a string`);
    if (description.length > 8000) throw badRequest(`"description" is too long (max 8000 chars)`);
  }
  return { name, description };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const SLUG_HINT = "must be lowercase letters, digits and hyphens, starting with a letter or digit";

/** Exported for unit tests (slug derivation, built-in collision) — pure, no ctx/db needed. */
export function validateSlug(body: HostedDynamic, name: HostedDynamic) {
  const explicit = stringField(body, "slug", { max: 50, pattern: SLUG_RE, patternHint: SLUG_HINT });
  const slug = explicit || deriveSlug(name);
  if (!slug) {
    throw badRequest(`could not derive a slug from "${name}" — supply "slug" explicitly`);
  }
  // A derived slug is built only from [a-z0-9-], so it already satisfies
  // SLUG_RE; this only re-fires for an explicit slug shorter than the earlier
  // stringField check missed (it can't, but stay defensive rather than clever).
  if (!SLUG_RE.test(slug)) throw badRequest(`"slug" ${SLUG_HINT}`);
  if (BUILTIN_NAMES.has(slug)) {
    throw conflict(`"${slug}" is a built-in persona — choose another name`);
  }
  return slug;
}

/** lowercase, diacritics stripped, non-alphanumeric runs -> "-", trimmed, capped.
 * Exported for unit tests. */
export function deriveSlug(name: HostedDynamic) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

const userIdOf = (p: HostedDynamic) => (p.kind === "user" ? p.userId : null);

const personaView = (r: HostedDynamic) => ({
  id: r.id,
  project_id: r.project_id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  builtin: false,
  updated_at: r.updated_at,
});
