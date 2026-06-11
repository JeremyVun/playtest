// The actor loop's brain (CONTRACTS.md §6): persona resolution, cache-efficient
// context assembly, forced-tool step extraction, schema validation.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv from "ajv";
import { chat, LlmError } from "./llm.js";

const here = dirname(fileURLToPath(import.meta.url));
const prompt = (name) => readFileSync(join(here, "prompts", name), "utf8");

const stepSchema = JSON.parse(readFileSync(join(here, "../schemas/step.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true });
const validateStep = ajv.compile(stepSchema);

const BUILTIN_PERSONAS = ["tester", "exploratory"];

/** @returns {{ name: string, description: string }} */
export function loadPersona(name, caseFile) {
  if (BUILTIN_PERSONAS.includes(name)) {
    return { name, description: prompt(`persona-${name}.md`).trim() };
  }
  let dir = caseFile ? dirname(resolve(caseFile)) : process.cwd();
  for (;;) {
    const personasDir = join(dir, "personas");
    if (existsSync(personasDir)) {
      for (const file of readdirSync(personasDir)) {
        if (!/\.ya?ml$/.test(file)) continue;
        let parsed;
        try {
          parsed = YAML.parse(readFileSync(join(personasDir, file), "utf8"));
        } catch {
          continue;
        }
        if (parsed?.name === name || basename(file).replace(/\.ya?ml$/, "") === name) {
          return { name, description: String(parsed?.description ?? "").trim() };
        }
      }
    }
    const parent = dirname(dir);
    // The dir containing .git is the repo root: search it, then stop.
    if (existsSync(join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  throw new Error(`persona "${name}" not found: not a built-in, and no matching personas/*.yaml between ${caseFile ?? process.cwd()} and the repo root`);
}

/** Human-readable one-liner for a step action (also used by the grader digest). */
export function describeAction(action) {
  switch (action?.type) {
    case "click": return `click ${action.ref}`;
    case "type": return `type ${JSON.stringify(action.text)} into ${action.ref}${action.submit ? " and press Enter" : ""}`;
    case "select": return `select ${JSON.stringify(action.value)} in ${action.ref}`;
    case "scroll": return `scroll ${action.direction}${action.ref ? ` in ${action.ref}` : ""}`;
    case "navigate": return `navigate ${action.url}`;
    case "wait": return `wait ${action.seconds}s`;
    case "done": return `done: ${action.summary}`;
    case "give_up": return `give_up: ${action.reason}`;
    default: return JSON.stringify(action);
  }
}

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, " ").trim();

function stepLine(env) {
  const what = env.agent ? describeAction(env.agent.action) : `acted ${env.resolution?.locator ?? "(baseline step)"}`;
  const outcome = env.result?.ok === false ? `error ${env.result.error}` : "ok";
  const url = env.result?.url;
  return `step ${env.step}: ${what} -> ${outcome}${url ? ` | url now ${url}` : ""}`;
}

const VERBOSE_STEPS = 15;
const FOLD_BATCH = 10;

// Compact append-only log: recent steps verbose (with thoughts), older steps
// folded to one line each with thoughts dropped. Folding happens in batches of
// FOLD_BATCH so the folded prefix is byte-stable between turns (prompt
// caching); the verbose tail holds the last 15-24 steps.
function renderLog(history) {
  if (!history.length) return "Steps so far: (none — this is your first step)";
  const lines = ["Steps so far:"];
  const fold = Math.floor(Math.max(0, history.length - VERBOSE_STEPS) / FOLD_BATCH) * FOLD_BATCH;
  if (fold > 0) {
    lines.push(`steps 1-${fold} (thoughts dropped):`);
    for (const env of history.slice(0, fold)) lines.push(stepLine(env));
    lines.push(`steps ${fold + 1} onward:`);
  }
  for (const env of history.slice(fold)) {
    lines.push(stepLine(env));
    if (env.agent?.thought) lines.push(`  thought: ${oneLine(env.agent.thought)}`);
  }
  return lines.join("\n");
}

const STEP_TOOL = {
  type: "function",
  function: {
    name: "step",
    description: "Your next step: one thought, one action, one expectation.",
    parameters: stepSchema,
  },
};

export class Actor {
  constructor(resolvedCase, persona) {
    this.case = resolvedCase;
    this.persona = persona;
    // Stable prefix: never changes mid-run, so the gateway can prompt-cache it.
    // The "## Your task" marker is load-bearing: mock-llm extracts the story by it.
    this.system = [
      prompt("actor-system.md").trim(),
      `## Persona\n\n${persona.description.trim()}`,
      `## Your task\n\n${resolvedCase.story.trim()}`,
    ].join("\n\n");
  }

  /**
   * @param {{ history: object[], snapshotText: string, stepNum: number,
   *           signal?: AbortSignal|null }} turn
   * @returns {Promise<{ agentStep: object, tokens: {in: number, out: number, cache_read: number} }>}
   */
  async nextStep({ history, snapshotText, stepNum, signal = null }) {
    const messages = [
      { role: "system", content: this.system },
      { role: "user", content: renderLog(history) },
      { role: "user", content: `Current page snapshot (step ${stepNum}):\n${snapshotText}` },
    ];
    const tokens = { in: 0, out: 0, cache_read: 0 };
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const turnMessages = attempt === 0 ? messages : [...messages, {
        role: "user",
        content: `Your previous step was invalid: ${lastError}\nCall the step tool again with a corrected step.`,
      }];
      const { toolCall, usage } = await chat({
        model: this.case.actor_model,
        messages: turnMessages,
        tools: [STEP_TOOL],
        toolChoice: "step",
        signal,
      });
      tokens.in += usage.in;
      tokens.out += usage.out;
      tokens.cache_read += usage.cache_read;
      if (!toolCall || toolCall.name !== "step") {
        lastError = `expected a "step" tool call, got ${toolCall ? `"${toolCall.name}"` : "none"}`;
        continue;
      }
      if (!validateStep(toolCall.args)) {
        lastError = ajv.errorsText(validateStep.errors);
        continue;
      }
      return { agentStep: toolCall.args, tokens };
    }
    throw new LlmError(`actor step failed validation after retry: ${lastError}`);
  }
}
