// Grader agent + natural-language assertion checker (CONTRACTS.md §8).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { chat, forcedToolCall, coerceStringifiedArgs, LlmError } from "./llm.js";
import { readTrajectory, readBaseline } from "./trajectory.js";
import { describeStep } from "./actor.js";

const here = dirname(fileURLToPath(import.meta.url));
const graderSystem = readFileSync(join(here, "prompts/grader-system.md"), "utf8").trim();
const graderDiscovery = readFileSync(join(here, "prompts/grader-discovery.md"), "utf8").trim();
const graderAssert = readFileSync(join(here, "prompts/grader-assert.md"), "utf8").trim();
const gradeSchema = JSON.parse(readFileSync(join(here, "../schemas/grade.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true });
const validateGrade = ajv.compile(gradeSchema);

const GRADE_TOOL = {
  type: "function",
  function: {
    name: "grade",
    description: "Your structured grade of the recorded run.",
    parameters: gradeSchema,
  },
};

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, " ").trim();

// Caps a runaway fetch loop in both grader calls; on the last turn we force the
// terminal tool (grade / verdict) so a result always lands.
const MAX_GRADE_TURNS = 6;
const MAX_VERDICT_TURNS = 6;

// Compact trajectory digest: per step — action, outcome, settle, url,
// confusion, thought, and (vision runs) the visual observation.
function digest(envelopes) {
  const lines = [];
  for (const env of envelopes) {
    const what = env.mode === "error"
      ? "actor error (no valid step produced)"
      : describeStep(env);
    // A state_drift marker has result.ok:false but error:null — the recorded step
    // was SKIPPED (the page changed under it), not executed-and-errored. Render it
    // as such so the grader isn't told a step "error null"ed (matches actor.js
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
    if (env.agent?.thought) lines.push(`  thought: ${oneLine(env.agent.thought)}`);
    if (env.agent?.visual) lines.push(`  visual: ${oneLine(env.agent.visual)}`);
  }
  return lines.join("\n") || "(empty trajectory)";
}

/**
 * HARNESS-COMPUTED a11y summary over the run's envelopes (CONTRACTS §8). Exact
 * axe-core counts for compliance — never grader prose (which varies run to run).
 * Returns null when no envelope carried an `axe` capture (non-web, or capture
 * failed everywhere), so the `a11y` key is absent on those grades. Pure.
 */
export function a11ySummary(envelopes) {
  const withAxe = envelopes.filter((e) => e.axe);
  if (withAxe.length === 0) return null;
  let total = 0;
  let stepsWithViolations = 0;
  const ruleCounts = new Map(); // id → { count, impact }
  for (const e of withAxe) {
    const violations = e.axe.violations ?? [];
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

/** A short prose digest of the a11y summary for the grader prompt (so findings
 * can reference a11y); it does NOT drive the numbers. null when no a11y data. */
function a11yDigest(summary) {
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
export async function gradeRun(runDir, resolvedCase, { signal = null, onRetry = null, onFetch = null } = {}) {
  const envelopes = readTrajectory(join(runDir, "trajectory.jsonl"));
  const manifestPath = join(runDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  // Every envelope carries artifacts.a11y (artifactsFor sets it unconditionally),
  // so the final snapshot is simply the last envelope's — no need to scan for one.
  const last = envelopes.at(-1);
  const finalSnapshot = last?.artifacts?.a11y
    ? readFileSync(join(runDir, last.artifacts.a11y), "utf8")
    : "(no final snapshot recorded)";
  const discovery = resolvedCase.mode === "discovery";
  // Discovery never reads a baseline: a stray .baseline.jsonl next to the case
  // must not leak into the prompt.
  const baseline = !discovery && resolvedCase.file ? readBaseline(resolvedCase.file) : null;

  const a11y = a11ySummary(envelopes);
  const sections = [
    `## Story\n\n${resolvedCase.story.trim()}`,
    `## Trajectory\n\n${digest(envelopes)}`,
  ];
  // A short axe digest so findings can reference a11y; the NUMBERS in grade.a11y
  // are harness-computed (spread below), never taken from the model's prose.
  const axeDigest = a11yDigest(a11y);
  if (axeDigest) sections.push(`## Accessibility\n\n${axeDigest}`);
  // The gate never runs in discovery; the section would always be "null" noise.
  if (!discovery) sections.push(`## Gate result\n\n${JSON.stringify(manifest?.result?.gate ?? null)}`);
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
  const validate = (a) => (validateGrade(a) ? null : ajv.errorsText(validateGrade.errors));
  const messages = [
    { role: "system", content: discovery ? graderDiscovery : graderSystem },
    { role: "user", content: sections.join("\n\n") },
  ];

  let args = null;
  const tokens = { in: 0, out: 0, cache_read: 0 };
  const addUsage = (usage) => {
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
          content: fetchResult(toolCall.args ?? {}, { runDir, artifacts, vision }),
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
    } catch (e) {
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
    ...args,
    // Harness-computed exact a11y counts (compliance) — spread AFTER the model's
    // args so the LLM can never author or override them; absent on non-web runs.
    ...(a11y ? { a11y } : {}),
    model: resolvedCase.grader_model,
    graded_at: new Date().toISOString(),
    tokens,
  };
  writeFileSync(join(runDir, "grade.json"), JSON.stringify(grade, null, 2) + "\n");
  return grade;
}

const VERDICT_TOOL = {
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
function fetchSnapshotTool(vision) {
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
function stepArtifacts(envelopes) {
  const map = new Map();
  for (const env of envelopes ?? []) {
    if (env.step == null) continue;
    map.set(env.step, env.artifacts ?? {});
  }
  return map;
}

// Best-effort: build the tool-result content for a fetch_snapshot call. Returns
// an OpenAI content-part array (text + any image_url blocks, the actor.js:226
// shape) so a screenshot rides inline. A missing step/resource yields a
// "couldn't be found" line rather than an error — the model decides how to cope.
function fetchResult({ step, resources }, { runDir, artifacts, vision }) {
  const arts = artifacts.get(step);
  const parts = [];
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
 * @param {string} claim
 * @param {{ snapshotText: string, finalUrl: string, model: string,
 *          runDir: string, envelopes?: object[], vision?: boolean,
 *          signal?: AbortSignal|null, onRetry?: Function|null }} ctx
 * @returns {Promise<{ pass: boolean, detail: string, tokens: {in:number,out:number,cache_read:number} }>}
 */
export async function checkAssertion(claim, { snapshotText, finalUrl, model, runDir, envelopes = [], vision = false, signal = null, onRetry = null }) {
  const artifacts = stepArtifacts(envelopes);
  const lastStep = envelopes.length ? envelopes[envelopes.length - 1].step : null;
  const fetchTool = fetchSnapshotTool(vision);
  const tools = [VERDICT_TOOL, fetchTool];
  const messages = [
    {
      role: "system",
      content: graderAssert
        .replace("{{vision}}", vision ? " (accessibility text and/or screenshot)" : "")
        .replace("{{lastStep}}", lastStep ?? "N"),
    },
    {
      role: "user",
      content: `Claim: ${claim}\n\n## Trajectory\n\n${digest(envelopes)}\n\nFinal URL: ${finalUrl}\n\nFinal page snapshot:\n${snapshotText}`,
    },
  ];

  // Sum usage across the verdict agent's turns (fetch loop + the final verdict)
  // so the run's grader-token total reflects the whole assert check, not just
  // its last turn's tokens. accompanies the verdict so the runner can bill it.
  const tokens = { in: 0, out: 0, cache_read: 0 };
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
        content: fetchResult(toolCall.args ?? {}, { runDir, artifacts, vision }),
      });
      continue;
    }
    throw new LlmError(`unexpected tool call "${toolCall.name}" from the verdict agent`);
  }
  // Unreachable: the last turn forces a verdict (returned above) or throws.
  throw new LlmError("verdict loop exhausted without a verdict");
}
