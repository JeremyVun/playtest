// Standalone mint executor: a `mint`
// workflow dispatch runs `runner-agent mint --claim <id>` instead of a run
// group. Exchange → fetch the grant → run the provider script clean-room →
// POST the storage state back. Failure reports the error so the control plane
// abandons the claim (takeover) and concludes the dispatch honestly.
import os from "node:os";
import path from "node:path";
import { ApiClient } from "./api-client.ts";
import { runMintScript } from "./mint.ts";

export async function execMint(opts: RunnerDynamic): Promise<RunnerDynamic> {
  const bootstrap = new ApiClient(opts.server);
  const exchange = await bootstrap.json("POST", "/runner/exchange", {
    github_oidc_token: opts.oidcToken || "local-dev",
    mint_claim_id: opts.claim,
    dispatch_id: opts.dispatchId || undefined,
    isolation: opts.isolation,
    versions: { node: process.version, isolation: opts.isolation, job_image: process.env.PLAYTEST_JOB_IMAGE || null },
  });
  const api = bootstrap.withToken(exchange.token);
  const grant = await api.json("GET", `/runner/mints/${opts.claim}`);
  try {
    const storageState = await runMintScript(grant, { isolation: opts.isolation, workDir: opts.workDir });
    await api.json("POST", `/runner/mints/${opts.claim}/complete`, { storage_state: storageState });
    process.stdout.write(`minted ${grant.provider}/${grant.identity}\n`);
    return { exitCode: 0 };
  } catch (e: RunnerDynamic) {
    const error = firstLine(e);
    await api.json("POST", `/runner/mints/${opts.claim}/complete`, { error }).catch(() => {});
    console.error(`mint failed: ${error}`);
    return { exitCode: 1, error };
  }
}

export function parseMintArgs(argv: string[], env: NodeJS.ProcessEnv): RunnerDynamic {
  const opts: RunnerDynamic = {
    server: env.PLAYTEST_SERVER_URL || env.PLAYTEST_HOSTED_URL || "http://127.0.0.1:4177",
    claim: env.PLAYTEST_MINT_CLAIM || null,
    dispatchId: env.PLAYTEST_DISPATCH_ID || null,
    oidcToken: env.ACTIONS_ID_TOKEN || env.PLAYTEST_GITHUB_OIDC_TOKEN || null,
    isolation: env.PLAYTEST_RUNNER_ISOLATION || "process",
    workDir: env.PLAYTEST_RUNNER_WORKDIR || path.join(os.tmpdir(), "playtest-runner"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") opts.server = argv[++i];
    else if (a === "--claim") opts.claim = argv[++i];
    else if (a === "--dispatch") opts.dispatchId = argv[++i];
    else if (a === "--oidc-token") opts.oidcToken = argv[++i];
    else if (a === "--isolation") opts.isolation = argv[++i];
    else if (a === "--work-dir") opts.workDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write("usage: runner-agent mint --claim <id> [--server <url>] [--isolation process|container]\n");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.claim) throw new Error("--claim is required");
  if (!["process", "container"].includes(opts.isolation)) throw new Error("--isolation must be process or container");
  return opts;
}

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
