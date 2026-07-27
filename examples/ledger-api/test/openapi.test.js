// The shipped OpenAPI 3.1 document: served by the fixture, internally
// consistent, and honest about the surface it describes. It is the only thing
// a comparator arm is given (DESIGN §4), so a gap here would bias the
// measurement.

import assert from "node:assert/strict";
import test from "node:test";
import { withFixture } from "./support/harness.js";
import { readOpenApiDocument } from "../src/http.js";
import { FAULT_IDS } from "../src/faults.js";

const spec = readOpenApiDocument();

test("the fixture serves the document it ships", async () => {
  await withFixture({}, async ({ client }) => {
    const served = await client.get("/openapi.json", { token: null });
    assert.equal(served.status, 200);
    assert.equal(served.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(served.body, spec);
  });
});

test("the document is OpenAPI 3.1 with bearer security and an error envelope schema", () => {
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  const error = spec.components.schemas.Error;
  assert.deepEqual(Object.keys(error.properties.error.properties).sort(), ["code", "details", "message"]);
  assert.deepEqual(error.properties.error.required, ["code", "message"]);
});

test("every internal $ref resolves", () => {
  const missing = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        assert.ok(value.startsWith("#/"), `only internal refs are allowed: ${value}`);
        let cursor = spec;
        for (const segment of value.slice(2).split("/")) cursor = cursor?.[segment];
        if (cursor === undefined) missing.push(value);
      } else visit(value);
    }
  };
  visit(spec);
  assert.deepEqual(missing, []);
});

test("the declared invariants and consistency notes the oracles rely on are present", () => {
  const ids = spec["x-ledger-invariants"].map((invariant) => invariant.id).sort();
  assert.deepEqual(ids, [
    "balance-agreement",
    "conservation",
    "error-shape",
    "idempotency",
    "lifecycle-legality",
    "ownership",
    "pagination-identity",
  ]);
  for (const invariant of spec["x-ledger-invariants"]) {
    assert.equal(typeof invariant.statement, "string");
    assert.equal(typeof invariant.applies_to, "string");
    assert.equal(typeof invariant.exceptions, "string", `${invariant.id} must declare its exceptions`);
  }
  const consistency = spec["x-ledger-consistency"];
  for (const key of ["settlement", "entry-pagination", "normalization", "closed-accounts", "daily-limit", "ownership"]) {
    assert.equal(typeof consistency[key], "string", key);
  }
  assert.equal(spec["x-ledger-fee-schedule"].flat, 25);
  assert.equal(spec["x-ledger-fee-schedule"].basis_points, 15);
  assert.equal(spec["x-ledger-limits"].daily_transfer_limit, 100000);
  assert.deepEqual(spec["x-ledger-limits"].fee_accounts, { USD: "acc_fee_usd", EUR: "acc_fee_eur" });
});

test("the document leaks nothing about the fault catalog", () => {
  const text = JSON.stringify(spec);
  for (const id of FAULT_IDS) assert.equal(text.includes(id), false, id);
  // "default" contains "fault", so match the word itself.
  assert.equal(/\bfaults?\b/i.test(text), false);
  assert.equal(/LEDGER_FAULTS/.test(text), false);
});

test("every documented operation answers with a documented status", async () => {
  await withFixture({}, async ({ client }) => {
    const source = await client.fundedAccount("alice", 50_000);
    const destination = await client.openAccount("bob");
    const closable = await client.openAccount("carol");
    const deposit = await client.post("/deposits", { account_id: source.id, amount: 100 });
    const transfer = await client.post("/transfers", {
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: 100,
    });

    // Per-operation concrete requests, so a shared {accountId} template can be
    // exercised against the account each operation actually needs.
    const requests = {
      getHealth: { path: "/health" },
      getOpenApiDocument: { path: "/openapi.json" },
      listAccounts: { path: "/accounts?limit=5" },
      createAccount: { path: "/accounts", body: { owner: "zoe", currency: "EUR" } },
      getAccount: { path: `/accounts/${source.id}` },
      activateAccount: { path: `/accounts/${destination.id}/activate`, body: {} },
      closeAccount: { path: `/accounts/${closable.id}/close`, body: {} },
      listLedgerEntries: { path: `/accounts/${source.id}/entries?limit=5` },
      createDeposit: { path: "/deposits", body: { account_id: source.id, amount: 250 } },
      getDeposit: { path: `/deposits/${deposit.body.id}` },
      listTransfers: { path: "/transfers?limit=5" },
      createTransfer: {
        path: "/transfers",
        body: { source_account_id: source.id, destination_account_id: destination.id, amount: 120 },
      },
      getTransfer: { path: `/transfers/${transfer.body.id}` },
      cancelTransfer: { path: `/transfers/${transfer.body.id}/cancel`, body: {} },
      adminTick: { path: "/admin/tick", body: {} },
      adminReset: null, // wipes the world; exercised on its own in clean.test.js
    };

    const checked = [];
    for (const [template, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (method === "parameters") continue;
        const plan = requests[operation.operationId];
        assert.notEqual(plan, undefined, `no request planned for ${operation.operationId}`);
        if (plan === null) continue;
        const response = await client.request(method.toUpperCase(), plan.path, { body: plan.body });
        assert.ok(
          Object.keys(operation.responses).includes(String(response.status)),
          `${method.toUpperCase()} ${template} answered ${response.status}, which is not documented ` +
            `(${Object.keys(operation.responses).join(", ")})`,
        );
        checked.push(operation.operationId);
      }
    }
    assert.equal(checked.length, 15);
  });
});

test("every operation that answers 400 on malformed input declares 400", async () => {
  // The happy-path sweep above cannot see this: a suite that probes a malformed
  // identifier or an unparseable body provokes a 400 the document used to omit
  // on seven operations, which fails a spec-driven `documented_status` gate on
  // a build that is behaving correctly. Enumerated by exercising the real
  // fixture, not by reading the router.
  await withFixture({}, async ({ client }) => {
    const account = await client.openAccount("dana");
    const transfer = await client.post("/transfers", {
      source_account_id: account.id,
      destination_account_id: "acc_fee_usd",
      amount: 100,
    });

    const probes = [
      ["listAccounts", "GET", "/accounts?limit=abc"],
      ["createAccount", "POST", "/accounts", "{"],
      ["getAccount", "GET", "/accounts/%zz"],
      ["activateAccount", "POST", "/accounts/%zz/activate", "{}"],
      ["activateAccount", "POST", `/accounts/${account.id}/activate`, "{"],
      ["closeAccount", "POST", "/accounts/%zz/close", "{}"],
      ["closeAccount", "POST", `/accounts/${account.id}/close`, "{"],
      ["listLedgerEntries", "GET", `/accounts/${account.id}/entries?cursor=zzz`],
      ["createDeposit", "POST", "/deposits", "{"],
      ["getDeposit", "GET", "/deposits/%zz"],
      ["listTransfers", "GET", "/transfers?limit=abc"],
      ["createTransfer", "POST", "/transfers", "{"],
      ["getTransfer", "GET", "/transfers/%zz"],
      ["cancelTransfer", "POST", "/transfers/%zz/cancel", "{}"],
      ["cancelTransfer", "POST", `/transfers/${transfer.body?.id}/cancel`, "{"],
      ["adminTick", "POST", "/admin/tick", "{"],
      ["adminReset", "POST", "/admin/reset", "{"],
    ];

    const byOperationId = new Map();
    for (const item of Object.values(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (method !== "parameters") byOperationId.set(operation.operationId, operation);
      }
    }

    const covered = new Set();
    for (const [operationId, method, path, rawBody] of probes) {
      const operation = byOperationId.get(operationId);
      assert.ok(operation, operationId);
      const response = await client.request(method, path, { body: rawBody });
      assert.equal(response.status, 400, `${method} ${path} should be a 400 probe`);
      assert.ok(
        Object.keys(operation.responses).includes("400"),
        `${method} ${path} answered 400, which ${operationId} does not declare ` +
          `(${Object.keys(operation.responses).join(", ")})`,
      );
      assert.equal(typeof response.body?.error?.code, "string", `${method} ${path} must answer the error envelope`);
      covered.add(operationId);
    }

    // Every operation but the two public, body-less ones can be made to answer
    // 400, so every one of them has to declare it.
    assert.deepEqual(
      [...byOperationId.keys()].filter((id) => !covered.has(id)).sort(),
      ["getHealth", "getOpenApiDocument"],
    );
  });
});

test("the router exposes no operation the document omits", async () => {
  const documented = new Set();
  for (const [template, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (method !== "parameters") documented.add(`${method.toUpperCase()} ${template}`);
    }
  }
  assert.deepEqual([...documented].sort(), [
    "GET /accounts",
    "GET /accounts/{accountId}",
    "GET /accounts/{accountId}/entries",
    "GET /deposits/{depositId}",
    "GET /health",
    "GET /openapi.json",
    "GET /transfers",
    "GET /transfers/{transferId}",
    "POST /accounts",
    "POST /accounts/{accountId}/activate",
    "POST /accounts/{accountId}/close",
    "POST /admin/reset",
    "POST /admin/tick",
    "POST /deposits",
    "POST /transfers",
    "POST /transfers/{transferId}/cancel",
  ]);

  // Anything outside that list is a 404 or a 405, never a working operation.
  await withFixture({}, async ({ client }) => {
    for (const [method, path] of [
      ["GET", "/admin/state"],
      ["DELETE", "/accounts/acc_fee_usd"],
      ["POST", "/entries"],
      ["PUT", "/transfers"],
      ["GET", "/deposits"],
    ]) {
      const response = await client.request(method, path);
      assert.ok([404, 405].includes(response.status), `${method} ${path} -> ${response.status}`);
    }
  });
});
