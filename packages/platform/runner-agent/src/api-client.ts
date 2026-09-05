import { Readable } from "node:stream";
export function resolveApiPath(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("runner server must be an HTTP(S) origin without credentials or path");
  if (path.includes("\\") || path.startsWith("//")) throw new Error("unsafe runner API path");
  const url = new URL(/^https?:/.test(path) || path.startsWith("/api/v1/") ? path : `/api/v1${path}`, base);
  if (url.origin !== base.origin || url.username || url.password || url.hash || !url.pathname.startsWith("/api/v1/")) throw new Error("runner API URL must remain on the configured server and API path");
  return url.href;
}

/**
 * The control plane's one stale-ownership answer (409 `executor_conflict`,
 * docs/contracts/hosted.md "Current executor fencing"). It means this bearer is
 * no longer the current executor of the attempt it is addressing — or that
 * attempt has ended — so the work is FINAL for this process: stop executing,
 * stop uploading, and go back to the board. Retrying is the one thing that can
 * never help.
 */
export const EXECUTOR_CONFLICT_CODE = "executor_conflict";

export function isStaleExecutorError(e: unknown): boolean {
  return e instanceof RunnerApiError && e.status === 409 && e.code === EXECUTOR_CONFLICT_CODE;
}

/**
 * A request the control plane refused ON ITS MERITS (4xx): the claim is gone,
 * this bearer is no longer current, or the body is wrong. Sending it again
 * produces the identical answer, so it is never retried. Everything else — a
 * 5xx, a dropped socket, a control plane restarting under a deploy — is
 * transient and worth another attempt.
 */
export function isRunnerRefusal(e: unknown): boolean {
  return e instanceof RunnerApiError && e.status >= 400 && e.status < 500;
}

export class RunnerApiError extends Error {
  declare status: number;
  declare code: string;
  declare details: RunnerDynamic;

  constructor(status: number, envelope: RunnerDynamic) {
    const e = envelope?.error || {};
    super(e.message || `runner API request failed (${status})`);
    this.name = "RunnerApiError";
    this.status = status;
    this.code = e.code || "error";
    this.details = e.details;
  }
}

export class ApiClient {
  declare baseUrl: string;
  declare token: string | null;

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  withToken(token: string) {
    return new ApiClient(this.baseUrl, token);
  }

  /**
   * `Answer` is the caller's statement of what this route answers with — the
   * owned protocol types in `protocol.ts` — defaulting to the explicit unsafe
   * boundary for routes whose answers nothing reads. `signal` is the live
   * uploader's abort seam: a case ending must not wait on a held request
   * (docs/contracts/hosted.md "Live staging routes"). Every other caller omits it.
   */
  async json<Answer = RunnerDynamic, Body = RunnerDynamic>(method: string, path: string, body: Body | undefined = undefined, { signal }: { signal?: AbortSignal } = {}): Promise<Answer> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(resolveApiPath(this.baseUrl, path), {
      method,
      redirect: "error",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    if (res.status === 204) return null as Answer; // SAFETY: a 204 route's caller reads nothing from it.
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new RunnerApiError(res.status, data);
    return data;
  }

  async bytes(path: string): Promise<Buffer> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(resolveApiPath(this.baseUrl, path), { headers, redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new RunnerApiError(res.status, await res.json().catch(() => ({})));
    return Buffer.from(await res.arrayBuffer());
  }

  async putBytes<Answer = RunnerDynamic>(path: string, bytes: Buffer, contentType = "application/octet-stream", { signal }: { signal?: AbortSignal } = {}): Promise<Answer> {
    const headers: Record<string, string> = { "content-type": contentType };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    // Streaming the existing buffer avoids fetch's full-size BodyInit copy.
    const res = await fetch(resolveApiPath(this.baseUrl, path), { method: "PUT", redirect: "error", headers, body: Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>, duplex: "half", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) } as RequestInit);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new RunnerApiError(res.status, data);
    return data;
  }
}
