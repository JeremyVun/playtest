// The two halves of a hygienic API baseline — the normalized response projection
// and the redacted request program — plus the acceptance leak scan that decides
// what may be committed. See docs/contracts/artifacts.md#baseline-files.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { API_PROJECTION_MARKER } from "../../../src/core/trajectory.ts";
import { mergeHeaders, projectApiSnapshot, redactRequestAction, shapeOf } from "../../../src/core/drivers/api.ts";
import { entropyBitsPerChar, looksLikeCredential, projectionShape, scanEnvelopes } from "../../../src/core/baseline-scan.ts";
import { registerSecretValue, resetSecrets } from "../../../src/core/secrets.ts";

const snapshot = (body: string) => `API: http://127.0.0.1:9\n[e1] POST /items — create\n\nLast response: 201 application/json\n${body}`;
const stripeLikeToken = ["sk", "live", "4kQ9zVn2XbR7tLpW8mHc3JdY"].join("_");

beforeEach(() => resetSecrets());
afterEach(() => resetSecrets());

test("the projection keeps status and shape, never values", () => {
  const out = projectApiSnapshot(snapshot('{\n "id": "itm_1",\n "tags": ["a", "b"],\n "paid": true,\n "note": null\n}'));
  assert.match(out, /^API: http:\/\/127\.0\.0\.1:9\n\[e1\] POST \/items — create\n\nLast response: 201 application\/json\n/);
  assert.ok(out.includes(API_PROJECTION_MARKER));
  assert.ok(out.endsWith('{"id":"string","note":"null","paid":"boolean","tags":["string","string"]}'));
  assert.ok(!out.includes("itm_1"), "no raw value survives");
});

test("shape is deterministic: keys sort, arrays keep their length", () => {
  assert.deepEqual(shapeOf({ b: 1, a: "x" }), { a: "string", b: "number" });
  assert.deepEqual(shapeOf([1, 2, 3]), ["number", "number", "number"], "a missing list entry is still behavioral drift");
  assert.deepEqual(shapeOf([]), []);
  assert.equal(JSON.stringify(shapeOf({ b: 1, a: 2 })), JSON.stringify(shapeOf({ a: 2, b: 1 })));
});

test("projection is idempotent, so both sides of a drift comparison can be projected blindly", () => {
  const once = projectApiSnapshot(snapshot('{"id":"itm_1"}'));
  assert.equal(projectApiSnapshot(once), once, "re-projecting must not turn the shape into a shape of a shape");
});

test("a snapshot with no response, a non-JSON body, and an empty body all project safely", () => {
  const head = "API: http://127.0.0.1:9\n(no OpenAPI spec — infer endpoints from the task; a request is one action)";
  assert.equal(projectApiSnapshot(head), head, "nothing to project before the first response");
  assert.match(projectApiSnapshot(snapshot("plain text: alice@example.com")), /\(non-json body: 29 chars\)/);
  assert.ok(!projectApiSnapshot(snapshot("plain text: alice@example.com")).includes("alice@"), "free text never survives");
  assert.match(projectApiSnapshot(snapshot("(no body)")), /\(no body\)/);
});

test("redaction-listed projection paths are shape-normalized out", () => {
  const body = '{"balances_by_email":{"alice@example.com":10},"count":1}';
  const out = projectApiSnapshot(snapshot(body), ["$.balances_by_email"]);
  assert.ok(out.endsWith('{"balances_by_email":"[redacted]","count":"number"}'));
  assert.ok(!out.includes("alice@example.com"));
  // A list path steps into every element.
  const nested = projectApiSnapshot(snapshot('{"items":[{"email":"a@b.co","id":"x"}]}'), ["$.items[*].email"]);
  assert.ok(nested.endsWith('{"items":[{"email":"[redacted]","id":"string"}]}'));
  // A path this response does not carry is inert.
  assert.ok(projectApiSnapshot(snapshot('{"count":1}'), ["$.absent"]).endsWith('{"count":"number"}'));
});

test("the recorded action becomes a redacted request program that still names its values", () => {
  registerSecretValue("Bearer tok-abcdefgh", "LEDGER_TOKEN");
  const action = {
    type: "request",
    method: "POST",
    path: "/items",
    headers: { "Idempotency-Key": "k-1", Authorization: "Bearer tok-abcdefgh" },
    body: { name: "widget", owner_email: "alice@example.com" },
  };
  const out: LegacyTestValue = redactRequestAction(action, [{ path: "body.owner_email", secret: "OWNER_EMAIL" }]);
  assert.deepEqual(out.headers.Authorization, { $secret: "LEDGER_TOKEN" }, "an injected value goes back to its reference");
  assert.equal(out.headers["Idempotency-Key"], "k-1", "non-secret values stay literal so acting replays them");
  assert.deepEqual(out.body, { name: "widget", owner_email: { $secret: "OWNER_EMAIL" } });
  assert.equal(action.body.owner_email, "alice@example.com", "the executable action is not mutated in place");

  // Already-templated input is stable, non-request actions pass through, and a
  // path the request does not carry is inert.
  assert.deepEqual(redactRequestAction(out, [{ path: "body.owner_email", secret: "OWNER_EMAIL" }]), out);
  const done = { type: "done", summary: "ok" };
  assert.equal(redactRequestAction(done, [{ path: "body.x", secret: "X" }]), done);
  const bare = { type: "request", method: "GET", path: "/items" };
  assert.equal(redactRequestAction(bare, [{ path: "body.owner_email", secret: "OWNER_EMAIL" }]), bare);
  // A string body is opaque to field paths; a whole-body entry still applies.
  const stringBody = { type: "request", method: "POST", path: "/x", body: "raw=1" };
  assert.equal(redactRequestAction(stringBody, [{ path: "body.a", secret: "A" }]).body, "raw=1");
  assert.deepEqual(redactRequestAction(stringBody, [{ path: "body", secret: "A" }]).body, { $secret: "A" });
});

test("configured headers merge under the action's own, case-insensitively", () => {
  assert.deepEqual(mergeHeaders({ Authorization: "cfg", "X-Tenant": "acme" }, { authorization: "action" }), {
    "X-Tenant": "acme",
    authorization: "action",
  });
  assert.deepEqual(mergeHeaders(null, { A: "1" }), { A: "1" });
  assert.deepEqual(mergeHeaders({ A: "1" }, null), { A: "1" });
});

test("the credential rule fires on tokens and spares ordinary identifiers", () => {
  assert.ok(looksLikeCredential(stripeLikeToken));
  assert.ok(looksLikeCredential("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
  assert.ok(!looksLikeCredential("01J8ZQ7X9K2M4N6P8R0T2V4W6Y"), "a ULID is not a credential");
  assert.ok(!looksLikeCredential("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "nor is a UUID");
  assert.ok(!looksLikeCredential("short"));
  assert.ok(entropyBitsPerChar("aaaaaaaa") < entropyBitsPerChar("a8Fq2Zx9"));
});

test("the scan reads request templates and projections, and spares web trajectories", () => {
  const envelope = (over: LegacyTestValue): LegacyTestValue => ({ step: 1, agent: { action: { type: "request", method: "POST", path: "/x", ...over } } });
  const withProjection = (body: string): LegacyTestValue => ({ step: 2, snapshot_text: `Last response: 200\n${API_PROJECTION_MARKER}\n${body}` });

  const credential: LegacyTestValue = scanEnvelopes([envelope({ headers: { Authorization: stripeLikeToken } })], { driver: "api" });
  assert.equal(credential.length, 1);
  assert.equal(credential[0].rule, "entropy");
  assert.equal(credential[0].field, "headers.Authorization");

  const email: LegacyTestValue = scanEnvelopes([withProjection('{"balances_by_email":{"alice@example.com":"number"}}')], { driver: "api" });
  assert.equal(email.length, 1);
  assert.equal(email[0].rule, "data");
  assert.match(email[0].detail, /alice@example\.com/);

  // Same content under the web driver: no entropy/data findings, because web
  // trajectories are full of hashes and user-visible text.
  assert.deepEqual(scanEnvelopes([envelope({ headers: { Authorization: stripeLikeToken } })], { driver: "web" }), []);

  // A clean api trajectory is clean: ids and normal values do not trip the scan.
  assert.deepEqual(
    scanEnvelopes([envelope({ headers: { "Idempotency-Key": "k-1" }, body: { name: "widget", id: "01J8ZQ7X9K2M4N6P8R0T2V4W6Y" } }), withProjection('{"id":"string"}')], {
      driver: "api",
    }),
    [],
  );
});

test("the scan is the backstop for injected secrets and for declared-but-unredacted fields", () => {
  registerSecretValue("Bearer tok-abcdefgh", "LEDGER_TOKEN");
  const leaked = scanEnvelopes([{ step: 1, agent: { action: { type: "request", method: "GET", path: "/x", headers: { Authorization: "Bearer tok-abcdefgh" } } } }], {
    driver: "api",
  });
  assert.ok(leaked.some((f) => f.rule === "secret" && /LEDGER_TOKEN/.test(f.detail)), JSON.stringify(leaked));

  const redact = { request: [{ path: "body.owner_email", secret: "OWNER_EMAIL" }], projection: ["$.email"] };
  const unredacted = scanEnvelopes([{ step: 1, agent: { action: { type: "request", method: "POST", path: "/x", body: { owner_email: "a@b.co" } } } }], {
    driver: "api",
    redact,
  });
  assert.ok(unredacted.some((f) => f.rule === "redaction" && f.field === "body.owner_email"), JSON.stringify(unredacted));
  // Templated correctly: no redaction finding.
  const templated = scanEnvelopes([{ step: 1, agent: { action: { type: "request", method: "POST", path: "/x", body: { owner_email: { $secret: "OWNER_EMAIL" } } } } }], {
    driver: "api",
    redact,
  });
  assert.deepEqual(templated, []);
  // The redaction rule applies on every driver, not just api.
  assert.equal(
    scanEnvelopes([{ step: 1, action: { type: "request", method: "POST", path: "/x", body: { owner_email: "a@b.co" } } }], { driver: "mobile", redact }).length,
    1,
  );
});

test("projectionShape reads only a real projection block", () => {
  assert.deepEqual(projectionShape(`x\n${API_PROJECTION_MARKER}\n{"a":"string"}`), { a: "string" });
  assert.equal(projectionShape("Last response: 200\n{\"a\":1}"), null, "a legacy raw body is not a projection");
  assert.equal(projectionShape(`x\n${API_PROJECTION_MARKER}\n(no body)`), null);
  assert.equal(projectionShape(undefined), null);
});
