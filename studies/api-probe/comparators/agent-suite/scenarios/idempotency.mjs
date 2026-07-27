// Rule 2. The interesting states are not "does a replay come back 200" but:
// does a replay exist as a second row anywhere (list), does it write a second
// set of ledger effects at settlement, does a burst of simultaneous requests
// with one key collapse to one transfer, and does the declared exception
// (same key, different body) really create nothing.

import { expectStatus, expectRefused, expectEqual, transferIdsFor } from '../lib/expect.mjs';

export const name = 'idempotency';

export async function run({ api, client, report }) {
  const src = (await api.createAccount('i-src', 'USD')).account;
  const dst = (await api.createAccount('i-dst', 'USD')).account;
  await api.activate(src.id);
  await api.activate(dst.id);
  await api.deposit(src.id, 60000);

  const body = { source_account_id: src.id, destination_account_id: dst.id, amount: 2500 };
  const KEY = 'suite-key-basic';

  const first = await api.postTransfer(body, { idempotencyKey: KEY });
  if (!expectStatus(report, 'idempotency', 'the first keyed transfer was not created', first, [201])) return;
  const original = first.json;

  const replay1 = await api.postTransfer(body, { idempotencyKey: KEY });
  const replay2 = await api.postTransfer(body, { idempotencyKey: KEY });
  for (const [i, r] of [replay1, replay2].entries()) {
    if (r.status === 201) {
      report.violation('idempotency', 'a repeated Idempotency-Key with the same body created a second transfer', {
        expected: `201 once, then the same transfer ${original.id} returned with 200`,
        observed: `replay #${i + 1} came back 201 with ${r.json?.id}`,
        requests: [first, r],
      });
      continue;
    }
    if (!expectStatus(report, 'idempotency', 'a replay of a keyed transfer was not accepted as a replay', r, [200], {
      note: `first request created ${original.id}`,
    })) {
      continue;
    }
    expectEqual(report, 'idempotency', 'a replay returned a different transfer than the first request', r.json, original, {
      requests: [first, r],
      note: 'the second request must return the transfer the first one created, field for field',
    });
    if (r.responseHeaders?.['idempotency-replayed'] !== 'true') {
      report.warn(
        'replay without the Idempotency-Replayed header',
        `${r.method} ${r.path} -> 200 but no Idempotency-Replayed: true (the OpenAPI document says replays carry it)`,
      );
    }
  }

  // Exactly one row must exist, whatever the responses said.
  const afterReplays = await transferIdsFor(api, src.id);
  const withKey = afterReplays.items.filter((t) => t.idempotency_key === KEY);
  if (withKey.length !== 1) {
    report.violation('idempotency', 'one Idempotency-Key produced more than one transfer', {
      expected: `exactly one transfer carries ${KEY}`,
      observed: `${withKey.length}: ${withKey.map((t) => `${t.id}(${t.status})`).join(' ')}`,
      requests: [first, replay1, replay2, ...afterReplays.requests].slice(0, 6),
    });
  }

  // Same key, different body: the declared exception. It must create nothing.
  const conflictBody = { ...body, amount: body.amount + 1 };
  const conflict = await api.postTransfer(conflictBody, { idempotencyKey: KEY });
  expectRefused(report, 'idempotency', 'a reused Idempotency-Key with a different body was not refused', conflict, {
    statuses: [409],
    code: 'idempotency_key_conflict',
    note: 'the declared exception says this is a conflict that creates nothing',
  });
  const swapped = await api.postTransfer(
    { source_account_id: dst.id, destination_account_id: src.id, amount: body.amount },
    { idempotencyKey: KEY },
  );
  expectRefused(report, 'idempotency', 'a reused Idempotency-Key with source and destination swapped was not refused', swapped, {
    statuses: [409],
    code: 'idempotency_key_conflict',
  });
  const afterConflict = await transferIdsFor(api, src.id);
  const created = afterConflict.ids.filter((id) => !afterReplays.ids.includes(id));
  if (created.length) {
    report.violation('idempotency', 'a rejected Idempotency-Key conflict still created a transfer', {
      expected: 'the same key with a different body creates nothing',
      observed: `new transfer(s) ${created.join(', ')} appeared after the two conflicting requests`,
      requests: [conflict, swapped, ...afterConflict.requests].slice(0, 5),
    });
  }

  // The same body under a *different* key is a different instruction and must
  // create a second transfer; collapsing it would silently swallow a payment.
  const otherKey = await api.postTransfer(body, { idempotencyKey: 'suite-key-other' });
  if (expectStatus(report, 'idempotency', 'the same body under a fresh key was not created', otherKey, [201, 200])) {
    if (otherKey.json?.id === original.id) {
      report.violation('idempotency', 'a different Idempotency-Key returned the transfer belonging to another key', {
        expected: 'idempotency is scoped to the key: a fresh key with the same body creates a new transfer',
        observed: `key "suite-key-other" returned ${original.id}, which belongs to key "${KEY}"`,
        requests: [first, otherKey],
      });
    }
  }

  // The same body reserialised with the members in a different order is the
  // same request. Creating a second transfer for it would break the rule; a
  // 409 would only be over-strict, so that is an advisory.
  const reordered = JSON.stringify({ amount: body.amount, destination_account_id: dst.id, source_account_id: src.id });
  const reorder = await api.postTransfer(undefined, { rawBody: reordered, idempotencyKey: KEY });
  if (reorder.status === 201) {
    report.violation('idempotency', 'the same key and the same body (members reordered) created a second transfer', {
      expected: `200 replay of ${original.id}`,
      observed: `201 ${reorder.json?.id}`,
      requests: [first, reorder],
    });
  } else if (reorder.status === 409) {
    report.warn('key conflict on a reordered body', 'same key + semantically identical body serialised differently -> 409');
  }

  // Concurrency: five simultaneous requests, one key. Exactly one transfer.
  const burstKey = 'suite-key-burst';
  const burstBody = { ...body, amount: 3500 };
  const burst = await Promise.all(Array.from({ length: 5 }, () => api.postTransfer(burstBody, { idempotencyKey: burstKey })));
  const burstIds = [...new Set(burst.filter((r) => r.status < 300 && r.json?.id).map((r) => r.json.id))];
  const listAfterBurst = await transferIdsFor(api, src.id);
  const burstRows = listAfterBurst.items.filter((t) => t.idempotency_key === burstKey);
  if (burstIds.length > 1 || burstRows.length > 1) {
    report.violation('idempotency', 'simultaneous requests with one Idempotency-Key produced more than one transfer', {
      expected: 'exactly one transfer, whichever request wins the race',
      observed: `responses: ${burst.map((r) => `${r.status}:${r.json?.id ?? r.json?.error?.code}`).join(' ')}; rows carrying the key: ${burstRows
        .map((t) => t.id)
        .join(' ')}`,
      requests: [...burst, ...listAfterBurst.requests].slice(0, 7),
    });
  }
  const created201 = burst.filter((r) => r.status === 201).length;
  if (created201 === 0 && burstRows.length === 1) {
    report.warn('burst without a 201', 'five concurrent keyed requests produced a transfer but no 201 among the responses');
  }

  // One key, one set of ledger effects — checked after the money actually moves.
  await api.tick({});
  const settledReplay = await api.postTransfer(body, { idempotencyKey: KEY });
  if (expectStatus(report, 'idempotency', 'replaying a key after settlement was not a replay', settledReplay, [200])) {
    if (settledReplay.json?.id !== original.id) {
      report.violation('idempotency', 'replaying a key after settlement returned a different transfer', {
        expected: `${original.id}`,
        observed: `${settledReplay.json?.id}`,
        requests: [first, settledReplay],
      });
    }
    if (settledReplay.json?.status !== 'settled') {
      report.warn('post-settlement replay status', `replay reported status ${settledReplay.json?.status}, the transfer had settled`);
    }
  }

  const srcEntries = await api.entries(src.id, { limit: 100 });
  const forOriginal = srcEntries.items.filter((e) => e.transfer_id === original.id);
  if (forOriginal.length !== 1) {
    report.violation('idempotency', 'one keyed transfer wrote more than one debit on the source account', {
      expected: `exactly one ledger entry on ${src.id} carries ${original.id}`,
      observed: `${forOriginal.length}: ${forOriginal.map((e) => `${e.id}:${e.amount}`).join(' ')}`,
      requests: srcEntries.requests.slice(0, 3),
    });
  }
  const dstEntries = await api.entries(dst.id, { limit: 100 });
  const creditsForOriginal = dstEntries.items.filter((e) => e.transfer_id === original.id);
  if (creditsForOriginal.length !== 1) {
    report.violation('idempotency', 'one keyed transfer wrote more than one credit on the destination account', {
      expected: `exactly one ledger entry on ${dst.id} carries ${original.id}`,
      observed: `${creditsForOriginal.length}: ${creditsForOriginal.map((e) => `${e.id}:${e.amount}`).join(' ')}`,
      requests: dstEntries.requests.slice(0, 3),
    });
  }

  // A key whose transfer was canceled must still replay that transfer: a
  // service that treats a canceled transfer as "never happened" would let a
  // retry re-create money movement the caller believed was withdrawn.
  const cancelKey = 'suite-key-canceled';
  const cancelBody = { ...body, amount: 1900 };
  const toCancel = await api.postTransfer(cancelBody, { idempotencyKey: cancelKey });
  if (expectStatus(report, 'idempotency', 'a keyed transfer for the cancel case was not created', toCancel, [201])) {
    const cancelled = await api.cancel(toCancel.json.id);
    if (expectStatus(report, 'lifecycle', 'a pending transfer could not be canceled', cancelled.entry, [200])) {
      const afterCancelReplay = await api.postTransfer(cancelBody, { idempotencyKey: cancelKey });
      if (afterCancelReplay.status === 201) {
        report.violation('idempotency', 'replaying a key after its transfer was canceled created a second transfer', {
          expected: `200 returning the canceled ${toCancel.json.id}`,
          observed: `201 ${afterCancelReplay.json?.id}`,
          requests: [toCancel, cancelled.entry, afterCancelReplay],
        });
      } else if (afterCancelReplay.status === 200 && afterCancelReplay.json?.id !== toCancel.json.id) {
        report.violation('idempotency', 'replaying a key after cancellation returned a different transfer', {
          expected: `${toCancel.json.id}`,
          observed: `${afterCancelReplay.json?.id}`,
          requests: [toCancel, cancelled.entry, afterCancelReplay],
        });
      }
    }
  }

  // Scoping is per principal: the admin token reusing the customer's key is
  // documented to be a different scope. Only advisory either way.
  const crossPrincipal = await api.postTransfer(body, { idempotencyKey: KEY, principal: 'admin' });
  if (crossPrincipal.status === 200 && crossPrincipal.json?.id === original.id) {
    report.warn(
      'idempotency key visible across principals',
      `the admin token replayed the customer token's key "${KEY}" (documented scope is per principal)`,
    );
  } else if (crossPrincipal.status === 201 && crossPrincipal.json?.id) {
    await api.cancel(crossPrincipal.json.id);
  }
}
