import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import pg from "pg";
import { ServerConfigError } from "./config.ts";
import type { ControlPlaneConfig } from "./config.ts";

export type DbRow = Record<string, any>; // SAFETY: SQL result schemas remain dynamic at the query boundary.
export interface QueryResult<Row extends DbRow = DbRow> { rows: Row[]; rowCount: number }
export interface Tx {
  query<Row extends DbRow = DbRow>(text: string, params?: unknown[]): Promise<QueryResult<Row>>;
  db: Db;
}
interface TxStore { tx: Tx; after: Array<() => void>; active: boolean }

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

export function inClause(values: readonly unknown[], startIndex: number): string {
  return values.map((_, i) => `$${startIndex + i}`).join(", ");
}


function encode(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "object") return canonicalJson(value as CanonicalValue);
  return value;
}

function numeric(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) {
    throw new Error("Database numeric result exceeds JavaScript's safe range");
  }
  return number;
}

export class Db extends EventEmitter {
  readonly client: pg.Client;
  readonly als = new AsyncLocalStorage<TxStore>();
  tail: Promise<void> = Promise.resolve();
  closed = false;
  failure: Error | null = null;
  feedWaker?: { notify(projectId: string): void };

  constructor(client: pg.Client) {
    super();
    this.client = client;
    client.on("error", (error) => this.fail(error));
    client.on("end", () => {
      if (!this.closed) this.fail(new Error("Postgres connection closed"));
    });
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.emit("disconnect");
  }

  private assertAvailable(): void {
    if (this.closed || this.failure) throw new Error("Postgres writer is unavailable; restart the control plane");
  }

  private async queued<T>(fn: () => Promise<T>): Promise<T> {
    const gate = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await gate;
      this.assertAvailable();
      return await fn();
    } finally {
      release();
    }
  }

  private async run<Row extends DbRow>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    this.assertAvailable();
    const result = await this.client.query<Row>(text, params.map(encode));
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async query<Row extends DbRow = DbRow>(text: string, params?: unknown[]): Promise<QueryResult<Row>> {
    const store = this.als.getStore();
    if (store) {
      if (!store.active) throw new Error("Database operation outlived its transaction");
      return this.run<Row>(text, params);
    }
    return this.queued(() => this.run<Row>(text, params));
  }

  async exec(sql: string): Promise<void> {
    const execute = async () => { this.assertAvailable(); await this.client.query(sql); };
    const store = this.als.getStore();
    if (store) {
      if (!store.active) throw new Error("Database operation outlived its transaction");
      await execute();
    } else await this.queued(execute);
  }

  afterCommit(fn: () => void): void {
    const store = this.als.getStore();
    if (store) {
      if (!store.active) throw new Error("Callback outlived its transaction");
      store.after.push(fn);
    } else fn();
  }

  async withTx<Result>(fn: (tx: Tx) => Result | Promise<Result>): Promise<Result> {
    const outer = this.als.getStore();
    if (outer) {
      if (!outer.active) throw new Error("Database operation outlived its transaction");
      return fn(outer.tx);
    }
    const after: Array<() => void> = [];
    const result = await this.queued(async () => {
      const store: TxStore = {
        tx: {
          query: <Row extends DbRow = DbRow>(sql: string, params?: unknown[]) => {
            if (!store.active) return Promise.reject(new Error("Database operation outlived its transaction"));
            return this.run<Row>(sql, params);
          },
          db: this,
        },
        after,
        active: true,
      };
      await this.client.query("BEGIN");
      try {
        const value = await this.als.run(store, () => fn(store.tx));
        const committed = await this.client.query("COMMIT");
        if (committed.command !== "COMMIT") throw new Error("Postgres transaction was rolled back after a failed statement");
        return value;
      } catch (error) {
        await this.client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        store.active = false;
      }
    });
    for (const callback of after) {
      try { callback(); } catch { /* Durable events remain available to the feed rescan. */ }
    }
    return result;
  }

  async end(): Promise<void> {
    if (this.closed) return;
    await this.tail;
    this.closed = true;
    await this.client.end();
  }
}

export async function connect(config: Pick<ControlPlaneConfig, "databaseUrl">): Promise<Db> {
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5000,
    application_name: "playtest-control-plane",
    types: { getTypeParser: (oid, format) => oid === 20 || oid === 1700 ? numeric : pg.types.getTypeParser(oid, format) },
  });
  const db = new Db(client);
  try {
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    const lock = await client.query("SELECT pg_try_advisory_lock(1886151033, 1) AS acquired");
    if (!lock.rows[0]?.acquired) throw new ServerConfigError("Another Playtest writer owns this database. Stop it before starting this server or running maintenance.");
    return db;
  } catch (error) {
    await db.end().catch(() => {});
    if (error instanceof ServerConfigError) throw error;
    throw new ServerConfigError("Cannot connect to Postgres. Check DATABASE_URL, tenant permissions, and database availability.");
  }
}
