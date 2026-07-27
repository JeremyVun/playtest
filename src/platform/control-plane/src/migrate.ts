// Plain-SQL migrations runner. Applies every `migrations/NNNN_*.sql` not yet recorded in
// `schema_migrations`, in filename order, each inside its own transaction. No DSL,
// no down-migrations: forward-only numbered SQL, the smallest thing that works.
//
// SQLite runs DDL transactionally, so an interrupted migration leaves the schema
// exactly as it was. Files already recorded are skipped, which makes `migrate`
// idempotent and safe to run on every boot.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Sorted list of migration files (NNNN_name.sql). Exported for tests. */
export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
}

/**
 * Apply pending migrations. Idempotent: files already in schema_migrations are
 * skipped. Returns the list of files applied this call.
 * @param {import("./db.ts").Db} db
 */
export async function migrate(
  db: Db,
  { dir = MIGRATIONS_DIR, log = () => {} }: { dir?: string; log?: (message: string) => void } = {}
) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
    )
  `);
  db.refreshSchema();
  const applied = new Set(
    (await db.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename),
  );
  const files = migrationFiles(dir);
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await db.withTx(async (tx) => {
      // Multi-statement scripts cannot be prepared one at a time; exec runs the
      // whole file inside the transaction this wrapper already opened.
      tx.db.exec(sql);
      await tx.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    });
    log(`migrated ${file}`);
    ran.push(file);
  }
  // Column types just changed; the row decoder reads them from the schema.
  if (ran.length) db.refreshSchema();
  return ran;
}
