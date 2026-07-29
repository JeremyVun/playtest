// The live ingest routes (docs/contracts/hosted.md "Live runs"). Three additions
// to the runner protocol, all behind the existing group-scoped runner token with
// the same run-group check the bundle PUT applies:
//
//   POST /runner/groups/:g/cases/:run_id/open   placeholder / manifest snapshot
//   PUT  /runner/runs/:r/live/<entry-path>      one staged step artifact
//   POST /runner/runs/:r/live/trajectory        { from_line, lines }
//
// Every answer is an explicit JSON ack — accepted, or refused with a reason the
// uploader acts on. A refusal is a normal answer, never a silent success and
// never an exception the queue has to guess about; and nothing here can change a
// run's status, ordering or sealed artifacts. Once a run is terminal every route
// is a no-op refusal.
import { badRequest, notFound } from "../errors.ts";
import { readJsonBody, readRawBody } from "../http.ts";
import { requireGroupExecutor, requireRunOwner } from "../auth/current-executor.ts";
import { canonicalJson } from "../db.ts";
import { ulid } from "../ulid.ts";
import {
  LIVE_ENTRY_LIMIT,
  LIVE_LINE_LIMIT,
  LIVE_MANIFEST_LIMIT,
  LIVE_MAX_BATCH_LINES,
  LIVE_TRAJECTORY_BODY_LIMIT,
  appendTrajectoryBatch,
  isStageableEntry,
  liveObjectKey,
  readTrajectoryLines,
  sha256Of,
  stagedBytes,
  trajectoryLineCount,
  wakeLive,
} from "../live/staging.ts";

/**
 * The refusal vocabulary. Each reason names one thing the uploader can do about
 * it: rewind, resend, stop shipping that entry, or stop streaming this run.
 */
type Refusal =
  | "terminal" // the run finished; staging is closed
  | "not_open" // no `open` call landed, so nothing is staged for this run
  | "shape" // the entry path or a line is not a shape this route stores
  | "immutable" // (run, entry) already holds different bytes
  | "budget" // the per-entry or per-run live budget is exhausted
  | "gap" // the batch would leave a hole; `lines` says where to rewind
  | "divergent" // the resent overlap does not match what is stored
  | "line_too_large"; // one line alone exceeds the route's line cap

const refused = (reason: Refusal, message: string, extra: Record<string, unknown> = {}) => ({
  accepted: false,
  reason,
  message,
  ...extra,
});

/**
 * POST /runner/groups/:g/cases/:run_id/open — open a run for live viewing, and
 * the manifest-snapshot route thereafter.
 *
 * Idempotent by construction: the body replaces the row-stored snapshot and
 * bumps `manifest_generation` only when the bytes actually changed, so a
 * repeated open is free and never churns a watching viewer. Setting
 * `live_opened_at` is the whole of "this run is open" — the status machine is
 * not touched.
 */
export async function openCase(ctx: HostedDynamic) {
  const runner = await requireGroupExecutor(ctx, { groupId: ctx.params.g });
  const group = runner.group;
  const run = requireRunOwner(
    runner,
    await one(
      ctx,
      `SELECT * FROM runs WHERE run_group_id = $1 AND run_id = $2`,
      [group.id, ctx.params.run_id],
      `no run "${ctx.params.run_id}" in this group`,
    ),
  );
  const body = await readJsonBody(ctx.req, { limit: LIVE_MANIFEST_LIMIT });
  const manifest = body.manifest && typeof body.manifest === "object" ? body.manifest : null;
  if (!manifest) throw badRequest(`"manifest" must be the run's manifest.json object`);

  let generation = 0;
  let opened = false;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `SELECT status, live_manifest, live_manifest_generation FROM runs WHERE id = $1`,
      [run.id],
    );
    const current = rows[0];
    if (!current || !OPENABLE.has(String(current.status))) return;
    const changed = canonicalJson(current.live_manifest) !== canonicalJson(manifest);
    generation = Number(current.live_manifest_generation || 0) + (changed ? 1 : 0);
    opened = true;
    await tx.query(
      `UPDATE runs
          SET live_opened_at = COALESCE(live_opened_at, now()),
              live_manifest = $2,
              live_manifest_generation = $3,
              live_activity_at = now()
        WHERE id = $1`,
      [run.id, manifest, generation],
    );
    wakeLive(tx, run.id);
  });
  if (!opened) return refused("terminal", `run "${run.run_id}" has already finished; live staging is closed`);
  return { accepted: true, open: true, manifest_generation: generation };
}

const OPENABLE = new Set(["queued", "running", "uploading"]);

/**
 * PUT /runner/runs/:r/live/<entry-path> — one staged step artifact, through the
 * two-phase ledger row that keeps the object owned at every instant:
 *
 *   1. reserve `pending` (budget charged, key and hash recorded) — committed;
 *   2. `store.put` the object;
 *   3. mark `ready` (the state readers serve).
 *
 * There is no window in which the object exists unowned, so the retention orphan
 * sweep — which deletes any `runs/`-prefixed object without an owning row in the
 * same cycle — can run mid-stream without touching staged bytes. A crash between
 * (1) and (3) leaves a `pending` row that GC reaps on the grace schedule, its
 * reservation refunded with it.
 *
 * `(run, entry)` is unique and immutable: an identical-bytes retry replays the
 * original ack without charging budget twice, and different bytes for a path
 * already staged are refused.
 */
export async function putLiveEntry(ctx: HostedDynamic) {
  const { run } = await runnerRun(ctx);
  const entry = String(ctx.params.entry || "");
  const closed = closedAck(run);
  if (closed) return closed;
  if (!isStageableEntry(entry)) {
    return refused("shape", `"${entry}" is not a step-artifact path; live staging accepts steps/<name> only`);
  }
  // Read a little past the cap so an oversized entry is answered with an ack the
  // uploader can act on rather than a transport-level refusal.
  const buf = await readRawBody(ctx.req, { limit: LIVE_ENTRY_LIMIT + 64 * 1024 });
  if (buf.length > LIVE_ENTRY_LIMIT) {
    return refused("budget", `"${entry}" is ${buf.length} bytes; a staged entry may be at most ${LIVE_ENTRY_LIMIT}`, {
      max_entry_bytes: LIVE_ENTRY_LIMIT,
    });
  }
  const sha256 = sha256Of(buf);
  const key = liveObjectKey(run, entry);
  const budget = ctx.config.live.runBudgetBytes;

  let outcome: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const fresh = await currentRun(tx, run.id);
    const stillClosed = closedAck(fresh);
    if (stillClosed) return void (outcome = stillClosed);
    const { rows } = await tx.query(`SELECT * FROM live_artifacts WHERE run_id = $1 AND entry = $2`, [run.id, entry]);
    const existing = rows[0];
    if (existing) {
      if (existing.sha256 !== sha256) {
        outcome = refused("immutable", `"${entry}" is already staged with different bytes; a staged entry never changes`, {
          entry,
          sha256: existing.sha256,
        });
        return;
      }
      // Same bytes: a retry. A `ready` row replays its ack for free; a `pending`
      // row is a crashed upload resuming, and its reservation already stands.
      outcome =
        existing.state === "ready"
          ? { accepted: true, duplicate: true, entry, size: Number(existing.size), sha256 }
          : { reserve: existing.key };
      return;
    }
    const used = await stagedBytes(tx, run.id);
    if (used + buf.length > budget) {
      outcome = refused("budget", `run "${run.run_id}" has staged ${used} of ${budget} live bytes; "${entry}" does not fit`, {
        entry,
        used_bytes: used,
        budget_bytes: budget,
      });
      return;
    }
    await tx.query(
      `INSERT INTO live_artifacts (id, run_id, entry, key, state, size, sha256)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [ulid(), run.id, entry, key, buf.length, sha256],
    );
    outcome = { reserve: key };
  });
  if (!outcome.reserve) return outcome;

  // Outside the transaction: the object store shares none of it, and a write
  // this size must never hold the single SQLite write connection.
  await ctx.store.put(outcome.reserve, buf);
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `UPDATE live_artifacts SET state = 'ready', size = $3, sha256 = $4, updated_at = now()
        WHERE run_id = $1 AND entry = $2`,
      [run.id, entry, buf.length, sha256],
    );
    await tx.query(`UPDATE runs SET live_activity_at = now() WHERE id = $1`, [run.id]);
    wakeLive(tx, run.id);
  });
  return { accepted: true, entry, size: buf.length, sha256 };
}

/**
 * POST /runner/runs/:r/live/trajectory — `{ from_line, lines }` against the
 * ledger's authoritative count, which every answer carries so the uploader can
 * always resynchronize from one response:
 *
 *   * `from_line === count` appends;
 *   * `from_line < count` is an overlapping resend — the overlapping prefix is
 *     VERIFIED against the stored lines (hash comparison) before being dropped,
 *     so a divergent retry is refused rather than silently merged, and only the
 *     new suffix is appended;
 *   * `from_line > count` would leave a gap and is refused, with `lines` naming
 *     the position to rewind to.
 */
export async function postLiveTrajectory(ctx: HostedDynamic) {
  const { run } = await runnerRun(ctx);
  const body = await readJsonBody(ctx.req, { limit: LIVE_TRAJECTORY_BODY_LIMIT });
  const fromLine = body.from_line;
  if (!Number.isSafeInteger(fromLine) || fromLine < 0) throw badRequest(`"from_line" must be a non-negative integer`);
  if (!Array.isArray(body.lines) || body.lines.some((l: unknown) => typeof l !== "string")) {
    throw badRequest(`"lines" must be an array of whole trajectory.jsonl lines`);
  }
  const lines: string[] = body.lines;
  if (lines.length > LIVE_MAX_BATCH_LINES) {
    throw badRequest(`"lines" carries ${lines.length} lines; at most ${LIVE_MAX_BATCH_LINES} per batch`);
  }

  const closed = closedAck(run);
  if (closed) return { ...closed, lines: await trajectoryLineCount(ctx.db, run.id) };
  for (const line of lines) {
    if (line.includes("\n")) {
      return { ...refused("shape", `a trajectory line may not contain a newline`), lines: await trajectoryLineCount(ctx.db, run.id) };
    }
    if (Buffer.byteLength(line, "utf8") > LIVE_LINE_LIMIT) {
      return {
        ...refused("line_too_large", `one line exceeds the ${LIVE_LINE_LIMIT}-byte line cap and cannot be staged`, {
          max_line_bytes: LIVE_LINE_LIMIT,
        }),
        lines: await trajectoryLineCount(ctx.db, run.id),
      };
    }
  }

  let outcome: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const fresh = await currentRun(tx, run.id);
    const count = await trajectoryLineCount(tx, run.id);
    const stillClosed = closedAck(fresh);
    if (stillClosed) return void (outcome = { ...stillClosed, lines: count });
    if (fromLine > count) {
      outcome = {
        ...refused("gap", `line ${fromLine} would leave a gap: ${count} lines are stored`, { from_line: fromLine }),
        lines: count,
      };
      return;
    }
    const overlap = count - fromLine;
    // Compare only what both sides actually hold: a resend that stops short of
    // the stored count is a duplicate, not a divergence.
    const compare = Math.min(overlap, lines.length);
    if (compare > 0) {
      const stored = await readTrajectoryLines(tx, run.id, {
        after: fromLine,
        maxLines: compare,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });
      const resent = lines.slice(0, compare);
      if (stored.length !== compare || sha256Of(stored.join("\n")) !== sha256Of(resent.join("\n"))) {
        outcome = {
          ...refused("divergent", `the resent lines from ${fromLine} do not match what is stored`, { from_line: fromLine }),
          lines: count,
        };
        return;
      }
    }
    const suffix = lines.slice(overlap);
    if (!suffix.length) {
      outcome = { accepted: true, lines: count, appended: 0 };
      return;
    }
    const bytes = suffix.reduce((n, line) => n + Buffer.byteLength(line, "utf8") + 1, 0);
    const used = await stagedBytes(tx, run.id);
    const budget = ctx.config.live.runBudgetBytes;
    if (used + bytes > budget) {
      outcome = {
        ...refused("budget", `run "${run.run_id}" has staged ${used} of ${budget} live bytes; the batch does not fit`, {
          used_bytes: used,
          budget_bytes: budget,
        }),
        lines: count,
      };
      return;
    }
    await appendTrajectoryBatch(tx, { runDbId: run.id, fromLine: count, lines: suffix });
    await tx.query(`UPDATE runs SET live_activity_at = now() WHERE id = $1`, [run.id]);
    wakeLive(tx, run.id);
    outcome = { accepted: true, lines: count + suffix.length, appended: suffix.length };
  });
  return outcome;
}

// ---------- shared guards ----------

/** The run this runner token may stage into — the bundle PUT's exact check. */
async function runnerRun(ctx: HostedDynamic) {
  const runner = await requireGroupExecutor(ctx);
  const run = requireRunOwner(runner, await one(ctx, `SELECT * FROM runs WHERE id = $1`, [ctx.params.r], `no run "${ctx.params.r}"`));
  return { runner, run };
}

/** The refusal a closed run answers with, or null while staging is open. */
function closedAck(run: HostedDynamic) {
  if (!OPENABLE.has(String(run.status))) {
    return refused("terminal", `run "${run.run_id}" has already finished; live staging is closed`);
  }
  if (run.live_opened_at == null) {
    return refused("not_open", `run "${run.run_id}" was never opened for live viewing; POST its open call first`);
  }
  return null;
}

async function currentRun(tx: HostedDynamic, runDbId: string) {
  const { rows } = await tx.query(`SELECT id, run_id, status, live_opened_at FROM runs WHERE id = $1`, [runDbId]);
  return rows[0] ?? { run_id: runDbId, status: "lost", live_opened_at: null };
}

async function one(ctx: HostedDynamic, sql: string, params: unknown[], message: string) {
  const { rows } = await ctx.db.query(sql, params);
  if (!rows[0]) throw notFound(message);
  return rows[0];
}
