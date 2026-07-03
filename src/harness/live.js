// Live TTY reporter: one updating
// line per active case at the bottom of the output; finished case lines,
// heal transitions, gate failures and warnings print permanently above it, so
// scrollback reads exactly like the plain reporter. TTY-only by construction —
// the CLI falls back to the plain reporter for pipes, --plain, --ci, --json.
// Every write during a run must go through this class: a console.* from
// elsewhere would land inside the live region and corrupt the redraw math.
import { caseLine, summary, healDigest, modeDoing, PHASE_DOING } from "./report.js";
import { shortModel } from "./llm.js";

// Shared with GradeSpinner (and any future single-line spinner): the frame
// glyphs and redraw cadence are the one true source for "live" output.
export const SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const REDRAW_MS = 100;

// Unconditional ANSI: these reporters only exist when stdout is a TTY.
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const SEP = dim(" · ");

// The live retry-countdown label for an in-flight LLM backoff, shared by the
// run reporter and the grade spinner so both phrase a 429/5xx/network wait
// identically. `retry` is { status, attempt, maxAttempts, until }; ceil so it
// never reads "0s" mid-wait, clamped at 0 once elapsed. 429 is the only true
// rate-limit; any other 5xx is a generic "<code> error"; a null status is a
// network error (no code to show).
export function retryLabel(retry, now = Date.now()) {
  const left = Math.max(0, Math.ceil((retry.until - now) / 1000));
  const s = retry.status;
  const label = s === 429 ? "429 rate-limited" : s ? `${s} error` : "network error";
  return `${label} — retry ${retry.attempt}/${retry.maxAttempts}, retrying in ${left}s`;
}

// 8231 → "8.2k", 980 → "980". Compact so the token readout fits the tail.
const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// The model display label for the vitals row: shortModel() collapses a known
// model to its enum / strips the gateway prefix, then long names clip past 16
// chars (full value never lost — it rides the run manifest + viewer). null/""
// model (none configured) renders no chip.
const MODEL_MAX = 16;
function modelLabel(model) {
  if (!model) return null;
  const s = shortModel(model);
  return s.length > MODEL_MAX ? s.slice(0, MODEL_MAX - 1) + "…" : s;
}

// Flatten any whitespace run (including embedded newlines) to a single space:
// every live line must render as exactly one terminal row, and a step summary
// is free actor text that can contain newlines.
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

// Post-actor phases whose work runs on the grader model, not the actor model
// (gate = assert: criteria; grading = the final grade). The vitals model chip
// swaps to the grader label once one of these starts so it names the model
// actually doing the work — otherwise it would keep showing the actor model
// through grading (case_start carries both actorModel + graderModel).
const GRADER_PHASES = new Set(["gate", "grading"]);

// The token readout as separate ·-joinable segments: "ctx 3.4k" (current
// context-window size) and "↑17.7k ↓1.3k" (cumulative in/out). ctx is absent on
// turns with no model call (acted/healed replay, actor error); the cumulative
// segment drops while still zero. Returns [] when there is nothing to show.
function tokenBits(t) {
  if (!t) return [];
  const parts = [];
  if (t.ctx) parts.push(`ctx ${kfmt(t.ctx)}`);
  if (t.in || t.out) parts.push(`↑${kfmt(t.in)} ↓${kfmt(t.out)}`);
  return parts;
}

export class LiveReporter {
  #out;
  #active = new Map(); // caseId → live line state
  #drawn = 0; // lines currently on screen below the permanent output
  #frame = 0;
  #lastDraw = 0;
  #timer;
  #onSigint;
  #trendFor; // result → caseLine trend (cli.js computes it from the pre-run scan)
  #labelWidth; // status-label column width (widened when the run has discovery cases)

  // `out` is injectable purely for the offline unit test (a fake stream);
  // production always uses process.stdout.
  constructor({ trendFor = () => null, labelWidth = 5, out = process.stdout } = {}) {
    this.#trendFor = trendFor;
    this.#labelWidth = labelWidth;
    this.#out = out;
    this.#timer = setInterval(() => this.#draw(true), REDRAW_MS);
    this.#timer.unref(); // the renderer must never keep the process alive,
    // Ctrl-C mid-run to clear the live region so the terminal is left clean, then re-raise so
    // the default handler still terminates the process.
    this.#onSigint = () => {
      this.#stop();
      process.kill(process.pid, "SIGINT");
    };
    process.once("SIGINT", this.#onSigint);
  }

  onEvent(ev) {
    const key = ev.caseId;
    const c = this.#active.get(key);
    switch (ev.type) {
      case "case_start":
        this.#active.set(key, {
          id: ev.caseId,
          mode: modeDoing(ev.mode),
          actorMode: modeDoing(ev.mode), // the actor mode word (record/act/explore→heal); step_start restores mode to it after a phase
          graderModel: modelLabel(ev.graderModel), // swapped in once a grader phase (gate/grading) starts
          model: modelLabel(ev.actorModel), // the chip currently shown; starts as the actor model
          step: 0,
          maxSteps: ev.maxSteps,
          summary: null,
          retry: null, // { status, attempt, maxAttempts, until } during an LLM backoff
          post: false, // true once a post-actor phase has cleared the summary (no actor action to show)
          tokens: null, // { ctx, in, out } once the first model turn lands
          startedAt: Date.now(),
        });
        this.#draw(true);
        this.#draw(true);
        break;
      case "step_start":
        if (!c) break;
        c.step = ev.step;
        c.summary = ev.summary;
        c.retry = null;
        c.phase = false;
        // Restore the actor mode word: a pre-actor phase (setup) promoted `mode`
        // to "setting up" before the loop began, and unlike the post-actor phases
        // an actor step follows it — so without this the line would stay stuck on
        // "setting up" through the whole record/act loop (the reported bug).
        c.mode = c.actorMode;
        this.#draw();
        break;
      case "retry": {
        if (!c) break;
        // A gateway 429/5xx backoff. Store the deadline (`until`) so #line can
        // tick the countdown down on the redraw interval — a static label would
        // freeze (and read stale) if the run is aborted mid-wait. `status` is
        // null for a network error. Cleared by the next step_start/result/phase/grading.
        c.retry = { status: ev.status, attempt: ev.attempt, maxAttempts: ev.maxAttempts, until: Date.now() + ev.waitMs };
        this.#draw(true);
      } break;
      case "step_result":
        if (!c) break;
        c.retry = null;
        c.cost = ev.costSoFar ?? c.cost;
        if (ev.tokens) c.tokens = ev.tokens;
        if (ev.error) c.summary = `${c.summary ?? ""} — ${ev.error}`;
        this.#draw();
        break;
      case "heal_start":
      case "heal_start":
        // The act replay drifted/failed and re-entered the record loop to recover.
        // Flip the live mode word to "healing" so the case's own spinner row shows
        // the transition in real time — but print NO permanent line. A heal fires
        // mid-run, so a permanent line interleaves with finished-case rows and
        // wrecks the ledger; the durable record is the case's "changed (healed @N)"
        // result line + the end-of-run healDigest (both from manifest.heal).
        if (c) c.mode = c.actorMode = modeDoing("heal");
        this.#draw(true);
        break;
      case "phase":
      case "grading": {
        // Post-actor phases (gate eval, manifest+teardown, grading): the actor
        // produced no more steps, so the last step summary is stale. Promote the
        // phase to the mode word and clear the action slot so the live line keeps
        // moving instead of freezing on "done: <summary>". `grading` is its own
        // legacy event; map it to the "grading" phase.
        if (!c) break;
        // A `phase` event names the phase in ev.phase; the legacy `grading`
        // event carries the phase as its own type. PHASE_DOING is keyed by
        // phase name, so resolve ev.phase first, then ev.type.
        const phase = ev.phase ?? ev.type;
        c.mode = PHASE_DOING[phase] ?? c.mode;
        // Grader-driven phases (gate assert checks, grading) run on the grader
        // model; swap the chip so it names the model actually working. Grader
        // phases only ever follow the actor phases in a run's life (heal
        // re-enters the loop before the gate), so we never need to swap back —
        // the neutral `finishing` between gate and grading just keeps the chip
        // rather than flashing back to the actor model.
        if (GRADER_PHASES.has(phase) && c.graderModel) c.model = c.graderModel;
        c.summary = null;
        c.retry = null;
        c.phase = true;
        this.#draw(true);
        break;
      }
      case "case_end":
        this.#active.delete(key);
        this.#print(caseLine(ev.result, this.#trendFor(ev.result), this.#labelWidth));
        break;
      case "warn":
        this.#print(ev.message, process.stderr);
        break;
    }
  }

  done(results) {
    this.#stop();
    // The heal digest (which journeys healed + where) prints once, after the
    // last result row, so it reads as a durable end-of-run block rather than
    // interleaving mid-run when nothing healed.
    this.#out.write(healDigest(results));
    this.#out.write(summary(results) + "\n");
    process.removeListener("SIGINT", this.#onSigint);
  }
// [UNREADABLE lines 209-248: scrolled past, not captured in any frame]
  // [reconstruction: the unreadable region declared the private methods #draw,
  // #stop and #print (used above but not captured in any frame); stub
  // declarations inserted to balance the class and satisfy parsing — the
  // original method bodies are not recoverable]
  #draw() {}
  #stop() {}
  #print() {}

  // One active case = TWO rows. Row 1 (vitals): spinner, RUN, id, mode, model,
  // step, tokens, elapsed, cost — the slow-changing telemetry. Row 2 (detail):
  // an indented "↳ <action>" carrying the volatile step summary (or the live
  // retry countdown), which is the only part that gets clipped. Returns the
  // [vitals, detail] styled rows; #draw flattens them into the live region.
  #line(c, idW, modeW, width) {
    const head = `${SPINNER[this.#frame]} `;
    const stepText = `step ${c.step}/${c.maxSteps}`;
    const elapsed = `${((Date.now() - c.startedAt) / 1000).toFixed(1)}s`;
    const dollars = c.cost > 0 ? `$${c.cost.toFixed(2)}` : null;
    const toks = tokenBits(c.tokens).map((t) => dim(t));
    const id = c.id.padEnd(idW);

    // Row 1 — vitals (styled segments joined by SEP). The model chip rides right
    // after the mode word; absent when no model is configured. Overflow here is
    // rare (no free text) so the vitals row is never clipped — only the detail row.
    const seg = [
      `${head}${cyan("RUN")}  ${id}`,
      dim(c.mode.padEnd(modeW)),
      ...(c.model ? [dim(c.model)] : []),
      cyan(stepText),
      ...toks,
      dim(elapsed),
      ...(dollars ? [dollars] : []), // normal weight: the cost pops
    ];
    const vitals = seg.join(SEP);

    // Row 2 — detail. A live retry countdown supersedes the step summary while a
    // backoff is in flight (it ticks down on the redraw interval; a static label
    // would freeze and read stale if the run is aborted mid-wait). Collapse any
    // embedded newlines: a step summary is free actor text ("done: <summary>")
    // that can span lines, and each live row MUST occupy exactly one terminal
    // row or the cursor-up redraw math undercounts and orphans rows. The detail
    // is indented to align under the id; an empty summary keeps the block two
    // rows. Pre-first-step that reads "starting…"; in a post-actor phase (gate /
    // grading) there is no actor action, so echo the phase as a "<mode>…"
    // placeholder rather than the misleading "starting…".
    const indent = "  "; // aligns under " RUN "
    let action = oneLine(c.retry ? retryLabel(c.retry) : (c.summary ?? ""));
    const placeholder = !action;
    if (placeholder) action = c.phase ? `${c.mode}…` : "starting…";
    if (placeholder) action = c.phase ? `${c.mode}…` : "starting…";
    // Clip the action to the linewidth (minus the "↳ " marker + indent).
    const room = (width - 1) - indent.length - 2;
    if (action.length > room && room > 1) action = action.slice(0, room - 1) + "…";
    const arrow = dim("↳");
    const text = placeholder ? dim(action) : bold(action);
    const detail = `${indent}${arrow} ${text}`;
    return [vitals, detail];
  }
}

// A single self-updating spinner line for a one-shot operation whose only live
// signal is "still working" plus the occasional LLM-backoff countdown — today
// just `playtest grade`, which makes one or more grader calls (a fetch loop +
// the grade) against an already-recorded run. It carries none of LiveReporter's
// per-step/result machinery (a grade has no steps), but renders the SAME
// " · "-joined segment line — `<spinner> GRADE  <id> · grading · <elapsed>` —
// using the shared SPINNER frames, redraw cadence, retryLabel phrasing and
// erase/SIGINT contract so it reads like the run animation. TTY-only by
// construction — the caller falls back to silent grading when stdout is piped.
export class GradeSpinner {
  #out;
  #mode;
  #id;
  #model; // short grader-model label for the chip, or null
  #fetching = null; // "fetching step N" while the grader pulls a snapshot, else null
  #startedAt = Date.now();
  #retry = null; // { status, attempt, maxAttempts, until } during an LLM backoff
  #drawn = false;
  #timer;
  #onAbort;

  // `mode` is the status word ("grading"); `id` (optional) names the run in the
  // id column, mirroring the run line. `out` is injectable purely for the
  // offline unit test (a fake stream); production always uses process.stdout.
  constructor(mode = "grading", { id = null, model = null, onAbort = () => {}, out = process.stdout } = {}) {
    this.#mode = mode;
    this.#id = id;
    this.#model = modelLabel(model);
    this.#onAbort = onAbort;
    this.#out = out;
    this.#timer = setInterval(() => this.#draw(), REDRAW_MS);
    this.#timer.unref(); // the renderer must never keep the process alive
    process.once("SIGINT", this.handleSigint);
    this.#draw();
  }

  // Ctrl-C mid-grade: abort the in-flight grader call (so a 429 backoff stops
  // promptly), clear the line so the terminal is left clean, then re-raise so
  // the default handler still terminates the process. Bound (arrow field) so
  // process.removeListener matches and the unit test can call it directly.
  handleSigint = () => {
    this.#onAbort();
    this.stop();
    process.kill(process.pid, "SIGINT");
  };

  // gradeRun's onRetry payload — store the deadline so the countdown ticks down
  // on the redraw interval and never freezes if the grade is aborted mid-wait.
  onRetry({ status, attempt, maxAttempts, waitMs }) {
    this.#retry = { status, attempt, maxAttempts, until: Date.now() + waitMs };
    this.#draw();
  }

  // gradeRun's onFetch payload — show "fetching step N" in the action slot while
  // the grader pulls a step's snapshot; `null`/no step returns to plain grading.
  onFetch(ev) {
    this.#fetching = ev && ev.step != null ? `fetching step ${ev.step}` : null;
    this.#draw();
  }

  stop() {
    clearInterval(this.#timer);
    process.removeListener("SIGINT", this.handleSigint);
    if (this.#drawn) {
      this.#out.write("\r\x1b[2K");
      this.#drawn = false;
    }
  }

  #draw() {
    const frame = SPINNER[Math.floor((Date.now() - this.#startedAt) / REDRAW_MS) % SPINNER.length];
    const elapsed = `${((Date.now() - this.#startedAt) / 1000).toFixed(1)}s`;
    // A retry countdown supersedes everything; else "fetching step N" rides the
    // action slot while a snapshot is in flight, else just the mode word.
    const seg = [];
    if (this.#retry) {
      seg.push(cyan("GRADE"));
      if (this.#id) seg.push(this.#id);
      seg.push(bold(retryLabel(this.#retry)));
    } else {
      seg.push(cyan("GRADE"));
      if (this.#id) seg.push(this.#id);
      seg.push(dim(this.#mode));
      if (this.#model) seg.push(dim(this.#model));
      if (this.#fetching) seg.push(bold(this.#fetching));
    }
    seg.push(dim(elapsed));
    this.#out.write(`\r\x1b[2K${frame} ${seg.join(SEP)}`);
    this.#drawn = true;
  }
}
