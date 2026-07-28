// Shared machinery for real-runner protocol tests. Keep this file free of
// `test(...)` calls; it is pure setup/teardown support.
//
// There is one placement model, so there is one way in here too: a REAL runner
// registered through the public API, which either
//
//   * runs as a scripted claimer (`claimer`, `claimAndExchange`) — poll, claim,
//     exchange, then drive the executor protocol by hand, or
//   * runs as the real agent process (`startPoolAgent`), which does all of that
//     and executes for real.
//
// Nothing here fakes an exchange: every bearer below was issued for a dispatch
// a registered runner actually claimed on the board.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { writeTar } from "../../src/suites/tar.ts";
import { BundleProvider } from "@playtest/core/artifacts";
import { REPO_ROOT as HELPERS_REPO_ROOT, createTarget, loadSuiteDir } from "./helpers.ts";

export const REPO_ROOT = HELPERS_REPO_ROOT;
export const FIXTURE_DIR = path.join(REPO_ROOT, "packages/platform/control-plane/tests/fixtures/hosted-todos");
export const RUNNER_AGENT_CLI = workspaceBin("packages/platform/runner-agent", "runner-agent");
export const CLI_BIN = workspaceBin("packages/cli", "playtest");
export const GROUP_TIMEOUT_MS = 150_000;

function workspaceBin(workspace: string, name: string) {
  const root = path.join(REPO_ROOT, workspace);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return path.resolve(root, manifest.bin[name]);
}

export function sleep(ms: HostedDynamic) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Env for spawned executor-protocol processes: hermetic and pointed at the
 * caller-supplied model endpoint. */
export function childEnv(llmUrl: HostedDynamic) {
  const env = { ...process.env };
  delete env.PLAYTEST_LLM_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  env.PLAYTEST_LLM_CACHE = "0";
  delete env.PLAYTEST_BROWSER_CHANNEL;
  env.PLAYTEST_LLM_BASE_URL = llmUrl;
  return env;
}

/**
 * A stub `token_endpoint` auth provider (§3a rung 1): POST /mint returns a
 * Playwright storage-state object and counts mints per rendered `identity` field.
 */
export function startAuthStub(): Promise<HostedDynamic> {
  const counts: HostedDynamic = {};
  return new Promise((resolve, reject) => {
    const server: HostedDynamic = http.createServer((req: HostedDynamic, res: HostedDynamic) => {
      if (req.method !== "POST" || req.url !== "/mint") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no route ${req.method} ${req.url}` }));
        return;
      }
      let raw = "";
      req.on("data", (c: HostedDynamic) => (raw += c));
      req.on("end", () => {
        let body: HostedDynamic = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          /* treated as {} below */
        }
        counts[body.identity] = (counts[body.identity] || 0) + 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            storage_state: {
              cookies: [{ name: "sid", value: String(body.identity), domain: "localhost", path: "/" }],
              origins: [],
            },
          }),
        );
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        counts,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

/** A scripted self-hosted runner: nothing but its credential and fetch. */
export function claimer(base: HostedDynamic, credential: HostedDynamic) {
  const call = async (method: HostedDynamic, path: HostedDynamic, body?: HostedDynamic) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    credential,
    poll: (query = "") => call("GET", `/runner/pool/claims${query}`),
    claim: (dispatchId: HostedDynamic) => call("POST", `/runner/pool/claims/${dispatchId}`, {}),
    heartbeat: (dispatchId: HostedDynamic) => call("POST", `/runner/pool/claims/${dispatchId}/heartbeat`, {}),
    exchange: (body: HostedDynamic) => call("POST", `/runner/exchange`, body),
  };
}

/** Register a standing runner and return the row plus its one-time credential. */
export async function registerRunner(api: HostedDynamic, project: HostedDynamic, body: HostedDynamic = {}) {
  const res = await api.post(`/projects/${project.key}/runners`, { name: `runner-${Math.random().toString(36).slice(2, 8)}`, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/**
 * The real arrival, scripted: register a runner, take the offer for `dispatchId`
 * (or the one naming `groupId` / `mintClaimId`) off the board, claim it, and
 * exchange the credential for the group- or mint-scoped bearer.
 *
 * This is what every protocol test uses instead of asking the server for a
 * token it never claimed anything for.
 */
export async function claimAndExchange(
  api: HostedDynamic,
  base: HostedDynamic,
  { project, groupId = null, mintClaimId = null, labels = [], isolation = "process", runner = null }: HostedDynamic,
) {
  const registered = runner ?? (await registerRunner(api, project, { labels }));
  const agent = claimer(base, registered.credential);
  const offered = await agent.poll("?wait=5");
  assert.equal(offered.status, 200, JSON.stringify(offered.body));
  const offer = (offered.body.offers || []).find((o: HostedDynamic) =>
    groupId ? o.run_group_id === groupId : mintClaimId ? o.mint_claim_id === mintClaimId : true,
  );
  assert.ok(offer, `no board offer for ${groupId ?? mintClaimId}: ${JSON.stringify(offered.body)}`);
  const claimed = await agent.claim(offer.dispatch_id);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const exchanged = await agent.exchange({ dispatch_id: offer.dispatch_id, isolation });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  return {
    runner: registered,
    agent,
    offer,
    dispatchId: offer.dispatch_id,
    token: exchanged.body.token,
    executorId: exchanged.body.executor_id,
    headers: { authorization: `Bearer ${exchanged.body.token}`, "content-type": "application/json" },
  };
}

/**
 * Start the REAL agent (`runner-agent pool`) as a separate process against this
 * control plane. It polls the board, claims what it can execute, exchanges, and
 * runs the group or mint executor — the same process a person starts on their
 * own machine. The credential rides the environment, never argv.
 */
export function startPoolAgent(base: string, credential: string, { llmUrl = "http://127.0.0.1:1", labels = "", isolation = "process" }: HostedDynamic = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-agent-"));
  const out = { stdout: "", stderr: "" };
  const args = [RUNNER_AGENT_CLI, "pool", "--server", base, "--isolation", isolation, "--work-dir", workDir];
  if (labels) args.push("--labels", labels);
  const child = spawn(process.execPath, args, {
    env: { ...childEnv(llmUrl), PLAYTEST_RUNNER_CREDENTIAL: credential },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

/** Wait for `pred()` to answer truthy, failing with the agent's own output. */
export async function untilAgent(pred: () => Promise<HostedDynamic>, what: string, agent: HostedDynamic, timeoutMs = GROUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await pred();
    if (value) return value;
    if (agent?.child?.exitCode != null) {
      assert.fail(`the runner agent exited (code ${agent.child.exitCode}) before ${what}\nSTDOUT:\n${agent.out.stdout}\nSTDERR:\n${agent.out.stderr}`);
    }
    await sleep(250);
  }
  assert.fail(`timed out waiting for ${what}\nSTDOUT:\n${agent?.out?.stdout}\nSTDERR:\n${agent?.out?.stderr}`);
}

/** Poll `GET /run-groups/:g` until `status === "done"`, bounded by `timeoutMs`.
 * On timeout, fails with the runner agent's captured stdout/stderr. */
export async function waitForGroupDone(api: HostedDynamic, groupId: HostedDynamic, { timeoutMs = GROUP_TIMEOUT_MS, agent = null }: HostedDynamic = {}) {
  const deadline = Date.now() + timeoutMs;
  let last: HostedDynamic = null;
  while (Date.now() < deadline) {
    last = await api.get(`/run-groups/${groupId}`);
    if (last.body?.status === "done") return last.body;
    if (agent?.child?.exitCode != null) {
      assert.fail(`the runner agent exited (code ${agent.child.exitCode}) before run group ${groupId} finished\nSTDOUT:\n${agent.out.stdout}\nSTDERR:\n${agent.out.stderr}`);
    }
    await sleep(500);
  }
  const debug = agent ? `STDOUT:\n${agent.out.stdout}\nSTDERR:\n${agent.out.stderr}` : "";
  assert.fail(
    `run group ${groupId} did not reach "done" within ${timeoutMs}ms (last status: ${JSON.stringify(last?.body?.status)})\n${debug}`,
  );
  return undefined;
}

export function bundleFor(storeRoot: HostedDynamic, run: HostedDynamic) {
  if (!run.artifact?.key) assert.fail(`run for case "${run.case_id}" has no bundle artifact`);
  return BundleProvider.fromFile(path.join(storeRoot, run.artifact.key));
}

export async function launchGroup(api: HostedDynamic, { project, suite, ring, ids = ["add-todo", "admin-note", "signup"], mode = "auto" }: HostedDynamic = {}) {
  return api.post(`/projects/${project.key}/run-groups`, {
    suite_id: suite.id,
    ring_id: ring.id,
    selection: { ids, mode },
  });
}

export async function setUpProject(api: HostedDynamic, { key, todoAppUrl, authStubUrl }: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  // The application and its ring come FIRST: a suite binds to an application at
  // creation, and the ring's URL is what a launch points at.
  const { application, ring } = await createTarget(api, project, {
    key: "todos",
    name: "Todos",
    ringKey: "staging",
    baseUrl: todoAppUrl,
    runnerLabels: ["self-hosted", "playtest"],
    config: {
      auth: {
        identities: {
          member: { $session: "sso/member" },
          admin: { $session: "sso/admin" },
        },
      },
      secret_env: {},
    },
  });
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(FIXTURE_DIR));
  const imported = await api.postTar(`/suites/${suite.id}/import`, tar);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));

  const provider = (
    await api.post(`/projects/${project.key}/auth-providers`, {
      name: "sso",
      kind: "token_endpoint",
      config: {
        url: `${authStubUrl}/mint`,
        method: "POST",
        body: { identity: "{{identity}}", username: "{{username}}" },
      },
      identities: { member: { username: "qa-member" }, admin: { username: "qa-admin" } },
      ttl_minutes: 45,
      ring_id: ring.id,
    })
  ).body;
  return { project, suite, application, ring, provider };
}

export { loadSuiteDir };

export function runCli(args: HostedDynamic, llmUrl: HostedDynamic) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: childEnv(llmUrl), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

/** Grab an ephemeral free TCP port and release it immediately — for tests that
 * restart a service (the todo app across a variant flip) on a FIXED port so a
 * ring's base_url keeps pointing at it. */
export async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv: HostedDynamic = http.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close((err: HostedDynamic) => (err ? reject(err) : resolve(port)));
    });
  });
}
