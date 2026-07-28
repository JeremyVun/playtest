// Per-case execution behind the isolation seam
// (docs/contracts/hosted.md#runner-protocol). Process mode runs core runCase
// in-process (fresh ephemeral VMs and
// offline tests); container mode runs it in an ephemeral `docker run --rm --init`
// from the pinned job image with ONLY the group workspace mounted. Host paths are
// translated to the /ws mount for the child and back for the caller; env reaches
// the container via `-e VAR` flags with values carried in the docker client's own
// environment (never argv, which would leak secrets to `ps`).
import childProcess from "node:child_process";
import { runCase } from "@playtest/core/run";

/** Where the group workspace is mounted inside a case container. Exported
 * because streamed engine events carry these paths and the live uploader has to
 * translate them back the same way the final result is translated. */
export const CONTAINER_WS = "/ws";
const CHILD = "/opt/playtest/packages/platform/runner-agent/src/case-runner-child.ts";

// Model-gateway + browser knobs the case needs beyond the workspace env.
const PASSTHROUGH_ENV = [
  "PLAYTEST_LLM_BASE_URL",
  "PLAYTEST_LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "PLAYTEST_LLM_CACHE",
  "PLAYTEST_BROWSER_CHANNEL",
  "PLAYTEST_FFMPEG",
];

const activeContainers = new Set<string>();
// Process isolation is only for local development/tests, but it can still run
// several cases from one group. Those cases receive the same environment
// overlay. Reference-count each key so the first finisher cannot restore the
// parent value while a sibling is still using it.
const envLeases = new Map<string, { count: number; value: string; previous: string | undefined }>();

/** Names of case containers currently running (cancellation + janitor input). */
export function activeContainerNames() {
  return [...activeContainers];
}

/**
 * `docker stop` every active case container (GHA cancel path: SIGTERM → stop →
 * the in-flight `docker run` exits nonzero → the case reports canceled/infra).
 * Sync on purpose: callable from a signal handler.
 */
export function stopActiveContainers() {
  const stopped: string[] = [];
  for (const name of [...activeContainers]) {
    try {
      childProcess.execFileSync("docker", ["stop", "--time", "5", name], { stdio: "ignore" });
      stopped.push(name);
    } catch {
      /* already gone */
    }
  }
  return stopped;
}

export async function runCaseIsolated(rc: RunnerDynamic, opts: RunnerDynamic): Promise<RunnerDynamic> {
  if (opts.isolation === "container") return await runInContainer(rc, opts);
  return await runInProcess(rc, opts);
}

async function runInProcess(rc: RunnerDynamic, opts: RunnerDynamic): Promise<RunnerDynamic> {
  const restore = applyProcessEnv(opts.env || {});
  try {
    return await runCase(rc, {
      runsRoot: opts.runsRoot,
      runId: opts.runId,
      mode: opts.mode,
      refresh: opts.refresh,
      grade: opts.grade,
      onEvent: opts.onEvent || (() => {}),
    });
  } finally {
    restore();
  }
}

async function runInContainer(rc: RunnerDynamic, opts: RunnerDynamic): Promise<RunnerDynamic> {
  const image = opts.image || process.env.PLAYTEST_JOB_IMAGE || "playtest-job:latest";
  const name = `playtest-case-${safeName(opts.runId)}`;
  // The child sees the workspace at /ws: translate every host path in the
  // resolved case (file, storage_state, init, compose, …) and the runs root.
  const payload = JSON.stringify({
    rc: translatePaths(rc, opts.workspaceRoot, CONTAINER_WS),
    opts: {
      runsRoot: translatePaths(opts.runsRoot, opts.workspaceRoot, CONTAINER_WS),
      runId: opts.runId,
      mode: opts.mode,
      refresh: opts.refresh,
      grade: opts.grade,
    },
  });
  const env = { ...process.env, ...(opts.env || {}) };
  const args = [
    "run", "--rm", "--init", "-i",
    "--name", name,
    "-v", `${opts.workspaceRoot}:${CONTAINER_WS}`,
    "-w", CONTAINER_WS,
    // Reach services on the runner host (an app under test bound to localhost)
    // as host.docker.internal — mapped to the host gateway on Linux too.
    "--add-host", "host.docker.internal:host-gateway",
    "--memory", opts.memory || process.env.PLAYTEST_CASE_MEMORY || "2g",
    "--cpus", opts.cpus || process.env.PLAYTEST_CASE_CPUS || "2",
  ];
  for (const key of Object.keys(opts.env || {})) args.push("-e", key);
  for (const key of PASSTHROUGH_ENV) if (env[key] !== undefined) args.push("-e", key);
  // Managed-compose cases get the docker socket ONLY when the pool is
  // capability-gated for it (runner labels include "docker" — §3).
  if (rc.env?.compose && opts.allowDocker) args.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
  args.push(image, "node", CHILD);

  return await new Promise<RunnerDynamic>((resolve, reject) => {
    const child = childProcess.spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env });
    activeContainers.add(name);
    // The child speaks NDJSON: {"event": …} lines stream engine progress out of
    // the container, {"result": …} carries the run. Events are surfaced to
    // opts.onEvent as they arrive (a listener throw never breaks the case —
    // core's own emit discipline); a job image predating the framing writes one
    // bare JSON object with no newline, which lands in the line remainder.
    let buf = "";
    let stderr = "";
    let result: RunnerDynamic;
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: RunnerDynamic;
        try {
          frame = JSON.parse(line);
        } catch {
          continue; // stray child output (a dependency writing to stdout) is not a frame
        }
        if (frame && typeof frame === "object" && "result" in frame) result = frame.result;
        else if (frame && typeof frame === "object" && "event" in frame) {
          try {
            opts.onEvent?.(frame.event);
          } catch {}
        }
      }
    });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      activeContainers.delete(name);
      reject(e);
    });
    child.on("close", (code) => {
      activeContainers.delete(name);
      if (code !== 0) return reject(new Error(firstLine(stderr) || `docker exited ${code}`));
      try {
        if (result === undefined) result = JSON.parse(buf); // pre-framing child
        resolve(translatePaths(result, CONTAINER_WS, opts.workspaceRoot));
      } catch (e: RunnerDynamic) {
        reject(new Error(`container returned invalid JSON: ${e.message}`));
      }
    });
    child.stdin.end(payload);
  });
}

/** Deep-copy `value`, rewriting string prefixes `from` → `to` (path translation). */
export function translatePaths(value: RunnerDynamic, from: string, to: string): RunnerDynamic {
  if (typeof value === "string") {
    if (value === from) return to;
    if (value.startsWith(from + "/")) return to + value.slice(from.length);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => translatePaths(v, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, translatePaths(v, from, to)]));
  }
  return value;
}

export function applyProcessEnv(extra: Record<string, unknown>): () => void {
  const acquired: string[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const k of acquired) {
      const lease = envLeases.get(k);
      if (!lease) continue;
      lease.count -= 1;
      if (lease.count > 0) continue;
      if (lease.previous === undefined) delete process.env[k];
      else process.env[k] = lease.previous;
      envLeases.delete(k);
    }
  };
  try {
    for (const [k, v] of Object.entries(extra)) {
      const value = String(v);
      const lease = envLeases.get(k);
      if (lease) {
        if (lease.value !== value) {
          throw new Error(`concurrent process-isolated cases requested different values for ${k}`);
        }
        lease.count += 1;
      } else {
        envLeases.set(k, {
          count: 1,
          value,
          previous: Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined,
        });
        process.env[k] = value;
      }
      acquired.push(k);
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

function firstLine(s: unknown): string {
  return String(s || "").split("\n").find((l) => l.trim()) ?? "";
}

function safeName(s: unknown): string {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "case";
}
