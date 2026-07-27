// Self-hosted runner registry. Registration is identity, not routing: the
// credential minted here is the only long-lived secret on the runner's machine
// and scopes it to exactly one project, while labels merely narrow which of that
// project's jobs it may claim (docs/contracts/hosted.md, "Runner pool").
//
// Shown once, stored hashed — the same discipline as project API tokens.
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { created, noContent, readJsonBody } from "../http.ts";
import { requireAuth, guard, getProjectByKey, stringField } from "./util.ts";
import { newRunnerCredential, normalizeLabels } from "../auth/runner-credentials.ts";
import { conflict, notFound } from "../errors.ts";

/**
 * GET /projects/:p/runners [viewer] — the fleet: what each runner advertises,
 * when it last checked in, and what it is working on right now. Ephemeral CI
 * registrations are excluded; they are pipeline scaffolding, not fleet, and one
 * busy repository would otherwise bury the machines a person actually keeps.
 */
export async function listRunners(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT r.*,
            d.id AS claim_dispatch_id, d.kind AS claim_kind, d.ref_id AS claim_ref_id,
            d.claimed_at AS claim_claimed_at, d.heartbeat_at AS claim_heartbeat_at
       FROM runners r
       LEFT JOIN dispatches d
         ON d.runner_id = r.id AND d.status IN ('requested','scheduled','running')
      WHERE r.project_id = $1 AND r.ephemeral = 0
      ORDER BY r.name`,
    [project.id],
  );
  return { items: rows.map(runnerView) };
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
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw conflict(`a runner named "${name}" is already registered in this project`);
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
    return rows[0];
  });

  // The one time the credential is ever revealed.
  return created({ ...runnerView(row), credential: plaintext });
}

/**
 * DELETE /projects/:p/runners/:r [developer] — revoke. Future check-ins, claims
 * and exchanges are refused; a group already exchanged keeps running under its
 * scoped bearer until that token expires. Revoking twice is a no-op, not an error.
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
  if (!runner) throw notFound(`no runner "${ctx.params.r}" in project "${project.key}"`);
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
  });
  return noContent();
}

const runnerView = (r: HostedDynamic) => ({
  id: r.id,
  project_id: r.project_id,
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
  // to its run group without a second request.
  claim: r.claim_dispatch_id
    ? {
        dispatch_id: r.claim_dispatch_id,
        kind: r.claim_kind,
        run_group_id: r.claim_kind === "group" ? r.claim_ref_id : null,
        mint_claim_id: r.claim_kind === "mint" ? r.claim_ref_id : null,
        claimed_at: r.claim_claimed_at ?? null,
        heartbeat_at: r.claim_heartbeat_at ?? null,
      }
    : null,
});

export { runnerView };
