// The per-run performance sidecar: `perf.jsonl`, one JSON object per timed span.
//
// DIAGNOSTIC ONLY — deliberately OUTSIDE the artifact contract. No manifest,
// envelope, bundle tier, viewer surface, or grader input names this file, and
// nothing downstream may start depending on it: deleting it must change no
// behavior. Spans are NOT added to trajectory.jsonl, which is pinned by
// committed baselines. Recording-performance work is accepted against measured
// spans rather than guesses: ordinary run telemetry cannot separate snapshot
// capture from the actor model call because `step_start` is only emitted after
// the actor returns.
//
// One line per span:
//
//   {"t":1753660800123,"step":3,"span":"snapshot","ms":27.412}
//   {"t":1753660800124,"step":3,"span":"actor_request","ms":24980.5,
//    "meta":{"tokens_in":9123,"cache_read":8192,"validation_retries":0}}
//   {"t":1753660800150,"step":2,"span":"axe","ms":24.3,
//    "meta":{"blocked_ms":0.05,"deferred_ms":412.7,"terminal":false}}
//
// `t` is wall-clock epoch ms at the moment the span CLOSED (so a reader can
// order spans against events.jsonl); `ms` is measured with performance.now(),
// which is monotonic and unaffected by clock steps. `step` is null for
// run-level spans (case_total, driver_close, env_teardown, slideshow, …).
//
// Sub-splits are separate spans, not nested metadata: the web snapshot reports
// `snapshot` (the total, emitted by the runner around the driver call) plus
// `snapshot_source`, `snapshot_screenshot`, `snapshot_image`, `snapshot_mhtml`,
// `snapshot_native_ax`, and `snapshot_write` from inside the driver. Flat rows
// aggregate into p50/p95 without a reader having to understand a shape.
//
// Enabled by default; PLAYTEST_PERF_SIDECAR=0|false|off|no turns it off, and a
// disabled recorder writes no file and does no timing work at all.
import fs from "node:fs";
import path from "node:path";

/** Free-form per-span annotations (token counts, retry counts, action type…). */
export type PerfMeta = Record<string, unknown>;

// Lines are buffered and written in batches: a syscall per span would put
// synchronous I/O on the very hot path this file exists to measure, and under a
// parallel suite that I/O blocks every other in-flight case's event loop. The
// sidecar is diagnostic, so losing a partial tail on a hard crash is acceptable;
// runCase flushes explicitly on every exit path.
const FLUSH_EVERY_LINES = 128;

/** PLAYTEST_PERF_SIDECAR=0/false/off/no disables the sidecar; default on. */
export function perfSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(env.PLAYTEST_PERF_SIDECAR || "");
}

/**
 * A run's span recorder. One instance per run (RunWriter owns it and hands the
 * same object to the driver, the grader, and the HAR flusher) so the file stays
 * in emission order without cross-instance interleaving.
 *
 * A DISABLED recorder is the same class, not a second one: every call site stays
 * monomorphic, `now()` returns 0 without reading the clock, and `span()` returns
 * on a single null check. `PerfSidecar.off()` is the shared disabled instance
 * for components constructed without a run (unit tests, external callers).
 */
export class PerfSidecar {
  static #off: PerfSidecar | null = null;

  /** The shared no-op recorder: never writes, never times, never allocates. */
  static off(): PerfSidecar {
    return (PerfSidecar.#off ??= new PerfSidecar(null));
  }

  // null = disabled. Also the single branch every hot-path method takes.
  #file: string | null;
  #lines: string[] = [];

  constructor(runDir: string | null, { enabled = perfSidecarEnabled() }: { enabled?: boolean } = {}) {
    this.#file = runDir && enabled ? path.join(runDir, "perf.jsonl") : null;
  }

  get enabled(): boolean {
    return this.#file !== null;
  }

  /** Span start stamp. 0 when disabled — no clock read, no allocation. */
  now(): number {
    return this.#file === null ? 0 : performance.now();
  }

  /** Close a span opened at `startedAt` (a value from `now()`). */
  span(span: string, startedAt: number, step: number | null = null, meta: PerfMeta | null = null): void {
    if (this.#file === null) return;
    this.record(span, performance.now() - startedAt, step, meta);
  }

  /** Record a span whose duration was measured elsewhere (or is a pure count). */
  record(span: string, ms: number, step: number | null = null, meta: PerfMeta | null = null): void {
    if (this.#file === null) return;
    const row = meta
      ? { t: Date.now(), step, span, ms: Math.round(ms * 1000) / 1000, meta }
      : { t: Date.now(), step, span, ms: Math.round(ms * 1000) / 1000 };
    this.#lines.push(JSON.stringify(row));
    if (this.#lines.length >= FLUSH_EVERY_LINES) this.flush();
  }

  /** Write buffered spans. Best-effort: a diagnostic file never fails a run. */
  flush(): void {
    if (this.#file === null || this.#lines.length === 0) return;
    const payload = this.#lines.join("\n") + "\n";
    this.#lines.length = 0;
    try {
      fs.appendFileSync(this.#file, payload);
    } catch {}
  }
}
