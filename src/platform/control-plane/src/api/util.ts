// Shared helpers for the API handlers: authenticated-principal + role guards,
// entity lookups (project by key, suite by id) that 404 friendly, small field
// validators, and cursor pagination. Keeps every handler terse and consistent.
import { AppError, badRequest, notFound, unauthenticated } from "../errors.ts";
import { requireRole } from "../auth/roles.ts";

export function requireAuth(ctx: HostedDynamic) {
  if (!ctx.principal) throw unauthenticated();
  return ctx.principal;
}

/** Project row by its short key (the URL's :p). */
export async function getProjectByKey(ctx: HostedDynamic, key: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM projects WHERE key = $1`, [key]);
  if (!rows[0]) throw notFound(`no project "${key}"`);
  return rows[0];
}

/** Suite row (with its project_id) by id. */
export async function getSuite(ctx: HostedDynamic, suiteId: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM suites WHERE id = $1`, [suiteId]);
  if (!rows[0]) throw notFound(`no suite "${suiteId}"`);
  return rows[0];
}

/** Guard the principal has at least `minRole` in the project. Returns the role. */
export function guard(ctx: HostedDynamic, projectId: HostedDynamic, minRole: HostedDynamic) {
  requireAuth(ctx);
  return requireRole(ctx.principal, projectId, minRole);
}

// --- field validators (surface as friendly bad_request, never a raw type error) ---

export function stringField(body: HostedDynamic, name: HostedDynamic, { required = false, max = 4096, pattern = null, patternHint = "" }: HostedDynamic = {}) {
  const v = body[name];
  if (v == null || v === "") {
    if (required) throw badRequest(`"${name}" is required`);
    return null;
  }
  if (typeof v !== "string") throw badRequest(`"${name}" must be a string`);
  if (v.length > max) throw badRequest(`"${name}" is too long (max ${max} chars)`);
  if (pattern && !pattern.test(v)) throw badRequest(`"${name}" ${patternHint || `must match ${pattern}`}`);
  return v;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A short slug (project key, suite slug): lowercase, digits, hyphens. */
export const slugField = (body: HostedDynamic, name: HostedDynamic) =>
  stringField(body, name, {
    required: true,
    max: 63,
    pattern: KEY_RE,
    patternHint: "must be lowercase letters, digits and hyphens",
  });

/** { limit, cursor } from ?limit/?cursor with a sane cap. */
export function parsePagination(query: HostedDynamic, { defaultLimit = 50, maxLimit = 200 }: HostedDynamic = {}) {
  let limit = Number(query.get("limit") || defaultLimit);
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  limit = Math.min(limit, maxLimit);
  return { limit, cursor: query.get("cursor") || null };
}

/** True when the principal can see any of the project (viewer+ or a scoped token). */
export function canView(ctx: HostedDynamic, projectId: HostedDynamic) {
  try {
    requireRole(ctx.principal, projectId, "viewer");
    return true;
  } catch {
    return false;
  }
}

export { AppError };
