// Reserved S3-compatible object-store adapter. Filesystem storage is the supported
// implementation; selecting this adapter fails honestly until a wire implementation
// exists.
import { AppError } from "../errors.ts";
import type { ObjectStoreConfig } from "../config.ts";

const NOT_WIRED = "the S3 object store is not wired up; " +
  "set OBJECT_STORE_URL to a local path for now";

export class S3Store {
  declare readonly cfg: Extract<ObjectStoreConfig, { kind: "s3" }>;

  constructor(cfg: Extract<ObjectStoreConfig, { kind: "s3" }>) {
    this.cfg = cfg; // { url, bucket, region, accessKeyId, secretAccessKey }
  }
  async put() { throw new AppError("not_implemented", NOT_WIRED); }
  async get() { throw new AppError("not_implemented", NOT_WIRED); }
  async getRange() { throw new AppError("not_implemented", NOT_WIRED); }
  async has() { throw new AppError("not_implemented", NOT_WIRED); }
  async delete() { throw new AppError("not_implemented", NOT_WIRED); }
  async list() { throw new AppError("not_implemented", NOT_WIRED); }
}
