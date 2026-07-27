// Pins core diffTracks (docs/contracts/artifacts.md#trajectory-projections):
// LCS over the action-track step signature
// (type | locator/url | text/value | direction), ops + {same, del, add} summary.
// The viewer keeps a byte-equivalent inline signature (packages/run-viewer/src/web/app.ts) — a
// change here that isn't mirrored there is contract drift.
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffTracks, actionTrack } from "../../src/trajectory.ts";

let n = 0;
const step = (action: LegacyTestValue, locator: string | null = null, over: LegacyTestValue = {}): LegacyTestValue => ({
  step: ++n,
  action,
  resolution: locator === undefined ? null : { locator },
  result: { ok: true },
  ...over,
});
const click = (loc: string) => step({ type: "click" }, loc);
const type = (loc: string, text: string) => step({ type: "type", text }, loc);

test("identical tracks are all same", () => {
  const a = [click("role=button[name='Add']"), type("role=textbox", "milk")];
  const b = [click("role=button[name='Add']"), type("role=textbox", "milk")];
  const { ops, summary } = diffTracks(a, b);
  assert.deepEqual(summary, { same: 2, del: 0, add: 0 });
  assert.deepEqual(ops.map((o) => o.op), ["same", "same"]);
  // ops carry the envelopes themselves, both sides on a "same" row
  assert.equal(ops[0]!.a, a[0]); // SAFETY: two identical input steps produce two diff rows
  assert.equal(ops[0]!.b, b[0]); // SAFETY: two identical input steps produce two diff rows
});

test("insertion and removal land as add/del around the common subsequence", () => {
  const a = [click("A"), click("B"), click("C")];
  const b = [click("A"), click("X"), click("C")];
  const { ops, summary } = diffTracks(a, b);
  assert.deepEqual(summary, { same: 2, del: 1, add: 1 });
  assert.deepEqual(ops.map((o) => o.op), ["same", "del", "add", "same"]);
  assert.equal(ops[1]!.b, null); // SAFETY: the asserted operation sequence proves this row exists
  assert.equal(ops[2]!.a, null); // SAFETY: the asserted operation sequence proves this row exists
});

test("signature: changed typed text, select value, or direction is NOT same", () => {
  // text
  assert.deepEqual(diffTracks([type("T", "milk")], [type("T", "eggs")]).summary, { same: 0, del: 1, add: 1 });
  // select value
  const sel = (v: string) => step({ type: "select", value: v }, "role=combobox");
  assert.deepEqual(diffTracks([sel("red")], [sel("blue")]).summary, { same: 0, del: 1, add: 1 });
  // scroll direction
  const scroll = (d: string) => step({ type: "scroll", direction: d }, "role=main");
  assert.deepEqual(diffTracks([scroll("down")], [scroll("up")]).summary, { same: 0, del: 1, add: 1 });
});

test("signature falls back to action.url when no locator resolved (goto steps)", () => {
  const go = (url: string) => step({ type: "goto", url }, null);
  assert.deepEqual(diffTracks([go("/a")], [go("/a")]).summary, { same: 1, del: 0, add: 0 });
  assert.deepEqual(diffTracks([go("/a")], [go("/b")]).summary, { same: 0, del: 1, add: 1 });
});

test("acted steps compare equal to their agent-decided originals (actionOf)", () => {
  // A baseline records agent.action; an acted replay records action — same signature.
  const recorded = step(undefined, "role=button[name='Add']", { agent: { action: { type: "click" } }, action: undefined });
  delete recorded.action;
  const acted = step({ type: "click" }, "role=button[name='Add']");
  assert.deepEqual(diffTracks([recorded], [acted]).summary, { same: 1, del: 0, add: 0 });
});

test("empty sides: everything added / everything removed", () => {
  const b = [click("A"), click("B")];
  assert.deepEqual(diffTracks([], b).summary, { same: 0, del: 0, add: 2 });
  assert.deepEqual(diffTracks(b, []).summary, { same: 0, del: 2, add: 0 });
  assert.deepEqual(diffTracks([], []), { ops: [], summary: { same: 0, del: 0, add: 0 } });
});

test("composes with actionTrack: terminal and failed steps never reach the diff", () => {
  const envelopes = [
    click("A"),
    step({ type: "click" }, "B", { result: { ok: false } }), // failed — excluded
    step({ type: "done" }, null),                            // terminal — excluded
  ];
  const track = actionTrack(envelopes);
  assert.equal(track.length, 1);
  assert.deepEqual(diffTracks(track, track).summary, { same: 1, del: 0, add: 0 });
});
