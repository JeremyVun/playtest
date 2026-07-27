// The HTTP request pipeline — the same hand-rolled node:http scale as
// view-server.ts, with a router (routes.ts) in front. Per request: resolve the
// principal (AuthN), match a route, run the handler, serialize its result, and map
// any throw to the §2 error envelope (never a stack trace to a client). Non-API GETs
// fall through to the static web app (src/platform/web), which does its own history-API
// routing, so any deep link renders index.html.
//
// Every buffered response leaves through response.js (ETag/304 + Accept-Encoding);
// handlers that stream (Range-capable viewer/bundle serving) write their own
// headers and are detected here by res.headersSent.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.ts";
import { HttpResult } from "./http.ts";
import { resolvePrincipal } from "./auth/middleware.ts";
import { limiterKey } from "./rate-limit.ts";
import { sendBuffered, serveStatic } from "./response.ts";
import { buildRouter } from "./routes.ts";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

/**
 * Build the http.Server. `ctx` is the app context: { db, store, config, log,
 * devUserId }. Exported (not started) so tests can drive it on an ephemeral port.
 */
export function createServer(ctx: HostedDynamic) {
  const router = buildRouter();
  const server = http.createServer((req, res) => {
    handle(ctx, router, req, res).catch((e) => {
      // Last-resort guard: any throw the handler pipeline didn't catch.
      if (!res.headersSent) sendError(res, ctx, e, "?");
      else res.destroy();
    });
  });
  return server;
}

async function handle(ctx: HostedDynamic, router: HostedDynamic, req: HostedDynamic, res: HostedDynamic) {
  const requestId = ctx.log.newRequestId();
  const started = Date.now();
  const u = new URL(req.url, "http://localhost");
  const method = req.method === "HEAD" ? "GET" : req.method;

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  let principal: HostedDynamic = null;
  let status = 500;
  try {
    principal = await resolvePrincipal(ctx, req);
  } catch (e) {
    // A broken session/token lookup shouldn't 500 the whole request — treat as
    // anonymous and let route guards decide.
    ctx.log.warn({ msg: "principal resolution failed", requestId, err: String(e) });
  }

  // Write-route rate limit: per-principal token bucket
  // on mutations under /api/v1. The runner protocol is exempt — its bearer is
  // already scoped to one dispatch and case reports must never bounce.
  if (
    ctx.writeLimiter?.enabled &&
    (req.method === "POST" || req.method === "PUT" || req.method === "DELETE" || req.method === "PATCH") &&
    u.pathname.startsWith("/api/v1/") &&
    !u.pathname.startsWith("/api/v1/runner/")
  ) {
    const verdict = ctx.writeLimiter.check(limiterKey(principal, req));
    if (!verdict.ok) {
      status = 429;
      sendError(
        res,
        ctx,
        new AppError("rate_limited", `too many write requests — retry in ${verdict.retryAfterS}s`),
        requestId,
        { "retry-after": String(verdict.retryAfterS) },
      );
      ctx.log.info({ requestId, method: req.method, path: u.pathname, status, ms: Date.now() - started, rateLimited: true });
      return;
    }
  }

  try {
    const match = router.match(method, u.pathname);
    if (match && match.handler) {
      const reqCtx: HostedDynamic = { ...ctx, req, res, principal, requestId, params: match.params, query: u.searchParams };
      const result = await match.handler(reqCtx);
      status = await writeResult(req, res, result);
    } else if (match && match.methodNotAllowed) {
      status = 405;
      sendError(res, ctx, new AppError("method_not_allowed", `method ${method} not allowed`, { status: 405 }), requestId, { Allow: match.allow.join(", ") });
    } else if (method === "GET" && !u.pathname.startsWith("/api/") && !u.pathname.startsWith("/auth/")) {
      // Non-API GETs fall through to the static web app (its own history-API routing).
      // A mistyped /api/ or /auth/ path must get the JSON not_found envelope, never
      // a 200 index.html (contract §2: "JSON everywhere").
      status = await serveStatic(req, res, WEB_DIR, u.pathname);
    } else {
      status = 404;
      sendError(res, ctx, new AppError("not_found", "not found"), requestId);
    }
  } catch (e) {
    status = e instanceof AppError ? e.status : 500;
    sendError(res, ctx, e, requestId);
  }

  ctx.log.info({
    requestId,
    method: req.method,
    path: u.pathname,
    status,
    ms: Date.now() - started,
    actor: principal ? (principal.kind === "token" ? `token:${principal.tokenId}` : principal.subject) : "-",
  });
}

/** Serialize a handler result; returns the status written (304 on a validator hit). */
async function writeResult(req: HostedDynamic, res: HostedDynamic, result: HostedDynamic) {
  // A handler may stream the response itself (the viewer adapter pipes bundle
  // entries through core sendFile for Range support); once headers are out the
  // pipeline must not write a second response.
  if (res.headersSent) return res.statusCode;
  const r = result instanceof HttpResult ? result : new HttpResult({ json: result });
  const headers: HostedDynamic = { ...r.headers };
  if (r.cookies?.length) headers["set-cookie"] = r.cookies;
  if (r.redirect) {
    headers.location = r.redirect;
    res.writeHead(r.status || 302, headers).end();
    return r.status || 302;
  }
  if (r.buffer !== undefined) {
    return await sendBuffered(req, res, {
      status: r.status,
      body: r.buffer,
      contentType: r.contentType || "application/octet-stream",
      headers,
    });
  }
  if (r.json !== undefined) {
    return await sendBuffered(req, res, {
      status: r.status,
      body: Buffer.from(JSON.stringify(r.json)),
      contentType: "application/json",
      headers,
    });
  }
  res.writeHead(r.status, headers).end();
  return r.status;
}

function sendError(res: HostedDynamic, ctx: HostedDynamic, err: HostedDynamic, requestId: HostedDynamic, extraHeaders = {}) {
  const isApp = err instanceof AppError;
  const status = isApp ? err.status : 500;
  if (!isApp) {
    ctx.log.error({ msg: "unhandled error", requestId, err: err?.stack || String(err) });
  }
  const envelope = isApp
    ? err.toEnvelope()
    : { error: { code: "internal", message: "internal server error" } };
  const body = Buffer.from(JSON.stringify(envelope));
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "content-length": body.length, ...extraHeaders });
  res.end(body);
}

export { WEB_DIR };
