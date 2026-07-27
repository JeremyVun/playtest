// Load pass on the hosted read path: boots a whole control plane in-process on
// its own temporary SQLite data root (the same withApp harness the integration
// tests use), seeds one project with M
// finished runs each carrying a REAL sealed .ptrun bundle (direct SQL + object
// store, the phase3-adapter-paths.test.js pattern — no executor, this measures
// the READ path only), then fires N concurrent simulated viewer sessions for T
// seconds. Each session loops the realistic viewer read path:
//
//   GET /projects/:p/view/runs.json        (picker)
//   GET /projects/:p/view/changed.json     (review list)
//   GET /projects/:p/view/history.json?case=<id>
//   GET /projects/:p/view/run/<run_id>/<case_id>/trajectory.jsonl
//   GET /projects/:p/view/run/<run_id>/<case_id>/grade.json
//   GET /projects/:p/view/run/<run_id>/<case_id>/steps/step-001.png
//
// Run it:   node packages/platform/control-plane/tests/load/viewer-load.ts
// Knobs:    LOAD_RUNS (M, default 12), LOAD_SESSIONS (N, default 25),
//           LOAD_SECONDS (T, default 10), LOAD_BUNDLE_KB (pad per bundle, 512),
//           PLAYTEST_VIEW_CACHE_MB (viewer-adapter.js bundle LRU cap, 256).
//
// PLAYTEST_VIEW_CACHE_MB is a MODULE-LEVEL constant in viewer-adapter.js,
// snapshotted from process.env at import time. As a CLI that is naturally set
// before this file's imports run; a test that wants a tiny cap must set
// process.env BEFORE dynamically importing this module (see
// phase7-viewer-load.test.ts).
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { withApp } from "../integration/helpers.ts";
import { setUpProject } from "../integration/exec-helpers.ts";
import { writeBundle } from "@playtest/core/artifacts";
import { ulid } from "../../src/ulid.ts";

const CASE_IDS = ["add-todo", "admin-note", "signup"];
const ROUTE_CLASSES = ["runs.json", "changed.json", "history.json", "bundle-entry"];
const ERROR_SAMPLE_MAX = 20;

// ---------- seeding ----------

/** Build one synthetic-but-real run directory and seal it into a .ptrun. The
 * manifest carries every field the viewer projections read (runsJson /
 * changedJson / historyJson — viewer-adapter.ts). Returns entry hashes so the
 * load loop can optionally verify served bytes against the sealed bundle. */
async function buildRunBundle(tmpDir: HostedDynamic, i: HostedDynamic, { runId, caseId, bundleKb, runCount }: HostedDynamic) {
  const startedAt = new Date(Date.now() - (runCount - i) * 60_000).toISOString();
  const manifest = {
    run_id: runId,
    mode: i < CASE_IDS.length ? "record" : "act",
    healed: i % 4 === 3, // some healed passes so changed.json is a real query, not always-[]
    started_at: startedAt,
    duration_ms: 5_000 + i * 137,
    case: {
      id: caseId,
      story: `As a member I can ${caseId.replace(/-/g, " ")}`,
      description: `viewer-load fixture run #${i + 1}`,
      tags: ["load"],
    },
    result: { status: "pass" },
    totals: { steps: 6, lcp_ms: 900 + i * 3, cost_usd: 0.0123 },
    pins: null,
    score: 92,
  };
  const trajectory =
    Array.from({ length: 40 }, (_, n) =>
      JSON.stringify({ step: n + 1, action: "click", target: `#el-${n}`, thought: `load fixture step ${n + 1} of run ${runId}` }),
    ).join("\n") + "\n";
  const grade = JSON.stringify({ score: 92, verdict: "pass", checks: [{ id: "goal", ok: true }] }, null, 2) + "\n";
  // Incompressible pad stored (not deflated — bundle.js STORE_RE matches .png)
  // so LOAD_BUNDLE_KB controls the sealed bundle size almost exactly.
  const png = crypto.randomBytes(bundleKb * 1024);

  const runDir = path.join(tmpDir, `run-${i}`);
  await fsp.mkdir(path.join(runDir, "steps"), { recursive: true });
  await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await fsp.writeFile(path.join(runDir, "trajectory.jsonl"), trajectory);
  await fsp.writeFile(path.join(runDir, "grade.json"), grade);
  await fsp.writeFile(path.join(runDir, "steps", "step-001.png"), png);

  const outPath = path.join(tmpDir, `run-${i}.ptrun`);
  writeBundle(runDir, outPath);
  const bytes = await fsp.readFile(outPath);
  return {
    manifest,
    bytes,
    entrySha: {
      "trajectory.jsonl": sha256(Buffer.from(trajectory)),
      "grade.json": sha256(Buffer.from(grade)),
      "steps/step-001.png": sha256(png),
    },
  };
}

/** Seed M finished runs (run_groups + runs + bundle artifacts) directly, the
 * phase3-adapter-paths.test.js pattern: the read path never cares who wrote. */
async function seedRuns(app: HostedDynamic, api: HostedDynamic, { runs, bundleKb }: HostedDynamic) {
  const { project, suite, env } = await setUpProject(api, {
    key: "viewer-load",
    todoAppUrl: "http://127.0.0.1:1", // never dialed — nothing executes in a read-path load
    authStubUrl: "http://127.0.0.1:1",
  });
  const snap = await app.db.query(
    `SELECT id FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 1`,
    [suite.id],
  );
  if (!snap.rows[0]) throw new Error("imported suite has no snapshot");
  const snapshotId = snap.rows[0].id;

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-viewer-load-"));
  const seeded: HostedDynamic[] = [];
  let bundleBytesTotal = 0;
  try {
    for (let i = 0; i < runs; i++) {
      const caseId = CASE_IDS[i % CASE_IDS.length];
      const runId = `ld${String(i + 1).padStart(3, "0")}-${ulid().toLowerCase()}`;
      const { manifest, bytes, entrySha } = await buildRunBundle(tmpDir, i, { runId, caseId, bundleKb, runCount: runs });

      const groupId = ulid();
      const runDbId = ulid();
      await app.db.query(
        `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
           VALUES ($1, $2, $3, $4, $5, '{}', '{}', 'done')`,
        [groupId, project.id, suite.id, snapshotId, env.id],
      );
      await app.db.query(
        `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, healed, manifest,
                           totals, score, duration_ms, started_at, finished_at)
           VALUES ($1, $2, $3, $3, $4, 'pass', $5, $6, $7, $8, $9, $10, $11, now())`,
        [
          runDbId, groupId, caseId, runId, manifest.mode, manifest.healed,
          manifest, manifest.totals,
          manifest.score, manifest.duration_ms, new Date(manifest.started_at),
        ],
      );
      const key = `runs/${groupId}/${runDbId}.ptrun`;
      const stored = await app.store.put(key, bytes);
      await app.db.query(
        `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
           VALUES ($1, $2, 'bundle', $3, $4, $5, 'full', now())`,
        [ulid(), runDbId, key, stored.sha256, stored.size],
      );
      bundleBytesTotal += stored.size;
      seeded.push({ path: `${runId}/${caseId}`, caseId, size: stored.size, entrySha });
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  return { project, seeded, bundleBytesTotal };
}

// ---------- the load loop ----------

function newStats() {
  const classes: HostedDynamic = {};
  for (const c of ROUTE_CLASSES) classes[c] = [];
  return { classes, total: 0, errorCount: 0, errors: [] };
}

function recordError(stats: HostedDynamic, cls: HostedDynamic, url: HostedDynamic, detail: HostedDynamic) {
  stats.total += 1;
  stats.errorCount += 1;
  if (stats.errors.length < ERROR_SAMPLE_MAX) stats.errors.push({ route: cls, url, detail });
}

/** One timed request. Every response is validated (200 + parseable JSON where
 * JSON; optional sha256 vs the sealed bundle) — a "fast wrong answer" counts as
 * an error, never as good latency. */
async function hit(stats: HostedDynamic, cls: HostedDynamic, url: HostedDynamic, { json = false, sha = null } = {}) {
  const t0 = performance.now();
  let res, buf;
  try {
    res = await fetch(url);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e: HostedDynamic) {
    return recordError(stats, cls, url, String(e?.message || e));
  }
  const ms = performance.now() - t0;
  if (res.status !== 200) return recordError(stats, cls, url, `status ${res.status}: ${buf.toString("utf8").slice(0, 120)}`);
  if (json) {
    try {
      JSON.parse(buf.toString("utf8"));
    } catch {
      return recordError(stats, cls, url, "unparseable JSON");
    }
  }
  if (sha && sha256(buf) !== sha) return recordError(stats, cls, url, "response bytes differ from the sealed bundle");
  stats.total += 1;
  stats.classes[cls].push(ms);
}

/** One simulated viewer session: loop the picker → review list → history →
 * a few bundle-entry reads, rotating across the seeded runs, until deadline. */
async function session(idx: HostedDynamic, { mount, seeded, deadline, stats, verifyBytes }: HostedDynamic) {
  let i = idx; // stagger the starting run per session so bundles interleave (LRU churn)
  while (performance.now() < deadline) {
    const run: HostedDynamic = seeded[i++ % seeded.length];
    const sha = (name: HostedDynamic) => (verifyBytes ? run.entrySha[name] : null);
    await hit(stats, "runs.json", `${mount}/runs.json`, { json: true });
    await hit(stats, "changed.json", `${mount}/changed.json`, { json: true });
    await hit(stats, "history.json", `${mount}/history.json?case=${encodeURIComponent(run.caseId)}`, { json: true });
    await hit(stats, "bundle-entry", `${mount}/run/${run.path}/trajectory.jsonl`, { sha: sha("trajectory.jsonl") });
    await hit(stats, "bundle-entry", `${mount}/run/${run.path}/grade.json`, { json: true, sha: sha("grade.json") });
    await hit(stats, "bundle-entry", `${mount}/run/${run.path}/steps/step-001.png`, { sha: sha("steps/step-001.png") });
  }
}

// ---------- percentiles / report ----------

function sha256(buf: HostedDynamic) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function percentile(sorted: HostedDynamic, p: HostedDynamic) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function cacheMbInEffect() {
  return Number(process.env.PLAYTEST_VIEW_CACHE_MB || 256); // mirror of viewer-adapter.js CACHE_MAX_BYTES
}

/**
 * Boot, seed, load, report. Options: runs (M), sessions (N), seconds (T),
 * bundleKb (pad per bundle), verifyBytes (sha-check every bundle-entry response
 * against the sealed bundle — the integration test's LRU-eviction correctness
 * check; off by default so the headline numbers measure serving, not client
 * hashing). Returns the report object; throws only on setup failure — request
 * failures are counted, sampled, and left to the caller to assert on.
 */
export async function runViewerLoad({ runs = 12, sessions = 25, seconds = 10, bundleKb = 512, verifyBytes = false } = {}) {
  let report: HostedDynamic = null;
  await withApp(async ({ base, app, api }: HostedDynamic) => {
    const { project, seeded, bundleBytesTotal } = await seedRuns(app, api, { runs, bundleKb });
    const mount = `${base}/api/v1/projects/${project.key}/view`;
    const stats = newStats();
    const t0 = performance.now();
    const deadline = t0 + seconds * 1000;
    await Promise.all(
      Array.from({ length: sessions }, (_, idx) => session(idx, { mount, seeded, deadline, stats, verifyBytes })),
    );
    const elapsedSeconds = (performance.now() - t0) / 1000;

    const classes: HostedDynamic = {};
    for (const [name, samples] of Object.entries(stats.classes) as HostedDynamic) {
      samples.sort((a: HostedDynamic, b: HostedDynamic) => a - b);
      classes[name] = {
        count: samples.length,
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        p99: percentile(samples, 99),
        max: samples.length ? samples[samples.length - 1] : null,
      };
    }
    report = {
      config: {
        runs, sessions, seconds, bundleKb, verifyBytes,
        cacheMb: cacheMbInEffect(),
        cacheMbSource: process.env.PLAYTEST_VIEW_CACHE_MB ? "env" : "default",
        bundleBytesTotal,
      },
      elapsedSeconds,
      totalRequests: stats.total,
      rps: stats.total / elapsedSeconds,
      errorCount: stats.errorCount,
      errors: stats.errors,
      classes,
    };
  });
  return report;
}

export function printReport(report: HostedDynamic, log = console.log) {
  const { config: c, classes } = report;
  const mb = (n: HostedDynamic) => (n / (1024 * 1024)).toFixed(1);
  const ms = (v: HostedDynamic) => (v == null ? "    -" : v.toFixed(1).padStart(7));
  log(`viewer read-path load — ${new Date().toISOString()}`);
  log(`  seeded runs (bundles)  : ${c.runs} × ~${c.bundleKb} KiB pad (${mb(c.bundleBytesTotal)} MB sealed total)`);
  log(`  sessions × duration    : ${c.sessions} × ${c.seconds}s (elapsed ${report.elapsedSeconds.toFixed(1)}s)`);
  log(`  view cache             : PLAYTEST_VIEW_CACHE_MB=${c.cacheMb} (${c.cacheMbSource})${c.verifyBytes ? "; sha-verifying every bundle entry" : ""}`);
  log(`  total requests         : ${report.totalRequests} (${report.rps.toFixed(1)} req/s)`);
  log(`  errors                 : ${report.errorCount}`);
  log(`  route class      count     p50     p95     p99     max  (ms)`);
  for (const [name, s] of Object.entries(classes) as HostedDynamic) {
    log(`  ${name.padEnd(14)} ${String(s.count).padStart(6)} ${ms(s.p50)} ${ms(s.p95)} ${ms(s.p99)} ${ms(s.max)}`);
  }
  for (const e of report.errors) log(`  error sample: [${e.route}] ${e.url} — ${e.detail}`);
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const envInt = (name: HostedDynamic, dflt: HostedDynamic) => {
    const v = Number(process.env[name] ?? dflt);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number, got "${process.env[name]}"`);
    return v;
  };
  const report = await runViewerLoad({
    runs: envInt("LOAD_RUNS", 12),
    sessions: envInt("LOAD_SESSIONS", 25),
    seconds: envInt("LOAD_SECONDS", 10),
    bundleKb: envInt("LOAD_BUNDLE_KB", 512),
    verifyBytes: process.env.LOAD_VERIFY === "1",
  });
  printReport(report);
  process.exit(report.errorCount === 0 ? 0 : 1);
}
