// The hosted live endpoint (docs/contracts/interfaces.md#live-runs), mounted
// beside the run's entry routes:
//
//   GET /api/v1/projects/:p/view/run/<run_id>/<case_id>/live?after=<line>&wait=<s>
//
// It answers exactly the shape the local viewer host answers
// (packages/run-viewer/src/node/live.ts), because the viewer's live mode is
// host-agnostic: one protocol, two hosts. What differs is only where the truth
// lives — here the cursor counts ledger lines rather than file bytes, the
// manifest generation is the run row's own counter rather than a stat
// signature, `progress` is the stored snapshot the runner already posts, and a
// held request is woken by ingest through the process waker instead of by
// stat-polling a directory.
import { HttpResult } from "../http.ts";
import {
  LIVE_MAX_RESPONSE_BYTES,
  LIVE_MAX_RESPONSE_LINES,
  LIVE_MAX_WAIT_S,
  isRunOpen,
  liveWakeKey,
  readTrajectoryLines,
  trajectoryLineCount,
} from "../live/staging.ts";
import type { DbRow } from "../db.ts";

export interface LiveResponse {
  open: boolean;
  reset: boolean;
  next: number;
  has_more: boolean;
  lines: string[];
  manifest_generation: number;
  progress: unknown;
  inactive_ms: number;
}

/**
 * Answer one live request for an already-resolved run row. A sealed or
 * never-opened run answers `open: false` immediately; an open, caught-up caller
 * is held up to `wait` seconds.
 */
export async function liveAnswer(ctx: HostedDynamic, runDbId: string): Promise<HttpResult> {
  const after = Math.max(0, Math.trunc(Number(ctx.query.get("after")) || 0));
  const wait = Math.min(LIVE_MAX_WAIT_S, Math.max(0, Math.trunc(Number(ctx.query.get("wait")) || 0)));
  const first = await answer(ctx, runDbId, after);
  const body = first.open && !first.reset && !first.lines.length && wait > 0
    ? await hold(ctx, runDbId, after, wait, first)
    : first;
  // `no-store`, not `no-cache`: a long-poll answer is a moment in a stream, and
  // a validator on it would only buy a revalidation round trip per poll.
  return new HttpResult({
    buffer: Buffer.from(JSON.stringify(body)),
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
  });
}

/** One coherent snapshot: the run's openness, its line window, and its edge state. */
async function answer(ctx: HostedDynamic, runDbId: string, after: number): Promise<LiveResponse> {
  const { rows } = await ctx.db.query(
    `SELECT status, progress, live_opened_at, live_manifest_generation, live_activity_at
       FROM runs WHERE id = $1`,
    [runDbId],
  );
  const run: DbRow | undefined = rows[0];
  const generation = Number(run?.live_manifest_generation || 0);
  if (!run || !isRunOpen(run)) return terminal(generation);

  const total = await trajectoryLineCount(ctx.db, runDbId);
  const activity = run.live_activity_at || run.live_opened_at;
  const inactive = activity ? Math.max(0, Date.now() - new Date(activity).getTime()) : 0;
  // A cursor past the host's truth cannot be honored — the client is holding
  // state this run never produced. Say so rather than guessing.
  if (after > total) {
    return {
      open: true,
      reset: true,
      next: 0,
      has_more: false,
      lines: [],
      manifest_generation: generation,
      progress: run.progress ?? null,
      inactive_ms: inactive,
    };
  }
  const lines = await readTrajectoryLines(ctx.db, runDbId, {
    after,
    maxLines: LIVE_MAX_RESPONSE_LINES,
    maxBytes: LIVE_MAX_RESPONSE_BYTES,
  });
  return {
    open: true,
    reset: false,
    next: after + lines.length,
    has_more: after + lines.length < total,
    lines,
    manifest_generation: generation,
    progress: run.progress ?? null,
    inactive_ms: inactive,
  };
}

const terminal = (generation: number): LiveResponse => ({
  open: false,
  reset: false,
  next: 0,
  has_more: false,
  lines: [],
  manifest_generation: generation,
  progress: null,
  inactive_ms: 0,
});

/**
 * Hold a caught-up caller. Ingest wakes this run's key post-commit, and the 1 s
 * re-read is the correctness path rather than a backstop: a batch committed
 * between the first answer and the subscription wakes nobody, so the committed
 * rows always decide what the client sees.
 *
 * The hold ends on anything the viewer must repaint for — new lines, a seal, a
 * manifest rewrite, or a progress move — so a finished run transitions on the
 * next wake instead of after a full 25 s of no new trajectory line.
 */
async function hold(
  ctx: HostedDynamic,
  runDbId: string,
  after: number,
  wait: number,
  first: LiveResponse,
): Promise<LiveResponse> {
  const deadline = Date.now() + wait * 1000;
  const key = liveWakeKey(runDbId);
  const gone = () => ctx.req?.destroyed || ctx.res?.destroyed || ctx.res?.writableEnded;
  let latest = first;
  while (!gone()) {
    if (ctx.feedWaker && !ctx.feedWaker.connected) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (ctx.feedWaker) await ctx.feedWaker.wait(key, Math.min(remaining, 1000));
    else await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000)));
    if (gone()) break;
    latest = await answer(ctx, runDbId, after);
    if (moved(first, latest)) return latest;
  }
  return latest;
}

function moved(before: LiveResponse, after: LiveResponse): boolean {
  if (!after.open || after.reset || after.lines.length) return true;
  if (after.manifest_generation !== before.manifest_generation) return true;
  return JSON.stringify(after.progress ?? null) !== JSON.stringify(before.progress ?? null);
}
