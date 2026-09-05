import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
const client = new S3Client({ endpoint: "http://objects:9000", region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "playtest-disposable", secretAccessKey: "playtest-disposable-password" }, maxAttempts: 5 });
try {
  await client.send(new HeadBucketCommand({ Bucket: "playtest-local" }));
} catch (e: any) {
  if (e.$metadata?.httpStatusCode !== 404) throw e;
  await client.send(new CreateBucketCommand({ Bucket: "playtest-local" }));
} finally { client.destroy(); }
