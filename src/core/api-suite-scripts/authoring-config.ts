import type { DynamicValue } from "./types.ts";

// The authoring job file (src/core/schemas/authoring-job.schema.json).
//
// One document describes a job: the target and its recorded authorization, where
// the OpenAPI document comes from, the approved rule statements, the credential
// references, and the budgets. It is what `playtest script author` reads and
// what the hosted authoring job is assembled from — same shape, same validation,
// same messages, so a user who moves between them is not learning twice.
//
// Every failure here is user input, so every failure is a DummyConfigError with
// an actionable message and no stack.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import YAML from "yaml";

import { DummyConfigError } from "../config.ts";
import { normalizeRules, parseInvariantRules } from "./handout.ts";

const SCHEMA = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../schemas/authoring-job.schema.json", import.meta.url)), "utf8"));
// @ts-expect-error -- Ajv's TS 7 ESM declaration is not constructable although its default runtime export is.
const validate = new Ajv({ allErrors: true, strict: false }).compile(SCHEMA);

/** Ajv errors → one actionable sentence per problem, in the user's vocabulary. */
const describe = (errors: DynamicValue) =>
  (errors ?? [])
    .map((error: DynamicValue) => {
      const at = error.instancePath ? error.instancePath.slice(1).replace(/\//g, ".") : "the job";
      if (error.keyword === "additionalProperties") return `${at}: unknown key "${error.params.additionalProperty}"`;
      if (error.keyword === "required") return `${at}: "${error.params.missingProperty}" is required`;
      return `${at} ${error.message}`;
    })
    .filter((line: DynamicValue, index: DynamicValue, all: DynamicValue) => all.indexOf(line) === index);

function readDocument(file: DynamicValue) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return /\.ya?ml$/i.test(file) ? YAML.parse(text) : JSON.parse(text);
  } catch (error: DynamicValue) {
    throw new DummyConfigError(`${file}: could not be parsed — ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

/** Load approved rule statements from a sidecar document. */
function readRulesFile(file: DynamicValue, where: DynamicValue) {
  if (!fs.existsSync(file)) throw new DummyConfigError(`${where}: no rule statements at ${file}`);
  if (/\.json$/i.test(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : (parsed.rules ?? []);
  }
  return parseInvariantRules(fs.readFileSync(file, "utf8"));
}

/**
 * Parse and resolve an authoring job document.
 *
 * @param {object} document the parsed job
 * @param {{ dir?: string, where?: string }} context `dir` is what relative paths resolve against
 * @returns {object} options for `runAuthoringJob`
 */
export function resolveAuthoringConfig(document: DynamicValue, { dir = process.cwd(), where = "authoring job" }: DynamicValue = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new DummyConfigError(`${where}: expected an object`);
  if (!validate(document)) throw new DummyConfigError(`${where}:\n  ${describe(validate.errors).join("\n  ")}`);

  const resolved: DynamicValue = { ...document, where };
  if (typeof document.spec === "string" && !/^https?:\/\//i.test(document.spec)) resolved.spec = { file: path.resolve(dir, document.spec) };
  else if (document.spec?.file) resolved.spec = { ...document.spec, file: path.resolve(dir, document.spec.file) };

  if (typeof document.rules === "string") resolved.rules = readRulesFile(path.resolve(dir, document.rules), where);
  resolved.rules = normalizeRules(resolved.rules ?? [], { where: `${where}: rules` });

  resolved.out_dir = path.resolve(dir, document.out_dir ?? "authoring");
  return resolved;
}

/**
 * Load an authoring job from a file. Paths inside it resolve relative to the
 * file, the way every other Playtest document behaves.
 */
export function loadAuthoringJob(file: DynamicValue, { where = null }: DynamicValue = {}) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new DummyConfigError(`no authoring job at ${absolute}`);
  return resolveAuthoringConfig(readDocument(absolute), { dir: path.dirname(absolute), where: where ?? absolute });
}
