// Grader agent + natural-language assertion checker.
// See docs/contracts/engine.md#grading.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { chat, forcedToolCall, coerceStringifiedArgs, LlmError } from "./llm.ts";
import type {
  ChatMessage,
  ContentPart,
  RetryCallback,
  TokenUsage,
  ToolDefinition,
} from "./llm.ts";
import { readTrajectory, readBaseline } from "./trajectory.ts";
import type { StepEnvelope } from "./trajectory.ts";
import { describeStep } from "./actor.ts";
import { extractAnomalies, formatSignals } from "./anomalies.ts";
import type { ResolvedCase } from "./types.ts";

interface A11ySummary {
  total_violations: number;
  steps_with_violations: number;
  top_rules: Array<{ id: string; count: number; impact: string | null }>;
}

interface InvariantEvidence {
  spec: string;
  pass: boolean;
  applicable: boolean;
  detail: string;
}

interface DriftEvidence {
  classification: string | null;
  signals: Array<{ kind: string; detail: string }>;
  accepted: boolean;
  rejected_reason?: string;
}

interface ApiEvidence {
  invariants?: InvariantEvidence[];
  advisory?: InvariantEvidence[];
  drift?: DriftEvidence;
}

interface GradingManifest {
  result?: {
    gate?: {
      checks?: Array<{
        kind?: string;
        spec: string;
        pass?: boolean;
        applicable?: boolean;
        detail?: string;
      }>;
      advisory?: Array<{
        kind?: string;
        spec: string;
        pass?: boolean;
        applicable?: boolean;
        detail?: string;
      }>;
    };
  };
  artifacts?: { drift_report?: string };
  totals?: Record<string, unknown>;
}

interface DriftReportFile {
  classification?: string;
  signals?: Array<{ kind: string; detail: string }>;
  healed_run?: { accepted?: boolean; rejected_reason?: string };
}

interface StepArtifacts {
  a11y?: string;
  screenshot?: string;
  [key: string]: unknown;
}

interface FetchSnapshotArgs extends Record<string, unknown> {
  step: number;
  resources: string[];
}

export type SnapshotFetchCallback = (info: { step: unknown } | null) => void;

const here = dirname(fileURLToPath(import.meta.url));
const graderSystem = readFileSync(join(here, "prompts/grader-system.md"), "utf8").trim();
const graderDiscovery = readFileSync(join(here, "prompts/grader-discovery.md"), "utf8").trim();
const graderAssert = readFileSync(join(here, "prompts/grader-assert.md"), "utf8").trim();
const gradeSchema = JSON.parse(
  readFileSync(join(here, "schemas/grade.schema.json"), "utf8")
) as Record<string, unknown>; // TODO(ts): grade.schema.json remains the runtime source of truth
// @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor as a module namespace.
const ajv = new Ajv({ allErrors: true });
const validateGrade: ValidateFunction = ajv.compile(gradeSchema);

const GRADE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "grade",
    description: "Your structured grade of the recorded run.",
    parameters: gradeSchema,
  },
};

const oneLine = (s: unknown): string => String(s).replace(/\s*\n\s*/g, " ").trim();

// Caps a runaway fetch loop in both grader calls; on the last turn we force the
// terminal tool (grade / verdict) so a result always lands.
const MAX_GRADE_TURNS = 6;
const MAX_VERDICT_TURNS = 6;

// Compact trajectory digest: per step — action, outcome, settle, url,
// confusion, actor raises, thought, and (vision runs) the visual observation.
function digest(envelopes: StepEnvelope[]): string {
  const lines: string[] = [];
  for (const env of envelopes) {
    const what = env.mode === "error"
      ? "actor error (no valid step produced)"
      : describeStep(env);
    // A state_drift marker has result.ok:false but error:null — the recorded step
    // was SKIPPED (the page changed under it), not executed-and-errored. Render it
    // as such so the grader isn't told a step "error null"ed (matches actor.ts
    // outcomeOf); only surface `error <e>` when there is a real error message.
    const outcome =
      env.confusion?.type === "state_drift"
        ? "skipped (page drifted)"
        : env.result?.ok === false
        ? `error ${env.result.error ?? "(no message)"}`
        : "ok";
    const settle = env.result?.settle_ms != null ? `, settled in ${env.result.settle_ms}ms` : "";
    const url = env.result?.url ? `, url ${env.result.url}` : "";
    const confusion = env.confusion
      ? ` [confusion: ${env.confusion.type}${env.confusion.note ? ` — ${oneLine(env.confusion.note)}` : ""}]`
      : "";
    lines.push(`step ${env.step}: ${what} -> ${outcome}${settle}${url}${confusion}`);
    // Actor sticky notes (structured raises) — first-class, not buried in thought.
    if (Array.isArray(env.raises)) {
      for (const r of env.raises) {
        if (!r?.kind || !r?.note) continue;
        const sev = r.severity ? `/${r.severity}` : "";
        lines.push(`  raise (${r.kind}${sev}): ${oneLine(r.note)}`);
      }
    }
    if (env.agent?.thought) lines.push(`  thought: ${oneLine(env.agent.thought)}`);
    if (env.agent?.visual) lines.push(`  visual: ${oneLine(env.agent.visual)}`);
  }
  return lines.join("\n") || "(empty trajectory)";
}

/**
 * HARNESS-COMPUTED a11y summary over the run's envelopes
 * (docs/contracts/engine.md#grading). Exact
 * axe-core counts for compliance — never grader prose (which varies run to run).
 * Returns null when no envelope carried an `axe` capture (non-web, or capture
 * failed everywhere), so the `a11y` key is absent on those grades. Pure.
 */
export function a11ySummary(envelopes: StepEnvelope[]): A11ySummary | null {
  const withAxe = envelopes.filter((e) => e.axe);
  if (withAxe.length === 0) return null;
  let total = 0;
  let stepsWithViolations = 0;
  const ruleCounts = new Map<string, { count: number; impact: string | null }>(); // id → { count, impact }
  for (const e of withAxe) {
    const violations = e.axe!.violations ?? []; // TODO(ts): withAxe contains only envelopes with an axe capture
    let stepNodes = 0;
    for (const v of violations) {
      const nodes = v.nodes ?? [];
      stepNodes += nodes.length;
      total += nodes.length;
      const prev = ruleCounts.get(v.id) ?? { count: 0, impact: null };
      prev.count += nodes.length;
      // Keep the first non-null impact seen for this rule — impact is nullable in
      // the schema, so a later occurrence may carry the real severity the first
      // one lacked.
      if (prev.impact == null && v.impact !== null) prev.impact = v.impact;
      ruleCounts.set(v.id, prev);
    }
    if (stepNodes > 0) stepsWithViolations++;
  }
  const top_rules = [...ruleCounts.entries()]
    .map(([id, { count, impact }]) => ({ id, count, impact }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, 5);
  return {
    total_violations: total,
    steps_with_violations: stepsWithViolations,
    top_rules,
  };
}

/**
 * HARNESS-COMPUTED API evidence (docs/contracts/engine.md#grading): the run's
 * Tier-1/2 invariant verdicts, its advisory policy results, and — on a healed
 * API journey — the deterministic half of the drift report. Every field is read
 * from artifacts the harness itself wrote; the grader may cite them but never
 * authors them. Returns null when the run carried neither, so web and mobile
 * grades are byte-identical to before. Pure apart from reading the sibling
 * drift-report.json.
 */
export function apiEvidence(manifest: GradingManifest | null, runDir: string): ApiEvidence | null {
  const gate = manifest?.result?.gate ?? null;
  const invariants = (gate?.checks ?? [])
    .filter((c) => c.kind === "invariant")
    .map((c) => ({ spec: c.spec, pass: Boolean(c.pass), applicable: c.applicable !== false, detail: c.detail ?? "" }));
  const advisory = (gate?.advisory ?? [])
    .filter((c) => c.kind === "invariant")
    .map((c) => ({ spec: c.spec, pass: Boolean(c.pass), applicable: c.applicable !== false, detail: c.detail ?? "" }));
  let drift = null;
  const file = manifest?.artifacts?.drift_report;
  if (file && runDir) {
    try {
      const report = JSON.parse(readFileSync(join(runDir, file), "utf8")) as DriftReportFile; // TODO(ts): the harness writes this validated artifact
      drift = {
        classification: report.classification ?? null,
        signals: report.signals ?? [],
        accepted: Boolean(report.healed_run?.accepted),
        ...(report.healed_run?.rejected_reason ? { rejected_reason: report.healed_run.rejected_reason } : {}),
      };
    } catch {
      drift = null;
    }
  }
  if (!invariants.length && !advisory.length && !drift) return null;
  return {
    ...(invariants.length ? { invariants } : {}),
    ...(advisory.length ? { advisory } : {}),
    ...(drift ? { drift } : {}),
  };
}

/** A short prose digest of the API evidence for the grader prompt. */
function apiDigest(api: ApiEvidence): string {
  const lines: string[] = [];
  const render = (label: string, list?: InvariantEvidence[]): void => {
    for (const c of list ?? []) {
      const verdict = !c.applicable ? "NOT EXERCISED" : c.pass ? "held" : "VIOLATED";
      lines.push(`- ${label}${c.spec}: ${verdict} — ${c.detail}`);
    }
  };
  render("", api.invariants);
  render("(advisory) ", api.advisory);
  if (api.drift) {
    lines.push(
      `- drift report: classified "${api.drift.classification}"` +
        (api.drift.accepted ? ", and the heal was accepted" : `, and the heal was NOT accepted (${api.drift.rejected_reason ?? "see the report"})`),
    );
    for (const s of api.drift.signals ?? []) lines.push(`  - signal ${s.kind}: ${s.detail}`);
  }
  lines.push(
    "These are exact deterministic verdicts computed by the harness. Treat a violated invariant as objective evidence that the application " +
      "misbehaved and reflect it in the score; you may explain or contextualise one, but never overturn it and never call a violated invariant acceptable.",
  );
  return lines.join("\n");
}

/** A short prose digest of the a11y summary for the grader prompt (so findings
 * can reference a11y); it does NOT drive the numbers. null when no a11y data. */
function a11yDigest(summary: A11ySummary | null): string | null {
  if (!summary) return null;
  if (summary.total_violations === 0) return "axe-core (WCAG 2.0 A/AA + 2.1 AA): no violations across the run.";
  const rules = summary.top_rules.map((r) => `${r.id} (${r.count})`).join(", ");
  return (
    `axe-core (WCAG 2.0 A/AA + 2.1 AA): ${summary.total_violations} violation node(s) across ` +
    `${summary.steps_with_violations} step(s). ` +
    `Top rules: ${rules}. These are exact harness counts; you may reference them in findings but do not restate them as the verdict.`
  );
}

/**
 * Grades a finished run; writes <runDir>/grade.json and returns the grade object.
 * `signal` cancels the grader's LLM call (the grader runs after the run's
 * hard-timeout guard, so without this a 429-retry storm could hang past the
 * deadline). `onRetry` surfaces those backoffs to the reporter, same as the actor.
 * `onFetch({step})` fires when the grader pulls a step's snapshot in its fetch
 * loop (and `onFetch(null)` when it returns to producing the grade) so a live
 * spinner can show "fetching step N"; optional, ignored offline.
 */
export async function gradeRun(
  runDir: string,
  resolvedCase: ResolvedCase,
  {
    signal = null,
    onRetry = null,
    onFetch = null
  }: {
    signal?: AbortSignal | null;
    onRetry?: RetryCallback | null;
    onFetch?: SnapshotFetchCallback | null;
  } = {}
): Promise<Record<string, unknown>> {
  const envelopes = readTrajectory(join(runDir, "trajectory.jsonl"));
  const manifestPath = join(runDir, "manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as GradingManifest // TODO(ts): manifest fields consumed here are harness-authored
    : null;
  // Step snapshots are pre-action evidence: the last envelope says what the
  // actor saw before its final action. Web captures final.a11y.txt after the
  // actor loop, so prefer it for the true post-action terminal state. Other
  // drivers and legacy bundles fall back to the last envelope artifact.
  const last = envelopes.at(-1);
  const finalPath = join(runDir, "final.a11y.txt");
  const finalSnapshot = existsSync(finalPath)
    ? readFileSync(finalPath, "utf8")
    : last?.artifacts?.a11y
      ? readFileSync(join(runDir, last.artifacts.a11y), "utf8")
      : "(no final snapshot recorded)";
  const discovery = resolvedCase.mode === "discovery";
  // Discovery never reads a baseline: a stray .baseline.jsonl next to the case
  // must not leak into the prompt.
  const baseline = !discovery && resolvedCase.file ? readBaseline(resolvedCase.file) : null;

  const a11y = a11ySummary(envelopes);
  const sections: string[] = [
    `## Story\n\n${resolvedCase.story.trim()}`,
    `## Trajectory\n\n${digest(envelopes)}`,
  ];
  // Discovery-only: cheap, factual anomaly signals extracted deterministically
  // from recorded fields (docs/contracts/engine.md#grading, DESIGN D2). Evidence,
  // not verdicts — the rubric classifies each in context. Omitted when empty, and
  // never added to journey grades (their prompt bytes are pinned).
  if (discovery) {
    const signalText = formatSignals(extractAnomalies(envelopes, { perf: resolvedCase.perf }));
    if (signalText) sections.push(`## Deterministic signals\n\n${signalText}`);
  }
  // A short axe digest so findings can reference a11y; the NUMBERS in grade.a11y
  // are harness-computed (spread below), never taken from the model's prose.
  const axeDigest = a11yDigest(a11y);
  if (axeDigest) sections.push(`## Accessibility\n\n${axeDigest}`);
  // The gate never runs in discovery; the section would always be "null" noise.
  if (!discovery) sections.push(`## Gate result\n\n${JSON.stringify(manifest?.result?.gate ?? null)}`);
  // API-specific evidence forms (docs/contracts/engine.md#grading): the
  // deterministic invariant verdicts and, on a healed run, the drift report.
  // Both are FACTS the grader may cite and must not overturn — the same
  // relationship it already has with the a11y counts. Omitted entirely when the
  // run produced neither, so web/mobile prompt bytes are unchanged.
  const api = apiEvidence(manifest, runDir);
  if (api) sections.push(`## API invariants and drift\n\n${apiDigest(api)}`);
  sections.push(`## Totals\n\n${JSON.stringify(manifest?.totals ?? null)}`);
  if (baseline) sections.push(`## Baseline\n\nbaseline step count: ${baseline.envelopes.length}`);
  if (resolvedCase.report?.length) {
    sections.push([
      "## Report questions",
      "",
      ...resolvedCase.report.map((q, i) => `${i + 1}. ${q}`),
      "",
      'Answer every question above in the grade\'s "report" array — one entry per question, quoting the question verbatim and citing the step numbers that evidence the answer in "evidence_steps". These questions overlap: when an answer\'s substance is already covered by another answer or a finding, give only the new part and refer back rather than re-narrating. Keep answers terse and readable.',
    ].join("\n"));
  }
  sections.push(`## Final page snapshot\n\n${finalSnapshot}`);

  // Like checkAssertion, the grader is a bounded tool-use loop offering
  // [grade, fetch_snapshot]: the digest says what each step DID, not what it
  // DISPLAYED, so the grader can pull any step's captured a11y (and screenshot,
  // on a vision case) to verify a claim about an intermediate state before
  // putting it in a finding. It ends by calling `grade`. When `grade` arrives via
  // a chat turn we accept those args directly (coerce + validate, same rescue as
  // forcedToolCall) — one request in the common no-fetch case. forcedToolCall is
  // the fallback: a model that fetched then declined to grade, gave no tool call,
  // or kept fetching to the cap is forced once into a grade (keeping coerce +
  // grade.error.json raw-capture). validate() answers the model's grade tool.
  const vision = Boolean(resolvedCase.vision);
  const artifacts = stepArtifacts(envelopes);
  const fetchTool = fetchSnapshotTool(vision);
  const maxTokens = discovery ? 4096 : 2048;
  const validate = (a: Record<string, unknown>): string | null => (
    validateGrade(a) ? null : ajv.errorsText(validateGrade.errors)
  );
  const messages: ChatMessage[] = [
    { role: "system", content: discovery ? graderDiscovery : graderSystem },
    { role: "user", content: sections.join("\n\n") },
  ];

  let args: Record<string, unknown> | null = null;
  const tokens: TokenUsage = { in: 0, out: 0, cache_read: 0 };
  const addUsage = (usage: Partial<TokenUsage> | null | undefined): void => {
    tokens.in += usage?.in ?? 0;
    tokens.out += usage?.out ?? 0;
    tokens.cache_read += usage?.cache_read ?? 0;
  };
  // Fetch turns; the loop ends when the model grades (args set) or when it must
  // be forced. The last allowed turn forces a grade so a grade always lands.
  for (let turn = 0; turn < MAX_GRADE_TURNS && args === null; turn++) {
    const lastTurn = turn === MAX_GRADE_TURNS - 1;
    if (!lastTurn) {
      const { toolCall, text, usage } = await chat({
        model: resolvedCase.grader_model,
        messages,
        tools: [GRADE_TOOL, fetchTool],
        toolChoice: "auto",
        maxTokens,
        signal,
        onRetry,
      });
      addUsage(usage);
      if (toolCall?.name === "fetch_snapshot") {
        // Surface the fetch to a live spinner, then echo the assistant's tool
        // call and answer it as a tool-role message (OpenAI tool-result shape).
        onFetch?.({ step: toolCall.args?.step ?? null });
        const callId = `fetch_${turn}`;
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: [{ id: callId, type: "function", function: { name: "fetch_snapshot", arguments: JSON.stringify(toolCall.args)
          } }],
        });
        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: fetchResult(toolCall.args as FetchSnapshotArgs ?? {} as FetchSnapshotArgs, { runDir, artifacts, vision }), // TODO(ts): the model-facing schema constrains fetch_snapshot arguments
        });
        continue;
      }
      if (toolCall?.name === "grade") {
        // The model graded on its own. Accept those args directly — same coerce
        // rescue forcedToolCall applies — so the no-fetch path stays one request.
        onFetch?.(null); // back to plain "grading" on the spinner
        const coerced = coerceStringifiedArgs(toolCall.args);
        if (validate(coerced) === null) {
          args = coerced;
          break;
        }
        // Coerce/validate failed: fall through to the forced extraction below,
        // which retries + writes grade.error.json on its own failure.
      } else if (!toolCall) {
        messages.push({ role: "user", content: "Call the grade tool with your grade, or fetch_snapshot if you need more evidence." });
        continue;
      }
    }
    // Forced extraction: the cap was hit, the model declined to grade, or its
    // self-produced grade failed validation. forcedToolCall coerces +
    // reattempts; its failure writes grade.error.json below.
    onFetch?.(null); // no longer fetching — the spinner returns to "grading"
    try {
      const forced = await forcedToolCall({
        model: resolvedCase.grader_model,
        messages,
        tool: GRADE_TOOL,
        validate,
        // Report answers add length; the pinned journey budget stays 2048.
        maxTokens,
        signal,
        onRetry,
      });
      args = forced.args;
      addUsage(forced.tokens);
    } catch (e: any) { // TODO(ts): forcedToolCall reports terminal failures as LlmError
      // Persist the raw gateway tool-call bytes next to the run so a validation
      // failure (e.g. an argument the model JSON-stringified) is debuggable
      // offline instead of lost behind the parsed error message.
      if (e.rawAttempts) {
        writeFileSync(join(runDir, "grade.error.json"),
          JSON.stringify({ error: e.message, attempts: e.rawAttempts }, null, 2) + "\n");
      }
      throw e;
    }
    break;
  }
  const grade = {
    ...args as Record<string, unknown>, // TODO(ts): every loop exit above assigns validated grade arguments
    // Harness-computed exact a11y counts (compliance) — spread AFTER the model's
    // args so the LLM can never author or override them; absent on non-web runs.
    ...(a11y ? { a11y } : {}),
    // Same rule for the API evidence: the invariant verdicts and the drift
    // classification are deterministic facts, spread after the model's args so
    // no grade can author or soften them. Absent on runs that produced neither.
    ...(api ? { api } : {}),
    model: resolvedCase.grader_model,
    graded_at: new Date().toISOString(),
    tokens,
  };
  writeFileSync(join(runDir, "grade.json"), JSON.stringify(grade, null, 2) + "\n");
  return grade;
}

const VERDICT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "verdict",
    description: "Your yes/no verdict on whether the run supports the claim. Call this once you have enough evidence.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pass", "detail"],
      properties: {
        pass: { type: "boolean", description: "true only if the evidence clearly supports the claim." },
        detail: { type: "string", description: "One sentence: the evidence for or against the claim." },
      },
    },
  },
};

// fetch_snapshot lets the verdict agent pull the captured state of ANY step,
// not just the final one — a claim about an intermediate page (e.g. a
// first-pass results screen later corrected) must be judged against that step's
// snapshot, not the final page. `resources` advertises "screenshot" ONLY on a
// vision case (the actor's flag; journey cases are a11y-only by construction),
// so a vision-off verdict never learns screenshots exist.
function fetchSnapshotTool(vision: boolean): ToolDefinition {
  const resources = vision ? ["a11y", "screenshot"] : ["a11y"];
  return {
    type: "function",
    function: {
      name: "fetch_snapshot",
      description: vision
        ? "Fetch the captured state of a specific step: its accessibility-text snapshot and/or its screenshot. Use this to verify a claim about an intermediate state of the run."
        : "Fetch the captured accessibility-text snapshot of a specific step. Use this to verify a claim about an intermediate state of the run.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["step", "resources"],
        properties: {
          step: { type: "integer", description: "The step number whose captured state to fetch." },
          resources: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: resources },
            description: `Which captured resources to return for that step (${resources.join(", ")}).`,
          },
        },
      },
    },
  };
}

// Map step number → { a11y?, screenshot? } artifact paths, from the trajectory
// envelopes. The verdict agent's fetch_snapshot resolves through this.
function stepArtifacts(envelopes: StepEnvelope[]): Map<number, StepArtifacts> {
  const map = new Map<number, StepArtifacts>();
  for (const env of envelopes ?? []) {
    if (env.step == null) continue;
    map.set(env.step, env.artifacts ?? {});
  }
  return map;
}

// Best-effort: build the tool-result content for a fetch_snapshot call. Returns
// an OpenAI content-part array (text + any image_url blocks, the actor.ts:226
// shape) so a screenshot rides inline. A missing step/resource yields a
// "couldn't be found" line rather than an error — the model decides how to cope.
function fetchResult(
  { step, resources }: FetchSnapshotArgs,
  {
    runDir,
    artifacts,
    vision
  }: {
    runDir: string;
    artifacts: Map<number, StepArtifacts>;
    vision: boolean;
  }
): ContentPart[] {
  const arts = artifacts.get(step);
  const parts: ContentPart[] = [];
  let header = `Step ${step}:`;
  if (!arts) {
    return [{ type: "text", text: `${header} no such step was recorded in this run.` }];
  }
  const want = Array.isArray(resources) ? resources : [];
  // vision-gate defensively: even if a model invents "screenshot" on an a11y
  // case, never read or surface the image.
  const allowed = vision ? ["a11y", "screenshot"] : ["a11y"];
  for (const r of want) {
    if (!allowed.includes(r)) {
      parts.push({ type: "text", text: `${header} resource "${r}" is not available for this run.` });
      continue;
    }
    if (r === "a11y") {
      const rel = arts.a11y;
      const abs = rel ? join(runDir, rel) : null;
      if (abs && existsSync(abs)) {
        parts.push({ type: "text", text: `${header} accessibility snapshot:\n${readFileSync(abs, "utf8")}` });
      } else {
        parts.push({ type: "text", text: `${header} accessibility snapshot could not be found.` });
      }
    } else if (r === "screenshot") {
      const rel = arts.screenshot;
      const abs = rel ? join(runDir, rel) : null;
      if (abs && existsSync(abs)) {
        parts.push({ type: "text", text: `${header} screenshot:` });
        // image_url inside a TOOL-role message (the actor's working vision path
        // uses a USER-role message). The OpenAI contract allows it; the
        // translating gateway (Portkey -> Anthropic) must map it onto a native
        // tool_result image block. Unexercised offline (vision is always off in
        // the self-tests) — verify on a real vision discovery run before relying
        // on intermediate-screenshot asserts.
        parts.push({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${readFileSync(abs).toString("base64")}` },
        });
      } else {
        parts.push({ type: "text", text: `${header} screenshot could not be found.` });
      }
    }
  }
  return parts.length ? parts : [{ type: "text", text: `${header} no resources requested.` }];
}

/**
 * Model-checks a natural-language `assert:` claim against the run. This is a
 * bounded tool-use loop, not a one-shot: the model is shown the final URL +
 * final snapshot up front (so a final-state claim resolves in one turn with no
 * fetch), and may call `fetch_snapshot(step, resources)` to pull any step's
 * captured a11y text (and screenshot, on a vision case) to verify a claim about
 * an intermediate state. It ends by calling `verdict`. Still a hard `assert`
 * gate check — the return contract is unchanged.
 * `signal`/`onRetry` mirror gradeRun (cancellable, retry-visible) — the gate
 * runs after the run's hard-timeout guard too.
 */
export async function checkAssertion(
  claim: string,
  {
    snapshotText,
    finalUrl,
    model,
    runDir,
    envelopes = [],
    vision = false,
    signal = null,
    onRetry = null
  }: {
    snapshotText: string;
    finalUrl: string;
    model: string;
    runDir: string;
    envelopes?: StepEnvelope[];
    vision?: boolean;
    signal?: AbortSignal | null;
    onRetry?: RetryCallback | null;
  }
): Promise<{ pass: boolean; detail: string; tokens: TokenUsage }> {
  const artifacts = stepArtifacts(envelopes);
  const lastStep = envelopes.length ? envelopes[envelopes.length - 1]!.step : null; // TODO(ts): the length guard proves the indexed envelope exists
  const fetchTool = fetchSnapshotTool(vision);
  const tools: ToolDefinition[] = [VERDICT_TOOL, fetchTool];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: graderAssert
        .replace("{{vision}}", vision ? " (accessibility text and/or screenshot)" : "")
        .replace("{{lastStep}}", lastStep as unknown as string ?? "N"), // TODO(ts): String.replace coerces the numeric step exactly as JavaScript did
    },
    {
      role: "user",
      content: `Claim: ${claim}\n\n## Trajectory\n\n${digest(envelopes)}\n\nFinal URL: ${finalUrl}\n\nFinal page snapshot:\n${snapshotText}`,
    },
  ];

  // Sum usage across the verdict agent's turns (fetch loop + the final verdict)
  // so the run's grader-token total reflects the whole assert check, not just
  // its last turn's tokens. accompanies the verdict so the runner can bill it.
  const tokens: TokenUsage = { in: 0, out: 0, cache_read: 0 };
  for (let turn = 0; turn < MAX_VERDICT_TURNS; turn++) {
    // On the last allowed turn, force a verdict so we always end with one.
    const lastTurn = turn === MAX_VERDICT_TURNS - 1;
    const { toolCall, text, usage } = await chat({
      model,
      messages,
      tools,
      toolChoice: lastTurn ? "verdict" : "auto",
      signal,
      onRetry,
    });
    tokens.in += usage?.in ?? 0;
    tokens.out += usage?.out ?? 0;
    tokens.cache_read += usage?.cache_read ?? 0;
    if (!toolCall) {
      // No tool call at all: nudge once toward a verdict, else fail closed.
      if (lastTurn) throw new LlmError(`expected a "verdict" tool call, got none`);
      messages.push({ role: "assistant", content: text || "" });
      messages.push({ role: "user", content: "Call the verdict tool with your decision, or fetch_snapshot if you need more evidence." });
      continue;
    }
    if (toolCall.name === "verdict") {
      return { pass: Boolean(toolCall.args.pass), detail: String(toolCall.args.detail ?? ""), tokens };
    }
    if (toolCall.name === "fetch_snapshot") {
      // Echo the assistant's tool call, then answer it as a tool-role message
      // (standard OpenAI tool-result shape) and loop.
      const callId = `fetch_${turn}`;
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: [{ id: callId, type: "function", function: { name: "fetch_snapshot", arguments: JSON.stringify(toolCall.args) } }],
      });
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: fetchResult(toolCall.args as FetchSnapshotArgs ?? {} as FetchSnapshotArgs, { runDir, artifacts, vision }), // TODO(ts): the model-facing schema constrains fetch_snapshot arguments
      });
      continue;
    }
    throw new LlmError(`unexpected tool call "${toolCall.name}" from the verdict agent`);
  }
  // Unreachable: the last turn forces a verdict (returned above) or throws.
  throw new LlmError("verdict loop exhausted without a verdict");
}
