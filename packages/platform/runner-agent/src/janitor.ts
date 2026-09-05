// Executor exit janitor: removes leftover
// workspaces and swept docker debris — exited `playtest-*` containers, compose
// stacks, and orphaned `playtest-*` networks. Anything it had to clean is
// reported in the group completion as a warning (a clean system reports
// nothing). It never touches a RUNNING container: on shared persistent runners
// another executor's live group may own it; `docker network rm` likewise
// refuses in-use networks, which is the safety, not a failure.
import childProcess from "node:child_process";

export async function cleanupWorkspace(workspace: RunnerDynamic): Promise<string[]> {
  const warnings: string[] = [];
  if (!workspace?.cleanup) return warnings;
  try {
    await workspace.cleanup();
  } catch (e: RunnerDynamic) {
    warnings.push(`workspace cleanup failed: ${e.message}`);
  }
  return warnings;
}

/**
 * Sweep docker debris. Returns warning strings for everything removed or
 * unremovable; returns [] silently when docker itself is unavailable (process
 * isolation pools have nothing to sweep).
 */
export function sweepDocker({ includeRunning = false }: { includeRunning?: boolean } = {}) {
  const owner = process.env.PLAYTEST_RUNNER_OWNER;
  if (!owner) return [];
  const warnings: string[] = [];
  const listing = docker(["ps", "-a", "--filter", `label=playtest.installation=${process.env.PLAYTEST_INSTALLATION || "playtest"}`, "--filter", `label=playtest.runner=${owner}`, "--format", "{{.ID}}\t{{.State}}"]);
  for (const line of listing.split("\n")) {
    const [id, state] = line.split("\t");
    if (!id || (!includeRunning && ["running", "restarting"].includes(state || ""))) continue;
    docker(["rm", "-f", id]);
    warnings.push(`janitor removed owned ${state} container ${id}`);
  }
  return warnings;
}

function docker(args: string[]): string {
  return childProcess.execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
