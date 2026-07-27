// Shared machinery for real-executor protocol tests. Keep this file free of
// `test(...)` calls; it is pure setup/teardown support.
//
// A stub GitHub dispatch client whose `dispatchWorkflow` spawns the REAL group
// executor (`packages/platform/runner-agent/src/exec-group.ts exec`) as a child process,
// talking to the control plane over real HTTP exactly as a GitHub Actions job
// would, driving real Chromium against an
// in-process todo app + OpenAI-compatible test endpoint.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { writeTar } from "../../src/suites/tar.ts";
import { BundleProvider } from "@playtest/core/artifacts";
import { REPO_ROOT as HELPERS_REPO_ROOT, loadSuiteDir } from "./helpers.ts";

export const REPO_ROOT = HELPERS_REPO_ROOT;
export const FIXTURE_DIR = path.join(REPO_ROOT, "packages/platform/control-plane/tests/fixtures/hosted-todos");
export const EXEC_GROUP_CLI = workspaceBin("packages/platform/runner-agent", "runner-agent");
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

/**
 * A stub GitHub dispatch client whose `dispatchWorkflow` spawns the REAL group
 * executor as a child process. `spawnNext` lets a test simulate a dispatch
 * whose workflow never produced a runner without spawning a process for it.
 */
export class SpawningGitHub {
  enabled = true;
  dispatches: HostedDynamic[] = [];
  execs: HostedDynamic[] = [];
  serverBase: HostedDynamic = null;
  spawnNext = true;
  declare llmUrl: HostedDynamic;
  declare workRoot: HostedDynamic;

  constructor({ llmUrl, workRoot }: HostedDynamic) {
    this.llmUrl = llmUrl;
    this.workRoot = workRoot;
  }

  async dispatchWorkflow(req: HostedDynamic) {
    const label = `wr-${this.dispatches.length + 1}`;
    this.dispatches.push(req);
    if (this.spawnNext) this.execs.push(this.#spawn(req.refId, label, req.kind));
    return { workflow_run_id: label, workflow_run_url: `https://gha.invalid/${label}` };
  }

  async getRunStatus(id: HostedDynamic) {
    return { id, status: "completed", conclusion: "failure", url: `https://gha.invalid/${id}` };
  }

  async cancelRun() {
    return { ok: true };
  }

  findDispatchRun() {
    return null;
  }

  #spawn(refId: HostedDynamic, label: HostedDynamic, kind = "group") {
    if (!this.serverBase) throw new Error("SpawningGitHub.serverBase must be set before a dispatch can spawn");
    const workDir = fs.mkdtempSync(path.join(this.workRoot, "exec-"));
    const out = { stdout: "", stderr: "" };
    // A `mint` dispatch runs the standalone mint command against its session
    // claim (§3a forced refresh) — same binary, same protocol, no run group.
    const args =
      kind === "mint"
        ? [EXEC_GROUP_CLI, "mint", "--claim", refId, "--server", this.serverBase, "--isolation", "process", "--work-dir", workDir]
        : [EXEC_GROUP_CLI, "exec", "--group", refId, "--server", this.serverBase, "--isolation", "process", "--work-dir", workDir];
    const child = spawn(process.execPath, args, { env: childEnv(this.llmUrl), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out.stdout += d));
    child.stderr.on("data", (d) => (out.stderr += d));
    const promise = new Promise((resolve) => child.on("exit", (code) => resolve({ code, ...out })));
    return { groupId: refId, label, workDir, child, promise, out };
  }
}

/** Poll `GET /run-groups/:g` until `status === "done"`, bounded by `timeoutMs`.
 * On timeout, fails with every spawned executor's captured stdout/stderr. */
export async function waitForGroupDone(api: HostedDynamic, groupId: HostedDynamic, { timeoutMs = GROUP_TIMEOUT_MS, execs = [] }: HostedDynamic = {}) {
  const deadline = Date.now() + timeoutMs;
  let last: HostedDynamic = null;
  while (Date.now() < deadline) {
    last = await api.get(`/run-groups/${groupId}`);
    if (last.body?.status === "done") return last.body;
    await sleep(500);
  }
  const debug = execs
    .map((e: HostedDynamic) => `--- exec ${e.label} (group ${e.groupId}) ---\nSTDOUT:\n${e.out.stdout}\nSTDERR:\n${e.out.stderr}`)
    .join("\n\n");
  assert.fail(
    `run group ${groupId} did not reach "done" within ${timeoutMs}ms (last status: ${JSON.stringify(last?.body?.status)})\n${debug}`,
  );
  return undefined;
}

export function bundleFor(storeRoot: HostedDynamic, run: HostedDynamic) {
  if (!run.artifact?.key) assert.fail(`run for case "${run.case_id}" has no bundle artifact`);
  return BundleProvider.fromFile(path.join(storeRoot, run.artifact.key));
}

export async function launchGroup(api: HostedDynamic, { project, suite, env, ids = ["add-todo", "admin-note", "signup"], mode = "auto" }: HostedDynamic = {}) {
  return api.post(`/projects/${project.key}/run-groups`, {
    suite_id: suite.id,
    environment_id: env.id,
    selection: { ids, mode },
  });
}

export async function setUpProject(api: HostedDynamic, { key, todoAppUrl, authStubUrl }: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(FIXTURE_DIR));
  const imported = await api.postTar(`/suites/${suite.id}/import`, tar);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));

  const env = (
    await api.post(`/projects/${project.key}/environments`, {
      name: "staging",
      runner_labels: ["self-hosted", "playtest"],
      config: {
        app: { base_url: todoAppUrl },
        auth: {
          identities: {
            member: { $session: "sso/member" },
            admin: { $session: "sso/admin" },
          },
        },
        secret_env: {},
      },
    })
  ).body;
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
    })
  ).body;
  return { project, suite, env, provider };
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
 * restart a service (the todo app across a variant flip) on a FIXED port so an
 * environment's base_url keeps pointing at it. */
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
