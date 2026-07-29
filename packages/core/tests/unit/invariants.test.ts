// Tier-1/2 invariant policies (docs/contracts/engine.md#invariant-policies).
//
// Every policy gets three cases, because all three are load-bearing:
//   * the VIOLATION — the property genuinely does not hold;
//   * the DECLARED EXCEPTION — behaviour that superficially looks like the
//     violation but the case declared as legitimate (a soft delete, an
//     eventually-consistent page boundary, a refreshed timestamp);
//   * NOT EXERCISED — the story never performed the operations the policy needs,
//     which under `success:` is a failure with an actionable detail.
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateGate } from "../../src/gate.ts";
import type { GateCheck } from "../../src/gate.ts";
import { POLICY_NAMES, evaluateInvariant, parseInvariantPolicy, policySpec } from "../../src/invariants.ts";

/** One recorded request, in the shape gate.js hands the policies. */
function req(method: string, path: string, status: number, body?: LegacyTestValue, extra: LegacyTestValue = {}): LegacyTestValue {
  return {
    method,
    path,
    status,
    mime: "application/json",
    body: body === undefined ? null : JSON.stringify(body),
    requestBody: extra.sent === undefined ? null : JSON.stringify(extra.sent),
    requestHeaders: extra.headers ?? {},
  };
}

const trace = (...requests: LegacyTestValue[]): LegacyTestValue[] => requests.map((r, index) => ({ ...r, index }));

/** Evaluate a policy the way the gate does: parse the authored value, then run it. */
const run = (value: LegacyTestValue, requests: LegacyTestValue[], ctx: LegacyTestValue = {}): Promise<LegacyTestValue> => evaluateInvariant(parseInvariantPolicy(value), { trace: trace(...requests), spec: null, match: null, observe: null, ...ctx });

const SPEC = {
  operations: [
    {
      method: "POST",
      path: "/accounts",
      status_codes: ["201", "422"],
      responses: {
        201: { content: { "application/json": { schema: { type: "object", required: ["id", "owner"], properties: { id: { type: "string" }, owner: { type: "string" } } } } } },
      },
    },
    { method: "GET", path: "/accounts/{accountId}", status_codes: ["200", "404"], responses: { 200: { content: { "application/json": { schema: { type: "object" } } } } } },
  ],
};

// ---- Tier 1 ----

test("no_server_error: a 5xx violates it; a clean trace holds; an empty trace is not exercised", async () => {
  const bad = await run({ policy: "no_server_error" }, [req("GET", "/accounts/a1", 500, { error: {} })]);
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /1 server error/);

  const good = await run({ policy: "no_server_error" }, [req("GET", "/accounts/a1", 200, { id: "a1" })]);
  assert.deepEqual([good.applicable, good.pass], [true, true]);

  const none = await run({ policy: "no_server_error", scope: "DELETE /accounts/{accountId}" }, [req("GET", "/accounts/a1", 200, {})]);
  assert.equal(none.applicable, false, "a scope no request matched was never exercised");
});

test("documented_status: an undeclared status violates it; a declared one holds; no spec operation is not exercised", async () => {
  const bad = await run({ policy: "documented_status" }, [req("POST", "/accounts", 202, { id: "a1" })], { spec: SPEC });
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /answered 202, which the spec does not declare/);
  assert.match(bad.detail, /declared: 201, 422/);

  const good = await run({ policy: "documented_status" }, [req("POST", "/accounts", 201, { id: "a1" })], { spec: SPEC });
  assert.deepEqual([good.applicable, good.pass], [true, true]);

  const none = await run({ policy: "documented_status" }, [req("GET", "/nowhere", 200, {})], { spec: SPEC });
  assert.equal(none.applicable, false);
  assert.match(none.detail, /never called a documented operation/);
});

test("response_schema: a body missing a required field violates it; a valid one holds; a schema-less trace is not exercised", async () => {
  const bad = await run({ policy: "response_schema" }, [req("POST", "/accounts", 201, { id: "a1" })], { spec: SPEC });
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /does not match its declared schema/);

  const good = await run({ policy: "response_schema" }, [req("POST", "/accounts", 201, { id: "a1", owner: "ada" })], { spec: SPEC });
  assert.deepEqual([good.applicable, good.pass], [true, true]);

  const none = await run({ policy: "response_schema" }, [req("POST", "/accounts", 422, { error: {} })], { spec: SPEC });
  assert.equal(none.applicable, false, "the spec declares no schema for that status here");
});

test("content_type: a wrong media type violates it", async () => {
  const bad = await run({ policy: "content_type" }, [{ ...req("POST", "/accounts", 201, { id: "a1" }), mime: "text/plain" }], { spec: SPEC });
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /answered text\/plain, not the declared application\/json/);
  const good = await run({ policy: "content_type" }, [req("POST", "/accounts", 201, { id: "a1" })], { spec: SPEC });
  assert.equal(good.pass, true);
});

// ---- Tier 2 ----

const ROUND_TRIP = { policy: "round_trip", create: "POST /accounts", read: "GET /accounts/{accountId}", fields: ["$.owner"] };

test("round_trip: a mangled field violates it; an undeclared generated field is exempt; no read-back is not exercised", async () => {
  const created = req("POST", "/accounts", 201, { id: "a1", owner: "ada" }, { sent: { owner: "ada" } });
  const bad = await run(ROUND_TRIP, [created, req("GET", "/accounts/a1", 200, { id: "a1", owner: "ad" })]);
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /\$\.owner was written as "ada" but read back as "ad"/);

  // The DECLARED EXCEPTION: only client-owned fields are declared, so a
  // server-generated one that differs (here `id`, which the write never carried)
  // is not a violation — generated, defaulted, and computed fields are excluded
  // by declaration, not by guesswork.
  const good = await run(ROUND_TRIP, [created, req("GET", "/accounts/a1", 200, { id: "a1-rewritten", owner: "ada", created_at: "now" })]);
  assert.deepEqual([good.applicable, good.pass], [true, true]);

  const none = await run(ROUND_TRIP, [created]);
  assert.equal(none.applicable, false);
  assert.match(none.detail, /never read GET \/accounts\/\{accountId\} back/);
  assert.match(none.detail, /declare observe: true/, "the detail names the fix");
});

test("round_trip with observe: true issues ONE read-only GET, addressed from the create response", async () => {
  const created = req("POST", "/accounts", 201, { id: "a1", owner: "ada" }, { sent: { owner: "ada" } });
  const issued: LegacyTestValue[] = [];
  const observe = async (request: LegacyTestValue) => {
    issued.push(request);
    return { status: 200, mime: "application/json", body: JSON.stringify({ id: "a1", owner: "ada" }) };
  };
  const verdict = await run({ ...ROUND_TRIP, observe: true, read_from: { accountId: "$.id" } }, [created], { observe });
  assert.deepEqual(issued, [{ method: "GET", path: "/accounts/a1" }], "the observation is a GET, addressed by the declared mapping");
  assert.deepEqual([verdict.applicable, verdict.pass], [true, true]);
  assert.match(verdict.detail, /read back by observation/);

  // With no observation channel the policy reports not-applicable rather than
  // inventing a verdict.
  const offline = await run({ ...ROUND_TRIP, observe: true, read_from: { accountId: "$.id" } }, [created], { observe: null });
  assert.equal(offline.applicable, false);
});

const IDEMPOTENCY = { policy: "idempotency", op: "POST /entries", key_header: "Idempotency-Key" };
const keyed = (body: LegacyTestValue) => req("POST", "/entries", 201, body, { sent: { account_id: "a1", amount: 5 }, headers: { "Idempotency-Key": "k-1" } });

test("idempotency: a divergent replay violates it; a declared ignore absorbs a volatile field; one call is not exercised", async () => {
  const bad = await run(IDEMPOTENCY, [keyed({ id: "e1", amount: 5, created_at: "t1" }), keyed({ id: "e2", amount: 5, created_at: "t2" })]);
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /reached a different normalized state/);

  // The DECLARED EXCEPTION: an API that refreshes a timestamp on replay is still
  // idempotent once the case says which field is volatile.
  const good = await run({ ...IDEMPOTENCY, ignore: ["$.created_at"] }, [keyed({ id: "e1", amount: 5, created_at: "t1" }), keyed({ id: "e1", amount: 5, created_at: "t2" })]);
  assert.deepEqual([good.applicable, good.pass], [true, true]);
  // ...but it cannot mask a genuinely different entry.
  const stillBad = await run({ ...IDEMPOTENCY, ignore: ["$.created_at"] }, [keyed({ id: "e1", created_at: "t1" }), keyed({ id: "e2", created_at: "t2" })]);
  assert.equal(stillBad.pass, false);

  const none = await run(IDEMPOTENCY, [keyed({ id: "e1" })]);
  assert.equal(none.applicable, false);
  assert.match(none.detail, /never repeats POST \/entries with the same Idempotency-Key/);
});

const LIFECYCLE = { policy: "lifecycle", delete: "DELETE /accounts/{accountId}", read: "GET /accounts/{accountId}" };

test("lifecycle: a resource that outlives its delete violates it; a declared soft delete does not; no delete is not exercised", async () => {
  const gone = req("DELETE", "/accounts/a1", 204);
  const bad = await run(LIFECYCLE, [gone, req("GET", "/accounts/a1", 200, { id: "a1", status: "active" })]);
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /answered 200 after the delete, which is not one of the declared 404, 410/);
  assert.match(bad.detail, /soft-delete, tombstones, and retention are legitimate/, "the detail names the declaration that would make it legal");

  // The DECLARED EXCEPTION the exit gate calls for: a soft delete declared with
  // after: + state: must not fail the policy.
  const soft = { ...LIFECYCLE, after: [200], state: '$.status == "deleted"' };
  const good = await run(soft, [gone, req("GET", "/accounts/a1", 200, { id: "a1", status: "deleted" })]);
  assert.deepEqual([good.applicable, good.pass], [true, true]);
  // ...and the declaration is not a blank cheque: a soft delete that never
  // actually marks the record still fails.
  const lying = await run(soft, [gone, req("GET", "/accounts/a1", 200, { id: "a1", status: "active" })]);
  assert.equal(lying.pass, false);
  assert.match(lying.detail, /survived the delete but/);

  const none = await run(LIFECYCLE, [req("GET", "/accounts/a1", 200, { id: "a1" })]);
  assert.equal(none.applicable, false);
  assert.match(none.detail, /never completed a DELETE/);
});

const PAGINATION = { policy: "pagination", op: "GET /entries", identity: "$.entries[*].id", cursor: "$.next_cursor" };
const page = (ids: string[], next: LegacyTestValue) => req("GET", "/entries", 200, { entries: ids.map((id) => ({ id })), next_cursor: next });

test("pagination: a repeated identity violates it; eventual consistency declares it legal; one page is not exercised", async () => {
  const bad = await run(PAGINATION, [page(["e1", "e2"], 2), page(["e2", "e3"], null)]);
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /identity "e2" appeared on page 1 and again on page 2/);
  assert.match(bad.detail, /declare consistency: eventual/);

  // The DECLARED EXCEPTION: under an eventual model a boundary repeat caused by
  // a concurrent write is legitimate, and only non-termination is a violation.
  const good = await run({ ...PAGINATION, consistency: "eventual" }, [page(["e1", "e2"], 2), page(["e2", "e3"], null)]);
  assert.deepEqual([good.applicable, good.pass], [true, true]);
  const runaway = await run({ ...PAGINATION, consistency: "eventual" }, [page(["e1"], 1), page(["e2"], 2)]);
  assert.equal(runaway.pass, false, "an enumeration that never terminates fails under either model");
  assert.match(runaway.detail, /never terminated/);

  const none = await run(PAGINATION, [page(["e1"], null)]);
  assert.equal(none.applicable, false);
  assert.match(none.detail, /needs at least two/);
});

const ERROR_SHAPE = { policy: "error_shape", require: ["$.error.code", "$.error.message"] };

test("error_shape: a bare 4xx body violates it; excluded auth statuses do not; no refusal is not exercised", async () => {
  const bad = await run(ERROR_SHAPE, [req("POST", "/accounts", 422, { message: "owner is required" })]);
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /missing \$\.error\.code from the declared error envelope/);

  const good = await run(ERROR_SHAPE, [req("POST", "/accounts", 422, { error: { code: "invalid", message: "owner is required" } })]);
  assert.deepEqual([good.applicable, good.pass], [true, true]);

  // The DECLARED EXCEPTION: auth and throttling responses legitimately differ,
  // and are excluded by default rather than by hand.
  const auth = await run(ERROR_SHAPE, [req("GET", "/admin/metrics", 401, {}), req("POST", "/accounts", 422, { error: { code: "x", message: "y" } })]);
  assert.deepEqual([auth.applicable, auth.pass], [true, true]);
  const authOnly = await run(ERROR_SHAPE, [req("GET", "/admin/metrics", 401, {})]);
  assert.equal(authOnly.applicable, false, "with only excluded statuses the policy was never exercised");

  const none = await run(ERROR_SHAPE, [req("POST", "/accounts", 201, { id: "a1" })]);
  assert.equal(none.applicable, false);
  assert.match(none.detail, /no 4xx response outside the excluded/);
});

// ---- gate integration: applicability, advisory, quarantine ----

test("under success: a not-applicable policy FAILS with its actionable detail; under observe: it only reports", async () => {
  const ctx = { trajectory: [], harEntries: [] };
  const policy = { invariant: { policy: "pagination", op: "GET /entries", identity: "$.entries[*].id" } };

  const gated = await evaluateGate({ success: [policy] }, ctx);
  assert.equal(gated.pass, false, "a declared invariant that was never exercised has not held");
  assert.equal(gated.checks[0]!.applicable, false);
  assert.equal(gated.checks[0]!.pass, false);
  assert.match(gated.checks[0]!.detail, /a pagination policy needs at least two/);
  assert.equal(gated.checks[0]!.spec, "invariant: pagination op=GET /entries identity=$.entries[*].id");

  const advised = await evaluateGate({ success: [], observe: [policy] }, ctx);
  assert.equal(advised.pass, true, "an advisory policy never gates");
  assert.equal(advised.checks.length, 0);
  assert.equal(advised.advisory!.length, 1);
  assert.deepEqual([advised.advisory![0]!.applicable, advised.advisory![0]!.severity], [false, "advisory"]);
});

test("an advisory VIOLATION is reported and still does not gate", async () => {
  const har = [
    { request: { method: "GET", url: "http://x/entries" }, response: { status: 200, mimeType: "application/json", body: JSON.stringify({ entries: [{ id: "e1" }], next_cursor: 1 }) } },
    { request: { method: "GET", url: "http://x/entries" }, response: { status: 200, mimeType: "application/json", body: JSON.stringify({ entries: [{ id: "e1" }], next_cursor: null }) } },
  ];
  const gate = await evaluateGate(
    { success: [], observe: [{ invariant: { policy: "pagination", op: "GET /entries", identity: "$.entries[*].id" } }] },
    { trajectory: [], harEntries: har },
  );
  assert.equal(gate.pass, true, "the run stays green");
  assert.equal(gate.advisory![0]!.pass, false, "and the violation is still recorded");
  assert.match(gate.advisory![0]!.detail, /appeared on page 1 and again on page 2/);
});

test("an observation GET can never satisfy api_called or shift the response another kind inspects", async () => {
  // A run whose story called POST /accounts, followed by an observation GET that
  // a round-trip policy issued. The observation is tagged in the HAR.
  const harEntries = [
    { request: { method: "POST", url: "http://x/accounts", body: '{"owner":"ada"}' }, response: { status: 201, mimeType: "application/json", body: '{"id":"a1","owner":"ada"}' } },
    {
      _observation: true,
      request: { method: "GET", url: "http://x/accounts/a1" },
      // A DIFFERENT body from the story's own last response, so every assertion
      // below discriminates: if the quarantine leaked, these checks would flip.
      response: { status: 200, mimeType: "application/json", body: '{"id":"a1","owner":"observed"}' },
    },
  ];
  const ctx = { trajectory: [{ network: { requests: [{ method: "POST", url: "http://x/accounts", path: "/accounts", status: 201 }] } }], harEntries };
  const gate = await evaluateGate(
    {
      success: [
        { api_called: "GET /accounts/*" },
        { response_matches: '$.owner == "observed"' },
        { response_status: { op: "GET /accounts/{accountId}", status: "200" } },
        { invariant: { policy: "no_server_error", scope: "GET /accounts/{accountId}" } },
      ],
    },
    ctx,
  );
  const [called, matched, selected, invariant] = gate.checks as [GateCheck, GateCheck, GateCheck, GateCheck];
  assert.equal(called.pass, false, "api_called must not be satisfied by the gate's own observation");
  assert.match(called.detail, /no matching request among 1 request/);
  assert.equal(matched.pass, false, "the observation must not become the last response body");
  assert.match(matched.detail, /\$\.owner = "ada"/, "the last response is still the story's own");
  assert.equal(selected.pass, false, "a structured selector must not see it either");
  assert.match(selected.detail, /no request matched GET \/accounts\/\{accountId\}/);
  assert.equal(invariant.applicable, false, "and a policy's own view of the story excludes it");

  // The control: the same run WITHOUT the quarantine tag would satisfy all four,
  // so the assertions above are about the tag and not about a missing request.
  const leaked = await evaluateGate(
    {
      success: [
        { api_called: "GET /accounts/*" },
        { response_matches: '$.owner == "observed"' },
        { response_status: { op: "GET /accounts/{accountId}", status: "200" } },
      ],
    },
    { ...ctx, harEntries: harEntries.map(({ _observation, ...e }) => e) },
  );
  assert.deepEqual(leaked.checks.map((c: LegacyTestValue) => c.pass), [true, true, true], "untagged, the same request satisfies every one of them");
});

// ---- step-linked evidence (docs/contracts/engine.md#invariant-policies) ----

test("every policy's violation names the recorded requests it is about", async () => {
  // A verdict a reviewer cannot trace back to a request is not evidence. Each
  // policy reports the offending entries; gate.js turns them into the step
  // citation, which is what makes a cross-layer violation reviewable on the web
  // driver, where the trace is a by-product of the page rather than the story.
  const created = req("POST", "/accounts", 201, { id: "a1", owner: "ada" }, { sent: { owner: "ada" } });
  const violations: LegacyTestValue[] = [
    [{ policy: "no_server_error" }, [req("GET", "/accounts/a1", 500, { error: {} })], null],
    [{ policy: "documented_status" }, [req("POST", "/accounts", 202, { id: "a1" })], SPEC],
    [{ policy: "response_schema" }, [req("POST", "/accounts", 201, { id: "a1" })], SPEC],
    [{ policy: "content_type" }, [{ ...req("POST", "/accounts", 201, { id: "a1", owner: "ada" }), mime: "text/plain" }], SPEC],
    [ROUND_TRIP, [created, req("GET", "/accounts/a1", 200, { id: "a1", owner: "ad" })], null],
    [IDEMPOTENCY, [keyed({ id: "e1", created_at: "t1" }), keyed({ id: "e2", created_at: "t2" })], null],
    [LIFECYCLE, [req("DELETE", "/accounts/a1", 204), req("GET", "/accounts/a1", 200, { id: "a1" })], null],
    [PAGINATION, [page(["e1", "e2"], 2), page(["e2", "e3"], null)], null],
    [ERROR_SHAPE, [req("POST", "/accounts", 422, { message: "nope" })], null],
  ];

  for (const [policy, requests, spec] of violations) {
    const verdict = await run(policy, requests, spec ? { spec } : {});
    assert.equal(verdict.pass, false, `${policy.policy} should fail on its violation`);
    assert.ok(verdict.requests?.length, `${policy.policy} names no offending request`);
    const indices = trace(...requests).map((r) => r.index);
    for (const r of verdict.requests) {
      assert.ok(indices.includes(r.index), `${policy.policy} cited a request that is not in the trace`);
    }
  }
});

test("gate.js resolves an invariant violation to the step whose action produced it, and drops the raw requests", async () => {
  // The seam is the step envelope's artifacts.har_entries — the per-step slice
  // of har.json — so this holds for any driver that records network traffic.
  const har = (method: string, path: string, status: number, body: LegacyTestValue) => ({
    request: { method, url: `http://x${path}` },
    response: { status, mimeType: "application/json", body: JSON.stringify(body) },
  });
  const harEntries = [har("GET", "/accounts/a1", 200, { id: "a1" }), har("POST", "/entries", 500, { error: {} })];
  const trajectory = [
    { step: 1, network: { requests: [{ method: "GET", url: "http://x/accounts/a1", path: "/accounts/a1", status: 200 }] }, artifacts: { har_entries: [0] } },
    { step: 2, network: { requests: [{ method: "POST", url: "http://x/entries", path: "/entries", status: 500 }] }, artifacts: { har_entries: [1] } },
  ];

  const gate: LegacyTestValue = await evaluateGate({ success: [{ invariant: { policy: "no_server_error" } }] }, { trajectory, harEntries });
  assert.equal(gate.checks[0].pass, false);
  assert.deepEqual(gate.checks[0].steps, [2], "the 5xx is cited against the step that made the request");
  assert.equal("requests" in gate.checks[0], false, "the raw entries carry bodies and never reach the manifest");

  // A passing check carries no citation at all — `steps` is violation evidence,
  // not a new field on every check.
  const clean: LegacyTestValue = await evaluateGate({ success: [{ invariant: { policy: "no_server_error", scope: "GET /accounts/{accountId}" } }] }, { trajectory, harEntries });
  assert.equal(clean.checks[0].pass, true);
  assert.equal("steps" in clean.checks[0], false);
});

// ---- authoring errors ----

test("a malformed policy is a named error at discovery, not a mystery at the end of a run", () => {
  const bad = (value: LegacyTestValue, re: RegExp) => assert.throws(() => parseInvariantPolicy(value), re, JSON.stringify(value));
  bad({ policy: "nonsense" }, /unknown invariant policy "nonsense" — the vocabulary is/);
  bad({ policy: "pagination", op: "GET /entries" }, /needs "identity"/);
  bad({ policy: "pagination", op: "entries", identity: "$.id" }, /must be a method and an OpenAPI-style path/);
  bad({ policy: "no_server_error", op: "GET /x" }, /unknown key\(s\) op/);
  bad({ policy: "pagination", op: "GET /e", identity: "$.id", consistency: "strong" }, /must be one of snapshot, eventual/);
  bad({ policy: "idempotency", op: "POST /e", compare: ["headers"] }, /accepts status and\/or body/);
  bad({ policy: "lifecycle", delete: "DELETE /a/{id}", read: "GET /a/{id}", after: ["gone"] }, /not a three-digit status/);
  bad({ policy: "no_server_error", observe: true }, /unknown key\(s\) observe on invariant policy "no_server_error"/);
  bad({ policy: "round_trip", create: "POST /a", read: "GET /a/{id}", fields: ["$.o"], observe: true }, /needs "read_from"/);
  bad("no_server_error", /takes a policy object/);
});

test("every policy in the vocabulary is reachable and has a stable spec key", () => {
  assert.deepEqual(POLICY_NAMES, [
    "no_server_error",
    "documented_status",
    "response_schema",
    "content_type",
    "round_trip",
    "idempotency",
    "lifecycle",
    "pagination",
    "error_shape",
  ]);
  assert.equal(policySpec({ policy: "no_server_error" }), "invariant: no_server_error");
  assert.notEqual(
    policySpec({ policy: "no_server_error", scope: "GET /a" }),
    policySpec({ policy: "no_server_error", scope: "GET /b" }),
    "two scopes of one policy never collide on one key",
  );
});
