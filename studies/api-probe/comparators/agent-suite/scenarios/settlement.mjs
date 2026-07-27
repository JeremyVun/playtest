// Rule 1 (conservation) and rule 6 (balance agreement) against real settled
// money: a spread of amounts chosen to hit every corner of the fee rounding
// rule, both currencies, a transfer whose destination is a fee account, a
// transfer canceled before it settles, and a transfer that runs out of funds
// between creation and settlement (so it must end "failed" with no entries).

import { feeFor } from '../lib/api.mjs';
import { expectStatus, expectRefused } from '../lib/expect.mjs';
import { snapshot, checkBalanceAgreement, checkConservation } from '../lib/ledger.mjs';

export const name = 'settlement';

export async function run({ api, client, report, baselineTotal = 0 }) {
  const alice = (await api.createAccount('s-alice', 'USD')).account;
  const bob = (await api.createAccount('s-bob', 'USD')).account;
  const carol = (await api.createAccount('s-carol', 'USD')).account;
  const eve = (await api.createAccount('s-eve', 'EUR')).account;
  const frank = (await api.createAccount('s-frank', 'EUR')).account;
  for (const acc of [alice, bob, carol, eve, frank]) await api.activate(acc.id);

  await api.deposit(alice.id, 90000);
  await api.deposit(eve.id, 50000);

  // amount -> fee: 1->25 (0.0015 rounds to 0), 333->25 (0.4995 rounds down),
  // 1000->27 (1.5 rounds away from zero), 3333->30, 25000->63 (37.5 rounds up),
  // 50000->100. Daily limit is 100000 per source per day; these sum to 79767.
  const plan = [
    { to: bob.id, amount: 1 },
    { to: bob.id, amount: 333, cancelBeforeTick: true },
    { to: carol.id, amount: 1000 },
    { to: bob.id, amount: 3333 },
    { to: carol.id, amount: 25000 },
    { to: bob.id, amount: 50000 },
    { to: 'acc_fee_usd', amount: 100 }, // destination is the system fee account
  ];

  const created = [];
  for (const step of plan) {
    const { transfer, entry } = await api.transfer(alice.id, step.to, step.amount);
    created.push({ ...step, transfer, entry });
    if (transfer.fee !== feeFor(step.amount)) {
      report.warn(
        'fee does not match the published schedule',
        `amount=${step.amount} fee=${transfer.fee}, schedule (25 + round_half_away(amount*15/10000)) says ${feeFor(step.amount)}`,
      );
    }
  }
  const eurTransfer = (await api.transfer(eve.id, frank.id, 12345)).transfer;

  const canceled = created.find((c) => c.cancelBeforeTick);
  const cancelRes = await api.cancel(canceled.transfer.id);
  expectStatus(report, 'lifecycle', 'a pending transfer could not be canceled', cancelRes.entry, [200]);

  // A partial tick: settlement is supposed to be bounded by settle_limit and to
  // run in creation order, which means the transfers it did not reach must
  // still be pending and must still have written nothing.
  const partial = await api.tick({ settle_limit: 2 });
  const partialSettled = partial.result?.settled ?? [];
  if (partialSettled.length > 2) {
    report.violation('lifecycle', 'a tick settled more transfers than settle_limit allowed', {
      expected: 'settle_limit: 2 settles at most 2 transfers',
      observed: JSON.stringify(partial.result),
      requests: [partial.entry],
    });
  }
  const untouched = created.find((c) => !c.cancelBeforeTick && !partialSettled.includes(c.transfer.id));
  if (untouched) {
    const read = await api.getTransfer(untouched.transfer.id);
    if (read.transfer?.status !== 'pending') {
      report.violation('lifecycle', 'a transfer the partial tick did not settle changed status anyway', {
        expected: `${untouched.transfer.id} is still "pending" after a tick with settle_limit 2`,
        observed: `${read.transfer?.status}`,
        requests: [partial.entry, read.entry],
      });
    }
  }

  const tick1 = await api.tick({});
  const settledIds = new Set([...partialSettled, ...(tick1.result?.settled ?? [])]);
  for (const c of created.filter((x) => !x.cancelBeforeTick)) {
    if (!settledIds.has(c.transfer.id)) {
      report.setupFailure(
        name,
        `tick did not settle pending transfer ${c.transfer.id} (amount ${c.amount}); tick said ${JSON.stringify(tick1.result)}`,
        [c.entry, tick1.entry],
      );
    }
  }
  if (settledIds.has(canceled.transfer.id)) {
    report.violation('lifecycle', 'a canceled transfer was settled by a later tick', {
      expected: `${canceled.transfer.id} was canceled before the tick and must stay canceled`,
      observed: `ticks settled: ${JSON.stringify([...settledIds])}`,
      requests: [cancelRes.entry, partial.entry, tick1.entry],
    });
  }
  if (!settledIds.has(eurTransfer.id)) {
    report.setupFailure(name, `tick did not settle the EUR transfer ${eurTransfer.id}`, [tick1.entry]);
  }

  // A transfer that is affordable when created but not when it settles: both of
  // these pass the creation-time check, the first one drains the account, the
  // second must end "failed" and write nothing.
  const balanceNow = (await api.getAccount(alice.id)).account?.balance;
  if (!Number.isInteger(balanceNow)) {
    report.setupFailure(name, `could not read ${alice.id} balance after settlement`, []);
    return;
  }
  const usedToday = plan.reduce((a, s) => a + s.amount, 0); // the limit is reserved at creation, cancels included
  const dailyLeft = 100000 - usedToday;
  const big = Math.max(1, Math.min(Math.floor((balanceNow - 200) * 0.9), Math.floor(dailyLeft / 2) - 1));
  const first = (await api.transfer(alice.id, carol.id, big)).transfer;
  const doomed = (await api.transfer(alice.id, bob.id, big)).transfer;
  const tick2 = await api.tick({});
  const settled2 = new Set(tick2.result?.settled ?? []);
  const failed2 = new Set(tick2.result?.failed ?? []);
  if (!settled2.has(first.id) || !failed2.has(doomed.id)) {
    report.setupFailure(
      name,
      `expected ${first.id} to settle and ${doomed.id} (${big} of a ${balanceNow} balance, twice) to fail: ${JSON.stringify(tick2.result)}`,
      [tick2.entry],
    );
  }
  const doomedRead = await api.getTransfer(doomed.id);
  if (doomedRead.transfer?.status === 'failed') {
    const cancelFailed = await api.cancel(doomed.id);
    expectRefused(report, 'lifecycle', 'a failed transfer could be canceled', cancelFailed.entry, {
      statuses: [409],
      code: 'transfer_not_pending',
    });
  }

  const snap = await snapshot(api, report, 'after settlement');
  checkBalanceAgreement(snap, report);
  checkConservation(snap, report, {
    depositTotal: client.depositTotal(baselineTotal),
    deposits: client.acceptedDeposits,
  });

  // The canceled and failed transfers must appear in the snapshot with no
  // entries at all; checkConservation asserts that for every non-settled
  // transfer it can see, so just make sure they were visible.
  const seen = new Set(snap.transfers.map((t) => t.id));
  for (const id of [canceled.transfer.id, doomed.id]) {
    if (!seen.has(id)) {
      report.setupFailure(name, `GET /transfers did not list ${id}, so its ledger effects could not be checked`, []);
    }
  }
}
