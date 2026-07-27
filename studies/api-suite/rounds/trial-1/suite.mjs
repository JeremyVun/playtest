/**
 * Minibank ledger — script suite.
 *
 * Tries to prove the thirteen invariant statements in handout/INVARIANTS.md wrong
 * by driving real state: create, activate, fund, transfer, settle, fail, cancel,
 * close, paginate — in both currencies, at boundaries, across three principals.
 *
 * Every obligation in handout/obligations.json is covered by an exercised check
 * (rules) or by recorded traffic (operations, policies).
 */

export default async function suite({ client, check }) {
  // ---------------------------------------------------------------- plumbing
  const ADMIN = () => ({ authorization: client.secret("LEDGER_ADMIN_TOKEN") });
  const CA = () => ({ authorization: client.secret("LEDGER_CUSTOMER_TOKEN") });
  const CB = () => ({ authorization: client.secret("LEDGER_CUSTOMER_B_TOKEN") });
  const SEED = "ledger-dev-seed";
  const FEE_USD = "acc_fee_usd";
  const FEE_EUR = "acc_fee_eur";
  const DAILY_LIMIT = 100000;

  /** every exchange the suite makes, for the end-of-run error-envelope sweep */
  const all = [];

  async function req(method, path, opts = {}) {
    const r = await client.request(method, path, opts);
    all.push(r);
    return r;
  }
  const GET = (p, h) => req("GET", p, { headers: h });
  const POST = (p, body, h) => req("POST", p, body === undefined ? { headers: h } : { body, headers: h });

  /** evidence refs, defensively — never cite something that cannot resolve */
  const ev = (...rs) => {
    const out = [];
    for (const r of rs.flat()) {
      if (r && typeof r.ref === "number" && Number.isInteger(r.ref) && r.ref >= 0) out.push(r.ref);
    }
    return out;
  };
  const arr = (x) => (Array.isArray(x) ? x : []);
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  const shape = (r) =>
    r ? `${r.status}${r.transportError ? " transport:" + r.transportError : ""} ${JSON.stringify(r.json ?? r.text ?? null)?.slice(0, 240)}` : "no response";

  /** fee = 25 + round_half_up(amount * 15 / 10000), exact integer arithmetic */
  const feeFor = (a) => 25 + Math.floor((30 * a + 10000) / 20000);

  const sum = (xs) => xs.reduce((t, x) => t + (Number.isInteger(x) ? x : NaN), 0);

  /** field-for-field difference, treating an omitted field and null as the same answer */
  function resourceDiff(a, b) {
    if (!a || typeof a !== "object" || !b || typeof b !== "object") return ["one side is not a JSON object"];
    const out = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[k] === undefined ? null : a[k];
      const y = b[k] === undefined ? null : b[k];
      if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${k}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
    }
    return out;
  }

  /** {"error":{"code","message","details"?}} and nothing else */
  function envelopeProblem(r) {
    if (r.parseError) return "body did not parse as JSON";
    const j = r.json;
    if (!j || typeof j !== "object" || Array.isArray(j)) return `body is not a JSON object (${JSON.stringify(r.text ?? null)?.slice(0, 120)})`;
    const top = Object.keys(j);
    if (top.length !== 1 || top[0] !== "error") return `top-level keys are ${JSON.stringify(top)}, expected exactly ["error"]`;
    const e = j.error;
    if (!e || typeof e !== "object" || Array.isArray(e)) return "error is not an object";
    if (typeof e.code !== "string") return `error.code is ${JSON.stringify(e.code)}, expected a string`;
    if (typeof e.message !== "string") return `error.message is ${JSON.stringify(e.message)}, expected a string`;
    const extra = Object.keys(e).filter((k) => k !== "code" && k !== "message" && k !== "details");
    if (extra.length) return `error carries undocumented keys ${JSON.stringify(extra)}`;
    if ("details" in e && (typeof e.details !== "object" || e.details === null || Array.isArray(e.details))) return "error.details is not an object";
    return null;
  }

  /**
   * One cursor enumeration: start without a cursor, follow next_cursor.
   * Returns the pages, the items, and every page-discipline problem observed.
   */
  async function enumerate(base, limit, headers, maxPages = 25) {
    const pages = [];
    const items = [];
    const ids = new Set();
    const problems = [];
    let cursor = null;
    for (let page = 1; ; page++) {
      if (page > maxPages) {
        problems.push(`enumeration did not terminate within ${maxPages} pages`);
        break;
      }
      const sep = base.includes("?") ? "&" : "?";
      const url = `${base}${sep}limit=${limit}` + (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      const r = await GET(url, headers);
      pages.push(r);
      if (!r.ok) {
        problems.push(`page ${page} answered ${shape(r)}`);
        break;
      }
      const its = Array.isArray(r.json?.items) ? r.json.items : null;
      if (its === null) {
        problems.push(`page ${page} carries no items array`);
        break;
      }
      if (its.length > limit) problems.push(`page ${page} carried ${its.length} items for limit=${limit}`);
      const nc = r.json?.next_cursor === undefined ? null : r.json.next_cursor;
      if (its.length < limit && nc !== null) problems.push(`page ${page} was short (${its.length} < ${limit}) but claimed next_cursor=${JSON.stringify(nc)}`);
      for (const it of its) {
        const id = it?.id;
        if (ids.has(id)) problems.push(`item ${JSON.stringify(id)} was returned twice`);
        ids.add(id);
        items.push(it);
      }
      if (nc === null) break;
      if (typeof nc !== "string") {
        problems.push(`next_cursor on page ${page} is ${JSON.stringify(nc)}, neither a string nor null`);
        break;
      }
      cursor = nc;
    }
    return { pages, items, ids, problems };
  }

  async function phase(name, obligation, fn) {
    try {
      await fn();
    } catch (e) {
      check({
        id: `phase-${name}-aborted`,
        obligation,
        title: `phase "${name}" ran to completion`,
        pass: false,
        expected: "the phase drives its sequence to the end",
        observed: `it aborted: ${e?.name}: ${e?.message}`,
        evidence: { requests: ev(all.slice(-3)) },
      });
    }
  }

  // The canonical prelude, replayed after a second reset to test determinism.
  async function prelude() {
    const a = await POST("/accounts", { owner: "det-source", currency: "USD" }, CA());
    const act = await POST(`/accounts/${a.json?.id}/activate`, undefined, CA());
    const dep = await POST("/deposits", { account_id: a.json?.id, amount: 5000 }, CA());
    const b = await POST("/accounts", { owner: "det-dest", currency: "USD" }, CB());
    const bact = await POST(`/accounts/${b.json?.id}/activate`, undefined, CB());
    const tr = await POST(
      "/transfers",
      { source_account_id: a.json?.id, destination_account_id: b.json?.id, amount: 1000 },
      CA()
    );
    return { a, act, dep, b, bact, tr };
  }

  // ---------------------------------------------------------- state handles
  const S = {};

  // =========================================================================
  // Phase 0 — reset to a known state, meta endpoints, the seeded world
  // =========================================================================
  const reset1 = await POST("/admin/reset", { seed: SEED }, ADMIN());
  const health = await GET("/health");
  const live = await GET("/openapi.json");
  const seeded = await GET("/accounts?limit=100&include_closed=true", ADMIN());

  await phase("meta", "rule:round-trip-consistency-and-determinism", async () => {
    const seedIds = arr(seeded.json?.items).map((a) => a?.id);
    check({
      id: "reset-restores-the-seeded-world",
      obligation: "rule:round-trip-consistency-and-determinism",
      title: "POST /admin/reset returns ok/seed/day and leaves exactly the two system fee accounts at day 0",
      pass:
        reset1.status === 200 &&
        reset1.json?.ok === true &&
        reset1.json?.seed === SEED &&
        reset1.json?.day === 0 &&
        seeded.status === 200 &&
        seedIds.length === 2 &&
        seedIds.includes(FEE_USD) &&
        seedIds.includes(FEE_EUR),
      expected: `200 {ok:true,seed:"${SEED}",day:0} and a world holding exactly [${FEE_USD}, ${FEE_EUR}]`,
      observed: `${shape(reset1)} / world=${JSON.stringify(seedIds)}`,
      evidence: { requests: ev(reset1, seeded) },
    });

    const feeDoc = obj(live.json?.["x-ledger-fee-schedule"]);
    const limDoc = obj(live.json?.["x-ledger-limits"]);
    check({
      id: "fee-schedule-document-agrees-with-the-stated-rule",
      obligation: "rule:the-fee-schedule",
      title: "the live document states the same one schedule the invariant states (25 flat + 15bp, one table for both currencies)",
      pass:
        live.status === 200 &&
        feeDoc.flat === 25 &&
        feeDoc.basis_points === 15 &&
        limDoc.daily_transfer_limit === DAILY_LIMIT &&
        obj(limDoc.fee_accounts).USD === FEE_USD &&
        obj(limDoc.fee_accounts).EUR === FEE_EUR,
      expected: `flat 25, 15 bp, daily limit ${DAILY_LIMIT}, fee accounts USD=${FEE_USD} EUR=${FEE_EUR}`,
      observed: `${JSON.stringify(feeDoc)} / ${JSON.stringify(limDoc)}`,
      evidence: { requests: ev(live) },
    });

    check({
      id: "health-answers-without-a-credential",
      obligation: "rule:error-shape-and-the-status-split-three-rules",
      title: "GET /health is declared with empty security and answers 200 without a credential (no 401 for an unauthenticated operation)",
      pass: health.status === 200 && health.json?.ok === true && typeof health.json?.service === "string",
      expected: "200 {ok:true, service:<string>}",
      observed: shape(health),
      evidence: { requests: ev(health) },
    });
  });

  // =========================================================================
  // Phase 1 — the determinism prelude (replayed at the very end)
  // =========================================================================
  const first = await prelude();
  S.detA = first.a.json?.id;
  S.detB = first.b.json?.id;
  const principalA = first.a.json?.owner_principal;
  const principalB = first.b.json?.owner_principal;

  // =========================================================================
  // Phase 2 — build the world
  // =========================================================================
  const mk = async (owner, currency, who) => POST("/accounts", { owner, currency }, who);

  const aUSDc = await mk("ada", "USD", CA());
  S.aUSD = aUSDc.json?.id;
  const aUSDact = await POST(`/accounts/${S.aUSD}/activate`, undefined, CA());
  const aUSDdep = await POST("/deposits", { account_id: S.aUSD, amount: 400000 }, CA());

  const a2c = await mk("ada-second", "USD", CA());
  S.a2USD = a2c.json?.id;
  await POST(`/accounts/${S.a2USD}/activate`, undefined, CA());

  const bUSDc = await mk("bob", "USD", CB());
  S.bUSD = bUSDc.json?.id;
  await POST(`/accounts/${S.bUSD}/activate`, undefined, CB());
  await POST("/deposits", { account_id: S.bUSD, amount: 50000 }, CB());

  const aEURc = await mk("ada-eur", "EUR", CA());
  S.aEUR = aEURc.json?.id;
  await POST(`/accounts/${S.aEUR}/activate`, undefined, CA());
  await POST("/deposits", { account_id: S.aEUR, amount: 200000 }, CA());

  const bEURc = await mk("bob-eur", "EUR", CB());
  S.bEUR = bEURc.json?.id;
  await POST(`/accounts/${S.bEUR}/activate`, undefined, CB());

  const limc = await mk("lim", "USD", CA());
  S.lim = limc.json?.id;
  await POST(`/accounts/${S.lim}/activate`, undefined, CA());
  await POST("/deposits", { account_id: S.lim, amount: 400000 }, CA());

  const setc = await mk("settle", "USD", CA());
  S.set = setc.json?.id;
  await POST(`/accounts/${S.set}/activate`, undefined, CA());
  const setDep = await POST("/deposits", { account_id: S.set, amount: 10000 }, CA());

  const pendc = await mk("never-activated", "USD", CA()); // stays pending for the whole run
  S.pend = pendc.json?.id;

  const closedc = await mk("to-be-closed", "USD", CA());
  S.closed = closedc.json?.id;
  await POST(`/accounts/${S.closed}/activate`, undefined, CA());
  const closedClose = await POST(`/accounts/${S.closed}/close`, undefined, CA());

  const behalf = await POST("/accounts", { owner: "opened-for-b", currency: "USD", owner_principal: principalB }, ADMIN());
  S.behalf = behalf.json?.id;

  await phase("world", "rule:lifecycle-legality", async () => {
    check({
      id: "lifecycle-new-account-is-pending-then-active",
      obligation: "rule:lifecycle-legality",
      title: "an account is created 'pending' with a zero balance and becomes 'active' only via activate",
      pass:
        aUSDc.status === 201 &&
        aUSDc.json?.status === "pending" &&
        aUSDc.json?.balance === 0 &&
        aUSDc.json?.activated_at == null &&
        aUSDact.status === 200 &&
        aUSDact.json?.status === "active" &&
        typeof aUSDact.json?.activated_at === "string",
      expected: "201 pending/balance 0/activated_at null, then 200 active with activated_at set",
      observed: `${shape(aUSDc)} then ${shape(aUSDact)}`,
      evidence: { requests: ev(aUSDc, aUSDact) },
    });

    check({
      id: "ownership-only-admin-opens-an-account-for-another-principal",
      obligation: "rule:ownership",
      title: "the administrator may set owner_principal on someone else's behalf and the account belongs to that principal",
      pass:
        behalf.status === 201 &&
        behalf.json?.owner_principal === principalB &&
        typeof principalA === "string" &&
        typeof principalB === "string" &&
        principalA !== principalB,
      expected: `201 with owner_principal ${JSON.stringify(principalB)}, distinct from ${JSON.stringify(principalA)}`,
      observed: shape(behalf),
      evidence: { requests: ev(behalf, first.a, first.b) },
    });
  });

  // =========================================================================
  // Phase 3 — the fee schedule, at rounding boundaries, in both currencies
  // =========================================================================
  const feeProbes = [];
  await phase("fee-schedule", "rule:the-fee-schedule", async () => {
    const usdAmounts = [1, 333, 334, 1000, 3000, 10000]; // 333/334 straddle the 0.5 cent point; 1000 and 3000 land exactly on .5
    const eurAmounts = [1, 1000, 66667]; // same schedule must apply to the other currency, including at scale
    for (const amount of usdAmounts) {
      const r = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.bUSD, amount }, CA());
      feeProbes.push({ amount, currency: "USD", r });
    }
    for (const amount of eurAmounts) {
      const r = await POST("/transfers", { source_account_id: S.aEUR, destination_account_id: S.bEUR, amount }, CA());
      feeProbes.push({ amount, currency: "EUR", r });
    }
    for (const p of feeProbes) {
      const want = feeFor(p.amount);
      check({
        id: `fee-declared-${p.currency.toLowerCase()}-${p.amount}`,
        obligation: "rule:the-fee-schedule",
        title: `a ${p.currency} transfer of ${p.amount} declares fee ${want} = 25 + round_half_up(${p.amount}*15/10000)`,
        pass: p.r.status === 201 && p.r.json?.fee === want && p.r.json?.currency === p.currency && p.r.json?.amount === p.amount,
        expected: `201 with fee ${want}, amount ${p.amount}, currency ${p.currency}`,
        observed: shape(p.r),
        evidence: { requests: ev(p.r) },
      });
    }
    const feeAcctWrong = feeProbes.filter(
      (p) => p.r.json?.fee_account_id !== (p.currency === "USD" ? FEE_USD : FEE_EUR)
    );
    check({
      id: "refint-fee-account-is-the-currency-system-account",
      obligation: "rule:reference-integrity",
      title: "every transfer's fee_account_id is the system fee account of the transfer's own currency",
      pass: feeProbes.length > 0 && feeAcctWrong.length === 0,
      expected: `USD transfers name ${FEE_USD}, EUR transfers name ${FEE_EUR}`,
      observed: feeAcctWrong.length
        ? feeAcctWrong.map((p) => `${p.currency}/${p.amount} -> ${JSON.stringify(p.r.json?.fee_account_id)}`).join("; ")
        : "every transfer named the fee account of its own currency",
      evidence: { requests: ev(feeProbes.map((p) => p.r)) },
    });
  });

  // =========================================================================
  // Phase 4 — lifecycle legality
  // =========================================================================
  await phase("lifecycle", "rule:lifecycle-legality", async () => {
    const fromPending = await POST("/transfers", { source_account_id: S.pend, destination_account_id: S.bUSD, amount: 100 }, CA());
    const toPending = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.behalf, amount: 100 }, CA());
    check({
      id: "lifecycle-transfer-refused-on-a-never-activated-account",
      obligation: "rule:lifecycle-legality",
      title: "a transfer naming a never-activated account is rejected on either side (409, the state refusal)",
      pass: fromPending.status === 409 && toPending.status === 409,
      expected: "409 whether the pending account is the source or the destination",
      observed: `source-pending ${shape(fromPending)} | destination-pending ${shape(toPending)}`,
      evidence: { requests: ev(fromPending, toPending, pendc, behalf) },
    });

    const fromClosed = await POST("/transfers", { source_account_id: S.closed, destination_account_id: S.bUSD, amount: 100 }, CA());
    const toClosed = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.closed, amount: 100 }, CA());
    check({
      id: "lifecycle-transfer-refused-on-a-closed-account",
      obligation: "rule:lifecycle-legality",
      title: "a transfer naming a closed account is rejected on either side (410, the tombstone refusal)",
      pass: fromClosed.status === 410 && toClosed.status === 410,
      expected: "410 whether the closed account is the source or the destination",
      observed: `source-closed ${shape(fromClosed)} | destination-closed ${shape(toClosed)}`,
      evidence: { requests: ev(closedClose, fromClosed, toClosed) },
    });

    const depPending = await POST("/deposits", { account_id: S.pend, amount: 1000 }, CA());
    const depClosed = await POST("/deposits", { account_id: S.closed, amount: 1000 }, CA());
    check({
      id: "lifecycle-deposit-refused-into-a-non-active-account",
      obligation: "rule:lifecycle-legality",
      title: "a deposit into an account that is not active is rejected — 409 while pending, 410 once closed",
      pass: depPending.status === 409 && depClosed.status === 410,
      expected: "409 for the pending account, 410 for the closed one",
      observed: `pending ${shape(depPending)} | closed ${shape(depClosed)}`,
      evidence: { requests: ev(depPending, depClosed) },
    });

    const reactivate = await POST(`/accounts/${S.closed}/activate`, undefined, CA());
    const reclose = await POST(`/accounts/${S.closed}/close`, undefined, CA());
    const readClosed = await GET(`/accounts/${S.closed}`, CA());
    const closedListing = await GET("/accounts?limit=100&include_closed=true", ADMIN());
    const stillClosed = arr(closedListing.json?.items).find((a) => a?.id === S.closed);
    check({
      id: "lifecycle-closure-is-terminal",
      obligation: "rule:lifecycle-legality",
      title: "a closed account is never activated, reopened, or brought back to any other state",
      pass:
        reactivate.status === 410 &&
        reclose.status === 410 &&
        readClosed.status === 410 &&
        stillClosed?.status === "closed" &&
        typeof stillClosed?.closed_at === "string",
      expected: "410 on activate, 410 on close, 410 on read, and the account still listed with status 'closed'",
      observed: `activate ${shape(reactivate)} | close ${shape(reclose)} | read ${shape(readClosed)} | listed=${JSON.stringify(stillClosed)}`,
      evidence: { requests: ev(reactivate, reclose, readClosed, closedListing) },
    });

    const tomb = obj(readClosed.json?.error?.details);
    check({
      id: "status-410-carries-the-tombstone",
      obligation: "rule:error-shape-and-the-status-split-three-rules",
      title: "reading a closed account is 410 and the details carry the tombstone",
      pass: readClosed.status === 410 && tomb.id === S.closed && tomb.status === "closed" && typeof tomb.closed_at === "string",
      expected: `410 with details naming ${S.closed}, status 'closed' and a closed_at`,
      observed: shape(readClosed),
      evidence: { requests: ev(readClosed) },
    });

    const closedEntries = await GET(`/accounts/${S.closed}/entries?limit=100`, CA());
    check({
      id: "lifecycle-closed-account-still-serves-its-history",
      obligation: "rule:lifecycle-legality",
      title: "closure is a soft delete: the closed account still serves its ledger history (documented behaviour, not a counterexample)",
      pass: closedEntries.status === 200 && Array.isArray(closedEntries.json?.items),
      expected: "200 with an items array",
      observed: shape(closedEntries),
      evidence: { requests: ev(closedEntries) },
    });

    // an account with a pending transfer against it — sending or receiving — cannot be closed
    const closeSender = await POST(`/accounts/${S.aUSD}/close`, undefined, CA());
    const closeReceiver = await POST(`/accounts/${S.bUSD}/close`, undefined, CB());
    check({
      id: "lifecycle-cannot-close-an-account-with-pending-transfers",
      obligation: "rule:lifecycle-legality",
      title: "an account with a pending transfer against it cannot be closed, whether it is sending or receiving",
      pass: closeSender.status === 409 && closeReceiver.status === 409,
      expected: "409 for the pending sender and 409 for the pending receiver",
      observed: `sender ${shape(closeSender)} | receiver ${shape(closeReceiver)}`,
      evidence: { requests: ev(closeSender, closeReceiver) },
    });
    const senderAfter = await GET(`/accounts/${S.aUSD}`, CA());
    check({
      id: "lifecycle-refused-close-left-the-account-alone",
      obligation: "rule:lifecycle-legality",
      title: "a refused close does not half-close the account",
      pass: senderAfter.status === 200 && senderAfter.json?.status === "active" && senderAfter.json?.closed_at == null,
      expected: "200, status 'active', closed_at null",
      observed: shape(senderAfter),
      evidence: { requests: ev(closeSender, senderAfter) },
    });

    const reactivateActive = await POST(`/accounts/${S.aUSD}/activate`, undefined, CA());
    check.advisory({
      title: "activating an already-active account",
      detail: `POST /accounts/{id}/activate on an active account answered ${shape(reactivateActive)}. The invariant statement only makes closure terminal, so this is recorded rather than judged.`,
      evidence: { requests: ev(reactivateActive) },
    });
  });

  // =========================================================================
  // Phase 5 — ownership, across three principals
  // =========================================================================
  let aToA2 = null;
  await phase("ownership", "rule:ownership", async () => {
    // a transfer between two accounts that both belong to A: B is party to neither side
    aToA2 = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.a2USD, amount: 200 }, CA());

    const readAcct = await GET(`/accounts/${S.aUSD}`, CB());
    const readEntries = await GET(`/accounts/${S.aUSD}/entries`, CB());
    const doActivate = await POST(`/accounts/${S.pend}/activate`, undefined, CB());
    const doClose = await POST(`/accounts/${S.aUSD}/close`, undefined, CB());
    const doFund = await POST("/deposits", { account_id: S.aUSD, amount: 1000 }, CB());
    const doSpend = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.bUSD, amount: 100 }, CB());
    const doCancel = await POST(`/transfers/${aToA2.json?.id}/cancel`, undefined, CB());
    const readDeposit = await GET(`/deposits/${aUSDdep.json?.id}`, CB());
    const readTransfer = await GET(`/transfers/${aToA2.json?.id}`, CB());

    const reaches = [
      ["read the account", readAcct],
      ["read its entries", readEntries],
      ["activate it", doActivate],
      ["close it", doClose],
      ["fund it", doFund],
      ["spend from it", doSpend],
      ["cancel a transfer that spends from it", doCancel],
      ["read a deposit into it", readDeposit],
      ["read a transfer neither of whose sides it owns", readTransfer],
    ];
    const notRefused = reaches.filter(([, r]) => r.status !== 403);
    check({
      id: "ownership-a-customer-cannot-reach-another-customers-account",
      obligation: "rule:ownership",
      title: "reading, funding, activating, closing, spending from, or cancelling against another principal's account is refused 403",
      pass: notRefused.length === 0,
      expected: "403 on all nine reaches",
      observed: notRefused.length ? notRefused.map(([w, r]) => `${w}: ${shape(r)}`).join(" | ") : "all nine were refused 403",
      evidence: { requests: ev(reaches.map(([, r]) => r)) },
    });

    // "no part of that account's state comes back with the refusal"
    const leaky = reaches
      .map(([w, r]) => {
        const body = JSON.stringify(r.json ?? r.text ?? null);
        const e = obj(obj(r.json).error);
        const d = obj(e.details);
        const fields = ["owner", "owner_principal", "balance", "currency", "kind", "created_at", "activated_at", "status"].filter((f) => f in d);
        // the id is the thing the caller asked about, not state; anything else is state
        return fields.length ? `${w}: details leak ${JSON.stringify(fields)} (${body.slice(0, 160)})` : null;
      })
      .filter(Boolean);
    check({
      id: "ownership-a-refusal-discloses-no-state",
      obligation: "rule:ownership",
      title: "no part of the refused account's state comes back with the 403",
      pass: leaky.length === 0,
      expected: "the error carries at most the identifier the caller supplied",
      observed: leaky.length ? leaky.join(" | ") : "no owner, balance, currency, kind, status or timestamp came back",
      evidence: { requests: ev(reaches.map(([, r]) => r)) },
    });

    const bAccounts = await GET("/accounts?limit=100&include_closed=true", CB());
    const strangers = arr(bAccounts.json?.items).filter(
      (a) => a?.owner_principal !== principalB && a?.id !== FEE_USD && a?.id !== FEE_EUR
    );
    check({
      id: "ownership-account-collections-are-scoped-to-the-principal",
      obligation: "rule:ownership",
      title: "GET /accounts shows a customer only its own accounts, plus the two public system fee accounts",
      pass: bAccounts.status === 200 && arr(bAccounts.json?.items).length > 0 && strangers.length === 0,
      expected: `every item is owned by ${JSON.stringify(principalB)} or is a system fee account`,
      observed: strangers.length
        ? `leaked ${JSON.stringify(strangers.map((a) => `${a?.id}/${a?.owner_principal}`))}`
        : `${arr(bAccounts.json?.items).length} items, all of them B's own or public`,
      evidence: { requests: ev(bAccounts) },
    });

    const bTransfers = await GET("/transfers?limit=100", CB());
    const bSeesPrivate = arr(bTransfers.json?.items).some((t) => t?.id === aToA2.json?.id);
    const bFiltered = await GET(`/transfers?account_id=${S.aUSD}&limit=100`, CB());
    const bFilteredSeesPrivate = arr(bFiltered.json?.items).some((t) => t?.id === aToA2.json?.id);
    const bFilteredOutsiders = arr(bFiltered.json?.items).filter(
      (t) => t?.source_account_id !== S.bUSD && t?.destination_account_id !== S.bUSD && t?.source_account_id !== S.bEUR && t?.destination_account_id !== S.bEUR && t?.source_account_id !== S.behalf && t?.destination_account_id !== S.behalf && t?.source_account_id !== S.detB && t?.destination_account_id !== S.detB
    );
    check({
      id: "ownership-transfer-collections-do-not-leak-a-strangers-transfer",
      obligation: "rule:ownership",
      title: "a transfer between two of A's own accounts is invisible to B, listed plainly or filtered by A's account id",
      pass: bTransfers.status === 200 && bFiltered.status === 200 && !bSeesPrivate && !bFilteredSeesPrivate && bFilteredOutsiders.length === 0,
      expected: `neither collection contains ${aToA2.json?.id}, and every item names one of B's accounts`,
      observed: `plain=${bSeesPrivate ? "LEAKED" : "clean"} filtered=${bFilteredSeesPrivate ? "LEAKED" : "clean"} strangers=${JSON.stringify(bFilteredOutsiders.map((t) => t?.id))}`,
      evidence: { requests: ev(aToA2, bTransfers, bFiltered) },
    });

    const bReadsShared = await GET(`/transfers/${feeProbes[0]?.r.json?.id}`, CB());
    check({
      id: "ownership-a-transfer-is-readable-by-both-of-its-sides",
      obligation: "rule:ownership",
      title: "being paid by a stranger makes the transfer visible without making the payer's account visible",
      pass: bReadsShared.status === 200 && bReadsShared.json?.id === feeProbes[0]?.r.json?.id && readAcct.status === 403,
      expected: "200 on the transfer B receives, while the payer's account stays 403",
      observed: `transfer ${shape(bReadsShared)} | payer account ${readAcct.status}`,
      evidence: { requests: ev(feeProbes[0]?.r, bReadsShared, readAcct) },
    });

    const asA = await GET(`/accounts/${FEE_USD}`, CA());
    const asB = await GET(`/accounts/${FEE_USD}`, CB());
    const feeEntriesB = await GET(`/accounts/${FEE_USD}/entries?limit=100`, CB());
    const feeBefore = asA.json?.balance;
    const actOnFee = await POST("/deposits", { account_id: FEE_USD, amount: 999 }, CA());
    const feeAfter = await GET(`/accounts/${FEE_USD}`, CA());
    check({
      id: "ownership-fee-accounts-are-public-to-read-and-closed-to-customer-action",
      obligation: "rule:ownership",
      title: "the system fee account is readable by every principal and cannot be acted on by a customer",
      pass:
        asA.status === 200 &&
        asB.status === 200 &&
        feeEntriesB.status === 200 &&
        actOnFee.status >= 400 &&
        actOnFee.status < 500 &&
        feeAfter.status === 200 &&
        feeAfter.json?.balance === feeBefore,
      expected: "200 for both customers reading it and its entries; a customer deposit refused 4xx with the balance unmoved",
      observed: `A=${asA.status} B=${asB.status} entries=${feeEntriesB.status} deposit=${shape(actOnFee)} balance ${JSON.stringify(feeBefore)}->${JSON.stringify(feeAfter.json?.balance)}`,
      evidence: { requests: ev(asA, asB, feeEntriesB, actOnFee, feeAfter) },
    });

    const customerOnBehalf = await POST("/accounts", { owner: "sneaky", currency: "USD", owner_principal: principalB }, CA());
    check({
      id: "ownership-a-customer-cannot-open-an-account-for-another-principal",
      obligation: "rule:ownership",
      title: "only the administrator may open an account on another principal's behalf",
      pass: customerOnBehalf.status === 403,
      expected: "403",
      observed: shape(customerOnBehalf),
      evidence: { requests: ev(customerOnBehalf) },
    });

    const aReread = await GET(`/accounts/${S.aUSD}`, CA());
    check({
      id: "ownership-owner-principal-is-fixed-at-creation",
      obligation: "rule:ownership",
      title: "an account still names the principal it was created under",
      pass: aReread.status === 200 && aReread.json?.owner_principal === principalA && aUSDc.json?.owner_principal === principalA,
      expected: `owner_principal stays ${JSON.stringify(principalA)}`,
      observed: `${JSON.stringify(aUSDc.json?.owner_principal)} at creation, ${JSON.stringify(aReread.json?.owner_principal)} now`,
      evidence: { requests: ev(aUSDc, aReread) },
    });
  });

  // =========================================================================
  // Phase 6 — the status split, on refusals that change nothing
  // =========================================================================
  await phase("status-split", "rule:error-shape-and-the-status-split-three-rules", async () => {
    const unparseable = await req("POST", "/transfers", { rawBody: "{ not json", headers: CA() });
    check({
      id: "status-400-for-an-unparseable-body",
      obligation: "rule:error-shape-and-the-status-split-three-rules",
      title: "an unparseable request body is 400",
      pass: unparseable.status === 400,
      expected: "400",
      observed: shape(unparseable),
      evidence: { requests: ev(unparseable) },
    });

    const wrongType = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.bUSD, amount: "ten" }, CA());
    check({
      id: "status-400-for-a-wrongly-typed-field",
      obligation: "rule:error-shape-and-the-status-split-three-rules",
      title: "a wrongly typed request is 400 — amount is a documented integer and this request sends a string",
      pass: wrongType.status === 400,
      expected: "400 (INVARIANTS §11: 'A malformed, unparseable, or wrongly typed request is 400')",
      observed: shape(wrongType),
      evidence: { requests: ev(wrongType, unparseable) },
    });

    const nonInteger = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.bUSD, amount: 10.5 }, CA());
    const missingField = await POST("/accounts", { owner: "no-currency" }, CA());
    const extraField = await POST("/accounts", { owner: "extra", currency: "USD", not_a_field: 1 }, CA());
    check.advisory({
      title: "request-body conformance beyond the plain wrong-type case",
      detail:
        `amount:10.5 (Money is an integer) -> ${shape(nonInteger)}; ` +
        `POST /accounts missing the required 'currency' -> ${shape(missingField)}; ` +
        `POST /accounts with an undocumented property against additionalProperties:false -> ${shape(extraField)}. ` +
        `The invariant's declared tolerance for unknown input is scoped to query parameters, but it names only "malformed, unparseable, or wrongly typed" for 400, so these three are recorded rather than judged.`,
      evidence: { requests: ev(nonInteger, missingField, extraField) },
    });

    const noAuthRead = await GET("/accounts");
    const noAuthWrite = await POST("/accounts", { owner: "anon", currency: "USD" });
    check({
      id: "status-401-for-a-missing-credential",
      obligation: "rule:error-shape-and-the-status-split-three-rules",
      title: "a missing credential is 401 on read and on write, and the 401 carries WWW-Authenticate",
      pass:
        noAuthRead.status === 401 &&
        noAuthWrite.status === 401 &&
        typeof noAuthRead.headers?.["www-authenticate"] === "string",
      expected: "401 both times, with a WWW-Authenticate header",
      observed: `read ${shape(noAuthRead)} hdr=${JSON.stringify(noAuthRead.headers?.["www-authenticate"])} | write ${shape(noAuthWrite)}`,
      evidence: { requests: ev(noAuthRead, noAuthWrite) },
    });

    const nf = [
      ["account", await GET("/accounts/acc_no_such_account", CA())],
      ["account as admin", await GET("/accounts/acc_no_such_account", ADMIN())],
      ["entries under an unknown account", await GET("/accounts/acc_no_such_account/entries", CA())],
      ["transfer", await GET("/transfers/tr_nosuch", CA())],
      ["deposit", await GET("/deposits/dep_nosuch", CA())],
      ["cancel of an unknown transfer", await POST("/transfers/tr_nosuch/cancel", undefined, CA())],
    ];
    const notNf = nf.filter(([, r]) => r.status !== 404);
    check({
      id: "status-404-for-an-identifier-that-names-nothing",
      obligation: "rule:error-shape-and-the-status-split-three-rules",
      title: "an unknown identifier is 404 — including after a resource-scoped path, and whichever principal asks",
      pass: notNf.length === 0,
      expected: "404 on all six",
      observed: notNf.length ? notNf.map(([w, r]) => `${w}: ${shape(r)}`).join(" | ") : "all six answered 404",
      evidence: { requests: ev(nf.map(([, r]) => r)) },
    });

    const sameAccount = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.aUSD, amount: 100 }, CA());
    const currencyMismatch = await POST("/transfers", { source_account_id: S.aUSD, destination_account_id: S.bEUR, amount: 100 }, CA());
    const insufficient = await POST("/transfers", { source_account_id: S.a2USD, destination_account_id: S.aUSD, amount: 5000 }, CA());
    const biz = [
      ["same_account", sameAccount],
      ["currency_mismatch", currencyMismatch],
      ["insufficient_funds", insufficient],
    ];
    const notBiz = biz.filter(([, r]) => r.status !== 422);
    check({
      id: "status-422-for-a-well-formed-request-a-business-rule-refuses",
      obligation: "rule:error-shape-and-the-status-split-three-rules",
      title: "same_account, currency_mismatch and insufficient_funds are 422, not 400 and not 409",
      pass: notBiz.length === 0,
      expected: "422 on all three",
      observed: biz.map(([w, r]) => `${w}: ${r.status} ${JSON.stringify(r.json?.error?.code)}`).join(" | "),
      evidence: { requests: ev(sameAccount, currencyMismatch, insufficient) },
    });

    // One operation, five reasons: the status must say *why*, not merely that it refused.
    const split = [
      ["an identifier that names nothing", 404, await POST("/deposits", { account_id: "acc_no_such_account", amount: 100 }, CA())],
      ["a principal that may not reach the resource", 403, await POST("/deposits", { account_id: S.aUSD, amount: 100 }, CB())],
      ["the state a resource is in", 409, await POST("/deposits", { account_id: S.pend, amount: 100 }, CA())],
      ["a closed account's tombstone", 410, await POST("/deposits", { account_id: S.closed, amount: 100 }, CA())],
      ["a malformed request", 400, await req("POST", "/deposits", { rawBody: "not json at all", headers: CA() })],
    ];
    const wrongStatus = split.filter(([, want, r]) => r.status !== want);
    check({
      id: "status-split-one-operation-five-reasons",
      obligation: "rule:error-shape-and-the-status-split-three-rules",
      title: "on a single operation (POST /deposits) the status says why the service refused: 404 / 403 / 409 / 410 / 400",
      pass: wrongStatus.length === 0,
      expected: split.map(([why, want]) => `${want} for ${why}`).join("; "),
      observed: wrongStatus.length
        ? wrongStatus.map(([why, want, r]) => `${why}: wanted ${want}, got ${shape(r)}`).join(" | ")
        : "each reason produced its own status",
      evidence: { requests: ev(split.map(([, , r]) => r)) },
    });
  });

  // =========================================================================
  // Phase 7 — settlement, conservation, and the funds re-check
  // =========================================================================
  const settled = {};
  await phase("settlement", "rule:settlement", async () => {
    const pendingBefore = await GET("/transfers?limit=100", ADMIN());
    const pendingIds = arr(pendingBefore.json?.items)
      .filter((t) => t?.status === "pending")
      .map((t) => t?.id)
      .reverse(); // the collection is newest-first; creation order is the reverse

    const tick1 = await POST("/admin/tick", {}, ADMIN());
    const outcome = [...arr(tick1.json?.settled), ...arr(tick1.json?.failed)];
    check({
      id: "settlement-a-tick-leaves-nothing-pending",
      obligation: "rule:settlement",
      title: "a tick with no settle_limit settles every pending transfer, each ending settled or failed — never still pending",
      pass:
        tick1.status === 200 &&
        tick1.json?.pending === 0 &&
        pendingIds.length > 0 &&
        outcome.length === pendingIds.length &&
        pendingIds.every((id) => outcome.includes(id)),
      expected: `pending 0 and all ${pendingIds.length} pending transfers accounted for`,
      observed: `${shape(tick1)} — expected ${JSON.stringify(pendingIds)}`,
      evidence: { requests: ev(pendingBefore, tick1) },
    });
    check({
      id: "settlement-happens-in-creation-order",
      obligation: "rule:settlement",
      title: "a tick works through the pending transfers in creation order",
      pass: JSON.stringify(outcome) === JSON.stringify(pendingIds),
      expected: `creation order ${JSON.stringify(pendingIds)}`,
      observed: `tick reported ${JSON.stringify(outcome)}`,
      evidence: { requests: ev(pendingBefore, tick1) },
    });

    // ---- the ledger, read once, for conservation and balance agreement
    const accountsForLedger = [
      ["detA", S.detA, CA()],
      ["detB", S.detB, CB()],
      ["aUSD", S.aUSD, CA()],
      ["a2USD", S.a2USD, CA()],
      ["bUSD", S.bUSD, CB()],
      ["aEUR", S.aEUR, CA()],
      ["bEUR", S.bEUR, CB()],
      ["feeUSD", FEE_USD, CA()],
      ["feeEUR", FEE_EUR, CA()],
    ];
    const ledger = new Map(); // entry id -> entry
    const byTransfer = new Map();
    const entryRefs = [];
    for (const [, id, who] of accountsForLedger) {
      const r = await GET(`/accounts/${id}/entries?limit=100`, who);
      entryRefs.push(r);
      for (const e of arr(r.json?.items)) {
        ledger.set(e?.id, e);
        if (typeof e?.transfer_id === "string") {
          if (!byTransfer.has(e.transfer_id)) byTransfer.set(e.transfer_id, []);
          byTransfer.get(e.transfer_id).push(e);
        }
      }
    }
    S.ledger = ledger;
    S.byTransfer = byTransfer;

    const listAll = await GET("/transfers?limit=100", ADMIN());
    const transfers = arr(listAll.json?.items);
    for (const t of transfers) if (t?.id) settled[t.id] = t;

    // conservation, per settled transfer, per currency
    for (const cur of ["USD", "EUR"]) {
      const subjects = transfers.filter(
        (t) => t?.status === "settled" && t?.currency === cur && t?.destination_account_id !== FEE_USD && t?.destination_account_id !== FEE_EUR
      );
      const bad = [];
      for (const t of subjects) {
        const es = byTransfer.get(t.id) ?? [];
        const debits = es.filter((e) => e?.kind === "transfer_debit");
        const credits = es.filter((e) => e?.kind === "transfer_credit");
        const fees = es.filter((e) => e?.kind === "fee");
        const problems = [];
        if (es.length !== 3) problems.push(`${es.length} entries carry the id`);
        if (debits.length !== 1 || credits.length !== 1 || fees.length !== 1)
          problems.push(`rows debit/credit/fee = ${debits.length}/${credits.length}/${fees.length}`);
        if (debits[0] && (debits[0].amount !== -(t.amount + t.fee) || debits[0].account_id !== t.source_account_id))
          problems.push(`debit ${debits[0].amount} on ${debits[0].account_id}, expected ${-(t.amount + t.fee)} on ${t.source_account_id}`);
        if (credits[0] && (credits[0].amount !== t.amount || credits[0].account_id !== t.destination_account_id))
          problems.push(`credit ${credits[0].amount} on ${credits[0].account_id}, expected ${t.amount} on ${t.destination_account_id}`);
        if (fees[0] && (fees[0].amount !== t.fee || fees[0].account_id !== t.fee_account_id))
          problems.push(`fee ${fees[0].amount} on ${fees[0].account_id}, expected ${t.fee} on ${t.fee_account_id}`);
        const total = sum(es.map((e) => e?.amount));
        if (total !== 0) problems.push(`entries sum to ${total}, not 0`);
        if (problems.length) bad.push(`${t.id} (amount ${t.amount}, fee ${t.fee}): ${problems.join("; ")}`);
      }
      check({
        id: `conservation-${cur.toLowerCase()}`,
        obligation: "rule:conservation",
        title: `every settled ${cur} transfer has exactly one debit, one credit and one fee row, summing to zero`,
        pass: subjects.length > 0 && bad.length === 0,
        expected: `all ${subjects.length} settled ${cur} transfers balance to zero across their three rows`,
        observed: bad.length ? bad.join(" || ") : `${subjects.length} settled ${cur} transfers all balanced`,
        evidence: { requests: ev(listAll, entryRefs), subject: { checked: subjects.map((t) => t.id) } },
      });
    }

    // the fee a transfer declares at creation is the fee it settles at
    const feeDrift = feeProbes
      .map((p) => {
        const id = p.r.json?.id;
        const now = settled[id];
        const feeRow = (byTransfer.get(id) ?? []).find((e) => e?.kind === "fee");
        if (!now) return `${id}: not in the transfer collection after settlement`;
        if (now.fee !== p.r.json?.fee) return `${id}: declared ${p.r.json?.fee}, settled at ${now.fee}`;
        if (feeRow && feeRow.amount !== p.r.json?.fee) return `${id}: fee row ${feeRow.amount} != declared ${p.r.json?.fee}`;
        if (!feeRow) return `${id}: no fee row was written`;
        return null;
      })
      .filter(Boolean);
    check({
      id: "fee-declared-is-the-fee-settled",
      obligation: "rule:the-fee-schedule",
      title: "the fee a transfer declares when it is created is the fee it settles at, and the fee row carries that amount",
      pass: feeProbes.length > 0 && feeDrift.length === 0,
      expected: "no drift between the declared fee, the settled fee, and the fee ledger row",
      observed: feeDrift.length ? feeDrift.join(" | ") : `${feeProbes.length} transfers settled at the fee they declared`,
      evidence: { requests: ev(feeProbes.map((p) => p.r), listAll, entryRefs) },
    });

    // reference integrity: a deposit's entry_id, and an entry's transfer_id
    const depRead = await GET(`/deposits/${aUSDdep.json?.id}`, CA());
    const depEntry = ledger.get(depRead.json?.entry_id);
    check({
      id: "refint-deposit-entry-id-resolves-and-agrees",
      obligation: "rule:reference-integrity",
      title: "a deposit's entry_id names a ledger entry on the deposit's own account, for its own amount, whose deposit_id is that deposit",
      pass:
        depRead.status === 200 &&
        (depRead.json?.entry_id == null ||
          (!!depEntry &&
            depEntry.account_id === depRead.json?.account_id &&
            depEntry.amount === depRead.json?.amount &&
            depEntry.deposit_id === depRead.json?.id &&
            depEntry.currency === depRead.json?.currency)),
      expected: `entry ${JSON.stringify(depRead.json?.entry_id)} on ${JSON.stringify(depRead.json?.account_id)} for ${JSON.stringify(depRead.json?.amount)} naming ${JSON.stringify(depRead.json?.id)}`,
      observed: depRead.json?.entry_id == null ? "entry_id absent — the declared exception" : JSON.stringify(depEntry ?? null),
      evidence: { requests: ev(aUSDdep, depRead, entryRefs) },
    });

    const dangling = [];
    for (const [tid, es] of byTransfer) {
      if (!settled[tid]) dangling.push(`${tid} is named by ${es.length} entries but is not in the transfer collection`);
    }
    const currencyMismatchEntries = [];
    const accountCurrency = new Map();
    for (const t of transfers) {
      accountCurrency.set(t?.source_account_id, t?.currency);
      accountCurrency.set(t?.destination_account_id, t?.currency);
    }
    for (const e of ledger.values()) {
      const cur = accountCurrency.get(e?.account_id);
      if (cur && e?.currency !== cur) currencyMismatchEntries.push(`${e.id} on ${e.account_id} is ${e.currency}, the account transacts in ${cur}`);
    }
    check({
      id: "refint-entry-transfer-id-resolves-and-currency-agrees",
      obligation: "rule:reference-integrity",
      title: "every entry's transfer_id names a transfer that exists, and the entry's currency is the currency of the account it sits on",
      pass: byTransfer.size > 0 && dangling.length === 0 && currencyMismatchEntries.length === 0,
      expected: "no dangling transfer_id and no currency disagreement",
      observed: [...dangling, ...currencyMismatchEntries].join(" | ") || `${byTransfer.size} transfer ids all resolved`,
      evidence: { requests: ev(listAll, entryRefs) },
    });

    // ---- a second tick must not settle anything again
    const sampleId = transfers.find((t) => t?.status === "settled")?.id;
    const sampleBefore = await GET(`/transfers/${sampleId}`, ADMIN());
    const balBefore = await GET(`/accounts/${S.aUSD}`, CA());
    const tick2 = await POST("/admin/tick", {}, ADMIN());
    const sampleAfter = await GET(`/transfers/${sampleId}`, ADMIN());
    const balAfter = await GET(`/accounts/${S.aUSD}`, CA());
    check({
      id: "settlement-a-transfer-settles-once",
      obligation: "rule:settlement",
      title: "a second tick does not settle an already-settled transfer again: no new outcome, no moved timestamp, no moved money",
      pass:
        tick2.status === 200 &&
        arr(tick2.json?.settled).length === 0 &&
        arr(tick2.json?.failed).length === 0 &&
        sampleBefore.status === 200 &&
        sampleAfter.status === 200 &&
        resourceDiff(sampleBefore.json, sampleAfter.json).length === 0 &&
        balBefore.json?.balance === balAfter.json?.balance,
      expected: "the second tick settles nothing and leaves the transfer and the balance untouched",
      observed: `tick=${shape(tick2)} diff=${JSON.stringify(resourceDiff(sampleBefore.json, sampleAfter.json))} balance ${JSON.stringify(balBefore.json?.balance)}->${JSON.stringify(balAfter.json?.balance)}`,
      evidence: { requests: ev(sampleBefore, balBefore, tick2, sampleAfter, balAfter) },
    });

    // ---- funds are re-checked at settlement: over-commit a 10 000 balance
    const big = await POST("/transfers", { source_account_id: S.set, destination_account_id: S.bUSD, amount: 9000 }, CA());
    const small = await POST("/transfers", { source_account_id: S.set, destination_account_id: S.bUSD, amount: 1000 }, CA());
    const partial = await POST("/admin/tick", { settle_limit: 1 }, ADMIN());
    check({
      id: "settlement-settle-limit-leaves-the-rest-pending",
      obligation: "rule:settlement",
      title: "settle_limit asks for at most that many settlements and leaves the rest pending on purpose",
      pass:
        big.status === 201 &&
        small.status === 201 &&
        partial.status === 200 &&
        arr(partial.json?.settled).length + arr(partial.json?.failed).length === 1 &&
        arr(partial.json?.settled)[0] === big.json?.id &&
        partial.json?.pending === 1,
      expected: `exactly one outcome (${big.json?.id}, the older transfer) and one still pending`,
      observed: `${shape(partial)} — created ${big.json?.id} then ${small.json?.id}`,
      evidence: { requests: ev(big, small, partial) },
    });
    const midBalance = await GET(`/accounts/${S.set}`, CA());
    const tick3 = await POST("/admin/tick", {}, ADMIN());
    const smallAfter = await GET(`/transfers/${small.json?.id}`, CA());
    const setEntries = await GET(`/accounts/${S.set}/entries?limit=100`, CA());
    const smallRows = arr(setEntries.json?.items).filter((e) => e?.transfer_id === small.json?.id);
    check({
      id: "settlement-funds-are-rechecked-at-settlement-time",
      obligation: "rule:settlement",
      title: "a transfer that can no longer be covered when its turn comes ends 'failed'",
      pass:
        midBalance.json?.balance === 10000 - (9000 + feeFor(9000)) &&
        tick3.status === 200 &&
        arr(tick3.json?.failed).includes(small.json?.id) &&
        smallAfter.json?.status === "failed" &&
        tick3.json?.pending === 0,
      expected: `after the first settlement the balance is ${10000 - (9000 + feeFor(9000))}, which cannot cover ${1000 + feeFor(1000)}, so the second transfer ends failed`,
      observed: `balance ${JSON.stringify(midBalance.json?.balance)} | tick ${shape(tick3)} | transfer ${JSON.stringify(smallAfter.json?.status)}`,
      evidence: { requests: ev(setDep, big, small, midBalance, tick3, smallAfter) },
    });
    check({
      id: "conservation-a-failed-transfer-writes-no-entries",
      obligation: "rule:conservation",
      title: "a transfer that ends 'failed' writes no ledger entries at all",
      pass: smallAfter.json?.status === "failed" && setEntries.status === 200 && smallRows.length === 0,
      expected: `no entry carries ${small.json?.id}`,
      observed: smallRows.length ? JSON.stringify(smallRows) : "the failed transfer wrote nothing",
      evidence: { requests: ev(small, tick3, setEntries) },
    });

    // ---- a cancelled transfer writes no entries either, and cannot be cancelled twice
    const doomed = await POST("/transfers", { source_account_id: S.set, destination_account_id: S.bUSD, amount: 100 }, CA());
    const cancel1 = await POST(`/transfers/${doomed.json?.id}/cancel`, undefined, CA());
    const cancel2 = await POST(`/transfers/${doomed.json?.id}/cancel`, undefined, CA());
    const tick4 = await POST("/admin/tick", {}, ADMIN());
    const setEntries2 = await GET(`/accounts/${S.set}/entries?limit=100`, CA());
    const doomedRows = arr(setEntries2.json?.items).filter((e) => e?.transfer_id === doomed.json?.id);
    check({
      id: "conservation-a-canceled-transfer-writes-no-entries",
      obligation: "rule:conservation",
      title: "a transfer canceled before it settles writes no entries and is not resurrected by a later tick",
      pass:
        cancel1.status === 200 &&
        cancel1.json?.status === "canceled" &&
        tick4.status === 200 &&
        !arr(tick4.json?.settled).includes(doomed.json?.id) &&
        doomedRows.length === 0,
      expected: `cancel returns 'canceled', the next tick ignores it, and no entry carries ${doomed.json?.id}`,
      observed: `cancel ${shape(cancel1)} | tick ${shape(tick4)} | rows ${JSON.stringify(doomedRows)}`,
      evidence: { requests: ev(doomed, cancel1, tick4, setEntries2) },
    });
    const cancelSettled = await POST(`/transfers/${big.json?.id}/cancel`, undefined, CA());
    const cancelFailed = await POST(`/transfers/${small.json?.id}/cancel`, undefined, CA());
    check({
      id: "lifecycle-cannot-cancel-a-transfer-that-is-no-longer-pending",
      obligation: "rule:lifecycle-legality",
      title: "a transfer that has settled, failed, or already been canceled cannot be canceled (409)",
      pass: cancelSettled.status === 409 && cancelFailed.status === 409 && cancel2.status === 409,
      expected: "409 for the settled one, the failed one, and the already-canceled one",
      observed: `settled ${shape(cancelSettled)} | failed ${shape(cancelFailed)} | canceled ${shape(cancel2)}`,
      evidence: { requests: ev(cancelSettled, cancelFailed, cancel2) },
    });

    // ---- daily usage is reserved at creation and is not released by a failure or a cancellation
    const roomProbe = await POST(
      "/transfers",
      { source_account_id: S.set, destination_account_id: S.bUSD, amount: DAILY_LIMIT - 10000 - 100 + 1 },
      CA()
    );
    check({
      id: "daily-usage-survives-a-failed-and-a-canceled-transfer",
      obligation: "rule:the-daily-limit",
      title: "usage is reserved at creation, so a transfer that failed at settlement and one that was canceled still count against the day",
      pass: roomProbe.status === 422 && roomProbe.json?.error?.code === "daily_limit_exceeded",
      expected: `9000 settled + 1000 failed + 100 canceled = 10100 reserved, so ${DAILY_LIMIT - 10100 + 1} must be refused 422 daily_limit_exceeded`,
      observed: shape(roomProbe),
      evidence: { requests: ev(big, small, doomed, cancel1, roomProbe) },
    });
  });

  // =========================================================================
  // Phase 8 — idempotency
  // =========================================================================
  await phase("idempotency", "rule:idempotency", async () => {
    const KEY = "s0-idem-key";
    const body = { source_account_id: S.aUSD, destination_account_id: S.bUSD, amount: 500 };
    const created = await POST("/transfers", body, { ...CA(), "idempotency-key": KEY });
    const replay = await POST("/transfers", body, { ...CA(), "idempotency-key": KEY });
    check({
      id: "idem-replay-returns-the-first-transfer",
      obligation: "rule:idempotency",
      title: "the same key with the same body returns the first transfer, with 200 and Idempotency-Replayed",
      pass:
        created.status === 201 &&
        replay.status === 200 &&
        replay.json?.id === created.json?.id &&
        resourceDiff(created.json, replay.json).length === 0 &&
        replay.headers?.["idempotency-replayed"] === "true",
      expected: "201 then 200 with an identical resource and Idempotency-Replayed: true",
      observed: `${shape(created)} then ${shape(replay)} hdr=${JSON.stringify(replay.headers?.["idempotency-replayed"])} diff=${JSON.stringify(resourceDiff(created.json, replay.json))}`,
      evidence: { requests: ev(created, replay) },
    });

    const conflict = await POST("/transfers", { ...body, amount: 501 }, { ...CA(), "idempotency-key": KEY });
    const afterConflict = await GET(`/transfers?account_id=${S.aUSD}&limit=100`, CA());
    const lostWrite = arr(afterConflict.json?.items).filter((t) => t?.amount === 501);
    check({
      id: "idem-same-key-different-body-is-a-conflict-that-creates-nothing",
      obligation: "rule:idempotency",
      title: "the same key with a different body is refused as a conflict and creates nothing — it does not return the earlier transfer",
      pass:
        conflict.status === 409 &&
        conflict.json?.error?.code === "idempotency_key_conflict" &&
        conflict.json?.id === undefined &&
        lostWrite.length === 0,
      expected: "409 idempotency_key_conflict, no transfer body, and no transfer of 501 anywhere",
      observed: `${shape(conflict)} | transfers of 501: ${JSON.stringify(lostWrite.map((t) => t?.id))}`,
      evidence: { requests: ev(created, conflict, afterConflict) },
    });

    // the key is scoped to the principal, so only count transfers this principal sourced
    const carriesKey = (items) => arr(items).filter((t) => t?.idempotency_key === KEY && t?.source_account_id === S.aUSD);
    const exactlyOne = carriesKey(afterConflict.json?.items);
    check({
      id: "idem-one-key-one-transfer",
      obligation: "rule:idempotency",
      title: "two requests carrying the same key produced exactly one transfer",
      pass: afterConflict.status === 200 && exactlyOne.length === 1 && exactlyOne[0]?.id === created.json?.id,
      expected: `exactly one transfer on this account carries the key, and it is ${created.json?.id}`,
      observed: JSON.stringify(exactlyOne.map((t) => t?.id)),
      evidence: { requests: ev(created, replay, afterConflict) },
    });

    const bSameKey = await POST(
      "/transfers",
      { source_account_id: S.bUSD, destination_account_id: S.aUSD, amount: 700 },
      { ...CB(), "idempotency-key": KEY }
    );
    check({
      id: "idem-keys-are-scoped-to-the-principal",
      obligation: "rule:idempotency",
      title: "a second principal may use the same key for a different transfer without violating anything",
      pass: bSameKey.status === 201 && bSameKey.json?.id !== created.json?.id && bSameKey.json?.amount === 700,
      expected: "201, a new transfer distinct from the first principal's",
      observed: shape(bSameKey),
      evidence: { requests: ev(created, bSameKey) },
    });

    const cancelled = await POST(`/transfers/${created.json?.id}/cancel`, undefined, CA());
    const replayAfterCancel = await POST("/transfers", body, { ...CA(), "idempotency-key": KEY });
    check({
      id: "idem-key-is-not-released-by-cancelling",
      obligation: "rule:idempotency",
      title: "cancelling the transfer a key created does not release the key",
      pass:
        cancelled.status === 200 &&
        replayAfterCancel.status === 200 &&
        replayAfterCancel.json?.id === created.json?.id &&
        replayAfterCancel.json?.status === "canceled",
      expected: "the replay still returns the original transfer, now canceled — no second transfer",
      observed: `cancel ${shape(cancelled)} | replay ${shape(replayAfterCancel)}`,
      evidence: { requests: ev(created, cancelled, replayAfterCancel) },
    });

    const rollover = await POST("/admin/tick", { advance_day: true }, ADMIN());
    const replayAfterDay = await POST("/transfers", body, { ...CA(), "idempotency-key": KEY });
    const finalList = await GET(`/transfers?account_id=${S.aUSD}&limit=100`, CA());
    const stillOne = carriesKey(finalList.json?.items);
    check({
      id: "idem-key-survives-settlement-and-the-day-rollover",
      obligation: "rule:idempotency",
      title: "the record of a key does not expire when the ledger day rolls over or when its transfers settle",
      pass:
        rollover.status === 200 &&
        replayAfterDay.status === 200 &&
        replayAfterDay.json?.id === created.json?.id &&
        stillOne.length === 1,
      expected: "after a tick that settles and advances the day, the replay still returns the one original transfer this principal created",
      observed: `tick ${shape(rollover)} | replay ${shape(replayAfterDay)} | this principal's transfers carrying the key ${JSON.stringify(stillOne.map((t) => t?.id))}`,
      evidence: { requests: ev(rollover, replayAfterDay, finalList) },
    });

    S.idemEvidence = [created, replay, bSameKey];
    check({
      id: "param-idempotency-key-is-honoured",
      obligation: "rule:documented-parameters",
      title: "the Idempotency-Key header is honoured: it is echoed on the transfer, it drives the replay, and a transfer sent without one is never a replay",
      pass:
        created.json?.idempotency_key === KEY &&
        replay.headers?.["idempotency-replayed"] === "true" &&
        created.headers?.["idempotency-replayed"] === undefined &&
        aToA2?.json?.idempotency_key == null,
      expected: "the key is echoed, the replay is flagged, the first request is not, and a keyless transfer carries a null key",
      observed: `echoed=${JSON.stringify(created.json?.idempotency_key)} replay-flag=${JSON.stringify(replay.headers?.["idempotency-replayed"])} first-flag=${JSON.stringify(created.headers?.["idempotency-replayed"])} keyless=${JSON.stringify(aToA2?.json?.idempotency_key)}`,
      evidence: { requests: ev(created, replay, aToA2) },
    });
  });

  // =========================================================================
  // Phase 9 — the daily limit, at its inclusive boundary
  // =========================================================================
  let limLast = null;
  await phase("daily-limit", "rule:the-daily-limit", async () => {
    const first60 = await POST("/transfers", { source_account_id: S.lim, destination_account_id: S.bUSD, amount: 60000 }, CA());
    const then39999 = await POST("/transfers", { source_account_id: S.lim, destination_account_id: S.bUSD, amount: 39999 }, CA());
    const exactly = await POST("/transfers", { source_account_id: S.lim, destination_account_id: S.bUSD, amount: 1 }, CA());
    check({
      id: "daily-boundary-is-inclusive",
      obligation: "rule:the-daily-limit",
      title: `an amount bringing the day's total exactly to ${DAILY_LIMIT} is accepted`,
      pass: first60.status === 201 && then39999.status === 201 && exactly.status === 201,
      expected: "60000 + 39999 + 1 = 100000, all three accepted",
      observed: `${first60.status} / ${then39999.status} / ${shape(exactly)}`,
      evidence: { requests: ev(first60, then39999, exactly) },
    });

    const over = await POST("/transfers", { source_account_id: S.lim, destination_account_id: S.bUSD, amount: 1 }, CA());
    check({
      id: "daily-anything-beyond-the-boundary-is-refused",
      obligation: "rule:the-daily-limit",
      title: "one minor unit beyond the limit is refused 422 daily_limit_exceeded",
      pass: over.status === 422 && over.json?.error?.code === "daily_limit_exceeded",
      expected: "422 daily_limit_exceeded",
      observed: shape(over),
      evidence: { requests: ev(exactly, over) },
    });

    const cancelled = await POST(`/transfers/${exactly.json?.id}/cancel`, undefined, CA());
    const afterCancel = await POST("/transfers", { source_account_id: S.lim, destination_account_id: S.bUSD, amount: 1 }, CA());
    check({
      id: "daily-cancelling-does-not-give-the-room-back",
      obligation: "rule:the-daily-limit",
      title: "usage is reserved at creation, so cancelling a transfer does not release its room in the day",
      pass: cancelled.status === 200 && afterCancel.status === 422 && afterCancel.json?.error?.code === "daily_limit_exceeded",
      expected: "still 422 daily_limit_exceeded after the cancellation",
      observed: `cancel ${cancelled.status} | retry ${shape(afterCancel)}`,
      evidence: { requests: ev(exactly, cancelled, afterCancel) },
    });

    const withFees = DAILY_LIMIT + feeFor(60000) + feeFor(39999) + feeFor(1);
    const reportedUsed = over.json?.error?.details?.used;
    check({
      id: "daily-usage-counts-amounts-not-fees",
      obligation: "rule:the-daily-limit",
      title: `usage counts transfer amounts, not fees: 60000+39999+1 is ${DAILY_LIMIT} of usage, not ${withFees}`,
      pass: reportedUsed === undefined || reportedUsed === DAILY_LIMIT,
      expected: `used = ${DAILY_LIMIT} (or omitted — details is optional)`,
      observed: `used = ${JSON.stringify(reportedUsed)}; ${withFees} would mean fees were counted`,
      evidence: { requests: ev(over) },
    });

    const dayRoll = await POST("/admin/tick", { advance_day: true }, ADMIN());
    limLast = await POST("/transfers", { source_account_id: S.lim, destination_account_id: S.bUSD, amount: 1 }, CA());
    check({
      id: "daily-rolling-the-day-starts-the-count-at-zero",
      obligation: "rule:the-daily-limit",
      title: "rolling the ledger day over via POST /admin/tick {advance_day:true} starts the next day's count at zero",
      pass: dayRoll.status === 200 && Number.isInteger(dayRoll.json?.day) && limLast.status === 201,
      expected: "the tick reports a new day and the previously refused transfer is now accepted",
      observed: `tick ${shape(dayRoll)} | retry ${shape(limLast)}`,
      evidence: { requests: ev(afterCancel, dayRoll, limLast) },
    });
    check({
      id: "param-tick-advance-day-and-settle-limit-do-what-they-say",
      obligation: "rule:documented-parameters",
      title: "advance_day rolls the ledger day and a tick that rolls the day is still a tick",
      pass:
        dayRoll.status === 200 &&
        Number.isInteger(dayRoll.json?.day) &&
        dayRoll.json?.pending === 0 &&
        arr(dayRoll.json?.settled).includes(first60.json?.id) &&
        arr(dayRoll.json?.settled).includes(then39999.json?.id),
      expected: "the advancing tick also settled the two pending transfers and left nothing pending",
      observed: shape(dayRoll),
      evidence: { requests: ev(first60, then39999, dayRoll) },
    });
  });

  // =========================================================================
  // Phase 10 — documented parameters and pagination (read-only from here)
  // =========================================================================
  await phase("parameters", "rule:documented-parameters", async () => {
    const bad = [
      ["limit=0", await GET("/accounts?limit=0", ADMIN())],
      ["limit=101", await GET("/accounts?limit=101", ADMIN())],
      ["limit=abc", await GET("/accounts?limit=abc", ADMIN())],
      ["limit=-1 on entries", await GET(`/accounts/${S.aUSD}/entries?limit=-1`, CA())],
      ["cursor=not-a-cursor", await GET("/accounts?cursor=not-a-cursor", ADMIN())],
    ];
    const notBad = bad.filter(([, r]) => r.status !== 400);
    check({
      id: "param-limit-and-cursor-are-refused-outside-their-documented-range",
      obligation: "rule:documented-parameters",
      title: "limit outside 1..100 is 400, and a cursor the endpoint never issued is 400",
      pass: notBad.length === 0,
      expected: "400 on all five",
      observed: notBad.length ? notBad.map(([w, r]) => `${w}: ${shape(r)}`).join(" | ") : "all five were refused 400",
      evidence: { requests: ev(bad.map(([, r]) => r)) },
    });

    const one = await GET("/accounts?limit=1", ADMIN());
    const hundred = await GET("/accounts?limit=100&include_closed=true", ADMIN());
    check({
      id: "param-limit-bounds-the-page",
      obligation: "rule:documented-parameters",
      title: "limit bounds the page size",
      pass: one.status === 200 && arr(one.json?.items).length === 1 && hundred.status === 200 && arr(hundred.json?.items).length <= 100,
      expected: "limit=1 returns one item; limit=100 returns at most a hundred",
      observed: `limit=1 -> ${arr(one.json?.items).length}; limit=100 -> ${arr(hundred.json?.items).length}`,
      evidence: { requests: ev(one, hundred) },
    });

    const withClosed = arr(hundred.json?.items).map((a) => a?.id);
    const withoutClosed = await GET("/accounts?limit=100", ADMIN());
    const plainIds = arr(withoutClosed.json?.items).map((a) => a?.id);
    const closedInPlain = arr(withoutClosed.json?.items).filter((a) => a?.status === "closed");
    check({
      id: "param-include-closed",
      obligation: "rule:documented-parameters",
      title: "include_closed=true includes closed accounts and its absence excludes them",
      pass:
        withClosed.includes(S.closed) &&
        !plainIds.includes(S.closed) &&
        closedInPlain.length === 0 &&
        plainIds.every((id) => withClosed.includes(id)),
      expected: `${S.closed} present with include_closed=true, absent without it, and no other closed account leaks into the plain listing`,
      observed: `with=${withClosed.length} items (closed present: ${withClosed.includes(S.closed)}), without=${plainIds.length} items, closed leaked: ${JSON.stringify(closedInPlain.map((a) => a?.id))}`,
      evidence: { requests: ev(hundred, withoutClosed) },
    });

    const filtered = await GET(`/transfers?account_id=${S.a2USD}&limit=100`, CA());
    const unfiltered = await GET("/transfers?limit=100", CA());
    const offFilter = arr(filtered.json?.items).filter((t) => t?.source_account_id !== S.a2USD && t?.destination_account_id !== S.a2USD);
    const shouldMatch = arr(unfiltered.json?.items).filter((t) => t?.source_account_id === S.a2USD || t?.destination_account_id === S.a2USD);
    const missing = shouldMatch.filter((t) => !arr(filtered.json?.items).some((f) => f?.id === t?.id));
    check({
      id: "param-account-id-filter-on-transfers",
      obligation: "rule:documented-parameters",
      title: "account_id restricts the collection to transfers naming that account on either side, and drops none of them",
      pass: filtered.status === 200 && offFilter.length === 0 && missing.length === 0 && shouldMatch.length > 0,
      expected: `every item names ${S.a2USD}, and every transfer naming it is returned`,
      observed: `off-filter ${JSON.stringify(offFilter.map((t) => t?.id))}, missing ${JSON.stringify(missing.map((t) => t?.id))}, matched ${shouldMatch.length}`,
      evidence: { requests: ev(filtered, unfiltered) },
    });

    const unknownParam = await GET("/accounts?limit=100&not_a_parameter=1", ADMIN());
    check({
      id: "param-an-unknown-query-parameter-is-ignored",
      obligation: "rule:documented-parameters",
      title: "an unknown query parameter is ignored rather than refused — the declared exception",
      pass:
        unknownParam.status === 200 &&
        JSON.stringify(arr(unknownParam.json?.items).map((a) => a?.id)) === JSON.stringify(plainIds),
      expected: "200 and the same page as without the parameter",
      observed: `${unknownParam.status}, ${arr(unknownParam.json?.items).length} items vs ${plainIds.length}`,
      evidence: { requests: ev(withoutClosed, unknownParam) },
    });

    const badSettleLimit = await POST("/admin/tick", { settle_limit: -1 }, ADMIN());
    check({
      id: "param-settle-limit-is-refused-outside-its-range",
      obligation: "rule:documented-parameters",
      title: "settle_limit is documented as a non-negative integer and a negative one is refused 400",
      pass: badSettleLimit.status === 400,
      expected: "400",
      observed: shape(badSettleLimit),
      evidence: { requests: ev(badSettleLimit) },
    });
  });

  await phase("pagination", "rule:pagination-identity-and-page-discipline", async () => {
    const cases = [
      ["accounts", "/accounts?include_closed=true", 3, ADMIN()],
      ["transfers", "/transfers", 4, ADMIN()],
      ["entries", `/accounts/${S.aUSD}/entries`, 3, CA()],
    ];
    for (const [name, base, limit, who] of cases) {
      const baseline = await GET(`${base}${base.includes("?") ? "&" : "?"}limit=100`, who);
      const baselineIds = arr(baseline.json?.items).map((i) => i?.id);
      const walk = await enumerate(base, limit, who);
      const walked = [...walk.ids];
      const missed = baselineIds.filter((id) => !walk.ids.has(id));
      check({
        id: `pagination-${name}`,
        obligation: "rule:pagination-identity-and-page-discipline",
        title: `enumerating ${name} at limit=${limit} returns no id twice, terminates, never overfills a page, and never claims more after a short page`,
        pass: baseline.status === 200 && walk.problems.length === 0 && walk.pages.length > 1,
        expected: `a clean multi-page walk over ${baselineIds.length} items`,
        observed: walk.problems.length
          ? walk.problems.join(" | ")
          : `${walk.pages.length} pages, ${walked.length} distinct items, terminated`,
        evidence: { requests: ev(baseline, walk.pages) },
      });
      check({
        id: `pagination-${name}-completeness`,
        obligation: "rule:pagination-identity-and-page-discipline",
        title: `an enumeration of ${name} that nothing wrote into returns every item that satisfied the filter when it began`,
        pass: baseline.status === 200 && baselineIds.length > 0 && missed.length === 0,
        expected: `all ${baselineIds.length} items reached by following next_cursor`,
        observed: missed.length ? `missed ${JSON.stringify(missed)}` : `all ${baselineIds.length} items were returned`,
        evidence: { requests: ev(baseline, walk.pages) },
      });
    }

    const closedWalk = await enumerate("/accounts", 3, ADMIN());
    const closedLeak = closedWalk.items.filter((a) => a?.status === "closed");
    check({
      id: "pagination-filter-holds-on-every-page",
      obligation: "rule:pagination-identity-and-page-discipline",
      title: "when the accounts collection is filtered by include_closed, every item on every page satisfies the filter",
      pass: closedWalk.problems.length === 0 && closedLeak.length === 0 && closedWalk.pages.length > 1,
      expected: "no closed account on any page of the unfiltered-by-default enumeration",
      observed: closedLeak.length ? `closed accounts leaked: ${JSON.stringify(closedLeak.map((a) => a?.id))}` : `${closedWalk.pages.length} pages, filter held throughout`,
      evidence: { requests: ev(closedWalk.pages) },
    });
  });

  // =========================================================================
  // Phase 11 — balance agreement and round-trip consistency (quiescent window)
  // =========================================================================
  await phase("balance", "rule:balance-agreement", async () => {
    const listing = await GET("/accounts?limit=100&include_closed=true", ADMIN());
    const accounts = arr(listing.json?.items);
    const disagreements = [];
    const entryRefs = [];
    let checked = 0;
    for (const a of accounts) {
      if (!a?.id) continue;
      const walk = await enumerate(`/accounts/${a.id}/entries`, 100, ADMIN());
      entryRefs.push(...walk.pages);
      if (walk.problems.length) {
        disagreements.push(`${a.id}: could not enumerate entries (${walk.problems.join("; ")})`);
        continue;
      }
      const total = sum(walk.items.map((e) => e?.amount));
      checked++;
      if (!Number.isInteger(a.balance)) disagreements.push(`${a.id}: balance ${JSON.stringify(a.balance)} is not an integer`);
      else if (total !== a.balance) disagreements.push(`${a.id}: balance ${a.balance} but ${walk.items.length} entries sum to ${total}`);
      const nonInt = walk.items.filter((e) => !Number.isInteger(e?.amount));
      if (nonInt.length) disagreements.push(`${a.id}: ${nonInt.length} entries carry a non-integer amount`);
    }
    check({
      id: "balance-equals-the-sum-of-the-entries",
      obligation: "rule:balance-agreement",
      title: "every account's stored balance equals the sum of the amounts of all its ledger entries, system fee accounts included",
      pass: listing.status === 200 && checked > 0 && disagreements.length === 0,
      expected: `all ${accounts.length} accounts agree exactly, with no rounding`,
      observed: disagreements.length ? disagreements.join(" | ") : `${checked} accounts agreed exactly`,
      evidence: { requests: ev(listing, entryRefs) },
    });

    const overdrawn = accounts.filter((a) => Number.isInteger(a?.balance) && a.balance < 0);
    check({
      id: "settlement-no-account-is-left-overdrawn",
      obligation: "rule:settlement",
      title: "funds really were re-checked: after every settlement in this run, no account holds a negative balance",
      pass: listing.status === 200 && accounts.length > 0 && overdrawn.length === 0,
      expected: "no account was allowed to settle itself below zero",
      observed: overdrawn.length
        ? overdrawn.map((a) => `${a.id} = ${a.balance}`).join(", ")
        : `all ${accounts.length} balances are non-negative`,
      evidence: { requests: ev(listing) },
    });

    const feeUsd = accounts.find((a) => a?.id === FEE_USD);
    const feeEur = accounts.find((a) => a?.id === FEE_EUR);
    check({
      id: "balance-fee-accounts-hold-the-fees-they-collected",
      obligation: "rule:balance-agreement",
      title: "the system fee accounts carry a non-negative integer balance made of the fees they collected",
      pass:
        Number.isInteger(feeUsd?.balance) &&
        feeUsd.balance > 0 &&
        Number.isInteger(feeEur?.balance) &&
        feeEur.balance > 0 &&
        feeUsd.kind === "system" &&
        feeEur.kind === "system",
      expected: "both fee accounts exist, are system accounts, and hold a positive integer balance",
      observed: `${FEE_USD}=${JSON.stringify(feeUsd?.balance)} ${FEE_EUR}=${JSON.stringify(feeEur?.balance)}`,
      evidence: { requests: ev(listing) },
    });
  });

  await phase("round-trip", "rule:round-trip-consistency-and-determinism", async () => {
    const pendRead = await GET(`/accounts/${S.pend}`, CA());
    const depRead = await GET(`/deposits/${setDep.json?.id}`, CA());
    const trRead = await GET(`/transfers/${limLast?.json?.id}`, CA());
    const subjects = [
      ["account (never touched since creation)", pendc, pendRead],
      ["deposit", setDep, depRead],
      ["transfer (still pending)", limLast, trRead],
    ];
    const drifted = subjects
      .map(([what, created, read]) => {
        if (!created || !read) return `${what}: no resource to compare`;
        if (read.status !== 200) return `${what}: the later read answered ${shape(read)}`;
        const d = resourceDiff(created.json, read.json);
        return d.length ? `${what}: ${d.join(", ")}` : null;
      })
      .filter(Boolean);
    check({
      id: "roundtrip-a-created-resource-reads-back-unchanged",
      obligation: "rule:round-trip-consistency-and-determinism",
      title: "a resource returned by the request that created it is the resource a later read returns, field for field",
      pass: drifted.length === 0,
      expected: "no field differs between the creation response and the later read",
      observed: drifted.length ? drifted.join(" || ") : "the account, the deposit and the transfer all read back identical",
      evidence: { requests: ev(pendc, pendRead, setDep, depRead, limLast, trRead) },
    });
  });

  // =========================================================================
  // Phase 12 — privileged routes (kept last: a broken guard here would be destructive)
  // =========================================================================
  await phase("admin-guard", "rule:ownership", async () => {
    const tickNoAuth = await POST("/admin/tick", {});
    const tickCustomer = await POST("/admin/tick", {}, CA());
    const resetNoAuth = await POST("/admin/reset", { seed: "hostile" });
    const resetCustomer = await POST("/admin/reset", { seed: "hostile" }, CA());
    check({
      id: "ownership-admin-routes-reject-customers-and-anonymous-callers",
      obligation: "rule:ownership",
      title: "the /admin routes accept the administrator only: 401 without a credential, 403 with a customer's",
      pass:
        tickNoAuth.status === 401 &&
        resetNoAuth.status === 401 &&
        tickCustomer.status === 403 &&
        resetCustomer.status === 403,
      expected: "401, 401, 403, 403",
      observed: `tick anon ${shape(tickNoAuth)} | reset anon ${shape(resetNoAuth)} | tick customer ${shape(tickCustomer)} | reset customer ${shape(resetCustomer)}`,
      evidence: { requests: ev(tickNoAuth, resetNoAuth, tickCustomer, resetCustomer) },
    });
  });

  // =========================================================================
  // Phase 13 — determinism: reset to the same seed and replay the prelude
  // =========================================================================
  await phase("determinism", "rule:round-trip-consistency-and-determinism", async () => {
    const reset2 = await POST("/admin/reset", { seed: SEED }, ADMIN());
    const again = await prelude();
    const pairs = [
      ["account", first.a, again.a],
      ["activate", first.act, again.act],
      ["deposit", first.dep, again.dep],
      ["second account", first.b, again.b],
      ["second activate", first.bact, again.bact],
      ["transfer", first.tr, again.tr],
    ];
    const drift = pairs
      .map(([what, x, y]) => {
        if (x.status !== y.status) return `${what}: ${x.status} then ${y.status}`;
        const d = resourceDiff(x.json, y.json);
        return d.length ? `${what}: ${d.join(", ")}` : null;
      })
      .filter(Boolean);
    check({
      id: "determinism-the-same-sequence-after-the-same-reset-produces-the-same-world",
      obligation: "rule:round-trip-consistency-and-determinism",
      title: "after POST /admin/reset with the same seed, the same six requests produce the same identifiers, timestamps and resources",
      pass:
        reset1.status === 200 &&
        reset2.status === 200 &&
        resourceDiff(reset1.json, reset2.json).length === 0 &&
        drift.length === 0,
      expected: "identical resources, field for field, including ids and timestamps",
      observed: drift.length
        ? drift.join(" || ")
        : `all six replayed identically (e.g. ${JSON.stringify(again.a.json?.id)} at ${JSON.stringify(again.a.json?.created_at)})`,
      evidence: { requests: ev(reset1, first.a, first.dep, first.tr, reset2, again.a, again.dep, again.tr) },
    });
  });

  // =========================================================================
  // Phase 14 — the error envelope, swept over every exchange this run made
  // =========================================================================
  const refusals = all.filter((r) => typeof r.status === "number" && r.status >= 400);
  const serverErrors = all.filter((r) => typeof r.status === "number" && r.status >= 500);
  const transportFailures = all.filter((r) => r.transportError || r.status === 0);
  const badEnvelopes = [];
  for (const r of refusals) {
    const p = envelopeProblem(r);
    if (p) badEnvelopes.push({ r, why: `${r.method ?? "?"} ${r.path ?? r.url} ${r.status}: ${p}` });
  }
  check({
    id: "envelope-every-refusal-uses-the-one-error-envelope",
    obligation: "rule:error-shape-and-the-status-split-three-rules",
    title: 'every 4xx/5xx body this run provoked is {"error":{"code","message","details"?}} with string code and message',
    pass: refusals.length > 0 && badEnvelopes.length === 0,
    expected: `all ${refusals.length} refusals carry the envelope and nothing else`,
    observed: badEnvelopes.length ? badEnvelopes.map((b) => b.why).join(" | ") : `${refusals.length} refusals all carried the envelope`,
    evidence: { requests: ev(badEnvelopes.length ? badEnvelopes.map((b) => b.r) : refusals.slice(0, 12)) },
  });

  const successWithError = all.filter((r) => r.ok && r.json && typeof r.json === "object" && !Array.isArray(r.json) && "error" in r.json);
  check({
    id: "envelope-no-2xx-carries-a-failure-and-no-operation-answers-5xx",
    obligation: "rule:error-shape-and-the-status-split-three-rules",
    title: "a request the service refuses is always reported with a 4xx status — never a 2xx carrying a failure, and no operation answers 5xx",
    pass: serverErrors.length === 0 && successWithError.length === 0 && transportFailures.length === 0,
    expected: "no 5xx, no 2xx body carrying an error, no transport failure",
    observed:
      serverErrors.length || successWithError.length || transportFailures.length
        ? `5xx: ${serverErrors.map((r) => `${r.path} ${r.status}`).join(",") || "none"}; 2xx-with-error: ${successWithError.map((r) => r.path).join(",") || "none"}; transport: ${transportFailures.map((r) => `${r.path} ${r.transportError}`).join(",") || "none"}`
        : `${all.length} exchanges, none of them a 5xx or a dressed-up failure`,
    evidence: {
      requests: ev(
        serverErrors.length || successWithError.length || transportFailures.length
          ? [...serverErrors, ...successWithError, ...transportFailures]
          : all.slice(0, 6)
      ),
    },
  });

  check.advisory({
    title: "request budget",
    detail: `the suite made ${all.length} recorded requests of the ${client.budget?.limit} allowed.`,
  });
}
