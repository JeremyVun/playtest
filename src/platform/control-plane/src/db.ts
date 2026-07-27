// SQLite access (node:sqlite, no npm dependency): one owned connection, an
// explicit `withTx` wrapper (the transactional-outbox unit — a state change +
// its audit row + its event, committed atomically), and a query wrapper that
// keeps the historical `{ rows, rowCount }` shape.
//
// Design notes (docs/backlog/storage/DESIGN.md, S0-INVENTORY.md §1, §5):
//
//   * One write connection. SQLite's write lock is not FIFO, so a pool buys
//     unfair tail latency and nothing else at this write volume.
//   * Pragma order is load-bearing: `busy_timeout` is armed BEFORE
//     `journal_mode = WAL`, which briefly needs an exclusive lock and otherwise
//     fails with SQLITE_BUSY_RECOVERY instead of waiting.
//   * Every pragma is verified after it is set; a failure is a startup error.
//   * `$1 … $n` placeholders are SQLite named parameters, so query text is
//     unchanged from the Postgres era; the adapter binds the array by index.
//   * Rows are decoded from the schema itself. Columns are declared `TEXT_JSON`
//     / `INT_TS` / `INT_BOOL`, `PRAGMA table_info` reports those verbatim, and
//     `StatementSync#columns()` reports each result column's origin table and
//     column — so JSON parsing, boolean coercion, and epoch-ms → Date happen
//     once here rather than at ~200 call sites. Computed/aliased expression
//     columns have no origin and are returned raw.
//   * `now()` is registered as a SQL function returning the transaction's
//     start instant (Postgres `now()` semantics), so `updated_at = now()` in
//     existing SQL keeps working and one transaction stamps one instant.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { ServerConfigError } from "./config.ts";
import type { ControlPlaneConfig } from "./config.ts";

export type DbRow = Record<string, any>; // TODO(ts): Raw SQL result schemas are dynamic until the query layer gains generated row mappings.
export interface QueryResult<Row extends DbRow = DbRow> {
  rows: Row[];
  rowCount: number;
}
export interface Tx {
  query<Row extends DbRow = DbRow>(text: string, params?: unknown[]): QueryResult<Row>;
  db: Db;
}
interface TxStore {
  tx: Tx;
  after: Array<() => void>;
}
type Decoder = (value: unknown) => unknown;

/** Canonical JSON: object keys sorted recursively, no insignificant whitespace. */
type CanonicalValue =
  | null
  | string
  | number
  | boolean
  | undefined
  | Date
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

export function canonicalJson(value: CanonicalValue): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/**
 * `col = ANY($n)` has no SQLite analogue. Build `(?,?,…)` placeholder text for a
 * bounded, server-controlled list plus the params to append.
 * @param {number} startIndex 1-based index of the first new placeholder
 */
export function inClause(values: readonly unknown[], startIndex: number): string {
  return values.map((_, i) => `$${startIndex + i}`).join(", ");
}

const STRING_LITERALS = /'(?:[^']|'')*'/g;
const PARAM_REF = /\$(\d+)/g;

/** Indices of the `$n` placeholders a statement actually references. */
function placeholderIndices(sql: string): Set<number> {
  const bare = sql.replace(STRING_LITERALS, "''");
  const out = new Set<number>();
  let m: RegExpExecArray | null;
  PARAM_REF.lastIndex = 0;
  while ((m = PARAM_REF.exec(bare))) out.add(Number(m[1]));
  return out;
}

/** JS value -> a value node:sqlite can bind. */
function encode(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === "object") return canonicalJson(value as CanonicalValue) as string; // json / json-array columns
  return value as SQLInputValue;
}

const DECODERS: Record<string, Decoder> = {
  TEXT_JSON: (v: unknown) => (v === null ? null : JSON.parse(v as string)),
  INT_TS: (v: unknown) => (v === null ? null : new Date(Number(v))),
  INT_BOOL: (v: unknown) => (v === null ? null : !!v),
  BLOB: (v: unknown) => (v === null || Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array)),
};

export class Db {
  declare readonly conn: DatabaseSync;
  declare readonly file: string;
  declare schemaTypes: Map<string, Map<string, string>>;
  declare readonly als: AsyncLocalStorage<TxStore>;
  declare txNow: number | null;
  declare tail: Promise<void>;
  declare closed: boolean;
  declare statements: Map<string, StatementSync>;
  declare feedWaker?: { notify(projectId: string): void };
  declare readonly db?: Db;

  constructor(conn: DatabaseSync, { file }: { file: string }) {
    this.conn = conn;
    this.file = file;
    /** table -> column -> declared type, rebuilt after migrations. */
    this.schemaTypes = new Map();
    this.als = new AsyncLocalStorage();
    this.txNow = null;
    this.tail = Promise.resolve(); // serializes transactions against loose queries
    this.closed = false;
    /** table -> column -> declared type, rebuilt after migrations. */
    this.conn.function("now", { deterministic: false }, () => this.txNow ?? Date.now());
    this.refreshSchema();
  }

  /** Re-read declared column types. Call after DDL. */
  refreshSchema() {
    this.schemaTypes = new Map();
    const tables = this.conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name as string);
    for (const table of tables) {
      const cols = new Map<string, string>();
      for (const c of this.conn.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()) {
        cols.set(c.name as string, String(c.type || "").toUpperCase());
      }
      this.schemaTypes.set(table, cols);
    }
    this.statements = new Map();
  }

  #prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.conn.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  /** Build a per-result-column decoder list from the statement's origin metadata. */
  #decoders(stmt: StatementSync): Array<Decoder | null> {
    return stmt.columns().map((c) => {
      if (!c.table || !c.column) return null;
      const declared = this.schemaTypes.get(c.table)?.get(c.column);
      return declared ? DECODERS[declared] || null : null;
    });
  }

  /** Execute one statement on the current connection. Synchronous by nature. */
  #run<Row extends DbRow = DbRow>(text: string, params: unknown[] = []): QueryResult<Row> {
    const stmt = this.#prepare(text);
    const wanted = placeholderIndices(text);
    const bound: Record<number, SQLInputValue> = {};
    for (const i of wanted) bound[i] = encode(params[i - 1]);
    const returnsRows = stmt.columns().length > 0;
    if (!returnsRows) {
      const info = stmt.run(bound);
      return { rows: [], rowCount: Number(info.changes) };
    }
    const decoders = this.#decoders(stmt);
    const names = stmt.columns().map((c) => c.name);
    const raw = stmt.all(bound);
    const rows = raw.map((r) => {
      const out: DbRow = {};
      for (let i = 0; i < names.length; i += 1) {
        const name = names[i];
        const dec = decoders[i];
        out[name as string] = dec ? dec(r[name as string]) : r[name as string];
      }
      return out as Row; // TODO(ts): SQL text determines the caller-selected row shape.
    });
    return { rows, rowCount: rows.length };
  }

  /**
   * A single statement. Inside a `withTx` body it joins that transaction
   * (AsyncLocalStorage), so a stray `db.query` can never leak out of — or
   * deadlock against — the open transaction.
   */
  async query<Row extends DbRow = DbRow>(text: string, params?: unknown[]): Promise<QueryResult<Row>> {
    if (this.als.getStore()) return this.#run<Row>(text, params);
    const gate = this.tail;
    let release!: () => void; // TODO(ts): The Promise constructor synchronously assigns the release callback.
    this.tail = new Promise((r) => (release = r));
    try {
      await gate;
      return this.#run<Row>(text, params);
    } finally {
      release();
    }
  }

  /** Multi-statement DDL/DML script (migrations). */
  exec(sql: string): void {
    this.conn.exec(sql);
  }

  /**
   * Register a callback to fire after the enclosing transaction commits (and
   * never if it rolls back) — the `NOTIFY`-at-COMMIT guarantee, made explicit.
   * Outside a transaction it fires immediately.
   */
  afterCommit(fn: () => void): void {
    const store = this.als.getStore();
    if (store) store.after.push(fn);
    else fn();
  }

  /**
   * Run `fn(tx)` inside `BEGIN IMMEDIATE` — the write lock is taken at statement
   * one, so a read-then-decide sequence cannot act on state another writer is
   * changing. Commit on success, rollback on any throw. Nested calls join the
   * outer transaction.
   *
   * Keep model calls, HTTP requests, and object-store I/O OUT of the body: the
   * body holds the single write connection for its whole duration.
   */
  async withTx<Result>(fn: (tx: Tx) => Result | Promise<Result>): Promise<Result> {
    const outer = this.als.getStore();
    if (outer) return await fn(outer.tx);

    const gate = this.tail;
    let release!: () => void; // TODO(ts): The Promise constructor synchronously assigns the release callback.
    this.tail = new Promise((r) => (release = r));
    await gate;

    const store: { tx: Tx | null; after: Array<() => void> } = { tx: null, after: [] };
    store.tx = { query: <Row extends DbRow = DbRow>(t: string, p?: unknown[]) => this.#run<Row>(t, p), db: this };
    this.txNow = Date.now();
    let result: Result;
    try {
      this.conn.exec("BEGIN IMMEDIATE");
      try {
        result = await this.als.run(store as TxStore, () => fn(store.tx as Tx));
        this.conn.exec("COMMIT");
      } catch (e) {
        try {
          this.conn.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw e;
      }
    } finally {
      this.txNow = null;
      release();
    }
    for (const cb of store.after) {
      try {
        cb();
      } catch {
        /* post-commit signals are best-effort; the committed row is truth */
      }
    }
    return result;
  }

  async end() {
    if (this.closed) return;
    this.closed = true;
    await this.tail.catch(() => {});
    this.statements = new Map();
    try {
      this.conn.exec("PRAGMA optimize");
    } catch {
      /* best effort */
    }
    this.conn.close();
  }
}

/** Pragmas in the order S0 §5 proved is required, with the value to verify. */
const PRAGMAS = [
  { sql: "PRAGMA busy_timeout = 5000", check: "busy_timeout", expect: (v: unknown) => Number(v) === 5000 },
  { sql: "PRAGMA journal_mode = WAL", check: "journal_mode", expect: (v: unknown) => String(v).toLowerCase() === "wal" },
  { sql: "PRAGMA foreign_keys = ON", check: "foreign_keys", expect: (v: unknown) => Number(v) === 1 },
  { sql: "PRAGMA synchronous = FULL", check: "synchronous", expect: (v: unknown) => Number(v) === 2 },
];

/**
 * Open the control-plane database at `config.databaseFile`, verifying that the
 * data root is writable and that every required pragma actually took effect.
 * Both failures are boot-time ServerConfigErrors naming what to fix.
 */
export async function connect(
  config: Pick<ControlPlaneConfig, "databaseFile">,
  { file = config.databaseFile }: { file?: string } = {}
): Promise<Db> {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch (e: any /* TODO(ts): Filesystem startup errors expose code and message. */) {
    throw new ServerConfigError(
      `the Playtest data root is not writable: ${dir} (${e.code || e.message}). ` +
        `Set PLAYTEST_DATA_DIR to a durable directory this process can write, ` +
        `and keep the database and its object store on the same volume.`,
    );
  }

  let conn: DatabaseSync;
  try {
    conn = new DatabaseSync(file);
  } catch (e: any /* TODO(ts): SQLite open errors expose code and message. */) {
    throw new ServerConfigError(
      `cannot open the Playtest database at ${file} (${e.code || e.message}). ` +
        `Set PLAYTEST_DATA_DIR to a durable, writable directory on a filesystem ` +
        `with reliable locking (local disk — not NFS).`,
    );
  }

  for (const { sql, check, expect } of PRAGMAS) {
    try {
      conn.exec(sql);
      const row = conn.prepare(`PRAGMA ${check}`).get();
      const value = row ? Object.values(row)[0] : undefined;
      if (!expect(value)) {
        throw new Error(`reported ${JSON.stringify(value)}`);
      }
    } catch (e: any /* TODO(ts): SQLite pragma failures expose Error.message. */) {
      conn.close();
      throw new ServerConfigError(
        `SQLite rejected a required setting on ${file}: \`${sql}\` (${e.message}). ` +
          `WAL journalling, foreign keys, a busy timeout, and synchronous=FULL are all ` +
          `required; a filesystem without reliable locking (NFS, some container overlays) ` +
          `cannot host the Playtest database.`,
      );
    }
  }

  return new Db(conn, { file });
}
