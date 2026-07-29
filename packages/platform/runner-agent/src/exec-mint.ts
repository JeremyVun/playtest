// Standalone mint executor: a `mint` dispatch rides the same claim board as a
// run group, and the pool loop (`pool.ts`) calls this after winning it.
// Exchange → fetch the grant → run the provider script clean-room → POST the
// storage state back.
//
// The two ways this can fail are DIFFERENT failures and are never conflated:
//
//   * the customer's mint script failed — that is a diagnosis, it is posted on
//     the claim so the control plane abandons the grant (takeover) and concludes
//     the dispatch honestly, and the script is never run again for it;
//   * the completion REQUEST failed — the mint succeeded, the result exists, and
//     only its delivery is retried (`deliverMintResult`). Nothing is posted on
//     the claim: blaming the customer's code for a network hiccup would both
//     mislead a developer and throw away a session that exists.
//
// Internal machinery, not an entry point: the pool loop is the one arrival.
import { ApiClient, isRunnerRefusal } from "./api-client.ts";
import { deliverMintResult, runMintScript } from "./mint.ts";
import { makeRedactor } from "./redact.ts";

export async function execMint(opts: RunnerDynamic): Promise<RunnerDynamic> {
  // As in exec-group: the runner exchanges its registration credential for the
  // dispatch it claimed, and receives a bearer scoped to this mint claim alone.
  // A runner resuming after a crash exchanges again for the SAME dispatch and
  // becomes its current executor; the bearer it held before is stale from that
  // instant (docs/contracts/hosted.md, "Current executor fencing").
  const bootstrap = new ApiClient(opts.server, opts.credential || null);
  const exchange = await bootstrap.json("POST", "/runner/exchange", {
    dispatch_id: opts.dispatchId,
    isolation: opts.isolation,
    versions: { node: process.version, isolation: opts.isolation, job_image: process.env.PLAYTEST_JOB_IMAGE || null },
  });
  const api = bootstrap.withToken(exchange.token);
  const grant = await api.json("GET", `/runner/mints/${opts.claim}`);
  return await executeMint(api, {
    grant,
    claim: opts.claim,
    isolation: opts.isolation,
    workDir: opts.workDir,
  });
}

/**
 * Run one mint grant and deliver its result. Separated from the exchange so the
 * script-versus-transport boundary is testable at the seam that owns it.
 */
export async function executeMint(
  api: RunnerDynamic,
  { grant, claim, isolation, workDir, sleep }: RunnerDynamic,
): Promise<RunnerDynamic> {
  // The failure is the provider script's own first line of stderr (mint.ts),
  // written by code that was handed this grant's resolved secrets. It becomes
  // the dispatch's error — served to developers — so it is scrubbed of every
  // value the grant carries, here and in this runner's log.
  const redact = makeRedactor(Object.values(grant.env || {}));
  let storageState;
  try {
    storageState = await runMintScript(grant, { isolation, workDir });
  } catch (e: RunnerDynamic) {
    const error = redact(firstLine(e));
    await deliverMintResult(api, `/runner/mints/${claim}/complete`, { error }, { sleep }).catch(() => {});
    console.error(`mint failed: ${error}`);
    return { exitCode: 1, error };
  }
  // The script ran, exactly once. From here only delivery can fail.
  try {
    await deliverMintResult(api, `/runner/mints/${claim}/complete`, { storage_state: storageState }, { sleep });
  } catch (e: RunnerDynamic) {
    const error =
      `the mint for ${grant.provider}/${grant.identity} succeeded, but its result could not be delivered: ` +
      redact(firstLine(e));
    console.error(error);
    // A refusal is the control plane's answer about this executor, not about the
    // script: hand it to the pool loop, which knows what a refused claim means.
    if (isRunnerRefusal(e)) throw e;
    return { exitCode: 1, error, minted: true };
  }
  process.stdout.write(`minted ${grant.provider}/${grant.identity}\n`);
  return { exitCode: 0, minted: true };
}

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
