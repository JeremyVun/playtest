import { emitPlatformEvent } from "./outbox.ts";
import type { Db, Tx } from "../db.ts";
import type { DynamicJson } from "../types.ts";

export async function appendRunEvent(
  q: Db | Tx,
  { runDbId, projectId, type, payload = {} }: {
    runDbId: string;
    projectId: string;
    type: string;
    payload?: DynamicJson;
  }
) {
  const { rows } = await q.query(
    `INSERT INTO run_events (run_id, seq, type, payload)
       VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM run_events WHERE run_id = $1), 1), $2, $3)
       RETURNING seq, ts, type, payload`,
    [runDbId, type, JSON.stringify(payload)],
  );
  await emitPlatformEvent(q, {
    projectId,
    type: "run.event",
    entity: { run_id: runDbId },
    payload: { seq: rows[0]!.seq, type, ...payload }, // SAFETY: INSERT ... RETURNING always produces exactly one row.
  });
  return rows[0];
}

export async function emitRunStatus(
  q: Db | Tx,
  { projectId, runGroupId, runDbId, status, payload = {} }: {
    projectId: string;
    runGroupId: string;
    runDbId: string;
    status: string;
    payload?: DynamicJson;
  }
) {
  return await emitPlatformEvent(q, {
    projectId,
    type: "run.status",
    entity: { run_group_id: runGroupId, run_id: runDbId },
    payload: { status, ...payload },
  });
}
