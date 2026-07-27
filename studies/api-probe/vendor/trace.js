// The bench's common trace form.
//
// Every arm under measurement — a Playtest probe run, a Schemathesis cassette,
// a plain HAR from any other client — is normalized into the same shape before
// scoring, so no arm can win because it had a friendlier oracle
// (DESIGN §4, "Comparator honesty").
//
// A trace is `{ id, source, label, meta, exchanges }` where every exchange is
// one request/response pair in wire order.

/** Parse a body that may be absent, non-JSON, or truncated. Never throws. */
export function parseJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lowerHeaders(headers) {
  const out = {};
  if (Array.isArray(headers)) {
    // HAR 1.2: [{ name, value }]
    for (const header of headers) {
      if (header && typeof header.name === "string") out[header.name.toLowerCase()] = String(header.value ?? "");
    }
  } else if (headers && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) out[String(name).toLowerCase()] = String(value ?? "");
  }
  return out;
}

/**
 * Normalize one HAR entry. Accepts both HAR 1.2 (`headers: [{name,value}]`,
 * `postData.text`, `response.content.text`) and the flattened shape Playtest's
 * api driver writes (`headers` as an object, `body` as a string).
 */
export function exchangeFromHarEntry(entry, index) {
  const request = entry?.request ?? {};
  const response = entry?.response ?? {};
  let url;
  let path = String(request.url ?? "");
  let query = new URLSearchParams();
  try {
    url = new URL(request.url);
    path = url.pathname;
    query = url.searchParams;
  } catch {
    const [rawPath, rawQuery] = path.split("?");
    path = rawPath;
    query = new URLSearchParams(rawQuery ?? "");
  }

  const requestBody = typeof request.body === "string" ? request.body : (request.postData?.text ?? null);
  const responseBody =
    typeof response.body === "string" ? response.body : (response.content?.text ?? null);
  const startedAt = Date.parse(entry?.startedDateTime ?? "");

  return {
    index,
    method: String(request.method ?? "GET").toUpperCase(),
    url: String(request.url ?? ""),
    path: path.replace(/\/+$/, "") || "/",
    query,
    requestHeaders: lowerHeaders(request.headers),
    requestBody,
    requestJson: parseJson(requestBody),
    status: Number(response.status ?? 0),
    responseHeaders: lowerHeaders(response.headers),
    responseBody,
    responseJson: parseJson(responseBody),
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    timeMs: Number.isFinite(entry?.time) && entry.time >= 0 ? entry.time : null,
    failed: entry?._failed === true || Number(response.status ?? 0) === 0,
  };
}

/** Build a trace from raw HAR entries. */
export function traceFromHarEntries(entries, { id, source, label = null, meta = {} } = {}) {
  const exchanges = entries.map((entry, index) => exchangeFromHarEntry(entry, index));
  return {
    id,
    source,
    label,
    meta: { requests: exchanges.length, ...meta },
    exchanges,
  };
}

/** Wall-clock span of a trace derived from its own entries, in milliseconds. */
export function wallMsFromExchanges(exchanges) {
  const stamped = exchanges.filter((exchange) => exchange.startedAt !== null);
  if (stamped.length === 0) return null;
  const first = stamped[0];
  const last = stamped[stamped.length - 1];
  return Math.max(0, last.startedAt + (last.timeMs ?? 0) - first.startedAt);
}

/** `2xx`. */
export const isOk = (exchange) => exchange.status >= 200 && exchange.status < 300;

/**
 * Classify an exchange against the ledger fixture's surface. Returns
 * `{ kind, accountId?, transferId?, depositId? }`; unknown paths are
 * `kind: "unknown"` and are ignored by every oracle.
 */
// A probing client sends deliberately malformed percent-encodings
// ("/accounts/%E0%A4%A"); decodeURIComponent throws on those, and a trace
// parser must never crash on hostile input — the raw segment is kept as the
// opaque id (the server rejected the request anyway; the oracles only need a
// stable identifier to correlate on).
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function route(exchange) {
  const segments = exchange.path.split("/").filter(Boolean);
  const method = exchange.method;
  if (segments.length === 0) return { kind: "unknown" };
  if (segments[0] === "health") return { kind: "health" };
  if (segments[0] === "openapi.json") return { kind: "openapi" };
  if (segments[0] === "admin") {
    if (segments[1] === "reset") return { kind: "admin_reset" };
    if (segments[1] === "tick") return { kind: "admin_tick" };
    return { kind: "unknown" };
  }
  if (segments[0] === "accounts") {
    if (segments.length === 1) return { kind: method === "POST" ? "accounts_create" : "accounts_list" };
    const accountId = decodeSegment(segments[1]);
    if (segments.length === 2) return { kind: "account_get", accountId };
    if (segments[2] === "activate") return { kind: "account_activate", accountId };
    if (segments[2] === "close") return { kind: "account_close", accountId };
    if (segments[2] === "entries") return { kind: "account_entries", accountId };
    return { kind: "unknown", accountId };
  }
  if (segments[0] === "deposits") {
    if (segments.length === 1) return { kind: "deposits_create" };
    return { kind: "deposit_get", depositId: decodeSegment(segments[1]) };
  }
  if (segments[0] === "transfers") {
    if (segments.length === 1) return { kind: method === "POST" ? "transfers_create" : "transfers_list" };
    const transferId = decodeSegment(segments[1]);
    if (segments.length === 2) return { kind: "transfer_get", transferId };
    if (segments[2] === "cancel") return { kind: "transfer_cancel", transferId };
    return { kind: "unknown", transferId };
  }
  return { kind: "unknown" };
}

/** Mutating routes, for the "no write in between" applicability windows. */
const MUTATING_KINDS = new Set([
  "admin_reset",
  "admin_tick",
  "accounts_create",
  "account_activate",
  "account_close",
  "deposits_create",
  "transfers_create",
  "transfer_cancel",
]);

export const isMutation = (exchange) => exchange.method !== "GET" && MUTATING_KINDS.has(route(exchange).kind);
