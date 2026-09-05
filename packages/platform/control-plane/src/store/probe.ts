import { randomBytes } from "node:crypto";
import { AppError } from "../errors.ts";
import type { ObjectStore } from "../types.ts";

export async function probeStore(store: ObjectStore): Promise<void> {
  const key = `_probes/${randomBytes(16).toString("hex")}`;
  const bytes = randomBytes(32);
  try {
    await store.put(key, bytes);
    if (!(await store.get(key)).equals(bytes) || !(await store.getRange(key, 3, 7)).equals(bytes.subarray(3, 8)) || !(await store.list(key)).includes(key)) {
      throw new AppError("storage_error", "object storage permission probe failed");
    }
  } finally { await store.delete(key); }
  if (await store.has(key)) throw new AppError("storage_error", "object storage deletion probe failed");
}

const SENTINEL_KEY = "_health/sentinel";
const SENTINEL = Buffer.from("playtest-storage-health-v1");
export async function initializeSentinel(store: ObjectStore): Promise<void> {
  await store.put(SENTINEL_KEY, SENTINEL);
}
export async function checkStore(store: ObjectStore): Promise<void> {
  if (!(await store.get(SENTINEL_KEY)).equals(SENTINEL)) throw new AppError("storage_error", "object storage readiness sentinel is invalid");
}
