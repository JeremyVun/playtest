// Projects and membership. The tenancy unit is the project; authZ is
// per-project roles. Project creation is self-serve for any authenticated user (an
// internal tool); the creator becomes the project
// admin. Member management is admin-only. Every mutation audits.
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { ROLES } from "../auth/roles.ts";
import { loadMemberships } from "../auth/users.ts";
import { created, noContent } from "../http.ts";
import { readJsonBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, slugField, stringField, canView, AppError } from "./util.ts";
import { badRequest, conflict, notFound, forbidden } from "../errors.ts";
import { storageUsage } from "./retention.ts";
import { assistantConfigured } from "../authoring/assistant.ts";
import { autoDedupeEnabledFor, scheduleAutoDedupe } from "../findings/auto-dedupe.ts";
import { autoResolveEnabledFor, scheduleAutoResolve } from "../findings/auto-resolve.ts";
import { modelTiers, defaultModels } from "@playtest/core/llm";
import { checkInWindowMs } from "../dispatch/pool.ts";

/** True when the principal is admin of at least one project (or a dev/admin token). */
function isAdminSomewhere(p: HostedDynamic) {
  if (p.kind === "token") return p.role === "admin";
  if (p.isDevAdmin) return true;
  return p.roles ? [...p.roles.values()].includes("admin") : false;
}

/**
 * GET /api/v1/me — the current principal, its project roles, and this
 * deployment's optional capabilities (web app bootstrap).
 *
 * `capabilities` describes the SERVER, not the person: it is what this
 * deployment was configured to do, so the console can present a capability it
 * does not have as unavailable-and-why instead of a live button that fails.
 * The first was `llm`, the platform LLM gateway behind story drafting, study
 * synthesis and candidate consolidation. It is never an authorization
 * signal — every one of those routes still enforces its own role.
 */
export async function me(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const pool = ctx.config.dispatch.pool;
  // `auto_dedupe` tells the console whether unreviewed findings are being
  // semantically deduped automatically after runs, so it can present manual
  // "Find duplicates" as the fallback it is rather than the routine path.
  const capabilities: HostedDynamic = {
    llm: assistantConfigured(),
    auto_dedupe: assistantConfigured() && ctx.config.autoDedupe.enabled,
    auto_resolve: ctx.config.autoResolve.enabled,
    // What a VERIFIED fix of a judgment-call finding may do by default:
    // "semi" suggests for a person to confirm, "full" resolves outright.
    // Verification itself needs the gateway (`llm`); without one the keyless
    // tier degrades to graded-pass suggestions whatever the mode says.
    auto_resolve_mode: ctx.config.autoResolve.mode,
    // How long since a runner's last check-in still counts as online, derived
    // server-side (dispatch/pool.ts) so the console's presence dot and the
    // reconciler's patience are the same number.
    runner_check_in_window_s: Math.round(checkInWindowMs(pool) / 1000),
  };
  if (p.kind === "token") {
    return { kind: "token", project_id: p.projectId, role: p.role, capabilities };
  }
  const roles = p.isDevAdmin
    ? await allProjectsAsAdmin(ctx)
    : Object.fromEntries(p.roles);
  return {
    kind: "user",
    user_id: p.userId,
    subject: p.subject,
    email: p.email,
    name: p.name,
    is_dev_admin: !!p.isDevAdmin,
    roles,
    capabilities,
  };
}

async function allProjectsAsAdmin(ctx: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT id FROM projects WHERE NOT archived`);
  return Object.fromEntries(rows.map((r: HostedDynamic) => [r.id, "admin"]));
}

/** GET /projects — projects the principal can see. */
export async function listProjects(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  let rows;
  if (p.kind === "user" && p.isDevAdmin) {
    ({ rows } = await ctx.db.query(`SELECT * FROM projects ORDER BY key`));
  } else if (p.kind === "user") {
    ({ rows } = await ctx.db.query(
      `SELECT pr.* FROM projects pr JOIN memberships m ON m.project_id = pr.id
        WHERE m.user_id = $1 ORDER BY pr.key`,
      [p.userId],
    ));
  } else {
    // token: its scoped project, or all when site-scoped.
    ({ rows } = p.projectId
      ? await ctx.db.query(`SELECT * FROM projects WHERE id = $1`, [p.projectId])
      : await ctx.db.query(`SELECT * FROM projects ORDER BY key`));
  }
  return { items: rows.map(projectView), next_cursor: null };
}

/** POST /projects {key, name} — creator becomes admin. */
export async function createProject(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  if (p.kind !== "user") throw new AppError("forbidden", "only a signed-in user can create a project");
  const body = await readJsonBody(ctx.req);
  const key = slugField(body, "key");
  const name = stringField(body, "name", { required: true, max: 200 });

  const dup = await ctx.db.query(`SELECT 1 FROM projects WHERE key = $1`, [key]);
  if (dup.rows.length) throw conflict(`a project with key "${key}" already exists`);

  const project = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const id = ulid();
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO projects (id, key, name) VALUES ($1, $2, $3) RETURNING *`,
        [id, key, name],
      ));
    } catch (e: HostedDynamic) {
      // The pre-check above is best-effort; a concurrent create can still race past
      // it and hit the unique index — surface the same friendly conflict, never the
      // raw SQLite constraint error.
      if (/UNIQUE constraint failed/.test(e.message || "")) {
        throw conflict(`a project with key "${key}" already exists`);
      }
      throw e;
    }
    await tx.query(
      `INSERT INTO memberships (user_id, project_id, role) VALUES ($1, $2, 'admin')`,
      [p.userId, id],
    );
    // A new project has no application: what a suite runs against is a decision
    // ("this web app, at this URL"), and the platform cannot guess it. The first
    // application is the first step of the first-run path, not a hidden default
    // that quietly resolves to whatever a suite happened to author.
    await audit(tx, {
      actor: actorOf(p),
      action: "project.created",
      entityType: "project",
      entityId: id,
      projectId: id,
      detail: { key, name },
    });
    return rows[0];
  });
  return created(projectView(project));
}

/** GET /projects/:p */
export async function getProject(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  return projectView(project);
}

/**
 * DELETE /projects/:p — permanent, admin-only.
 *
 * Every entity that refuses to be deleted out from under a referrer does so with
 * ON DELETE RESTRICT — run groups pin suites, snapshots, applications and rings;
 * suites pin applications; ring-bound auth providers pin rings. That is exactly
 * right for the per-entity delete endpoints and exactly wrong for "remove this
 * whole project", so the order is spelled out here rather than left to a cascade
 * nobody can read: run groups (cascading runs → events/artifacts/candidates/
 * evidence), auth providers, suites, rings, applications, then the project
 * (cascading secrets, tokens, findings, memberships, personas, …).
 *
 * Content-addressed blobs are shared and reaped by retention; they are not wiped
 * here. The project key is free to reuse after this returns.
 */
export async function deleteProject(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");

  await ctx.db.withTx(async (tx: HostedDynamic) => {
    // Audit before the row vanishes so the actor/key are still recoverable
    // from the site-level log (audit_log has no FK on project_id).
    await audit(tx, {
      actor: actorOf(p),
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
      projectId: project.id,
      detail: { key: project.key, name: project.name },
    });
    await tx.query(`DELETE FROM run_groups WHERE project_id = $1`, [project.id]);
    await tx.query(`DELETE FROM auth_providers WHERE project_id = $1`, [project.id]);
    await tx.query(`DELETE FROM suites WHERE project_id = $1`, [project.id]);
    await tx.query(
      `DELETE FROM rings WHERE application_id IN (SELECT id FROM applications WHERE project_id = $1)`,
      [project.id],
    );
    await tx.query(`DELETE FROM applications WHERE project_id = $1`, [project.id]);
    await tx.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  });
  return noContent();
}

/** GET /projects/:p/members */
export async function listMembers(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT m.user_id, m.role, u.email, u.name, u.subject
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1 ORDER BY u.email`,
    [project.id],
  );
  return { items: rows };
}

/** PUT /projects/:p/members/:userId {role} */
export async function putMember(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const body = await readJsonBody(ctx.req);
  const role: HostedDynamic = stringField(body, "role", { required: true });
  if (!ROLES.includes(role)) throw badRequest(`role must be one of ${ROLES.join("/")}`);
  const userId = ctx.params.userId;
  const u = await ctx.db.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  if (!u.rows.length) throw notFound(`no user "${userId}"`);

  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `INSERT INTO memberships (user_id, project_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, project_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
      [userId, project.id, role],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "member.set",
      entityType: "membership",
      entityId: `${project.id}:${userId}`,
      projectId: project.id,
      detail: { project_id: project.id, user_id: userId, role },
    });
  });
  return { user_id: userId, project_id: project.id, role };
}

/** DELETE /projects/:p/members/:userId */
export async function deleteMember(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const userId = ctx.params.userId;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`DELETE FROM memberships WHERE user_id = $1 AND project_id = $2`, [
      userId,
      project.id,
    ]);
    await audit(tx, {
      actor: actorOf(p),
      action: "member.removed",
      entityType: "membership",
      entityId: `${project.id}:${userId}`,
      projectId: project.id,
      detail: { project_id: project.id, user_id: userId },
    });
  });
  return noContent();
}

/**
 * GET /users?email= — minimal user lookup so an admin can find a subject to add as
 * a member (additive to §2; the contract lists member PUT by userId but omits how a
 * user id is discovered — this is the smallest answer). Restricted to principals who
 * are admin of at least one project (the only ones who manage membership), so a bare
 * viewer / low-role token can't enumerate the directory by email.
 */
export async function lookupUsers(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  if (!isAdminSomewhere(p)) throw forbidden("only a project admin can look up users");
  const email = ctx.query.get("email");
  if (!email) throw badRequest(`?email= is required`);
  const { rows } = await ctx.db.query(
    `SELECT id, email, name, subject FROM users WHERE email = $1`,
    [email],
  );
  return { items: rows };
}

/**
 * GET /models — the model vocabulary this deployment ships: the short tier
 * enums (core models.json) and the engine's built-in actor/grader defaults.
 * Sited under no project because it is a property of the build, not of any
 * tenant. Any authenticated principal may read it — settings forms use it for
 * suggestions and "using the default …" captions, and it holds no secrets.
 */
export async function modelCatalog(ctx: HostedDynamic) {
  requireAuth(ctx);
  return {
    tiers: modelTiers(),
    // consolidation_model's and auto_resolve_model's engine defaults are
    // server configuration, not core engine constants — the settings form
    // still captions "leave blank" with them.
    defaults: {
      ...defaultModels,
      consolidation_model: ctx.config.llm.consolidationModel,
      auto_resolve_model: ctx.config.llm.autoResolveModel,
    },
  };
}

// The model roles a project may set defaults for. Actor and grader are per-run
// engine roles; consolidation_model joined when finding dedupe became an
// automatic per-project behavior (auto-dedupe) rather than a pure operator
// knob, and auto_resolve_model followed for the auto-resolve sweep's fix
// verification. Authoring/synthesis stay deployment (env) knobs, and every
// other per-run setting already lives in the suite's own playtest.yaml.
const MODEL_KEYS = ["actor_model", "grader_model", "consolidation_model", "auto_resolve_model"];

/**
 * PUT /projects/:p/models { actor_model?, grader_model?, consolidation_model? }
 * — admin-only, since
 * a model default is a project-wide cost/quality policy. Merge-on-update: an
 * omitted key keeps its stored value; null or "" clears one, deferring that
 * role back to the engine default. Values are a short tier enum or a
 * fully-qualified gateway name — the same vocabulary playtest.yaml accepts —
 * and suites always win over these (docs/contracts/hosted.md, "Model
 * selection"), so setting one can never override a suite that chose.
 */
export async function putModels(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const body = await readJsonBody(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a JSON object");
  const unknown = Object.keys(body).filter((k) => !MODEL_KEYS.includes(k));
  if (unknown.length) {
    throw badRequest(`unknown model key ${unknown.map((k) => `"${k}"`).join(", ")} — this endpoint sets ${MODEL_KEYS.join(", ")}`);
  }
  const models: HostedDynamic = {};
  for (const key of MODEL_KEYS) {
    const stored = project.models?.[key];
    if (!(key in body)) {
      if (stored) models[key] = stored;
      continue;
    }
    const raw = body[key];
    if (raw === null || raw === "") continue; // cleared — the engine default takes over
    if (typeof raw !== "string" || !raw.trim() || /\s/.test(raw.trim()) || raw.trim().length > 200) {
      throw badRequest(
        `"${key}" must be a model tier (${modelTiers().join(", ")}) or a fully-qualified gateway model name — got ${JSON.stringify(raw)}`,
      );
    }
    models[key] = raw.trim();
  }

  const updated = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE projects SET models = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [project.id, models],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "project.models_set",
      entityType: "project",
      entityId: project.id,
      projectId: project.id,
      detail: { models },
    });
    return rows[0];
  });
  return projectView(updated);
}

/**
 * PUT /projects/:p/parallel { total, record } — admin-only hosted concurrency
 * default. Both values are concrete positive integers: hosted capacity must be
 * predictable, while a suite that needs core's automatic pool can still opt
 * into `parallel: true` in its own playtest.yaml.
 */
export async function putParallel(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const body = await readJsonBody(ctx.req);
  const parallel = validateParallel(body);

  const updated = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE projects SET parallel = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [project.id, parallel],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "project.parallel_set",
      entityType: "project",
      entityId: project.id,
      projectId: project.id,
      detail: { parallel },
    });
    return rows[0];
  });
  return projectView(updated);
}

function validateParallel(body: HostedDynamic) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest(`body must be { "total": <positive integer>, "record": <positive integer> }`);
  }
  const unknown = Object.keys(body).filter((key) => !["total", "record"].includes(key));
  if (unknown.length) throw badRequest(`unknown parallel key ${unknown.map((k) => `"${k}"`).join(", ")}`);
  for (const key of ["total", "record"]) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 1) {
      throw badRequest(`"${key}" must be a positive integer`);
    }
  }
  if (body.record > body.total) {
    throw badRequest(`"record" (${body.record}) cannot exceed "total" (${body.total})`);
  }
  return { total: body.total, record: body.record };
}

const DAY_MS = 86_400_000;

const projectView = (r: HostedDynamic) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  archived: r.archived,
  models: r.models || {},
  parallel: r.parallel || { total: 1, record: 1 },
  // Tri-state: true/false pin the automatic dedupe sweep for this project,
  // null inherits the deployment default (`/me` capabilities.auto_dedupe).
  auto_dedupe: r.auto_dedupe ?? null,
  // Same tri-state for the auto-resolve sweep (`/me` capabilities.auto_resolve)
  // and its mode — what a verified fix may do (`semi`/`full`, null inherits
  // capabilities.auto_resolve_mode).
  auto_resolve: r.auto_resolve ?? null,
  auto_resolve_mode: r.auto_resolve_mode ?? null,
  created_at: r.created_at,
});

/**
 * PUT /projects/:p/auto-dedupe {enabled: true|false|null} — admin-only, like
 * the model policy it sits beside in Settings. `null` returns the project to
 * the deployment default. No gateway still means no sweep anywhere; this only
 * decides whether a configured deployment sweeps THIS project.
 */
export async function putAutoDedupe(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const body = await readJsonBody(ctx.req);
  const enabled = body?.enabled ?? null;
  if (enabled !== null && typeof enabled !== "boolean") {
    throw badRequest(`"enabled" must be true, false, or null (inherit the deployment default)`);
  }
  const updated = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE projects SET auto_dedupe = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [project.id, enabled],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "project.auto_dedupe_set",
      entityType: "project",
      entityId: project.id,
      projectId: project.id,
      detail: { enabled },
    });
    return rows[0];
  });
  // Switching the sweep on runs a catch-up pass over whatever accumulated
  // while it was off — the button-less design depends on there never being a
  // stranded backlog only a manual run could clear.
  if (autoDedupeEnabledFor(ctx, updated)) scheduleAutoDedupe(ctx, updated.id);
  return projectView(updated);
}

/**
 * PUT /projects/:p/auto-resolve {enabled?: true|false|null, mode?:
 * "semi"|"full"|null} — admin-only, the sibling of the auto-dedupe pin.
 * `null` returns either knob to its deployment default
 * (PLAYTEST_AUTO_RESOLVE / PLAYTEST_AUTO_RESOLVE_MODE); an omitted key keeps
 * the stored pin. `mode` decides what a VERIFIED fix of a judgment-call
 * finding may do — "semi" suggests for a person to confirm, "full" resolves
 * outright. Switching the sweep on (or widening the mode) runs a catch-up
 * sweep, so findings disproved while it was narrower resolve without waiting
 * for the next report.
 */
export async function putAutoResolve(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const body = await readJsonBody(ctx.req);
  const enabled = "enabled" in (body || {}) ? body.enabled : (project.auto_resolve ?? null);
  if (enabled !== null && typeof enabled !== "boolean") {
    throw badRequest(`"enabled" must be true, false, or null (inherit the deployment default)`);
  }
  const mode = "mode" in (body || {}) ? body.mode : (project.auto_resolve_mode ?? null);
  if (mode !== null && !["semi", "full"].includes(mode)) {
    throw badRequest(`"mode" must be "semi", "full", or null (inherit the deployment default)`);
  }
  const updated = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE projects SET auto_resolve = $2, auto_resolve_mode = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [project.id, enabled, mode],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "project.auto_resolve_set",
      entityType: "project",
      entityId: project.id,
      projectId: project.id,
      detail: { enabled, mode },
    });
    return rows[0];
  });
  if (autoResolveEnabledFor(ctx, updated)) scheduleAutoResolve(ctx, updated.id);
  return projectView(updated);
}

/**
 * GET /projects/:p/health [viewer] — the project-home tiles + "needs attention"
 * list, using pure SQL projections. Infra and
 * explored runs stay out of the pass rate — they are not product verdicts
 * (UX principle 2: the gate is the verdict; score is only ever a trend).
 */
export async function health(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const db = ctx.db;

  // Window boundaries are computed here, not in SQL: SQLite has no interval
  // type and no date_trunc, and timestamps are epoch milliseconds. All three
  // are UTC, which is what date_trunc on a timestamptz already gave on a UTC
  // server (S0-INVENTORY.md §6.7).
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [rate, daily, pending, today, spend, groups, storage, majors] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FILTER (WHERE r.status = 'pass') AS pass,
              COUNT(*) FILTER (WHERE r.status = 'fail') AS fail
         FROM runs r JOIN run_groups g ON g.id = r.run_group_id
        WHERE g.project_id = $1 AND r.finished_at > $2`,
      [project.id, sevenDaysAgo],
    ),
    db.query(
      // Integer division by one day gives the UTC day bucket date_trunc used to
      // produce; the bucket index is turned back into a date in JS below.
      `SELECT CAST(r.finished_at / 86400000 AS INTEGER) AS day,
              COUNT(*) FILTER (WHERE r.status = 'pass') AS pass,
              COUNT(*) FILTER (WHERE r.status = 'fail') AS fail
         FROM runs r JOIN run_groups g ON g.id = r.run_group_id
        WHERE g.project_id = $1 AND r.finished_at > $2
        GROUP BY 1 ORDER BY 1`,
      [project.id, sevenDaysAgo],
    ),
    db.query(`SELECT COUNT(*) AS n FROM candidates WHERE project_id = $1 AND status = 'pending'`, [project.id]),
    db.query(
      `SELECT COUNT(*) AS n FROM runs r JOIN run_groups g ON g.id = r.run_group_id
        WHERE g.project_id = $1 AND r.created_at > $2`,
      [project.id, startOfDay],
    ),
    db.query(
      `SELECT COALESCE(SUM(CAST(json_extract(r.totals, '$.cost_usd') AS REAL)), 0) AS usd
         FROM runs r JOIN run_groups g ON g.id = r.run_group_id
        WHERE g.project_id = $1 AND r.finished_at > $2`,
      [project.id, startOfMonth],
    ),
    db.query(
      // Latest group per suite. SQLite has no DISTINCT ON, so the pick is a
      // row_number window filtered to the first row of each suite's partition.
      `WITH latest AS (
         SELECT g.suite_id, s.slug, g.id AS group_id, g.created_at, g.status,
                row_number() OVER (PARTITION BY g.suite_id ORDER BY g.created_at DESC) AS rn
           FROM run_groups g JOIN suites s ON s.id = g.suite_id
          WHERE g.project_id = $1
       )
       SELECT suite_id, slug, group_id, created_at, status,
              (SELECT COUNT(*) FROM runs r WHERE r.run_group_id = group_id AND r.status = 'pass') AS pass,
              (SELECT COUNT(*) FROM runs r WHERE r.run_group_id = group_id AND r.status = 'fail') AS fail,
              (SELECT COUNT(*) FROM runs r WHERE r.run_group_id = group_id AND r.changed) AS changed
         FROM latest
        WHERE rn = 1
        ORDER BY suite_id`,
      [project.id],
    ),
    storageUsage(ctx, project.id),
    db.query(
      // The dashboard's attention majors: CONFIRMED open work only (accepted/
      // reopened — a `new` finding is unvetted machine output), newest evidence
      // first, same order the findings list uses. Riding health saves the
      // dashboard a second findings round trip for five rows.
      `SELECT id, title, state, evidence_count FROM findings
        WHERE project_id = $1 AND merged_into IS NULL
          AND state IN ('reopened','accepted') AND severity = 'major'
        ORDER BY last_seen DESC, id DESC LIMIT 5`,
      [project.id],
    ),
  ]);

  // Finding counts per suite for the Overview suite table. A finding is reached
  // through its evidence runs' owning suite (findings are project-scoped and
  // carry no suite column).
  //
  // Open counts CONFIRMED work only — `accepted` and `reopened`. A `new` finding
  // is machine output no person has vetted, so it must not ring an alarm: it is
  // reported separately as a quiet needs-review count
  // (docs/contracts/hosted.md, "Findings").
  // `fix_suggested_n` is the auto-resolve sweep's pending "looks fixed"
  // suggestions among those open findings — the EXACT queue the findings
  // review tab shows, so the suites table and its destination always agree.
  // (An earlier story-health heuristic here overcounted: a single story's
  // latest pass is weaker evidence than the sweep's every-triple check.)
  const findingCounts = await db.query(
    `SELECT rg.suite_id,
            COUNT(DISTINCT CASE WHEN f.state IN ('accepted','reopened') THEN f.id END) AS open_n,
            COUNT(DISTINCT CASE WHEN f.state = 'new' THEN f.id END) AS review_n,
            COUNT(DISTINCT CASE WHEN f.state IN ('accepted','reopened')
                                  AND json_extract(f.summary, '$.auto_resolve.suggested') IS NOT NULL
                             THEN f.id END) AS fix_suggested_n
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
       JOIN runs r ON r.id = fe.run_id
       JOIN run_groups rg ON rg.id = r.run_group_id
      WHERE f.project_id = $1 AND f.merged_into IS NULL
      GROUP BY rg.suite_id`,
    [project.id],
  );
  const bySuite: HostedDynamic = new Map(findingCounts.rows.map((r: HostedDynamic) => [r.suite_id, r]));
  for (const s of groups.rows) {
    s.open_findings = bySuite.get(s.suite_id)?.open_n || 0;
    s.needs_review_findings = bySuite.get(s.suite_id)?.review_n || 0;
    s.fix_suggested_findings = bySuite.get(s.suite_id)?.fix_suggested_n || 0;
  }
  // The project-level needs-review count is the console's one quiet line; it is
  // not derived from the per-suite counts, which double-count a finding whose
  // evidence spans two suites.
  // `fix_suggested_n` rides along: pending looks-fixed suggestions are review
  // work too (the review tab's second queue), just good news rather than alarm.
  const needsReview = await db.query(
    `SELECT COUNT(CASE WHEN state = 'new' THEN 1 END) AS n,
            COUNT(CASE WHEN state IN ('reopened','accepted')
                         AND json_extract(summary, '$.auto_resolve.suggested') IS NOT NULL
                    THEN 1 END) AS fix_suggested_n
       FROM findings
      WHERE project_id = $1 AND merged_into IS NULL`,
    [project.id],
  );

  // Needs attention: recent fails with streak context, pending changed
  // journeys, and workflows the reconciler declared dead — each row carries the
  // ids to deep-link (UX principle 4: every claim links to evidence).
  const fails = await db.query(
    // Rank every finished verdict before filtering to failures. Filtering first
    // would keep an older red run alive after the same story had passed.
    `WITH ranked AS (
       SELECT r.id, r.run_group_id, r.run_id, r.case_id, r.story_id, r.status,
              r.finished_at, g.suite_id,
              row_number() OVER (
                PARTITION BY g.suite_id, r.story_id
                ORDER BY COALESCE(r.finished_at, r.created_at) DESC, r.id DESC
              ) AS rn
         FROM runs r JOIN run_groups g ON g.id = r.run_group_id
        WHERE g.project_id = $1
          AND r.status IN ('pass','fail')
          AND r.finished_at > $2
     )
     SELECT id, run_group_id, run_id, case_id, story_id, finished_at, suite_id
       FROM ranked
      WHERE rn = 1 AND status = 'fail'
      ORDER BY suite_id, story_id LIMIT 5`,
    [project.id, sevenDaysAgo],
  );
  const attention: HostedDynamic[] = [];
  for (const f of fails.rows) {
    const prior = await db.query(
      `SELECT r.status FROM runs r JOIN run_groups g ON g.id = r.run_group_id
        WHERE g.project_id = $1 AND r.story_id = $2 AND r.finished_at < $3
          AND g.suite_id = $4
          AND r.status IN ('pass','fail')
        ORDER BY r.finished_at DESC LIMIT 25`,
      [project.id, f.story_id, f.finished_at, f.suite_id],
    );
    let streak = 0;
    for (const p of prior.rows) {
      if (p.status === "pass") streak++;
      else break;
    }
    attention.push({
      kind: "fail",
      case_id: f.case_id,
      run_db_id: f.id,
      run_group_id: f.run_group_id,
      note: streak > 0 ? `first fail after ${streak} pass${streak === 1 ? "" : "es"}` : "failing",
    });
  }
  const changedRows = await db.query(
    `SELECT c.id, r.case_id, r.id AS run_db_id, r.run_group_id FROM candidates c
       JOIN runs r ON r.id = c.run_id
      WHERE c.project_id = $1 AND c.status = 'pending'
      ORDER BY c.created_at DESC LIMIT 5`,
    [project.id],
  );
  for (const c of changedRows.rows) {
    attention.push({
      kind: "changed",
      case_id: c.case_id,
      run_db_id: c.run_db_id,
      run_group_id: c.run_group_id,
      candidate_id: c.id,
      note: "changed — passed after healing",
    });
  }
  const dead = await db.query(
    `WITH latest_dead AS (
       SELECT d.id, d.ref_id, d.workflow_run_url, d.requested_at,
              row_number() OVER (
                PARTITION BY d.ref_id
                ORDER BY d.requested_at DESC, d.id DESC
              ) AS rn
         FROM dispatches d
         JOIN run_groups g ON g.id = d.ref_id
        WHERE d.project_id = $1 AND d.kind = 'group'
          AND d.status = 'reconciled_dead' AND d.requested_at > $2
          AND g.status = 'done'
          AND EXISTS (
            SELECT 1 FROM runs r
             WHERE r.run_group_id = g.id AND r.status IN ('infra','lost')
          )
     )
     SELECT id, ref_id, workflow_run_url
       FROM latest_dead
      WHERE rn = 1
      ORDER BY requested_at DESC LIMIT 3`,
    [project.id, sevenDaysAgo],
  );
  for (const d of dead.rows) {
    attention.push({
      kind: "infra",
      run_group_id: d.ref_id,
      note: "runner stopped before the run finished",
      workflow_run_url: d.workflow_run_url,
    });
  }

  const graded = rate.rows[0].pass + rate.rows[0].fail;
  return {
    pass_rate_7d: graded ? Math.round((rate.rows[0].pass / graded) * 100) : null,
    pass_count_7d: rate.rows[0].pass,
    graded_count_7d: graded,
    pass_rate_daily: daily.rows.map((d: HostedDynamic) => ({
      // `day` is a UTC day-bucket index. Postgres `date_trunc('day', …)` came
      // back through the driver as a Date, so keep returning one: the wire
      // format stays the ISO-8601 midnight this field has always carried.
      day: new Date(d.day * DAY_MS),
      rate: d.pass + d.fail ? Math.round((d.pass / (d.pass + d.fail)) * 100) : null,
    })),
    review_pending: pending.rows[0].n,
    findings_needs_review: needsReview.rows[0].n,
    findings_fix_suggested: needsReview.rows[0].fix_suggested_n,
    major_findings: majors.rows,
    runs_today: today.rows[0].n,
    spend_month_usd: Number(spend.rows[0].usd),
    storage,
    attention,
    suites: groups.rows,
  };
}

export { canView };
