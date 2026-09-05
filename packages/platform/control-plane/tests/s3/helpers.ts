import { randomBytes } from "node:crypto";
import { S3Client, CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { withApp } from "../integration/helpers.ts";
import { S3Store } from "../../src/store/s3-store.ts";

export async function withS3App(fn: HostedDynamic): Promise<void> {
  const url = process.env.PLAYTEST_TEST_S3_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("PLAYTEST_TEST_S3_URL must name a disposable loopback S3 service");
  const cfg = { kind: "s3" as const, url, bucket: `pt-app-${randomBytes(8).toString("hex")}`, prefix: "source/", region: "us-east-1", accessKeyId: "playtest-disposable", secretAccessKey: "playtest-disposable-password", forcePathStyle: true, timeoutMs: 5000, maxAttempts: 2 };
  const client = new S3Client({ endpoint: url, region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
  try {
    await withApp(fn, { OBJECT_STORE_URL: url, OBJECT_STORE_ALLOW_HTTP: "1", OBJECT_STORE_FORCE_PATH_STYLE: "1", OBJECT_STORE_BUCKET: cfg.bucket, OBJECT_STORE_PREFIX: "source", OBJECT_STORE_REGION: cfg.region, OBJECT_STORE_ACCESS_KEY: cfg.accessKeyId, OBJECT_STORE_SECRET_KEY: cfg.secretAccessKey });
  } finally {
    const store = new S3Store({ ...cfg, prefix: "" });
    try { for (const key of await store.list()) await store.delete(key); } finally { store.close(); }
    await client.send(new DeleteBucketCommand({ Bucket: cfg.bucket })); client.destroy();
  }
}
