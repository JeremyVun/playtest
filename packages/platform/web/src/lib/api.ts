// API client. Wraps fetch against /api/v1, parses the JSON body, and turns the §2
// error envelope { error: { code, message, details } } into a thrown ApiError so
// callers can render the friendly message + field details (never a raw 500).

export class ApiError extends Error {
  declare status: WebDynamic;
  declare code: WebDynamic;
  declare details: WebDynamic;

  constructor(status: WebDynamic, envelope: WebDynamic) {
    const e = envelope?.error || {};
    super(e.message || `request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = e.code || "error";
    this.details = e.details;
  }
}

// Read cache for slow-moving reference collections (applications and rings,
// personas, models, members, suite lists). Keyed by path; an entry holds the request
// promise itself, so concurrent callers — a page and the modal it opens —
// share one wire request. Any successful mutation wipes the whole cache:
// mutations happen at human rate, so the cost is one refetch per list, while
// a map from mutated path to affected lists would be a standing bug.
const cache: WebDynamic = new Map(); // path -> { at, ttl, promise }

async function request(method: WebDynamic, path: WebDynamic, { body, raw, headers, signal }: WebDynamic = {}) {
  const opts: WebDynamic = { method, headers: { ...headers }, ...(signal ? { signal } : {}) };
  if (raw !== undefined) {
    opts.body = raw;
  } else if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/v1${path}`, opts);
  if (method !== "GET" && res.ok) cache.clear();
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  const buf = await res.arrayBuffer();
  if (!res.ok) throw new ApiError(res.status, { error: { message: `HTTP ${res.status}` } });
  return buf;
}

export const api: WebDynamic = {
  // `opts.signal` lets a caller abandon a request it no longer needs. The long
  // poll in lib/feed.js depends on it: a browser allows only ~6 connections per
  // origin, so an abandoned 25-second request that stays on the wire is a
  // connection the next page cannot have.
  get: (p: WebDynamic, opts?: WebDynamic) => request("GET", p, opts),
  // A GET served from the cache while fresh. `ttl` bounds cross-user staleness
  // (own mutations wipe the cache); `force: true` refreshes the entry in place.
  cached(p: WebDynamic, { ttl = 60_000, force = false }: WebDynamic = {}) {
    let entry = cache.get(p);
    if (force || !entry || Date.now() - entry.at >= entry.ttl) {
      entry = { at: Date.now(), ttl, promise: request("GET", p) };
      const mine = entry;
      mine.promise.catch(() => { if (cache.get(p) === mine) cache.delete(p); });
      cache.set(p, entry);
    }
    // Callers may mutate what they receive (an uncached GET hands out a fresh
    // object every time), so each caller gets its own copy of the body.
    return entry.promise.then((v: WebDynamic) => structuredClone(v));
  },
  post: (p: WebDynamic, body: WebDynamic) => request("POST", p, { body }),
  put: (p: WebDynamic, body: WebDynamic) => request("PUT", p, { body }),
  patch: (p: WebDynamic, body: WebDynamic) => request("PATCH", p, { body }),
  del: (p: WebDynamic, body: WebDynamic) => request("DELETE", p, { body }),
  postRaw: (p: WebDynamic, raw: WebDynamic, contentType: WebDynamic) => request("POST", p, { raw, headers: { "content-type": contentType } }),
  // A binary GET (tar export) — returns a Blob for download.
  async blob(p: WebDynamic) {
    const res = await fetch(`/api/v1${p}`);
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    return res.blob();
  },
};
