// The pre-action effect token is fetched only where something can read it
// (docs/backlog/perf/BUILD_PLAN.md, T1.2).
//
// `detectConfusion()`'s no_effect rule compares a before/after token for exactly
// three verbs — click, tap, type — and treats a null before-token as "no
// signal". recordLoop used to pay `driver.effectToken()` on EVERY non-terminal
// action anyway, which on mobile is a live Appium alert probe on every scroll,
// swipe, and back. So the gate here is a pure saving, and the two things this
// suite pins are that (1) the untokenable verbs stop asking, and (2) no_effect
// detection on the verbs that do ask is unchanged.
//
// Hermetic: the scripted driver rides runCase's driverFactory seam and the
// scripted OpenAI gateway plays the actor — real runner, real writer, no browser
// and no model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { discoverCases } from "../../src/config.ts";
import { runCase } from "../../src/runner.ts";
import { newRunId } from "../../src/trajectory.ts";
import { startScriptedModel } from "../../../../tests/support/scripted-model.ts";
import { ScriptedWebDriver } from "../../../../tests/support/scripted-web-driver.ts";

let tmpRoot: LegacyTestValue;
let baseUrl: LegacyTestValue; // a real origin for prepareEnv's reachability probe
const servers: LegacyTestValue = [];

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-token-"));
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

/**
 * The scripted driver plus the two things this suite needs: a counter on
 * `effectToken()`, and success for the verbs the base fixture rejects (it only
 * models clicks). The token is the screen NAME alone — no tick — so a click that
 * lands on the same screen reads as a genuine no-op, which is the trajectory the
 * no_effect rule exists for.
 */
class CountingDriver extends ScriptedWebDriver {
  tokenCalls = 0;

  async effectToken() {
    this.tokenCalls += 1;
    return this.state;
  }

  async execute(action: LegacyTestValue): Promise<LegacyTestValue> {
    if (action?.type !== "click") {
      return {
        ok: true,
        error: null,
        settle_ms: 1,
        perf: { input_to_paint_ms: null, long_tasks_ms: 0, requests: 0, js_errors: 0, nav: null },
        network: { requests: [] },
        har_entries: [],
        url: this.location(),
        resolution: { locator: null, bbox: null },
      };
    }
    return super.execute(action);
  }
}

const SCREENS = {
  home: { text: "home screen\n[e1] button Next", elements: ["#done"] },
  details: { text: "details screen\n[e2] button Continue", elements: ["#done"] },
};

/** One scripted record run in its own suite, against a driver the caller owns. */
async function record(label: LegacyTestValue, script: LegacyTestValue, driver: LegacyTestValue) {
  const suite = path.join(tmpRoot, label);
  fs.mkdirSync(path.join(suite, "stories"), { recursive: true });
  fs.writeFileSync(path.join(suite, "playtest.yaml"), ["app:", `  base_url: ${baseUrl}`, ""].join("\n"));
  fs.writeFileSync(
    path.join(suite, "stories", "journey.yaml"),
    ["story: |", "  Walk the screens.", "success:", '  - element_exists: "#done"', ""].join("\n"),
  );
  const model = await startScriptedModel(script);
  servers.push(model);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const [rc]: LegacyTestValue = await discoverCases([suite]);
  const res = await runCase(rc, {
    runsRoot: path.join(tmpRoot, `runs-${label}`),
    runId: newRunId(),
    grade: false,
    onEvent: () => {},
    driverFactory: async () => driver,
  });
  delete process.env.PLAYTEST_LLM_BASE_URL;
  return res;
}

const envelopes = (runDir: LegacyTestValue) =>
  fs.readFileSync(path.join(runDir, "trajectory.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.step);

const spans = (runDir: LegacyTestValue) =>
  fs.readFileSync(path.join(runDir, "perf.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));

test("scroll, select, wait, back, and navigate steps never ask for an effect token", async () => {
  const driver = new CountingDriver({ start: "home", screens: SCREENS, transitions: { "home e1": "details" } });
  const res = await record("untokenable", [
    { thought: "look further down", action: { type: "scroll", direction: "down" }, expectation: "more of the page" },
    { thought: "pick an option", action: { type: "select", ref: "e1", value: "two" }, expectation: "the option is chosen" },
    { thought: "give it a moment", action: { type: "wait", seconds: 0.1 }, expectation: "the page settles" },
    { thought: "go back", action: { type: "back" }, expectation: "the previous page" },
    { thought: "start over", action: { type: "navigate", url: "/" }, expectation: "the home page" },
    { thought: "finished", action: { type: "done", summary: "walked the page" }, expectation: "the journey is complete" },
  ], driver);

  assert.equal(res.status, "pass", `the scripted record run passes (error: ${res.error ?? "none"})`);
  // Five executed actions, not one of which any confusion rule could have read a
  // token for — so not one round-trip was spent fetching one.
  assert.equal(driver.tokenCalls, 0, "no transport call was made for a token nothing consumes");
  const steps = envelopes(res.runDir);
  assert.deepEqual(steps.map((e: LegacyTestValue) => e.agent.action.type), ["scroll", "select", "wait", "back", "navigate", "done"]);
  // Skipping the token is not a changed verdict: these steps carry no confusion,
  // exactly as before.
  for (const e of steps) assert.equal(e.confusion, undefined, `${e.agent.action.type} must stay unflagged`);
  assert.equal(spans(res.runDir).some((s: LegacyTestValue) => s.span === "effect_token"), false, "no effect_token span was opened at all");
});

test("click still fetches both tokens and still detects a no-effect step", async () => {
  // Two clicks on `e1`: the first moves home -> details, the second lands on a
  // transition that returns to the SAME screen, so the token cannot move.
  const driver = new CountingDriver({
    start: "home",
    screens: SCREENS,
    transitions: { "home e1": "details", "details e2": "details" },
  });
  const res = await record("tokenable", [
    { thought: "go on", action: { type: "click", ref: "e1" }, expectation: "the details screen" },
    { thought: "continue", action: { type: "click", ref: "e2" }, expectation: "something new" },
    { thought: "finished", action: { type: "done", summary: "walked the screens" }, expectation: "the journey is complete" },
  ], driver);

  assert.equal(res.status, "pass", `the scripted record run passes (error: ${res.error ?? "none"})`);
  const steps = envelopes(res.runDir);
  assert.equal(steps[0].confusion, undefined, "a click that changed the screen is not confusion");
  assert.deepEqual(steps[1].confusion, {
    type: "no_effect",
    note: "no requests, no DOM or input changes, url unchanged",
  });
  // Two before-tokens, plus one after-token for each click whose gate opened.
  assert.equal(driver.tokenCalls, 4);
  const tokenSpans = spans(res.runDir).filter((s: LegacyTestValue) => s.span === "effect_token");
  assert.deepEqual(tokenSpans.map((s: LegacyTestValue) => `${s.step}:${s.meta.when}`), ["1:before", "1:after", "2:before", "2:after"]);
});
