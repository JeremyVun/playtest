// The bridge to harness core: the harness has no knowledge of the database. A
// suite's live files are materialized to a temp dir
// in the exact CLI layout, then the SAME core functions the CLI uses run over it —
// discoverCases (validate + resolve), lintCase, readBaseline. There is ONE resolver;
// the platform never re-implements config merging or validation. Core error messages
// (DummyConfigError) are surfaced verbatim, with the temp path rewritten back to the
// suite-relative path the user sees.
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCases, DummyConfigError, lintCase } from "../../../../core/public/suite.ts";
import { readBaseline } from "../../../../core/public/artifacts.ts";
import { normalizePath } from "./paths.ts";

/**
 * Write `{ path: content }` to a fresh temp dir (exact CLI suite layout).
 * @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>}
 */
export async function materializeTree(files: HostedDynamic) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-suite-"));
  for (const [rel, content] of Object.entries(files) as HostedDynamic) {
    const safe = normalizePath(rel);
    const abs = path.join(dir, safe);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  }
  return { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

/** Rewrite absolute temp paths in a core error message back to suite-relative. */
function stripTempPaths(msg: HostedDynamic, dir: HostedDynamic) {
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* dir already cleaned up */
  }
  const relDir = path.relative(process.cwd(), dir);
  const realRelDir = path.relative(process.cwd(), real);
  let out = msg;
  for (const base of [dir, real, relDir, realRelDir]) {
    if (!base) continue;
    out = out.split(`${base}/`).join("").split(base).join("");
  }
  return out;
}

/** The §2 resolved-case projection (mirrors `playtest list --json` + description/driver). */
function project(c: HostedDynamic, dir: HostedDynamic) {
  return {
    id: c.id,
    // Suite-root-relative path of the case file, so the editor knows which file to
    // open (the id drops a `stories/` grouping segment, so id ≠ path in general).
    path: dir ? path.relative(dir, c.file) : undefined,
    story_id: c.storyId,
    story: c.story ?? null,
    description: c.description ?? null,
    mode: c.mode,
    tags: c.tags ?? [],
    persona: c.persona ?? null,
    driver: c.env?.driver ?? "web",
    limits: c.limits ? { max_steps: c.limits.max_steps, timeout_ms: c.limits.timeout_ms } : null,
    // next_run mirrors the CLI exactly (cli.ts list): discovery decides first; a
    // baseline in the materialized tree ⇒ "check", else "record". Phase 1 trees
    // carry no baselines yet (runs are Phase 2), so journeys read "record".
    next_run: c.mode === "discovery" ? "explore" : readBaseline(c.file) ? "check" : "record",
  };
}

/**
 * One FULL resolved case — the whole core object, not the §2 projection, so a
 * consumer that needs `success` / `perf` / `env` (the Playwright export) sees
 * exactly what the CLI sees. `file` is left as the temp path, which is already
 * gone by the time this returns: callers pass their own display path.
 * @returns {Promise<object|null>} null when no case matches `storyId`
 */
export async function resolveCaseByStory(files: HostedDynamic, storyId: HostedDynamic) {
  const { dir, cleanup } = await materializeTree(files);
  try {
    const cases = await discoverCases([dir]);
    const hit = cases.find((c) => (c.storyId || c.id) === storyId) ?? null;
    return hit ? { ...hit, path: path.relative(dir, hit.file) } : null;
  } finally {
    await cleanup();
  }
}

/**
 * Resolve every case in the tree to the §2 projection (the /cases endpoint).
 * @returns {Promise<Array<object>>}
 */
export async function resolveCases(files: HostedDynamic) {
  const { dir, cleanup } = await materializeTree(files);
  try {
    const cases = await discoverCases([dir]);
    return cases.map((c) => project(c, dir));
  } finally {
    await cleanup();
  }
}

// Snapshot trees are immutable, so a snapshot id is a perfect cache key for the
// resolved projection — launch, preview and retries of the same snapshot skip the
// temp-dir materialization + core discovery entirely. Entries are shared by
// reference: callers must treat `cases` as read-only (dispatch paths only filter
// and re-project). Small LRU; a control plane touches few live snapshots.
const SNAPSHOT_CACHE_MAX = 64;
const snapshotCache = new Map(); // snapshot id -> { cases, defaults }

/**
 * Resolve a snapshot's cases through the cache. `loadFiles` is only called on a
 * miss. Returns `{ cases, defaults }` — `defaults` is the raw playtest.yaml
 * string (or null), so target resolution needs no second tree load.
 */
export async function resolveSnapshotCases(snapshotId: HostedDynamic, loadFiles: HostedDynamic) {
  const hit = snapshotCache.get(snapshotId);
  if (hit) {
    // refresh recency (Map iteration order is insertion order)
    snapshotCache.delete(snapshotId);
    snapshotCache.set(snapshotId, hit);
    return hit;
  }
  const files = await loadFiles();
  const entry: HostedDynamic = { cases: await resolveCases(files), defaults: files["playtest.yaml"] ?? null };
  snapshotCache.set(snapshotId, entry);
  if (snapshotCache.size > SNAPSHOT_CACHE_MAX) {
    snapshotCache.delete(snapshotCache.keys().next().value);
  }
  return entry;
}

/**
 * Validate the proposed tree with core. When `only` names case paths, just those
 * cases (+ their defaults chain + assertions) are resolved — the single-file PUT
 * path, so an unrelated broken case doesn't block an edit; otherwise the whole tree
 * is resolved (commit/import: all-or-nothing).
 * @returns {Promise<{ ok: true, cases } | { ok: false, errors: Array<{path?:string,message:string}> }>}
 */
export async function validateTree(files: HostedDynamic, { only = null }: HostedDynamic = {}) {
  const { dir, cleanup } = await materializeTree(files);
  try {
    const targets = only && only.length ? only.map((p: HostedDynamic) => path.join(dir, normalizePath(p))) : [dir];
    const cases = await discoverCases(targets);
    return { ok: true, cases: cases.map((c) => project(c, dir)) };
  } catch (e) {
    if (e instanceof DummyConfigError) {
      return { ok: false, errors: parseConfigError(stripTempPaths(e.message, dir)) };
    }
    throw e;
  } finally {
    await cleanup();
  }
}

/**
 * Lint every resolved case in the tree (core lintCase); advisory warnings only.
 * If the tree doesn't resolve (invalid YAML/config), there is nothing to lint —
 * return no findings and let validateTree surface the real error. Lint never fails.
 */
export async function lintTree(files: HostedDynamic) {
  const { dir, cleanup } = await materializeTree(files);
  try {
    const cases = await discoverCases([dir]);
    return cases.flatMap((c) =>
      lintCase(c).map((w) => ({ id: c.id, level: w.level, message: w.message })),
    );
  } catch (e) {
    if (e instanceof DummyConfigError) return [];
    throw e;
  } finally {
    await cleanup();
  }
}

/**
 * Split a (temp-stripped) DummyConfigError into `{ path, message }` entries. Core
 * emits `"<file>: <detail>"`; we peel the leading file token so the UI can attach
 * the message to the offending file. Multiple keys are joined by "; " inside one
 * file's detail — kept as-is (they already read as one line per key).
 */
function parseConfigError(msg: HostedDynamic) {
  const m: HostedDynamic = /^([^:\n]+\.(?:ya?ml|js)):\s*([\s\S]+)$/.exec(msg.trim());
  if (m) return [{ path: m[1], message: m[2].trim() }];
  return [{ message: msg.trim() }];
}
