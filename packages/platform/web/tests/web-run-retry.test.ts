import test from "node:test";
import assert from "node:assert/strict";
import { canRetryRun, retryableStoryCount } from "../src/lib/run-retry.js";

test("retry is offered only when a settled run has stories that never started", () => {
  const neverStarted = { status: "done", runs: [{ status: "infra", started_at: null }] };
  assert.equal(canRetryRun(neverStarted), true);
  assert.equal(retryableStoryCount(neverStarted), 1);
  assert.equal(canRetryRun({ status: "done", runs: [{ status: "lost", started_at: null }] }), true);
  assert.equal(canRetryRun({ status: "done", runs: [{ status: "fail", started_at: null }] }), false);
  assert.equal(canRetryRun({ status: "done", runs: [{ status: "infra", started_at: "2026-07-27T10:00:00Z" }] }), false);
  assert.equal(canRetryRun({ status: "running", runs: [{ status: "infra", started_at: null }] }), false);
});

test("retry counts only unfinished placement failures", () => {
  assert.equal(retryableStoryCount({
    runs: [
      { status: "infra", started_at: null },
      { status: "lost", started_at: null },
      { status: "pass", started_at: null },
      { status: "infra", started_at: "2026-07-27T10:00:00Z" },
    ],
  }), 2);
});
