// OpenAPI ingestion: what the enriched document carries, and the hermetic
// boundary it resolves inside (docs/contracts/engine.md#openapi-ingestion).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DummyConfigError } from "../../../src/core/config.ts";
import { loadOpenApi, operationLine, parseOperationSelector, pathTemplateToRegExp, selectorSpec } from "../../../src/core/openapi.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const SPEC = path.join(FIXTURES, "replay-api/openapi.yaml");

let tmp: LegacyTestValue;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-openapi-"));
});
after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a spec (plus optional siblings) into a fresh directory and load it. */
function withSpec(name: string, files: Record<string, string>) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
  return path.join(dir, "openapi.yaml");
}

const MINIMAL = (paths: string) => `openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths:\n${paths}`;

test("enrichment resolves internal and suite-local refs into parameters, schemas, statuses, links, and security", () => {
  const spec: LegacyTestValue = loadOpenApi(SPEC);

  const create = spec.operations.find((o: LegacyTestValue) => o.method === "POST" && o.path === "/accounts");
  assert.equal(create.operation_id, "createAccount");
  // The request schema came through an internal $ref...
  assert.deepEqual(Object.keys(create.request_body.content["application/json"].schema.properties), ["owner"]);
  assert.equal(create.request_body.required, true);
  // ...and the response schema through a suite-local FILE ref.
  const account = create.responses["201"].content["application/json"].schema;
  assert.ok(account.properties.balance, "the file-ref'd Account schema resolved");
  assert.deepEqual(create.status_codes, ["201", "422"], "declared statuses are Tier-1 material for the gate");

  const read = spec.operations.find((o: LegacyTestValue) => o.path === "/accounts/{accountId}" && o.method === "GET");
  assert.deepEqual(read.parameters, [
    { name: "accountId", in: "path", required: true, description: "The account's opaque identifier.", schema: { type: "string" } },
  ], "path-level $ref'd parameters are merged into the operation");
  assert.equal(read.responses["404"].content["application/json"].schema.properties.error.type, "object", "a $ref'd response component resolved");

  assert.deepEqual(spec.links.map((l: LegacyTestValue) => l.name).sort(), ["ActivateAccount", "ReadAccount"]);
  assert.equal(spec.links[0].from, "POST /accounts");
  assert.deepEqual(spec.security_schemes.bearerAuth, { type: "http", scheme: "bearer" });
  assert.deepEqual(create.security, [{ bearerAuth: [] }], "an operation inherits the document's security when it declares none");
});

test("a recursive schema is marked and reported, never expanded forever", () => {
  const spec: LegacyTestValue = loadOpenApi(SPEC);
  const account = spec.operations.find((o: LegacyTestValue) => o.method === "GET" && o.path === "/accounts/{accountId}").responses["200"].content["application/json"].schema;
  const notice = account.properties.notices.items;
  assert.deepEqual(notice.properties.caused_by, { $ref_cycle: "#/schemas/Notice" }, "the self-reference resolves to a marker");
  assert.ok(spec.diagnostics.some((d: LegacyTestValue) => d.kind === "cycle"), "and the cycle is reported for a Tier-1 check to act on");
});

test("the hermetic boundary: network refs, escaping file refs, and unresolvable pointers are config errors", () => {
  const network = withSpec("network", {
    "openapi.yaml": MINIMAL('  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: "https://example.com/schema.json#/Thing" }\n'),
  });
  assert.throws(
    () => loadOpenApi(network),
    (e) => e instanceof DummyConfigError && /points off the machine/.test(e.message) && /Vendor the document/.test(e.message),
  );

  fs.writeFileSync(path.join(tmp, "outside.yaml"), "schemas: { Thing: { type: object } }\n");
  const escaping = withSpec("escaping", {
    "openapi.yaml": MINIMAL('  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: "../outside.yaml#/schemas/Thing" }\n'),
  });
  assert.throws(
    () => loadOpenApi(escaping),
    (e) => e instanceof DummyConfigError && /escapes the spec's own directory/.test(e.message),
  );

  const dangling = withSpec("dangling", {
    "openapi.yaml": MINIMAL('  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: "#/components/schemas/Missing" }\n'),
  });
  assert.throws(
    () => loadOpenApi(dangling),
    (e) => e instanceof DummyConfigError && /does not resolve/.test(e.message),
  );

  const missingFile = withSpec("missing-file", {
    "openapi.yaml": MINIMAL('  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: "./gone.yaml#/Thing" }\n'),
  });
  assert.throws(
    () => loadOpenApi(missingFile),
    (e) => e instanceof DummyConfigError && /cannot read/.test(e.message),
  );
});

test("a spec that is unreadable, unparsable, oversized, or not an OpenAPI document names the problem", () => {
  assert.throws(
    () => loadOpenApi(path.join(tmp, "nope.yaml")),
    (e) => e instanceof DummyConfigError && /cannot read/.test(e.message),
  );

  const garbage = withSpec("garbage", { "openapi.yaml": "openapi: 3.1.0\npaths: [ unclosed\n" });
  assert.throws(
    () => loadOpenApi(garbage),
    (e) => e instanceof DummyConfigError && /not valid YAML or JSON/.test(e.message),
  );

  const notASpec = withSpec("not-a-spec", { "openapi.yaml": "title: my notes\nbody: nothing to see\n" });
  assert.throws(
    () => loadOpenApi(notASpec),
    (e) => e instanceof DummyConfigError && /does not look like an OpenAPI document/.test(e.message),
  );

  const big = withSpec("big", { "openapi.yaml": MINIMAL('  /a:\n    get:\n      responses:\n        "200": { description: ok }\n') });
  assert.throws(
    () => loadOpenApi(big, { maxBytes: 10 }),
    (e) => e instanceof DummyConfigError && /over the .*ingestion cap/.test(e.message),
  );
});

test("a self-multiplying $ref hits the node cap instead of exhausting memory", () => {
  // Each level references the one below it twice, so expansion is exponential —
  // the classic "billion laughs" shape, written as JSON Schema.
  const levels = Array.from({ length: 24 }, (_, i) => {
    const next = i === 23 ? "{ type: string }" : `{ $ref: "#/components/schemas/L${i + 1}" }`;
    return `    L${i}:\n      type: object\n      properties:\n        a: ${next}\n        b: ${next}`;
  }).join("\n");
  const bomb = withSpec("bomb", {
    "openapi.yaml":
      `openapi: 3.1.0\ninfo: { title: t, version: "1" }\ncomponents:\n  schemas:\n${levels}\n` +
      '\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: "#/components/schemas/L0" }\n',
  });
  assert.throws(
    () => loadOpenApi(bomb, { maxNodes: 20000 }),
    (e) => e instanceof DummyConfigError && /self-multiplying \$ref/.test(e.message),
  );
});

test("operation lines name what a call needs and what it may answer", () => {
  const spec = loadOpenApi(SPEC);
  const lines = spec.operations.map(operationLine);
  assert.equal(lines[0], "[e1] POST /accounts — Open an account [body: owner*] → 201, 422");
  assert.equal(lines[1], "[e2] GET /accounts/{accountId} — Read an account [accountId*] → 200, 404");
  assert.ok(lines.some((l) => l.includes("[body: account_id*, amount*]")), "required body fields are starred");
});

test("path templates match one segment per parameter, and nothing more", () => {
  const re = pathTemplateToRegExp("/accounts/{accountId}/entries");
  assert.ok(re.test("/accounts/acc_1/entries"));
  assert.ok(!re.test("/accounts/acc_1/entries/9"), "a template is anchored");
  assert.ok(!re.test("/accounts/acc_1/deep/entries"), "{param} never spans a slash");
  assert.ok(pathTemplateToRegExp("/entries").test("/entries"));
  assert.ok(!pathTemplateToRegExp("/entries").test("/entriesx"));
});

test("selectors parse with sane defaults, and every malformed shape is named", () => {
  assert.equal(parseOperationSelector("response_status", "201"), null, "a bare string keeps today's semantics");
  assert.deepEqual(
    { ...parseOperationSelector("response_status", { op: "POST /accounts", status: 201 }), template: undefined },
    { method: "POST", path: "/accounts", template: undefined, status: "201", match: null, occurrence: "all" },
  );
  assert.equal(parseOperationSelector("response_matches", { op: "GET /a", match: "$.x == 1" })!.occurrence, "last", "body matching defaults to the last response"); // SAFETY: this valid selector cannot parse to null

  assert.throws(() => parseOperationSelector("response_status", { op: "/accounts", status: "201" }), /method and an OpenAPI-style path/);
  assert.throws(() => parseOperationSelector("response_status", { op: "POST /a" }), /needs a "status"/);
  assert.throws(() => parseOperationSelector("response_matches", { op: "POST /a" }), /needs a "match" expression/);
  assert.throws(() => parseOperationSelector("response_status", { op: "POST /a", status: "201", occurrence: "sometimes" }), /must be one of all, any, first, last/);
  assert.throws(() => parseOperationSelector("response_status", { op: "POST /a", status: "201", nope: 1 }), /unknown response_status key\(s\) nope/);

  assert.equal(selectorSpec("response_status", { op: "POST /accounts", status: "201" }), "response_status: POST /accounts 201 (all)");
  assert.equal(selectorSpec("response_status", "201"), "response_status: 201");
});
