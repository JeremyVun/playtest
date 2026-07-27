// Local development placement adapter: instead of dispatching a GitHub Actions
// workflow, spawn the `runner-agent` workspace executable as a child process
// against this server — the same executor protocol end to end, no GitHub. This
// exists so the launch → watch → verdict path is exercisable on a laptop
// (PLAYTEST_DISPATCH=local, dev auth only — config.js refuses it elsewhere,
// because the exchange then rides allowInsecureRunnerExchange).
//
// Same interface as GitHubDispatchClient. Children are tracked in-memory only:
// after a server restart getRunStatus knows nothing, and the reconciler
// declares the dispatch dead — exactly how a vanished GHA workflow degrades.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { ControlPlaneConfig } from "../config.ts";
import type { Logger } from "../types.ts";

interface LocalRun {
  child: ChildProcess;
  dispatchId: string;
  status: string;
  conclusion: string | null;
  logFile: string;
}

// Local placement is a repository-development adapter, so start the sibling
// runner module with this Node process instead of depending on npm's
// node_modules/.bin symlink. The latter gives the module a different argv[1]
// from import.meta.url and can make its import-safe main guard treat a real
// launch as an import. The entry is located through package resolution — a
// process-spawn edge, not a code import, so the workspace boundary holds. The
// future pull-based pool starts a long-lived runner independently; this
// adapter remains the short-lived local equivalent.
const RUNNER_AGENT_ENTRY = fileURLToPath(
  import.meta.resolve("@playtest/runner-agent/src/exec-group.ts"),
);

export function localRunnerInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const override = env.PLAYTEST_RUNNER_AGENT_BIN;
  return override
    ? { command: override, args }
    : { command: process.execPath, args: [RUNNER_AGENT_ENTRY, ...args] };
}

export class LocalDispatchClient {
  enabled: boolean = true;
  /** @type {Map<string, {child: import("node:child_process").ChildProcess, dispatchId: string, status: string, conclusion: string|null, logFile: string}>} */
  #runs = new Map<string, LocalRun>();
  #seq = 0;
  declare readonly serverBase: string;
  declare readonly log: Logger | null;
  declare readonly workRoot: string;

  constructor(config: ControlPlaneConfig, { log = null }: { log?: Logger | null } = {}) {
    this.serverBase = config.publicUrl;
    this.log = log;
    this.workRoot = path.join(os.tmpdir(), "playtest-local-dispatch");
  }

  async dispatchWorkflow(
    { dispatchId, kind, refId }: { dispatchId: string; kind: string; refId: string }
  ) {
    fs.mkdirSync(this.workRoot, { recursive: true });
    const workDir = fs.mkdtempSync(path.join(this.workRoot, "exec-"));
    const id = `local-${++this.#seq}-${dispatchId}`;
    const logFile = path.join(workDir, "executor.log");
    const args =
      kind === "mint"
        ? ["mint", "--claim", refId, "--server", this.serverBase, "--isolation", "process", "--work-dir", workDir]
        : ["exec", "--group", refId, "--server", this.serverBase, "--isolation", "process", "--work-dir", workDir];
    // The child inherits this server's env, so PLAYTEST_LLM_* flow through to
    // the actor/grader exactly as the GHA job env would carry them.
    const out = fs.openSync(logFile, "w");
    const runner = localRunnerInvocation(args);
    const child = spawn(runner.command, runner.args, { env: process.env, stdio: ["ignore", out, out] });
    const entry: LocalRun = { child, dispatchId, status: "in_progress", conclusion: null, logFile };
    this.#runs.set(id, entry);
    child.on("exit", (code) => {
      fs.closeSync(out);
      entry.status = "completed";
      entry.conclusion = code === 0 ? "success" : "failure";
      this.log?.info?.({ msg: "local dispatch executor exited", dispatch_id: dispatchId, kind, code, log_file: logFile });
    });
    this.log?.info?.({ msg: "local dispatch executor spawned", dispatch_id: dispatchId, kind, ref_id: refId, pid: child.pid, log_file: logFile });
    return { workflow_run_id: id, workflow_run_url: null };
  }

  async findDispatchRun(dispatchId: string) {
    for (const [id, entry] of this.#runs) {
      if (entry.dispatchId === dispatchId) {
        return { id, status: entry.status, conclusion: entry.conclusion, url: null };
      }
    }
    return null;
  }

  async getRunStatus(workflowRunId: string) {
    const entry = this.#runs.get(workflowRunId);
    if (!entry) return null;
    return { id: workflowRunId, status: entry.status, conclusion: entry.conclusion, url: null };
  }

  async cancelRun(workflowRunId: string) {
    const entry = this.#runs.get(workflowRunId);
    // SIGTERM: exec-group's handler stops starting cases, stops containers, and
    // posts a best-effort complete — the same path a GHA cancel exercises.
    if (entry && entry.status !== "completed") entry.child.kill("SIGTERM");
    return { ok: true };
  }
}
