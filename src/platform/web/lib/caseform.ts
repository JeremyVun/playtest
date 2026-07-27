// The story form's model (UX principle 3: "Form first, YAML always" — the form and
// the YAML toggle are two views of the identical bytes). Uses the vendored `yaml`
// library's Document API: form edits are applied to the parsed source document IN
// PLACE, so comments, key order, quoting and block styles survive — only the fields
// the user actually changed are re-emitted. The server's core validators remain the
// source of truth — the form never re-validates.
import { parse, parseDocument, stringify, Scalar, Pair } from "../vendor/yaml/dist/index.js";

// Built-in success kinds and the drivers they're valid under (mirrors core
// config.ts SUCCESS_KIND_DRIVERS — the success-criteria builder offers only the
// driver's valid kinds, UX story editor).
export const SUCCESS_KINDS: WebDynamic = {
  assert: ["web", "mobile", "api"],
  element_exists: ["web"],
  url_matches: ["web", "api"],
  api_called: ["web", "api"],
  console_errors: ["web"],
  accessibility_violations: ["web"],
  screen_shows: ["mobile"],
  response_status: ["api"],
  response_matches: ["api"],
  invariant: ["api"],
};

// Kinds whose value may be a structured object rather than a scalar: an
// operation selector (response_status / response_matches) or an invariant
// policy. The form has one text input per row, so those values round-trip as
// their compact flow form — see criterionToRow / coerce.
const STRUCTURED_KINDS: WebDynamic = new Set(["response_status", "response_matches", "invariant"]);

export const kindsForDriver = (driver: WebDynamic) =>
  Object.keys(SUCCESS_KINDS).filter((k) => SUCCESS_KINDS[k].includes(driver || "web"));

// No line folding (long asserts stay on one line, like the repo's case files) and
// no flow padding (`[smoke]`, not `[ smoke ]` — the repo house style), so an edit
// to one field never reformats a neighbouring flow collection.
const EMIT_OPTS: WebDynamic = { lineWidth: 0, flowCollectionPadding: false };

/** parse(yaml) → object; throws on invalid YAML (caller shows the message). */
export function parseYaml(text: WebDynamic) {
  const obj = parse(text || "");
  return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
}

/** A flat model of the story fields the form edits. */
export function toModel(obj: WebDynamic) {
  return {
    story: obj.story ?? "",
    description: obj.description ?? "",
    persona: Array.isArray(obj.persona) ? obj.persona.join(", ") : obj.persona ?? "",
    tags: Array.isArray(obj.tags) ? obj.tags.join(", ") : obj.tags ?? "",
    mode: obj.mode ?? "journey",
    success: (Array.isArray(obj.success) ? obj.success : []).map(criterionToRow),
  };
}

function criterionToRow(c: WebDynamic) {
  if (!c || typeof c !== "object") return { kind: "assert", value: String(c ?? ""), label: "" };
  const label = c.label ?? "";
  const kind = Object.keys(c).find((k) => k !== "label") ?? "assert";
  const raw = c[kind];
  // A structured value has no scalar form, and `String(obj)` would flatten it to
  // "[object Object]" — so editing any OTHER row would silently destroy this one.
  // Show it as its compact flow form (valid YAML, and JSON is a subset of it);
  // coerce() parses the same text back on write.
  if (raw && typeof raw === "object") return { kind, value: JSON.stringify(raw), label };
  return { kind, value: String(raw ?? ""), label };
}

/**
 * Apply the form model back onto the YAML source text. Only fields whose value
 * actually differs from what the text already says are touched; everything else —
 * comments, unknown keys (app/perf/report/vision/…), quoting, block styles — keeps
 * its original bytes. Returns the new text. Throws on invalid YAML.
 */
export function applyModelToText(text: WebDynamic, model: WebDynamic) {
  const doc = parseDocument(text || "");
  if (doc.errors?.length) throw doc.errors[0];
  if (!doc.contents || !Array.isArray(doc.contents.items)) {
    // Empty or non-map source (a new file, or a scalar doc): build fresh.
    return stringify(freshObject(model), EMIT_OPTS);
  }
  const cur = toModel(doc.toJS() ?? {});
  let changed = false;
  const apply = (key: WebDynamic, value: WebDynamic) => { setOrDeleteKey(doc, key, value); changed = true; };

  if ((model.story ?? "") !== cur.story) apply("story", model.story?.trim() ? model.story : null);
  if ((model.description ?? "") !== cur.description) {
    apply("description", model.description?.trim() ? model.description : null);
  }
  const personas = splitList(model.persona);
  if (!sameList(personas, splitList(cur.persona))) {
    apply("persona", personas.length ? (personas.length === 1 ? personas[0] : personas) : null);
  }
  const tags = splitList(model.tags);
  if (!sameList(tags, splitList(cur.tags))) apply("tags", tags.length ? tags : null);
  if (model.mode !== cur.mode) {
    // journey is the default — write the key only for discovery, drop it otherwise.
    apply("mode", model.mode === "discovery" ? "discovery" : null);
  }
  const success = successRows(model);
  if (!sameSuccess(success, successRows({ success: cur.success }))) {
    apply("success", success.length ? success.map(rowToCriterion) : null);
  }
  // Untouched fields keep their source bytes; an untouched FILE is returned verbatim.
  return changed ? doc.toString(EMIT_OPTS) : text;
}

function freshObject(model: WebDynamic) {
  const out: WebDynamic = {};
  if (model.story?.trim()) out.story = model.story;
  if (model.description?.trim()) out.description = model.description;
  const personas = splitList(model.persona);
  if (personas.length) out.persona = personas.length === 1 ? personas[0] : personas;
  const tags = splitList(model.tags);
  if (tags.length) out.tags = tags;
  if (model.mode === "discovery") out.mode = "discovery";
  const success = successRows(model);
  if (success.length) out.success = success.map(rowToCriterion);
  return out;
}

const successRows = (model: WebDynamic) =>
  (model.success || []).filter((r: WebDynamic) => r.kind && String(r.value).trim() !== "");

const sameList = (a: WebDynamic, b: WebDynamic) => a.length === b.length && a.every((x: WebDynamic, i: WebDynamic) => x === b[i]);
const sameSuccess = (a: WebDynamic, b: WebDynamic) =>
  a.length === b.length &&
  a.every((r: WebDynamic, i: WebDynamic) => r.kind === b[i].kind && String(r.value) === String(b[i].value) && (r.label || "") === (b[i].label || ""));

function rowToCriterion(row: WebDynamic) {
  const val = coerce(row.kind, row.value);
  return row.label ? { [row.kind]: val, label: row.label } : { [row.kind]: val };
}

// Numeric kinds read nicer unquoted; coerce a clean integer string to a number.
// NOTE: response_status is deliberately NOT here — the form authors the bare
// form, which case.schema.json types as a string ("200" or "2xx"). (The schema
// also accepts a structured operation selector object; the form does not author
// one.) Ajv runs without coerceTypes, so a number fails validation for the most
// common api-driver criterion.
const NUMERIC: WebDynamic = new Set(["console_errors", "accessibility_violations"]);
function coerce(kind: WebDynamic, value: WebDynamic) {
  const s = String(value).trim();
  // The structured form of an operation selector or an invariant policy, as
  // criterionToRow rendered it (or as a user typed it). Parsed back into a real
  // mapping so the emitted YAML is the object the schema expects, not a string
  // that looks like one. Only for kinds that accept an object, and only for text
  // that actually opens a flow mapping — an unparseable value stays a string and
  // the server's validator names it.
  if (STRUCTURED_KINDS.has(kind) && s.startsWith("{")) {
    try {
      const parsed = parse(s);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  if (NUMERIC.has(kind) && /^\d+$/.test(s)) return Number(value);
  return value;
}

const splitList = (s: WebDynamic) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// ---------- document surgery ----------

// Story-ish keys first, matching how case files read in the repo; unknown keys
// keep their existing position (we never move a pair the user didn't edit).
const KEY_ORDER: WebDynamic = ["story", "description", "persona", "tags", "mode", "app", "success", "perf", "report"];
const rank = (k: WebDynamic) => { const i = KEY_ORDER.indexOf(k); return i === -1 ? KEY_ORDER.length : i; };

/** Set (in KEY_ORDER position for new keys, in place for existing) or delete a top-level key. */
function setOrDeleteKey(doc: WebDynamic, key: WebDynamic, value: WebDynamic) {
  const items = doc.contents.items;
  const at = items.findIndex((p: WebDynamic) => p.key?.value === key);
  if (value === null) {
    if (at !== -1) items.splice(at, 1);
    return;
  }
  const node = doc.createNode(value);
  // A multi-line story reads best as a block literal (`story: |`), which is also
  // what the template and every committed case use.
  if (typeof value === "string" && value.includes("\n")) node.type = Scalar.BLOCK_LITERAL;
  if (at !== -1) {
    items[at].value = node;
    return;
  }
  const pair = new Pair(new Scalar(key), node);
  let idx = items.length;
  for (let i = 0; i < items.length; i++) {
    if (rank(items[i].key?.value) > rank(key)) { idx = i; break; }
  }
  items.splice(idx, 0, pair);
}
