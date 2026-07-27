// Turn a scenario run against the fixture into the trace shapes the bench
// consumes. Used by the bench tests so the bench is exercised against traffic a
// real client actually produced, not against hand-written JSON that could
// silently drift from the fixture.

import fs from "node:fs";
import path from "node:path";
import { startFixture } from "./harness.js";

/**
 * Run `scenario(client)` against a fresh fixture and return the recorded HAR
 * entries in Playtest's api-driver shape. Every recording starts with an admin
 * reset, exactly as a harness-owned per-run isolation step would
 * (DESIGN §3) — it also anchors the bench's phantom-effect oracle.
 */
export async function record({ faults = [], seed = "bench-seed", scenario }) {
  const fixture = await startFixture({ faults, seed });
  try {
    await fixture.client.reset(seed);
    const outcome = await scenario(fixture.client);
    return { entries: fixture.client.har, outcome };
  } finally {
    await fixture.close();
  }
}

/** Write a Playtest-style run directory: manifest.json + har.json (+ label). */
export function writePlaytestRun(dir, entries, { label = null, caseId = "ledger-probe@api-fuzzer", steps = null, costUsd = null, runId = "2026-07-25T0900-be01" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const started = entries[0]?.startedDateTime ?? new Date().toISOString();
  const durationMs = entries.reduce((total, entry) => total + Math.max(0, entry.time ?? 0), 0);
  const manifest = {
    schema_version: 1,
    run_id: runId,
    case: { id: caseId, mode: "journey", persona: "api-fuzzer" },
    mode: "act",
    started_at: started,
    finished_at: new Date(Date.parse(started) + durationMs).toISOString(),
    duration_ms: durationMs,
    pins: { driver: "api", harness_version: "0.1.0" },
    env: { base_url: "http://127.0.0.1:4180", driver: "api" },
    result: { status: "pass", end_reason: "done", error: null, gate: null },
    totals: {
      steps: steps ?? entries.length,
      executed_steps: steps ?? entries.length,
      tokens: { in: 0, out: 0 },
      cost_usd: costUsd,
    },
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "har.json"), `${JSON.stringify({ log: { entries } })}\n`);
  if (label) fs.writeFileSync(path.join(dir, "bench-meta.json"), `${JSON.stringify({ label }, null, 2)}\n`);
  return dir;
}

/** Convert Playtest-flavoured entries into a standard HAR 1.2 log. */
export function toStandardHar(entries, creator = { name: "ledger-bench-recorder", version: "1.0" }) {
  return {
    log: {
      version: "1.2",
      creator,
      entries: entries.map((entry) => ({
        startedDateTime: entry.startedDateTime,
        time: entry.time,
        request: {
          method: entry.request.method,
          url: entry.request.url,
          httpVersion: "HTTP/1.1",
          headers: Object.entries(entry.request.headers ?? {}).map(([name, value]) => ({ name, value })),
          queryString: [...new URL(entry.request.url).searchParams].map(([name, value]) => ({ name, value })),
          cookies: [],
          headersSize: -1,
          bodySize: entry.request.body ? Buffer.byteLength(entry.request.body) : 0,
          ...(entry.request.body
            ? { postData: { mimeType: "application/json", text: entry.request.body } }
            : {}),
        },
        response: {
          status: entry.response.status,
          statusText: "",
          httpVersion: "HTTP/1.1",
          headers: Object.entries(entry.response.headers ?? {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          content: {
            size: entry.response.bodySize,
            mimeType: entry.response.mimeType,
            text: entry.response.body,
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: entry.response.bodySize,
        },
        cache: {},
        timings: { send: 0, wait: entry.time, receive: 0 },
      })),
    },
  };
}

/** Write a plain HAR file plus its optional `<name>.meta.json` sidecar. */
export function writeHarFile(file, entries, { label = null, creator, meta } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(toStandardHar(entries, creator), null, 2)}\n`);
  if (label || meta) {
    const sidecar = `${file.replace(/\.[^.]+$/, "")}.meta.json`;
    fs.writeFileSync(sidecar, `${JSON.stringify({ label, ...(meta ?? {}) }, null, 2)}\n`);
  }
  return file;
}

/**
 * Write the HAR cassette Schemathesis produces with
 * `--cassette-path <file> --cassette-format har`.
 */
export function writeSchemathesisCassette(file, entries, options = {}) {
  return writeHarFile(file, entries, {
    ...options,
    creator: { name: "Schemathesis", version: "3.39.0", comment: "stateful mode" },
  });
}
