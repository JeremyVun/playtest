// Oracle-level tests over synthetic traces.
//
// The bench suite proves the oracles catch the eight development faults on real
// traffic. This suite covers the branches no development fault reaches — the
// ones the sealed held-out set and future comparator traffic will exercise —
// and, just as importantly, the applicability rules that keep a thin trace from
// scoring as a pass or a violation.

import assert from "node:assert/strict";
import test from "node:test";
import { traceFromHarEntries } from "../bench/lib/trace.js";
import { scoreTrace, ORACLE_IDS } from "../bench/lib/oracles.js";

let clock = Date.parse("2026-07-25T09:00:00.000Z");

/** Build one HAR entry in the shape Playtest's api driver writes. */
function entry(method, path, { status = 200, body = null, request = null, headers = {} } = {}) {
  clock += 10;
  const responseBody = body === null ? null : JSON.stringify(body);
  return {
    startedDateTime: new Date(clock).toISOString(),
    time: 5,
    request: {
      method,
      url: `http://127.0.0.1:4180${path}`,
      headers: { authorization: "Bearer admin-token-test", ...headers },
      body: request === null ? null : JSON.stringify(request),
    },
    response: {
      status,
      bodySize: responseBody ? responseBody.length : 0,
      mimeType: "application/json",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: responseBody,
    },
    _failed: false,
  };
}

const score = (entries, label = null) =>
  scoreTrace(traceFromHarEntries(entries, { id: "synthetic", source: "har", label }));

const reset = () => entry("POST", "/admin/reset", { body: { ok: true, seed: "s", day: 0 } });
const account = (id, status) => entry("POST", "/accounts", { status: 201, body: { id, status, balance: 0 } });
const entriesPage = (accountId, items, next = null, cursor = null) =>
  entry("GET", `/accounts/${accountId}/entries${cursor ? `?cursor=${cursor}` : ""}`, {
    body: { items, next_cursor: next },
  });
const row = (id, kind, amount, transferId, accountId = "acc_a") => ({
  id,
  account_id: accountId,
  kind,
  amount,
  currency: "USD",
  transfer_id: transferId,
  deposit_id: null,
  sequence: Number(id.replace(/\D/g, "")),
  created_at: "2026-01-01T00:00:01.000Z",
});

test("an empty or irrelevant trace makes no oracle applicable and no violation", () => {
  assert.deepEqual(score([]).violations, []);
  assert.deepEqual(
    Object.values(score([]).applicability),
    ORACLE_IDS.map(() => false),
  );
  const trivial = score([entry("GET", "/health", { body: { ok: true } })]);
  assert.deepEqual(trivial.violations, []);
  assert.equal(trivial.applicability.protocol, true, "a completed response can be judged for 5xx");
  assert.equal(trivial.applicability.conservation, false);
});

test("error-shape: a 4xx that is not the envelope is a violation", () => {
  const bad = score([entry("GET", "/accounts/acc_x", { status: 404, body: { message: "nope" } })]);
  assert.equal(bad.violations.length, 1);
  assert.equal(bad.violations[0].code, "error_envelope_violation");
  assert.equal(bad.violations[0].evidence.request.status, 404);

  const extraKeys = score([
    entry("GET", "/accounts/acc_x", { status: 404, body: { error: { code: "x", message: "y", hint: "z" } } }),
  ]);
  assert.equal(extraKeys.violations[0].code, "error_envelope_violation");

  const good = score([
    entry("GET", "/accounts/acc_x", { status: 404, body: { error: { code: "account_not_found", message: "no" } } }),
  ]);
  assert.deepEqual(good.violations, []);
  assert.equal(good.applicability.error_shape, true);
});

test("error-shape: a truncated or empty body is not judged", () => {
  const truncated = [entry("GET", "/accounts/acc_x", { status: 500 })];
  truncated[0].response.body = '{"error":{"code":"internal_erro…[truncated]';
  const result = score(truncated);
  assert.deepEqual(result.violations.map((violation) => violation.code), ["unexpected_server_error"]);
});

test("idempotency: the same key and body returning two transfers is a violation", () => {
  const body = { source_account_id: "acc_a", destination_account_id: "acc_b", amount: 100 };
  const result = score([
    reset(),
    entry("POST", "/transfers", {
      status: 201,
      request: body,
      headers: { "idempotency-key": "k1" },
      body: { id: "tr_1", status: "pending" },
    }),
    entry("POST", "/transfers", {
      status: 201,
      request: body,
      headers: { "idempotency-key": "k1" },
      body: { id: "tr_2", status: "pending" },
    }),
  ]);
  assert.deepEqual(result.violations.map((violation) => violation.code), ["idempotency_key_diverged"]);
  assert.deepEqual(result.violations[0].evidence.subject.transfer_ids, ["tr_1", "tr_2"]);

  const differentBody = score([
    reset(),
    entry("POST", "/transfers", {
      status: 201,
      request: body,
      headers: { "idempotency-key": "k1" },
      body: { id: "tr_1", status: "pending" },
    }),
    entry("POST", "/transfers", {
      status: 201,
      request: { ...body, amount: 200 },
      headers: { "idempotency-key": "k1" },
      body: { id: "tr_2", status: "pending" },
    }),
  ]);
  assert.deepEqual(differentBody.violations, [], "a different body is a different request");
});

test("idempotency: the same key under two principals is not a violation", () => {
  // The invariant is scoped "per authenticated principal", and the service
  // scopes its own records the same way, so one key reused by a *different*
  // credential legitimately creates a second transfer. An oracle that ignored
  // the credential reported this as a violation on a clean build — a false
  // positive found by the agent-suite comparator arm, which switches tokens
  // mid-suite.
  const body = { source_account_id: "acc_a", destination_account_id: "acc_b", amount: 100 };
  const twoPrincipals = score([
    reset(),
    entry("POST", "/transfers", {
      status: 201,
      request: body,
      headers: { "idempotency-key": "k1", authorization: "Bearer customer-token" },
      body: { id: "tr_1", status: "pending" },
    }),
    entry("POST", "/transfers", {
      status: 201,
      request: body,
      headers: { "idempotency-key": "k1", authorization: "Bearer admin-token" },
      body: { id: "tr_2", status: "pending" },
    }),
  ]);
  assert.deepEqual(twoPrincipals.violations, [], "a different principal is a different scope");

  const onePrincipal = score([
    reset(),
    entry("POST", "/transfers", {
      status: 201,
      request: body,
      headers: { "idempotency-key": "k1", authorization: "Bearer customer-token" },
      body: { id: "tr_1", status: "pending" },
    }),
    entry("POST", "/transfers", {
      status: 201,
      request: body,
      headers: { "idempotency-key": "k1", authorization: "Bearer customer-token" },
      body: { id: "tr_2", status: "pending" },
    }),
  ]);
  assert.deepEqual(
    onePrincipal.violations.map((violation) => violation.code),
    ["idempotency_key_diverged"],
    "the same principal reusing the key still violates",
  );
});

test("idempotency: the phantom-effect rule needs a reset anchor", () => {
  const entries = [
    entry("POST", "/transfers", { status: 201, body: { id: "tr_1", status: "pending" } }),
    entriesPage("acc_a", [row("ent_1", "transfer_debit", -127, "tr_ghost")]),
  ];
  assert.deepEqual(score(entries).violations, [], "without a reset the trace may simply predate the effect");

  const anchored = score([reset(), ...entries]);
  assert.deepEqual(anchored.violations.map((violation) => violation.code), ["phantom_ledger_effect"]);
  assert.equal(anchored.violations[0].evidence.subject.transfer_id, "tr_ghost");
});

test("lifecycle: a transfer against a never-activated account is a violation", () => {
  const result = score([
    reset(),
    account("acc_a", "pending"),
    entry("POST", "/transfers", {
      status: 201,
      request: { source_account_id: "acc_a", destination_account_id: "acc_b", amount: 10 },
      body: { id: "tr_1", status: "pending" },
    }),
  ]);
  assert.deepEqual(result.violations.map((violation) => violation.code), ["transfer_on_inactive_account"]);
  assert.equal(result.violations[0].evidence.supporting[0].index, 1);
});

test("lifecycle: closing an account with a pending transfer is a violation", () => {
  const result = score([
    reset(),
    account("acc_a", "active"),
    entry("POST", "/transfers", {
      status: 201,
      request: { source_account_id: "acc_a", destination_account_id: "acc_b", amount: 10 },
      body: { id: "tr_1", status: "pending", source_account_id: "acc_a", destination_account_id: "acc_b" },
    }),
    entry("POST", "/accounts/acc_a/close", { body: { id: "acc_a", status: "closed" } }),
  ]);
  assert.deepEqual(result.violations.map((violation) => violation.code), ["close_with_pending_transfers"]);
  assert.deepEqual(result.violations[0].evidence.subject.transfer_ids, ["tr_1"]);
});

test("lifecycle: a refused operation is never a violation", () => {
  const result = score([
    reset(),
    account("acc_a", "pending"),
    entry("POST", "/transfers", {
      status: 409,
      request: { source_account_id: "acc_a", destination_account_id: "acc_b", amount: 10 },
      body: { error: { code: "account_not_active", message: "no" } },
    }),
    entry("POST", "/transfers/tr_1/cancel", { status: 409, body: { error: { code: "transfer_not_pending", message: "no" } } }),
  ]);
  assert.deepEqual(result.violations, []);
});

test("conservation: only a fully observed settlement is judged", () => {
  const partial = score([
    reset(),
    entriesPage("acc_a", [row("ent_1", "transfer_debit", -127, "tr_1")]),
  ]);
  assert.equal(partial.applicability.conservation, false, "one leg is not a settlement");

  const complete = score([
    reset(),
    entry("POST", "/transfers", { status: 201, body: { id: "tr_1", status: "pending" } }),
    entriesPage("acc_a", [
      row("ent_1", "transfer_debit", -127, "tr_1"),
      row("ent_2", "transfer_credit", 100, "tr_1", "acc_b"),
      row("ent_3", "fee", 27, "tr_1", "acc_fee_usd"),
    ]),
  ]);
  assert.equal(complete.applicability.conservation, true);
  assert.deepEqual(complete.violations, []);

  const broken = score([
    reset(),
    entry("POST", "/transfers", { status: 201, body: { id: "tr_1", status: "pending" } }),
    entriesPage("acc_a", [
      row("ent_1", "transfer_debit", -127, "tr_1"),
      row("ent_2", "transfer_credit", 100, "tr_1", "acc_b"),
      row("ent_3", "fee", 26, "tr_1", "acc_fee_usd"),
    ]),
  ]);
  assert.deepEqual(broken.violations.map((violation) => violation.code), ["transfer_entries_nonzero"]);
  assert.equal(broken.violations[0].evidence.subject.sum, -1);
  assert.equal(broken.violations[0].evidence.supporting.length, 3, "every leg is cited");
});

test("conservation: a duplicated entry sighting is counted once", () => {
  const legs = [
    row("ent_1", "transfer_debit", -127, "tr_1"),
    row("ent_2", "transfer_credit", 100, "tr_1", "acc_b"),
    row("ent_3", "fee", 27, "tr_1", "acc_fee_usd"),
  ];
  const result = score([
    reset(),
    entry("POST", "/transfers", { status: 201, body: { id: "tr_1", status: "pending" } }),
    entriesPage("acc_a", legs),
    entriesPage("acc_a", legs),
  ]);
  assert.deepEqual(result.violations, []);
});

test("pagination: identity is scored only for enumerations the trace started", () => {
  const duplicated = score([
    entriesPage("acc_a", [row("ent_3", "deposit", 300, null)], "cursor-1"),
    entriesPage("acc_a", [row("ent_3", "deposit", 300, null)], null, "cursor-1"),
  ]);
  assert.deepEqual(duplicated.violations.map((violation) => violation.code), ["duplicate_entry_in_enumeration"]);
  assert.equal(duplicated.violations[0].evidence.supporting[0].index, 0);

  const unanchored = score([entriesPage("acc_a", [row("ent_3", "deposit", 300, null)], null, "someone-elses-cursor")]);
  assert.equal(unanchored.applicability.pagination, false);
  assert.deepEqual(unanchored.violations, []);
});

test("balance agreement: applicable only when nothing was written in between", () => {
  const balanceRead = entry("GET", "/accounts/acc_a", { body: { id: "acc_a", status: "active", balance: 900 } });
  const enumeration = entriesPage("acc_a", [row("ent_1", "deposit", 1000, null)]);

  const quiet = score([reset(), balanceRead, enumeration]);
  assert.equal(quiet.applicability.balance_agreement, true);
  assert.deepEqual(quiet.violations.map((violation) => violation.code), ["stored_balance_diverged"]);
  assert.equal(quiet.violations[0].evidence.subject.derived, 1000);

  const noisy = score([
    reset(),
    balanceRead,
    entry("POST", "/deposits", { status: 201, body: { id: "dep_1", status: "settled" } }),
    enumeration,
  ]);
  assert.equal(noisy.applicability.balance_agreement, false, "a write between the two reads voids the comparison");
  assert.deepEqual(noisy.violations, []);

  const incomplete = score([
    reset(),
    balanceRead,
    entriesPage("acc_a", [row("ent_1", "deposit", 1000, null)], "cursor-1"),
  ]);
  assert.equal(incomplete.applicability.balance_agreement, false, "a partial enumeration proves nothing");
});

test("protocol: any 5xx is a violation, wherever it lands", () => {
  const result = score([
    entry("POST", "/transfers", { status: 503, body: { error: { code: "internal_error", message: "boom" } } }),
  ]);
  assert.deepEqual(result.violations.map((violation) => violation.code), ["unexpected_server_error"]);
  assert.equal(result.violations[0].evidence.request.path, "/transfers");
});

test("violations are ordered by the request they cite", () => {
  const result = score([
    reset(),
    account("acc_a", "pending"),
    entry("POST", "/transfers", {
      status: 201,
      request: { source_account_id: "acc_a", destination_account_id: "acc_b", amount: 10 },
      body: { id: "tr_1", status: "pending" },
    }),
    entry("GET", "/accounts/acc_z", { status: 500, body: { error: { code: "internal_error", message: "x" } } }),
  ]);
  assert.deepEqual(result.violations.map((violation) => violation.evidence.request.index), [2, 3]);
});
