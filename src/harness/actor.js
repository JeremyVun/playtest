// The actor loop's brain (CONTRACTS.md §6): persona resolution, cache-efficient
// context assembly, forced-tool step extraction, schema validation.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv from "ajv";
import { forcedToolCall } from "./llm.js";

const here = dirname(fileURLToPath(import.meta.url));
const prompt = (name) => readFileSync(join(here, "prompts", name), "utf8");

const stepSchema = JSON.parse(readFileSync(join(here, "../schemas/step.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true });
const validateStep = ajv.compile(stepSchema);

const BUILTIN_PERSONAS = ["tester", "exploratory"];

/** Existing personas/ dirs from `fromDir` up to the repo root, nearest first. */
function personaDirs(fromDir) {
  const dirs = [];
  let dir = fromDir;
  for (;;) {
    const d = join(dir, "personas");
    if (existsSync(d)) dirs.push(d);
    const parent = dirname(dir);
    // The dir containing .git is the repo root: search it, then stop.
    if (existsSync(join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** Parseable personas/*.yaml entries, nearest dir first; loadPersona matches name or slug. */
function customPersonas(fromDir) {
  const out = [];
  for (const personasDir of personaDirs(fromDir)) {
    for (const file of readdirSync(personasDir)) {
      if (!/\.ya?ml$/.test(file)) continue;
      let parsed;
      try {
        parsed = YAML.parse(readFileSync(join(personasDir, file), "utf8"));
      } catch {
        continue;
      }
      const slug = basename(file).replace(/\.ya?ml$/, "");
      out.push({
        name: typeof parsed?.name === "string" ? parsed.name : slug,
        slug,
        description: String(parsed?.description ?? "").trim(),
        file: join(personasDir, file),
      });
    }
  }
  return out;
}

/**
 * Built-ins plus every custom persona visible from a case file or directory.
 * @returns {{ name: string, file: string|null }[]} file null -> built-in
 */
export function listPersonas(fromDirOrCaseFile = process.cwd()) {
  let start = resolve(fromDirOrCaseFile);
  try {
    if (!statSync(start).isDirectory()) start = dirname(start);
  } catch {
    start = dirname(start);
  }
  return [
    ...BUILTIN_PERSONAS.map((name) => ({ name, file: null })),
    ...customPersonas(start).map(({ name, file }) => ({ name, file })),
  ];
}

/** @returns {{ name: string, description: string }} */
export function loadPersona(name, caseFile) {
  if (BUILTIN_PERSONAS.includes(name)) {
    return { name, description: prompt(`persona-${name}.md`).trim() };
  }
  const start = caseFile ? dirname(resolve(caseFile)) : process.cwd();
  const match = customPersonas(start).find((p) => p.name === name || p.slug === name);
  if (match) return { name, description: match.description };
  // Single line: runner truncates run errors with firstLine().
  const dirs = personaDirs(start);
  const searched = dirs.length
    ? `searched ${dirs.join(", ")}`
    : `no personas/ directory between ${start} and the repo root`;
  throw new Error(
    `persona "${name}" not found: not a built-in, and no matching personas/*.yaml (${searched}). Create one with: playtest new persona ${name}`,
  );
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

// Append-only log: every step's line plus its thought, never rewritten, so
// the prefix is byte-stable between turns (prompt caching). Bounded by
// max_steps (50 by default), a few thousand tokens at worst — the per-turn
// page snapshot dwarfs it.
function renderLog(history) {
  if (!history.length) return "Steps so far: (none — this is your first step)";
  const lines = ["Steps so far:"];
  for (const env of history) {
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
    // The "## Your task" marker is load-bearing: mock-llm extracts the story by
    // its LAST occurrence, so the discovery overlay must stay before it.
    this.system = [
      prompt("actor-system.md").trim(),
      `## Persona\n\n${persona.description.trim()}`,
      ...(resolvedCase.mode === "discovery" ? [prompt("actor-discovery.md").trim()] : []),
      // Keyed off vision only (config guarantees vision implies discovery);
      // vision-off prompts stay byte-identical.
      ...(resolvedCase.vision ? [prompt("actor-vision.md").trim()] : []),
      `## Your task\n\n${resolvedCase.story.trim()}`,
    ].join("\n\n");
  }

  /**
   * @param {{ history: object[], snapshotText: string, stepNum: number,
   *           screenshot?: Buffer|null, signal?: AbortSignal|null }} turn
   *   screenshot: the step's viewport PNG; rides the snapshot message as an
   *   image part when the case has vision on (null degrades to text-only).
   * @returns {Promise<{ agentStep: object, tokens: {in: number, out: number, cache_read: number} }>}
   */
  async nextStep({ history, snapshotText, stepNum, screenshot = null, signal = null }) {
    const snapText = `Current page snapshot (step ${stepNum}):\n${snapshotText}`;
    const snapContent = this.case.vision && screenshot
      ? [
          { type: "text", text: snapText },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot.toString("base64")}` } },
        ]
      : snapText;
    const { args, tokens } = await forcedToolCall({
      model: this.case.actor_model,
      messages: [
        { role: "system", content: this.system },
        { role: "user", content: renderLog(history) },
        { role: "user", content: snapContent },
      ],
      tool: STEP_TOOL,
      validate: (a) => (validateStep(a) ? null : ajv.errorsText(validateStep.errors)),
      signal,
    });
    return { agentStep: args, tokens };
  }
}
