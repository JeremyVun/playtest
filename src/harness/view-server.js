// Zero-dep static server for `dummy view`. See docs/CONTRACTS.md §13.
// Serves the viewer at /, run files at /run/*, /runs.json (runs-root picker)
// and /history.json?case=<id> (cross-run sparkline). Supports Range requests
// so the browser can seek video.webm.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VIEWER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../viewer");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".png": "image/png",
  ".webm": "video/webm",
  ".mhtml": "multipart/related",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * @param {string} dir a single run dir (has manifest.json) or a runs root
 * @returns {Promise<import("node:http").Server>}
 */
export async function serveRun(dir, { port = 0, open = true } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  const singleRun = fs.existsSync(path.join(root, "manifest.json"));

  const server = http.createServer((req, res) => {
    try {
      handle(req, res, root, singleRun);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`error: ${e.message}`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const url = `http://localhost:${server.address().port}/`;
  console.log(`Dummy viewer: ${url}`);
  if (open) openBrowser(url);
  return server;
}

function handle(req, res, root, singleRun) {
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
    return json(res, listRuns(root));
  }
  if (pathname === "/history.json") {
    return json(res, history(root, singleRun, u.searchParams.get("case")));
  }
  if (pathname.startsWith("/run/")) {
    return sendFile(req, res, root, pathname.slice("/run/".length));
  }
  return sendFile(req, res, VIEWER_DIR, pathname === "/" ? "index.html" : pathname.slice(1));
}

/** Traversal-safe file response with single-range support (video seeking). */
function sendFile(req, res, base, rel) {
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return notFound(res);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return notFound(res);
  }
  if (!st.isFile()) return notFound(res);

  const headers = {
    "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
  };

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
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, "content-length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(abs).pipe(res);
}

/** All run dirs under a runs root: every manifest.json at any depth (bounded). */
function findManifests(root, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "manifest.json")) {
      out.push(dir);
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "steps") walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listRuns(root) {
  const runs = [];
  for (const dir of findManifests(root)) {
    const m = readJson(path.join(dir, "manifest.json"));
    if (!m) continue;
    const rel = path.relative(root, dir).split(path.sep);
    runs.push({
      run_id: rel[0],
      case_id: rel.slice(1).join("/"), // dir-derived so picker links resolve (repeat runs get -2 suffixes)
      path: rel.join("/"),
      status: m.result?.status ?? null,
      mode: m.mode ?? null,
      started_at: m.started_at ?? null,
    });
  }
  return runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

/** Sibling runs of one case across run ids, oldest first. */
function history(root, singleRun, caseId) {
  if (!caseId) return [];
  const runsRoot = singleRun ? runsRootOf(root) : root;
  if (!runsRoot) return [];

  const entries = [];
  for (const dir of findManifests(runsRoot)) {
    const m = readJson(path.join(dir, "manifest.json"));
    if (m?.case?.id !== caseId) continue;
    entries.push({
      run_id: m.run_id ?? null,
      started_at: m.started_at ?? null,
      status: m.result?.status ?? null,
      mode: m.mode ?? null,
      duration_ms: m.duration_ms ?? null,
      steps: m.totals?.steps ?? null,
      score: readJson(path.join(dir, "grade.json"))?.score ?? null,
      lcp_ms: worstLcp(path.join(dir, "trajectory.jsonl")),
      cost_usd: m.totals?.cost_usd ?? 0,
    });
  }
  return entries.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

/** For a single run dir, the runs root is the parent of the <run_id> ancestor. */
function runsRootOf(runDir) {
  const runId = readJson(path.join(runDir, "manifest.json"))?.run_id;
  if (!runId) return null;
  for (let d = runDir; ; ) {
    if (path.basename(d) === runId) return path.dirname(d);
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function worstLcp(trajPath) {
  let worst = null;
  let text;
  try {
    text = fs.readFileSync(trajPath, "utf8");
  } catch {
    return null;
  }
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
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
