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
import { ServerConfigError } from "./config.ts";
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
 * Refuse a data root whose ledger names migrations this build no longer ships.
 *
 * The migrator is forward-only, so without this check a pre-rebaseline root
 * would simply have the new baseline applied ON TOP of the legacy schema: the
 * retired tables would survive, the new ones would collide with them, and the
 * failure would surface as a raw SQLite error at some later query. The
 * applications/rings model has no migration from the environments model it
 * replaces — the deployment is greenfield — so the honest answer is to name the
 * retired files and tell the operator to point `PLAYTEST_DATA_DIR` somewhere new.
 */
export function assertLedgerIsShippable(applied: readonly string[], shipped: readonly string[], file: string) {
  const known = new Set(shipped);
  const retired = applied.filter((f) => !known.has(f)).sort();
  if (!retired.length) return;
  const named = retired.slice(0, 4).join(", ") + (retired.length > 4 ? `, … (${retired.length} in all)` : "");
  throw new ServerConfigError(
    `the Playtest data root at ${file} was created by an older schema and cannot be upgraded: ` +
      `its migration ledger names ${named}, which this build no longer ships. Applications and ` +
      `environments replaced the previous target model with no migration path, so this database has to ` +
      `be recreated. ` +
      `Point PLAYTEST_DATA_DIR at a new directory (or delete the current one, losing its runs) ` +
      `and start the server again.`,
  );
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
  const files = migrationFiles(dir);
  const appliedRows = (await db.query("SELECT filename FROM schema_migrations")).rows.map((r) => String(r.filename));
  assertLedgerIsShippable(appliedRows, files, db.file);
  const applied = new Set(appliedRows);
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
