// Clean-build behaviour: the contract the OpenAPI document promises and the
// invariants of DESIGN §6.2 hold when no fault is enabled.

import assert from "node:assert/strict";
import test from "node:test";
import { withFixture, ADMIN_TOKEN, CUSTOMER_TOKEN } from "./support/harness.js";
import { feeFor, DAILY_LIMIT, FEE_FLAT } from "../src/ledger.js";

const clean = (body) => withFixture({}, body);

test("health and the OpenAPI document are public; everything else needs a token", async () => {
  await clean(async ({ client }) => {
    const health = await client.get("/health", { token: null });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    // The service must never disclose which faults are enabled.
    assert.equal(JSON.stringify(health.body).includes("fault"), false);

    const spec = await client.get("/openapi.json", { token: null });
    assert.equal(spec.status, 200);
    assert.equal(spec.body.openapi, "3.1.0");

    const unauthorized = await client.get("/accounts", { token: null });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error.code, "unauthorized");
    assert.match(unauthorized.headers["www-authenticate"] ?? "", /Bearer/);

    const bogus = await client.get("/accounts", { token: "not-a-token" });
    assert.equal(bogus.status, 401);
  });
});

test("the customer role cannot reach admin operations", async () => {
  await clean(async ({ client, customer }) => {
    const forbidden = await customer.post("/admin/tick", {});
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, "forbidden");

    const account = await customer.post("/accounts", { owner: "carol", currency: "USD" });
    assert.equal(account.status, 201, "customers may still open accounts");

    const admin = await client.post("/admin/tick", {});
    assert.equal(admin.status, 200);
    assert.notEqual(ADMIN_TOKEN, CUSTOMER_TOKEN);
  });
});

test("an account is owned by the principal that opened it; only an admin opens one for someone else", async () => {
  await clean(async ({ client, customer, customerB }) => {
    const own = await customer.post("/accounts", { owner: "carol", currency: "USD" });
    assert.equal(own.status, 201);
    assert.equal(own.body.owner_principal, "customer_a");

    const onBehalf = await client.post("/accounts", {
      owner: "dave",
      currency: "USD",
      owner_principal: "customer_b",
    });
    assert.equal(onBehalf.status, 201);
    assert.equal(onBehalf.body.owner_principal, "customer_b");
    assert.equal((await customerB.get(`/accounts/${onBehalf.body.id}`)).status, 200);

    const impersonated = await customer.post("/accounts", {
      owner: "eve",
      currency: "USD",
      owner_principal: "customer_b",
    });
    assert.equal(impersonated.status, 403);
    assert.equal(impersonated.body.error.code, "forbidden");

    const adminOwned = await client.post("/accounts", { owner: "frank", currency: "USD" });
    assert.equal(adminOwned.body.owner_principal, "admin");
  });
});

test("a customer principal cannot reach another principal's account", async () => {
  await clean(async ({ client, customer, customerB }) => {
    const mine = (await customer.post("/accounts", { owner: "carol", currency: "USD" })).body;
    await customer.post(`/accounts/${mine.id}/activate`);
    await client.post("/deposits", { account_id: mine.id, amount: 10_000 });

    for (const [method, path, body] of [
      ["GET", `/accounts/${mine.id}`, undefined],
      ["GET", `/accounts/${mine.id}/entries`, undefined],
      ["POST", `/accounts/${mine.id}/activate`, {}],
      ["POST", `/accounts/${mine.id}/close`, {}],
      ["POST", "/deposits", { account_id: mine.id, amount: 100 }],
    ]) {
      const response = await customerB.request(method, path, { body });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.body.error.code, "forbidden");
      assert.equal(response.body.error.details.id, mine.id);
    }

    // Existence is checked before ownership: a mistyped id is still a 404.
    assert.equal((await customerB.get("/accounts/acc_missing")).status, 404);

    // Listings are scoped rather than refused.
    const listed = await customerB.get("/accounts");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.some((account) => account.id === mine.id), false);
    assert.ok((await customer.get("/accounts")).body.items.some((account) => account.id === mine.id));
  });
});

test("only the payer spends: transfers debit an account the caller owns", async () => {
  await clean(async ({ client, customer, customerB }) => {
    const payer = (await customer.post("/accounts", { owner: "carol", currency: "USD" })).body;
    await customer.post(`/accounts/${payer.id}/activate`);
    await client.post("/deposits", { account_id: payer.id, amount: 10_000 });
    const payee = (await customerB.post("/accounts", { owner: "dave", currency: "USD" })).body;
    await customerB.post(`/accounts/${payee.id}/activate`);

    const stolen = await customerB.post("/transfers", {
      source_account_id: payer.id,
      destination_account_id: payee.id,
      amount: 1000,
    });
    assert.equal(stolen.status, 403);
    assert.equal(stolen.body.error.code, "forbidden");

    // Paying an account you cannot read is the ordinary case.
    const paid = await customer.post("/transfers", {
      source_account_id: payer.id,
      destination_account_id: payee.id,
      amount: 1000,
    });
    assert.equal(paid.status, 201);

    // Both parties see the transfer; nobody else does.
    assert.equal((await customer.get(`/transfers/${paid.body.id}`)).status, 200);
    assert.equal((await customerB.get(`/transfers/${paid.body.id}`)).status, 200);
    assert.equal((await client.get(`/transfers/${paid.body.id}`)).status, 200);

    // Cancellation returns the reserved funds to the source, so the payer cancels.
    const payeeCancel = await customerB.post(`/transfers/${paid.body.id}/cancel`);
    assert.equal(payeeCancel.status, 403);
    assert.equal((await customer.post(`/transfers/${paid.body.id}/cancel`)).status, 200);
  });
});

test("the system fee accounts are readable by every principal and actable by none", async () => {
  await clean(async ({ customer }) => {
    const fee = await customer.get("/accounts/acc_fee_usd");
    assert.equal(fee.status, 200);
    assert.equal(fee.body.owner_principal, "minibank");
    assert.equal((await customer.get("/accounts/acc_fee_usd/entries")).status, 200);

    const closed = await customer.post("/accounts/acc_fee_usd/close");
    assert.equal(closed.status, 403);
    const funded = await customer.post("/deposits", { account_id: "acc_fee_usd", amount: 10 });
    assert.equal(funded.status, 403);
  });
});

test("accounts move pending -> active -> closed and closure is a soft delete", async () => {
  await clean(async ({ client }) => {
    const created = await client.post("/accounts", { owner: "alice", currency: "USD" });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "pending");
    assert.equal(created.body.balance, 0);
    assert.equal(created.body.kind, "customer");

    const activated = await client.post(`/accounts/${created.body.id}/activate`);
    assert.equal(activated.status, 200);
    assert.equal(activated.body.status, "active");

    const again = await client.post(`/accounts/${created.body.id}/activate`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "account_not_pending");

    const listed = await client.get("/accounts");
    assert.ok(listed.body.items.some((account) => account.id === created.body.id));

    const closed = await client.post(`/accounts/${created.body.id}/close`);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "closed");

    const tombstone = await client.get(`/accounts/${created.body.id}`);
    assert.equal(tombstone.status, 410);
    assert.equal(tombstone.body.error.code, "account_closed");
    assert.equal(tombstone.body.error.details.status, "closed");

    const withoutClosed = await client.get("/accounts");
    assert.equal(withoutClosed.body.items.some((account) => account.id === created.body.id), false);
    const withClosed = await client.get("/accounts?include_closed=true");
    assert.ok(withClosed.body.items.some((account) => account.id === created.body.id));

    // A closed account keeps serving its ledger history.
    const entries = await client.get(`/accounts/${created.body.id}/entries`);
    assert.equal(entries.status, 200);

    assert.equal((await client.get("/accounts/acc_missing")).status, 404);
  });
});

test("system fee accounts exist for every currency and cannot be closed", async () => {
  await clean(async ({ client }) => {
    for (const id of ["acc_fee_usd", "acc_fee_eur"]) {
      const account = await client.get(`/accounts/${id}`);
      assert.equal(account.status, 200);
      assert.equal(account.body.kind, "system");
      assert.equal(account.body.status, "active");
      const closed = await client.post(`/accounts/${id}/close`);
      assert.equal(closed.status, 409);
      assert.equal(closed.body.error.code, "account_not_closable");
    }
  });
});

test("deposits fund only active accounts and settle immediately", async () => {
  await clean(async ({ client }) => {
    const pending = await client.post("/accounts", { owner: "alice", currency: "USD" });
    const rejected = await client.post("/deposits", { account_id: pending.body.id, amount: 1000 });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "account_not_active");

    await client.post(`/accounts/${pending.body.id}/activate`);
    const deposit = await client.post("/deposits", { account_id: pending.body.id, amount: 1000 });
    assert.equal(deposit.status, 201);
    assert.equal(deposit.body.status, "settled");

    const readBack = await client.get(`/deposits/${deposit.body.id}`);
    assert.deepEqual(readBack.body, deposit.body);

    const account = await client.get(`/accounts/${pending.body.id}`);
    assert.equal(account.body.balance, 1000);

    const entries = await client.allEntries(pending.body.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "deposit");
    assert.equal(entries[0].amount, 1000);
    assert.equal(entries[0].deposit_id, deposit.body.id);

    for (const [body, code, status] of [
      [{ account_id: pending.body.id, amount: 0 }, "invalid_amount", 422],
      [{ account_id: pending.body.id, amount: -5 }, "invalid_amount", 422],
      [{ account_id: pending.body.id, amount: 1.5 }, "invalid_request", 400],
      [{ account_id: "acc_nope", amount: 10 }, "account_not_found", 404],
      [{ amount: 10 }, "invalid_request", 400],
    ]) {
      const response = await client.post("/deposits", body);
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(response.body.error.code, code);
    }
  });
});

test("transfer creation enforces its documented business rules", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 10_000);
    const destination = await client.openAccount("bob");
    const euro = await client.openAccount("elke", "EUR");
    const inactive = await client.post("/accounts", { owner: "ivan", currency: "USD" });

    const cases = [
      [{ source_account_id: source.id, destination_account_id: "acc_nope", amount: 100 }, 404, "account_not_found"],
      [{ source_account_id: source.id, destination_account_id: source.id, amount: 100 }, 422, "same_account"],
      [{ source_account_id: source.id, destination_account_id: euro.id, amount: 100 }, 422, "currency_mismatch"],
      [
        { source_account_id: source.id, destination_account_id: destination.id, amount: 100, currency: "EUR" },
        422,
        "currency_mismatch",
      ],
      [
        { source_account_id: source.id, destination_account_id: inactive.body.id, amount: 100 },
        409,
        "account_not_active",
      ],
      [{ source_account_id: source.id, destination_account_id: destination.id, amount: 0 }, 422, "invalid_amount"],
      [
        { source_account_id: source.id, destination_account_id: destination.id, amount: 99_999 },
        422,
        "insufficient_funds",
      ],
      [{ destination_account_id: destination.id, amount: 10 }, 400, "invalid_request"],
    ];
    for (const [body, status, code] of cases) {
      const response = await client.post("/transfers", body);
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(response.body.error.code, code, JSON.stringify(body));
    }
  });
});

// The 400/422 split, from both sides. A field of the wrong type is a malformed
// request and answers 400; a well-typed value the business declines answers
// 422. The two are easiest to confuse on `amount`, which is where this fixture
// used to collapse them (studies/api-suite/rounds/ROUND-LOG.md, defect D2).
test("a wrongly typed or missing field is 400, never 422", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 50_000);
    const destination = await client.openAccount("bob");
    const pair = { source_account_id: source.id, destination_account_id: destination.id };

    const cases = [
      // POST /transfers — the amount's type
      ["/transfers", { ...pair, amount: "ten" }],
      ["/transfers", { ...pair, amount: "100" }],
      ["/transfers", { ...pair, amount: 1.5 }],
      ["/transfers", { ...pair, amount: true }],
      ["/transfers", { ...pair, amount: null }],
      ["/transfers", { ...pair, amount: [100] }],
      ["/transfers", { ...pair, amount: { value: 100 } }],
      ["/transfers", pair],
      // POST /transfers — the optional currency assertion's type
      ["/transfers", { ...pair, amount: 100, currency: 840 }],
      ["/transfers", { ...pair, amount: 100, currency: null }],
      // POST /transfers — the identifiers' types
      ["/transfers", { source_account_id: 7, destination_account_id: destination.id, amount: 100 }],
      ["/transfers", { source_account_id: source.id, destination_account_id: false, amount: 100 }],
      // POST /deposits
      ["/deposits", { account_id: source.id, amount: "ten" }],
      ["/deposits", { account_id: source.id, amount: 1.5 }],
      ["/deposits", { account_id: source.id, amount: null }],
      ["/deposits", { account_id: source.id }],
      ["/deposits", { account_id: 7, amount: 100 }],
      // POST /accounts
      ["/accounts", { owner: "dave" }],
      ["/accounts", { owner: "dave", currency: 840 }],
      ["/accounts", { owner: "dave", currency: null }],
      ["/accounts", { owner: 7, currency: "USD" }],
    ];

    for (const [path, body] of cases) {
      const label = `POST ${path} ${JSON.stringify(body)}`;
      const response = await client.post(path, body);
      assert.equal(response.status, 400, label);
      assert.equal(response.body.error.code, "invalid_request", label);
      // The envelope holds on the 400 side too, and it names the field.
      assert.equal(typeof response.body.error.message, "string", label);
      assert.ok(response.body.error.details?.field, label);
    }
  });
});

test("a well-formed request a business rule declines is 422, never 400", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 50_000);
    const destination = await client.openAccount("bob");
    const euro = await client.openAccount("elke", "EUR");
    const pair = { source_account_id: source.id, destination_account_id: destination.id };
    const limitBreaker = await client.fundedAccount("mallory", 500_000);
    const limitDestination = await client.openAccount("mona");

    const cases = [
      // Well-typed integers the business will not accept.
      ["/transfers", { ...pair, amount: 0 }, "invalid_amount"],
      ["/transfers", { ...pair, amount: -100 }, "invalid_amount"],
      ["/deposits", { account_id: source.id, amount: 0 }, "invalid_amount"],
      ["/deposits", { account_id: source.id, amount: -100 }, "invalid_amount"],
      // Well-formed values refused for what they mean, not for their type.
      ["/transfers", { source_account_id: source.id, destination_account_id: source.id, amount: 100 }, "same_account"],
      ["/transfers", { ...pair, amount: 100, currency: "EUR" }, "currency_mismatch"],
      ["/transfers", { source_account_id: source.id, destination_account_id: euro.id, amount: 100 }, "currency_mismatch"],
      ["/transfers", { ...pair, amount: 49_990 }, "insufficient_funds"],
      // A string naming a currency this ledger does not carry: well-formed,
      // and declined for what it asks for.
      ["/accounts", { owner: "dave", currency: "GBP" }, "unsupported_currency"],
      // Over the daily limit: the value is impeccable, the rule says no.
      [
        "/transfers",
        { source_account_id: limitBreaker.id, destination_account_id: limitDestination.id, amount: 100_001 },
        "daily_limit_exceeded",
      ],
    ];

    for (const [path, body, code] of cases) {
      const label = `POST ${path} ${JSON.stringify(body)}`;
      const response = await client.post(path, body);
      assert.equal(response.status, 422, label);
      assert.equal(response.body.error.code, code, label);
    }
  });
});

// Bodies are strict, query strings are not. Every request schema declares
// `additionalProperties: false`; the only declared leniency is for unknown
// *query* parameters (studies/api-suite/rounds/ROUND-LOG.md, defect D3).
test("an unknown body property is refused on every operation that takes a body", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 50_000);
    const destination = await client.openAccount("bob");

    const cases = [
      ["/accounts", { owner: "dave", currency: "USD", nonsense: true }, "nonsense"],
      ["/accounts", { owner: "dave", currency: "USD", Currency: "EUR" }, "Currency"],
      ["/deposits", { account_id: source.id, amount: 100, bogus: 1 }, "bogus"],
      // The mistake this rule is really about: a header sent in the body.
      [
        "/transfers",
        {
          source_account_id: source.id,
          destination_account_id: destination.id,
          amount: 100,
          idempotency_key: "k-1",
        },
        "idempotency_key",
      ],
      ["/transfers", { source_account_id: source.id, destination_account_id: destination.id, amount: 100, fee: 0 }, "fee"],
      ["/admin/tick", { settle_limit: 1, advance_days: true }, "advance_days"],
      ["/admin/reset", { seed: "ledger-dev-seed", faults: "f-close-ghost" }, "faults"],
    ];

    for (const [path, body, field] of cases) {
      const label = `POST ${path} ${JSON.stringify(body)}`;
      const response = await client.post(path, body);
      assert.equal(response.status, 400, label);
      assert.equal(response.body.error.code, "invalid_request", label);
      assert.equal(response.body.error.details.field, field, label);
      assert.match(response.body.error.message, /unknown property/, label);
    }

    // The typed properties of an admin body are enforced too, rather than
    // coerced or dropped.
    for (const [body, field] of [
      [{ settle_limit: "1" }, "settle_limit"],
      [{ settle_limit: 1.5 }, "settle_limit"],
      [{ settle_limit: -1 }, "settle_limit"],
      [{ advance_day: "true" }, "advance_day"],
      [{ advance_day: 1 }, "advance_day"],
    ]) {
      const label = `POST /admin/tick ${JSON.stringify(body)}`;
      const response = await client.post("/admin/tick", body);
      assert.equal(response.status, 400, label);
      assert.equal(response.body.error.code, "invalid_request", label);
      assert.equal(response.body.error.details.field, field, label);
    }
  });
});

test("the declared exception holds: an unknown query parameter is ignored", async () => {
  await clean(async ({ client }) => {
    const plain = await client.get("/accounts?limit=5");
    const noisy = await client.get("/accounts?limit=5&bogus=1&include_closed=false&utm_source=x");
    assert.equal(noisy.status, 200);
    assert.deepEqual(noisy.body, plain.body);

    const transfers = await client.get("/transfers?nonsense=yes");
    assert.equal(transfers.status, 200);
  });
});

test("the fee schedule is flat plus basis points, rounded half up", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 50_000);
    const destination = await client.openAccount("bob");
    // 1000 * 15 / 10000 = 1.5 exactly -> rounds up to 2.
    assert.equal(feeFor(1000), FEE_FLAT + 2);
    assert.equal(feeFor(1200), FEE_FLAT + 2);
    assert.equal(feeFor(1), FEE_FLAT + 0);

    for (const amount of [1, 1000, 1200, 3333]) {
      const created = await client.post("/transfers", {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount,
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.fee, feeFor(amount), `fee for ${amount}`);
      assert.equal(created.body.status, "pending");
      assert.equal(created.body.fee_account_id, "acc_fee_usd");
      await client.post(`/transfers/${created.body.id}/cancel`);
    }
  });
});

test("settlement happens only on an admin tick and conserves value", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 10_000);
    const destination = await client.openAccount("bob");
    const created = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 1000,
    });

    // Nothing moves without a tick.
    assert.equal((await client.get(`/accounts/${source.id}`)).body.balance, 10_000);
    assert.equal((await client.allEntries(source.id)).length, 1);

    const ticked = await client.tick();
    assert.deepEqual(ticked.body.settled, [created.body.id]);
    assert.deepEqual(ticked.body.failed, []);
    assert.equal(ticked.body.pending, 0);

    const settled = await client.get(`/transfers/${created.body.id}`);
    assert.equal(settled.body.status, "settled");
    assert.ok(settled.body.settled_at);

    const fee = feeFor(1000);
    assert.equal((await client.get(`/accounts/${source.id}`)).body.balance, 10_000 - 1000 - fee);
    assert.equal((await client.get(`/accounts/${destination.id}`)).body.balance, 1000);
    assert.equal((await client.get("/accounts/acc_fee_usd")).body.balance, fee);

    const rows = [
      ...(await client.allEntries(source.id)),
      ...(await client.allEntries(destination.id)),
      ...(await client.allEntries("acc_fee_usd")),
    ].filter((entry) => entry.transfer_id === created.body.id);
    assert.equal(rows.length, 3);
    assert.equal(rows.reduce((total, entry) => total + entry.amount, 0), 0, "conservation");
    assert.deepEqual(rows.map((entry) => entry.kind).sort(), ["fee", "transfer_credit", "transfer_debit"]);

    // Derived balance equals stored balance for every account touched.
    for (const id of [source.id, destination.id, "acc_fee_usd"]) {
      const derived = (await client.allEntries(id)).reduce((total, entry) => total + entry.amount, 0);
      assert.equal((await client.get(`/accounts/${id}`)).body.balance, derived, `balance agreement for ${id}`);
    }
  });
});

test("a transfer that can no longer be covered fails at settlement and writes no entries", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 3000);
    const destination = await client.openAccount("bob");
    const first = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 1500,
    });
    const second = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 1500,
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const ticked = await client.tick();
    assert.deepEqual(ticked.body.settled, [first.body.id]);
    assert.deepEqual(ticked.body.failed, [second.body.id]);

    const failed = await client.get(`/transfers/${second.body.id}`);
    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.failure_reason, "insufficient_funds");
    const rows = (await client.allEntries(source.id)).filter((entry) => entry.transfer_id === second.body.id);
    assert.deepEqual(rows, []);
  });
});

test("Idempotency-Key replays return the original transfer and post one effect", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 10_000);
    const destination = await client.openAccount("bob");
    const body = { source_account_id: source.id, destination_account_id: destination.id, amount: 1200 };

    const first = await client.post("/transfers", body, { headers: { "idempotency-key": "abc" } });
    assert.equal(first.status, 201);
    const replay = await client.post("/transfers", body, { headers: { "idempotency-key": "abc" } });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.body.id, first.body.id);

    const conflict = await client.post(
      "/transfers",
      { ...body, amount: 1300 },
      { headers: { "idempotency-key": "abc" } },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "idempotency_key_conflict");

    await client.tick();
    const debits = (await client.allEntries(source.id)).filter((entry) => entry.kind === "transfer_debit");
    assert.equal(debits.length, 1, "one key, one ledger effect");
    assert.equal(debits[0].transfer_id, first.body.id);
  });
});

test("the daily limit is inclusive and rolls over with the ledger day", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 300_000);
    const destination = await client.openAccount("bob");
    const transfer = (amount) =>
      client.post("/transfers", {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount,
      });

    const atLimit = await transfer(DAILY_LIMIT);
    assert.equal(atLimit.status, 201, "exactly the limit is allowed");

    const beyond = await transfer(1);
    assert.equal(beyond.status, 422);
    assert.equal(beyond.body.error.code, "daily_limit_exceeded");
    assert.equal(beyond.body.error.details.limit, DAILY_LIMIT);

    const rolled = await client.tick({ advance_day: true });
    assert.equal(rolled.body.day, 1);
    const nextDay = await transfer(1);
    assert.equal(nextDay.status, 201);
  });
});

test("cancel is legal only while a transfer is pending", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 10_000);
    const destination = await client.openAccount("bob");
    const body = { source_account_id: source.id, destination_account_id: destination.id, amount: 1200 };

    const first = await client.post("/transfers", body);
    const canceled = await client.post(`/transfers/${first.body.id}/cancel`);
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.status, "canceled");

    const twice = await client.post(`/transfers/${first.body.id}/cancel`);
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, "transfer_not_pending");

    await client.tick();
    assert.deepEqual((await client.allEntries(source.id)).filter((entry) => entry.transfer_id), []);

    const second = await client.post("/transfers", body);
    await client.tick();
    const afterSettlement = await client.post(`/transfers/${second.body.id}/cancel`);
    assert.equal(afterSettlement.status, 409);
    assert.equal(afterSettlement.body.error.code, "transfer_not_pending");

    assert.equal((await client.post("/transfers/tr_nope/cancel")).status, 404);
  });
});

test("an account with pending transfers cannot be closed", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 10_000);
    const destination = await client.openAccount("bob");
    const created = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 1200,
    });

    for (const id of [source.id, destination.id]) {
      const blocked = await client.post(`/accounts/${id}/close`);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, "account_has_pending_transfers");
      assert.deepEqual(blocked.body.error.details.pending_transfer_ids, [created.body.id]);
    }

    await client.tick();
    assert.equal((await client.post(`/accounts/${destination.id}/close`)).status, 200);
    const ghost = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 100,
    });
    assert.equal(ghost.status, 410);
    assert.equal(ghost.body.error.code, "account_closed");
  });
});

test("a quiescent cursor walk returns every account exactly once at any page size", async () => {
  await clean(async ({ client }) => {
    // The two seeded fee accounts share sequence 0; before the id tie-break a
    // limit=1 walk over /accounts silently dropped acc_fee_eur (found live by
    // the S0 proposal trial's observation pass, 2026-07-26).
    for (const limit of [1, 2]) {
      const seen = [];
      let cursor = null;
      do {
        const page = await client.get(
          `/accounts?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        assert.equal(page.status, 200);
        seen.push(...page.body.items.map((account) => account.id));
        cursor = page.body.next_cursor;
      } while (cursor);
      assert.deepEqual(seen, ["acc_fee_usd", "acc_fee_eur"], `limit=${limit} walk`);
    }
  });
});

test("entry pagination is newest-first, cursor-monotone, and never duplicates", async () => {
  await clean(async ({ client }) => {
    const account = await client.fundedAccount("alice", 100);
    for (const amount of [200, 300, 400, 500]) {
      await client.post("/deposits", { account_id: account.id, amount });
    }

    const first = await client.get(`/accounts/${account.id}/entries?limit=2`);
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 2);
    assert.deepEqual(first.body.items.map((entry) => entry.amount), [500, 400]);
    assert.ok(first.body.next_cursor);

    // A write lands between pages: it may be missed, it may never duplicate.
    await client.post("/deposits", { account_id: account.id, amount: 600 });
    const second = await client.get(
      `/accounts/${account.id}/entries?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    const firstIds = new Set(first.body.items.map((entry) => entry.id));
    assert.equal(second.body.items.some((entry) => firstIds.has(entry.id)), false);
    assert.deepEqual(second.body.items.map((entry) => entry.amount), [300, 200]);

    const all = await client.allEntries(account.id);
    assert.equal(new Set(all.map((entry) => entry.id)).size, all.length);

    const badCursor = await client.get(`/accounts/${account.id}/entries?cursor=not-a-cursor`);
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.body.error.code, "invalid_cursor");

    for (const limit of ["0", "101", "abc"]) {
      const response = await client.get(`/accounts/${account.id}/entries?limit=${limit}`);
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "invalid_limit");
    }
    assert.equal((await client.get("/accounts/acc_nope/entries")).status, 404);
  });
});

test("transfers list newest-first and can be filtered by account", async () => {
  await clean(async ({ client }) => {
    const source = await client.fundedAccount("alice", 20_000);
    const destination = await client.openAccount("bob");
    const other = await client.fundedAccount("carol", 5000);
    const first = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 100,
    });
    const second = await client.post("/transfers", {
      source_account_id: other.id,
      destination_account_id: destination.id,
      amount: 200,
    });

    const all = await client.get("/transfers");
    assert.deepEqual(all.body.items.map((transfer) => transfer.id), [second.body.id, first.body.id]);
    const filtered = await client.get(`/transfers?account_id=${other.id}`);
    assert.deepEqual(filtered.body.items.map((transfer) => transfer.id), [second.body.id]);
    assert.equal(filtered.body.next_cursor, null);
  });
});

test("reset rewinds the world and the same seed replays the same identifiers", async () => {
  await clean(async ({ client }) => {
    const sequence = async () => {
      const account = await client.fundedAccount("alice", 1000);
      const entries = await client.allEntries(account.id);
      return { account: account.id, entry: entries[0].id };
    };

    await client.reset("seed-a");
    const first = await sequence();
    await client.reset("seed-a");
    const second = await sequence();
    assert.deepEqual(first, second, "identifiers are a pure function of the seed");

    const reset = await client.reset("seed-b");
    assert.equal(reset.body.ok, true);
    assert.equal(reset.body.seed, "seed-b");
    const third = await sequence();
    assert.notEqual(third.account, first.account);

    // The reset really is a full-state wipe.
    await client.reset("seed-a");
    assert.deepEqual((await client.get("/accounts")).body.items.map((account) => account.id).sort(), [
      "acc_fee_eur",
      "acc_fee_usd",
    ]);
    assert.deepEqual((await client.get("/transfers")).body.items, []);
  });
});

test("every failure uses the error envelope, and unknown routes and methods are refused", async () => {
  await clean(async ({ client }) => {
    const responses = [
      await client.get("/nope"),
      await client.get("/accounts/acc_nope"),
      await client.request("DELETE", "/accounts"),
      await client.request("POST", "/accounts", { body: "{not json" }),
      await client.get("/health", { token: null }),
    ];
    for (const response of responses.slice(0, 4)) {
      assert.deepEqual(Object.keys(response.body), ["error"], JSON.stringify(response.body));
      assert.equal(typeof response.body.error.code, "string");
      assert.equal(typeof response.body.error.message, "string");
      assert.equal(
        Object.keys(response.body.error).every((key) => ["code", "message", "details"].includes(key)),
        true,
      );
    }
    assert.equal(responses[0].status, 404);
    assert.equal(responses[2].status, 405);
    assert.equal(responses[2].headers.allow, "GET, POST");
    assert.equal(responses[3].body.error.code, "invalid_json");
    assert.equal(responses[4].status, 200);
  });
});

// Regression (found by the P1 probe against the CLEAN build, 2026-07-25): a
// malformed percent-encoding in a path segment reached decodeURIComponent and
// threw, so the service answered 500 — violating its own declared "no
// operation answers 5xx" invariant. It is a client error: 400, in the envelope.
test("a malformed percent-encoded path is a 400 in the envelope, never a 5xx", async () => {
  await clean(async ({ client }) => {
    for (const path of ["/accounts/%", "/accounts/%E0%A4%A", "/transfers/%", "/accounts/%zz", "/accounts/%/entries"]) {
      const response = await client.get(path);
      assert.equal(response.status, 400, `${path} should be 400, got ${response.status}`);
      assert.equal(response.body.error.code, "invalid_request", JSON.stringify(response.body));
      assert.equal(typeof response.body.error.message, "string");
    }
  });
});

test("the fixture is deterministic across instances: same seed, same sequence, same ids", async () => {
  const run = () =>
    withFixture({ seed: "repeat-seed" }, async ({ client }) => {
      const source = await client.fundedAccount("alice", 5000);
      const destination = await client.openAccount("bob");
      const transfer = await client.post("/transfers", {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 1200,
      });
      await client.tick();
      return {
        source: source.id,
        destination: destination.id,
        transfer: transfer.body.id,
        created_at: transfer.body.created_at,
        entries: (await client.allEntries(source.id)).map((entry) => `${entry.id}:${entry.amount}:${entry.created_at}`),
      };
    });
  assert.deepEqual(await run(), await run());
});
