import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "./src/db.ts";
import type { Db } from "./src/db.ts";
import { loadConfig } from "./src/config.ts";
import type { ControlPlaneConfig } from "./src/config.ts";
import { makeObjectStore } from "./src/store/object-store.ts";
import { objectReferences } from "./src/store/references.ts";
import { validateKey } from "./src/store/keys.ts";
import { decryptSecret } from "./src/crypto/secrets.ts";
import { migrate } from "./src/migrate.ts";

interface Manifest {
  version: 1;
  createdAt: string;
  sourceStore: string;
  kmsFingerprint: string | null;
  dumpSha256: string;
  objects: Array<{ key: string; size: number; sha256: string }>;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (config: ControlPlaneConfig) => config.kmsKey ? sha(config.kmsKey) : null;
const storeIdentity = (config: ControlPlaneConfig) => config.objectStore.kind === "s3" ? `${config.objectStore.url}/${config.objectStore.bucket}/${config.objectStore.prefix}` : config.objectStore.root;
async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function writePrivate(file: string, bytes: Buffer | string): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function pgTool(command: string, args: string[], config: ControlPlaneConfig): Promise<void> {
  const url = new URL(config.databaseUrl);
  const env = { PATH: process.env.PATH, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get("sslmode") || "prefer", PGCONNECT_TIMEOUT: "10" };
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { error = (error + String(chunk)).slice(-4000); });
    child.once("error", () => reject(new Error(`${path.basename(command)} is unavailable; install PostgreSQL 18 client tools`)));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code}); verify database connectivity and PostgreSQL 18 compatibility${error.includes("version mismatch") ? ": server/client version mismatch" : ""}`)));
  });
}
async function verifySecrets(db: Db, config: ControlPlaneConfig): Promise<void> {
  for (const row of (await db.query("SELECT ciphertext FROM secrets UNION ALL SELECT ciphertext FROM session_artifacts")).rows) decryptSecret(config.kmsKey, row.ciphertext);
}

export async function backup(config: ControlPlaneConfig, directory: string, { pgDump = "pg_dump" } = {}): Promise<Manifest> {
  const db = await connect(config);
  const store = makeObjectStore(config.objectStore);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.mkdir(path.join(directory, "objects"), { mode: 0o700 });
    await writePrivate(path.join(directory, "INCOMPLETE"), "Backup is not complete.\n");
    await verifySecrets(db, config);
    const refs = await objectReferences(db);
    const dump = path.join(directory, "metadata.dump");
    await writePrivate(dump, "");
    await pgTool(pgDump, ["--format=custom", "--no-owner", "--no-acl", "--file", dump], config);
    const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), sourceStore: storeIdentity(config), kmsFingerprint: fingerprint(config), dumpSha256: await fileHash(dump), objects: [] };
    for (const key of [...refs].sort()) {
      validateKey(key);
      const bytes = await store.get(key);
      const hash = sha(bytes);
      const file = path.join(directory, "objects", hash);
      try { await writePrivate(file, bytes); } catch (e: any) { if (e.code !== "EEXIST") throw e; }
      if (await fileHash(file) !== hash) throw new Error("Backup object verification failed");
      manifest.objects.push({ key, size: bytes.length, sha256: hash });
    }
    const text = JSON.stringify(manifest, null, 2) + "\n";
    await writePrivate(path.join(directory, "manifest.json"), text);
    await writePrivate(path.join(directory, "COMPLETE"), sha(Buffer.from(text)) + "\n");
    await fs.unlink(path.join(directory, "INCOMPLETE"));
    return manifest;
  } finally { store.close(); await db.end(); }
}

export async function restore(config: ControlPlaneConfig, directory: string, { pgRestore = "pg_restore" } = {}): Promise<Manifest> {
  const text = await fs.readFile(path.join(directory, "manifest.json"));
  if ((await fs.readFile(path.join(directory, "COMPLETE"), "utf8")).trim() !== sha(text)) throw new Error("Backup is incomplete or its manifest is corrupt");
  const manifest = JSON.parse(text.toString()) as Manifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.objects)) throw new Error("Unsupported backup format");
  if (manifest.sourceStore === storeIdentity(config)) throw new Error("Restore requires a fresh object prefix; the source is preserved");
  if (manifest.kmsFingerprint !== fingerprint(config)) throw new Error("Restore requires the original PLAYTEST_KMS_KEY");
  const dump = path.join(directory, "metadata.dump");
  if (await fileHash(dump) !== manifest.dumpSha256) throw new Error("Backup database dump is corrupt");
  const db = await connect(config);
  const store = makeObjectStore(config.objectStore);
  try {
    if ((await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' LIMIT 1")).rows.length) throw new Error("Restore requires an empty database");
    if ((await store.list()).length) throw new Error("Restore requires an empty object prefix");
    for (const object of manifest.objects) {
      validateKey(object.key);
      if (!/^[a-f0-9]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.size) || object.size < 0) throw new Error("Invalid backup object metadata");
      const bytes = await fs.readFile(path.join(directory, "objects", object.sha256));
      if (bytes.length !== object.size || sha(bytes) !== object.sha256) throw new Error("Backup object is missing or corrupt");
      await store.put(object.key, bytes);
      if (sha(await store.get(object.key)) !== object.sha256) throw new Error("Restored object verification failed");
    }
    await pgTool(pgRestore, ["--dbname", decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1)), "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", dump], config);
    await migrate(db);
    await verifySecrets(db, config);
    const restored = await objectReferences(db);
    const expected = new Set(manifest.objects.map(object => object.key));
    if (restored.size !== expected.size || [...restored].some(key => !expected.has(key))) throw new Error("Restored database references do not match the backup objects");
    return manifest;
  } finally { store.close(); await db.end(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [command, directory] = process.argv.slice(2);
  try {
    if (!directory || !["backup", "restore"].includes(command || "")) throw new Error("Usage: maintenance.ts backup|restore <directory>; stop the control plane and runner first");
    const config = loadConfig();
    const result = command === "backup" ? await backup(config, path.resolve(directory)) : await restore(config, path.resolve(directory));
    console.log(`${command} verified: ${result.objects.length} referenced objects`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
