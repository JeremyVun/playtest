// Per-case orchestration: record / act / heal, plus discovery's explore. See docs/CONTRACTS.md §10.
import fs from "node:fs";
import os from "node:os";
import {
  PINS_BASE,
  STEP_SCHEMA_VERSION,
  RunWriter,
  actionOf,
  actionTrack,
  baselinePaths,
  acceptBaseline,
  firstLine,
  readBaseline,
} from "./trajectory.js";
import { Session } from "./browser.js";
import { Actor, loadPersona, describeAction } from "./actor.js";
import { evaluateGate } from "./gate.js";
import { gradeRun, checkAssertion } from "./grader.js";
import { llmConfig, estimateCost } from "./llm.js";
import { prepareEnv, InfraError } from "./env.js";
import { junitXml } from "./report.js";

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
 * `onEvent` receives progress events ({ type, caseId, ...payload }):
 * case_start, env_ready, step_start, step_result, heal_start, grading,
 * gate_fail, warn, case_end (emitted on every exit path, infra included).
 * @param {object} rc ResolvedCase
 * @param {{ mode?: "auto"|"agent", runsRoot: string, runId: string, grade?: boolean,
 *           headed?: boolean, refresh?: boolean,
 *           onEvent?: (event: object) => void }} opts
 * @returns {Promise<{ status: "pass"|"fail"|"infra"|"explored", runDir: string, manifest: object,
 *   score: number|null, error?: string }>} score is the grade when this run graded
 */
export async function runCase(rc, opts) {
  const { runsRoot, runId, mode = "auto", grade = true, headed = false, refresh = false, onEvent = () => {} } = opts;
  const writer = new RunWriter(runsRoot, runId, rc.id);
  const startedAt = new Date();
  const llm = llmConfig();
  // A throwing progress listener must not break the case (contract §10:
  // runCase never throws).
  const emit = (type, payload = {}) => {
    try {
      onEvent({ type, caseId: rc.id, ...payload });
    } catch {}
  };

  // A corrupt/unparseable committed baseline must fail this case as infra,
  // not throw out of runCase (contract §10: never throws). Discovery is always
  // a fresh exploration: never read a baseline, even a stray one next to the case.
  const discovery = rc.mode === "discovery";
  let baseline = null;
  let baselineError = null;
  if (!discovery && mode !== "agent" && !refresh) {
    try {
      baseline = readBaseline(rc.file);
    } catch (e) {
      baselineError = `unreadable baseline ${baselinePaths(rc.file).traj}: ${firstLine(e)}`;
    }
  }
  const startMode = discovery ? "explore" : baseline && actionTrack(baseline.envelopes).length > 0 ? "act" : "record";
  emit("case_start", { mode: startMode, maxSteps: rc.limits.max_steps, runDir: writer.dir });

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
    // The manifest must carry the infra cause: result.error is the only place
    // a later reader (viewer, fix-loop skill) can find it — the in-memory
    // result doesn't survive the process, and --json/stderr stay silent here.
    r.runError = r.runError ?? firstLine(error);
    const manifest = buildManifest({
      rc, runId, mode: startMode, startedAt, videoStartedAt: null, llm, env, r,
      status: "infra", gate: { pass: false, checks: [] },
      consoleErrors: 0, baseline, willGrade: false, headed,
    });
    writer.writeManifest(manifest);
    const result = { status: "infra", runDir: writer.dir, manifest, score: null, error };
    emit("case_end", { status: "infra", result });
    return result;
  };

  if (baselineError) return finishInfra(baselineError);

  // Resolve the persona before any env/browser work: an unknown persona is a
  // config error (infra, exit 2), surfaced loudly even on act-mode runs that
  // would only need it to heal.
  let persona;
  try {
    persona = loadPersona(rc.persona, rc.file);
  } catch (e) {
    return finishInfra(firstLine(e));
  }

  if (startMode !== "act" && !llm.available) {
    return finishInfra(`${startMode} mode needs a model: set PLAYTEST_LLM_BASE_URL or an API key`);
  }

  let env;
  try {
    env = await prepareEnv(rc, runId);
  } catch (e) {
    return finishInfra(e.message);
  }
  emit("env_ready", { base_url: env.baseUrl, managed: env.managed });

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
      const failed = await actLoop({ session, writer, rc, deadline, r, emit, baselineEnvelopes: baseline.envelopes });
      if (failed) {
        if (!llm.available) {
          // contract: an unhealable act failure is a gate failure
          actFailedUnhealed = true;
          r.endReason = "error";
          r.runError = `acted step ${failed.step} failed and no LLM is configured to heal`;
          return;
        }
        actualMode = "heal";
        emit("heal_start", { failedStep: failed.step });
        await recordLoop({ session, writer, rc, persona, deadline, r, emit });
      }
    } else {
      await recordLoop({ session, writer, rc, persona, deadline, r, emit });
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
      // Stop the loop and wait for it to settle before the gate/manifest/accept
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
  // Discovery skips the gate entirely, keyed on the case mode — not on the
  // empty success list, which gate.js would pass vacuously. A run that errored
  // produced no exploration data: it stays infra.
  let gate = null;
  let status;
  if (discovery) {
    status = ["done", "give_up", "max_steps", "timeout"].includes(r.endReason) ? "explored" : "infra";
  } else {
    let finalUrl = "";
    try {
      finalUrl = session.page.url();
    } catch {}
    gate = await evaluateGate(rc, {
      session,
      harEntries: readHar(writer.dir),
      consoleErrorCount: session.consoleErrors(),
      // the harness-side initial page load isn't an envelope; include its nav
      // vitals (perf.lcp_ms gates single-page cases) and its network requests
      // (api_called must see first-load calls like the app's bootstrap GET)
      trajectory: r.initialNav
        ? [{ perf: r.initialNav.perf, network: r.initialNav.network }, ...r.envelopes]
        : r.envelopes,
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
    if (!gate.pass) emit("gate_fail", { checks: gate.checks.filter((c) => !c.pass) });
    status = gate.pass && !actFailedUnhealed ? "pass" : "fail";
  }
  const willGrade = grade && llm.available && actualMode !== "act";

  const manifest = buildManifest({
    rc, runId, mode: actualMode, startedAt, videoStartedAt, llm, env, r,
    status, gate, consoleErrors: session.consoleErrors(), baseline, willGrade, headed,
  });
  writer.writeManifest(manifest);
  await session.close().catch(() => {});
  await env.teardown();

  // The score rides on the result so trend lines and --json need not re-read
  // grade.json.
  let score = null;
  if (willGrade) {
    emit("grading");
    try {
      score = (await gradeRun(writer.dir, rc)).score ?? null;
    } catch (e) {
      emit("warn", { message: `warning: grading ${rc.id} failed: ${firstLine(e)}` });
      manifest.artifacts.grade = null;
      writer.writeManifest(manifest);
    }
  }

  // Discovery never writes baselines or healed candidates, refresh included
  // (its status above is never "pass"; the guard states the constraint).
  if (status === "pass" && !discovery) {
    // existsSync, not readBaseline: a corrupt-but-present baseline must not
    // throw here, and must not be silently overwritten by an accept.
    if (actualMode === "record" && (refresh || !fs.existsSync(baselinePaths(rc.file).traj))) {
      acceptBaseline(rc.file, writer.dir);
      if (refresh) {
        // A refreshed baseline invalidates any pending healed candidate: that
        // candidate diffs against the baseline this accept just replaced.
        const p = baselinePaths(rc.file);
        fs.rmSync(p.healedTraj, { force: true });
        fs.rmSync(p.healedMeta, { force: true });
      }
    } else if (actualMode === "heal") {
      acceptBaseline(rc.file, writer.dir, { healed: true });
    }
  }

  const result = { status, runDir: writer.dir, manifest, score, ...(r.runError ? { error: r.runError } : {}) };
  emit("case_end", { status, result });
  return result;
}

/** Agentic loop (record, and heal continuation). Budget is total max_steps. */
async function recordLoop({ session, writer, rc, persona, deadline, r, emit }) {
  const actor = new Actor(rc, persona);
  const costSoFar = () => estimateCost(rc.actor_model, r.tokens);
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
    // The summary only exists once the model has decided; one event per step.
    emit("step_start", { step: stepNum, summary: describeAction(agentStep.action) });

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
        network: { requests: [] },
        tokens,
      });
      writer.appendEnvelope(envelope);
      r.envelopes.push(envelope);
      emit("step_result", { step: stepNum, ok: true, error: null, settleMs: 0, costSoFar: costSoFar() });
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
      network: exec.network,
      tokens,
    });
    const confusion = await detectConfusion(envelope, r.envelopes, exec, before, session);
    if (r.aborted) return; // do not append past the hard-timeout cut
    if (confusion) envelope.confusion = confusion;
    writer.appendEnvelope(envelope);
    r.envelopes.push(envelope);
    emit("step_result", { step: stepNum, ok: exec.ok, error: exec.error, settleMs: exec.settle_ms, costSoFar: costSoFar() });
  }
  r.endReason = "max_steps";
}

/**
 * Walk the baseline's action track. Returns the failed baseline step (heal
 * point) or null when the track completed / deadline hit.
 */
async function actLoop({ session, writer, rc, deadline, r, emit, baselineEnvelopes }) {
  for (const baseStep of actionTrack(baselineEnvelopes)) {
    if (r.aborted) return null;
    if (Date.now() >= deadline) {
      r.endReason = "timeout";
      return null;
    }
    const stepNum = r.envelopes.length + 1;
    // Acted steps replay a known action: the summary is known up front.
    emit("step_start", { step: stepNum, summary: describeAction(actionOf(baseStep)) });
    const snap = await session.captureSnapshot(stepNum);
    r.lastSnapshot = snap.text;
    // ts is "at action dispatch" (CONTRACTS): stamped before execution, like the
    // record loop, so the viewer's video seek lands on the frame the step acted on
    const ts = Date.now();
    const exec = await session.executeLocator(baseStep);
    if (r.aborted) return null; // do not append past the hard-timeout cut
    const envelope = {
      step: stepNum,
      schema_version: STEP_SCHEMA_VERSION,
      ts,
      mode: "act",
      acted_from: baseStep.step,
      action: actionOf(baseStep),
      ...(exec.resolution ? { resolution: exec.resolution } : {}),
      result: { ok: exec.ok, error: exec.error, settle_ms: exec.settle_ms, url: exec.url ?? null },
      perf: exec.perf,
      artifacts: artifactsFor(stepNum, exec.har_entries),
      network: exec.network,
    };
    if (!exec.ok) envelope.confusion = { type: "action_failed", note: exec.error };
    writer.appendEnvelope(envelope);
    r.envelopes.push(envelope);
    emit("step_result", {
      step: stepNum, ok: exec.ok, error: exec.error, settleMs: exec.settle_ms,
      costSoFar: estimateCost(rc.actor_model, r.tokens),
    });
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
    network: { requests: [] },
  };
  writer.appendEnvelope(envelope);
  r.envelopes.push(envelope);
  emit("step_start", { step: stepNum, summary: describeAction(envelope.action) });
  emit("step_result", { step: stepNum, ok: true, error: null, settleMs: 0, costSoFar: estimateCost(rc.actor_model, r.tokens) });
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

function buildManifest({ rc, runId, mode, startedAt, videoStartedAt, llm, env, r, status, gate, consoleErrors, baseline, willGrade, headed = false }) {
  const finishedAt = new Date();
  return {
    schema_version: 1,
    run_id: runId,
    // mode/report ride along so `playtest grade` re-grades with the right rubric.
    case: {
      id: rc.id,
      file: rc.file,
      story: rc.story,
      mode: rc.mode,
      persona: rc.persona,
      tags: rc.tags,
      success: rc.success,
      perf: rc.perf,
      report: rc.report,
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
      headed, // part of the comparability key (shared/movement.js)
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
        ? { run_id: baseline.meta?.run_id ?? null, accepted_at: baseline.meta?.accepted_at ?? null }
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
 * Run every case, write JUnit. All console output
 * goes through `opts.reporter` ({ onEvent(event), done(results) }) so the CLI
 * chooses plain lines, a live TTY region, or silence (--json).
 * Serial for external envs; managed-only selections run parallel min(4, cores);
 * --parallel overrides.
 * @returns {Promise<{ exitCode: 0|1|2, results: object[] }>}
 */
export async function runAll(resolvedCases, opts) {
  const reporter = opts.reporter ?? { onEvent: () => {}, done: () => {} };
  // One guard for every emission: a throwing reporter must not break the run.
  const onEvent = (event) => {
    try {
      reporter.onEvent(event);
    } catch {}
  };

  const defaultPool = Math.min(4, os.availableParallelism());
  let concurrency = 1;
  if (typeof opts.parallel === "number") concurrency = Math.max(1, opts.parallel);
  else if (opts.parallel === true) concurrency = defaultPool;
  else if (resolvedCases.length && resolvedCases.every((rc) => rc.env.compose)) concurrency = defaultPool;

  const results = new Array(resolvedCases.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= resolvedCases.length) return;
      const rc = resolvedCases[i];
      // runCase never throws per contract, but stay defensive: one rejected
      // case must not reject Promise.all and suppress the report/JUnit output.
      // This catch is the one exit runCase cannot see, so emit its case_end.
      results[i] = await runCase(rc, { ...opts, onEvent }).catch((e) => {
        const result = {
          status: "infra",
          runDir: null,
          manifest: null,
          score: null,
          error: `runner error for ${rc.id}: ${firstLine(e)}`,
        };
        onEvent({ type: "case_end", caseId: rc.id, status: "infra", result });
        return result;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, resolvedCases.length) || 1 }, worker));

  try {
    reporter.done(results);
  } catch {}
  if (opts.junit) fs.writeFileSync(opts.junit, junitXml(results));

  const anyFail = results.some((res) => res.status === "fail");
  const anyInfra = results.some((res) => res.status === "infra");
  return { exitCode: anyFail ? 1 : anyInfra ? 2 : 0, results };
}
