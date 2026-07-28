// Site-scoped runners: the lifecycle of a machine trusted with EVERY project's
// work (docs/contracts/hosted.md, "Site-scoped runners").
//
// Runner scope is a trust decision, not a capability one. A claiming runner
// receives suite files and secrets and executes suite hooks, so which projects
// may reach a machine has to be explicit — which is why project scope is the
// default and site scope is a deliberate site-operator grant, never something a
// project developer can hand out. Capability routing stays with labels; scope
// says nothing about what a runner can do, only whose work it may see.
//
// Three routes, all gated to the site-admin principal (`requireSiteAdmin`) and
// all writing audit rows. A console surface is optional and deferred; the
// security lifecycle is not, because a credential every project trusts must be
// KILLABLE by whoever granted it. Revocation follows project-runner semantics
// exactly: future polls, claims and exchanges refused, work already exchanged
// finishing under the bearer it was issued.
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { created, noContent, readJsonBody } from "../http.ts";
import { requireSiteAdmin, stringField } from "./util.ts";
import { newRunnerCredential, normalizeLabels } from "../auth/runner-credentials.ts";
import { conflict, notFound } from "../errors.ts";
import { emitRunnerStatus, runnerView } from "./runners.ts";

/**
 * GET /site/runners [site admin] — every site-scoped runner, with what each is
 * working on right now. The site operator is the one reader who sees claims
 * unredacted, because there is no other tenant to protect them from: this is
 * the authority that granted the machine its access in the first place.
 */
export async function listSiteRunners(ctx: HostedDynamic) {
  requireSiteAdmin(ctx);
  const { rows } = await ctx.db.query(
    `SELECT r.*,
            d.id AS claim_dispatch_id, d.kind AS claim_kind, d.ref_id AS claim_ref_id,
            d.project_id AS claim_project_id,
            d.claimed_at AS claim_claimed_at, d.heartbeat_at AS claim_heartbeat_at,
            p.key AS claim_project_key
       FROM runners r
       LEFT JOIN dispatches d
         ON d.runner_id = r.id AND d.status IN ('requested','scheduled','running')
       LEFT JOIN projects p ON p.id = d.project_id
      WHERE r.project_id IS NULL
      ORDER BY r.name`,
  );
  return {
    items: rows.map((r: HostedDynamic) => ({
      ...runnerView(r),
      // Which project's board this claim came off. Only this view carries it.
      claim_project_key: r.claim_dispatch_id ? (r.claim_project_key ?? null) : null,
    })),
  };
}

/**
 * POST /site/runners {name, labels?} [site admin] — register one, and mint its
 * credential. The plaintext is in this response and nowhere else, ever.
 */
export async function createSiteRunner(ctx: HostedDynamic) {
  const principal = requireSiteAdmin(ctx);
  const body = await readJsonBody(ctx.req);
  const name: HostedDynamic = stringField(body, "name", { required: true, max: 100 });
  const labels = normalizeLabels(body.labels);
  const { plaintext, hash } = newRunnerCredential();
  const row = await ensureSiteRunner(ctx, { name, labels, hash, actor: actorOf(principal) });
  if (!row) {
    throw conflict(
      `a site runner named "${name}" is already registered and live — revoke that one first, or give this ` +
        `machine a different name`,
    );
  }
  return created({ ...runnerView(row), credential: plaintext });
}

/**
 * DELETE /site/runners/:r [site admin] — revoke. Future check-ins, claims and
 * exchanges are refused in every project at once; a group already exchanged
 * finishes under its scoped bearer, heartbeats included. Revoking twice is a
 * no-op, not an error.
 */
export async function deleteSiteRunner(ctx: HostedDynamic) {
  const principal = requireSiteAdmin(ctx);
  const { rows } = await ctx.db.query(`SELECT * FROM runners WHERE id = $1 AND project_id IS NULL`, [ctx.params.r]);
  const runner = rows[0];
  if (!runner) throw notFound(`no site runner "${ctx.params.r}"`);
  if (runner.revoked_at) return noContent();
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(`UPDATE runners SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [runner.id]);
    await audit(tx, {
      actor: actorOf(principal),
      action: "runner.revoked",
      entityType: "runner",
      entityId: runner.id,
      // No project owns this row; the audit trail is the site's.
      projectId: null,
      detail: { name: runner.name, labels: runner.labels, scope: "site" },
    });
    await emitRunnerStatus(tx, runner, { state: "revoked" });
  });
  return noContent();
}

/**
 * Insert one live site-scoped runner, or answer null when that name is taken.
 *
 * Shared with the dev peer runner's boot-time ensure (`dev-runner.ts`), so both
 * arrivals write the same row shape, the same audit action, and the same
 * per-project presence fan-out. The unique index over `project_id IS NULL` is
 * the arbiter: a pre-check cannot be, since a concurrent register slips past it.
 */
export async function ensureSiteRunner(
  ctx: HostedDynamic,
  { name, labels, hash, actor }: { name: string; labels: string[]; hash: string; actor: HostedDynamic },
) {
  const id = ulid();
  return await ctx.db.withTx(async (tx: HostedDynamic) => {
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO runners (id, project_id, name, labels, credential_hash)
           VALUES ($1, NULL, $2, $3, $4) RETURNING *`,
        [id, name, labels, hash],
      ));
    } catch (e: HostedDynamic) {
      if (/UNIQUE constraint failed/.test(e.message)) return null;
      throw e;
    }
    await audit(tx, {
      actor,
      action: "runner.registered",
      entityType: "runner",
      entityId: id,
      projectId: null,
      detail: { name, labels, scope: "site" },
    });
    // Every project's console is looking at a list this machine now belongs to,
    // so the edge fans out to each of them (one event row per project).
    await emitRunnerStatus(tx, rows[0], { state: "registered", labels });
    return rows[0];
  });
}
