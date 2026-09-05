import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../db.ts";
import type { ObjectStore } from "../types.ts";

export class Lifecycle {
  #readers = 0;
  #writer = false;
  #queue: Array<{ write: boolean; resolve(): void }> = [];
  #scope = new AsyncLocalStorage<{ write: boolean; active: boolean }>();
  #keys = new Map<string, Promise<void>>();

  #advance(): void {
    if (this.#writer || this.#readers || !this.#queue.length) return;
    if (this.#queue[0]!.write) { this.#writer = true; this.#queue.shift()!.resolve(); }
    else while (this.#queue.length && !this.#queue[0]!.write) { this.#readers++; this.#queue.shift()!.resolve(); }
  }
  async #run<T>(write: boolean, fn: () => Promise<T>): Promise<T> {
    const outer = this.#scope.getStore();
    if (outer?.active) {
      if (write && !outer.write) throw new Error("Object lifecycle cannot upgrade a publication lock to deletion");
      if (!outer.write) this.#readers++;
      const scope = { write: outer.write, active: true };
      try { return await this.#scope.run(scope, fn); } finally { scope.active = false; if (!outer.write) { this.#readers--; this.#advance(); } }
    }
    if (!write && !this.#writer && !this.#queue.length) this.#readers++;
    else await new Promise<void>(resolve => { this.#queue.push({ write, resolve }); this.#advance(); });
    const scope = { write, active: true };
    try { return await this.#scope.run(scope, fn); }
    finally { scope.active = false; if (write) this.#writer = false; else this.#readers--; this.#advance(); }
  }
  read<T>(fn: () => Promise<T>): Promise<T> { return this.#run(false, fn); }
  delete<T>(fn: () => Promise<T>): Promise<T> { return this.#run(true, fn); }
  async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.#keys.get(key) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    this.#keys.set(key, next);
    await prior;
    try { return await fn(); }
    finally { release(); if (this.#keys.get(key) === next) this.#keys.delete(key); }
  }
}
const owners = new WeakMap<Db, Lifecycle>();
export function lifecycle(ctx: { db: Db }): Lifecycle {
  if (ctx.db.als.getStore()?.active) throw new Error("Acquire object lifecycle before the database transaction");
  let owner = owners.get(ctx.db);
  if (!owner) { owner = new Lifecycle(); owners.set(ctx.db, owner); }
  return owner;
}

export function outsideTransactions(store: ObjectStore, db: Db): ObjectStore {
  const check = () => { if (db.als.getStore()?.active) throw new Error("Object I/O inside a database transaction is forbidden"); };
  return {
    put: (...args) => { check(); return store.put(...args); },
    get: (...args) => { check(); return store.get(...args); },
    getRange: (...args) => { check(); return store.getRange(...args); },
    has: (...args) => { check(); return store.has(...args); },
    delete: (...args) => { check(); return store.delete(...args); },
    list: (...args) => { check(); return store.list(...args); },
    async *listPages(...args) { check(); yield* store.listPages(...args); },
    close: () => store.close(),
  };
}
