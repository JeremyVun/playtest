// The console's half of a live run (docs/contracts/interfaces.md#live-runs).
//
// A hosted run streams into the viewer while it executes, so the console's own
// chrome has to keep up with it — and it has to do that WITHOUT a second live
// loop. The division is fixed: the embedded viewer owns the live long-poll
// (one in-flight request per tab, against the run's `live` route), and the page
// owns the event feed it already subscribes to. Nothing here polls; every
// function is a pure decision over a feed event or a run row, so the seal
// transition can be regression-tested without a browser (sibling of
// run-stats.ts / run-retry.ts / vocab.ts).
//
// Words come from the shared run vocabulary (labels.ts, the core report.ts
// mirror) — never local synonyms. "recording step 7 of 40" reads the same in
// the runs index, in this page's chrome, and in the viewer's pending row.

import { modeDoing } from "./labels.js";

/** A run that is still executing: its evidence is still arriving. */
const LIVE_STATUS: WebDynamic = ["queued", "running", "uploading"];

/** Is this run streaming — i.e. does the page wear the live badge? */
export const isLiveRun = (run: WebDynamic) => !!run && LIVE_STATUS.includes(run.status);

/**
 * What a feed event means for the run page:
 *
 *   "reload"    this run's status moved — refetch the run and repaint the
 *               chrome. The seal arrives this way: `run.status` carrying the
 *               verdict is emitted in the same transaction as the case report,
 *               so the header flips a feed tick after the run finished, while
 *               the iframe's own live poll (woken by the same seal) reloads
 *               into the sealed run. Neither waits on the other.
 *   "progress"  a coalesced progress snapshot for this run — patch the live
 *               line in place. Never a repaint: a step counter ticking is not
 *               a reason to rebuild a header holding an open menu.
 *   null        not ours, or nothing this page renders.
 *
 * Group-level `run.status` (no `run_id`) is the cold-start narration for a
 * whole launch and belongs to the runs index, not here.
 */
export function liveFeedIntent(e: WebDynamic, runId: WebDynamic) {
  if (!e || !runId || e.entity?.run_id !== runId) return null;
  if (e.type === "run.status") return "reload";
  if (e.type === "run.event" && e.payload?.type === "progress") return "progress";
  return null;
}

/**
 * The progress snapshot inside a `run.event` progress payload — the payload IS
 * the row's `progress` projection (hosted.md, Runner protocol), minus the two
 * envelope fields the feed adds.
 */
export function progressSnapshot(e: WebDynamic) {
  const { type: _type, case_id: _caseId, ...snap } = e?.payload || {};
  return snap;
}

/**
 * What the run is doing right now, in one line, from the progress snapshot the
 * feed already delivers. Never step-budget arithmetic and never an ETA: the
 * step number is a fact the runner reported, a percentage would be a promise.
 *
 * Returns null when there is nothing true to say yet — a queued run has no
 * runner, so it gets the waiting words instead of a phantom step.
 */
export function liveDoing(run: WebDynamic, progress: WebDynamic = null) {
  if (!isLiveRun(run)) return null;
  if (run.status === "queued") return "waiting for a runner";
  if (run.status === "uploading") return "uploading evidence";
  const p = progress || run.progress || null;
  const doing = p?.doing || modeDoing(run.mode);
  if (!doing) return null;
  if (typeof p?.step !== "number") return String(doing);
  return p.max_steps ? `${doing} step ${p.step} of ${p.max_steps}` : `${doing} step ${p.step}`;
}

/** The actor's latest action, when the snapshot carries one. */
export function liveAction(run: WebDynamic, progress: WebDynamic = null) {
  if (!isLiveRun(run) || run.status !== "running") return null;
  const p = progress || run.progress || null;
  return typeof p?.action === "string" && p.action ? p.action : null;
}
