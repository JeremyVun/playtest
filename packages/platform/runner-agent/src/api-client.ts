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

  /** `signal` is the live uploader's abort seam: a case ending must not wait on
   * a held request (docs/contracts/hosted.md "Live staging routes"). Every other caller omits it. */
  async json(method: string, path: string, body: RunnerDynamic = undefined, { signal }: RunnerDynamic = {}): Promise<RunnerDynamic> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new RunnerApiError(res.status, data);
    return data;
  }

  async bytes(path: string): Promise<Buffer> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, { headers });
    if (!res.ok) throw new RunnerApiError(res.status, await res.json().catch(() => ({})));
    return Buffer.from(await res.arrayBuffer());
  }

  async putBytes(path: string, bytes: RunnerDynamic, contentType = "application/octet-stream", { signal }: RunnerDynamic = {}): Promise<RunnerDynamic> {
    const headers: Record<string, string> = { "content-type": contentType };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, { method: "PUT", headers, body: bytes, signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new RunnerApiError(res.status, data);
    return data;
  }
}
