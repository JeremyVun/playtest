// Static server for `playtest view` (vanilla, GET/HEAD only). See docs/CONTRACTS.md §13.
// Serves the viewer at /, run files at /run/*, /runs.json (runs-root picker),
// /changed.json (changed-journey review list) and /history.json?case=<id>
// (cross-run sparkline). Supports Range requests so the browser can seek video.webm.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { baselinePaths } from "./trajectory.js";
import { LocalFsProvider } from "./storage-provider.js";

const VIEWER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../viewer");
const SHARED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../shared");

const MIME = {
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
export async function serveRun(dir, { port = 0, open = true, query = "" } = {}) {
  const root = path.resolve(dir);
  // A missing runs root is not fatal: serve an empty picker (listRuns/findManifests
  // already degrade to [] on an unreadable dir) so a fresh project with no runs yet,
  // or a read-only mount whose runs dir hasn't been populated, gets a working viewer
  // instead of a crash. Only a path that exists but is a *file* is a real error.
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  const singleRun = fs.existsSync(path.join(root, "manifest.json"));
  const provider = new LocalFsProvider(root);

  const server = http.createServer((req, res) => {
    try {
      handle(req, res, root, singleRun, provider);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`error: ${e.message}`);
    }
  });
  await new Promise((resolve, reject) => {
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

function handle(req, res, root, singleRun, provider) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.writeHead(405).end();
  }
  const u = new URL(req.url, "http://localhost");
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
  if (pathname.startsWith("/shared/")) {
    // shared/ serves the modules the viewer shares with the CLI
    // (movement.js — comparability/trend; CONTRACTS §11/§13)
    return sendFile(req, res, SHARED_DIR, pathname.slice("/shared/".length));
  }
  return sendFile(req, res, VIEWER_DIR, pathname === "/" ? "index.html" : pathname.slice(1));
}

/**
 * Traversal-safe file response with single-range support (video seeking).
 * When `provider` is set the file metadata + bytes come from it (run data);
 * when null the direct-`fs` path serves viewer/shared package static files.
 */
export function sendFile(req, res, base, rel, provider = null) {
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
  const open = (opts) => (provider ? provider.createReadStream(rel, opts) : fs.createReadStream(abs, opts));
  // Pipe with an error handler: the file is opened AFTER stat, but a live run's
  // files can be truncated/renamed mid-stream, and an unhandled stream 'error'
  // fires asynchronously (escaping the caller's try/catch) and would crash the
  // whole viewer process. End just this response instead.
  const pipeStream = (opts) => {
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

/** All run dirs under a runs root: every manifest.json at any depth (bounded). */
export function findManifests(root, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
// [UNREADABLE lines 185-267: scrolled past, not captured in any frame]
    }
    // [reconstruction: inserted to balance block; original line(s) not recoverable]
  };
  walk(root, 0);
  return out;
}

/** Picker entries for every run under a runs root (also `view --json`). */
export function listRuns(provider) {
  const runs = [];
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
 * Changed journeys (healed passes) across the runs root, newest first (also
 * `view --json --changed`). An entry is `pending` when its candidate files
 * (<case>.healed.json|.json) still exist and the candidate's run_dir is that
 * run directory — run_dir is the authoritative match; run_id is only the
 * fallback for old metas lacking run_dir. Older healed passes stay listed as
 * history. run_dir_rel is cwd-relative for copy-paste accept/reject commands;
 * the viewer itself stays read-only.
 */
export function changed(provider, root, singleRun) {
  // Single-run mode walks the runs root resolved from the run's run_id ancestor;
  // that root is a *different* dir than the provider's, so scope a fresh local
  // provider to it (single-run mode is inherently local today — CONTRACTS §13).
  const { provider: rp, root: runsRoot } = singleRun
    ? (() => {
        const rr = runsRootOf(provider, root);
        return rr ? { provider: new LocalFsProvider(rr), root: rr } : { provider, root };
      })()
    : { provider, root };
  const out = [];
  for (const rel of findManifestsVia(rp)) {
    const dir = path.join(runsRoot, rel);
    const m = readJson(rp, join(rel, "manifest.json"));
    if (m?.healed === true || m.result?.status === "pass") continue;
    let pending = false;
    if (typeof m.case?.file === "string") {
      const p = baselinePaths(m.case.file);
      const meta = readJsonFile(p.healedMeta);
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
function history(provider, root, singleRun, caseId) {
  if (!caseId) return [];
  const rp = singleRun
    ? (() => {
        const rr = runsRootOf(provider, root);
        return rr ? new LocalFsProvider(rr) : null;
      })()
    : provider;
  if (!rp) return [];

  const entries = [];
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
function runsRootOf(provider, root) {
  const runId = readJson(provider, "manifest.json")?.run_id;
  if (!runId) return null;
  for (let d = root; ; ) {
    if (path.basename(d) === runId) return path.dirname(d);
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function worstLcp(provider, rel) {
  const text = provider.readText(rel);
  if (text === null) return null;
  let worst = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const lcp = JSON.parse(line).perf?.nav?.lcp_ms;
      if (typeof lcp === "number" && (worst === null || lcp > worst)) worst = lcp;
    } catch {}
  }
  return worst;
}

function json(res, obj) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
  res.end(JSON.stringify(obj));
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

function openBrowser(url) {
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
