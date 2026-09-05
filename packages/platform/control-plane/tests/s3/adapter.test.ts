import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { S3Client, CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { S3Store } from "../../src/store/s3-store.ts";
import { probeStore } from "../../src/store/probe.ts";

function config() {
  const endpoint = process.env.PLAYTEST_TEST_S3_URL;
  if (!endpoint || new URL(endpoint).hostname !== "127.0.0.1") throw new Error("PLAYTEST_TEST_S3_URL must name a disposable loopback S3 test service");
  return { kind: "s3" as const, url: endpoint, bucket: `pt-test-${randomBytes(8).toString("hex")}`, prefix: "tenant/", region: "us-east-1", accessKeyId: "playtest-disposable", secretAccessKey: "playtest-disposable-password", forcePathStyle: true, timeoutMs: 5000, maxAttempts: 2 };
}

test("real S3: binary, ranges, duplicates, isolation, >1000 objects, denied and missing", async t => {
  const cfg = config();
  const client = new S3Client({ endpoint: cfg.url, region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  const store = new S3Store(cfg);
  const other = new S3Store({ ...cfg, prefix: "other/" });
  await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
  t.after(async () => {
    for (const s of [store, other]) { for (const key of await s.list()) await s.delete(key); s.close(); }
    await client.send(new DeleteBucketCommand({ Bucket: cfg.bucket })); client.destroy();
  });
  await probeStore(store);
  const bytes = randomBytes(4096);
  assert.deepEqual(await store.put("binary", bytes), await store.put("binary", bytes));
  assert.deepEqual(await store.get("binary"), bytes);
  assert.deepEqual(await store.getRange("binary", 21, 42), bytes.subarray(21, 43));
  assert.deepEqual(await store.getRange("binary", 4090, 5000), bytes.subarray(4090));
  await assert.rejects(store.getRange("binary", 5000, 5100));
  assert.equal(await store.has("missing"), false);
  await assert.rejects(store.get("missing"), { code: "not_found" });
  await other.put("outside", "preserve");
  for (let batch = 0; batch < 1010; batch += 20) {
    await Promise.all(Array.from({ length: Math.min(20, 1010 - batch) }, (_, n) => store.put(`many/${String(batch + n).padStart(4, "0")}`, "x")));
  }
  const pages = [];
  for await (const page of store.listPages("many/")) pages.push(page);
  assert.deepEqual(pages.map(p => p.length), [1000, 10]);
  assert.equal(pages[0]![0]!.size, 1);
  assert.ok(pages[0]![0]!.lastModified instanceof Date);
  assert.equal((await store.list("many/00")).length, 100);
  assert.equal((await store.list()).includes("outside"), false);
  await store.delete("binary"); await store.delete("binary");
  assert.equal(await other.has("outside"), true);
  const denied = new S3Store({ ...cfg, secretAccessKey: "wrong-password" });
  t.after(() => denied.close());
  await assert.rejects(denied.has("many/0000"));
  await assert.rejects(denied.list());
});

test("real HTTP transport: retries are bounded and hung requests abort", async t => {
  let attempts = 0;
  const server = createServer((req, res) => {
    if (req.url?.includes("hung")) return;
    attempts++;
    res.writeHead(503, { "content-type": "application/xml" });
    res.end("<Error><Code>SlowDown</Code></Error>");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const addr = server.address() as { port: number };
  const store = new S3Store({ ...config(), url: `http://127.0.0.1:${addr.port}`, timeoutMs: 500, maxAttempts: 2 });
  t.after(() => store.close());
  await assert.rejects(store.get("retry"));
  assert.equal(attempts, 2);
  const start = Date.now();
  await assert.rejects(store.get("hung"));
  assert.ok(Date.now() - start < 2000);
});
