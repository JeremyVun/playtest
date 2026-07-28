// Ctrl-C is phase-aware (docs/contracts/engine.md#progress-events): the
// synchronous SIGINT flusher writes the interrupted placeholder as it always
// has, and now also appends a terminal event so a run dir that stops changing
// says so — the durable seal record local liveness reads.
//
// The three phases, and the one thing that must not change:
//
//   before the final manifest — interrupted placeholder + interrupted terminal
//     event; the run seals as interrupted;
//   during the finishing tail — the flusher already refuses to clobber the
//     final manifest, so only the terminal event is appended, sealing honestly
//     with grade and video possibly absent;
//   after the tail — the real case_end is already on disk and the flusher is
//     unregistered: nothing is appended.
//
// The flusher stays synchronous, re-raises, and preserves exit code 130, which
// the child-process case below pins directly. Hermetic: the scripted driver
// rides runCase's driverFactory seam and a loopback gateway plays the actor.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { discoverCases } from "../../src/config.ts";
import { runCase, _sigintFlushers } from "../../src/runner.ts";
import { newRunId } from "../../src/trajectory.ts";
import { ScriptedWebDriver } from "../../../../tests/support/scripted-web-driver.ts";
import { startScriptedModel } from "../../../../tests/support/scripted-model.ts";

type LegacyTestValue = any; // SAFETY: run results and manifests are dynamic artifacts

let tmpRoot: string;
const closers: LegacyTestValue[] = [];

const SCREENS = {
  s0: { text: "screen 0\n[e1] button Next", elements: ["#done"] },
  s1: { text: "screen 1\n[e1] button Next", elements: ["#done"] },
  s2: { text: "screen 2\n[e1] button Next", elements: ["#done"] },
};
const TRANSITIONS = { "s0 e1": "s1", "s1 e1": "s2" };
const STEPS = [
  { thought: "go on", action: { type: "click", ref: "e1" }, expectation: "the next screen" },
  { thought: "go on", action: { type: "click", ref: "e1" }, expectation: "the next screen" },
  { thought: "finished", action: { type: "done", summary: "walked the screens" }, expectation: "the journey is complete" },
];

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-sigint-"));
});

after(async () => {
  for (const c of closers) await c.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PLAYTEST_LLM_BASE_URL;
});

/** Exactly what the installed SIGINT handler does before it re-raises. */
function flushAsSigintWould() {
  for (const flush of _sigintFlushers) flush();
}

function suiteFor(label: string) {
  const suite = path.join(tmpRoot, `suite-${label}`);
  fs.mkdirSync(path.join(suite, "stories"), { recursive: true });
  fs.writeFileSync(path.join(suite, "playtest.yaml"), "app:\n  base_url: http://127.0.0.1:1\n");
  fs.writeFileSync(
    path.join(suite, "stories", "walk.yaml"),
    ["story: |", "  Walk the screens.", "success:", '  - element_exists: "#done"', ""].join("\n"),
  );
  return suite;
}

const readEvents = (dir: string) =>
  fs
    .readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

async function record(label: string, { onSnapshot, teardown = async (_runDir: string) => {} }: LegacyTestValue = {}) {
  const gateway = await startScriptedModel(STEPS as LegacyTestValue);
  closers.push(gateway);
  process.env.PLAYTEST_LLM_BASE_URL = gateway.baseUrl;
  const [rc]: LegacyTestValue = await discoverCases([suiteFor(label)]);
  const runsRoot = path.join(tmpRoot, `runs-${label}`);
  const runId = newRunId();
  const runDir = path.join(runsRoot, runId, ...rc.id.split("/"));
  class Paced extends ScriptedWebDriver {
    async captureSnapshot() {
      onSnapshot?.(runDir);
      return super.captureSnapshot();
    }
  }
  const result: LegacyTestValue = await runCase(rc, {
    runsRoot,
    runId,
    grade: false,
    onEvent: () => {},
    driverFactory: async () => new Paced({ start: "s0", screens: SCREENS, transitions: TRANSITIONS }),
    envFactory: async () => ({ baseUrl: "http://127.0.0.1:1", managed: false, teardown: () => teardown(runDir) }),
  });
  return { result, runDir };
}

test("before the final manifest: the interrupted placeholder plus an interrupted terminal event", async () => {
  let snapshotAt = 0;
  let sealed: LegacyTestValue = null;
  const { result, runDir } = await record("before-tail", {
    onSnapshot: (dir: string) => {
      // Second step: the run is mid-recording, well before the gate.
      if (++snapshotAt !== 2 || sealed) return;
      flushAsSigintWould();
      sealed = {
        manifest: JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")),
        events: readEvents(dir),
      };
    },
  });
  assert.ok(sealed, "the flush ran mid-recording");
  assert.equal(sealed.manifest.result.status, "interrupted", "the placeholder is refreshed with partial totals");
  const terminal = sealed.events.at(-1);
  assert.equal(terminal.type, "case_end", "the event stream carries a terminal event");
  assert.equal(terminal.status, "interrupted");
  assert.equal(terminal.interrupted, true, "…marked as the interrupt seal, not a graded end");
  assert.ok(sealed.events.some((e: LegacyTestValue) => e.type === "case_start"), "the open bracket is still there");
  // The interrupt seal never changes the run: in production the process dies
  // here, but nothing about the case was touched.
  assert.equal(result.status, "pass");
  assert.ok(fs.existsSync(path.join(runDir, "trajectory.jsonl")));
});

test("during the finishing tail: an honest seal that does not clobber the final manifest", async () => {
  let sealed: LegacyTestValue = null;
  const { result } = await record("in-tail", {
    // teardown runs inside the tail, after the final manifest was written and
    // while grade/video may still be outstanding.
    teardown: async (dir: string) => {
      flushAsSigintWould();
      sealed = {
        manifest: JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")),
        events: readEvents(dir),
        grade: fs.existsSync(path.join(dir, "grade.json")),
      };
    },
  });
  assert.ok(sealed, "the flush ran inside the tail");
  assert.equal(sealed.manifest.result.status, "pass", "the completed manifest survives — no interrupted placeholder");
  assert.equal(sealed.grade, false, "grade may legally be absent at the interrupt");
  const terminal = sealed.events.at(-1);
  assert.equal(terminal.type, "case_end");
  assert.equal(terminal.interrupted, true);
  assert.equal(result.status, "pass");
});

test("after the tail: the run's own case_end is on disk and the flusher is gone", async () => {
  const { runDir } = await record("after-tail");
  assert.equal(_sigintFlushers.size, 0, "every return path unregisters the flusher");
  const before = readEvents(runDir);
  flushAsSigintWould();
  const after = readEvents(runDir);
  assert.deepEqual(after, before, "a Ctrl-C after the tail appends nothing");
  const ends = before.filter((e: LegacyTestValue) => e.type === "case_end");
  assert.equal(ends.length, 1, "exactly one terminal event");
  assert.equal(ends[0].interrupted, undefined, "…the run's own, not an interrupt seal");
  assert.equal(ends[0].status, "pass");
});

test("the flusher stays synchronous, re-raises, and lets SIGINT terminate the process", () => {
  // 128 + SIGINT(2) = the 130 the CLI contract pins
  // (docs/contracts/interfaces.md#exit-codes-and-errors): the handler removes
  // itself and re-raises, so the DEFAULT action terminates the process —
  // observable here as death by SIGINT rather than a normal exit.
  const runner = fileURLToPath(new URL("../../src/runner.ts", import.meta.url));
  const marker = path.join(tmpRoot, "flushed.txt");
  const child = path.join(tmpRoot, "sigint-child.mjs");
  fs.writeFileSync(
    child,
    [
      `import fs from "node:fs";`,
      `const { _sigintFlushers, _installSigintHandler } = await import(${JSON.stringify(runner)});`,
      `_sigintFlushers.add(() => fs.writeFileSync(${JSON.stringify(marker)}, "flushed"));`,
      `_installSigintHandler();`,
      `process.kill(process.pid, "SIGINT");`,
      `setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, "survived"); process.exit(7); }, 2000);`,
      "",
    ].join("\n"),
  );
  const out = spawnSync(process.execPath, [child], { encoding: "utf8", timeout: 60_000 });
  assert.equal(out.signal, "SIGINT", `the process died from the re-raised signal (status ${out.status})`);
  assert.equal(out.status, null, "…rather than exiting normally");
  assert.equal(fs.readFileSync(marker, "utf8"), "flushed", "the synchronous flush completed before the process died");
});
