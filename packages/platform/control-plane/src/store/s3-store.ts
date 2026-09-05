import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { AppError } from "../errors.ts";
import type { ObjectStoreConfig } from "../config.ts";
import type { ObjectMetadata, ObjectStore } from "../types.ts";
import { validateKey, validateRange } from "./keys.ts";

type Config = Extract<ObjectStoreConfig, { kind: "s3" }>;
function missing(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound";
}

export class S3Store implements ObjectStore {
  readonly cfg: Config;
  readonly client: S3Client;

  constructor(cfg: Config, options: Pick<S3ClientConfig, "requestHandler"> = {}) {
    this.cfg = cfg;
    this.client = new S3Client({
      endpoint: cfg.url, region: cfg.region, forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      maxAttempts: cfg.maxAttempts, retryMode: "standard",
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { connectionTimeout: Math.min(5_000, cfg.timeoutMs), requestTimeout: cfg.timeoutMs },
      ...options,
    });
  }

  #key(key: string): string { validateKey(key); return this.cfg.prefix + key; }
  #signal(): AbortSignal { return AbortSignal.timeout(this.cfg.timeoutMs); }

  async put(key: string, data: Buffer | Uint8Array | string) {
    const body = typeof data === "string" ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const sha256 = createHash("sha256").update(body).digest("hex");
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.#key(key), Body: body, ContentLength: body.length, Metadata: { sha256 } }), { abortSignal: this.#signal() });
    return { key, size: body.length, sha256 };
  }

  async #get(key: string, range?: { start: number; end: number }): Promise<Buffer> {
    const signal = this.#signal();
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.#key(key), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }), { abortSignal: signal });
      if (!result.Body) throw new AppError("storage_error", "object response has no body");
      const body = result.Body;
      const abort = () => { if ("destroy" in body && typeof body.destroy === "function") body.destroy(new Error("object read timed out")); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) { abort(); throw new AppError("storage_error", "object read timed out"); }
        const raw = await body.transformToByteArray();
        const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        if (result.ContentLength !== undefined && bytes.length !== result.ContentLength) throw new AppError("storage_error", "object response length mismatch");
        if (range) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.ContentRange || "");
          if (!match || Number(match[1]) !== range.start || Number(match[2]) !== Math.min(range.end, Number(match[3]) - 1) || bytes.length !== Number(match[2]) - range.start + 1) throw new AppError("storage_error", "object server returned an invalid byte range");
        } else if (result.Metadata?.sha256 && createHash("sha256").update(bytes).digest("hex") !== result.Metadata.sha256) {
          throw new AppError("storage_error", "object checksum mismatch");
        }
        return bytes;
      } finally { signal.removeEventListener("abort", abort); }
    } catch (error) {
      if (missing(error)) throw new AppError("not_found", `object not found: ${key}`);
      throw error;
    }
  }

  get(key: string): Promise<Buffer> { return this.#get(key); }
  getRange(key: string, start: number, end: number): Promise<Buffer> { validateRange(start, end); return this.#get(key, { start, end }); }
  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.#key(key) }), { abortSignal: this.#signal() });
      return true;
    } catch (error) { if (missing(error)) return false; throw error; }
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.#key(key) }), { abortSignal: this.#signal() });
  }
  async *listPages(prefix = ""): AsyncGenerator<ObjectMetadata[]> {
    validateKey(prefix, true);
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: this.cfg.prefix + prefix, ContinuationToken: token, MaxKeys: 1000 }), { abortSignal: this.#signal() });
      const page = (result.Contents || []).map(item => {
        if (!item.Key?.startsWith(this.cfg.prefix + prefix) || !Number.isSafeInteger(item.Size) || item.Size! < 0 || !item.LastModified || !Number.isFinite(item.LastModified.getTime())) throw new AppError("storage_error", "object listing contains invalid metadata");
        const key = item.Key.slice(this.cfg.prefix.length);
        validateKey(key);
        return { key, size: item.Size!, lastModified: item.LastModified };
      });
      yield page;
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
      if (result.IsTruncated && (!token || seen.has(token))) throw new AppError("storage_error", "object listing pagination did not advance");
      if (token) seen.add(token);
    } while (token);
  }
  async list(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    for await (const page of this.listPages(prefix)) for (const item of page) keys.push(item.key);
    return keys.sort();
  }
  close(): void { this.client.destroy(); }
}
