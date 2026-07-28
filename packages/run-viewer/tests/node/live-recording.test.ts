// End to end, hermetically: a real recording run writing a real run directory
// in this process, while a fetch-based client follows the live endpoint the way
// the viewer will (docs/backlog/live-runs/DESIGN.md).
//
// What it pins: the follower observes every envelope exactly once and in append
// order — ordering is sacred — sees them while the run is still executing rather
// than in one batch at the end, and then observes the terminal transition. No
// browser, no model, no platform: the scripted driver rides runCase's
// driverFactory seam and a loopback gateway plays the actor.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { serveRun } from "../../src/node/index.ts";
import { runCase } from "@playtest/core/run";
import { discoverCases } from "@playtest/core/suite";
import { newRunId } from "@playtest/core/artifacts";
import { ScriptedWebDriver } from "../../../../tests/support/scripted-web-driver.ts";
import { startScriptedModel } from "../../../../tests/support/scripted-model.ts";

type LegacyTestValue = any; // SAFETY: run results and live responses are dynamic

let tmpRoot: string;
const closers: LegacyTestValue[] = [];

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-livrec-"));
});

after(async () => {
  for (const c of closers) await c.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PLAYTEST_LLM_BASE_URL;
});

const SCREENS = {
  s0: { text: "screen 0\n[e1] button Next", elements: ["#done"] },
  s1: { text: "screen 1\n[e1] button Next", elements: ["#done"] },
  s2: { text: "screen 2\n[e1] button Next", elements: ["#done"] },
  s3: { text: "screen 3\n[e1] button Next", elements: ["#done"] },
  s4: { text: "screen 4\n[e1] button Next", elements: ["#done"] },
};
const TRANSITIONS = { "s0 e1": "s1", "s1 e1": "s2", "s2 e1": "s3", "s3 e1": "s4" };
const STEPS = [
  { thought: "go on", action: { type: "click", ref: "e1" }, expectation: "the next screen" },
  { thought: "go on", action: { type: "click", ref: "e1" }, expectation: "the next screen" },
  { thought: "go on", action: { type: "click", ref: "e1" }, expectation: "the next screen" },
  { thought: "go on", action: { type: "click", ref: "e1" }, expectation: "the next screen" },
  { thought: "finished", action: { type: "done", summary: "walked the screens" }, expectation: "the journey is complete" },
];

/** A driver that takes visible time per step, so "mid-run" is a real window. */
class PacedDriver extends ScriptedWebDriver {
  async captureSnapshot() {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return super.captureSnapshot();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a viewer client follows a live recording run to its seal, in order", async () => {
  const suite = path.join(tmpRoot, "suite");
  fs.mkdirSync(path.join(suite, "stories"), { recursive: true });
  fs.writeFileSync(path.join(suite, "playtest.yaml"), "app:\n  base_url: http://127.0.0.1:1\n");
  fs.writeFileSync(
    path.join(suite, "stories", "walk.yaml"),
    ["story: |", "  Walk the screens.", "success:", '  - element_exists: "#done"', ""].join("\n"),
  );

  const gateway = await startScriptedModel(STEPS as LegacyTestValue);
  closers.push(gateway);
  process.env.PLAYTEST_LLM_BASE_URL = gateway.baseUrl;

  const runsRoot = path.join(tmpRoot, "runs");
  const runId = newRunId();
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const rel = [runId, ...rc.id.split("/")].join("/");
  const runDir = path.join(runsRoot, runId, ...rc.id.split("/"));

  const server: LegacyTestValue = await serveRun(runsRoot, { port: 0, open: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const running = runCase(rc, {
      runsRoot,
      runId,
      grade: false,
      onEvent: () => {},
      driverFactory: async () => new PacedDriver({ start: "s0", screens: SCREENS, transitions: TRANSITIONS }),
      envFactory: async () => ({ baseUrl: "http://127.0.0.1:1", managed: false, teardown: async () => {} }),
    });

    // The viewer opens on a run that already exists, so wait for the run dir the
    // way a user reaching for `playtest view` would.
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(path.join(runDir, "events.jsonl")) && Date.now() < deadline) await sleep(10);

    const seen: string[] = [];
    let linesWhileOpen = 0;
    let polls = 0;
    let terminal: LegacyTestValue = null;
    let cursor = 0;
    while (Date.now() < deadline) {
      polls++;
      const body: LegacyTestValue = await (await fetch(`${base}/run/${rel}/live?after=${cursor}&wait=2`)).json();
      assert.equal(body.reset, false, "an append-only run never invalidates a cursor");
      assert.equal(body.next, cursor + body.lines.length, "the cursor advances by exactly what was delivered");
      cursor = body.next;
      seen.push(...body.lines);
      if (body.open) linesWhileOpen += body.lines.length;
      if (!body.open && !body.has_more) {
        terminal = body;
        break;
      }
    }
    const result: LegacyTestValue = await running;

    assert.ok(terminal, "the follower observed the terminal transition");
    assert.equal(result.status, "pass", `the run passes (error: ${result.error ?? "none"})`);
    assert.ok(polls > 1, "the follower polled rather than taking one final batch");
    assert.ok(linesWhileOpen > 0, "envelopes were observed while the run was still executing");

    const onDisk = fs
      .readFileSync(path.join(runDir, "trajectory.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim());
    assert.deepEqual(seen, onDisk, "every envelope, exactly once, in append order");
    assert.equal(onDisk.length, STEPS.length, "…and the whole journey");

    // The seal is what the viewer reloads through: the manifest is final, and
    // the endpoint keeps answering open: false.
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")).result.status, "pass");
    const again: LegacyTestValue = await (await fetch(`${base}/run/${rel}/live?after=${cursor}`)).json();
    assert.equal(again.open, false, "a sealed run stays sealed");
  } finally {
    server.close();
  }
});
