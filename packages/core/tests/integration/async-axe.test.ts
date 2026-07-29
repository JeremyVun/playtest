import { after, before, test } from "node:test";
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

const SCREENS = {
  home: { text: "home\n[e1] button Next" },
  details: { text: "details\n[e2] button Continue", elements: ["#after"] },
  receipt: { text: "receipt", elements: ["#after"] },
};
const TRANSITIONS = { "home e1": "details", "details e2": "receipt" };
interface AgentStep {
  thought: string;
  action: Record<string, unknown>;
  expectation: string;
}
const CLICK_1: AgentStep = { thought: "next", action: { type: "click", ref: "e1" }, expectation: "details" };
const CLICK_2: AgentStep = { thought: "continue", action: { type: "click", ref: "e2" }, expectation: "receipt" };
const DONE: AgentStep = { thought: "done", action: { type: "done", summary: "finished" }, expectation: "complete" };

let tmpRoot: string;
let probeUrl: string;
const servers: Array<{ close(): Promise<unknown> }> = [];

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-async-axe-"));
  const probe = http.createServer((_req, res) => res.end("ok")) as Omit<ReturnType<typeof http.createServer>, "address"> & {
    address(): import("node:net").AddressInfo;
  };
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  probeUrl = `http://127.0.0.1:${probe.address().port}`;
  servers.push({
    close: () => new Promise<void>((resolve) => probe.close(() => resolve())),
  });
});

after(async () => {
  delete process.env.PLAYTEST_LLM_BASE_URL;
  for (const server of servers.reverse()) await server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface AxeDriverOptions {
  delayMs?: number;
  rejectCalls?: number[];
  executeDelayMs?: number;
  throwOnSnapshot?: number;
  transitions?: Record<string, string>;
}

class AxeDriver extends ScriptedWebDriver {
  readonly operations: string[] = [];
  readonly overlaps: string[] = [];
  #scanActive = false;
  #pageOperation: string | null = null;
  #delayMs: number;
  #rejectCalls: Set<number>;
  #executeDelayMs: number;
  #throwOnSnapshot: number;
  #snapshotCalls = 0;
  #axeCalls = 0;

  constructor({
    delayMs = 0,
    rejectCalls = [],
    executeDelayMs = 0,
    throwOnSnapshot = 0,
    transitions = TRANSITIONS,
  }: AxeDriverOptions = {}) {
    super({ start: "home", screens: SCREENS, transitions });
    this.#delayMs = delayMs;
    this.#rejectCalls = new Set(rejectCalls);
    this.#executeDelayMs = executeDelayMs;
    this.#throwOnSnapshot = throwOnSnapshot;
  }

  async #page<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.#scanActive) this.overlaps.push(`${name} during axe`);
    this.#pageOperation = name;
    this.operations.push(`${name}:start`);
    try {
      return await fn();
    } finally {
      this.operations.push(`${name}:end`);
      this.#pageOperation = null;
    }
  }

  override captureSnapshot() {
    return this.#page("snapshot", async () => {
      this.#snapshotCalls += 1;
      if (this.#snapshotCalls === this.#throwOnSnapshot) throw new Error("seeded snapshot failure");
      return super.captureSnapshot();
    });
  }

  override effectToken() {
    return this.#page("effect", () => super.effectToken());
  }

  override execute(action: Parameters<ScriptedWebDriver["execute"]>[0]) {
    return this.#page("execute", async () => {
      if (this.#executeDelayMs) await new Promise((resolve) => setTimeout(resolve, this.#executeDelayMs));
      const result = await super.execute(action);
      return { ...result, axe_deferred_at: performance.now() };
    });
  }

  override finalPageCheck(query: string) {
    return this.#page("final-check", () => super.finalPageCheck(query));
  }

  async captureAxe() {
    this.#axeCalls += 1;
    const call = this.#axeCalls;
    if (this.#pageOperation) this.overlaps.push(`axe during ${this.#pageOperation}`);
    this.#scanActive = true;
    this.operations.push(`axe-${call}:start`);
    try {
      if (this.#delayMs) await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
      if (this.#rejectCalls.has(call)) throw new Error("seeded axe rejection");
      return {
        violations: [{
          id: `state-${this.state}`,
          impact: "serious",
          help: "seeded",
          help_url: null,
          wcag_tags: ["wcag2a"],
          nodes: [{ target: ["main"], html: "<main>" }],
        }],
        counts: { total: 1 },
      };
    } finally {
      this.operations.push(`axe-${call}:end`);
      this.#scanActive = false;
    }
  }
}

function writeSuite(label: string, { maxSteps = 10, timeout = "5s", axeLimit = 10 } = {}) {
  const dir = path.join(tmpRoot, label);
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "playtest.yaml"),
    ["app:", `  base_url: ${probeUrl}`, `max_steps: ${maxSteps}`, `timeout: ${timeout}`, ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "stories", "journey.yaml"),
    [
      "story: |",
      "  Reach the next screen.",
      "success:",
      '  - element_exists: "#after"',
      `  - accessibility_violations: ${axeLimit}`,
      "",
    ].join("\n"),
  );
  return dir;
}

async function run(
  label: string,
  steps: AgentStep[],
  driver: AxeDriver,
  suiteOptions: { maxSteps?: number; timeout?: string; axeLimit?: number } = {},
  runOptions: Record<string, unknown> = {},
) {
  const model = await startScriptedModel(steps);
  servers.push(model);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  const [rc] = await discoverCases([writeSuite(label, suiteOptions)]);
  const result = await runCase(rc, {
    runsRoot: path.join(tmpRoot, `runs-${label}`),
    runId: newRunId(),
    grade: false,
    onEvent: () => {},
    driverFactory: async () => driver,
    ...runOptions,
  });
  delete process.env.PLAYTEST_LLM_BASE_URL;
  return result;
}

function trajectory(runDir: string) {
  return fs.readFileSync(path.join(runDir, "trajectory.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("axe overlaps only the model turn, the dispatch barrier holds, and appends stay ordered", async () => {
  const driver = new AxeDriver({ delayMs: 25 });
  const result = await run("ordered", [CLICK_1, CLICK_2, DONE], driver);
  assert.equal(result.status, "pass", result.error ?? "(no error)");

  const envelopes = trajectory(result.runDir);
  assert.deepEqual(envelopes.map((step) => step.step), [1, 2, 3]);
  assert.deepEqual(envelopes.map((step) => step.axe.violations[0].id), [
    "state-details",
    "state-receipt",
    "state-receipt",
  ], "static states retain the same axe semantics as an immediate post-settle scan");
  assert.deepEqual(driver.overlaps, [], `page operations never overlap axe: ${driver.operations.join(", ")}`);

  const snapshot2End = driver.operations.indexOf("snapshot:end", driver.operations.indexOf("execute:end") + 1);
  const axe1Start = driver.operations.indexOf("axe-1:start");
  const execute2Start = driver.operations.indexOf("execute:start", driver.operations.indexOf("execute:end") + 1);
  const axe1End = driver.operations.indexOf("axe-1:end");
  assert.ok(snapshot2End < axe1Start, "step N scan starts only after step N+1 snapshot");
  assert.ok(axe1End < execute2Start, "step N+1 dispatch waits for step N scan");

  const spans = fs.readFileSync(path.join(result.runDir, "perf.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))
    .filter((row) => row.span === "axe");
  assert.equal(spans.length, 3);
  assert.ok(spans[0].meta.blocked_ms >= 10, "the deliberately slow scan exercises the barrier wait");
  assert.ok(spans[0].meta.deferred_ms >= 0);
  assert.equal(spans[2].meta.terminal, true);
});

test("a rejected deferred scan omits axe and does not affect the run", async () => {
  const driver = new AxeDriver({ rejectCalls: [1] });
  const result = await run("reject", [CLICK_1, DONE], driver);
  assert.equal(result.status, "pass", result.error ?? "(no error)");
  const envelopes = trajectory(result.runDir);
  assert.equal("axe" in envelopes[0], false);
  assert.equal(envelopes[0].result.ok, true);
  assert.ok(envelopes[1].axe, "later terminal capture still succeeds");
  const deferredSpan = fs.readFileSync(path.join(result.runDir, "perf.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))
    .find((row) => row.span === "axe" && row.meta.terminal === false);
  assert.ok(deferredSpan.meta.blocked_ms < 10, `fixture dispatch wait is ~0 ms (${deferredSpan.meta.blocked_ms} ms)`);
});

for (const scenario of [
  {
    name: "max_steps",
    steps: [CLICK_1],
    driver: () => new AxeDriver(),
    suite: { maxSteps: 1 },
  },
  {
    name: "stuck",
    steps: [CLICK_1, CLICK_1, CLICK_1, CLICK_1],
    driver: () => new AxeDriver({ transitions: {} }),
    suite: { maxSteps: 10 },
  },
  {
    name: "timeout",
    steps: [CLICK_1],
    driver: () => new AxeDriver({ executeDelayMs: 120 }),
    suite: { maxSteps: 10, timeout: "80ms" },
  },
  {
    name: "error",
    steps: [CLICK_1, DONE],
    driver: () => new AxeDriver({ throwOnSnapshot: 2 }),
    suite: { maxSteps: 10 },
  },
]) {
  test(`${scenario.name} flushes the final pending scan before gate evaluation`, async () => {
    const result = await run(
      `flush-${scenario.name}`,
      scenario.steps,
      scenario.driver(),
      { ...scenario.suite, axeLimit: 0 },
    );
    const envelopes = trajectory(result.runDir);
    assert.ok(envelopes.length > 0);
    assert.ok(envelopes.at(-1).axe, `${scenario.name} persisted the final settled axe result`);
    assert.equal(result.manifest.result.end_reason, scenario.name);
    const axeGate = result.manifest.result.gate.checks.find(
      (check: { kind: string }) => check.kind === "accessibility_violations",
    );
    assert.equal(axeGate.pass, false, `${scenario.name} gate reads the flushed trajectory`);
  });
}

test("hard abort joins an in-flight deferred scan before the gate", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      if (calls > 1) return;
      const body = JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "step", arguments: JSON.stringify(CLICK_1) },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  servers.push({
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  });
  process.env.PLAYTEST_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  const [rc] = await discoverCases([writeSuite("flush-abort", { timeout: "300ms", axeLimit: 0 })]);
  const driver = new AxeDriver({ delayMs: 25 });
  const result = await runCase(rc, {
    runsRoot: path.join(tmpRoot, "runs-flush-abort"),
    runId: newRunId(),
    grade: false,
    onEvent: () => {},
    driverFactory: async () => driver,
    hardTimeoutGraceMs: 0,
  });
  delete process.env.PLAYTEST_LLM_BASE_URL;

  assert.equal(result.manifest.result.end_reason, "timeout");
  assert.match(result.error ?? "", /hard timeout/);
  const envelopes = trajectory(result.runDir);
  assert.equal(envelopes.length, 1);
  assert.ok(envelopes[0].axe, "the step queued before abort is settled and persisted");
  const axeGate = result.manifest.result.gate.checks.find(
    (check: { kind: string }) => check.kind === "accessibility_violations",
  );
  assert.equal(axeGate.pass, false, "the gate reads the step settled before abort");
  assert.deepEqual(driver.overlaps, []);
});
