// One deterministic manifestation probe per fault — development set first,
// then the sealed held-out set.
//
// Each probe drives a fresh fixture through the shortest sequence that makes
// its fault observable *from the API surface alone*, and returns whether the
// fault manifested plus the evidence. The probes are deliberately independent:
// running any probe against a fixture with a *different* single fault enabled
// must report "not manifested", which is what proves the faults are isolated
// (BUILD_PLAN P0 exit gate: "every fault toggles independently; no fault
// changes clean-build behavior when off").

import { FAULT_IDS } from "../../src/faults.js";
import { feeFor } from "../../src/ledger.js";
import { CUSTOMER_TOKEN, CUSTOMER_B_TOKEN } from "./harness.js";

const T = (client, body, headers) => client.post("/transfers", body, headers ? { headers } : undefined);

/** Open an activated account owned by a named principal, using the admin client. */
async function openFor(client, owner, ownerPrincipal, { currency = "USD", fund = 0 } = {}) {
  const created = await client.post("/accounts", { owner, currency, owner_principal: ownerPrincipal });
  if (created.status !== 201) throw new Error(`openFor: create failed with ${created.status}`);
  await client.post(`/accounts/${created.body.id}/activate`);
  if (fund > 0) await client.post("/deposits", { account_id: created.body.id, amount: fund });
  return created.body;
}

export const MANIFESTATIONS = [
  {
    fault: "f-error-200",
    title: "insufficient funds is refused with a 422 envelope",
    async probe(client) {
      const source = await client.fundedAccount("alice", 500);
      const destination = await client.openAccount("bob");
      const response = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 1000,
      });
      return {
        manifested: response.status === 200,
        clean: response.status === 422 && response.body?.error?.code === "insufficient_funds",
        evidence: `POST /transfers -> ${response.status} ${JSON.stringify(response.body)}`,
      };
    },
  },
  {
    fault: "f-undocumented-500",
    title: "a transfer of exactly the daily limit is accepted",
    async probe(client) {
      const source = await client.fundedAccount("alice", 200_000);
      const destination = await client.openAccount("bob");
      const response = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 100_000,
      });
      return {
        manifested: response.status >= 500,
        clean: response.status === 201 && response.body?.status === "pending",
        evidence: `POST /transfers amount=100000 -> ${response.status} ${JSON.stringify(response.body)}`,
      };
    },
  },
  {
    fault: "f-fee-rounding-drift",
    title: "a settled transfer's entries sum to zero",
    async probe(client) {
      const source = await client.fundedAccount("alice", 5000);
      const destination = await client.openAccount("bob");
      // amount * 15 / 10000 == 1.5 exactly: the half-minor-unit fee boundary.
      const created = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 1000,
      });
      await client.tick();
      const entries = [
        ...(await client.allEntries(source.id)),
        ...(await client.allEntries(destination.id)),
        ...(await client.allEntries("acc_fee_usd")),
      ].filter((entry) => entry.transfer_id === created.body.id);
      const sum = entries.reduce((total, entry) => total + entry.amount, 0);
      return {
        manifested: sum !== 0,
        clean: sum === 0 && entries.length === 3,
        evidence: `transfer ${created.body.id} entries sum to ${sum} over ${entries.length} rows`,
      };
    },
  },
  {
    fault: "f-idempotency-replay-double",
    title: "a replayed Idempotency-Key posts exactly one ledger effect",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000);
      const destination = await client.openAccount("bob");
      const body = { source_account_id: source.id, destination_account_id: destination.id, amount: 1200 };
      const first = await T(client, body, { "idempotency-key": "probe-key" });
      const replay = await T(client, body, { "idempotency-key": "probe-key" });
      await client.tick();
      const debits = (await client.allEntries(source.id)).filter((entry) => entry.kind === "transfer_debit");
      const phantom = debits.filter((entry) => entry.transfer_id !== first.body.id);
      return {
        manifested: debits.length > 1,
        clean:
          debits.length === 1 &&
          phantom.length === 0 &&
          replay.status === 200 &&
          replay.body?.id === first.body.id,
        evidence: `${debits.length} transfer_debit entries after one replayed key (phantom: ${phantom
          .map((entry) => entry.transfer_id)
          .join(", ") || "none"})`,
      };
    },
  },
  {
    fault: "f-settle-cancel-race",
    title: "a settled transfer cannot be canceled",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000);
      const destination = await client.openAccount("bob");
      const created = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 1200,
      });
      await client.tick();
      const canceled = await client.post(`/transfers/${created.body.id}/cancel`);
      const entries = [
        ...(await client.allEntries(source.id)),
        ...(await client.allEntries(destination.id)),
        ...(await client.allEntries("acc_fee_usd")),
      ].filter((entry) => entry.transfer_id === created.body.id);
      const sum = entries.reduce((total, entry) => total + entry.amount, 0);
      return {
        // `clean` asserts only this probe's own property (lifecycle legality),
        // so the matrix can hold it true under every other single fault; the
        // entry evidence is reported but not asserted here.
        manifested: canceled.status === 200,
        clean:
          canceled.status === 409 &&
          canceled.body?.error?.code === "transfer_not_pending" &&
          entries.length === 3,
        evidence: `cancel of settled ${created.body.id} -> ${canceled.status}; entries=${entries.length} sum=${sum}`,
      };
    },
  },
  {
    fault: "f-close-ghost",
    title: "a closed account cannot transact",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000);
      const destination = await client.openAccount("bob");
      const closed = await client.post(`/accounts/${source.id}/close`);
      const response = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 1200,
      });
      return {
        manifested: response.status >= 200 && response.status < 300,
        clean:
          closed.status === 200 &&
          response.status === 410 &&
          response.body?.error?.code === "account_closed",
        evidence: `transfer from closed ${source.id} -> ${response.status} ${JSON.stringify(response.body)}`,
      };
    },
  },
  {
    fault: "f-pagination-dup",
    title: "a write between pages never duplicates an entry",
    async probe(client) {
      const account = await client.fundedAccount("alice", 1000);
      await client.post("/deposits", { account_id: account.id, amount: 2000 });
      await client.post("/deposits", { account_id: account.id, amount: 3000 });
      const first = await client.get(`/accounts/${account.id}/entries?limit=2`);
      await client.post("/deposits", { account_id: account.id, amount: 4000 });
      const second = await client.get(
        `/accounts/${account.id}/entries?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
      );
      const firstIds = first.body.items.map((entry) => entry.id);
      const duplicates = second.body.items.map((entry) => entry.id).filter((id) => firstIds.includes(id));
      return {
        manifested: duplicates.length > 0,
        clean: duplicates.length === 0 && first.body.next_cursor !== null,
        evidence: `page 2 repeated ${duplicates.length} id(s): ${duplicates.join(", ") || "none"}`,
      };
    },
  },
  {
    fault: "f-balance-cache-stale",
    title: "the stored balance matches the sum of the account's entries",
    async probe(client) {
      const source = await client.fundedAccount("alice", 20_000);
      const destination = await client.openAccount("bob");
      for (const amount of [1200, 2400]) {
        await T(client, {
          source_account_id: source.id,
          destination_account_id: destination.id,
          amount,
        });
      }
      await client.tick(); // both settle inside one tick
      const stored = (await client.get(`/accounts/${source.id}`)).body.balance;
      const derived = (await client.allEntries(source.id)).reduce((total, entry) => total + entry.amount, 0);
      return {
        manifested: stored !== derived,
        clean: stored === derived,
        evidence: `stored balance ${stored} vs derived ${derived}`,
      };
    },
  },

  // ---- the sealed held-out set (DESIGN §6.3) ----
  //
  // Every probe below asserts the *oracle-level observable* — the response or
  // trace shape one of the frozen bench oracles reads — rather than fixture
  // internals, so a fault that fires here is a fault an arm's trace can be
  // scored on.
  {
    fault: "f-cursor-error-bare",
    title: "a rejected entry cursor is refused with the error envelope",
    async probe(client) {
      const account = await client.fundedAccount("alice", 1000);
      const response = await client.get(`/accounts/${account.id}/entries?limit=1&cursor=not-a-real-cursor`);
      return {
        // error_shape/error_envelope_violation: a 4xx whose body is not
        // `{error:{code,message,details?}}`.
        manifested: response.status === 400 && !response.body?.error,
        clean: response.status === 400 && response.body?.error?.code === "invalid_cursor",
        evidence: `GET entries with a bad cursor -> ${response.status} ${JSON.stringify(response.body)}`,
      };
    },
  },
  {
    fault: "f-close-pending-inbound",
    title: "an account owed an in-flight transfer cannot be closed",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000);
      const destination = await client.openAccount("bob");
      const created = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 1200,
      });
      const closed = await client.post(`/accounts/${destination.id}/close`);
      return {
        // lifecycle/close_with_pending_transfers: a 2xx close of an account a
        // transfer observed pending still names.
        manifested: closed.status === 200 && closed.body?.status === "closed",
        clean:
          created.status === 201 &&
          created.body?.status === "pending" &&
          closed.status === 409 &&
          closed.body?.error?.code === "account_has_pending_transfers",
        evidence: `close of ${destination.id} while ${created.body?.id} is pending -> ${closed.status} ${JSON.stringify(
          closed.body,
        )}`,
      };
    },
  },
  {
    fault: "f-settle-failed-debit",
    title: "a transfer that fails at settlement writes no entries",
    async probe(client) {
      const source = await client.fundedAccount("alice", 3000);
      const destination = await client.openAccount("bob");
      const body = (amount) => ({
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount,
      });
      // Either transfer is affordable on its own (fees 27 and 28); together
      // they are not, so the second one fails the funds re-check at settlement.
      await T(client, body(1000));
      const second = await T(client, body(1950));
      await client.tick();
      const stored = (await client.get(`/accounts/${source.id}`)).body.balance;
      const entries = await client.allEntries(source.id);
      const derived = entries.reduce((total, entry) => total + entry.amount, 0);
      const orphans = entries.filter((entry) => entry.transfer_id === second.body?.id);
      return {
        // balance_agreement/stored_balance_diverged: a completely enumerated
        // account whose rows no longer sum to the balance it reports.
        manifested: stored !== derived,
        clean: stored === derived && orphans.length === 0 && entries.length === 2,
        evidence:
          `failed transfer ${second.body?.id} left ${orphans.length} entr${orphans.length === 1 ? "y" : "ies"}; ` +
          `stored ${stored} vs derived ${derived} over ${entries.length} rows`,
      };
    },
  },
  {
    fault: "f-idempotency-day-expiry",
    title: "an Idempotency-Key still replays across a ledger-day rollover",
    async probe(client) {
      const source = await client.fundedAccount("alice", 20_000);
      const destination = await client.openAccount("bob");
      const body = { source_account_id: source.id, destination_account_id: destination.id, amount: 1200 };
      const first = await T(client, body, { "idempotency-key": "held-out-key" });
      await client.tick({ advance_day: true });
      const retry = await T(client, body, { "idempotency-key": "held-out-key" });
      return {
        // idempotency/idempotency_key_diverged: one key and one body, two
        // transfers.
        manifested: retry.status >= 200 && retry.status < 300 && retry.body?.id !== first.body?.id,
        clean: first.status === 201 && retry.status === 200 && retry.body?.id === first.body?.id,
        evidence: `retry after the day rollover -> ${retry.status} ${retry.body?.id} (first ${first.body?.id})`,
      };
    },
  },
  {
    fault: "f-fee-double-charged",
    title: "a settled EUR transfer's entries sum to zero",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000, "EUR");
      const destination = await client.openAccount("bob", "EUR");
      // amount * 15 / 10000 is exactly 3, so no rounding is in play: only a
      // misapplied fee can move this transfer's entries off zero.
      const created = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 2000,
      });
      await client.tick();
      const entries = [
        ...(await client.allEntries(source.id)),
        ...(await client.allEntries(destination.id)),
        ...(await client.allEntries("acc_fee_eur")),
      ].filter((entry) => entry.transfer_id === created.body?.id);
      const sum = entries.reduce((total, entry) => total + entry.amount, 0);
      return {
        // conservation/transfer_entries_nonzero: debit + credit + fee != 0.
        manifested: sum !== 0,
        clean: sum === 0 && entries.length === 3,
        evidence: `EUR transfer ${created.body?.id} entries sum to ${sum} over ${entries.length} rows`,
      };
    },
  },

  // ---- the S0 sealed set (studies/api-suite/PREREGISTRATION.md §4.2) ----
  //
  // Same discipline as the held-out set above: each probe drives the shortest
  // sequence that makes its fault observable from the API surface alone, and
  // asserts the *contract* it breaks — the statement in the S0 handout, not a
  // fixture internal — so a fault that fires here is one an arm's traffic can
  // be scored on.
  {
    fault: "f-activate-after-close",
    title: "a closed account cannot be activated again",
    async probe(client) {
      const account = await client.openAccount("alice");
      const closed = await client.post(`/accounts/${account.id}/close`);
      const revived = await client.post(`/accounts/${account.id}/activate`);
      const readBack = await client.get(`/accounts/${account.id}`);
      return {
        // Lifecycle legality: closure is terminal.
        manifested: revived.status >= 200 && revived.status < 300 && revived.body?.status === "active",
        clean:
          closed.status === 200 &&
          revived.status === 410 &&
          revived.body?.error?.code === "account_closed" &&
          readBack.status === 410,
        evidence: `activate of closed ${account.id} -> ${revived.status} ${JSON.stringify(revived.body)}`,
      };
    },
  },
  {
    fault: "f-transfer-to-pending-destination",
    title: "a transfer into a never-activated account is refused",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000);
      const destination = await client.post("/accounts", { owner: "bob", currency: "USD" });
      const response = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.body.id,
        amount: 1200,
      });
      return {
        // lifecycle/transfer_on_inactive_account: a 2xx transfer naming an
        // account the trace observed pending.
        manifested: response.status >= 200 && response.status < 300,
        clean:
          destination.body?.status === "pending" &&
          response.status === 409 &&
          response.body?.error?.code === "account_not_active",
        evidence: `transfer into pending ${destination.body?.id} -> ${response.status} ${JSON.stringify(response.body)}`,
      };
    },
  },
  {
    fault: "f-deposit-entry-mismatch",
    title: "a deposit's entry_id names the row that deposit wrote",
    async probe(client) {
      const account = await client.fundedAccount("alice", 1000);
      const second = await client.post("/deposits", { account_id: account.id, amount: 2000 });
      const readBack = await client.get(`/deposits/${second.body.id}`);
      const entries = await client.allEntries(account.id);
      const named = entries.find((entry) => entry.id === readBack.body?.entry_id);
      return {
        // Reference integrity: a present reference resolves and agrees.
        manifested: Boolean(readBack.body?.entry_id) && (!named || named.deposit_id !== second.body.id),
        clean: Boolean(named) && named.deposit_id === second.body.id && named.amount === 2000,
        evidence:
          `deposit ${second.body?.id} (amount 2000) cites ${readBack.body?.entry_id}, ` +
          `which belongs to ${named ? `${named.deposit_id} amount ${named.amount}` : "no observed entry"}`,
      };
    },
  },
  {
    fault: "f-fee-account-balance-untouched",
    title: "the fee account's balance is the fees it has collected",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000);
      const destination = await client.openAccount("bob");
      await T(client, { source_account_id: source.id, destination_account_id: destination.id, amount: 1200 });
      await client.tick();
      const stored = (await client.get("/accounts/acc_fee_usd")).body?.balance;
      const derived = (await client.allEntries("acc_fee_usd")).reduce((total, entry) => total + entry.amount, 0);
      return {
        // balance_agreement/stored_balance_diverged, on the system account.
        manifested: stored !== derived,
        clean: stored === derived && derived > 0,
        evidence: `acc_fee_usd stored ${stored} vs derived ${derived}`,
      };
    },
  },
  {
    fault: "f-eur-fee-flat",
    title: "the fee schedule is one schedule in every currency",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000, "EUR");
      const destination = await client.openAccount("bob", "EUR");
      const created = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 2000,
      });
      return {
        // The declared schedule: 25 + round_half_up(amount * 15 / 10000).
        manifested: created.status === 201 && created.body?.fee !== feeFor(2000),
        clean: created.status === 201 && created.body?.fee === feeFor(2000),
        evidence: `EUR transfer of 2000 declares fee ${created.body?.fee} (schedule says ${feeFor(2000)})`,
      };
    },
  },
  {
    fault: "f-include-closed-ignored",
    title: "include_closed=true lists closed accounts",
    async probe(client) {
      const account = await client.openAccount("alice");
      const closed = await client.post(`/accounts/${account.id}/close`);
      const listed = await client.get("/accounts?include_closed=true&limit=100");
      const present = (listed.body?.items ?? []).some((item) => item.id === account.id);
      return {
        // Documented parameters: the flag has its documented effect.
        manifested: listed.status === 200 && !present,
        clean: closed.status === 200 && listed.status === 200 && present,
        evidence: `include_closed=true returned ${listed.body?.items?.length} account(s); ${account.id} present=${present}`,
      };
    },
  },
  {
    fault: "f-transfers-filter-after-page",
    title: "a short page of a filtered transfer listing is the last page",
    async probe(client) {
      const alice = await client.fundedAccount("alice", 9000);
      const bob = await client.openAccount("bob");
      const carol = await client.fundedAccount("carol", 9000);
      const pay = (source, amount) =>
        T(client, { source_account_id: source, destination_account_id: bob.id, amount });
      await pay(alice.id, 1000);
      await pay(alice.id, 1100);
      await pay(carol.id, 1200); // newest, and not alice's
      const page = await client.get(`/transfers?account_id=${alice.id}&limit=2`);
      const items = page.body?.items ?? [];
      const foreign = items.filter(
        (transfer) => transfer.source_account_id !== alice.id && transfer.destination_account_id !== alice.id,
      );
      return {
        // Page discipline: a page shorter than the limit carries no cursor.
        manifested: page.status === 200 && items.length < 2 && page.body?.next_cursor !== null,
        clean: page.status === 200 && items.length === 2 && page.body?.next_cursor === null && foreign.length === 0,
        evidence: `account_id=${alice.id}&limit=2 -> ${items.length} item(s), next_cursor=${page.body?.next_cursor}`,
      };
    },
  },
  {
    fault: "f-idempotency-conflict-ignored",
    title: "one key with a different body is a conflict that creates nothing",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000);
      const destination = await client.openAccount("bob");
      const body = (amount) => ({
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount,
      });
      const first = await T(client, body(1200), { "idempotency-key": "sealed-conflict" });
      const second = await T(client, body(1300), { "idempotency-key": "sealed-conflict" });
      return {
        // The declared exception to idempotency, in reverse: the second
        // request asked for something else and got the first transfer.
        manifested: second.status >= 200 && second.status < 300 && second.body?.id === first.body?.id,
        clean:
          first.status === 201 &&
          second.status === 409 &&
          second.body?.error?.code === "idempotency_key_conflict",
        evidence: `same key, amount 1200 then 1300 -> ${second.status} ${JSON.stringify(second.body)}`,
      };
    },
  },
  {
    fault: "f-idempotency-freed-by-cancel",
    title: "an Idempotency-Key still replays after its transfer is canceled",
    async probe(client) {
      const source = await client.fundedAccount("alice", 20_000);
      const destination = await client.openAccount("bob");
      const body = { source_account_id: source.id, destination_account_id: destination.id, amount: 1200 };
      const first = await T(client, body, { "idempotency-key": "sealed-cancel" });
      const canceled = await client.post(`/transfers/${first.body.id}/cancel`);
      const retry = await T(client, body, { "idempotency-key": "sealed-cancel" });
      return {
        // idempotency/idempotency_key_diverged: one key, one body, two transfers.
        manifested: retry.status >= 200 && retry.status < 300 && retry.body?.id !== first.body?.id,
        clean: canceled.status === 200 && retry.status === 200 && retry.body?.id === first.body?.id,
        evidence: `retry after cancelling ${first.body?.id} -> ${retry.status} ${retry.body?.id}`,
      };
    },
  },
  {
    fault: "f-day-usage-carryover",
    title: "a ledger-day rollover starts the day's transfer usage at zero",
    async probe(client) {
      const source = await client.fundedAccount("alice", 250_000);
      const destination = await client.openAccount("bob");
      const send = (amount) =>
        T(client, { source_account_id: source.id, destination_account_id: destination.id, amount });
      const firstDay = await send(60_000);
      await client.tick({ advance_day: true });
      const nextDay = await send(60_000);
      return {
        // The daily limit is per ledger day, and the rollover resets it.
        manifested: nextDay.status === 422 && nextDay.body?.error?.code === "daily_limit_exceeded",
        clean: firstDay.status === 201 && nextDay.status === 201,
        evidence: `60000 on day 0 then 60000 on day 1 -> ${nextDay.status} ${JSON.stringify(nextDay.body)}`,
      };
    },
  },
  {
    fault: "f-tick-day-skips-settlement",
    title: "a tick that advances the ledger day is still a tick",
    async probe(client) {
      const source = await client.fundedAccount("alice", 9000);
      const destination = await client.openAccount("bob");
      const created = await T(client, {
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: 1200,
      });
      const ticked = await client.tick({ advance_day: true });
      const after = await client.get(`/transfers/${created.body.id}`);
      return {
        // Settlement: no transfer is still pending after an unlimited tick.
        manifested: after.body?.status === "pending" && (ticked.body?.settled?.length ?? 0) === 0,
        clean:
          (ticked.body?.settled ?? []).includes(created.body.id) &&
          after.body?.status === "settled" &&
          ticked.body?.day === 1,
        evidence:
          `tick{advance_day} settled ${JSON.stringify(ticked.body?.settled)}; ` +
          `${created.body?.id} is ${after.body?.status}`,
      };
    },
  },
  {
    fault: "f-entries-cross-principal",
    title: "one principal cannot read another's ledger history",
    async probe(client) {
      const account = await openFor(client, "alice", "customer_a", { fund: 5000 });
      // Opening an account is how a client learns which principal it is: the
      // account comes back owned by the caller.
      const mine = await client.post("/accounts", { owner: "bob", currency: "USD" }, { token: CUSTOMER_B_TOKEN });
      const peeked = await client.get(`/accounts/${account.id}/entries`, { token: CUSTOMER_B_TOKEN });
      const own = await client.get(`/accounts/${account.id}/entries`, { token: CUSTOMER_TOKEN });
      if (mine.body?.owner_principal !== "customer_b") throw new Error("customer_b did not own its own account");
      return {
        // Ownership: no part of another principal's account comes back.
        manifested: peeked.status === 200 && (peeked.body?.items?.length ?? 0) > 0,
        clean:
          peeked.status === 403 &&
          peeked.body?.error?.code === "forbidden" &&
          own.status === 200 &&
          own.body.items.length > 0,
        evidence: `customer_b reading customer_a's ${account.id} entries -> ${peeked.status}`,
      };
    },
  },
  {
    fault: "f-transfer-source-unowned",
    title: "only the owner of the source account may spend from it",
    async probe(client) {
      const payer = await openFor(client, "alice", "customer_a", { fund: 9000 });
      // The payee opens its own account, as a customer of the service does.
      const created = await client.post("/accounts", { owner: "bob", currency: "USD" }, { token: CUSTOMER_B_TOKEN });
      const payee = created.body;
      await client.post(`/accounts/${payee.id}/activate`, {}, { token: CUSTOMER_B_TOKEN });
      const pulled = await client.post(
        "/transfers",
        { source_account_id: payer.id, destination_account_id: payee.id, amount: 1200 },
        { token: CUSTOMER_B_TOKEN },
      );
      return {
        // Ownership: the payee is a party to the transfer, not an authority
        // over the payer's account.
        manifested: pulled.status >= 200 && pulled.status < 300,
        clean: pulled.status === 403 && pulled.body?.error?.code === "forbidden",
        evidence: `customer_b pulling 1200 out of customer_a's ${payer.id} -> ${pulled.status}`,
      };
    },
  },
  {
    fault: "f-same-account-envelope-bare",
    title: "a self-transfer is refused with the error envelope",
    async probe(client) {
      const account = await client.fundedAccount("alice", 9000);
      const response = await T(client, {
        source_account_id: account.id,
        destination_account_id: account.id,
        amount: 1200,
      });
      return {
        // error_shape/error_envelope_violation: a 4xx that is not
        // {error:{code,message,details?}}.
        manifested: response.status >= 400 && typeof response.body?.error === "string",
        clean: response.status === 422 && response.body?.error?.code === "same_account",
        evidence: `self-transfer -> ${response.status} ${JSON.stringify(response.body)}`,
      };
    },
  },
];

// Guard against the catalog and the probes drifting apart.
const covered = MANIFESTATIONS.map((entry) => entry.fault).sort();
const known = [...FAULT_IDS].sort();
if (covered.join(",") !== known.join(",")) {
  throw new Error(`manifestation probes do not cover the fault catalog: ${covered} vs ${known}`);
}
