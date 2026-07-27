import type { DynamicValue } from "./types.ts";

// The secret-bearing script proxy: the ONLY path from a script process to a
// network (docs/contracts/scripts.md#the-secret-bearing-proxy).
//
// The proxy runs in the parent — the CLI process locally, the runner-agent job
// process hosted — and the script runs in a child that holds no credential. It
// is a loopback JSON control channel rather than a forwarding HTTP proxy, so
// every guard is enforced on the wire by the process the script cannot reach
// into:
//
//   origin        base_url's origin plus the explicit allowlist, nothing else
//                 (the shipped P0 egress semantics, applied to scripts)
//   method        read-only unless the run configuration carries the target's
//                 write grant — the grant never comes from script code
//   budget        counted here; past the cap nothing is forwarded and no HAR
//                 entry is written, so the recorded trace IS the budget
//   secrets       `{ $secret: NAME }` header values are resolved HERE, from the
//                 declared name list only; the value never crosses to the child
//
// A refused request performs no network I/O and produces no HAR entry — it is
// recorded as a guard event instead, which is what the risk profiler reports as
// an out-of-origin attempt or a refused mutation.
import http from "node:http";
import crypto from "node:crypto";

import { DummyConfigError } from "../config.ts";
import { hasKnownSecrets, isSecretRef, redactSecrets, resolveSecret, secretPlaceholder } from "../secrets.ts";
import { captureDecision } from "./har.ts";

/** Per-request abort, mirroring the api driver's ceiling. */
export const REQUEST_TIMEOUT_MS = 15000;
/** Header the child authenticates the control channel with. */
export const TOKEN_HEADER = "x-playtest-script-token";
/** Methods a read-only client may issue. */
export const READ_ONLY_METHODS = ["GET", "HEAD"];

// A specifier with an explicit scheme is an absolute URL (and faces the origin
// guard). Anything else is a PATH, appended to the base URL rather than resolved
// against it — so `//evil.example/x` is a double-slashed path on the target, not a
// protocol-relative jump to another host, and a suite probing hostile paths still
// probes the target. Exported for test.
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;

export function resolveRequestUrl(rawPath: DynamicValue, baseUrl: DynamicValue) {
  const path = String(rawPath ?? "");
  if (SCHEME_RE.test(path)) return new URL(path);
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  return new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
}

/** Guard refusal codes, stable for the report and the risk profile. */
export const GUARD_CODES: DynamicValue = Object.freeze({
  offOrigin: "off_origin",
  readOnly: "read_only",
  budget: "budget_exhausted",
  secret: "undeclared_secret",
  path: "invalid_path",
});

/**
 * Start the proxy. Resolves once it is listening.
 *
 * @param {{ baseUrl: string, allowedOrigins?: string[]|null, mode?: "read-only"|"read-write",
 *           budget: number, secretNames?: string[], timeoutMs?: number,
 *           recorder: { add: Function }, onChecks?: (checks: object[]) => void,
 *           onReport?: (report: object) => void, fetchImpl?: Function }} options
 */
export async function startScriptProxy({
  baseUrl,
  allowedOrigins = null,
  mode = "read-only",
  budget,
  secretNames = [],
  timeoutMs = REQUEST_TIMEOUT_MS,
  recorder,
  onChecks = null,
  onReport = null,
  fetchImpl = null,
}: DynamicValue) {
  const token = crypto.randomBytes(24).toString("hex");
  const baseOrigin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return null;
    }
  })();
  const origins: DynamicValue = new Set();
  for (const candidate of [baseUrl, ...(allowedOrigins ?? [])]) {
    try {
      origins.add(new URL(candidate).origin);
    } catch {}
  }
  const declared: DynamicValue = new Set(secretNames ?? []);
  const guard: DynamicValue = [];
  let used = 0;
  let finalReport: DynamicValue = null;
  const streamed: DynamicValue = [];

  const doFetch = fetchImpl ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));

  const refuse = (code: DynamicValue, detail: DynamicValue, { method, path }: DynamicValue) => {
    guard.push({ code, method, path, detail, at: new Date().toISOString() });
    return { refused: { code, message: detail } };
  };

  /**
   * Resolve `{ $secret: NAME }` header values into the WIRE headers, and record
   * the placeholder form instead. Two consequences worth the extra map: the
   * credential is never in the recorder's memory (the write-time scrub is a
   * backstop, not the only defence), and the risk profiler can see WHICH secret
   * a request used without anyone holding its value.
   */
  const resolveHeaders = (headers: DynamicValue, { method, path, origin }: DynamicValue) => {
    const wire: DynamicValue = {};
    const record: DynamicValue = {};
    for (const [rawName, value] of Object.entries(headers ?? {})) {
      const name = String(rawName).toLowerCase();
      if (isSecretRef(value)) {
        // A credential is bound to the TARGET origin, not to the run. An
        // allow-listed auxiliary origin is reachable and gets no credential, so
        // the allowlist can never become an exfiltration channel.
        if (origin !== baseOrigin) {
          return {
            error: refuse(
              GUARD_CODES.secret,
              `secret reference { $secret: "${value.$secret}" } is bound to the target origin ${baseOrigin}` +
                ` and will not be sent to ${origin}`,
              { method, path },
            ),
          };
        }
        if (!declared.has(value.$secret)) {
          return {
            error: refuse(
              GUARD_CODES.secret,
              `secret reference { $secret: "${value.$secret}" } is not declared for this run` +
                ` (declared: ${[...declared].join(", ") || "none"})`,
              { method, path },
            ),
          };
        }
        // Resolution registers the value for redaction, so the write-time HAR
        // scrub covers it wherever else it may be echoed back.
        wire[name] = resolveSecret(value.$secret, { where: "script client" });
        record[name] = secretPlaceholder(value.$secret);
        continue;
      }
      if (value === null || value === undefined) continue;
      wire[name] = String(value);
      record[name] = wire[name];
    }
    return { headers: wire, recordHeaders: record };
  };

  // `harness` marks a request the PARENT is making on the run's behalf — today
  // only the declared cleanup reset. It faces every guard except the budget,
  // which belongs to the script: a suite that spent its whole allowance must
  // still be able to put the environment back.
  async function handleRequest(payload: DynamicValue, { harness = false }: DynamicValue = {}) {
    const method = String(payload?.method ?? "GET").toUpperCase();
    const rawPath = String(payload?.path ?? "");
    let url;
    try {
      url = resolveRequestUrl(rawPath, baseUrl);
    } catch {
      return refuse(GUARD_CODES.path, `"${rawPath}" is not a resolvable request path`, { method, path: rawPath });
    }
    if (!origins.has(url.origin)) {
      return refuse(
        GUARD_CODES.offOrigin,
        `request to ${url.origin} refused: outside the target origin (allowed: ${[...origins].join(", ") || "none"};` +
          ` widen with the run's allowed_origins)`,
        { method, path: url.href },
      );
    }
    if (mode !== "read-write" && !READ_ONLY_METHODS.includes(method)) {
      return refuse(
        GUARD_CODES.readOnly,
        `${method} ${url.pathname} refused: this run is read-only — a mutation needs the target's write grant` +
          ` in the run configuration (it can never be enabled from script code)`,
        { method, path: url.pathname },
      );
    }
    if (used >= budget && !harness) {
      return refuse(
        GUARD_CODES.budget,
        `request budget of ${budget} is spent — nothing further is forwarded or recorded`,
        { method, path: url.pathname },
      );
    }

    const resolved = resolveHeaders(payload?.headers, { method, path: url.pathname, origin: url.origin });
    if (resolved.error) return resolved.error;
    const headers = resolved.headers;
    const recordHeaders = resolved.recordHeaders;

    const bodyText =
      payload?.rawBody !== undefined && payload.rawBody !== null
        ? String(payload.rawBody)
        : payload?.body !== undefined && payload.body !== null
          ? JSON.stringify(payload.body)
          : null;
    const sendsBody = bodyText !== null && !READ_ONLY_METHODS.includes(method);
    if (sendsBody && !Object.keys(headers).some((h) => h === "content-type")) {
      headers["content-type"] = payload?.contentType ? String(payload.contentType) : "application/json";
      recordHeaders["content-type"] = headers["content-type"];
    }

    used += 1;
    const startedAt = Date.now();
    let status = 0;
    let statusText = "";
    let responseHeaders: DynamicValue = {};
    let text: DynamicValue = null;
    let declaredSize: DynamicValue = null;
    let transportError: DynamicValue = null;
    try {
      const response = await doFetch(url.href, {
        method,
        headers,
        body: sendsBody ? bodyText : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      statusText = response.statusText ?? "";
      responseHeaders = Object.fromEntries(response.headers.entries());
      const mime = (responseHeaders["content-type"] || "").split(";")[0].trim();
      const decision = captureDecision({ mime, contentLength: responseHeaders["content-length"] });
      declaredSize = decision.declaredSize;
      text = decision.capturable && method !== "HEAD" ? await response.text().catch(() => "") : null;
    } catch (error: DynamicValue) {
      transportError =
        error?.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : String(error?.message ?? error).split("\n")[0];
    }
    const timeMs = Date.now() - startedAt;
    // A target that echoes a credential back discloses it to its own caller. The
    // script must not be that caller: known secret values are scrubbed out of the
    // response BEFORE it crosses back into the script process, so the value is
    // absent from script-visible state and not merely from the artifacts.
    if (hasKnownSecrets()) {
      if (typeof text === "string") text = redactSecrets(text);
      statusText = redactSecrets(statusText);
      for (const [name, value] of Object.entries(responseHeaders)) responseHeaders[name] = redactSecrets(String(value));
    }
    const ref = recorder.add({
      method,
      url: url.href,
      requestHeaders: recordHeaders,
      requestBody: sendsBody ? bodyText : null,
      mimeType: headers["content-type"] ?? "",
      startedAt,
      timeMs,
      status,
      statusText,
      responseHeaders,
      responseBody: text,
      responseSize: declaredSize,
      failed: Boolean(transportError),
    });

    return {
      entry: {
        ref,
        method,
        url: url.href,
        path: url.pathname + url.search,
        status,
        statusText,
        headers: responseHeaders,
        text,
        timeMs,
        transportError,
      },
      budget: { limit: budget, used, remaining: Math.max(0, budget - used) },
    };
  }

  const server = http.createServer((request, response) => {
    const send = (code: DynamicValue, body: DynamicValue) => {
      const json = JSON.stringify(body ?? {});
      response.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
      response.end(json);
    };
    if (request.headers[TOKEN_HEADER] !== token) {
      send(403, { error: "script control channel: bad or missing token" });
      return;
    }
    const chunks: DynamicValue = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      let payload: DynamicValue = {};
      if (chunks.length) {
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          send(400, { error: "script control channel: body is not JSON" });
          return;
        }
      }
      try {
        if (request.url === "/request" && request.method === "POST") {
          if (Array.isArray(payload.checks) && payload.checks.length) {
            streamed.push(...payload.checks);
            onChecks?.(payload.checks);
          }
          send(200, await handleRequest(payload.request ?? payload));
          return;
        }
        if (request.url === "/checks" && request.method === "POST") {
          const list = Array.isArray(payload.checks) ? payload.checks : [];
          streamed.push(...list);
          onChecks?.(list);
          send(200, { ok: true });
          return;
        }
        if (request.url === "/report" && request.method === "POST") {
          finalReport = payload;
          onReport?.(payload);
          send(200, { ok: true });
          return;
        }
        send(404, { error: `script control channel: no route ${request.method} ${request.url}` });
      } catch (error: DynamicValue) {
        // A DummyConfigError here (an unresolvable secret) must reach the parent
        // as a config failure, not as a mystery 500 the script sees.
        send(500, {
          error: String(error?.message ?? error).split("\n")[0],
          config: error instanceof DummyConfigError,
        });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve as () => void);
  });
  const { port } = server.address() as DynamicValue; // TODO(ts): the listen callback proves the server has an AddressInfo

  return {
    endpoint: `http://127.0.0.1:${port}`,
    token,
    /** The parent's own way onto the wire, under the same guards (see `harness`). */
    perform: (payload: DynamicValue) => handleRequest(payload, { harness: true }),
    get requestCount() {
      return used;
    },
    get guardEvents() {
      return guard;
    },
    get streamedChecks() {
      return streamed;
    },
    get finalReport() {
      return finalReport;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
