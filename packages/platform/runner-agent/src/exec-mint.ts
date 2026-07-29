// Standalone mint executor: a `mint` dispatch rides the same claim board as a
// run group, and the pool loop (`pool.ts`) calls this after winning it.
// Exchange → fetch the grant → run the provider script clean-room → POST the
// storage state back. Failure reports the error so the control plane abandons
// the claim (takeover) and concludes the dispatch honestly.
//
// Internal machinery, not an entry point: the pool loop is the one arrival.
import { ApiClient } from "./api-client.ts";
import { runMintScript } from "./mint.ts";
import { makeRedactor } from "./redact.ts";

export async function execMint(opts: RunnerDynamic): Promise<RunnerDynamic> {
  // As in exec-group: the runner exchanges its registration credential for the
  // dispatch it claimed, and receives a bearer scoped to this mint claim alone.
  const bootstrap = new ApiClient(opts.server, opts.credential || null);
  const exchange = await bootstrap.json("POST", "/runner/exchange", {
    dispatch_id: opts.dispatchId,
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
    // The failure is the provider script's own first line of stderr (mint.ts),
    // written by code that was handed this grant's resolved secrets. It becomes
    // the dispatch's error — served to developers — so it is scrubbed of every
    // value the grant carries, here and in this runner's log.
    const error = makeRedactor(Object.values(grant.env || {}))(firstLine(e));
    await api.json("POST", `/runner/mints/${opts.claim}/complete`, { error }).catch(() => {});
    console.error(`mint failed: ${error}`);
    return { exitCode: 1, error };
  }
}

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
