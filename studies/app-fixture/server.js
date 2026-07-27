// Deliberately buggy home-loan applicant capture fixture (not a product).
// Serves static files from public/ and accepts POST /api/applications.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function safePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const clean = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.join(PUBLIC_DIR, clean);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

function serveStatic(req, res, urlPath) {
  const filePath = safePublicPath(urlPath === "/" ? "/index.html" : urlPath);
  if (!filePath) {
    json(res, 403, { error: "forbidden" });
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (urlPath === "/" || urlPath === "/index.html") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("index.html not found");
        return;
      }
      json(res, 404, { error: "not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    fs.createReadStream(filePath).pipe(res);
  });
}

function makeReference() {
  const n = Math.floor(Math.random() * 900000) + 100000;
  return `HL-${Date.now().toString(36).toUpperCase()}-${n}`;
}

/**
 * Boot one loan-capture fixture instance.
 * @param {{ port?: number, host?: string }} [opts] port 0 = ephemeral
 * @returns {Promise<{ url: string, port: number, host: string, close: () => Promise<void> }>}
 */
export async function start({ port = 0, host = "127.0.0.1" } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}`);
    try {
      if (req.method === "POST" && url.pathname === "/api/applications") {
        const body = await readBody(req);
        const reference = makeReference();
        return json(res, 200, {
          ok: true,
          reference,
          message: "received",
          echo: body,
        });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(req, res, url.pathname);
      }

      json(res, 405, { error: "method not allowed" });
    } catch (err) {
      json(res, 400, { error: err.message || "bad request" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const boundHost = host || "127.0.0.1";

  return {
    url: `http://${boundHost}:${boundPort}`,
    port: boundPort,
    host: boundHost,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      }),
  };
}

// CLI: `node tests/app-fixture/server.js`. Importing this module never binds a port.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT) || 4191;
  const host = process.env.HOST || "127.0.0.1";
  const { url } = await start({ port, host });
  console.log("loan-fixture listening on " + url);
}
