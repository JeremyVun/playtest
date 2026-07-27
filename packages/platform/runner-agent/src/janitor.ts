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
export function sweepDocker() {
  const warnings: string[] = [];
  let listing;
  try {
    listing = docker(["ps", "-a", "--filter", "name=playtest-", "--format", "{{.Names}}\t{{.State}}"]);
  } catch {
    return warnings;
  }
  for (const line of listing.split("\n")) {
    const [name, state] = line.split("\t");
    if (!name || !name.startsWith("playtest-")) continue;
    if (state === "running" || state === "restarting") continue; // never another group's live work
    try {
      docker(["rm", "-f", name]);
      warnings.push(`janitor removed ${state ?? "stopped"} container ${name}`);
    } catch (e: RunnerDynamic) {
      warnings.push(`janitor could not remove container ${name}: ${firstLine(e.message)}`);
    }
  }
  try {
    const nets = docker(["network", "ls", "--filter", "name=playtest-", "--format", "{{.Name}}"]);
    for (const net of nets.split("\n")) {
      if (!net || !net.startsWith("playtest-")) continue;
      try {
        docker(["network", "rm", net]);
        warnings.push(`janitor removed network ${net}`);
      } catch {
        /* in use by a live stack — that's the safety working */
      }
    }
  } catch {
    /* network listing unavailable */
  }
  return warnings;
}

function docker(args: string[]): string {
  return childProcess.execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function firstLine(s: unknown): string {
  return String(s || "").split("\n").find((l) => l.trim()) ?? "";
}
