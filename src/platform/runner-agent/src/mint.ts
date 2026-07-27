// Clean-room execution of a `script` auth provider's mint grant. The provider
// code runs with only the grant's resolved
// root secrets + identity vars in env — never the group workspace, never suite
// code — and must print a Playwright storage-state JSON to stdout. Container
// isolation mounts the script read-only and passes env through the docker
// client's own environment (never argv, which would leak values to `ps`).
import childProcess from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

const STDOUT_LIMIT = 8 * 1024 * 1024;

export async function runMintScript(grant: RunnerDynamic, { isolation = "process", workDir, image = null }: RunnerDynamic = {}): Promise<RunnerDynamic> {
  const dir = path.join(workDir, "mints", safeName(grant.claim_id));
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const script = path.join(dir, "mint.mjs");
  await fsp.writeFile(script, String(grant.code ?? ""), { mode: 0o600 });
  const env = {
    ...(grant.env || {}),
    PLAYTEST_PROVIDER: grant.provider,
    PLAYTEST_IDENTITY: grant.identity,
    PLAYTEST_IDENTITY_CONFIG: JSON.stringify(grant.identity_config ?? {}),
  };
  const timeoutMs = Math.max(1, Number(grant.timeout_s || 120)) * 1000;
  try {
    const stdout =
      isolation === "container"
        ? await runContainer({ dir, env, timeoutMs, image: image || process.env.PLAYTEST_JOB_IMAGE || "playtest-job:latest", claimId: grant.claim_id })
        : await runProcess({ script, env, timeoutMs });
    return parseStorageState(stdout, grant);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runProcess({ script, env, timeoutMs }: RunnerDynamic): Promise<string> {
  // Minimal inherited env: the script gets its secrets from the grant, not the
  // executor's environment (which holds the whole group's secret_env).
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  return collect(
    childProcess.spawn(process.execPath, [script], {
      env: { ...base, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    timeoutMs,
    (child: RunnerDynamic) => child.kill("SIGKILL"),
  );
}

function runContainer({ dir, env, timeoutMs, image, claimId }: RunnerDynamic): Promise<string> {
  const name = `playtest-mint-${safeName(claimId)}`;
  const args = ["run", "--rm", "--init", "--name", name, "-v", `${dir}:/mint:ro`];
  for (const key of Object.keys(env)) args.push("-e", key); // value from docker's env, not argv
  args.push(image, "node", "/mint/mint.mjs");
  return collect(
    childProcess.spawn("docker", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    timeoutMs,
    () => {
      childProcess.spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {});
    },
  );
}

function collect(child: RunnerDynamic, timeoutMs: number, onTimeout: (child: RunnerDynamic) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout(child);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: RunnerDynamic) => {
      if (stdout.length < STDOUT_LIMIT) stdout += c;
    });
    child.stderr.on("data", (c: RunnerDynamic) => {
      if (stderr.length < 64 * 1024) stderr += c;
    });
    child.on("error", (e: RunnerDynamic) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("mint script timed out"));
      if (code !== 0) return reject(new Error(firstLine(stderr) || `mint script exited ${code}`));
      resolve(stdout);
    });
  });
}

function parseStorageState(stdout: string, grant: RunnerDynamic): RunnerDynamic {
  const text = String(stdout).trim();
  const candidates = [text, text.split("\n").filter(Boolean).at(-1) ?? ""];
  for (const c of candidates) {
    try {
      const value = JSON.parse(c);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {}
  }
  throw new Error(
    `mint script for "${grant.provider}/${grant.identity}" did not print a storage-state JSON object to stdout`,
  );
}

function firstLine(s: unknown): string {
  return String(s || "").split("\n").find((l) => l.trim()) ?? "";
}

function safeName(s: unknown): string {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "claim";
}
