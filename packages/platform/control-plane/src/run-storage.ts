import { BundleProvider } from "@playtest/core/artifacts";

const CACHE_MAX_BYTES = Number(process.env.PLAYTEST_VIEW_CACHE_MB || 256) * 1024 * 1024;
const bundleCache = new Map<string, { provider: BundleProvider; size: number }>();
let bundleCacheBytes = 0;

async function cachedProvider(sha256: string, load: () => Promise<Buffer>) {
  const hit = bundleCache.get(sha256);
  if (hit) {
    bundleCache.delete(sha256);
    bundleCache.set(sha256, hit);
    return hit.provider;
  }

  const buffer = await load();
  const raced = bundleCache.get(sha256);
  if (raced) return raced.provider;

  const readRange = (start: number, end: number) => buffer.subarray(start, end + 1);
  readRange.size = buffer.length;
  const provider = new BundleProvider({ readRange });
  bundleCache.set(sha256, { provider, size: buffer.length });
  bundleCacheBytes += buffer.length;
  for (const [key, entry] of bundleCache) {
    if (bundleCacheBytes <= CACHE_MAX_BYTES || bundleCache.size === 1) break;
    bundleCache.delete(key);
    bundleCacheBytes -= entry.size;
  }
  return provider;
}

/**
 * Resolve the newest verified run bundle through the control plane's object
 * store. Grading, findings, review, media, and viewer delivery share this path.
 */
export async function loadRunBundle(ctx: HostedDynamic, runDbId: string) {
  const { rows } = await ctx.db.query(
    `SELECT * FROM artifacts WHERE run_id = $1 AND kind = 'bundle' ORDER BY created_at DESC LIMIT 1`,
    [runDbId],
  );
  if (!rows[0]) return null;
  const artifact = rows[0];
  const provider = await cachedProvider(artifact.sha256, () => ctx.store.get(artifact.key));
  return { provider, artifact };
}
