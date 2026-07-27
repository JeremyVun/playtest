// Whole-world ledger snapshot and the two arithmetic rules that read it.
//
// A snapshot is: every account (including closed ones), every ledger entry of
// every account, and every transfer. Balances are read before and after the
// entry walk and must be identical, which is the "no intervening write"
// condition rule 6 declares.

import { feeFor } from './api.mjs';

export async function snapshot(api, report, label) {
  const before = await api.listAccounts({ includeClosed: true });
  const accounts = before.items;
  const entriesByAccount = new Map();
  const requestsByAccount = new Map();

  for (const account of accounts) {
    if (typeof account?.id !== 'string') continue;
    // limit=100 needs one page for anything this suite creates; the cap is a
    // budget guard, and enumerate() only calls a stop at the cap a violation
    // when the walk has clearly run away.
    const walk = await api.entries(account.id, { limit: 100, maxPages: 12 });
    entriesByAccount.set(account.id, walk.items);
    requestsByAccount.set(account.id, walk.requests);
  }

  const after = await api.listAccounts({ includeClosed: true });
  const beforeBal = new Map(accounts.map((a) => [a.id, a.balance]));
  const afterBal = new Map(after.items.map((a) => [a.id, a.balance]));
  const moved = [...beforeBal.entries()].filter(([id, v]) => afterBal.get(id) !== v);
  if (moved.length) {
    // The suite is strictly sequential and issued no write during the walk, so
    // this is the service moving money on its own — which also destroys the
    // premise rule 6 is read under. Report it and let the caller decide.
    report.violation('balance', 'a balance changed while the suite issued no write', {
      dedupe: label,
      expected: 'balances are stable between two reads with no intervening write',
      observed: moved.map(([id, v]) => `${id}: ${v} -> ${afterBal.get(id)}`).join('; '),
      requests: [before.requests[0], after.requests[0]],
    });
  }

  const transfers = await api.listTransfers();

  return {
    label,
    accounts,
    accountsAfter: after.items,
    entriesByAccount,
    requestsByAccount,
    transfers: transfers.items,
    listRequests: [...before.requests, ...after.requests, ...transfers.requests],
    stable: moved.length === 0,
  };
}

export function checkBalanceAgreement(snap, report) {
  for (const account of snap.accounts) {
    const entries = snap.entriesByAccount.get(account.id) ?? [];
    let sum = 0;
    let bad = false;
    for (const e of entries) {
      if (!Number.isInteger(e?.amount)) {
        report.violation('balance', 'a ledger entry amount is not an integer in minor units', {
          dedupe: `${account.id}`,
          expected: 'every money field is an integer number of minor units',
          observed: `entry ${e?.id} amount=${JSON.stringify(e?.amount)}`,
          requests: snap.requestsByAccount.get(account.id) ?? [],
        });
        bad = true;
        break;
      }
      if (e.account_id !== account.id) {
        report.violation('balance', "an account's entry listing served an entry belonging to another account", {
          dedupe: `${account.id}`,
          expected: `every entry under GET /accounts/${account.id}/entries has account_id ${account.id}`,
          observed: `entry ${e.id} has account_id ${e.account_id}`,
          requests: snap.requestsByAccount.get(account.id) ?? [],
        });
        bad = true;
        break;
      }
      sum += e.amount;
    }
    if (bad) continue;
    if (!Number.isInteger(account.balance)) {
      report.violation('balance', 'an account balance is not an integer in minor units', {
        dedupe: account.id,
        expected: 'integer minor units',
        observed: `${account.id} balance=${JSON.stringify(account.balance)}`,
        requests: [snap.listRequests[0]],
      });
      continue;
    }
    if (sum !== account.balance) {
      report.violation('balance', "an account's stored balance does not equal the sum of its ledger entries", {
        dedupe: `${account.id}@${snap.label}`,
        expected: `${account.id} (${account.kind}/${account.status}) balance == sum of its ${entries.length} entries == ${sum}`,
        observed: `balance=${account.balance}, entries sum=${sum}, difference=${account.balance - sum}; entries: ${entries
          .map((e) => `${e.id}:${e.kind}:${e.amount}`)
          .join(' ')}`,
        requests: [snap.listRequests[0], ...(snap.requestsByAccount.get(account.id) ?? [])].slice(0, 6),
        note: `snapshot "${snap.label}"; balances were re-read after the walk and were unchanged`,
      });
    }
  }
}

export function checkConservation(snap, report, { depositTotal, deposits } = {}) {
  const byTransfer = new Map();
  const allEntryIds = new Map();
  let entryTotal = 0;
  let depositEntryTotal = 0;

  for (const [accountId, entries] of snap.entriesByAccount) {
    for (const e of entries) {
      if (!Number.isInteger(e?.amount)) continue;
      entryTotal += e.amount;
      if (e.kind === 'deposit') depositEntryTotal += e.amount;
      if (typeof e.id === 'string') {
        const prior = allEntryIds.get(e.id);
        if (prior && prior !== accountId) {
          report.violation('conservation', 'the same ledger entry id appears under two different accounts', {
            dedupe: e.id,
            expected: 'ledger entry ids are unique',
            observed: `${e.id} served under both ${prior} and ${accountId}`,
            requests: [...(snap.requestsByAccount.get(prior) ?? []), ...(snap.requestsByAccount.get(accountId) ?? [])].slice(0, 4),
          });
        }
        allEntryIds.set(e.id, accountId);
      }
      if (typeof e.transfer_id === 'string') {
        if (!byTransfer.has(e.transfer_id)) byTransfer.set(e.transfer_id, []);
        byTransfer.get(e.transfer_id).push(e);
      }
    }
  }

  const knownTransfers = new Map(snap.transfers.map((t) => [t.id, t]));

  for (const transfer of snap.transfers) {
    const entries = byTransfer.get(transfer.id) ?? [];
    const evidence = () =>
      [
        ...(snap.requestsByAccount.get(transfer.source_account_id) ?? []),
        ...(snap.requestsByAccount.get(transfer.destination_account_id) ?? []),
        ...(snap.requestsByAccount.get(transfer.fee_account_id) ?? []),
      ].slice(0, 6);

    if (transfer.status === 'settled') {
      const sum = entries.reduce((acc, e) => acc + (Number.isInteger(e.amount) ? e.amount : NaN), 0);
      if (sum !== 0) {
        report.violation('conservation', 'the ledger entries of a settled transfer do not sum to zero', {
          dedupe: `${transfer.id}@${snap.label}`,
          expected: `entries carrying ${transfer.id} sum to 0 (debit -${transfer.amount + transfer.fee}, credit +${transfer.amount}, fee +${transfer.fee})`,
          observed: `sum=${sum} over ${entries.length} entries: ${entries
            .map((e) => `${e.id}[${e.account_id} ${e.kind} ${e.amount}]`)
            .join(' ')}`,
          requests: evidence(),
        });
      }
      const debit = entries.filter((e) => e.kind === 'transfer_debit');
      const credit = entries.filter((e) => e.kind === 'transfer_credit');
      const fee = entries.filter((e) => e.kind === 'fee');
      const structure = [];
      if (entries.length !== 3) structure.push(`${entries.length} entries carry this transfer id, expected exactly 3`);
      if (debit.length !== 1) structure.push(`${debit.length} transfer_debit entries`);
      else {
        if (debit[0].account_id !== transfer.source_account_id)
          structure.push(`the debit landed on ${debit[0].account_id}, not the source ${transfer.source_account_id}`);
        if (debit[0].amount !== -(transfer.amount + transfer.fee))
          structure.push(`the debit is ${debit[0].amount}, expected ${-(transfer.amount + transfer.fee)} (amount+fee)`);
      }
      if (credit.length !== 1) structure.push(`${credit.length} transfer_credit entries`);
      else {
        if (credit[0].account_id !== transfer.destination_account_id)
          structure.push(`the credit landed on ${credit[0].account_id}, not the destination ${transfer.destination_account_id}`);
        if (credit[0].amount !== transfer.amount)
          structure.push(`the credit is ${credit[0].amount}, expected ${transfer.amount}`);
      }
      if (fee.length !== 1) structure.push(`${fee.length} fee entries`);
      else {
        if (fee[0].account_id !== transfer.fee_account_id)
          structure.push(`the fee credit landed on ${fee[0].account_id}, not ${transfer.fee_account_id}`);
        if (fee[0].amount !== transfer.fee) structure.push(`the fee credit is ${fee[0].amount}, expected ${transfer.fee}`);
      }
      for (const e of entries) {
        if (e.currency !== transfer.currency)
          structure.push(`entry ${e.id} is in ${e.currency}, the transfer is in ${transfer.currency}`);
      }
      if (structure.length && sum === 0) {
        report.violation('conservation', 'a settled transfer did not write the documented debit/credit/fee triple', {
          dedupe: `${transfer.id}@${snap.label}`,
          expected: `one transfer_debit of ${-(transfer.amount + transfer.fee)} on ${transfer.source_account_id}, one transfer_credit of ${transfer.amount} on ${transfer.destination_account_id}, one fee of ${transfer.fee} on ${transfer.fee_account_id}`,
          observed: `${structure.join('; ')} — entries: ${entries.map((e) => `${e.id}[${e.account_id} ${e.kind} ${e.amount}]`).join(' ')}`,
          requests: evidence(),
        });
      }
      if (Number.isInteger(transfer.amount) && transfer.fee !== feeFor(transfer.amount)) {
        report.warn(
          'fee does not match the published schedule',
          `${transfer.id} amount=${transfer.amount} fee=${transfer.fee}, schedule says ${feeFor(transfer.amount)}`,
        );
      }
    } else if (entries.length > 0) {
      report.violation('conservation', `a ${transfer.status} transfer wrote ledger entries`, {
        dedupe: `${transfer.status}@${snap.label}`,
        expected: `a transfer that ends "${transfer.status}" writes no entries at all`,
        observed: `${transfer.id} (${transfer.status}) carries ${entries.length} entries: ${entries
          .map((e) => `${e.id}[${e.account_id} ${e.kind} ${e.amount}]`)
          .join(' ')}`,
        requests: evidence(),
      });
    }
  }

  for (const [transferId, entries] of byTransfer) {
    if (!knownTransfers.has(transferId)) {
      report.violation('conservation', 'ledger entries carry a transfer id that GET /transfers does not know', {
        dedupe: transferId,
        expected: 'every entry with a transfer_id belongs to a listed transfer',
        observed: `${transferId}: ${entries.map((e) => `${e.id}[${e.account_id} ${e.kind} ${e.amount}]`).join(' ')}`,
        requests: snap.listRequests.slice(-1),
      });
    }
  }

  if (typeof depositTotal === 'number') {
    const balanceTotal = snap.accounts.reduce((acc, a) => acc + (Number.isInteger(a.balance) ? a.balance : NaN), 0);
    if (balanceTotal !== depositTotal) {
      report.violation('conservation', 'money in the world does not equal money deposited into it', {
        dedupe: `world@${snap.label}`,
        expected: `every settled transfer nets to zero and only deposits add money, so the balances of all ${snap.accounts.length} accounts sum to the ${deposits?.length ?? '?'} deposits made: ${depositTotal}`,
        observed: `balances sum to ${balanceTotal} (difference ${balanceTotal - depositTotal}); per-account: ${snap.accounts
          .map((a) => `${a.id}=${a.balance}`)
          .join(' ')}`,
        requests: snap.listRequests.slice(0, 2),
        note: 'this is conservation read across the whole ledger; the per-transfer and per-account checks above localise it',
      });
    }
    if (entryTotal !== depositEntryTotal) {
      report.violation('conservation', 'the ledger entries of all transfers do not net to zero', {
        dedupe: `entries@${snap.label}`,
        expected: `sum of every ledger entry == sum of deposit entries (${depositEntryTotal})`,
        observed: `sum of every ledger entry is ${entryTotal}`,
        requests: snap.listRequests.slice(0, 2),
      });
    }
  }
}
