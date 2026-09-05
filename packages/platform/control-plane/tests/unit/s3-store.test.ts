import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { S3Store } from "../../src/store/s3-store.ts";
import { loadConfig } from "../../src/config.ts";

export const cfg = { kind: "s3" as const, url: "https://objects.example.test", bucket: "bucket", region: "us-east-1", accessKeyId: "test", secretAccessKey: "test", prefix: "installation/", forcePathStyle: true, timeoutMs: 1000, maxAttempts: 2 };
function storeFor(reply: (request: any) => { statusCode?: number; headers?: Record<string, string>; body?: string | Buffer }) {
  const requests: any[] = [];
  const store = new S3Store(cfg, { requestHandler: { async handle(request: any) {
    requests.push(request);
    const r = reply(request);
    return { response: { statusCode: r.statusCode ?? 200, headers: r.headers ?? {}, body: Readable.from([r.body ?? ""]) } };
  } } });
  return { store, requests };
}

test("S3 puts hash bytes independently of ETag and stay inside the namespace", async t => {
  const { store, requests } = storeFor(() => ({ headers: { etag: '"not-a-sha256"' } }));
  t.after(() => store.close());
  const result = await store.put("blobs/a", "hello");
  assert.equal(result.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(requests[0].path, "/bucket/installation/blobs/a");
  assert.equal(requests[0].headers["x-amz-acl"], undefined);
  for (const key of ["../x", "/x", "x//y", "x\\y", "x#entry", ""]) await assert.rejects(store.put(key, "x"), /invalid object key/);
  assert.equal(requests.length, 1);
});

test("S3 ranges reject servers ignoring Range or returning a different slice", async t => {
  const { store, requests } = storeFor(() => ({ headers: { "content-length": "3", "content-range": "bytes 2-4/10" }, body: "234" }));
  t.after(() => store.close());
  assert.equal((await store.getRange("k", 2, 4)).toString(), "234");
  assert.equal(requests[0].headers.range, "bytes=2-4");
  const wrong = storeFor(() => ({ body: "0123456789" })).store;
  t.after(() => wrong.close());
  await assert.rejects(wrong.getRange("k", 2, 4), /invalid byte range/);
});

test("S3 missing is distinct from denied, and transient failures retry", async t => {
  let attempts = 0;
  const { store } = storeFor(() => ++attempts === 1 ? { statusCode: 503, body: "<Error><Code>SlowDown</Code></Error>" } : { statusCode: 404, body: "<Error><Code>NoSuchKey</Code></Error>" });
  t.after(() => store.close());
  assert.equal(await store.has("absent"), false);
  assert.equal(attempts, 2);
  const denied = storeFor(() => ({ statusCode: 403, body: "<Error><Code>AccessDenied</Code></Error>" })).store;
  t.after(() => denied.close());
  await assert.rejects(denied.has("k"), /AccessDenied/);
  await assert.rejects(denied.list(), /AccessDenied/);
});

test("S3 pagination preserves prefix, metadata and continuation; broken pages fail", async t => {
  const { store, requests } = storeFor(req => ({ body: `<ListBucketResult><IsTruncated>${req.query["continuation-token"] ? "false" : "true"}</IsTruncated>${req.query["continuation-token"] ? "" : "<NextContinuationToken>next</NextContinuationToken>"}<Contents><Key>installation/blobs/${req.query["continuation-token"] ? "b" : "a"}</Key><Size>3</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>` }));
  t.after(() => store.close());
  assert.deepEqual(await store.list("blobs/"), ["blobs/a", "blobs/b"]);
  assert.equal(requests[1].query.prefix, "installation/blobs/");
  const broken = storeFor(() => ({ body: "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>" })).store;
  t.after(() => broken.close());
  await assert.rejects(broken.list(), /pagination did not advance/);
});

test("S3 configuration requires explicit namespace, credentials and bounded requests", () => {
  const base = { PLAYTEST_AUTH: "dev", DATABASE_URL: "postgres://localhost/test", OBJECT_STORE_URL: "https://s3.example.test" };
  assert.throws(() => loadConfig(base), /OBJECT_STORE_PREFIX/);
  assert.throws(() => loadConfig({ ...base, OBJECT_STORE_URL: "http://localhost:9000" }), /HTTPS/);
  assert.throws(() => loadConfig({ ...base, OBJECT_STORE_PREFIX: "../other" }), /PREFIX/);
  assert.throws(() => loadConfig({ ...base, OBJECT_STORE_PREFIX: "app", OBJECT_STORE_TIMEOUT_MS: "0" }), /TIMEOUT/);
});
