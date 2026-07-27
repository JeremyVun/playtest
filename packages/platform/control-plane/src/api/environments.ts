// Environments. A named target: a core-shaped `app` overlay
// (merged as app.envs.<name> at materialization — Phase 2), an `auth` identity map,
// `secret_env`, a `discovery_allowed` flag (the discovery skill's staging-only
// guardrail, made enforceable), and GHA `runner_labels`. Phase 1 stores/serves the
// config verbatim with light structural checks; the overlay is merged and resolved
// by the executor in Phase 2 (the platform never re-implements config merging).
// Developer role throughout.
//
// A target is owned either by the project (`suite_id` null — a deployment ring
// every suite can launch against, credentials and all) or by one suite
// (`suite_id` set — visible and launchable from that suite only, deleted with
// it). The two share this table and this API because a launch treats them
// identically: `run_groups.environment_id` points at whichever was chosen, and
// the runner materializes either as `app.envs.<name>`. Names stay unique per
// project across both scopes — the name IS the overlay key, so one name means
// one target inside a project, whoever owns it.
import { createHash } from "node:crypto";
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { created, noContent, readJsonBody, readRawBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, getSuite, stringField } from "./util.ts";
import { AppError, badRequest, notFound, conflict } from "../errors.ts";
import { blobKey } from "../store/object-store.ts";

/**
 * GET /projects/:p/environments — every target in the project, project-owned
 * first. Suite-owned rows carry the suite that owns them so a caller can scope
 * the list (the launch dialog) or attribute it (Settings → Test targets)
 * without a second request.
 */
export async function listEnvironments(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  const { rows } = await ctx.db.query(
    `SELECT e.*, s.slug AS suite_slug, s.name AS suite_name
       FROM environments e
       LEFT JOIN suites s ON s.id = e.suite_id
      WHERE e.project_id = $1
      ORDER BY (e.suite_id IS NOT NULL), e.name`,
    [project.id],
  );
  return { items: rows.map(envView) };
}

/** POST /projects/:p/environments */
export async function createEnvironment(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  const body = await readJsonBody(ctx.req);
  const fields = validateEnvFields(body, { nameRequired: true });
  // A suite-owned target: same row, visible from one suite. The suite must be in
  // this project — otherwise a caller could hang a target off someone else's.
  let suite: HostedDynamic = null;
  if (body.suite_id != null && body.suite_id !== "") {
    suite = await getSuite(ctx, String(body.suite_id));
    if (suite.project_id !== project.id) {
      throw notFound(`no suite "${body.suite_id}" in project "${project.key}"`);
    }
  }
  const dup = await ctx.db.query(
    `SELECT e.name, s.name AS suite_name FROM environments e
       LEFT JOIN suites s ON s.id = e.suite_id
      WHERE e.project_id = $1 AND e.name = $2`,
    [project.id, fields.name],
  );
  if (dup.rows.length) throw nameConflict(fields.name, dup.rows[0].suite_name);

  const env = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const id = ulid();
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO environments (id, project_id, suite_id, name, config, discovery_allowed, runner_labels)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, project.id, suite?.id ?? null, fields.name, fields.config, fields.discovery_allowed, fields.runner_labels],
      ));
    } catch (e: HostedDynamic) {
      // Pre-check races: a concurrent create can slip past it and hit the unique
      // index — surface the same friendly conflict, never the raw constraint error.
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw nameConflict(fields.name, null);
      }
      throw e;
    }
    await audit(tx, {
      actor: actorOf(p),
      action: "environment.created",
      entityType: "environment",
      entityId: id,
      projectId: project.id,
      detail: { name: fields.name, discovery_allowed: fields.discovery_allowed, suite_id: suite?.id ?? null },
    });
    return rows[0];
  });
  // With the owning suite's slug and name attached: the console puts this
  // response straight into its list, and a row that labels itself with a raw id
  // until the next refetch is a worse first impression than one extra read.
  return created(envView(withSuite(env, suite)));
}

/** A written row, dressed with the owning suite the way the list query does. */
const withSuite = (row: HostedDynamic, suite: HostedDynamic) =>
  suite ? { ...row, suite_slug: suite.slug, suite_name: suite.name } : row;

/**
 * One name, one target per project — the name is the `app.envs.<name>` overlay
 * key, so a clash is real even across scopes. Say who holds the name, since a
 * suite-owned one is invisible from the project's own list of targets.
 */
const nameConflict = (name: HostedDynamic, suiteName: HostedDynamic) =>
  conflict(
    suiteName
      ? `the suite "${suiteName}" already has a target named "${name}" — target names are unique within a project`
      : `an environment named "${name}" already exists`,
  );

/** PUT /environments/:e */
export async function updateEnvironment(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const env = await getEnv(ctx);
  guard(ctx, env.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a JSON object");
  if ("name" in body && body.name !== env.name) {
    throw badRequest(`environments can't be renamed (this one is "${env.name}") — create a new one instead`);
  }
  // Ownership is fixed for the same reason a name is: run history, and the
  // suite-scoped visibility rule at launch, both read it. An empty string means
  // "no suite" on the way in, exactly as it does on create — the two endpoints
  // must not disagree about the same field.
  const wantsSuite = body.suite_id === "" ? null : (body.suite_id ?? null);
  if ("suite_id" in body && wantsSuite !== (env.suite_id ?? null)) {
    throw badRequest(
      env.suite_id
        ? `"${env.name}" belongs to a suite and can't be moved — create a project target instead`
        : `"${env.name}" is a project target and can't be moved into a suite — create a suite target instead`,
    );
  }
  // Merge-on-update: an omitted field keeps its stored value, so a partial
  // PUT {discovery_allowed: true} can never silently wipe the app/auth/secret_env
  // overlay or the runner labels.
  const fields = validateEnvFields({
    name: env.name,
    config: "config" in body ? body.config : env.config,
    runner_labels: "runner_labels" in body ? body.runner_labels : env.runner_labels,
    discovery_allowed: "discovery_allowed" in body ? body.discovery_allowed : env.discovery_allowed,
  }, { nameRequired: false });

  const updated = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE environments SET config = $2, discovery_allowed = $3, runner_labels = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
      [env.id, fields.config, fields.discovery_allowed, fields.runner_labels],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "environment.updated",
      entityType: "environment",
      entityId: env.id,
      projectId: env.project_id,
      detail: { name: env.name, discovery_allowed: fields.discovery_allowed },
    });
    return rows[0];
  });
  const owner = updated.suite_id ? await getSuite(ctx, updated.suite_id).catch(() => null) : null;
  return envView(withSuite(updated, owner));
}

/** DELETE /environments/:e */
export async function deleteEnvironment(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const env = await getEnv(ctx);
  guard(ctx, env.project_id, "developer");
  // Run history pins a target (run_groups.environment_id is ON DELETE RESTRICT),
  // and "where did this run point?" is exactly what a reader needs months later.
  // Say that, rather than letting the constraint surface as a 500.
  // The constraint is on the launch (run_groups), so that decides; the number a
  // person reads is the runs inside it, because "1 run" for a launch of twelve
  // stories is the kind of number that makes someone doubt the message.
  const used = await ctx.db.query(
    `SELECT COUNT(DISTINCT g.id) AS launches, COUNT(r.id) AS runs
       FROM run_groups g LEFT JOIN runs r ON r.run_group_id = g.id
      WHERE g.environment_id = $1`,
    [env.id],
  );
  const { launches, runs } = used.rows[0];
  if (launches > 0) {
    const what = runs > 0
      ? `${runs} run${runs === 1 ? "" : "s"}`
      : `${launches} launch${launches === 1 ? "" : "es"}`;
    throw conflict(
      `"${env.name}" has ${what} against it and can't be deleted — ` +
        `that history records where they pointed. Change its URL instead, or leave it unused.`,
    );
  }
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`DELETE FROM environments WHERE id = $1`, [env.id]);
    await audit(tx, {
      actor: actorOf(p),
      action: "environment.deleted",
      entityType: "environment",
      entityId: env.id,
      projectId: env.project_id,
      detail: { name: env.name },
    });
  });
  return noContent();
}

// What an uploaded app binary may be called. The extension is not decoration:
// the runner materializes a `.zip` by unpacking it (an iOS `.app` is a
// directory, so it can only travel zipped) and everything else as a file, and
// core's mobile driver reads the extension too.
const APP_ARTIFACT_EXTENSIONS = [".apk", ".aab", ".ipa", ".zip"];

/**
 * PUT /environments/:e/app-artifact?filename=<name> [developer] — the raw bytes
 * of the app under test.
 *
 * Stored content-addressed beside every other blob, so re-uploading identical
 * bytes writes the same key and is a no-op by construction; the environment
 * records only the reference. Nothing here touches an in-flight run: a launch
 * pins the reference it resolved, so replacing the binary changes the NEXT
 * launch and no earlier one.
 */
export async function putAppArtifact(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const env = await getEnv(ctx);
  guard(ctx, env.project_id, "developer");
  const filename = appArtifactFilename(ctx.query.get("filename"));
  const limit = ctx.config.uploads.appArtifactMaxBytes;
  let bytes;
  try {
    bytes = await readRawBody(ctx.req, { limit });
  } catch (e: HostedDynamic) {
    // The generic "body exceeds N bytes" says nothing a person can act on.
    // Name the cap in megabytes, the variable that raises it, and the way a
    // build that genuinely cannot be uploaded still runs.
    if (e instanceof AppError && e.code === "payload_too_large") {
      throw new AppError(
        "payload_too_large",
        `"${filename}" is larger than this deployment's app-artifact cap of ${mib(limit)} MiB. ` +
          `Raise PLAYTEST_APP_ARTIFACT_MAX_MB on the server, or leave the build on the runner's own ` +
          `disk and point this environment's app overlay at its absolute path instead.`,
      );
    }
    throw e;
  }
  if (!bytes.length) throw badRequest(`the request body was empty — PUT the bytes of "${filename}"`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Object first, reference second: a reference to a blob that is not there yet
  // is the one ordering a reader can never recover from.
  await ctx.store.put(blobKey(sha256), bytes);

  const artifact = {
    sha256,
    size: bytes.length,
    filename,
    uploaded_at: new Date().toISOString(),
    uploaded_by: p.kind === "user" ? p.userId : (p.tokenId ?? null),
  };
  const updated = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE environments SET app_artifact = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [env.id, artifact],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: "environment.app_artifact_set",
      entityType: "environment",
      entityId: env.id,
      projectId: env.project_id,
      detail: { name: env.name, sha256, size: artifact.size, filename, replaced: env.app_artifact?.sha256 ?? null },
    });
    return rows[0];
  });
  const owner = updated.suite_id ? await getSuite(ctx, updated.suite_id).catch(() => null) : null;
  return envView(withSuite(updated, owner));
}

/**
 * DELETE /environments/:e/app-artifact [developer] — clear the reference. The
 * blob stays until retention's blob GC finds no environment and no pinned run
 * group naming it, so clearing this never reaches back into run history.
 * Clearing an environment that has no artifact is a no-op, not an error.
 */
export async function deleteAppArtifact(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const env = await getEnv(ctx);
  guard(ctx, env.project_id, "developer");
  if (!env.app_artifact) return noContent();
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`UPDATE environments SET app_artifact = NULL, updated_at = now() WHERE id = $1`, [env.id]);
    await audit(tx, {
      actor: actorOf(p),
      action: "environment.app_artifact_cleared",
      entityType: "environment",
      entityId: env.id,
      projectId: env.project_id,
      detail: { name: env.name, sha256: env.app_artifact.sha256, filename: env.app_artifact.filename ?? null },
    });
  });
  return noContent();
}

/** A plain, safe base name with an extension the runner knows how to materialize. */
function appArtifactFilename(raw: HostedDynamic) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) {
    throw badRequest(
      `"filename" is required: name the file being uploaded (for example ?filename=app-release.apk) — ` +
        `the runner installs it under that name and its extension decides how it is materialized`,
    );
  }
  if (name.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
    throw badRequest(
      `"filename" must be a plain file name — letters, digits, dot, dash and underscore only, no directories (got ${JSON.stringify(name)})`,
    );
  }
  const ext = APP_ARTIFACT_EXTENSIONS.find((e) => name.toLowerCase().endsWith(e));
  if (!ext) {
    throw badRequest(
      `"${name}" is not an app binary this platform can materialize (expected ${APP_ARTIFACT_EXTENSIONS.join(", ")}). ` +
        `An iOS .app is a directory, so upload it zipped — the runner unpacks it.`,
    );
  }
  return name;
}

const mib = (bytes: number) => Math.round(bytes / (1024 * 1024));

async function getEnv(ctx: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM environments WHERE id = $1`, [ctx.params.e]);
  if (!rows[0]) throw notFound(`no environment "${ctx.params.e}"`);
  return rows[0];
}

function validateEnvFields(body: HostedDynamic, { nameRequired }: HostedDynamic) {
  const name = stringField(body, "name", { required: nameRequired, max: 63 });
  const config = body.config ?? {};
  if (typeof config !== "object" || Array.isArray(config)) throw badRequest(`"config" must be an object`);
  for (const k of ["app", "auth", "secret_env"]) {
    if (config[k] != null && (typeof config[k] !== "object" || Array.isArray(config[k]))) {
      throw badRequest(`"config.${k}" must be an object`);
    }
  }
  // Stored as a JSON array (never NULL): absent labels normalize to [] here, so
  // every read — envView, dispatch label routing — sees a JS array.
  let runner_labels = body.runner_labels ?? [];
  if (!Array.isArray(runner_labels) || runner_labels.some((l) => typeof l !== "string")) {
    throw badRequest(`"runner_labels" must be an array of strings`);
  }
  const discovery_allowed = body.discovery_allowed === true;
  return { name, config, runner_labels, discovery_allowed };
}

const envView = (r: HostedDynamic) => ({
  id: r.id,
  project_id: r.project_id,
  // null for a project-owned ring; the owning suite for a suite-owned target.
  suite_id: r.suite_id ?? null,
  suite: r.suite_id ? { id: r.suite_id, slug: r.suite_slug ?? null, name: r.suite_name ?? null } : null,
  name: r.name,
  config: r.config,
  discovery_allowed: r.discovery_allowed,
  runner_labels: r.runner_labels,
  // The uploaded app binary, by reference only — never a URL and never bytes.
  // Null for the ordinary case: a web or API target, or a co-located runner
  // whose build is already a path on its own disk.
  app_artifact: r.app_artifact ?? null,
  updated_at: r.updated_at,
});
