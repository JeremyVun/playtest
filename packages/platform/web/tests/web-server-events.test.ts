import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeServerEvent } from "../src/lib/server-events.js";

test("server events decode retry status and JSON data", () => {
  assert.deepEqual(
    decodeServerEvent('event: retry\ndata: {"attempt":2,"max_attempts":3}'),
    { event: "retry", data: { attempt: 2, max_attempts: 3 } },
  );
});

test("server events accept CRLF, multiline data and ignore comments", () => {
  assert.deepEqual(
    decodeServerEvent(': keepalive\r\nevent: result\r\ndata: {"reply":\r\ndata: "done"}'),
    { event: "result", data: { reply: "done" } },
  );
  assert.equal(decodeServerEvent(": keepalive"), null);
});
