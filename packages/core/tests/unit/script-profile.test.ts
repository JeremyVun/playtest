// The mechanical risk profile (docs/contracts/scripts.md#risk-profile). Pure and
// model-free: the whole point is that a reviewer's summary of what a script does
// cannot be a guess. These cases feed it HAR entries directly, so they also pin
// the HAR-shape adapter both the profile and the gate column share.
import { test } from "node:test";
import assert from "node:assert/strict";

import { profileScript, staticProfile, templatePath, traceFromHar } from "../../src/public/api-suite-scripts.ts";

const BASE = "http://127.0.0.1:4181";

/** A HAR 1.2 entry, as the script recorder writes them. */
const entry = ({ method = "GET", path = "/items", status = 200, body = null, requestHeaders = {} }: LegacyTestValue): LegacyTestValue => ({
  startedDateTime: "2026-07-26T00:00:00.000Z",
  time: 1,
  request: {
    method,
    url: `${BASE}${path}`,
    httpVersion: "HTTP/1.1",
    headers: Object.entries(requestHeaders).map(([name, value]) => ({ name, value })),
    queryString: [],
    cookies: [],
    headersSize: -1,
    bodySize: 0,
  },
  response: {
    status,
    statusText: "",
    httpVersion: "HTTP/1.1",
    headers: [{ name: "content-type", value: "application/json" }],
    cookies: [],
    content: { size: body ? body.length : 0, mimeType: "application/json", ...(body ? { text: body } : {}) },
    redirectURL: "",
    headersSize: -1,
    bodySize: body ? body.length : -1,
  },
  cache: {},
  timings: { send: 0, wait: 1, receive: 0 },
});

test("a read-only script is classified read-only, with its endpoints listed", () => {
  const profile = profileScript({
    source: 'export default async function ({ client }) { await client.get("/items"); }\n',
    harEntries: [
      entry({ path: "/items", body: '{"items":[]}' }),
      entry({ path: "/items?limit=2", body: '{"items":[]}' }),
      entry({ path: "/items/it_item_1", body: '{"id":"it_item_1"}' }),
      entry({ method: "HEAD", path: "/health", status: 200 }),
    ],
    budget: 40,
  });

  assert.equal(profile.mutation.classification, "read-only");
  assert.equal(profile.mutation.writes, 0);
  assert.equal(profile.mutation.deletes, 0);
  assert.equal(profile.requests.total, 4);
  assert.equal(profile.requests.budget, 40);
  assert.deepEqual(profile.requests.methods, { GET: 3, HEAD: 1 });
  assert.deepEqual(
    profile.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    ["HEAD /health", "GET /items", "GET /items/{id}"],
    "concrete ids collapse to the route template, query strings are not routes",
  );
  assert.equal(profile.endpoints.find((endpoint) => endpoint.path === "/items").count, 2);
  assert.equal(profile.data_created.count, 0);
});

test("a mutating script is classified by its strongest verb and counts what it created", () => {
  const writes = profileScript({
    harEntries: [
      entry({ method: "POST", path: "/items", status: 201, body: '{"id":"it_item_1","name":"a"}' }),
      entry({ method: "POST", path: "/items", status: 201, body: '{"id":"it_item_2","name":"b"}' }),
      entry({ method: "POST", path: "/items", status: 422, body: '{"error":{"code":"invalid"}}' }),
      entry({ path: "/items/it_item_1", body: '{"id":"it_item_1"}' }),
    ],
  });
  assert.equal(writes.mutation.classification, "writes");
  assert.equal(writes.mutation.writes, 3);
  assert.equal(writes.data_created.count, 2, "a refused create created nothing");
  assert.deepEqual(writes.data_created.ids, ["it_item_1", "it_item_2"]);
  assert.deepEqual(writes.data_created.by_collection, { "/items": 2 });
  assert.deepEqual(
    writes.resources.map((resource) => [resource.collection, resource.reads, resource.writes, resource.created]),
    [["/items", 1, 3, 2]],
  );

  const deletes = profileScript({ harEntries: [entry({ method: "DELETE", path: "/items/it_item_1", status: 204 })] });
  assert.equal(deletes.mutation.classification, "deletes", "a delete outranks a write in the headline");
  assert.equal(deletes.mutation.deletes, 1);
});

test("secret usage is reported by name from the recorded placeholder, never by value", () => {
  const profile = profileScript({
    source: 'export default async function ({ client }) { await client.get("/whoami", { headers: { authorization: client.secret("API_TOKEN") } }); }\n',
    harEntries: [entry({ path: "/whoami", requestHeaders: { authorization: "[secret:API_TOKEN]" } })],
    secretNames: ["API_TOKEN", "UNUSED_TOKEN"],
  });

  assert.deepEqual(profile.secret_references.declared, ["API_TOKEN", "UNUSED_TOKEN"]);
  assert.deepEqual(profile.secret_references.in_source, ["API_TOKEN"]);
  assert.deepEqual(profile.secret_references.used, ["API_TOKEN"], "a declared-but-unused secret is visibly unused");
});

test("guard events surface as out-of-origin attempts and refusal counts", () => {
  const profile = profileScript({
    harEntries: [entry({ path: "/items" })],
    guardEvents: [
      { code: "off_origin", method: "GET", path: "https://evil.example/steal", detail: "refused: outside the target origin" },
      { code: "read_only", method: "POST", path: "/items", detail: "refused: this run is read-only" },
      { code: "read_only", method: "DELETE", path: "/items/it_1", detail: "refused: this run is read-only" },
    ],
  });

  assert.equal(profile.out_of_origin_attempts.length, 1);
  assert.equal(profile.out_of_origin_attempts[0].path, "https://evil.example/steal");
  assert.equal(profile.refused.off_origin, 1);
  assert.equal(profile.refused.read_only, 2);
  assert.equal(profile.requests.total, 1, "a refused request is not traffic");
});

test("templatePath collapses ids the API announced and the standard id shapes", () => {
  const announced = new Set(["weird-looking-name"]);
  assert.equal(templatePath("/accounts/acc_9fh2k1/entries", new Set()), "/accounts/{id}/entries");
  assert.equal(templatePath("/orders/42", new Set()), "/orders/{id}");
  assert.equal(templatePath("/users/1f8c0f4e-1b6a-4e5d-9b8f-2a3c4d5e6f70", new Set()), "/users/{id}");
  assert.equal(templatePath("/things/weird-looking-name", announced), "/things/{id}", "an announced id is an id whatever it looks like");
  assert.equal(templatePath("/items", new Set()), "/items", "a collection is not an id");
});

test("the static half reads secret references and imports without executing anything", () => {
  const profile = staticProfile(
    'import { setTimeout } from "node:timers/promises";\nimport helper from "./helper.mjs";\n' + // specifier-resolution-ignore: fixture text

      'export default async function ({ client }) { await client.get("/x", { headers: { a: { $secret: "A_TOKEN" } } }); }\n',
  );
  assert.deepEqual(profile.imports, ["./helper.mjs", "node:timers/promises"]);
  assert.deepEqual(profile.secret_references, ["A_TOKEN"]);
  assert.equal(profile.lines, 4);
});

test("traceFromHar reads HAR 1.2 and the drivers' reduced shape alike", () => {
  const har12 = traceFromHar([entry({ method: "POST", path: "/items", status: 201, body: '{"id":"it_1"}' })]);
  const reduced = traceFromHar([
    {
      startedDateTime: "2026-07-26T00:00:00.000Z",
      time: 1,
      request: { method: "POST", url: `${BASE}/items`, headers: { "content-type": "application/json" }, body: '{"name":"a"}' },
      response: { status: 201, bodySize: 13, mimeType: "application/json", headers: { "content-type": "application/json" }, body: '{"id":"it_1"}' },
    },
  ]);

  for (const [label, trace] of [["har 1.2", har12], ["reduced", reduced]]) {
    assert.equal(trace[0].method, "POST", label);
    assert.equal(trace[0].path, "/items", label);
    assert.equal(trace[0].status, 201, label);
    assert.equal(trace[0].mime, "application/json", label);
    assert.equal(trace[0].body, '{"id":"it_1"}', label);
    assert.equal(trace[0].index, 0, label);
  }
  assert.equal(reduced[0].requestBody, '{"name":"a"}');
});
