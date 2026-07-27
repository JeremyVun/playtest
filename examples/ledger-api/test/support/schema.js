// A small, zero-dependency JSON-Schema validator, good enough for the shipped
// OpenAPI 3.1 document and nothing more. It is test support for proving a
// response body is document-conforming (openapi.test.js already proves the
// document is internally consistent; this is the piece that checks a
// concrete *value* against one of its schemas), not a product feature.
//
// Supported keywords: type (including union types like ["string","null"]),
// required, additionalProperties: false, enum, const, pattern, items,
// properties, allOf, minimum, and internal `$ref` resolution against the
// document passed in. `format` is intentionally ignored.

function typeMatches(value, expected) {
  switch (expected) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // an unrecognised type keyword is not this validator's job to police
  }
}

function describe(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Resolve one internal `#/a/b/c` ref against `document`. Throws if it dangles. */
function resolveRef(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`schema.js only resolves internal refs; got ${describe(ref)}`);
  }
  let cursor = document;
  for (const raw of ref.slice(2).split("/")) {
    const segment = decodeURIComponent(raw.replace(/~1/g, "/").replace(/~0/g, "~"));
    cursor = cursor?.[segment];
  }
  if (cursor === undefined) throw new Error(`cannot resolve $ref ${ref}`);
  return cursor;
}

function walk(document, schema, value, path, errors) {
  if (schema === null || typeof schema !== "object") return;

  if (typeof schema.$ref === "string") {
    walk(document, resolveRef(document, schema.$ref), value, path, errors);
    return;
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) walk(document, sub, value, path, errors);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${describe(value)}`);
      return; // further structural checks would just cascade noise
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${path}: expected one of ${describe(schema.enum)}, got ${describe(value)}`);
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${path}: expected const ${describe(schema.const)}, got ${describe(value)}`);
  }

  if (schema.pattern !== undefined && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: "${value}" does not match pattern ${schema.pattern}`);
  }

  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: ${value} is less than minimum ${schema.minimum}`);
  }

  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((item, index) => walk(document, schema.items, item, `${path}[${index}]`, errors));
  }

  const hasObjectKeywords =
    schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined;
  if (hasObjectKeywords && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in value) walk(document, propSchema, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

/**
 * Validate `value` against `schemaOrRef` (a schema object, or a `"#/..."` ref
 * string) resolved within `document`. Returns a list of human-readable
 * errors; empty means valid.
 */
export function validate(document, schemaOrRef, value) {
  const errors = [];
  const schema = typeof schemaOrRef === "string" ? { $ref: schemaOrRef } : schemaOrRef;
  walk(document, schema, value, "$", errors);
  return errors;
}
