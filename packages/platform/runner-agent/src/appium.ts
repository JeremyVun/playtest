// Appium backends: the runner-side half of "hosted mobile stops meaning
// remember to hand-start Appium" (docs/contracts/interfaces.md, "Appium
// backends").
//
// Two modes, one interface. `managed` spawns an Appium of its own on an unused
// LOOPBACK port, health-checks it, supervises it, and tears it down with the
// group. `external` dials an Appium somebody else runs, optionally presenting a
// credential that only ever travels as a file path or an environment variable
// name — never through the group spec, the runtime target, or any recorded
// shape.
//
// Two questions this module answers, deliberately kept apart:
//
//   startable() — asked BEFORE claiming, so it must be cheap, cached, and
//                 honest about its limits: it proves the pieces exist (an
//                 Appium binary and the platform driver; an external endpoint
//                 that answers), never that a session will succeed. Real health
//                 is only knowable after the claim, when the backend spawns.
//   open()      — asked AFTER claiming. It starts or dials for real and throws
//                 one actionable line when it cannot.
//
// Nothing here installs anything. A missing platform driver is reported with
// the exact `appium driver install …` command and left to the operator: a
// runner that silently mutates its own toolchain is a runner nobody can reason
// about.
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import type { AppiumBackend, MobilePlatform } from "./runner-config.ts";

/** Appium's own driver names, by the platform a binding declares. */
export const PLATFORM_DRIVER: Record<MobilePlatform, string> = { ios: "xcuitest", android: "uiautomator2" };

/** How long a `startable()` answer is reused before it is asked again. */
const PROBE_TTL_MS = 60_000;
/** A status probe is a loopback GET; anything slower is "not answering". */
const STATUS_TIMEOUT_MS = 3_000;
/** How long a spawned Appium may take to answer `/status` before it is a failure. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 200;
/** How much of a managed server's stderr is kept for a death diagnostic. */
const STDERR_TAIL = 4_000;

/** How the Appium server is started: `node <entry>` or an `appium` on PATH. */
export interface AppiumCommand {
  command: string;
  args: string[];
  label: string;
}

/** A live backend, held for the length of one run group. */
export interface AppiumHandle {
  name: string;
  /** Where the mobile driver dials. Never leaves this machine. */
  url: string;
  /**
   * The local-only driver input carrying an external backend's credential
   * (docs/contracts/engine.md, "Mobile driver"). A file path or a value, in the
   * environment of the case process — never in the runtime target.
   */
  credentialEnv: Record<string, string>;
  /** Non-null once a managed server has exited; the platform-safe diagnostic. */
  died: () => string | null;
  close: () => Promise<void>;
}

export interface AppiumDeps {
  spawn?: typeof childProcess.spawn;
  /** `appium driver list --installed --json`, as installed driver names. */
  installedDrivers?: (cmd: AppiumCommand) => Promise<string[]>;
  /** Does an Appium answer `<url>/status`? */
  statusOk?: (url: string, timeoutMs: number) => Promise<boolean>;
  findAppium?: () => AppiumCommand | null;
  freePort?: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Local log detail — paths and stderr a person on this machine may see. */
  log?: (line: string) => void;
}

export class AppiumBackends {
  #deps: Required<Omit<AppiumDeps, "installedDrivers">> & { installedDrivers: (cmd: AppiumCommand) => Promise<string[]> };
  #probes = new Map<string, { at: number; reason: string | null }>();
  #drivers: Promise<string[]> | null = null;

  constructor(deps: AppiumDeps = {}) {
    this.#deps = {
      spawn: deps.spawn ?? childProcess.spawn,
      installedDrivers: deps.installedDrivers ?? defaultInstalledDrivers,
      statusOk: deps.statusOk ?? probeAppiumStatus,
      findAppium: deps.findAppium ?? defaultFindAppium,
      freePort: deps.freePort ?? defaultFreePort,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.())),
      env: deps.env ?? process.env,
      log: deps.log ?? (() => {}),
    };
  }

  /**
   * Can this backend be started here? Null when it can. Cached per backend for
   * a session window, because this runs against every mobile offer on every
   * page and the underlying probes are a subprocess and a socket.
   */
  async startable(backend: AppiumBackend): Promise<string | null> {
    const cached = this.#probes.get(backend.name);
    if (cached && this.#deps.now() - cached.at < PROBE_TTL_MS) return cached.reason;
    const reason = await this.#probe(backend);
    this.#probes.set(backend.name, { at: this.#deps.now(), reason });
    return reason;
  }

  async #probe(backend: AppiumBackend): Promise<string | null> {
    if (backend.mode === "external") {
      const ok = await this.#deps.statusOk(backend.url!, STATUS_TIMEOUT_MS);
      return ok ? null : `nothing is answering ${backend.url}/status`;
    }
    const cmd = this.#deps.findAppium();
    if (!cmd) return missingAppium();
    const driver = PLATFORM_DRIVER[backend.platform];
    const installed = await this.#installedDrivers(cmd);
    return installed.includes(driver) ? null : missingDriver(driver);
  }

  /** The installed driver list, asked once per session (it costs a subprocess). */
  #installedDrivers(cmd: AppiumCommand): Promise<string[]> {
    this.#drivers ??= this.#deps.installedDrivers(cmd).catch(() => []);
    return this.#drivers;
  }

  /**
   * Which Appium drivers this machine has installed, for the post-claim
   * preflight. Empty when no Appium is installed here at all — a managed
   * backend cannot have opened in that case, so the caller is already past it.
   */
  async driverNames(): Promise<string[]> {
    const cmd = this.#deps.findAppium();
    return cmd ? await this.#installedDrivers(cmd) : [];
  }

  /** Does an Appium answer here? The same probe the pre-claim check uses. */
  statusOk(url: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<boolean> {
    return this.#deps.statusOk(url, timeoutMs);
  }

  /**
   * Start or dial the backend for one run group. Throws one actionable line;
   * the caller classifies it as an infra failure.
   */
  async open(backend: AppiumBackend): Promise<AppiumHandle> {
    // A fresh answer either way: `startable` is a cached pre-claim hint, and
    // this is the moment the group actually depends on it.
    this.#probes.delete(backend.name);
    return backend.mode === "external" ? await this.#dial(backend) : await this.#spawn(backend);
  }

  async #dial(backend: AppiumBackend): Promise<AppiumHandle> {
    const url = backend.url!;
    if (!(await this.#deps.statusOk(url, STATUS_TIMEOUT_MS))) {
      throw new Error(
        `the Appium backend "${backend.name}" this runner is configured with is not answering — ` +
          `check that the external Appium named in the runner's config file is running and reachable from this machine`,
      );
    }
    this.#deps.log(`appium: using the external backend "${backend.name}" at ${url}`);
    return {
      name: backend.name,
      url,
      credentialEnv: credentialEnvFor(backend, this.#deps.env),
      died: () => null,
      close: async () => {},
    };
  }

  async #spawn(backend: AppiumBackend): Promise<AppiumHandle> {
    const cmd = this.#deps.findAppium();
    if (!cmd) throw new Error(missingAppium());
    const driver = PLATFORM_DRIVER[backend.platform];
    const installed = await this.#installedDrivers(cmd);
    if (!installed.includes(driver)) throw new Error(missingDriver(driver));

    const port = await this.#deps.freePort();
    // Loopback only, always: a managed Appium has full control of a device and
    // must never be reachable from anywhere but this machine.
    const args = [...cmd.args, "--address", "127.0.0.1", "--port", String(port), "--base-path", "/", "--log-level", "error"];
    const url = `http://127.0.0.1:${port}`;
    const child = this.#deps.spawn(cmd.command, args, {
      env: { ...this.#deps.env, APPIUM_HOME: appiumHome(this.#deps.env) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: RunnerDynamic) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
    });
    // A holder rather than two `let`s: these are written from event callbacks,
    // which control-flow analysis does not follow — a narrowed local would read
    // as permanently null to the compiler.
    const state: { exit: { code: number | null; signal: string | null } | null; error: RunnerDynamic } = { exit: null, error: null };
    child.once("exit", (code: RunnerDynamic, signal: RunnerDynamic) => {
      state.exit = { code: code ?? null, signal: signal ?? null };
    });
    child.once("error", (e: RunnerDynamic) => {
      state.error = e;
    });

    let closed = false;
    const stop = async () => {
      if (closed) return;
      closed = true;
      if (state.exit) return;
      try {
        child.kill("SIGTERM");
      } catch {}
      for (let i = 0; i < 25 && !state.exit; i++) await this.#deps.sleep(READY_POLL_MS);
      if (!state.exit) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };

    const deadline = this.#deps.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (state.error) {
        await stop();
        throw new Error(`could not start Appium on this runner (${firstLine(state.error)}) — ${INSTALL_HINT}`);
      }
      if (state.exit) {
        this.#deps.log(`appium: the managed backend "${backend.name}" exited before it was ready:\n${stderr}`);
        throw new Error(
          `Appium did not start on this runner for backend "${backend.name}" (${exitWord(state.exit)})` +
            tail(stderr, ": ", ""),
        );
      }
      if (await this.#deps.statusOk(url, STATUS_TIMEOUT_MS)) break;
      if (this.#deps.now() > deadline) {
        await stop();
        throw new Error(
          `Appium did not answer on this runner within ${Math.round(READY_TIMEOUT_MS / 1000)}s for backend "${backend.name}"` +
            tail(stderr, " — ", ""),
        );
      }
      await this.#deps.sleep(READY_POLL_MS);
    }
    this.#deps.log(`appium: started a managed backend "${backend.name}" on ${url} (${cmd.label})`);

    return {
      name: backend.name,
      url,
      credentialEnv: {},
      // Redacted on purpose: a death diagnostic reaches the platform as a run's
      // infra error, so it carries an exit status and at most one sanitized
      // line — never the paths Appium logs.
      died: () => {
        if (closed || !state.exit) return null;
        return (
          `the Appium backend "${backend.name}" on this runner exited while the group was running (${exitWord(state.exit)})` +
          tail(stderr, " — ", "")
        );
      },
      close: async () => {
        const wasRunning = !state.exit;
        await stop();
        if (!wasRunning) this.#deps.log(`appium: the managed backend "${backend.name}" had already exited:\n${stderr}`);
      },
    };
  }
}

/**
 * The environment a case process needs to present an external backend's
 * credential. A file path stays a file path — the value never enters this
 * process's environment at all — and an environment-named credential is copied
 * across under the name core reads.
 */
export function credentialEnvFor(backend: AppiumBackend, env: NodeJS.ProcessEnv): Record<string, string> {
  if (backend.credentialFile) return { PLAYTEST_APPIUM_CREDENTIAL_FILE: backend.credentialFile };
  if (backend.credentialEnv) {
    const value = String(env[backend.credentialEnv] ?? "");
    if (value) return { PLAYTEST_APPIUM_CREDENTIAL: value };
  }
  return {};
}

const INSTALL_HINT = "install it in this checkout (npm install) or globally (npm i -g appium)";

const missingAppium = () =>
  `the Appium server is not installed on this runner — ${INSTALL_HINT}, then restart the agent`;

const missingDriver = (driver: string) =>
  `the Appium "${driver}" driver is not installed on this runner — run: appium driver install ${driver}`;

const exitWord = (exit: { code: number | null; signal: string | null }) =>
  exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`;

/**
 * One sanitized line of a server's own output. Absolute paths are replaced
 * wholesale: this text crosses to the platform, and a runner's filesystem
 * layout is exactly the kind of physical fact that must not.
 */
function tail(stderr: string, prefix: string, fallback: string): string {
  const line = stderr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (!line) return fallback;
  return prefix + line.replace(/(?:[A-Za-z]:)?[/\\][^\s"']{2,}/g, "<path>").slice(0, 200);
}

function appiumHome(env: NodeJS.ProcessEnv): string {
  // Appium 2+/3 otherwise treats a project-local `appium` dependency as its home
  // and installs platform drivers INTO the checkout; the shared per-user home is
  // where `appium driver install` puts them by default.
  return env.APPIUM_HOME || path.join(env.HOME || env.USERPROFILE || ".", ".appium");
}

/** The `appium` server package in this installation, or an `appium` on PATH. */
function defaultFindAppium(): AppiumCommand | null {
  try {
    const entry = path.join(path.dirname(createRequire(import.meta.url).resolve("appium/package.json")), "index.js");
    if (fs.existsSync(entry)) return { command: process.execPath, args: [entry], label: entry };
  } catch {}
  const onPath = whichAppium(process.env.PATH || "");
  return onPath ? { command: onPath, args: [], label: onPath } : null;
}

function whichAppium(rawPath: string): string | null {
  for (const dir of rawPath.split(path.delimiter).filter(Boolean)) {
    for (const name of process.platform === "win32" ? ["appium.cmd", "appium.exe", "appium"] : ["appium"]) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function defaultInstalledDrivers(cmd: AppiumCommand): Promise<string[]> {
  return new Promise((resolve) => {
    childProcess.execFile(
      cmd.command,
      [...cmd.args, "driver", "list", "--installed", "--json"],
      { encoding: "utf8", timeout: 120_000, env: { ...process.env, APPIUM_HOME: appiumHome(process.env) } },
      (error, stdout) => {
        if (error) return resolve([]);
        try {
          resolve(Object.keys(JSON.parse(String(stdout))));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/** Does an Appium answer `<url>/status`? The one liveness question this module asks. */
export async function probeAppiumStatus(url: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** An unused loopback port, taken by binding and releasing one. */
function defaultFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
