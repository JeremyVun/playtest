// Pool mode: the long-lived self-hosted runner (`runner-agent pool`).
//
// Everything here is this process dialling OUT. The control plane never starts
// this agent and never connects to it (docs/contracts/hosted.md, "Runner
// pool"); the loop is
//
//   check in ─▶ long-poll the claim board ─▶ claim ─▶ exchange ─▶ execute
//        ▲                                                          │
//        └──────────────── complete ◀───────────────────────────────┘
//
// and execution is the group/mint executor in this package: after the claim the
// agent enters `POST /runner/exchange` presenting its registration credential
// and the dispatch it won.
//
// Four rules this file exists to keep:
//
//   1. The credential never touches argv. It arrives in the environment or in a
//      file, so it cannot land in `ps`, in a shell's process table, or in a CI
//      log of the command line.
//   2. One runner executes one group at a time (v1). The board enforces it; this
//      loop simply never asks for more, and a restart resumes the claim it still
//      holds (`current` in the poll answer) instead of abandoning it.
//   3. Loss is loud but never fatal by accident. A server that is down is
//      retried with backoff and jitter; a revoked or unknown credential is a
//      configuration error that stops the process with one actionable line.
//   4. An offer this runner cannot execute is skipped LOCALLY and nothing else.
//      The board serves a bounded page and the agent claims the first entry it
//      can; the ones it cannot go into the next poll's `skip` list, so the
//      server holds instead of handing back the same page, and another runner
//      claims them unaffected. The reason is logged here, once, and never sent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiClient, RunnerApiError } from "./api-client.ts";
import { execGroup } from "./exec-group.ts";
import { execMint } from "./exec-mint.ts";

/** How long a single check-in may hold, matching the board's own cap. */
const POLL_WAIT_S = 25;
/** Retry envelope for a control plane that is unreachable or erroring. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Used only if a claim answer omits `heartbeat_interval_s`. */
const HEARTBEAT_FALLBACK_S = 20;
/**
 * How many incompatible dispatch ids one session may carry in its `skip` list.
 * The server refuses more than this on a poll, and it is the point at which
 * this loop backs off explicitly instead of asking again immediately: past that
 * many unclaimable offers the honest answer is "nothing here is for me".
 */
const SKIP_CAP = 64;

export interface PoolOptions {
  server: string;
  labels: string[];
  isolation: string;
  workDir: string;
  credential: string;
  pollWaitS: number;
}

/**
 * One entry of the board's offer page. The project rides the envelope (a mint
 * for a project-wide provider has no target at all), and `target` carries the
 * non-secret facts this runner decides compatibility from. Contractual shape:
 * docs/contracts/hosted.md, "The claim board".
 */
export interface ClaimOffer {
  dispatch_id: string;
  kind: string;
  ref_id: string;
  run_group_id: string | null;
  mint_claim_id: string | null;
  labels: string[];
  project_id?: string;
  project_key?: string | null;
  target?: OfferTarget | null;
}

export interface OfferTarget {
  application_id: string | null;
  application_key: string | null;
  ring_id: string | null;
  ring_key: string | null;
  driver: string | null;
  platform: string | null;
  base_url: string | null;
}

interface RunnerIdentity {
  id: string;
  name: string;
  labels: string[];
  project_key: string | null;
}

export interface PoolDeps {
  execGroupImpl?: typeof execGroup;
  execMintImpl?: typeof execMint;
  /**
   * Can this runner execute this offer? Returns null when it can, or ONE
   * actionable sentence saying why not. Labels are the server's filter; this is
   * the half only the machine knows (which drivers it can run, and — with
   * runner configuration — which application/ring bindings it holds).
   */
  compatibility?: (offer: ClaimOffer) => string | null;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Stop after this many completed executions — the test seam for the loop. */
  maxIterations?: number;
  /** Stop after this many check-ins — the other half of that seam. */
  maxPolls?: number;
}

/**
 * Run the pool loop until the process is asked to stop. Resolves with how many
 * claims this runner executed, which is what the unit tests assert on.
 */
export async function runPool(opts: PoolOptions, deps: PoolDeps = {}): Promise<{ executed: number }> {
  const {
    execGroupImpl = execGroup,
    execMintImpl = execMint,
    compatibility = (offer: ClaimOffer) => defaultCompatibility(offer, opts),
    log = (line: string) => process.stdout.write(`${line}\n`),
    sleep = defaultSleep,
    random = Math.random,
    maxIterations = Infinity,
    maxPolls = Infinity,
  } = deps;
  const api = new ApiClient(opts.server, opts.credential);

  let stopping = false;
  let busy = false;
  let executed = 0;
  // SIGTERM while idle has nothing to tear down, so it exits at once. SIGTERM
  // mid-group stops starting cases, stops containers, reports what exists and
  // posts a best-effort `complete` — this loop just stops asking for more work.
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    log(busy ? "shutting down — finishing the case in flight, then exiting" : "shutting down");
    if (!busy) process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  let announced = false;
  let failures = 0;
  let polls = 0;
  // Session-local, in-memory, never persisted: the offers this runner has
  // already decided it cannot take, and the reasons it has already said out
  // loud. Both are cleared together when a long-poll comes back empty.
  let skip: string[] = [];
  const reported = new Set<string>();
  let idleBackoff = 0;
  try {
    while (!stopping && executed < maxIterations && polls < maxPolls) {
      let answer;
      polls += 1;
      try {
        // The FIRST request does not hold: a person who just pasted the start
        // command must see what this runner is within a second, not after the
        // first 25-second poll returns. Every later check-in long-polls.
        const wait = announced ? opts.pollWaitS : 0;
        const query = new URLSearchParams({ wait: String(wait), labels: opts.labels.join(",") });
        if (skip.length) query.set("skip", skip.join(","));
        answer = await api.json("GET", `/runner/pool/claims?${query}`);
        if (failures) log("reconnected to the control plane");
        failures = 0;
      } catch (e) {
        if (isFatalRefusal(e)) throw new Error(firstLine(e));
        const delay = backoffDelayMs(++failures, { random });
        // Say it once per outage, not once per retry: a laptop that closed its
        // lid should not fill the terminal while it waits to come back.
        if (failures === 1) log(`the control plane at ${opts.server} is not answering (${firstLine(e)}) — retrying`);
        await sleep(delay);
        continue;
      }

      if (!announced) {
        for (const line of startupLines(opts, answer.runner)) log(line);
        announced = true;
      }

      // `current` is the claim this runner already holds: a crash-resume, and
      // the board's answer to a runner that asks for work while it has some.
      const resumed: ClaimOffer | null = answer.current ?? null;
      const page: ClaimOffer[] = resumed ? [] : (answer.offers ?? []);
      let offer = resumed;
      let intervalS = HEARTBEAT_FALLBACK_S;

      if (!offer) {
        if (!page.length) {
          // Nothing on the board, or the hold expired with only skipped entries
          // left. Either way this session's skips have had their window, so
          // clear them: an incompatibility that was transient — a backend back
          // online, a platform driver installed — is reconsidered without
          // restarting the agent.
          if (skip.length) {
            skip = [];
            reported.clear();
            idleBackoff = 0;
          }
          continue;
        }
        // Judge the whole page, not just up to the first taker: an offer this
        // runner cannot execute is named in the next poll's `skip` list either
        // way, so the server holds instead of handing back the same entries.
        const judged = page.map((o) => [o, compatibility(o)] as const);
        const takeable = judged.find(([, reason]) => !reason)?.[0] ?? null;
        // Say each distinct reason once per session, not once per poll, and send
        // nothing but the ids: the advertisement is never mutated, so a capable
        // runner claims these unaffected.
        for (const [o, reason] of judged) {
          if (reason && !reported.has(reason)) {
            reported.add(reason);
            log(`skipping ${describe(o)}: ${reason}`);
          }
        }
        const fresh = judged
          .filter(([, reason]) => reason)
          .map(([o]) => o.dispatch_id)
          .filter((id) => !skip.includes(id));
        if (skip.length + fresh.length <= SKIP_CAP) {
          skip = [...skip, ...fresh];
          idleBackoff = 0;
        } else if (!takeable) {
          // Past the cap the next poll would name more than the board accepts,
          // and re-polling with the same list returns the same page. Back off
          // explicitly rather than re-entering a tight loop.
          const delay = backoffDelayMs(++idleBackoff, { random });
          if (idleBackoff === 1) {
            log(`nothing on the board is for this runner (${skip.length} offers skipped) — backing off`);
          }
          await sleep(delay);
          continue;
        }
        if (!takeable) continue;
        offer = takeable;
      }

      if (resumed) {
        log(`resuming ${describe(offer)} — this runner still holds its claim`);
      } else {
        let claim;
        try {
          claim = await api.json("POST", `/runner/pool/claims/${offer.dispatch_id}`, {});
        } catch (e) {
          if (isFatalRefusal(e)) throw new Error(firstLine(e));
          // A lost race is the documented outcome for the runner that did not
          // win it, not an error: go straight back to the board.
          if (e instanceof RunnerApiError && e.status === 409) continue;
          const delay = backoffDelayMs(++failures, { random });
          log(`could not claim dispatch ${offer.dispatch_id} (${firstLine(e)}) — retrying`);
          await sleep(delay);
          continue;
        }
        offer.run_group_id = claim.run_group_id ?? offer.run_group_id;
        offer.mint_claim_id = claim.mint_claim_id ?? offer.mint_claim_id;
        intervalS = claim.heartbeat_interval_s ?? HEARTBEAT_FALLBACK_S;
        log(`claimed ${describe(offer)}`);
      }

      busy = true;
      try {
        await executeClaim(api, opts, offer, intervalS, { execGroupImpl, execMintImpl, log });
      } finally {
        busy = false;
        executed += 1;
      }
      if (!stopping) log("waiting for work");
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
  return { executed };
}

/**
 * What this runner can execute without any local configuration: web and API
 * groups, and every mint (mint compatibility is labels only — no binding is
 * required to claim one). A mobile group needs a binding in the runner's own
 * configuration file naming the offered application and ring, which is the
 * machine-local fact no platform record may hold.
 */
export function defaultCompatibility(offer: ClaimOffer, opts: PoolOptions): string | null {
  if (offer.kind !== "group") return null;
  const driver = offer.target?.driver ?? null;
  if (driver === "web" || driver === "api") return null;
  if (driver === "mobile") {
    const bound = `${offer.target?.application_key ?? "?"}/${offer.target?.ring_key ?? "?"}`;
    return (
      `this runner has no configuration binding for the mobile target "${bound}" — a mobile build, its ` +
      `Appium backend and its device are machine-local facts, declared in the runner's own config file ` +
      `(--config). Another runner that binds "${bound}" can take this.`
    );
  }
  void opts;
  return `this runner cannot execute the "${driver ?? "unknown"}" driver`;
}

/**
 * Execute one claimed board entry through the existing executor, with the
 * heartbeat running alongside it. A failure here is logged and swallowed: the
 * executor has already posted its own `complete` carrying the real error, and
 * one bad group must never take the fleet's runner down with it.
 */
async function executeClaim(
  api: ApiClient,
  opts: PoolOptions,
  offer: ClaimOffer,
  intervalS: number,
  { execGroupImpl, execMintImpl, log }: { execGroupImpl: typeof execGroup; execMintImpl: typeof execMint; log: (line: string) => void },
): Promise<void> {
  const canceler = new AbortController();
  const heartbeat = startHeartbeat(api, offer.dispatch_id, intervalS, {
    onCancel: (why: string) => {
      log(`${why} — tearing down ${describe(offer)}`);
      canceler.abort();
    },
  });
  const started = Date.now();
  try {
    if (offer.kind === "mint") {
      await execMintImpl({
        server: opts.server,
        claim: offer.mint_claim_id ?? offer.ref_id,
        dispatchId: offer.dispatch_id,
        isolation: opts.isolation,
        workDir: opts.workDir,
        credential: opts.credential,
      });
    } else {
      await execGroupImpl({
        server: opts.server,
        group: offer.run_group_id ?? offer.ref_id,
        dispatchId: offer.dispatch_id,
        isolation: opts.isolation,
        workDir: opts.workDir,
        credential: opts.credential,
        signal: canceler.signal,
      });
    }
    log(`finished ${describe(offer)} in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    log(`${describe(offer)} ended with an error: ${firstLine(e)}`);
  } finally {
    heartbeat.stop();
  }
}

/**
 * Coarse group-level liveness between claim and completion. It is also the only
 * channel a cancel can reach this process on — nothing dials in — so a
 * `canceled` answer runs the same teardown a SIGTERM does, and a claim that is
 * no longer ours (reconciled dead, or the runner revoked mid-group) does too.
 */
function startHeartbeat(
  api: ApiClient,
  dispatchId: string,
  intervalS: number,
  { onCancel }: { onCancel: (why: string) => void },
) {
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const beat = await api.json("POST", `/runner/pool/claims/${dispatchId}/heartbeat`, {});
      if (beat?.canceled) onCancel("the control plane canceled this run");
    } catch (e) {
      // A transport hiccup is nothing: the next tick carries the liveness, and
      // the reconciler's window is several beats wide. A refusal is different —
      // this claim is not ours any more, so stop pretending to execute it.
      if (e instanceof RunnerApiError && e.status >= 400 && e.status < 500) {
        onCancel(`this claim is no longer held by this runner (${firstLine(e)})`);
      }
    } finally {
      inFlight = false;
    }
  }, Math.max(1, intervalS) * 1000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Exponential backoff with ±25% jitter, so a fleet never retries in lockstep. */
export function backoffDelayMs(
  attempt: number,
  { base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS, random = Math.random }: { base?: number; max?: number; random?: () => number } = {},
): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.75 + random() * 0.5));
}

/**
 * The first thing a person sees. A misconfigured runner has to be diagnosable
 * at a glance, so this states who the control plane thinks this runner is,
 * which project it can take work from, what it advertises, and what isolation
 * its evidence will carry — then says, in words, that it is waiting.
 */
export function startupLines(opts: PoolOptions, runner: RunnerIdentity | null): string[] {
  const name = runner?.name ? `"${runner.name}"` : "(unnamed)";
  const project = runner?.project_key ? ` — project ${runner.project_key}` : "";
  const labels = opts.labels.length ? opts.labels.join(", ") : "none — takes any job in this project";
  return [
    `Playtest runner ${name}${project}`,
    `  server     ${opts.server}`,
    `  labels     ${labels}`,
    `  isolation  ${opts.isolation}${opts.isolation === "process" ? " — cases run directly on this machine" : " — one container per case"}`,
    `  work dir   ${opts.workDir}`,
    "waiting for work — launch a run against a ring whose runner labels this runner advertises",
  ];
}

/** `run group 01J…` / `session mint 01J…`, for a log line a person reads. */
const describe = (offer: ClaimOffer) =>
  offer.kind === "mint" ? `session mint ${offer.mint_claim_id ?? offer.ref_id}` : `run group ${offer.run_group_id ?? offer.ref_id}`;

/**
 * A request the control plane refuses on its merits is a configuration problem,
 * not an outage: this loop would send the identical request forever, so retrying
 * it hides the one thing the operator must fix. A refused credential (401/403)
 * and a refused request (400 — a label this deployment will not accept, say) are
 * both that shape; everything else is retried with backoff.
 */
function isFatalRefusal(e: unknown): boolean {
  return e instanceof RunnerApiError && (e.status === 400 || e.status === 401 || e.status === 403);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Resolve the registration credential. Never from argv: `--credential-file`
 * names a path, and the environment carries the value itself, so the secret
 * cannot appear in `ps` output or a CI log of the command line.
 */
export function resolveCredential(env: NodeJS.ProcessEnv, credentialFile: string | null): string {
  const file = credentialFile || env.PLAYTEST_RUNNER_CREDENTIAL_FILE || null;
  let value = (env.PLAYTEST_RUNNER_CREDENTIAL || "").trim();
  if (file) {
    try {
      value = fs.readFileSync(file, "utf8").trim();
    } catch (e: RunnerDynamic) {
      throw new Error(
        `cannot read the runner credential from "${file}" (${e?.code || firstLine(e)}) — ` +
          `point --credential-file at the file holding the value shown once when the runner was registered`,
      );
    }
  }
  if (!value) {
    throw new Error(
      "no runner credential: set PLAYTEST_RUNNER_CREDENTIAL, or point --credential-file at a file holding it. " +
        "The value is shown once, when you register the runner under Settings → Runners; it is never accepted on the command line.",
    );
  }
  if (!value.startsWith("ptr_")) {
    throw new Error(
      `that does not look like a runner credential (expected it to start with "ptr_") — ` +
        `a project API token (pt_…) cannot claim work; register a runner under Settings → Runners`,
    );
  }
  return value;
}

export function parsePoolArgs(argv: string[], env: NodeJS.ProcessEnv): PoolOptions {
  const opts: RunnerDynamic = {
    server: env.PLAYTEST_SERVER_URL || env.PLAYTEST_HOSTED_URL || "http://127.0.0.1:4177",
    labels: splitLabels(env.PLAYTEST_RUNNER_LABELS || ""),
    isolation: env.PLAYTEST_RUNNER_ISOLATION || "process",
    workDir: env.PLAYTEST_RUNNER_WORKDIR || path.join(os.tmpdir(), "playtest-runner"),
    pollWaitS: POLL_WAIT_S,
  };
  let credentialFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A flag whose value is missing is a typo, not an empty value: say which.
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--server") opts.server = value();
    else if (a === "--labels") opts.labels = splitLabels(value());
    else if (a === "--isolation") opts.isolation = value();
    else if (a === "--work-dir") opts.workDir = value();
    else if (a === "--credential-file") credentialFile = value();
    else if (a === "--help" || a === "-h") {
      process.stdout.write(POOL_USAGE);
      process.exit(0);
    } else if (a === "--credential" || a === "--token") {
      throw new Error(
        "the runner credential is never passed on the command line — set PLAYTEST_RUNNER_CREDENTIAL " +
          "in the environment, or use --credential-file <path>",
      );
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!["process", "container"].includes(opts.isolation)) throw new Error("--isolation must be process or container");
  opts.credential = resolveCredential(env, credentialFile);
  return opts as PoolOptions;
}

export const POOL_USAGE =
  "usage: runner-agent pool --server <url> [--labels a,b] [--isolation process|container] [--work-dir <dir>] [--credential-file <path>]\n" +
  "       the credential comes from PLAYTEST_RUNNER_CREDENTIAL (or --credential-file), never from an argument\n";

const splitLabels = (raw: string) => [...new Set(String(raw || "").split(",").map((l) => l.trim()).filter(Boolean))];

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
