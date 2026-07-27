// Hosted viewer adapter (docs/contracts/hosted.md#bundles-viewer-and-review): the
// product's read path. Serves the UNMODIFIED src/run-viewer/web app and implements the core
// Core viewer URL contract (docs/contracts/interfaces.md#viewer-url-contract)
// against `runs` projections + `.ptrun` bundles:
//
//   /api/v1/view/shared/*                    src/core/shared browser modules (movement.js)
//   /api/v1/projects/:p/view/                the viewer, mounted project-scoped (the
//                                            viewer resolves its data URLs against its
//                                            own base path — core viewer contract)
//   /api/v1/projects/:p/view/runs.json       picker entries      ─┐ pure projections of
//   /api/v1/projects/:p/view/changed.json    review list          ├ the runs rows' verbatim
//   /api/v1/projects/:p/view/history.json    sparkline history   ─┘ manifest JSON — §13
//                                            shapes byte-for-byte, no bundle walks
//   /api/v1/projects/:p/view/run/<run_id>/<case_id>/<entry>
//                                            bundle entry bytes over BundleProvider with
//                                            Range support (video seeking) + sibling-
//                                            artifact merge (generated clips)
//
// Run paths are core-shaped (<run_id>/<case_id>) so runs.json/changed.json/history.json
// match a CLI runs root of the same runs byte-for-byte and viewer deep links work
// unchanged. Reads reuse core view-server helpers (sendFile, manifestToHistoryEntry)
// so the core route shapes cannot drift.
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { sendFile, manifestToHistoryEntry } from "../../../../run-viewer/node.ts";
import { BundleProvider } from "../../../../core/public/artifacts.ts";
import { HttpResult } from "../http.ts";
import { notFound } from "../errors.ts";
import { guard, getProjectByKey } from "./util.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.resolve(here, "../../../../run-viewer/web");
const SHARED_DIR = path.resolve(here, "../../../../core/shared");

// ---------- static hosting ----------

/** GET /api/v1/view/shared/*path — the browser-safe src/core/shared modules (§2). */
export function sharedStatic(ctx: HostedDynamic) {
  sendFile(ctx.req, ctx.res, SHARED_DIR, ctx.params.path);
}

/**
 * GET /api/v1/projects/:p/view — the project-scoped viewer mount. The viewer
 * resolves data URLs against its own directory, so it must be loaded WITH the
 * trailing slash; the slashless form redirects (query preserved) rather than
 * quietly serving a page whose fetches would miss.
 */
export async function viewIndex(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const u = new URL(ctx.req.url, "http://localhost");
  if (!u.pathname.endsWith("/")) {
    return new HttpResult({ status: 302, redirect: `${u.pathname}/${u.search}` });
  }
  serveAppFile(ctx, "index.html");
}

/** GET /api/v1/projects/:p/view/*path — viewer static assets under the project mount. */
export async function viewStatic(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  serveAppFile(ctx, ctx.params.path);
}

// The viewer imports ./shared/movement.js relative to its own URL; under any
// mount that resolves to <mount>/shared/*, which lives in src/core/shared, not
// src/run-viewer/web — same split core view-server.js serves.
function serveAppFile(ctx: HostedDynamic, rel: HostedDynamic) {
  if (rel.startsWith("shared/")) {
    return sendFile(ctx.req, ctx.res, SHARED_DIR, rel.slice("shared/".length));
  }
  sendFile(ctx.req, ctx.res, VIEWER_DIR, rel);
}

// ---------- JSON projections (docs/contracts/interfaces.md#routes) ----------

/**
 * GET /projects/:p/view/runs.json — picker entries, newest first, projected from
 * the verbatim manifest JSON (projection = copy, never transform —
 * docs/contracts/artifacts.md#manifest),
 * so each entry equals what core listRuns reads out of the same manifest.json.
 */
export async function runsJson(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT r.run_id, r.case_id, r.manifest FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1 AND r.manifest IS NOT NULL`,
    [project.id],
  );
  const runs = rows.map(({ run_id, case_id, manifest: m }: HostedDynamic) => ({
    run_id: m.run_id ?? null,
    case_id,
    path: `${run_id}/${case_id}`,
    status: m.result?.status ?? null,
    mode: m.mode ?? null,
    healed: m.healed ?? false,
    started_at: m.started_at ?? null,
    duration_ms: m.duration_ms ?? null,
    story: m.case?.story ?? null,
    description: m.case?.description ?? null,
    tags: m.case?.tags ?? [],
  }));
  return runs.sort((a: HostedDynamic, b: HostedDynamic) => String(b.started_at).localeCompare(String(a.started_at)));
}

/**
 * GET /projects/:p/view/changed.json — healed passes, newest first. `pending`
 * is the candidates row's status (the DB is the hosted analog of the CLI's
 * <case>.healed.* files, written from the same run). `run_dir_rel` has no
 * meaning off-disk; it carries the run path so the shape stays
 * core-interface-identical
 * (equal to the CLI's value when cwd is the runs root).
 */
export async function changedJson(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT r.run_id, r.case_id, r.score, r.manifest,
            EXISTS (SELECT 1 FROM candidates c WHERE c.run_id = r.id AND c.status = 'pending') AS pending
       FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1 AND r.manifest IS NOT NULL
        AND json_extract(r.manifest, '$.healed') IN (1, 'true')
        AND json_extract(r.manifest, '$.result.status') = 'pass'`,
    [project.id],
  );
  // `pending` is a computed column, so it arrives as SQLite's 0/1 rather than a
  // decoded boolean; the contract shape is a JSON boolean.
  const out = rows.map(({ run_id, case_id, score, manifest: m, pending }: HostedDynamic) => ({
    case_id: m.case?.id ?? null,
    run_id: m.run_id ?? null,
    started_at: m.started_at ?? null,
    score: score ?? null,
    path: `${run_id}/${case_id}`,
    run_dir_rel: `${run_id}/${case_id}`,
    pending: !!pending,
  }));
  return out.sort((a: HostedDynamic, b: HostedDynamic) => String(b.started_at).localeCompare(String(a.started_at)));
}

/**
 * GET /projects/:p/view/history.json?case=<id> — sibling runs of one case,
 * oldest first, through core manifestToHistoryEntry so the movement/sparkline
 * shape cannot drift from the CLI's. Hosted manifests always carry totals, so
 * the legacy trajectory re-parse fallback for lcp_ms never applies here.
 */
export async function historyJson(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const caseId = ctx.query.get("case");
  if (!caseId) return [];
  const { rows } = await ctx.db.query(
    `SELECT r.run_id, r.case_id, r.score, r.manifest FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1 AND r.case_id = $2 AND r.manifest IS NOT NULL`,
    [project.id, caseId],
  );
  const entries = rows.map(({ run_id, case_id, score, manifest: m }: HostedDynamic) =>
    manifestToHistoryEntry(m, score, {
      lcp_ms: m.totals?.lcp_ms ?? null,
      cost_usd: m.totals?.cost_usd ?? 0,
      path: `${run_id}/${case_id}`,
    }),
  );
  return entries.sort((a: HostedDynamic, b: HostedDynamic) => String(a.started_at).localeCompare(String(b.started_at)));
}

// ---------- bundle entry serving ----------

// Post-hoc sibling artifacts (generated clips): these entry names consult the
// artifacts rows first, then fall back to the sealed bundle, so a generated clip
// serves over the bundled original without mutating the sealed bundle.
const SIBLING_KINDS: HostedDynamic = { "clip.mp4": "clip", "clip.webm": "clip", "clip.vtt": "clip_vtt" };

// In-process bundle cache: BundleProvider is synchronous (readRange → Buffer),
// so the whole bundle is buffered once and every entry/Range request after that
// is a memory slice — the Phase 0 residue, sized properly in Phase 7. Keyed on
// the artifact sha256 (immutability makes that a perfect key), byte-capped LRU.
const CACHE_MAX_BYTES = Number(process.env.PLAYTEST_VIEW_CACHE_MB || 256) * 1024 * 1024;
const bundleCache = new Map(); // sha256 -> { provider, size }
let bundleCacheBytes = 0;

async function cachedProvider(sha256: HostedDynamic, load: HostedDynamic) {
  const hit = bundleCache.get(sha256);
  if (hit) {
    bundleCache.delete(sha256); // refresh LRU position
    bundleCache.set(sha256, hit);
    return hit.provider;
  }
  const buf = await load();
  // A concurrent request may have loaded the same bundle while we awaited —
  // keep the existing entry so the byte accounting never double-counts.
  const raced = bundleCache.get(sha256);
  if (raced) return raced.provider;
  const provider = new BundleProvider({
    readRange: (start: HostedDynamic, end: HostedDynamic) => buf.subarray(start, end + 1),
    size: buf.length,
  } as HostedDynamic);
  bundleCache.set(sha256, { provider, size: buf.length });
  bundleCacheBytes += buf.length;
  for (const [key, entry] of bundleCache) {
    if (bundleCacheBytes <= CACHE_MAX_BYTES || bundleCache.size === 1) break;
    bundleCache.delete(key);
    bundleCacheBytes -= entry.size;
  }
  return provider;
}

/**
 * The run's sealed bundle as a (cached) BundleProvider — the one hosted read
 * path into run artifacts, shared with the review queue's diff summaries.
 * Null when the run has no verified bundle yet.
 */
export async function loadRunBundle(ctx: HostedDynamic, runDbId: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT * FROM artifacts WHERE run_id = $1 AND kind = 'bundle' ORDER BY created_at DESC LIMIT 1`,
    [runDbId],
  );
  if (!rows[0]) return null;
  const provider = await cachedProvider(rows[0].sha256, () => ctx.store.get(rows[0].key));
  return { provider, artifact: rows[0] };
}

/**
 * GET /projects/:p/view/run/<run_id>/<case_id>/<entry…> — one bundle entry.
 * The path is core-shaped (the same `path` runs.json hands out); the run row is
 * found by run_id + case_id prefix, newest first when a run_id ever repeats
 * across groups. Range honored (core sendFile); sibling clip artifacts
 * take precedence over bundle entries of the same name.
 */
export async function runEntry(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const rel = ctx.params.path;
  const runId = rel.split("/")[0];
  if (!runId) throw notFound("not found");
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.run_id, r.case_id FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1 AND r.run_id = $2
      ORDER BY r.created_at DESC`,
    [project.id, runId],
  );
  const run = rows.find((r: HostedDynamic) => rel.startsWith(`${r.run_id}/${r.case_id}/`));
  if (!run) throw notFound(`no run "${runId}" here`);
  const entry = rel.slice(`${run.run_id}/${run.case_id}/`.length);
  if (!entry) throw notFound("not found");

  const arts = await ctx.db.query(
    `SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at DESC`,
    [run.id],
  );

  // Sibling artifacts first (generated clips and their VTT).
  const siblingKind = SIBLING_KINDS[entry];
  const sibling = siblingKind && arts.rows.find((a: HostedDynamic) => a.kind === siblingKind);
  if (sibling) {
    const buf = await ctx.store.get(sibling.key);
    return sendFile(ctx.req, ctx.res, "/playtest-run", entry, singleEntry(entry, buf, sibling.created_at));
  }

  const bundle = await loadRunBundle(ctx, run.id);
  if (!bundle) throw notFound(`run "${run.run_id}" has no bundle yet`);
  // The base arg only anchors sendFile's traversal check; bundle entry names are
  // already validated by the provider, so any absolute virtual root works.
  sendFile(ctx.req, ctx.res, "/playtest-run", entry, bundle.provider);
}

/** A one-entry provider so sibling store objects ride the same Range-capable sendFile. */
function singleEntry(name: HostedDynamic, buf: HostedDynamic, createdAt: HostedDynamic) {
  const mtime = createdAt ? new Date(createdAt) : new Date(0);
  return {
    stat: (rel: HostedDynamic) => (rel === name ? { size: buf.length, mtime, isFile: true } : null),
    createReadStream: (rel: HostedDynamic, opts: HostedDynamic = {}) => {
      const start = Math.max(0, opts.start ?? 0);
      const end = Math.min(opts.end ?? buf.length - 1, buf.length - 1);
      return Readable.from(start > end ? Buffer.alloc(0) : buf.subarray(start, end + 1));
    },
  } as HostedDynamic;
}
