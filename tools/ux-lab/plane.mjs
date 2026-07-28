// A disposable, fully-seeded hosted control plane for UX work.
//
// Boots `packages/platform/control-plane` in-process (same code path as the
// integration harness: `createApp` + `listen`) against a throwaway data root, so
// a UX pass never touches the developer's own `.playtest-data` or port 4177.
//
// Placement has one model now: a launch lands on the project's runner claim
// board, and a runner (registered through the public API, credentialed, and
// polling) claims and exchanges for it. There is no dispatch stub to install —
// `seed.mjs` registers a real (if throwaway) runner per group it needs claimed,
// then drives the *public* runner protocol (poll → claim → exchange → start →
// upload → report → complete) exactly as `runner-agent pool` would, which is
// what makes the server compute real candidates, findings, events, and group
// summaries instead of hand-forged rows. The lab deliberately never starts a
// `runner-agent pool` process of its own, so a launch made through the console
// (rather than by `seed.mjs`) stays queued on the board — see the README.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CP = path.join(REPO_ROOT, "packages/platform/control-plane/src");

/** A tiny API client over /api/v1 that throws with the server's message. */
export function makeClient(base) {
  const call = async (method, p, body, { raw, contentType, expect } = {}) => {
    const headers = {};
    let payload;
    if (raw !== undefined) {
      payload = raw;
      headers["content-type"] = contentType || "application/octet-stream";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${base}/api/v1${p}`, { method, headers, body: payload });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    const okay = expect ? [].concat(expect).includes(res.status) : res.ok;
    if (!okay) {
      const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
      const err = new Error(`${method} ${p} → ${res.status}: ${msg}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  };
  return {
    base,
    get: (p, o) => call("GET", p, undefined, o),
    post: (p, b, o) => call("POST", p, b, o),
    put: (p, b, o) => call("PUT", p, b, o),
    patch: (p, b, o) => call("PATCH", p, b, o),
    del: (p, b, o) => call("DELETE", p, b, o),
    raw: call,
  };
}

/**
 * Start a control plane on `port` against `dataDir`.
 * @param {{port?: number, dataDir?: string, reset?: boolean, log?: boolean}} opts
 */
export async function startPlane({
  port = 4188,
  dataDir = path.join(REPO_ROOT, "tools/ux-lab/.data"),
  reset = true,
  log = false,
} = {}) {
  const { loadConfig } = await import(path.join(CP, "config.ts"));
  const { createApp } = await import(path.join(CP, "app.ts"));

  if (reset) await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.mkdir(dataDir, { recursive: true });

  const config = loadConfig({
    PLAYTEST_DATA_DIR: dataDir,
    PLAYTEST_AUTH: "dev",
    PLAYTEST_KMS_KEY: Buffer.alloc(32, 7).toString("base64"),
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    LOG_LEVEL: log ? "info" : "error",
    // Seeding writes far faster than a human; the limiter would 429 mid-seed.
    PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "0",
    // The lab holds every in-flight state at once — four busy groups plus the
    // open runs the live surfaces need — which is more than one project may
    // really dispatch concurrently. The cap is a deployment policy, and nothing
    // it guards (a real fleet with its own limits) exists here.
    PLAYTEST_DISPATCH_MAX_ACTIVE_PER_PROJECT: "12",
    // No reconciler: the seeded runners never heartbeat again once seed.mjs
    // moves on, and a reconciliation pass would declare their claims dead
    // mid-capture.
    PLAYTEST_RECONCILE_INTERVAL_S: "0",
  });

  const app = await createApp(config);
  const addr = await app.listen(port, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    app,
    db: app.db,
    store: app.store,
    dataDir,
    api: makeClient(base),
    stop: () => app.close(),
  };
}
