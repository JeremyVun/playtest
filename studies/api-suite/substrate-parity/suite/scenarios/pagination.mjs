// Rule 4. The enumerate() helper already fails on a repeated id or a
// non-terminating cursor chain, so this scenario's job is to build the states
// where a cursor bug actually shows: an account deep enough to need many
// pages, page sizes of 1 (every boundary is a page boundary), a page size that
// exactly divides the entry count, writes landing in the middle of a walk, and
// the fee account, which is the one account that collects entries from every
// transfer in the whole suite.

export const name = 'pagination';

export async function run({ api, report }) {
  const a = (await api.createAccount('p-a', 'USD')).account;
  const b = (await api.createAccount('p-b', 'USD')).account;
  await api.activate(a.id);
  await api.activate(b.id);

  // Nine entries: enough for many pages, and 9 = 3 x 3 so limit=3 ends exactly
  // on a page boundary (the classic off-by-one in "is there a next page").
  for (let i = 0; i < 9; i++) await api.deposit(a.id, 1000 + i);

  const reference = await api.entries(a.id, { limit: 100 });
  const refIds = reference.items.map((e) => e.id);
  if (new Set(refIds).size !== refIds.length) {
    report.violation('pagination', 'a single page repeated an entry id', {
      expected: 'ids are unique inside one page',
      observed: refIds.join(' '),
      requests: reference.requests,
    });
  }
  const refSet = new Set(refIds);

  for (const limit of [1, 3, 4]) {
    const walk = await api.entries(a.id, { limit });
    const ids = walk.items.map((e) => e.id);
    if (walk.pages < Math.ceil(refIds.length / limit)) {
      report.warn(
        'short enumeration',
        `limit=${limit} over ${refIds.length} entries terminated after ${walk.pages} page(s) with ${ids.length} entries (skips are permitted, so this is not a violation)`,
      );
    }
    const strays = ids.filter((id) => !refSet.has(id));
    if (strays.length) {
      report.warn('unexpected entry', `limit=${limit} walk returned ids the single-page read did not: ${strays.join(' ')}`);
    }
    // Newest-first ordering is what makes "older than the cursor" safe; if it
    // is violated the enumeration can hand the same row back later.
    for (let i = 1; i < walk.items.length; i++) {
      const prev = walk.items[i - 1];
      const cur = walk.items[i];
      if (Number.isInteger(prev.sequence) && Number.isInteger(cur.sequence) && cur.sequence >= prev.sequence) {
        report.violation('pagination', 'a cursor enumeration was not strictly newest-first', {
          dedupe: `limit=${limit}`,
          expected: 'entries come back in strictly decreasing sequence order',
          observed: `${prev.id}(seq ${prev.sequence}) then ${cur.id}(seq ${cur.sequence}) at limit=${limit}`,
          requests: walk.requests.slice(0, 4),
          note: 'out-of-order pages are how the same row gets returned twice',
        });
        break;
      }
    }
  }

  // Writes landing between pages. The declared exception allows the new rows
  // to be missed; it does not allow an already-returned row to come back.
  let writes = 0;
  const interleaved = await api.entries(a.id, {
    limit: 2,
    between: async () => {
      if (writes < 3) {
        writes += 1;
        await api.deposit(a.id, 500 + writes);
      }
    },
  });
  const interleavedIds = interleaved.items.map((e) => e.id);
  if (new Set(interleavedIds).size !== interleavedIds.length) {
    report.violation('pagination', 'an entry was returned twice by an enumeration that had writes interleaved', {
      expected: 'concurrent writes may be missed but never duplicated',
      observed: interleavedIds.join(' '),
      requests: interleaved.requests.slice(0, 6),
    });
  }

  // Two transfers settling in the same tick put two entries on the destination
  // and two on the fee account with adjacent timestamps — the state where a
  // timestamp-keyed cursor loses.
  await api.transfer(a.id, b.id, 700);
  await api.transfer(a.id, b.id, 800);
  await api.tick({});
  await api.entries(b.id, { limit: 1 });
  await api.entries('acc_fee_usd', { limit: 2 });

  // Settlement landing in the middle of a walk: three entries appear at once,
  // one of them on the account being enumerated. They may be missed; they may
  // not displace or repeat a row already handed over.
  await api.transfer(a.id, b.id, 900);
  let ticked = false;
  const acrossTick = await api.entries(a.id, {
    limit: 3,
    between: async () => {
      if (!ticked) {
        ticked = true;
        await api.tick({});
      }
    },
  });
  const acrossIds = acrossTick.items.map((e) => e.id);
  if (new Set(acrossIds).size !== acrossIds.length) {
    report.violation('pagination', 'an entry was returned twice by an enumeration that a settlement ran through', {
      expected: 'entries written by the tick may be missed, but no already-returned entry comes back',
      observed: acrossIds.join(' '),
      requests: acrossTick.requests.slice(0, 6),
    });
  }

  // Default page size (no limit parameter at all) must behave like any other.
  await api.entries(a.id, {});

  // A soft-deleted account keeps serving its history, so it must paginate too.
  const gone = (await api.createAccount('p-closed', 'USD')).account;
  await api.activate(gone.id);
  await api.deposit(gone.id, 300);
  await api.deposit(gone.id, 400);
  const closeGone = await api.close(gone.id);
  if (closeGone.entry.status === 200) {
    const walk = await api.entries(gone.id, { limit: 1 });
    if (walk.items.length !== 2) {
      report.warn(
        'closed account history',
        `${gone.id} was funded twice before closure but a limit=1 walk returned ${walk.items.length} entries`,
      );
    }
  }
}
