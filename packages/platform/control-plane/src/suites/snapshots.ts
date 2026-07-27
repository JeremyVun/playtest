// Content-addressed suite snapshots. A snapshot's
// `tree` is { path -> sha256 }; each file's bytes live once at blobs/<sha256> in
// object storage (deduped, immutable). Making a snapshot = hash every file, put any
// blob not already present, record the tree. Materializing one = read each blob.
import { createHash } from "node:crypto";
import { blobKey } from "../store/object-store.ts";
import type { ObjectStore } from "../types.ts";

export const sha256Hex = (data: Buffer | Uint8Array | string) =>
  createHash("sha256").update(Buffer.isBuffer(data) ? data : Buffer.from(data as string, "utf8")).digest("hex"); // SAFETY: Buffer.from accepts the runtime Uint8Array branch despite this overload selecting the string form.

/** { path -> sha256 } for a { path -> content } map. */
export function contentTree(files: Record<string, Buffer | Uint8Array | string>): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const [p, content] of Object.entries(files)) tree[p] = sha256Hex(content);
  return tree;
}

/**
 * Persist every file's bytes as a content-addressed blob (idempotent: an existing
 * blob is left untouched) and return the snapshot tree { path -> sha256 }.
 */
export async function putBlobs(
  store: ObjectStore,
  files: Record<string, Buffer | Uint8Array | string>
): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const [p, content] of Object.entries(files)) {
    const sha = sha256Hex(content);
    tree[p] = sha;
    if (!(await store.has(blobKey(sha)))) await store.put(blobKey(sha), content);
  }
  return tree;
}

/** Read a snapshot tree back into { path -> content(string) }. */
export async function loadTreeFiles(
  store: ObjectStore,
  tree: Record<string, string>
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [p, sha] of Object.entries(tree)) {
    files[p] = (await store.get(blobKey(sha))).toString("utf8");
  }
  return files;
}
