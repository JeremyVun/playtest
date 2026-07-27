// Pure, deterministic anomaly extractor over recorded run evidence.
// See docs/contracts/engine.md#grading.
//
// It reads ONLY recorded envelope fields (network requests, console/page errors,
// harness-computed confusion markers, perf metrics) and emits FACTUAL signals —
// never verdicts. A 404 may be intended; a no-effect click may be a correctly
// disabled control. Classification is the grader's job (in the context of the
// story, trajectory, actor raises, and snapshots); this module only surfaces the
// cheap evidence the grader would otherwise have to reconstruct from the digest.
//
// Signal types (the fine-grained evidence vocabulary the discovery grader cites
// in a candidate's `signals`): http_4xx, http_5xx, console_exception,
// failed_action, no_effect, repeated_action, perf_budget. The coarse D4
// `signal_type` used for exact keys is derived later, server-side (P2), from
// trusted context — never authored here or by the model.
import type { StepEnvelope } from "./trajectory.ts";
import type { PerfConfig } from "./types.ts";

type ComparisonOperator = "<" | "<=" | ">" | ">=";
type PerfMetric = keyof PerfConfig;
export type AnomalyType =
  | "http_4xx"
  | "http_5xx"
  | "console_exception"
  | "failed_action"
  | "no_effect"
  | "repeated_action"
  | "perf_budget";

export interface AnomalySignal {
  type: AnomalyType;
  step: number | null;
  detail: string;
  locus?: {
    route: string | null;
    status_class: "4xx" | "5xx" | "ok";
  };
}

interface ParsedThreshold {
  op: ComparisonOperator;
  limit: number;
}

interface ParsedBudget extends ParsedThreshold {
  key: PerfMetric;
}

const oneLine = (s: unknown): string => String(s ?? "").replace(/\s*\n\s*/g, " ").trim();

/** "< 2500" / "<= 2500" / ">= 10" / "> 10"; a bare number means "<= n". */
function parseThreshold(threshold: string | number): ParsedThreshold | null {
  if (typeof threshold === "number") return { op: "<=", limit: threshold };
  const m = String(threshold).trim().match(/^(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { op: m[1] as ComparisonOperator, limit: Number(m[2]) };
}

function withinBudget(value: number, op: ComparisonOperator, limit: number): boolean {
  switch (op) {
    case "<": return value < limit;
    case "<=": return value <= limit;
    case ">": return value > limit;
    case ">=": return value >= limit;
    default: return true;
  }
}

// Only metrics the harness records per step can ground a deterministic budget
// signal. Keys mirror the perf gate (gate.js#checkPerf).
function metricValue(env: StepEnvelope, key: PerfMetric): number | undefined {
  if (key === "lcp_ms") return env?.perf?.nav?.lcp_ms;
  if (key === "input_to_paint_ms") return env?.perf?.input_to_paint_ms;
  return undefined;
}

function parseBudgets(perf: PerfConfig | null): ParsedBudget[] {
  const out: ParsedBudget[] = [];
  for (const [key, threshold] of Object.entries(perf ?? {})) {
    const parsed = parseThreshold(threshold);
    if (parsed && (key === "lcp_ms" || key === "input_to_paint_ms")) {
      out.push({ key, op: parsed.op, limit: parsed.limit });
    }
  }
  return out;
}

function statusClass(status: number): "4xx" | "5xx" | "ok" {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  return "ok";
}

/**
 * Extract factual anomaly signals from a run's step envelopes.
 *
 * `perf` is the case's perf budget map
 *   (e.g. `{ lcp_ms: "< 2500" }`); omitted ⇒ no perf_budget signals.
 * Signals are returned in trajectory order. Pure: same envelopes ⇒ same signals.
 */
export function extractAnomalies(
  envelopes: StepEnvelope[],
  { perf = null }: { perf?: PerfConfig | null } = {}
): AnomalySignal[] {
  const signals: AnomalySignal[] = [];
  const budgets = parseBudgets(perf);
  for (const env of envelopes ?? []) {
    const step = env?.step ?? null;

    // Unexpected HTTP responses. A request still pending at settle has status 0
    // (artifacts.md) and is not an error; only 4xx/5xx are surfaced.
    for (const r of env?.network?.requests ?? []) {
      const status = typeof r?.status === "number" ? r.status : 0;
      if (status < 400) continue;
      const type = status >= 500 ? "http_5xx" : "http_4xx";
      const where = r.method && r.path ? `${r.method} ${r.path}` : r.url || r.path || "request";
      signals.push({
        type,
        step,
        detail: oneLine(`${where} → ${status}`),
        locus: { route: r.path ?? r.url ?? null, status_class: statusClass(status) },
      });
    }

    // Page or console exceptions (console.error and uncaught pageerror alike).
    for (const e of env?.console_errors ?? []) {
      signals.push({
        type: "console_exception",
        step,
        detail: oneLine(`${e?.type ?? "console"}: ${e?.text ?? ""}`),
      });
    }

    // Harness-computed confusion markers (runner.js#confusionFor). state_drift is
    // a skipped step, not an app malfunction, so it is deliberately not surfaced.
    const ctype = env?.confusion?.type;
    if (ctype === "action_failed") {
      signals.push({ type: "failed_action", step, detail: oneLine(env.confusion!.note || env?.result?.error || "action failed") }); // TODO(ts): this branch requires a matching confusion marker
    } else if (ctype === "no_effect") {
      signals.push({ type: "no_effect", step, detail: oneLine(env.confusion!.note || "action produced no observable effect") }); // TODO(ts): this branch requires a matching confusion marker
    } else if (ctype === "repeated_action") {
      signals.push({ type: "repeated_action", step, detail: oneLine(env.confusion!.note || "same action repeated with no page change") }); // TODO(ts): this branch requires a matching confusion marker
    } else if (env?.result?.ok === false && env?.result?.error) {
      // An errored step with no confusion marker (e.g. a legacy envelope). A
      // state_drift skip has result.ok:false but error:null, so it is excluded.
      signals.push({ type: "failed_action", step, detail: oneLine(String(env.result.error)) });
    }

    // Deterministic performance-budget failures. Discovery runs never gate, so
    // this is the only place a latency budget is surfaced for a discovery grade.
    for (const b of budgets) {
      const value = metricValue(env, b.key);
      if (typeof value === "number" && !withinBudget(value, b.op, b.limit)) {
        signals.push({ type: "perf_budget", step, detail: `${b.key} ${value} violates ${b.op} ${b.limit}` });
      }
    }
  }
  return signals;
}

/**
 * Render a compact, model-facing signal list for the discovery grader prompt.
 * One line per signal; empty string when there are none (the caller omits the
 * whole section, mirroring the a11y/gate sections).
 */
export function formatSignals(signals: AnomalySignal[]): string {
  return (signals ?? [])
    .map((s) => `step ${s.step ?? "?"}: ${s.type}${s.detail ? ` — ${s.detail}` : ""}`)
    .join("\n");
}
