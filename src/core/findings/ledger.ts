// The LOCAL findings ledger: a suite/workspace-scoped SQLite database that gives
// bug candidates and findings durable cross-run identity and lifecycle
// (docs/contracts/interfaces.md#local-findings-ledger).
//
// WHERE IT LIVES (P5 item 1): `<suite root>/.playtest/findings.db`, where the
// suite root is the nearest ancestor holding `playtest.yaml` — the same identity
// `results/*.baseline.jsonl` is already scoped to. Deliberately NOT inside
// `runs/`: a runs root is disposable evidence that CI wipes between jobs, while
// the ledger is durable identity that must survive it. The directory is created
// with its own `.gitignore` (`*`) so the ledger is source-control-ignored in any
// consumer's repository without editing theirs.
//
// WHAT IT STORES (D8): opaque ids, algorithm-versioned fingerprints, candidates,
// evidence REFERENCES (run id + run dir + step numbers), lifecycle transitions,
// and merge tombstones. It never stores artifact bytes: no `.ptrun` payloads, no
// copies of `grade.json`, no screenshots. Run directories remain the portable
// evidence source, and no ledger failure may touch them.
//
// SCOPE (D8): every key is computed under the ledger's opaque `workspace_id` —
// the local analogue of the hosted `project_id`, minted once when the database
// is created and stored in `ledger_meta`. Local and hosted therefore share the
// key ALGORITHM and its versions (key-v1 / locus-norm-v1 / match-text-v1) but
// never share key VALUES; a local→hosted import recomputes keys under the hosted
// project scope (see ./exports.js for the format contract).
import fs from "node:fs";
import path from "node:path";
import { DummyConfigError } from "../config.ts";
import { ulid } from "../ulid.ts";
import type { DatabaseSync } from "node:sqlite";

type DynamicValue = any; // TODO(ts): SQLite rows and statement parameters vary by query at this low-level ledger seam
export type LedgerRow = Record<string, DynamicValue>;

export interface Ledger {
  db: DatabaseSync;
  file: string;
  suiteRoot: string;
  workspaceId: DynamicValue;
  all(sql: string, params?: DynamicValue[]): LedgerRow[];
  get(sql: string, params?: DynamicValue[]): DynamicValue;
  run(sql: string, params?: DynamicValue[]): DynamicValue;
  tx<T>(fn: (ledger: Ledger) => T): T;
  close(): void;
}

export const LEDGER_DIR = ".playtest";
export const LEDGER_FILE = "findings.db";

/** Bumping this is a migration; `openLedger` refuses a newer file. */
export const SCHEMA_VERSION = 1;

/** `node:sqlite` (DatabaseSync) is stable from Node 22.5; the root package still supports Node 20. */
export const MIN_NODE: DynamicValue = [22, 5, 0];

const nowIso = () => new Date().toISOString();

const SCHEMA = `
-- Ledger identity and schema bookkeeping. workspace_id is the opaque local
-- analogue of the hosted project_id and is the first part of every exact key.
CREATE TABLE ledger_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Durable local findings. Identity is the opaque id; "fingerprint" is a lookup
-- key only (the promoting candidate's strict key when it had one).
CREATE TABLE findings (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  fingerprint     TEXT,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '{}',
  severity        TEXT NOT NULL CHECK (severity IN ('info','minor','major')),
  state           TEXT NOT NULL CHECK (state IN ('new','accepted','rejected','resolved','reopened')),
  reject_reason   TEXT CHECK (reject_reason IS NULL OR reject_reason IN ('not_a_bug','wont_fix')),
  merged_into     TEXT REFERENCES findings(id) ON DELETE SET NULL,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  evidence_count  INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX findings_fingerprint_active_idx
  ON findings(workspace_id, fingerprint) WHERE fingerprint IS NOT NULL AND merged_into IS NULL;
CREATE INDEX findings_queue_idx ON findings(state, last_seen DESC) WHERE merged_into IS NULL;
CREATE INDEX findings_merged_idx ON findings(merged_into);

-- Evidence REFERENCES only: a run id, the directory it was read from, and step
-- numbers. Never bytes. Append-only and idempotent on the natural key.
CREATE TABLE finding_evidence (
  id          TEXT PRIMARY KEY,
  finding_id  TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL,
  run_dir     TEXT,
  case_id     TEXT NOT NULL,
  step_from   INTEGER,
  step_to     INTEGER,
  excerpt     TEXT,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX finding_evidence_natural_idx
  ON finding_evidence(finding_id, run_id, COALESCE(step_from, -1));
CREATE INDEX finding_evidence_finding_idx ON finding_evidence(finding_id, created_at);

-- Every lifecycle change, in order. Hosted records these in its audit log; the
-- local ledger has no audit log, so transitions are a first-class table.
CREATE TABLE finding_transitions (
  id          TEXT PRIMARY KEY,
  finding_id  TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  reason      TEXT,
  note        TEXT,
  actor       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX finding_transitions_finding_idx ON finding_transitions(finding_id, created_at);

-- Merge tombstones. "findings.merged_into" is the pointer that lookups follow;
-- this table is the durable record of who merged into whom, and when.
CREATE TABLE finding_merges (
  id                TEXT PRIMARY KEY,
  from_finding_id   TEXT NOT NULL,
  into_finding_id   TEXT NOT NULL,
  actor             TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX finding_merges_from_idx ON finding_merges(from_finding_id);

-- Typed bug candidates (D3/D4). Mirrors the hosted table, minus hosted-only
-- concerns (project FK, run FK, feed) and plus the run directory reference.
CREATE TABLE bug_candidates (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  run_id                TEXT,
  run_dir               TEXT,
  case_id               TEXT,
  story_id              TEXT,
  category              TEXT NOT NULL,
  claim                 TEXT NOT NULL,
  source                TEXT NOT NULL CHECK (source IN ('run_grade','reviewer','import')),

  signal_type           TEXT,
  locus                 TEXT,
  normalized_locus      TEXT,
  strict_key            TEXT,
  loose_key             TEXT,
  key_algo_version      TEXT NOT NULL,
  locus_norm_version    TEXT NOT NULL,

  match_text            TEXT NOT NULL DEFAULT '',
  match_text_version    TEXT NOT NULL,

  status                TEXT NOT NULL CHECK (status IN ('unassigned','assigned','dismissed')),
  finding_id            TEXT REFERENCES findings(id) ON DELETE SET NULL,
  suggested_finding_id  TEXT REFERENCES findings(id) ON DELETE SET NULL,
  suggestion_kind       TEXT CHECK (suggestion_kind IS NULL OR suggestion_kind IN ('loose_key')),
  dismiss_reason        TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('not_a_bug','wont_fix','duplicate')),
  recurrence_count      INTEGER NOT NULL DEFAULT 0,
  intake_key            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX bug_candidates_queue_idx ON bug_candidates(status, created_at DESC);
CREATE INDEX bug_candidates_strict_idx ON bug_candidates(strict_key);
CREATE INDEX bug_candidates_loose_idx ON bug_candidates(loose_key);
CREATE INDEX bug_candidates_finding_idx ON bug_candidates(finding_id);
CREATE UNIQUE INDEX bug_candidates_intake_key_idx
  ON bug_candidates(intake_key) WHERE intake_key IS NOT NULL;

CREATE TABLE bug_candidate_evidence (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL REFERENCES bug_candidates(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  run_dir       TEXT,
  case_id       TEXT NOT NULL,
  step_from     INTEGER,
  step_to       INTEGER,
  excerpt       TEXT,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX bug_candidate_evidence_natural_idx
  ON bug_candidate_evidence(candidate_id, run_id, COALESCE(step_from, -1), source);
CREATE INDEX bug_candidate_evidence_candidate_idx ON bug_candidate_evidence(candidate_id, created_at);

-- Rejecting a candidate records its keys here; an exact (strict) recurrence is
-- absorbed and counted instead of re-entering the queue.
CREATE TABLE bug_candidate_suppressions (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL CHECK (scope IN ('strict','loose')),
  key               TEXT NOT NULL,
  key_algo_version  TEXT NOT NULL,
  candidate_id      TEXT REFERENCES bug_candidates(id) ON DELETE SET NULL,
  reason            TEXT,
  absorbed_count    INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (scope, key)
);
`;

/** True when this Node can load `node:sqlite`'s stable DatabaseSync. */
export function sqliteSupported(version: string = process.versions.node): boolean {
  const parts = String(version).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < MIN_NODE.length; i++) {
    if ((parts[i] ?? 0) > MIN_NODE[i]) return true;
    if ((parts[i] ?? 0) < MIN_NODE[i]) return false;
  }
  return true;
}

/**
 * The suite root that scopes a ledger: an explicit directory, else the nearest
 * ancestor of `from` holding a playtest.yaml (the walk stops at a .git root, the
 * same rule `suiteRootFor` uses).
 */
export function resolveSuiteRoot(explicit: string | null = null, from: string = process.cwd()): string {
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!isDir(abs)) throw new DummyConfigError(`--suite must be a directory: ${explicit}`);
    return abs;
  }
  for (let dir = path.resolve(from); ;) {
    if (fs.existsSync(path.join(dir, "playtest.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  throw new DummyConfigError(
    "no suite found here: the local findings ledger is scoped to the suite holding playtest.yaml.\n" +
      "  Run this from inside your suite, or name it:\n" +
      "  playtest findings list --suite ./test-stories",
  );
}

/** The ledger file for a suite root. */
export function ledgerPath(suiteRoot: string): string {
  return path.join(suiteRoot, LEDGER_DIR, LEDGER_FILE);
}

/**
 * Open (and migrate, and create on first use) the ledger for one suite.
 *
 * Every failure here is a DummyConfigError carrying the recovery action, and
 * none of them touch run artifacts: the ledger holds identity only.
 *
 * @param {{suite?: string|null, from?: string, create?: boolean}} [opts]
 * @returns {Promise<object>} ledger handle; call `close()` when done
 */
export async function openLedger({ suite = null, from = process.cwd(), create = true }: { suite?: string | null; from?: string; create?: boolean } = {}): Promise<Ledger> {
  if (!sqliteSupported()) {
    throw new DummyConfigError(
      `local findings ledger requires Node 22.5+ (running ${process.version}).\n` +
        "  Node's built-in SQLite (node:sqlite) is only available from 22.5.\n" +
        "  Upgrade Node, or use the hosted control plane for cross-run findings.",
    );
  }
  const suiteRoot = resolveSuiteRoot(suite, from);
  const file = ledgerPath(suiteRoot);
  if (!create && !fs.existsSync(file)) {
    throw new DummyConfigError(
      `no findings ledger yet for ${suiteRoot}.\n` +
        "  It is created by the first: playtest findings consolidate",
    );
  }

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (e) {
    throw new DummyConfigError(
      `this Node cannot load node:sqlite (${firstLine(e)}).\n` +
        "  The local findings ledger needs Node 22.5+ with node:sqlite available.",
    );
  }

  ensureLedgerDir(path.dirname(file));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 10000");
    migrate(db);
  } catch (e) {
    try {
      db?.close();
    } catch {}
    throw corruptLedgerError(file, e);
  }

  const ledger = makeLedger(db, { file, suiteRoot });
  try {
    ledger.workspaceId = ensureWorkspaceId(ledger);
  } catch (e) {
    ledger.close();
    throw corruptLedgerError(file, e);
  }
  return ledger;
}

function makeLedger(db: DatabaseSync, { file, suiteRoot }: { file: string; suiteRoot: string }): Ledger {
  return {
    db,
    file,
    suiteRoot,
    workspaceId: null,
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    get(sql, params = []) {
      return db.prepare(sql).get(...params) ?? null;
    },
    run(sql, params = []) {
      return db.prepare(sql).run(...params);
    },
    /** One immediate transaction: the deciding read holds the write lock too. */
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn(this);
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    },
    close() {
      try {
        db.close();
      } catch {}
    },
  };
}

/**
 * A ledger that cannot be opened is a configuration failure with one recovery
 * action, never a stack trace — and never a reason to touch run artifacts.
 */
function corruptLedgerError(file: string, cause: unknown): DummyConfigError {
  return new DummyConfigError(
    `cannot open the local findings ledger at ${file}:\n` +
      `  ${firstLine(cause)}\n` +
      "  The ledger holds finding identity only — your run artifacts are stored in runs/ and are untouched.\n" +
      `  Move the file aside to start a fresh ledger (evidence is re-read from runs/):\n` +
      `    mv ${file} ${file}.corrupt`,
  );
}

const firstLine = (e: DynamicValue): DynamicValue => String(e?.message ?? e).split("\n")[0];

function ensureLedgerDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  // Source-control-ignored wherever it lands, without editing the consumer's
  // .gitignore.
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, "# Local Playtest state (findings ledger). Not portable; never committed.\n*\n");
  }
}

function migrate(db: DynamicValue): void {
  const current: DynamicValue = db.prepare("PRAGMA user_version").get().user_version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `ledger schema v${current} was written by a newer Playtest (this build understands v${SCHEMA_VERSION})`,
    );
  }
  if (current === SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (current === 0) db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
}

function ensureWorkspaceId(ledger: Ledger): string {
  const row = ledger.get("SELECT value FROM ledger_meta WHERE key = 'workspace_id'");
  if (row?.value) return row.value;
  const id = ulid();
  ledger.tx(() => {
    ledger.run("INSERT OR IGNORE INTO ledger_meta (key, value) VALUES ('workspace_id', ?)", [id]);
    ledger.run("INSERT OR IGNORE INTO ledger_meta (key, value) VALUES ('created_at', ?)", [nowIso()]);
    ledger.run("INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('schema_version', ?)", [
      String(SCHEMA_VERSION),
    ]);
  });
  return ledger.get("SELECT value FROM ledger_meta WHERE key = 'workspace_id'").value;
}

function isDir(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

export { nowIso };
