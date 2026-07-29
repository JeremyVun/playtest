// API client. Wraps fetch against /api/v1, parses the JSON body, and turns the §2
// error envelope { error: { code, message, details } } into a thrown ApiError so
// callers can render the friendly message + field details (never a raw 500).
import { decodeServerEvent } from "./server-events.js";

export class ApiError extends Error {
  declare status: number;
  declare code: string;
  declare details: unknown;

  constructor(status: number, envelope: unknown) {
    const outer = isRecord(envelope) ? envelope : {};
    const error = isRecord(outer.error) ? outer.error : {};
    super(typeof error.message === "string" ? error.message : `request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof error.code === "string" ? error.code : "error";
    this.details = error.details;
  }
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  body?: unknown;
  raw?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

interface CacheEntry {
  at: number;
  ttl: number;
  promise: Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Read cache for slow-moving reference collections (applications and rings,
// personas, models, members, suite lists). Keyed by path; an entry holds the request
// promise itself, so concurrent callers — a page and the modal it opens —
// share one wire request. Any successful mutation wipes the whole cache:
// mutations happen at human rate, so the cost is one refetch per list, while
// a map from mutated path to affected lists would be a standing bug.
const cache = new Map<string, CacheEntry>();

async function request(method: HttpMethod, path: string, { body, raw, headers, signal }: RequestOptions = {}): Promise<unknown> {
  const opts: RequestInit = { method, headers: new Headers(headers), ...(signal ? { signal } : {}) };
  if (raw !== undefined) {
    opts.body = raw;
  } else if (body !== undefined) {
    (opts.headers as Headers).set("content-type", "application/json");
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

async function postEvents(
  path: string,
  body: unknown,
  onEvent: (event: { event: string; data: WebDynamic }) => void,
): Promise<unknown> {
  const res = await fetch(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") || "";

  // Backward compatibility with a control plane that does not offer progress:
  // it returns the ordinary final JSON envelope and the caller still works.
  if (contentType.includes("application/json")) {
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data);
    cache.clear();
    return data;
  }
  if (!res.ok || !contentType.includes("text/event-stream") || !res.body) {
    throw new ApiError(res.status, { error: { message: `HTTP ${res.status}` } });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result: unknown;
  for (;;) {
    const chunk = await reader.read();
    pending += decoder.decode(chunk.value, { stream: !chunk.done });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const message = decodeServerEvent(block);
      if (!message) continue;
      if (message.event === "result") result = message.data;
      else if (message.event === "error") {
        const status = Number(message.data?.status) || 500;
        throw new ApiError(status, { error: message.data?.error });
      } else {
        onEvent(message);
      }
    }
    if (chunk.done) break;
  }
  if (result === undefined) {
    throw new ApiError(502, { error: { message: "the drafting response ended before a result arrived — try again" } });
  }
  cache.clear();
  return result;
}

export const api = {
  // `opts.signal` lets a caller abandon a request it no longer needs. The long
  // poll in lib/feed.js depends on it: a browser allows only ~6 connections per
  // origin, so an abandoned 25-second request that stays on the wire is a
  // connection the next page cannot have.
  get: <T = WebDynamic>(path: string, opts?: RequestOptions) => request("GET", path, opts) as Promise<T>,
  // A GET served from the cache while fresh. `ttl` bounds cross-user staleness
  // (own mutations wipe the cache); `force: true` refreshes the entry in place.
  cached<T = WebDynamic>(path: string, { ttl = 60_000, force = false }: { ttl?: number; force?: boolean } = {}) {
    let entry = cache.get(path);
    if (force || !entry || Date.now() - entry.at >= entry.ttl) {
      entry = { at: Date.now(), ttl, promise: request("GET", path) };
      const mine = entry;
      mine.promise.catch(() => { if (cache.get(path) === mine) cache.delete(path); });
      cache.set(path, entry);
    }
    // Callers may mutate what they receive (an uncached GET hands out a fresh
    // object every time), so each caller gets its own copy of the body.
    return entry.promise.then((value) => structuredClone(value) as T);
  },
  post: <T = WebDynamic>(path: string, body: unknown) => request("POST", path, { body }) as Promise<T>,
  postEvents: <T = WebDynamic>(
    path: string,
    body: unknown,
    onEvent: (event: { event: string; data: WebDynamic }) => void,
  ) => postEvents(path, body, onEvent) as Promise<T>,
  put: <T = WebDynamic>(path: string, body: unknown) => request("PUT", path, { body }) as Promise<T>,
  patch: <T = WebDynamic>(path: string, body: unknown) => request("PATCH", path, { body }) as Promise<T>,
  del: <T = WebDynamic>(path: string, body?: unknown) => request("DELETE", path, { body }) as Promise<T>,
  postRaw: <T = WebDynamic>(path: string, raw: BodyInit, contentType: string) =>
    request("POST", path, { raw, headers: { "content-type": contentType } }) as Promise<T>,
  // A binary GET (tar export) — returns a Blob for download.
  async blob(path: string) {
    const res = await fetch(`/api/v1${path}`);
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    return res.blob();
  },
};
