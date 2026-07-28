// The shared progress fold (docs/contracts/engine.md#progress-events).
//
// Two hosts read it from two places — the runner-agent folds the live event
// stream, the local viewer host folds the run dir's events.jsonl — so the
// property that matters is that both readings are the same fold: applying
// events one at a time as they stream must equal folding the persisted lines of
// the same run.
import { test } from "node:test";
import assert from "node:assert/strict";

import { foldProgress, progressFold } from "../../src/progress.ts";

const EVENTS = [
  { type: "case_start", caseId: "todos/add", mode: "record", maxSteps: 20, actorModel: "gpt5_4_mini", graderModel: "gpt5_5", runDir: "/tmp/run" },
  { type: "phase", phase: "setup" },
  { type: "env_ready", base_url: "http://127.0.0.1:1", managed: false },
  { type: "step_start", step: 1, summary: "click Add" },
  { type: "step_result", step: 1, ok: true, costSoFar: 0.01, tokens: { in: 10, out: 5, cache_read: 0 } },
  { type: "step_start", step: 2, summary: "type buy milk" },
  { type: "retry", phase: "actor", attempt: 1, maxAttempts: 3 },
  { type: "step_result", step: 2, ok: true, costSoFar: 0.02, tokens: { in: 20, out: 9, cache_read: 4 } },
  { type: "heal_start", failedStep: 3, reason: "state drift" },
  { type: "heal_resume", resumedAtStep: 4 },
  { type: "warn", message: "something advisory" },
  { type: "phase", phase: "gate" },
  { type: "grading" },
  { type: "phase", phase: "finishing" },
  { type: "case_end", status: "pass" },
];

/** The run dir's own record, exactly as RunWriter.appendEvent writes it. */
const eventsJsonl = EVENTS.map((event) => JSON.stringify({ ts: new Date().toISOString(), ...event })).join("\n") + "\n";

test("folding a persisted events.jsonl equals folding the same events as they stream", () => {
  const streamed = progressFold();
  for (const event of EVENTS) streamed.apply(event);

  const persisted = foldProgress(
    eventsJsonl
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)),
  );

  assert.deepEqual(persisted, streamed.view());
  // …and one incremental reader that folds the file in two passes, the way the
  // local host does across polls, lands in the same place.
  const incremental = progressFold();
  const parsed = eventsJsonl.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  for (const event of parsed.slice(0, 6)) incremental.apply(event);
  for (const event of parsed.slice(6)) incremental.apply(event);
  assert.deepEqual(incremental.view(), streamed.view());
});

test("the fold's vocabulary: mode words, the grader model swap, and what moves nothing", () => {
  const fold = progressFold();
  assert.equal(fold.view(), null, "no event has moved it yet");

  assert.equal(fold.apply(EVENTS[0] as never), true);
  assert.deepEqual(fold.view(), { doing: "recording", max_steps: 20, model: "gpt5_4_mini" });

  assert.equal(fold.apply({ type: "phase", phase: "setup" }), true);
  assert.equal(fold.view()?.doing, "setting up", "a pre-actor phase promotes the word");
  assert.equal(fold.apply({ type: "step_start", step: 1, summary: "click Add" }), true);
  assert.equal(fold.view()?.doing, "recording", "step_start restores the actor's own word");
  assert.equal(fold.view()?.action, "click Add");

  assert.equal(fold.apply({ type: "heal_start" }), true);
  assert.equal(fold.view()?.doing, "healing");
  assert.equal(fold.view()?.action, null, "the step summary is stale once the mode changes");
  assert.equal(fold.apply({ type: "heal_resume" }), true);
  assert.equal(fold.view()?.doing, "checking", "a re-anchored heal is acting again");

  assert.equal(fold.apply({ type: "grading" }), true);
  assert.equal(fold.view()?.doing, "grading");
  assert.equal(fold.view()?.model, "gpt5_5", "the model chip follows the model doing the work");

  for (const inert of [{ type: "retry" }, { type: "env_ready" }, { type: "gate_fail" }, { type: "warn" }, { type: "case_end" }]) {
    assert.equal(fold.apply(inert), false, `${inert.type} moves nothing a live row shows`);
  }
});

test("free text passes through the caller's redactor and stays bounded", () => {
  const fold = progressFold({ redact: (value) => value.replaceAll("hunter2", "[secret:PW]") });
  fold.apply({ type: "step_start", step: 1, summary: "type hunter2 into the password field" });
  assert.equal(fold.view()?.action, "type [secret:PW] into the password field");

  fold.apply({ type: "step_start", step: 2, summary: "x".repeat(500) });
  assert.equal(fold.view()?.action?.length, 200);
});
