// Self-hosted runner registry. Registration is identity, not routing: the
// credential minted here is the only long-lived secret on the runner's machine
// and scopes it to exactly one project, while labels merely narrow which of that
// project's jobs it may claim (docs/contracts/hosted.md, "Runner pool").
//
// Shown once, stored hashed — the same discipline as project API tokens.
//
// One runner may instead be SITE-SCOPED (`project_id IS NULL`): a machine a site
// operator deliberately trusted with every project's work. Its lifecycle lives
// in `api/site-runners.ts`; this file owns how a project SEES one, which is the
// tenant-shaped projection below.
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { created, noContent, readJsonBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, stringField } from "./util.ts";
import { newRunnerCredential, normalizeLabels, isSiteRunner } from "../auth/runner-credentials.ts";
import { conflict, forbidden, notFound } from "../errors.ts";
import { emitPlatformEvent } from "../events/outbox.ts";

/**
 * GET /projects/:p/runners [viewer] — the fleet: what each runner advertises,
 * when it last checked in, and what it is working on right now. Ephemeral CI
 * registrations are excluded; they are pipeline scaffolding, not fleet, and one
 * busy repository would otherwise bury the machines a person actually keeps.
 *
 * Site-scoped runners appear here too, because this project's launches really
 * are claimable by them — but read-only (`scope: "site"`), and projected FOR
 * THIS VIEWER: a claim belonging to another project is redacted to "busy in
 * another project" rather than joining that project's dispatch and run ids
 * straight into the answer.
 */
export async function listRunners(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT r.*,
            d.id AS claim_dispatch_id, d.kind AS claim_kind, d.ref_id AS claim_ref_id,
            d.project_id AS claim_project_id,
            d.claimed_at AS claim_claimed_at, d.heartbeat_at AS claim_heartbeat_at
       FROM runners r
       LEFT JOIN dispatches d
         ON d.runner_id = r.id AND d.status IN ('requested','scheduled','running')
      WHERE (r.project_id = $1 OR r.project_id IS NULL)
        AND r.ephemeral = 0
        AND (r.project_id IS NOT NULL OR r.revoked_at IS NULL)
      ORDER BY r.project_id IS NULL, r.name`,
    [project.id],
  );
  return { items: rows.map((r: HostedDynamic) => runnerView(r, { viewerProjectId: project.id })) };
}

/**
 * POST /projects/:p/runners {name, labels?} [developer] — register a runner and
 * mint its credential. The plaintext is in this response and nowhere else, ever.
 */
export async function createRunner(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  const body = await readJsonBody(ctx.req);
  const name: HostedDynamic = stringField(body, "name", { required: true, max: 100 });
  const labels = normalizeLabels(body.labels);
  const { plaintext, hash } = newRunnerCredential();
  const id = ulid();

  const row = await ctx.db.withTx(async (tx: HostedDynamic) => {
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO runners (id, project_id, name, labels, credential_hash, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, project.id, name, labels, hash, principal.kind === "user" ? principal.userId : null],
      ));
    } catch (e: HostedDynamic) {
      // A concurrent register can slip past any pre-check and hit the unique
      // index — surface the friendly conflict, never the raw constraint error.
      // The index covers live runners only, so a revoked machine's name is free
      // to reuse and this can only mean a second runner that is still standing.
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw conflict(
          `a runner named "${name}" is already registered and live in this project — ` +
            `revoke that one first, or give this machine a different name`,
        );
      }
      throw e;
    }
    await audit(tx, {
      actor: actorOf(principal),
      action: "runner.registered",
      entityType: "runner",
      entityId: id,
      projectId: project.id,
      detail: { name, labels },
    });
    // Someone else's console is looking at this list too; the feed is how it
    // learns, without a timer (docs/contracts/hosted.md, "Runner pool").
    await emitRunnerStatus(tx, rows[0], { state: "registered", labels });
    return rows[0];
  });

  // The one time the credential is ever revealed.
  return created({ ...runnerView(row), credential: plaintext });
}

/**
 * DELETE /projects/:p/runners/:r [developer] — revoke. Future check-ins, claims
 * and exchanges are refused; a group already exchanged keeps running under its
 * scoped bearer until that token expires. Revoking twice is a no-op, not an error.
 *
 * A site-scoped runner is NOT revocable here, however loudly it appears in this
 * project's list: it serves every project, so retiring it is a site-operator
 * decision and one project's developer must not be able to take the fleet down.
 */
export async function deleteRunner(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  const { rows } = await ctx.db.query(`SELECT * FROM runners WHERE id = $1 AND project_id = $2`, [
    ctx.params.r,
    project.id,
  ]);
  const runner = rows[0];
  if (!runner) {
    const { rows: site } = await ctx.db.query(`SELECT name FROM runners WHERE id = $1 AND project_id IS NULL`, [
      ctx.params.r,
    ]);
    if (site[0]) {
      throw forbidden(
        `runner "${site[0].name}" is site-scoped: it serves every project on this deployment, so only a site ` +
          `operator can revoke it (DELETE /api/v1/site/runners/${ctx.params.r}). This project can stop using it ` +
          `by giving its rings runner labels that machine does not advertise.`,
      );
    }
    throw notFound(`no runner "${ctx.params.r}" in project "${project.key}"`);
  }
  if (runner.revoked_at) return noContent();
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`UPDATE runners SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [runner.id]);
    await audit(tx, {
      actor: actorOf(principal),
      action: "runner.revoked",
      entityType: "runner",
      entityId: runner.id,
      projectId: project.id,
      detail: { name: runner.name, labels: runner.labels },
    });
    await emitRunnerStatus(tx, runner, { state: "revoked" });
  });
  return noContent();
}

/**
 * `runner.status` — the fleet moved. Emitted when a runner joins, comes back
 * from silence, re-advertises its labels, takes a claim, or is revoked; never
 * on the steady state, which is what keeps this an edge signal rather than a
 * poll with extra steps. A console repaints its Runners section from it and
 * reads presence off `last_seen_at` in between (docs/contracts/hosted.md,
 * "Runner pool").
 *
 * A platform event row REQUIRES a project, and a site-scoped runner has none.
 * Presence and registry edges are rare and edge-triggered, so they fan out one
 * event per project at emit time — every console watching any project sees the
 * same machine arrive or leave. A CLAIM is different: it belongs to exactly one
 * project, so its caller names that project with `projectId` and the event
 * lands only in that project's feed.
 */
export async function emitRunnerStatus(
  q: HostedDynamic,
  runner: HostedDynamic,
  payload: HostedDynamic = {},
  { projectId = null }: { projectId?: string | null } = {},
) {
  const emit = async (target: string) =>
    await emitPlatformEvent(q, {
      projectId: target,
      type: "runner.status",
      entity: { runner_id: runner.id },
      payload: { runner_id: runner.id, name: runner.name, scope: isSiteRunner(runner) ? "site" : "project", ...payload },
    });
  const named = projectId ?? runner.project_id ?? null;
  if (named) return void (await emit(named));
  const { rows } = await q.query(`SELECT id FROM projects ORDER BY id`);
  for (const row of rows) await emit(row.id);
}

/**
 * One runner, shaped for whoever is reading.
 *
 * `viewerProjectId` is the project whose Runners page this is. It is what makes
 * the projection TENANT-SHAPED rather than merely single-operator-correct: a
 * site runner busy with another project's dispatch is reported as busy, with
 * `claim.foreign` set and every identifier null. The keys stay put so a reader
 * needs no second shape, and there is no branch anywhere that could forget to
 * redact one of them.
 */
const runnerView = (r: HostedDynamic, { viewerProjectId = null }: { viewerProjectId?: string | null } = {}) => {
  const scope = isSiteRunner(r) ? "site" : "project";
  // A site runner is administered by the site operator, never from a project's
  // Runners page — the console renders it read-only from this.
  const managed_here = viewerProjectId == null || r.project_id === viewerProjectId;
  const foreign = Boolean(
    r.claim_dispatch_id && viewerProjectId != null && r.claim_project_id != null && r.claim_project_id !== viewerProjectId,
  );
  return {
    id: r.id,
    project_id: r.project_id ?? null,
    scope,
    managed_here,
    name: r.name,
    labels: r.labels,
    ephemeral: r.ephemeral === true,
    created_at: r.created_at,
    last_seen_at: r.last_seen_at ?? null,
    revoked_at: r.revoked_at ?? null,
    // Null for a standing runner: it stops working when someone revokes it, not
    // on a clock. An ephemeral CI registration states when it stops.
    expires_at: r.expires_at ?? null,
    // What this runner is executing right now, if anything — the console links it
    // to its run group without a second request. Unless that work belongs to
    // someone else, in which case all this reader learns is that it is busy.
    claim: r.claim_dispatch_id
      ? {
          foreign,
          dispatch_id: foreign ? null : r.claim_dispatch_id,
          kind: foreign ? null : r.claim_kind,
          run_group_id: foreign || r.claim_kind !== "group" ? null : r.claim_ref_id,
          mint_claim_id: foreign || r.claim_kind !== "mint" ? null : r.claim_ref_id,
          claimed_at: r.claim_claimed_at ?? null,
          heartbeat_at: r.claim_heartbeat_at ?? null,
        }
      : null,
  };
};

export { runnerView };
