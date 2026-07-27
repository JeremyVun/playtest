// The object-store seam. SQLite holds structured state; object storage holds
// every document artifact — suite file blobs (content-addressed), snapshots,
// exports, and run bundles. The
// interface is deliberately the small subset a hosted S3 adapter and the fs
// adapter can both satisfy exactly; the fs adapter keeps tests and local
// development self-contained.
//
// interface ObjectStore {
//   put(key, buf|string) -> Promise<{ key, size, sha256 }>
//   get(key) -> Promise<Buffer>            // throws AppError('not_found') if absent
//   getRange(key, start, end) -> Promise<Buffer>   // inclusive byte range
//   has(key) -> Promise<boolean>
//   delete(key) -> Promise<void>           // idempotent
//   list(prefix) -> Promise<string[]>      // keys under a prefix
// }
import { FsStore } from "./fs-store.ts";
import { S3Store } from "./s3-store.ts";
import type { ControlPlaneConfig } from "../config.ts";
import type { ObjectStore } from "../types.ts";

/** Build the configured store from config.objectStore. */
export function makeObjectStore(cfg: ControlPlaneConfig["objectStore"]): ObjectStore {
  if (cfg.kind === "s3") return new S3Store(cfg) as unknown as ObjectStore; // TODO(ts): The reserved S3 adapter implements the seam by throwing not_implemented for every method.
  return new FsStore(cfg.root);
}

// Content-addressed blob keys for suite files: blobs/<sha256> (deduped and
// immutable). Kept here so writer and reader agree on layout.
export const blobKey = (sha256: string) => `blobs/${sha256}`;
