// Grader agent + natural-language assertion checker (CONTRACTS.md §8).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { chat, forcedToolCall, LlmError } from "./llm.js";
import { readTrajectory, readBaseline } from "./trajectory.js";
import { describeAction } from "./actor.js";

const here = dirname(fileURLToPath(import.meta.url));
const graderSystem = readFileSync(join(here, "prompts/grader-system.md"), "utf8").trim();
const graderDiscovery = readFileSync(join(here, "prompts/grader-discovery.md"), "utf8").trim();
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

// Compact trajectory digest: per step — action, outcome, settle, url,
// confusion, thought, and (vision runs) the visual observation.
function digest(envelopes) {
  const lines = [];
  for (const env of envelopes) {
    const what = env.mode === "error"
      ? "actor error (no valid step produced)"
      : env.agent ? describeAction(env.agent.action) : `act ${env.resolution?.locator ?? "(baseline step)"}`;
    const outcome = env.result?.ok === false ? `error ${env.result.error}` : "ok";
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

/** Grades a finished run; writes <runDir>/grade.json and returns the grade object. */
export async function gradeRun(runDir, resolvedCase) {
  const envelopes = readTrajectory(join(runDir, "trajectory.jsonl"));
  const manifestPath = join(runDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const lastA11y = envelopes.findLast((e) => e.artifacts?.a11y);
  const finalSnapshot = lastA11y
    ? readFileSync(join(runDir, lastA11y.artifacts.a11y), "utf8")
    : "(no final snapshot recorded)";
  const discovery = resolvedCase.mode === "discovery";
  // Discovery never reads a baseline: a stray .baseline.jsonl next to the case
  // must not leak into the prompt.
  const baseline = !discovery && resolvedCase.file ? readBaseline(resolvedCase.file) : null;

  const sections = [
    `## Story\n\n${resolvedCase.story.trim()}`,
    `## Trajectory\n\n${digest(envelopes)}`,
  ];
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
      'Answer every question above in the grade\'s "report" array — one entry per question, quoting the question verbatim and citing the step numbers that evidence the answer in "evidence_steps".',
    ].join("\n"));
  }
  sections.push(`## Final page snapshot\n\n${finalSnapshot}`);

  const { args, tokens } = await forcedToolCall({
    model: resolvedCase.grader_model,
    messages: [
      { role: "system", content: discovery ? graderDiscovery : graderSystem },
      { role: "user", content: sections.join("\n\n") },
    ],
    tool: GRADE_TOOL,
    validate: (a) => (validateGrade(a) ? null : ajv.errorsText(validateGrade.errors)),
    // Report answers add length; the pinned journey budget stays 2048.
    maxTokens: discovery ? 4096 : 2048,
  });
  const grade = {
    ...args,
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
    description: "Your yes/no verdict on whether the page supports the claim.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pass", "detail"],
      properties: {
        pass: { type: "boolean", description: "true only if the snapshot clearly supports the claim." },
        detail: { type: "string", description: "One sentence: the evidence for or against the claim." },
      },
    },
  },
};

/**
 * Model-checks a natural-language `assert:` claim against the final page.
 * @returns {Promise<{ pass: boolean, detail: string }>}
 */
export async function checkAssertion(claim, { snapshotText, finalUrl, model }) {
  const messages = [
    {
      role: "system",
      content: "You verify a claim about the final state under test. You are given the claim and a textual snapshot of that state — an accessibility snapshot for web/mobile, or the API response for an api run. Pass only if the snapshot clearly supports the claim. Report via the verdict tool.",
    },
    {
      role: "user",
      content: `Claim: ${claim}\n\nFinal URL: ${finalUrl}\n\nFinal page snapshot:\n${snapshotText}`,
    },
  ];
  const { toolCall } = await chat({ model, messages, tools: [VERDICT_TOOL], toolChoice: "verdict" });
  if (!toolCall || toolCall.name !== "verdict") {
    throw new LlmError(`expected a "verdict" tool call, got ${toolCall ? `"${toolCall.name}"` : "none"}`);
  }
  return { pass: Boolean(toolCall.args.pass), detail: String(toolCall.args.detail ?? "") };
}
