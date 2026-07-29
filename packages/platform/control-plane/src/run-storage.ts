import { BundleProvider } from "@playtest/core/artifacts";

/**
 * App-owned LRU over decoded run bundles. One instance per app (`createApp`),
 * budgeted by the validated config (PLAYTEST_VIEW_CACHE_MB) and cleared on
 * `app.close()` — never a module-level cache, so two apps in one process (tests,
 * embedders) each keep their own budget and release it with the app.
 */
export class RunBundleCache {
  #maxBytes: number;
  #entries = new Map<string, { provider: BundleProvider; size: number }>();
  #bytes = 0;

  constructor({ maxBytes }: { maxBytes: number }) {
    this.#maxBytes = maxBytes;
  }

  async provider(sha256: string, load: () => Promise<Buffer>): Promise<BundleProvider> {
    const hit = this.#entries.get(sha256);
    if (hit) {
      this.#entries.delete(sha256);
      this.#entries.set(sha256, hit);
      return hit.provider;
    }

    const buffer = await load();
    const raced = this.#entries.get(sha256);
    if (raced) return raced.provider;

    const readRange = Object.assign((start: number, end: number) => buffer.subarray(start, end + 1), {
      size: buffer.length,
    });
    const provider = new BundleProvider({ readRange });
    this.#entries.set(sha256, { provider, size: buffer.length });
    this.#bytes += buffer.length;
    for (const [key, entry] of this.#entries) {
      if (this.#bytes <= this.#maxBytes || this.#entries.size === 1) break;
      this.#entries.delete(key);
      this.#bytes -= entry.size;
    }
    return provider;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
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
  const provider = await ctx.runBundleCache.provider(artifact.sha256, () => ctx.store.get(artifact.key));
  return { provider, artifact };
}
