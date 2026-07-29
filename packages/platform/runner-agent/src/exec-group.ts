// The group executor. It is INTERNAL machinery, not an entry point: the pool
// loop (`pool.ts`) is the one arrival, and it calls `execGroup` directly after
// winning a claim on the board.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "./api-client.ts";
import { materializeWorkspace } from "./workspace.ts";
import { CONTAINER_WS, runCaseIsolated, stopActiveContainers } from "./case-runner.ts";
import { liveUploader } from "./live-uploader.ts";
import { platformEvidence } from "./evidence.ts";
import { cleanupWorkspace, sweepDocker } from "./janitor.ts";
import { runMintScript } from "./mint.ts";
import { makeMasker, makeRedactor, secretMasks, collectSecretValues, redactDeep } from "./redact.ts";
import { AppiumBackends } from "./appium.ts";
import { bindingFor } from "./runner-config.ts";
import { mobilePhysicalMasks, mobileRuntimeTarget, preflightMobile } from "./mobile.ts";
import type { AppiumHandle } from "./appium.ts";
import { discoverCases } from "@playtest/core/suite";
import { resolveBudget, schedulePool, willRecord } from "@playtest/core/run";
import { writeBundle, baselinePaths } from "@playtest/core/artifacts";
import { progressFold } from "@playtest/core/reporting";

export async function execGroup(opts: RunnerDynamic): Promise<RunnerDynamic> {
  // Claiming assigned the work; exchanging authorizes it. The runner presents
  // its registration credential and names the dispatch it CLAIMED on the board,
  // and receives a short-lived bearer scoped to this one run group. The
  // isolation reported here is what the run records as producing its evidence.
  const bootstrap = new ApiClient(opts.server, opts.credential || null);
  const exchange = await bootstrap.json("POST", "/runner/exchange", {
    dispatch_id: opts.dispatchId,
    isolation: opts.isolation,
    versions: await versions(opts),
  });
  const api = bootstrap.withToken(exchange.token);
  const spec = await api.json("GET", `/runner/groups/${opts.group}`);
  const warnings: string[] = [];
  const results: RunnerDynamic[] = [];
  let workspace: RunnerDynamic = null;
  // A mobile group runs against this machine's own binding and its own Appium.
  // Both are opened after the claim and torn down with the group, whatever it
  // ends as.
  const mobile = spec.application?.driver === "mobile";
  const log = opts.log || (() => {});
  const backends: AppiumBackends = opts.backends ?? new AppiumBackends({ log });
  let backend: AppiumHandle | null = null;
  // The catch below posts errors through the redactor; it must exist before the
  // claim/materialize steps that could throw (secrets arrive with the claims).
  let redactor = (s: RunnerDynamic): string => String(s);
  // SIGTERM/SIGINT: stop starting cases, `docker stop` whatever is in flight,
  // report what we have, post a best-effort complete. A cancel arrives on the
  // runner's heartbeat instead — nothing can dial in to signal it — and aborts
  // `opts.signal` to run this same path.
  let canceled = false;
  const onSignal = () => {
    canceled = true;
    stopActiveContainers();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  opts.signal?.addEventListener?.("abort", onSignal);
  try {
    // Mobile setup comes FIRST, before sessions and before a snapshot is
    // downloaded: everything it can fail on is this machine's own setup, and
    // diagnosing it is cheaper than materializing a workspace to throw away.
    let binding = null;
    if (mobile) {
      binding = requireMobileBinding(spec, opts);
      backend = await backends.open(binding.backend);
      const failure = await preflightMobile(binding, backend, {
        statusOk: (url: string, timeoutMs: number) => backends.statusOk(url, timeoutMs),
        // An external Appium's drivers are its own business; only a backend
        // this runner starts can be asked what it has installed.
        installedDrivers: binding.backend.mode === "managed" ? () => backends.driverNames() : undefined,
      });
      if (failure) {
        // Gate 10: ONE actionable infra error per case, before anything starts
        // a driver. The path that produced it stays in this runner's own log.
        log(failure.detail);
        for (const item of spec.cases || []) {
          const report = { status: "infra", error: failure.error };
          await api.json("POST", `/runner/groups/${spec.run_group_id}/cases/${item.run_id}/report`, report);
          results.push(report);
        }
        await api.json("POST", `/runner/groups/${spec.run_group_id}/complete`, {
          summary: { cases: results.map((r) => ({ status: r.status })) },
          janitor: warnings,
        });
        return { exitCode: 2, results };
      }
    }
    // Inside the try: a claim/materialize failure must still post `complete`
    // with the real error — dying here used to leave the group to the
    // reconciler's anonymous "runner died before case started".
    const { sessions: claimed, failed: failedSessions, secretValues: mintSecrets } =
      await claimGroupSessions(api, spec, opts);
    // The external-Appium credential joins the redactor's needles: it is not a
    // ring secret, so nothing else would catch it if an Appium error ever echoed
    // it back. Only the VALUE form — a credential_file's path is not a secret.
    //
    // A mobile group adds its physical facts (mobile.ts): the driver's own
    // words about a session that would not start are the one text crossing to
    // the platform that this runner did not write, and they quote the build
    // path, the device and the endpoint. Placeholders, not the secret mask —
    // "<endpoint> refused the connection" is still a diagnosis.
    redactor = makeMasker([
      ...secretMasks([
        ...collectSecretValues(spec, claimed),
        ...mintSecrets,
        backend?.credentialEnv?.PLAYTEST_APPIUM_CREDENTIAL,
      ]),
      ...(binding && backend ? mobilePhysicalMasks(binding, backend) : []),
    ]);
    const failedByLabel = failedSessionLabels(spec, failedSessions);
    workspace = await materializeWorkspace({ api, spec, sessions: claimed, failedSessions, workDir: opts.workDir });
    // Hosted physical precedence runs through core's runtime target: it is
    // applied AFTER the complete authored merge, so an authored `base_url` or
    // `app` (top level, case, or `app.envs.<ring key>`) is inert here and cannot
    // redirect a placed run.
    //
    // A web/API ring always carries its URL. A mobile target is assembled from
    // the binding and the backend that is now running: the build path on THIS
    // disk, the platform, the device the binding names (omitted means Appium's
    // default, never the suite's authored one), and the loopback URL of the
    // Appium this runner just started. None of it came from the platform and
    // none of it goes back.
    const runtimeTarget = binding && backend
      ? mobileRuntimeTarget(binding, backend)
      : spec.ring?.base_url
        ? { base_url: spec.ring.base_url }
        : null;
    const resolved = await discoverCases([workspace.suiteDir], { env: spec.ring.key, runtimeTarget });
    const byId = new Map(resolved.map((c) => [c.id, c]));
    const selectedResolved = spec.cases.map((item: RunnerDynamic) => byId.get(item.case_id)).filter(Boolean);
    const budget = resolveHostedBudget(selectedResolved, spec.parallel, undefined, { serial: mobile });
    const work = spec.cases.map((item: RunnerDynamic, index: number) => {
      const resolvedCase = byId.get(item.case_id);
      return {
        index,
        item,
        resolvedCase,
        record: resolvedCase
          ? willRecord(resolvedCase, {
              mode: item.options?.mode || "auto",
              refresh: item.options?.refresh === true,
            })
          : false,
      };
    });
    const orderedResults: RunnerDynamic[] = new Array(work.length);
    await schedulePool(work, budget, async ({ index, item, resolvedCase }: RunnerDynamic) => {
      if (canceled) {
        const report = { status: "canceled", error: "canceled before the case started" };
        await api.json("POST", `/runner/groups/${spec.run_group_id}/cases/${item.run_id}/report`, report);
        orderedResults[index] = report;
        return;
      }
      if (!resolvedCase) {
        const report = {
          status: "infra",
          error: `case "${item.case_id}" was not resolved in materialized snapshot`,
        };
        await api.json("POST", `/runner/groups/${spec.run_group_id}/cases/${item.run_id}/report`, report);
        orderedResults[index] = report;
        return;
      }
      // A managed Appium that died takes the rest of the group with it, but as
      // a stated infra failure rather than a driver stack per case. The
      // diagnostic is already redacted of paths (appium.ts).
      const death = backend?.died() ?? null;
      if (death) {
        const report = { status: "infra", error: redactor(death) };
        await api.json("POST", `/runner/groups/${spec.run_group_id}/cases/${item.run_id}/report`, report);
        orderedResults[index] = report;
        return;
      }
      const rc = applyLimitOverrides(resolvedCase, item.options?.limits);
      // A case whose story resolves to an identity whose mint failed reports
      // infra with the provider named (§3a) — it never starts a browser.
      const authLabel = rc.env?.auth;
      if (authLabel && authLabel !== "none" && failedByLabel[authLabel]) {
        const report = {
          status: "infra",
          error: redactor(`session mint failed for ${failedByLabel[authLabel]}`),
        };
        await api.json("POST", `/runner/groups/${spec.run_group_id}/cases/${item.run_id}/report`, report);
        orderedResults[index] = report;
        return;
      }
      const sideEffectsBefore = readSideEffects(rc.file);
      await api.json("POST", `/runner/groups/${spec.run_group_id}/cases/${item.run_id}/start`, {});
      const progress = progressReporter(api, spec.run_group_id, item.run_id, redactor);
      // The live uploader is a second consumer of the same event stream, on the
      // same coalescing floor: it streams the case's evidence in ahead of its
      // bundle so the run is viewable while it executes
      // (docs/contracts/hosted.md "Live staging routes"). Everything it does is
      // indifferent at the case boundary — it never affects what follows.
      const live = liveUploader(api, {
        groupId: spec.run_group_id,
        runId: item.run_id,
        runDbId: item.db_id,
        live: spec.uploads?.live ?? null,
        workspaceRoot: workspace.root,
        containerRoot: opts.isolation === "container" ? CONTAINER_WS : null,
        // The live manifest is a platform-stored copy of the same document the
        // bundle seals, so it goes through the same needles.
        redact: redactor,
      });
      let report;
      try {
        const res = await runCaseIsolated(rc, {
          isolation: opts.isolation,
          workspaceRoot: workspace.root,
          runsRoot: workspace.runsRoot,
          runId: item.run_id,
          mode: item.options?.mode || "auto",
          refresh: item.options?.refresh === true,
          grade: item.options?.grade !== false,
          // The external-Appium credential rides the case process's environment
          // as a FILE PATH (or, when the operator named an environment variable,
          // its value) — core's local-only driver input. It is not part of the
          // runtime target, so it cannot reach a manifest or an error response.
          env: { ...workspace.env, ...(backend?.credentialEnv ?? {}) },
          allowDocker: (spec.ring?.runner_labels || []).includes("docker"),
          onEvent: (ev: RunnerDynamic) => {
            progress.onEvent(ev);
            live.onEvent(ev);
          },
        });
        const bundle = await uploadBundle(api, item.db_id, res.runDir, redactor);
        const sideEffectsAfter = readSideEffects(rc.file);
        report = {
          status: normalizeStatus(res.status),
          manifest: res.manifest || readJson(path.join(res.runDir || "", "manifest.json")),
          score: res.score ?? null,
          error: res.error ? redactor(res.error) : null,
          bundle: bundle.artifact,
          ...changedSideEffects(sideEffectsBefore, sideEffectsAfter),
        };
      } catch (e) {
        // One case's crash (docker hiccup, upload failure) never kills the
        // group — it reports infra with a first line, core discipline; a
        // docker-stopped container under cancel reports canceled.
        report = { status: canceled ? "canceled" : "infra", error: redactor(firstLine(e)) };
      } finally {
        // A backend that died DURING the case explains that case better than
        // whatever the driver managed to say about a socket that went away.
        const diedDuring = report && report.status !== "pass" ? backend?.died() : null;
        if (diedDuring) report = { ...report, status: "infra", error: redactor(diedDuring) };
        // Shutdown is the scheduler's, not the uploader's: stop both live
        // consumers here — before the final report and before the workspace is
        // cleaned up — so no background read races the teardown and no timer or
        // held request outlives the case. A cancel (docker stop, SIGTERM drain)
        // arrives through this same path.
        progress.stop();
        await live.stop();
      }
      // The WHOLE report, not just the error line it was built with. Core
      // records an infra cause in the manifest too (`result.error`), the report
      // carries that manifest, and the platform stores and serves both — so the
      // last thing that happens to a report is that every string in it is
      // scrubbed. It is metadata only (the evidence bundle travels as bytes on
      // its own route), so the walk is cheap.
      const posted = redactDeep(report, redactor);
      await api.json("POST", `/runner/groups/${spec.run_group_id}/cases/${item.run_id}/report`, posted);
      orderedResults[index] = posted;
    });
    results.push(...orderedResults);
    // Janitor before complete so its findings ride the completion report (§3).
    warnings.push(...(await cleanupWorkspace(workspace)));
    if (opts.isolation === "container") warnings.push(...sweepDocker());
    await api.json("POST", `/runner/groups/${spec.run_group_id}/complete`, {
      ...(canceled ? { partial: true, error: "canceled" } : {}),
      summary: { cases: results.map((r) => ({ status: r.status })) },
      janitor: warnings,
    });
  } catch (e: RunnerDynamic) {
    await api.json("POST", `/runner/groups/${spec.run_group_id}/complete`, {
      partial: true,
      error: redactor(e.message || String(e)),
    }).catch(() => {});
    throw e;
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    opts.signal?.removeEventListener?.("abort", onSignal);
    // The backend's lifetime is the group's: a managed Appium never outlives
    // the work it was started for, however that work ended.
    await backend?.close().catch(() => {});
    warnings.push(...(await cleanupWorkspace(workspace)));
  }
  return { exitCode: results.some((r) => r.status === "fail") ? 1 : results.some((r) => r.status === "infra") ? 2 : 0, results };
}

/**
 * The binding this runner holds for the group's `(application key, ring key)`.
 *
 * The claim already checked this, so reaching either throw means the config
 * changed under a running agent or a group was placed on a runner that cannot
 * serve it; both are infra failures with the remedy in them rather than a
 * driver error forty steps into a case.
 */
export function requireMobileBinding(spec: RunnerDynamic, opts: RunnerDynamic): RunnerDynamic {
  const bound = `${spec.application?.key ?? "?"}/${spec.ring?.key ?? "?"}`;
  if (opts.isolation !== "process") {
    throw new Error(
      `this runner runs cases in containers, and a mobile case cannot: the device, the Appium server on loopback and ` +
        `the build outside the workspace are all unreachable from one. Start a runner with --isolation process.`,
    );
  }
  const binding = bindingFor(opts.config ?? null, {
    projectKey: spec.project?.key ?? null,
    applicationKey: spec.application?.key ?? null,
    ringKey: spec.ring?.key ?? null,
  });
  if (!binding) {
    throw new Error(
      `this runner has no configuration binding for the mobile target "${bound}" — the claiming runner supplies the ` +
        `build, its Appium backend and its device from its own config file (--config)`,
    );
  }
  if (spec.application?.platform && binding.platform !== spec.application.platform) {
    throw new Error(
      `this runner binds the mobile target "${bound}" to ${binding.platform}, but that application is ` +
        `${spec.application.platform} — correct the platform in the runner's config file`,
    );
  }
  return binding;
}

/**
 * Resolve the executor pool with hosted precedence: a suite's pinned
 * playtest.yaml wins as one run-wide value, then the project policy from the
 * group spec, then the historical serial fallback.
 */
export function resolveHostedBudget(
  resolvedCases: RunnerDynamic[],
  projectParallel: RunnerDynamic,
  auto = Math.min(4, os.availableParallelism()),
  { serial = false }: { serial?: boolean } = {},
): RunnerDynamic {
  // One backend serves one session at a time: two concurrent cases cannot share
  // a simulator or a device, so a mobile group is serial whatever the suite's
  // `parallel` says. Stated here rather than left to the operator.
  if (serial) return resolveBudget({ total: 1, record: 1 }, auto);
  const suiteParallel = resolvedCases.find((rc) => rc.parallel != null)?.parallel ?? null;
  return resolveBudget(suiteParallel ?? projectParallel ?? { total: 1, record: 1 }, auto);
}

// How often a case's live progress may go over the wire. The engine emits an
// event roughly per model turn; one snapshot every couple of seconds is plenty
// for a screen a human is watching, and keeps a 30-story group from turning
// the feed into a firehose.
const PROGRESS_INTERVAL_MS = 2000;

/**
 * Folds a case's engine events into one live-progress snapshot and POSTs it,
 * coalesced to at most one request per PROGRESS_INTERVAL_MS. Telemetry only:
 * every send is fire-and-forget and a failure is swallowed — progress must
 * never slow down or break the case it describes. Free text (the actor's step
 * summary) goes through the redactor before it leaves this process; the wire
 * carries the same words the CLI's live line shows (mode word from core
 * reporting, step N/M, cost so far, tokens, model).
 */
export function progressReporter(api: RunnerDynamic, groupId: string, runId: string, redactor: (value: string) => string, { intervalMs = PROGRESS_INTERVAL_MS, now = Date.now }: RunnerDynamic = {}) {
  // The fold itself is core's (docs/contracts/engine.md#progress-events): the
  // local viewer host folds the same events off events.jsonl for its live
  // endpoint, so the two live surfaces share one vocabulary instead of two
  // copies of this state machine.
  const fold = progressFold({ redact: redactor });
  let timer: NodeJS.Timeout | null = null;
  let lastSent = 0;
  let dirty = false;
  let stopped = false;

  const send = () => {
    timer = null;
    if (stopped || !dirty) return;
    dirty = false;
    lastSent = now();
    api.json("POST", `/runner/groups/${groupId}/cases/${runId}/progress`, { ...fold.view() }).catch(() => {});
  };
  const schedule = () => {
    dirty = true;
    if (stopped || timer) return;
    timer = setTimeout(send, Math.max(0, lastSent + intervalMs - now()));
    timer.unref?.();
  };

  return {
    onEvent: (ev: RunnerDynamic) => {
      if (fold.apply(ev)) schedule();
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Apply a run-group's ephemeral limit overrides without mutating discovery's cached case. */
export function applyLimitOverrides(resolvedCase: RunnerDynamic, overrides: RunnerDynamic = null): RunnerDynamic {
  if (!overrides || !Object.keys(overrides).length) return resolvedCase;
  return { ...resolvedCase, limits: { ...resolvedCase.limits, ...overrides } };
}

/**
 * Claim every needed session (§3a). Each ref resolves to a fresh session, a
 * `wait` ticket (another executor is minting — re-claim with a ≤ 25 s hold), or
 * a `mint` grant (run the provider script clean-room, then fulfill). A failed
 * mint reports the error on the claim (so the next claimer takes over) and
 * lands in `failed` — only the cases needing that identity go infra, not the
 * group. `secretValues` feeds the redactor with the grant's root secrets.
 */
export async function claimGroupSessions(api: RunnerDynamic, spec: RunnerDynamic, opts: RunnerDynamic): Promise<RunnerDynamic> {
  const needed = spec.sessions?.needed || [];
  const sessions: Record<string, RunnerDynamic> = {};
  const failed: Record<string, string> = {};
  const secretValues: RunnerDynamic[] = [];
  let pending = [...needed];
  const deadline = Date.now() + 10 * 60 * 1000;
  while (pending.length) {
    const res = await api.json("POST", "/runner/sessions/claim", { sessions: pending, wait: 20 });
    const next = [];
    for (const ref of pending) {
      const r = res.sessions?.[ref];
      if (r && r.storage_state) {
        sessions[ref] = r;
      } else if (r?.pending && r.mint) {
        for (const v of Object.values(r.mint.env || {})) secretValues.push(v);
        try {
          const storageState = await runMintScript(r.mint, { isolation: opts.isolation, workDir: opts.workDir });
          const fulfilled = await api.json("POST", `/runner/sessions/${r.mint.claim_id}/fulfill`, {
            storage_state: storageState,
          });
          sessions[ref] = fulfilled.session;
        } catch (e) {
          // A failed mint's first line is the customer's OWN script talking
          // (mint.ts takes stderr's first line), and the script was handed this
          // grant's resolved secrets — so an `echo $TOKEN` or a library that
          // prints the value it POSTed lands here. It is posted on the claim and
          // served to developers as the dispatch error, so it is scrubbed of
          // every value the grant carries before it goes. This runs before the
          // group's redactor exists, hence its own.
          const redact = makeRedactor([...secretValues, ...Object.values(r.mint.env || {})]);
          const msg = redact(firstLine(e));
          await api
            .json("POST", `/runner/sessions/${r.mint.claim_id}/fulfill`, { error: msg })
            .catch(() => {});
          failed[ref] = msg;
        }
      } else if (r?.pending) {
        next.push(ref);
      } else {
        // The control plane mints token_endpoint/secret providers itself and
        // reports a failure per-ref (§3a) — carry its message to the case report.
        failed[ref] = r?.error || "session claim returned no session";
      }
    }
    pending = next;
    if (pending.length && Date.now() > deadline) {
      for (const ref of pending) failed[ref] = "timed out waiting for another executor's session mint";
      break;
    }
  }
  return { sessions, failed, secretValues };
}

/** Map failed session refs back to the abstract identity labels cases use. */
function failedSessionLabels(spec: RunnerDynamic, failedSessions: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const identities: Record<string, RunnerDynamic> = spec.ring?.config?.auth?.identities || {};
  for (const [label, cfg] of Object.entries(identities)) {
    const ref = cfg && typeof cfg === "object" ? cfg.$session : null;
    if (ref && failedSessions[ref]) out[label] = `${ref}: ${failedSessions[ref]}`;
  }
  return out;
}

/**
 * Seal one case's evidence and upload it.
 *
 * The bundle is evidence the platform stores and serves, so it is built from a
 * SANITIZED STAGING COPY of the run directory (evidence.ts) rather than from the
 * run directory itself: every textual entry goes through the group's needles,
 * binary payloads are byte-identical, and the resulting index, sizes and hashes
 * therefore describe the bytes actually sent. The run directory is this
 * machine's own diagnostic record and is never mutated — its raw text stays in
 * the runner's log, where it is still the answer to "what did it actually dial".
 */
export async function uploadBundle(
  api: RunnerDynamic,
  runDbId: string,
  runDir: string | null | undefined,
  redactor: (value: unknown) => string = String,
): Promise<RunnerDynamic> {
  if (!runDir) return { artifact: null };
  const out = path.join(os.tmpdir(), `playtest-${process.pid}-${runDbId}.ptrun`);
  let staged: string | null = null;
  try {
    staged = await platformEvidence(redactor).stage(runDir);
    writeBundle(staged, out);
    return await api.putBytes(`/runner/runs/${runDbId}/bundle`, await fsp.readFile(out), "application/vnd.playtest.run-bundle");
  } finally {
    await fsp.rm(out, { force: true }).catch(() => {});
    await fsp.rm(`${out}.idx.json`, { force: true }).catch(() => {});
    if (staged) await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
  }
}

function readSideEffects(caseFile: string): RunnerDynamic {
  const p = baselinePaths(caseFile);
  return {
    baseline: readJson(p.meta),
    candidate: readJson(p.healedMeta),
  };
}

function changedSideEffects(before: RunnerDynamic, after: RunnerDynamic): RunnerDynamic {
  const out: RunnerDynamic = {};
  if (after.baseline && JSON.stringify(after.baseline) !== JSON.stringify(before.baseline)) out.baseline_written = after.baseline;
  if (after.candidate && JSON.stringify(after.candidate) !== JSON.stringify(before.candidate)) out.candidate_written = after.candidate;
  return out;
}

function normalizeStatus(status: RunnerDynamic): string {
  if (["pass", "fail", "infra", "explored", "canceled", "lost"].includes(status)) return status;
  if (status === "interrupted") return "infra";
  return "infra";
}

function readJson(file: string): RunnerDynamic {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function versions(opts: RunnerDynamic): Promise<RunnerDynamic> {
  return {
    node: process.version,
    isolation: opts.isolation,
    job_image: process.env.PLAYTEST_JOB_IMAGE || null,
  };
}

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
