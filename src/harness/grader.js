// Grader agent + natural-language assertion checker (CONTRACTS.md §8).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { chat, LlmError } from "./llm.js";
import { readTrajectory, readBaseline } from "./trajectory.js";
import { describeAction } from "./actor.js";

const here = dirname(fileURLToPath(import.meta.url));
const graderSystem = readFileSync(join(here, "prompts/grader-system.md"), "utf8").trim();
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

// Compact trajectory digest: per step — action, outcome, settle, confusion, thought.
function digest(envelopes) {
  const lines = [];
  for (const env of envelopes) {
    const what = env.agent ? describeAction(env.agent.action) : `act ${env.resolution?.locator ?? "(baseline step)"}`;
    const outcome = env.result?.ok === false ? `error ${env.result.error}` : "ok";
    const settle = env.result?.settle_ms != null ? `, settled in ${env.result.settle_ms}ms` : "";
    const confusion = env.confusion
      ? ` [confusion: ${env.confusion.type}${env.confusion.note ? ` — ${oneLine(env.confusion.note)}` : ""}]`
      : "";
    lines.push(`step ${env.step}: ${what} -> ${outcome}${settle}${confusion}`);
    if (env.agent?.thought) lines.push(`  thought: ${oneLine(env.agent.thought)}`);
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
  const baseline = resolvedCase.file ? readBaseline(resolvedCase.file) : null;

  const sections = [
    `## Story\n\n${resolvedCase.story.trim()}`,
    `## Trajectory\n\n${digest(envelopes)}`,
    `## Gate result\n\n${JSON.stringify(manifest?.result?.gate ?? null)}`,
    `## Totals\n\n${JSON.stringify(manifest?.totals ?? null)}`,
  ];
  if (baseline) sections.push(`## Baseline\n\nbaseline step count: ${baseline.envelopes.length}`);
  sections.push(`## Final page snapshot\n\n${finalSnapshot}`);

  const messages = [
    { role: "system", content: graderSystem },
    { role: "user", content: sections.join("\n\n") },
  ];

  const tokens = { in: 0, out: 0, cache_read: 0 };
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const turnMessages = attempt === 0 ? messages : [...messages, {
      role: "user",
      content: `Your previous grade was invalid: ${lastError}\nCall the grade tool again with a corrected grade.`,
    }];
    const { toolCall, usage } = await chat({
      model: resolvedCase.grader_model,
      messages: turnMessages,
      tools: [GRADE_TOOL],
      toolChoice: "grade",
      maxTokens: 2048,
    });
    tokens.in += usage.in;
    tokens.out += usage.out;
    tokens.cache_read += usage.cache_read;
    if (!toolCall || toolCall.name !== "grade") {
      lastError = `expected a "grade" tool call, got ${toolCall ? `"${toolCall.name}"` : "none"}`;
      continue;
    }
    if (!validateGrade(toolCall.args)) {
      lastError = ajv.errorsText(validateGrade.errors);
      continue;
    }
    const grade = {
      ...toolCall.args,
      model: resolvedCase.grader_model,
      graded_at: new Date().toISOString(),
      tokens,
    };
    writeFileSync(join(runDir, "grade.json"), JSON.stringify(grade, null, 2) + "\n");
    return grade;
  }
  throw new LlmError(`grade failed validation after retry: ${lastError}`);
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
      content: "You verify claims about the final state of a web page. You are given a claim and the page's accessibility snapshot. Pass only if the snapshot clearly supports the claim. Report via the verdict tool.",
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
