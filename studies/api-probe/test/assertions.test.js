// Every probe assertion, over hand-built traces.
//
// The contract each one has to hold, per invariant:
//   - a trace containing the violation is a FAILED check naming the oracle,
//     the violation code, and the request it happened on;
//   - a trace that exercised the rule without breaking it PASSES;
//   - a trace that never reached the state the rule talks about is neither —
//     it fails as NOT_EXERCISED, so an actor cannot earn a green run by
//     exploring nothing.
//
// Hermetic: no network, no model, no ledger fixture, no clock. Not part of the
// root gate — run it with `node --test studies/api-probe/test/`.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import conservation from "../assertions/ledger-conservation/assertion.js";
import idempotency from "../assertions/ledger-idempotency/assertion.js";
import lifecycle from "../assertions/ledger-lifecycle/assertion.js";
import pagination from "../assertions/ledger-pagination/assertion.js";
import errorShape from "../assertions/ledger-error-shape/assertion.js";
import balance from "../assertions/ledger-balance-agreement/assertion.js";
import { _clearOracleCache } from "../lib/oracle-gate.js";
import {
  activeAccount,
  createTransfer,
  entriesPage,
  entry,
  evaluate,
  exchange,
  reset,
} from "./support/synthetic.js";

const ALL = [
  ["ledger-conservation", conservation, ["ledger_conservation"]],
  ["ledger-idempotency", idempotency, ["ledger_idempotency"]],
  ["ledger-lifecycle", lifecycle, ["ledger_lifecycle_legality"]],
  ["ledger-pagination", pagination, ["ledger_pagination_identity"]],
  ["ledger-error-shape", errorShape, ["ledger_error_shape", "ledger_no_server_error"]],
  ["ledger-balance-agreement", balance, ["ledger_balance_agreement"]],
];

beforeEach(() => _clearOracleCache());

describe("module shape", () => {
  test("every assertion satisfies the registry contract", () => {
    for (const [name, assertion, keys] of ALL) {
      assert.equal(typeof assertion.keys, "function", `${name}: keys()`);
      assert.equal(typeof assertion.gather, "function", `${name}: gather()`);
      assert.equal(typeof assertion.verdict, "function", `${name}: verdict()`);
      assert.deepEqual(assertion.keys(), keys, `${name}: owned keys`);
      assert.equal(assertion.inheritable, false, `${name}: every probe run re-evaluates live`);
    }
  });

  test("no two assertions claim the same success key", () => {
    const seen = new Set();
    for (const [, assertion] of ALL) {
      for (const key of assertion.keys()) {
        assert.ok(!seen.has(key), `duplicate key ${key}`);
        seen.add(key);
      }
    }
    assert.equal(seen.size, 7);
  });
});

describe("conservation", () => {
  const legs = (sum) => [
    entry("ent_1", "tr_1", "transfer_debit", -1026, "acc_a"),
    entry("ent_2", "tr_1", "transfer_credit", 1000, "acc_b"),
    entry("ent_3", "tr_1", "fee", 26 + sum, "acc_fee_usd"),
  ];

  test("a settled transfer whose legs do not sum to zero is a violation", () => {
    const verdict = evaluate(conservation, "ledger_conservation", "settled transfers", [
      reset(),
      createTransfer("tr_1"),
      entriesPage("acc_a", legs(-1)),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: conservation\/transfer_entries_nonzero/);
    assert.match(verdict.detail, /sum to -1, not 0/);
    assert.match(verdict.detail, /GET \/accounts\/acc_a\/entries/);
  });

  test("a settled transfer whose legs balance passes", () => {
    const verdict = evaluate(conservation, "ledger_conservation", "settled transfers", [
      reset(),
      createTransfer("tr_1"),
      entriesPage("acc_a", legs(0)),
    ]);
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /^HELD: conservation/);
  });

  test("entries missing the fee leg are not judged at all", () => {
    // Applicability, not leniency: an unbalanced-looking pair that is simply
    // incompletely observed must never be reported as a counterexample.
    const verdict = evaluate(conservation, "ledger_conservation", "settled transfers", [
      reset(),
      createTransfer("tr_1"),
      entriesPage("acc_a", legs(-1).slice(0, 2)),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NOT_EXERCISED: conservation/);
    assert.match(verdict.detail, /Needs: at least one transfer settled/);
  });
});

describe("idempotency", () => {
  test("one key and one body producing two transfers is a violation", () => {
    const verdict = evaluate(idempotency, "ledger_idempotency", "one key, one effect", [
      reset(),
      createTransfer("tr_1", { key: "k-1" }),
      createTransfer("tr_2", { key: "k-1" }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: idempotency\/idempotency_key_diverged/);
    assert.match(verdict.detail, /"k-1"/);
  });

  test("a replay returning the original transfer passes", () => {
    const verdict = evaluate(idempotency, "ledger_idempotency", "one key, one effect", [
      reset(),
      createTransfer("tr_1", { key: "k-1" }),
      createTransfer("tr_1", { key: "k-1" }),
    ]);
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /^HELD: idempotency/);
  });

  test("a ledger effect for a transfer this run never created is a violation", () => {
    const verdict = evaluate(idempotency, "ledger_idempotency", "one key, one effect", [
      reset(),
      createTransfer("tr_1", { key: "k-1" }),
      entriesPage("acc_a", [entry("ent_9", "tr_ghost", "transfer_debit", -500, "acc_a")]),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: idempotency\/phantom_ledger_effect/);
    assert.match(verdict.detail, /tr_ghost/);
  });

  test("a run that never used an idempotency key is not exercised", () => {
    const verdict = evaluate(idempotency, "ledger_idempotency", "one key, one effect", [
      exchange("GET", "/accounts", 200, { items: [], next_cursor: null }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NOT_EXERCISED: idempotency/);
  });
});

describe("lifecycle legality", () => {
  test("a transfer accepted against a closed account is a violation", () => {
    const verdict = evaluate(lifecycle, "ledger_lifecycle_legality", "transfers and closures", [
      reset(),
      activeAccount("acc_a"),
      exchange("POST", "/accounts/acc_a/close", 200, { id: "acc_a", status: "closed" }),
      createTransfer("tr_1", { source: "acc_a" }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: lifecycle\/transfer_on_closed_account/);
    assert.match(verdict.detail, /acc_a/);
  });

  test("closing an account with a pending transfer is a violation", () => {
    const verdict = evaluate(lifecycle, "ledger_lifecycle_legality", "transfers and closures", [
      reset(),
      activeAccount("acc_a"),
      createTransfer("tr_1", { source: "acc_a" }),
      exchange("POST", "/accounts/acc_a/close", 200, { id: "acc_a", status: "closed" }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: lifecycle\/close_with_pending_transfers/);
  });

  test("cancelling a transfer that already settled is a violation", () => {
    const verdict = evaluate(lifecycle, "ledger_lifecycle_legality", "transfers and closures", [
      reset(),
      activeAccount("acc_a"),
      createTransfer("tr_1", { source: "acc_a" }),
      exchange("POST", "/admin/tick", 200, { settled: ["tr_1"], failed: [] }),
      exchange("POST", "/transfers/tr_1/cancel", 200, { id: "tr_1", status: "canceled" }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: lifecycle\/cancel_after_settlement/);
  });

  test("a transfer between active accounts, and a refused close, pass", () => {
    const verdict = evaluate(lifecycle, "ledger_lifecycle_legality", "transfers and closures", [
      reset(),
      activeAccount("acc_a"),
      activeAccount("acc_b"),
      createTransfer("tr_1"),
      exchange("POST", "/accounts/acc_a/close", 409, {
        error: { code: "account_has_pending_transfers", message: "no" },
      }),
    ]);
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /^HELD: lifecycle/);
  });

  test("a run with no transfer, close, or cancel is not exercised", () => {
    const verdict = evaluate(lifecycle, "ledger_lifecycle_legality", "transfers and closures", [
      reset(),
      activeAccount("acc_a"),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NOT_EXERCISED: lifecycle/);
  });
});

describe("pagination identity", () => {
  const e = (id) => entry(id, "tr_1", "transfer_credit", 10, "acc_a");

  test("an entry returned twice in one enumeration is a violation", () => {
    const verdict = evaluate(pagination, "ledger_pagination_identity", "one enumeration", [
      entriesPage("acc_a", [e("ent_1"), e("ent_2")], { nextCursor: "c1" }),
      entriesPage("acc_a", [e("ent_2"), e("ent_3")], { cursor: "c1", nextCursor: null }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: pagination\/duplicate_entry_in_enumeration/);
    assert.match(verdict.detail, /ent_2/);
  });

  test("a clean two-page enumeration passes", () => {
    const verdict = evaluate(pagination, "ledger_pagination_identity", "one enumeration", [
      entriesPage("acc_a", [e("ent_1"), e("ent_2")], { nextCursor: "c1" }),
      entriesPage("acc_a", [e("ent_3")], { cursor: "c1", nextCursor: null }),
    ]);
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /^HELD: pagination/);
  });

  test("a repeat inside an unanchored enumeration is not scored", () => {
    // A page fetched with a cursor nobody handed out is not an enumeration the
    // rule talks about, so it can neither pass nor fail on identity.
    const verdict = evaluate(pagination, "ledger_pagination_identity", "one enumeration", [
      entriesPage("acc_a", [e("ent_1")], { cursor: "invented", nextCursor: null }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NOT_EXERCISED: pagination/);
  });
});

describe("error shape and protocol", () => {
  test("a 4xx body that is not the envelope is a violation", () => {
    const verdict = evaluate(errorShape, "ledger_error_shape", "refusals", [
      exchange("POST", "/transfers", 422, { message: "insufficient funds" }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: error_shape\/error_envelope_violation/);
  });

  test("a refusal dressed as a 2xx is a violation", () => {
    const verdict = evaluate(errorShape, "ledger_error_shape", "refusals", [
      exchange("POST", "/transfers", 200, {
        id: "tr_1",
        status: "failed",
        failure_reason: "insufficient_funds",
      }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: error_shape\/failure_masked_as_2xx/);
  });

  test("well-formed envelopes pass", () => {
    const verdict = evaluate(errorShape, "ledger_error_shape", "refusals", [
      exchange("POST", "/transfers", 422, {
        error: { code: "insufficient_funds", message: "balance is 0", details: {} },
      }),
      exchange("GET", "/accounts/nope", 404, { error: { code: "not_found", message: "no such account" } }),
    ]);
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /^HELD: error_shape/);
  });

  test("a run with nothing refused is not exercised", () => {
    const verdict = evaluate(errorShape, "ledger_error_shape", "refusals", [
      exchange("GET", "/accounts", 200, { items: [], next_cursor: null }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NOT_EXERCISED: error_shape/);
  });

  test("a 5xx fails the protocol key", () => {
    const verdict = evaluate(errorShape, "ledger_no_server_error", "every request", [
      exchange("POST", "/transfers", 500, { error: { code: "internal", message: "boom" } }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: protocol\/unexpected_server_error/);
    assert.match(verdict.detail, /500/);
  });

  test("the protocol key passes on a trace with no 5xx", () => {
    const verdict = evaluate(errorShape, "ledger_no_server_error", "every request", [
      exchange("GET", "/accounts", 200, { items: [], next_cursor: null }),
    ]);
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /^HELD: protocol/);
  });

  test("one gather serves both of the module's keys independently", () => {
    const exchanges = [
      exchange("POST", "/transfers", 500, { error: { code: "internal", message: "boom" } }),
      exchange("GET", "/accounts/nope", 404, { error: { code: "not_found", message: "no" } }),
    ];
    const shape = evaluate(errorShape, "ledger_error_shape", "refusals", exchanges);
    _clearOracleCache();
    const protocol = evaluate(errorShape, "ledger_no_server_error", "every request", exchanges);
    // The 500 carries a valid envelope, so error-shape holds while protocol does not.
    assert.equal(shape.pass, true);
    assert.equal(protocol.pass, false);
  });
});

describe("balance agreement", () => {
  const enumeration = (accountId, amounts) => [
    entriesPage(
      accountId,
      amounts.map((amount, index) => entry(`ent_${index}`, "tr_1", "transfer_credit", amount, accountId)),
      { nextCursor: null },
    ),
  ];

  test("a stored balance that disagrees with the entry sum is a violation", () => {
    const verdict = evaluate(balance, "ledger_balance_agreement", "consistent pair", [
      reset(),
      activeAccount("acc_a", 90),
      ...enumeration("acc_a", [60, 40]),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: balance_agreement\/stored_balance_diverged/);
    assert.match(verdict.detail, /balance 90 but its 2 entries sum to 100/);
  });

  test("an agreeing pair passes", () => {
    const verdict = evaluate(balance, "ledger_balance_agreement", "consistent pair", [
      reset(),
      activeAccount("acc_a", 100),
      ...enumeration("acc_a", [60, 40]),
    ]);
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /^HELD: balance_agreement/);
  });

  test("a write between the two reads makes the pair unusable", () => {
    const verdict = evaluate(balance, "ledger_balance_agreement", "consistent pair", [
      reset(),
      activeAccount("acc_a", 90),
      createTransfer("tr_2", { source: "acc_a" }),
      ...enumeration("acc_a", [60, 40]),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NOT_EXERCISED: balance_agreement/);
    assert.match(verdict.detail, /no write of any kind between them/);
  });

  test("an incomplete enumeration is not a consistent pair", () => {
    const verdict = evaluate(balance, "ledger_balance_agreement", "consistent pair", [
      reset(),
      activeAccount("acc_a", 90),
      entriesPage("acc_a", [entry("ent_0", "tr_1", "transfer_credit", 60, "acc_a")], { nextCursor: "c1" }),
    ]);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NOT_EXERCISED: balance_agreement/);
  });
});

describe("evidence integrity", () => {
  test("a missing har.json is an empty trace, not a crash", () => {
    // The api driver writes har.json on its first request; a run that made none
    // has nothing to read, and that is a real outcome rather than infrastructure
    // failure.
    const verdict = evaluate(conservation, "ledger_conservation", "settled transfers", []);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NOT_EXERCISED: conservation/);
    assert.match(verdict.detail, /0 requests/);
  });

  test("verdict without gathered evidence fails loudly", () => {
    const verdict = conservation.verdict({ key: "ledger_conservation", value: "x", evidence: undefined });
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^NO_EVIDENCE/);
  });

  test("a violation inside an incomplete trace still fails, and says the trace was short", () => {
    // Truncation drops a suffix, so every exchange the gate can see still has
    // its full history: a counterexample found in the prefix is real.
    const verdict = evaluate(
      conservation,
      "ledger_conservation",
      "settled transfers",
      [
        reset(),
        createTransfer("tr_1"),
        entriesPage("acc_a", [
          entry("ent_1", "tr_1", "transfer_debit", -1026, "acc_a"),
          entry("ent_2", "tr_1", "transfer_credit", 1000, "acc_b"),
          entry("ent_3", "tr_1", "fee", 25, "acc_fee_usd"),
        ]),
        exchange("GET", "/accounts/acc_b", 200, { id: "acc_b", status: "active", balance: 1000 }),
      ],
      { missing: 1 },
    );
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^VIOLATED: conservation/);
  });

  test("an incomplete trace never fails a rule for being unexercised", () => {
    // The opposite direction: blaming the actor for evidence the harness had
    // not present would be a false gate failure, so it reports instead.
    const verdict = evaluate(
      balance,
      "ledger_balance_agreement",
      "consistent pair",
      [reset(), activeAccount("acc_a", 100), entriesPage("acc_a", [], { nextCursor: null })],
      { missing: 1 },
    );
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /^INCONCLUSIVE: balance_agreement/);
    assert.match(verdict.detail, /2 of 3 recorded requests/);
  });
});
