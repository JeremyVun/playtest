import fs from "node:fs";
import { execFileSync } from "node:child_process";

export function recordHealthy(): void {
  const file = process.env.PLAYTEST_RUNNER_HEALTH_FILE;
  if (!file) return;
  fs.writeFileSync(`${file}.tmp`, String(Date.now()), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
export function checkRunnerHealth(): void {
  const file = process.env.PLAYTEST_RUNNER_HEALTH_FILE;
  if (!file || Date.now() - Number(fs.readFileSync(file, "utf8")) > 90_000) throw new Error("Runner has no recent successful poll or heartbeat");
  execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "pipe", timeout: 5000 });
  execFileSync("docker", ["image", "inspect", process.env.PLAYTEST_JOB_IMAGE || ""], { stdio: "pipe", timeout: 5000 });
}
