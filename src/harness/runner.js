import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PINS_BASE,
  STEP_SCHEMA_VERSION,
  RunWriter,
  actionOf,
  actionTrack,
  isReplayableBaseline,
  baselinePaths,
  acceptBaseline,
  firstLine,
  readBaseline,
  storyHash,
  suiteRootFor,
} from "./trajectory.js";
import { loadHooks, validateSetupContext } from "./hooks.js";
import { createDriver } from "./driver.js";
import { visualDriftReason } from "./drivers/web.js";
import { Actor, loadPersona, describeAction } from "./actor.js";
import { evaluateGate, isInheritable } from "./gate.js";
import { gradeRun, checkAssertion } from "./grader.js";
import { llmConfig, estimateCost } from "./llm.js";
import { prepareEnv, InfraError } from "./env.js";
import { junitXml } from "./report.js";
import { writeVideoSidecar, ffmpegPresent, buildSlideshow, FFMPEG_HINT } from "./clip.js";

const HARD_TIMEOUT = Symbol("hard timeout");

// SIGINT flush registry: a Ctrl-C'd run never reaches the final writeManifest,
// so each in-flight runCase registers a zero-arg sync flusher that writes its
// manifest from current in-memory state before the process exits. The handler
// is installed once (the flag survives concurrent cases — no listener leak).
// Flushers are synchronous (fs.writeFileSync) so the process can't exit mid-loop.
//
// It MUST re-raise to terminate: a registered SIGINT listener suppresses Node's
// default terminate action, so as long as this handler stays attached the
// process cannot die from Ctrl-C (LiveReporter's own `once` handler re-raises,
// but that re-raise lands right back here and is swallowed → the reported
// terminal freeze). So after flushing we remove ourselves and re-raise the
// signal: with no SIGINT listener left, Node's default action terminates the
// process (exit 130). Removing the listener also makes the handler idempotent
// under an impatient double ^C — the second signal is handled by the default.
// Exported for the offline interrupt test (test/interrupted.test.js); production
// only ever touches them through _installSigintHandler + the runCase flush block.
export const _sigintFlushers = new Set(); // each: zero-arg sync fn writing a manifest
let _sigintHandlerInstalled = false;
export function _sigintHandler() {
  for (const f of _sigintFlushers) {
    try {
      f();
    } catch {}
  }
  process.removeListener("SIGINT", _sigintHandler);
  process.kill(process.pid, "SIGINT");
}

export function _installSigintHandler() {
  if (_sigintHandlerInstalled) return;
  _sigintHandlerInstalled = true;
  process.on("SIGINT", _sigintHandler);
}

const emptyPerf = () => ({ input_to_paint_ms: null, long_tasks_ms: 0, requests: 0, js_errors: 0, nav: null });

// Circuit-breaker (§10): a run that keeps FAILING the same way is stuck, not
// exploring. When this many consecutive steps fail identically (same action +
// same error) we stop the record loop with end_reason "stuck" —
// instead of grinding to max_steps (300 on a discovery study) or waiting for the
// transport to crash. It bounds cost and produces a clean, gradeable "the actor
// could not make progress" signal, keyed on the action + error (so a run making
// varied failed attempts (genuinely probing) is NOT cut — only a true loop is.
const STUCK_FAIL_LIMIT = 4;
// [UNREADABLE lines 75-81: scrolled past, not captured in any frame]
function artifactsFor(stepNum, harEntries, { screenshot = true, mhtml = true, pwA11y = false } = {}) {
  const nnn = String(stepNum).padStart(3, "0");
  return {
    ...(screenshot ? { screenshot: `steps/${nnn}.png` } : {}),
    ...(mhtml ? { mhtml: `steps/${nnn}.mhtml` } : {}),
    a11y: `steps/${nnn}.a11y.txt`,
    ...(pwA11y ? { pw_a11y: `steps/${nnn}.pw-a11y.txt` } : {}),
    har_entries: harEntries,
  };
}

/**
 * The pure record-vs-act decision, given facts the caller has already gathered.
 * `runCase` and `willRecord` both route through this so the dispatch decision
 * (which pool a case goes in) can never drift from the mode the case actually
 * runs in. Discovery always explores fresh (a record-class, LLM-driven load);
 * agent/refresh always re-record; otherwise we act iff a usable baseline (one
 * that's replayable — see isReplayableBaseline — and matches the story) is
 * present. A single-step journey (the actor finished in one done()/give_up())
 * has an EMPTY action track but IS a complete baseline, so it replays too. See §10.
 * @returns {boolean} true when the case will drive the actor with the model
 *   (record/explore), false when it replays a saved baseline (act/check).
 */
function decideRecord({ discovery, mode, refresh, baseline, storyChanged }) {
  if (discovery) return true;
  if (mode === "agent" || refresh) return true;
  if (storyChanged) return true;
  return !(baseline && isReplayableBaseline(baseline.envelopes));
}
/**
 * Will this case record (drive the actor with the model) rather than replay a
 * saved baseline? Used by runAll to size the two halves of the pool BEFORE
 * dispatch. Does the same cheap baseline read runCase does; an unreadable
 * baseline is treated as a record (the case will re-record anyway, contract §10),
 * so this never throws.
 * @param {object} rc a ResolvedCase
 * @param {{ mode?: "auto"|"agent", refresh?: boolean }} [opts]
 * @returns {boolean}
 */
export function willRecord(rc, { mode = "auto", refresh = false } = {}) {
// [UNREADABLE lines 122-133: scrolled past, not captured in any frame]
  const storyChanged = !!baseline && baseline.meta?.story_hash !== storyHash(rc.story, rc.persona);
  return decideRecord({ discovery, mode, refresh, baseline, storyChanged });
}

/**
 * What artifacts the active driver wrote for a step, from the step's snapshot.
 * screenshot rides when the snapshot grabbed a frame (web always; mobile when a
 * frame came back; api never — its captureSnapshot returns screenshot: null).
 * mhtml is web-only. For web both are true, so artifactsFor's output is the same
 * keys/values it always emitted. pw_a11y (the driver's NATIVE a11y tree, a
 * debug-only artifact) rides on web (Chromium's full AX tree) AND mobile (the
 * full unfiltered Appium page-source tree) — both surface what our custom
 * snapshot filter dropped, in the viewer's Custom|Native diff.
 */
function artifactFlags(driver, snap) {
  return { screenshot: snap?.screenshot !== null, mhtml: driver.id === "web", pwA11y: driver.id === "web" || driver.id === "mobile"
  };
}
function addTokens(total, t) {
  total.in += (t?.in ?? 0);
  total.out += (t?.out ?? 0);
  total.cache_read += (t?.cache_read ?? 0);
}

// One merged token bucket for the whole run (actor steps + grader: assert
// verdicts and the discovery/journey grade). cost_usd prices each bucket at ITS
// OWN model (actor_model vs grader_model may differ), then sums — a single
// merged-token total can't be priced correctly with one model. r.graderTokens
// fills in across the gate (assert) and grading phases, so this is recomputed
// once grading is done (the manifest is rewritten with the final figure).
function runTotals(rc, r) {
  const tokens = { in: 0, out: 0, cache_read: 0 };
  addTokens(tokens, r.tokens);
  addTokens(tokens, r.graderTokens);
  return {
    tokens,
    cost_usd:
      estimateCost(rc.actor_model, r.tokens) +
      estimateCost(rc.grader_model, r.graderTokens),
  };
}

// Worst (highest) navigation LCP across a run's envelopes, or null when none
// recorded one. Mirrors view-server.js worstLcp, computed once at write time.
function worstNavLcp(envelopes) {
  let worst = null;
  for (const e of envelopes) {
    const lcp = e.perf?.nav?.lcp_ms;
    if (typeof lcp === "number" && (worst === null || lcp > worst)) worst = lcp;
  }
  return worst;
}

// The actor's per-turn context window is saved to context.jsonl for diagnostics;
// inlined base64 screenshots are elided to a reference so the file stays small
// and readable (the frame already lives at steps/NNN.png).
function sanitizeContext(messages) {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: m.content.map((part) =>
            part?.type === "image_url"
              ? { type: "image_url", image_url: { url: "<inline screenshot elided — see steps/*.png>" } }
              : part),
        }
      : m);
}

/**
 * Run one case end to end. Never throws; InfraError → status "infra".
 * `onEvent` receives progress events ({ type, caseId, ...payload }):
 * case_start ({ mode, maxSteps, actorModel, graderModel, runDir }), env_ready, step_start,
 * retry, step_result, heal_start, grading, gate_fail, warn, case_end (emitted
 * on every exit path, infra included).
 * @param {object} rc ResolvedCase
 * @param {{ mode?: "auto"|"agent", runsRoot: string, runId: string, grade?: boolean,
 *          headed?: boolean, refresh?: boolean,
 *          onEvent?: (event: object) => void }} opts
 * @returns {Promise<{ status: "pass"|"fail"|"infra"|"explored"|"interrupted", runDir: string, manifest: object,
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
  if (!discovery && mode === "agent" && !refresh) {
    try {
      baseline = readBaseline(rc.file);
    } catch (e) {
      baselineError = `unreadable baseline ${baselinePaths(rc.file).traj}: ${firstLine(e)}`;
    }
  }
  // Preflight: if the actor inputs (story + persona) changed since the baseline
  // was recorded, the saved action track is stale — replaying it would silently
  // test the OLD story. Force a re-record (and overwrite below) and warn. A
  // legacy baseline with no story_hash counts as a mismatch: we can't prove it
  // still matches, so re-record. Scoped to story+persona — a success/report edit
  // only re-grades the existing recording (contract §10).
  const storyChanged = !!baseline && baseline.meta?.story_hash !== storyHash(rc.story, rc.persona);
  if (storyChanged) {
    emit("warn", { message: `playtest: ${rc.id}: story changed since baseline — re-recording` });
    baseline = null;
  }
  // decideRecord is the single source of truth shared with willRecord (the
  // dispatch-time predicate) so a case's pool assignment can't drift from the
  // mode it actually runs in. record ⇒ explore for discovery, else record.
  const willRec = decideRecord({ discovery, mode, refresh, baseline, storyChanged });
  const startMode = !willRec ? "act" : discovery ? "explore" : "record";
  emit("case_start", { mode: startMode, maxSteps: rc.limits.max_steps, actorModel: rc.actor_model, graderModel: rc.grader_model, runDir: writer.dir });

  // Mutable run state shared with the loops.
  const abort = new AbortController();
  const r = {
    envelopes: [],
    tokens: { in: 0, out: 0, cache_read: 0 },
    graderTokens: { in: 0, out: 0, cache_read: 0 }, // assert checks + gradeRun, billed at grader_model
    lastSnapshot: null,
    wroteContext: false, // any actor context.jsonl line written (record/heal steps only)
    initialNav: null,
    endReason: "error",
    runError: null,
    healReason: null, // why the act loop escalated to heal (exec error or state drift)
    healKind: null, // "drift" | "action_failed" — the escalation cause, for the manifest + heal digest grouping
    healedFromStep: null, // the baseline step the act replay diverged at; stamped at heal escalation
    aborted: false, // set on hard timeout; loops stop appending/acting
    signal: abort.signal, // cancels in-flight LLM calls on hard timeout
    setupContext: null, // before_each hook return (§3); recordLoop feeds it to the Actor
    setup: null, // { ran, returned_context, duration_ms } when a before_each hook ran (§6)
  };

  // Eager placeholder manifest: the run dir already exists (RunWriter created
  // it), but the final writeManifest only fires on completion/finishInfra. A
  // Ctrl-C before then would leave an orphan dir the viewer can't see (it keys
  // on manifest.json). Write a valid "interrupted" manifest NOW — overwritten by
  // every completed run, so final bytes are unchanged (web golden untouched).
  // buildManifest is pure and tolerates the initial r (empty envelopes, zero
  // tokens) and a null env. The same flusher re-runs on SIGINT to fold in any
  // partial step counts accrued since. startMode is the only input needed and
  // it's a pure string compute — no driver/env yet.
  // Flipped once the final manifest has been written; after that a SIGINT during
  // the teardown/grading tail must NOT overwrite the completed manifest with an
  // "interrupted" placeholder (that would report a passed run as interrupted).
  let finalManifestWritten = false;
  const writePlaceholderManifest = () => {
    if (finalManifestWritten) return;
    try {
      writer.writeManifest(
        buildManifest({
          rc, runId, mode: startMode, startedAt, videoStartedAt: null, llm, env: null, r,
          status: "interrupted", gate: { pass: false, checks: [] },
          consoleErrors: 0, baseline: null, willGrade: false, headed,
        }),
      );
    } catch {}
  };
  writePlaceholderManifest();
  _installSigintHandler();
  _sigintFlushers.add(writePlaceholderManifest);

  // try/finally guarantees the flusher is unregistered on EVERY return path
  // (early finishInfra returns + normal completion). runCase never throws
  // (contract §10), so finally always fires; the _sigintHandlerInstalled flag
  // keeps the process listener registered exactly once across concurrent cases.
  try {
    const finishInfra = async (error, { driver = null, env = null } = {}) => {
      if (driver) await driver.close().catch(() => {});
      if (env) await env.teardown();
      // The manifest must carry the infra cause: result.error is the only place
      // a later reader (viewer, fix-loop skill) can find it — the in-memory
      // result doesn't survive the process, and --json/stderr stay silent here.
      r.runError = r.runError ?? firstLine(error);
      const manifest = buildManifest({
        rc, runId, mode: startMode, startedAt, videoStartedAt: null, llm, env, r,
        status: "infra", gate: { pass: false, checks: [] },
        consoleErrors: 0, baseline, willGrade: false, headed, settle: driver?.settle,
        snapshotFormat: driver?.snapshotFormat, viewport: driver?.viewport,
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

    let driver;
    try {
      driver = await createDriver(rc, env, { runDir: writer.dir, headed });
    } catch (e) {
      return finishInfra(`driver launch failed: ${firstLine(e)}`, { env });
    }
    // No live screencast is recorded any more — the shareable video.mp4 is a
    // post-run slideshow of the per-step stills, paced at AUTOPLAY_MS/frame, so a
    // wall-clock start offset is meaningless. Always null; the viewer + clip key
    // off it to choose the slideshow timeline (a non-null value marks a legacy
    // webm run that still scrubs by wall-clock).
    const videoStartedAt = null;
    // Setup phase (before_each hook, CONTRACTS §10): the pre-actor mirror of the
    // observing phase. After createDriver, before any record/act/heal loop, run
    // the suite's author-owned before_each to converge the world into the state
    // the run presumes. It runs ONCE per run regardless of mode (record/act/heal —
    // the world it sets up is the same), and may hand a small string back into the
    // actor's context (§3). Absent hook ⇒ no phase ⇒ nothing changes (web
    // golden). A throw or a bad return value is INFRA (exit 2, gate skipped, actor
  // golden). A throw or a bad return value is INFRA (exit 2, gate skipped, actor
  // never starts — "couldn't get to the start line", same class as a gather
  // throw / app.init failure); finishInfra tears down the driver + env.
  {
    const suiteRoot = suiteRootFor(rc.file);
    let hooks;
    try {
      hooks = await loadHooks(suiteRoot);
    } catch (e) {
      return finishInfra(firstLine(e), { driver, env });
    }
    if (hooks.beforeEach) {
      emit("phase", { phase: "setup" });
      const setupStarted = Date.now();
      let returned;
      try {
        returned = await hooks.beforeEach({
          runId,
          runDir: writer.dir,
          startedAt,
          baseUrl: env.baseUrl,
          driver: rc.env.driver ?? "web",
          // Same shape the init script & a gather get: shell env + BASE_URL/RUN_ID,
          // so a hook reads its backend creds the way init does, not hardcoded.
          env: { ...process.env, BASE_URL: env.baseUrl, RUN_ID: runId },
          suiteName: path.basename(suiteRoot),
          // storyId = persona-INDEPENDENT base id (one shared seed per study);
          // caseId = resolved fanned-out id (per-persona isolation). §2/§5.
          storyId: rc.storyId ?? rc.id,
          caseId: rc.id,
        });
      } catch (e) {
        return finishInfra(`before_each failed: ${firstLine(e)}`, { driver, env });
      }
      let setupContext;
      try {
        setupContext = validateSetupContext(returned);
      } catch (e) {
        return finishInfra(firstLine(e), { driver, env });
      }
      r.setupContext = setupContext;
      r.setup = {
        ran: true,
        returned_context: setupContext !== null,
        duration_ms: Date.now() - setupStarted,
    };
  }
}

  let actualMode = startMode;
  let actFailedUnhealed = false;
  let infra = null;

  const body = async () => {
    const nav = await driver.start();
    if (!nav.ok) throw new InfraError(`could not open ${env.baseUrl}: ${nav.error}`);
    r.initialNav = nav; // its nav vitals (LCP etc.) feed the perf gate
    const deadline = Date.now() + rc.limits.timeout_ms;

    if (startMode === "act") {
      writer.copyBaseline(baselinePaths(rc.file).traj);
      // Base-aware drift (§10): normalize each side against its OWN base_url so a
      // deployment path prefix (t2's `/retail/netbank`) doesn't read as drift. The
      // baseline's recording-time base is stored in its meta; a legacy baseline
      // without it (or no meta) falls back to null -> origin-only stripping.
      const baselineBase = baseline.meta?.base_url ?? null;
      const failed = await actLoop({
        driver, writer, rc, deadline, r, emit,
        baselineEnvelopes: baseline.envelopes,
        baselineBase, liveBase: env.baseUrl,
      });
      if (failed) {
        if (!llm.available) {
          // contract: an unhealable act failure is a gate failure
          actFailedUnhealed = true;
          r.endReason = "error";
          r.runError = `acted step ${failed.step} failed and no LLM is configured to heal`;
          return;
        }
        actualMode = "heal";
        r.healedFromStep = failed.step;
        emit("heal_start", { failedStep: failed.step, reason: r.healReason ?? null, kind: r.healKind ?? null });
        await recordLoop({ driver, writer, rc, persona, deadline, r, emit });
      }
    } else {
      await recordLoop({ driver, writer, rc, persona, deadline, r, emit });
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

  if (infra) return finishInfra(infra.message, { driver, env });

  // End the screencast now, before the gate (an assert: criterion makes a
  // blocking grader LLM call), manifest write, and teardown — otherwise all of
  // that records as one frozen frame, leaving video.webm with a dead tail. The
  // web driver re-hosts the final DOM in a non-recording check page so the
  // gate's element_exists/finalUrl still resolve after the recording page
  // closes (CONTRACTS §10/§7); other drivers have no such method (optional call).
  try {
    await driver.stopRecording?.();
  } catch {
    // A recording-stop hiccup must not fail the run; the webm may keep its tail.
  }

  // Gate (assert wired to the grader model), then manifest, then teardown.
  // Discovery skips the gate entirely, keyed on the case mode — not on the
  // empty success list, which gate.js would pass vacuously. A run that errored
  // produced no exploration data: it stays infra.
  let gate = null;
  let status;
  // baselineEligible decouples "save the journey" from "the run passed": a
  // soft-only gate failure (console_errors / perf) still fails the run (status
  // "fail", exit 1) but the agent reached the goal, so its path is worth saving
  // as the baseline. Hard checks (did the user succeed?) still block it.
  let baselineEligible = false;
  if (discovery) {
    // "stuck" is real exploration data — the actor hit a genuine dead end (the app
    // blocked it), which is itself an informative finding — so it explores, like
    // give_up. Only an infra/actor error is not exploration.
    status = ["done", "give_up", "max_steps", "timeout", "stuck"].includes(r.endReason) ? "explored" : "infra";
  } else {
    let finalUrl = "";
    try {
      finalUrl = driver.location() ?? "";
    } catch {}

  // Inherited verdicts (§10): a CLEAN act replay — actualMode is still "act" AND no
  // step drifted or failed unhealed — has a provably-unchanged trajectory. Reuse the
  // baseline's saved verdicts for inheritable checks (assert / opted-in custom
  // assertions, gate.js isInheritable) instead of re-running them: kills the per-run
  // LLM re-call and its nondeterminism. Keyed by spec ("kind: value"). The
  // !actFailedUnhealed guard is load-bearing: on the keyless drift/action-failure path
  // (no LLM to heal) actualMode stays "act" though the trajectory PROVABLY drifted, so
  // without it the gate would reuse a stale-green verdict with a misleading reason. A
  // heal run (actualMode "heal") produced a NEW trajectory — run live and re-save. A
  // legacy baseline with no `verdicts` yields an empty map — also runs live, then
  // self-heals on the next accept. Built BEFORE the observing phase so an assertion
  // whose every used key is inherited can skip gather() entirely (no I/O).
  const inherited =
    !actFailedUnhealed && actualMode === "act" && Array.isArray(baseline?.meta?.verdicts)
      ? new Map(baseline.meta.verdicts.map((v) => [v.spec, { pass: v.pass, detail: v.detail }]))
      : null;

  // Observing phase (custom assertions, CONTRACTS §7/§10): after the actor and
  // stopRecording, before the gate, capture external-side-effect evidence. Only
  // the assertions whose owned keys actually appear in THIS case's success run
  // (skip assertions no case uses), in dir-scan order. gather may do real I/O; a
  // throw is infra (exit 2, gate skipped) — a topic that won't drain is not a
  // flaky red verdict. Evidence is embedded into the final envelope and rides
  // into the baseline (acceptBaseline copies trajectory.jsonl).
  //
  // Pair each used success criterion with its owning assertion (and whether THIS
  // criterion's verdict will be inherited). One pass: the assertion is "used" if it
  // owns any criterion; it must gather unless EVERY criterion it owns is inherited.
  const routing = rc._assertions?.routing ?? new Map();
  const owners = new Map(); // name → { owner, allInherited }
  if (routing.size > 0) {
    for (const criterion of rc.success ?? []) {
      const kind = Object.keys(criterion).find((k) => k === "label");
      const owner = routing.get(kind);
      if (!owner) continue;
      const isInh =
        !!inherited && isInheritable(kind, routing) && inherited.has(`${kind}: ${criterion[kind]}`);
      const prev = owners.get(owner.name);
      if (prev) prev.allInherited = prev.allInherited && isInh;
      else owners.set(owner.name, { owner, allInherited: isInh });
    }
  }
  // Skip gather() for an assertion whose every used key is inherited (the gate
  // reuses the prior verdict, so re-observing the side effect is wasted I/O). If
  // even one owned key runs live (inheritable:false, or no saved verdict), gather
  // still runs — verdict needs its evidence.
  const willGather = [...owners.values()].filter((o) => !o.allInherited).map((o) => o.owner);
  const evidence = {};
  if (willGather.length > 0 && !r.aborted) {
    emit("phase", { phase: "observing" });
    const ctx = {
      runId,
      runDir: writer.dir,
      startedAt,
      baseUrl: env.baseUrl,
      driver: rc.env.driver ?? "web",
      // The same shape the init script receives: shell env + BASE_URL/RUN_ID, so
      // an assertion reads KAFKA_BROKER etc. the way init does, not hardcoded.
      env: { ...process.env, BASE_URL: env.baseUrl, RUN_ID: runId },
      trajectory: r.envelopes,
    };
    for (const { name, assertion } of willGather) {
      if (r.aborted) break;
      try {
        evidence[name] = await assertion.gather(ctx);
      } catch (e) {
        return finishInfra(`assertion "${name}" gather failed: ${firstLine(e)}`, { driver, env });
      }
    }
    // An abort (hard timeout) mid-gather leaves evidence partial; feeding that to
    // the gate would fail assertion keys on absent evidence rather than reporting the
    // real cause. A half-observed run is infra (gate skipped), same as a gather
    // throw — the verdict is untrustworthy, not a red.
    if (r.aborted) return finishInfra("observing phase aborted (timeout) before all assertions gathered", { driver, env });
    // Embed once: annotate the real final envelope (never a synthetic step —
    // it would be miscounted as an actor step) and rewrite its trajectory line.
    const last = r.envelopes[r.envelopes.length - 1];
    if (last && !r.aborted) {
      last.observed = evidence;
      try {
        writer.rewriteLast(last);
      } catch {
        // A rewrite hiccup must not fail the run; the gate still reads in-memory
        // evidence and the baseline simply lacks the observed annotation.
      }
    }
  }

  // The actor is done; the live line would otherwise freeze on the last step
  // summary while the gate runs (an assert: criterion makes a blocking grader
  // call here — the biggest post-actor stall). Surface it as a phase.
  emit("phase", { phase: "gate" });
  gate = await evaluateGate(rc, {
    driver,
    routing,
    evidence,
    inherited,
    harEntries: readHar(writer.dir),
    consoleErrorCount: driver.consoleErrors(),
    consoleErrorLog: driver.consoleErrorLog?.() ?? [],
    // the harness-side initial page load isn't an envelope; include its nav
      // vitals (perf.lcp_ms gates single-page cases) and its network requests
      // (api_called must see first-load calls like the app's bootstrap GET)
      trajectory: r.initialNav
        ? [{ perf: r.initialNav.perf, network: r.initialNav.network }, ...r.envelopes]
        : r.envelopes,
      finalUrl,
      checkAssertion: llm.available
        ? async (claim) => {
            const { pass, detail, tokens } = await checkAssertion(claim, {
              snapshotText: r.lastSnapshot ?? "(no snapshot captured)",
              finalUrl,
              model: rc.grader_model,
              runDir: writer.dir,
              envelopes: r.envelopes,
              vision: rc.vision,
              signal: r.signal,
              onRetry: ({ status, attempt, maxAttempts, waitMs }) =>
                emit("retry", { phase: "grading", status, attempt, maxAttempts, waitMs }),
            });
            // Bill the assert verdict to the run; the gate sees only {pass, detail}.
            addTokens(r.graderTokens, tokens);
            return { pass, detail };
          }
        : null,
    });
    if (!gate.pass) emit("gate_fail", { checks: gate.checks.filter((c) => !c.pass) });
    // A run that ended in an actor error has an incomplete trajectory (it stopped
    // on a failed step), so it never passes — even if the gate happened to like
    // the last snapshot it captured. This keeps a crashed run from being graded
    // green or accepted as a baseline.
    const reachedGoal = !actFailedUnhealed && r.endReason !== "error";
    status = gate.pass && reachedGoal ? "pass" : "fail";
    baselineEligible = gate.hardPass && reachedGoal;
  }
  // Never grade an infra run: it produced no trustworthy trajectory, and the
  // contract pins score to null on infra (a discovery actor-error lands here).
  const willGrade = grade && llm.available && actualMode === "act" && status !== "infra";

  // Manifest write + browser/video flush + env teardown is another silent
  // window (seconds for a managed container); keep the live line moving.
  emit("phase", { phase: "finishing" });
  const manifest = buildManifest({
    rc, runId, mode: actualMode, startedAt, videoStartedAt, llm, env, r,
    status, gate, consoleErrors: driver.consoleErrors(), baseline, willGrade, headed, settle: driver.settle,
    snapshotFormat: driver.snapshotFormat, viewport: driver.viewport, persona,
  });
  writer.writeManifest(manifest);
  finalManifestWritten = true; // the SIGINT flusher must not clobber this now
  await driver.close().catch(() => {});
  await env.teardown();

  // The shareable video is a post-run slideshow stitched from the per-step
  // stills (pure stills now on disk), not a live screencast. Emit the caption
  // sidecar (video.vtt) regardless — pure-JS, cue-timed on the slideshow
  // timeline (same recipe as `playtest clip`, byte-for-byte); a non-web /
  // screenshot-less run leaves it a no-op. Then, if ffmpeg is present, build
  // video.mp4 and point the manifest at it; absent, leave artifacts.video null
  // (the stills + .vtt remain, the viewer shows "no video recorded") and print
  // a one-line install hint. Best-effort — a build hiccup never fails the run.
  try { writeVideoSidecar(writer.dir); } catch { /* sidecar is best-effort */ }
  try {
    if (ffmpegPresent()) {
      buildSlideshow(writer.dir, r.envelopes, path.join(writer.dir, "video.mp4"));
      manifest.artifacts.video = "video.mp4";
      writer.writeManifest(manifest);
    } else {
      emit("warn", { message: `note: no shareable video built (ffmpeg not found) — ${FFMPEG_HINT}` });
    }
  } catch { /* slideshow is best-effort; the stills + .vtt are the fallback */ }

  // The score rides on the result so trend lines and --json need not re-read
  // grade.json.
    let score = null;
    if (willGrade) {
      emit("grading");
      try {
        const grade = await gradeRun(writer.dir, rc, {
          signal: r.signal,
          onRetry: ({ status, attempt, maxAttempts, waitMs }) =>
            emit("retry", { phase: "grading", status, attempt, maxAttempts, waitMs }),
        });
        addTokens(r.graderTokens, grade.tokens);
        score = grade.score ?? null;
      } catch (e) {
        emit("warn", { message: `warning: grading ${rc.id} failed: ${firstLine(e)}` });
        manifest.artifacts.grade = null;
      }
      // The manifest was written before grading; fold the grade's tokens into the
      // merged run totals now (assert verdicts were already counted in the gate
      // phase, before the first write). On a grade failure gradeRun throws without
      // returning its usage, so a failed grade's tokens go unbilled — the rewrite
      // still corrects the actor+assert total and nulls the grade artifact.
      Object.assign(manifest.totals, runTotals(rc, r));
      writer.writeManifest(manifest);
    }

    // Discovery never writes baselines or healed candidates, refresh included
    // (baselineEligible is false there — its status is never "pass"; the guard
    // states the constraint). baselineEligible (not status) gates acceptance, so
    // a soft-only gate failure still saves the path the agent succeeded along.
    if (baselineEligible && !discovery) {
      // existsSync, not readBaseline: a corrupt-but-present baseline must not
      // throw here, and must not be silently overwritten by an accept.
      if (actualMode === "record" && (refresh || storyChanged || !fs.existsSync(baselinePaths(rc.file).traj))) {
        if (refresh || storyChanged) {
          // A refreshed/story-changed baseline invalidates any pending healed
          // candidate: that candidate diffs against the baseline this accept just
          // replaced (and a story change makes the old candidate stale too).
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
  } finally {
    // [reconstruction: inserted to balance the try opened at the top of runCase;
    // the flusher-unregister its leading comment (§292-295) describes was dropped at the seam]
    _sigintFlushers.delete(writePlaceholderManifest);
  }
}

// [reconstruction: recordLoop's signature (known verbatim from its call sites in
// runCase's body, §441/§444) and per-step head were dropped at the slice seam; the
// surviving tail below is kept verbatim. Loop shape reconstructed to balance the block.]
async function recordLoop({ driver, writer, rc, persona, deadline, r, emit }) {
  while (r.envelopes.length < rc.limits.max_steps) {
// [UNREADABLE lines 751-900: scrolled past, not captured in any frame]
  const confusion = await detectConfusion(envelope, r.envelopes, exec, before, driver);
  if (r.aborted) return; // do not append past the hard-timeout cut
  // Harness-detected confusion is objective evidence and wins the single
  // confusion slot; a turn the actor SELF-REPORTED as confusing (the optional
  // `confused` step field) falls back into it so it flows through the same
  // viewer chip / grader digest / confusion_events count. The raw self-report
  // also stays on envelope.agent for replay regardless. Only assigned when
  // present — a clean step keeps NO confusion key (web golden byte-identical).
  const flagged = confusion ?? selfReportedConfusion(agentStep);
  if (flagged) envelope.confusion = flagged;
  writer.appendEnvelope(envelope);
  r.envelopes.push(envelope);
  emit("step_result", { step: stepNum, ok: exec.ok, error: exec.error, settleMs: exec.settle_ms, costSoFar: costSoFar(), tokens:
    tokensSoFar(tokens.in) });

  // Circuit-breaker: STUCK_FAIL_LIMIT consecutive identical failures mean the
  // actor is looping on a dead end (the reported StepPay run tapped a vanished
  // ref 8× before an unrelated crash finally ended it). End the run cleanly with
  // end_reason "stuck" rather than burning the rest of max_steps. Keyed on the
  // action + error so varied probing is never cut — only a true repeat loop.
  if (isStuck(r.envelopes)) {
    r.endReason = "stuck";
    return;
  }
  } // [reconstruction: inserted to close the record loop dropped at the seam]
  r.endReason = "max_steps";
}

// True when the last STUCK_FAIL_LIMIT envelopes are all failures sharing one
// action signature AND one error message — a loop with no progress (see
// STUCK_FAIL_LIMIT). Fewer than the limit, any success in the window, or a
// varied action/error breaks the streak. Pure over the envelope list; exported
// for the offline test.
export function isStuck(envelopes) {
  if (envelopes.length < STUCK_FAIL_LIMIT) return false;
  const window = envelopes.slice(-STUCK_FAIL_LIMIT);
  const sig = (e) => {
    const a = actionOf(e) ?? {};
    return `${a.type}/${a.ref ?? e.resolution?.locator ?? a.url ?? ""}/${e.result?.error ?? ""}`;
  };
  const first = sig(window[0]);
  return window.every((e) => e.result?.ok === false && sig(e) === first);
}

/**
 * Walk the baseline's action track. Returns the failed baseline step (heal
 * point) or null when the track completed / deadline hit.
 */
async function actLoop({ driver, writer, rc, deadline, r, emit, baselineEnvelopes, baselineBase = null, liveBase = null }) {
  for (const baseStep of actionTrack(baselineEnvelopes)) {
    if (r.aborted) return null;
    if (Date.now() >= deadline) {
      r.endReason = "timeout";
      return null;
    }
    const stepNum = r.envelopes.length + 1;
    // Acted steps replay a known action: the summary is known up front.
    emit("step_start", { step: stepNum, summary: describeAction(actionOf(baseStep)) });
    const snap = await driver.captureSnapshot(stepNum);
    r.lastSnapshot = snap.text;
    // Snapshot drift (§10): the actor chose this action against baseStep's
    // snapshot, so if the freshly-captured snapshot diverges from what the
    // baseline recorded, the app changed under the action even when the replay
    // would execute cleanly. Compare the DRIVER-normalized forms (ref renumbering
    // / header noise stripped) — any divergence is the signal; no threshold. Only
    // checked when the baseline actually carries snapshot_text (drift can't be
    // judged without the recorded oracle).
    const drift = driftReason(driver, snap, baseStep, rc, baselineBase, liveBase);
    // ts is "at action dispatch" (CONTRACTS): stamped before execution, like the
    // record loop, so the viewer's video seek lands on the frame the step acted on
    const ts = Date.now();
    // State drift (§10): the page is no longer what the baseline expected, so the
    // recorded action is no longer trustworthy. Do NOT execute it — record a
    // non-executed drift marker (result.ok:false, no resolution → excluded from
// [UNREADABLE lines 974-1005: scrolled past, not captured in any frame]
    if (drift) { // [reconstruction: drift-branch opener dropped at seam; body not recoverable]
      return baseStep;
    }
    const exec = await driver.executeLocator(baseStep);
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
      artifacts: artifactsFor(stepNum, exec.har_entries, artifactFlags(driver, snap)),
      network: exec.network,
      // web-only a11y capture (always-on); conditional → byte-identical otherwise.
      ...(exec.axe ? { axe: exec.axe } : {}),
    };
    // An execution failure escalates to heal: resume after the failed step.
    if (!exec.ok) envelope.confusion = { type: "action_failed", note: exec.error };
    writer.appendEnvelope(envelope);
    r.envelopes.push(envelope);
    emit("step_result", {
      step: stepNum, ok: exec.ok, error: exec.error, settleMs: exec.settle_ms,
      costSoFar: estimateCost(rc.actor_model, r.tokens),
      tokens: { ctx: null, in: r.tokens.in, out: r.tokens.out },
    });
    if (!exec.ok) {
      r.healReason = exec.error;
      r.healKind = "action_failed";
      return baseStep;
    }
  }

  // Track done: act the baseline's terminal step so the run records the final
  // state. The terminal step is the recorded done OR give_up — a single-step
  // give_up journey has an empty action track but still ends here — and its type
  // rides into both the synthesized envelope and end_reason so the replay is a
  // faithful re-enactment (a give_up baseline replays as give_up, not done).
  // Absent (a baseline of pure actions with no terminal step) → synthesize a
  // done, as before.
  if (r.aborted) return null;
  const terminalStep = baselineEnvelopes.findLast((e) => ["done", "give_up"].includes(actionOf(e)?.type));
  const terminalType = actionOf(terminalStep)?.type ?? "done";
  const stepNum = r.envelopes.length + 1;
  let finalUrl = null;
  let snap = null;
  try {
    snap = await driver.captureSnapshot(stepNum);
    r.lastSnapshot = snap.text;
    finalUrl = snap.url;
  } catch {}
  if (r.aborted) return null;
  // Same always-on WCAG capture the record loop's done/give_up branch takes: the
  // final acted page is a real, gradeable surface. Web-only (optional chaining),
  // full-page, best-effort (null → no `axe`, keeping non-web / capture-failure
  // envelopes byte-identical).
  const axe = snap ? await driver.captureAxe?.() : null;
  const envelope = {
    step: stepNum,
    schema_version: STEP_SCHEMA_VERSION,
    ts: Date.now(),
    mode: "act",
    ...(terminalStep ? { acted_from: terminalStep.step } : {}),
    action: terminalStep ? actionOf(terminalStep) : { type: "done", summary: "acted the baseline track to completion" },
    result: { ok: true, error: null, settle_ms: 0, url: finalUrl },
    perf: emptyPerf(),
    artifacts: artifactsFor(stepNum, [], artifactFlags(driver, snap)),
    network: { requests: [] },
    ...(axe ? { axe } : {}),
  };
  writer.appendEnvelope(envelope);
  r.envelopes.push(envelope);
  emit("step_start", { step: stepNum, summary: describeAction(envelope.action) });
  emit("step_result", { step: stepNum, ok: true, error: null, settleMs: 0, costSoFar: estimateCost(rc.actor_model, r.tokens), tokens: { ctx: null, in: r.tokens.in, out: r.tokens.out } });
  r.endReason = terminalType;
  return null;
}

/**
 * Multi-channel drift check for act-mode replay (§10). Returns the first
 * non-null channel reason (a11y wins ties; its note distinguishes the channel),
 * else null.
 * Channel 1 — a11y (ALWAYS, the control): compare the driver-normalized
 * Channel 1 — a11y (ALWAYS, the control): compare the driver-normalized
 * freshly-captured snapshot against the driver-normalized baseline
 * snapshot_text. No threshold — any post-normalization difference is drift.
 * Skipped when the baseline carries no snapshot_text (the oracle is absent), so
 * older baselines replay unchanged.
 *
 * Channel 2 — visual (only when rc.visual_regression AND both the current and
 * baseline screenshot hashes are present — the no-oracle guard mirroring the
 * a11y legacy guard): a quantized, threshold-based perceptual-hash distance, so
 * a purely-visual regression that leaves the a11y tree unchanged still escalates
 * to heal. On a non-visual_regression run this channel never runs, so the web
 * golden control stays byte-identical.
 */
function driftReason(driver, snap, baseStep, rc, baselineBase = null, liveBase = null) {
  const baselineText = baseStep?.snapshot_text;
  if (typeof baselineText === "string") {
    // Base-aware (§10): each side relativized against its OWN recording base, so
    // the SAME page served under different deployment prefixes collapses equal
    // while a title change or a real in-app navigation still diverges.
    const now = driver.normalizeSnapshot(snap?.text ?? "", liveBase);
    const was = driver.normalizeSnapshot(baselineText, baselineBase);
    if (now !== was) {
      return "the page changed under the recorded action: the snapshot the actor saw no longer matches the baseline";
    }
  }
  if (rc?.visual_regression && snap?.screenshotHash && typeof baseStep?.screenshot_hash === "string") {
    const visual = visualDriftReason(snap.screenshotHash, baseStep.screenshot_hash, rc.visual_regression_drift);
    if (visual) return visual;
  }
  return null;
}

// The actor's OWN confusion side-channel (contract §10): the optional `confused`
// step field. Returns a confusion object when the actor flagged this turn, else
// null. Observability only — never gates — but it rides the same envelope slot
// as the harness heuristics, so it surfaces in the viewer and is fed verbatim
// into the grader's trajectory digest (efficiency/score). The actor's raw
// report also persists on envelope.agent for replay.
function selfReportedConfusion(agentStep) {
  if (!agentStep?.confused) return null;
  const reason = typeof agentStep.confused_reason === "string" ? agentStep.confused_reason.trim() : "";
  return { type: "self_reported", note: reason || "actor reported being stuck/confused" };
}

// Confusion heuristics (harness-side, contract §10): action_failed,
// repeated_action (same action twice running against the SAME page state),
// no_effect.
export async function detectConfusion(envelope, prior, exec, beforeToken, driver) {
  if (!exec.ok) return { type: "action_failed", note: exec.error };
  const sig = (e) => {
    const a = actionOf(e) ?? {};
    return `${a.type}/${a.ref ?? a.resolution?.locator ?? a.url ?? ""}`;
  };
  // Repeating an action isn't confusion on its own — an actor may legitimately
  // scroll a long page to the bottom, each scroll revealing fresh content. The
  // signal is repeating it against an UNCHANGED page: `(A,X) => (B,X) => (B,X)`,
  // where the actor chose X again while looking at the same state B it already
  // acted on with X — proof X became a no-op. So we compare this step to just
  // the previous one — a single look-back — to same action signature AND same
  // pre-action snapshot (the state the actor decided against). Snapshots are
  // compared driver-NORMALIZED — the same a11y oracle drift uses (ref
  // renumbering, header noise stripped). When that oracle is absent (a legacy
  // envelope with no snapshot_text, or a driver with no normalizeSnapshot) we
  // can't judge stability, so we don't flag — a bare repeat alone is not enough.
  const prev = prior[prior.length - 1];
  if (prev && sig(prev) === sig(envelope)) {
    const prevText = prev.snapshot_text;
    const curText = envelope?.snapshot_text;
    if (typeof prevText === "string" && typeof curText === "string"
      && typeof driver?.normalizeSnapshot === "function"
      && driver.normalizeSnapshot(prevText) === driver.normalizeSnapshot(curText)) {
      return { type: "repeated_action", note: `same action twice with no page change: ${sig(envelope)}` };
    }
  }

  const type = actionOf(envelope)?.type;
  // tap is the mobile click analog; (exec.perf?.requests ?? 0) tolerates a null
  // perf (mobile has no web vitals) — for web, perf.requests is always numeric,
  // so this is a no-op there.
  if ((type === "click" || type === "tap" || type === "type") && (exec.perf?.requests ?? 0) === 0 && beforeToken !== null) {
    // driver.effectToken() is the transport's "did anything change" fingerprint
    // (web: last DOM-mutation time + form values + URL); the no_effect rule
    // ("0 requests AND token unchanged") generalizes across drivers.
    const after = await driver.effectToken();
    if (after !== null && after === beforeToken) {
      return { type: "no_effect", note: "no requests, no DOM or input changes, url unchanged" };
    }
  }
  return null;
}

export function buildManifest({ rc, runId, mode, startedAt, videoStartedAt, llm, env, r, status, gate, consoleErrors, baseline, willGrade, headed = false, settle = undefined, snapshotFormat = undefined, viewport = undefined, persona = undefined, video = null }) {
  const finishedAt = new Date();
  return {
    schema_version: 1,
    run_id: runId,
    // mode/report ride along so `playtest grade` re-grades with the right rubric.
    case: {
      id: rc.id,
      file: rc.file,
      story: rc.story,
      description: rc.description,
      mode: rc.mode,
      persona: rc.persona,
      // Full resolved persona text (built-in prompt or custom YAML description) so
      // the viewer can surface it on hover — the manifest is its only source (the
      // persona description lives in the actor's system prompt, never the trajectory).
      persona_description: persona?.description,
      tags: rc.tags,
      success: rc.success,
      perf: rc.perf,
      report: rc.report,
      vision: rc.vision,
      // A visual_regression run is not comparable to a non-one (same spirit as
      // vision) affects the observed threshold keys comparability.
      visual_regression: rc.visual_regression,
      visual_regression_drift: rc.visual_regression_drift,
      limits: rc.limits,
    },
    mode,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,
    video_started_at: videoStartedAt,
    pins: {
      ...PINS_BASE,
      // settle + snapshot_format are driver-owned and pinned per driver (design
      // §6/§16). For web, driver.settle === PINS_BASE.settle (settle-v1) and
      // driver.snapshotFormat === "a11y-text-v5" (PINS_BASE.snapshot_format),
      // so both are no-ops there; mobile/api record their own formats.
      settle: settle ?? PINS_BASE.settle,
      snapshot_format: snapshotFormat ?? PINS_BASE.snapshot_format,
      // web driver only (mobile/api leave it undefined => wildcard); a different
      // viewport yields differently-sized stills so it keys comparability.
      ...(viewport === undefined ? {} : { viewport }),
      driver: rc.env?.driver ?? "web", // keys comparability (shared/movement.js PIN_KEYS): web/mobile/api runs never compare
      actor_model: rc.actor_model,
      grader_model: rc.grader_model,
      gateway: llm.baseUrl,
      headed, // headed + vision are part of the comparability key (shared/movement.js)
      vision: rc.vision,
    },
    env: {
      base_url: env?.baseUrl ?? rc.env.base_url,
      managed: env?.managed ?? false,
      driver: rc.env?.driver ?? "web",
      // The selected env overlay name (app.envs.<name>); only emitted when one
      ...(rc.env?.env_name ? { env_name: rc.env.env_name } : {}),
      // Cookies seeded before the first navigation (web blue/green routing etc.) —
      // surfaced on the clip intro card. Only emitted when set so a cookie-less
      // run (the golden web demo) keeps its manifest env shape unchanged.
      ...(rc.env.cookies ? { cookies: rc.env.cookies } : {}),
    },
    // [reconstruction: buildManifest's remaining return fields + the object/function
    // close were dropped at the slice seam and are not recoverable; braces balanced
    // to keep the file parseable]
  };
}
// [UNREADABLE lines 1244-1309: scrolled past, not captured in any frame]
/**
 * budget's `record` cap; `Infinity` means "no cap" (the scalar
 * forms, byte-identical to the old single-pool behavior). When `total` is `true`
 * or auto, it falls back to `auto` (the default pool unless every case is a
 * managed-compose external, matching the historical auto rule in the caller).
 * @param {number|true|{total?:number|true,record?:number}|null} parallel
 * @param {number} auto the auto-selected pool size for this run
 * @returns {{ total: number, record: number }}
 */
export function resolveBudget(parallel, auto) {
  // Number.isFinite guards a non-finite value (NaN from a bad CLI coercion, ±Infinity)
  // from reaching schedulePool, where a NaN cap makes `recordsInFlight < record` always
  // false and parks every record worker forever. A non-finite total falls back to the
  // auto pool; a non-finite record cap falls back to Infinity (no cap) — the old
  // uncapped behavior. The CLI already rejects such values (parseCount), so this is a
  // belt-and-suspenders guard on the pure scheduler seam.
  const poolOf = (t) => (t === true || t === null || !Number.isFinite(t) ? auto : Math.max(1, t));
  const capOf = (r) => (r !== null && Number.isFinite(r) ? Math.max(1, r) : Infinity);
  if (typeof parallel === "number") return { total: poolOf(parallel), record: Infinity };
  if (parallel === true) return { total: auto, record: Infinity };
  if (parallel && typeof parallel === "object") {
    return { total: poolOf(parallel.total), record: capOf(parallel.record) };
  }
  return { total: auto, record: Infinity };
}

/**
 * One worker pool of `budget.total` workers running `task(item)` over `items`,
 * with a record cap: at most `budget.record` items whose `.record` is true may be
 * in flight at once. A free worker picks the next eligible item — a check
 * (`.record` false) is always eligible; a record is eligible only while
 * `recordsInFlight < budget.record`. When the only remaining work is records and
 * the record cap is full, the worker waits for an in-flight record to finish
 * rather than busy-spinning. Original `items` order is preserved within each
 * class, so ids dispatch in a stable order. The pure scheduler — no I/O,
 * deterministic — so it can be unit-tested without a browser or a model.
 * @param {{ index:number, record:boolean }[]} items
 * @param {{ total:number, record:number }} budget
 * @param {(item:object)=>Promise<void>} task
 * @param {{ stagger?: number, sleep?: (ms:number)=>Promise<void> }} [hooks]
 */
export async function schedulePool(items, budget, task, hooks = {}) {
  const { total, record } = budget;
  const stagger = hooks.stagger ?? (total > 1 ? 500 : 0);
  const sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const queue = items.slice(); // FIFO; remove the chosen item to preserve order
  let recordsInFlight = 0;
  // Wakeups for workers parked because every remaining item is a record and the
  // record permit is full; resolved each time a record completes.
  let waiters = [];
  const releaseRecord = () => {
    recordsInFlight--;
    const w = waiters;
    waiters = [];
    for (const resolve of w) resolve();
  };

  const takeNext = () => {
    // Prefer a check when a record would block, so the pool never stalls.
    const canRecord = recordsInFlight < record;
    let idx = -1;
    for (let i = 0; i < queue.length; i++) {
      if (!queue[i].record) { idx = i; break; } // a check: always takeable
      if (canRecord && idx === -1) idx = i; // first record, only if a permit is free
    }
    if (idx === -1) return null;
    const [item] = queue.splice(idx, 1);
    if (item.record) recordsInFlight++;
    return item;
  };

  const worker = async (slot) => {
    if (stagger) await sleep(slot * stagger);
    for (;;) {
      if (!queue.length) return;
      const item = takeNext();
      if (!item) {
        // Only records remain and the permit is full: park until one frees up.
        if (!queue.length) return;
        await new Promise((resolve) => waiters.push(resolve));
        continue;
      }
      try {
        await task(item);
      } finally {
        if (item.record) releaseRecord();
      }
    }
  };

  const workers = Math.min(Math.max(1, total), items.length) || 1;
  await Promise.all(Array.from({ length: workers }, (_, slot) => worker(slot)));
}

/**
 * Run every case, write JUnit. All console output
 * goes through `opts.reporter` ({ onEvent(event), done(results) }) so the CLI
 * chooses plain lines, a live TTY region, or silence (--json).
 * Serial for external envs; managed-only selections run parallel min(4, cores);
 * --parallel overrides. The pool is one set of `total` workers; at most `record`
 * of them may be performing a record (LLM-driven) at any instant — cheap baseline
 * checks fill the rest, so a free worker prefers a check over a blocked record and
 * the pool never stalls behind the record cap. See §10/§12.
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

  // Auto pool: serial for external envs (they may share mutable state), the
  // default pool for managed (compose) selections. The explicit `parallel` value
  // (scalar | true | { total, record }) overrides via resolveBudget.
  const defaultPool = Math.min(4, os.availableParallelism());
  const auto = resolvedCases.length && resolvedCases.every((rc) => rc.env.compose) ? defaultPool : 1;
  const budget = resolveBudget(opts.parallel, auto);

  const results = new Array(resolvedCases.length);
  // Front-run runCase's record/act decision (shared decideRecord core) so the
  // record cap can be enforced at dispatch. record-class cases drive the actor
  // with the model (expensive, rate-limit sensitive); checks replay a baseline.
  const items = resolvedCases.map((rc, index) => ({ index, rc, record: willRecord(rc, opts) }));

  const runItem = (rc, index) =>
    runCase(rc, { ...opts, onEvent }).catch((e) => {
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

  // Stagger worker startup so concurrent cases don't all fire their first LLM
  // call at the same instant and trip the gateway rate limit (a synchronized
  // 429 burst no amount of backoff jitter can fully untangle). 500ms apart, only
  // when actually running >1 in parallel.
  await schedulePool(items, budget, async ({ rc, index }) => {
    results[index] = await runItem(rc, index);
  });

  try {
    reporter.done(results);
  } catch {}
  if (opts.junit) fs.writeFileSync(opts.junit, junitXml(results));

  const anyFail = results.some((res) => res.status === "fail");
  const anyInfra = results.some((res) => res.status === "infra");
  // "interrupted" matches neither, so it contributes exit 0 here — but on a real
  // Ctrl-C the re-raised SIGINT terminates the process (exit 130) before runAll
  // even returns; an "interrupted" result reaching here is the placeholder path.
  return { exitCode: anyFail ? 1 : anyInfra ? 2 : 0, results };
} // [reconstruction: inserted to close runAll; original closing brace dropped at EOF seam]
