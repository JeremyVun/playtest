// Per-case execution behind the isolation seam
// (docs/contracts/hosted.md#runner-protocol).
//
// BOTH isolations run the case in a CHILD PROCESS speaking one protocol
// (`case-runner-child.ts`): one JSON payload in on stdin, `{"event": …}` lines
// out for engine progress, then exactly one `{"result": …}` line. What differs
// is only how the child is reached and how it is stopped:
//
//   * container — an ephemeral `docker run --rm --init` from the pinned job
//     image with ONLY the group workspace mounted. Host paths are translated to
//     the /ws mount for the child and back for the caller; env reaches the
//     container via `-e VAR` flags with values carried in the docker client's
//     own environment (never argv, which would leak secrets to `ps`). Stopped
//     with `docker stop`.
//   * process — this machine's own `node`, running the same entry resolved
//     beside this file rather than inside the image. No path translation: the
//     child sees this machine's filesystem. Spawned DETACHED so it leads its own
//     process group, and stopped by signalling that GROUP — a browser, an
//     ffmpeg, or a hook's own children all go with it.
//
// The process boundary is what makes cancellation real. A cooperative
// `AbortSignal` cannot be the final barrier: third-party hooks and drivers may
// ignore it, and a mobile group's driver calls can block for minutes. A killed
// process group cannot.
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

/** Where the group workspace is mounted inside a case container. Exported
 * because streamed engine events carry these paths and the live uploader has to
 * translate them back the same way the final result is translated. */
export const CONTAINER_WS = "/ws";
/** The child entry inside the pinned job image. */
const CONTAINER_CHILD = "/opt/playtest/packages/platform/runner-agent/src/case-runner-child.ts";
/** The same entry on this machine, resolved relative to the repository checkout. */
const LOCAL_CHILD = fileURLToPath(new URL("./case-runner-child.ts", import.meta.url));

/**
 * How long a cancelled case may take to stop on its own before its process
 * group is force-killed. Long enough for core's own teardown (a browser close,
 * an artifact flush) and short enough that a cancel is a bounded wait rather
 * than an open one.
 */
export const CANCEL_GRACE_MS = 5_000;

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

/**
 * One case currently executing on this runner. The registry lives beside the
 * code that spawns them — cancellation has to reach a child from a signal
 * handler, so `stop()` is synchronous and idempotent — and `exec-group.ts`
 * drives it through `stopActiveCases()` on cancel, on SIGTERM, and on a
 * stale-owner refusal.
 */
interface ActiveCase {
  /** The child's pid, which IS its process-group id under process isolation. */
  pid: number | null;
  /** Graceful signal now, force-kill after the grace period. Idempotent. */
  stop: () => void;
}

const active = new Set<ActiveCase>();

/** Pids of case children currently running. The test seam for "it is gone". */
export function activeCasePids(): number[] {
  return [...active].map((c) => c.pid).filter((p): p is number => p !== null);
}

/**
 * Stop every case in flight: `docker stop` each container, and signal each
 * process-isolated child's PROCESS GROUP (SIGTERM, then SIGKILL after the grace
 * period). The in-flight `runCaseIsolated` then rejects with a cancellation, so
 * the case reports canceled and never a product verdict.
 *
 * Sync on purpose: callable from a signal handler.
 */
export function stopActiveCases(): number {
  const stopping = [...active];
  for (const entry of stopping) entry.stop();
  return stopping.length;
}

export async function runCaseIsolated(rc: RunnerDynamic, opts: RunnerDynamic): Promise<RunnerDynamic> {
  if (opts.isolation === "container") return await runInContainer(rc, opts);
  return await runInProcess(rc, opts);
}

/** The child half of the case options — everything the engine needs, nothing local. */
function childOpts(opts: RunnerDynamic): RunnerDynamic {
  return {
    runsRoot: opts.runsRoot,
    runId: opts.runId,
    mode: opts.mode,
    refresh: opts.refresh,
    grade: opts.grade,
  };
}

async function runInProcess(rc: RunnerDynamic, opts: RunnerDynamic): Promise<RunnerDynamic> {
  // Each child owns its own environment: the group's secret env is spread into
  // the SPAWN environment, never into this long-lived agent's `process.env` and
  // never into argv. That is what retired the reference-counted env overlay two
  // concurrent process-isolated cases used to share.
  const env = { ...process.env, ...(opts.env || {}) };
  // A mobile group's Appium backend stays in the agent; the child reaches it
  // over loopback through the runtime target already resolved into `rc`,
  // exactly as a container case reaches a service on the runner host.
  return await runChildCase({
    command: opts.nodePath || process.execPath,
    args: [opts.childEntry || LOCAL_CHILD],
    env,
    payload: JSON.stringify({ rc, opts: childOpts(opts) }),
    detached: true,
    container: null,
    graceMs: opts.graceMs ?? CANCEL_GRACE_MS,
    spawn: opts.spawn || childProcess.spawn,
    onEvent: opts.onEvent,
    exitLabel: (code: number | null) => `case child exited ${code}`,
  });
}

async function runInContainer(rc: RunnerDynamic, opts: RunnerDynamic): Promise<RunnerDynamic> {
  const image = opts.image || process.env.PLAYTEST_JOB_IMAGE || "playtest-job:latest";
  const name = `playtest-case-${safeName(opts.runId)}`;
  // The child sees the workspace at /ws: translate every host path in the
  // resolved case (file, storage_state, init, compose, …) and the runs root.
  const payload = JSON.stringify({
    rc: translatePaths(rc, opts.workspaceRoot, CONTAINER_WS),
    opts: {
      ...childOpts(opts),
      runsRoot: translatePaths(opts.runsRoot, opts.workspaceRoot, CONTAINER_WS),
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
  args.push(image, "node", CONTAINER_CHILD);

  const result = await runChildCase({
    command: "docker",
    args,
    env,
    payload,
    detached: false,
    container: name,
    graceMs: opts.graceMs ?? CANCEL_GRACE_MS,
    spawn: opts.spawn || childProcess.spawn,
    onEvent: opts.onEvent,
    exitLabel: (code: number | null) => `docker exited ${code}`,
  });
  return translatePaths(result, CONTAINER_WS, opts.workspaceRoot);
}

interface ChildCaseSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  payload: string;
  /** Lead a new process group, so cancellation can signal the whole tree. */
  detached: boolean;
  /** The container name to `docker stop`, or null for a local child. */
  container: string | null;
  graceMs: number;
  spawn: typeof childProcess.spawn;
  onEvent?: (event: RunnerDynamic) => void;
  exitLabel: (code: number | null) => string;
}

/**
 * Drive one child through the case protocol and resolve its result.
 *
 * Every exit path removes the child from the active registry, clears the
 * force-kill timer, and drops its listeners. A child this executor STOPPED
 * always rejects as a cancellation, whatever exit status the race produced: a
 * cancelled case never reports success or a product failure.
 */
function runChildCase(spec: ChildCaseSpec): Promise<RunnerDynamic> {
  return new Promise<RunnerDynamic>((resolve, reject) => {
    const child = spec.spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: spec.env,
      detached: spec.detached,
    });
    let stopped = false;
    let killTimer: NodeJS.Timeout | null = null;
    const entry: ActiveCase = {
      pid: child.pid ?? null,
      stop: () => {
        if (stopped) return;
        stopped = true;
        terminate(child, spec, "graceful");
        // Deliberately NOT unref'd: this is the force-kill that makes the grace
        // period bounded, and an unref'd timer would let the agent exit while a
        // child it asked to stop is still running.
        killTimer = setTimeout(() => terminate(child, spec, "force"), spec.graceMs);
      },
    };
    active.add(entry);

    let buf = "";
    let stderr = "";
    let result: RunnerDynamic;
    let settled = false;
    const settle = (fn: (value: RunnerDynamic) => void, value: RunnerDynamic) => {
      if (settled) return;
      settled = true;
      active.delete(entry);
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      fn(value);
    };

    // The child speaks NDJSON: {"event": …} lines stream engine progress out,
    // {"result": …} carries the run. Events are surfaced to opts.onEvent as they
    // arrive (a listener throw never breaks the case — core's own emit
    // discipline); a job image predating the framing writes one bare JSON object
    // with no newline, which lands in the line remainder.
    child.stdout?.on("data", (c: RunnerDynamic) => {
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
            spec.onEvent?.(frame.event);
          } catch {}
        }
      }
    });
    child.stderr?.on("data", (c: RunnerDynamic) => (stderr += c));
    child.on("error", (e: RunnerDynamic) => settle(reject, e));
    child.on("close", (code: number | null) => {
      // A child this executor asked to stop is a CANCELLATION, whatever the exit
      // status says — including a zero it managed to reach in the gap.
      if (stopped) return settle(reject, new Error("the executor stopped this case (canceled)"));
      if (code !== 0) return settle(reject, new Error(firstLine(stderr) || spec.exitLabel(code)));
      try {
        if (result === undefined) result = JSON.parse(buf); // pre-framing child
        settle(resolve, result);
      } catch (e: RunnerDynamic) {
        settle(reject, new Error(`the case child returned invalid JSON: ${e.message}`));
      }
    });
    // A payload write can lose its race with a child that died on spawn; the
    // close/error handler above is the one that decides the outcome.
    child.stdin?.on("error", () => {});
    child.stdin?.end(spec.payload);
  });
}

/**
 * Stop one child. A container is stopped through docker (it is the only handle
 * on a process tree in another namespace); a local child is signalled by
 * PROCESS GROUP, never by pid alone — killing the node process would orphan the
 * browser, the ffmpeg and every other descendant it started.
 */
function terminate(child: RunnerDynamic, spec: ChildCaseSpec, phase: "graceful" | "force") {
  if (spec.container) {
    try {
      const args = phase === "graceful"
        ? ["stop", "--time", "5", spec.container]
        : ["kill", spec.container];
      childProcess.execFileSync("docker", args, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  const signal = phase === "graceful" ? "SIGTERM" : "SIGKILL";
  const pid = child.pid;
  if (!pid) return;
  try {
    // Negative pid: the whole process group the detached spawn created.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
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

function firstLine(s: unknown): string {
  return String(s || "").split("\n").find((l) => l.trim()) ?? "";
}

function safeName(s: unknown): string {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "case";
}
