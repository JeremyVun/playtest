// Applications and rings (docs/contracts/hosted.md, "Applications and rings").
//
// An APPLICATION is one executable test surface — a web app, an HTTP API, or a
// mobile build for one platform. A RING is an application-owned deployment
// target: `local`, `staging`, `prod`. A suite belongs to exactly one application
// and may launch only against that application's rings, which is what makes
// "setting up a mobile suite corrupted the ring a web suite launched against"
// unrepresentable.
//
// Two rules run through this whole file:
//
//   * Keys are immutable. Runner configuration and run evidence address an
//     application and a ring by key, so a rename would silently rebind a
//     machine's bindings. `driver`, `platform`, a ring's application, and a
//     suite's application binding are immutable for the same reason. Names are
//     editable; delete-and-recreate is the stated remedy for a mistyped key.
//   * A ring holds LOGICAL policy plus, for web/API, one base URL. It never
//     holds a mobile binary path, a device, or an Appium endpoint — enforced by
//     an allowlist (`validateRingConfig`), not by convention.
//
// Reads are `viewer` (an editor picks an application at suite creation, and the
// launch dialog is a viewer surface); every mutation is `developer`.
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { created, noContent, readJsonBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, stringField } from "./util.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { normalizeLabels } from "../auth/runner-credentials.ts";

const DRIVERS = ["web", "api", "mobile"];
const PLATFORMS = ["ios", "android"];
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The five PHYSICAL fields a runtime target owns (core's `runtimeTarget`). A
 * ring may not carry any of them at the overlay position where they would take
 * effect: the web/API URL lives in the first-class `base_url` column, and the
 * mobile trio is a runner-local fact that no platform record stores or serves.
 */
const PHYSICAL_APP_KEYS = ["base_url", "app", "platform", "device", "appium_url"];

/**
 * The LOGICAL keys a ring's `config.app` overlay may set. An allowlist, not a
 * blacklist — and applied only HERE, at the one position where `app` means
 * "core's app overlay". Deeper data is untouched, so an auth identity or a
 * secret_env entry may legitimately be named `app` or `device`.
 *
 * `compose`, `driver` and `envs` are excluded deliberately rather than by
 * omission (see `ringAppKeyError`).
 */
const LOGICAL_APP_KEYS = [
  "init",
  "storage_state",
  "auth",
  "auth_states",
  "preserve_session",
  "openapi",
  "allowed_origins",
  "headers",
  "viewport",
  "device_scale_factor",
  "settle",
  "cookies",
];

const CONFIG_KEYS = ["app", "auth", "secret_env"];
const RING_AUTH_KEYS = ["identities", "default"];

// ---------- applications ----------

/**
 * GET /projects/:p/applications[?include=rings] — every surface in the project.
 * `include=rings` folds each application's rings in, which is what the suite
 * creation and launch dialogs need in one request.
 */
export async function listApplications(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT * FROM applications WHERE project_id = $1 ORDER BY key`,
    [project.id],
  );
  const items = rows.map(applicationView);
  if ((ctx.query.get("include") || "").split(",").includes("rings")) {
    const { rows: rings } = await ctx.db.query(
      `SELECT r.* FROM rings r JOIN applications a ON a.id = r.application_id
        WHERE a.project_id = $1 ORDER BY r.key`,
      [project.id],
    );
    const byApp = new Map<string, HostedDynamic[]>();
    for (const r of rings) {
      const list = byApp.get(r.application_id) ?? [];
      list.push(ringView(r));
      byApp.set(r.application_id, list);
    }
    for (const item of items) item.rings = byApp.get(item.id) ?? [];
  }
  return { items };
}

/** GET /applications/:a[?include=rings] */
export async function getApplication(ctx: HostedDynamic) {
  const app = await applicationById(ctx, ctx.params.a);
  guard(ctx, app.project_id, "viewer");
  const view = applicationView(app);
  if ((ctx.query.get("include") || "").split(",").includes("rings")) {
    view.rings = (await ringsOf(ctx, app.id)).map(ringView);
  }
  return view;
}

/** POST /projects/:p/applications {key, name, driver, platform?} [developer] */
export async function createApplication(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  const body = await readJsonBody(ctx.req);
  const fields = validateApplicationFields(body);

  const row = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const id = ulid();
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO applications (id, project_id, key, name, driver, platform)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, project.id, fields.key, fields.name, fields.driver, fields.platform],
      ));
    } catch (e: HostedDynamic) {
      // Pre-checks race; the unique index is the truth. Surface the friendly
      // conflict, never the raw constraint error.
      if (/UNIQUE constraint failed/.test(e.message)) throw keyConflict(fields.key);
      throw e;
    }
    await audit(tx, {
      actor: actorOf(p),
      action: "application.created",
      entityType: "application",
      entityId: id,
      projectId: project.id,
      detail: { key: fields.key, name: fields.name, driver: fields.driver, platform: fields.platform },
    });
    return rows[0];
  });
  return created(applicationView(row));
}

/**
 * PUT /applications/:a {name} [developer] — the name is the only editable
 * field. Everything else is identity: a key that runner configuration binds, and
 * a driver/platform pair core resolves against.
 */
export async function updateApplication(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const app = await applicationById(ctx, ctx.params.a);
  guard(ctx, app.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a JSON object");
  refuseImmutable(body, app, {
    key: `an application's key is part of its identity — runner configuration and run evidence bind "${app.key}". Create a new application instead`,
    driver: `an application's driver can't change (this one is "${app.driver}") — a web app and an iOS build are two applications`,
    platform: `an application's platform can't change (this one is ${app.platform ? `"${app.platform}"` : "unset"}) — create a new application instead`,
  });
  const name = stringField(body, "name", { required: true, max: 200 });

  const row = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE applications SET name = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [app.id, name],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "application.updated",
      entityType: "application",
      entityId: app.id,
      projectId: app.project_id,
      detail: { key: app.key, name },
    });
    return rows[0];
  });
  return applicationView(row);
}

/**
 * DELETE /applications/:a [developer] — refuse-not-cascade. An application is
 * deletable only when nothing points at it, and the refusal NAMES the rings,
 * suites and run groups that do. Nothing an application owns is ever deleted as
 * a side effect of deleting it.
 */
export async function deleteApplication(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const app = await applicationById(ctx, ctx.params.a);
  guard(ctx, app.project_id, "developer");

  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const rings = (await tx.query(`SELECT key FROM rings WHERE application_id = $1 ORDER BY key`, [app.id])).rows;
    const suites = (await tx.query(`SELECT slug FROM suites WHERE application_id = $1 ORDER BY slug`, [app.id])).rows;
    const groups = (await tx.query(`SELECT COUNT(*) AS n FROM run_groups WHERE application_id = $1`, [app.id])).rows[0].n;
    const blockers = [
      listBlocker(rings.map((r: HostedDynamic) => r.key), "environment", "environments"),
      listBlocker(suites.map((s: HostedDynamic) => s.slug), "suite", "suites"),
      groups > 0 ? `${groups} run group${groups === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    if (blockers.length) {
      throw conflict(
        `application "${app.key}" still has ${joinList(blockers as string[])} — delete them first. ` +
          `Nothing is removed on your behalf: environments carry credentials and run groups are evidence.`,
      );
    }
    await tx.query(`DELETE FROM applications WHERE id = $1`, [app.id]);
    await audit(tx, {
      actor: actorOf(p),
      action: "application.deleted",
      entityType: "application",
      entityId: app.id,
      projectId: app.project_id,
      detail: { key: app.key, name: app.name },
    });
  });
  return noContent();
}

// ---------- rings ----------

/** GET /applications/:a/rings */
export async function listRings(ctx: HostedDynamic) {
  const app = await applicationById(ctx, ctx.params.a);
  guard(ctx, app.project_id, "viewer");
  return { items: (await ringsOf(ctx, app.id)).map(ringView) };
}

/** POST /applications/:a/rings {key, name, base_url?, runner_labels?, config?} */
export async function createRing(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const app = await applicationById(ctx, ctx.params.a);
  guard(ctx, app.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  const fields = validateRingFields(body, app, { keyRequired: true });

  const row = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const id = ulid();
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO rings (id, application_id, key, name, base_url, runner_labels, config)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, app.id, fields.key, fields.name, fields.base_url, fields.runner_labels, fields.config],
      ));
    } catch (e: HostedDynamic) {
      if (/UNIQUE constraint failed/.test(e.message)) throw ringKeyConflict(fields.key, app.key);
      throw e;
    }
    await audit(tx, {
      actor: actorOf(p),
      action: "ring.created",
      entityType: "ring",
      entityId: id,
      projectId: app.project_id,
      detail: {
        application: app.key,
        key: fields.key,
        name: fields.name,
        base_url: fields.base_url,
      },
    });
    return rows[0];
  });
  return created(ringView(row, app));
}

/**
 * PUT /rings/:r [developer] — merge-on-update: an omitted field keeps its stored
 * value, so a partial `{runner_labels: [...]}` can never silently wipe the
 * auth/secret_env overlay or the URL.
 */
export async function updateRing(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const { ring, application } = await ringById(ctx, ctx.params.r);
  guard(ctx, application.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a JSON object");
  refuseImmutable(body, ring, {
    key: `an environment's key is part of its identity — runner configuration binds "${application.key}/${ring.key}". Create a new environment instead`,
  });
  if ("application_id" in body && body.application_id !== ring.application_id) {
    throw badRequest(`an environment belongs to one application for its whole life — create one on the other application instead`);
  }
  const fields = validateRingFields(
    {
      key: ring.key,
      name: "name" in body ? body.name : ring.name,
      base_url: "base_url" in body ? body.base_url : ring.base_url,
      runner_labels: "runner_labels" in body ? body.runner_labels : ring.runner_labels,
      config: "config" in body ? body.config : ring.config,
    },
    application,
    { keyRequired: false },
  );

  const row = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE rings SET name = $2, base_url = $3, runner_labels = $4, config = $5, updated_at = now()
         WHERE id = $1 RETURNING *`,
      [ring.id, fields.name, fields.base_url, fields.runner_labels, fields.config],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "ring.updated",
      entityType: "ring",
      entityId: ring.id,
      projectId: application.project_id,
      detail: {
        application: application.key,
        key: ring.key,
        base_url: fields.base_url,
      },
    });
    return rows[0];
  });
  return ringView(row, application);
}

/**
 * DELETE /rings/:r [developer] — refuse-not-cascade, naming the referrers. Run
 * groups record where they pointed; an auth provider bound to this ring holds
 * secrets policy, and silently promoting it to project-wide would move that
 * policy without anyone deciding it.
 */
export async function deleteRing(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const { ring, application } = await ringById(ctx, ctx.params.r);
  guard(ctx, application.project_id, "developer");

  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const groups = (
      await tx.query(
        `SELECT COUNT(DISTINCT g.id) AS launches, COUNT(r.id) AS runs
           FROM run_groups g LEFT JOIN runs r ON r.run_group_id = g.id
          WHERE g.ring_id = $1`,
        [ring.id],
      )
    ).rows[0];
    const providers = (
      await tx.query(`SELECT name FROM auth_providers WHERE ring_id = $1 ORDER BY name`, [ring.id])
    ).rows;
    const blockers = [
      groups.launches > 0
        ? groups.runs > 0
          ? `${groups.runs} run${groups.runs === 1 ? "" : "s"} against it`
          : `${groups.launches} launch${groups.launches === 1 ? "" : "es"} against it`
        : null,
      listBlocker(providers.map((r: HostedDynamic) => r.name), "auth provider", "auth providers"),
    ].filter(Boolean);
    if (blockers.length) {
      throw conflict(
        `environment "${application.key}/${ring.key}" has ${joinList(blockers as string[])} and can't be deleted — ` +
          `run history records where it pointed, and a bound auth provider would lose its scope. ` +
          `Change its URL instead, or leave it unused.`,
      );
    }
    await tx.query(`DELETE FROM rings WHERE id = $1`, [ring.id]);
    await audit(tx, {
      actor: actorOf(p),
      action: "ring.deleted",
      entityType: "ring",
      entityId: ring.id,
      projectId: application.project_id,
      detail: { application: application.key, key: ring.key, name: ring.name },
    });
  });
  return noContent();
}

// ---------- lookups shared with the launch path ----------

export async function applicationById(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM applications WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`no application "${id}"`);
  return rows[0];
}

/** A ring plus the application that owns it — the pair every caller needs. */
export async function ringById(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT r.*, a.project_id AS application_project_id FROM rings r
       JOIN applications a ON a.id = r.application_id
      WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound(`no environment "${id}"`);
  const application = await applicationById(ctx, rows[0].application_id);
  return { ring: rows[0], application };
}

async function ringsOf(ctx: HostedDynamic, applicationId: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM rings WHERE application_id = $1 ORDER BY key`, [applicationId]);
  return rows;
}

// ---------- validation ----------

function validateApplicationFields(body: HostedDynamic) {
  const key = stringField(body, "key", {
    required: true,
    max: 63,
    pattern: KEY_RE,
    patternHint: "must be lowercase letters, digits and hyphens",
  });
  const name = stringField(body, "name", { required: true, max: 200 });
  const driver = body.driver == null ? "web" : String(body.driver).trim();
  if (!DRIVERS.includes(driver)) throw badRequest(`"driver" must be one of ${DRIVERS.map(q).join(", ")}`);
  const rawPlatform = body.platform == null || body.platform === "" ? null : String(body.platform).trim();
  if (driver === "mobile") {
    if (!rawPlatform) {
      throw badRequest(
        `"platform" is required for a mobile application (${PLATFORMS.map(q).join(" or ")}) — ` +
          `core picks XCUITest or UiAutomator2 from it`,
      );
    }
    if (!PLATFORMS.includes(rawPlatform)) throw badRequest(`"platform" must be ${PLATFORMS.map(q).join(" or ")}`);
  } else if (rawPlatform) {
    throw badRequest(`"platform" applies to mobile applications only — this one is a ${driver} application`);
  }
  return { key, name, driver, platform: driver === "mobile" ? rawPlatform : null };
}

function validateRingFields(body: HostedDynamic, application: HostedDynamic, { keyRequired }: HostedDynamic) {
  const key = stringField(body, "key", {
    required: keyRequired,
    max: 63,
    pattern: KEY_RE,
    patternHint: "must be lowercase letters, digits and hyphens",
  });
  const name = stringField(body, "name", { required: false, max: 200 }) ?? key;
  const base_url = validateBaseUrl(body.base_url, application);
  const config = validateRingConfig(body.config ?? {});
  // Through the same validator the runner registry uses, so a ring can never ask
  // for a label a runner is not allowed to advertise.
  const runner_labels = normalizeLabels(body.runner_labels, "runner_labels");
  return { key, name, base_url, config, runner_labels };
}

/**
 * The ring's URL: required for web/API and refused for mobile. A mobile ring's
 * build, device and Appium endpoint come from the claiming runner's own
 * configuration file, so there is nothing here for a URL to mean.
 */
function validateBaseUrl(raw: HostedDynamic, application: HostedDynamic) {
  const value = raw == null || raw === "" ? null : String(raw).trim();
  if (application.driver === "mobile") {
    if (value) {
      throw badRequest(
        `"${application.key}" is a mobile application, so its environments hold no URL — the claiming runner ` +
          `supplies the build, the device and the Appium endpoint from its own configuration file`,
      );
    }
    return null;
  }
  if (!value) {
    throw badRequest(
      `"base_url" is required for a ${application.driver} environment — it is the address its runs point at, ` +
        `evaluated from the claiming runner's network position (a loopback URL means the runner's own machine)`,
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw badRequest(`"base_url" must be an absolute http(s) URL (got ${JSON.stringify(value)})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest(`"base_url" must be an http or https URL (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * The ring's logical overlay, validated against an ALLOWLIST at the two overlay
 * positions where core reads it — `config.app` and `config.auth`.
 *
 * The allowlist is the point. A property-name blacklist applied at every depth
 * would be the wrong tool twice over: it would reject the logical `app`
 * container itself, and it would reject legitimate data that merely happens to
 * be named `device` (an auth identity, a secret_env variable). Here the five
 * physical keys are rejected exactly where they would take effect, and
 * everything below `config.auth.identities` / `config.secret_env` is left alone.
 */
export function validateRingConfig(config: HostedDynamic) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw badRequest(`"config" must be an object`);
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw badRequest(
        `"config.${key}" is not part of an environment's configuration (expected ${CONFIG_KEYS.map(q).join(", ")})`,
      );
    }
    if (config[key] != null && (typeof config[key] !== "object" || Array.isArray(config[key]))) {
      throw badRequest(`"config.${key}" must be an object`);
    }
  }
  for (const key of Object.keys(config.app ?? {})) {
    if (!LOGICAL_APP_KEYS.includes(key)) throw badRequest(ringAppKeyError(key));
  }
  for (const key of Object.keys(config.auth ?? {})) {
    if (!RING_AUTH_KEYS.includes(key)) {
      throw badRequest(`"config.auth.${key}" is not part of an environment's authorization (expected ${RING_AUTH_KEYS.map(q).join(", ")})`);
    }
  }
  if (config.auth?.identities != null && (typeof config.auth.identities !== "object" || Array.isArray(config.auth.identities))) {
    throw badRequest(`"config.auth.identities" must be an object`);
  }
  return config;
}

/** Why this `config.app` key is refused — physical, structural, or unknown. */
function ringAppKeyError(key: string) {
  if (key === "base_url") {
    return `"config.app.base_url" is not an environment overlay key — an environment's URL is its own "base_url" field`;
  }
  if (PHYSICAL_APP_KEYS.includes(key)) {
    return (
      `"config.app.${key}" is a physical target the claiming runner resolves, not environment configuration — ` +
      `a mobile build's path, its device and its Appium endpoint live in the runner's own configuration ` +
      `file, keyed by application and environment key`
    );
  }
  if (key === "compose") {
    return (
      `"config.app.compose" would boot a different application under this environment's name, and hosted execution ` +
      `clears it — point its "base_url" at the deployment instead`
    );
  }
  if (key === "driver") {
    return `"config.app.driver" is the application's driver, not the environment's — create a separate application for another surface`;
  }
  if (key === "envs") {
    return `"config.app.envs" is the suite's own overlay map; an environment IS one entry in it and cannot nest another`;
  }
  return `"config.app.${key}" is not an environment overlay key (allowed: ${LOGICAL_APP_KEYS.join(", ")})`;
}

/** Refuse an immutable field the caller tried to change, with its own reason. */
function refuseImmutable(body: HostedDynamic, row: HostedDynamic, reasons: Record<string, string>) {
  for (const [field, reason] of Object.entries(reasons)) {
    if (!(field in body)) continue;
    const wanted = body[field] === "" ? null : (body[field] ?? null);
    if (wanted === (row[field] ?? null)) continue;
    throw badRequest(reason);
  }
}

const q = (s: string) => `"${s}"`;

const keyConflict = (key: HostedDynamic) => conflict(`an application with key "${key}" already exists in this project`);

const ringKeyConflict = (key: HostedDynamic, appKey: HostedDynamic) =>
  conflict(`application "${appKey}" already has an environment named "${key}"`);

/** `2 environments ("local", "prod")` — the referrers, named, capped so a refusal stays readable. */
function listBlocker(values: string[], singular: string, plural: string) {
  if (!values.length) return null;
  const shown = values.slice(0, 5).map(q).join(", ");
  const more = values.length > 5 ? `, …` : "";
  return `${values.length} ${values.length === 1 ? singular : plural} (${shown}${more})`;
}

function joinList(parts: string[]) {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ---------- views ----------

export function applicationView(r: HostedDynamic): HostedDynamic {
  return {
    id: r.id,
    project_id: r.project_id,
    key: r.key,
    name: r.name,
    driver: r.driver,
    platform: r.platform ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function ringView(r: HostedDynamic, application: HostedDynamic = null): HostedDynamic {
  return {
    id: r.id,
    application_id: r.application_id,
    ...(application ? { application: { id: application.id, key: application.key, driver: application.driver, platform: application.platform ?? null } } : {}),
    key: r.key,
    name: r.name,
    // Null for a mobile ring: the claiming runner supplies the build.
    base_url: r.base_url ?? null,
    runner_labels: r.runner_labels ?? [],
    config: r.config ?? {},
    updated_at: r.updated_at,
  };
}
