// Regression: the HAR must be flushed BEFORE the observing phase, so a custom
// assertion's gather() reading har.json from ctx.runDir sees every request the
// trajectory recorded. The HAR writer batches (first entry, then every fifth):
// before the fix, a 7-request run left the last entries unflushed at gather()
// time and an invariant reading its own read-backs judged a truncated trace.
// Offline: scripted actor via a loopback mock gateway; loopback target API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { discoverCases } from "../../src/config.ts";
import { runCase } from "../../src/runner.ts";
import { newRunId } from "../../src/trajectory.ts";

const REQUESTS = 7; // > one flush batch, and not on a flush boundary

let tmpRoot: LegacyTestValue;
let target: LegacyTestValue; // the API under test
let gateway: LegacyTestValue; // scripted actor
let actorCalls = 0;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-har-flush-"));

  target = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));

  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      actorCalls += 1;
      const action =
        actorCalls <= REQUESTS
          ? { type: "request", method: "GET", path: `/items/${actorCalls}` }
          : { type: "done", summary: "made every read the invariant needs" };
      const args = {
        thought: `scripted step ${actorCalls}`,
        action,
        expectation: actorCalls <= REQUESTS ? "a 200 JSON response" : "n/a",
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ id: `call_${actorCalls}`, type: "function", function: { name: "step", arguments: JSON.stringify(args) } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));

  process.env.PLAYTEST_LLM_BASE_URL = `http://127.0.0.1:${gateway.address().port}`;
  process.env.PLAYTEST_LLM_CACHE = "0";
});

after(async () => {
  if (gateway) await new Promise((r) => gateway.close(r));
  if (target) await new Promise((r) => target.close(r));
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function suiteWithHarAssertion() {
  const dir = path.join(tmpRoot, "suite");
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assertions", "har-complete"), { recursive: true });
  fs.writeFileSync(path.join(dir, "playtest.yaml"), "app:\n  driver: api\n");
  fs.writeFileSync(
    path.join(dir, "stories", "reads.yaml"),
    ["story: |", "  Read the items the invariant needs, then stop.", "success:", '  - har_complete: "every trajectory request is in har.json"', ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "assertions", "har-complete", "assertion.js"),
    `import fs from "node:fs";
import path from "node:path";

export default {
  keys() {
    return ["har_complete"];
  },
  async gather(ctx) {
    const requested = ctx.trajectory.filter((e) => e?.agent?.action?.type === "request" && e?.result?.ok).length;
    let inHar = 0;
    try {
      inHar = (JSON.parse(fs.readFileSync(path.join(ctx.runDir, "har.json"), "utf8")).log?.entries ?? []).length;
    } catch {}
    return { requested, inHar };
  },
  verdict({ evidence }) {
    return evidence.inHar >= evidence.requested
      ? { pass: true, detail: \`har has all \${evidence.requested} requests\` }
      : { pass: false, detail: \`har.json has \${evidence.inHar} of \${evidence.requested} trajectory requests — flushed too late for gather()\` };
  },
  inheritable: false,
};
`,
  );
  return dir;
}

test("gather() sees a complete har.json: flush happens before the observing phase", async () => {
  const baseUrl = `http://127.0.0.1:${target.address().port}`;
  const [rc]: LegacyTestValue = await discoverCases([suiteWithHarAssertion()], { baseUrl });
  assert.equal(rc.env.driver, "api");

  const res = await runCase(rc, { runsRoot: path.join(tmpRoot, "runs"), runId: newRunId(), grade: false, onEvent: () => {} });
  const manifest = JSON.parse(fs.readFileSync(path.join(res.runDir, "manifest.json"), "utf8"));
  const check = (manifest.result?.gate?.checks ?? []).find((c: LegacyTestValue) => c.kind === "har_complete");
  assert.ok(check, "the custom assertion ran in the gate");
  assert.equal(check.pass, true, `gather() saw a truncated HAR: ${check.detail}`);
  assert.equal(res.status, "pass", `run should pass, got ${res.status} (${res.error ?? manifest.result?.error ?? ""})`);
  assert.equal(actorCalls, REQUESTS + 1, "the scripted actor made every request then done");
});
