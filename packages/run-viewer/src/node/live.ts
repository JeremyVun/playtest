// The live protocol on the local viewer host: GET <run base>/live.
// See docs/contracts/interfaces.md#live-runs.
//
// Two facts the run directory already carries make this possible, and neither
// is new: trajectory.jsonl is append-only while a run executes (rewriteLast on
// the terminal envelope is the sole exception, and the seal reload covers it),
// and every engine event is persisted to events.jsonl with case_end written
// after the finishing tail (docs/contracts/engine.md#progress-events). So
// liveness is read from the event stream — never inferred from manifest
// contents, whose placeholder deliberately says "interrupted" from the first
// instant of a case.
//
// Everything here is additive and best-effort: no route, degradation, or
// artifact changes, and a live read that fails answers "sealed" rather than
// disturbing a run.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StorageProvider } from "@playtest/core/artifacts";
import { progressFold } from "@playtest/core/reporting";
import type { ProgressFold, ProgressView } from "@playtest/core/reporting";

const TRAJECTORY = "trajectory.jsonl";
const EVENTS = "events.jsonl";
const MANIFEST = "manifest.json";

// One bounded read answers "is this run open?": the last line of events.jsonl
// is the terminal event when the run sealed, and a whole small file also shows
// whether case_start was ever written. The picker does this once per run, so it
// must never parse a whole event log.
const BRACKET_BYTES = 8192;

// Response caps. A late joiner pages through a backlog in bounded responses
// (has_more) instead of one enormous body; a single line over the byte cap is
// still delivered alone, because holding it back would stall the cursor.
const MAX_LINES = 500;
const MAX_BYTES = 512 * 1024;

// Hold bounds, matching the platform's feed long-poll: at most 25 s per
// request, re-checking the three signals a few times a second.
const MAX_WAIT_S = 25;
const POLL_MS = 200;

export interface LiveResponse {
  open: boolean;
  reset: boolean;
  next: number;
  has_more: boolean;
  lines: string[];
  manifest_generation: number;
  progress: ProgressView | null;
  inactive_ms: number;
}

/** The additive verdict fields of a picker entry (docs/contracts/interfaces.md). */
export interface LiveStatusProjection {
  status: string | null;
  open?: true;
}

const joinRel = (rel: string, name: string) => (rel ? `${rel}/${name}` : name);

function parseEvent(line: string): { type?: string } | null {
  try {
    return JSON.parse(line) as { type?: string };
  } catch {
    return null;
  }
}

/**
 * Is this run still executing? `case_start` present with no terminal `case_end`
 * means open; a terminal event means sealed; no events.jsonl at all means a
 * legacy (sealed) run.
 *
 * Best-effort by inheritance: engine event writes are deliberately swallowed,
 * so the degradations are defined rather than accidental — a missing
 * `case_start` reads sealed/non-live, a missing terminal event reads
 * open-but-inactive, and neither ever touches a run's status or artifacts. A
 * provider with no tail read (a `.ptrun` bundle) is sealed by construction.
 */
export function isOpenRun(provider: StorageProvider, rel = ""): boolean {
  if (typeof provider.readTail !== "function") return false;
  const tail = provider.readTail(joinRel(rel, EVENTS), BRACKET_BYTES);
  if (!tail) return false;
  const lines = tail.text.split("\n").filter((line) => line.trim());
  // Only a whole file proves case_start's absence; a tail of a larger log is a
  // run that already emitted thousands of bytes of events.
  if (tail.complete && !lines.some((line) => parseEvent(line)?.type === "case_start")) return false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = parseEvent(lines[i] as string); // SAFETY: the descending index stays inside the filtered lines
    if (!event) continue; // a torn trailing line: the previous whole one still answers
    return event.type !== "case_end";
  }
  return false;
}

/**
 * A run's verdict fields for the picker and `view --json`. An open run keeps the
 * existing "no verdict yet" vocabulary — `status: null` — and adds `open: true`;
 * it never shows the placeholder manifest's `interrupted`. A sealed run projects
 * exactly what it always did, with no extra key.
 */
export function liveStatusProjection(
  manifest: { result?: { status?: string | null } } | null,
  provider: StorageProvider,
  rel = "",
): LiveStatusProjection {
  if (isOpenRun(provider, rel)) return { status: null, open: true };
  return { status: manifest?.result?.status ?? null };
}

/** Bounded byte-range read through the provider seam; null on any failure. */
function readChunk(provider: StorageProvider, rel: string, start: number, end: number): Promise<Buffer | null> {
  if (end < start) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve) => {
    let stream;
    try {
      stream = provider.createReadStream(rel, { start, end });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", () => resolve(null));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Per-run live state: the private line→byte index over trajectory.jsonl, the
 * incremental progress fold over events.jsonl, and the host-minted manifest
 * generation. All of it is a cache — losing it costs a rescan, never
 * correctness — but an index the host had to rebuild inconsistently answers
 * `reset` rather than guessing what a client already holds.
 */
interface RunLiveState {
  offsets: number[]; // byte offset of every indexed line, plus the end sentinel
  indexed: number; // whole lines indexed (offsets.length - 1)
  fold: ProgressFold;
  progress: ProgressView | null;
  eventsRead: number; // bytes of events.jsonl consumed into whole lines
  generation: number;
  manifestKey: string | null;
  rebuilt: boolean; // the index restarted since the last answer: cursors are stale
}

const freshState = (): RunLiveState => ({
  offsets: [0],
  indexed: 0,
  fold: progressFold(),
  progress: null,
  eventsRead: 0,
  generation: 0,
  manifestKey: null,
  rebuilt: false,
});

/**
 * The live endpoint's server-side state, one instance per viewer server. It
 * holds nothing a request cannot rebuild, and nothing that outlives the server.
 */
export function createLiveHost(provider: StorageProvider, { sealed = false }: { sealed?: boolean } = {}) {
  const runs = new Map<string, RunLiveState>();
  // Answers for one run are serialized: the index grows across await points, so
  // two overlapping polls (a second tab, a reload) must not both append to it.
  // Holds happen outside this chain, so one waiting client never blocks another.
  const chains = new Map<string, Promise<unknown>>();

  const stateOf = (rel: string) => {
    let state = runs.get(rel);
    if (!state) runs.set(rel, (state = freshState()));
    return state;
  };

  const serialized = <T,>(rel: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(rel) ?? Promise.resolve()).then(fn, fn);
    chains.set(rel, next.then(() => {}, () => {}));
    return next;
  };

  /** Grow the line index over whatever whole lines the file has gained. */
  const index = async (rel: string, state: RunLiveState, size: number) => {
    const scanned = state.offsets[state.indexed] as number; // SAFETY: offsets always carries the end sentinel
    if (size < scanned) {
      // Truncated, replaced, or rewritten shorter than what we indexed: the
      // cursor we handed out no longer names the same line.
      Object.assign(state, { offsets: [0], indexed: 0, rebuilt: true });
      return index(rel, state, size);
    }
    if (size === scanned) return;
    // rewriteLast() mutates the terminal envelope in place — the one exception
    // to append-only. A longer rewrite grows the file without adding a line, so
    // a size-only index would hand out a fragment of the rewritten line as a new
    // one. Envelopes are JSON, so the only newline bytes are line terminators:
    // if the byte before the new region is no longer one, the file was rewritten
    // rather than appended to, and every cursor over it is stale.
    if (state.indexed > 0) {
      const boundary = await readChunk(provider, joinRel(rel, TRAJECTORY), scanned - 1, scanned - 1);
      if (!boundary || boundary[0] !== 0x0a) {
        Object.assign(state, { offsets: [0], indexed: 0, rebuilt: true });
        return index(rel, state, size);
      }
    }
    const chunk = await readChunk(provider, joinRel(rel, TRAJECTORY), scanned, size - 1);
    if (!chunk) return;
    // Whatever follows the last newline is a partial write: held for the next
    // poll, never delivered as a line.
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      state.offsets.push(scanned + i + 1);
      state.indexed++;
    }
  };

  /** Fold the events the run has appended since the last poll. */
  const foldEvents = async (rel: string, state: RunLiveState, size: number) => {
    if (size < state.eventsRead) {
      state.fold = progressFold();
      state.progress = null;
      state.eventsRead = 0;
    }
    if (size === state.eventsRead) return;
    const chunk = await readChunk(provider, joinRel(rel, EVENTS), state.eventsRead, size - 1);
    if (!chunk) return;
    const text = chunk.toString("utf8");
    const lastBreak = text.lastIndexOf("\n");
    if (lastBreak === -1) return;
    for (const line of text.slice(0, lastBreak).split("\n")) {
      if (!line.trim()) continue;
      const event = parseEvent(line);
      if (event) state.fold.apply(event);
    }
    state.eventsRead += Buffer.byteLength(text.slice(0, lastBreak + 1), "utf8");
    state.progress = state.fold.view();
  };

  /** Host-minted monotonic counter: clients compare inequality, never order. */
  const generation = (rel: string, state: RunLiveState) => {
    const st = provider.stat(joinRel(rel, MANIFEST));
    const key = st ? `${st.mtime.getTime()}:${st.size}` : null;
    if (key !== state.manifestKey) {
      state.manifestKey = key;
      state.generation++;
    }
    return state.generation;
  };

  /** The three signals a held poll watches, as one comparable string. */
  const signals = (rel: string) => {
    const t = provider.stat(joinRel(rel, TRAJECTORY));
    const e = provider.stat(joinRel(rel, EVENTS));
    const m = provider.stat(joinRel(rel, MANIFEST));
    return [
      t ? t.size : -1,
      e ? `${e.size}:${e.mtime.getTime()}` : -1,
      m ? `${m.mtime.getTime()}:${m.size}` : -1,
    ].join("|");
  };

  const answer = async (rel: string, after: number): Promise<LiveResponse> => {
    const state = stateOf(rel);
    const open = isOpenRun(provider, rel);
    const traj = provider.stat(joinRel(rel, TRAJECTORY));
    if (traj) await index(rel, state, traj.size);
    const events = provider.stat(joinRel(rel, EVENTS));
    if (events) await foldEvents(rel, state, events.size);
    const manifestGeneration = generation(rel, state);
    const inactive = events ? Math.max(0, Date.now() - events.mtime.getTime()) : 0;

    // A cursor past the host's truth, or one issued against an index the host
    // had to rebuild, cannot be honored: say so instead of guessing.
    if (after > state.indexed || (state.rebuilt && after > 0)) {
      state.rebuilt = false;
      return {
        open, reset: true, next: 0, has_more: false, lines: [],
        manifest_generation: manifestGeneration, progress: state.progress, inactive_ms: inactive,
      };
    }
    state.rebuilt = false;

    let last = after; // exclusive end of the window we will deliver
    let bytes = 0;
    while (last < state.indexed && last - after < MAX_LINES) {
      const size = (state.offsets[last + 1] as number) - (state.offsets[last] as number); // SAFETY: last < indexed proves both offsets exist
      if (last > after && bytes + size > MAX_BYTES) break;
      bytes += size;
      last++;
    }
    let more = last < state.indexed;
    let lines: string[] = [];
    if (last > after) {
      const chunk = await readChunk(
        provider,
        joinRel(rel, TRAJECTORY),
        state.offsets[after] as number, // SAFETY: after <= indexed proves the offset exists
        (state.offsets[last] as number) - 1,
      );
      if (chunk) {
        // The window is whole lines by construction, so the trailing newline
        // leaves one empty tail element.
        lines = chunk.toString("utf8").split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
      } else {
        // An unreadable window is a transient (a file being replaced under us):
        // deliver nothing and let the caller long-poll rather than spin on an
        // immediate drain that has no bytes behind it.
        more = false;
      }
    }
    return {
      open,
      reset: false,
      next: after + lines.length,
      has_more: more,
      lines,
      manifest_generation: manifestGeneration,
      progress: state.progress,
      inactive_ms: inactive,
    };
  };

  /**
   * Answer one live request. A sealed provider (a `.ptrun` bundle) and an
   * absent run both answer `open: false` immediately; an open, caught-up caller
   * is held up to `wait` seconds and woken by trajectory growth, an event
   * append (progress and, critically, `case_end`), or a manifest rewrite.
   */
  const respond = async (req: IncomingMessage, rel: string, params: URLSearchParams): Promise<LiveResponse> => {
    if (sealed) {
      return { open: false, reset: false, next: 0, has_more: false, lines: [], manifest_generation: 0, progress: null, inactive_ms: 0 };
    }
    const after = Math.max(0, Math.trunc(Number(params.get("after")) || 0));
    const wait = Math.min(MAX_WAIT_S, Math.max(0, Math.trunc(Number(params.get("wait")) || 0)));
    let result = await serialized(rel, () => answer(rel, after));
    if (!result.open || result.reset || result.lines.length || !wait) return result;

    const before = signals(rel);
    const deadline = Date.now() + wait * 1000;
    let aborted = false;
    const onClose = () => {
      aborted = true;
    };
    req.on("close", onClose);
    try {
      while (!aborted && Date.now() < deadline && signals(rel) === before) {
        await new Promise<void>((resolve) => {
          // Unref'd: a held poll never keeps a viewer process alive on its own.
          const timer = setTimeout(resolve, POLL_MS);
          timer.unref?.();
        });
      }
    } finally {
      req.off("close", onClose);
    }
    result = await serialized(rel, () => answer(rel, after));
    return result;
  };

  return { respond };
}

export type LiveHost = ReturnType<typeof createLiveHost>;

/** `/run/<rel>/live` (or `/run/live` in single-run mode) → the run's relative path. */
export function liveTargetOf(runPath: string): string | null {
  if (runPath === "live") return "";
  if (!runPath.endsWith("/live")) return null;
  const rel = runPath.slice(0, -"/live".length);
  if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return rel;
}

export function liveResponse(res: ServerResponse, body: LiveResponse) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
  res.end(JSON.stringify(body));
}
