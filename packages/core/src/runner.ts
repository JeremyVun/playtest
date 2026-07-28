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
  snapshotFormatFor,
  storyHash,
  suiteRootFor,
} from "./trajectory.ts";
import { approvedFingerprint, describeFindings, scanRun } from "./baseline-scan.ts";
import { collectSecretRefNames } from "./secrets.ts";
import { statusesEquivalent } from "./match.ts";
import { loadHooks, validateSetupContext } from "./hooks.ts";
import { createDriver } from "./driver.ts";
import { PerfSidecar } from "./perf.ts";
import { visualDriftReason } from "./drivers/web.ts";
import { Actor, loadPersona, describeAction } from "./actor.ts";
import { evaluateGate, isInheritable } from "./gate.ts";
import { acceptHeal, classifyHealFailure } from "./heal.ts";
import { writeDriftReport } from "./drift-report.ts";
import { gradeRun, checkAssertion } from "./grader.ts";
import { llmConfig, estimateCost } from "./llm.ts";
import { prepareEnv, InfraError } from "./env.ts";
import { junitXml } from "./report.ts";
import { writeVideoSidecar, ffmpegPresent, buildSlideshow, FFMPEG_HINT } from "./clip.ts";

type DynamicValue = any; // SAFETY: runner coordinates driver-specific envelopes, hooks, manifests, and model payloads

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
// Exported for the offline interrupt test; production
// only ever touches them through _installSigintHandler + the runCase flush block.
export const _sigintFlushers: Set<() => void> = new Set(); // each: zero-arg sync fn writing a manifest
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
function baseEnvelope(stepNum: number, { ts = Date.now(), ...extras }: DynamicValue = {}): DynamicValue {
  return { step: stepNum, schema_version: STEP_SCHEMA_VERSION, ts, ...extras };
}

// Circuit breaker (docs/contracts/engine.md#record-and-explore): a run that
// keeps failing the same way is stuck, not
// exploring. When this many consecutive steps fail identically (same action +
// same error) we stop the record loop with end_reason "stuck" —
// instead of grinding to max_steps (300 on a discovery study) or waiting for the
// transport to crash. It bounds cost and produces a clean, gradeable "the actor
// could not make progress" signal, keyed on the action + error (so a run making
// varied failed attempts (genuinely probing) is NOT cut — only a true loop is.
const STUCK_FAIL_LIMIT = 4;

function artifactsFor(stepNum: number, harEntries: DynamicValue, { screenshot = true, mhtml = true, pwA11y = false }: DynamicValue = {}) {
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
 * has an empty action track but is a complete baseline, so it replays too.
 * See docs/contracts/engine.md#run-lifecycle.
 * @returns {boolean} true when the case will drive the actor with the model
 *   (record/explore), false when it replays a saved baseline (act/check).
 */
function decideRecord({ discovery, mode, refresh, baseline, storyChanged, formatChanged = false }: DynamicValue) {
  if (discovery) return true;
  if (mode === "agent" || refresh) return true;
  if (storyChanged) return true;
  if (formatChanged) return true;
  return !(baseline && isReplayableBaseline(baseline.envelopes));
}

// The baseline was serialized under a different snapshot format than the one
// this run's driver will emit: every page would read as drift even when the app
// is unchanged (the incomparability is ours, not the app's), so the baseline is
// unreadable and must be re-recorded. A baseline with no recorded format (or no
// meta) is a wildcard and replays as always — the missing-pin rule
// (docs/contracts/artifacts.md#compatibility-rules).
function snapshotFormatChanged(baseline: DynamicValue, rc: DynamicValue) {
  const recorded = baseline?.meta?.pins?.snapshot_format;
  return !!baseline && typeof recorded === "string" && recorded !== snapshotFormatFor(rc.env?.driver ?? "web");
}
/**
 * Will this case record (drive the actor with the model) rather than replay a
 * saved baseline? Used by runAll to size the two halves of the pool BEFORE
 * dispatch. Does the same cheap baseline read runCase does; an unreadable
 * baseline is treated as a record (the case will re-record anyway; see
 * docs/contracts/engine.md#run-lifecycle),
 * so this never throws.
 * @param {object} rc a ResolvedCase
 * @param {{ mode?: "auto"|"agent", refresh?: boolean }} [opts]
 * @returns {boolean}
 */
export function willRecord(rc: DynamicValue, { mode = "auto", refresh = false }: DynamicValue = {}) {
  const discovery = rc.mode === "discovery";
  let baseline: DynamicValue = null;
  if (!discovery && mode !== "agent" && !refresh) {
    try {
      baseline = readBaseline(rc.file);
    } catch {
      return true;
    }
  }
  const storyChanged = !!baseline && baseline.meta?.story_hash !== storyHash(rc.story, rc.persona);
  const formatChanged = snapshotFormatChanged(baseline, rc);
  return decideRecord({ discovery, mode, refresh, baseline, storyChanged, formatChanged });
}

/**
 * What artifacts the active driver wrote for a step, from the step's snapshot.
 * screenshot rides when the snapshot grabbed a frame (web always; mobile when a
 * frame came back; api never — its captureSnapshot returns screenshot: null).
 * mhtml is web-only. pw_a11y (the driver's NATIVE a11y tree, a debug-only
 * artifact) rides on web (Chromium's full AX tree) AND mobile (the full
 * unfiltered Appium page-source tree) — both surface what our custom snapshot
 * filter dropped, in the viewer's Custom|Native diff.
 *
 * Both are also DEBUG-PROFILE artifacts
 * (docs/contracts/artifacts.md#artifact-profiles), so the flags read the
 * profile off the DRIVER rather than off the case: the object that decided not
 * to capture a file is the same object that tells the envelope not to advertise
 * it, which is what keeps "no envelope names a file that is not on disk" true
 * by construction. A driver that predates the profile reads as "debug".
 */
function artifactFlags(driver: DynamicValue, snap: DynamicValue) {
  const debug = (driver.artifactProfile ?? "debug") === "debug";
  return {
    screenshot: snap?.screenshot !== null,
    mhtml: driver.id === "web" && debug,
    pwA11y: (driver.id === "web" || driver.id === "mobile") && debug,
  };
}
function addTokens(total: DynamicValue, t: DynamicValue) {
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
function runTotals(rc: DynamicValue, r: DynamicValue): DynamicValue {
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
function worstNavLcp(envelopes: DynamicValue[]) {
  let worst: DynamicValue = null;
  for (const e of envelopes) {
    const lcp = e.perf?.nav?.lcp_ms;
    if (typeof lcp === "number" && (worst === null || lcp > worst)) worst = lcp;
  }
  return worst;
}

// The actor's per-turn context window is saved to context.jsonl for diagnostics;
// inlined base64 screenshots are elided to a reference so the file stays small
// and readable (the frame already lives at steps/NNN.png).
function sanitizeContext(messages: DynamicValue[]) {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: m.content.map((part: DynamicValue) =>
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
 * retry, step_result, heal_start, heal_resume, grading, gate_fail, warn, case_end (emitted
 * on every exit path, infra included).
 * @param {object} rc ResolvedCase
 * @param {{ mode?: "auto"|"agent", runsRoot: string, runId: string, grade?: boolean,
 *          headed?: boolean, refresh?: boolean,
 *          onEvent?: (event: object) => void }} opts
 * @returns {Promise<{ status: "pass"|"fail"|"infra"|"explored"|"interrupted", runDir: string, manifest: object,
 *   score: number|null, error?: string }>} score is the grade when this run graded
 */
export async function runCase(rc: DynamicValue, opts: DynamicValue): Promise<DynamicValue> {
  // driverFactory is a test seam (docs/contracts/engine.md#run-lifecycle): the
  // hermetic engine tests inject a scripted in-memory driver to exercise the
  // act/heal loop without a browser. Production callers never pass it.
  // envFactory is a second test seam alongside driverFactory: the finishing
  // tail is the one place where env.teardown() can throw, and no hermetic
  // fixture environment can be made to fail on demand. Production callers never
  // pass it.
  const { runsRoot, runId, mode = "auto", grade = true, headed = false, refresh = false, onEvent = () => {}, driverFactory = createDriver, envFactory = prepareEnv } = opts;
  // Test seam for exercising the abort cleanup without a 30-second wait.
  // Production callers omit it and retain the full grace period.
  const hardTimeoutGraceMs = opts.hardTimeoutGraceMs ?? 30000;
  // Concurrency permits handed down by schedulePool. A case
  // run on its own — `playtest run` of a single story, a hosted single-case
  // executor, a test — gets the identity permits and behaves exactly as before:
  // `release` is a no-op and the two semaphores run their thunk inline.
  const permits = {
    release: opts.permits?.release ?? (() => {}),
    grade: opts.permits?.grade ?? (<T,>(fn: () => T | Promise<T>) => Promise.resolve(fn())),
    cpu: opts.permits?.cpu ?? (<T,>(fn: () => T | Promise<T>) => Promise.resolve(fn())),
  };
  const writer = new RunWriter(runsRoot, runId, rc.id);
  // The run's diagnostic timing sidecar (perf.ts). Diagnostic only: it never
  // appears in a manifest, an envelope, or trajectory.jsonl, and every call is a
  // single null check when PLAYTEST_PERF_SIDECAR=0.
  const perf = writer.perf;
  const caseStartedAt = perf.now();
  const startedAt = new Date();
  const llm = llmConfig();
  // A throwing progress listener must not break the case
  // (docs/contracts/engine.md#progress-events). Every event is also appended to the run dir's
  // events.jsonl (ts-stamped) so a finished run carries its own progress record —
  // the hosted platform's case-level status replays it from the bundle
  // (docs/contracts/artifacts.md#diagnostic-and-progress-logs);
  // a write failure is swallowed like a throwing listener (events are telemetry,
  // never load-bearing for the run itself).
  const emit = (type: string, payload: DynamicValue = {}) => {
    const event = { type, caseId: rc.id, ...payload };
    try {
      writer.appendEvent(event);
    } catch {}
    try {
      onEvent(event);
    } catch {}
  };

  // A corrupt/unparseable committed baseline must fail this case as infra,
  // not throw out of runCase (docs/contracts/engine.md#error-boundary).
  // Discovery is always
  // a fresh exploration: never read a baseline, even a stray one next to the case.
  const discovery = rc.mode === "discovery";
  let baseline: DynamicValue = null;
  let baselineError: DynamicValue = null;
  if (!discovery && mode !== "agent" && !refresh) {
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
  // only re-grades the existing recording
  // (docs/contracts/artifacts.md#baseline-files).
  const storyChanged = !!baseline && baseline.meta?.story_hash !== storyHash(rc.story, rc.persona);
  if (storyChanged) {
    emit("warn", { message: `playtest: ${rc.id}: story changed since baseline — re-recording` });
    baseline = null;
  }
  // Same preflight for the serializer: a baseline recorded under a different
  // snapshot format would drift on every page (ours, not the app's) — the
  // hobart incident: a v5 baseline replayed under the v6 landmark demotion
  // healed at step 2 and could never re-anchor.
  const formatChanged = snapshotFormatChanged(baseline, rc);
  if (formatChanged) {
    const recorded = baseline.meta?.pins?.snapshot_format;
    const current = snapshotFormatFor(rc.env?.driver ?? "web");
    emit("warn", { message: `playtest: ${rc.id}: snapshot format changed since baseline (${recorded} → ${current}) — re-recording` });
    baseline = null;
  }
  // decideRecord is the single source of truth shared with willRecord (the
  // dispatch-time predicate) so a case's pool assignment can't drift from the
  // mode it actually runs in. record ⇒ explore for discovery, else record.
  const willRec = decideRecord({ discovery, mode, refresh, baseline, storyChanged, formatChanged });
  const startMode = !willRec ? "act" : discovery ? "explore" : "record";
  emit("case_start", { mode: startMode, maxSteps: rc.limits.max_steps, actorModel: rc.actor_model, graderModel: rc.grader_model, runDir: writer.dir });

  // Mutable run state shared with the loops.
  const abort = new AbortController();
  const r: DynamicValue = {
    envelopes: [],
    tokens: { in: 0, out: 0, cache_read: 0 },
    graderTokens: { in: 0, out: 0, cache_read: 0 }, // assert checks + gradeRun, billed at grader_model
    lastSnapshot: null,
    wroteContext: false, // any actor context.jsonl line written (record/heal steps only)
    initialNav: null,
    endReason: "error",
    runError: null,
    healReason: null, // why the act loop escalated to heal (exec error or state drift)
    healKind: null, // "drift" | "action_failed" — the CURRENT escalation's cause (re-anchored runs can heal more than once)
    healedFromStep: null, // the FIRST baseline step the act replay diverged at; stamped at the first heal escalation
    // First-escalation cause, frozen for manifest.heal — later heal segments
    // overwrite healKind/healReason for their own heal_start event and triage
    // evidence, but the ledger/digest group on the first divergence.
    healKindFirst: null,
    healReasonFirst: null,
    // Re-anchor provenance (docs/contracts/engine.md#act-and-heal): one
    // { from, to } per heal segment — `from` the baseline step that escalated,
    // `to` the baseline step where deterministic replay resumed (null when the
    // segment ran to the end of the journey).
    healSegments: [],
    // Recorded evidence the heal triage classifies from (docs/contracts/engine.md#act-and-heal).
    // Captured at escalation, BEFORE any patching, so the classification reads
    // the failure itself rather than whatever the heal loop went on to do.
    healEvidence: null,
    healTriage: null, // { classification, signals, ... } — classifyHealFailure's verdict
    healAccepted: null, // { ok, reason } — the deterministic acceptance decision
    driftReport: null, // the written drift-report.json, on api heals only
    aborted: false, // set on hard timeout; loops stop appending/acting
    signal: abort.signal, // cancels in-flight LLM calls on hard timeout
    setupContext: null, // before_each return; see docs/contracts/engine.md#environment-and-setup
    setup: null, // hook provenance; see docs/contracts/engine.md#environment-and-setup
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
  // (docs/contracts/engine.md#error-boundary), so finally always fires;
  // the _sigintHandlerInstalled flag
  // keeps the process listener registered exactly once across concurrent cases.
  try {
    const finishInfra = async (error: DynamicValue, { driver = null, env = null }: DynamicValue = {}) => {
      if (driver) {
        const closeAt = perf.now();
        await driver.close().catch(() => {});
        perf.span("driver_close", closeAt);
      }
      if (env) {
        const teardownAt = perf.now();
        await env.teardown();
        perf.span("env_teardown", teardownAt);
      }
      // The manifest must carry the infra cause: result.error is the only place
      // a later reader (viewer, fix-loop skill) can find it — the in-memory
      // result doesn't survive the process, and --json/stderr stay silent here.
      r.runError = r.runError ?? firstLine(error);
      const manifest = buildManifest({
        rc, runId, mode: startMode, startedAt, videoStartedAt: null, llm, env, r,
        status: "infra", gate: { pass: false, checks: [] },
        consoleErrors: 0, baseline, willGrade: false, headed, settle: driver?.settle,
        snapshotFormat: driver?.snapshotFormat, viewport: driver?.viewport,
        artifacts: driver?.artifactProfile,
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
    let persona: DynamicValue;
    try {
      persona = loadPersona(rc.persona, rc.file);
    } catch (e) {
      return finishInfra(firstLine(e));
    }

    if (startMode !== "act" && !llm.available) {
      return finishInfra(`${startMode} mode needs a model: set PLAYTEST_LLM_BASE_URL or an API key`);
    }

    let env: DynamicValue;
    try {
      env = await envFactory(rc, runId);
    } catch (e: DynamicValue) {
      return finishInfra(e.message);
    }
    emit("env_ready", { base_url: env.baseUrl, managed: env.managed });

    let driver: DynamicValue;
    try {
      driver = await driverFactory(rc, env, { runDir: writer.dir, headed, perf });
    } catch (e) {
      return finishInfra(`driver launch failed: ${firstLine(e)}`, { env });
    }
    const axeCapture = new DeferredAxeCapture(driver, writer);
    // No live screencast is recorded any more — the shareable video.mp4 is a
    // post-run slideshow of the per-step stills, paced at AUTOPLAY_MS/frame, so a
    // wall-clock start offset is meaningless. Always null; the viewer + clip key
    // off it to choose the slideshow timeline (a non-null value marks a legacy
    // webm run that still scrubs by wall-clock).
    const videoStartedAt = null;
    // Setup phase (docs/contracts/engine.md#environment-and-setup): the
    // pre-actor mirror of the
    // observing phase. After createDriver, before any record/act/heal loop, run
    // the suite's author-owned before_each to converge the world into the state
    // the run presumes. It runs ONCE per run regardless of mode (record/act/heal —
    // the world it sets up is the same), and may hand a small string back into the
    // actor's context. Absent hook ⇒ no phase ⇒ nothing changes (web
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
          // caseId = resolved fanned-out id (per-persona isolation).
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
  let infra: DynamicValue = null;

  const body = async () => {
    const nav = await driver.start();
    if (!nav.ok) throw new InfraError(`could not open ${env.baseUrl}: ${nav.error}`);
    r.initialNav = nav; // its nav vitals (LCP etc.) feed the perf gate
    const deadline = Date.now() + rc.limits.timeout_ms;

    if (startMode === "act") {
      writer.copyBaseline(baselinePaths(rc.file).traj);
      // Base-aware drift (docs/contracts/engine.md#act-and-heal): normalize
      // each side against its own base_url so a
      // deployment path prefix (t2's `/retail/netbank`) doesn't read as drift. The
      // baseline's recording-time base is stored in its meta; a legacy baseline
      // without it (or no meta) falls back to null -> origin-only stripping.
      const baselineBase = baseline.meta?.base_url ?? null;
      // Re-anchor (docs/contracts/engine.md#act-and-heal): act and heal
      // ALTERNATE. A replay failure hands the actor the wheel as before, but
      // between agent steps the harness tests the fresh state against the
      // remaining baseline window, and a unique match resumes deterministic
      // replay there. The track and actedFrom map span segments so bindings
      // recorded before a heal keep resolving in a resumed tail, and each heal
      // point is strictly beyond the last (the window excludes the heal point,
      // so a resumed walk can only fail further on) — a bad anchor cannot loop.
      const track = actionTrack(baseline.envelopes);
      const actedFrom = new Map();
      let resumeIndex = 0;
      for (;;) {
        const failed = await actLoop({
          driver, writer, rc, deadline, r, emit, axeCapture,
          baselineEnvelopes: baseline.envelopes,
          track: track.slice(resumeIndex), actedFrom,
          baselineBase, liveBase: env.baseUrl,
        });
        if (!failed) break;
        if (!llm.available) {
          // contract: an unhealable act failure is a gate failure
          actFailedUnhealed = true;
          r.endReason = "error";
          r.runError = `acted step ${failed.step} failed and no LLM is configured to heal`;
          return;
        }
        actualMode = "heal";
        if (r.healedFromStep == null) {
          // First escalation owns manifest.heal's from_step/kind/reason — the
          // ledger line and heal digest group on the original divergence even
          // when a re-anchored run heals again further down the track.
          r.healedFromStep = failed.step;
          r.healKindFirst = r.healKind;
          r.healReasonFirst = r.healReason;
        }
        // Classify BEFORE patching (DESIGN §5.3). The verdict is computed from
        // recorded evidence alone, so it is never a model call — and it can only
        // make the run redder: acceptHeal treats "regression" as a blocker, and
        // nothing here can turn a failing gate green.
        //
        // api-scoped: every signal it reads (statuses, response projections, the
        // binding graph) is a property of an HTTP request program. Web and mobile
        // healing is unchanged, down to their manifest bytes and the CLI's heal
        // digest grouping.
        if ((rc.env?.driver ?? "web") === "api") {
          r.healTriage = classifyHealFailure(r.healEvidence ?? { baselineStep: failed, kind: r.healKind, reason: r.healReason });
        }
        emit("heal_start", {
          failedStep: failed.step,
          reason: r.healReason ?? null,
          kind: r.healKind ?? null,
          ...(r.healTriage ? { classification: r.healTriage.classification } : {}),
        });
        // Anchor window (docs/contracts/engine.md#act-and-heal): action-track
        // steps STRICTLY after the heal point that carry the snapshot oracle —
        // a step without snapshot_text has nothing to match against (and
        // driftReason would vacuously pass it). Web/mobile only in v1: the api
        // driver's snapshot is a projection of the last response, too weak a
        // fingerprint of world state to anchor on, so api heals run to the end
        // exactly as before.
        const window = (rc.env?.driver ?? "web") === "api"
          ? []
          : track.filter((s: DynamicValue) => s.step > failed.step && typeof s.snapshot_text === "string");
        const resumed = await recordLoop({
          driver, writer, rc, persona, deadline, r, emit, axeCapture,
          anchor: window.length ? { window, baselineBase, liveBase: env.baseUrl } : null,
        });
        if (!resumed) {
          // The actor drove to an ending (or the run timed out/aborted): this
          // heal segment never re-anchored. endReason is already set.
          // A whole-segment anchoring failure is otherwise silent — say how
          // close the window got, so a poisoned oracle (one systematic line of
          // difference on every screen) is a one-line diagnosis instead of a
          // stuck run to reverse-engineer.
          const nearest = window.length ? nearestAnchor(driver, r.lastSnapshot, window, baselineBase, env.baseUrl) : null;
          if (nearest) {
            emit("warn", {
              message: `playtest: ${rc.id}: heal never re-anchored across ${window.length} candidate step${window.length === 1 ? "" : "s"} — nearest is baseline step ${nearest.step}, ${nearest.diff_lines} line${nearest.diff_lines === 1 ? "" : "s"} different`,
            });
          }
          r.healSegments.push({ from: failed.step, to: null, ...(nearest ? { nearest } : {}) });
          break;
        }
        r.healSegments.push({ from: failed.step, to: resumed.step });
        emit("heal_resume", { resumedAtStep: resumed.step });
        resumeIndex = track.findIndex((s) => s.step === resumed.step);
      }
    } else {
      await recordLoop({ driver, writer, rc, persona, deadline, r, emit, axeCapture });
    }
  };

  // Loop-level deadline checks bound each turn; this hard cap wraps the whole
  // case in case something hangs anyway.
  let timer;
  try {
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => resolve(HARD_TIMEOUT), rc.limits.timeout_ms + hardTimeoutGraceMs);
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

  // No loop exit may leave its final executed step uncommitted. When there was
  // no successor snapshot (max_steps, stuck, timeout, abort, or error), flush()
  // starts the scan now; otherwise it only joins the scan already overlapping
  // the actor turn. This precedes every gate and every further page operation.
  try {
    await axeCapture.flush();
  } catch (e) {
    r.endReason = "error";
    r.runError = r.runError ?? firstLine(e);
  }

  if (infra) return finishInfra(infra.message, { driver, env });

  // End the screencast now, before the gate (an assert: criterion makes a
  // blocking grader LLM call), manifest write, and teardown — otherwise all of
  // that records as one frozen frame, leaving video.webm with a dead tail. The
  // web driver re-hosts the final DOM in a non-recording check page so the
  // gate's element_exists/finalUrl still resolve after the recording page
  // closes (docs/contracts/engine.md#post-execution-phases); other drivers
  // have no such method (optional call).
  try {
    const finalState = await driver.stopRecording?.();
    // Step artifacts intentionally show what the actor saw BEFORE choosing the
    // action. Gates and grading need the state AFTER the last successful action,
    // especially when a timeout prevents another actor turn from capturing it.
    if (finalState?.text) r.lastSnapshot = projectSnapshot(driver, finalState.text);
  } catch {
    // A recording-stop hiccup must not fail the run; the webm may keep its tail.
  }

  // Gate (assert wired to the grader model), then manifest, then teardown.
  // Discovery skips the gate entirely, keyed on the case mode — not on the
  // empty success list, which gate.js would pass vacuously. A run that errored
  // produced no exploration data: it stays infra.
  let gate: DynamicValue = null;
  let status: DynamicValue;
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

  // Inherited verdicts (docs/contracts/engine.md#act-and-heal): a clean act
  // replay — actualMode is still "act" and no
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
      ? new Map(baseline.meta.verdicts.map((v: DynamicValue) => [v.spec, { pass: v.pass, detail: v.detail }]))
      : null;

  // Observing phase (docs/contracts/engine.md#gates-and-custom-assertions):
  // after the actor and
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
  const owners: DynamicValue = new Map(); // name → { owner, allInherited }
  if (routing.size > 0) {
    for (const criterion of rc.success ?? []) {
      const kind: DynamicValue = Object.keys(criterion).find((k) => k !== "label");
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
  const evidence: DynamicValue = {};
  if (willGather.length > 0 && !r.aborted) {
    emit("phase", { phase: "observing" });
    // Flush the HAR BEFORE gather() runs: the writer batches entries (first,
    // then every fifth), so without this an assertion reading har.json from
    // ctx.runDir can miss up to four trailing requests — on an api probe run,
    // often exactly the read-backs its invariant needs. The pre-gate flush
    // below stays as an idempotent backstop for the no-assertion path.
    try {
      await driver.flushHar?.();
    } catch {}
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
  try {
    await driver.flushHar?.();
  } catch {}
  // The observe phase's channel (docs/contracts/engine.md#invariant-policies).
  // An invariant policy that declared `observe: true` calls this; the driver
  // refuses anything but a read-only GET/HEAD, so the gate can never mutate the
  // system under test. A TRANSPORT failure here is infrastructure, not a red
  // verdict — an unreachable read-back says nothing about the app's invariants —
  // so the error is recorded and re-thrown: evaluateGate never throws, and the
  // run is finished as infra below.
  let observationError: DynamicValue = null;
  const observe =
    typeof driver.observe === "function"
      ? async (request: DynamicValue) => {
          try {
            return await driver.observe(request);
          } catch (e) {
            observationError = observationError ?? firstLine(e);
            throw e;
          }
        }
      : null;
  gate = await evaluateGate(rc, {
    driver,
    routing,
    evidence,
    inherited,
    observe,
    // The enriched OpenAPI document, when the suite configured one
    // (docs/contracts/engine.md#openapi-ingestion): declared statuses,
    // request/response schemas, security schemes, and links — the spec-driven
    // material Tier-1 checks are built on. Absent on web/mobile and on api
    // suites with no spec.
    spec: driver.spec ?? null,
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
        ? async (claim: DynamicValue) => {
            const { pass, detail, tokens } = await checkAssertion(claim, {
              snapshotText: r.lastSnapshot ?? "(no snapshot captured)",
              finalUrl,
              model: rc.grader_model,
              runDir: writer.dir,
              envelopes: r.envelopes,
              vision: rc.vision,
              perf,
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
    if (observationError) {
      return finishInfra(`invariant observation failed: ${observationError}`, { driver, env });
    }
    if (!gate.pass) emit("gate_fail", { checks: gate.checks.filter((c: DynamicValue) => !c.pass) });
    // A run that ended in an actor error has an incomplete trajectory (it stopped
    // on a failed step), so it never passes — even if the gate happened to like
    // the last snapshot it captured. This keeps a crashed run from being graded
    // green or accepted as a baseline.
    const reachedGoal = !actFailedUnhealed && r.endReason !== "error";
    // Heal acceptance (docs/contracts/engine.md#act-and-heal). Two rules that a
    // green gate alone does NOT satisfy, on the api driver: the healed run must
    // have ended with the actor's own `done` (an allowlist, so `stuck`,
    // `give_up`, `max_steps`, timeout, and any future ending are refused by
    // construction), and at least one applicable HARD DETERMINISTIC postcondition
    // must actually have evaluated on the healed trajectory (so an empty or
    // never-exercised gate cannot pass trivially). A regression classification
    // blocks acceptance too. The guard only ever subtracts: it can turn a pass
    // into a fail, never the reverse.
    r.healAccepted = acceptHeal({
      driver: rc.env?.driver ?? "web",
      mode: actualMode,
      endReason: r.endReason,
      gate,
      classification: r.healTriage?.classification ?? null,
    });
    if (!r.healAccepted.ok) {
      r.runError = r.runError ?? `heal not accepted: ${r.healAccepted.reason}`;
      emit("warn", { message: `playtest: ${rc.id}: the heal was not accepted — ${r.healAccepted.reason}` });
    }
    status = gate.pass && reachedGoal && r.healAccepted.ok ? "pass" : "fail";
    baselineEligible = gate.hardPass && reachedGoal && r.healAccepted.ok;
  }
  // The drift report (docs/contracts/artifacts.md#drift-report): written on
  // every API heal, accepted or not. Its deterministic half — classification,
  // signals, failed step, the gate verdict on the healed trajectory, and whether
  // the heal was accepted — is computed from recorded evidence. The narrative is
  // asked of the model only when one is configured, and nothing downstream reads
  // it back: the model has no authority over status or exit code (DESIGN D2).
  if (actualMode === "heal" && (rc.env?.driver ?? "web") === "api" && status !== "infra") {
    try {
      const report = await writeDriftReport(writer.dir, {
        runId,
        caseId: rc.id,
        mode: actualMode,
        story: rc.story,
        triage: r.healTriage,
        evidence: r.healEvidence,
        healKind: r.healKind,
        healReason: r.healReason,
        healedFromStep: r.healedFromStep,
        endReason: r.endReason,
        gate,
        accepted: r.healAccepted,
        narrate: llm.available,
        model: rc.grader_model,
        signal: r.signal,
        onRetry: ({ status: code, attempt, maxAttempts, waitMs }) => emit("retry", { phase: "grading", status: code, attempt, maxAttempts, waitMs }),
        onTokens: (tokens) => addTokens(r.graderTokens, tokens),
      });
      r.driftReport = report;
    } catch {
      // A drift report is diagnostic; failing to write one must not fail the run.
    }
  }

  // Never grade an infra run: it produced no trustworthy trajectory, and the
  // contract pins score to null on infra (a discovery actor-error lands here).
  // Act replays are never graded either — a clean replay's trajectory is
  // provably unchanged, so a fresh grade would only add cost + nondeterminism.
  const willGrade = grade && llm.available && actualMode !== "act" && status !== "infra";

  // Manifest write + browser/video flush + env teardown is another silent
  // window (seconds for a managed container); keep the live line moving.
  emit("phase", { phase: "finishing" });
  const manifest = buildManifest({
    rc, runId, mode: actualMode, startedAt, videoStartedAt, llm, env, r,
    status, gate, consoleErrors: driver.consoleErrors(), baseline, willGrade, headed, settle: driver.settle,
    snapshotFormat: driver.snapshotFormat, viewport: driver.viewport, persona,
    artifacts: driver.artifactProfile,
  });
  writer.writeManifest(manifest);
  finalManifestWritten = true; // the SIGINT flusher must not clobber this now

  // ------------------------------------------------------------- the tail
  // Two independent finishing jobs, run CONCURRENTLY:
  //
  //   grade — the grader model call. Everything it reads exists already:
  //     the trajectory and the manifest are handed to it in memory,
  //     final.a11y.txt was written by stopRecording before the gate, and the
  //     per-step artifacts it may fetch were persisted by captureSnapshot. It
  //     reads no har.json, so the HAR-flush ordering below is not its business.
  //   tail — driver close, env teardown, the VTT sidecar, the mp4 slideshow.
  //     driver.close() forces the final HAR flush; nothing in the grade branch
  //     reads har.json, and the gate (which does) already ran above.
  //
  // JOIN ORDER: settle BOTH, then let the tail's error win. Only env.teardown()
  // can throw here — driver.close, the sidecar and the slideshow are all
  // best-effort — and a teardown throw leaves runCase as it always has: it
  // escapes to runAll, which reports the case infra (exit 2). Rethrowing only
  // after grading has settled is deliberate: an eager throw would leave a
  // grade call writing grade.json into a directory nobody is waiting on.
  // The one visible difference from the serial order is that a run whose
  // teardown fails may now also have graded; status and exit code are
  // unchanged.
  let score: DynamicValue = null;
  const gradeJob = async () => {
    if (!willGrade) return;
    emit("grading");
    const gradeAt = perf.now();
    try {
      const grade = await permits.grade(() => gradeRun(writer.dir, rc, {
        signal: r.signal,
        perf,
        // The runner's own copies — identical to the bytes it wrote, and no
        // re-read to race the tail's manifest rewrite (T5.2).
        envelopes: r.envelopes,
        manifest,
        onRetry: ({ status, attempt, maxAttempts, waitMs }: DynamicValue) =>
          emit("retry", { phase: "grading", status, attempt, maxAttempts, waitMs }),
      }));
      addTokens(r.graderTokens, grade.tokens);
      score = grade.score ?? null;
      // Projection only (P1): the count of typed bug candidates the discovery
      // grader emitted, so run listings/CLI can surface it without re-reading
      // grade.json. Not a platform finding; hosted intake is a later phase.
      if (Array.isArray(grade.bug_candidates) && grade.bug_candidates.length) {
        manifest.totals.bug_candidates = grade.bug_candidates.length;
      }
    } catch (e) {
      emit("warn", { message: `warning: grading ${rc.id} failed: ${firstLine(e)}` });
      manifest.artifacts.grade = null;
    }
    perf.span("grade_total", gradeAt, null, { score });
    // The manifest was written before grading; fold the grade's tokens into the
    // merged run totals now (assert verdicts were already counted in the gate
    // phase, before the first write). On a grade failure gradeRun throws without
    // returning its usage, so a failed grade's tokens go unbilled — the rewrite
    // still corrects the actor+assert total and nulls the grade artifact.
    Object.assign(manifest.totals, runTotals(rc, r));
    writer.writeManifest(manifest);
  };

  const tailJob = async () => {
    const closeAt = perf.now();
    await driver.close().catch(() => {});
    perf.span("driver_close", closeAt);
    const teardownAt = perf.now();
    try {
      await env.teardown();
    } finally {
      perf.span("env_teardown", teardownAt);
      // Everything expensive and exclusive — the browser/simulator, the managed
      // container, the actor's model budget — is now released, so hand the
      // recording permit back and let the pool start the next case while this
      // one grades (T4.2). Idempotent; the pool releases it again on exit.
      permits.release();
    }

    // The shareable video is a post-run slideshow stitched from the per-step
    // stills (pure stills now on disk), not a live screencast. Emit the caption
    // sidecar (video.vtt) regardless — pure-JS, cue-timed on the slideshow
    // timeline (same recipe as `playtest clip`, byte-for-byte); a non-web /
    // screenshot-less run leaves it a no-op. Then, if ffmpeg is present, build
    // video.mp4 and point the manifest at it; absent, leave artifacts.video null
    // (the stills + .vtt remain, the viewer shows "no video recorded") and print
    // a one-line install hint. Best-effort — a build hiccup never fails the run.
    const vttAt = perf.now();
    try { writeVideoSidecar(writer.dir, { manifest, envelopes: r.envelopes }); } catch { /* sidecar is best-effort */ }
    perf.span("vtt", vttAt);
    const slideshowAt = perf.now();
    try {
      if (await ffmpegPresent()) {
        // The ffmpeg child no longer blocks the event loop, so the CPU permit
        // — not the runtime — is what bounds how many stitch at once.
        await permits.cpu(() => buildSlideshow(writer.dir, r.envelopes, path.join(writer.dir, "video.mp4")));
        manifest.artifacts.video = "video.mp4";
        writer.writeManifest(manifest);
      } else {
        emit("warn", { message: `note: no shareable video built (ffmpeg not found) — ${FFMPEG_HINT}` });
      }
    } catch { /* slideshow is best-effort; the stills + .vtt are the fallback */ }
    perf.span("slideshow", slideshowAt, null, { steps: r.envelopes.length });
  };

  // Both jobs mutate the same `manifest` object and may each write it; whichever
  // finishes last writes the union, so the final bytes match the serial order.
  const [, tailOutcome] = await Promise.allSettled([gradeJob(), tailJob()]);
  if (tailOutcome.status === "rejected") throw tailOutcome.reason;

    // Discovery never writes baselines or healed candidates, refresh included
    // (baselineEligible is false there — its status is never "pass"; the guard
    // states the constraint). baselineEligible (not status) gates acceptance, so
    // a soft-only gate failure still saves the path the agent succeeded along.
    if (baselineEligible && !discovery) {
      // existsSync, not readBaseline: a corrupt-but-present baseline must not
      // throw here, and must not be silently overwritten by an accept.
      const recordAccept =
        actualMode === "record" && (refresh || storyChanged || !fs.existsSync(baselinePaths(rc.file).traj));
      if (recordAccept || actualMode === "heal") {
        // The acceptance leak scan
        // (docs/contracts/interfaces.md#baseline-review-and-grading): a clean
        // scan auto-accepts exactly as before, a passing first record included.
        // Findings block AUTOMATIC acceptance and leave a pending candidate only
        // an explicit `playtest baseline accept` can approve. A fingerprint a
        // human already approved covers exactly those bytes, so re-recording
        // approved content still auto-accepts — changing it does not.
        let scan: DynamicValue = { findings: [], fingerprint: null };
        try {
          scan = scanRun(writer.dir, { redact: rc.redact ?? null, driver: rc.env?.driver ?? "web" });
        } catch {} // an unreadable trajectory cannot be accepted anyway
        const blocked = scan.findings.length > 0 && scan.fingerprint !== approvedFingerprint(rc.file);
        if (blocked) {
          manifest.baseline_scan = { blocked: true, findings: scan.findings };
          writer.writeManifest(manifest);
          emit("warn", {
            message:
              `playtest: ${rc.id}: not saved as the baseline — the leak scan found ` +
              `${scan.findings.length} value(s) that must not be committed:\n${describeFindings(scan.findings).join("\n")}\n` +
              `  declare them under redact: and re-record, or approve explicitly: playtest baseline accept ${writer.dir}`,
          });
        }
        if (recordAccept && !blocked) {
          acceptBaseline(rc.file, writer.dir);
          if (refresh || storyChanged) {
            // A refreshed/story-changed baseline invalidates any pending healed
            // candidate: that candidate diffs against the baseline this accept just
            // replaced (and a story change makes the old candidate stale too).
            const p = baselinePaths(rc.file);
            fs.rmSync(p.healedTraj, { force: true });
            fs.rmSync(p.healedMeta, { force: true });
          }
        } else {
          acceptBaseline(rc.file, writer.dir, { healed: true, scan: blocked ? scan : null });
        }
      }
    }
    const result = { status, runDir: writer.dir, manifest, score, ...(r.runError ? { error: r.runError } : {}) };
    emit("case_end", { status, result });
    return result;
  } finally {
    _sigintFlushers.delete(writePlaceholderManifest);
    perf.span("case_total", caseStartedAt, null, {
      driver: rc.env?.driver ?? "web",
      start_mode: startMode,
      steps: r.envelopes.length,
      end_reason: r.endReason,
    });
    perf.flush();
  }
}

class DeferredAxeCapture {
  #driver: DynamicValue;
  #writer: RunWriter;
  #perf: PerfSidecar;
  #pending: DynamicValue = null;

  constructor(driver: DynamicValue, writer: RunWriter) {
    this.#driver = driver;
    this.#writer = writer;
    this.#perf = writer.perf;
  }

  get enabled(): boolean {
    return typeof this.#driver.captureAxe === "function";
  }

  /**
   * Latch an executed envelope until its best-effort scan settles. Non-web
   * drivers retain the historical immediate append path.
   */
  defer(envelope: DynamicValue, settledAt = 0): void {
    if (!this.enabled) {
      this.#writer.appendEnvelope(envelope);
      return;
    }
    if (this.#pending) throw new Error("deferred axe invariant: previous envelope is still pending");
    this.#pending = {
      envelope,
      step: envelope.step,
      settledAt,
      scan: null,
      scanStartedAt: 0,
      scanSettledAt: 0,
      deferredMs: 0,
    };
  }

  /**
   * The only normal scan start: immediately after the successor snapshot has
   * finished, before the next model turn or replay dispatch. No page operation
   * may run until barrier() has joined it.
   */
  afterSnapshot(): void {
    const pending = this.#pending;
    if (!pending || pending.scan) return;
    pending.scanStartedAt = this.#perf.now();
    pending.deferredMs =
      pending.scanStartedAt && pending.settledAt
        ? Math.max(0, pending.scanStartedAt - pending.settledAt)
        : 0;
    pending.scan = Promise.resolve()
      .then(() => this.#driver.captureAxe())
      .then((axe: DynamicValue) => {
        if (axe) pending.envelope.axe = axe;
      })
      .catch(() => {
        // Best-effort: rejection leaves the field absent and never changes the
        // action result or run status.
      })
      .finally(() => {
        pending.scanSettledAt = this.#perf.now();
      });
  }

  /**
   * Correctness barrier before the next action or page operation. It also owns
   * the ordered trajectory append: step N cannot be written until its scan has
   * settled, and no later executed step can exist before this barrier passes.
   */
  async barrier(): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    this.afterSnapshot();
    const blockedAt = this.#perf.now();
    await pending.scan;
    const finishedAt = this.#perf.now();
    const blockedMs = blockedAt && finishedAt ? Math.max(0, finishedAt - blockedAt) : 0;
    const scanMs =
      pending.scanStartedAt && pending.scanSettledAt
        ? Math.max(0, pending.scanSettledAt - pending.scanStartedAt)
        : 0;
    this.#perf.record("axe", scanMs, pending.step, {
      terminal: false,
      violations: pending.envelope.axe?.violations?.length ?? null,
      blocked_ms: blockedMs,
      deferred_ms: pending.deferredMs,
    });
    this.#writer.appendEnvelope(pending.envelope);
    this.#pending = null;
  }

  /** Resolve the last step when no successor snapshot exists. */
  async flush(): Promise<void> {
    await this.barrier();
  }

  /** Terminal done/give_up retains an inline capture of the page just read. */
  async terminal(step: number): Promise<DynamicValue> {
    if (!this.enabled) return null;
    const startedAt = this.#perf.now();
    let axe = null;
    try {
      axe = await this.#driver.captureAxe();
    } catch {
      // Best-effort, matching deferred capture.
    }
    const finishedAt = this.#perf.now();
    this.#perf.record(
      "axe",
      startedAt && finishedAt ? Math.max(0, finishedAt - startedAt) : 0,
      step,
      {
        terminal: true,
        violations: axe?.violations?.length ?? null,
        blocked_ms: 0,
        deferred_ms: 0,
      },
    );
    return axe;
  }
}

async function recordLoop({ driver, writer, rc, persona, deadline, r, emit, axeCapture, anchor = null }: DynamicValue) {
  const perf = writer.perf; // diagnostic timing sidecar (perf.ts)
  const actor = new Actor(rc, persona);
  actor.setupContext = r.setupContext;
  const costSoFar = () => estimateCost(rc.actor_model, r.tokens);
  const tokensSoFar = (ctx: DynamicValue) => ({ ctx, in: r.tokens.in, out: r.tokens.out });
  // Agent envelopes appended by THIS call. The re-anchor check arms only after
  // the first one: heal entered because the state did not (or could not) replay,
  // so the heal-entry snapshot has nothing new to say — the actor must move first.
  let agentSteps = 0;

  while (r.envelopes.length < rc.limits.max_steps) {
    if (r.aborted) return;
    if (Date.now() >= deadline) {
      r.endReason = "timeout";
      return;
    }
    const stepNum = r.envelopes.length + 1;
    // `snapshot` is the whole capture, timed here so it is driver-agnostic; each
    // driver reports its own snapshot_* sub-splits from the inside.
    const snapshotAt = perf.now();
    const snap = await driver.captureSnapshot(stepNum);
    perf.span("snapshot", snapshotAt, stepNum);
    if (r.aborted) return;
    r.lastSnapshot = snap.text;
    axeCapture.afterSnapshot();
    // Re-anchor (docs/contracts/engine.md#act-and-heal): the snapshot is already
    // captured for the actor's next turn, so testing it against the remaining
    // baseline window costs no driver work. A unique match hands the wheel back
    // to the deterministic replayer; the actor never knows the check exists.
    if (anchor && agentSteps >= 1) {
      const match = findAnchor(driver, snap, anchor.window, rc, anchor.baselineBase, anchor.liveBase);
      if (match) {
        await axeCapture.barrier();
        return match;
      }
    }
    let agentStep, tokens, llmRetries;
    // actor_request covers the whole turn INCLUDING a validation retry and any
    // 429/5xx backoff, because that is what the step actually waits for; the
    // meta separates the two so a slow gateway reads differently from a model
    // that had to be asked twice.
    const actorAt = perf.now();
    let httpRetries = 0;
    try {
      ({ agentStep, tokens, retries: llmRetries } = await actor.nextStep({
        history: r.envelopes,
        snapshotText: snap.text,
        stepNum,
        screenshot: rc.vision ? snap.screenshot: null,
        signal: r.signal,
        onContext: (messages, tools) => {
          try {
            if (!r.wroteContext) {
              writer.appendContext({ type: "header", ts: Date.now(), model: rc.actor_model, system: messages[0]?.content, tools });
              r.wroteContext = true;
            }
            writer.appendContext({
              step: stepNum,
              ts: Date.now(),
              model: rc.actor_model,
              messages: sanitizeContext(messages).filter((m) => m.role !== "system"),
            });
          } catch {}
        },
        onRetry: ({ status, attempt, maxAttempts, waitMs }) => {
          httpRetries += 1;
          emit("retry", { phase: "acting", step: stepNum, status, attempt, maxAttempts, waitMs });
        },
      }));
    } catch (e) {
      perf.span("actor_request", actorAt, stepNum, { ok: false, http_retries: httpRetries });
      if (r.aborted) return;
      await axeCapture.barrier();
      const message = firstLine(e);
      const envelope = baseEnvelope(stepNum, {
        mode: "error",
        error: message,
        result: { ok: false, error: message, settle_ms: 0, url: snap.url },
        perf: emptyPerf(),
        artifacts: artifactsFor(stepNum, [], artifactFlags(driver, snap)),
        network: { requests: [] },
      });
      emit("step_start", { step: stepNum, summary: "actor error" });
      writer.appendEnvelope(envelope);
      r.envelopes.push(envelope);
      emit("step_result", { step: stepNum, ok: false, error: message, settleMs: 0, costSoFar: costSoFar(), tokens: tokensSoFar(null) });
      r.endReason = "error";
      r.runError = message;
      return;
    }
    perf.span("actor_request", actorAt, stepNum, {
      ok: true,
      tokens_in: tokens.in, tokens_out: tokens.out, cache_read: tokens.cache_read,
      // One extra model call per entry: the actor retries once on a schema
      // rejection, and the retry pays for a second full prompt.
      validation_retries: llmRetries?.length ?? 0,
      http_retries: httpRetries,
    });
    if (r.aborted) return;
    addTokens(r.tokens, tokens);
    // The trajectory persists the REDACTED action, and the driver executes that
    // same redacted form (it resolves the placeholders again internally) — so a
    // committed baseline is a request program that acts, byte-for-byte, without
    // any credential or redaction-listed value ever reaching disk. Drivers with
    // no redactAction hook (web, mobile) are untouched.
    if (typeof driver.redactAction === "function") {
      const redacted = driver.redactAction(agentStep.action);
      if (redacted !== agentStep.action) agentStep = { ...agentStep, action: redacted };
    }
    // Bindings (docs/contracts/engine.md#bindings): a literal this run's earlier
    // responses produced becomes a `{{name}}` token, and the returned records
    // cite the producer step + JSON path each token re-reads. Drivers without the
    // hook (web, mobile) are untouched.
    let bindings = [];
    if (typeof driver.parameterizeAction === "function") {
      const parameterized = driver.parameterizeAction(agentStep.action);
      if (parameterized.action !== agentStep.action) agentStep = { ...agentStep, action: parameterized.action };
      bindings = parameterized.bindings ?? [];
    }
    emit("step_start", { step: stepNum, summary: describeAction(agentStep.action) });

    const envelope = baseEnvelope(stepNum, {
      mode: "agent",
      agent: agentStep,
      ...(bindings.length ? { bindings } : {}),
      snapshot_text: projectSnapshot(driver, snap.text),
      ...(rc.visual_regression && snap.screenshotHash ? { screenshot_hash: snap.screenshotHash } : {}),
    });
    const type = agentStep.action.type;
    if (type === "done" || type === "give_up") {
      // The prior executed envelope must settle before this inline terminal scan
      // touches the page or this terminal envelope is appended.
      await axeCapture.barrier();
      const axe = await axeCapture.terminal(stepNum);
      Object.assign(envelope, {
        result: { ok: true, error: null, settle_ms: 0, url: snap.url },
        perf: emptyPerf(),
        artifacts: artifactsFor(stepNum, [], artifactFlags(driver, snap)),
        network: { requests: [] },
        ...(axe ? { axe } : {}),
        tokens,
        ...(llmRetries?.length ? { llm_retries: llmRetries } : {}),
      });
      // Terminal steps still accept actor raises (e.g. findings noticed on the
      // final page); no harness confusion heuristic runs without an executed action.
      applyActorRaises(envelope, agentStep, null);
      writer.appendEnvelope(envelope);
      r.envelopes.push(envelope);
      emit("step_result", { step: stepNum, ok: true, error: null, settleMs: 0, costSoFar: costSoFar(), tokens: tokensSoFar(tokens.in) });
      r.endReason = type;
      return;
    }

    // Only click/tap/type can ever consume a pre-action token: detectConfusion's
    // no_effect rule gates on exactly those types and reads a null before-token
    // as "no signal" (so a skipped token is not a changed verdict, it is the same
    // verdict without the round-trip). Every other action type — scroll, swipe,
    // wait, back, navigate, select, request — was paying a live transport call
    // for a value nothing reads; on mobile that call is an Appium alert probe.
    const tokenable = type === "click" || type === "tap" || type === "type";
    let before: string | null = null;
    // effectToken and execute are page operations. Neither may overlap the scan
    // that began after this turn's snapshot.
    await axeCapture.barrier();
    if (tokenable) {
      const tokenAt = perf.now();
      before = await driver.effectToken();
      perf.span("effect_token", tokenAt, stepNum, { when: "before", type });
    }
    const dispatchAt = perf.now();
    const exec = await driver.execute(agentStep.action, { step: stepNum, bindings });
    perf.span("action_dispatch", dispatchAt, stepNum, { mode: "record", type, ok: exec.ok });
    Object.assign(envelope, {
      ...(exec.resolution ? { resolution: exec.resolution } : {}),
      // The exact response status this step observed, when the transport reports
      // one (api). Acting compares against it per step, so a changed status is
      // drift attributed HERE (docs/contracts/engine.md#act-and-heal).
      ...(exec.expect ? { expect: exec.expect } : {}),
      result: { ok: exec.ok, error: exec.error, settle_ms: exec.settle_ms, url: exec.url ?? null },
      perf: exec.perf,
      artifacts: artifactsFor(stepNum, exec.har_entries, artifactFlags(driver, snap)),
      network: exec.network,
      // Reserve axe's historical key position while its value is pending.
      // JSON.stringify omits undefined on rejection; assigning after the scan
      // preserves byte order on success.
      ...(axeCapture.enabled ? { axe: undefined } : {}),
      ...(exec.console_errors?.length ? { console_errors: exec.console_errors } : {}),
      tokens,
      ...(llmRetries?.length ? { llm_retries: llmRetries } : {}),
    });
    const confusion = await detectConfusion(envelope, r.envelopes, exec, before, driver, perf);
    if (r.aborted) return; // do not append past the hard-timeout cut
    // Harness-detected confusion is objective evidence and wins the single
    // confusion slot; actor raises (and legacy confused sugar) fall back into
    // it when no harness flag fires. envelope.raises holds every actor sticky
    // note (multiple allowed). Only assigned when present — a clean step keeps
    // NO confusion/raises keys (web golden byte-identical when unused).
    applyActorRaises(envelope, agentStep, confusion);
    r.envelopes.push(envelope);
    axeCapture.defer(envelope, exec.axe_deferred_at);
    agentSteps += 1;
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
  }
  r.endReason = "max_steps";
}

// True when the last STUCK_FAIL_LIMIT envelopes are all failures sharing one
// action signature AND one error message — a loop with no progress (see
// STUCK_FAIL_LIMIT). Fewer than the limit, any success in the window, or a
// varied action/error breaks the streak. Pure over the envelope list; exported
// for the offline test.
export function isStuck(envelopes: DynamicValue[]) {
  if (envelopes.length < STUCK_FAIL_LIMIT) return false;
  const window = envelopes.slice(-STUCK_FAIL_LIMIT);
  const sig = (e: DynamicValue) => {
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
async function actLoop({ driver, writer, rc, deadline, r, emit, axeCapture, baselineEnvelopes, track = null, actedFrom = new Map(), baselineBase = null, liveBase = null }: DynamicValue) {
  const perf = writer.perf; // diagnostic timing sidecar (perf.ts)
  // `track` is the (remaining) action track to walk — the caller passes a tail
  // slice when replay resumes after a re-anchored heal — and `actedFrom` maps
  // baseline step -> the run step that acted it. A binding's `from_step` cites a
  // step in the trajectory that recorded it, so replay must translate it into
  // this run's numbering before the driver can read the FRESH response — and the
  // acted envelope stores the translated form, so a healed trajectory accepted
  // as the next baseline keeps citing steps that exist in it. Both live in the
  // caller so they survive act -> heal -> act alternation.
  for (const baseStep of track ?? actionTrack(baselineEnvelopes)) {
    if (r.aborted) return null;
    if (Date.now() >= deadline) {
      r.endReason = "timeout";
      return null;
    }
    const stepNum = r.envelopes.length + 1;
    // Acted steps replay a known action: the summary is known up front.
    emit("step_start", { step: stepNum, summary: describeAction(actionOf(baseStep)) });
    const snapshotAt = perf.now();
    const snap = await driver.captureSnapshot(stepNum);
    perf.span("snapshot", snapshotAt, stepNum);
    r.lastSnapshot = snap.text;
    axeCapture.afterSnapshot();
    // Snapshot drift (docs/contracts/engine.md#act-and-heal): the actor chose
    // this action against baseStep's
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
    // State drift (docs/contracts/engine.md#act-and-heal): the page is no longer
    // what the baseline expected, so the
    // recorded action is no longer trustworthy. Do NOT execute it — record a
    // non-executed drift marker (result.ok:false, no resolution → excluded from
    // actionTrack, so it can never be replayed as a step) and escalate to heal
    // from this baseline step. The marker carries confusion.type "state_drift":
    // the actor's history renderer reads it as "SKIPPED — decide fresh from here".
    if (drift) {
      await axeCapture.barrier();
      const envelope = baseEnvelope(stepNum, {
        ts,
        mode: "act",
        acted_from: baseStep.step,
        action: actionOf(baseStep),
        result: { ok: false, error: drift, settle_ms: 0, url: snap.url ?? null },
        perf: emptyPerf(),
        artifacts: artifactsFor(stepNum, [], artifactFlags(driver, snap)),
        network: { requests: [] },
        confusion: { type: "state_drift", note: drift },
      });
      writer.appendEnvelope(envelope);
      r.envelopes.push(envelope);
      emit("step_result", {
        step: stepNum, ok: false, error: drift, settleMs: 0,
        costSoFar: estimateCost(rc.actor_model, r.tokens),
        tokens: { ctx: null, in: r.tokens.in, out: r.tokens.out },
      });
      r.healReason = drift;
      r.healKind = "drift";
      // Triage evidence (docs/contracts/engine.md#act-and-heal): both sides of
      // the comparison that failed, so the classification can name WHAT moved
      // (a renamed field, a vanished one) without asking a model.
      r.healEvidence = {
        baselineStep: baseStep,
        baselineEnvelopes,
        kind: "drift",
        reason: drift,
        observedStatus: null,
        transportError: null,
        baselineProjection: projectSnapshot(driver, baseStep.snapshot_text ?? ""),
        freshProjection: projectSnapshot(driver, snap?.text ?? ""),
      };
      return baseStep;
    }
    const bindings = remapBindings(baseStep.bindings, actedFrom);
    await axeCapture.barrier();
    const dispatchAt = perf.now();
    const exec = await driver.executeLocator(baseStep, { step: stepNum, bindings });
    perf.span("action_dispatch", dispatchAt, stepNum, { mode: "act", type: actionOf(baseStep)?.type, ok: exec.ok });
    if (r.aborted) return null; // do not append past the hard-timeout cut
    actedFrom.set(baseStep.step, stepNum);
    const envelope = baseEnvelope(stepNum, {
      ts,
      mode: "act",
      acted_from: baseStep.step,
      action: actionOf(baseStep),
      ...(bindings.length ? { bindings } : {}),
      ...(exec.resolution ? { resolution: exec.resolution } : {}),
      ...(exec.expect ? { expect: exec.expect } : {}),
      result: { ok: exec.ok, error: exec.error, settle_ms: exec.settle_ms, url: exec.url ?? null },
      perf: exec.perf,
      artifacts: artifactsFor(stepNum, exec.har_entries, artifactFlags(driver, snap)),
      network: exec.network,
      ...(axeCapture.enabled ? { axe: undefined } : {}),
    });
    // Step-scoped expectation (docs/contracts/engine.md#act-and-heal): the
    // baseline recorded the EXACT status this step answered. A different status
    // now is drift attributed to THIS step — including a within-class change like
    // 201 -> 202, which a class match would have hidden. Only an explicit
    // match.status_equivalent normalization widens it.
    const statusDrift = expectationDrift(baseStep, exec, rc.match);
    // An execution failure escalates to heal: resume after the failed step.
    if (!exec.ok) envelope.confusion = { type: "action_failed", note: exec.error };
    else if (statusDrift) envelope.confusion = { type: "state_drift", note: statusDrift };
    r.envelopes.push(envelope);
    axeCapture.defer(envelope, exec.axe_deferred_at);
    emit("step_result", {
      step: stepNum, ok: exec.ok, error: exec.error ?? statusDrift, settleMs: exec.settle_ms,
      costSoFar: estimateCost(rc.actor_model, r.tokens),
      tokens: { ctx: null, in: r.tokens.in, out: r.tokens.out },
    });
    if (!exec.ok || statusDrift) {
      r.healReason = exec.ok ? statusDrift : exec.error;
      r.healKind = exec.ok ? "drift" : "action_failed";
      r.healEvidence = {
        baselineStep: baseStep,
        baselineEnvelopes,
        kind: r.healKind,
        reason: r.healReason,
        // The exact status this step just answered, against the exact status the
        // baseline recorded for it — the pair the regression signals read
        // (a 4xx that became a 2xx, a 2xx that became a 5xx).
        observedStatus: exec.expect?.status ?? null,
        transportError: exec.ok ? null : exec.error,
        baselineProjection: projectSnapshot(driver, baseStep.snapshot_text ?? ""),
        freshProjection: null,
      };
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
  const terminalStep = baselineEnvelopes.findLast((e: DynamicValue) => ["done", "give_up"].includes(actionOf(e)?.type as DynamicValue)); // SAFETY: includes intentionally treats a missing action type as a non-match
  const terminalType = actionOf(terminalStep)?.type ?? "done";
  const stepNum = r.envelopes.length + 1;
  let finalUrl = null;
  let snap = null;
  const finalSnapshotAt = perf.now();
  try {
    snap = await driver.captureSnapshot(stepNum);
    r.lastSnapshot = snap.text;
    finalUrl = snap.url;
  } catch {}
  perf.span("snapshot", finalSnapshotAt, stepNum);
  if (r.aborted) return null;
  axeCapture.afterSnapshot();
  // Same always-on WCAG capture the record loop's done/give_up branch takes: the
  // final acted page is a real, gradeable surface. Web-only (optional chaining),
  // full-page, best-effort (null → no `axe`, keeping non-web / capture-failure
  // envelopes byte-identical).
  await axeCapture.barrier();
  const axe = snap ? await axeCapture.terminal(stepNum) : null;
  const envelope = baseEnvelope(stepNum, {
    mode: "act",
    ...(terminalStep ? { acted_from: terminalStep.step } : {}),
    action: terminalStep ? actionOf(terminalStep) : { type: "done", summary: "acted the baseline track to completion" },
    result: { ok: true, error: null, settle_ms: 0, url: finalUrl },
    perf: emptyPerf(),
    artifacts: artifactsFor(stepNum, [], artifactFlags(driver, snap)),
    network: { requests: [] },
    ...(axe ? { axe } : {}),
  });
  writer.appendEnvelope(envelope);
  r.envelopes.push(envelope);
  emit("step_start", { step: stepNum, summary: describeAction(envelope.action) });
  emit("step_result", { step: stepNum, ok: true, error: null, settleMs: 0, costSoFar: estimateCost(rc.actor_model, r.tokens), tokens: { ctx: null, in: r.tokens.in, out: r.tokens.out } });
  r.endReason = terminalType;
  return null;
}

/**
 * What the step envelope stores as `snapshot_text`. A driver may replace the raw
 * snapshot with a persistence projection (the api driver's status + body shape);
 * the raw text still reaches the actor and the run-local step artifacts.
 * Drivers without the hook persist exactly what they captured, as before.
 */
function projectSnapshot(driver: DynamicValue, text: DynamicValue) {
  return typeof driver?.snapshotProjection === "function" ? driver.snapshotProjection(text ?? "") : text;
}

/**
 * Translate a baseline step's bindings into this run's step numbering
 * (docs/contracts/engine.md#bindings). A producer the replay has not reached
 * keeps its recorded number, so the driver reports an unresolvable binding and
 * the step fails loudly rather than sending a stale value. Pure; exported for test.
 */
export function remapBindings(bindings: DynamicValue, actedFrom: DynamicValue) {
  if (!Array.isArray(bindings) || !bindings.length) return [];
  return bindings.map((b) => (actedFrom.has(b.from_step) ? { ...b, from_step: actedFrom.get(b.from_step) } : { ...b }));
}

/**
 * Step-scoped expectation check (docs/contracts/engine.md#act-and-heal): does the
 * status this acted step just observed still match the one the baseline recorded
 * for it? Exact by default — a within-class change (201 -> 202, 200 -> 204) is a
 * contract change, and treating a class as a match would hide it. `match.status_equivalent`
 * is the only way to declare two statuses interchangeable. Returns the drift
 * reason, or null. Pure; exported for test.
 */
export function expectationDrift(baseStep: DynamicValue, exec: DynamicValue, match: DynamicValue = null) {
  const expected = baseStep?.expect?.status;
  const actual = exec?.expect?.status;
  if (expected == null || actual == null) return null; // legacy baseline, or a transport with no status
  if (statusesEquivalent(expected, actual, match)) return null;
  return (
    `the acted step answered ${actual} where the baseline recorded ${expected}` +
    ` (baseline step ${baseStep.step}) — declare them interchangeable under match.status_equivalent if that is intended`
  );
}

/**
 * Multi-channel drift check for act-mode replay
 * (docs/contracts/engine.md#act-and-heal). Returns the first
 * non-null channel reason (a11y wins ties; its note distinguishes the channel),
 * else null.
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
function driftReason(driver: DynamicValue, snap: DynamicValue, baseStep: DynamicValue, rc: DynamicValue, baselineBase: DynamicValue = null, liveBase: DynamicValue = null) {
  const baselineText = baseStep?.snapshot_text;
  if (typeof baselineText === "string") {
    // Base-aware (docs/contracts/engine.md#act-and-heal): each side is
    // relativized against its own recording base, so
    // the SAME page served under different deployment prefixes collapses equal
    // while a title change or a real in-app navigation still diverges.
    // Both sides go through the driver's persistence projection first, so the
    // comparison is projection-vs-projection with no special case. Projection is
    // idempotent, so a baseline recorded before P2 (a raw response body in
    // snapshot_text) is projected on the fly here and keeps acting.
    const now = driver.normalizeSnapshot(projectSnapshot(driver, snap?.text ?? ""), liveBase);
    const was = driver.normalizeSnapshot(projectSnapshot(driver, baselineText), baselineBase);
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

/**
 * Re-anchor test (docs/contracts/engine.md#act-and-heal): during a heal, find
 * the baseline step where deterministic replay may resume. The oracle is
 * driftReason itself — the same exact-equality bar replay must meet before
 * executing a step — evaluated against the remaining window (action-track steps
 * strictly after the heal point that carry snapshot_text; the caller filters).
 * Only a UNIQUE match resumes: two byte-identical candidate screens (a wizard
 * loop) are the one case where "earliest" could rewind, so a tie anchors
 * nothing and the actor keeps driving. Pure; exported for the offline test.
 * @returns {object|null} the matched baseline step envelope, or null
 */
export function findAnchor(driver: DynamicValue, snap: DynamicValue, window: DynamicValue[], rc: DynamicValue, baselineBase: DynamicValue = null, liveBase: DynamicValue = null) {
  let match: DynamicValue = null;
  for (const candidate of window) {
    if (driftReason(driver, snap, candidate, rc, baselineBase, liveBase)) continue;
    if (match) return null; // ambiguous — conservative v1 resumes only on a unique match
    match = candidate;
  }
  return match;
}

/**
 * Post-mortem for a heal segment that never re-anchored: how close did the
 * window get? Returns the candidate with the fewest differing normalized
 * snapshot lines against the final live snapshot (multiset line difference —
 * a cheap, order-insensitive count; a diagnostic, not an oracle). Runs once,
 * at segment end, through the same normalization path as driftReason. Null
 * when either side carries no snapshot oracle. Pure; exported for tests.
 * @param {string|null} snapText the live snapshot text (r.lastSnapshot)
 * @returns {{ step: number, diff_lines: number } | null}
 */
export function nearestAnchor(driver: DynamicValue, snapText: DynamicValue, window: DynamicValue[], baselineBase: DynamicValue = null, liveBase: DynamicValue = null) {
  if (typeof snapText !== "string") return null;
  const now = driver.normalizeSnapshot(projectSnapshot(driver, snapText), liveBase).split("\n");
  const nowCounts = new Map();
  for (const line of now) nowCounts.set(line, (nowCounts.get(line) ?? 0) + 1);
  let best: DynamicValue = null;
  for (const candidate of window) {
    if (typeof candidate?.snapshot_text !== "string") continue;
    const was = driver.normalizeSnapshot(projectSnapshot(driver, candidate.snapshot_text), baselineBase).split("\n");
    const remaining = new Map(nowCounts);
    let missing = 0;
    for (const line of was) {
      const n = remaining.get(line) ?? 0;
      if (n > 0) remaining.set(line, n - 1);
      else missing++;
    }
    let extra = 0;
    for (const n of remaining.values()) extra += n;
    const diffLines = missing + extra;
    if (!best || diffLines < best.diff_lines) best = { step: candidate.step, diff_lines: diffLines };
  }
  return best;
}

/**
 * Normalize the actor's structured sticky notes for this turn.
 * See docs/contracts/artifacts.md#step-envelope.
 * Accepts `raises: [{ kind, note, severity? }]` (preferred; up to 5) and legacy
 * `confused` + `confused_reason` sugar (one confusion). Pure; exported for tests.
 * @returns {{ kind: "confusion"|"finding", note: string, severity?: string }[]}
 */
export function normalizeRaises(agentStep: DynamicValue) {
  const out: DynamicValue[] = [];
  const seen = new Set<string>();
  const push = (kind: DynamicValue, note: DynamicValue, severity?: DynamicValue) => {
    if (kind !== "confusion" && kind !== "finding") return;
    const n = typeof note === "string" ? note.trim() : "";
    if (!n) return;
    const sev = severity === "info" || severity === "minor" || severity === "major" ? severity : undefined;
    const key = `${kind}\0${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sev ? { kind, note: n, severity: sev } : { kind, note: n });
  };
  if (Array.isArray(agentStep?.raises)) {
    for (const r of agentStep.raises) {
      if (!r || typeof r !== "object") continue;
      push(r.kind, r.note, r.severity);
      if (out.length >= 5) break;
    }
  }
  // Legacy sugar: confused → one confusion raise when not already present.
  if (agentStep?.confused && out.length < 5) {
    const reason = typeof agentStep.confused_reason === "string" ? agentStep.confused_reason.trim() : "";
    push("confusion", reason || "actor reported being stuck/confused");
  }
  return out;
}

/**
 * Attach actor raises to the envelope and fill the shared `confusion` slot.
 * @param {object|null} harnessConfusion detectConfusion result (wins ties)
 */
function applyActorRaises(envelope: DynamicValue, agentStep: DynamicValue, harnessConfusion: DynamicValue) {
  const raises = normalizeRaises(agentStep);
  if (raises.length) envelope.raises = raises;
  const selfConfusion = raises.find((r) => r.kind === "confusion");
  const flagged =
    harnessConfusion ??
    (selfConfusion ? { type: "self_reported", note: selfConfusion.note } : null);
  if (flagged) envelope.confusion = flagged;
}

// Confusion heuristics (docs/contracts/engine.md#record-and-explore): action_failed,
// repeated_action (same action twice running against the SAME page state),
// no_effect.
export async function detectConfusion(envelope: DynamicValue, prior: DynamicValue[], exec: DynamicValue, beforeToken: DynamicValue, driver: DynamicValue, perf: PerfSidecar = PerfSidecar.off()) {
  if (!exec.ok) return { type: "action_failed", note: exec.error };
  const sig = (e: DynamicValue) => {
    const a = actionOf(e) ?? {};
    return `${a.type}/${a.ref ?? e.resolution?.locator ?? a.url ?? ""}`;
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
  // so this is a no-op there. recordLoop only fetches a before-token for these
  // same three types, so every other type arrives here with beforeToken null and
  // stops at this gate — the null branch is load-bearing, not defensive.
  if ((type === "click" || type === "tap" || type === "type") && (exec.perf?.requests ?? 0) === 0 && beforeToken !== null) {
    // driver.effectToken() is the transport's "did anything change" fingerprint
    // (web: last DOM-mutation time + form values + URL); the no_effect rule
    // ("0 requests AND token unchanged") generalizes across drivers.
    const afterAt = perf.now();
    const after = await driver.effectToken();
    perf.span("effect_token", afterAt, envelope.step ?? null, { when: "after", type: actionOf(envelope)?.type });
    if (after !== null && after === beforeToken) {
      return { type: "no_effect", note: "no requests, no DOM or input changes, url unchanged" };
    }
  }
  return null;
}

/** Secret NAMES this case references (config headers + redaction list), sorted. */
function secretNamesFor(rc: DynamicValue) {
  const names = new Set(collectSecretRefNames(rc?.env?.headers ?? null));
  for (const entry of rc?.redact?.request ?? []) names.add(entry.secret);
  return [...names].sort();
}

export function buildManifest({ rc, runId, mode, startedAt, videoStartedAt, llm, env, r, status, gate, consoleErrors, baseline, willGrade, headed = false, settle = undefined, snapshotFormat = undefined, viewport = undefined, persona = undefined, video = null, artifacts = undefined }: DynamicValue): DynamicValue {
  const finishedAt: DynamicValue = new Date();
  const secrets = secretNamesFor(rc);
  // The recording profile this run actually ran under
  // (docs/contracts/artifacts.md#artifact-profiles). Prefer the LIVE driver's
  // answer — it is the object that made the capture decisions — and fall back to
  // the case's own value for the placeholder manifest written before any driver
  // exists. It decides both the recorded provenance below and whether
  // artifacts.trace may name a file.
  const profile = artifacts ?? rc.artifacts ?? "core";
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
      // Advisory invariant policies, only when the case declares any — so a
      // manifest for a suite that uses none is byte-identical to before.
      ...(rc.observe?.length ? { observe: rc.observe } : {}),
      perf: rc.perf,
      report: rc.report,
      // Redaction/secret provenance so an out-of-process `playtest baseline
      // accept` scans this run by the same rules the run itself did. Names only —
      // a resolved secret value never reaches the manifest. Both are emitted only
      // when declared, so manifests for suites that use neither are unchanged.
      ...(rc.redact ? { redact: rc.redact } : {}),
      ...(secrets.length ? { secrets } : {}),
      vision: rc.vision,
      // A visual_regression run is not comparable to a non-one (same spirit as
      // vision) affects the observed threshold keys comparability.
      visual_regression: rc.visual_regression,
      visual_regression_drift: rc.visual_regression_drift,
      // Which recording profile wrote this run's evidence
      // (docs/contracts/artifacts.md#artifact-profiles). Provenance, not a pin:
      // it explains why a trace/MHTML/native tree is absent, and it never makes
      // two runs incomparable — the profile changes what is written BESIDE the
      // evidence, never the snapshot text, the actions, or the gate.
      artifacts: profile,
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
      // docs/contracts/artifacts.md#versions-and-comparability). For web,
      // driver.settle === PINS_BASE.settle (settle-v1) and
      // driver.snapshotFormat === SNAPSHOT_FORMAT (PINS_BASE.snapshot_format),
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
      headed, // headed + vision are part of the comparability key (shared/movement.ts)
      vision: rc.vision,
    },
    env: {
      base_url: env?.baseUrl ?? rc.env.base_url,
      managed: env?.managed ?? false,
      driver: rc.env?.driver ?? "web",
      // The selected env overlay name (app.envs.<name>); only emitted when one
      ...(rc.env?.env_name ? { env_name: rc.env.env_name } : {}),
      // Cookies seeded before the first navigation (web blue/green routing etc.) —
      // surfaced on the clip intro card. Only emitted when set so cookie-less
      // runs keep the stable manifest env shape.
      ...(rc.env.cookies ? { cookies: rc.env.cookies } : {}),
      // The abstract identity label this case ran as (app.auth: "member"/"none");
      // informational, only emitted when declared — NOT a comparability pin (a
      // session input, like cookies/storage_state).
      ...(rc.env?.auth ? { auth: rc.env.auth } : {}),
    },
    result: { status, end_reason: r.endReason, error: r.runError, gate },
    // Heal provenance: where the act replay diverged and why. Only on heal runs —
    // the ledger line ("healed @N"), the end-of-run heal digest (report.ts), and
    // the viewer all group on it.
    ...(mode === "heal"
      ? {
          heal: {
            from_step: r.healedFromStep,
            kind: r.healKindFirst ?? r.healKind,
            reason: r.healReasonFirst ?? r.healReason,
            // Re-anchor provenance (docs/contracts/engine.md#act-and-heal):
            // one { from, to } per heal segment (`to` = the baseline step where
            // replay resumed, null when the segment ran to the end) and the
            // total agent-mode envelope count across segments — the cost story
            // of the heal in two numbers.
            segments: r.healSegments,
            agent_steps: r.envelopes.filter((e: DynamicValue) => e.mode === "agent").length,
            // Heal triage (docs/contracts/engine.md#act-and-heal). Present only
            // once triage has run (api heals), so a web heal's manifest keeps
            // exactly the three fields it always had.
            ...(r.healTriage
              ? { classification: r.healTriage.classification, signals: r.healTriage.signals }
              : {}),
            // Emitted alongside the classification, so a web/mobile heal's block
            // keeps exactly the three fields it always had.
            ...(r.healTriage && r.healAccepted
              ? { accepted: r.healAccepted.ok, ...(r.healAccepted.ok ? {} : { rejected_reason: r.healAccepted.reason }) }
              : {}),
          },
        }
      : {}),
    totals: {
      steps: r.envelopes.length,
      executed_steps: actionTrack(r.envelopes).length,
      // Merged actor+grader token bucket, priced per model (runTotals); the
      // manifest is rewritten with the final figure once grading is done.
      ...runTotals(rc, r),
      console_errors: consoleErrors,
      confusion_events: r.envelopes.filter((e: DynamicValue) => e.confusion).length,
      // Actor sticky notes of kind "finding" (structured raises); separate from
      // confusion_events so UX/product signal isn't lumped into flounder counts.
      finding_events: r.envelopes.reduce(
        (n: number, e: DynamicValue) => n + (Array.isArray(e.raises) ? e.raises.filter((r: DynamicValue) => r.kind === "finding").length : 0),
        0,
      ),
      // Worst navigation LCP stamped at write time (mirrors view-server worstLcp)
      // so history readers don't re-parse the trajectory per run.
      lcp_ms: worstNavLcp(r.envelopes),
    },
    // Setup phase provenance (docs/contracts/engine.md#environment-and-setup):
    // { ran, returned_context, duration_ms } when a
    // before_each hook ran; absent otherwise so hook-less manifests are unchanged.
    ...(r.setup ? { setup: r.setup } : {}),
    healed: mode === "heal",
    baseline:
      mode !== "record" && baseline
        ? { run_id: baseline.meta?.run_id ?? null, accepted_at: baseline.meta?.accepted_at ?? null }
        : null,
    artifacts: {
      trajectory: "trajectory.jsonl",
      har: "har.json",
      // null until the post-run slideshow build assigns "video.mp4" (ffmpeg
      // present); a non-null video_started_at marks a legacy webm screencast.
      video,
      // The Playwright trace exists only when a WEB run recorded under the
      // debug profile: the other two drivers never had one, and a core-profile
      // web run never starts tracing at all. Null rather than a path nothing
      // wrote — a manifest must not advertise a file that is not on disk.
      trace: (rc.env?.driver ?? "web") === "web" && profile === "debug" ? "trace.zip" : null,
      grade: willGrade ? "grade.json" : null,
      // per-turn actor context windows, for diagnostics; absent on pure act runs
      // (no model calls) and explicitly null so the viewer doesn't probe for it
      context: r.wroteContext ? "context.jsonl" : null,
      baseline_copy: mode !== "record" && baseline ? "baseline.jsonl" : null,
      // The heal's structured drift report; null on every run that did not write
      // one (docs/contracts/artifacts.md#drift-report).
      drift_report: r.driftReport ? "drift-report.json" : null,
    },
  };
}

function readHar(runDir: string): DynamicValue[] {
  try {
    const entries = JSON.parse(fs.readFileSync(`${runDir}/har.json`, "utf8")).log.entries;
    // Quarantine (docs/contracts/engine.md#invariant-policies): an observation
    // request an invariant policy issued is tagged in the HAR and must never
    // reach the gate as ordinary traffic. Stripping it HERE means every gate
    // kind — present and future — is quarantined by default rather than by
    // remembering to filter.
    return entries.filter((e: DynamicValue) => !e?._observation);
  } catch {
    return [];
  }
}

/**
 * budget's `record` cap; `Infinity` means "no cap" (the scalar
 * forms, byte-identical to the old single-pool behavior). When `total` is `true`
 * or auto, it falls back to `auto` (the default pool unless every case is a
 * managed-compose external, matching the historical auto rule in the caller).
 *
 * `grade` and `cpu` are the T4.2 tail permits. `grade` bounds BOTH how many
 * cases may sit in their grading tail detached from a worker slot and how many
 * grader calls may be in flight; `cpu` bounds concurrent ffmpeg slideshow
 * builds. Both default to `total`, which is exactly the number of cases that
 * could be grading before the split existed — so the defaults add pipelining
 * without adding load on the grader gateway. `grade: 0` opts out of the
 * hand-off entirely and restores the pre-Phase-4 shape.
 *
 * @param {number|true|{total?:number|true,record?:number,grade?:number,cpu?:number}|null} parallel
 * @param {number} auto the auto-selected pool size for this run
 * @returns {{ total: number, record: number, grade: number, cpu: number }}
 */
export function resolveBudget(parallel: DynamicValue, auto: number) {
  // Number.isFinite guards a non-finite value (NaN from a bad CLI coercion, ±Infinity)
  // from reaching schedulePool, where a NaN cap makes `recordsInFlight < record` always
  // false and parks every record worker forever. A non-finite total falls back to the
  // auto pool; a non-finite record cap falls back to Infinity (no cap) — the old
  // uncapped behavior. The CLI already rejects such values (parseCount), so this is a
  // belt-and-suspenders guard on the pure scheduler seam.
  const poolOf = (t: DynamicValue) => (t === true || t === null || !Number.isFinite(t) ? auto : Math.max(1, t));
  const capOf = (r: DynamicValue) => (r !== null && Number.isFinite(r) ? Math.max(1, r) : Infinity);
  // A tail cap of 0 is meaningful ("never detach"), so it clamps at 0, not 1.
  const tailOf = (v: DynamicValue, fallback: number) =>
    (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : fallback);
  if (typeof parallel === "number") {
    const total = poolOf(parallel);
    return { total, record: Infinity, grade: total, cpu: total };
  }
  if (parallel === true) return { total: auto, record: Infinity, grade: auto, cpu: auto };
  if (parallel && typeof parallel === "object") {
    const total = poolOf(parallel.total);
    const record = capOf(parallel.record);
    // With a finite record cap the pool is deliberately lopsided (many cheap
    // checks, few recordings) and only recordings ever grade, so the natural
    // grading headroom is the record cap, not the whole pool.
    const graded = Number.isFinite(record) ? Math.min(record, total) : total;
    return { total, record, grade: tailOf(parallel.grade, graded), cpu: Math.max(1, tailOf(parallel.cpu, total)) };
  }
  return { total: auto, record: Infinity, grade: auto, cpu: auto };
}

/**
 * A counting semaphore over `limit` permits, FIFO. `Infinity` short-circuits to
 * a plain call so the uncapped path allocates nothing.
 */
function semaphore(limit: number) {
  let inFlight = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    const next = queue.shift();
    // Hand the permit straight to the next waiter rather than dropping and
    // re-taking it: with a synchronous resume in between, a third caller could
    // otherwise slip past the cap.
    if (next) next();
    else inFlight--;
  };
  return async <T>(fn: () => T | Promise<T>): Promise<T> => {
    if (!Number.isFinite(limit)) return await fn();
    if (inFlight >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    else inFlight++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * One worker pool of `budget.total` workers running `task(item, permits)` over
 * `items`, with a record cap: at most `budget.record` items whose `.record` is
 * true may be RECORDING at once. A free worker picks the next eligible item — a
 * check (`.record` false) is always eligible; a record is eligible only while
 * `recordsInFlight < budget.record`. When the only remaining work is records and
 * the record cap is full, the worker waits for an in-flight record to finish
 * rather than busy-spinning. Original `items` order is preserved within each
 * class, so ids dispatch in a stable order. The pure scheduler — no I/O,
 * deterministic — so it can be unit-tested without a browser or a model.
 *
 * The task is handed three permits:
 *
 *   permits.release()  the case's recording is over — its browser is closed and
 *                      its environment torn down. Gives the record permit back
 *                      AND, if the tail budget allows, hands the worker slot
 *                      back too: the task keeps running (its grade, its video)
 *                      DETACHED while the worker starts the next recording.
 *                      Idempotent, and always re-run when the task settles.
 *   permits.grade(fn)  run fn under the grader cap (`budget.grade`).
 *   permits.cpu(fn)    run fn under the CPU cap (`budget.cpu`) — ffmpeg.
 *
 * A task that never calls `release` behaves exactly as it did before the split:
 * it owns its worker until it settles. `schedulePool` does not return until
 * every detached tail has settled, and rethrows the first task error only then
 * — an eager throw would abandon live tails to finish unobserved.
 *
 * @param {{ index:number, record:boolean }[]} items
 * @param {{ total:number, record:number, grade?:number, cpu?:number }} budget
 * @param {(item:object, permits:object)=>Promise<void>} task
 * @param {{ stagger?: number, sleep?: (ms:number)=>Promise<void> }} [hooks]
 */
export async function schedulePool(items: DynamicValue[], budget: DynamicValue, task: DynamicValue, hooks: DynamicValue = {}) {
  const { total, record } = budget;
  const stagger = hooks.stagger ?? (total > 1 ? 500 : 0);
  const sleep = hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // Absent from a caller that predates the split (the hosted executor passes a
  // budget straight through resolveBudget, so this is the belt): fall back to
  // the pool size, which is what could already have been grading at once.
  const tailCap = Number.isFinite(budget.grade) ? budget.grade : total;
  // `grade: 0` means "never detach", which is the pre-Phase-4 shape — and there
  // the worker count already bounds concurrent grades, so it must NOT also
  // serialize them.
  const gradePermit = semaphore(tailCap > 0 && Number.isFinite(tailCap) ? tailCap : Infinity);
  const cpuPermit = semaphore(Number.isFinite(budget.cpu) ? Math.max(1, budget.cpu) : Infinity);

  const queue = items.slice(); // FIFO; remove the chosen item to preserve order
  let recordsInFlight = 0;
  // Cases that gave their worker back and are still finishing their tail.
  let tailsInFlight = 0;
  // Cases that have finished recording and want a tail slot, oldest first. Each
  // entry claims a slot and returns true, or declines (already settled) so the
  // slot passes on.
  const wantsTail: (() => boolean)[] = [];
  const admitTails = () => {
    while (tailsInFlight < tailCap && wantsTail.length) {
      if (wantsTail.shift()!()) break;
    }
  };
  // Tails still running; the pool must outlive its workers by exactly this much.
  const tails = new Set<Promise<void>>();
  let firstError: DynamicValue = null;
  // Wakeups for workers parked because every remaining item is a record and the
  // record permit is full; resolved each time a record completes.
  let waiters: DynamicValue[] = [];
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

  const worker = async (slot: number) => {
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
      let holdsRecord = Boolean(item.record);
      let detached = false;
      let settled = false;
      let freeSlot: () => void = () => {};
      const slotFree = new Promise<void>((resolve) => { freeSlot = resolve; });
      // Claim a tail slot and hand the worker back. Returns false when there is
      // nothing to claim with (already detached, or the case finished while it
      // was queued) or no slot to claim.
      const claimTail = () => {
        if (detached || settled || tailsInFlight >= tailCap) return false;
        detached = true;
        tailsInFlight++;
        freeSlot();
        return true;
      };
      const permits = {
        release: () => {
          if (holdsRecord) {
            holdsRecord = false;
            releaseRecord();
          }
          // `release` NEVER blocks — it is announcing a teardown that already
          // happened, and waiting here would stall the tail it is freeing. With
          // the tail budget full the case simply keeps its worker and finishes
          // the way it always did, joining the queue in case a slot frees first.
          if (!claimTail() && !detached && !settled) wantsTail.push(claimTail);
        },
        grade: gradePermit,
        cpu: cpuPermit,
      };
      const running = (async () => {
        try {
          await task(item, permits);
        } catch (e) {
          firstError ??= e;
        } finally {
          settled = true;
          if (holdsRecord) {
            holdsRecord = false;
            releaseRecord();
          }
          if (detached) {
            tailsInFlight--;
            admitTails();
          }
          freeSlot();
        }
      })();
      tails.add(running);
      void running.then(() => tails.delete(running));
      await slotFree;
    }
  };

  const workers = Math.min(Math.max(1, total), items.length) || 1;
  await Promise.all(Array.from({ length: workers }, (_, slot) => worker(slot)));
  // Detached tails outlive their workers by construction; drain them (a settling
  // tail cannot start new work, so this converges).
  while (tails.size) await Promise.all([...tails]);
  if (firstError) throw firstError;
}

/**
 * Run every case, write JUnit. All console output
 * goes through `opts.reporter` ({ onEvent(event), done(results) }) so the CLI
 * chooses plain lines, a live TTY region, or silence (--json).
 * Serial for external envs; managed-only selections run parallel min(4, cores);
 * --parallel overrides. The pool is one set of `total` workers; at most `record`
 * of them may be performing a record (LLM-driven) at any instant — cheap baseline
 * checks fill the rest, so a free worker prefers a check over a blocked record and
 * the pool never stalls behind the record cap. A worker is released as soon as
 * its case stops recording, so the next recording starts while the previous case
 * is still grading (`budget.grade` bounds how many may be doing that).
 * See docs/contracts/engine.md#running-multiple-cases.
 * @returns {Promise<{ exitCode: 0|1|2, results: object[] }>}
 */
export async function runAll(resolvedCases: DynamicValue[], opts: DynamicValue): Promise<DynamicValue> {
  const reporter = opts.reporter ?? { onEvent: () => {}, done: () => {} };
  // One guard for every emission: a throwing reporter must not break the run.
  const onEvent = (event: DynamicValue) => {
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

  const results: DynamicValue[] = new Array(resolvedCases.length);
  // Front-run runCase's record/act decision (shared decideRecord core) so the
  // record cap can be enforced at dispatch. record-class cases drive the actor
  // with the model (expensive, rate-limit sensitive); checks replay a baseline.
  const items = resolvedCases.map((rc, index) => ({ index, rc, record: willRecord(rc, opts) }));

  const runItem = (rc: DynamicValue, index: number, permits: DynamicValue) =>
    runCase(rc, { ...opts, onEvent, permits }).catch((e: DynamicValue) => {
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
  // The permits ride into runCase, which hands the recording slot back once the
  // driver is closed and the environment is down, then finishes its grade and
  // its video detached from the pool (T4.2).
  await schedulePool(items, budget, async ({ rc, index }: DynamicValue, permits: DynamicValue) => {
    results[index] = await runItem(rc, index, permits);
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
}
