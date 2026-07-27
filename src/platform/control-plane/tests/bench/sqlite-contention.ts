#!/usr/bin/env node
// S0 write-contention benchmark (docs/backlog/storage/S0-INVENTORY.md §5).
//
// Measures whether one SQLite database on a local durable filesystem sustains
// the control plane's real transaction mix, and whether concurrent connections
// on the same file contend badly enough to threaten the single-node assumption.
//
// NOT part of any test gate: it writes to a temp directory, fsyncs hard, and
// takes tens of seconds. Run it deliberately:
//
//   node src/platform/control-plane/tests/bench/sqlite-contention.ts
//   node src/platform/control-plane/tests/bench/sqlite-contention.ts --json
//
// The workload mirrors the three shapes the hosted API actually issues:
//   write  — the outbox unit: append a run_event, update the run projection,
//            insert a platform_event, and append an audit row, in ONE
//            `BEGIN IMMEDIATE` transaction (src/events/run-events.js +
//            src/audit.ts + src/events/outbox.ts).
//   list   — the read projections: a feed page by ULID cursor, the findings
//            queue, and the storage-usage aggregate.
//   event  — the long-poll tail read: newest platform_event id for a project.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  run_group_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  story_id TEXT,
  status TEXT NOT NULL,
  score INTEGER,
  totals TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS platform_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  entity TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_events_project_idx ON platform_events(project_id, id);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  project_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_project_idx ON audit_log(project_id, ts DESC);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL,
  merged_into TEXT,
  last_seen INTEGER NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS findings_queue_idx ON findings(project_id, state, severity, last_seen DESC);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  tier TEXT NOT NULL,
  project_id TEXT NOT NULL
);
`;

const PROJECT = "01KTFIXTUREPROJECT00000001";
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type WorkerRole = "write" | "list" | "event";

interface WorkSpec {
  role: WorkerRole;
  ops: number;
}

interface WorkerPayload extends WorkSpec {
  file: string;
  id: number;
  synchronous: string;
  fullfsync: boolean;
  deadline: number | null;
}

interface WorkerResult {
  role: WorkerRole;
  id: number;
  done: number;
  busy: number;
  latencies: number[];
}

interface OpenOptions {
  synchronous: string;
  setJournalMode?: boolean;
  fullfsync?: boolean;
}

interface SeedOptions {
  runs?: number;
  findings?: number;
  artifacts?: number;
}

type SummaryColumn =
  | "scenario"
  | "workers"
  | "operations"
  | "ops_per_s"
  | "p50_ms"
  | "p95_ms"
  | "p99_ms"
  | "max_ms"
  | "sqlite_busy_retries";

interface Summary {
  scenario: string;
  workers: number;
  operations: number;
  wall_ms: number;
  ops_per_s: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
  sqlite_busy_retries: number;
  writes?: Summary;
  reads?: Summary;
  synchronous?: string;
  db_bytes?: number;
  wal_bytes?: number;
}

function ulid(ms: number, counter: number): string {
  let t = ms;
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let c = counter;
  let tail = "";
  for (let i = 0; i < 16; i += 1) {
    tail = B32[c % 32] + tail;
    c = Math.floor(c / 32);
  }
  return time + tail;
}

// Pragma order matters: `journal_mode = WAL` briefly needs an exclusive lock, so
// `busy_timeout` must be armed first or a second connection opening concurrently
// fails outright with SQLITE_BUSY_RECOVERY instead of waiting. `journal_mode` is
// persistent in the file, so only the creating connection sets it.
function open(file: string, { synchronous, setJournalMode = false, fullfsync = false }: OpenOptions): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  if (setJournalMode) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA synchronous = ${synchronous}`);
  // macOS `fsync(2)` does not flush the drive's write cache; only F_FULLFSYNC
  // does. Without this pragma a "synchronous = FULL" number on darwin is
  // optimistic relative to Linux. Measured both ways so the floor is honest.
  if (fullfsync) db.exec("PRAGMA fullfsync = 1");
  return db;
}

function seed(file: string, { runs = 40, findings = 60, artifacts = 80 }: SeedOptions = {}): void {
  const db = open(file, { synchronous: "FULL", setJournalMode: true });
  db.exec(SCHEMA);
  db.exec("BEGIN IMMEDIATE");
  const insRun = db.prepare(
    "INSERT INTO runs (id, run_group_id, project_id, case_id, story_id, status, score, totals, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < runs; i += 1) {
    insRun.run(
      `run-${i}`, `group-${i % 5}`, PROJECT, `case-${i}`, `story-${i % 7}`,
      i % 3 === 0 ? "fail" : "pass", 50 + (i % 50),
      JSON.stringify({ steps: 10 + i, cost_usd: 0.1 + i / 1000 }), Date.now(),
    );
  }
  const insFinding = db.prepare(
    "INSERT INTO findings (id, project_id, fingerprint, title, severity, state, merged_into, last_seen, evidence_count) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < findings; i += 1) {
    insFinding.run(
      `finding-${i}`, PROJECT, `fp-${i}`, `Finding ${i}`,
      ["info", "minor", "major"][i % 3] as string, ["new", "accepted", "resolved"][i % 3] as string, // SAFETY: modulo indexing always selects one of these inline seed values
      null, Date.now() - i * 1000, i % 4,
    );
  }
  const insArtifact = db.prepare(
    "INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, project_id) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < artifacts; i += 1) {
    insArtifact.run(
      `artifact-${i}`, `run-${i % runs}`, ["bundle", "index", "clip", "clip_vtt"][i % 4] as string, // SAFETY: modulo indexing always selects one of these inline seed values
      `runs/group/${i}.ptrun`, "0".repeat(64), 4096 + i * 17, i % 3 === 0 ? "core" : "full", PROJECT,
    );
  }
  db.exec("COMMIT");
  db.close();
}

// ------------------------------------------------------------------ worker

function runWorker(): void {
  const { file, role, ops, id, synchronous, fullfsync, deadline }: WorkerPayload = workerData;
  const db = open(file, { synchronous, fullfsync });
  const latencies: number[] = [];
  let busy = 0;
  let done = 0;

  const insEvent = db.prepare("INSERT INTO run_events (run_id, seq, ts, type, payload) VALUES (?, COALESCE((SELECT MAX(seq) + 1 FROM run_events WHERE run_id = ?), 1), ?, ?, ?)");
  const updRun = db.prepare("UPDATE runs SET status = ?, score = ?, updated_at = ? WHERE id = ?");
  const insPlatform = db.prepare("INSERT INTO platform_events (id, project_id, type, entity, payload, ts) VALUES (?,?,?,?,?,?)");
  const insAudit = db.prepare("INSERT INTO audit_log (id, ts, project_id, actor, action, entity_type, entity_id, detail) VALUES (?,?,?,?,?,?,?,?)");

  const feedPage = db.prepare("SELECT id, ts, type, entity, payload FROM platform_events WHERE project_id = ? AND id > ? ORDER BY id LIMIT 200");
  const feedTail = db.prepare("SELECT id FROM platform_events WHERE project_id = ? ORDER BY id DESC LIMIT 1");
  const findingsQueue = db.prepare(
    "SELECT id, title, severity, state, evidence_count FROM findings WHERE project_id = ? AND merged_into IS NULL AND state IN ('new','accepted','reopened') ORDER BY last_seen DESC LIMIT 50",
  );
  const storage = db.prepare("SELECT tier, kind, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM artifacts WHERE project_id = ? GROUP BY tier, kind");
  const spend = db.prepare("SELECT COALESCE(SUM(CAST(json_extract(totals, '$.cost_usd') AS REAL)), 0) AS usd FROM runs WHERE project_id = ?");

  const writeTxn = (i: number): void => {
    const now = Date.now();
    const runId = `run-${(id * 7 + i) % 40}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      insEvent.run(runId, runId, now, "step", JSON.stringify({ step: i, action: "click", worker: id }));
      updRun.run(i % 5 === 0 ? "fail" : "pass", 40 + (i % 60), now, runId);
      insPlatform.run(ulid(now, id * 1e6 + i), PROJECT, "run.event", JSON.stringify({ run_id: runId }), JSON.stringify({ seq: i }), now);
      insAudit.run(ulid(now, id * 1e6 + i + 500000), now, PROJECT, JSON.stringify({ system: "bench" }), "run.event", "run", runId, JSON.stringify({ i }));
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  };

  const listTxn = () => {
    feedPage.all(PROJECT, "0".repeat(26));
    findingsQueue.all(PROJECT);
    storage.all(PROJECT);
    spend.get(PROJECT);
  };

  const eventTxn = () => {
    feedTail.get(PROJECT);
  };

  while (done < ops && (!deadline || Date.now() < deadline)) {
    const t0 = process.hrtime.bigint();
    try {
      if (role === "write") writeTxn(done);
      else if (role === "list") listTxn();
      else eventTxn();
    } catch (e: any) { // SAFETY: SQLite errors expose errstr, message, and errcode at this benchmark boundary
      if (String(e.errstr || e.message).includes("busy") || e.errcode === 5) {
        busy += 1;
        continue;
      }
      throw e;
    }
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    done += 1;
  }
  db.close();
  parentPort!.postMessage({ role, id, done, busy, latencies }); // SAFETY: worker execution always has a parent port
}

// -------------------------------------------------------------------- main

const pct = (sorted: number[], q: number): number | null | undefined =>
  (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const r2 = (n: number | null | undefined): number | null => (n == null ? null : Math.round(n * 100) / 100);

function summarize(name: string, results: WorkerResult[], wallMs: number): Summary {
  const all = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const done = results.reduce((a, r) => a + r.done, 0);
  const busy = results.reduce((a, r) => a + r.busy, 0);
  return {
    scenario: name,
    workers: results.length,
    operations: done,
    wall_ms: Math.round(wallMs),
    ops_per_s: r2((done / wallMs) * 1000),
    p50_ms: r2(pct(all, 0.5)),
    p95_ms: r2(pct(all, 0.95)),
    p99_ms: r2(pct(all, 0.99)),
    max_ms: r2(all.at(-1)),
    sqlite_busy_retries: busy,
  };
}

function spawn(file: string, spec: WorkSpec[], synchronous: string, fullfsync: boolean): Promise<{
  results: WorkerResult[];
  wallMs: number;
}> {
  const started = Date.now();
  const workers = spec.map(
    (w, i) =>
      new Promise<WorkerResult>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { file, role: w.role, ops: w.ops, id: i, synchronous, fullfsync, deadline: null },
        });
        worker.on("message", resolve);
        worker.on("error", reject);
      }),
  );
  return Promise.all(workers).then((results) => ({ results, wallMs: Date.now() - started }));
}

async function main() {
  const asJson = process.argv.includes("--json");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-sqlite-bench-"));
  const scenarios: Summary[] = [];

  const run = async (
    name: string,
    file: string,
    spec: WorkSpec[],
    synchronous: string,
    fullfsync = false
  ): Promise<Summary> => {
    seed(file);
    const { results, wallMs } = await spawn(file, spec, synchronous, fullfsync);
    const writeOnly = results.filter((r) => r.role === "write");
    const readOnly = results.filter((r) => r.role !== "write");
    const summary = summarize(name, results, wallMs);
    if (writeOnly.length && readOnly.length) {
      summary.writes = summarize(`${name} (writes)`, writeOnly, wallMs);
      summary.reads = summarize(`${name} (reads)`, readOnly, wallMs);
    }
    summary.synchronous = fullfsync ? `${synchronous} + fullfsync` : synchronous;
    summary.db_bytes = fs.statSync(file).size;
    const wal = `${file}-wal`;
    summary.wal_bytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
    scenarios.push(summary);
    return summary;
  };

  await run("1 writer, synchronous=FULL", path.join(root, "a.sqlite"), [{ role: "write", ops: 1000 }], "FULL");
  await run("1 writer, synchronous=NORMAL", path.join(root, "b.sqlite"), [{ role: "write", ops: 2000 }], "NORMAL");
  await run(
    "1 writer, FULL + fullfsync (durable floor)",
    path.join(root, "a2.sqlite"),
    [{ role: "write", ops: 300 }],
    "FULL",
    true,
  );
  await run(
    "4 concurrent writers, FULL + fullfsync",
    path.join(root, "c2.sqlite"),
    Array.from({ length: 4 }, () => ({ role: "write", ops: 150 })),
    "FULL",
    true,
  );
  await run(
    "4 concurrent writers, synchronous=FULL",
    path.join(root, "c.sqlite"),
    Array.from({ length: 4 }, () => ({ role: "write", ops: 500 })),
    "FULL",
  );
  await run(
    "8 concurrent writers, synchronous=NORMAL",
    path.join(root, "d.sqlite"),
    Array.from({ length: 8 }, () => ({ role: "write", ops: 500 })),
    "NORMAL",
  );
  await run(
    "2 writers + 4 readers (WAL), synchronous=FULL",
    path.join(root, "e.sqlite"),
    [
      { role: "write", ops: 500 },
      { role: "write", ops: 500 },
      { role: "list", ops: 1000 },
      { role: "list", ops: 1000 },
      { role: "event", ops: 4000 },
      { role: "event", ops: 4000 },
    ],
    "FULL",
  );

  const out = {
    node: process.version,
    sqlite: new DatabaseSync(":memory:").prepare("SELECT sqlite_version() AS v").get()!.v, // SAFETY: SQLite always returns one row for sqlite_version()
    platform: `${os.platform()} ${os.arch()}`,
    cpus: os.cpus().length,
    driver: "node:sqlite (DatabaseSync)",
    scenarios,
  };
  fs.rmSync(root, { recursive: true, force: true });

  if (asJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }
  process.stdout.write(`node ${out.node} · sqlite ${out.sqlite} · ${out.platform} · ${out.cpus} cpus · ${out.driver}\n\n`);
  const cols: SummaryColumn[] = ["scenario", "workers", "operations", "ops_per_s", "p50_ms", "p95_ms", "p99_ms", "max_ms", "sqlite_busy_retries"];
  const widths = cols.map((c) => Math.max(c.length, ...scenarios.map((s) => String(s[c]).length)));
  const line = (vals: Array<string | number | null>) => vals.map((v, i) => String(v).padEnd(widths[i]!)).join("  "); // SAFETY: vals and widths are derived from the same column list
  process.stdout.write(line(cols) + "\n");
  process.stdout.write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
  for (const s of scenarios) {
    process.stdout.write(line(cols.map((c) => s[c])) + "\n");
    if (s.writes) {
      process.stdout.write("  " + line(cols.map((c) => (c === "scenario" ? "  ↳ writes" : s.writes![c]))) + "\n"); // SAFETY: this branch is guarded by the writes summary
      process.stdout.write("  " + line(cols.map((c) => (c === "scenario" ? "  ↳ reads" : s.reads![c]))) + "\n"); // SAFETY: mixed summaries assign reads with writes
    }
  }
}

if (isMainThread) await main();
else runWorker();
