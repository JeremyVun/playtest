// The buffered-response layer (src/response.ts): conditional requests and
// content coding. Driven over a real loopback node:http server with a raw
// client, because that is the only way to observe what actually goes on the
// wire — fetch() transparently decodes content-encoding and hides 304 handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { platformWebAssetsDir } from "@playtest/web/assets";
import {
  sendBuffered,
  serveStatic,
  etagFor,
  ifNoneMatchSatisfied,
  negotiateEncoding,
} from "../../src/response.ts";

const WEB_DIR = platformWebAssetsDir;

/** A JSON body comfortably over the 1 KiB compression floor and very compressible. */
const BIG = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, note: "a repeated line of json" })) };
const SMALL = { ok: true };

async function startServer(handler: HostedDynamic) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      if (!res.headersSent) res.writeHead(500).end(String(e));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function request(server: HostedDynamic, { method = "GET", path: reqPath = "/", headers = {} }: HostedDynamic = {}): Promise<HostedDynamic> {
  const { port } = server.address();
  return new Promise<HostedDynamic>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: reqPath, headers }, (res) => {
      const chunks: HostedDynamic[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The routes exercised below, all through the same central sender. */
async function app(req: HostedDynamic, res: HostedDynamic) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/big") {
    return await sendBuffered(req, res, { body: Buffer.from(JSON.stringify(BIG)), contentType: "application/json" });
  }
  if (url.pathname === "/api/small") {
    return await sendBuffered(req, res, { body: Buffer.from(JSON.stringify(SMALL)), contentType: "application/json" });
  }
  if (url.pathname === "/api/created") {
    return await sendBuffered(req, res, {
      status: 201,
      body: Buffer.from(JSON.stringify(BIG)),
      contentType: "application/json",
    });
  }
  if (url.pathname === "/api/download") {
    return await sendBuffered(req, res, {
      body: Buffer.from(JSON.stringify(BIG)),
      contentType: "application/vnd.playtest.run-bundle",
      headers: { "content-disposition": 'attachment; filename="run.ptrun"' },
    });
  }
  if (url.pathname === "/api/session") {
    return await sendBuffered(req, res, {
      body: Buffer.from(JSON.stringify(SMALL)),
      contentType: "application/json",
      headers: { "set-cookie": ["pt_session=abc; Path=/"] },
    });
  }
  return await serveStatic(req, res, WEB_DIR, url.pathname);
}

async function withApp(t: HostedDynamic) {
  const server = await startServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test("etag: a JSON GET carries a strong validator and revalidate semantics", async (t) => {
  const server = await withApp(t);
  const res = await request(server, { path: "/api/small" });
  assert.equal(res.status, 200);
  assert.match(res.headers.etag, /^"[0-9a-f]{32}"$/);
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.equal(res.headers.vary, "accept-encoding");
  assert.deepEqual(JSON.parse(res.body.toString()), SMALL);
  // Stable across requests, and computed from the bytes.
  const again = await request(server, { path: "/api/small" });
  assert.equal(again.headers.etag, res.headers.etag);
  assert.equal(res.headers.etag, etagFor(Buffer.from(JSON.stringify(SMALL))));
});

test("etag: If-None-Match hit is a bodyless 304 keeping the cache headers", async (t) => {
  const server = await withApp(t);
  const first = await request(server, { path: "/api/small" });
  const hit = await request(server, { path: "/api/small", headers: { "if-none-match": first.headers.etag } });
  assert.equal(hit.status, 304);
  assert.equal(hit.body.length, 0);
  assert.equal(hit.headers.etag, first.headers.etag);
  assert.equal(hit.headers["cache-control"], "no-cache");
  assert.equal(hit.headers.vary, "accept-encoding");
  assert.equal(hit.headers["content-length"], undefined);
  // A weak-form validator and `*` also match (If-None-Match is a weak comparison).
  const weak = await request(server, {
    path: "/api/small",
    headers: { "if-none-match": `W/${first.headers.etag}` },
  });
  assert.equal(weak.status, 304);
  assert.equal((await request(server, { path: "/api/small", headers: { "if-none-match": "*" } })).status, 304);
});

test("etag: a stale or absent If-None-Match is a full 200", async (t) => {
  const server = await withApp(t);
  const miss = await request(server, { path: "/api/small", headers: { "if-none-match": '"deadbeef"' } });
  assert.equal(miss.status, 200);
  assert.deepEqual(JSON.parse(miss.body.toString()), SMALL);
  // A validator for a *different* resource must not short-circuit this one.
  const big = await request(server, { path: "/api/big" });
  const cross = await request(server, { path: "/api/small", headers: { "if-none-match": big.headers.etag } });
  assert.equal(cross.status, 200);
});

test("compression: a large JSON body gzips, round-trips, and keeps its uncompressed etag", async (t) => {
  const server = await withApp(t);
  const plain = await request(server, { path: "/api/big" });
  const gzipped = await request(server, { path: "/api/big", headers: { "accept-encoding": "gzip" } });

  assert.equal(gzipped.status, 200);
  assert.equal(gzipped.headers["content-encoding"], "gzip");
  assert.equal(gzipped.headers.vary, "accept-encoding");
  assert.ok(gzipped.body.length < plain.body.length, "compressed body must be smaller");
  assert.equal(Number(gzipped.headers["content-length"]), gzipped.body.length);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gzipped.body).toString()), BIG);
  // The validator is over the uncompressed bytes, so it is encoding-independent.
  assert.equal(gzipped.headers.etag, plain.headers.etag);
  assert.equal(plain.headers["content-encoding"], undefined);
});

test("compression: brotli wins when both are welcome, and q=0 refusals are honored", async (t) => {
  const server = await withApp(t);
  const br = await request(server, { path: "/api/big", headers: { "accept-encoding": "gzip, br" } });
  assert.equal(br.headers["content-encoding"], "br");
  assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.body).toString()), BIG);

  const noBr = await request(server, { path: "/api/big", headers: { "accept-encoding": "br;q=0, gzip" } });
  assert.equal(noBr.headers["content-encoding"], "gzip");

  const none = await request(server, { path: "/api/big", headers: { "accept-encoding": "identity" } });
  assert.equal(none.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(none.body.toString()), BIG);
});

test("compression: a 304 carries no encoding, and small bodies ship raw", async (t) => {
  const server = await withApp(t);
  const small = await request(server, { path: "/api/small", headers: { "accept-encoding": "gzip, br" } });
  assert.equal(small.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(small.body.toString()), SMALL);

  const notModified = await request(server, {
    path: "/api/small",
    headers: { "accept-encoding": "gzip, br", "if-none-match": small.headers.etag },
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers["content-encoding"], undefined);
  assert.equal(notModified.body.length, 0);
});

test("static: bundled web assets get validators without exposing source modules", async (t) => {
  const server = await withApp(t);
  const css = await request(server, { path: "/style.css" });
  assert.equal(css.status, 200);
  assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(css.headers["cache-control"], "no-cache");
  assert.match(css.headers.etag, /^"[0-9a-f]{32}"$/);
  assert.ok(css.body.length > 0);

  const revalidated = await request(server, { path: "/style.css", headers: { "if-none-match": css.headers.etag } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.length, 0);
  assert.equal(revalidated.headers.etag, css.headers.etag);

  // Text assets compress; the SPA fallback still renders index.html with a validator.
  const gz = await request(server, { path: "/style.css", headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(gz.body).length, css.body.length);

  const deepLink = await request(server, { path: "/p/demo/runs" });
  assert.equal(deepLink.status, 200);
  assert.equal(deepLink.headers["content-type"], "text/html; charset=utf-8");
  assert.match(deepLink.headers.etag, /^"[0-9a-f]{32}"$/);

  const bundle = await request(server, { path: "/app.js" });
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers["content-type"], "text/javascript; charset=utf-8");
  assert.ok(bundle.body.length > 100_000);

  const sourceModule = await request(server, { path: "/lib/api.js" });
  assert.equal(sourceModule.status, 404);
});

test("head: identical headers to a GET, with no body", async (t) => {
  const server = await withApp(t);
  const get = await request(server, { path: "/api/big" });
  const head = await request(server, { method: "HEAD", path: "/api/big" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], get.headers["content-length"]);
  assert.equal(head.headers["content-type"], "application/json");
  assert.equal(head.headers.etag, get.headers.etag);

  // Compression is negotiated for HEAD too, so content-length stays truthful.
  const headGz = await request(server, { method: "HEAD", path: "/api/big", headers: { "accept-encoding": "gzip" } });
  const getGz = await request(server, { path: "/api/big", headers: { "accept-encoding": "gzip" } });
  assert.equal(headGz.headers["content-encoding"], "gzip");
  assert.equal(headGz.headers["content-length"], getGz.headers["content-length"]);
  assert.equal(headGz.body.length, 0);

  // A HEAD may revalidate as well.
  const head304 = await request(server, { method: "HEAD", path: "/api/big", headers: { "if-none-match": get.headers.etag } });
  assert.equal(head304.status, 304);
});

test("carve-outs: downloads, non-200 writes, and Set-Cookie responses stay unvalidated", async (t) => {
  const server = await withApp(t);
  // Attachment downloads (run bundle, clip, tar export) are never hashed: the
  // point of the carve-out is that big/streamed payloads keep their old path.
  const download = await request(server, { path: "/api/download" });
  assert.equal(download.status, 200);
  assert.equal(download.headers.etag, undefined);
  assert.equal(download.headers["content-encoding"], undefined);
  assert.equal(Number(download.headers["content-length"]), download.body.length);

  // A 201 is not a cache entry; it may still compress.
  const created = await request(server, { path: "/api/created", headers: { "accept-encoding": "gzip" } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.etag, undefined);
  assert.equal(created.headers["content-encoding"], "gzip");

  // A 304 would drop Set-Cookie, so session responses are sent whole.
  const session = await request(server, { path: "/api/session" });
  assert.equal(session.status, 200);
  assert.equal(session.headers.etag, undefined);
  assert.ok(session.headers["set-cookie"]);
});

test("negotiateEncoding and ifNoneMatchSatisfied: header parsing edge cases", () => {
  assert.equal(negotiateEncoding(undefined), null);
  assert.equal(negotiateEncoding(""), null);
  assert.equal(negotiateEncoding("deflate"), null);
  assert.equal(negotiateEncoding("gzip"), "gzip");
  assert.equal(negotiateEncoding("GZIP, BR"), "br");
  assert.equal(negotiateEncoding("*"), "br");
  assert.equal(negotiateEncoding("gzip;q=0.9, br;q=0.5"), "gzip");
  assert.equal(negotiateEncoding("gzip;q=0, br;q=0"), null);
  assert.equal(negotiateEncoding("identity;q=1, *;q=0"), null);

  assert.equal(ifNoneMatchSatisfied('"a"', '"a"'), true);
  assert.equal(ifNoneMatchSatisfied('"a", "b"', '"b"'), true);
  assert.equal(ifNoneMatchSatisfied('W/"a"', '"a"'), true);
  assert.equal(ifNoneMatchSatisfied('"a"', '"b"'), false);
  assert.equal(ifNoneMatchSatisfied(undefined, '"a"'), false);
  assert.equal(ifNoneMatchSatisfied('"a"', undefined), false);
});
