import test from "node:test";
import assert from "node:assert/strict";
import { isLiveRun, liveFeedIntent, progressSnapshot, liveDoing, liveAction } from "../src/lib/run-live.js";

const progressEvent = (runId: WebDynamic, snap: WebDynamic) => ({
  id: "01EVENT",
  type: "run.event",
  entity: { run_id: runId, run_group_id: "01GROUP" },
  payload: { type: "progress", case_id: "add-todo", ...snap },
});
const statusEvent = (runId: WebDynamic, status: WebDynamic) => ({
  id: "01EVENT",
  type: "run.status",
  entity: { run_id: runId, run_group_id: "01GROUP" },
  payload: { status },
});

test("a run is live until it reaches an end", () => {
  for (const status of ["queued", "running", "uploading"]) assert.equal(isLiveRun({ status }), true);
  for (const status of ["pass", "fail", "infra", "explored", "canceled", "lost"]) {
    assert.equal(isLiveRun({ status }), false);
  }
  assert.equal(isLiveRun(null), false);
});

test("the run page acts only on feed events naming its own run", () => {
  assert.equal(liveFeedIntent(progressEvent("01RUN", { step: 3 }), "01RUN"), "progress");
  assert.equal(liveFeedIntent(statusEvent("01RUN", "running"), "01RUN"), "reload");
  // Another story in the same launch moves constantly; this page must not
  // refetch itself every time one of them ticks.
  assert.equal(liveFeedIntent(progressEvent("01OTHER", { step: 3 }), "01RUN"), null);
  assert.equal(liveFeedIntent(statusEvent("01OTHER", "pass"), "01RUN"), null);
  // Group-level narration carries no run_id: it belongs to the runs index.
  assert.equal(liveFeedIntent({ type: "run.status", entity: { run_group_id: "01GROUP" }, payload: { status: "running" } }, "01RUN"), null);
  // Other run events keep their own handlers.
  assert.equal(liveFeedIntent({ type: "run.event", entity: { run_id: "01RUN" }, payload: { type: "clip_failed" } }, "01RUN"), null);
  assert.equal(liveFeedIntent({ type: "clip.created", entity: { run_id: "01RUN" } }, "01RUN"), null);
  assert.equal(liveFeedIntent(null, "01RUN"), null);
});

test("the seal arrives as one run.status event, and takes the live chrome with it", () => {
  const runId = "01RUN";
  let run: WebDynamic = { id: runId, status: "running", mode: "record", progress: null };
  let progress: WebDynamic = null;

  // Steps arrive: the live line moves, the page never refetches.
  for (const e of [
    progressEvent(runId, { step: 6, max_steps: 40, doing: "recording", action: 'typed "buy oat milk"' }),
    progressEvent(runId, { step: 7, max_steps: 40, doing: "recording", action: 'clicked "Add"' }),
  ]) {
    assert.equal(liveFeedIntent(e, runId), "progress");
    progress = progressSnapshot(e);
  }
  assert.equal(liveDoing(run, progress), "recording step 7 of 40");
  assert.equal(liveAction(run, progress), 'clicked "Add"');

  // The case report emits the verdict on the same feed. One refetch, and the
  // chrome has nothing live left to say — the iframe reloads itself into the
  // sealed run off its own live poll.
  assert.equal(liveFeedIntent(statusEvent(runId, "pass"), runId), "reload");
  run = { id: runId, status: "pass", mode: "record", score: 91, progress: null };
  progress = run.progress ?? null;
  assert.equal(isLiveRun(run), false);
  assert.equal(liveDoing(run, progress), null);
  assert.equal(liveAction(run, progress), null);
});

test("the live line says only what the run has actually reported", () => {
  // Nothing has claimed the story yet: no runner, so no step to name.
  assert.equal(liveDoing({ status: "queued", mode: "record" }), "waiting for a runner");
  // The tail after the last step, where a step number would be a phantom.
  assert.equal(liveDoing({ status: "uploading", mode: "record" }), "uploading evidence");
  // No snapshot yet: the story's mode is still a true thing to say.
  assert.equal(liveDoing({ status: "running", mode: "heal" }), "healing");
  assert.equal(liveDoing({ status: "running", mode: "record", progress: { doing: "grading" } }), "grading");
  // A budget the runner did not report is never invented.
  assert.equal(liveDoing({ status: "running", mode: "record" }, { doing: "recording", step: 4 }), "recording step 4");
  // The row's own snapshot seeds the line before the first feed event lands.
  assert.equal(
    liveDoing({ status: "running", mode: "record", progress: { doing: "checking", step: 2, max_steps: 12 } }),
    "checking step 2 of 12",
  );
  // Post-actor phases clear the action server-side; nothing is carried over.
  assert.equal(liveAction({ status: "running", mode: "record" }, { doing: "grading", action: "" }), null);
  assert.equal(liveAction({ status: "uploading", mode: "record" }, { action: "clicked Submit" }), null);
});

test("a progress snapshot is the row projection, minus the feed envelope", () => {
  const snap = progressSnapshot(progressEvent("01RUN", {
    step: 7, max_steps: 40, doing: "recording", action: "clicked Add", cost_usd: 0.14, model: "claude-sonnet-5",
  }));
  assert.deepEqual(snap, {
    step: 7, max_steps: 40, doing: "recording", action: "clicked Add", cost_usd: 0.14, model: "claude-sonnet-5",
  });
  assert.deepEqual(progressSnapshot({}), {});
});
