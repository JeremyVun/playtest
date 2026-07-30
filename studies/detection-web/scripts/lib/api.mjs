// Hosted control-plane HTTP client for the detection-web study drivers.
// Dev-auth deployment: every request runs as the dev admin, no credential.
// Study rule: drivers speak ONLY this public /api/v1 surface.

const BASE = process.env.STUDY_HOSTED_URL || "http://127.0.0.1:4177";

export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → ${status}: ${JSON.stringify(body).slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

async function call(method, path, body, { raw, contentType } = {}) {
  const headers = {};
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers["content-type"] = contentType || "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: payload });
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(method, path, res.status, data);
  return data;
}

export const api = {
  base: BASE,
  get: (p) => call("GET", p),
  post: (p, body) => call("POST", p, body),
  put: (p, body, opts) => call("PUT", p, body, opts),
  putRaw: (p, raw, contentType) => call("PUT", p, undefined, { raw, contentType }),
  patch: (p, body) => call("PATCH", p, body),
  del: (p) => call("DELETE", p),
};

/** Poll a run group with server-side holds until it settles. */
export async function waitForGroup(groupId, { timeoutMs = 90 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const g = await api.get(`/run-groups/${groupId}?wait=25`);
    const status = g.run_group?.status ?? g.status;
    if (status === "done" || status === "canceled") return g;
    if (Date.now() > deadline) throw new Error(`run group ${groupId} still ${status} after ${timeoutMs}ms`);
  }
}

/**
 * Wait until the project's findings list stops changing (auto-dedupe and
 * synthesis sweeps are debounced): stable for `stableMs`, capped at `maxMs`.
 */
export async function waitForFindingsSettle(projectKey, { stableMs = 30_000, maxMs = 5 * 60_000 } = {}) {
  const started = Date.now();
  let last = "";
  let lastChange = Date.now();
  for (;;) {
    const res = await api.get(`/projects/${projectKey}/findings?state=all&limit=500`);
    const fingerprint = JSON.stringify(
      (res.items || []).map((f) => [f.id, f.state, f.merged_into ?? null, (f.evidence_count ?? f.evidence?.length) ?? 0]),
    );
    if (fingerprint !== last) {
      last = fingerprint;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= stableMs) {
      return res;
    }
    if (Date.now() - started > maxMs) return res;
    await new Promise((r) => setTimeout(r, 5000));
  }
}
