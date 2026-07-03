// The actor loop's brain (CONTRACTS.md §6): persona resolution, cache-efficient
// context assembly, forced-tool step extraction, schema validation.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv from "ajv";
import { forcedToolCall } from "./llm.js";
import { actionOf } from "./trajectory.js";
import { overlayFor, toolParamsFor, stepSchemaFor } from "./drivers/overlay.js";
import { DummyConfigError } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const prompt = (name) => readFileSync(join(here, "prompts", name), "utf8");
const personas = (name) => readFileSync(join(here, "personas", name), "utf8");

const ajv = new Ajv({ allErrors: true });
// Per-driver forced-tool schema + validator. The actor is shown only its
// driver's verbs and fields (toolParamsFor — the stripped, model-facing copy)
// and validated against the strict per-driver schema (stepSchemaFor). Because
// the OpenAI-compat endpoint does not constrain decoding, the shipped schema is
// documentation and the validator is the real gate; the two are decoupled in
// drivers/overlay.js. Cached by driver id; the $id-stripped validator lets
// several driver schemas compile in one Ajv instance.

// A worked example per driver, folded into the tool description — the single
// highest-yield aid for a weak actor model: it anchors the flat action shape.
const EXAMPLE = {
  web: '{"thought":"…","action":{"type":"type","ref":"e2","text":"buy milk","submit":true},"expectation":"a todo \\"buy milk\\" appears in the list"}',
  mobile: '{"thought":"…","action":{"type":"tap","ref":"e3"},"expectation":"the compose screen opens"}',
  api: '{"thought":"…","action":{"type":"request","method":"GET","path":"/api/todos"},"expectation":"a 200 response listing the todos"}',
};

const stepToolCache = new Map();
function stepToolFor(driverId) {
  if (!stepToolCache.has(driverId)) {
    const parameters = toolParamsFor(driverId);
    const example = EXAMPLE[driverId] ?? EXAMPLE.web;
    stepToolCache.set(driverId, {
      tool: {
        type: "function",
        function: {
          name: "step",
          description: `Your next step: one thought, one action, one expectation. Example: ${example}`,
          parameters,
        },
      },
      validate: ajv.compile(stepSchemaFor(driverId)),
    });
  }
  return stepToolCache.get(driverId);
}

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
    return { name, description: personas(`persona-${name}.md`).trim() };
  }
  const start = caseFile ? dirname(resolve(caseFile)) : process.cwd();
  const match = customPersonas(start).find((p) => p.name === name || p.slug === name);
  if (match) return { name, description: match.description };
  // Single line: runner truncates run errors with firstLine().
  const dirs = personaDirs(start);
  const searched = dirs.length
    ? `searched ${dirs.join(", ")}`
    : `no personas/ directory between ${start} and the repo root`;
  throw new DummyConfigError(
    `persona "${name}" not found: not a built-in, and no matching personas/*.yaml (${searched}). Create one with: playtest new pers
ona ${name}`,
  );
}

/**
 * Human-readable one-liner for a step ENVELOPE: its action whether agent-decided
 * or replayed from a baseline (actionOf), never the raw `resolution.locator` — a
 * long CSS nth-of-type path for a nameless element that spams the log/digest and
 * bears no relation to the [eN] role "name" snapshot the actor saw. Shared by
 * the actor log (stepLine) and the grader digest so the two cannot drift apart.
 */
export function describeStep(env) {
  const action = actionOf(env);
  return action ? describeAction(action) : "(baseline step)";
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
    case "tap": return `tap ${action.ref}`;
    case "swipe": return `swipe ${action.direction}${action.ref ? ` on ${action.ref}` : ""}`;
    case "back": return "back";
    // api verb:
    case "request": return `request ${action.method} ${action.path}`;
    default: return JSON.stringify(action);
  }
}

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, " ").trim();

// The harness flags steps that made no progress (runner detectConfusion): a
// click/type that changed nothing (no_effect), or the same action repeated
// against an unchanged page (repeated_action). The actor only ever saw "→ ok"
// for these and so kept spinning; surface the flag so it can recognise a dead
// end and stop.
function outcomeOf(env) {
  // A state-drift marker is a non-executed step (result.ok:false, no resolution):
  // the page changed under the recorded action so it was SKIPPED, not run/failed.
  if (env.confusion?.type === "state_drift") {
    return "the page changed under this recorded step, so it was SKIPPED — decide fresh from here";
  }
  if (env.result?.ok === false) return `error ${env.result.error}`;
  switch (env.confusion?.type) {
    case "no_effect": return "ok but NOTHING CHANGED on the page";
    case "repeated_action": return "ok but you just did the SAME action against the SAME page — nothing changed";
    default: return "ok";
  }
}

function stepLine(env) {
  const url = env.result?.url;
  return `step ${env.step}: ${describeStep(env)} → ${outcomeOf(env)}${url ? ` | url now ${url}` : ""}`;
}
// [UNREADABLE lines 188-213: scrolled past, not captured in any frame]
export class Actor { // [reconstruction: inserted to balance block; original line(s) not recoverable]
  constructor(resolvedCase, persona) { // [reconstruction: inserted to balance block; original line(s) not recoverable]
    // (or an absent driver) loads actor-system.md verbatim, so a web journey's
    // assembled prompt is byte-identical to pre-driver-seam — the golden test.
    this.driverId = resolvedCase.env?.driver ?? "web";
    const { tool, validate } = stepToolFor(this.driverId);
    this.stepTool = tool;
    this.validateStep = validate;
    // Stable prefix: never changes mid-run, so the gateway can prompt-cache it.
    // The "## Your task" marker is load-bearing: mock-llm extracts the story by
    // its LAST occurrence, so the discovery overlay must stay before it.
    this.system = [
      overlayFor(this.driverId).prompt,
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
   *         screenshot?: Buffer|null, signal?: AbortSignal|null,
   *         onContext?: ((messages: object[], tools: object[]) => void)|null,
   *         onRetry?: Function|null }} turn
   * screenshot: the step's viewport PNG; rides the snapshot message as an
   * image part when the case has vision on (null degrades to text-only).
   * onContext: called with the assembled message window AND the tool definitions
   * sent that turn, before the model call, so the caller can persist them
   * (context.jsonl) even if the call then fails.
   * onRetry: forwarded to the LLM call — fires on each 429/5xx backoff.
   * @returns {Promise<{ agentStep: object, tokens: {in: number, out: number, cache_read: number} }>}
   */
  async nextStep({ history, snapshotText, stepNum, screenshot = null, signal = null, onContext = null, onRetry = null }) {
    const snapText = `Current page snapshot (step ${stepNum}):\n${snapshotText}`;
    const snapContent = this.case.vision && screenshot
      ? [
          { type: "text", text: snapText },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot.toString("base64")}` } },
        ]
      : snapText;
    const messages = [
      { role: "system", content: this.system },
      // Run-setup context (§3): a NON-pinned user message a before_each hook fed
      // back (e.g. "Test user acme_user_42 (password hunter2), already signed
      // up."). It lives in the message window, NOT in this.system — so it's
      // outside the prompts_version golden pin (like the snapshot) and doesn't
      // bust prompt caching. Placed before the log so it reads as standing
      // background. Absent (null) => no message => byte-identical to today.
      ...(this.setupContext ? [{ role: "user", content: `## Run setup\n\n${this.setupContext}` }] : []),
      { role: "user", content: renderLog(history) },
      { role: "user", content: snapContent },
    ];
    if (onContext) onContext(messages, [this.stepTool]);
    const { args, tokens } = await forcedToolCall({
      model: this.case.actor_model,
      messages,
      tool: this.stepTool,
      validate: (a) => (this.validateStep(a) ? null : ajv.errorsText(this.validateStep.errors)),
      signal,
      onRetry,
      // Cache through the last stable message — the append-only "Steps so far"
      // log at length-2 — so the volatile per-turn snapshot (the final message)
      // stays fresh. length-2, not a fixed index, because an optional run-setup
      // message shifts the log's position. See applyCacheControl.
      cacheBreakpoint: messages.length - 2,
    });
    return { agentStep: args, tokens };
  }
}
