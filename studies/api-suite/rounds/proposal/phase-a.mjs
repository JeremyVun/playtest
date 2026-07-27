// Phase A: build real ledger state and check the rules that are only legible
// while that state is being built (settlement, lifecycle, idempotency, limits, fees).

import { ADMIN, CUST_A, CUST_B, FEE_USD, FEE_EUR, DAILY_LIMIT, expectedFee } from "./lib.mjs";

const R_FEE = "rule:fee-schedule";
const R_LEDGER = "rule:ledger-arithmetic";
const R_OWN = "rule:ownership";
const R_LIFE = "rule:lifecycle-legality";
const R_IDEM = "rule:idempotency";
const R_SETTLE = "rule:settlement";
const R_DAILY = "rule:daily-limit";

export const FEE_AMOUNTS = [1, 333, 334, 1000, 1667, 3000, 3333, 3334, 10000];

export default async function phaseA(H, S) {
  const { record, ev, get, post, d, errCode, idOf, walk, section } = H;

  // ---------------------------------------------------------------- boot ---
  await section("boot", ["operation:POST /admin/reset"], async () => {
    const reset = await post("/admin/reset", { as: ADMIN, body: { seed: "ledger-dev-seed" } });
    S.reset = reset;
    record({
      id: "reset-establishes-known-state",
      obligation: "operation:POST /admin/reset",
      title: "POST /admin/reset seeds a known world the rest of the suite starts from",
      pass: reset.status === 200 && reset.json && reset.json.ok === true && typeof reset.json.day === "number",
      expected: 'status 200 with {ok:true, seed, day}',
      observed: `${d(reset)} body=${JSON.stringify(reset.json)}`,
      evidence: ev(reset),
    });
    S.day0 = reset.json && typeof reset.json.day === "number" ? reset.json.day : null;

    const health = await get("/health");
    const openapi = await get("/openapi.json");
    H.check.advisory({
      title: "service metadata",
      detail: `GET /health ${d(health)} ok=${health.json && health.json.ok}; GET /openapi.json ${d(openapi)}`,
      evidence: ev([health, openapi]),
    });

    const anon = await get("/accounts");
    H.check.advisory({
      title: "an unauthenticated listing is refused",
      detail: `${d(anon)}; www-authenticate=${JSON.stringify(anon.headers && anon.headers["www-authenticate"])}`,
      evidence: ev(anon),
    });

    const base = await get("/accounts?limit=100", { as: ADMIN });
    S.baseline = base;
  });

  // ------------------------------------------------------------ accounts ---
  const mk = async (label, as, currency, extra) => {
    const body = { owner: label, currency, ...(extra || {}) };
    const r = await post("/accounts", { as, body });
    S.created[label] = r;
    S.acct[label] = idOf(r);
    return r;
  };

  await section("accounts", [R_OWN, R_LIFE], async () => {
    const feeSrc = await mk("feeSrc", CUST_A, "USD");
    S.principalA = feeSrc.json && feeSrc.json.owner_principal;
    record({
      id: "new-account-is-pending",
      obligation: R_LIFE,
      title: "a newly opened account is created in status 'pending' and cannot yet transact",
      pass: feeSrc.status === 201 && feeSrc.json && feeSrc.json.status === "pending" && feeSrc.json.balance === 0,
      expected: 'status 201 with account status "pending" and balance 0',
      observed: `${d(feeSrc)} status=${JSON.stringify(feeSrc.json && feeSrc.json.status)} balance=${JSON.stringify(feeSrc.json && feeSrc.json.balance)}`,
      evidence: ev(feeSrc),
    });

    await mk("feeDst", CUST_A, "USD");
    await mk("limitSrc", CUST_A, "USD");
    await mk("failSrc", CUST_A, "USD");
    await mk("idemSrc", CUST_A, "USD");
    await mk("closeAcct", CUST_A, "USD");
    await mk("pendingAcct", CUST_A, "USD");
    await mk("eurSrc", CUST_A, "EUR");
    await mk("eurDst", CUST_A, "EUR");

    const bDst = await mk("bDst", CUST_B, "USD");
    S.principalB = bDst.json && bDst.json.owner_principal;
    await mk("bSrc", CUST_B, "USD");

    record({
      id: "owner-principal-defaults-to-caller-and-differs-per-token",
      obligation: R_OWN,
      title: "each customer token owns its own principal, and the two customer tokens are different principals",
      pass:
        typeof S.principalA === "string" &&
        typeof S.principalB === "string" &&
        S.principalA.length > 0 &&
        S.principalA !== S.principalB,
      expected: "two distinct non-empty owner_principal values, one per customer token",
      observed: `A=${JSON.stringify(S.principalA)} B=${JSON.stringify(S.principalB)}`,
      evidence: ev([feeSrc, bDst]),
    });

    // Administrator may open an account for another principal; a customer may not.
    if (typeof S.principalB === "string") {
      const ob = await post("/accounts", {
        as: ADMIN,
        body: { owner: "onbehalf", currency: "USD", owner_principal: S.principalB },
      });
      S.created.obAcct = ob;
      S.acct.obAcct = idOf(ob);
      record({
        id: "admin-may-open-account-for-another-principal",
        obligation: R_OWN,
        title: "the administrator may open an account whose owner_principal is another principal",
        pass: ob.status === 201 && ob.json && ob.json.owner_principal === S.principalB,
        expected: `status 201 with owner_principal ${JSON.stringify(S.principalB)}`,
        observed: `${d(ob)} owner_principal=${JSON.stringify(ob.json && ob.json.owner_principal)}`,
        evidence: ev(ob),
      });

      const usurp = await post("/accounts", {
        as: CUST_A,
        body: { owner: "usurp", currency: "USD", owner_principal: S.principalB },
      });
      S.usurp = usurp;
      record({
        id: "customer-may-not-open-account-for-another-principal",
        obligation: R_OWN,
        title: "a customer principal supplying owner_principal is refused 403",
        pass: usurp.status === 403,
        expected: "status 403",
        observed: d(usurp),
        evidence: ev(usurp),
      });
    }

    // Activate everything that must transact; pendingAcct and obAcct stay pending.
    const toActivate = ["feeSrc", "feeDst", "limitSrc", "failSrc", "idemSrc", "closeAcct", "eurSrc", "eurDst", "bDst", "bSrc"];
    for (const label of toActivate) {
      const id = S.acct[label];
      if (!id) continue;
      const as = label.startsWith("b") ? CUST_B : CUST_A;
      S.activated[label] = await post(`/accounts/${id}/activate`, { as });
    }
    const act = S.activated.feeSrc;
    record({
      id: "activate-makes-an-account-active",
      obligation: R_LIFE,
      title: "activation moves a pending account to 'active' so that it may transact",
      pass: !!act && act.status === 200 && act.json && act.json.status === "active" && !!act.json.activated_at,
      expected: 'status 200 with status "active" and a non-null activated_at',
      observed: act ? `${d(act)} status=${JSON.stringify(act.json && act.json.status)}` : "activation never ran",
      evidence: ev([S.created.feeSrc, act]),
    });

    if (S.acct.feeSrc) {
      const again = await post(`/accounts/${S.acct.feeSrc}/activate`, { as: CUST_A });
      H.check.advisory({
        title: "re-activating an already active account",
        detail: `${d(again)} (spec documents 409 for this operation; not covered by an adjudicated card)`,
        evidence: ev(again),
      });
    }
  });

  // ------------------------------------------------------------ deposits ---
  await section("deposits", [R_LIFE, R_OWN, R_LEDGER], async () => {
    const fund = async (label, amount, as) => {
      const id = S.acct[label];
      if (!id) return null;
      const r = await post("/deposits", { as: as || (label.startsWith("b") ? CUST_B : CUST_A), body: { account_id: id, amount } });
      S.deposits.push({ label, amount, resp: r, id: idOf(r), account_id: id });
      return r;
    };
    await fund("feeSrc", 200000);
    await fund("limitSrc", 200000);
    await fund("failSrc", 60000);
    await fund("idemSrc", 100000);
    await fund("closeAcct", 1000);
    await fund("eurSrc", 100000);
    await fund("bSrc", 50000);

    const first = S.deposits[0];
    record({
      id: "deposit-settles-immediately",
      obligation: R_LEDGER,
      title: "a deposit is created already settled against the named account",
      pass:
        !!first &&
        first.resp.status === 201 &&
        first.resp.json &&
        first.resp.json.status === "settled" &&
        first.resp.json.amount === first.amount &&
        first.resp.json.account_id === first.account_id,
      expected: 'status 201, deposit status "settled", amount and account_id echoed',
      observed: first ? `${d(first.resp)} body=${JSON.stringify(first.resp.json)}` : "no deposit was created",
      evidence: ev(first && first.resp),
    });

    // Read a deposit back, as its owner and as the other customer.
    if (first && first.id) {
      const mine = await get(`/deposits/${first.id}`, { as: CUST_A });
      const theirs = await get(`/deposits/${first.id}`, { as: CUST_B });
      record({
        id: "deposit-readable-by-its-account-owner",
        obligation: R_OWN,
        title: "the owner of the funded account may read the deposit",
        pass: mine.status === 200 && mine.json && mine.json.id === first.id,
        expected: "status 200 with the deposit",
        observed: d(mine),
        evidence: ev(mine),
      });
      record({
        id: "deposit-not-readable-by-other-principal",
        obligation: R_OWN,
        title: "a customer may not read a deposit made into another principal's account",
        pass: theirs.status === 403,
        expected: "status 403",
        observed: `${d(theirs)} body=${JSON.stringify(theirs.json)}`,
        evidence: ev(theirs),
      });
    }

    // Lifecycle: a deposit naming a pending account is refused 409.
    if (S.acct.pendingAcct) {
      const r = await post("/deposits", { as: CUST_A, body: { account_id: S.acct.pendingAcct, amount: 500 } });
      S.depositIntoPending = r;
      record({
        id: "deposit-into-pending-account-refused-409",
        obligation: R_LIFE,
        title: "a deposit naming a pending account is refused 409",
        pass: r.status === 409,
        expected: "status 409",
        observed: d(r),
        evidence: ev([S.created.pendingAcct, r]),
      });
    }

    // Ownership: funding someone else's account is refused 403.
    if (S.acct.bSrc) {
      const r = await post("/deposits", { as: CUST_A, body: { account_id: S.acct.bSrc, amount: 500 } });
      record({
        id: "customer-may-not-fund-another-principals-account",
        obligation: R_OWN,
        title: "a customer may not deposit into an account it does not own",
        pass: r.status === 403,
        expected: "status 403",
        observed: `${d(r)} body=${JSON.stringify(r.json)}`,
        evidence: ev(r),
      });
    }
  });

  // -------------------------------------------- settlement: tick-only ------
  const xfer = async (key, srcLabel, dstLabel, amount, opts = {}) => {
    const src = typeof srcLabel === "string" && S.acct[srcLabel] !== undefined ? S.acct[srcLabel] : srcLabel;
    const dst = typeof dstLabel === "string" && S.acct[dstLabel] !== undefined ? S.acct[dstLabel] : dstLabel;
    if (!src || !dst) return { ref: undefined, status: -1, json: null, headers: {}, clientThrew: "prerequisite account missing" };
    const body = { source_account_id: src, destination_account_id: dst, amount };
    const r = await post("/transfers", { as: opts.as || CUST_A, body, idemKey: opts.idemKey });
    if (key) S.tx[key] = { resp: r, id: idOf(r), amount, src, dst };
    return r;
  };
  S.xfer = xfer;

  await section("settlement-basic", [R_SETTLE], async () => {
    const s1 = await xfer("S1", "idemSrc", "feeDst", 500);
    const s2 = await xfer("S2", "idemSrc", "feeDst", 600);
    const s2b = await xfer("S2B", "idemSrc", "feeDst", 650);

    record({
      id: "transfer-is-created-pending",
      obligation: R_SETTLE,
      title: "POST /transfers creates the transfer in status 'pending'",
      pass: s1.status === 201 && s1.json && s1.json.status === "pending" && s1.json.settled_at == null,
      expected: 'status 201 with transfer status "pending" and settled_at null',
      observed: `${d(s1)} status=${JSON.stringify(s1.json && s1.json.status)} settled_at=${JSON.stringify(s1.json && s1.json.settled_at)}`,
      evidence: ev(s1),
    });

    // Creation must not touch the ledger.
    const bal = await get(`/accounts/${S.acct.idemSrc}`, { as: CUST_A });
    const ents = await walk(`/accounts/${S.acct.idemSrc}/entries`, CUST_A, 100, 4);
    const txIds = [S.tx.S1 && S.tx.S1.id, S.tx.S2 && S.tx.S2.id, S.tx.S2B && S.tx.S2B.id].filter(Boolean);
    const leaked = ents.items.filter((e) => e && txIds.includes(e.transfer_id));
    record({
      id: "pending-transfer-creation-moves-no-balance",
      obligation: R_SETTLE,
      title: "creating a pending transfer does not move the source balance",
      pass: bal.status === 200 && bal.json && bal.json.balance === 100000,
      expected: "balance still 100000 (the deposited amount) while all three transfers are pending",
      observed: `${d(bal)} balance=${JSON.stringify(bal.json && bal.json.balance)}`,
      evidence: ev([S.deposits.find((x) => x.label === "idemSrc")?.resp, s1, s2, s2b, bal]),
    });
    record({
      id: "pending-transfer-creation-writes-no-entries",
      obligation: R_SETTLE,
      title: "creating a pending transfer writes no ledger entries",
      pass: leaked.length === 0,
      expected: "no ledger entry carries a still-pending transfer's transfer_id",
      observed: leaked.length === 0 ? "no entries carry any of the three pending transfer ids" : `entries ${JSON.stringify(leaked.map((e) => e.id))}`,
      evidence: ev([s1, s2, s2b, ents.pages]),
    });

    const stillPending = await get(`/transfers/${S.tx.S1 && S.tx.S1.id}`, { as: CUST_A });
    record({
      id: "transfer-does-not-settle-without-a-tick",
      obligation: R_SETTLE,
      title: "a pending transfer stays pending across unrelated requests; only a tick moves it",
      pass: stillPending.status === 200 && stillPending.json && stillPending.json.status === "pending",
      expected: 'status "pending" after several intervening non-tick requests',
      observed: `${d(stillPending)} status=${JSON.stringify(stillPending.json && stillPending.json.status)}`,
      evidence: ev([s1, bal, ents.pages[0], stillPending]),
    });

    // settle_limit bounds the tick and preserves creation order.
    const t1 = await post("/admin/tick", { as: ADMIN, body: { settle_limit: 2 } });
    S.ticks.push(t1);
    const settled = (t1.json && t1.json.settled) || [];
    const wantOrder = [S.tx.S1 && S.tx.S1.id, S.tx.S2 && S.tx.S2.id];
    record({
      id: "tick-settles-in-creation-order",
      obligation: R_SETTLE,
      title: "a bounded tick settles the oldest pending transfers first, in creation order",
      pass: JSON.stringify(settled) === JSON.stringify(wantOrder) && wantOrder.every(Boolean),
      expected: `settled == ${JSON.stringify(wantOrder)} — the first two of three transfers created, in that order`,
      observed: `${d(t1)} settled=${JSON.stringify(settled)}`,
      evidence: ev([s1, s2, s2b, t1]),
    });
    const s2read = await get(`/transfers/${S.tx.S2B && S.tx.S2B.id}`, { as: CUST_A });
    record({
      id: "settle-limit-leaves-the-rest-pending",
      obligation: R_SETTLE,
      title: "settle_limit bounds how many transfers a tick settles and leaves the rest pending",
      pass:
        t1.json &&
        t1.json.pending === 1 &&
        s2read.status === 200 &&
        s2read.json &&
        s2read.json.status === "pending",
      expected: "TickResult.pending == 1 and the newest of the three transfers still pending",
      observed: `pending=${JSON.stringify(t1.json && t1.json.pending)} S2B=${JSON.stringify(s2read.json && s2read.json.status)}`,
      evidence: ev([t1, s2read]),
    });

    const t2 = await post("/admin/tick", { as: ADMIN, body: {} });
    S.ticks.push(t2);
    const settled2 = (t2.json && t2.json.settled) || [];
    record({
      id: "an-unbounded-tick-settles-the-remaining-pending-transfer",
      obligation: R_SETTLE,
      title: "an unbounded tick settles what a bounded tick left behind",
      pass: settled2.length === 1 && S.tx.S2B && settled2[0] === S.tx.S2B.id && t2.json.pending === 0,
      expected: `settled == [${JSON.stringify(S.tx.S2B && S.tx.S2B.id)}] and pending == 0`,
      observed: `${d(t2)} settled=${JSON.stringify(settled2)} pending=${JSON.stringify(t2.json && t2.json.pending)}`,
      evidence: ev([s2b, t2]),
    });
  });

  // ------------------------------------------------------------- cancel ---
  await section("cancel", [R_SETTLE], async () => {
    const s3 = await xfer("S3", "idemSrc", "feeDst", 700);
    const cancel = await post(`/transfers/${S.tx.S3 && S.tx.S3.id}/cancel`, { as: CUST_A });
    S.cancelS3 = cancel;
    const t = await post("/admin/tick", { as: ADMIN, body: {} });
    S.ticks.push(t);
    const after = await get(`/transfers/${S.tx.S3 && S.tx.S3.id}`, { as: CUST_A });
    const settled = (t.json && t.json.settled) || [];
    const failed = (t.json && t.json.failed) || [];
    record({
      id: "canceled-transfer-is-never-picked-up-by-a-later-tick",
      obligation: R_SETTLE,
      title: "a canceled transfer stays canceled and is not settled or failed by a subsequent tick",
      pass:
        cancel.status === 200 &&
        cancel.json &&
        cancel.json.status === "canceled" &&
        !settled.includes(S.tx.S3 && S.tx.S3.id) &&
        !failed.includes(S.tx.S3 && S.tx.S3.id) &&
        after.status === 200 &&
        after.json &&
        after.json.status === "canceled",
      expected: 'cancel 200 -> "canceled"; the next tick reports it neither settled nor failed; it reads back "canceled"',
      observed: `cancel=${d(cancel)} tick.settled=${JSON.stringify(settled)} tick.failed=${JSON.stringify(failed)} read=${JSON.stringify(after.json && after.json.status)}`,
      evidence: ev([s3, cancel, t, after]),
    });

    const recancel = await post(`/transfers/${S.tx.S3 && S.tx.S3.id}/cancel`, { as: CUST_A });
    const cancelSettled = await post(`/transfers/${S.tx.S1 && S.tx.S1.id}/cancel`, { as: CUST_A });
    H.check.advisory({
      title: "cancelling a transfer that is no longer pending",
      detail: `re-cancel a canceled transfer: ${d(recancel)}; cancel a settled transfer: ${d(cancelSettled)} (spec documents 409; not covered by an adjudicated card)`,
      evidence: ev([recancel, cancelSettled]),
    });
  });

  // -------------------------------------------------------------- close ---
  await section("close", [R_LIFE], async () => {
    const id = S.acct.closeAcct;
    const s4 = await xfer("S4", "closeAcct", "feeDst", 100);
    const blocked = await post(`/accounts/${id}/close`, { as: CUST_A });
    record({
      id: "close-refused-while-a-transfer-is-pending",
      obligation: R_LIFE,
      title: "an account with pending transfers cannot be closed",
      pass: blocked.status === 409,
      expected: "status 409",
      observed: d(blocked),
      evidence: ev([s4, blocked]),
    });

    const undo = await post(`/transfers/${S.tx.S4 && S.tx.S4.id}/cancel`, { as: CUST_A });
    const closed = await post(`/accounts/${id}/close`, { as: CUST_A });
    S.closeResp = closed;
    record({
      id: "close-succeeds-once-nothing-is-pending",
      obligation: R_LIFE,
      title: "an account with no pending transfers closes and reports status 'closed'",
      pass: closed.status === 200 && closed.json && closed.json.status === "closed" && !!closed.json.closed_at,
      expected: 'status 200 with status "closed" and a non-null closed_at',
      observed: `${d(closed)} status=${JSON.stringify(closed.json && closed.json.status)}`,
      evidence: ev([undo, closed]),
    });

    const tomb = await get(`/accounts/${id}`, { as: CUST_A });
    record({
      id: "closed-account-read-answers-410-with-a-tombstone",
      obligation: R_LIFE,
      title: "GET /accounts/{accountId} on a closed account answers 410 with a tombstone",
      pass: tomb.status === 410 && !!tomb.json && !!tomb.json.error && !!tomb.json.error.details,
      expected: "status 410 with error.details carrying the tombstone",
      observed: `${d(tomb)} details=${JSON.stringify(tomb.json && tomb.json.error && tomb.json.error.details)}`,
      evidence: ev(tomb),
    });

    const hist = await walk(`/accounts/${id}/entries`, CUST_A, 100, 4);
    const dep = S.deposits.find((x) => x.label === "closeAcct");
    record({
      id: "closed-account-keeps-serving-its-ledger-history",
      obligation: R_LIFE,
      title: "a closed account's ledger history is still served after closure",
      pass:
        hist.pages.length > 0 &&
        hist.pages[0].status === 200 &&
        hist.items.length === 1 &&
        hist.items[0] &&
        hist.items[0].amount === 1000 &&
        hist.items[0].kind === "deposit",
      expected: "status 200 listing the single +1000 deposit entry written before closure",
      observed: `${d(hist.pages[0])} items=${JSON.stringify(hist.items.map((e) => e && [e.kind, e.amount]))}`,
      evidence: ev([dep && dep.resp, closed, hist.pages]),
    });

    const listDefault = await walk("/accounts", ADMIN, 100, 4);
    const listAll = await walk("/accounts?include_closed=true", ADMIN, 100, 4);
    record({
      id: "closed-account-omitted-from-the-default-listing",
      obligation: R_LIFE,
      title: "GET /accounts omits a closed account unless include_closed=true",
      pass: !listDefault.ids.includes(id) && listAll.ids.includes(id),
      expected: `${id} absent from GET /accounts and present with include_closed=true`,
      observed: `default=${listDefault.ids.includes(id) ? "present" : "absent"} include_closed=${listAll.ids.includes(id) ? "present" : "absent"}`,
      evidence: ev([listDefault.pages, listAll.pages]),
    });

    const depClosed = await post("/deposits", { as: CUST_A, body: { account_id: id, amount: 100 } });
    const sendClosed = await xfer(null, "closeAcct", "feeDst", 100);
    const recvClosed = await xfer(null, "feeSrc", "closeAcct", 100);
    record({
      id: "closed-account-cannot-transact",
      obligation: R_LIFE,
      title: "a deposit or transfer naming a closed account is refused 410",
      pass: depClosed.status === 410 && sendClosed.status === 410 && recvClosed.status === 410,
      expected: "410 for a deposit into it, for sending from it, and for receiving into it",
      observed: `deposit=${d(depClosed)} source=${d(sendClosed)} destination=${d(recvClosed)}`,
      evidence: ev([depClosed, sendClosed, recvClosed]),
    });

    const reclose = await post(`/accounts/${id}/close`, { as: CUST_A });
    H.check.advisory({
      title: "closing an already closed account",
      detail: `${d(reclose)} (spec documents 410; not covered by an adjudicated card)`,
      evidence: ev(reclose),
    });
  });

  // --------------------------------------------------- pending legality ---
  await section("pending-legality", [R_LIFE], async () => {
    const recv = await xfer(null, "feeSrc", "pendingAcct", 100);
    const send = await xfer(null, "pendingAcct", "feeDst", 100);
    record({
      id: "pending-account-cannot-receive-a-transfer",
      obligation: R_LIFE,
      title: "a transfer naming a pending account as destination is refused 409",
      pass: recv.status === 409,
      expected: "status 409",
      observed: `${d(recv)}`,
      evidence: ev([S.created.pendingAcct, recv]),
    });
    record({
      id: "pending-account-cannot-send-a-transfer",
      obligation: R_LIFE,
      title: "a transfer naming a pending account as source is refused 409",
      pass: send.status === 409,
      expected: "status 409 (state is evaluated before the funding rule)",
      observed: `${d(send)}`,
      evidence: ev([S.created.pendingAcct, send]),
    });
  });

  // -------------------------------- settlement re-check + daily allowance ---
  await section("settlement-failure", [R_SETTLE, R_DAILY], async () => {
    const f1 = await xfer("F1", "failSrc", "feeDst", 50000);
    const f2 = await xfer("F2", "failSrc", "feeDst", 50000);
    const t = await post("/admin/tick", { as: ADMIN, body: {} });
    S.ticks.push(t);
    const settled = (t.json && t.json.settled) || [];
    const failed = (t.json && t.json.failed) || [];
    const f2read = await get(`/transfers/${S.tx.F2 && S.tx.F2.id}`, { as: CUST_A });
    const bal = await get(`/accounts/${S.acct.failSrc}`, { as: CUST_A });

    record({
      id: "settlement-rechecks-funds-and-fails-the-uncovered-transfer",
      obligation: R_SETTLE,
      title: "a tick re-checks amount+fee at settlement time and fails a transfer the source can no longer cover",
      pass:
        settled.includes(S.tx.F1 && S.tx.F1.id) &&
        failed.includes(S.tx.F2 && S.tx.F2.id) &&
        f2read.json &&
        f2read.json.status === "failed",
      expected: `both created against a 60000 balance; the first (needs 50100) settles, the second (needs 50100 against 9900) fails`,
      observed: `${d(t)} settled=${JSON.stringify(settled)} failed=${JSON.stringify(failed)} F2=${JSON.stringify(f2read.json && f2read.json.status)}`,
      evidence: ev([f1, f2, t, f2read]),
    });
    record({
      id: "failed-transfer-carries-a-failure-reason",
      obligation: R_SETTLE,
      title: "a transfer failed at settlement carries a failure_reason",
      pass: !!(f2read.json && typeof f2read.json.failure_reason === "string" && f2read.json.failure_reason.length > 0),
      expected: "a non-empty failure_reason string",
      observed: `failure_reason=${JSON.stringify(f2read.json && f2read.json.failure_reason)}`,
      evidence: ev(f2read),
    });
    record({
      id: "failed-transfer-moves-no-money",
      obligation: R_SETTLE,
      title: "only the settled transfer moved money out of the source account",
      pass: bal.status === 200 && bal.json && bal.json.balance === 60000 - (50000 + expectedFee(50000)),
      expected: `balance ${60000 - (50000 + expectedFee(50000))} (60000 less the one settled amount+fee)`,
      observed: `${d(bal)} balance=${JSON.stringify(bal.json && bal.json.balance)}`,
      evidence: ev([f1, f2, t, bal]),
    });

    // The two creations reserved 100000 of allowance; the failure must not release it.
    const after = await xfer(null, "failSrc", "feeDst", 1);
    record({
      id: "daily-allowance-not-released-by-a-failed-settlement",
      obligation: R_DAILY,
      title: "a transfer that fails at settlement does not return its amount to the daily allowance",
      pass: after.status === 422 && errCode(after) === "daily_limit_exceeded",
      expected: 'status 422 with code "daily_limit_exceeded" (2 x 50000 already reserved, funds are ample)',
      observed: `${d(after)}`,
      evidence: ev([f1, f2, t, bal, after]),
    });
  });

  // -------------------------------------------------------- daily limit ---
  await section("daily-limit", [R_DAILY, R_OWN], async () => {
    const l1 = await xfer("L1", "limitSrc", "feeDst", 60000);
    const over = await xfer(null, "limitSrc", "feeDst", 40001);
    const l3 = await xfer("L3", "limitSrc", "feeDst", 40000);
    const past = await xfer(null, "limitSrc", "feeDst", 1);

    record({
      id: "daily-limit-refuses-an-amount-that-would-exceed-it",
      obligation: R_DAILY,
      title: "a transfer that would take the source past 100 000 in the ledger day is refused 422 daily_limit_exceeded",
      pass: l1.status === 201 && over.status === 422 && errCode(over) === "daily_limit_exceeded",
      expected: '60000 accepted, then 40001 (total 100001) refused 422 "daily_limit_exceeded"',
      observed: `60000=${d(l1)} 40001=${d(over)}`,
      evidence: ev([l1, over]),
    });
    record({
      id: "daily-limit-accepts-exactly-reaching-the-limit",
      obligation: R_DAILY,
      title: "an amount that brings the day's total exactly to 100 000 is accepted",
      pass: l3.status === 201 && past.status === 422 && errCode(past) === "daily_limit_exceeded",
      expected: "40000 accepted (total exactly 100000), then a further 1 refused 422",
      observed: `40000=${d(l3)} then 1=${d(past)}`,
      evidence: ev([l1, l3, past]),
    });
    record({
      id: "daily-limit-measures-amount-only-not-amount-plus-fee",
      obligation: R_DAILY,
      title: "the allowance is consumed by amount alone: 60000+40000 fits although amount+fee totals 100200",
      pass: l1.status === 201 && l3.status === 201,
      expected: `both accepted even though the balance was debited ${60000 + expectedFee(60000) + 40000 + expectedFee(40000)} in total`,
      observed: `60000=${d(l1)} 40000=${d(l3)}`,
      evidence: ev([l1, l3]),
    });

    // Ownership: the other customer may not cancel this principal's pending transfer.
    if (S.tx.L1 && S.tx.L1.id) {
      const foreign = await post(`/transfers/${S.tx.L1.id}/cancel`, { as: CUST_B });
      record({
        id: "customer-may-not-cancel-another-principals-transfer",
        obligation: R_OWN,
        title: "a customer may not cancel a transfer between accounts it does not own",
        pass: foreign.status === 403,
        expected: "status 403",
        observed: `${d(foreign)} body=${JSON.stringify(foreign.json)}`,
        evidence: ev([l1, foreign]),
      });
    }

    const cancelL3 = await post(`/transfers/${S.tx.L3 && S.tx.L3.id}/cancel`, { as: CUST_A });
    const afterCancel = await xfer(null, "limitSrc", "feeDst", 1);
    record({
      id: "daily-allowance-not-released-by-cancelling",
      obligation: R_DAILY,
      title: "cancelling a transfer does not return its amount to the daily allowance",
      pass:
        cancelL3.status === 200 &&
        cancelL3.json &&
        cancelL3.json.status === "canceled" &&
        afterCancel.status === 422 &&
        errCode(afterCancel) === "daily_limit_exceeded",
      expected: 'the 40000 transfer cancels, and a further 1 is still refused 422 "daily_limit_exceeded"',
      observed: `cancel=${d(cancelL3)} then 1=${d(afterCancel)}`,
      evidence: ev([l3, cancelL3, afterCancel]),
    });

    const other = await xfer("PERACCT", "idemSrc", "feeDst", 1);
    record({
      id: "daily-limit-is-scoped-to-the-source-account",
      obligation: R_DAILY,
      title: "one account reaching its daily limit does not block another account of the same principal",
      pass: other.status === 201,
      expected: "status 201 from a different source account owned by the same principal",
      observed: d(other),
      evidence: ev([past, other]),
    });
  });

  // ------------------------------------------------------- fee schedule ---
  await section("fees", [R_FEE], async () => {
    for (const amount of FEE_AMOUNTS) {
      const r = await xfer(`FEE${amount}`, "feeSrc", "feeDst", amount);
      const want = expectedFee(amount);
      record({
        id: `fee-formula-usd-${amount}`,
        obligation: R_FEE,
        title: `USD transfer of ${amount} minor units is charged a fee of ${want}`,
        pass: r.status === 201 && r.json && r.json.fee === want && r.json.amount === amount,
        expected: `fee ${want} = 25 + round_half_away_from_zero(${amount} x 15 / 10000)`,
        observed: `${d(r)} amount=${JSON.stringify(r.json && r.json.amount)} fee=${JSON.stringify(r.json && r.json.fee)}`,
        evidence: ev(r),
      });
    }
    const cross = await xfer("ATOB", "feeSrc", "bDst", 2000);
    record({
      id: "transfer-destination-need-not-belong-to-the-caller",
      obligation: "rule:ownership",
      title: "a customer may send to an account owned by another principal",
      pass: cross.status === 201 && cross.json && cross.json.fee === expectedFee(2000),
      expected: `status 201 with fee ${expectedFee(2000)}`,
      observed: d(cross),
      evidence: ev(cross),
    });

    for (const amount of [1000, 20000]) {
      const r = await xfer(`EUR${amount}`, "eurSrc", "eurDst", amount);
      const want = expectedFee(amount);
      record({
        id: `fee-formula-eur-${amount}`,
        obligation: R_FEE,
        title: `EUR transfer of ${amount} minor units is charged a fee of ${want} and routed to the EUR fee account`,
        pass:
          r.status === 201 &&
          r.json &&
          r.json.fee === want &&
          r.json.currency === "EUR" &&
          r.json.fee_account_id === FEE_EUR,
        expected: `fee ${want}, currency EUR, fee_account_id ${FEE_EUR}`,
        observed: `${d(r)} fee=${JSON.stringify(r.json && r.json.fee)} fee_account_id=${JSON.stringify(r.json && r.json.fee_account_id)}`,
        evidence: ev(r),
      });
    }

    const usd = Object.keys(S.tx)
      .filter((k) => k.startsWith("FEE") || k === "ATOB")
      .map((k) => S.tx[k].resp)
      .filter((r) => r && r.json && r.json.currency === "USD");
    const misrouted = usd.filter((r) => r.json.fee_account_id !== FEE_USD);
    record({
      id: "usd-transfer-fees-are-routed-to-the-usd-fee-account",
      obligation: R_FEE,
      title: "every USD transfer names the USD system fee account as its fee account",
      pass: usd.length > 0 && misrouted.length === 0,
      expected: `every USD transfer carries fee_account_id ${FEE_USD}`,
      observed:
        usd.length === 0
          ? "no USD transfer was created"
          : `${usd.length} USD transfers, ${misrouted.length} misrouted: ${JSON.stringify(misrouted.map((r) => r.json.fee_account_id))}`,
      evidence: ev(usd),
    });
  });

  // -------------------------------------------------------- idempotency ---
  await section("idempotency", [R_IDEM], async () => {
    const KEY = "trial-key-alpha";
    const before = await walk(`/transfers?account_id=${S.acct.idemSrc}`, CUST_A, 100, 4);
    const first = await xfer("IDEM", "idemSrc", "feeDst", 1000, { idemKey: KEY });
    const replay = await post("/transfers", {
      as: CUST_A,
      idemKey: KEY,
      body: { source_account_id: S.acct.idemSrc, destination_account_id: S.acct.feeDst, amount: 1000 },
    });
    const conflict = await post("/transfers", {
      as: CUST_A,
      idemKey: KEY,
      body: { source_account_id: S.acct.idemSrc, destination_account_id: S.acct.feeDst, amount: 1234 },
    });
    const bOwn = await post("/transfers", {
      as: CUST_B,
      idemKey: KEY,
      body: { source_account_id: S.acct.bSrc, destination_account_id: S.acct.bDst, amount: 700 },
    });
    S.tx.BOWN = { resp: bOwn, id: (bOwn.json && bOwn.json.id) || null, amount: 700 };
    const after = await walk(`/transfers?account_id=${S.acct.idemSrc}`, CUST_A, 100, 4);

    record({
      id: "idempotent-replay-returns-the-first-transfer-with-200",
      obligation: R_IDEM,
      title: "the same key with the same body answers 200 with the transfer the first request created",
      pass:
        first.status === 201 &&
        replay.status === 200 &&
        replay.json &&
        S.tx.IDEM &&
        replay.json.id === S.tx.IDEM.id,
      expected: `201 then 200 returning ${JSON.stringify(S.tx.IDEM && S.tx.IDEM.id)}`,
      observed: `first=${d(first)} id=${JSON.stringify(S.tx.IDEM && S.tx.IDEM.id)}; replay=${d(replay)} id=${JSON.stringify(replay.json && replay.json.id)}`,
      evidence: ev([first, replay]),
    });
    record({
      id: "idempotent-replay-creates-no-second-transfer",
      obligation: R_IDEM,
      title: "a replay and a conflicting reuse of the key add exactly one transfer to the source account",
      pass: after.ids.length === before.ids.length + 1,
      expected: `exactly one new transfer for the account (was ${before.ids.length})`,
      observed: `before=${before.ids.length} after=${after.ids.length}`,
      evidence: ev([before.pages, first, replay, conflict, after.pages]),
    });
    record({
      id: "idempotency-key-with-a-different-body-is-refused-409",
      obligation: R_IDEM,
      title: "reusing the key with a different body is refused 409 and creates nothing",
      pass: conflict.status === 409 && !after.ids.includes(conflict.json && conflict.json.id),
      expected: "status 409 and no additional transfer",
      observed: `${d(conflict)}`,
      evidence: ev([conflict, after.pages]),
    });
    record({
      id: "idempotency-is-scoped-per-principal",
      obligation: R_IDEM,
      title: "the same key string used by a different principal creates that principal's own transfer",
      pass:
        bOwn.status === 201 &&
        bOwn.json &&
        S.tx.IDEM &&
        bOwn.json.id !== S.tx.IDEM.id &&
        bOwn.json.amount === 700,
      expected: "status 201 with a distinct transfer of 700 for the second customer",
      observed: `${d(bOwn)} id=${JSON.stringify(bOwn.json && bOwn.json.id)} amount=${JSON.stringify(bOwn.json && bOwn.json.amount)}`,
      evidence: ev([first, bOwn]),
    });
    H.check.advisory({
      title: "Idempotency-Replayed header on the replay",
      detail: `header=${JSON.stringify(replay.headers && replay.headers["idempotency-replayed"])}`,
      evidence: ev(replay),
    });
  });

  // -------------------------------------------- settle everything, roll day ---
  await section("settle-all", [R_SETTLE, R_DAILY], async () => {
    const big = await post("/admin/tick", { as: ADMIN, body: {} });
    S.ticks.push(big);
    const settled = (big.json && big.json.settled) || [];
    const canceledId = S.tx.L3 && S.tx.L3.id;
    record({
      id: "tick-settles-every-remaining-pending-transfer",
      obligation: R_SETTLE,
      title: "an unbounded tick settles all pending transfers and leaves none behind",
      pass: big.status === 200 && big.json && big.json.pending === 0 && settled.length > 0,
      expected: "status 200 with pending 0 and a non-empty settled list",
      observed: `${d(big)} settled=${settled.length} failed=${((big.json && big.json.failed) || []).length} pending=${JSON.stringify(big.json && big.json.pending)}`,
      evidence: ev(big),
    });
    record({
      id: "canceled-transfer-excluded-from-the-final-tick",
      obligation: R_SETTLE,
      title: "the transfer canceled during the daily-limit sequence is not settled by a later tick",
      pass: !!canceledId && !settled.includes(canceledId),
      expected: `${JSON.stringify(canceledId)} absent from the tick's settled list`,
      observed: settled.includes(canceledId) ? "it was settled" : "absent, as required",
      evidence: ev(big),
    });

    const dayBefore = big.json && big.json.day;
    const roll = await post("/admin/tick", { as: ADMIN, body: { advance_day: true } });
    S.ticks.push(roll);
    record({
      id: "advance-day-rolls-the-ledger-day",
      obligation: R_DAILY,
      title: "POST /admin/tick with advance_day rolls the ledger day forward",
      pass: roll.status === 200 && roll.json && typeof dayBefore === "number" && roll.json.day === dayBefore + 1,
      expected: `day ${typeof dayBefore === "number" ? dayBefore + 1 : "previous + 1"}`,
      observed: `${d(roll)} day ${JSON.stringify(dayBefore)} -> ${JSON.stringify(roll.json && roll.json.day)}`,
      evidence: ev([big, roll]),
    });

    const fresh = await xfer("NEWDAY", "limitSrc", "feeDst", 1);
    record({
      id: "daily-allowance-resets-on-a-new-ledger-day",
      obligation: R_DAILY,
      title: "the source account that exhausted its allowance may transfer again after the day rolls over",
      pass: fresh.status === 201,
      expected: "status 201 from the account that was refused 422 before the roll",
      observed: d(fresh),
      evidence: ev([roll, fresh]),
    });

    const last = await post("/admin/tick", { as: ADMIN, body: {} });
    S.ticks.push(last);
    S.quiescent = last.status === 200 && last.json && last.json.pending === 0;
  });
}
