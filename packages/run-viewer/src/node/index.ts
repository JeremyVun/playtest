// Static server for `playtest view` (vanilla, GET/HEAD only).
// See docs/contracts/interfaces.md#viewer-server.
// Serves the viewer at /, run files at /run/*, /runs.json (runs-root picker),
// /changed.json (changed-journey review list) and /history.json?case=<id>
// (cross-run sparkline). Supports Range requests so the browser can seek video.webm.
import http from "node:http";
import fs from "node:fs";
import path, { join } from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StorageProvider } from "@playtest/core/artifacts";
import type { RunHistoryEntry, RunManifest } from "@playtest/core/artifacts";
import { runViewerAssetsDir } from "../assets.ts";
import {
  baselinePaths,
  BundleProvider,
  findManifests,
  isBundlePath,
  LocalFsProvider,
  manifestToHistoryEntry,
  readJsonFile,
} from "@playtest/core/artifacts";

export { findManifests, manifestToHistoryEntry, readJsonFile };

interface ViewerManifest extends RunManifest {
  score?: number | null;
  baseline_scan?: { blocked?: boolean };
  case?: {
    id?: string;
    file?: string;
    story?: string;
    description?: string;
    tags?: string[];
  };
  totals?: {
    steps?: number | null;
    lcp_ms?: number | null;
    cost_usd?: number | null;
  };
}

interface ServeRunOptions {
  port?: number;
  open?: boolean;
  query?: string;
}

interface TcpServer extends http.Server {
  address(): AddressInfo;
}

interface RunListEntry {
  run_id: string | undefined;
  case_id: string;
  path: string;
  status: string | null;
  mode: string | null;
  healed: boolean;
  started_at: string | null;
  duration_ms: number | null;
  story: string | null;
  description: string | null;
  tags: string[];
}

interface ChangedEntry {
  case_id: string | null;
  run_id: string | null;
  started_at: string | null;
  score: number | null;
  path: string;
  run_dir_rel: string;
  pending: boolean;
}

const VIEWER_DIR = runViewerAssetsDir;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mhtml": "multipart/related",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/**
 * @param {string} dir a single run dir (has manifest.json) or a runs root
 * @param {{ port?: number, open?: boolean, query?: string }} [opts] query (e.g.
 *   "?filter=changed") is appended to the URL printed and opened; the viewer reads it
 * @returns {Promise<import("node:http").Server>}
 */
export async function serveRun(dir: string, { port = 0, open = true, query = "" }: ServeRunOptions = {}) {
  const root = path.resolve(dir);
  const bundle = isBundlePath(root);
  // A missing runs root is not fatal: serve an empty picker (listRuns/findManifests
  // already degrade to [] on an unreadable dir) so a fresh project with no runs yet,
  // or a read-only mount whose runs dir hasn't been populated, gets a working viewer
  // instead of a crash. Only a path that exists but is a *file* is a real error.
  if (bundle && (!fs.existsSync(root) || !fs.statSync(root).isFile())) {
    throw new Error(`not a bundle: ${dir}`);
  }
  if (!bundle && fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  const provider = bundle ? BundleProvider.fromFile(root) : new LocalFsProvider(root);
  const singleRun = bundle || fs.existsSync(path.join(root, "manifest.json"));

  const server = http.createServer((req, res) => {
    try {
      handle(req, res, root, singleRun, provider);
    } catch (e: any) { // SAFETY: route failures preserve the existing Error-like message response
      res.writeHead(500, { "content-type": "text/plain" }).end(`error: ${e.message}`);
    }
  }) as TcpServer; // SAFETY: this server listens only on a TCP host/port, never a Unix socket
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback-only by default; PLAYTEST_VIEW_HOST=0.0.0.0 makes the server
    // reachable through Docker port mapping (the self-test compose needs this).
    server.listen(port, process.env.PLAYTEST_VIEW_HOST || "127.0.0.1", resolve);
  });

  const url = `http://localhost:${server.address().port}/${query}`;
  console.log(`Playtest viewer: ${url}`);
  if (open) openBrowser(url);
  return server;
}

function handle(req: IncomingMessage, res: ServerResponse, root: string, singleRun: boolean, provider: StorageProvider) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.writeHead(405).end();
  }
  const u = new URL(req.url as string, "http://localhost"); // SAFETY: Node server requests always carry a URL
  let pathname;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return notFound(res);
  }

  if (pathname === "/runs.json") {
    if (singleRun) return notFound(res);
    return json(res, listRuns(provider));
  }
  if (pathname === "/changed.json") {
    return json(res, changed(provider, root, singleRun));
  }
  if (pathname === "/history.json") {
    return json(res, history(provider, root, singleRun, u.searchParams.get("case")));
  }
  if (pathname.startsWith("/run/")) {
    return sendFile(req, res, root, pathname.slice("/run/".length), provider);
  }
  return sendFile(req, res, VIEWER_DIR, pathname === "/" ? "index.html" : pathname.slice(1));
}

/**
 * Traversal-safe file response with single-range support (video seeking).
 * When `provider` is set the file metadata + bytes come from it (run data);
 * when null the direct-`fs` path serves viewer/shared package static files.
 */
export function sendFile(req: IncomingMessage, res: ServerResponse, base: string, rel: string, provider: StorageProvider | null = null) {
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return notFound(res);
  let st;
  if (provider) {
    st = provider.stat(rel);
    if (!st) return notFound(res);
  } else {
    try {
      const s = fs.statSync(abs);
      st = { size: s.size, mtime: s.mtime, isFile: s.isFile() };
    } catch {
      return notFound(res);
    }
  }
  if (!st.isFile) return notFound(res);
  const open = (opts?: { start?: number; end?: number }) => (provider ? provider.createReadStream(rel, opts) : fs.createReadStream(abs, opts));
  // Pipe with an error handler: the file is opened AFTER stat, but a live run's
  // files can be truncated/renamed mid-stream, and an unhandled stream 'error'
  // fires asynchronously (escaping the caller's try/catch) and would crash the
  // whole viewer process. End just this response instead.
  const pipeStream = (opts?: { start?: number; end?: number }) => {
    const s = open(opts);
    s.on("error", () => {
      if (!res.headersSent) notFound(res);
      else res.destroy();
    });
    s.pipe(res);
  };

  // no-cache = revalidate each use; Last-Modified lets that revalidation be a
  // bodyless 304 instead of a full re-download (run dirs are mostly immutable,
  // but a live run's files still grow — mtime catches that).
  const lastModified = st.mtime.toUTCString();
  const headers = {
    "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "last-modified": lastModified,
  };
  if (!req.headers.range && req.headers["if-modified-since"] === lastModified) {
    return res.writeHead(304, headers).end();
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2]) && st.size > 0) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) {
      return res.writeHead(416, { "content-range": `bytes */${st.size}` }).end();
    }
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${st.size}`,
      "content-length": end - start + 1,
    });
    if (req.method === "HEAD") return res.end();
    return pipeStream({ start, end });
  }

  res.writeHead(200, { ...headers, "content-length": st.size });
  if (req.method === "HEAD") return res.end();
  pipeStream();
}

/**
 * Provider-routed twin of findManifests: every run dir (provider-relative,
 * "/"-joined) holding a manifest.json, at any depth (bounded). All run-data
 * listing goes through the StorageProvider seam
 * (docs/contracts/artifacts.md#storage-providers-and-run-bundles) so a hosted provider
 * swaps in without touching the routes.
 */
function findManifestsVia(provider: StorageProvider, maxDepth = 6) {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > maxDepth) return;
    const entries = provider.listDir(rel);
    if (!entries) return;
    if (entries.some((e) => e.isFile && e.name === "manifest.json")) {
      out.push(rel);
      return;
    }
    for (const e of entries) {
      if (e.isDirectory && !e.name.startsWith(".") && e.name !== "steps") {
        walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
      }
    }
  };
  walk("", 0);
  return out;
}

/** Provider-routed JSON read: null on a missing/unparseable file, never throws. */
function readJson(provider: StorageProvider, rel: string): ViewerManifest | null {
  const text = provider.readText(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text) as ViewerManifest; // SAFETY: consumers project optional fields and tolerate every missing legacy field.
  } catch {
    return null;
  }
}

/** Picker entries for every run under a runs root (also `view --json`). */
export function listRuns(provider: StorageProvider) {
  const runs: RunListEntry[] = [];
  for (const dir of findManifestsVia(provider)) {
    const m = readJson(provider, join(dir, "manifest.json"));
    if (!m) continue;
    const rel = dir.split("/");
    runs.push({
      run_id: rel[0],
      case_id: rel.slice(1).join("/"), // dir-derived so picker links resolve
      path: rel.join("/"),
      status: m.result?.status ?? null,
      mode: m.mode ?? null,
      healed: m.healed ?? false,
      started_at: m.started_at ?? null,
      duration_ms: m.duration_ms ?? null,
      // the picker's "which story is this?" context: the one-line description
      // when authored, the story prose as fallback, plus tags
      story: m.case?.story ?? null,
      description: m.case?.description ?? null,
      tags: m.case?.tags ?? [],
    });
  }
  return runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

/**
 * Changed journeys — healed passes, plus recordings the acceptance leak scan
 * held back — across the runs root, newest first (also
 * `view --json --changed`). An entry is `pending` when its candidate files
 * (<case>.healed.json|.json) still exist and the candidate's run_dir is that
 * run directory — run_dir is the authoritative match; run_id is only the
 * fallback for old metas lacking run_dir. Older healed passes stay listed as
 * history. run_dir_rel is cwd-relative for copy-paste accept/reject commands;
 * the viewer itself stays read-only.
 */
export function changed(provider: StorageProvider, root: string, singleRun: boolean) {
  // Single-run mode walks the runs root resolved from the run's run_id ancestor;
  // that root is a *different* dir than the provider's, so scope a fresh local
  // provider to it (single-run mode is inherently local today — see
  // docs/contracts/interfaces.md#viewer-server).
  const { provider: rp, root: runsRoot } = singleRun
    ? (() => {
        const rr = runsRootOf(provider, root);
        return rr ? { provider: new LocalFsProvider(rr), root: rr } : { provider, root };
      })()
    : { provider, root };
  const out: ChangedEntry[] = [];
  for (const rel of findManifestsVia(rp)) {
    const dir = path.join(runsRoot, rel);
    const m = readJson(rp, join(rel, "manifest.json"));
    // Passing runs awaiting an explicit accept: a healed journey, or a recording
    // the acceptance leak scan refused to save automatically
    // (docs/contracts/interfaces.md#baseline-review-and-grading). Both leave the
    // same candidate files and are accepted the same way; everything else is skipped.
    if (m?.result?.status !== "pass") continue;
    if (m.healed !== true && m.baseline_scan?.blocked !== true) continue;
    let pending = false;
    if (typeof m.case?.file === "string") {
      const p = baselinePaths(m.case.file);
      const meta = readJsonFile<{ run_dir?: string; run_id?: string }>(p.healedMeta);
      pending =
        fs.existsSync(p.healedTraj) &&
        meta !== null &&
        (meta.run_dir ? path.resolve(meta.run_dir) === path.resolve(dir) : meta.run_id === m.run_id);
    }
    out.push({
      case_id: m.case?.id ?? null,
      run_id: m.run_id ?? null,
      started_at: m.started_at ?? null,
      score: readJson(rp, join(rel, "grade.json"))?.score ?? null,
      path: rel,
      run_dir_rel: path.relative(process.cwd(), dir),
      pending,
    });
  }
  return out.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

/**
 * Sibling runs of one case across run ids, oldest first. `path` is
 * root-relative (like listRuns) so sparkline dots can link ?run=<path> —
 * only resolvable when the server is serving the runs root, not a single run.
 */
function history(provider: StorageProvider, root: string, singleRun: boolean, caseId: string | null) {
  if (!caseId) return [];
  const rp = singleRun
    ? (() => {
        const rr = runsRootOf(provider, root);
        return rr ? new LocalFsProvider(rr) : null;
      })()
    : provider;
  if (!rp) return [];

  const entries: RunHistoryEntry[] = [];
  for (const rel of findManifestsVia(rp)) {
    const m = readJson(rp, join(rel, "manifest.json"));
    if (m?.case?.id !== caseId) continue;
    entries.push(
      manifestToHistoryEntry(m, readJson(rp, join(rel, "grade.json"))?.score, {
        // manifestToHistoryEntry reads totals stamped into the manifest at generate-time. Fall back to a
        // full trajectory re-parse only for legacy runs that predate totals.lcp_ms.
        lcp_ms: m.totals?.lcp_ms ?? worstLcp(rp, join(rel, "trajectory.jsonl")),
        cost_usd: m.totals?.cost_usd ?? 0,
        path: rel,
      }),
    );
  }
  return entries.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

/**
 * For a single run dir, the runs root is the parent of the <run_id> ancestor.
 * Reads the run_id via the provider, then walks the absolute root ancestors
 * (the run dir on disk) — single-run mode is inherently local today.
 */
function runsRootOf(provider: StorageProvider, root: string) {
  const runId = readJson(provider, "manifest.json")?.run_id;
  if (!runId) return null;
  for (let d = root; ; ) {
    if (path.basename(d) === runId) return path.dirname(d);
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function worstLcp(provider: StorageProvider, rel: string) {
  const text = provider.readText(rel);
  if (text === null) return null;
  let worst: number | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const lcp = JSON.parse(line).perf?.nav?.lcp_ms;
      if (typeof lcp === "number" && (worst === null || lcp > worst)) worst = lcp;
    } catch {}
  }
  return worst;
}

function json(res: ServerResponse, obj: unknown) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
  res.end(JSON.stringify(obj));
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

function openBrowser(url: string) {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
