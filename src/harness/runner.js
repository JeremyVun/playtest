// Per-case orchestration: record / act / heal. See docs/CONTRACTS.md §10.
import fs from "node:fs";
import os from "node:os";
import {
  PINS_BASE,
  STEP_SCHEMA_VERSION,
  RunWriter,
  actionOf,
  actionTrack,
  baselinePaths,
  blessBaseline,
  firstLine,
  readBaseline,
} from "./trajectory.js";
import { Session } from "./browser.js";
import { Actor, loadPersona } from "./actor.js";
import { evaluateGate } from "./gate.js";
import { gradeRun, checkAssertion } from "./grader.js";
import { llmConfig, estimateCost } from "./llm.js";
import { prepareEnv, InfraError } from "./env.js";
import { caseLine, summary, junitXml } from "./report.js";

const HARD_TIMEOUT = Symbol("hard timeout");

const emptyPerf = () => ({ input_to_paint_ms: null, long_tasks_ms: 0, requests: 0, js_errors: 0, nav: null });

function artifactsFor(stepNum, harEntries) {
  const nnn = String(stepNum).padStart(3, "0");
  return {
    screenshot: `steps/${nnn}.png`,
    mhtml: `steps/${nnn}.mhtml`,
    a11y: `steps/${nnn}.a11y.txt`,
    har_entries: harEntries,
  };
}

function addTokens(total, t) {
  total.in += t.in ?? 0;
  total.out += t.out ?? 0;
  total.cache_read += t.cache_read ?? 0;
}

/**
 * Run one case end to end. Never throws; InfraError -> status "infra".
 * @param {object} rc ResolvedCase
 * @param {{ mode?: "auto"|"agent", runsRoot: string, runId: string, grade?: boolean,
 *           headed?: boolean, rebaseline?: boolean, runIndex?: number }} opts
 * @returns {Promise<{ status: "pass"|"fail"|"infra", runDir: string, manifest: object, error?: string }>}
 */
export async function runCase(rc, opts) {
  const { runsRoot, runId, mode = "auto", grade = true, headed = false, rebaseline = false, runIndex = 1 } = opts;
  const writer = new RunWriter(runsRoot, runId, runIndex > 1 ? `${rc.id}-${runIndex}` : rc.id);
  const startedAt = new Date();
  const llm = llmConfig();

  // A corrupt/unparseable committed baseline must fail this case as infra,
  // not throw out of runCase (contract §10: never throws).
  let baseline = null;
  let baselineError = null;
  if (mode !== "agent" && !rebaseline) {
    try {
      baseline = readBaseline(rc.file);
    } catch (e) {
      baselineError = `unreadable baseline ${baselinePaths(rc.file).traj}: ${firstLine(e)}`;
    }
  }
  const startMode = baseline && actionTrack(baseline.envelopes).length > 0 ? "act" : "record";

  // Mutable run state shared with the loops.
  const abort = new AbortController();
  const r = {
    envelopes: [],
    tokens: { in: 0, out: 0, cache_read: 0 },
    lastSnapshot: null,
    initialNav: null,
    endReason: "error",
    runError: null,
    aborted: false, // set on hard timeout; loops stop appending/acting
    signal: abort.signal, // cancels in-flight LLM calls on hard timeout
  };

  const finishInfra = async (error, { session = null, env = null } = {}) => {
    if (session) await session.close().catch(() => {});
    if (env) await env.teardown();
    const manifest = buildManifest({
      rc, runId, mode: startMode, startedAt, videoStartedAt: null, llm, env, r,
      status: "infra", gate: { pass: false, checks: [] },
      consoleErrors: 0, baseline, willGrade: false,
    });
    writer.writeManifest(manifest);
    return { status: "infra", runDir: writer.dir, manifest, error };
  };

  if (baselineError) return finishInfra(baselineError);

  if (startMode === "record" && !llm.available) {
    return finishInfra("record mode needs a model: set DUMMY_LLM_BASE_URL or an API key");
  }

  let env;
  try {
    env = await prepareEnv(rc, runId);
  } catch (e) {
    return finishInfra(e.message);
  }

  let session;
  try {
    session = await Session.launch({
      baseUrl: env.baseUrl,
      runDir: writer.dir,
      storageState: rc.env.storage_state,
      headed,
    });
  } catch (e) {
    return finishInfra(`browser launch failed: ${firstLine(e)}`, { env });
  }
  const videoStartedAt = Date.now();

  let actualMode = startMode;
  let actFailedUnhealed = false;
  let infra = null;

  const body = async () => {
    const nav = await session.goto(env.baseUrl);
    if (!nav.ok) throw new InfraError(`could not open ${env.baseUrl}: ${nav.error}`);
    r.initialNav = nav; // its nav vitals (LCP etc.) feed the perf gate
    const deadline = Date.now() + rc.limits.timeout_ms;

    if (startMode === "act") {
      writer.copyBaseline(baselinePaths(rc.file).traj);
      const failed = await actLoop({ session, writer, rc, deadline, r, baselineEnvelopes: baseline.envelopes });
      if (failed) {
        if (!llm.available) {
          // contract: an unhealable act failure is a gate failure
          actFailedUnhealed = true;
          r.endReason = "error";
          r.runError = `acted step ${failed.step} failed and no LLM is configured to heal`;
          return;
        }
        actualMode = "heal";
        await recordLoop({ session, writer, rc, deadline, r });
      }
    } else {
      await recordLoop({ session, writer, rc, deadline, r });
    }
  };

  // Loop-level deadline checks bound each turn; this hard cap wraps the whole
  // case in case something hangs anyway.
  let timer;
  try {
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => resolve(HARD_TIMEOUT), rc.limits.timeout_ms + 30000);
    });
    const loop = body();
    if ((await Promise.race([loop, cap])) === HARD_TIMEOUT) {
      // Stop the loop and wait for it to settle before the gate/manifest/bless
      // below read shared state: the abort cancels any in-flight LLM call, the
      // aborted flag stops the loop at its next checkpoint, and Playwright ops
      // are bounded by their own timeouts.
      r.aborted = true;
      abort.abort(new Error("hard timeout"));
      await loop.catch(() => {});
      r.endReason = "timeout";
      r.runError = "hard timeout: the run exceeded its budget and did not respond to the deadline";
    }
  } catch (e) {
    if (e instanceof InfraError) infra = e;
    else {
      r.endReason = "error";
      r.runError = firstLine(e);
    }
  } finally {
    clearTimeout(timer);
  }

  if (infra) return finishInfra(infra.message, { session, env });

  // Gate (assert wired to the grader model), then manifest, then teardown.
  let finalUrl = "";
  try {
    finalUrl = session.page.url();
  } catch {}
  const gate = await evaluateGate(rc, {
    session,
    harEntries: readHar(writer.dir),
    consoleErrorCount: session.consoleErrors(),
    // the harness-side initial page load isn't an envelope; include its nav
    // vitals so perf.lcp_ms can gate single-page cases
    trajectory: r.initialNav ? [{ perf: r.initialNav.perf }, ...r.envelopes] : r.envelopes,
    finalUrl,
    checkAssertion: llm.available
      ? (claim) =>
          checkAssertion(claim, {
            snapshotText: r.lastSnapshot ?? "(no snapshot captured)",
            finalUrl,
            model: rc.grader_model,
          })
      : null,
  });
  const status = gate.pass && !actFailedUnhealed ? "pass" : "fail";
  const willGrade = grade && llm.available && actualMode !== "act";

  const manifest = buildManifest({
    rc, runId, mode: actualMode, startedAt, videoStartedAt, llm, env, r,
    status, gate, consoleErrors: session.consoleErrors(), baseline, willGrade,
  });
  writer.writeManifest(manifest);
  await session.close().catch(() => {});
  await env.teardown();

  if (willGrade) {
    try {
      await gradeRun(writer.dir, rc);
    } catch (e) {
      console.error(`warning: grading ${rc.id} failed: ${firstLine(e)}`);
      manifest.artifacts.grade = null;
      writer.writeManifest(manifest);
    }
  }

  if (status === "pass") {
    // existsSync, not readBaseline: a corrupt-but-present baseline must not
    // throw here, and must not be silently overwritten by a bless.
    if (actualMode === "record" && (rebaseline || !fs.existsSync(baselinePaths(rc.file).traj))) {
      blessBaseline(rc.file, writer.dir);
    } else if (actualMode === "heal") {
      blessBaseline(rc.file, writer.dir, { healed: true });
    }
  }

  return { status, runDir: writer.dir, manifest, ...(r.runError ? { error: r.runError } : {}) };
}

/** Agentic loop (record, and heal continuation). Budget is total max_steps. */
async function recordLoop({ session, writer, rc, deadline, r }) {
  const actor = new Actor(rc, loadPersona(rc.persona, rc.file));
  while (r.envelopes.length < rc.limits.max_steps) {
    if (r.aborted) return;
    if (Date.now() >= deadline) {
      r.endReason = "timeout";
      return;
    }
    const stepNum = r.envelopes.length + 1;
    const snap = await session.captureSnapshot(stepNum);
    if (r.aborted) return;
    r.lastSnapshot = snap.text;
    const { agentStep, tokens } = await actor.nextStep({
      history: r.envelopes,
      snapshotText: snap.text,
      stepNum,
      signal: r.signal,
    });
    if (r.aborted) return;
    addTokens(r.tokens, tokens);

    const envelope = {
      step: stepNum,
      schema_version: STEP_SCHEMA_VERSION,
      ts: Date.now(),
      mode: "agent",
      agent: agentStep,
    };
    const type = agentStep.action.type;
    if (type === "done" || type === "give_up") {
      Object.assign(envelope, {
        result: { ok: true, error: null, settle_ms: 0, url: snap.url },
        perf: emptyPerf(),
        artifacts: artifactsFor(stepNum, []),
        tokens,
      });
      writer.appendEnvelope(envelope);
      r.envelopes.push(envelope);
      r.endReason = type;
      return;
    }

    const before = await effectToken(session);
    const exec = await session.execute(agentStep.action);
    Object.assign(envelope, {
      ...(exec.resolution ? { resolution: exec.resolution } : {}),
      result: { ok: exec.ok, error: exec.error, settle_ms: exec.settle_ms, url: exec.url ?? null },
      perf: exec.perf,
      artifacts: artifactsFor(stepNum, exec.har_entries),
      tokens,
    });
    const confusion = await detectConfusion(envelope, r.envelopes, exec, before, session);
    if (r.aborted) return; // do not append past the hard-timeout cut
    if (confusion) envelope.confusion = confusion;
    writer.appendEnvelope(envelope);
    r.envelopes.push(envelope);
  }
  r.endReason = "max_steps";
}

/**
 * Walk the baseline's action track. Returns the failed baseline step (heal
 * point) or null when the track completed / deadline hit.
 */
async function actLoop({ session, writer, rc, deadline, r, baselineEnvelopes }) {
  for (const baseStep of actionTrack(baselineEnvelopes)) {
    if (r.aborted) return null;
    if (Date.now() >= deadline) {
      r.endReason = "timeout";
      return null;
    }
    const stepNum = r.envelopes.length + 1;
    const snap = await session.captureSnapshot(stepNum);
    r.lastSnapshot = snap.text;
    const exec = await session.executeLocator(baseStep);
    if (r.aborted) return null; // do not append past the hard-timeout cut
    const envelope = {
      step: stepNum,
      schema_version: STEP_SCHEMA_VERSION,
      ts: Date.now(),
      mode: "act",
      acted_from: baseStep.step,
      action: actionOf(baseStep),
      ...(exec.resolution ? { resolution: exec.resolution } : {}),
      result: { ok: exec.ok, error: exec.error, settle_ms: exec.settle_ms, url: exec.url ?? null },
      perf: exec.perf,
      artifacts: artifactsFor(stepNum, exec.har_entries),
    };
    if (!exec.ok) envelope.confusion = { type: "action_failed", note: exec.error };
    writer.appendEnvelope(envelope);
    r.envelopes.push(envelope);
    if (!exec.ok) return baseStep;
  }

  // Track done: act the baseline's done step so the run records the final state.
  if (r.aborted) return null;
  const doneStep = baselineEnvelopes.findLast((e) => actionOf(e)?.type === "done");
  const stepNum = r.envelopes.length + 1;
  let finalUrl = null;
  try {
    const snap = await session.captureSnapshot(stepNum);
    r.lastSnapshot = snap.text;
    finalUrl = snap.url;
  } catch {}
  if (r.aborted) return null;
  const envelope = {
    step: stepNum,
    schema_version: STEP_SCHEMA_VERSION,
    ts: Date.now(),
    mode: "act",
    ...(doneStep ? { acted_from: doneStep.step } : {}),
    action: doneStep ? actionOf(doneStep) : { type: "done", summary: "acted the baseline track to completion" },
    result: { ok: true, error: null, settle_ms: 0, url: finalUrl },
    perf: emptyPerf(),
    artifacts: artifactsFor(stepNum, []),
  };
  writer.appendEnvelope(envelope);
  r.envelopes.push(envelope);
  r.endReason = "done";
  return null;
}

// Confusion heuristics (harness-side, contract §10): action_failed,
// repeated_action (same type+target 3x consecutively), no_effect.
async function detectConfusion(envelope, prior, exec, beforeToken, session) {
  if (!exec.ok) return { type: "action_failed", note: exec.error };

  const sig = (e) => {
    const a = actionOf(e) ?? {};
    return `${a.type}|${a.ref ?? e.resolution?.locator ?? a.url ?? ""}`;
  };
  const last2 = prior.slice(-2);
  if (last2.length === 2 && last2.every((e) => sig(e) === sig(envelope))) {
    return { type: "repeated_action", note: `same action three times in a row: ${sig(envelope)}` };
  }

  const type = actionOf(envelope)?.type;
  if ((type === "click" || type === "type") && exec.perf.requests === 0 && beforeToken !== null) {
    const after = await effectToken(session);
    if (after !== null && after === beforeToken) {
      return { type: "no_effect", note: "no requests, no DOM or input changes, url unchanged" };
    }
  }
  return null;
}

// Cheap page-state fingerprint for no_effect detection: last DOM mutation time,
// form values (MutationObserver misses input value changes), and the URL.
async function effectToken(session) {
  try {
    return await session.page.evaluate(() => {
      const vals = Array.from(document.querySelectorAll("input,textarea,select"), (el) => el.value).join("\u0000");
      const d = window.__dummy;
      return `${d ? d.lastMutationAt : 0}|${vals}|${location.href}`;
    });
  } catch {
    return null;
  }
}

function buildManifest({ rc, runId, mode, startedAt, videoStartedAt, llm, env, r, status, gate, consoleErrors, baseline, willGrade }) {
  const finishedAt = new Date();
  return {
    schema_version: 1,
    run_id: runId,
    case: {
      id: rc.id,
      file: rc.file,
      story: rc.story,
      persona: rc.persona,
      tags: rc.tags,
      success: rc.success,
      perf: rc.perf,
      limits: rc.limits,
    },
    mode,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,
    video_started_at: videoStartedAt,
    pins: {
      ...PINS_BASE,
      actor_model: rc.actor_model,
      grader_model: rc.grader_model,
      gateway: llm.baseUrl,
    },
    env: { base_url: env?.baseUrl ?? rc.env.base_url, managed: env?.managed ?? false },
    result: { status, end_reason: r.endReason, error: r.runError, gate },
    totals: {
      steps: r.envelopes.length,
      executed_steps: actionTrack(r.envelopes).length,
      tokens: r.tokens,
      cost_usd: estimateCost(rc.actor_model, r.tokens),
      console_errors: consoleErrors,
      confusion_events: r.envelopes.filter((e) => e.confusion).length,
    },
    healed: mode === "heal",
    baseline:
      mode !== "record" && baseline
        ? { run_id: baseline.meta?.run_id ?? null, blessed_at: baseline.meta?.blessed_at ?? null }
        : null,
    artifacts: {
      trajectory: "trajectory.jsonl",
      har: "har.json",
      video: "video.webm",
      trace: "trace.zip",
      grade: willGrade ? "grade.json" : null,
      baseline_copy: mode !== "record" && baseline ? "baseline.jsonl" : null,
    },
  };
}

function readHar(runDir) {
  try {
    return JSON.parse(fs.readFileSync(`${runDir}/har.json`, "utf8")).log.entries;
  } catch {
    return [];
  }
}

/**
 * Run every case (honoring runs_per_case), print report lines, write JUnit.
 * Serial for external envs; managed-only selections run parallel min(4, cores);
 * --parallel overrides.
 * @returns {Promise<{ exitCode: 0|1|2, results: object[] }>}
 */
export async function runAll(resolvedCases, opts) {
  const jobs = [];
  for (const rc of resolvedCases) {
    for (let i = 1; i <= (rc.runs_per_case ?? 1); i++) jobs.push({ rc, runIndex: i });
  }

  const defaultPool = Math.min(4, os.availableParallelism());
  let concurrency = 1;
  if (typeof opts.parallel === "number") concurrency = Math.max(1, opts.parallel);
  else if (opts.parallel === true) concurrency = defaultPool;
  else if (jobs.length && jobs.every(({ rc }) => rc.env.compose)) concurrency = defaultPool;

  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const { rc, runIndex } = jobs[i];
      // runCase never throws per contract, but stay defensive: one rejected
      // job must not reject Promise.all and suppress the report/JUnit output.
      results[i] = await runCase(rc, { ...opts, runIndex }).catch((e) => ({
        status: "infra",
        runDir: null,
        manifest: null,
        error: `runner error for ${rc.id}: ${firstLine(e)}`,
      }));
      console.log(caseLine(results[i]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) || 1 }, worker));

  console.log(summary(results));
  if (opts.junit) fs.writeFileSync(opts.junit, junitXml(results));

  const anyFail = results.some((res) => res.status === "fail");
  const anyInfra = results.some((res) => res.status === "infra");
  return { exitCode: anyFail ? 1 : anyInfra ? 2 : 0, results };
}
