// Heal re-anchor (docs/contracts/engine.md#act-and-heal): after a replay
// failure hands the actor the wheel, the harness tests each settled agent step
// against the remaining baseline window and a unique match resumes
// deterministic replay — act, act(fail), agent, act … done — instead of
// re-recording the whole tail at model cost.
//
// Hermetic: the scripted in-memory web driver (tests/support/scripted-web-driver.ts)
// rides runCase's driverFactory seam, and the actor is the scripted OpenAI
// gateway — real runner, real trajectory, no browser, no model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { discoverCases } from "../../../src/core/config.ts";
import { runCase } from "../../../src/core/runner.ts";
import { newRunId } from "../../../src/core/trajectory.ts";
import { startScriptedModel } from "../../support/scripted-model.ts";
import { ScriptedWebDriver } from "../../support/scripted-web-driver.ts";

let tmpRoot: LegacyTestValue;
let baseUrl: LegacyTestValue; // a real origin for prepareEnv's reachability probe; the driver never touches it
const servers: LegacyTestValue = [];

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-reanchor-"));
  const probe = http.createServer((req, res) => res.end("ok")) as Omit<ReturnType<typeof http.createServer>, "address"> & { address(): { port: number } }; // SAFETY: a listening TCP server has an AddressInfo result
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => new Promise<LegacyTestValue>((r) => probe.close(r)) });
  baseUrl = `http://127.0.0.1:${probe.address().port}`;
});

after(async () => {
  for (const s of servers) await s.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PLAYTEST_LLM_BASE_URL;
});

function writeSuite(name: LegacyTestValue) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(path.join(dir, "playtest.yaml"), ["app:", `  base_url: ${baseUrl}`, ""].join("\n"));
  fs.writeFileSync(
    path.join(dir, "stories", "journey.yaml"),
    ["story: |", "  Walk the wizard to the receipt screen.", "success:", '  - element_exists: "#done"', ""].join("\n"),
  );
  return dir;
}

const click = (ref: LegacyTestValue, what: LegacyTestValue) => ({ thought: `click ${what}`, action: { type: "click", ref }, expectation: "the next screen" });
const done = { thought: "finished", action: { type: "done", summary: "reached the receipt" }, expectation: "the journey is complete" };

/** One runCase against the scripted driver + scripted actor. */
async function run(suite: LegacyTestValue, label: LegacyTestValue, { world, script }: LegacyTestValue) {
  const model = await startScriptedModel(script);
  servers.push(model);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const events: LegacyTestValue = [];
  const res = await runCase(rc, {
    runsRoot: path.join(tmpRoot, `runs-${label}`),
    runId: newRunId(),
    grade: false,
    onEvent: (e: LegacyTestValue) => events.push(e),
    driverFactory: async () => new ScriptedWebDriver(world),
  });
  delete process.env.PLAYTEST_LLM_BASE_URL;
  return { res, events };
}

const trajectory = (res: LegacyTestValue) =>
  fs.readFileSync(path.join(res.runDir, "trajectory.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.step);

// ---------- scenario 1: local breakage, clean resume ----------

test("a one-step fix re-anchors: replay resumes at the earliest matching baseline step and the tail stays deterministic", async () => {
  const screens = {
    home: { text: "home screen\n[e1] button Next" },
    details: { text: "details screen\n[e2] button Continue" },
    review: { text: "review screen\n[e3] button Finish" },
    receipt: { text: "receipt screen\nOrder placed", elements: ["#done"] },
  };
  const transitions = { "home e1": "details", "details e2": "review", "details e8": "review", "review e3": "receipt" };
  const suite = writeSuite("resume");

  const rec = await run(suite, "resume-record", {
    world: { start: "home", screens, transitions },
    script: [click("e1", "next"), click("e2", "continue"), click("e3", "finish"), done],
  });
  assert.equal(rec.res.status, "pass", `record run passes (error: ${rec.res.error ?? "none"})`);

  const { res, events } = await run(suite, "resume-act", {
    world: { start: "home", screens, transitions, failOnce: ["details e2"] },
    script: [click("e8", "the alternate continue control")],
  });

  assert.equal(res.manifest.mode, "heal", "the replay escalated to heal");
  assert.equal(res.status, "pass", `the re-anchored heal passes (error: ${res.error ?? "none"})`);
  assert.equal(res.manifest.healed, true);

  // Modes read act, act(fail), agent, act … done: a short agent island, not an agent tail.
  const envs = trajectory(res);
  assert.deepEqual(envs.map((e) => e.mode), ["act", "act", "agent", "act", "act"]);
  assert.equal(envs[1].result.ok, false, "the acted step failed");
  assert.equal(envs[1].confusion?.type, "action_failed");

  // The resumed tail replays the baseline's own steps: same acted_from, same
  // actions, and NO tokens — zero model cost after the resume.
  assert.equal(envs[3].acted_from, 3);
  assert.deepEqual(envs[3].action, { type: "click", ref: "e3" });
  assert.equal(envs[4].action.type, "done");
  assert.ok(!("tokens" in envs[3]) && !("tokens" in envs[4]), "no model tokens after the resume");

  // Manifest provenance: one segment, resumed at baseline step 3, one agent step.
  assert.equal(res.manifest.heal.from_step, 2);
  assert.equal(res.manifest.heal.kind, "action_failed");
  assert.deepEqual(res.manifest.heal.segments, [{ from: 2, to: 3 }]);
  assert.equal(res.manifest.heal.agent_steps, 1);

  const resume = events.filter((e: LegacyTestValue) => e.type === "heal_resume");
  assert.deepEqual(resume.map((e: LegacyTestValue) => e.resumedAtStep), [3]);
});

// ---------- scenario 2: ambiguous identical screens never resume ----------

test("two identical future screens are ambiguous: no resume, the heal runs to the end", async () => {
  // The wizard page repeats byte-identically (w1 and w2 share one text), so
  // after the fix the fresh state matches BOTH remaining candidates — the one
  // case where "earliest" could rewind across a loop, excluded by rule.
  const wizard = "wizard screen\n[e2] button Add another\n[e3] button Done adding";
  const screens = {
    start: { text: "start screen\n[e1] button Begin" },
    w1: { text: wizard },
    w2: { text: wizard },
    end: { text: "end screen\nAll added", elements: ["#done"] },
  };
  const transitions = { "start e1": "w1", "start e7": "w1", "w1 e2": "w2", "w2 e3": "end" };
  const suite = writeSuite("ambiguous");

  const rec = await run(suite, "ambiguous-record", {
    world: { start: "start", screens, transitions },
    script: [click("e1", "begin"), click("e2", "add another"), click("e3", "done adding"), done],
  });
  assert.equal(rec.res.status, "pass", `record run passes (error: ${rec.res.error ?? "none"})`);

  const { res, events } = await run(suite, "ambiguous-act", {
    world: { start: "start", screens, transitions, failOnce: ["start e1"] },
    script: [click("e7", "the alternate begin control"), click("e2", "add another"), click("e3", "done adding"), done],
  });

  assert.equal(res.manifest.mode, "heal");
  assert.equal(res.status, "pass", `the heal-to-end run passes (error: ${res.error ?? "none"})`);
  // Ambiguity anchors nothing; the un-resumed segment names its near miss
  // (both wizard candidates are 5 normalized lines from the end screen — the
  // earliest wins the tie) and a warn event says the window never matched.
  assert.deepEqual(res.manifest.heal.segments,
    [{ from: 1, to: null, nearest: { step: 2, diff_lines: 5 } }], "ambiguity anchors nothing");
  assert.equal(res.manifest.heal.agent_steps, 4, "the actor drove to the end, done included");
  assert.equal(events.filter((e: LegacyTestValue) => e.type === "heal_resume").length, 0);
  assert.equal(events.filter((e: LegacyTestValue) => e.type === "warn" && /never re-anchored/.test(e.message ?? "")).length, 1,
    "an un-resumed anchor window warns with its nearest candidate");
  const envs = trajectory(res);
  assert.deepEqual(envs.map((e) => e.mode), ["act", "agent", "agent", "agent", "agent"]);
});

// ---------- scenario 3: a permanent divergence behaves exactly like today ----------

test("a path that never matches again heals to the end — the no-op regression guard", async () => {
  const screens = {
    a: { text: "screen a\n[e1] button One" },
    b: { text: "screen b\n[e2] button Two" },
    c: { text: "screen c\n[e3] button Three" },
    finish: { text: "finish screen\nAll good", elements: ["#done"] },
    x: { text: "detour screen\n[e9] button Onward" },
  };
  const transitions = { "a e1": "b", "b e2": "c", "c e3": "finish", "b e8": "x", "x e9": "finish" };
  const suite = writeSuite("diverge");

  const rec = await run(suite, "diverge-record", {
    world: { start: "a", screens, transitions },
    script: [click("e1", "one"), click("e2", "two"), click("e3", "three"), done],
  });
  assert.equal(rec.res.status, "pass", `record run passes (error: ${rec.res.error ?? "none"})`);

  const { res, events } = await run(suite, "diverge-act", {
    world: { start: "a", screens, transitions, failOnce: ["b e2"] },
    script: [click("e8", "the detour"), click("e9", "onward"), done],
  });

  assert.equal(res.manifest.mode, "heal");
  assert.equal(res.status, "pass", `the heal passes (error: ${res.error ?? "none"})`);
  assert.equal(res.manifest.healed, true);
  assert.deepEqual(res.manifest.heal.segments,
    [{ from: 2, to: null, nearest: { step: 3, diff_lines: 4 } }]);
  assert.equal(res.manifest.heal.from_step, 2);
  assert.equal(events.filter((e: LegacyTestValue) => e.type === "heal_resume").length, 0);
  const envs = trajectory(res);
  assert.deepEqual(envs.map((e) => e.mode), ["act", "act", "agent", "agent", "agent"], "identical shape to a pre-re-anchor heal");
});

// ---------- scenario 4: resume, re-fail, heal again — forward only ----------

test("a second failure after a resume heals again from a strictly later step", async () => {
  const screens = {
    s1: { text: "screen 1\n[e1] button Go" },
    s2: { text: "screen 2\n[e2] button Go" },
    s3: { text: "screen 3\n[e3] button Go" },
    s4: { text: "screen 4\n[e4] button Go" },
    s5: { text: "screen 5\n[e5] button Go" },
    fin: { text: "final screen\nComplete", elements: ["#done"] },
  };
  const transitions = {
    "s1 e1": "s2", "s2 e2": "s3", "s3 e3": "s4", "s4 e4": "s5", "s5 e5": "fin",
    "s2 f2": "s3", "s4 f4": "s5", // the actor's fixes
  };
  const suite = writeSuite("refail");

  const rec = await run(suite, "refail-record", {
    world: { start: "s1", screens, transitions },
    script: [click("e1", "go"), click("e2", "go"), click("e3", "go"), click("e4", "go"), click("e5", "go"), done],
  });
  assert.equal(rec.res.status, "pass", `record run passes (error: ${rec.res.error ?? "none"})`);

  const { res, events } = await run(suite, "refail-act", {
    world: { start: "s1", screens, transitions, failOnce: ["s2 e2", "s4 e4"] },
    script: [click("f2", "the first fix"), click("f4", "the second fix")],
  });

  assert.equal(res.manifest.mode, "heal");
  assert.equal(res.status, "pass", `the twice-healed run passes (error: ${res.error ?? "none"})`);
  assert.deepEqual(res.manifest.heal.segments, [{ from: 2, to: 3 }, { from: 4, to: 5 }]);
  assert.ok(res.manifest.heal.segments[1].from > res.manifest.heal.segments[0].to, "each heal point is strictly beyond the previous resume");
  assert.equal(res.manifest.heal.from_step, 2, "manifest provenance keeps the FIRST divergence");
  assert.equal(res.manifest.heal.agent_steps, 2);
  assert.deepEqual(events.filter((e: LegacyTestValue) => e.type === "heal_resume").map((e: LegacyTestValue) => e.resumedAtStep), [3, 5]);
  const envs = trajectory(res);
  assert.deepEqual(envs.map((e) => e.mode), ["act", "act", "agent", "act", "act", "agent", "act", "act"]);
});
