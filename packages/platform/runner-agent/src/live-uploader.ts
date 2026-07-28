// The live uploader (docs/contracts/hosted.md "Live staging routes").
//
// One serialized, single-flight queue per case, ticking beside the progress
// reporter at the same ~2 s coalescing floor. Each tick ships, in run-dir order:
//
//   1. the step artifacts the new trajectory lines reference,
//   2. the trajectory delta — only lines whose artifacts are acknowledged,
//   3. a manifest re-POST (`open` doubles as the snapshot route) if the runner
//      rewrote manifest.json.
//
// Two disciplines hold the whole thing together:
//
// *Ordering is reliable.* Nothing is ever in flight concurrently, so nothing can
// complete out of order, and a line is sent only after every artifact it names
// has been acked — the engine's own "no envelope may advertise a file that is
// not yet on disk" invariant, preserved across the wire. Acks drive the queue:
// an accepted batch advances to the server's authoritative count, a `gap` or
// `divergent` refusal rewinds to it, a transport failure pauses and the next
// tick retries from the same position (the routes deduplicate a verified
// overlap, so a retry is free).
//
// *Indifference lives at the case boundary.* No ack, refusal, or unreachable
// control plane may change the recording, its timing, its status, or its sealed
// artifacts. When the stream cannot continue honestly — the run's live budget is
// exhausted, a line alone exceeds the route's cap, an entry is refused for a
// reason no retry can fix, or the queue has fallen hopelessly behind — the
// uploader stops ITSELF and the case never notices. The seal carries everything
// regardless; nothing is ever truncated and no skip marker is invented.
//
// Memory is bounded by construction: the queue holds byte offsets into
// trajectory.jsonl and the entry names still to ship, never the run directory.
// The only bytes resident are the batch currently being sent.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { translatePaths } from "./case-runner.ts";

/** The coalescing floor, shared with the progress reporter (exec-group.ts). */
const TICK_MS = 2000;

/**
 * A trajectory line's `artifacts` values are shipped only when they look like a
 * step-artifact path — the same shape the staging route accepts, applied here so
 * a `har_entries` index list or a future artifact kind is skipped silently
 * instead of earning a refusal.
 */
const ENTRY_SHAPE = /^steps\/[0-9A-Za-z][0-9A-Za-z._-]{0,119}$/;

/**
 * Route caps, defaulted to the control plane's own constants. A deployment
 * advertises its real numbers under `uploads.live` in the group spec, so batch
 * sizing follows the deployment rather than a constant compiled in here.
 */
const DEFAULT_CAPS = {
  max_manifest_bytes: 1024 * 1024,
  max_entry_bytes: 16 * 1024 * 1024,
  max_body_bytes: 8 * 1024 * 1024,
  max_line_bytes: 4 * 1024 * 1024,
  max_batch_lines: 2000,
};

/**
 * How far the queue may fall behind before it drops itself. Being behind is
 * normal (a tick ships what a tick can); being this far behind means the stream
 * will never catch up inside the case, and a preview nobody can use is not worth
 * the reads.
 */
const BEHIND_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Start a live uploader for one case. Returns the `onEvent` listener to hand the
 * engine beside the progress reporter's, and the `stop()` the case scheduler
 * calls in its `finally`.
 *
 * `containerRoot` is set only in container isolation: streamed engine events
 * carry container paths (`/ws/...`) because only the final result is translated
 * back, so the run dir the uploader reads is translated the same way here.
 */
export function liveUploader(
  api: RunnerDynamic,
  {
    groupId,
    runId,
    runDbId,
    live = null,
    workspaceRoot = null,
    containerRoot = null,
  }: RunnerDynamic,
  { intervalMs = TICK_MS }: RunnerDynamic = {},
): RunnerDynamic {
  const caps = { ...DEFAULT_CAPS, ...positiveNumbers(live) };
  const routes = {
    open: apiPath(live?.open_url_template, { run_group_id: groupId, run_id: runId }, `/runner/groups/${groupId}/cases/${runId}/open`),
    trajectory: apiPath(live?.trajectory_url_template, { run_db_id: runDbId }, `/runner/runs/${runDbId}/live/trajectory`),
    entry: (entry: string) =>
      apiPath(live?.entry_url_template, { run_db_id: runDbId, entry }, `/runner/runs/${runDbId}/live/${entry}`),
  };
  // A JSON body escapes the lines it carries, so half the route's body cap is
  // the margin raw line bytes are sized against.
  const batchByteCap = Math.max(1, Math.floor(caps.max_body_bytes / 2) - 1024);
  // Big enough that a line still holding no newline at this length is provably
  // over the route's line cap, rather than merely mid-write.
  const scanChunk = caps.max_line_bytes + 64 * 1024;

  let runDir: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let stopped = false;
  let stopReason: string | null = null;
  let opened = false;

  // Trajectory queue state. `lineOffsets[i]` is the byte offset of line `i`;
  // its last element is the end of the last whole line scanned, which is where
  // the next read starts. Keeping the whole index (a number per line) is what
  // makes a rewind a re-read rather than a buffered backlog.
  const lineOffsets: number[] = [0];
  /** Entries a not-yet-acked line references, dropped as its line is acked. */
  const lineEntries = new Map<number, string[]>();
  const stagedEntries = new Set<string>();
  let sentLines = 0;
  let divergences = 0;
  let manifestStamp = "";

  const trajectoryFile = () => path.join(String(runDir), "trajectory.jsonl");
  const manifestFile = () => path.join(String(runDir), "manifest.json");

  function selfStop(reason: string): void {
    stopReason ??= reason;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    lineEntries.clear();
  }

  /**
   * One request, single-flight and abortable, through the runner's own client.
   * A 4xx that is not a retry hint is the control plane saying this runner will
   * never be able to stage here — an older deployment without the live routes,
   * or a token that is not scoped to this run — so the uploader stops itself
   * rather than retrying for the length of the case.
   */
  async function call(fn: (signal: AbortSignal) => Promise<RunnerDynamic>): Promise<RunnerDynamic> {
    controller = new AbortController();
    try {
      return await fn(controller.signal);
    } catch (e: RunnerDynamic) {
      const status = Number(e?.status);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) selfStop(`http_${status}`);
      throw e;
    } finally {
      controller = null;
    }
  }

  /**
   * The refusal an ack carries, or null when it was accepted. The vocabulary is
   * `terminal`, `not_open`, `shape`, `immutable`, `budget`, `gap`, `divergent`
   * and `line_too_large` (docs/contracts/hosted.md); only the trajectory route's
   * `gap` and `divergent` are recoverable by resending, so every caller but
   * `shipTrajectory` treats a refusal as the end of this run's stream.
   */
  function refusal(ack: RunnerDynamic): string | null {
    if (ack && ack.accepted === false) return String(ack.reason || "refused");
    return null;
  }

  // ---------- opening ----------

  /**
   * Openness waits for MANIFEST READINESS, not `case_start`: the event precedes
   * the placeholder write, so the uploader stats the run dir the event named and
   * opens the instant a readable placeholder is there.
   */
  async function openIfReady(): Promise<boolean> {
    const snapshot = readManifest();
    if (!snapshot) return false;
    const ack = await call((signal) => api.json("POST", routes.open, { manifest: snapshot.manifest }, { signal }));
    const reason = refusal(ack);
    if (reason) {
      selfStop(reason);
      return false;
    }
    opened = true;
    manifestStamp = snapshot.stamp;
    return true;
  }

  /** The manifest as it stands, or null while it is absent, oversized, or mid-write. */
  function readManifest(): { manifest: RunnerDynamic; stamp: string } | null {
    let stat;
    try {
      stat = fs.statSync(manifestFile());
    } catch {
      return null; // not written yet — the placeholder follows `case_start`
    }
    if (stat.size > caps.max_manifest_bytes) return null;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
      if (!manifest || typeof manifest !== "object") return null;
      return { manifest, stamp: `${stat.size}:${stat.mtimeMs}` };
    } catch {
      return null; // a torn read of a whole-file rewrite: try again next tick
    }
  }

  // ---------- discovery ----------

  /** Index the whole lines that appeared since the last scan; buffer none of them. */
  async function scanTrajectory(): Promise<void> {
    let size: number;
    try {
      size = fs.statSync(trajectoryFile()).size;
    } catch {
      return; // the first envelope has not landed
    }
    const scanned = lineOffsets[lineOffsets.length - 1] as number; // SAFETY: seeded with 0
    if (size <= scanned) return;
    const want = Math.min(size - scanned, scanChunk);
    const buf = await readRange(trajectoryFile(), scanned, want);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) {
      // No line terminator in a window wider than the route's line cap: the line
      // being written is already too large to stage, whatever else follows it.
      if (buf.length >= scanChunk) selfStop("line_too_large");
      return;
    }
    let start = 0;
    for (let i = 0; i <= lastNl; i++) {
      if (buf[i] !== 0x0a) continue;
      if (i - start > caps.max_line_bytes) {
        selfStop("line_too_large");
        return;
      }
      const index = lineOffsets.length - 1;
      lineOffsets.push(scanned + i + 1);
      const refs = artifactRefs(buf.toString("utf8", start, i));
      if (refs.length) lineEntries.set(index, refs);
      start = i + 1;
    }
  }

  // ---------- shipping ----------

  /** Every artifact the queued lines name, in line order, one request at a time. */
  async function shipArtifacts(): Promise<void> {
    const known = lineOffsets.length - 1;
    for (let index = sentLines; index < known && !stopped; index++) {
      for (const entry of lineEntries.get(index) || []) {
        if (stagedEntries.has(entry)) continue;
        let bytes: Buffer;
        try {
          bytes = await fsp.readFile(path.join(String(runDir), entry));
        } catch {
          // The engine writes artifacts before the line naming them, so this is
          // a profile that never wrote the file (or a workspace already going
          // away). Leave the line queued; a later tick decides.
          return;
        }
        const ack = await call((signal) => api.putBytes(routes.entry(entry), bytes, "application/octet-stream", { signal }));
        const reason = refusal(ack);
        if (reason) {
          selfStop(reason);
          return;
        }
        stagedEntries.add(entry);
      }
    }
  }

  /** One byte-sized batch of lines whose artifacts are all acknowledged. */
  async function shipTrajectory(): Promise<void> {
    const known = lineOffsets.length - 1;
    if (sentLines >= known) return;
    let ready = sentLines;
    while (ready < known && (lineEntries.get(ready) || []).every((e) => stagedEntries.has(e))) ready++;
    if (ready === sentLines) return;

    const from = lineOffsets[sentLines] as number; // SAFETY: sentLines < known
    let end = sentLines;
    while (
      end < ready &&
      end - sentLines < caps.max_batch_lines &&
      ((lineOffsets[end + 1] as number) - from <= batchByteCap || end === sentLines)
    ) {
      end++;
    }
    const upto = lineOffsets[end] as number; // SAFETY: end <= ready <= known
    const buf = await readRange(trajectoryFile(), from, upto - from);
    const lines = buf.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    const ack = await call((signal) =>
      api.json("POST", routes.trajectory, { from_line: sentLines, lines }, { signal }),
    );
    const reason = refusal(ack);
    if (!reason) {
      advanceTo(Number(ack?.lines ?? sentLines + lines.length));
      divergences = 0;
      return;
    }
    if (reason === "gap") {
      // The answered count is the truth: rewind to it and resend from there.
      advanceTo(Number(ack.lines ?? 0));
      return;
    }
    if (reason === "divergent") {
      // Resync once from the authoritative count. A second divergence means the
      // two sides cannot be reconciled by resending, so stop rather than loop.
      if (++divergences > 1) return selfStop("divergent");
      advanceTo(Number(ack.lines ?? 0));
      return;
    }
    selfStop(reason);
  }

  /** Move the cursor to the server's count and forget what is behind it. */
  function advanceTo(count: number): void {
    const next = Math.max(0, Math.min(count, lineOffsets.length - 1));
    for (const index of [...lineEntries.keys()]) if (index < next) lineEntries.delete(index);
    sentLines = next;
  }

  /** A rewritten manifest replaces the row-stored copy; `open` is that route. */
  async function shipManifest(): Promise<void> {
    const snapshot = readManifest();
    if (!snapshot || snapshot.stamp === manifestStamp) return;
    const ack = await call((signal) => api.json("POST", routes.open, { manifest: snapshot.manifest }, { signal }));
    const reason = refusal(ack);
    if (reason) return selfStop(reason);
    manifestStamp = snapshot.stamp;
  }

  // ---------- the tick ----------

  async function tick(): Promise<void> {
    if (stopped || !runDir) return;
    try {
      if (!opened && !(await openIfReady())) return;
      if (stopped) return;
      await scanTrajectory();
      if (stopped) return;
      if ((lineOffsets[lineOffsets.length - 1] as number) - (lineOffsets[sentLines] as number) > BEHIND_LIMIT_BYTES) {
        return selfStop("behind");
      }
      await shipArtifacts();
      if (stopped) return;
      await shipTrajectory();
      if (stopped) return;
      await shipManifest();
    } catch {
      // Transport failure (or an abort at stop): pause here and let the next
      // tick retry from exactly this position. The routes deduplicate a verified
      // overlap, so a retry costs nothing and can never reorder anything.
    }
  }

  function schedule(): void {
    if (stopped || timer) return;
    timer = setTimeout(fire, intervalMs);
    // The uploader is telemetry: it must never be the reason a runner process
    // stays alive.
    timer.unref?.();
  }

  function fire(): void {
    timer = null;
    inFlight = tick().finally(() => {
      inFlight = null;
      schedule();
    });
  }

  return {
    /**
     * `case_start` carries the run dir; everything else is the disk's business.
     * A throw here would reach the engine's emit, so nothing throws.
     */
    onEvent(ev: RunnerDynamic): void {
      try {
        if (stopped || runDir || ev?.type !== "case_start" || typeof ev.runDir !== "string") return;
        runDir = containerRoot && workspaceRoot ? translatePaths(ev.runDir, containerRoot, workspaceRoot) : ev.runDir;
        schedule();
      } catch {
        /* live state is never load-bearing for the case */
      }
    },

    /**
     * Shutdown, owned by the case scheduler: clear the tick timer, abort any
     * in-flight request, drop the queue. Awaiting the settled tick is what keeps
     * a background read from racing the workspace teardown that follows; the
     * abort is what keeps that await from delaying the case report.
     */
    async stop(): Promise<void> {
      selfStop("stopped");
      try {
        controller?.abort();
      } catch {
        /* an already-settled request */
      }
      await inFlight?.catch(() => {});
    },

    /** Queue state, for tests and for reading a stalled stream in a log. */
    state: () => ({ opened, sentLines, stopped, reason: stopReason, staged: stagedEntries.size, runDir }),
  };
}

// ---------- helpers ----------

/** The step-artifact paths one trajectory line advertises, in envelope order. */
export function artifactRefs(line: string): string[] {
  let envelope: RunnerDynamic;
  try {
    envelope = JSON.parse(line);
  } catch {
    return []; // not an envelope; it still ships, it just names nothing
  }
  const artifacts = envelope?.artifacts;
  if (!artifacts || typeof artifacts !== "object") return [];
  const out: string[] = [];
  for (const value of Object.values(artifacts)) {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (typeof candidate === "string" && ENTRY_SHAPE.test(candidate) && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * The API path for an advertised URL template.
 *
 * The deployment owns the route SHAPE, so the template is what fills in the
 * variables — but its origin is `publicUrl`, which is not necessarily the origin
 * this runner was pointed at (a proxy, a tunnel, a test server on an ephemeral
 * port). So only the path survives, and it travels through the same client that
 * every other runner call uses. An unusable template falls back to the route as
 * this runner knows it, which is also what happens against a control plane whose
 * spec predates `uploads.live`.
 */
export function apiPath(template: unknown, vars: Record<string, string>, fallback: string): string {
  if (typeof template !== "string" || !template) return fallback;
  let filled = template;
  for (const [key, value] of Object.entries(vars)) filled = filled.replaceAll(`{${key}}`, value);
  if (filled.includes("{")) return fallback;
  try {
    const { pathname } = new URL(filled);
    return pathname.startsWith("/api/v1/") ? pathname.slice("/api/v1".length) : fallback;
  } catch {
    return fallback;
  }
}

/** Only the advertised caps that are usable numbers; anything else keeps its default. */
function positiveNumbers(live: RunnerDynamic): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(live || {})) {
    if (key in DEFAULT_CAPS && Number.isFinite(value) && Number(value) > 0) out[key] = Number(value);
  }
  return out;
}

/** Read exactly `length` bytes at `start` — the only run-dir bytes ever resident. */
async function readRange(file: string, start: number, length: number): Promise<Buffer> {
  const handle = await fsp.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
