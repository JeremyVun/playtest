// A zero-dependency widget registry for the S2 authoring tests
// (docs/contracts/scripts.md#the-authoring-loop). In-process, offline, seeded,
// and disposable — the shape of target a DESIGN §4 step 2 authorization covers.
//
// It exists to exercise three things the authoring loop needs a real service
// for, and nothing else:
//
//   1. **Spec provisioning.** `spec: "path"` serves the document at the
//      conventional `/openapi.json`; `spec: "link"` hides it at an unconventional
//      path and announces it with a `Link: …; rel="service-desc"` header on the
//      root; `spec: "none"` exposes nothing, so a run must be told where the
//      document is.
//   2. **A seeded semantic fault.** `faults.republishSucceeds` makes
//      `POST /widgets/{id}/publish` answer 200 for an already-published widget
//      instead of 409. It is invisible to the HAR column — 200 is a documented
//      status for that operation and the body matches its schema — so only an
//      authored check that knows the lifecycle rule can catch it. That is the
//      whole thesis of the script-authoring direction in one toggle.
//   3. **A reset.** `POST /admin/reset` restores the seeded state, so every
//      execution starts from the same place and a replay is comparable.
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const SPEC = fileURLToPath(new URL("./openapi.json", import.meta.url));
/** The unconventional location `spec: "link"` serves the document from. */
export const LINKED_SPEC_PATH = "/internal/service-description";

const send = (res: LegacyTestValue, status: LegacyTestValue, body: LegacyTestValue, headers = {}) => {
  if (body === null) {
    res.writeHead(status, { "content-length": 0, ...headers });
    res.end();
    return;
  }
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), ...headers });
  res.end(data);
};

const readBody = (req: LegacyTestValue): Promise<LegacyTestValue> =>
  new Promise<LegacyTestValue>((resolve) => {
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

const envelope = (code: LegacyTestValue, message: LegacyTestValue) => ({ error: { code, message } });

/**
 * @param {{ spec?: "path"|"link"|"none", faults?: { republishSucceeds?: boolean },
 *           prefix?: string }} [options]
 * @returns {Promise<{ url, origin, requests, faults, close }>}
 */
export async function startAuthoringApi({ spec = "path", faults = {}, prefix = "w" }: LegacyTestValue = {}) {
  const specText = fs.readFileSync(SPEC, "utf8");
  const requests: LegacyTestValue = [];
  let widgets = new Map();
  let next = 1;

  const seed = () => {
    widgets = new Map();
    next = 1;
    for (const [name, status] of [["seeded draft", "draft"], ["seeded published", "published"]]) {
      const id = `${prefix}_${next++}`;
      widgets.set(id, { id, name, status, created_at: "2026-01-01T00:00:00.000Z" });
    }
  };
  seed();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"); // TODO(ts): Node requests always carry a URL here
    const segments = url.pathname.split("/").filter(Boolean);
    requests.push({ method: req.method, path: url.pathname });

    if (url.pathname === "/" ) {
      const headers = spec === "link" ? { link: `<${LINKED_SPEC_PATH}>; rel="service-desc"` } : {};
      return send(res, 200, { service: "widget-registry" }, headers);
    }
    if (url.pathname === "/openapi.json") {
      if (spec !== "path") return send(res, 404, envelope("not_found", "no route GET /openapi.json"));
      return send(res, 200, specText);
    }
    if (url.pathname === LINKED_SPEC_PATH) {
      if (spec !== "link") return send(res, 404, envelope("not_found", `no route GET ${LINKED_SPEC_PATH}`));
      return send(res, 200, specText);
    }
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/admin/reset" && req.method === "POST") {
      seed();
      return send(res, 204, null);
    }

    if (segments[0] === "widgets" && segments.length === 1) {
      if (req.method === "GET") {
        const status = url.searchParams.get("status");
        if (status !== null && !["draft", "published"].includes(status)) {
          return send(res, 400, envelope("invalid_status", `status must be draft or published, got ${JSON.stringify(status)}`));
        }
        const all = [...widgets.values()].reverse();
        return send(res, 200, { widgets: status ? all.filter((widget) => widget.status === status) : all });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body.name !== "string" || !body.name.trim()) {
          return send(res, 422, envelope("invalid_name", "name is required and must be a non-empty string"));
        }
        const widget = { id: `${prefix}_${next++}`, name: body.name, status: "draft", created_at: new Date().toISOString() };
        widgets.set(widget.id, widget);
        return send(res, 201, widget);
      }
    }

    if (segments[0] === "widgets" && segments.length === 2) {
      const widget = widgets.get(segments[1]);
      if (req.method === "GET") return widget ? send(res, 200, widget) : send(res, 404, envelope("not_found", "no such widget"));
      if (req.method === "DELETE") {
        if (!widget) return send(res, 404, envelope("not_found", "no such widget"));
        widgets.delete(widget.id);
        return send(res, 204, null);
      }
    }

    if (segments[0] === "widgets" && segments.length === 3 && segments[2] === "publish" && req.method === "POST") {
      const widget = widgets.get(segments[1]);
      if (!widget) return send(res, 404, envelope("not_found", "no such widget"));
      if (widget.status === "published" && !faults.republishSucceeds) {
        return send(res, 409, envelope("already_published", "this widget is already published"));
      }
      widget.status = "published";
      return send(res, 200, widget);
    }

    return send(res, 404, envelope("not_found", `no route ${req.method} ${url.pathname}`));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port }: LegacyTestValue = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: origin,
    origin,
    requests,
    faults,
    specPath: spec,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** The approved rule statements a test hands the authoring loop for this fixture. */
export const AUTHORING_RULES = Object.freeze([
  Object.freeze({
    id: "lifecycle",
    title: "Publication is one-way and refuses repetition",
    statement: "A widget is created in status \"draft\", publishing moves it to \"published\", and publishing an already-published widget is refused with 409.",
    applicability: "Every widget, however it was created.",
  }),
  Object.freeze({
    id: "deletion",
    title: "A deleted widget is gone",
    statement: "A deleted widget answers 404 on read and does not appear in the listing.",
  }),
]);
