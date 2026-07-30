#!/usr/bin/env node
// Loanpoint — equipment lending desk for Fairmont University Media Services.
//
//   SUBJECT_PORT   listen port (default 4620), always bound to 127.0.0.1
//   SUBJECT_NOW    the frozen desk clock as an ISO instant
//                  (default 2026-03-16T09:00:00Z)

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as api from "./src/api.js";
import * as store from "./src/store.js";
import { nowIso } from "./src/time.js";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PUBLIC_DIR = join(HERE, "public");
const PORT = Number(process.env.SUBJECT_PORT || 4620);
const HOST = "127.0.0.1";

const APP_NAME = "Loanpoint";

// --- route table ---------------------------------------------------------

const API_ROUTES = [
  ["GET", "/api/session", api.getSession],
  ["GET", "/api/overview", api.getOverview],
  ["GET", "/api/equipment", api.listEquipment],
  ["GET", "/api/equipment/:id", api.getEquipment],
  ["GET", "/api/loans", api.listLoans],
  ["GET", "/api/loans/:id", api.getLoan],
  ["POST", "/api/loans/:id/pickup", api.pickupLoan],
  ["POST", "/api/loans/:id/extend", api.extendLoan],
  ["POST", "/api/loans/:id/checkin", api.checkinLoan],
  ["POST", "/api/loans/:id/cancel", api.cancelLoan],
  ["GET", "/api/approvals", api.listApprovals],
  ["POST", "/api/approvals/:id/approve", api.approveLoan],
  ["POST", "/api/approvals/:id/decline", api.declineLoan],
  ["POST", "/api/loan-drafts", api.createDraft],
  ["GET", "/api/loan-drafts/:id", api.getDraft],
  ["PATCH", "/api/loan-drafts/:id", api.updateDraft],
  ["POST", "/api/loan-drafts/:id/submit", api.submitDraft],
];

/** Paths the browser application owns; each renders the single-page shell. */
const APP_ROUTES = [
  "/",
  "/equipment",
  "/equipment/:id",
  "/loans",
  "/loans/:id",
  "/new-loan",
  "/approvals",
];

function matchPattern(pattern, pathname) {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(":")) {
      if (!actual) return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

// --- helpers -------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("payload too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function sendShell(res, status) {
  const html = await readFile(join(PUBLIC_DIR, "app.html"));
  res.writeHead(status, {
    "content-type": MIME[".html"],
    "content-length": html.length,
    "cache-control": "no-store",
  });
  res.end(html);
}

async function sendStatic(res, pathname) {
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return true;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// --- request handling ----------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const method = req.method || "GET";

  // Operational hooks. Not part of the product surface.
  if (pathname === "/__reset" && method === "POST") {
    store.reset();
    sendJson(res, 200, { reset: true, now: nowIso() });
    return;
  }
  if (pathname === "/__build" && method === "GET") {
    sendJson(res, 200, { app: APP_NAME, variant: "clean", now: nowIso() });
    return;
  }

  if (pathname.startsWith("/api/")) {
    let pathMatched = false;
    for (const [routeMethod, pattern, handler] of API_ROUTES) {
      const params = matchPattern(pattern, pathname);
      if (!params) continue;
      pathMatched = true;
      if (routeMethod !== method) continue;
      let body = {};
      if (method !== "GET") {
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 400, { error: { message: "The request body was not valid JSON." } });
          return;
        }
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await handler({ params, query, body });
      sendJson(res, result.status, result.body);
      return;
    }
    if (pathMatched) {
      sendJson(res, 405, { error: { message: `${method} is not allowed on this endpoint.` } });
      return;
    }
    sendJson(res, 404, { error: { message: "No such endpoint." } });
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: { message: `${method} is not allowed on this endpoint.` } });
    return;
  }

  if (extname(pathname)) {
    const served = await sendStatic(res, pathname);
    if (served) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const known = APP_ROUTES.some((pattern) => matchPattern(pattern, pathname));
  await sendShell(res, known ? 200 : 404);
}

export const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: "The desk system hit an unexpected problem." } });
    } else {
      res.end();
    }
    process.stderr.write(`[loanpoint] ${error && error.stack ? error.stack : error}\n`);
  });
});

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`${APP_NAME} listening on http://${HOST}:${PORT} (desk time ${nowIso()})\n`);
  });
}
