// Managed (compose) / external environments, health probe, init scripts. See docs/CONTRACTS.md §9.
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { firstLine } from "./trajectory.js";

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
    const project = `playtest-${runId}-${++bootCounter}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
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
      throw new InfraError(`compose boot failed (${env.compose}): ${firstLine(e)}`);
    }
  }

  try {
    await probe(baseUrl, managed ? null : { caseFile: resolvedCase.file });
    if (env.init) await runInit(env.init, baseUrl, runId);
  } catch (e) {
    await teardown();
    throw e instanceof InfraError ? e : new InfraError(firstLine(e));
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
  // Match the shape of YAML-authored base_urls: URL.href appends a trailing
  // slash, and init scripts that concatenate "$BASE_URL/path" then hit
  // "//path", which routers 404.
  return url.pathname === "/" && !url.search ? url.origin : url.href;
}

/**
 * GET base_url; ok when status < 500. 5 attempts, 1s apart.
 * `external` ({ caseFile }) marks an unmanaged env: a localhost failure then
 * gets the "start the app or add app.compose" hint instead of the raw probe
 * error. Managed-mode failures keep the probe detail — compose is already
 * configured there, so the hint would mislead.
 */
async function probe(baseUrl, external = null) {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return;
      last = `status ${res.status}`;
    } catch (e) {
      last = e.cause?.code || firstLine(e.cause ?? e) || firstLine(e);
    }
  }
  if (external && isLocalUrl(baseUrl)) {
    throw new InfraError(externalProbeHint(baseUrl, external.caseFile));
  }
  throw new InfraError(`health probe failed for ${baseUrl}: ${last}`);
}

function isLocalUrl(baseUrl) {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

const dotRel = (from, to) => {
  const r = path.relative(from, to);
  return r.startsWith(".") ? r : `./${r}`;
};

function externalProbeHint(baseUrl, caseFile) {
  const lines = [
    `Could not reach ${baseUrl}.`,
    "Start the app yourself, or add app.compose to playtest.yaml so Playtest can manage it.",
  ];
  const compose = findComposeFile(caseFile);
  if (compose) {
    // The snippet gets pasted into a defaults file, and config.js resolves
    // app.compose against the DECLARING file's dir — so name that file and
    // compute the suggested path relative to it.
    const target = defaultsFileFor(caseFile);
    lines.push(
      `Found ${dotRel(process.cwd(), compose)}; add to ${dotRel(process.cwd(), target)}:`,
      "app:",
      `  compose: ${dotRel(path.dirname(target), compose)}`,
    );
  }
  return lines.join("\n");
}

/** First docker-compose*.yml/yaml next to the case file or in cwd, absolute. */
function findComposeFile(caseFile) {
  const dirs = [...(caseFile ? [path.dirname(caseFile)] : []), process.cwd()];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => n.startsWith("docker-compose") && /\.ya?ml$/.test(n));
    if (hit) return path.resolve(dir, hit);
  }
  return null;
}

/**
 * Nearest existing playtest.yaml from the case file's dir upward (stopping at
 * the repo root), else the playtest.yaml the user would create next to the
 * case file.
 */
function defaultsFileFor(caseFile) {
  const start = caseFile ? path.dirname(path.resolve(caseFile)) : process.cwd();
  for (let dir = start; ; ) {
    const file = path.join(dir, "playtest.yaml");
    if (fs.existsSync(file)) return file;
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  return path.join(start, "playtest.yaml");
}

async function runInit(script, baseUrl, runId) {
  // JS inits run via the current Node binary — shebang scripts don't exec on
  // Windows, and the bundled demo's reset.mjs relies on this.
  const jsInit = /\.(mjs|cjs|js)$/.test(script);
  try {
    await execFile(jsInit ? process.execPath : script, jsInit ? [script] : [], {
      cwd: path.dirname(script),
      env: { ...process.env, BASE_URL: baseUrl, RUN_ID: runId },
      timeout: 60000,
    });
  } catch (e) {
    const stderr = e.stderr ? `: ${String(e.stderr).trim()}` : "";
    throw new InfraError(`init script failed (${script}): ${firstLine(e)}${stderr}`);
  }
}
