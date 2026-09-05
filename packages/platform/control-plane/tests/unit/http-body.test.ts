import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readRawBody } from "../../src/http.ts";

test("a cancelled upload rejects even when cancellation precedes the queued body reader", { timeout: 3000 }, async () => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as import("node:net").AddressInfo;
  const request = http.request({ hostname: "127.0.0.1", port, method: "PUT", headers: { "content-length": "100" } });
  request.on("error", () => {});
  try {
    const incoming = once(server, "request");
    request.write("partial");
    const [req] = await incoming;
    const closed = once(req, "close").catch(() => {});
    request.destroy();
    await closed;
    await assert.rejects(readRawBody(req), /request ended/);
  } finally {
    request.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
