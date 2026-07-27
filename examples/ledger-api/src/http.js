// HTTP surface for the ledger fixture: routing, bearer auth, body parsing, and
// the single error envelope. All business behaviour lives in `ledger.js`; this
// layer only translates HTTP into domain calls and domain results into JSON.
//
// Every failure — auth, routing, parsing, and business rules alike — is
// `{ "error": { "code", "message", "details"? } }`, which is what the
// error-shape invariant (DESIGN §6.2) is written against.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "./ledger.js";
import { FaultSet } from "./faults.js";
import { VariantSet } from "./variants.js";
import { makeRng } from "./rng.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OPENAPI_PATH = path.join(HERE, "..", "openapi.json");

const MAX_BODY_BYTES = 1024 * 1024;
const PUBLIC_ROUTES = new Set(["/health", "/openapi.json"]);

const envelope = (code, message, details) => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

/** Read the shipped OpenAPI 3.1 document. Throws an actionable error if absent. */
export function readOpenApiDocument(file = OPENAPI_PATH) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the OpenAPI document at ${file}: ${error.message}`);
  }
}

function send(res, status, body, headers) {
  const payload = body === null ? "" : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...(headers ?? {}),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { code: "payload_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Build the request handler.
 *
 * `tokens` carries the throwaway static credentials; `faults` is the enabled
 * development-set fault list; `variants` is the enabled conforming-variant
 * list. None of the three is ever echoed back to a client. `jitterMs` (0 by
 * default) adds a bounded, pseudo-random delay before each response is
 * written — a CI-flake estimate — without changing a single byte of any
 * response body.
 */
export function createApp({
  seed = "ledger-dev-seed",
  faults = [],
  variants = [],
  jitterMs = 0,
  jitterSeed,
  tokens = {
    admin: "admin-token-dev",
    customer: "customer-token-dev",
    customerB: "customer-b-token-dev",
  },
  openapi = readOpenApiDocument(),
} = {}) {
  const ledger = new Ledger({
    seed,
    faults: faults instanceof FaultSet ? faults : new FaultSet(faults),
    variants: variants instanceof VariantSet ? variants : new VariantSet(variants),
  });

  // A PRNG dedicated to jitter, seeded independently of the ledger's own
  // identifier generator (`LEDGER_JITTER_SEED ?? \`${seed}:jitter\``), so
  // turning jitter on can never perturb an id, a timestamp, or any other
  // response content — only how long the client waits to read it. State
  // transitions still happen synchronously, in request-arrival order; only
  // the write of the already-computed response is delayed.
  const jitterRng = jitterMs > 0 ? makeRng(jitterSeed ?? `${seed}:jitter`) : null;
  const jitterDelayMs = () => (jitterRng ? Math.floor(jitterRng() * (jitterMs + 1)) : 0);

  // One bearer token per principal. `customer_a` and `customer_b` are two
  // distinct customers of the same service, which is what makes "this account
  // is not yours" a testable statement rather than a role check.
  const principalFor = (req) => {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!match) return null;
    const value = match[1].trim();
    if (value === tokens.admin) return { role: "admin", id: "admin" };
    if (value === tokens.customer) return { role: "customer", id: "customer_a" };
    if (value === tokens.customerB) return { role: "customer", id: "customer_b" };
    return null;
  };

  const isDecodable = (segment) => {
    try {
      decodeURIComponent(segment);
      return true;
    } catch {
      return false;
    }
  };

  const handler = async (req, res) => {
    // Every response leaves through here, so this is the one place jitter is
    // applied: compute the response first (state transitions happen exactly
    // where they always did), then, only for the write, wait 0..jitterMs ms.
    const write = async (status, body, headers) => {
      const delayMs = jitterDelayMs();
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      send(res, status, body, headers);
    };

    let url;
    try {
      url = new URL(req.url, "http://ledger.local");
    } catch {
      await write(400, envelope("invalid_request", "malformed request target"));
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const segments = pathname.split("/").filter(Boolean);
    // A malformed percent-encoding in a path segment ("/accounts/%") makes
    // decodeURIComponent throw below. That is a client error, not a server
    // fault: answer 400 in the standard envelope rather than letting it reach
    // the 500 handler and violate the declared "no operation answers 5xx" rule.
    if (segments.some((segment) => !isDecodable(segment))) {
      await write(400, envelope("invalid_request", "malformed percent-encoding in the request path"));
      return;
    }

    if (!PUBLIC_ROUTES.has(pathname)) {
      const principal = principalFor(req);
      if (!principal) {
        await write(401, envelope("unauthorized", "a valid Bearer token is required"), {
          "www-authenticate": 'Bearer realm="minibank"',
        });
        return;
      }
      if (segments[0] === "admin" && principal.role !== "admin") {
        await write(403, envelope("forbidden", "this operation requires the admin role"));
        return;
      }
      req.principal = principal;
    }

    let body = null;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        if (error?.code === "payload_too_large") {
          await write(413, envelope("payload_too_large", "request body exceeds 1 MiB"));
          return;
        }
        await write(400, envelope("invalid_request", "could not read the request body"));
        return;
      }
      if (raw.trim() === "") {
        body = {};
      } else {
        try {
          body = JSON.parse(raw);
        } catch {
          await write(400, envelope("invalid_json", "request body is not valid JSON"));
          return;
        }
      }
    }

    const query = url.searchParams;
    const respond = (result) => write(result.status, result.body, result.headers ?? undefined);
    const notAllowed = (allow) =>
      write(405, envelope("method_not_allowed", `${method} is not allowed on ${pathname}`, { allow }), {
        allow: allow.join(", "),
      });

    // ---- public ----
    if (pathname === "/health") {
      if (method !== "GET") return notAllowed(["GET"]);
      // Deliberately says nothing about enabled faults or variants.
      return write(200, { ok: true, service: "minibank-ledger", openapi: "/openapi.json" });
    }
    if (pathname === "/openapi.json") {
      if (method !== "GET") return notAllowed(["GET"]);
      return write(200, openapi);
    }

    // ---- admin ----
    if (pathname === "/admin/reset") {
      if (method !== "POST") return notAllowed(["POST"]);
      return respond(ledger.adminReset(body));
    }
    if (pathname === "/admin/tick") {
      if (method !== "POST") return notAllowed(["POST"]);
      // TickRequest declares additionalProperties: false and two typed
      // properties. Both are enforced: an unknown property, a non-integer
      // settle_limit, or a non-boolean advance_day is a malformed request, not
      // something to ignore or coerce.
      if (body && typeof body === "object") {
        for (const key of Object.keys(body)) {
          if (key !== "settle_limit" && key !== "advance_day") {
            return write(
              400,
              envelope("invalid_request", `unknown property "${key}"`, {
                field: key,
                allowed: ["settle_limit", "advance_day"],
              }),
            );
          }
        }
      }
      const rawSettleLimit = body && body.settle_limit !== undefined && body.settle_limit !== null
        ? body.settle_limit
        : null;
      if (rawSettleLimit !== null && (typeof rawSettleLimit !== "number" || !Number.isSafeInteger(rawSettleLimit) || rawSettleLimit < 0)) {
        return write(400, envelope("invalid_request", "settle_limit must be a non-negative integer", {
          field: "settle_limit",
        }));
      }
      const advanceDay = body?.advance_day;
      if (advanceDay !== undefined && advanceDay !== null && typeof advanceDay !== "boolean") {
        return write(400, envelope("invalid_request", "advance_day must be a boolean", { field: "advance_day" }));
      }
      return respond(ledger.tick({ settleLimit: rawSettleLimit, advanceDay: advanceDay === true }));
    }

    // Every domain call below is made on behalf of the resolved principal.
    const principal = req.principal;

    // ---- accounts ----
    if (segments[0] === "accounts") {
      if (segments.length === 1) {
        if (method === "POST") return respond(ledger.createAccount(body, { principal }));
        if (method === "GET") {
          return respond(
            ledger.listAccounts({
              limit: query.get("limit"),
              cursor: query.get("cursor"),
              includeClosed: query.get("include_closed") === "true",
              principal,
            }),
          );
        }
        return notAllowed(["GET", "POST"]);
      }
      const id = decodeURIComponent(segments[1]);
      if (segments.length === 2) {
        if (method === "GET") return respond(ledger.getAccount(id, { principal }));
        return notAllowed(["GET"]);
      }
      if (segments.length === 3 && segments[2] === "activate") {
        if (method !== "POST") return notAllowed(["POST"]);
        return respond(ledger.activateAccount(id, { principal }));
      }
      if (segments.length === 3 && segments[2] === "close") {
        if (method !== "POST") return notAllowed(["POST"]);
        return respond(ledger.closeAccount(id, { principal }));
      }
      if (segments.length === 3 && segments[2] === "entries") {
        if (method !== "GET") return notAllowed(["GET"]);
        return respond(
          ledger.listEntries(id, { limit: query.get("limit"), cursor: query.get("cursor"), principal }),
        );
      }
    }

    // ---- deposits ----
    if (segments[0] === "deposits") {
      if (segments.length === 1) {
        if (method !== "POST") return notAllowed(["POST"]);
        return respond(ledger.createDeposit(body, { principal }));
      }
      if (segments.length === 2) {
        if (method !== "GET") return notAllowed(["GET"]);
        return respond(ledger.getDeposit(decodeURIComponent(segments[1]), { principal }));
      }
    }

    // ---- transfers ----
    if (segments[0] === "transfers") {
      if (segments.length === 1) {
        if (method === "POST") {
          const key = req.headers["idempotency-key"];
          return respond(
            ledger.createTransfer(body, {
              idempotencyKey: typeof key === "string" && key.trim() ? key.trim() : null,
              principal,
            }),
          );
        }
        if (method === "GET") {
          return respond(
            ledger.listTransfers({
              limit: query.get("limit"),
              cursor: query.get("cursor"),
              accountId: query.get("account_id") ?? undefined,
              principal,
            }),
          );
        }
        return notAllowed(["GET", "POST"]);
      }
      const id = decodeURIComponent(segments[1]);
      if (segments.length === 2) {
        if (method !== "GET") return notAllowed(["GET"]);
        return respond(ledger.getTransfer(id, { principal }));
      }
      if (segments.length === 3 && segments[2] === "cancel") {
        if (method !== "POST") return notAllowed(["POST"]);
        return respond(ledger.cancelTransfer(id, { principal }));
      }
    }

    return write(404, envelope("not_found", `no route for ${method} ${pathname}`));
  };

  const guarded = (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        // The fixture never leaks stacks; an unexpected throw is still an
        // envelope, so the 500 itself is the only signal.
        if (!res.headersSent) send(res, 500, envelope("internal_error", "the request could not be completed"));
        else res.end();
        void error;
      });
  };

  guarded.ledger = ledger;
  return guarded;
}

/** Create (but do not listen on) the fixture's HTTP server. */
export function createServer(options = {}) {
  const app = createApp(options);
  const server = http.createServer(app);
  server.app = app;
  server.ledger = app.ledger;
  return server;
}

/** Start the fixture on `port`/`host`; resolves once it is accepting requests. */
export async function startServer({ port = 0, host = "127.0.0.1", ...options } = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  return {
    server,
    ledger: server.ledger,
    port: address.port,
    url,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
