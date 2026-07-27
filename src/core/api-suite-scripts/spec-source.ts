import type { DynamicValue } from "./types.ts";

// Spec provisioning for script suites
// (docs/contracts/scripts.md#spec-provisioning).
//
// DESIGN §4 step 1: a user pastes a base URL and the platform finds the API's
// OpenAPI document — at a conventional path, behind a spec link header, at a URL
// they give, or from a document they upload or paste. Whichever way it arrives,
// the document is written to the run's work directory and resolved through the
// shipped P3 enrichment (../openapi.ts), so a provisioned spec is the same
// enriched object the Tier-1 policies and the obligation manifest already read,
// with the same hermetic boundary rules: internal pointers resolve, file refs
// resolve only inside the document's own directory, a network `$ref` is refused.
//
// Fetching the ROOT document over the network is the one thing this module adds,
// and it is explicit — the user asked for a URL, or asked for discovery against
// the target they authorized. Nothing it fetches gains the right to fetch more.
//
// There is no degraded mode. A missing or unresolvable spec is a DummyConfigError
// naming what was tried and what to set instead: a suite authored without a spec
// would silently lose every operation obligation, which is precisely the vacuity
// N5 exists to prevent.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { DummyConfigError } from "../config.ts";
import { loadOpenApi, MAX_SPEC_BYTES } from "../openapi.ts";

/** Conventional locations auto-discovery probes, in order. */
export const SPEC_DISCOVERY_PATHS: DynamicValue = Object.freeze([
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/v3/api-docs",
  "/api-docs",
  "/.well-known/openapi.json",
]);

/** Link-header relation types that announce a machine-readable description. */
export const SPEC_LINK_RELS: DynamicValue = Object.freeze(["service-desc", "describedby", "openapi"]);

/** How the resolved document arrived. */
export const SPEC_SOURCE_KINDS: DynamicValue = Object.freeze(["file", "url", "document", "discovered"]);

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Normalize a spec declaration into exactly one provisioning mode.
 *
 * Accepted shapes, all equivalent to the hosted environment form:
 *   null | undefined | true | "discover"      → auto-discovery against base_url
 *   "…/openapi.yaml" | "https://…"            → file path, or URL when it is one
 *   { file } { url } { document } { text } { discover: true, paths?: [] }
 *   false                                     → refused: there is no "no spec" mode
 */
export function normalizeSpecDeclaration(declaration: DynamicValue, { where = "spec" }: DynamicValue = {}) {
  if (declaration === false) {
    throw new DummyConfigError(
      `${where}: an authored suite needs an OpenAPI document — set spec.url, spec.file, paste it into spec.document,` +
        " or leave spec unset to auto-discover it on the target",
    );
  }
  if (declaration === null || declaration === undefined || declaration === true || declaration === "discover") {
    return { kind: "discovered", paths: [...SPEC_DISCOVERY_PATHS] };
  }
  if (typeof declaration === "string") {
    const value = declaration.trim();
    if (!value) return { kind: "discovered", paths: [...SPEC_DISCOVERY_PATHS] };
    if (/^https?:\/\//i.test(value)) return { kind: "url", url: value };
    return { kind: "file", file: value };
  }
  if (typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new DummyConfigError(`${where}: expected a path, a URL, or { file | url | document | text | discover }`);
  }

  const modes = ["file", "url", "document", "text"].filter((key) => declaration[key] !== undefined && declaration[key] !== null);
  if (modes.length > 1) {
    throw new DummyConfigError(`${where}: name exactly one of file, url, document, or text (got ${modes.join(", ")})`);
  }
  const paths = declaration.paths ? [...declaration.paths] : [...SPEC_DISCOVERY_PATHS];
  if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string" || !entry.startsWith("/"))) {
    throw new DummyConfigError(`${where}: spec.paths entries are absolute paths on the target, e.g. "/openapi.json"`);
  }
  if (!modes.length) return { kind: "discovered", paths };
  if (modes[0] === "file") {
    if (typeof declaration.file !== "string" || !declaration.file.trim()) throw new DummyConfigError(`${where}: spec.file must be a path`);
    return { kind: "file", file: declaration.file.trim() };
  }
  if (modes[0] === "url") {
    if (typeof declaration.url !== "string" || !/^https?:\/\//i.test(declaration.url.trim())) {
      throw new DummyConfigError(`${where}: spec.url must be an http(s) URL (got ${JSON.stringify(declaration.url ?? null)})`);
    }
    return { kind: "url", url: declaration.url.trim() };
  }
  if (modes[0] === "document") {
    if (typeof declaration.document !== "object" || Array.isArray(declaration.document)) {
      throw new DummyConfigError(`${where}: spec.document must be the parsed OpenAPI object — use spec.text for YAML or raw JSON`);
    }
    return { kind: "document", document: declaration.document };
  }
  if (typeof declaration.text !== "string" || !declaration.text.trim()) {
    throw new DummyConfigError(`${where}: spec.text must be the document as JSON or YAML text`);
  }
  return { kind: "document", text: declaration.text };
}

/** Does this text parse as a document that looks like OpenAPI? */
function parseSpecText(text: DynamicValue, { where, from }: DynamicValue) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new DummyConfigError(`${where}: ${from} is empty`);
  let parsed;
  try {
    parsed = trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(trimmed) : YAML.parse(trimmed);
  } catch (error: DynamicValue) {
    throw new DummyConfigError(`${where}: ${from} is not parseable as JSON or YAML — ${String(error?.message ?? error).split("\n")[0]}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.paths || typeof parsed.paths !== "object") {
    throw new DummyConfigError(`${where}: ${from} has no "paths" object — this does not look like an OpenAPI 3.x document`);
  }
  return parsed;
}

/** Same test, without throwing: discovery probes many candidates and keeps the first real one. */
function looksLikeSpec(text: DynamicValue) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = trimmed.startsWith("{") ? JSON.parse(trimmed) : YAML.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.paths && typeof parsed.paths === "object") return parsed;
  } catch {
    return null;
  }
  return null;
}

async function fetchText(url: DynamicValue, { fetchImpl, where }: DynamicValue) {
  const impl = fetchImpl ?? globalThis.fetch;
  if (typeof impl !== "function") throw new DummyConfigError(`${where}: no fetch implementation is available to retrieve ${url}`);
  const response = await impl(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await response.text();
  if (text.length > MAX_SPEC_BYTES) {
    throw new DummyConfigError(`${where}: ${url} returned ${Math.round(text.length / 1024)}KB, over the ${Math.round(MAX_SPEC_BYTES / 1024)}KB ingestion cap`);
  }
  return { status: response.status, ok: response.ok, text, headers: response.headers };
}

/** `Link: <…>; rel="service-desc"` → the absolute URLs it announces. */
export function specLinksFrom(headerValue: DynamicValue, baseUrl: DynamicValue) {
  const out: DynamicValue = [];
  for (const part of String(headerValue ?? "").split(/,(?=\s*<)/)) {
    const match = part.match(/<([^>]+)>/);
    if (!match) continue;
    const rel = (part.match(/rel\s*=\s*"?([^";]+)"?/i)?.[1] ?? "").trim().toLowerCase();
    if (!SPEC_LINK_RELS.includes(rel)) continue;
    try {
      out.push(new URL(match[1]!.trim(), baseUrl).href); // TODO(ts): the successful regex match guarantees capture group one
    } catch {
      // A malformed link header is not a configuration error the user can act on.
    }
  }
  return out;
}

/**
 * Resolve one run's OpenAPI document.
 *
 * @param {object|string|null} declaration the spec provisioning declaration
 * @param {{ baseUrl?: string, workDir: string, where?: string, fetchImpl?: Function }} context
 * @returns {Promise<{ spec: object, source: { kind: string, detail: string, file: string, attempted?: string[] } }>}
 * @throws {DummyConfigError} when no document can be resolved — never a degraded mode
 */
export async function resolveSpecSource(declaration: DynamicValue, { baseUrl = null, workDir, where = "spec", fetchImpl = null }: DynamicValue = {}) {
  if (!workDir) throw new DummyConfigError(`${where}: a work directory is required to materialize the resolved document`);
  const mode: DynamicValue = normalizeSpecDeclaration(declaration, { where });
  fs.mkdirSync(workDir, { recursive: true });

  const materialize = (text: DynamicValue, extension: DynamicValue) => {
    const file = path.join(workDir, `openapi.${extension}`);
    fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
    return file;
  };
  const enrich = (file: DynamicValue, detail: DynamicValue, extra: DynamicValue = {}) => ({
    spec: loadOpenApi(file, { where: `${where} (${detail})` }),
    source: { kind: mode.kind, detail, file, ...extra },
  });

  if (mode.kind === "file") {
    const file = path.resolve(mode.file);
    if (!fs.existsSync(file)) {
      throw new DummyConfigError(`${where}: no OpenAPI document at ${file} — check spec.file, which resolves relative to the working directory`);
    }
    return enrich(file, file);
  }

  if (mode.kind === "document") {
    const parsed = mode.document ?? parseSpecText(mode.text, { where, from: "spec.text" });
    if (mode.document) parseSpecText(JSON.stringify(parsed), { where, from: "spec.document" });
    return enrich(materialize(`${JSON.stringify(parsed, null, 2)}`, "json"), mode.document ? "spec.document" : "spec.text");
  }

  if (mode.kind === "url") {
    let answer;
    try {
      answer = await fetchText(mode.url, { fetchImpl, where });
    } catch (error: DynamicValue) {
      if (error instanceof DummyConfigError) throw error;
      throw new DummyConfigError(
        `${where}: could not fetch the OpenAPI document from ${mode.url} — ${String(error?.message ?? error)}.` +
          " Check the URL is reachable from here, or upload the document instead (spec.document / spec.text).",
      );
    }
    if (!answer.ok) {
      throw new DummyConfigError(`${where}: ${mode.url} answered ${answer.status} — the OpenAPI document is not served there`);
    }
    const parsed = parseSpecText(answer.text, { where, from: mode.url });
    const isJson = answer.text.trim().startsWith("{");
    return enrich(materialize(isJson ? `${JSON.stringify(parsed, null, 2)}` : answer.text, isJson ? "json" : "yaml"), mode.url);
  }

  // ---- auto-discovery -------------------------------------------------------
  if (!baseUrl) {
    throw new DummyConfigError(`${where}: auto-discovery needs the target's base URL — set target.base_url, or name the document with spec.url / spec.file`);
  }
  const origin = new URL(baseUrl).href.replace(/\/+$/, "");
  const attempted: DynamicValue = [];
  const candidates = mode.paths.map((suffix: DynamicValue) => `${origin}${suffix}`);

  const tryCandidate = async (url: DynamicValue) => {
    attempted.push(url);
    let answer;
    try {
      answer = await fetchText(url, { fetchImpl, where });
    } catch {
      return null;
    }
    if (!answer.ok) return null;
    const parsed = looksLikeSpec(answer.text);
    if (!parsed) return null;
    const isJson = answer.text.trim().startsWith("{");
    return enrich(materialize(isJson ? `${JSON.stringify(parsed, null, 2)}` : answer.text, isJson ? "json" : "yaml"), url, { attempted: [...attempted] });
  };

  for (const url of candidates) {
    const hit = await tryCandidate(url);
    if (hit) return hit;
  }

  // The link header is the standards-blessed announcement; probe it after the
  // conventional paths so discovery stays deterministic when both exist.
  try {
    const root = await fetchText(`${origin}/`, { fetchImpl, where });
    for (const url of specLinksFrom(root.headers?.get?.("link"), `${origin}/`)) {
      const hit = await tryCandidate(url);
      if (hit) return hit;
    }
  } catch {
    // A target that will not answer its root is simply undiscoverable.
  }

  throw new DummyConfigError(
    `${where}: ${origin} exposes no OpenAPI document — auto-discovery tried ${attempted.length} location(s)` +
      ` (${mode.paths.join(", ")}) and the spec link header, and found none.\n` +
      "  Point spec.url at the document, set spec.file to a local copy, or paste it in (spec.document / spec.text).\n" +
      "  An authored suite is not run without one: every operation obligation comes from the document.",
  );
}
