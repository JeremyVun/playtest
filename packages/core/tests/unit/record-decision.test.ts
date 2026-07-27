// The record/act preflight (docs/contracts/engine.md#run-lifecycle): a
// baseline recorded under a different snapshot format is unreadable by the
// current serializer — replaying it would drift on every page even when the
// app is unchanged (the hobart incident: a v5 baseline under the v6 landmark
// demotion healed at step 2 and could never re-anchor). A format mismatch
// forces a re-record exactly as a story change does; a baseline with no
// recorded format stays a wildcard and replays.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { willRecord, nearestAnchor } from "../../src/runner.ts";
import { SNAPSHOT_FORMATS, baselinePaths, storyHash } from "../../src/trajectory.ts";

const STORY = "Buy the plan.";
const PERSONA = "tester";

let suiteDir: string;
let caseFile: string;

before(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-record-decision-"));
  fs.writeFileSync(path.join(suiteDir, "playtest.yaml"), "app:\n  base_url: http://127.0.0.1:9\n");
  fs.mkdirSync(path.join(suiteDir, "stories"));
  caseFile = path.join(suiteDir, "stories", "case.yaml");
  fs.writeFileSync(caseFile, `story: ${STORY}\n`);
});

after(() => {
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

function writeBaseline({ pins }: LegacyTestValue) {
  const p = baselinePaths(caseFile);
  fs.mkdirSync(path.dirname(p.traj), { recursive: true });
  // A minimal replayable baseline: one executed step plus the closing done().
  fs.writeFileSync(p.traj, [
    JSON.stringify({ step: 1, mode: "agent", agent: { action: { type: "click", ref: "e1" } }, resolution: { locator: "role=button[name=\"Buy\"]" }, result: { ok: true } }),
    JSON.stringify({ step: 2, mode: "agent", agent: { action: { type: "done", summary: "bought" } } }),
    "",
  ].join("\n"));
  const meta = { story_hash: storyHash(STORY, PERSONA), ...(pins ? { pins } : {}) };
  fs.writeFileSync(p.meta, JSON.stringify(meta));
}

const rc = (driver = "web"): LegacyTestValue => ({
  id: "case",
  file: caseFile,
  story: STORY,
  persona: PERSONA,
  mode: "journey",
  env: { driver },
});

test("a baseline recorded under the current snapshot format replays", () => {
  writeBaseline({ pins: { snapshot_format: SNAPSHOT_FORMATS.web } });
  assert.equal(willRecord(rc()), false);
});

test("a snapshot-format mismatch forces a re-record, like a story change", () => {
  writeBaseline({ pins: { snapshot_format: "a11y-text-v5" } });
  assert.equal(willRecord(rc()), true);
});

test("a legacy baseline with no recorded format is a wildcard and still replays", () => {
  writeBaseline({ pins: {} });
  assert.equal(willRecord(rc()), false);
  writeBaseline({ pins: null });
  assert.equal(willRecord(rc()), false);
});

test("the format pin is per driver: a web-format baseline under the mobile driver re-records", () => {
  writeBaseline({ pins: { snapshot_format: SNAPSHOT_FORMATS.web } });
  assert.equal(willRecord(rc("mobile")), true);
  writeBaseline({ pins: { snapshot_format: SNAPSHOT_FORMATS.mobile } });
  assert.equal(willRecord(rc("mobile")), false);
});

// nearestAnchor: the post-mortem for a heal segment that never re-anchored.
// A systematic one-line difference on every candidate — a serializer change,
// not app drift — must surface as "nearest is step N, 1 line different".
const stubDriver: LegacyTestValue = { normalizeSnapshot: (text: string) => text };

test("nearestAnchor names the closest candidate and its line distance", () => {
  const live = "heading Checkout\ntext total $10\nbutton Pay";
  const window = [
    { step: 4, snapshot_text: "heading Checkout\ntext total $10\nbutton Pay now" },
    { step: 7, snapshot_text: "heading Receipt\ntext order 42\nbutton Done" },
  ];
  const near = nearestAnchor(stubDriver, live, window);
  assert.deepEqual(near, { step: 4, diff_lines: 2 }, "one changed line counts once per side");
});

test("nearestAnchor returns null without an oracle on either side", () => {
  assert.equal(nearestAnchor(stubDriver, null, [{ step: 4, snapshot_text: "x" }]), null);
  assert.equal(nearestAnchor(stubDriver, "x", [{ step: 4 }]), null);
});
