// The Runs surfaces' arithmetic and words (packages/platform/web/src/lib/run-stats.ts).
// The index, the run dashboard and the replay page all read a run's counts from
// this module, from three different server shapes, and they must agree: a run
// that says "1 failed" in the list and "done" on its own page is exactly the
// failure-hiding the web invariants forbid. DOM-free, like the module.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runStats, outcomeParts, outcomeWords, outcomeChip, outcomeTone, progressWords,
  needsAttention, pipTone, triggerWord, runTitle, runName, suiteOrder, soloStory,
  isFinishedStatus, neverRanStatus, inFlightStatus,
} from "../src/lib/run-stats.js";

const STATS = (over = {}) => ({
  total: 0, queued: 0, running: 0, done: 0,
  pass: 0, fail: 0, infra: 0, explored: 0, canceled: 0, lost: 0, changed: 0,
  cost_usd: 0, duration_ms: null, started_at: null, finished_at: null,
  ...over,
});

test("statuses: finished, never-ran and in-flight families", () => {
  for (const s of ["pass", "fail", "infra", "explored", "canceled", "lost"]) {
    assert.ok(isFinishedStatus(s), `${s} is an end state`);
  }
  for (const s of ["queued", "running", "uploading"]) assert.ok(!isFinishedStatus(s));
  // No verdict is not a product failure — the amber family.
  assert.deepEqual(["infra", "canceled", "lost"].map(neverRanStatus), [true, true, true]);
  assert.ok(!neverRanStatus("fail"));
  assert.deepEqual(["running", "uploading"].map(inFlightStatus), [true, true]);
});

test("runStats: prefers the server projection, then rows, then exit_summary", () => {
  const stats = STATS({ total: 3, done: 3, pass: 2, fail: 1, cost_usd: 0.02 });
  assert.equal(runStats({ stats }).source, "stats");
  assert.equal(runStats({ stats }).fail, 1);

  const rows = { runs: [{ status: "pass" }, { status: "fail" }] };
  assert.equal(runStats(rows).source, "runs");
  assert.equal(runStats(rows).total, 2);

  const legacy = { exit_summary: { cases: [{ status: "pass" }, { status: "explored" }] } };
  assert.equal(runStats(legacy).source, "exit_summary");
  assert.equal(runStats(legacy).explored, 1);

  // Nothing at all still reads as zeros, never as undefined arithmetic.
  const none = runStats({});
  assert.equal(none.source, "none");
  assert.equal(none.total, 0);
  assert.equal(runStats(null).total, 0);
});

test("runStats: the three shapes agree on the same run", () => {
  const cases = [{ status: "pass" }, { status: "fail" }, { status: "infra" }];
  const fromRows = runStats({ runs: cases });
  const fromSummary = runStats({ exit_summary: { cases } });
  const fromServer = runStats({ stats: STATS({ total: 3, done: 3, pass: 1, fail: 1, infra: 1 }) });
  for (const k of ["total", "done", "pass", "fail", "infra"]) {
    assert.equal(fromRows[k], fromServer[k], `rows and stats disagree on ${k}`);
    assert.equal(fromSummary[k], fromServer[k], `exit_summary and stats disagree on ${k}`);
  }
  assert.equal(outcomeWords(fromRows), outcomeWords(fromServer));
});

test("runStats: cost adds up from either row shape", () => {
  // A group view carries the manifest's totals; an index row carries the one
  // number a list needs.
  const stats = runStats({ runs: [{ status: "pass", totals: { cost_usd: 0.01 } }, { status: "pass", cost_usd: 0.02 }] });
  assert.ok(Math.abs(stats.cost_usd - 0.03) < 1e-9, `cost was ${stats.cost_usd}`);
  // A missing or unparseable cost is zero, never NaN in a table cell.
  assert.equal(runStats({ runs: [{ status: "pass" }, { status: "pass", cost_usd: null }] }).cost_usd, 0);
});

test("runStats: a run whose rows share a timestamp still reports its work", () => {
  // Replayed and backdated groups can have every story stamped the same
  // millisecond. The span collapses to zero; "0ms" for a run that did seconds
  // of work is a lie, so the work its stories reported stands in.
  const at = new Date(1_700_000_000_000).toISOString();
  const stats = runStats({
    runs: [
      { status: "pass", started_at: at, finished_at: at, duration_ms: 2100 },
      { status: "fail", started_at: at, finished_at: at, duration_ms: 2100 },
    ],
  });
  assert.equal(stats.duration_ms, 4200);
  // And when the span is the bigger of the two, the span wins — it includes the
  // gaps between stories, which are part of how long the run took.
  const spanned = runStats({
    runs: [
      { status: "pass", started_at: at, finished_at: new Date(1_700_000_001_000).toISOString(), duration_ms: 100 },
      { status: "pass", started_at: at, finished_at: new Date(1_700_000_030_000).toISOString(), duration_ms: 100 },
    ],
  });
  assert.equal(spanned.duration_ms, 30_000);
});

test("runStats: wall clock only once nothing is still moving", () => {
  const t = (ms: WebDynamic) => new Date(1_700_000_000_000 + ms).toISOString();
  const settled = runStats({
    runs: [
      { status: "pass", started_at: t(0), finished_at: t(5000) },
      { status: "fail", started_at: t(1000), finished_at: t(9000) },
    ],
  });
  assert.equal(settled.duration_ms, 9000);
  assert.equal(new Date(settled.started_at).getTime(), new Date(t(0)).getTime());

  // One story still running: reporting the last one that HAPPENED to finish as
  // the run's duration makes an in-flight run's clock jump backwards.
  const live = runStats({
    runs: [{ status: "pass", started_at: t(0), finished_at: t(5000) }, { status: "running", started_at: t(1000) }],
  });
  assert.equal(live.duration_ms, null);
  assert.equal(live.finished_at, null);
  assert.equal(live.running, 1);
  assert.equal(live.done, 1);
});

test("outcomeParts: failure first, and a changed pass is counted once", () => {
  const parts = outcomeParts(STATS({ total: 3, done: 3, pass: 1, fail: 1, infra: 1 }));
  assert.deepEqual(parts.map((p: WebDynamic) => p.key), ["fail", "infra", "pass"]);
  assert.deepEqual(parts.map((p: WebDynamic) => p.word), ["failed", "didn't run", "passed"]);
  // Every part carries its own word: the glyph and its colour are never the
  // only carrier of what a number means.
  assert.ok(parts.every((p: WebDynamic) => p.word && p.tone && p.n > 0));

  // Two of three passes took a new path. 2 passed + 1 changed = 3, not 4.
  const changed = outcomeParts(STATS({ total: 3, done: 3, pass: 3, changed: 1 }));
  assert.deepEqual(changed.map((p: WebDynamic) => [p.key, p.n]), [["changed", 1], ["pass", 2]]);
  assert.equal(changed.reduce((n: WebDynamic, p: WebDynamic) => n + p.n, 0), 3);

  // "lost" wears infra's tone: to a person it is the same fact.
  assert.equal(outcomeParts(STATS({ total: 1, done: 1, lost: 1 }))[0].tone, "infra");
  assert.deepEqual(outcomeParts(STATS()), []);
});

test("outcomeWords: says a shared word's number once", () => {
  assert.equal(outcomeWords(STATS({ total: 3, done: 3, pass: 1, fail: 1, infra: 1 })), "1 failed · 1 didn't run · 1 passed");
  // infra + lost are both "didn't run" — one phrase, both counted.
  assert.equal(outcomeWords(STATS({ total: 2, done: 2, infra: 1, lost: 1 })), "2 didn't run");
  assert.equal(outcomeWords(STATS()), "");
});

test("progressWords: how far a live run has got", () => {
  assert.equal(progressWords(STATS({ total: 5, done: 3, running: 1, queued: 1 })), "3 of 5 stories done");
  assert.equal(progressWords(STATS({ total: 1, done: 0, running: 1 })), "0 of 1 story done");
  // Nothing to say once everything is in.
  assert.equal(progressWords(STATS({ total: 2, done: 2, pass: 2 })), "");
  assert.equal(progressWords(STATS()), "");
});

test("outcomeChip: a live run states progress, and a failure is never green", () => {
  assert.deepEqual(outcomeChip({ status: "queued", stats: STATS({ total: 3, queued: 3 }) }),
    { tone: "neutral", label: "provisioning" });
  assert.deepEqual(outcomeChip({ status: "running", stats: STATS({ total: 5, done: 3, running: 2 }) }),
    { tone: "running", label: "3 of 5 stories done" });
  // A running run with no rows yet still says something.
  assert.deepEqual(outcomeChip({ status: "running", stats: STATS() }), { tone: "running", label: "running" });
  assert.deepEqual(outcomeChip({ status: "canceled", stats: STATS({ total: 2, canceled: 2 }) }),
    { tone: "neutral", label: "canceled" });

  const failing = outcomeChip({ status: "done", stats: STATS({ total: 3, done: 3, pass: 2, fail: 1 }) });
  assert.equal(failing.tone, "fail", "a run holding a failure is never a green done");
  assert.equal(failing.label, "1 failed · 2 passed");
  // A finished run with no stories at all is the only bare "done".
  assert.deepEqual(outcomeChip({ status: "done", stats: STATS() }), { tone: "neutral", label: "done" });
});

test("outcomeTone: the worst outcome wins", () => {
  assert.equal(outcomeTone(STATS({ fail: 1, pass: 9, infra: 1 })), "fail");
  assert.equal(outcomeTone(STATS({ infra: 1, pass: 2 })), "infra");
  assert.equal(outcomeTone(STATS({ lost: 1, pass: 2 })), "infra");
  assert.equal(outcomeTone(STATS({ pass: 2 })), "pass");
  // Every pass took a new path — that is a decision waiting, not a clean pass.
  assert.equal(outcomeTone(STATS({ pass: 2, changed: 2 })), "changed");
  assert.equal(outcomeTone(STATS({ pass: 3, changed: 1 })), "pass");
  assert.equal(outcomeTone(STATS({ explored: 2 })), "explored");
  assert.equal(outcomeTone(STATS({ canceled: 2 })), "neutral");
  assert.equal(outcomeTone(STATS()), "neutral");
});

test("needsAttention: a failed check or no verdict", () => {
  assert.ok(needsAttention(STATS({ fail: 1 })));
  assert.ok(needsAttention(STATS({ infra: 1 })));
  assert.ok(needsAttention(STATS({ lost: 1 })));
  // A discovery run has no pass/fail to give, and a cancellation is a decision
  // somebody already made — neither is a thing to chase.
  assert.ok(!needsAttention(STATS({ explored: 3 })));
  assert.ok(!needsAttention(STATS({ canceled: 2 })));
  assert.ok(!needsAttention(STATS({ pass: 4, changed: 1 })));
});

test("pipTone: an in-flight or cancelled run is a gap in the trend", () => {
  assert.equal(pipTone({ status: "done", stats: STATS({ pass: 2 }) }), "pass");
  assert.equal(pipTone({ status: "done", stats: STATS({ fail: 1 }) }), "fail");
  assert.equal(pipTone({ status: "running", stats: STATS({ pass: 1 }) }), "");
  assert.equal(pipTone({ status: "queued", stats: STATS() }), "");
  assert.equal(pipTone({ status: "canceled", stats: STATS({ canceled: 1 }) }), "");
});

test("trigger and title: a run's name is never its ULID", () => {
  assert.equal(triggerWord("manual"), "launched run");
  assert.equal(triggerWord("schedule"), "scheduled run");
  assert.equal(triggerWord("ci"), "CI run");
  assert.equal(triggerWord("api"), "API run");
  // An unknown trigger degrades to something readable, never to a blank.
  assert.equal(triggerWord("webhook"), "webhook");
  assert.equal(triggerWord(undefined), "run");

  assert.equal(runTitle({ trigger: { kind: "manual", note: "after the counter fix" } }), "after the counter fix");
  assert.equal(runTitle({ trigger: { kind: "schedule" } }), "scheduled run");
  assert.equal(runTitle({}), "run");

  // runName: an un-noted run's name carries its start stamp — the one thing
  // that tells three bare launches apart. A note still wins verbatim.
  assert.equal(runName({ trigger: { kind: "manual", note: "after the counter fix" }, created_at: new Date().toISOString() }),
    "after the counter fix");
  assert.match(runName({ trigger: { kind: "manual" }, created_at: new Date().toISOString() }),
    /^launched · \d{1,2}:\d{2}/);
  assert.match(runName({ trigger: { kind: "schedule" }, created_at: new Date().toISOString() }),
    /^scheduled · /);
  // No created_at (an older payload): degrade to the trigger word, never blank.
  assert.equal(runName({ trigger: { kind: "manual" } }), "launched run");
  assert.equal(runName({}), "run");
});

test("soloStory: a finished one-story run skips its own summary screen", () => {
  const one = (status: WebDynamic) => ({ stats: { total: 1, done: status === "running" ? 0 : 1 }, runs: [{ id: "r1", status }] });
  assert.equal(soloStory(one("pass")).id, "r1");
  assert.equal(soloStory(one("fail")).id, "r1");
  // A story that never produced a verdict still has a page worth landing on —
  // it explains why and offers a retry.
  assert.equal(soloStory(one("infra")).id, "r1");
  // Still moving: the run's dashboard (narration, Cancel) is the useful
  // destination until the story lands.
  assert.equal(soloStory(one("running")), null);
  assert.equal(soloStory(one("queued")), null);
  // More than one story, or rows the server capped away, means the run's own
  // page is the only honest destination.
  assert.equal(soloStory({ stats: { total: 2, done: 2 }, runs: [{ id: "a", status: "pass" }, { id: "b", status: "pass" }] }), null);
  assert.equal(soloStory({ stats: { total: 4, done: 4 }, runs: [] }), null);
  assert.equal(soloStory({ stats: { total: 1, done: 1 } }), null, "no rows, no shortcut");
  assert.equal(soloStory(null), null);
});

test("suiteOrder: suites in most-recently-run order, once each", () => {
  const groups = [{ suite_id: "s2" }, { suite_id: "s1" }, { suite_id: "s2" }, { suite_id: "s3" }];
  assert.deepEqual(suiteOrder(groups), ["s2", "s1", "s3"]);
  assert.deepEqual(suiteOrder([]), []);
});
