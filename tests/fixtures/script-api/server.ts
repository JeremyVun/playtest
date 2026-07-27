// A zero-dependency loopback API for the script substrate's tests
// (docs/contracts/scripts.md). In-process, offline, and deliberately hostile in
// one specific way: `GET /whoami` ECHOES the Authorization header it received, so
// a test can prove that an injected credential is scrubbed out of every persisted
// artifact rather than merely never written by the harness.
//
// Routes:
//   GET    /health           { ok: true }
//   GET    /whoami           401 without a bearer token; 200 { seen } with one
//   GET    /items            { items: [...] }
//   POST   /items            201 { id, name }
//   GET    /items/{id}       200 | 404 envelope
//   DELETE /items/{id}       204 | 404 envelope
//   GET    /boom             500 (for the HAR gate column)
//   GET    /bare-error       400 with a NON-envelope body
//   POST   /admin/reset      204, the harness-owned reset a target may declare
//                            (503 when the fixture is started with `resetFails`)
import http from "node:http";

function send(res: LegacyTestValue, status: LegacyTestValue, body: LegacyTestValue) {
  if (body === null) {
    res.writeHead(status, { "content-length": 0 });
    res.end();
    return;
  }
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req: LegacyTestValue): Promise<LegacyTestValue> {
  return new Promise<LegacyTestValue>((resolve) => {
    let data = "";
    req.on("data", (chunk: LegacyTestValue) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

const envelope = (code: LegacyTestValue, message: LegacyTestValue) => ({ error: { code, message } });

/**
 * @param {{ token?: string, prefix?: string }} [options] `token` is the bearer
 *   value `/whoami` accepts.
 * @returns {Promise<{ url, origin, requests, close }>}
 */
export async function startScriptApi({ token = "s3cret-token-value-abc123", prefix = "it", resetFails = false }: LegacyTestValue = {}) {
  const items = new Map();
  const requests: LegacyTestValue = [];
  let next = 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"); // SAFETY: Node requests always carry a URL here
    const segments = url.pathname.split("/").filter(Boolean);
    requests.push({ method: req.method, path: url.pathname, headers: { ...req.headers } });

    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/admin/reset" && req.method === "POST") {
      if (resetFails) return send(res, 503, envelope("reset_unavailable", "the reset affordance is down"));
      items.clear();
      return send(res, 204, null);
    }
    if (url.pathname === "/boom") return send(res, 500, envelope("boom", "the fixture fell over on purpose"));
    if (url.pathname === "/bare-error") return send(res, 400, { message: "no envelope here" });
    if (url.pathname === "/whoami") {
      const seen = req.headers.authorization ?? null;
      if (seen !== `Bearer ${token}`) {
        res.setHeader("www-authenticate", 'Bearer realm="script-api"');
        return send(res, 401, envelope("unauthorized", "a bearer token is required"));
      }
      // The echo: a real API that reflects its own auth header back at the caller.
      return send(res, 200, { ok: true, seen });
    }
    if (segments[0] === "items") {
      if (req.method === "GET" && segments.length === 1) {
        return send(res, 200, { items: [...items.values()] });
      }
      if (req.method === "POST" && segments.length === 1) {
        const body = await readBody(req);
        if (!body || typeof body.name !== "string") return send(res, 422, envelope("invalid", "name is required"));
        const item = { id: `${prefix}_item_${next++}`, name: body.name };
        items.set(item.id, item);
        return send(res, 201, item);
      }
      if (segments.length === 2) {
        const item = items.get(segments[1]);
        if (req.method === "GET") return item ? send(res, 200, item) : send(res, 404, envelope("not_found", "no such item"));
        if (req.method === "DELETE") {
          if (!item) return send(res, 404, envelope("not_found", "no such item"));
          items.delete(item.id);
          return send(res, 204, null);
        }
      }
    }
    return send(res, 404, envelope("not_found", `no route ${req.method} ${url.pathname}`));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port }: LegacyTestValue = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: origin,
    origin,
    token,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
