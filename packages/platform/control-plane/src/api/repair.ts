// Repair claims and finding notes (docs/contracts/hosted-findings.md,
// "Repair claims"). An external repair daemon asks which findings are
// repairable, leases one, heartbeats while it works, and releases with what it
// concluded. Playtest arbitrates and records; it dispatches nothing.
//
// The transitions themselves live in `findings/repair.ts` — each a single
// UPDATE whose WHERE restates the precondition. This module decides who is
// asking, and turns a lost race into an answer the daemon can act on.
import { audit, actorOf } from "../audit.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { created, readJsonBody } from "../http.ts";
import { publicFinding } from "../findings/extractor.ts";
import { ulid } from "../ulid.ts";
import {
  REPAIR_OUTCOMES,
  claimRepair,
  clampTtlSeconds,
  heartbeatIntervalSeconds,
  heartbeatRepair,
  heldByAnother,
  releaseRepair,
  resetRepairOutcome,
  type RepairOutcome,
} from "../findings/repair.ts";
import { guard, requireAuth, stringField } from "./util.ts";

const NOTE_MAX = 4096;

async function findingRow(q: HostedDynamic, id: HostedDynamic) {
  const { rows } = await q.query(`SELECT * FROM findings WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`no finding "${id}"`);
  return rows[0];
}

/**
 * Why this caller lost. Re-read inside the same transaction and name the fact
 * that made the write impossible, so a daemon can tell "someone else is on it"
 * (wait) from "this finding is done with repair" (move on).
 */
async function repairConflict(tx: HostedDynamic, findingId: HostedDynamic, owner: string) {
  const f = await findingRow(tx, findingId);
  const detail = { reason: "stale", owner: f.repair_owner ?? null, expires_at: f.repair_expires_at ?? null };
  if (f.merged_into) {
    return conflict(`finding "${f.id}" was merged into "${f.merged_into}"`, { ...detail, reason: "merged" });
  }
  if (heldByAnother(f, owner)) {
    return conflict(
      `finding "${f.id}" is already claimed by "${f.repair_owner}" until ${new Date(f.repair_expires_at).toISOString()}`,
      { ...detail, reason: "claimed" },
    );
  }
  if (f.repair_outcome !== "none") {
    return conflict(
      `finding "${f.id}" already concluded repair as "${f.repair_outcome}" — a reviewer must reset the outcome before it is repairable again`,
      { ...detail, reason: "outcome" },
    );
  }
  if (f.state !== "new" && f.state !== "reopened") {
    return conflict(`finding "${f.id}" is "${f.state}", and only new or reopened findings are repairable`, { ...detail, reason: "state" });
  }
  return conflict(
    `the repair claim on finding "${f.id}" is no longer yours: it expired, was released, or was re-claimed at a newer generation`,
    detail,
  );
}

function ownerField(body: HostedDynamic) {
  return stringField(body, "owner", { required: true, max: 200 }) as string;
}

function generationField(body: HostedDynamic) {
  const n = body.generation;
  if (!Number.isInteger(n) || n < 1) throw badRequest(`"generation" must be the integer this claim returned`);
  return n as number;
}

function claimView(f: HostedDynamic, ttlSeconds: number) {
  return {
    finding_id: f.id,
    owner: f.repair_owner,
    generation: f.repair_generation,
    expires_at: f.repair_expires_at,
    heartbeat_interval_s: heartbeatIntervalSeconds(ttlSeconds),
  };
}

/** POST /findings/:f/repair-claim {owner, ttl_s} [developer] */
export async function claimRepairSlot(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const current = await findingRow(ctx.db, ctx.params.f);
  guard(ctx, current.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  const owner = ownerField(body);
  const ttlSeconds = clampTtlSeconds(body.ttl_s);

  return await ctx.db.withTx(async (tx: HostedDynamic) => {
    const won = await claimRepair(tx, { findingId: current.id, owner, ttlSeconds });
    if (!won) throw await repairConflict(tx, current.id, owner);
    await audit(tx, {
      actor: actorOf(principal),
      action: "finding.repair_claimed",
      entityType: "finding",
      entityId: won.id,
      projectId: won.project_id,
      detail: { owner, generation: won.repair_generation, ttl_s: ttlSeconds },
    });
    return claimView(won, ttlSeconds);
  });
}

/** POST /findings/:f/repair-claim/heartbeat {owner, generation, ttl_s} [developer] */
export async function heartbeatRepairSlot(ctx: HostedDynamic) {
  requireAuth(ctx);
  const current = await findingRow(ctx.db, ctx.params.f);
  guard(ctx, current.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  const owner = ownerField(body);
  const generation = generationField(body);
  const ttlSeconds = clampTtlSeconds(body.ttl_s);

  return await ctx.db.withTx(async (tx: HostedDynamic) => {
    const beat = await heartbeatRepair(tx, { findingId: current.id, owner, generation, ttlSeconds });
    if (!beat) throw await repairConflict(tx, current.id, owner);
    return { generation: beat.repair_generation, expires_at: beat.repair_expires_at };
  });
}

/** POST /findings/:f/repair-claim/release {owner, generation, outcome, external_ref?, note?} [developer] */
export async function releaseRepairSlot(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const current = await findingRow(ctx.db, ctx.params.f);
  guard(ctx, current.project_id, "developer");
  const body = await readJsonBody(ctx.req);
  const owner = ownerField(body);
  const generation = generationField(body);
  const outcome = body.outcome as RepairOutcome;
  if (!REPAIR_OUTCOMES.includes(outcome)) {
    throw badRequest(`"outcome" must be ${REPAIR_OUTCOMES.join(", ")}`);
  }
  const externalRef = stringField(body, "external_ref", { max: 500 });
  // A suggestion without a link is unreviewable, and it is the link that makes
  // auto-resolution suggest rather than resolve.
  if (outcome === "suggested" && !externalRef) {
    throw badRequest(`"external_ref" is required when releasing a repair claim as "suggested": name the pull request`);
  }
  const noteText = stringField(body, "note", { max: NOTE_MAX });

  return await ctx.db.withTx(async (tx: HostedDynamic) => {
    const next = await releaseRepair(tx, { findingId: current.id, owner, generation, outcome, externalRef });
    if (!next) throw await repairConflict(tx, current.id, owner);
    if (noteText) await insertNote(tx, { findingId: next.id, source: "repair", text: noteText });
    const payload: HostedDynamic = {
      finding_id: next.id,
      owner,
      generation,
      outcome,
      source: "repair",
    };
    if (externalRef) payload.external_ref = externalRef;
    await audit(tx, {
      actor: actorOf(principal),
      action: "finding.repair_released",
      entityType: "finding",
      entityId: next.id,
      projectId: next.project_id,
      detail: payload,
    });
    await emitPlatformEvent(tx, {
      projectId: next.project_id,
      type: outcome === "suggested" ? "finding.repair_suggested" : "finding.repair_released",
      entity: { finding_id: next.id },
      payload,
    });
    return { finding: publicFinding(next) };
  });
}

/** POST /findings/:f/repair-outcome/reset [reviewer] */
export async function resetRepairOutcomeRoute(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const current = await findingRow(ctx.db, ctx.params.f);
  guard(ctx, current.project_id, "reviewer");

  return await ctx.db.withTx(async (tx: HostedDynamic) => {
    const next = await resetRepairOutcome(tx, current.id);
    if (!next) {
      const f = await findingRow(tx, current.id);
      throw conflict(`finding "${f.id}" was merged into "${f.merged_into}"`, { reason: "merged" });
    }
    await audit(tx, {
      actor: actorOf(principal),
      action: "finding.repair_reset",
      entityType: "finding",
      entityId: next.id,
      projectId: next.project_id,
      detail: { from: current.repair_outcome },
    });
    await emitPlatformEvent(tx, {
      projectId: next.project_id,
      type: "finding.repair_reset",
      entity: { finding_id: next.id },
      payload: { finding_id: next.id, from: current.repair_outcome, actor: actorOf(principal) },
    });
    return { finding: publicFinding(next) };
  });
}

export async function insertNote(tx: HostedDynamic, { findingId, source, text }: HostedDynamic) {
  const { rows } = await tx.query(
    `INSERT INTO finding_notes (id, finding_id, source, text) VALUES ($1, $2, $3, $4) RETURNING *`,
    [ulid(), findingId, source, text],
  );
  return rows[0];
}

/** POST /findings/:f/notes {text, source} [editor] */
export async function addFindingNote(ctx: HostedDynamic) {
  const principal = requireAuth(ctx);
  const current = await findingRow(ctx.db, ctx.params.f);
  guard(ctx, current.project_id, "editor");
  if (current.merged_into) throw conflict(`finding "${current.id}" was merged into "${current.merged_into}"`);
  const body = await readJsonBody(ctx.req);
  const text = stringField(body, "text", { required: true, max: NOTE_MAX }) as string;
  const source = stringField(body, "source", { required: true, max: 100 }) as string;

  const note = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const row = await insertNote(tx, { findingId: current.id, source, text });
    await audit(tx, {
      actor: actorOf(principal),
      action: "finding.note_added",
      entityType: "finding",
      entityId: current.id,
      projectId: current.project_id,
      detail: { note_id: row.id, source },
    });
    await emitPlatformEvent(tx, {
      projectId: current.project_id,
      type: "finding.note_added",
      entity: { finding_id: current.id },
      payload: { finding_id: current.id, note: publicNote(row), actor: actorOf(principal) },
    });
    return row;
  });
  return created({ note: publicNote(note) });
}

export function publicNote(n: HostedDynamic) {
  return { id: n.id, finding_id: n.finding_id, source: n.source, text: n.text, created_at: n.created_at };
}
