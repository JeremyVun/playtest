import { ulid } from "../ulid.ts";
import type { Db, Tx } from "../db.ts";
import type { DynamicJson } from "../types.ts";

export async function emitPlatformEvent(
  q: Db | Tx,
  { projectId, type, entity, payload = {} }: {
    projectId: string;
    type: string;
    entity: DynamicJson;
    payload?: DynamicJson;
  }
) {
  const id = ulid();
  await q.query(
    `INSERT INTO platform_events (id, project_id, type, entity, payload)
       VALUES ($1, $2, $3, $4, $5)`,
    [id, projectId, type, entity, payload],
  );
  // Wake held long-polls, but only once the row is readable. `afterCommit`
  // defers to COMMIT inside a transaction (and fires nothing on rollback), which
  // is the guarantee `NOTIFY` used to give for free.
  const db: Db = q.db || q as Db;
  db.afterCommit?.(() => db.feedWaker?.notify(projectId));
  return id;
}
