// The finishing tail: grading overlaps teardown.
//
// Everything after the gate used to be one strict line — manifest, driver
// close, env teardown, VTT, ffmpeg slideshow, THEN the grader call. The current
// pipeline splits it into two jobs that run concurrently and joins them by settling
// both. Three things have to survive that, and each is pinned below:
//
//   1. the overlap is real (the grader is already in flight while the
//      environment is still tearing down);
//   2. the recording permit is handed back at teardown, not at grade;
//   3. every failure combination ends with the SAME status and the same
//      escape behaviour as the serial order — only `env.teardown()` can throw
//      here, and a throw still leaves runCase as it always did (it escapes,
//      and runAll reports the case infra).
//
// Hermetic: the scripted driver rides runCase's driverFactory seam, a scripted
// gateway plays the actor and the grader, and envFactory supplies an
// environment whose teardown the test controls. No browser, no model, no
// container.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { discoverCases } from "../../src/config.ts";
import { runCase } from "../../src/runner.ts";
import { newRunId } from "../../src/trajectory.ts";
import { ScriptedWebDriver } from "../../../../tests/support/scripted-web-driver.ts";

/**
 * The scripted driver plus the one artifact the grader reads off disk. The real
 * web driver writes `final.a11y.txt` in stopRecording (before the gate, and so
 * before the tail this suite exercises); the scripted one writes no artifacts
 * at all, which would make every grade here fail for a reason that has nothing
 * to do with Phase 4.
 */
class GradableDriver extends ScriptedWebDriver {
  #runDir: string;
  constructor(world: LegacyTestValue, runDir: string) {
    super(world);
    this.#runDir = runDir;
  }
  async stopRecording() {
    const text = (this as LegacyTestValue).screens[(this as LegacyTestValue).state].text;
    fs.writeFileSync(path.join(this.#runDir, "final.a11y.txt"), text + "\n");
    return { text, url: this.location() };
  }
}

type LegacyTestValue = any; // SAFETY: run results and manifests are dynamic artifacts

let tmpRoot: LegacyTestValue;
const closers: LegacyTestValue[] = [];

const SCREENS = {
  home: { text: "home screen\n[e1] button Next", elements: ["#done"] },
  details: { text: "details screen\n[e2] button Continue", elements: ["#done"] },
};

const STEPS = [
  { thought: "go on", action: { type: "click", ref: "e1" }, expectation: "the details screen" },
  { thought: "finished", action: { type: "done", summary: "walked the screens" }, expectation: "the journey is complete" },
];

const GOOD_GRADE = {
  score: 90,
  completion: "full",
  efficiency: { assessment: "the journey took the direct path", wasted_steps: 0 },
  findings: [],
  summary: "The scripted journey completed as written.",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * The actor/grader gateway. `onGrade` is awaited before the grade is answered,
 * which is what makes the overlap observable: the test can hold the grader open
 * and check what the rest of the tail did in the meantime.
 */
async function startGateway({ grade = GOOD_GRADE, onGrade = async () => {} }: LegacyTestValue = {}) {
  let step = 0;
  let gradeCalls = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let parsed: LegacyTestValue = null;
      try { parsed = JSON.parse(raw); } catch {}
      const isGrade = (parsed?.tools ?? []).some((t: LegacyTestValue) => t?.function?.name === "grade");
      if (isGrade) {
        gradeCalls++;
        await onGrade();
      }
      const args = isGrade
        ? grade
        : STEPS[step++] ?? { thought: "out of script", action: { type: "give_up", reason: "script exhausted" }, expectation: "the run ends" };
      const body = JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: { role: "assistant", content: "", tool_calls: [{ id: `c${step}`, type: "function", function: { name: isGrade ? "grade" : "step", arguments: JSON.stringify(args) } }] },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve as () => void));
  const { port } = server.address() as import("node:net").AddressInfo;
  const handle = {
    baseUrl: `http://127.0.0.1:${port}`,
    get gradeCalls() { return gradeCalls; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
  closers.push(handle);
  return handle;
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-tail-"));
});

/** A suite of its own per test: a passing record run ACCEPTS a baseline, and a
 *  shared suite would silently turn every later run into an ungraded replay. */
function makeSuite(label: string) {
  const suite = path.join(tmpRoot, `suite-${label}`);
  fs.mkdirSync(path.join(suite, "stories"), { recursive: true });
  // The env is supplied by envFactory, so base_url here is never probed.
  fs.writeFileSync(path.join(suite, "playtest.yaml"), "app:\n  base_url: http://127.0.0.1:1\n");
  fs.writeFileSync(
    path.join(suite, "stories", "journey.yaml"),
    ["story: |", "  Walk the screens.", "success:", '  - element_exists: "#done"', ""].join("\n"),
  );
  return suite;
}

after(async () => {
  for (const c of closers) await c.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PLAYTEST_LLM_BASE_URL;
});

/** One scripted record run with a controllable environment and permits. */
async function record(label: string, { gateway, teardown, permits }: LegacyTestValue) {
  process.env.PLAYTEST_LLM_BASE_URL = gateway.baseUrl;
  const [rc]: LegacyTestValue = await discoverCases([makeSuite(label)]);
  return runCase(rc, {
    runsRoot: path.join(tmpRoot, `runs-${label}`),
    runId: newRunId(),
    grade: true,
    onEvent: () => {},
    permits,
    driverFactory: async (_rc: LegacyTestValue, _env: LegacyTestValue, { runDir }: LegacyTestValue) =>
      new GradableDriver({ start: "home", screens: SCREENS, transitions: { "home e1": "details" } }, runDir),
    envFactory: async () => ({ baseUrl: "http://127.0.0.1:1", managed: false, teardown }),
  });
}

test("the grader is already in flight while the environment is still tearing down", async () => {
  // The gateway holds the grade open until the test releases it; teardown
  // refuses to finish until the grade call has ARRIVED. Under the old serial
  // order (teardown, then grade) that is a deadlock, so this test would hit its
  // guard and say so rather than hang.
  const graderStarted = deferred();
  const holdGrade = deferred();
  const gateway = await startGateway({
    onGrade: async () => { graderStarted.resolve(); await holdGrade.promise; },
  });

  let teardownFinished = false;
  // The whole point of T4.2: what the pool sees at the moment the case says
  // "my recording is over".
  const atRelease: LegacyTestValue = { teardownFinished: null, gradeCalls: null };
  let releases = 0;
  const permits = {
    release: () => {
      releases++;
      atRelease.teardownFinished = teardownFinished;
      atRelease.gradeCalls = gateway.gradeCalls;
    },
    grade: (fn: LegacyTestValue) => Promise.resolve(fn()),
    cpu: (fn: LegacyTestValue) => Promise.resolve(fn()),
  };

  const guard = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("the grader never started before teardown — the tail is still serial")), 8000);
    graderStarted.promise.then(() => clearTimeout(t));
  });
  const teardown = async () => {
    await Promise.race([graderStarted.promise, guard]);
    teardownFinished = true;
  };

  const running = record("overlap", { gateway, teardown, permits });
  await graderStarted.promise;
  // The grader is open. Nothing may be waiting on it: let the tail finish.
  holdGrade.resolve();
  const res: LegacyTestValue = await running;

  assert.equal(res.status, "pass", `the run passes (error: ${res.error ?? "none"})`);
  assert.equal(teardownFinished, true, "teardown completed inside the grader's window");
  assert.equal(res.score, 90, "the overlapped grade still rides on the result");
  assert.equal(releases, 1, "the recording permit is handed back exactly once");
  assert.equal(atRelease.teardownFinished, true, "…after the environment was down");
  assert.equal(atRelease.gradeCalls, 1, "…and while the grader call was already open");
  assert.ok(fs.existsSync(path.join(res.runDir, "grade.json")), "grade.json was written");
});

test("grade ok + teardown ok: the manifest carries the grade and its totals", async () => {
  const gateway = await startGateway();
  const res: LegacyTestValue = await record("both-ok", { gateway, teardown: async () => {} });
  assert.equal(res.status, "pass");
  assert.equal(res.score, 90);
  const manifest = JSON.parse(fs.readFileSync(path.join(res.runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.artifacts.grade, "grade.json");
  assert.ok(fs.existsSync(path.join(res.runDir, manifest.artifacts.grade)), "no artifact is advertised that is missing on disk");
  assert.ok(manifest.totals.tokens.in > 0, "the grade's tokens were folded into the merged totals");
});

test("grade fails + teardown ok: a warning, a nulled artifact, and a passing run", async () => {
  // A grade the schema refuses: gradeRun throws, which has always been a
  // warning rather than a run failure.
  const gateway = await startGateway({ grade: { score: "ninety" } });
  const res: LegacyTestValue = await record("grade-fails", { gateway, teardown: async () => {} });
  assert.equal(res.status, "pass", "a grader failure never changes the run's verdict");
  assert.equal(res.score, null);
  const manifest = JSON.parse(fs.readFileSync(path.join(res.runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.artifacts.grade, null, "the manifest advertises no grade it does not have");
  assert.equal(fs.existsSync(path.join(res.runDir, "grade.json")), false);
});

test("grade ok + teardown throws: the teardown error still escapes runCase", async () => {
  const gateway = await startGateway();
  await assert.rejects(
    record("teardown-fails", { gateway, teardown: async () => { throw new Error("compose down failed"); } }),
    /compose down failed/,
    "the tail's error wins the join, exactly as the serial order let it escape",
  );
  // The join settles both jobs before rethrowing, so the grade that was already
  // in flight completed rather than being abandoned mid-write.
  assert.equal(gateway.gradeCalls, 1);
});

test("grade fails + teardown throws: still the teardown error, and nothing is left half-written", async () => {
  const gateway = await startGateway({ grade: { score: "ninety" } });
  let runDir: string | null = null;
  await assert.rejects(
    record("both-fail", { gateway, teardown: async () => { throw new Error("compose down failed"); } }).catch((e: LegacyTestValue) => {
      runDir = path.join(tmpRoot, "runs-both-fail");
      throw e;
    }),
    /compose down failed/,
    "a grader failure is a warning; only the teardown throw is fatal",
  );
  // The manifest on disk is the completed one written before the tail, not an
  // interrupted placeholder, and it advertises no grade.
  const dirs = fs.readdirSync(runDir!, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("manifest.json"));
  assert.equal(dirs.length, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir!, dirs[0]!), "utf8"));
  assert.equal(manifest.result.status, "pass");
  assert.equal(manifest.artifacts.grade, null);
});
