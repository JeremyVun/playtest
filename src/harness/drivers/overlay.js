// Per-driver actor action schemas (docs/CONTRACTS.md §16). The actor's step
// contract is a FLAT action object — one `type` verb plus the flat parameters
// that verb uses (NOT a oneOf union). The canonical VALIDATION schema lives in
// schemas/step.schema.json; this module projects it per driver into two
// artifacts that are deliberately decoupled, because the OpenAI-compat endpoint
// does NOT constrain decoding — so the shipped schema is documentation and the
// validator is the real gate (compiled by forcedToolCall in llm.js):
//
//   stepSchemaFor(driver)  — the strict VALIDATOR: the canonical flat schema
//                            with `type`/`direction` enums scoped to the
//                            driver's verbs, keeping additionalProperties, the
//                            allOf per-verb requireds, and min/max.
//   toolParamsFor(driver)  — the model-facing SHIPPED schema: only this driver's
//                            verbs and only the fields those verbs use, with
//                            advisory keywords ($id/$schema/$comment/allOf/
//                            additionalProperties/min-max/default) stripped and
//                            concise, weak-model-tuned field descriptions.
//
// overlayFor(driver) returns the system-prompt overlay (actor-system.md for web,
// the self-contained mobile/api bodies otherwise).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // src/harness/drivers
const promptsDir = join(here, "..", "prompts");
const CANON = JSON.parse(readFileSync(join(here, "..", "..", "schemas", "step.schema.json"), "utf8"));
const CANON_FIELDS = CANON.properties.action.properties;

// The verb subset each driver shows the actor, in display order. wait/done/
// give_up are shared across all drivers; back is web+mobile only; the rest are
// transport-specific. Single source of truth for "which verbs exist on this
// transport".
export const DRIVER_VERBS = {
  web: ["click", "type", "select", "scroll", "navigate", "back", "wait", "done", "give_up"],
  mobile: ["tap", "type", "swipe", "scroll", "back", "wait", "done", "give_up"],
  api: ["request", "wait", "done", "give_up"],
};

// Which flat fields each verb uses (required + optional), so the SHIPPED schema
// carries only the fields relevant to a driver's verbs. The VALIDATOR's per-verb
// REQUIRED fields live in the canonical schema's `allOf`; driver.test.js pins
// the two consistent so this map can't silently drift from enforcement.
const VERB_FIELDS = {
  click: ["ref"],
  type: ["ref", "text", "submit"],
  select: ["ref", "value"],
  scroll: ["direction", "ref"],
  navigate: ["url"],
  back: [],
  wait: ["seconds"],
  done: ["summary"],
  give_up: ["reason"],
  tap: ["ref"],
  swipe: ["direction", "ref"],
  request: ["method", "path", "body", "headers"],
};

// `direction` serves scroll (web: up/down) and additionally swipe on mobile
// (left/right). Scoped per driver so the model is never offered a verb-foreign
// value, and the validator rejects one.
const DIRECTION_ENUM = { web: ["up", "down"], mobile: ["up", "down", "left", "right"] };

// Model-facing field descriptions: concise, verb-anchored, weak-model-tuned.
// They intentionally differ from the canonical schema's contract descriptions;
// load-bearing clauses (replaces the current value, label or value, relative to
// base_url) are preserved. Per-driver entries cover ref/direction wording.
const FIELD_DESC = {
  ref: {
    web: 'The element to act on, by its ref from the current page snapshot, e.g. "e3".',
    mobile: 'The element to act on, by its ref from the current screen snapshot, e.g. "e3".',
  },
  text: "For type: the text to enter. Replaces the element's current value.",
  submit: "For type: set true to press Enter after typing. Omit for no.",
  value: "For select: the visible label or value of the option to choose.",
  direction: {
    web: 'For scroll: "up" or "down".',
    mobile: "For scroll or swipe: the direction to move.",
  },
  url: "For navigate: an absolute URL, or a path relative to base_url.",
  seconds: "For wait: how many seconds to wait.",
  method: "For request: the HTTP method.",
  path: "For request: the path or URL, relative to base_url.",
  body: "For request: an optional body — a JSON value or a string.",
  headers: "For request: optional headers, as an object.",
  summary: "For done: what you accomplished, in the persona's voice.",
  reason: "For give_up: why you are stuck and cannot continue.",
};

const OVERLAY_FILE = { web: "actor-system.md", mobile: "actor-mobile.md", api: "actor-api.md" };

/** Normalize an arbitrary driver id to a known one ("web" default). */
export function normalizeDriver(driverId) {
  return DRIVER_VERBS[driverId] ? driverId : "web";
}

/**
 * @param {"web"|"mobile"|"api"} [driverId]
 * @returns {{ prompt: string }} the system-prompt overlay block for this driver.
 */
export function overlayFor(driverId = "web") {
  const id = normalizeDriver(driverId);
  return { prompt: readFileSync(join(promptsDir, OVERLAY_FILE[id]), "utf8").trim() };
}

/**
 * A model-facing field schema: the canonical field structure minus advisory
 * keywords (minimum/maximum/default), with a driver-scoped enum (direction) and
 * a concise, model-tuned description.
 */
function shippedField(id, name) {
  const { minimum, maximum, default: _default, description: _description, ...rest } = CANON_FIELDS[name];
  if (name === "direction") rest.enum = DIRECTION_ENUM[id];
  const desc = FIELD_DESC[name];
  rest.description = typeof desc === "string" ? desc : desc[id];
  return rest;
}

/**
 * The model-facing forced-tool `parameters`: only this driver's verbs and the
 * fields they use, advisory keywords stripped. Documentation, not enforcement —
 * the decoding endpoint ignores it; stepSchemaFor() is what validates.
 */
export function toolParamsFor(driverId = "web") {
  const id = normalizeDriver(driverId);
  const verbs = DRIVER_VERBS[id];
  const fields = [...new Set(verbs.flatMap((v) => VERB_FIELDS[v]))];
  const actionProps = { type: { enum: verbs, description: "The single thing to do this turn — exactly one of these." } };
  for (const f of fields) actionProps[f] = shippedField(id, f);
  const { thought, expectation, visual } = CANON.properties;
  return {
    type: "object",
    required: ["thought", "action", "expectation"],
    properties: {
      thought,
      action: { type: "object", required: ["type"], properties: actionProps },
      expectation,
      visual,
    },
  };
}

/**
 * The strict Ajv VALIDATION schema for a driver: the canonical flat schema with
 * `type`/`direction` enums scoped to the driver's verbs; $id/$schema stripped so
 * several driver schemas compile in one Ajv instance. Keeps additionalProperties,
 * the allOf per-verb requireds, and min/max — this is what forcedToolCall gates on.
 */
export function stepSchemaFor(driverId = "web") {
  const id = normalizeDriver(driverId);
  const { $id, $schema, ...rest } = CANON;
  const action = rest.properties.action;
  const properties = {
    ...action.properties,
    type: { ...action.properties.type, enum: DRIVER_VERBS[id] },
  };
  if (DIRECTION_ENUM[id]) properties.direction = { ...action.properties.direction, enum: DIRECTION_ENUM[id] };
  return { ...rest, properties: { ...rest.properties, action: { ...action, properties } } };
}

// VERB_FIELDS is a projection input, exported for the consistency test that
// pins it against the canonical schema's allOf requireds.
export const __testing = { VERB_FIELDS };
