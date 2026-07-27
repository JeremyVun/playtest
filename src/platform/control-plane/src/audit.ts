// The append-only audit log. Every mutation writes exactly one row — who, what, which entity,
// and the before/after refs (snapshot ids, changed paths, hash transitions). Writes
// go through the SAME transaction as the mutation so a state change and its audit
// entry commit atomically (the outbox discipline); never call this outside a tx.
import { ulid } from "./ulid.ts";
import type { Tx } from "./db.ts";
import type { DynamicJson, Principal } from "./types.ts";

/**
 * Reduce an authenticated principal to the audit `actor` shape:
 * {user_id} | {token_id} | {system}.
 */
export function actorOf(principal: Principal | null | undefined): DynamicJson {
  if (!principal) return { system: "anonymous" };
  if (principal.kind === "token") return { token_id: principal.tokenId };
  if (principal.kind === "system") return { system: principal.system };
  return { user_id: principal.userId };
}

/**
 * Append an audit row inside an open transaction.
 * @param {{query: Function}} tx  a Db.withTx handle
 * @param {{ actor: object, action: string, entityType: string, entityId?: string|null,
 *           projectId?: string|null, detail?: object }} entry
 */
export async function audit(
  tx: Tx,
  { actor, action, entityType, entityId = null, projectId = null, detail = {} }: {
    actor: DynamicJson;
    action: string;
    entityType: string;
    entityId?: string | null;
    projectId?: string | null;
    detail?: DynamicJson;
  }
) {
  const id = ulid();
  await tx.query(
    `INSERT INTO audit_log (id, project_id, actor, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, projectId, actor, action, entityType, entityId, detail],
  );
  return id;
}
