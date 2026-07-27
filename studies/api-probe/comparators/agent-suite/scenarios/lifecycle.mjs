// Rule 3. Every illegal operation is followed by a read that proves nothing
// happened: a refusal that still moved money, still created a row, or still
// wrote an entry is the defect worth catching, not the status code.

import { expectRefused, expectStatus, transferIdsFor } from '../lib/expect.mjs';

export const name = 'lifecycle';

export async function run({ api, report }) {
  const pending = (await api.createAccount('l-pending', 'USD')).account; // never activated
  const a = (await api.createAccount('l-a', 'USD')).account;
  const b = (await api.createAccount('l-b', 'USD')).account;
  const c = (await api.createAccount('l-c', 'USD')).account;
  const doomedAcct = (await api.createAccount('l-closed', 'USD')).account;
  for (const acc of [a, b, c, doomedAcct]) await api.activate(acc.id);
  await api.deposit(a.id, 40000);
  await api.deposit(doomedAcct.id, 5000);

  // --- an account that has never been activated cannot transact -------------
  const fromPending = await api.postTransfer({ source_account_id: pending.id, destination_account_id: a.id, amount: 100 });
  expectRefused(report, 'lifecycle', 'a transfer whose source has never been activated was accepted', fromPending, {
    statuses: [409],
    code: 'account_not_active',
  });
  const toPending = await api.postTransfer({ source_account_id: a.id, destination_account_id: pending.id, amount: 100 });
  expectRefused(report, 'lifecycle', 'a transfer whose destination has never been activated was accepted', toPending, {
    statuses: [409],
    code: 'account_not_active',
  });
  const pendingTransfers = await transferIdsFor(api, pending.id);
  if (pendingTransfers.ids.length) {
    report.violation('lifecycle', 'a refused transfer against a never-activated account was still recorded', {
      expected: `no transfer names ${pending.id}`,
      observed: pendingTransfers.ids.join(' '),
      requests: [fromPending, toPending, ...pendingTransfers.requests].slice(0, 5),
    });
  }
  const pendingEntries = await api.entries(pending.id, { limit: 100 });
  if (pendingEntries.items.length) {
    report.violation('lifecycle', 'a never-activated account has ledger entries', {
      expected: `${pending.id} has never transacted, so it has no entries`,
      observed: pendingEntries.items.map((e) => `${e.id}:${e.kind}:${e.amount}`).join(' '),
      requests: pendingEntries.requests.slice(0, 2),
    });
  }

  // --- an account with a pending transfer cannot be closed ------------------
  const held = (await api.transfer(a.id, b.id, 2000)).transfer;
  const closeSource = await api.close(a.id);
  expectRefused(report, 'lifecycle', 'an account with a pending outgoing transfer could be closed', closeSource.entry, {
    statuses: [409],
    code: 'account_has_pending_transfers',
  });
  const closeDest = await api.close(b.id);
  expectRefused(report, 'lifecycle', 'an account with a pending incoming transfer could be closed', closeDest.entry, {
    statuses: [409],
    code: 'account_has_pending_transfers',
  });
  for (const acc of [a, b]) {
    const read = await api.getAccount(acc.id);
    if (read.entry.status !== 200 || read.account?.status !== 'active') {
      report.violation('lifecycle', 'a refused close still changed the account', {
        expected: `${acc.id} is still active after its close was refused`,
        observed: `${read.entry.status} ${read.entry.responseText.slice(0, 200)}`,
        requests: [closeSource.entry, closeDest.entry, read.entry],
      });
    }
  }

  // Cancel it, and the close becomes legal; the cancel must write nothing.
  const balanceBeforeCancel = (await api.getAccount(a.id)).account?.balance;
  const cancel = await api.cancel(held.id);
  expectStatus(report, 'lifecycle', 'a pending transfer could not be canceled', cancel.entry, [200]);
  const cancelAgain = await api.cancel(held.id);
  expectRefused(report, 'lifecycle', 'an already canceled transfer could be canceled again', cancelAgain.entry, {
    statuses: [409],
    code: 'transfer_not_pending',
  });
  const afterCancel = await api.entries(a.id, { limit: 100 });
  const heldEntries = afterCancel.items.filter((e) => e.transfer_id === held.id);
  if (heldEntries.length) {
    report.violation('conservation', 'a canceled transfer wrote ledger entries', {
      expected: `${held.id} was canceled before settlement and writes no entries`,
      observed: heldEntries.map((e) => `${e.id}:${e.kind}:${e.amount}`).join(' '),
      requests: [cancel.entry, ...afterCancel.requests].slice(0, 4),
    });
  }
  const balanceAfterCancel = (await api.getAccount(a.id)).account?.balance;
  if (balanceAfterCancel !== balanceBeforeCancel) {
    report.violation('balance', 'canceling a pending transfer moved the source balance', {
      expected: `${a.id} balance stays ${balanceBeforeCancel}`,
      observed: `${balanceAfterCancel}`,
      requests: [cancel.entry],
    });
  }
  // A canceled transfer must not be resurrected by settlement.
  await api.tick({});
  const afterTick = await api.getTransfer(held.id);
  if (afterTick.transfer?.status !== 'canceled') {
    report.violation('lifecycle', 'a canceled transfer did not stay canceled through a tick', {
      expected: `${held.id} status "canceled"`,
      observed: `${afterTick.transfer?.status}`,
      requests: [cancel.entry, afterTick.entry],
    });
  }

  // --- closure is a soft delete, and a closed account cannot transact -------
  const closed = await api.close(doomedAcct.id);
  if (!expectStatus(report, 'lifecycle', 'an idle account could not be closed', closed.entry, [200])) return;
  const readClosed = await api.getAccount(doomedAcct.id);
  expectRefused(report, 'lifecycle', 'a closed account still answers a plain read with 2xx', readClosed.entry, {
    statuses: [410],
    code: 'account_closed',
  });
  const reactivate = await api.close(doomedAcct.id);
  expectRefused(report, 'lifecycle', 'a closed account could be closed twice', reactivate.entry, { statuses: [410, 409] });
  const activateClosed = await api.postActivateRaw(doomedAcct.id);
  expectRefused(report, 'lifecycle', 'a closed account could be re-activated', activateClosed, { statuses: [410, 409] });
  const depositClosed = await api.postDepositRaw(doomedAcct.id, 100);
  expectRefused(report, 'lifecycle', 'a closed account could be funded', depositClosed, { statuses: [410] });
  const fromClosed = await api.postTransfer({ source_account_id: doomedAcct.id, destination_account_id: a.id, amount: 100 });
  expectRefused(report, 'lifecycle', 'a transfer out of a closed account was accepted', fromClosed, {
    statuses: [410],
    code: 'account_closed',
  });
  const toClosed = await api.postTransfer({ source_account_id: a.id, destination_account_id: doomedAcct.id, amount: 100 });
  expectRefused(report, 'lifecycle', 'a transfer into a closed account was accepted', toClosed, {
    statuses: [410],
    code: 'account_closed',
  });
  const closedTransfers = await transferIdsFor(api, doomedAcct.id);
  if (closedTransfers.ids.length) {
    report.violation('lifecycle', 'a refused transfer against a closed account was still recorded', {
      expected: `no transfer names ${doomedAcct.id}`,
      observed: closedTransfers.ids.join(' '),
      requests: [fromClosed, toClosed, ...closedTransfers.requests].slice(0, 5),
    });
  }
  // The tombstone side of the same rule: history keeps being served.
  const closedEntries = await api.entries(doomedAcct.id, { limit: 100 });
  if (closedEntries.items.length !== 1) {
    report.warn(
      'closed account history',
      `${doomedAcct.id} was funded once before closure but its entry history has ${closedEntries.items.length} rows`,
    );
  }
  const visible = await api.listAccounts({ includeClosed: false });
  if (visible.items.some((acc) => acc.id === doomedAcct.id)) {
    report.warn('closed account listing', `${doomedAcct.id} is closed but still appears in GET /accounts without include_closed`);
  }
  const visibleAll = await api.listAccounts({ includeClosed: true });
  if (!visibleAll.items.some((acc) => acc.id === doomedAcct.id)) {
    report.violation('balance', 'a closed account disappeared from include_closed=true, so its money cannot be accounted for', {
      expected: `${doomedAcct.id} is listed with include_closed=true`,
      observed: visibleAll.items.map((acc) => acc.id).join(' '),
      requests: visibleAll.requests.slice(0, 2),
    });
  }

  // --- a settled transfer cannot be canceled -------------------------------
  const settledOne = (await api.transfer(a.id, c.id, 1500)).transfer;
  await api.tick({});
  const settledRead = await api.getTransfer(settledOne.id);
  if (settledRead.transfer?.status !== 'settled') {
    report.setupFailure(name, `expected ${settledOne.id} to be settled after a tick, got ${settledRead.transfer?.status}`, [
      settledRead.entry,
    ]);
  } else {
    const entriesBefore = await api.entries(a.id, { limit: 100 });
    const cancelSettled = await api.cancel(settledOne.id);
    expectRefused(report, 'lifecycle', 'a settled transfer could be canceled', cancelSettled.entry, {
      statuses: [409],
      code: 'transfer_not_pending',
    });
    const entriesAfter = await api.entries(a.id, { limit: 100 });
    if (entriesAfter.items.length !== entriesBefore.items.length) {
      report.violation('lifecycle', 'refusing to cancel a settled transfer still wrote to the ledger', {
        expected: `${a.id} keeps its ${entriesBefore.items.length} entries`,
        observed: `${entriesAfter.items.length} entries after the refused cancel`,
        requests: [cancelSettled.entry, ...entriesAfter.requests].slice(0, 4),
      });
    }
    const readAgain = await api.getTransfer(settledOne.id);
    if (readAgain.transfer?.status !== 'settled') {
      report.violation('lifecycle', 'a refused cancel still changed a settled transfer', {
        expected: 'status stays "settled"',
        observed: `${readAgain.transfer?.status}`,
        requests: [cancelSettled.entry, readAgain.entry],
      });
    }
  }
}
