import { FsStore } from "./fs-store.ts";
import { S3Store } from "./s3-store.ts";
import type { ControlPlaneConfig } from "../config.ts";
import type { ObjectStore } from "../types.ts";

/** Build the configured store from config.objectStore. */
export function makeObjectStore(cfg: ControlPlaneConfig["objectStore"]): ObjectStore {
  if (cfg.kind === "s3") return new S3Store(cfg);
  return new FsStore(cfg.root);
}

// Content-addressed blob keys: blobs/<sha256> (deduped and immutable). Kept
// here so writer and reader agree on layout. Suite file content lives under it,
// keyed by its own bytes: uploading the same bytes twice is one object, and
// retention's blob GC reclaims one only when no snapshot names it.
export const blobKey = (sha256: string) => `blobs/${sha256}`;
