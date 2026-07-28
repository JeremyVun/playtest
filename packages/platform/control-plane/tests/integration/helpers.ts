// Integration test harness. Each test spins a whole control plane on an ephemeral
// port against its own temporary data root — one SQLite file plus its object
// store, removed on teardown — so suites parallelize and leave no residue.
// Auth is the dev bypass.
//
// No database service, no Docker, no environment gate: every integration test
// runs everywhere `npm install` runs.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/app.ts";
import { ulid } from "../../src/ulid.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** Run `fn({ base, app, api })` against a fresh, isolated control plane. `envOverrides`
 * merges into the env passed to loadConfig (e.g. PUBLIC_URL=https://… to exercise
 * the Secure-cookie path without needing a real TLS listener). */
export async function withApp(fn: HostedDynamic, envOverrides: HostedDynamic = {}, appOptions: HostedDynamic = {}) {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ptdata-"));
  const storeRoot = path.join(dataRoot, "objects");
  const config = loadConfig({
    PLAYTEST_DATA_DIR: dataRoot,
    PLAYTEST_AUTH: "dev",
    OBJECT_STORE_URL: storeRoot,
    PLAYTEST_KMS_KEY: Buffer.alloc(32, 3).toString("base64"),
    LOG_LEVEL: "error",
    // Phase 7 background behaviors are opt-in per test: rate limits off so
    // write-heavy suites stay deterministic, reconciler off so tests that call
    // reconcileDispatches() drive it themselves (a background pass against the
    // SpawningGitHub stub would mark dispatches dead mid-test).
    PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "0",
    PLAYTEST_RECONCILE_INTERVAL_S: "0",
    ...envOverrides,
  });
  const app = await createApp(config, appOptions);
  const addr: HostedDynamic = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn({ base, app, api: makeClient(base), storeRoot });
  } finally {
    await app.close();
    await fsp.rm(dataRoot, { recursive: true, force: true });
  }
}

/** A tiny API client: returns { status, body } and never throws on 4xx/5xx. */
export function makeClient(base: HostedDynamic, { token = null }: HostedDynamic = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const call = async (method: HostedDynamic, path: HostedDynamic, body?: HostedDynamic, extra: HostedDynamic = {}) => {
    const opts: HostedDynamic = { method, headers: { ...headers, ...(extra.headers || {}) } };
    if (extra.raw !== undefined) opts.body = extra.raw;
    else if (body !== undefined) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
    const res = await fetch(base + "/api/v1" + path, opts);
    const ct = res.headers.get("content-type") || "";
    let data;
    if (ct.includes("application/json")) data = await res.json();
    else data = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: data, headers: res.headers };
  };
  return {
    get: (p: HostedDynamic) => call("GET", p),
    post: (p: HostedDynamic, b: HostedDynamic) => call("POST", p, b),
    put: (p: HostedDynamic, b: HostedDynamic) => call("PUT", p, b),
    patch: (p: HostedDynamic, b: HostedDynamic) => call("PATCH", p, b),
    del: (p: HostedDynamic, b: HostedDynamic) => call("DELETE", p, b),
    postTar: (p: HostedDynamic, buf: HostedDynamic) => call("POST", p, undefined, { raw: buf, headers: { "content-type": "application/x-tar" } }),
    /** PUT raw bytes — anything a route takes that is not JSON. */
    putRaw: (p: HostedDynamic, buf: HostedDynamic) =>
      call("PUT", p, undefined, { raw: buf, headers: { "content-type": "application/octet-stream" } }),
    withToken: (t: HostedDynamic) => makeClient(base, { token: t }),
  };
}

/**
 * The target fixture every launching test needs: one application and one ring
 * with a URL.
 *
 * A suite runs against exactly one application and launches against exactly one
 * of that application's rings, and the ring's `base_url` is the ONLY thing that
 * decides where a hosted run points — there is no fallback to whatever the suite
 * happened to author. So a test that launches has to create this pair first, and
 * pass `ring.id` as the launch's `ring_id`.
 *
 * Defaults suit the common case (a web application with one `local` ring), and
 * every field is overridable for the tests that care: `driver`/`platform` for a
 * mobile surface, `runnerLabels` for placement, `discoveryAllowed` for discovery
 * stories, `config` for the logical auth/secret_env overlay.
 *
 * A suite created after this needs no `application_id`: with exactly one
 * application in the project, suite creation takes it.
 */
export async function createTarget(api: HostedDynamic, project: HostedDynamic, over: HostedDynamic = {}) {
  const {
    key = "app",
    name = over.key ?? "App",
    driver = "web",
    platform = null,
    ringKey = "local",
    ringName = ringKey,
    baseUrl = driver === "mobile" ? null : "http://127.0.0.1:4173",
    runnerLabels = [],
    discoveryAllowed = false,
    config = {},
  } = over;
  const created = await api.post(`/projects/${project.key}/applications`, {
    key,
    name,
    driver,
    ...(platform ? { platform } : {}),
  });
  if (created.status !== 201) {
    throw new Error(`could not create application "${key}": ${created.status} ${JSON.stringify(created.body)}`);
  }
  const application = created.body;
  const ringRes = await api.post(`/applications/${application.id}/rings`, {
    key: ringKey,
    name: ringName,
    ...(baseUrl == null ? {} : { base_url: baseUrl }),
    runner_labels: runnerLabels,
    discovery_allowed: discoveryAllowed,
    config,
  });
  if (ringRes.status !== 201) {
    throw new Error(`could not create ring "${key}/${ringKey}": ${ringRes.status} ${JSON.stringify(ringRes.body)}`);
  }
  return { application, ring: ringRes.body };
}

/** Load a suite directory into a { path: content } map (skipping run output). */
export function loadSuiteDir(dir: HostedDynamic) {
  const files: HostedDynamic = {};
  const walk = (d: HostedDynamic, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "results" || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else files[r] = fs.readFileSync(path.join(d, e.name), "utf8");
    }
  };
  walk(dir);
  return files;
}
