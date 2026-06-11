// Live TTY reporter: one updating
// line per active case at the bottom of the output; finished case lines,
// heal transitions, gate failures and warnings print permanently above it, so
// scrollback reads exactly like the plain reporter. TTY-only by construction —
// the CLI falls back to the plain reporter for pipes, --plain, --ci, --json.
// Every write during a run must go through this class: a console.* from
// elsewhere would land inside the live region and corrupt the redraw math.
import { caseLine, summary, modeLabel } from "./report.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REDRAW_MS = 100;

// Unconditional ANSI: this reporter only exists when stdout is a TTY.
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

export class LiveReporter {
  #out = process.stdout;
  #active = new Map(); // "caseId#runIndex" -> live line state
  #drawn = 0; // lines currently on screen below the permanent output
  #frame = 0;
  #lastDraw = 0;
  #timer;
  #onSigint;
  #trendFor; // result -> caseLine trend (cli.js computes it from the pre-run scan)

  constructor({ trendFor = () => null } = {}) {
    this.#trendFor = trendFor;
    this.#timer = setInterval(() => this.#draw(true), REDRAW_MS);
    this.#timer.unref(); // the renderer must never keep the process alive
    // Ctrl-C mid-run: clear the live region so the terminal is left clean,
    // then re-raise so the default handler still terminates the process.
    this.#onSigint = () => {
      this.#stop();
      process.kill(process.pid, "SIGINT");
    };
    process.once("SIGINT", this.#onSigint);
  }

  onEvent(ev) {
    const key = `${ev.caseId}#${ev.runIndex}`;
    const c = this.#active.get(key);
    switch (ev.type) {
      case "case_start":
        this.#active.set(key, {
          id: ev.caseId,
          mode: modeLabel(ev.mode),
          step: 0,
          maxSteps: ev.maxSteps,
          summary: null,
          cost: 0,
          startedAt: Date.now(),
        });
        this.#draw(true);
        break;
      case "step_start":
        if (!c) break;
        c.step = ev.step;
        c.summary = ev.summary;
        this.#draw();
        break;
      case "step_result":
        if (!c) break;
        c.cost = ev.costSoFar ?? c.cost;
        if (!ev.ok && ev.error) c.summary = `${c.summary ?? ""} — ${ev.error}`;
        this.#draw();
        break;
      case "heal_start":
        if (c) c.mode = modeLabel("heal");
        this.#print(dim(`healing ${ev.caseId} from step ${ev.failedStep}`));
        break;
      case "grading":
        if (!c) break;
        c.summary = "grading";
        this.#draw();
        break;
      case "gate_fail":
        // Immediate signal; caseLine repeats the detail when the case ends.
        for (const check of ev.checks ?? []) {
          this.#print(`${red("x")} ${ev.caseId}  ${check.spec} ${dim(`— ${check.detail}`)}`);
        }
        break;
      case "case_end":
        this.#active.delete(key);
        this.#print(caseLine(ev.result, this.#trendFor(ev.result)));
        break;
      case "warn":
        this.#print(ev.message, process.stderr);
        break;
    }
  }

  done(results) {
    this.#stop();
    this.#out.write(summary(results) + "\n");
    process.removeListener("SIGINT", this.#onSigint);
  }

  #stop() {
    clearInterval(this.#timer);
    this.#erase();
  }

  #erase() {
    if (!this.#drawn) return;
    this.#out.write(`\x1b[${this.#drawn}A\x1b[J`);
    this.#drawn = 0;
  }

  /** Permanent line: erase the live region, print, redraw below. */
  #print(text, stream = this.#out) {
    this.#erase();
    stream.write(text + "\n");
    this.#draw(true);
  }

  #draw(force = false) {
    const now = Date.now();
    if (!force && now - this.#lastDraw < REDRAW_MS) return; // the interval catches up
    this.#lastDraw = now;
    this.#frame = (this.#frame + 1) % SPINNER.length;

    const cases = [...this.#active.values()];
    const idW = Math.max(0, ...cases.map((c) => c.id.length));
    const modeW = "recording".length;
    const width = this.#out.columns || 80;
    const lines = cases.map((c) => this.#line(c, idW, modeW, width));

    // Cursor-up over the old region, rewrite each line in place, clear leftovers.
    let buf = this.#drawn > 0 ? `\x1b[${this.#drawn}A` : "";
    for (const line of lines) buf += `\r\x1b[2K${line}\n`;
    if (this.#drawn > lines.length) buf += "\x1b[J";
    if (buf) this.#out.write(buf);
    this.#drawn = lines.length;
  }

  #line(c, idW, modeW, width) {
    const head = `${SPINNER[this.#frame]} `;
    const tail = ` ${((Date.now() - c.startedAt) / 1000).toFixed(1)}s${c.cost > 0 ? `  $${c.cost.toFixed(2)}` : ""}`;
    let mid = ` ${c.id.padEnd(idW)}  ${c.mode.padEnd(modeW)}  step ${c.step}/${c.maxSteps}${c.summary ? `  ${c.summary}` : ""}`;
    // Truncate by visible length: only "RUN" carries escapes, added after the cut.
    const over = head.length + 3 + mid.length + tail.length - (width - 1);
    if (over > 0) mid = mid.slice(0, Math.max(0, mid.length - over - 1)) + "…";
    return `${head}${cyan("RUN")}${mid}${dim(tail)}`;
  }
}
