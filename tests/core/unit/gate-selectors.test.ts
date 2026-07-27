// The structured operation selector on response_status / response_matches:
// occurrence semantics, the never-vacuous rule, and the untouched bare-string
// forms (docs/contracts/engine.md#gates-and-custom-assertions).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { discoverCases, DummyConfigError } from "../../../src/core/config.ts";
import { evaluateGate } from "../../../src/core/gate.ts";

/** A run whose requests and bodies are given directly, as the runner assembles them. */
function ctxOf(requests: LegacyTestValue[]): LegacyTestValue {
  return {
    trajectory: [{ network: { requests: requests.map(({ method, path: p, status }) => ({ method, path: p, url: `http://x${p}`, status })) } }],
    harEntries: requests.map(({ method, path: p, status, body }) => ({
      request: { method, url: `http://x${p}` },
      response: { status, body: body === undefined ? null : JSON.stringify(body) },
    })),
  };
}

const RUN = ctxOf([
  { method: "POST", path: "/accounts", status: 201, body: { id: "acc_1", status: "pending" } },
  { method: "POST", path: "/accounts/acc_1/activate", status: 200, body: { id: "acc_1", status: "active" } },
  { method: "POST", path: "/entries", status: 201, body: { id: "ent_1" } },
  { method: "POST", path: "/entries", status: 409, body: { error: { code: "not_active" } } },
  { method: "GET", path: "/accounts/acc_1", status: 200, body: { id: "acc_1", balance: 250 } },
]);

const verdict = async (criterion: LegacyTestValue, ctx: LegacyTestValue = RUN): Promise<LegacyTestValue> => (await evaluateGate({ success: [criterion] }, ctx)).checks[0];

test("occurrence decides which of an operation's requests must satisfy the check", async () => {
  const status = (occurrence: string) => ({ response_status: { op: "POST /entries", status: "201", occurrence } });
  assert.equal((await verdict(status("all"))).pass, false, "all: the 409 breaks it");
  assert.equal((await verdict(status("any"))).pass, true);
  assert.equal((await verdict(status("first"))).pass, true);
  assert.equal((await verdict(status("last"))).pass, false);
  assert.equal((await verdict({ response_status: { op: "POST /entries", status: "201" } })).pass, false, "status defaults to all");
});

test("a path template scopes the check to one operation, one segment per parameter", async () => {
  assert.equal((await verdict({ response_status: { op: "POST /accounts/{id}/activate", status: "200" } })).pass, true);
  assert.equal((await verdict({ response_status: { op: "POST /accounts", status: "201" } })).pass, true, "the template does not also match the activate path");
  const wide = await verdict({ response_status: { op: "GET /accounts/{id}", status: "200" } });
  assert.equal(wide.pass, true);
  assert.match(wide.detail, /1\/1 GET \/accounts\/\{id\} response\(s\) answered 200/);
});

test("a selector matching zero requests FAILS — 'all' is never vacuously true", async () => {
  for (const occurrence of ["all", "any", "first", "last"]) {
    const check = await verdict({ response_status: { op: "DELETE /accounts/{id}", status: "204", occurrence } });
    assert.equal(check.pass, false, `${occurrence} must not pass without being exercised`);
    assert.match(check.detail, /no request matched DELETE \/accounts\/\{id\}/);
    assert.match(check.detail, /must be exercised to pass/);
  }
  const body = await verdict({ response_matches: { op: "GET /nope", match: "$.a == 1" } });
  assert.equal(body.pass, false);
  assert.match(body.detail, /no request matched GET \/nope/);
});

test("response_matches scopes a body check to one operation instead of the run's last response", async () => {
  // The bare-string form reads the LAST response, which here is the GET; the
  // selector form can still ask about the activate call earlier in the journey.
  assert.equal((await verdict({ response_matches: '$.balance == 250' })).pass, true);
  assert.equal((await verdict({ response_matches: '$.status == "active"' })).pass, false, "the last body has no status field");
  const scoped = await verdict({ response_matches: { op: "POST /accounts/{id}/activate", match: '$.status == "active"' } });
  assert.equal(scoped.pass, true, "the selector reaches the operation the check is actually about");

  const all = await verdict({ response_matches: { op: "POST /entries", match: '$.id == "ent_1"', occurrence: "all" } });
  assert.equal(all.pass, false, "the 409 body has no id");
  assert.match(all.detail, /POST \/entries: \$\.id = \(no value at path\)/);
  assert.equal((await verdict({ response_matches: { op: "POST /entries", match: '$.id == "ent_1"', occurrence: "any" } })).pass, true);
});

test("bare-string forms keep today's any-request / last-body semantics", async () => {
  assert.equal((await verdict({ response_status: "201" })).pass, true, "any request in the run");
  assert.equal((await verdict({ response_status: "2xx" })).pass, true);
  assert.equal((await verdict({ response_status: "404" })).pass, false);
  const detail = (await verdict({ response_status: "201" })).detail;
  assert.match(detail, /2 response\(s\) with status 201/);
  assert.equal((await verdict({ response_status: "201" })).spec, "response_status: 201", "the spec key is unchanged for existing suites");
});

test("each selector gets its own stable spec key, so two checks on one kind never collide", async () => {
  const gate = await evaluateGate(
    {
      success: [
        { response_status: { op: "POST /entries", status: "201", occurrence: "first" } },
        { response_status: { op: "POST /entries", status: "409", occurrence: "last" } },
      ],
    },
    RUN,
  );
  assert.deepEqual(gate.checks.map((c: LegacyTestValue) => c.spec), [
    "response_status: POST /entries 201 (first)",
    "response_status: POST /entries 409 (last)",
  ]);
  assert.deepEqual(gate.checks.map((c: LegacyTestValue) => c.pass), [true, true]);
});

test("a malformed selector is a config error naming the case file, not a late gate failure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-selector-"));
  try {
    const dir = path.join(tmp, "suite");
    fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
    fs.writeFileSync(path.join(dir, "playtest.yaml"), "app:\n  driver: api\n  base_url: http://127.0.0.1:1\n");
    fs.writeFileSync(
      path.join(dir, "stories", "x.yaml"),
      ["story: do a thing", "success:", "  - response_status:", '      op: "accounts"', '      status: "201"', ""].join("\n"),
    );
    await assert.rejects(
      () => discoverCases([dir]),
      (e) => e instanceof DummyConfigError && /x\.yaml/.test(e.message) && /method and an OpenAPI-style path/.test(e.message),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
