// Managed (compose) / external environments, health probe, init scripts. See docs/CONTRACTS.md §9.
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFile = promisify(execFileCb);

export class InfraError extends Error {}

let bootCounter = 0; // unique compose project per boot within this process

/**
 * Boot (managed) or probe (external) the app under test, then run the init script.
 * @returns {Promise<{ baseUrl: string, managed: boolean, teardown: () => Promise<void> }>}
 * @throws {InfraError} on boot/probe/init failure
 */
export async function prepareEnv(resolvedCase, runId) {
  const env = resolvedCase.env;
  let baseUrl = env.base_url;
  let managed = false;
  let teardown = async () => {};

  if (env.compose) {
    managed = true;
    // compose project names must be lowercase [a-z0-9_-]
    const project = `dummy-${runId}-${++bootCounter}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const compose = (args, opts = {}) =>
      execFile("docker", ["compose", "-f", env.compose, "-p", project, ...args], opts);
    teardown = async () => {
      try {
        await compose(["down", "-v"], { timeout: 60000 });
      } catch {}
    };
    try {
      await compose(["up", "-d", "--wait"], { timeout: 180000 });
      baseUrl = await resolveComposeUrl(compose, baseUrl);
    } catch (e) {
      await teardown();
      throw new InfraError(`compose boot failed (${env.compose}): ${detail(e)}`);
    }
  }

  try {
    await probe(baseUrl);
    if (env.init) await runInit(env.init, baseUrl, runId);
  } catch (e) {
    await teardown();
    throw e instanceof InfraError ? e : new InfraError(detail(e));
  }

  return { baseUrl, managed, teardown };
}

/** If base_url's hostname is a compose service, rewrite to its published localhost port. */
async function resolveComposeUrl(compose, baseUrl) {
  const url = new URL(baseUrl);
  const { stdout } = await compose(["config", "--services"]);
  if (!stdout.split("\n").map((s) => s.trim()).includes(url.hostname)) return baseUrl;
  const containerPort = url.port || (url.protocol === "https:" ? "443" : "80");
  const { stdout: portOut } = await compose(["port", url.hostname, containerPort]);
  const published = portOut.trim().split(":").pop();
  if (!published) throw new Error(`no published port for service ${url.hostname}:${containerPort}`);
  url.hostname = "localhost";
  url.port = published;
  return url.href;
}

/** GET base_url; ok when status < 500. 5 attempts, 1s apart. */
async function probe(baseUrl) {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return;
      last = `status ${res.status}`;
    } catch (e) {
      last = e.cause?.code || detail(e.cause ?? e) || detail(e);
    }
  }
  throw new InfraError(`health probe failed for ${baseUrl}: ${last}`);
}

async function runInit(script, baseUrl, runId) {
  try {
    await execFile(script, [], {
      cwd: path.dirname(script),
      env: { ...process.env, BASE_URL: baseUrl, RUN_ID: runId },
      timeout: 60000,
    });
  } catch (e) {
    const stderr = e.stderr ? `: ${String(e.stderr).trim()}` : "";
    throw new InfraError(`init script failed (${script}): ${detail(e)}${stderr}`);
  }
}

function detail(e) {
  return String(e?.message ?? e).split("\n")[0];
}
