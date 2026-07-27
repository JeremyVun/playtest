// The buffered-response layer. Every fully buffered control-plane response —
// handler JSON, small handler buffers, and the static web app — is written by
// sendBuffered(), so conditional requests and content coding are implemented
// exactly once instead of per route:
//
//   * strong ETag over the response bytes + If-None-Match → bodyless 304, so a
//     revalidation of an unchanged page/API payload costs headers, not bytes.
//   * gzip/brotli negotiated from Accept-Encoding for compressible types above
//     a size floor, with Vary: accept-encoding so caches stay honest.
//
// Streaming and Range responses never come through here: those handlers write
// their own headers (run-viewer sendFile does its own Last-Modified/304/206),
// and server.js sees res.headersSent and stops. Big attachment downloads (run
// bundle, clip, tar export) and opaque blobs are deliberately left unvalidated
// too — hashing tens of MiB per request buys nothing.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Readable } from "node:stream";

type Body = string | Buffer | Uint8Array | null | undefined;

/** Below this a compressed body saves less than the header/CPU it costs. */
const COMPRESS_MIN_BYTES = 1024;
/** Brotli's default quality (11) is far too slow for dynamic bodies. */
const BROTLI_QUALITY = 5;

/** Types worth compressing — text-shaped payloads only. */
const COMPRESSIBLE = [
  /^application\/json\b/,
  /^text\//,
  /^application\/javascript\b/,
  /^image\/svg\+xml\b/,
];

/** Types that get an ETag: API JSON plus the static web app's own assets. */
const VALIDATED = [...COMPRESSIBLE, /^image\//, /^font\//, /^application\/manifest\+json\b/];

export const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mhtml": "multipart/related",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticFileProvider {
  stat(rel: string): { size: number; mtime: Date; isFile: boolean } | null;
  createReadStream(rel: string, opts?: { start?: number; end?: number }): Readable;
}

/**
 * Traversal-safe file response with Last-Modified validation and one byte
 * range. A provider supplies virtual bundle entries; without one, bytes come
 * from the bounded filesystem directory.
 */
export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  base: string,
  rel: string,
  provider: StaticFileProvider | null = null,
) {
  const root = path.resolve(base);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return sendFileNotFound(res);

  let stat;
  if (provider) {
    stat = provider.stat(rel);
    if (!stat) return sendFileNotFound(res);
  } else {
    try {
      const value = fs.statSync(abs);
      stat = { size: value.size, mtime: value.mtime, isFile: value.isFile() };
    } catch {
      return sendFileNotFound(res);
    }
  }
  if (!stat.isFile) return sendFileNotFound(res);

  const open = (opts?: { start?: number; end?: number }) =>
    provider ? provider.createReadStream(rel, opts) : fs.createReadStream(abs, opts);
  const pipe = (opts?: { start?: number; end?: number }) => {
    const stream = open(opts);
    stream.on("error", () => {
      if (!res.headersSent) sendFileNotFound(res);
      else res.destroy();
    });
    stream.pipe(res);
  };

  const lastModified = stat.mtime.toUTCString();
  const headers = {
    "content-type": STATIC_MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "last-modified": lastModified,
  };
  if (!req.headers.range && req.headers["if-modified-since"] === lastModified) {
    return res.writeHead(304, headers).end();
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2]) && stat.size > 0) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end) {
      return res.writeHead(416, { "content-range": `bytes */${stat.size}` }).end();
    }
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "content-length": end - start + 1,
    });
    if (req.method === "HEAD") return res.end();
    return pipe({ start, end });
  }

  res.writeHead(200, { ...headers, "content-length": stat.size });
  if (req.method === "HEAD") return res.end();
  pipe();
}

function sendFileNotFound(res: ServerResponse) {
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

const matches = (patterns: readonly RegExp[], type: string) => patterns.some((p) => p.test(type));

/** Strong validator over the *uncompressed* bytes, so it is stable across encodings. */
export function etagFor(body: Body): string {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  return `"${createHash("sha256").update(buf).digest("hex").slice(0, 32)}"`;
}

/** If-None-Match uses weak comparison, so `W/"x"` matches `"x"`; `*` matches anything. */
export function ifNoneMatchSatisfied(header: string | string[] | undefined, etag: string | undefined): boolean {
  if (!header || !etag) return false;
  const raw = String(header).trim();
  if (raw === "*") return true;
  const want = etag.replace(/^W\//, "");
  return raw.split(",").some((token) => token.trim().replace(/^W\//, "") === want);
}

/**
 * Pick a content coding from Accept-Encoding: brotli when it is at least as
 * welcome as gzip, else gzip, else null. Honors q-values (q=0 = refused) and
 * the `*` wildcard.
 */
export function negotiateEncoding(header: string | string[] | undefined): "br" | "gzip" | null {
  if (!header) return null;
  const q: Record<"br" | "gzip" | "*", number> = { br: -1, gzip: -1, "*": -1 };
  for (const part of String(header).split(",")) {
    const [nameRaw, ...params] = part.trim().split(";");
    const name = nameRaw!.trim().toLowerCase(); // SAFETY: Splitting a non-empty encoding token always yields its name component.
    if (!(name in q)) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) weight = Number(m[1]);
    }
    if (!Number.isFinite(weight)) weight = 0;
    q[name as keyof typeof q] = Math.max(q[name as keyof typeof q], weight);
  }
  const score = (name: "br" | "gzip") => (q[name] >= 0 ? q[name] : q["*"]);
  const br = score("br");
  const gzip = score("gzip");
  if (br > 0 && br >= gzip) return "br";
  if (gzip > 0) return "gzip";
  return null;
}

async function compress(encoding: "br" | "gzip", body: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (encoding === "br") {
      zlib.brotliCompress(
        body,
        {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        },
        done,
      );
    } else {
      zlib.gzip(body, done);
    }
  });
}

// Handler headers arrive in whatever case the route wrote them, so every lookup
// is case-insensitive and writes reuse the existing key.
function headerKey(headers: OutgoingHttpHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}
function getHeader(headers: OutgoingHttpHeaders, name: string) {
  const k = headerKey(headers, name);
  return k === undefined ? undefined : headers[k] as string | undefined; // SAFETY: Control-plane buffered response headers use scalar strings at these lookup sites.
}
function setHeader(headers: OutgoingHttpHeaders, name: string, value: string | number | string[]) {
  headers[headerKey(headers, name) ?? name] = value;
}
function addVary(headers: OutgoingHttpHeaders, field: string) {
  const current = getHeader(headers, "vary");
  const list = String(current ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.some((v) => v.toLowerCase() === field || v === "*")) return;
  setHeader(headers, "vary", [...list, field].join(", "));
}

/**
 * Write a fully buffered response.
 * @returns the status actually written — 304 when the client's If-None-Match matched.
 */
export async function sendBuffered(
  req: IncomingMessage,
  res: ServerResponse,
  { status = 200, body, contentType, headers = {} }: {
    status?: number;
    body?: Body;
    contentType?: string;
    headers?: OutgoingHttpHeaders;
  } = {}
): Promise<number> {
  const out = { ...headers };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  const type = contentType ?? getHeader(out, "content-type") ?? "application/octet-stream";
  setHeader(out, "content-type", type);

  const preEncoded = getHeader(out, "content-encoding") !== undefined;
  const isAttachment = getHeader(out, "content-disposition") !== undefined;
  const hasCookies = getHeader(out, "set-cookie") !== undefined;
  const bodyless = status === 204 || status === 304;

  const compressible = !preEncoded && !bodyless && status !== 206 && matches(COMPRESSIBLE, type);
  // Only safe, cacheable reads get a validator: a 201/202 is not a cache entry,
  // an attachment is a download, and a Set-Cookie response must reach the client
  // in full so the cookie is not dropped by a 304.
  const validatable =
    !preEncoded &&
    !isAttachment &&
    !hasCookies &&
    status === 200 &&
    (req.method === "GET" || req.method === "HEAD") &&
    matches(VALIDATED, type);

  if (compressible) addVary(out, "accept-encoding");

  if (validatable) {
    const etag = getHeader(out, "etag") ?? etagFor(buf);
    setHeader(out, "etag", etag);
    // No content-hashed filenames anywhere in the app, so every validated
    // response revalidates; the ETag makes that revalidation bodyless.
    if (getHeader(out, "cache-control") === undefined) setHeader(out, "cache-control", "no-cache");
    if (ifNoneMatchSatisfied(req.headers["if-none-match"], etag as string)) {
      const notModified: OutgoingHttpHeaders = {};
      for (const name of ["etag", "cache-control", "vary"]) {
        const value = getHeader(out, name);
        if (value !== undefined) notModified[name] = value;
      }
      res.writeHead(304, notModified).end();
      return 304;
    }
  }

  let payload = buf;
  if (compressible && buf.length >= COMPRESS_MIN_BYTES) {
    const encoding = negotiateEncoding(req.headers["accept-encoding"]);
    if (encoding) {
      const encoded = await compress(encoding, buf);
      // A body that grew (already-compressed bytes) ships raw.
      if (encoded.length < buf.length) {
        payload = encoded;
        setHeader(out, "content-encoding", encoding);
      }
    }
  }

  setHeader(out, "content-length", payload.length);
  res.writeHead(status, out);
  // HEAD gets the exact headers a GET would return, minus the body.
  res.end(req.method === "HEAD" ? undefined : payload);
  return status;
}

/**
 * Serve a static directory through sendBuffered. `indexFallback` gives the SPA
 * its history-API routing: an extension-less miss renders index.html.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  pathname: string,
  { indexFallback = true }: { indexFallback?: boolean } = {}
): Promise<number> {
  const root = path.resolve(dir);
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const abs = path.resolve(root, rel);
  const inRoot = abs === root || abs.startsWith(root + path.sep);
  let file = inRoot && fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
  if (!file && indexFallback && !path.extname(rel)) {
    const index = path.join(root, "index.html");
    file = fs.existsSync(index) ? index : null;
  }
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return 404;
  }
  return await sendBuffered(req, res, {
    body: fs.readFileSync(file),
    contentType: STATIC_MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    headers: { "cache-control": "no-cache" },
  });
}
