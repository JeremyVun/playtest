// Schema loading and Ajv validation for playtest.yaml / case files, plus the
// built-in success-criterion vocabulary derived from the case schema.
// See docs/contracts/engine.md#discovery-and-configuration.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import type { ErrorObject, SchemaObject, ValidateFunction } from "ajv";

type JsonSchema = SchemaObject;

const here = path.dirname(fileURLToPath(import.meta.url));
const loadSchema = (name: string): JsonSchema => JSON.parse(readFileSync(path.join(here, "..", "schemas", name), "utf8"));
// @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor as a module namespace.
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true }); // timeout/perf accept "90s" | 90000
const caseSchema = loadSchema("case.schema.json");
export const validateCaseBase = ajv.compile(caseSchema);
export const validateDefaults = ajv.compile(loadSchema("defaults.schema.json"));

// The built-in success kinds, derived from the schema itself (its success-item
// properties minus the cosmetic `label`) so there is ONE source of truth: the
// keys an assertion may not shadow are exactly the keys case.schema.json already
// names. assertions.ts imports this for its collision check.
export const BUILTIN_SUCCESS_KINDS = new Set(
  Object.keys(caseSchema.properties.success.items.properties).filter((k) => k !== "label"),
);

// The case validator is per-suite, not a singleton: a suite's custom assertions
// (assertions.ts) inject their owned success keys into a CLONE of case.schema.json
// (success-item properties += { <key>: ASSERTION_VALUE_TYPE }; additionalProperties
// STAYS false so a typo'd key is still a named error, not a silent no-op). With no
// assertion keys the clone is acceptance-identical to validateCaseBase, so the web
// golden is unaffected. Cached by the set of injected keys (a join), so suites
// that register the same keys share a compiled validator.

// An assertion's success value is opaque to core (the assertion owns its grammar), so we
// accept any JSON scalar — string | number | boolean — not just string. This lets
// `dummy_expect_min_steps: 3` be written unquoted, the way the built-in numeric
// `console_errors: 5` is, instead of forcing `"3"`. The assertion's verdict() still
// receives the value as-authored and coerces it (e.g. Number(value)).
const ASSERTION_VALUE_TYPE = { type: ["string", "number", "boolean"] };
const caseValidatorCache = new Map<string, ValidateFunction>(); // keys.join("\0") → compiled Ajv validator
export function caseValidatorFor(assertionKeys: string[]): ValidateFunction {
  if (assertionKeys.length === 0) return validateCaseBase;
  const cacheKey = [...assertionKeys].sort().join("\0");
  let validate = caseValidatorCache.get(cacheKey);
  if (validate) return validate;
  // loadSchema re-reads + parses from disk, so this is already a private fresh
  // copy — safe to mutate without an extra deep clone.
  const schema = loadSchema("case.schema.json");
  // The clone carries the base schema's $id; Ajv refuses a duplicate id, so give
  // the per-suite clone its own id derived from the injected keys.
  schema.$id = `dummy/case.schema.json#assertions:${cacheKey}`;
  const props = schema.properties.success.items.properties;
  for (const key of assertionKeys) props[key] = { ...ASSERTION_VALUE_TYPE };
  validate = ajv.compile(schema) as ValidateFunction;
  caseValidatorCache.set(cacheKey, validate);
  return validate;
}

/** Ajv errors -> one friendly line naming each offending key. */
export function describeSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  const msgs = errors!.map((e) => { // SAFETY: this formatter is only called after the corresponding Ajv validation fails
    const at = e.instancePath.slice(1).split("/").join(".");
    if (e.keyword === "additionalProperties") {
      // Success-item keys that aren't a built-in kind and no assertion claims get the
      // assertion-hint appended — the likeliest fix is a missing/misnamed assertion.
      const hint = /^\/success\/\d+$/.test(e.instancePath)
        ? ` (is the assertion under assertions/ and does it register this key?)`
        : "";
      return `unknown key "${at ? `${at}.` : ""}${e.params.additionalProperty}"${hint}`;
    }
    if (e.keyword === "required") {
      return `missing required "${at ? `${at}.` : ""}${e.params.missingProperty}"`;
    }
    if (e.keyword === "enum") {
      return `"${at}" must be one of ${e.params.allowedValues.join("/")}`;
    }
    if (e.keyword === "minItems") {
      return `"${at}" must list at least ${e.params.limit} ${e.params.limit === 1 ? "entry" : "entries"}`;
    }
    if (e.keyword === "uniqueItems") {
      return `"${at}" has duplicate entries`;
    }
    return `${at ? `"${at}" ` : ""}${e.message}`;
  });
  return [...new Set(msgs)].join("; ");
}
