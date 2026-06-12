// Console reporter + JUnit XML. See docs/CONTRACTS.md §11.
// `result` is runner.runCase's return: { status: "pass"|"fail"|"infra"|"explored", runDir, manifest }.

const paint = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => paint(32, s);
const red = (s) => paint(31, s);
const yellow = (s) => paint(33, s);
const cyan = (s) => paint(36, s);
const dim = (s) => paint(2, s);

// Right-aligned to the label column. Width 5 spans the journey statuses and
// keeps journey-only output byte-identical; runs that include discovery cases
// pass "EXPLORED".length so mixed output still aligns.
const STATUS_LABEL = {
  pass: (w) => green("PASS".padStart(w)),
  fail: (w) => red("FAIL".padStart(w)),
  infra: (w) => yellow("INFRA".padStart(w)),
  explored: (w) => cyan("EXPLORED".padStart(w)),
};

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

const signedMs = (ms) => (ms < 0 ? "-" : "+") + fmtMs(Math.abs(ms));

function failedChecks(manifest) {
  return (manifest?.result?.gate?.checks ?? []).filter((c) => !c.pass);
}

// Internal mode words stay 'record'|'act'|'heal'; only display changes, and the
// tense matches the surface: the live spinner says what a run IS doing, finished
// surfaces say what it DID. The viewer keeps an inline copy of MODE_DID.
const MODE_DOING = { record: "recording", act: "checking", heal: "healing", explore: "exploring" };
const MODE_DID = { record: "recorded", act: "checked", heal: "tried to heal", explore: "explored" };

// For finished explore runs the mode label would just repeat the EXPLORED
// status; say how the exploration ended instead.
const EXPLORE_END = { done: "finished", give_up: "gave up", max_steps: "hit max steps", timeout: "timed out", error: "errored" };

/** In-progress label for the live display. */
export function modeDoing(mode) {
  return MODE_DOING[mode] ?? mode;
}

/** User-facing label for a finished run's mode; a healed pass is a "changed" journey. */
export function modeLabel(mode, { healed = false, status } = {}) {
  if (healed && status === "pass") return "changed";
  return MODE_DID[mode] ?? mode;
}

/**
 * One console line (plus indented gate failures) for one run. `trend` is the
 * case's movement vs prior runs (computed in cli.js); zero deltas are
 * suppressed — they read as no movement.
 * @param {{ duration_delta_ms?: number|null, score_delta?: number|null,
 *           status_streak?: string|null }|null} [trend]
 */
export function caseLine(result, trend = null, labelWidth = 5) {
  const m = result.manifest ?? {};
  const status = result.status ?? "infra";
  const label = STATUS_LABEL[status]?.(labelWidth) ?? status;
  const id = m.case?.id ?? "?";

  const bits = [];
  if (m.mode === "explore") bits.push(EXPLORE_END[m.result?.end_reason] ?? modeLabel(m.mode, { healed: m.healed, status }));
  else if (m.mode) bits.push(modeLabel(m.mode, { healed: m.healed, status }));
  if (m.totals?.steps != null) bits.push(`${m.totals.steps} steps`);
  if (m.duration_ms != null) {
    bits.push(fmtMs(m.duration_ms) + (trend?.duration_delta_ms ? ` (${signedMs(trend.duration_delta_ms)})` : ""));
  }
  if (result.score != null) {
    const d = trend?.score_delta;
    bits.push(`score ${Math.round(result.score)}${d ? ` (${d > 0 ? "+" : ""}${Math.round(d)} vs last graded run)` : ""}`);
  }
  if (m.totals?.cost_usd) bits.push(`$${m.totals.cost_usd.toFixed(2)}`);
  if (trend?.status_streak) bits.push(trend.status_streak);

  let line = `${label} ${id}${bits.length ? dim(`  ${bits.join(" · ")}`) : ""}`;
  if (status === "fail") {
    for (const c of failedChecks(m)) line += `\n        ${red("x")} ${c.spec} ${dim(`— ${c.detail}`)}`;
  } else if (status === "infra") {
    const why = result.error ?? m.result?.end_reason;
    if (why) line += yellow(`  (${why})`);
  }
  return line;
}

/** Totals line for a set of runs. */
export function summary(results) {
  const counts = { pass: 0, fail: 0, infra: 0, explored: 0 };
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
  ].filter(Boolean);
  return `\n${parts.join(", ")} · ${results.length} run(s) · ${fmtMs(duration)} · $${cost.toFixed(2)}`;
}

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** JUnit XML: one <testsuite> per top-level case directory, one <testcase> per run. */
export function junitXml(results) {
  const suites = new Map();
  for (const r of results) {
    const id = r.manifest?.case?.id ?? "unknown";
    const suite = id.includes("/") ? id.slice(0, id.indexOf("/")) : "(root)";
    if (!suites.has(suite)) suites.set(suite, []);
    suites.get(suite).push(r);
  }

  const totals = { tests: 0, failures: 0, errors: 0, time: 0 };
  const suitesXml = [];
  for (const [name, runs] of suites) {
    const failures = runs.filter((r) => r.status === "fail").length;
    const errors = runs.filter((r) => r.status === "infra").length;
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
      return `${open}/>`;
    });

    suitesXml.push(
      `  <testsuite name="${esc(name)}" tests="${runs.length}" failures="${failures}"` +
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
