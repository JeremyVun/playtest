import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const state = path.join(root, ".playtest-compose");
const work = path.join(state, "runner");
const command = process.argv[2] || "up";
await fs.mkdir(work, { recursive: true, mode: 0o700 });
async function revision(): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await fs.readdir(path.join(root, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["node_modules", "build", "tests"].includes(entry.name)) continue;
      const file = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(ts|js|json|sql|css|html|yaml|yml|md)$/.test(file)) { hash.update(file); hash.update(await fs.readFile(path.join(root, file))); }
    }
  };
  await walk("packages");
  for (const file of ["Dockerfile", ".dockerignore", "package.json", "package-lock.json", "tsconfig.base.json", "docker-bake.hcl"]) { hash.update(file); hash.update(await fs.readFile(path.join(root, file))); }
  return hash.digest("hex").slice(0, 20);
}
const releaseFile = path.join(state, "release");
const release = ["up", "build"].includes(command) ? await revision() : (await fs.readFile(releaseFile, "utf8")).trim();
const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_DISABLE_ENV_FILE: "1", PLAYTEST_RELEASE: release, RELEASE: release, REVISION: release, PLAYTEST_RUNNER_WORKDIR: work,
  PLAYTEST_JOB_UID: String(process.getuid!()), PLAYTEST_JOB_GID: String(process.getgid!()), PLAYTEST_DOCKER_GID: process.env.PLAYTEST_DOCKER_GID || (process.platform === "darwin" ? "0" : String((await fs.stat("/var/run/docker.sock")).gid)) };
async function run(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`docker exited ${code}`)));
  });
}
try {
  if (["up", "build"].includes(command)) {
    await run(["buildx", "bake", "--load"]);
    await fs.writeFile(releaseFile, release + "\n");
  }
  if (command !== "build") {
    const args = ["up", "start"].includes(command) ? ["--profile", "test", "up", "-d", "--wait", "--wait-timeout", "180"] : command === "down" ? ["down"] : command === "logs" ? ["logs", "--tail", "100", "-f"] : command === "config" ? ["config", "--quiet"] : command === "status" ? ["ps"] : null;
    if (!args) throw new Error("Usage: compose.ts [up|start|build|down|logs|config|status]");
    await run(["compose", "--env-file", "/dev/null", "-f", "compose.yaml", ...args]);
    if (["up", "start"].includes(command)) process.stdout.write(`Playtest: http://127.0.0.1:${env.PLAYTEST_LOCAL_PORT || 4177}\nTest target inside jobs: http://test-target:4173\n`);
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
