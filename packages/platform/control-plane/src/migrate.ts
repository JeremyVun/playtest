import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ServerConfigError } from "./config.ts";
import type { Db } from "./db.ts";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return fs.readdirSync(dir).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
}

export function assertLedgerIsShippable(applied: readonly string[], shipped: readonly string[]): void {
  const unknown = applied.filter((file) => !shipped.includes(file));
  if (unknown.length) throw new ServerConfigError(`This database has migrations absent from this release: ${unknown.join(", ")}. Use a compatible release or restore a verified backup.`);
}

export async function migrate(db: Db, { dir = MIGRATIONS_DIR, log = () => {} }: { dir?: string; log?: (message: string) => void } = {}): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text COLLATE "C" PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = migrationFiles(dir);
  const applied = (await db.query("SELECT filename, sha256 FROM schema_migrations")).rows;
  assertLedgerIsShippable(applied.map((row) => row.filename), files);
  const scripts = new Map(files.map((file) => {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    return [file, { sql, sha256: createHash("sha256").update(sql).digest("hex") }];
  }));
  for (const row of applied) {
    if (row.sha256 !== scripts.get(row.filename)?.sha256) throw new ServerConfigError(`Applied migration ${row.filename} was edited. Restore the original file and add a new numbered migration.`);
  }
  const done = new Set(applied.map((row) => row.filename));
  const ran: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const script = scripts.get(file)!;
    await db.withTx(async (tx) => {
      await tx.db.exec(script.sql);
      await tx.query("INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)", [file, script.sha256]);
    });
    ran.push(file);
    log(`migrated ${file}`);
  }
  return ran;
}
