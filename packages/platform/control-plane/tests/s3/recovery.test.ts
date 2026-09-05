import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withS3App } from "./helpers.ts";
import { testDatabase } from "../postgres/helpers.ts";
import { backup, restore } from "../../maintenance.ts";
import { connect } from "../../src/db.ts";
import { encryptSecret, decryptSecret } from "../../src/crypto/secrets.ts";
import { makeObjectStore } from "../../src/store/object-store.ts";
import { ulid } from "../../src/ulid.ts";

test("Postgres/S3 recovery: writer exclusion, verified objects, secret decryption, failed sets and fresh restore", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pt-recovery-"));
  try {
    await withS3App(async ({ api, app }: HostedDynamic) => {
      const project = (await api.post("/projects", { key: "recovery", name: "Recovery" })).body;
      assert.equal((await api.post(`/projects/${project.key}/personas`, { name: "Recovery reader", description: "Preserve this persona." })).status, 201);
      await app.db.query("INSERT INTO secrets (id, project_id, name, ciphertext) VALUES ($1, $2, 'test', $3)", [ulid(), project.id, encryptSecret(app.config.kmsKey, "disposable target secret")]);
      await assert.rejects(backup(app.config, path.join(dir, "while-running")), /writer|owns/i);
      await app.close();
      const source = app.config;
      const manifest = await backup(source, path.join(dir, "complete"));
      assert.equal(manifest.objects.length, 1);
      await assert.rejects(backup(source, path.join(dir, "failed"), { pgDump: "missing-pg-dump-for-test" }));
      await assert.rejects(fs.access(path.join(dir, "failed", "COMPLETE")));
      await fs.access(path.join(dir, "complete", "COMPLETE"));
      const sourceStore = makeObjectStore(source.objectStore);
      const object = manifest.objects[0]!;
      const savedBytes = await sourceStore.get(object.key);
      await sourceStore.delete(object.key);
      await assert.rejects(backup(source, path.join(dir, "failed-copy")), /object not found/);
      await assert.rejects(fs.access(path.join(dir, "failed-copy", "COMPLETE")));
      await sourceStore.put(object.key, savedBytes);
      sourceStore.close();
      const database = await testDatabase();
      const restoredConfig = { ...source, databaseUrl: database.databaseUrl, objectStore: { ...source.objectStore, prefix: "restored/" } };
      try {
        await assert.rejects(restore({ ...restoredConfig, kmsKey: Buffer.alloc(32, 9) }, path.join(dir, "complete")), /original PLAYTEST_KMS_KEY/);
        await restore(restoredConfig, path.join(dir, "complete"));
        const db = await connect(restoredConfig);
        try {
          assert.equal((await db.query("SELECT description FROM personas")).rows[0]!.description, "Preserve this persona.");
          assert.equal(decryptSecret(restoredConfig.kmsKey, (await db.query("SELECT ciphertext FROM secrets")).rows[0]!.ciphertext), "disposable target secret");
        } finally { await db.end(); }
        await assert.rejects(restore(restoredConfig, path.join(dir, "complete")), /empty database/);
      } finally { await database.close(); }
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
