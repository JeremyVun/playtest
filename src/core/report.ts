// Console reporter + JUnit XML. See docs/contracts/interfaces.md#reporting-api.
// `result` is runner.runCase's return:
// { status: "pass"|"fail"|"infra"|"explored"|"interrupted", runDir, manifest }.

export type RunStatus = "pass" | "fail" | "infra" | "explored" | "interrupted";

interface GateCheck {
  pass: boolean;
  spec: string;
  detail: string;
  severity?: string;
}

interface ReportManifest {
  case?: { id?: string };
  mode?: string;
  baseline?: unknown;
  healed?: boolean;
  heal?: {
    from_step?: number;
    classification?: string;
    kind?: string;
  };
  result?: {
    end_reason?: string;
    gate?: { checks?: GateCheck[] };
  };
  totals: {
    steps?: number;
    bug_candidates?: number;
    cost_usd?: number;
  };
  duration_ms?: number;
}

export interface ReportResult {
  status: RunStatus;
  runDir?: string;
  manifest: ReportManifest;
  score?: number | null;
  error?: unknown;
}

export interface RunTrend {
  duration_delta_ms?: number | null;
  score_delta?: number | null;
  status_streak?: string | null;
}

type HealedReportResult = ReportResult & {
  manifest: ReportManifest & { healed: true };
};

const paint = (code: number, s: string): string => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string): string => paint(32, s);
const red = (s: string): string => paint(31, s);
const yellow = (s: string): string => paint(33, s);
const cyan = (s: string): string => paint(36, s);
const dim = (s: string): string => paint(2, s);

// Right-aligned to the label column. Width 5 spans the journey statuses and
// keeps journey-only output byte-identical; runs that include discovery cases
// pass "EXPLORED".length so mixed output still aligns.
const STATUS_LABEL: Record<RunStatus, (width: number) => string> = {
  pass: (w: number) => green("PASS".padStart(w)),
  fail: (w: number) => red("FAIL".padStart(w)),
  infra: (w: number) => yellow("INFRA".padStart(w)),
  explored: (w: number) => cyan("EXPLORED".padStart(w)),
  // "INTERRUPTED" overflows the journey label width (5); padStart leaves an
  // over-wide word unchanged, so the column simply isn't padded — harmless.
  interrupted: (w: number) => yellow("INTERRUPTED".padStart(w)),
};

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

const signedMs = (ms: number): string => (ms < 0 ? "-" : "+") + fmtMs(Math.abs(ms));

function failedChecks(manifest: ReportManifest): GateCheck[] {
  return (manifest?.result?.gate?.checks ?? []).filter((c) => !c.pass);
}

// Internal mode words stay 'record'|'act'|'heal'; only display changes, and the
// tense matches the surface: the live spinner says what a run IS doing, finished
// surfaces say what it DID. The viewer keeps an inline copy of MODE_DID.
const MODE_DOING: Record<string, string> = { record: "recording", act: "checking", heal: "healing", explore: "exploring" };
const MODE_DID: Record<string, string> = { record: "recorded", act: "checked", heal: "tried to heal", explore: "explored" };

// Post-actor live-display words: once the actor is done the harness still works
// (evaluate the gate, write the manifest + tear the browser/env down, grade),
// and each phase replaces the mode word so the live line keeps moving instead
// of freezing on the last step summary. Live-display only — never a finished
// surface (the case ends on case_end before any phase would have completed).
export const PHASE_DOING = { setup: "setting up", observing: "observing", gate: "evaluating gate", finishing: "saving", grading: "grading" };

// For finished explore runs the mode label would just repeat the EXPLORED
// status; say how the exploration ended instead.
const EXPLORE_END: Record<string, string> = { done: "finished", give_up: "gave up", max_steps: "hit max steps", timeout: "timed out", stuck: "got stuck", error: "errored" };

/** In-progress label for the live display. */
export function modeDoing(mode: string): string {
  return MODE_DOING[mode] ?? mode;
}

/** User-facing label for a finished run's mode; a healed pass is a "changed" journey. */
export function modeLabel(
  mode: string,
  { healed = false, status }: { healed?: boolean; status?: RunStatus } = {}
): string {
  if (healed && status === "pass") return "changed";
  return MODE_DID[mode] ?? mode;
}

/**
 * One console line (plus indented gate failures) for one run. `trend` is the
 * case's movement vs prior runs (computed in cli.ts); zero deltas are
 * suppressed — they read as no movement.
 */
export function caseLine(result: ReportResult, trend: RunTrend | null = null, labelWidth = 5): string {
  const m = result.manifest ?? {};
  const status = result.status ?? "infra";
  const label = STATUS_LABEL[status]?.(labelWidth) ?? status;
  const id = m.case?.id ?? "?";

  const bits = [];
  if (m.mode === "explore") bits.push(EXPLORE_END[m.result?.end_reason as string] ?? modeLabel(m.mode, { healed: m.healed, status }));
  // A plain "record" with no baseline rode along (first run, or a prior run that
  // failed and so never saved a path) says so: it explains why this run derived
  // the journey afresh instead of checking against a saved path.
  else if (m.mode === "record" && m.baseline == null) bits.push(`${modeLabel(m.mode, { healed: m.healed, status })} (no baseline)`);
  else if (m.mode) {
    // A healed pass reads "changed"; append the step it diverged at so the ledger
    // says WHERE the recovery began at a glance (the verbose reason rides the
    // manifest + the end-of-run digest, not this line).
    const label = modeLabel(m.mode, { healed: m.healed, status });
    const at = status === "pass" && m.healed && m.heal?.from_step != null ? ` (healed @${m.heal.from_step})` : "";
    bits.push(label + at);
  }
  if (m.totals?.steps != null) bits.push(`${m.totals.steps} steps`);
  if (m.duration_ms != null) {
    bits.push(fmtMs(m.duration_ms) + (trend?.duration_delta_ms ? ` (${signedMs(trend.duration_delta_ms)})` : ""));
  }
  if (result.score != null) {
    const d = trend?.score_delta;
    bits.push(`score ${Math.round(result.score)}${d ? ` (${d > 0 ? "+" : ""}${Math.round(d)} vs last graded run)` : ""}`);
  }
  // Discovery-only projection of typed bug candidates the grader emitted; guarded
  // on a positive count so journey lines stay byte-identical (P1).
  if (m.totals?.bug_candidates! > 0) bits.push(`${m.totals.bug_candidates} bug candidate${m.totals.bug_candidates === 1 ? "" : "s"}`);
  if (m.totals?.cost_usd) bits.push(`$${m.totals.cost_usd.toFixed(2)}`);
  if (trend?.status_streak) bits.push(trend.status_streak);

  let line = `${label} ${id}${bits.length ? dim(`  ${bits.join(" · ")}`) : ""}`;
  if (status === "fail") {
    const failures = failedChecks(m);
    for (const c of failures) {
      // Soft failures (console_errors / perf) still fail the run but didn't
      // block the baseline; mark them so the FAIL reads as advisory, not a
      // blocked regression.
      const soft = c.severity === "soft";
      const mark = soft ? yellow("!") : red("x");
      line += `\n        ${mark} ${c.spec}${soft ? dim(" (soft)") : ""} ${dim(`— ${c.detail}`)}`;
    }
    // Only soft checks failed: the agent reached the goal, so the path was saved
    // as the baseline even though the run is FAIL. Say so — it explains why a
    // re-record isn't needed.
    if (failures.length && failures.every((c) => c.severity === "soft")) {
      line += `\n        ${dim("baseline saved (only soft checks failed)")}`;
    }
  } else if (status === "infra" ) {
    const why = result.error ?? m.result?.end_reason;
    if (why) line += yellow(`  (${why})`);
  } else if (status === "interrupted") {
    line += yellow("  (interrupted)");
    const why = result.error ?? m.result?.end_reason;
    if (why) line += yellow(`  (${why})`);
  }
  return line;
}

const HEAL_PHRASE: Record<string, string> = {
  drift: "saved paths drifted, agent recovered",
  action_failed: "recorded actions failed, agent recovered",
  // Heal triage (docs/contracts/engine.md#act-and-heal) answers a sharper
  // question than the escalation cause did, so an API heal groups by its
  // classification instead. `regression` never appears here: a regression is
  // refused, so it is a failed case with its reason on the result line.
  contract_drift: "the API's surface changed, agent rebound the journey",
  baseline_drift: "the environment moved, agent rebuilt the state",
};

export function healDigest(results: ReportResult[]): string {
  const healed = results.filter(
    (r): r is HealedReportResult => r.status === "pass" && r.manifest?.healed as boolean
  );
  if (!healed.length) return "";
  const groups = new Map<string, HealedReportResult[]>(); // classification (or escalation kind) -> runs, first-seen order
  for (const r of healed) {
    const kind = r.manifest.heal?.classification ?? r.manifest.heal?.kind ?? "drift";
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind)!.push(r); // TODO(ts): the preceding branch initializes every missing group
  }
  const idW = Math.max(...healed.map((r) => (r.manifest.case?.id ?? "?").length));
  const blocks = [];
  for (const [kind, runs] of groups) {
    const head = dim(`${runs.length} healed · ${HEAL_PHRASE[kind] ?? "agent recovered"}:`);
    const rows = runs.map((r) => {
      const id = (r.manifest.case?.id ?? "?").padEnd(idW);
      const step = r.manifest.heal?.from_step;
      return dim(`     ${id} ${step != null ? `step ${step}` : "—"}`);
    });
    blocks.push([head, ...rows].join("\n"));
  }
  return "\n" + blocks.join("\n") + "\n";
}

/** Totals line for a set of runs. */
export function summary(results: ReportResult[]): string {
  const counts: Record<RunStatus, number> = { pass: 0, fail: 0, infra: 0, explored: 0, interrupted: 0 };
  let duration = 0;
  let cost = 0;
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    duration += r.manifest?.duration_ms ?? 0;
    cost += r.manifest?.totals?.cost_usd ?? 0;
  }
  // "0 passed" anchors the line for journey runs; an all-discovery run reads
  // "N explored" alone.
  const parts = [
    counts.pass > 0 ? green(`${counts.pass} passed`) : counts.explored > 0 ? null : "0 passed",
    counts.explored > 0 ? cyan(`${counts.explored} explored`) : null,
    counts.fail > 0 ? red(`${counts.fail} failed`) : null,
    counts.infra > 0 ? yellow(`${counts.infra} infra`) : null,
    counts.interrupted > 0 ? yellow(`${counts.interrupted} interrupted`) : null,
  ].filter(Boolean);
  return `\n${parts.join(", ")} · ${results.length} run(s) · ${fmtMs(duration)} · $${cost.toFixed(2)}`;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c] as string);

/** JUnit XML: one <testsuite> per top-level case directory, one <testcase> per run. */
export function junitXml(results: ReportResult[]): string {
  const suites = new Map<string, ReportResult[]>();
  for (const r of results) {
    const id = r.manifest?.case?.id ?? "unknown";
    const suite = id.includes("/") ? id.slice(0, id.indexOf("/")) : "(root)";
    if (!suites.has(suite)) suites.set(suite, []);
    suites.get(suite)!.push(r); // TODO(ts): the preceding branch initializes every missing suite
  }

  const totals = { tests: 0, failures: 0, errors: 0, time: 0 };
  const suitesXml: string[] = [];
  for (const [name, runs] of suites) {
    const failures = runs.filter((r) => r.status === "fail").length;
    // An interrupted (Ctrl-C'd) run is an error, same bucket as infra.
    const errors = runs.filter((r) => r.status === "infra" || r.status === "interrupted").length;
    const time = runs.reduce((s, r) => s + (r.manifest?.duration_ms ?? 0), 0) / 1000;
    totals.tests += runs.length;
    totals.failures += failures;
    totals.errors += errors;
    totals.time += time;

    const cases = runs.map((r) => {
      const m = r.manifest ?? {};
      const open =
        `    <testcase classname="${esc(name)}" name="${esc(m.case?.id ?? "unknown")}"` +
        ` time="${((m.duration_ms ?? 0) / 1000).toFixed(3)}"`;
      if (r.status === "fail") {
        const failed = failedChecks(m);
        const message = failed.map((c) => c.spec).join("; ") || `gate failed (${m.result?.end_reason ?? "unknown"})`;
        const body = failed.map((c) => `${c.spec}\n  ${c.detail}`).join("\n");
        return `${open}>\n      <failure message="${esc(message)}">${esc(body)}</failure>\n    </testcase>`;
      }
      if (r.status === "infra") {
        const why = r.error ?? m.result?.end_reason ?? "environment error";
        return `${open}>\n      <error message="${esc(why)}"/>\n    </testcase>`;
      }
      if (r.status === "interrupted") {
        return `${open}>\n      <error message="interrupted"/>\n    </testcase>`;
      }
      return `${open}/>`;
    });

    suitesXml.push(
      `<testsuite name="${esc(name)}" tests="${runs.length}" failures="${failures}"` +
      ` errors="${errors}" time="${time.toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>`,
    );
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" time="${totals.time.toFixed(3)}">`,
    ...suitesXml,
    `</testsuites>`,
    ``,
  ].join("\n");
}
