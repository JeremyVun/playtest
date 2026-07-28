// R1: the benchmark, mechanized. The REAL runner agent (`runner-agent pool`)
// runs as a separate process against a control plane in pool mode, claims the
// group a person launched through the public API, and executes an API suite
// whose target is a server on the runner's own machine — DESIGN's benchmark
// path 3, end to end, with nothing but the agent between the two.
//
// Everything here is offline: a temporary SQLite data root, a loopback ledger
// fixture as the target, and a scripted gateway standing in for the model. The
// control plane never connects to the runner; every request below that reaches
// it came from the agent dialling out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { childEnv, EXEC_GROUP_CLI, sleep } from "./exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { reconcileDispatches } from "../../src/dispatch/reconciler.ts";
import { startInvariantApi } from "../../../../../tests/fixtures/invariant-api/server.ts";
import { startScriptedModel } from "../../../../../tests/support/scripted-model.ts";

const POOL = { PLAYTEST_DISPATCH: "pool" };
const AGENT_TIMEOUT_MS = 120_000;

/** The recorded journey the api-example suite's gates and policies describe. */
const journey = (prefix: string) => [
  { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201 with the new account" },
  { thought: "post the seed entry", action: { type: "request", method: "POST", path: "/entries", headers: { "Idempotency-Key": "seed-1" }, body: { account_id: `acc_${prefix}_1`, amount: 250 } }, expectation: "a 201" },
  { thought: "replay it with the same key", action: { type: "request", method: "POST", path: "/entries", headers: { "Idempotency-Key": "seed-1" }, body: { account_id: `acc_${prefix}_1`, amount: 250 } }, expectation: "the same entry, not a second one" },
  { thought: "read the account back", action: { type: "request", method: "GET", path: `/accounts/acc_${prefix}_1` }, expectation: "a balance of 250" },
  { thought: "done", action: { type: "done", summary: "funded the account once and confirmed the balance" }, expectation: "the balance is 250" },
];

/** A project holding the committed API example suite, targeted at `baseUrl`. */
async function setUp(api: HostedDynamic, { key, baseUrl, labels = ["macos"], stories = 1 }: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { application, ring } = await createTarget(api, project, {
    key: "ledger",
    name: "Ledger",
    driver: "api",
    ringKey: "laptop",
    runnerLabels: labels,
    // The whole point: the ring's URL is loopback on the RUNNER's machine, which
    // a remotely hosted control plane could never reach itself.
    baseUrl,
  });
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "ledger", name: "Ledger" })).body;
  // loadSuiteDir skips `results/`, so the committed baseline stays behind and
  // this story records — the model in the loop is the scripted gateway.
  const files = loadSuiteDir(`${REPO_ROOT}/tests/fixtures/api-example`);
  // A second copy of the story, when a test needs a remainder the reconciler
  // can re-post after the runner it was placed on disappears.
  if (stories > 1) files["stories/second-journey.yaml"] = files["stories/ledger-journey.yaml"];
  const tar = writeTar(files);
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  return { project, suite, application, ring };
}

/** Start the real agent in pool mode. The credential rides the process environment. */
function startAgent(base: string, credential: string, { llmUrl, labels = "macos" }: HostedDynamic) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-agent-"));
  const out = { stdout: "", stderr: "" };
  const child = spawn(
    process.execPath,
    [EXEC_GROUP_CLI, "pool", "--server", base, "--labels", labels, "--isolation", "process", "--work-dir", workDir],
    {
      // The credential is an environment variable, never an argument: it must
      // not be readable from this process's command line.
      env: { ...childEnv(llmUrl), PLAYTEST_RUNNER_CREDENTIAL: credential },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => (out.stderr += d));
  return {
    child,
    out,
    workDir,
    args: child.spawnargs,
    stop: async () => {
      if (child.exitCode == null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(5_000)]);
        if (child.exitCode == null) child.kill("SIGKILL");
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/** Wait for `pred(row)`, failing with the agent's own output when it never happens. */
async function until(pred: () => Promise<HostedDynamic>, what: string, agent: HostedDynamic, timeoutMs = AGENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await pred();
    if (value) return value;
    if (agent.child.exitCode != null) {
      assert.fail(`the runner agent exited (code ${agent.child.exitCode}) before ${what}\nSTDOUT:\n${agent.out.stdout}\nSTDERR:\n${agent.out.stderr}`);
    }
    await sleep(250);
  }
  assert.fail(`timed out waiting for ${what}\nSTDOUT:\n${agent.out.stdout}\nSTDERR:\n${agent.out.stderr}`);
}

test("pool: the real agent claims a launched group and runs an API suite against the runner's own localhost", async () => {
  const target = await startInvariantApi({ prefix: "P" });
  const model = await startScriptedModel(journey("P"));
  let agent: HostedDynamic = null;
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const { project, suite, ring } = await setUp(api, { key: "poolagent", baseUrl: target.url });
      const registered = await api.post(`/projects/${project.key}/runners`, { name: "adas-laptop", labels: ["macos", "ios-sim"] });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));

      agent = startAgent(base, registered.body.credential, { llmUrl: model.baseUrl });
      // The one-line start command a person pastes carries no secret: the
      // credential is in the environment, so `ps` cannot read it.
      assert.equal(agent.args.some((a: string) => a.includes("ptr_")), false, `the credential must never reach argv: ${agent.args.join(" ")}`);

      // It checks in before there is anything to do, and says who it is.
      await until(
        async () => (await app.db.query(`SELECT last_seen_at FROM runners WHERE project_id = $1`, [project.id])).rows[0]?.last_seen_at,
        "the runner to check in",
        agent,
      );
      // The banner reaches this process through a pipe, so it can trail the
      // check-in row it precedes: wait for it rather than sampling it.
      await until(
        async () => /Playtest runner "adas-laptop" — project poolagent/.test(agent.out.stdout),
        "the agent to say who it is",
        agent,
        20_000,
      );
      assert.match(agent.out.stdout, /waiting for work/);

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["ledger-journey"] },
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const groupId = launched.body.run_group.id;

      // The automation wait: exactly what CI does, and what the console's own
      // launch flow rides. The board holds it until the agent reports.
      const done = await until(
        async () => {
          const res = await api.get(`/run-groups/${groupId}?wait=true`);
          return res.body?.status === "done" ? res.body : null;
        },
        "the launched group to finish",
        agent,
      );

      assert.equal(done.runs.length, 1);
      assert.equal(done.runs[0].status, "pass", `the API journey passed: ${done.runs[0].error ?? "no error"}\n${agent.out.stdout}\n${agent.out.stderr}`);
      assert.equal(done.exit_summary.exit_code, 0);
      // The evidence says what produced it: this runner, and the isolation it
      // reported at the exchange.
      assert.equal(done.placement.runner.name, "adas-laptop");
      assert.equal(done.placement.isolation, "process");
      assert.ok(done.runs[0].artifact?.key, "the bundle was uploaded through the ordinary runner protocol");

      // The target really was the loopback fixture on the runner's machine.
      assert.ok(target.requests.some((r: HostedDynamic) => r.method === "POST" && r.path === "/accounts"));
      assert.ok(target.requests.some((r: HostedDynamic) => r.method === "GET" && r.path === "/accounts/acc_P_1"));

      // And the agent is back on the board, not exited: one process, many groups.
      await until(async () => /waiting for work[\s\S]*claimed run group[\s\S]*waiting for work/.test(agent.out.stdout), "the agent to return to the board", agent, 20_000);
      assert.equal(agent.child.exitCode, null, "a pool runner outlives the group it just ran");

      const dispatch = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId]);
      assert.equal(dispatch.rows[0].status, "concluded");
      assert.ok(dispatch.rows[0].runner_id, "the ledger row records which runner took it");

      // Stop the agent before the control plane: its long-poll is a live
      // request, and closing the server under it would just wait out the hold.
      await agent.stop();
    }, POOL);
  } finally {
    if (agent) await agent.stop();
    await target.close();
    await model.close();
  }
});

test("pool: a runner killed mid-group is reconciled like any vanished executor — infra failure, one bounded re-dispatch", async () => {
  const target = await startInvariantApi({ prefix: "K" });
  // A gateway that never answers: the case starts and then hangs, so the kill
  // lands squarely in the middle of the group instead of racing its end.
  const stalled = http.createServer(() => {});
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", () => resolve()));
  const stalledUrl = `http://127.0.0.1:${(stalled.address() as import("node:net").AddressInfo).port}`;
  let agent: HostedDynamic = null;
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const { project, suite, ring } = await setUp(api, { key: "poolkill", baseUrl: target.url, stories: 2 });
      const registered = await api.post(`/projects/${project.key}/runners`, { name: "adas-laptop", labels: ["macos"] });
      agent = startAgent(base, registered.body.credential, { llmUrl: stalledUrl });

      // Two stories, executed serially: when the runner dies the first is lost
      // and the second has not started, which is the remainder the reconciler
      // is allowed to place once more.
      const groupId = (
        await api.post(`/projects/${project.key}/run-groups`, { suite_id: suite.id, ring_id: ring.id, selection: { ids: ["ledger-journey", "second-journey"] } })
      ).body.run_group.id;

      const claimed = await until(
        async () => (await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1 AND claimed_at IS NOT NULL`, [groupId])).rows[0],
        "the agent to claim the group",
        agent,
      );
      // …and to be genuinely mid-group: one story started (and now hanging on
      // the gateway that never answers), one still queued.
      await until(
        async () => (await app.db.query(`SELECT COUNT(*) AS n FROM runs WHERE run_group_id = $1 AND started_at IS NOT NULL`, [groupId])).rows[0].n > 0,
        "the first story to start",
        agent,
      );
      // Pull the plug: no teardown, no completion — the shape of a laptop that
      // went to sleep or a process that was killed.
      agent.child.kill("SIGKILL");
      await new Promise((r) => agent.child.once("exit", r));

      // The heartbeat window is zero in this deployment, so the claim reads as
      // gone the moment the reconciler looks at it: the existing dead-executor
      // path, with the remainder re-posted to the board exactly once.
      const first = await reconcileDispatches(app.ctx);
      assert.equal(first.find((r: HostedDynamic) => r.dispatch_id === claimed.id)?.action, "redispatched", JSON.stringify(first));
      const attempts = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1 ORDER BY attempt`, [groupId]);
      assert.equal(attempts.rows.length, 2);
      assert.match(attempts.rows[0].error, /adas-laptop/);
      assert.match(attempts.rows[0].error, /stopped checking in/);
      assert.deepEqual(attempts.rows[1].labels, ["macos"], "the replacement carries the same routing");

      // Nothing is left to claim it, so the group fails as infrastructure with
      // the remedy named — never a story-level verdict.
      const second = await reconcileDispatches(app.ctx);
      assert.equal(second.find((r: HostedDynamic) => r.dispatch_id === attempts.rows[1].id)?.action, "dead");
      const group = await api.get(`/run-groups/${groupId}`);
      assert.equal(group.body.status, "done");
      assert.equal(group.body.exit_summary.exit_code, 2);
      assert.equal(group.body.runs[0].status, "infra");
      assert.match(group.body.runs[0].error, /runner/);
    }, { ...POOL, PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S: "0", PLAYTEST_POOL_CLAIM_TIMEOUT_S: "0" });
  } finally {
    if (agent) await agent.stop();
    await new Promise((r) => stalled.close(r));
    await target.close();
  }
});
