// Synthetic run directories for the assertion tests.
//
// An assertion's whole input is a run directory's har.json plus the runner's
// trajectory, so a test only has to write those two things. Nothing here talks
// to a network, a model, or the ledger fixture: every trace is hand-built so the
// expected verdict is obvious from reading it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "http://127.0.0.1:4180";

/** One request/response pair in the flattened shape Playtest's api driver writes. */
export function exchange(method, target, status, responseJson, { body = null, headers = {} } = {}) {
  return {
    startedDateTime: "2026-01-01T00:00:00.000Z",
    time: 1,
    request: {
      method,
      url: `${BASE}${target}`,
      headers,
      body: body === null ? null : JSON.stringify(body),
    },
    response: {
      status,
      bodySize: -1,
      mimeType: "application/json",
      headers: { "content-type": "application/json" },
      body: responseJson === undefined ? null : JSON.stringify(responseJson),
    },
    _failed: false,
  };
}

/**
 * Write a throwaway run directory and return the gather() ctx for it.
 *
 * @param {object[]} exchanges every request the run made, in wire order
 * @param {{ missing?: number }} [options] how many trailing exchanges to leave
 *   OUT of har.json while keeping them in the trajectory, simulating an
 *   incomplete synthetic or legacy trace
 * @returns {{ runDir: string, ctx: object, cleanup: Function }}
 */
export function syntheticRun(exchanges, { missing = 0 } = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-probe-"));
  const flushed = missing > 0 ? exchanges.slice(0, exchanges.length - missing) : exchanges;
  fs.writeFileSync(path.join(runDir, "har.json"), JSON.stringify({ log: { entries: flushed } }));

  const trajectory = exchanges.map((_, index) => ({
    step: index + 1,
    artifacts: { har_entries: [index] },
  }));

  return {
    runDir,
    ctx: { runId: "test-run", runDir, baseUrl: BASE, driver: "api", env: {}, trajectory },
    cleanup: () => fs.rmSync(runDir, { recursive: true, force: true }),
  };
}

/** Run one assertion end to end over a synthetic trace, as the harness would. */
export function evaluate(assertion, key, value, exchanges, options) {
  const run = syntheticRun(exchanges, options);
  try {
    const evidence = assertion.gather(run.ctx);
    return { ...assertion.verdict({ key, value, evidence }), evidence };
  } finally {
    run.cleanup();
  }
}

// ---- fragments the invariants are built from --------------------------------

export const reset = () => exchange("POST", "/admin/reset", 200, { seed: "ledger-dev-seed" }, { body: { seed: "ledger-dev-seed" } });

export const activeAccount = (id, balance = 0) =>
  exchange("GET", `/accounts/${id}`, 200, { id, status: "active", currency: "usd", balance });

export const entriesPage = (accountId, items, { cursor = null, nextCursor = null } = {}) =>
  exchange(
    "GET",
    `/accounts/${accountId}/entries${cursor ? `?cursor=${cursor}` : ""}`,
    200,
    { items, next_cursor: nextCursor },
  );

export const entry = (id, transferId, kind, amount, accountId) => ({
  id,
  transfer_id: transferId,
  kind,
  amount,
  account_id: accountId,
});

export const createTransfer = (transferId, { source = "acc_a", destination = "acc_b", amount = 1000, key = null, status = 200 } = {}) =>
  exchange(
    "POST",
    "/transfers",
    status,
    { id: transferId, status: "pending", source_account_id: source, destination_account_id: destination, amount },
    {
      body: { source_account_id: source, destination_account_id: destination, amount, currency: "usd" },
      headers: key ? { "Idempotency-Key": key } : {},
    },
  );
