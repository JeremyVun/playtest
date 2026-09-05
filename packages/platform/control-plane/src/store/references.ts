import { createHash } from "node:crypto";
import type { Db, Tx } from "../db.ts";
import type { AppContext } from "../types.ts";
import { lifecycle } from "./lifecycle.ts";

export async function objectReferences(q: Db | Tx): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const { key } of (await q.query(`SELECT key FROM artifacts UNION SELECT key FROM live_artifacts UNION SELECT split_part(trajectory_key, '#', 1) AS key FROM baselines WHERE trajectory_key IS NOT NULL UNION SELECT split_part(trajectory_key, '#', 1) AS key FROM candidates WHERE trajectory_key IS NOT NULL`)).rows) if (key) keys.add(key);
  for (const { tree } of (await q.query("SELECT tree FROM suite_snapshots")).rows) for (const sha of Object.values(tree || {})) keys.add(`blobs/${sha}`);
  for (const { blob_sha256 } of (await q.query("SELECT blob_sha256 FROM personas")).rows) keys.add(`blobs/${blob_sha256}`);
  for (const { content } of (await q.query("SELECT content FROM suite_files")).rows) keys.add(`blobs/${createHash("sha256").update(content).digest("hex")}`);
  return keys;
}

export async function collectObjects(ctx: AppContext, { now = new Date(), graceMs = 86_400_000, limit = 1000 }: { now?: Date; graceMs?: number; limit?: number } = {}) {
  return lifecycle(ctx).delete(async () => {
    const referenced = await objectReferences(ctx.db);
    const summary = { blobs: 0, runs: 0 };
    for (const prefix of ["blobs/", "runs/"]) {
      for await (const page of ctx.store.listPages(prefix)) {
        for (const object of page) {
          if (referenced.has(object.key) || object.lastModified.getTime() > now.getTime() - graceMs) continue;
          await ctx.store.delete(object.key);
          if (prefix === "blobs/") summary.blobs++; else summary.runs++;
          if (summary.blobs + summary.runs >= limit) return summary;
        }
      }
    }
    return summary;
  });
}
