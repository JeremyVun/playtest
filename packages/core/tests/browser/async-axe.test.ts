import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases } from "../../src/config.ts";
import { WebDriver } from "../../src/drivers/web.ts";
import { runCase } from "../../src/runner.ts";
import { newRunId } from "../../src/trajectory.ts";
import { start as startApp } from "../../../../tests/fixtures/todo-app/server.ts";
import { startScriptedModel } from "../../../../tests/support/scripted-model.ts";

let app: Awaited<ReturnType<typeof startApp>>;
let model: Awaited<ReturnType<typeof startScriptedModel>>;
let tmpRoot: string;

before(async () => {
  app = await startApp();
  model = await startScriptedModel([
    {
      thought: "exercise a settled action",
      action: { type: "navigate", url: "/?async-axe=1" },
      expectation: "the todo page reloads",
    },
    {
      thought: "finished",
      action: { type: "done", summary: "the todo input is present" },
      expectation: "complete",
    },
  ]);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-browser-async-axe-"));
});

after(async () => {
  delete process.env.PLAYTEST_LLM_BASE_URL;
  await model?.close();
  await app?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("the real browser runner never overlaps axe with another page operation", async () => {
  const suite = path.join(tmpRoot, "suite");
  fs.mkdirSync(path.join(suite, "stories"), { recursive: true });
  fs.writeFileSync(path.join(suite, "playtest.yaml"), `app:\n  base_url: ${app.url}\n`);
  fs.writeFileSync(
    path.join(suite, "stories", "journey.yaml"),
    'story: |\n  Reload the todo page and finish.\nsuccess:\n  - element_exists: "#new-todo"\n',
  );
  const [rc] = await discoverCases([suite]);

  const overlaps: string[] = [];
  const operations: string[] = [];
  const result = await runCase(rc, {
    runsRoot: path.join(tmpRoot, "runs"),
    runId: newRunId(),
    grade: false,
    onEvent: () => {},
    driverFactory: async (_case: unknown, _env: unknown, options: { runDir: string; perf: unknown }) => {
      const driver = await WebDriver.launch({
        baseUrl: app.url,
        runDir: options.runDir,
        perf: options.perf as never,
        artifacts: "core",
      });
      const mutable = driver as LegacyTestValue;
      let scanActive = false;
      let pageOperation: string | null = null;

      const wrapPage = (name: string) => {
        const original = mutable[name].bind(driver);
        mutable[name] = async (...args: unknown[]) => {
          if (scanActive) overlaps.push(`${name} during axe`);
          pageOperation = name;
          operations.push(`${name}:start`);
          try {
            return await original(...args);
          } finally {
            operations.push(`${name}:end`);
            pageOperation = null;
          }
        };
      };
      for (const name of ["captureSnapshot", "execute", "executeLocator", "effectToken", "stopRecording", "finalPageCheck"]) {
        wrapPage(name);
      }

      const originalAxe = driver.captureAxe.bind(driver);
      mutable.captureAxe = async () => {
        if (pageOperation) overlaps.push(`axe during ${pageOperation}`);
        scanActive = true;
        operations.push("axe:start");
        try {
          return await originalAxe();
        } finally {
          operations.push("axe:end");
          scanActive = false;
        }
      };
      return driver;
    },
  });

  assert.equal(result.status, "pass", result.error ?? "(no error)");
  assert.deepEqual(overlaps, [], operations.join(", "));
  const envelopes = fs.readFileSync(path.join(result.runDir, "trajectory.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(envelopes.map((step) => step.step), [1, 2]);
  assert.ok(envelopes.every((step) => step.axe), "both the deferred action and inline terminal state carry axe");
});
