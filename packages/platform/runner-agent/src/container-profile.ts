import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolOptions } from "./pool.ts";

export function runnerOwner(credential: string): string { return createHash("sha256").update(credential).digest("hex").slice(0, 24); }
export function jobProfile(env: NodeJS.ProcessEnv = process.env) {
  const image = env.PLAYTEST_JOB_IMAGE;
  if (!image || image.endsWith(":latest") || (!image.includes(":") && !image.includes("@sha256:"))) throw new Error("PLAYTEST_JOB_IMAGE must name the matching release tag or digest");
  const network = env.PLAYTEST_JOB_NETWORK;
  if (!network || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)) throw new Error("PLAYTEST_JOB_NETWORK must name the target Docker network");
  const uid = env.PLAYTEST_JOB_UID || "1000", gid = env.PLAYTEST_JOB_GID || "1000";
  if (!/^[1-9][0-9]*$/.test(uid) || !/^[0-9]+$/.test(gid)) throw new Error("PLAYTEST_JOB_UID must be non-root and PLAYTEST_JOB_GID numeric");
  const memory = env.PLAYTEST_CASE_MEMORY || "2g", cpus = env.PLAYTEST_CASE_CPUS || "2";
  const pids = env.PLAYTEST_CASE_PIDS || "512", shm = env.PLAYTEST_CASE_SHM || "512m";
  if (!/^[1-9][0-9]*[mg]$/i.test(memory) || !/^[1-9][0-9]*[mg]$/i.test(shm) || !Number.isFinite(Number(cpus)) || Number(cpus) <= 0 || Number(cpus) > 32 || !/^[1-9][0-9]*$/.test(pids) || Number(pids) > 4096) throw new Error("Invalid PLAYTEST_CASE_MEMORY/CPUS/PIDS/SHM limits");
  const installation = env.PLAYTEST_INSTALLATION || "playtest";
  const owner = env.PLAYTEST_RUNNER_OWNER;
  if (!owner) throw new Error("Runner ownership is unavailable; start through runner-agent pool");
  return { image, network, uid, gid, installation, owner, memory, cpus, pids, shm };
}

export function jobArguments(executor: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const p = jobProfile(env);
  return ["--network", p.network, "--user", `${p.uid}:${p.gid}`, "--memory", p.memory, "--memory-swap", p.memory, "--cpus", p.cpus, "--pids-limit", p.pids, "--shm-size", p.shm,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--label", `playtest.installation=${p.installation}`, "--label", `playtest.runner=${p.owner}`, "--label", `playtest.executor=${executor}`];
}

export async function preflightContainers(opts: PoolOptions, env: NodeJS.ProcessEnv): Promise<void> {
  const p = jobProfile(env);
  if (!path.isAbsolute(opts.workDir) || opts.workDir.includes(":")) throw new Error("PLAYTEST_RUNNER_WORKDIR must be an absolute host path mounted at the same path in the runner");
  const imageRevision = execFileSync("docker", ["image", "inspect", p.image, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}'], { encoding: "utf8", timeout: 10000 }).trim();
  if (!env.PLAYTEST_IMAGE_REVISION || imageRevision !== env.PLAYTEST_IMAGE_REVISION) throw new Error("Job image revision does not match this runner; build or pull the matching job release");
  await fs.mkdir(opts.workDir, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(opts.workDir, ".preflight-"));
  const nonce = randomBytes(16).toString("hex");
  await fs.writeFile(path.join(dir, "input"), nonce, { mode: 0o600 });
  try {
    execFileSync("docker", ["run", "--rm", ...jobArguments("preflight", env), "-v", `${dir}:/probe`, p.image, "node", "--input-type=module", "-e", 'import fs from "node:fs"; fs.writeFileSync("/probe/output", fs.readFileSync("/probe/input"));'], { stdio: "pipe", timeout: 30000 });
    if (await fs.readFile(path.join(dir, "output"), "utf8") !== nonce) throw new Error("Job workspace mount does not point at the runner's host directory");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
