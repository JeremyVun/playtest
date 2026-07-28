// Open-run staging: the shared vocabulary of the live path
// (docs/contracts/hosted.md "Live runs").
//
// Ingest (api/live-ingest.ts), serving (api/viewer-adapter.ts and
// api/live-view.ts), the seal (api/executor-api.ts) and the retention GC
// (retention/worker.ts) all read openness, budgets, entry-path shape and the
// ledger through this one module, so none of them can drift from another.
//
// Everything here is transient serving state. The sealed `.ptrun` and the case
// report are untouched by it, and no live failure may change a run's status,
// ordering, or sealed artifacts.
import { createHash } from "node:crypto";
import { ulid } from "../ulid.ts";
import type { Db, DbRow, Tx } from "../db.ts";

type QueryTarget = Db | Tx;

/** The non-terminal run statuses. A run is open only while it is in one. */
export const OPEN_STATUSES = new Set(["queued", "running", "uploading"]);

/**
 * Openness is explicit state, never inferred from manifest contents: the
 * placeholder manifest carries a terminal-looking status from the first instant
 * of a case. A run is open from the `open` call until its case report lands (or
 * the reconciler fails it).
 */
export function isRunOpen(run: { live_opened_at?: unknown; status?: unknown }): boolean {
  return run.live_opened_at != null && OPEN_STATUSES.has(String(run.status));
}

// ---------- limits ----------

/**
 * The sealed-bundle upload ceiling (the bundle PUT's own cap, which lives here
 * so the two cannot drift). It is also the ceiling on the per-run live budget:
 * staging must never cost more than the bundle it precedes.
 */
export const BUNDLE_LIMIT = 512 * 1024 * 1024;

/** One staged step artifact. A step still is ~100 KiB; 16 MiB is generous. */
export const LIVE_ENTRY_LIMIT = 16 * 1024 * 1024;

/**
 * The trajectory route's explicit body cap, set comfortably above the practical
 * envelope maximum (envelopes are bounded — axe caps at 25 violations with
 * capped HTML). The uploader batches by bytes under it.
 */
export const LIVE_TRAJECTORY_BODY_LIMIT = 8 * 1024 * 1024;

/**
 * The largest single trajectory line the route will store. Deliberately half
 * the body cap so a pathological line arrives inside the body limit and is
 * answered with an explicit `line_too_large` ack rather than a transport error.
 */
export const LIVE_LINE_LIMIT = 4 * 1024 * 1024;

/** Batch shape bound: a tick ships completed steps, never thousands of lines. */
export const LIVE_MAX_BATCH_LINES = 2000;

/** The placeholder manifest is one small JSON document; anything bigger is a bug. */
export const LIVE_MANIFEST_LIMIT = 1024 * 1024;

/** Response caps for the live endpoint, matching the local viewer host. */
export const LIVE_MAX_RESPONSE_LINES = 500;
export const LIVE_MAX_RESPONSE_BYTES = 512 * 1024;

/** Hold bound, matching the platform's feed long-poll. */
export const LIVE_MAX_WAIT_S = 25;

// ---------- entry paths ----------

// Step artifacts only (docs/contracts/artifacts.md): steps/NNN.png plus the
// profile-dependent siblings steps/NNN.a11y.txt, steps/NNN.mhtml and
// steps/NNN.pw-a11y.txt. manifest.json and trajectory.jsonl are virtual entries
// served from rows, and end-of-run artifacts (video, HAR, grade) stay
// end-of-run, so nothing else is stageable.
const ENTRY_SHAPE = /^steps\/[0-9A-Za-z][0-9A-Za-z._-]{0,119}$/;

/**
 * Is `entry` a stageable step-artifact path? Traversal, absolute paths, nested
 * directories and dot-files all fail the shape rather than being sanitized —
 * a refusal the uploader can act on beats a silently rewritten key.
 */
export function isStageableEntry(entry: string): boolean {
  if (typeof entry !== "string" || !ENTRY_SHAPE.test(entry)) return false;
  return !entry.split("/").some((seg) => seg === "." || seg === "..");
}

/**
 * The staged object's key. Under `runs/` like every other run object, so the
 * retention orphan sweep sees it — and is kept apart from the sealed bundle's
 * own key so neither can ever collide with the other.
 */
export function liveObjectKey(run: DbRow, entry: string): string {
  return `runs/${run.run_group_id}/live/${run.id}/${entry}`;
}

export const sha256Of = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

// ---------- budget ----------

/**
 * Bytes this run has staged: trajectory text plus every artifact reservation,
 * `pending` included. A reservation is charged from the moment it is recorded
 * and refunded only when its row goes away, so a crashed upload cannot leak
 * budget silently and cannot be double-charged by a retry either.
 */
export async function stagedBytes(q: QueryTarget, runDbId: string): Promise<number> {
  const { rows } = await q.query(
    `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM live_trajectory WHERE run_id = $1)
          + (SELECT COALESCE(SUM(size), 0) FROM live_artifacts WHERE run_id = $1) AS used`,
    [runDbId],
  );
  return Number(rows[0]?.used || 0);
}

// ---------- the trajectory ledger ----------

/**
 * The authoritative stored line count. Batches are contiguous from line 0 by
 * construction (a gap is refused, an overlap is verified and deduplicated), so
 * the end of the last batch is the count.
 */
export async function trajectoryLineCount(q: QueryTarget, runDbId: string): Promise<number> {
  const { rows } = await q.query(
    `SELECT COALESCE(MAX(from_line + line_count), 0) AS n FROM live_trajectory WHERE run_id = $1`,
    [runDbId],
  );
  return Number(rows[0]?.n || 0);
}

/** Split a stored batch back into its whole lines (each was newline-terminated). */
function batchLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Whole trajectory lines from `after` onward, capped by count and bytes. One
 * indexed query: the ledger is ordered by line range, so the window is a scan
 * over the batches that overlap it.
 */
export async function readTrajectoryLines(
  q: QueryTarget,
  runDbId: string,
  { after, maxLines, maxBytes }: { after: number; maxLines: number; maxBytes: number },
): Promise<string[]> {
  const { rows } = await q.query(
    `SELECT from_line, line_count, text FROM live_trajectory
      WHERE run_id = $1 AND from_line + line_count > $2
      ORDER BY from_line`,
    [runDbId, after],
  );
  const out: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const lines = batchLines(row.text);
    const skip = Math.max(0, after - Number(row.from_line));
    for (let i = skip; i < lines.length; i++) {
      const line = lines[i] as string; // SAFETY: the loop bound is the array length
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (out.length >= maxLines) return out;
      // A single line over the cap still ships alone: holding it back would
      // stall the cursor forever.
      if (out.length && bytes + size > maxBytes) return out;
      out.push(line);
      bytes += size;
    }
  }
  return out;
}

/** The whole staged trajectory, in append order — the virtual `trajectory.jsonl`. */
export async function readTrajectoryText(q: QueryTarget, runDbId: string): Promise<string> {
  const { rows } = await q.query(
    `SELECT text FROM live_trajectory WHERE run_id = $1 ORDER BY from_line`,
    [runDbId],
  );
  return rows.map((r: DbRow) => r.text).join("");
}

/** Append one verified batch. The caller owns the transaction and the checks. */
export async function appendTrajectoryBatch(
  tx: Tx,
  { runDbId, fromLine, lines }: { runDbId: string; fromLine: number; lines: string[] },
): Promise<void> {
  const text = `${lines.join("\n")}\n`;
  await tx.query(
    `INSERT INTO live_trajectory (id, run_id, from_line, line_count, bytes, text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [ulid(), runDbId, fromLine, lines.length, Buffer.byteLength(text, "utf8"), text],
  );
}

// ---------- serving ----------

/** A staged step artifact ready to serve, or null while it is still `pending`. */
export async function readyArtifact(q: QueryTarget, runDbId: string, entry: string): Promise<DbRow | null> {
  const { rows } = await q.query(
    `SELECT * FROM live_artifacts WHERE run_id = $1 AND entry = $2 AND state = 'ready'`,
    [runDbId, entry],
  );
  return rows[0] ?? null;
}

// ---------- cleanup ----------

/**
 * Drop every ledger row for a run and return the object keys it owned. The
 * caller deletes those objects AFTER the transaction commits — SQLite and the
 * object store share no transaction, and the safe order is unambiguous: while
 * the row exists the object is owned, and once the row is gone the object is
 * the orphan sweep's problem. That is the backstop, not the primary path.
 */
export async function dropStaging(tx: Tx, runDbId: string): Promise<string[]> {
  const { rows } = await tx.query(`SELECT key FROM live_artifacts WHERE run_id = $1`, [runDbId]);
  await tx.query(`DELETE FROM live_artifacts WHERE run_id = $1`, [runDbId]);
  await tx.query(`DELETE FROM live_trajectory WHERE run_id = $1`, [runDbId]);
  await tx.query(`UPDATE runs SET live_manifest = NULL WHERE id = $1`, [runDbId]);
  return rows.map((r: DbRow) => String(r.key));
}

// ---------- wakeups ----------

/**
 * Live holders wait on their own key in the process-wide waker the event feed
 * already uses. It is a string-keyed accelerator, not a feed-specific object,
 * and the `live:` prefix keeps run keys and project keys from ever colliding.
 * Correctness stays with the committed rows: a held poll re-reads them once a
 * second regardless of whether any signal arrives.
 */
export const liveWakeKey = (runDbId: string) => `live:${runDbId}`;

/** Wake this run's live holders once the enclosing transaction commits. */
export function wakeLive(q: QueryTarget, runDbId: string): void {
  const db: Db = (q as Tx).db || (q as Db);
  db.afterCommit?.(() => db.feedWaker?.notify(liveWakeKey(runDbId)));
}
