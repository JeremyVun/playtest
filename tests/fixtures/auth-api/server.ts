// A zero-dependency HTTP API that REQUIRES a bearer token. It exists so the
// secrets and baseline-hygiene tests have an authenticated target: without one,
// "acting a baseline recorded with secret references works" cannot be proven.
// It is a fixture, not a product — and deliberately tiny.
//
// Deterministic by construction: ids come from a counter, timestamps are fixed,
// and no wall clock or randomness enters a response — so two runs against a
// fresh instance produce identical response projections and a replay is stable.
import http from "node:http";

function json(res: LegacyTestValue, status: LegacyTestValue, body: LegacyTestValue) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req: LegacyTestValue): Promise<LegacyTestValue> {
  return new Promise<LegacyTestValue>((resolve, reject) => {
    let data = "";
    req.on("data", (c: LegacyTestValue) => (data += c));
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

/**
 * @param {{ token: string }} options the bearer token every authenticated route
 *   demands. Throwaway, supplied per test — never a real credential.
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: object[] }>}
 */
export async function startAuthApi({ token }: LegacyTestValue) {
  let nextId = 1;
  const items: LegacyTestValue = [];
  const byIdempotencyKey = new Map();
  const requests: LegacyTestValue = []; // what the server actually received, for assertions

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"); // TODO(ts): Node requests always carry a URL here
    const auth = req.headers.authorization ?? "";
    requests.push({ method: req.method, path: url.pathname, headers: { ...req.headers } });

    // The root is unauthenticated so the harness health probe can reach it.
    if (url.pathname === "/") return json(res, 200, { service: "auth-api" });

    if (auth !== `Bearer ${token}`) {
      return json(res, 401, { error: { code: "unauthorized", message: "a valid bearer token is required" } });
    }

    // Echoes the caller's own credential — the case a write-time scrub must
    // cover, since a server may hand a token straight back.
    if (req.method === "GET" && url.pathname === "/whoami") {
      return json(res, 200, { token, role: "customer" });
    }

    // Application data keyed BY EMAIL: values-free shape projection still
    // carries the key structure, so this leaks unless it is redacted.
    if (req.method === "GET" && url.pathname === "/balances") {
      return json(res, 200, { balances_by_email: { "alice@example.com": 1200, "bob@example.com": 300 } });
    }

    if (req.method === "GET" && url.pathname === "/items") {
      return json(res, 200, { items, count: items.length });
    }

    if (req.method === "POST" && url.pathname === "/items") {
      let body;
      try {
        body = await readBody(req);
      } catch (e: LegacyTestValue) {
        return json(res, 400, { error: { code: "bad_request", message: e.message } });
      }
      requests[requests.length - 1].body = body; // what the client actually sent
      const key = req.headers["idempotency-key"];
      if (typeof key === "string" && byIdempotencyKey.has(key)) {
        return json(res, 201, byIdempotencyKey.get(key));
      }
      if (typeof body?.name !== "string" || !body.name) {
        return json(res, 422, { error: { code: "invalid", message: "name is required" } });
      }
      const item = {
        id: `itm_${nextId++}`,
        name: body.name,
        owner_email: typeof body.owner_email === "string" ? body.owner_email : null,
        created_at: "2026-01-01T00:00:00.000Z",
      };
      items.push(item);
      if (typeof key === "string") byIdempotencyKey.set(key, item);
      return json(res, 201, item);
    }

    return json(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port }: LegacyTestValue = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
