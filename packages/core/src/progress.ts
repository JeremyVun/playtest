// The shared live-progress fold: engine events in, one coalesced snapshot out.
// See docs/contracts/engine.md#progress-events.
//
// Two hosts answer "what is this run doing right now" and they must answer it
// in the same vocabulary: the runner-agent folds the event stream it already
// listens to and POSTs the snapshot (exec-group.ts, progressReporter), while
// the local viewer host folds the run dir's own events.jsonl for the live
// endpoint (docs/contracts/interfaces.md#viewer-server). Shared as code rather
// than reimplemented, so the two can never drift — and so liveness needs no new
// field on the hosted progress whitelist.
//
// Pure: the fold owns no I/O, no timers, and no transport. Coalescing, sending,
// and reading files stay with the callers.
import { modeDoing, PHASE_DOING } from "./report.ts";

/** The engine event fields the fold reads; every event carries more. */
export interface ProgressEvent {
  type?: string;
  mode?: string;
  maxSteps?: number | null;
  actorModel?: string | null;
  graderModel?: string | null;
  step?: number;
  summary?: unknown;
  costSoFar?: number | null;
  tokens?: unknown;
  phase?: string;
  [key: string]: unknown;
}

/**
 * The snapshot a live row renders. Exactly the fields the hosted progress
 * channel whitelists (executor-api.ts, progressView) — a new one would be
 * dropped on the floor there.
 */
export interface ProgressView {
  step?: number;
  max_steps?: number | null;
  doing?: string | null;
  action?: string | null;
  cost_usd?: number | null;
  model?: string | null;
  tokens?: unknown;
}

export interface ProgressFold {
  /** Apply one event; true when it moved the snapshot (i.e. worth sending). */
  apply(event: ProgressEvent): boolean;
  /** The snapshot so far, or null while no event has moved it. */
  view(): ProgressView | null;
}

/** Truncation bound for the actor's free-text step summary. */
const ACTION_MAX = 200;

/**
 * A stateful fold over one case's event stream.
 * `redact` runs over the actor's free text before it leaves the process; the
 * default is identity (the local host reads bytes the run already persisted).
 */
export function progressFold({ redact = (value: string) => value }: { redact?: (value: string) => string } = {}): ProgressFold {
  const snap: ProgressView = {};
  let moved = false;
  // The mode-word state machine mirrors the CLI live reporter (packages/cli/src/live.ts):
  // a pre-actor phase (setup) promotes the word, step_start restores the actor's
  // own word, and the grader phases swap the model chip to the model actually
  // doing the work.
  let actorDoing: string | null = null;
  let graderModel: string | null = null;

  const apply = (ev: ProgressEvent): boolean => {
    switch (ev.type) {
      case "case_start":
        actorDoing = snap.doing = ev.mode == null ? null : modeDoing(ev.mode);
        snap.max_steps = ev.maxSteps ?? null;
        snap.model = ev.actorModel || null;
        graderModel = ev.graderModel || null;
        break;
      case "step_start":
        snap.step = ev.step;
        snap.doing = actorDoing;
        snap.action = ev.summary ? redact(String(ev.summary)).slice(0, ACTION_MAX) : null;
        break;
      case "step_result":
        if (ev.costSoFar != null) snap.cost_usd = ev.costSoFar;
        if (ev.tokens) snap.tokens = ev.tokens;
        break;
      case "heal_start":
        actorDoing = snap.doing = modeDoing("heal");
        snap.action = null;
        break;
      case "heal_resume":
        // Re-anchored: replay resumed, so the mode word goes back to acting.
        actorDoing = snap.doing = modeDoing("act");
        snap.action = null;
        break;
      case "phase":
      case "grading": {
        const phase = (ev.phase ?? ev.type) as keyof typeof PHASE_DOING;
        snap.doing = PHASE_DOING[phase] ?? snap.doing;
        snap.action = null; // the actor stopped acting; its last step summary is stale
        if ((phase === "gate" || phase === "grading") && graderModel) snap.model = graderModel;
        break;
      }
      default:
        return false; // retry/env_ready/gate_fail/warn/case_end move nothing a live row shows
    }
    moved = true;
    return true;
  };

  return { apply, view: () => (moved ? { ...snap } : null) };
}

/**
 * Fold a finite event sequence in one call — the read path over a persisted
 * events.jsonl. Equivalent by construction to applying the same events one at a
 * time as they stream.
 */
export function foldProgress(
  events: Iterable<ProgressEvent>,
  opts?: { redact?: (value: string) => string },
): ProgressView | null {
  const fold = progressFold(opts);
  for (const event of events) fold.apply(event);
  return fold.view();
}
