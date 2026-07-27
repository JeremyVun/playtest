#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "./api-client.ts";
import { materializeWorkspace } from "./workspace.ts";
import { runCaseIsolated, stopActiveContainers } from "./case-runner.ts";
import { cleanupWorkspace, sweepDocker } from "./janitor.ts";
import { runMintScript } from "./mint.ts";
import { makeRedactor, collectSecretValues } from "./redact.ts";
import { discoverCases } from "@playtest/core/suite";
import { resolveBudget, schedulePool, willRecord } from "@playtest/core/run";
import { writeBundle, baselinePaths } from "@playtest/core/artifacts";
import { modeDoing, PHASE_DOING } from "@playtest/core/reporting";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  execFromCli().catch((e) => {
    console.error(firstLine(e));
    process.exit(2);
  });
}

export async function execFromCli(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<RunnerDynamic> {
  if (argv[0] === "mint") {
    const { execMint, parseMintArgs } = await import("./exec-mint.ts");
    const result = await execMint(parseMintArgs(argv.slice(1), env));
    if (result.exitCode) process.exitCode = result.exitCode;
    return result;
  }
  const opts = parseArgs(argv, env);
  const result = await execGroup(opts);
  if (result.exitCode) process.exitCode = result.exitCode;
  return result;
}

export async function execGroup(opts: RunnerDynamic): Promise<RunnerDynamic> {
  const bootstrap = new ApiClient(opts.server);
  const exchange = await bootstrap.json("POST", "/runner/exchange", {
    github_oidc_token: opts.oidcToken || "local-dev",
    run_group_id: opts.group,
    // GitHub's dispatch API returns 204 with no run id; presenting the dispatch
    // id (a workflow input) lets the control plane bind this verified exchange
    // to its ledger row and backfill workflow_run_id from the OIDC claims.
    dispatch_id: opts.dispatchId || undefined,
    isolation: opts.isolation,
    versions: await versions(opts),
  });
  const api = bootstrap.withToken(exchange.token);
  const spec = await api.json("GET", `/runner/groups/${opts.group}`);
  const warnings: string[] = [];
  const results: RunnerDynamic[] = [];
  let workspace: RunnerDynamic = null;
  // The catch below posts errors through the redactor; it must exist before the
  // claim/materialize steps that could throw (secrets arrive with the claims).
  let redactor = (s: RunnerDynamic): string => String(s);
  // GHA cancel delivers SIGTERM/SIGINT (§3): stop starting cases, `docker stop`
  // whatever is in flight, report what we have, post a best-effort complete.
  let canceled = false;
  const onSignal = () => {
    canceled = true;
    stopActiveContainers();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    // Inside the try: a claim/materialize failure must still post `complete`
    // with the real error — dying here used to leave the group to the
    // reconciler's anonymous "runner died before case started".
    const { sessions: claimed, failed: failedSessions, secretValues: mintSecrets } =
      await claimGroupSessions(api, spec, opts);
    redactor = makeRedactor([...collectSecretValues(spec, claimed), ...mintSecrets]);
    const failedByLabel = failedSessionLabels(spec, failedSessions);
    workspace = await materializeWorkspace({ api, spec, sessions: claimed, failedSessions, workDir: opts.workDir });
    const resolved = await discoverCases([workspace.suiteDir], { env: spec.environment.name });
    const byId = new Map(resolved.map((c) => [c.id, c]));
    const selectedResolved = spec.cases.map((item: RunnerDynamic) => byId.get(item.case_id)).filter(Boolean);
    const budget = resolveHostedBudget(selectedResolved, spec.parallel);
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
          env: workspace.env,
          allowDocker: (spec.environment?.runner_labels || []).includes("docker"),
          onEvent: progress.onEvent,
        });
        const bundle = await uploadBundle(api, item.db_id, res.runDir);
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
      }
      progress.stop();
      await api.json("POST", `/runner/groups/${spec.run_group_id}/cases/${item.run_id}/report`, report);
      orderedResults[index] = report;
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
    warnings.push(...(await cleanupWorkspace(workspace)));
  }
  return { exitCode: results.some((r) => r.status === "fail") ? 1 : results.some((r) => r.status === "infra") ? 2 : 0, results };
}

/**
 * Resolve the executor pool with hosted precedence: a suite's pinned
 * playtest.yaml wins as one run-wide value, then the project policy from the
 * group spec, then the historical serial fallback.
 */
export function resolveHostedBudget(resolvedCases: RunnerDynamic[], projectParallel: RunnerDynamic, auto = Math.min(4, os.availableParallelism())): RunnerDynamic {
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
  const snap: Record<string, RunnerDynamic> = {};
  let timer: NodeJS.Timeout | null = null;
  let lastSent = 0;
  let dirty = false;
  let stopped = false;

  const send = () => {
    timer = null;
    if (stopped || !dirty) return;
    dirty = false;
    lastSent = now();
    api.json("POST", `/runner/groups/${groupId}/cases/${runId}/progress`, { ...snap }).catch(() => {});
  };
  const schedule = () => {
    dirty = true;
    if (stopped || timer) return;
    timer = setTimeout(send, Math.max(0, lastSent + intervalMs - now()));
    timer.unref?.();
  };

  // The mode-word state machine mirrors the CLI live reporter (packages/cli/src/live.ts):
  // a pre-actor phase (setup) promotes the word, step_start restores the actor's
  // own word, and the grader phases swap the model chip to the model actually
  // doing the work.
  let actorDoing: string | null = null;
  let graderModel: string | null = null;
  const onEvent = (ev: RunnerDynamic) => {
    switch (ev.type) {
      case "case_start":
        actorDoing = snap.doing = modeDoing(ev.mode);
        snap.max_steps = ev.maxSteps ?? null;
        snap.model = ev.actorModel || null;
        graderModel = ev.graderModel || null;
        break;
      case "step_start":
        snap.step = ev.step;
        snap.doing = actorDoing;
        snap.action = ev.summary ? redactor(String(ev.summary)).slice(0, 200) : null;
        break;
      case "step_result":
        if (ev.costSoFar != null) snap.cost_usd = ev.costSoFar;
        if (ev.tokens) snap.tokens = ev.tokens;
        break;
      case "heal_start":
        actorDoing = snap.doing = modeDoing("heal");
        snap.action = null;
        break;
      case "heal_resume":
        // Re-anchored: replay resumed, so the mode word goes back to acting.
        actorDoing = snap.doing = modeDoing("act");
        snap.action = null;
        break;
      case "phase":
      case "grading": {
        const phase: keyof typeof PHASE_DOING = ev.phase ?? ev.type;
        snap.doing = PHASE_DOING[phase] ?? snap.doing;
        snap.action = null; // the actor stopped acting; its last step summary is stale
        if ((phase === "gate" || phase === "grading") && graderModel) snap.model = graderModel;
        break;
      }
      default:
        return; // retry/env_ready/gate_fail/warn/case_end move nothing a live row shows
    }
    schedule();
  };

  return {
    onEvent,
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
async function claimGroupSessions(api: RunnerDynamic, spec: RunnerDynamic, opts: RunnerDynamic): Promise<RunnerDynamic> {
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
          const msg = firstLine(e);
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
  const identities: Record<string, RunnerDynamic> = spec.environment?.config?.auth?.identities || {};
  for (const [label, cfg] of Object.entries(identities)) {
    const ref = cfg && typeof cfg === "object" ? cfg.$session : null;
    if (ref && failedSessions[ref]) out[label] = `${ref}: ${failedSessions[ref]}`;
  }
  return out;
}

async function uploadBundle(api: RunnerDynamic, runDbId: string, runDir: string | null | undefined): Promise<RunnerDynamic> {
  if (!runDir) return { artifact: null };
  const out = path.join(os.tmpdir(), `playtest-${process.pid}-${runDbId}.ptrun`);
  try {
    writeBundle(runDir, out);
    return await api.putBytes(`/runner/runs/${runDbId}/bundle`, await fsp.readFile(out), "application/vnd.playtest.run-bundle");
  } finally {
    await fsp.rm(out, { force: true }).catch(() => {});
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

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): RunnerDynamic {
  const opts: RunnerDynamic = {
    server: env.PLAYTEST_SERVER_URL || env.PLAYTEST_HOSTED_URL || "http://127.0.0.1:4177",
    group: env.PLAYTEST_RUN_GROUP || null,
    dispatchId: env.PLAYTEST_DISPATCH_ID || null,
    oidcToken: env.ACTIONS_ID_TOKEN || env.PLAYTEST_GITHUB_OIDC_TOKEN || null,
    isolation: env.PLAYTEST_RUNNER_ISOLATION || "process",
    workDir: env.PLAYTEST_RUNNER_WORKDIR || path.join(os.tmpdir(), "playtest-runner"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") opts.server = argv[++i];
    else if (a === "--group") opts.group = argv[++i];
    else if (a === "--dispatch") opts.dispatchId = argv[++i];
    else if (a === "--oidc-token") opts.oidcToken = argv[++i];
    else if (a === "--isolation") opts.isolation = argv[++i];
    else if (a === "--work-dir") opts.workDir = argv[++i];
    else if (a === "exec") {
      /* accepted for `runner-agent exec --group ...` */
    } else if (a === "--help" || a === "-h") {
      process.stdout.write("usage: runner-agent exec --group <id> [--server <url>] [--isolation process|container]\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.group) throw new Error("--group is required");
  if (!["process", "container"].includes(opts.isolation)) throw new Error("--isolation must be process or container");
  return opts;
}

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
