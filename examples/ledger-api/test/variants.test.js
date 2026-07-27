// The conforming-variant catalog (docs/backlog/api-testing/DESIGN.md §7,
// BUILD_PLAN.md S0) and the response-write jitter knob.
//
// A variant is not a fault, so this suite proves the opposite of
// faults.test.js: every variant must (1) be observably different from the
// canonical build given the same seed and request sequence — otherwise it
// would not be testing anything — (2) still validate against every
// documented response schema, and (3) still produce zero findings from the
// bench's deterministic oracles. A test suite that fails against a
// conforming variant has snapshotted the implementation instead of the
// contract; this suite is what proves these three variants are not that
// trap.
//
// `startVariantFixture` below intentionally does not live in
// `test/support/harness.js`: that file's `startFixture` has no `variants` or
// `jitterMs` knob, and this suite is not allowed to add one. It reuses
// `Client` from the harness (HAR recording, convenience flows) and drives
// `startServer` from `src/http.js` directly, exactly as `startFixture` does
// internally.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, readOpenApiDocument } from "../src/http.js";
import { Client, ADMIN_TOKEN, CUSTOMER_TOKEN } from "./support/harness.js";
import { validate } from "./support/schema.js";
import { scoreTrace } from "../bench/lib/oracles.js";
import { traceFromHarEntries } from "../bench/lib/trace.js";
import { VARIANT_IDS, VARIANT_DESCRIPTIONS, VariantSet, parseVariants } from "../src/variants.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const spec = readOpenApiDocument();

/** Start a fixture instance with `variants`/`jitterMs`/`jitterSeed` support. */
async function startVariantFixture({
  variants = [],
  faults = [],
  jitterMs = 0,
  jitterSeed,
  seed = "variant-test-seed",
} = {}) {
  const started = await startServer({
    port: 0,
    host: "127.0.0.1",
    seed,
    faults,
    variants,
    jitterMs,
    jitterSeed,
    tokens: { admin: ADMIN_TOKEN, customer: CUSTOMER_TOKEN },
  });
  const client = new Client(started.url, { token: ADMIN_TOKEN });
  return {
    url: started.url,
    ledger: started.ledger,
    client,
    customer: new Client(started.url, { token: CUSTOMER_TOKEN }),
    close: started.close,
  };
}

/** Run `body` against a same-seed canonical/variant pair, closing both after. */
async function withPair(variantIds, seed, body) {
  const canonical = await startVariantFixture({ seed });
  const variant = await startVariantFixture({ seed, variants: variantIds });
  try {
    return await body({ canonical, variant });
  } finally {
    await canonical.close();
    await variant.close();
  }
}

function operationsByOperationId(document) {
  const map = {};
  for (const item of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (method === "parameters") continue;
      map[operation.operationId] = operation;
    }
  }
  return map;
}
const OPERATIONS = operationsByOperationId(spec);

function resolvePointer(document, pointer) {
  let cursor = document;
  for (const segment of pointer.slice(2).split("/")) cursor = cursor?.[segment];
  return cursor;
}

/** Enumerate one account's entries by following next_cursor, recording every page. */
async function enumerateEntries(client, accountId, note, limit = 2) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const query = cursor ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}` : `?limit=${limit}`;
    const response = note("listLedgerEntries", await client.get(`/accounts/${accountId}/entries${query}`));
    items.push(...response.body.items);
    cursor = response.body.next_cursor;
    if (!cursor) break;
  }
  return items;
}

/**
 * Drive create/activate/fund/transfer/tick/settle/cancel/close/paginate/error
 * through every documented operation at least once, recording each
 * (operationId, status, body) so a caller can validate schemas, and fully
 * enumerating three accounts' entries plus a balance read so the
 * conservation, pagination, and balance-agreement oracles are all
 * applicable, not vacuously skipped.
 */
async function driveRepresentativeFlow(client, seed) {
  const responses = [];
  const note = (operationId, response) => {
    responses.push({ operationId, status: response.status, body: response.body });
    return response;
  };

  await client.reset(seed);

  note("getHealth", await client.get("/health", { token: null }));
  note("getOpenApiDocument", await client.get("/openapi.json", { token: null }));

  const source = note("createAccount", await client.post("/accounts", { owner: "alice", currency: "USD" })).body;
  note("activateAccount", await client.post(`/accounts/${source.id}/activate`));
  const destination = note("createAccount", await client.post("/accounts", { owner: "bob", currency: "USD" })).body;
  note("activateAccount", await client.post(`/accounts/${destination.id}/activate`));
  const closable = note("createAccount", await client.post("/accounts", { owner: "carol", currency: "USD" })).body;
  note("activateAccount", await client.post(`/accounts/${closable.id}/activate`));

  const deposit = note("createDeposit", await client.post("/deposits", { account_id: source.id, amount: 50_000 })).body;
  note("getDeposit", await client.get(`/deposits/${deposit.id}`));
  for (const amount of [200, 300, 400, 500]) {
    note("createDeposit", await client.post("/deposits", { account_id: source.id, amount }));
  }

  const transfer = note(
    "createTransfer",
    await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 1000,
    }),
  ).body;
  note("getTransfer", await client.get(`/transfers/${transfer.id}`));
  note("listTransfers", await client.get("/transfers?limit=5"));

  const idemBody = { source_account_id: source.id, destination_account_id: destination.id, amount: 50 };
  note("createTransfer", await client.post("/transfers", idemBody, { headers: { "idempotency-key": "idem-1" } }));
  note("createTransfer", await client.post("/transfers", idemBody, { headers: { "idempotency-key": "idem-1" } }));

  note("adminTick", await client.tick());

  const cancelable = note(
    "createTransfer",
    await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 100,
    }),
  ).body;
  note("cancelTransfer", await client.post(`/transfers/${cancelable.id}/cancel`));

  note("listAccounts", await client.get("/accounts?limit=2"));

  // A settled transfer's debit, credit, and fee legs live on three different
  // accounts; enumerating all three is what makes conservation applicable,
  // and enumerating fully (anchored, following next_cursor to null) is what
  // makes pagination and balance-agreement applicable.
  const sourceEntries = await enumerateEntries(client, source.id, note);
  await enumerateEntries(client, destination.id, note);
  await enumerateEntries(client, "acc_fee_usd", note);
  const balanceRead = note("getAccount", await client.get(`/accounts/${source.id}`));

  note("closeAccount", await client.post(`/accounts/${closable.id}/close`));
  note("getAccount", await client.get(`/accounts/${closable.id}`)); // 410 tombstone

  // ---- error cases, so error-shape and lifecycle have plenty to check ----
  note("createAccount", await client.post("/accounts", { owner: "" })); // 400 invalid_request
  note("createAccount", await client.post("/accounts", { owner: "dave", currency: "GBP" })); // 422 unsupported_currency
  note("getAccount", await client.get("/accounts/acc_nope")); // 404
  note("activateAccount", await client.post(`/accounts/${source.id}/activate`)); // 409 already active
  note(
    "createTransfer",
    await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: source.id,
      amount: 10,
    }),
  ); // 422 same_account
  note("listLedgerEntries", await client.get(`/accounts/${source.id}/entries?cursor=not-a-cursor`)); // 400 invalid_cursor
  note("listAccounts", await client.get("/accounts", { token: null })); // 401

  return { responses, source, destination, entries: sourceEntries, balance: balanceRead.body.balance };
}

/** Every recorded response must resolve to a documented status whose schema it satisfies. */
function assertFlowConforms(responses, label) {
  for (const { operationId, status, body } of responses) {
    const operation = OPERATIONS[operationId];
    assert.ok(operation, `${label}: no operation named ${operationId}`);
    const key = String(status);
    assert.ok(
      Object.keys(operation.responses).includes(key),
      `${label}: ${operationId} answered ${status}, which is not documented`,
    );
    let responseDef = operation.responses[key];
    if (responseDef.$ref) responseDef = resolvePointer(spec, responseDef.$ref);
    const schema = responseDef?.content?.["application/json"]?.schema;
    if (!schema) continue;
    const errors = validate(spec, schema, body);
    assert.deepEqual(errors, [], `${label}: ${operationId} -> ${status}: ${errors.join("; ")}`);
  }
}

const CONFIGS = [
  { label: "canonical", variants: [] },
  { label: "terse-optionals", variants: ["terse-optionals"] },
  { label: "trailing-page", variants: ["trailing-page"] },
  { label: "wide-ids", variants: ["wide-ids"] },
  { label: "all three combined", variants: [...VARIANT_IDS] },
];

// ---- catalog and parsing ----

test("VARIANT_IDS lists exactly the three conforming variants, each described honestly", () => {
  assert.deepEqual(VARIANT_IDS, ["terse-optionals", "trailing-page", "wide-ids"]);
  for (const id of VARIANT_IDS) {
    assert.equal(typeof VARIANT_DESCRIPTIONS[id], "string");
    assert.ok(VARIANT_DESCRIPTIONS[id].length > 10, id);
  }
});

test("LEDGER_VARIANT parsing accepts a list, dedupes, and reports unknown ids", () => {
  assert.deepEqual(parseVariants("terse-optionals, wide-ids"), { ids: ["terse-optionals", "wide-ids"], unknown: [] });
  assert.deepEqual(parseVariants(""), { ids: [], unknown: [] });
  assert.deepEqual(parseVariants(undefined), { ids: [], unknown: [] });
  assert.deepEqual(parseVariants("wide-ids,wide-ids"), { ids: ["wide-ids"], unknown: [] });
  assert.deepEqual(parseVariants("nope,wide-ids"), { ids: ["wide-ids"], unknown: ["nope"] });
});

test("VariantSet throws on an unknown id and lists known ones in catalog order", () => {
  assert.throws(() => new VariantSet(["nope"]), /unknown variant id/);
  assert.deepEqual(new VariantSet(["wide-ids", "terse-optionals"]).list(), ["terse-optionals", "wide-ids"]);
  assert.equal(new VariantSet().size, 0);
  assert.equal(new VariantSet(["wide-ids"]).has("wide-ids"), true);
  assert.equal(new VariantSet(["wide-ids"]).has("trailing-page"), false);
});

// ---- canonical shape is unchanged ----

test("with no variant enabled, every projection keeps exactly the keys it had before variants existed", async () => {
  const fixture = await startVariantFixture({ seed: "canonical-shape-seed" });
  try {
    const account = (await fixture.client.post("/accounts", { owner: "alice", currency: "USD" })).body;
    assert.deepEqual(Object.keys(account).sort(), [
      "activated_at",
      "balance",
      "closed_at",
      "created_at",
      "currency",
      "id",
      "kind",
      "owner",
      "owner_principal",
      "status",
    ]);
    assert.equal(account.id.slice(4).length, 10);

    const source = await fixture.client.fundedAccount("bob", 10_000);
    const destination = await fixture.client.openAccount("carol");
    const transfer = (
      await fixture.client.post("/transfers", {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 100,
      })
    ).body;
    assert.deepEqual(Object.keys(transfer).sort(), [
      "amount",
      "canceled_at",
      "created_at",
      "currency",
      "destination_account_id",
      "failure_reason",
      "fee",
      "fee_account_id",
      "id",
      "idempotency_key",
      "settled_at",
      "source_account_id",
      "status",
    ]);

    const deposit = (await fixture.client.post("/deposits", { account_id: source.id, amount: 100 })).body;
    assert.deepEqual(Object.keys(deposit).sort(), [
      "account_id",
      "amount",
      "created_at",
      "currency",
      "entry_id",
      "id",
      "status",
    ]);

    const entries = await fixture.client.allEntries(source.id);
    assert.deepEqual(Object.keys(entries[0]).sort(), [
      "account_id",
      "amount",
      "created_at",
      "currency",
      "deposit_id",
      "id",
      "kind",
      "sequence",
      "transfer_id",
    ]);
  } finally {
    await fixture.close();
  }
});

// ---- terse-optionals ----

test("terse-optionals omits null optional properties instead of emitting them as null", async () => {
  await withPair(["terse-optionals"], "terse-optionals-seed", async ({ canonical, variant }) => {
    const cAccount = (await canonical.client.post("/accounts", { owner: "alice", currency: "USD" })).body;
    const vAccount = (await variant.client.post("/accounts", { owner: "alice", currency: "USD" })).body;
    assert.equal(cAccount.activated_at, null);
    assert.equal("activated_at" in cAccount, true);
    assert.equal("closed_at" in cAccount, true);
    assert.equal("activated_at" in vAccount, false);
    assert.equal("closed_at" in vAccount, false);

    // Once populated, the same key is present in both builds — the variant
    // only ever omits a null value, never a populated one.
    const vActive = (await variant.client.post(`/accounts/${vAccount.id}/activate`)).body;
    assert.equal("activated_at" in vActive, true);
    assert.notEqual(vActive.activated_at, null);

    const cSource = await canonical.client.fundedAccount("s", 10_000);
    const cDestination = await canonical.client.openAccount("d");
    const cTransfer = (
      await canonical.client.post("/transfers", {
        source_account_id: cSource.id,
        destination_account_id: cDestination.id,
        amount: 100,
      })
    ).body;
    for (const key of ["idempotency_key", "failure_reason", "settled_at", "canceled_at"]) {
      assert.equal(cTransfer[key], null, key);
    }

    const vSource = await variant.client.fundedAccount("s", 10_000);
    const vDestination = await variant.client.openAccount("d");
    const vTransfer = (
      await variant.client.post("/transfers", {
        source_account_id: vSource.id,
        destination_account_id: vDestination.id,
        amount: 100,
      })
    ).body;
    for (const key of ["idempotency_key", "failure_reason", "settled_at", "canceled_at"]) {
      assert.equal(key in vTransfer, false, key);
    }

    // LedgerEntry: a deposit entry's transfer_id is null, a settled
    // transfer's debit entry's deposit_id is null — both omitted.
    const cDepositEntry = (await canonical.client.allEntries(cSource.id)).find((entry) => entry.kind === "deposit");
    assert.equal(cDepositEntry.transfer_id, null);
    assert.equal("deposit_id" in cDepositEntry, true);

    const vDepositEntry = (await variant.client.allEntries(vSource.id)).find((entry) => entry.kind === "deposit");
    assert.equal("transfer_id" in vDepositEntry, false);
    assert.equal("deposit_id" in vDepositEntry, true);

    await canonical.client.tick();
    await variant.client.tick();
    const cDebitEntry = (await canonical.client.allEntries(cSource.id)).find((entry) => entry.kind === "transfer_debit");
    assert.equal(cDebitEntry.deposit_id, null);
    assert.equal("transfer_id" in cDebitEntry, true);

    const vDebitEntry = (await variant.client.allEntries(vSource.id)).find((entry) => entry.kind === "transfer_debit");
    assert.equal("deposit_id" in vDebitEntry, false);
    assert.equal("transfer_id" in vDebitEntry, true);
  });
});

// ---- trailing-page ----

test("trailing-page: GET /accounts ends on an empty trailing page after a full last page", async () => {
  await withPair(["trailing-page"], "trailing-accounts-seed", async ({ canonical, variant }) => {
    // A fresh reset seeds exactly the two system fee accounts, so limit=2
    // makes the very first page both full and the last one.
    const cFirst = await canonical.client.get("/accounts?limit=2");
    assert.equal(cFirst.body.items.length, 2);
    assert.equal(cFirst.body.next_cursor, null);

    const vFirst = await variant.client.get("/accounts?limit=2");
    assert.equal(vFirst.body.items.length, 2);
    assert.ok(vFirst.body.next_cursor, "trailing-page must carry a cursor on a full last page");
    assert.deepEqual(
      vFirst.body.items.map((account) => account.id).sort(),
      cFirst.body.items.map((account) => account.id).sort(),
      "the variant returns the same accounts, just with an extra cursor",
    );

    const vSecond = await variant.client.get(`/accounts?limit=2&cursor=${encodeURIComponent(vFirst.body.next_cursor)}`);
    assert.deepEqual(vSecond.body, { items: [], next_cursor: null });
  });
});

test("trailing-page: GET /transfers ends on an empty trailing page after a full last page", async () => {
  await withPair(["trailing-page"], "trailing-transfers-seed", async ({ canonical, variant }) => {
    for (const fixture of [canonical, variant]) {
      const source = await fixture.client.fundedAccount("alice", 10_000);
      const destination = await fixture.client.openAccount("bob");
      await fixture.client.post("/transfers", {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 100,
      });
    }

    const cFirst = await canonical.client.get("/transfers?limit=1");
    assert.equal(cFirst.body.items.length, 1);
    assert.equal(cFirst.body.next_cursor, null);

    const vFirst = await variant.client.get("/transfers?limit=1");
    assert.equal(vFirst.body.items.length, 1);
    assert.ok(vFirst.body.next_cursor);

    const vSecond = await variant.client.get(`/transfers?limit=1&cursor=${encodeURIComponent(vFirst.body.next_cursor)}`);
    assert.deepEqual(vSecond.body, { items: [], next_cursor: null });
  });
});

test("trailing-page: GET /accounts/{id}/entries ends on an empty trailing page after a full last page", async () => {
  await withPair(["trailing-page"], "trailing-entries-seed", async ({ canonical, variant }) => {
    // fundedAccount writes one deposit entry; a second deposit makes two —
    // limit=2 makes the only page also the last one.
    const cSource = await canonical.client.fundedAccount("alice", 100);
    await canonical.client.post("/deposits", { account_id: cSource.id, amount: 200 });
    const vSource = await variant.client.fundedAccount("alice", 100);
    await variant.client.post("/deposits", { account_id: vSource.id, amount: 200 });

    const cFirst = await canonical.client.get(`/accounts/${cSource.id}/entries?limit=2`);
    assert.equal(cFirst.body.items.length, 2);
    assert.equal(cFirst.body.next_cursor, null);

    const vFirst = await variant.client.get(`/accounts/${vSource.id}/entries?limit=2`);
    assert.equal(vFirst.body.items.length, 2);
    assert.ok(vFirst.body.next_cursor);

    const vSecond = await variant.client.get(
      `/accounts/${vSource.id}/entries?limit=2&cursor=${encodeURIComponent(vFirst.body.next_cursor)}`,
    );
    assert.deepEqual(vSecond.body, { items: [], next_cursor: null });

    const allViaClient = await variant.client.allEntries(vSource.id);
    assert.equal(new Set(allViaClient.map((entry) => entry.id)).size, allViaClient.length, "no entry duplicated");
  });
});

// ---- wide-ids ----

test("wide-ids draws 26-character id tokens; the fixed fee-account ids are unchanged", async () => {
  await withPair(["wide-ids"], "wide-ids-seed", async ({ canonical, variant }) => {
    const cAccount = (await canonical.client.post("/accounts", { owner: "alice", currency: "USD" })).body;
    const vAccount = (await variant.client.post("/accounts", { owner: "alice", currency: "USD" })).body;
    assert.match(cAccount.id, /^acc_[0-9a-z_]+$/);
    assert.match(vAccount.id, /^acc_[0-9a-z_]+$/);
    assert.equal(cAccount.id.slice(4).length, 10);
    assert.equal(vAccount.id.slice(4).length, 26);

    const cSource = await canonical.client.fundedAccount("s", 10_000);
    const cDestination = await canonical.client.openAccount("d");
    const cTransfer = (
      await canonical.client.post("/transfers", {
        source_account_id: cSource.id,
        destination_account_id: cDestination.id,
        amount: 100,
      })
    ).body;
    const vSource = await variant.client.fundedAccount("s", 10_000);
    const vDestination = await variant.client.openAccount("d");
    const vTransfer = (
      await variant.client.post("/transfers", {
        source_account_id: vSource.id,
        destination_account_id: vDestination.id,
        amount: 100,
      })
    ).body;

    assert.match(cTransfer.id, /^tr_[0-9a-z]+$/);
    assert.match(vTransfer.id, /^tr_[0-9a-z]+$/);
    assert.equal(cTransfer.id.slice(3).length, 10);
    assert.equal(vTransfer.id.slice(3).length, 26);

    // The fixed system fee-account ids are documented constants, not
    // generated ids — wide-ids must not touch them.
    assert.equal(cTransfer.fee_account_id, "acc_fee_usd");
    assert.equal(vTransfer.fee_account_id, "acc_fee_usd");

    await canonical.client.tick();
    await variant.client.tick();
    const cFeeEntry = (await canonical.client.allEntries("acc_fee_usd")).find(
      (entry) => entry.transfer_id === cTransfer.id,
    );
    const vFeeEntry = (await variant.client.allEntries("acc_fee_usd")).find(
      (entry) => entry.transfer_id === vTransfer.id,
    );
    assert.match(cFeeEntry.id, /^ent_[0-9a-z]+$/);
    assert.match(vFeeEntry.id, /^ent_[0-9a-z]+$/);
    assert.equal(cFeeEntry.id.slice(4).length, 10);
    assert.equal(vFeeEntry.id.slice(4).length, 26);
  });
});

// ---- conforming and oracle-clean, per variant and combined ----

test("the canonical build and every variant, individually and combined, stay inside the declared schema across a representative flow", async () => {
  for (const { label, variants } of CONFIGS) {
    const fixture = await startVariantFixture({ variants, seed: `conform-${label}` });
    try {
      const { responses } = await driveRepresentativeFlow(fixture.client, `conform-${label}`);
      assertFlowConforms(responses, label);
    } finally {
      await fixture.close();
    }
  }
});

test("the canonical build and every variant, individually and combined, are oracle-clean with every oracle actually exercised", async () => {
  for (const { label, variants } of CONFIGS) {
    const fixture = await startVariantFixture({ variants, seed: `oracle-${label}` });
    try {
      const { entries, balance } = await driveRepresentativeFlow(fixture.client, `oracle-${label}`);
      assert.ok(entries.length > 0, `${label}: the flow produced no entries to enumerate`);
      assert.ok(Number.isInteger(balance), `${label}: no balance was read`);

      const trace = traceFromHarEntries(fixture.client.har, { id: label, source: "test" });
      const { violations, applicability } = scoreTrace(trace);
      assert.deepEqual(
        violations,
        [],
        `${label}: ${violations.map((violation) => `${violation.oracle}/${violation.code}`).join(", ")}`,
      );
      // A vacuous pass proves nothing: every oracle must have actually been
      // exercised, not merely silent because the flow never reached it.
      for (const oracle of [
        "protocol",
        "error_shape",
        "conservation",
        "idempotency",
        "lifecycle",
        "pagination",
        "balance_agreement",
      ]) {
        assert.equal(applicability[oracle], true, `${label}: ${oracle} was never exercised`);
      }
    } finally {
      await fixture.close();
    }
  }
});

// ---- jitter ----

test("jitter delays the write but never changes response content", async () => {
  const seed = "jitter-content-seed";
  const scenario = async (client) => {
    await client.reset(seed);
    const source = await client.fundedAccount("alice", 10_000);
    const destination = await client.openAccount("bob");
    const transfer = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 500,
    });
    await client.tick();
    const canceled = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 10,
    });
    await client.post(`/transfers/${canceled.body.id}/cancel`);
    return {
      source,
      destination,
      transfer: transfer.body,
      canceled: canceled.body,
      entries: await client.allEntries(source.id),
    };
  };

  const plain = await startVariantFixture({ seed });
  const jittered = await startVariantFixture({ seed, jitterMs: 25 });
  try {
    const plainResult = await scenario(plain.client);
    const jitteredResult = await scenario(jittered.client);
    assert.deepEqual(jitteredResult, plainResult);
  } finally {
    await plain.close();
    await jittered.close();
  }
});

test("jitter demonstrably delays responses", async () => {
  const seed = "jitter-timing-seed";
  const requestCount = 20;
  const jitterMs = 40;

  const timeRequests = async (client) => {
    const started = Date.now();
    for (let i = 0; i < requestCount; i++) {
      await client.get("/health", { token: null });
    }
    return Date.now() - started;
  };

  const plain = await startVariantFixture({ seed });
  const jittered = await startVariantFixture({ seed, jitterMs });
  try {
    const plainMs = await timeRequests(plain.client);
    const jitteredMs = await timeRequests(jittered.client);
    // Expected extra latency ~= requestCount * jitterMs / 2 (mean of a
    // uniform 0..jitterMs draw) = 400ms here; the assertion only demands a
    // quarter of that, so ordinary scheduling noise can never flip it.
    assert.ok(
      jitteredMs > plainMs + (requestCount * jitterMs) / 4,
      `expected jitter to add measurable latency: plain=${plainMs}ms jittered=${jitteredMs}ms`,
    );
  } finally {
    await plain.close();
    await jittered.close();
  }
});

// ---- server configuration ----

function boot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not start in time: ${stdout}${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /listening on (http:\/\/\S+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve({
          child,
          url: match[1],
          get stdout() {
            return stdout;
          },
          stop: () =>
            new Promise((done) => {
              child.once("exit", done);
              child.kill("SIGTERM");
            }),
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${stderr || stdout}`));
    });
  });
}

function bootExpectingFailure(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

test("an unknown LEDGER_VARIANT id refuses to start with an actionable message", async () => {
  const bad = await bootExpectingFailure({ LEDGER_VARIANT: "not-a-variant" });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown LEDGER_VARIANT id\(s\): not-a-variant/);
  assert.match(bad.stderr, /known ids: terse-optionals/);
});

test("a bad LEDGER_JITTER_MS refuses to start with an actionable message", async () => {
  const notANumber = await bootExpectingFailure({ LEDGER_JITTER_MS: "soon" });
  assert.equal(notANumber.code, 1);
  assert.match(notANumber.stderr, /LEDGER_JITTER_MS must be a non-negative integer/);

  const negative = await bootExpectingFailure({ LEDGER_JITTER_MS: "-5" });
  assert.equal(negative.code, 1);
  assert.match(negative.stderr, /LEDGER_JITTER_MS must be a non-negative integer/);
});

test("LEDGER_VARIANT and LEDGER_JITTER_MS take effect and are announced only on the operator's terminal", async () => {
  const server = await boot({ LEDGER_VARIANT: "terse-optionals, wide-ids", LEDGER_JITTER_MS: "5" });
  try {
    const created = await fetch(`${server.url}/accounts`, {
      method: "POST",
      headers: { authorization: "Bearer admin-token-dev", "content-type": "application/json" },
      body: JSON.stringify({ owner: "alice", currency: "USD" }),
    });
    const body = await created.json();
    assert.equal("activated_at" in body, false, "terse-optionals should have taken effect");
    assert.equal(body.id.slice(4).length, 26, "wide-ids should have taken effect");

    const health = await (await fetch(`${server.url}/health`)).text();
    assert.equal(health.includes("terse-optionals"), false);
    assert.equal(health.includes("wide-ids"), false);

    // Checked last: these awaited fetches give the child process's stdout
    // time to flush the rest of the startup banner past "listening on ...",
    // which is all `boot()` waits for.
    assert.match(server.stdout, /variants: terse-optionals, wide-ids/);
    assert.match(server.stdout, /jitter:\s+up to 5ms per response/);
  } finally {
    await server.stop();
  }
});
