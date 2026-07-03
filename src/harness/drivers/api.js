// The `api` driver: a REST/JSON API over fetch, behind the same Driver
// interface as web/mobile (CONTRACTS.md §16). Endpoints are the "elements", a
// request is the "action", the JSON response is what you "see" next. Every
// action IS a request, so network.requests (the six stable fields) is fully
// native and api_called/response_status are first-class; the full request +
// response bodies go to har.json (never the committed trajectory), the data
// source for response_matches and body-level assert.
//
// No new dependency: OpenAPI ingestion (optional) reuses the `yaml` parser the
// harness already loads. No screenshots/bbox — the viewer drops the film strip
// and cursor and leans on its network + a11y-text panels (which degrade already).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { firstLine } from "../trajectory.js";
import { overlayFor } from "./overlay.js";
import { MAX_BODY_READ, capBody, isTextualMime, pathnameOf, flushHar } from "./har.js";

const REQUEST_TIMEOUT_MS = 15000;
// max_ms mirrors the real per-request abort (REQUEST_TIMEOUT_MS) so the pinned
// settle descriptor doesn't overstate the ceiling a slow endpoint actually hits.
export const SETTLE_API = { name: "settle-api-v1", max_ms: REQUEST_TIMEOUT_MS };

export class ApiDriver {
  /** @returns {Promise<ApiDriver>} */
  static async launch({ env, runDir }) {
    fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
    let operations = [];
    if (env.openapi) {
      try {
        const spec = YAML.parse(fs.readFileSync(env.openapi, "utf8"));
        operations = operationsFrom(spec);
      } catch {
        // a bad/unreadable spec degrades to exploratory (no [eN] ops), never throws
      }
    }
    return new ApiDriver({ baseUrl: env.base_url, runDir, operations });
  }

  #baseUrl;
  #runDir;
  #operations;
  #har = [];
  #lastResponse = null; // { status, mime, body } for the snapshot + effectToken

  constructor({ baseUrl, runDir, operations }) {
    this.#baseUrl = baseUrl;
    this.#runDir = runDir;
    this.#operations = operations ?? [];
  }

  get id() {
    return "api";
  }
  get settle() {
    return SETTLE_API;
  }
  get snapshotFormat() {
    return "api-text-v1";
  }
  get overlay() {
    return overlayFor("api");
  }

  /**
   * No prime request: the api driver issues ONLY the actor's explicit requests,
   * so the gate's trajectory is never polluted by a synthetic GET (a prime would
   * let api_called/response_status/url_matches pass off it even when the actor
   * made no matching request). prepareEnv already health-probed the base URL.
   */
  async start() {
    return { ok: true, error: null, resolution: null, settle_ms: 0, url: this.#baseUrl, perf: null, network: { requests: [] }, har_entries: [] };
  }

  location() {
    return this.#lastResponse?.url ?? this.#baseUrl ?? null;
  }

  consoleErrors() {
    return 0;
  }

  /** Transport-defined no_effect token: a fingerprint of the last response. */
  async effectToken() {
    return this.#lastResponse ? `${this.#lastResponse.status}|${this.#lastResponse.body ?? ""}` : null;
  }

  /** Element-exists has no API analog — config scopes element_exists/screen_shows away from api. */
  async finalPageCheck() {
    return false;
  }

  /**
   * The API surface as text: base URL + the operations (when a spec is given) +
   * the actual last response body, pretty-printed and capped. Written to
   * steps/NNN.a11y.txt; no screenshot (the viewer drops the film strip).
   */
  async captureSnapshot(stepNum) {
    const lines = [`API: ${this.#baseUrl}`];
    if (this.#operations.length) {
      this.#operations.forEach((op, i) => {
        lines.push(`[e${i + 1}] ${op.method} ${op.path}${op.summary ? ` — ${op.summary}` : ""}`);
      });
    } else {
      lines.push("(no OpenAPI spec — infer endpoints from the task; a request is one action)");
    }
    if (this.#lastResponse) {
      lines.push("", `Last response: ${this.#lastResponse.status}${this.#lastResponse.mime ? ` ${this.#lastResponse.mime}` : ""}`);
      lines.push(prettyCap(this.#lastResponse.body));
    }
    const text = lines.join("\n");
    try {
      fs.writeFileSync(path.join(this.#runDir, "steps", `${String(stepNum).padStart(3, "0")}.a11y.txt`), text + "\n");
    } catch {}
    return { text, url: this.location(), title: this.#baseUrl, refCount: this.#operations.length, truncated: false, screenshot: null };
  }

  async execute(action) {
    if (action?.type === "wait") {
      const ms = Math.min(10, Math.max(0.1, Number(action.seconds) || 1)) * 1000;
      await new Promise((r) => setTimeout(r, ms));
      // resolution.locator: null keeps wait steps on the act-mode replay track
      // (trajectory.js keys actionTrack on resolution), matching web/mobile.
      return this.#ok({ resolution: { locator: null, bbox: null }, network: { requests: [] }, har_entries: [], settle_ms: ms });
    }
    if (action?.type !== "request") return this.#fail(`action type "${action?.type}" is not executable on api`);
    return this.#request(action, { resolution: { locator: `${action.method} ${action.path}`, bbox: null } });
  }

  async executeLocator(actedStep) {
    const action = actedStep.agent?.action ?? actedStep.action;
    if (action?.type !== "request") return this.execute(action ?? {});
    return this.#request(action, { resolution: { locator: `${action.method} ${action.path}`, bbox: null } });
  }

  async close() {
    this.#flushHar();
  }

  // ---- internals ----

  async #request(action, { resolution }) {
    const method = String(action.method || "GET").toUpperCase();
    let url;
    try {
      url = new URL(action.path, this.#baseUrl).href;
    } catch {
      return this.#fail(`invalid request path "${action.path}"`);
    }
    const hasBody = action.body !== undefined && action.body !== null && method !== "GET" && method !== "HEAD";
    const reqBodyText = hasBody ? (typeof action.body === "string" ? action.body : JSON.stringify(action.body)) : null;
    // Default JSON content-type only when the caller didn't set one (any casing),
    // so we never emit a duplicate differently-cased Content-Type header.
    const userHeaders = action.headers ?? {};
    const hasContentType = Object.keys(userHeaders).some((h) => h.toLowerCase() === "content-type");
    const headers = {
      ...(hasBody && typeof action.body !== "string" && !hasContentType ? { "content-type": "application/json" } : {}),
      ...userHeaders,
    };

    const index = this.#har.length;
    const entry = {
      startedDateTime: new Date().toISOString(),
      time: -1,
      request: { method, url, headers, body: capBody(reqBodyText) },
      response: { status: 0, bodySize: -1, mimeType: "", headers: null, body: null },
      _failed: false,
    };
    this.#har.push(entry);

    const started = Date.now();
    let error = null;
    let status = 0;
    let mime = "";
    let respBody = null;
    try {
      const res = await fetch(url, { method, headers, body: reqBodyText, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      status = res.status;
      const respHeaders = Object.fromEntries(res.headers.entries());
      mime = (respHeaders["content-type"] || "").split(";")[0].trim();
      const len = parseInt(respHeaders["content-length"], 10);
      // Capture text/JSON only, and never buffer a body whose declared length
      // exceeds the read cap (binary + huge bodies are recorded by size alone).
      const tooBig = Number.isFinite(len) && len > MAX_BODY_READ;
      const text = isTextualMime(mime) && !tooBig ? await res.text().catch(() => "") : "";
      respBody = isTextualMime(mime) && !tooBig ? capBody(text) : null;
      entry.response = { status, bodySize: Number.isFinite(len) ? len : text ? Buffer.byteLength(text) : -1, mimeType: mime, headers: respHeaders, body: respBody };
    } catch (e) {
      error = firstLine(e);
      entry._failed = true;
    }
    entry.time = Date.now() - started;
    this.#flushHar();
    this.#lastResponse = { status, mime, body: respBody, url: pathnameOf(url) };

    const network = {
      requests: [{ method, url, path: pathnameOf(url), status, mime_type: mime, failed: entry._failed }],
    };
    return {
      ok: !error,
      error,
      resolution,
      settle_ms: entry.time,
      url: pathnameOf(url),
      perf: null, // api perf (latency) is deferred (design); gate perf keys are config-errored on api
      har_entries: [index],
      network,
    };
  }

  #ok({ resolution, network, har_entries, settle_ms }) {
    return { ok: true, error: null, resolution, settle_ms, url: this.location(), perf: null, har_entries, network };
  }

  #fail(error) {
    return { ok: false, error, resolution: null, settle_ms: 0, url: this.location(), perf: null, har_entries: [], network: { requests: [] } };
  }

  #flushHar() {
    try {
      flushHar(this.#runDir, this.#har);
    } catch {}
  }
}

// OpenAPI paths → flat operation list. Tolerant: any shape that isn't
// recognizable yields []. No $ref resolution (summaries are best-effort).
function operationsFrom(spec) {
  const ops = [];
  const paths = spec?.paths;
  if (!paths || typeof paths !== "object") return ops;
  for (const [p, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const op = item[method];
      if (op) ops.push({ method: method.toUpperCase(), path: p, summary: op.summary ?? op.operationId ?? "" });
    }
  }
  return ops;
}

function prettyCap(body) {
  if (body == null) return "(no body)";
  try {
    return capBody(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    return capBody(String(body));
  }
}
