// The `api` driver: a REST/JSON API over fetch, behind the same Driver
// interface as web/mobile (docs/contracts/engine.md#api-driver). Endpoints are
// the "elements", a
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
import { firstLine, actionOf, API_PROJECTION_MARKER } from "../trajectory.ts";
import { overlayFor } from "./overlay.ts";
import { MAX_BODY_READ, capBody, isTextualMime, pathnameOf, createHarFlusher, relativizeUrls } from "./har.ts";
import { isSecretRef, redactSecrets, resolveSecretRefs, secretNameForValue } from "../secrets.ts";
import { applyMatchRules, canonicalStatus, existsAt, pathSegments, replaceAt, shapeOf } from "../match.ts";
import { applyBindings, indexProducers, inferBindings, requestLiterals, resolveBindings } from "../bindings.ts";
import { loadOpenApi, operationLine } from "../openapi.ts";
import type { ApiRequestAction, BindingProducer, BindingRecord } from "../bindings.ts";
import type { Driver, DriverContext, DriverNetworkRequest, DriverResolution, DriverResult, DriverSnapshot } from "../driver.ts";
import type { MatchNode } from "../match.ts";
import type { EnrichedOpenApi, OpenApiOperation } from "../openapi.ts";
import type { StepAction, StepEnvelope } from "../trajectory.ts";
import type { ResolvedMatch, ResolvedRedact } from "../types.ts";

type HeaderMap = Record<string, string>;

interface ApiLaunchEnvironment {
  base_url: string;
  case_file?: string;
  openapi?: string | null;
  allowed_origins?: string[] | null;
  headers?: unknown;
  redact?: ResolvedRedact | null;
  match?: ResolvedMatch | null;
  bind?: string[] | null;
}

interface HarResponse {
  status: number;
  bodySize: number;
  mimeType: string;
  headers: HeaderMap | null;
  body: string | null;
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; headers: HeaderMap; body: string | null };
  response: HarResponse;
  _failed: boolean;
  _observation?: boolean;
}

interface LastResponse {
  status: number;
  mime: string;
  body: string | null;
  url: string;
}

// The projection shaper and its field-path vocabulary live in ../match.ts (the
// match rules widen the same block); re-exported here because the api driver is
// where callers expect the API projection helpers to live.
export { shapeOf };

const REQUEST_TIMEOUT_MS = 15000;
// The ONLY methods the gate's observe phase may issue
// (docs/contracts/engine.md#invariant-policies). This list is the single choke
// point: a policy names a method, the driver refuses anything not here, so "the
// gate never issues a mutation" is a property of the transport rather than a
// convention every policy has to remember.
export const OBSERVATION_METHODS = ["GET", "HEAD"];
// max_ms mirrors the real per-request abort (REQUEST_TIMEOUT_MS) so the pinned
// settle descriptor doesn't overstate the ceiling a slow endpoint actually hits.
export const SETTLE_API = { name: "settle-api-v1", max_ms: REQUEST_TIMEOUT_MS };

export class ApiDriver implements Driver {
  static async launch({ env, runDir }: { env: ApiLaunchEnvironment; runDir: string }): Promise<ApiDriver> {
    fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
    // Spec ingestion is CONFIGURATION (docs/contracts/engine.md#openapi-ingestion):
    // a declared app.openapi that cannot be resolved is a DummyConfigError naming
    // the file and the ref, not a silent downgrade to exploratory. A run whose
    // actor was promised an operation list and got none is a debugging trap.
    const spec = env.openapi ? loadOpenApi(env.openapi, { where: `${env.case_file ?? "app.openapi"}: app.openapi` }) : null;
    // app.headers resolve HERE, at launch: a missing secret must stop the run
    // before the actor spends a token, and the resolved value must never reach
    // the ResolvedCase (which rides into the manifest). Resolution registers each
    // value for redaction, so everything this run writes is scrubbed from now on.
    const headers = resolveSecretRefs(env.headers ?? null, { where: env.case_file ?? "app.headers" }) as HeaderMap | null;
    return new ApiDriver({
      baseUrl: env.base_url,
      runDir,
      spec,
      allowedOrigins: env.allowed_origins,
      headers,
      redact: env.redact ?? null,
      match: env.match ?? null,
      bind: env.bind ?? null,
    });
  }

  #baseUrl: string;
  #runDir: string;
  #spec: EnrichedOpenApi | null; // the enriched OpenAPI document, or null
  #operations: OpenApiOperation[];
  #allowedOrigins: Set<string>; // Set of origins the egress guard admits (base_url's + app.allowed_origins)
  #headers: HeaderMap | null; // resolved app.headers, merged UNDER each action's own headers
  #redact: ResolvedRedact | null; // { request: [{path, secret}], projection: [path] } | null
  #match: ResolvedMatch | null; // { exclude, compare, normalize, status_equivalent } | null
  #bind: string[] | null; // declared response field paths that widen binding inference | null
  #har: HarEntry[] = [];
  #harFlusher: ({ force }?: { force?: boolean }) => boolean;
  #lastResponse: LastResponse | null = null; // { status, mime, body } for the snapshot + effectToken
  // Binding machinery (docs/contracts/engine.md#bindings). The ledger is
  // step -> that step's parsed response body, so a later step can re-read a
  // producer's FRESH value; producers indexes the bindable values seen so far;
  // names keeps one variable name per producer across the whole trajectory.
  #ledger = new Map<number, unknown>();
  #producers = new Map<string, BindingProducer>();
  #names = new Map<string, string>(); // "step|path" -> variable name
  #byName = new Map<string, BindingProducer>(); // variable name -> { step, path }

  constructor({
    baseUrl,
    runDir,
    spec = null,
    operations,
    allowedOrigins,
    headers = null,
    redact = null,
    match = null,
    bind = null
  }: {
    baseUrl: string;
    runDir: string;
    spec?: EnrichedOpenApi | null;
    operations?: OpenApiOperation[];
    allowedOrigins?: string[] | null;
    headers?: HeaderMap | null;
    redact?: ResolvedRedact | null;
    match?: ResolvedMatch | null;
    bind?: string[] | null;
  }) {
    this.#baseUrl = baseUrl;
    this.#runDir = runDir;
    this.#spec = spec ?? null;
    this.#operations = operations ?? spec?.operations ?? [];
    this.#headers = headers ?? null;
    this.#redact = redact ?? null;
    this.#match = match ?? null;
    this.#bind = bind ?? null;
    // Egress guard (docs/contracts/engine.md#api-driver): requests may reach
    // base_url's origin plus the explicit app.allowed_origins entries, nothing
    // else. Config normalizes entries to bare origins; unparsable values (a
    // hosted caller bypassing config) are dropped rather than admitting "null".
    this.#allowedOrigins = new Set();
    for (const o of [baseUrl, ...(allowedOrigins ?? [])]) {
      try {
        this.#allowedOrigins.add(new URL(o).origin);
      } catch {}
    }
    this.#harFlusher = createHarFlusher(runDir, this.#har);
  }

  get id(): "api" {
    return "api";
  }
  get settle() {
    return SETTLE_API;
  }
  get snapshotFormat() {
    // v3: the persisted snapshot_text is the normalized response projection
    // (status + body shape), not the raw response body — a pre-P2 api baseline
    // is not comparable with a post-P2 one.
    // v4: OpenAPI ingestion resolves $refs, so an operation line now carries the
    // parameters, body fields, and declared statuses a spec actually describes —
    // the head of every snapshot changed for spec-configured suites.
    return "api-text-v4";
  }

  /**
   * The enriched OpenAPI document (docs/contracts/engine.md#openapi-ingestion),
   * or null when the suite configured no spec. The gate reads it for
   * spec-driven checks: declared statuses, request/response schemas, security
   * schemes, and response links.
   */
  get spec() {
    return this.#spec;
  }

  /**
   * Drift comparison surface (docs/contracts/engine.md#act-and-heal): the API
   * snapshot is base URL + operations +
   * the last response status + body. Canonicalize the JSON body (stable key
   * order) so semantically-equal responses with reordered keys don't read as
   * drift; non-JSON bodies pass through. Response headers are NOT in the snapshot
   * text (captureSnapshot never emits them), so there is nothing header-shaped to
   * strip here. Pure; exported for test.
   *
   * The case's `match.status_equivalent` groups are applied HERE rather than in
   * the persisted projection: a baseline always records the status that actually
   * happened, and normalization is a comparison-time concern. Both sides go
   * through this method, so declaring an equivalence after recording still works.
   */
  normalizeSnapshot(text: string, base: string | null = this.#baseUrl): string {
    return normalizeApiSnapshot(text, base, this.#match);
  }

  /**
   * Optional Driver hook (docs/contracts/engine.md#driver-contract): what the
   * step envelope persists as `snapshot_text`. The raw response text still
   * reaches the actor and still lands in steps/NNN.a11y.txt and har.json — but
   * the committed trajectory carries only the normalized RESPONSE PROJECTION
   * (status + body shape), so a baseline never embeds a raw response body.
   * The act loop projects both sides before comparing, so drift comparison is
   * projection-vs-projection with no special case (and a legacy baseline whose
   * snapshot_text is a raw body still acts — it is projected on the fly).
   *
   * The case's match rules (docs/contracts/engine.md#match-rules) shape this
   * block: they quiet volatile structure and widen the named fields drift should
   * compare by value. They cannot hide a rename — every rule keeps its key.
   */
  snapshotProjection(text: string): string {
    return projectApiSnapshot(text, this.#redact?.projection ?? [], this.#match);
  }

  /**
   * Optional Driver hook (docs/contracts/engine.md#driver-contract): the form of
   * an action the trajectory persists. Values core injected from a secret
   * reference turn back into that reference, and redaction-listed request fields
   * become `{ $secret: … }` placeholders — the committed baseline is a redacted
   * REQUEST PROGRAM. The runner executes this same redacted form; #request
   * resolves the placeholders again, so record and act send identical bytes.
   */
  redactAction(action: StepAction): StepAction {
    return redactRequestAction(action, this.#redact?.request ?? []);
  }

  /**
   * Optional Driver hook (docs/contracts/engine.md#driver-contract): turn a
   * just-decided action into the PARAMETERIZED form the trajectory persists.
   * Any literal this run's earlier responses produced becomes a `{{name}}`
   * token, and the returned bindings record which step and JSON path each token
   * re-reads at act time — the provenance every substitution cites. Inference is
   * conservative by construction (see ../bindings.ts): an ambiguous literal
   * creates no binding and stays literal.
   * @returns {{ action: object, bindings: object[] }}
   */
  parameterizeAction(action: StepAction): { action: StepAction; bindings: BindingRecord[] } {
    return inferBindings(action, { producers: this.#producers, names: this.#names, byName: this.#byName });
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
  async start(): Promise<DriverResult> {
    return { ok: true, error: null, resolution: null, settle_ms: 0, url: this.#baseUrl, perf: null, network: { requests: [] }, har_entries: [] };
  }

  location(): string | null {
    return this.#lastResponse?.url ?? this.#baseUrl ?? null;
  }

  consoleErrors(): number {
    return 0;
  }

  consoleErrorLog(): Array<{ type: string; text: string }> {
    return []; // no console concept for the api transport
  }

  /** Transport-defined no_effect token: a fingerprint of the last response. */
  async effectToken(): Promise<string | null> {
    return this.#lastResponse ? `${this.#lastResponse.status}/${this.#lastResponse.body ?? ""}` : null;
  }

  /** Element-exists has no API analog — config scopes element_exists/screen_shows away from api. */
  async finalPageCheck(): Promise<boolean> {
    return false;
  }

  /**
   * The API surface as text: base URL + the operations (when a spec is given) +
   * the actual last response body, pretty-printed and capped. Written to
   * steps/NNN.a11y.txt; no screenshot (the viewer drops the film strip).
   */
  async captureSnapshot(stepNum: number): Promise<DriverSnapshot> {
    const lines: string[] = [`API: ${this.#baseUrl}`];
    if (this.#operations.length) {
      // Enriched lines (docs/contracts/engine.md#openapi-ingestion): what the
      // call needs and what it may answer, not just its summary.
      this.#operations.forEach((op, i) => lines.push(operationLine(op, i)));
    } else {
      lines.push("(no OpenAPI spec — infer endpoints from the task; a request is one action)");
    }
    if (this.#lastResponse) {
      lines.push("", `Last response: ${this.#lastResponse.status}${this.#lastResponse.mime ? ` ${this.#lastResponse.mime}` : ""}`);
      lines.push(prettyBody(this.#lastResponse.body));
    }
    // Scrub known secret values before the text is written OR handed to the
    // actor: a server that echoes a credential back must not leak it into
    // steps/NNN.a11y.txt, the actor's context, or the drift oracle.
    const text = redactSecrets(lines.join("\n"));
    try {
      fs.writeFileSync(path.join(this.#runDir, "steps", `${String(stepNum).padStart(3, "0")}.a11y.txt`), text + "\n");
    } catch {}
    // screenshotHash: explicit null documents the visual_regression Driver seam
    // (web-only); the runner already guards on its presence.
    return { text, url: this.location(), title: this.#baseUrl, refCount: this.#operations.length, truncated: false, screenshot: null, screenshotHash: null };
  }

  /**
   * @param {object} action
   * @param {{ step?: number, bindings?: object[] }} [ctx] the run step this
   *   action is (so its response can be re-read by a later binding) and the
   *   bindings whose `{{name}}` tokens this action carries.
   */
  async execute(action: StepAction, ctx: DriverContext = {}): Promise<DriverResult> {
    if (action?.type === "wait") {
      const ms = Math.min(10, Math.max(0.1, Number(action.seconds) || 1)) * 1000;
      await new Promise((r) => setTimeout(r, ms));
      // resolution.locator: null keeps wait steps on the act-mode replay track
      // (trajectory.ts keys actionTrack on resolution), matching web/mobile.
      return this.#ok({ resolution: { locator: null, bbox: null }, network: { requests: [] }, har_entries: [], settle_ms: ms });
    }
    if (action?.type !== "request") return this.#fail(`action type "${action?.type}" is not executable on api`);
    return this.#request(action, { resolution: { locator: `${action.method} ${action.path}`, bbox: null }, ctx });
  }
  async executeLocator(actedStep: StepEnvelope, ctx: DriverContext = {}): Promise<DriverResult> {
    const action = actionOf(actedStep);
    if (action?.type !== "request") return this.execute(action ?? {}, ctx);
    return this.#request(action, { resolution: { locator: `${action.method} ${action.path}`, bbox: null }, ctx });
  }

  async close(): Promise<void> {
    this.#flushHar(true);
  }

  async flushHar(): Promise<void> {
    this.#flushHar(true);
  }

  /**
   * The gate's OBSERVE phase (docs/contracts/engine.md#invariant-policies): a
   * read-only request an invariant policy declared, issued after the actor has
   * finished. Three properties make it safe to hand to a policy:
   *
   *   1. **Read-only by construction.** Only OBSERVATION_METHODS are accepted;
   *      anything else throws before any I/O, so no policy can ever mutate the
   *      system under test — not by mistake, not by a hostile spec.
   *   2. **Quarantined.** Its HAR entry is tagged `_observation: true` and is
   *      excluded from every ordinary gate kind, from the replay/action track
   *      (it is not an envelope at all), from baselines, drift, and metrics. It
   *      never touches `#lastResponse`, so it cannot become the response another
   *      check inspects, shift `location()`, or move the drift oracle; and it
   *      never enters the binding ledger, so it cannot alter a later replay.
   *   3. **Loud on failure.** A transport failure THROWS, so the runner reports
   *      it as an infrastructure error rather than a red verdict — an
   *      unreachable read-back says nothing about the application's invariants.
   *
   * @param {{ method?: string, path: string }} request
   * @returns {Promise<{ status: number, mime: string, body: string|null }>}
   */
  async observe({ method = "GET", path: requestPath }: { method?: string; path?: string } = {}): Promise<{ status: number; mime: string; body: string | null }> {
    const verb = String(method).toUpperCase();
    if (!OBSERVATION_METHODS.includes(verb)) {
      throw new Error(`the gate's observe phase issues ${OBSERVATION_METHODS.join("/")} only — refused ${verb} ${requestPath}`);
    }
    let url: string;
    try {
      url = new URL(requestPath as string, this.#baseUrl).href;
    } catch {
      throw new Error(`invalid observation path "${requestPath}"`);
    }
    const origin = new URL(url).origin;
    if (!this.#allowedOrigins.has(origin)) {
      throw new Error(`observation to ${origin} refused: outside the target origin (allowed: ${[...this.#allowedOrigins].join(", ") || "none"})`);
    }
    const headers = mergeHeaders(this.#headers, null);
    const entry: HarEntry = {
      startedDateTime: new Date().toISOString(),
      time: -1,
      request: { method: verb, url, headers, body: null },
      response: { status: 0, bodySize: -1, mimeType: "", headers: null, body: null },
      _failed: false,
      // The HAR tag that quarantines this request from every gate kind, the
      // viewer's action track, and the run's metrics.
      _observation: true,
    };
    this.#har.push(entry);
    const started = Date.now();
    try {
      const res = await fetch(url, { method: verb, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const respHeaders = Object.fromEntries(res.headers.entries());
      const mime = (respHeaders["content-type"] || "").split(";")[0]!.trim(); // TODO(ts): split always yields a first segment
      const len = parseInt(respHeaders["content-length"]!, 10); // TODO(ts): parseInt historically receives undefined when the header is absent
      const capturable = mime === "" || isTextualMime(mime);
      const tooBig = Number.isFinite(len) && len > MAX_BODY_READ;
      const text = capturable && !tooBig && verb !== "HEAD" ? await res.text().catch(() => "") : "";
      const body = capturable && !tooBig && verb !== "HEAD" ? capBody(text) : null;
      entry.response = { status: res.status, bodySize: Number.isFinite(len) ? len : text ? Buffer.byteLength(text) : -1, mimeType: mime, headers: respHeaders, body };
      entry.time = Date.now() - started;
      this.#flushHar(true);
      return { status: res.status, mime, body };
    } catch (e) {
      entry._failed = true;
      entry.time = Date.now() - started;
      this.#flushHar(true);
      throw new Error(`observation ${verb} ${requestPath} failed: ${firstLine(e)}`);
    }
  }

  // ---- internals ----

  async #request(
    action: ApiRequestAction,
    { resolution, ctx = {} }: { resolution: DriverResolution; ctx?: DriverContext }
  ): Promise<DriverResult> {
    const method = String(action.method || "GET").toUpperCase();
    // Bindings first (docs/contracts/engine.md#bindings): the committed action is
    // a PROGRAM whose `{{name}}` tokens re-read the fresh responses this run has
    // already seen. An unresolvable token is a failed step, never a request sent
    // with a stale id or a literal `{{…}}` — a silently corrupted replay is worse
    // than a loud failure.
    const { vars, problems } = resolveBindings(ctx.bindings, this.#ledger);
    if (problems.length) {
      return this.#fail(`binding could not be resolved: ${problems.join("; ")} — the response shape changed, so this replay would send a stale value`);
    }
    const bound = applyBindings(action, vars);
    if (bound.missing.length) {
      return this.#fail(`unbound substitution ${[...new Set(bound.missing)].map((n) => `{{${n}}}`).join(", ")} in the recorded request — re-record this journey`);
    }
    if (bound.unsafe.length) {
      return this.#fail(`substituted value would reshape the request URL (${bound.unsafe.join(", ")}) — the binding is unsafe to replay`);
    }
    action = { ...action, path: bound.path as string | undefined, ...(action.headers !== undefined ? { headers: bound.headers } : {}), ...(action.body !== undefined ? { body: bound.body } : {}) };
    let url: string;
    try {
      url = new URL(action.path as string, this.#baseUrl).href;
    } catch {
      return this.#fail(`invalid request path "${action.path}"`);
    }
    // Egress guard: an absolute action.path can resolve off-origin; refuse it
    // BEFORE any I/O or HAR entry. A violation is a failed step returned to the
    // actor (never a crash) so a probing actor sees the refusal and moves on.
    const origin = new URL(url).origin;
    if (!this.#allowedOrigins.has(origin)) {
      return this.#fail(
        `request to ${origin} refused: outside the target origin (allowed: ${[...this.#allowedOrigins].join(", ") || "none"}; widen with app.allowed_origins)`,
      );
    }
    // Act-time resolution (docs/contracts/engine.md#secrets-and-redaction): the
    // action may be a committed TEMPLATE carrying { $secret: NAME } placeholders
    // in its headers or body. Resolve them into request inputs only — a missing
    // value is a DummyConfigError, surfaced as a failed step rather than a crash.
    let resolved;
    try {
      resolved = resolveSecretRefs({ headers: action.headers ?? null, body: action.body ?? null }, { where: "request" }) as { headers: HeaderMap | null; body: unknown };
    } catch (e) {
      return this.#fail(firstLine(e));
    }
    const body = resolved.body;
    const hasBody = body !== undefined && body !== null && method !== "GET" && method !== "HEAD";
    const reqBodyText: string | null = hasBody ? (typeof body === "string" ? body : JSON.stringify(body) as string) : null; // TODO(ts): fetch accepts only serializable authored request bodies
    // app.headers merge UNDER the action's own headers (case-insensitively), so
    // an explicit per-request header still wins over the suite's standing ones.
    const userHeaders = mergeHeaders(this.#headers, resolved.headers);
    // Default JSON content-type only when the caller didn't set one (any casing),
    // so we never emit a duplicate differently-cased Content-Type header.
    const hasContentType = Object.keys(userHeaders).some((h) => h.toLowerCase() === "content-type");
    const headers = {
      ...(hasBody && typeof body !== "string" && !hasContentType ? { "content-type": "application/json" } : {}),
      ...userHeaders,
    };

    const index = this.#har.length;
    const entry: HarEntry = {
      startedDateTime: new Date().toISOString(),
      time: -1,
      request: { method, url, headers, body: capBody(reqBodyText) },
      response: { status: 0, bodySize: -1, mimeType: "", headers: null, body: null },
      _failed: false,
    };
    this.#har.push(entry);

    const started = Date.now();
    let error: string | null = null;
    let status = 0;
    let mime = "";
    let respBody: string | null = null;
    try {
      const res = await fetch(url, { method, headers, body: reqBodyText, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      status = res.status;
      const respHeaders = Object.fromEntries(res.headers.entries());
      mime = (respHeaders["content-type"] || "").split(";")[0]!.trim(); // TODO(ts): split always yields a first segment
      const len = parseInt(respHeaders["content-length"]!, 10); // TODO(ts): parseInt historically receives undefined when the header is absent
      // Capture text/JSON only, and never buffer a body whose declared length
      // exceeds the read cap (binary + huge bodies are recorded by size alone).
      // On the api transport the body IS the actor's observable and the gate's
      // source for response_matches, so an absent Content-Type (a header servers
      // legitimately omit) is treated as capturable text rather than dropped —
      // otherwise a valid JSON response reads as "(no body)" and fails the gate.
      const capturable = mime === "" || isTextualMime(mime);
      const tooBig = Number.isFinite(len) && len > MAX_BODY_READ;
      const text = capturable && !tooBig ? await res.text().catch(() => "") : "";
      respBody = capturable && !tooBig ? capBody(text) : null;
      entry.response = { status, bodySize: Number.isFinite(len) ? len : text ? Buffer.byteLength(text) : -1, mimeType: mime, headers: respHeaders, body: respBody };
    } catch (e) {
      error = firstLine(e);
      entry._failed = true;
    }
    entry.time = Date.now() - started;
    this.#flushHar();
    this.#lastResponse = { status, mime, body: respBody, url: pathnameOf(url) };
    this.#ledgerResponse(ctx.step, respBody, action);

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
      // Step-scoped expectation (docs/contracts/engine.md#act-and-heal): the
      // EXACT status this request answered. Recorded on the envelope so a
      // differing status at act time is drift attributed to this step, not to
      // whichever later step happened to notice the changed snapshot.
      ...(error ? {} : { expect: { status } }),
    };
  }

  /**
   * Remember a step's response so a later step can bind against it, and index
   * the server-generated identifiers in it. `sent` is everything this request
   * carried, so an echoed input is never mistaken for something produced.
   */
  #ledgerResponse(step: number | undefined, respBody: string | null, action: ApiRequestAction): void {
    if (step == null) return;
    let parsed: unknown = null;
    try {
      parsed = respBody == null ? null : JSON.parse(respBody);
    } catch {
      parsed = null; // a non-JSON body has no readable field to bind
    }
    this.#ledger.set(step, parsed);
    if (parsed && typeof parsed === "object") {
      indexProducers(this.#producers, { step, body: parsed, sent: requestLiterals(action), declared: this.#bind });
    }
  }

  #ok({
    resolution,
    network,
    har_entries,
    settle_ms
  }: {
    resolution: DriverResolution;
    network: { requests: DriverNetworkRequest[] };
    har_entries: number[];
    settle_ms: number;
  }): DriverResult {
    return { ok: true, error: null, resolution, settle_ms, url: this.location(), perf: null, har_entries, network };
  }

  #fail(error: string): DriverResult {
    return { ok: false, error, resolution: null, settle_ms: 0, url: this.location(), perf: null, har_entries: [], network: { requests: [] } };
  }

  #flushHar(force = false): void {
    try {
      this.#harFlusher({ force });
    } catch {}
  }
}

// Stable-key-order re-serialization of any JSON value (recursive sort of object
// keys; arrays keep order). Reserve hook: a future JSON-path exclusion config
// would prune volatile fields here before re-stringifying.
function canonicalizeJson(value: MatchNode): MatchNode {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    const out: Record<string, MatchNode> = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalizeJson(value[k]);
    return out;
  }
  return value;
}

/**
 * Normalize an api snapshot for drift comparison. The header + operations lines
 * are kept verbatim; the response body (everything after the `Last response:`
 * line) is canonicalized to stable JSON key order when it parses as JSON, else
 * passed through. When `base` is given, the comparison is made BASE-AWARE: the
 * snapshot's OWN base_url (origin + base path prefix) is subtracted from the
 * `API: <baseUrl>` head + any response url, leaving the relative form — so the
 * same ops/body under two environments (incl. a deployment path prefix) don't
 * read as drift, mirroring the `url_matches` pathname precedent.
 * The two sides of a drift comparison are relativized against their OWN bases.
 * `base === null` => origin-only stripping (legacy baselines); NO second arg =>
 * no-op pass-through (backward compatible). Pure; exported for test.
 */
export function normalizeApiSnapshot(text: unknown, base: string | null | undefined = undefined, match: ResolvedMatch | null = null): string {
  let s = String(text ?? "");
  if (base !== undefined) s = relativizeUrls(s, base);
  const idx = s.indexOf("\nLast response:");
  if (idx === -1) return s.trimEnd();
  const head = s.slice(0, idx);
  const rest = s.slice(idx + 1); // from "Last response:" onward
  const nl = rest.indexOf("\n");
  if (nl === -1) return s.trimEnd();
  // A declared status equivalence collapses both sides to one token before the
  // comparison; with no rule the line is untouched (docs/contracts/engine.md#match-rules).
  const statusLine = rest.slice(0, nl).replace(/^Last response: (\d{3})/, (line, status) => `Last response: ${canonicalStatus(status, match)}`);
  const body = rest.slice(nl + 1).trim();
  let normBody = body;
  try {
    normBody = JSON.stringify(canonicalizeJson(JSON.parse(body)));
  } catch {
    // non-JSON body (or the "(no body)" placeholder) passes through
  }
  return `${head}\n${statusLine}\n${normBody}`.trimEnd();
}

/**
 * Merge standing app.headers UNDER an action's own headers, case-insensitively:
 * an action header named `authorization` beats a configured `Authorization`
 * rather than sending both. The winner keeps its own casing. Pure; exported for test.
 */
export function mergeHeaders(appHeaders: HeaderMap | null | undefined, actionHeaders: HeaderMap | null | undefined): HeaderMap {
  const out: HeaderMap = {};
  const byLower = new Map<string, string>(); // lowercased name -> the key currently in `out`
  for (const source of [appHeaders ?? {}, actionHeaders ?? {}]) {
    for (const [name, value] of Object.entries(source)) {
      const prior = byLower.get(name.toLowerCase());
      if (prior !== undefined) delete out[prior];
      out[name] = value;
      byLower.set(name.toLowerCase(), name);
    }
  }
  return out;
}

/**
 * The normalized response projection replacing a raw body in the committed
 * trajectory: status line plus body shape (docs/contracts/artifacts.md#step-envelope).
 * Idempotent — a text already carrying the marker is returned unchanged, so the
 * act loop can project both sides blindly. The case's match rules widen the
 * block to the named fields drift should compare by value, and quiet the
 * volatile structure it should not; neither can hide a renamed key.
 * Pure; exported for test.
 */
export function projectApiSnapshot(text: unknown, redactPaths: string[] = [], match: ResolvedMatch | null = null): string {
  const s = String(text ?? "");
  if (s.includes(API_PROJECTION_MARKER)) return s;
  const idx = s.indexOf("\nLast response:");
  if (idx === -1) return s; // no response captured yet: the head carries no body
  const head = s.slice(0, idx);
  const rest = s.slice(idx + 1);
  const nl = rest.indexOf("\n");
  const statusLine = nl === -1 ? rest : rest.slice(0, nl);
  const body = nl === -1 ? "" : rest.slice(nl + 1).trim();
  return `${head}\n${statusLine}\n${API_PROJECTION_MARKER}\n${projectBody(body, redactPaths, match)}`;
}

function projectBody(body: string, redactPaths: string[], match: ResolvedMatch | null): string {
  if (!body || body === "(no body)") return "(no body)";
  let parsed: MatchNode;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Non-JSON (or truncated) bodies have no shape to project and may be free
    // text: record only that one was there, never its content.
    return `(non-json body: ${body.length} chars)`;
  }
  return JSON.stringify(shapeOf(applyMatchRules(parsed, { redact: redactPaths, match })));
}

/**
 * Turn an executable request action into the redacted template the trajectory
 * persists (docs/contracts/artifacts.md#baseline-files):
 *
 *   1. any literal equal to a value core injected from a secret reference goes
 *      back to that reference (so it resolves again at act time), and any string
 *      merely CONTAINING one is scrubbed to the placeholder token;
 *   2. every declared redact.request path becomes its `{ $secret: NAME }`
 *      placeholder.
 *
 * Non-request actions pass through untouched. Pure; exported for test.
 */
export function redactRequestAction(
  action: StepAction,
  requestRedactions: Array<{ path: string; secret: string }> = []
): StepAction {
  if (action?.type !== "request") return action;
  let out = action;
  const headers = templatizeSecrets(action.headers);
  const body = templatizeSecrets(action.body);
  if (headers !== action.headers || body !== action.body) out = { ...action, ...(action.headers !== undefined ? { headers } : {}), ...(action.body !== undefined ? { body } : {}) };
  for (const { path: p, secret } of requestRedactions ?? []) {
    const root = /^headers\b/.test(p) ? "headers" : "body";
    const segs = pathSegments(p, { strip: root });
    const node = out[root];
    // A string body is opaque to field paths (only a whole-body entry applies);
    // a path naming a field that this request does not carry is simply inert.
    if (node === undefined || node === null) continue;
    if (typeof node === "string" && segs.length) continue;
    if (!existsAt(node as MatchNode, segs)) continue;
    out = { ...out, [root]: replaceAt(node as MatchNode, segs, (v) => (isSecretRef(v) ? v : { $secret: secret })) };
  }
  return out;
}

/** Deep-replace known secret VALUES with the reference they were resolved from. */
function templatizeSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    const name = secretNameForValue(value);
    if (name) return { $secret: name };
    const scrubbed = redactSecrets(value);
    return scrubbed === value ? value : scrubbed;
  }
  if (Array.isArray(value)) {
    const out = value.map(templatizeSecrets);
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (value && typeof value === "object") {
    if (isSecretRef(value)) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = templatizeSecrets(v);
      if (out[k] !== v) changed = true;
    }
    return changed ? out : value;
  }
  return value;
}

function prettyBody(body: string | null): string {
  if (body === null) return "(no body)";
  try {
    return capBody(JSON.stringify(JSON.parse(body), null, 2)) as string;
  } catch {
    return capBody(String(body)) as string;
  }
}
