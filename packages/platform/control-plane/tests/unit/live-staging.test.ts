// Unit cover for the live-staging vocabulary every part of the live path shares
// (src/live/staging.ts). Hermetic: no database, no object store — these are the
// pure decisions (openness, entry-path shape, response windowing) that ingest,
// serving, seal and GC must all agree on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRunOpen, isStageableEntry, liveObjectKey, liveWakeKey } from "../../src/live/staging.ts";

test("openness is explicit state, never an inference from manifest contents", () => {
  for (const status of ["queued", "running", "uploading"]) {
    assert.equal(isRunOpen({ live_opened_at: new Date(), status }), true, status);
  }
  for (const status of ["pass", "fail", "infra", "explored", "canceled", "lost"]) {
    assert.equal(isRunOpen({ live_opened_at: new Date(), status }), false, `${status} is terminal`);
  }
  assert.equal(
    isRunOpen({ live_opened_at: null, status: "running" }),
    false,
    "a running run nobody opened is not live-viewable",
  );
});

test("only step-artifact paths are stageable, and traversal never is", () => {
  for (const entry of ["steps/001.png", "steps/007.a11y.txt", "steps/007.mhtml", "steps/012.pw-a11y.txt"]) {
    assert.equal(isStageableEntry(entry), true, entry);
  }
  for (const entry of [
    "manifest.json", // virtual: served from the run row, never staged as an object
    "trajectory.jsonl", // virtual: served from the ledger
    "video.mp4", // end-of-run artifacts stay end-of-run
    "steps/../../etc/passwd",
    "../steps/001.png",
    "/steps/001.png",
    "steps//001.png",
    "steps/",
    "steps/.hidden",
    "steps/sub/001.png",
    "",
  ]) {
    assert.equal(isStageableEntry(entry), false, JSON.stringify(entry));
  }
  assert.equal(isStageableEntry(`steps/${"a".repeat(200)}.png`), false, "an unbounded entry name is refused");
});

test("staged objects live under runs/ so the orphan sweep sees them, apart from the sealed bundle key", () => {
  const run = { id: "run-db-1", run_group_id: "grp-1" };
  const key = liveObjectKey(run, "steps/001.png");
  assert.equal(key, "runs/grp-1/live/run-db-1/steps/001.png");
  assert.ok(key.startsWith("runs/"), "retention's orphan sweep only lists the runs/ prefix");
  assert.notEqual(key, `runs/${run.run_group_id}/${run.id}.ptrun`);
});

test("live wake keys cannot collide with the feed's project keys", () => {
  assert.equal(liveWakeKey("01J"), "live:01J");
});
