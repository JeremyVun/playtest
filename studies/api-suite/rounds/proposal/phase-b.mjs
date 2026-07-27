// Phase B: read-only passes over the settled world — ownership reach,
// ledger arithmetic and fee routing, then quiescent pagination.

import { ADMIN, CUST_A, CUST_B, FEE_USD, FEE_EUR, expectedFee } from "./lib.mjs";

const R_FEE = "rule:fee-schedule";
const R_LEDGER = "rule:ledger-arithmetic";
const R_OWN = "rule:ownership";
const R_PAGE = "rule:pagination-completeness";

const looksLikeAccount = (text) =>
  typeof text === "string" &&
  (text.includes('"balance"') || text.includes('"owner_principal"') || text.includes('"activated_at"'));

export default async function phaseB(H, S) {
  const { record, ev, get, post, d, walk, section, dupes, setDiff } = H;

  // ---------------------------------------------------------- ownership ---
  await section("ownership", [R_OWN], async () => {
    const mine = await get(`/accounts/${S.acct.feeSrc}`, { as: CUST_A });
    record({
      id: "customer-reads-its-own-account",
      obligation: R_OWN,
      title: "a customer may read an account whose owner_principal is that principal",
      pass: mine.status === 200 && mine.json && mine.json.owner_principal === S.principalA,
      expected: `status 200 with owner_principal ${JSON.stringify(S.principalA)}`,
      observed: `${d(mine)} owner_principal=${JSON.stringify(mine.json && mine.json.owner_principal)}`,
      evidence: ev(mine),
    });

    const foreignRead = await get(`/accounts/${S.acct.bSrc}`, { as: CUST_A });
    record({
      id: "customer-cannot-read-another-principals-account",
      obligation: R_OWN,
      title: "reading another principal's account is refused 403 with no representation of it",
      pass: foreignRead.status === 403 && !looksLikeAccount(foreignRead.text),
      expected: "status 403 and a body carrying no account representation",
      observed: `${d(foreignRead)} body=${JSON.stringify(foreignRead.text || "").slice(0, 200)}`,
      evidence: ev(foreignRead),
    });

    const foreignEntries = await get(`/accounts/${S.acct.bSrc}/entries`, { as: CUST_A });
    const foreignActivate = await post(`/accounts/${S.acct.bDst}/activate`, { as: CUST_A });
    const foreignClose = await post(`/accounts/${S.acct.bSrc}/close`, { as: CUST_A });
    const foreignSpend = await post("/transfers", {
      as: CUST_A,
      body: { source_account_id: S.acct.bSrc, destination_account_id: S.acct.feeDst, amount: 100 },
    });
    record({
      id: "customer-cannot-act-on-another-principals-account",
      obligation: R_OWN,
      title: "listing entries of, activating, closing, or spending from another principal's account is refused 403",
      pass:
        foreignEntries.status === 403 &&
        foreignActivate.status === 403 &&
        foreignClose.status === 403 &&
        foreignSpend.status === 403,
      expected: "403 for entries, activate, close, and transfer-from",
      observed: `entries=${d(foreignEntries)} activate=${d(foreignActivate)} close=${d(foreignClose)} spend=${d(foreignSpend)}`,
      evidence: ev([foreignEntries, foreignActivate, foreignClose, foreignSpend]),
    });

    if (S.acct.obAcct) {
      const asB = await get(`/accounts/${S.acct.obAcct}`, { as: CUST_B });
      const asA = await get(`/accounts/${S.acct.obAcct}`, { as: CUST_A });
      record({
        id: "owner-principal-assignment-decides-reach",
        obligation: R_OWN,
        title: "an account the administrator opened for the second customer is reachable by that customer and by nobody else",
        pass: asB.status === 200 && asA.status === 403,
        expected: "200 for the named owner_principal, 403 for the other customer",
        observed: `asB=${d(asB)} asA=${d(asA)}`,
        evidence: ev([S.created.obAcct, asB, asA]),
      });
    }

    const unknownAsCustomer = await get("/accounts/acc_zzz_absent", { as: CUST_A });
    record({
      id: "unknown-account-is-404-not-403",
      obligation: R_OWN,
      title: "existence is resolved before ownership: an unknown account id answers 404",
      pass: unknownAsCustomer.status === 404,
      expected: "status 404",
      observed: d(unknownAsCustomer),
      evidence: ev(unknownAsCustomer),
    });

    const feeAsA = await get(`/accounts/${FEE_USD}`, { as: CUST_A });
    const feeAsB = await get(`/accounts/${FEE_EUR}`, { as: CUST_B });
    const feeEntriesAsB = await get(`/accounts/${FEE_USD}/entries?limit=5`, { as: CUST_B });
    record({
      id: "system-fee-accounts-are-readable-by-every-principal",
      obligation: R_OWN,
      title: "the system fee accounts and their entries are readable by any customer",
      pass:
        feeAsA.status === 200 &&
        feeAsB.status === 200 &&
        feeEntriesAsB.status === 200 &&
        feeEntriesAsB.json &&
        Array.isArray(feeEntriesAsB.json.items),
      expected: "200 for both fee accounts and for the USD fee account's entries",
      observed: `usdAsA=${d(feeAsA)} eurAsB=${d(feeAsB)} usdEntriesAsB=${d(feeEntriesAsB)}`,
      evidence: ev([feeAsA, feeAsB, feeEntriesAsB]),
    });

    const adminReadsA = await get(`/accounts/${S.acct.feeSrc}`, { as: ADMIN });
    const adminReadsB = await get(`/accounts/${S.acct.bSrc}`, { as: ADMIN });
    record({
      id: "administrator-is-unrestricted",
      obligation: R_OWN,
      title: "the administrator reaches accounts of both customer principals",
      pass: adminReadsA.status === 200 && adminReadsB.status === 200,
      expected: "200 for an account of each customer principal",
      observed: `A=${d(adminReadsA)} B=${d(adminReadsB)}`,
      evidence: ev([adminReadsA, adminReadsB]),
    });

    const cross = S.tx.ATOB;
    if (cross && cross.id) {
      const bySource = await get(`/transfers/${cross.id}`, { as: CUST_A });
      const byDest = await get(`/transfers/${cross.id}`, { as: CUST_B });
      const payerAcct = await get(`/accounts/${S.acct.feeSrc}`, { as: CUST_B });
      record({
        id: "transfer-is-readable-by-the-owner-of-either-side",
        obligation: R_OWN,
        title: "a transfer is visible to both principals, without exposing the payer's account to the payee",
        pass: bySource.status === 200 && byDest.status === 200 && payerAcct.status === 403,
        expected: "200 for the source owner, 200 for the destination owner, 403 when the payee reads the payer's account",
        observed: `source=${d(bySource)} dest=${d(byDest)} payerAccount=${d(payerAcct)}`,
        evidence: ev([bySource, byDest, payerAcct]),
      });
    }
  });

  // -------------------------------------- ledger arithmetic + fee routing ---
  await section("verify", [R_LEDGER, R_FEE], async () => {
    const all = await walk("/transfers", ADMIN, 100, 6);
    const transfers = all.items.filter(Boolean);
    S.transfers = transfers;

    const labels = [
      "feeSrc",
      "feeDst",
      "limitSrc",
      "failSrc",
      "idemSrc",
      "eurSrc",
      "eurDst",
      "bDst",
      "bSrc",
      "pendingAcct",
      "obAcct",
    ];
    const targets = [];
    for (const label of labels) if (S.acct[label]) targets.push({ label, id: S.acct[label] });
    targets.push({ label: "acc_fee_usd", id: FEE_USD }, { label: "acc_fee_eur", id: FEE_EUR });

    const entries = [];
    const evidenceByAccount = {};
    for (const t of targets) {
      const acct = await get(`/accounts/${t.id}`, { as: ADMIN });
      const w = await walk(`/accounts/${t.id}/entries`, ADMIN, 100, 6);
      evidenceByAccount[t.label] = [acct, ...w.pages];
      for (const e of w.items) if (e) entries.push(e);
      const sum = w.items.reduce((a, e) => a + (e && typeof e.amount === "number" ? e.amount : NaN), 0);
      const balance = acct.json && acct.json.balance;
      record({
        id: `balance-agrees-with-entries-${t.label}`,
        obligation: R_LEDGER,
        title: `${t.label}: the stored balance equals the sum of its ledger entries`,
        pass: acct.status === 200 && w.terminated && balance === sum,
        expected: `balance == sum of ${w.items.length} entry amounts`,
        observed: `${d(acct)} balance=${JSON.stringify(balance)} sum=${JSON.stringify(sum)} entries=${w.items.length}${w.terminated ? "" : " (enumeration did not terminate)"}`,
        evidence: ev(evidenceByAccount[t.label], { account: t.id }),
      });
    }

    // Entries carried over from the closed account, which has no readable balance.
    if (S.acct.closeAcct) {
      const w = await walk(`/accounts/${S.acct.closeAcct}/entries`, ADMIN, 100, 4);
      for (const e of w.items) if (e) entries.push(e);
      evidenceByAccount.closeAcct = w.pages;
    }
    S.allEntries = entries;

    const byTransfer = new Map();
    for (const e of entries) {
      if (!e.transfer_id) continue;
      if (!byTransfer.has(e.transfer_id)) byTransfer.set(e.transfer_id, []);
      byTransfer.get(e.transfer_id).push(e);
    }

    const settled = transfers.filter((t) => t.status === "settled");
    const badShape = [];
    const badDebit = [];
    const badCredit = [];
    const badFee = [];
    for (const t of settled) {
      const es = byTransfer.get(t.id) || [];
      const sum = es.reduce((a, e) => a + e.amount, 0);
      if (es.length !== 3 || sum !== 0) badShape.push({ id: t.id, n: es.length, sum });
      const debit = es.find((e) => e.account_id === t.source_account_id && e.kind === "transfer_debit");
      const credit = es.find((e) => e.account_id === t.destination_account_id && e.kind === "transfer_credit");
      const fee = es.find((e) => e.kind === "fee");
      if (!debit || debit.amount !== -(t.amount + t.fee)) {
        badDebit.push({ id: t.id, want: -(t.amount + t.fee), got: debit ? debit.amount : null });
      }
      if (!credit || credit.amount !== t.amount) {
        badCredit.push({ id: t.id, want: t.amount, got: credit ? credit.amount : null });
      }
      const wantFeeAcct = t.currency === "EUR" ? FEE_EUR : FEE_USD;
      if (!fee || fee.amount !== t.fee || fee.account_id !== wantFeeAcct || fee.account_id !== t.fee_account_id) {
        badFee.push({ id: t.id, want: [wantFeeAcct, t.fee], got: fee ? [fee.account_id, fee.amount] : null });
      }
    }

    const allEv = ev(
      [].concat(...Object.values(evidenceByAccount)).slice(0, 40).concat(all.pages),
      { settled_transfers: settled.length }
    );

    record({
      id: "settled-transfer-has-exactly-three-entries-summing-to-zero",
      obligation: R_LEDGER,
      title: "every settled transfer's ledger entries are exactly three and sum to zero",
      pass: settled.length > 0 && badShape.length === 0,
      expected: `three entries summing to 0 for each of the ${settled.length} settled transfers`,
      observed: badShape.length === 0 ? `all ${settled.length} settled transfers conserve` : JSON.stringify(badShape.slice(0, 6)),
      evidence: allEv,
    });
    record({
      id: "settled-destination-is-credited-the-amount",
      obligation: R_LEDGER,
      title: "the destination account of a settled transfer is credited exactly the amount",
      pass: settled.length > 0 && badCredit.length === 0,
      expected: "a transfer_credit of +amount on the destination account",
      observed: badCredit.length === 0 ? "every destination credit matches" : JSON.stringify(badCredit.slice(0, 6)),
      evidence: allEv,
    });
    record({
      id: "settled-source-is-debited-amount-plus-fee",
      obligation: R_FEE,
      title: "the source account is debited amount + fee, never just the amount",
      pass: settled.length > 0 && badDebit.length === 0,
      expected: "a transfer_debit of -(amount + fee) on the source account",
      observed: badDebit.length === 0 ? "every source debit carries the fee" : JSON.stringify(badDebit.slice(0, 6)),
      evidence: allEv,
    });
    record({
      id: "settlement-fee-entry-credits-the-currencys-fee-account",
      obligation: R_FEE,
      title: "the fee is credited to the system fee account for the transfer's own currency",
      pass: settled.length > 0 && badFee.length === 0,
      expected: `a fee entry of +fee on ${FEE_USD} for USD and ${FEE_EUR} for EUR`,
      observed: badFee.length === 0 ? "every fee entry is routed and valued correctly" : JSON.stringify(badFee.slice(0, 6)),
      evidence: allEv,
    });

    // The fee schedule, recomputed from the persisted transfers rather than from creation responses.
    const wrongFee = transfers.filter((t) => t.fee !== expectedFee(t.amount));
    record({
      id: "persisted-transfers-all-match-the-fee-formula",
      obligation: R_FEE,
      title: "every transfer the service persisted carries the scheduled fee for its amount",
      pass: transfers.length > 0 && wrongFee.length === 0,
      expected: `fee == 25 + round_half_away_from_zero(amount x 15 / 10000) for all ${transfers.length} transfers`,
      observed:
        wrongFee.length === 0
          ? `all ${transfers.length} persisted transfers match`
          : JSON.stringify(wrongFee.slice(0, 6).map((t) => ({ id: t.id, amount: t.amount, fee: t.fee, want: expectedFee(t.amount) }))),
      evidence: ev(all.pages),
    });

    // Fee-account balances are exactly the settled fees of that currency.
    for (const [feeAcct, currency] of [[FEE_USD, "USD"], [FEE_EUR, "EUR"]]) {
      const want = settled.filter((t) => t.currency === currency).reduce((a, t) => a + t.fee, 0);
      const feeEntries = entries.filter((e) => e.account_id === feeAcct);
      const got = feeEntries.reduce((a, e) => a + e.amount, 0);
      record({
        id: `fee-account-collects-exactly-the-scheduled-fees-${currency.toLowerCase()}`,
        obligation: R_FEE,
        title: `${feeAcct} holds exactly the sum of the fees of the settled ${currency} transfers`,
        pass: got === want && feeEntries.every((e) => e.kind === "fee" && e.amount > 0),
        expected: `sum of fee entries == ${want}`,
        observed: `sum=${got} over ${feeEntries.length} entries, kinds=${JSON.stringify([...new Set(feeEntries.map((e) => e.kind))])}`,
        evidence: ev(evidenceByAccount[feeAcct === FEE_USD ? "acc_fee_usd" : "acc_fee_eur"]),
      });
    }

    // Deposits: one entry each, no counter-entry, no fee.
    const badDeposits = [];
    for (const dep of S.deposits) {
      if (!dep.id) continue;
      const es = entries.filter((e) => e.deposit_id === dep.id);
      if (es.length !== 1 || es[0].kind !== "deposit" || es[0].amount !== dep.amount || es[0].account_id !== dep.account_id) {
        badDeposits.push({ id: dep.id, want: dep.amount, got: es.map((e) => [e.kind, e.amount]) });
      }
    }
    record({
      id: "deposit-writes-one-entry-and-carries-no-fee",
      obligation: R_FEE,
      title: "a deposit writes a single +amount entry with no counter-entry and no fee",
      pass: S.deposits.length > 0 && badDeposits.length === 0,
      expected: `exactly one 'deposit' entry of +amount per deposit, and no fee entry naming a deposit`,
      observed: badDeposits.length === 0 ? `all ${S.deposits.filter((x) => x.id).length} deposits match` : JSON.stringify(badDeposits.slice(0, 6)),
      evidence: ev([S.deposits.map((x) => x.resp), evidenceByAccount.feeSrc]),
    });

    // Canceled and failed transfers move nothing.
    const dead = transfers.filter((t) => t.status === "canceled" || t.status === "failed");
    const withEntries = dead.filter((t) => (byTransfer.get(t.id) || []).length > 0);
    record({
      id: "canceled-and-failed-transfers-write-no-entries",
      obligation: R_LEDGER,
      title: "a transfer ending canceled or failed writes no ledger entries and moves nothing",
      pass: dead.length > 0 && withEntries.length === 0,
      expected: `no entries for any of the ${dead.length} canceled/failed transfers`,
      observed:
        dead.length === 0
          ? "no canceled or failed transfer existed to check"
          : withEntries.length === 0
            ? `all ${dead.length} moved nothing`
            : JSON.stringify(withEntries.map((t) => t.id)),
      evidence: allEv,
    });

    // Idempotent replay produced exactly one set of effects.
    const idem = S.tx.IDEM && S.tx.IDEM.id;
    const idemEntries = idem ? byTransfer.get(idem) || [] : [];
    record({
      id: "idempotent-replay-produced-exactly-one-set-of-ledger-effects",
      obligation: "rule:idempotency",
      title: "the replayed transfer settled once, with a single three-entry effect",
      pass: !!idem && idemEntries.length === 3 && idemEntries.reduce((a, e) => a + e.amount, 0) === 0,
      expected: "exactly three entries for the replayed transfer id",
      observed: idem ? `${idemEntries.length} entries for ${idem}` : "the idempotent transfer was never created",
      evidence: allEv,
    });
  });

  // --------------------------------------------------------- pagination ---
  await section("pagination", [R_PAGE], async () => {
    const collections = [
      { name: "accounts", path: "/accounts?include_closed=true", as: ADMIN, sizes: [1, 3] },
      { name: "transfers", path: "/transfers", as: ADMIN, sizes: [1, 7] },
      { name: "entries", path: `/accounts/${FEE_USD}/entries`, as: ADMIN, sizes: [1, 5] },
    ];
    for (const c of collections) {
      const base = await walk(c.path, c.as, 100, 6);
      const baseIds = base.ids.filter(Boolean);
      for (const size of c.sizes) {
        const cap = Math.min(baseIds.length + 5, 60);
        const w = await walk(c.path, c.as, size, cap);
        const ids = w.ids.filter(Boolean);
        const missing = setDiff(baseIds, ids);
        const extra = setDiff(ids, baseIds);
        const dup = dupes(ids);
        record({
          id: `pagination-complete-${c.name}-page-size-${size}`,
          obligation: R_PAGE,
          title: `walking ${c.path} at page size ${size} returns every item present at the start of the walk, exactly once`,
          pass: w.terminated && missing.length === 0 && extra.length === 0 && dup.length === 0,
          expected: `the same ${baseIds.length} ids as the page-size-100 walk of the same quiescent collection, no duplicates, terminating`,
          observed: `pages=${w.pages.length} returned=${ids.length} missing=${JSON.stringify(missing.slice(0, 8))} unexpected=${JSON.stringify(extra.slice(0, 8))} duplicated=${JSON.stringify(dup.slice(0, 8))}${w.terminated ? "" : " (walk hit the page cap without a null cursor)"}`,
          evidence: ev([base.pages, w.pages].flat().slice(0, 60), { baseline: baseIds.length }),
        });
      }
    }
  });

  // ------------------------------------------------------------ hostile ---
  // Everything here is expected to be refused and therefore to write nothing;
  // it runs last so that a success would not corrupt any earlier evidence.
  await section("hostile", [R_OWN], async () => {
    const custTick = await post("/admin/tick", { as: CUST_A, body: {} });
    const custReset = await post("/admin/reset", { as: CUST_B, body: { seed: "hostile" } });
    record({
      id: "admin-routes-are-refused-to-customers",
      obligation: R_OWN,
      title: "only the administrator may call /admin/*",
      pass: custTick.status === 403 && custReset.status === 403,
      expected: "403 for POST /admin/tick and POST /admin/reset under a customer token",
      observed: `tick=${d(custTick)} reset=${d(custReset)}`,
      evidence: ev([custTick, custReset]),
    });

    const custCloseFee = await post(`/accounts/${FEE_USD}/close`, { as: CUST_A });
    const custSpendFee = await post("/transfers", {
      as: CUST_A,
      body: { source_account_id: FEE_USD, destination_account_id: S.acct.feeDst, amount: 100 },
    });
    const adminSpendFee = await post("/transfers", {
      as: ADMIN,
      body: { source_account_id: FEE_USD, destination_account_id: S.acct.feeDst, amount: 100 },
    });
    record({
      id: "system-fee-accounts-are-not-actable-by-customers",
      obligation: R_OWN,
      title: "the system fee accounts are readable by every customer but may not be closed or spent from by one",
      pass: custCloseFee.status === 403 && custSpendFee.status === 403,
      expected: "403 when a customer closes a fee account and 403 when a customer spends from one",
      observed: `customerClose=${d(custCloseFee)} customerSpend=${d(custSpendFee)}`,
      evidence: ev([custCloseFee, custSpendFee]),
    });
    // The card's applicability sentence scopes it to customer principals and says
    // the administrator is unrestricted, so an administrator spending from a fee
    // account is outside what this suite may assert. Recorded, not gated.
    H.check.advisory({
      title: "the administrator can spend from a system fee account",
      detail:
        `POST /transfers with source_account_id=${FEE_USD} under the admin token answered ${d(adminSpendFee)}. ` +
        `The ownership card's exception says the fee accounts are "actable by none", but its applicability sentence ` +
        `scopes the card to customer principals and states the administrator is unrestricted, so this is not gated here. ` +
        `See TRANSCRIPT.md.`,
      evidence: ev(adminSpendFee),
    });
  });
}
