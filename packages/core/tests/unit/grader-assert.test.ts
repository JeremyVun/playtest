import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkAssertion } from "../../src/grader.ts";

test("assert verdict instructions consistently use the reasonable-person standard", async () => {
  let request: LegacyTestValue;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      request = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "verdict",
                arguments: JSON.stringify({
                  pass: true,
                  detail: "The results identify two schemes for which the buyer may be eligible.",
                }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-grader-assert-"));
  const saved = {
    base: process.env.PLAYTEST_LLM_BASE_URL,
    key: process.env.PLAYTEST_LLM_API_KEY,
    cache: process.env.PLAYTEST_LLM_CACHE,
  };
  process.env.PLAYTEST_LLM_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  delete process.env.PLAYTEST_LLM_API_KEY;
  process.env.PLAYTEST_LLM_CACHE = "0";

  try {
    const result = await checkAssertion(
      "The results say this buyer is eligible for at least one government home-buying scheme.",
      {
        snapshotText:
          "You may be eligible for the 5% Deposit Scheme and Help to Buy Scheme. Eligibility is assessed separately and subject to additional criteria.",
        finalUrl: "http://localhost/results",
        model: "test-model",
        runDir,
      },
    );
    assert.equal(result.pass, true);

    const system = request.messages.find((message: LegacyTestValue) => message.role === "system").content;
    const verdict = request.tools.find((tool: LegacyTestValue) => tool.function?.name === "verdict");
    const passDescription = verdict.function.parameters.properties.pass.description;

    assert.match(system, /reasonable person/i);
    assert.match(system, /Routine hedges, conditions, and disclaimers do not automatically negate a positive result/);
    assert.match(passDescription, /reasonable person/i);
    assert.doesNotMatch(passDescription, /true only if|clearly supports/i);
  } finally {
    saved.base == null
      ? delete process.env.PLAYTEST_LLM_BASE_URL
      : (process.env.PLAYTEST_LLM_BASE_URL = saved.base);
    saved.key == null
      ? delete process.env.PLAYTEST_LLM_API_KEY
      : (process.env.PLAYTEST_LLM_API_KEY = saved.key);
    saved.cache == null
      ? delete process.env.PLAYTEST_LLM_CACHE
      : (process.env.PLAYTEST_LLM_CACHE = saved.cache);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
