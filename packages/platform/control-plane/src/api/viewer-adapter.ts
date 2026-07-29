// Hosted viewer adapter (docs/contracts/hosted.md#bundles-viewer-and-review): the
// product's read path. Serves the viewer packaged in @playtest/web and implements the core
// Core viewer URL contract (docs/contracts/interfaces.md#viewer-url-contract)
// against `runs` projections + `.ptrun` bundles:
//
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
// unchanged. Projection shapes reuse the core history facade.
import path from "node:path";
import { Readable } from "node:stream";
import { manifestToHistoryEntry } from "@playtest/core/artifacts";
import { platformWebAssetsDir } from "@playtest/web/assets";
import { HttpResult } from "../http.ts";
import { notFound } from "../errors.ts";
import { sendFile } from "../response.ts";
import { loadRunBundle } from "../run-storage.ts";
import { isRunOpen, readTrajectoryText, readyArtifact } from "../live/staging.ts";
import { liveAnswer } from "./live-view.ts";
import { guard, getProjectByKey } from "./util.ts";

// An open run is excluded from the history and movement projections until it
// seals: a half-recorded run is neither history nor a review item. The exclusion
// is scoped to open runs; completed-run projections are untouched.
const NOT_OPEN = `NOT (r.live_opened_at IS NOT NULL AND r.status IN ('queued','running','uploading'))`;

const VIEWER_DIR = path.join(platformWebAssetsDir, "viewer");

// ---------- static hosting ----------

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
  return sendFile(ctx.req, ctx.res, VIEWER_DIR, "index.html");
}

/** GET /api/v1/projects/:p/view/*path — viewer static assets under the project mount. */
export async function viewStatic(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  sendFile(ctx.req, ctx.res, VIEWER_DIR, ctx.params.path);
}

// ---------- JSON projections (docs/contracts/interfaces.md#routes) ----------

/**
 * GET /projects/:p/view/runs.json — picker entries, newest first, projected from
 * the verbatim manifest JSON (projection = copy, never transform —
 * docs/contracts/artifacts.md#manifest),
 * so each entry equals what core listRuns reads out of the same manifest.json.
 *
 * An open run is projected from its live manifest snapshot and keeps the
 * existing "no verdict yet" vocabulary — `status: null` plus an additive
 * `open: true` — never the placeholder's terminal-looking `interrupted`. A
 * sealed entry carries no `open` key at all, so existing consumers are
 * untouched (docs/contracts/interfaces.md#live-runs).
 */
export async function runsJson(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    // A live manifest snapshot enters the picker only while the run is open. A
    // terminal run that never reported one keeps its staging (it is the only
    // evidence it produced) but stays out of the picker exactly as before —
    // projecting the placeholder's `interrupted` over a run the platform knows
    // ended as `infra` would be worse than absence.
    `SELECT r.run_id, r.case_id, r.status, r.manifest, r.live_manifest, r.live_opened_at FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1
        AND (r.manifest IS NOT NULL
             OR (r.live_manifest IS NOT NULL AND r.live_opened_at IS NOT NULL
                 AND r.status IN ('queued','running','uploading')))`,
    [project.id],
  );
  const runs = rows.map((row: HostedDynamic) => {
    const { run_id, case_id } = row;
    const open = isRunOpen(row);
    const m = row.manifest ?? row.live_manifest;
    return {
      run_id: m.run_id ?? null,
      case_id,
      path: `${run_id}/${case_id}`,
      status: open ? null : m.result?.status ?? null,
      ...(open ? { open: true as const } : {}),
      mode: m.mode ?? null,
      healed: m.healed ?? false,
      started_at: m.started_at ?? null,
      duration_ms: m.duration_ms ?? null,
      story: m.case?.story ?? null,
      description: m.case?.description ?? null,
      tags: m.case?.tags ?? [],
    };
  });
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
      WHERE g.project_id = $1 AND r.manifest IS NOT NULL AND ${NOT_OPEN}
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
      WHERE g.project_id = $1 AND r.case_id = $2 AND r.manifest IS NOT NULL AND ${NOT_OPEN}`,
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

/**
 * GET /projects/:p/view/run/<run_id>/<case_id>/<entry…> — one bundle entry.
 * The path is core-shaped (the same `path` runs.json hands out); the run row is
 * found by run_id + case_id prefix, newest first when a run_id ever repeats
 * across groups. Range honored (core sendFile).
 *
 * Entry precedence is **sibling artifact → sealed bundle entry → staged live
 * entry**: today's sibling-over-bundle order (so a generated clip wins over the
 * bundled original) is preserved exactly, and staging is appended as the final
 * rung. A run is therefore viewable before its bundle exists, and a sealed run
 * serves byte-for-byte what it always did.
 *
 * `<entry>` = `live` is the live endpoint rather than a file
 * (docs/contracts/interfaces.md#live-runs); a bundle can never contain that name.
 */
export async function runEntry(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const rel = ctx.params.path;
  const runId = rel.split("/")[0];
  if (!runId) throw notFound("not found");
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.run_id, r.case_id, r.status, r.live_opened_at, r.live_manifest, r.live_activity_at
       FROM runs r
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1 AND r.run_id = $2
      ORDER BY r.created_at DESC`,
    [project.id, runId],
  );
  const run = rows.find((r: HostedDynamic) => rel.startsWith(`${r.run_id}/${r.case_id}/`));
  if (!run) throw notFound(`no run "${runId}" here`);
  const entry = rel.slice(`${run.run_id}/${run.case_id}/`.length);
  if (!entry) throw notFound("not found");
  if (entry === "live") return await liveAnswer(ctx, run.id);

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

  // The base arg only anchors sendFile's traversal check; bundle entry names are
  // already validated by the provider, so any absolute virtual root works.
  const bundle = await loadRunBundle(ctx, run.id);
  if (bundle?.provider.stat(entry)) {
    return sendFile(ctx.req, ctx.res, "/playtest-run", entry, bundle.provider);
  }
  const staged = await stagedEntry(ctx, run, entry);
  if (staged) return sendFile(ctx.req, ctx.res, "/playtest-run", entry, staged);
  if (!bundle) throw notFound(`run "${run.run_id}" has no bundle yet`);
  // A sealed bundle that simply lacks this entry degrades exactly as before.
  sendFile(ctx.req, ctx.res, "/playtest-run", entry, bundle.provider);
}

/**
 * The staging rung. Two entries are virtual because their source is a row, not
 * an object — `manifest.json` from the run row (so the viewer's first fetch
 * works the moment the run opens) and `trajectory.jsonl` as the ordered
 * concatenation of the ledger's line batches. Everything else is a staged step
 * artifact, and only a `ready` row is ever served: a `pending` reservation is a
 * byte range that may not exist yet.
 */
async function stagedEntry(ctx: HostedDynamic, run: HostedDynamic, entry: HostedDynamic) {
  const mtime = run.live_activity_at || run.live_opened_at || null;
  if (entry === "manifest.json") {
    if (!run.live_manifest) return null;
    return singleEntry(entry, Buffer.from(JSON.stringify(run.live_manifest)), mtime);
  }
  if (entry === "trajectory.jsonl") {
    const text = await readTrajectoryText(ctx.db, run.id);
    if (!text) return null;
    return singleEntry(entry, Buffer.from(text, "utf8"), mtime);
  }
  const row = await readyArtifact(ctx.db, run.id, entry);
  if (!row) return null;
  return singleEntry(entry, await ctx.store.get(row.key), row.updated_at);
}

/** A one-entry provider so sibling store objects ride the same Range-capable sendFile. */
function singleEntry(name: HostedDynamic, buf: HostedDynamic, createdAt: HostedDynamic) {
  const mtime = createdAt ? new Date(createdAt) : new Date(0);
  return {
    stat: (rel: HostedDynamic) => (rel === name ? { size: buf.length, mtime, isFile: true } : null),
    createReadStream: (_rel: HostedDynamic, opts: HostedDynamic = {}) => {
      const start = Math.max(0, opts.start ?? 0);
      const end = Math.min(opts.end ?? buf.length - 1, buf.length - 1);
      return Readable.from(start > end ? Buffer.alloc(0) : buf.subarray(start, end + 1));
    },
  } as HostedDynamic;
}
