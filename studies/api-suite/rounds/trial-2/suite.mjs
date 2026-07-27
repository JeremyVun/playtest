// Minibank ledger — script suite.
//
// Expectations come from handout/INVARIANTS.md and handout/openapi.json only.
// Every check names one of the obligation ids in handout/obligations.json and
// cites the HAR entries that prove it.

const OB = {
  CONS: "rule:conservation",
  FEE: "rule:the-fee-schedule",
  IDEM: "rule:idempotency",
  LIFE: "rule:lifecycle-legality",
  SETL: "rule:settlement",
  OWN: "rule:ownership",
  PAGE: "rule:pagination-identity-and-page-discipline",
  PARAM: "rule:documented-parameters",
  REF: "rule:reference-integrity",
  DAILY: "rule:the-daily-limit",
  ERR: "rule:error-shape-and-the-status-split-three-rules",
  BAL: "rule:balance-agreement",
  RT: "rule:round-trip-consistency-and-determinism",
};

const SEED = "ledger-dev-seed";
const DAILY_LIMIT = 100000;
const FEE_USD = "acc_fee_usd";
const FEE_EUR = "acc_fee_eur";
const MISSING_ACC = "acc_absent_fixture";
const MISSING_TR = "tr_absentfixture";

// 25 + round_half_up(amount * 15 / 10000), amounts are positive integers.
const feeFor = (amount) => 25 + Math.floor((amount * 15 + 5000) / 10000);

export default async function ({ client, check }) {
  // ---------------------------------------------------------------- plumbing
  const S = (n) => client.secret(n);
  const ADMIN = () => ({ authorization: S("LEDGER_ADMIN_TOKEN") });
  const CA = () => ({ authorization: S("LEDGER_CUSTOMER_TOKEN") });
  const CB = () => ({ authorization: S("LEDGER_CUSTOMER_B_TOKEN") });

  const traffic = [];
  async function rq(method, path, opts = {}) {
    let r;
    try {
      r = await client.request(method, path, opts);
    } catch (e) {
      r = {
        ref: null, method, path, status: 0, headers: {}, text: "",
        json: null, ok: false, clientError: String((e && e.message) || e),
      };
    }
    traffic.push(r);
    return r;
  }
  const GET = (p, o) => rq("GET", p, o);
  const POST = (p, o) => rq("POST", p, o);

  const R = (...rs) =>
    rs
      .flat(3)
      .map((x) => (x && typeof x === "object" ? x.ref : x))
      .filter((v) => Number.isInteger(v));

  const usedIds = new Set();
  function ck(id, obligation, title, pass, expected, observed, evidence, subject, note) {
    let key = id;
    let n = 2;
    while (usedIds.has(key)) key = `${id}-${n++}`;
    usedIds.add(key);
    try {
      check({
        id: key,
        obligation,
        title,
        pass: pass === true,
        expected: String(expected),
        observed: String(observed),
        ...(note ? { note: String(note) } : {}),
        evidence: {
          requests: R(evidence ?? []),
          ...(subject === undefined ? {} : { subject }),
        },
      });
    } catch (e) {
      check.advisory({
        title: `check ${key} could not be recorded`,
        detail: String((e && e.message) || e),
      });
    }
  }

  function adv(title, detail, evidence) {
    try {
      check.advisory({ title, detail, evidence: { requests: R(evidence ?? []) } });
    } catch {
      /* an advisory gates nothing; never let it break the run */
    }
  }

  const shown = (v) => {
    try {
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : s.length > 700 ? `${s.slice(0, 700)}…` : s;
    } catch {
      return String(v);
    }
  };
  const rdesc = (r) =>
    !r
      ? "no response"
      : r.clientError
        ? `client error ${r.clientError}`
        : r.transportError
          ? `transport error ${r.transportError} (status ${r.status})`
          : `HTTP ${r.status} ${shown(r.json ?? r.text ?? null)}`;

  const idOf = (r, fallback) => {
    const v = r?.json?.id;
    return typeof v === "string" && v.length ? v : fallback;
  };
  const items = (r) => (Array.isArray(r?.json?.items) ? r.json.items : []);

  function normalize(v) {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (v[k] === null || v[k] === undefined) continue; // absent === null
        out[k] = normalize(v[k]);
      }
      return out;
    }
    return v;
  }
  const eqDeep = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  function fieldDiff(a, b) {
    const na = normalize(a) ?? {};
    const nb = normalize(b) ?? {};
    const keys = new Set([...Object.keys(na || {}), ...Object.keys(nb || {})]);
    const out = [];
    for (const k of keys) {
      if (JSON.stringify(na[k]) !== JSON.stringify(nb[k])) {
        out.push(`${k}: ${shown(na[k])} vs ${shown(nb[k])}`);
      }
    }
    return out;
  }

  // Every deliberately refused request, for the aggregate status-split checks.
  const refusals = [];
  function split(id, title, r, wantStatus, wantCodeHint) {
    refusals.push({ id, r, wantStatus });
    ck(
      `split-${id}`,
      OB.ERR,
      title,
      r?.status === wantStatus,
      `HTTP ${wantStatus}${wantCodeHint ? ` (${wantCodeHint})` : ""}`,
      rdesc(r),
      [r],
    );
    return r;
  }

  function envelopeProblem(r) {
    if (!r || r.status < 400) return null;
    if (r.parseError) return "body did not parse as JSON";
    const b = r.json;
    if (!b || typeof b !== "object" || Array.isArray(b)) return `body is not a JSON object (${shown(r.text)})`;
    const top = Object.keys(b);
    if (top.length !== 1 || top[0] !== "error") return `top-level keys ${shown(top)}`;
    const e = b.error;
    if (!e || typeof e !== "object" || Array.isArray(e)) return "error is not an object";
    if (typeof e.code !== "string") return `error.code is ${shown(e.code)}`;
    if (typeof e.message !== "string") return `error.message is ${shown(e.message)}`;
    const extra = Object.keys(e).filter((k) => k !== "code" && k !== "message" && k !== "details");
    if (extra.length) return `error object has extra keys ${shown(extra)}`;
    if ("details" in e && (e.details === null || typeof e.details !== "object" || Array.isArray(e.details))) {
      return `error.details is ${shown(e.details)}`;
    }
    return null;
  }

  async function enumerate(basePath, limit, headersFn, cap = 40) {
    const pages = [];
    let cursor = null;
    for (let i = 0; i < cap; i++) {
      const sep = basePath.includes("?") ? "&" : "?";
      const q = `${basePath}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const r = await GET(q, { headers: headersFn() });
      pages.push(r);
      const nc = r.json?.next_cursor;
      cursor = typeof nc === "string" && nc.length ? nc : null;
      if (!cursor) return { pages, terminated: true };
      if (r.status !== 200) return { pages, terminated: true };
    }
    return { pages, terminated: false };
  }

  function paginationChecks(tag, obligationTitle, limit, pages, terminated, baselineIds) {
    const evid = pages;
    const badPages = pages.map((p, i) => ({ i, status: p.status })).filter((x) => x.status !== 200);
    ck(`page-${tag}-pages-answered`, OB.PAGE,
      `${obligationTitle}: every page of the enumeration answers 200 with an items array`,
      badPages.length === 0 && pages.length > 0 && pages.every((p) => Array.isArray(p.json?.items)),
      "HTTP 200 and a well-formed page on every step of the enumeration",
      badPages.length ? `pages ${shown(badPages)}` : `${pages.length} page(s), all 200`,
      evid);

    const seenOrder = [];
    const dupes = [];
    const seen = new Set();
    for (const p of pages) {
      for (const it of items(p)) {
        const id = it?.id;
        seenOrder.push(id);
        if (seen.has(id)) dupes.push(id);
        seen.add(id);
      }
    }
    ck(`page-${tag}-no-duplicates`, OB.PAGE,
      `${obligationTitle}: no item id is returned twice in one enumeration`,
      dupes.length === 0, "every item id appears at most once",
      dupes.length ? `duplicated ids ${shown(dupes)} across ${pages.length} pages` : `${seenOrder.length} items over ${pages.length} pages, all distinct`,
      evid, { limit, pages: pages.length });

    ck(`page-${tag}-terminates`, OB.PAGE,
      `${obligationTitle}: following next_cursor terminates`,
      terminated === true, "the enumeration reaches a page with next_cursor null",
      terminated ? `terminated after ${pages.length} page(s)` : `still had a next_cursor after ${pages.length} pages (cap reached)`,
      evid);

    const oversize = pages
      .map((p, i) => ({ i, n: items(p).length, status: p.status }))
      .filter((x) => x.n > limit);
    ck(`page-${tag}-respects-limit`, OB.PAGE,
      `${obligationTitle}: no page carries more items than the requested limit`,
      oversize.length === 0, `every page has at most ${limit} items`,
      oversize.length ? `pages ${shown(oversize)} exceeded the limit` : `page sizes ${shown(pages.map((p) => items(p).length))}`,
      evid);

    const badShort = pages
      .map((p, i) => ({ i, n: items(p).length, next: p.json?.next_cursor ?? null }))
      .filter((x) => x.n < limit && x.next !== null);
    ck(`page-${tag}-short-page-is-last`, OB.PAGE,
      `${obligationTitle}: a page shorter than the limit is the last page`,
      badShort.length === 0, "a short page carries next_cursor null",
      badShort.length ? `short pages that still promised more: ${shown(badShort)}` : `page sizes ${shown(pages.map((p) => items(p).length))} with final next_cursor ${shown(pages[pages.length - 1]?.json?.next_cursor ?? null)}`,
      evid);

    if (baselineIds) {
      const missed = baselineIds.filter((id) => !seen.has(id));
      ck(`page-${tag}-complete`, OB.PAGE,
        `${obligationTitle}: the enumeration returns every item that qualified when it began`,
        baselineIds.length > 0 && missed.length === 0, `all ${baselineIds.length} items reachable by cursor`,
        missed.length ? `missing ${shown(missed)}` : `all ${baselineIds.length} items were returned`,
        evid, { baseline: baselineIds.length, enumerated: seen.size });
    }
    return { ids: seenOrder, set: seen };
  }

  async function phase(name, fn) {
    try {
      await fn();
    } catch (e) {
      check.defect({
        message: `suite phase "${name}" threw and could not build the state its checks needed`,
        detail: String((e && e.stack) || e),
      });
    }
  }

  // =====================================================================
  // 0. Liveness and the document
  // =====================================================================
  const health = await GET("/health", {});
  const doc = await GET("/openapi.json", {});

  // =====================================================================
  // 1. Determinism: the same sequence after the same reset twice over
  // =====================================================================
  const detRuns = [];
  await phase("determinism", async () => {
    for (let pass = 0; pass < 2; pass++) {
      const rs = [];
      rs.push(await POST("/admin/reset", { headers: ADMIN(), body: { seed: SEED } }));
      const src = await POST("/accounts", { headers: CA(), body: { owner: "det-src", currency: "USD" } });
      rs.push(src);
      const srcId = idOf(src, MISSING_ACC);
      rs.push(await POST(`/accounts/${srcId}/activate`, { headers: CA() }));
      rs.push(await POST("/deposits", { headers: CA(), body: { account_id: srcId, amount: 1234 } }));
      const dst = await POST("/accounts", { headers: CA(), body: { owner: "det-dst", currency: "USD" } });
      rs.push(dst);
      const dstId = idOf(dst, MISSING_ACC);
      rs.push(await POST(`/accounts/${dstId}/activate`, { headers: CA() }));
      rs.push(await POST("/transfers", { headers: CA(), body: { source_account_id: srcId, destination_account_id: dstId, amount: 1000 } }));
      rs.push(await POST("/admin/tick", { headers: ADMIN(), body: {} }));
      rs.push(await GET(`/accounts/${srcId}/entries?limit=100`, { headers: CA() }));
      detRuns.push(rs);
    }
    const [p1, p2] = detRuns;
    const bodies1 = p1.map((r) => r.json);
    const bodies2 = p2.map((r) => r.json);
    const same = eqDeep(bodies1, bodies2);
    const differing = [];
    for (let i = 0; i < bodies1.length; i++) {
      if (!eqDeep(bodies1[i], bodies2[i])) differing.push(`step ${i}: ${shown(fieldDiff(bodies1[i], bodies2[i]))}`);
    }
    ck("determinism-replay", OB.RT,
      "the same request sequence after the same seeded reset yields identical ids, timestamps and resources",
      same,
      "both replays return byte-identical resources (ids, created_at, entry ids and sequences)",
      same ? "the two replays agreed on all 9 steps" : `divergence: ${shown(differing)}`,
      [p1, p2],
      { steps: p1.length });
  });

  // =====================================================================
  // 2. Canonical reset — every check below starts from here
  // =====================================================================
  const reset = await POST("/admin/reset", { headers: ADMIN(), body: { seed: SEED } });
  ck("reset-is-clean", OB.RT,
    "POST /admin/reset returns the seeded initial state",
    reset.status === 200 && reset.json?.ok === true && reset.json?.seed === SEED && reset.json?.day === 0,
    `HTTP 200 {ok:true, seed:"${SEED}", day:0}`, rdesc(reset), [reset]);

  // =====================================================================
  // 3. Admin-only routes, and unauthenticated access
  // =====================================================================
  await phase("admin-and-auth", async () => {
    const custTick = await POST("/admin/tick", { headers: CA(), body: { settle_limit: 0 } });
    split("customer-tick-forbidden", "a customer principal calling POST /admin/tick is 403", custTick, 403, "forbidden");
    ck("own-admin-tick-is-admin-only", OB.OWN,
      "only the administrator may advance settlement",
      custTick.status === 403, "HTTP 403 for a customer principal", rdesc(custTick), [custTick]);

    const custReset = await POST("/admin/reset", { headers: CB(), body: { seed: "hostile-seed" } });
    split("customer-reset-forbidden", "a customer principal calling POST /admin/reset is 403", custReset, 403, "forbidden");
    ck("own-admin-reset-is-admin-only", OB.OWN,
      "only the administrator may reset the service",
      custReset.status === 403, "HTTP 403 for a customer principal", rdesc(custReset), [custReset]);

    const noAuth = await GET("/accounts", {});
    split("missing-credential-get", "a request with no credential is 401", noAuth, 401, "unauthorized");
    ck("err-401-www-authenticate", OB.ERR,
      "a 401 response carries a WWW-Authenticate header",
      typeof noAuth.headers?.["www-authenticate"] === "string" && noAuth.headers["www-authenticate"].length > 0,
      "WWW-Authenticate present on 401", `headers ${shown(noAuth.headers)}`, [noAuth]);

    const noAuthPost = await POST("/accounts", { body: { owner: "nobody", currency: "USD" } });
    split("missing-credential-post", "an unauthenticated write is 401", noAuthPost, 401, "unauthorized");
    const badTok = await GET("/accounts", { headers: { authorization: "Bearer not-a-real-token" } });
    split("unknown-credential", "an unrecognized bearer token is 401", badTok, 401, "unauthorized");
    ck("own-unauthenticated-sees-nothing", OB.OWN,
      "an unauthenticated caller is shown no account state",
      noAuth.status === 401 && !Array.isArray(noAuth.json?.items),
      "401 with no items array", rdesc(noAuth), [noAuth, badTok]);
  });

  // =====================================================================
  // 4. Fixtures
  // =====================================================================
  const acc = {};
  const created = {};
  const deposits = {};
  await phase("fixtures", async () => {
    const spec = [
      ["A1", CA, { owner: "ada-main", currency: "USD" }, true, 200000],
      ["A2", CA, { owner: "ada-dest", currency: "USD" }, true, 0],
      ["AP", CA, { owner: "ada-pending", currency: "USD" }, false, 0],
      ["AC", CA, { owner: "ada-closing", currency: "USD" }, true, 500],
      ["AE", CA, { owner: "ada-eur", currency: "EUR" }, true, 60000],
      ["AF", CA, { owner: "ada-fees", currency: "USD" }, true, 100000],
      ["AD", CA, { owner: "ada-daily", currency: "USD" }, true, 400000],
      ["AS", CA, { owner: "ada-settle", currency: "USD" }, true, 60000],
      ["AG", CA, { owner: "ada-order", currency: "USD" }, true, 30000],
      ["AK", CA, { owner: "ada-idem", currency: "USD" }, true, 30000],
      ["AI", CA, { owner: "ada-poor", currency: "USD" }, true, 0],
      ["B1", CB, { owner: "bob-main", currency: "USD" }, true, 40000],
      ["BE", CB, { owner: "bob-eur", currency: "EUR" }, true, 0],
    ];
    for (const [key, who, body, activate, fund] of spec) {
      const c = await POST("/accounts", { headers: who(), body });
      created[key] = c;
      acc[key] = idOf(c, MISSING_ACC);
      if (activate) await POST(`/accounts/${acc[key]}/activate`, { headers: who() });
      if (fund > 0) deposits[key] = await POST("/deposits", { headers: who(), body: { account_id: acc[key], amount: fund } });
    }
    // Admin opens an account on another principal's behalf.
    const bx = await POST("/accounts", {
      headers: ADMIN(),
      body: { owner: "bob-by-admin", currency: "USD", owner_principal: "customer_b" },
    });
    created.BX = bx;
    acc.BX = idOf(bx, MISSING_ACC);
    await POST(`/accounts/${acc.BX}/activate`, { headers: CB() });

    const a1 = created.A1;
    ck("life-new-account-is-pending", OB.LIFE,
      "a newly created account is 'pending' and holds no money",
      a1?.status === 201 && a1.json?.status === "pending" && a1.json?.balance === 0 && a1.json?.activated_at == null,
      'HTTP 201 with status "pending", balance 0, activated_at null', rdesc(a1), [a1]);

    ck("own-admin-may-open-for-another-principal", OB.OWN,
      "the administrator may open an account owned by another principal",
      bx?.status === 201 && bx.json?.owner_principal === "customer_b",
      'HTTP 201 with owner_principal "customer_b"', rdesc(bx), [bx]);
  });

  const missingFixtures = Object.entries(acc).filter(([, v]) => v === MISSING_ACC).map(([k]) => k);
  ck("fixtures-available", OB.LIFE,
    "the accounts the rest of the suite transacts against were created and activated",
    missingFixtures.length === 0,
    "every fixture account created with an id",
    missingFixtures.length ? `the service did not return an id for ${shown(missingFixtures)}` : `${Object.keys(acc).length} fixture accounts created`,
    Object.values(created));

  // =====================================================================
  // 5. Round-trip consistency: created resource === later read
  // =====================================================================
  await phase("round-trip", async () => {
    const readA1 = await GET(`/accounts/${acc.A1}`, { headers: CA() });
    const createdBody = { ...(created.A1?.json ?? {}) };
    // balance moved because we funded it; compare the immutable identity fields.
    const stable = (o) => o && ({
      id: o.id, kind: o.kind, owner: o.owner, owner_principal: o.owner_principal,
      currency: o.currency, created_at: o.created_at,
    });
    ck("rt-account-create-vs-read", OB.RT,
      "the account returned by POST /accounts is the account GET /accounts/{id} returns",
      readA1.status === 200 && eqDeep(stable(createdBody), stable(readA1.json)),
      "identical id, kind, owner, owner_principal, currency and created_at",
      readA1.status === 200 ? `diff ${shown(fieldDiff(stable(createdBody), stable(readA1.json)))}` : rdesc(readA1),
      [created.A1, readA1], { created: stable(createdBody), read: stable(readA1.json) });

    const dep = deposits.A1;
    const depId = idOf(dep, "dep_absentfixture");
    const readDep = await GET(`/deposits/${depId}`, { headers: CA() });
    ck("rt-deposit-create-vs-read", OB.RT,
      "the deposit returned by POST /deposits is the deposit GET /deposits/{id} returns, field for field",
      readDep.status === 200 && eqDeep(dep?.json, readDep.json),
      "identical resource on both reads",
      readDep.status === 200 ? `diff ${shown(fieldDiff(dep?.json, readDep.json))}` : rdesc(readDep),
      [dep, readDep]);

    ck("rt-deposit-settles-immediately", OB.RT,
      "a deposit is returned settled, with its amount and currency echoed",
      dep?.status === 201 && dep.json?.status === "settled" && dep.json?.amount === 200000 && dep.json?.currency === "USD" && dep.json?.account_id === acc.A1,
      'HTTP 201 {status:"settled", amount:200000, currency:"USD"}', rdesc(dep), [dep]);
  });

  // =====================================================================
  // 6. Ownership
  // =====================================================================
  await phase("ownership", async () => {
    const a1 = acc.A1;
    const probes = [
      ["read-other-account", await GET(`/accounts/${a1}`, { headers: CB() }), "reading another principal's account is refused"],
      ["read-other-entries", await GET(`/accounts/${a1}/entries`, { headers: CB() }), "reading another principal's ledger entries is refused"],
      ["fund-other-account", await POST("/deposits", { headers: CB(), body: { account_id: a1, amount: 10 } }), "funding another principal's account is refused"],
      ["activate-other-account", await POST(`/accounts/${acc.AP}/activate`, { headers: CB() }), "activating another principal's account is refused"],
      ["close-other-account", await POST(`/accounts/${acc.A2}/close`, { headers: CB() }), "closing another principal's account is refused"],
      ["spend-from-other-account", await POST("/transfers", { headers: CB(), body: { source_account_id: a1, destination_account_id: acc.B1, amount: 10 } }), "spending from another principal's account is refused"],
      ["read-other-deposit", await GET(`/deposits/${idOf(deposits.A1, "dep_absentfixture")}`, { headers: CB() }), "reading a deposit into another principal's account is refused"],
    ];
    for (const [tag, r, title] of probes) {
      ck(`own-${tag}`, OB.OWN, title, r.status === 403, "HTTP 403", rdesc(r), [r]);
      split(`forbidden-${tag}`, `${title} with 403`, r, 403, "forbidden");
    }

    // No part of the target account's state comes back with the refusal.
    const secretBits = ["ada-main", "customer_a", "200000", "\"balance\"", "\"owner\"", "\"status\""];
    const leaks = [];
    for (const [tag, r] of probes) {
      const body = r.text ?? "";
      for (const bit of secretBits) if (body.includes(bit)) leaks.push(`${tag}: leaked ${bit}`);
    }
    ck("own-refusal-discloses-nothing", OB.OWN,
      "a refusal to reach another principal's account carries no part of that account's state",
      leaks.length === 0,
      "no owner, owner_principal, balance or status of the target account in the 403 body",
      leaks.length ? shown(leaks) : `${probes.length} refusal bodies carried only the id the caller supplied`,
      probes.map(([, r]) => r));

    // Fee accounts: readable by every principal, actable by none.
    const feeRead = await GET(`/accounts/${FEE_USD}`, { headers: CA() });
    const feeEntries = await GET(`/accounts/${FEE_USD}/entries?limit=100`, { headers: CB() });
    ck("own-fee-account-readable", OB.OWN,
      "the system fee accounts are readable by every principal",
      feeRead.status === 200 && feeRead.json?.kind === "system" && feeEntries.status === 200 && Array.isArray(feeEntries.json?.items),
      "HTTP 200 for both a customer read of the fee account and of its entries",
      `${rdesc(feeRead)} / entries ${feeEntries.status}`, [feeRead, feeEntries]);

    const feeFund = await POST("/deposits", { headers: CA(), body: { account_id: FEE_USD, amount: 10 } });
    const feeActivate = await POST(`/accounts/${FEE_EUR}/activate`, { headers: CA() });
    ck("own-fee-account-not-actable", OB.OWN,
      "the system fee accounts are actable by no customer principal",
      feeFund.status === 403 && feeActivate.status === 403,
      "HTTP 403 for both a deposit into and an activation of a system fee account",
      `deposit ${rdesc(feeFund)} / activate ${rdesc(feeActivate)}`, [feeFund, feeActivate]);
    split("fee-account-fund", "acting on a system fee account is 403", feeFund, 403, "forbidden");

    // A customer may not open an account for someone else.
    const sneaky = await POST("/accounts", { headers: CA(), body: { owner: "sneaky", currency: "USD", owner_principal: "customer_b" } });
    ck("own-customer-cannot-open-for-another", OB.OWN,
      "a customer principal may not open an account on another principal's behalf",
      sneaky.status === 403, "HTTP 403", rdesc(sneaky), [sneaky]);
    split("customer-owner-principal", "a customer supplying owner_principal is 403", sneaky, 403, "forbidden");

    // The account admin opened for customer_b is reachable by B and not by A.
    const bReadsBx = await GET(`/accounts/${acc.BX}`, { headers: CB() });
    const aReadsBx = await GET(`/accounts/${acc.BX}`, { headers: CA() });
    ck("own-owner_principal-decides-reach", OB.OWN,
      "an account opened on a principal's behalf is reachable by that principal and by no other customer",
      bReadsBx.status === 200 && bReadsBx.json?.owner_principal === "customer_b" && aReadsBx.status === 403,
      "owner reads 200, the other customer reads 403",
      `owner ${rdesc(bReadsBx)} / other ${rdesc(aReadsBx)}`, [bReadsBx, aReadsBx]);

    // Listing is scoped to the caller.
    const bList = await GET("/accounts?limit=100&include_closed=true", { headers: CB() });
    const foreign = items(bList).filter((x) => x.owner_principal !== "customer_b" && x.kind !== "system");
    ck("own-listing-is-scoped", OB.OWN,
      "GET /accounts shows a customer only its own accounts (plus the public system accounts)",
      bList.status === 200 && foreign.length === 0 && items(bList).length > 0,
      "no account owned by another customer principal in the listing",
      foreign.length ? `leaked ${shown(foreign.map((x) => [x.id, x.owner_principal]))}` : `${items(bList).length} items, all customer_b or system`,
      [bList]);

    // Admin is unrestricted.
    const adminRead = await GET(`/accounts/${a1}`, { headers: ADMIN() });
    ck("own-admin-unrestricted", OB.OWN,
      "the administrator reaches an account it does not own",
      adminRead.status === 200 && adminRead.json?.id === a1,
      "HTTP 200 with the account", rdesc(adminRead), [adminRead]);
  });

  // =====================================================================
  // 7. 404: an identifier that names nothing
  // =====================================================================
  await phase("not-found", async () => {
    const probes = [
      ["account-admin", await GET(`/accounts/${MISSING_ACC}`, { headers: ADMIN() }), "an unknown account id is 404 for the administrator"],
      ["account-customer", await GET(`/accounts/${MISSING_ACC}`, { headers: CB() }), "an unknown account id is 404 for a customer too, not 403"],
      ["entries", await GET(`/accounts/${MISSING_ACC}/entries`, { headers: CA() }), "an unknown account id after a resource-scoped path is 404"],
      ["transfer", await GET(`/transfers/${MISSING_TR}`, { headers: CA() }), "an unknown transfer id is 404"],
      ["deposit", await GET("/deposits/dep_absentfixture", { headers: CA() }), "an unknown deposit id is 404"],
      ["cancel", await POST(`/transfers/${MISSING_TR}/cancel`, { headers: CA() }), "cancelling an unknown transfer is 404"],
      ["activate", await POST(`/accounts/${MISSING_ACC}/activate`, { headers: CA() }), "activating an unknown account is 404"],
      ["close", await POST(`/accounts/${MISSING_ACC}/close`, { headers: CA() }), "closing an unknown account is 404"],
      ["deposit-target", await POST("/deposits", { headers: CA(), body: { account_id: MISSING_ACC, amount: 10 } }), "depositing into an unknown account is 404"],
      ["transfer-target", await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: MISSING_ACC, amount: 10 } }), "transferring to an unknown account is 404"],
    ];
    for (const [tag, r, title] of probes) split(`404-${tag}`, title, r, 404, "*_not_found");
  });

  // =====================================================================
  // 8. 400: malformed, unparseable, out-of-range
  // =====================================================================
  await phase("bad-request", async () => {
    const badJson = await POST("/accounts", { headers: CA(), rawBody: "{ this is not json", contentType: "application/json" });
    split("400-unparseable", "an unparseable body is 400", badJson, 400, "invalid_json");

    const l0 = await GET("/accounts?limit=0", { headers: ADMIN() });
    const l101 = await GET("/accounts?limit=101", { headers: ADMIN() });
    const lAbc = await GET("/transfers?limit=abc", { headers: ADMIN() });
    const lNeg = await GET(`/accounts/${acc.A1}/entries?limit=-1`, { headers: CA() });
    for (const [tag, r] of [["limit-0", l0], ["limit-101", l101], ["limit-nan", lAbc], ["limit-negative", lNeg]]) {
      split(`400-${tag}`, `limit outside its documented range (${tag}) is 400`, r, 400, "invalid_limit");
    }
    ck("param-limit-range-enforced", OB.PARAM,
      "limit is refused outside its documented range of 1..100",
      [l0, l101, lAbc, lNeg].every((r) => r.status === 400),
      "HTTP 400 for limit=0, limit=101, limit=abc and limit=-1",
      shown([l0.status, l101.status, lAbc.status, lNeg.status]), [l0, l101, lAbc, lNeg]);

    const badCursor = await GET("/accounts?cursor=not-a-cursor", { headers: ADMIN() });
    split("400-cursor", "a cursor the endpoint never issued is 400", badCursor, 400, "invalid_cursor");

    const unknownQuery = await GET("/accounts?limit=100&bogus=1&include_closed=false", { headers: ADMIN() });
    const plain = await GET("/accounts?limit=100&include_closed=false", { headers: ADMIN() });
    ck("param-unknown-query-ignored", OB.PARAM,
      "an unknown query parameter is ignored rather than refused",
      unknownQuery.status === 200 && plain.status === 200 && items(plain).length > 0 &&
        eqDeep(items(unknownQuery).map((x) => x.id), items(plain).map((x) => x.id)),
      "HTTP 200 and the same collection as the request without it",
      `with ${unknownQuery.status}/${items(unknownQuery).length} items, without ${plain.status}/${items(plain).length} items`,
      [unknownQuery, plain]);

    const limit1 = await GET("/accounts?limit=1", { headers: ADMIN() });
    ck("param-limit-bounds-page", OB.PARAM,
      "limit bounds the page size",
      limit1.status === 200 && items(limit1).length === 1,
      "HTTP 200 with exactly 1 item for limit=1",
      `${items(limit1).length} items`, [limit1]);
  });

  // =====================================================================
  // 9. 422: well-formed requests a business rule refuses
  // =====================================================================
  await phase("business-refusals", async () => {
    const mismatch = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: acc.BE, amount: 10 } });
    split("422-currency-mismatch", "a cross-currency transfer is 422", mismatch, 422, "currency_mismatch");

    const wrongAssert = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: acc.A2, amount: 10, currency: "EUR" } });
    split("422-currency-assertion", "a currency assertion that disagrees with the source account is 422", wrongAssert, 422, "currency_mismatch");
    ck("param-currency-assertion", OB.PARAM,
      "the optional currency assertion on POST /transfers is honoured: a mismatch is refused",
      wrongAssert.status === 422, "HTTP 422 for currency:\"EUR\" against a USD source", rdesc(wrongAssert), [wrongAssert]);

    const selfTr = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: acc.A1, amount: 10 } });
    split("422-same-account", "a transfer to the source account itself is 422", selfTr, 422, "same_account");

    const zero = await POST("/deposits", { headers: CA(), body: { account_id: acc.A1, amount: 0 } });
    split("422-zero-amount", "a deposit of 0 is refused", zero, 422, "invalid_amount");
    const negative = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: acc.A2, amount: -100 } });
    split("422-negative-amount", "a negative transfer amount is refused", negative, 422, "invalid_amount");

    // AI is active and empty: this is a funds refusal, not a daily-limit one.
    const poor = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AI, destination_account_id: acc.A2, amount: 1000 } });
    split("422-insufficient-funds", "a transfer the source cannot cover is 422", poor, 422, "insufficient_funds");
    ck("life-unfunded-source-creates-nothing", OB.LIFE,
      "a transfer refused for want of funds is not created",
      poor.status === 422 && poor.json?.id === undefined,
      "HTTP 422 and no transfer resource in the body", rdesc(poor), [poor]);

    const wrongType = await POST("/deposits", { headers: CA(), body: { account_id: acc.A1, amount: "lots" } });
    ck("err-wrongly-typed-refused", OB.ERR,
      "a wrongly typed amount is refused, not accepted",
      wrongType.status >= 400 && wrongType.status < 500,
      "a 4xx refusal", rdesc(wrongType), [wrongType]);
    refusals.push({ id: "wrong-type", r: wrongType, wantStatus: wrongType.status });
    if (wrongType.status !== 400) {
      adv(
        'a wrongly typed "amount" answers 422 (invalid_amount), not the 400 the status split names',
        'INVARIANTS.md §11 says "A malformed, unparseable, or wrongly typed request is 400", but ' +
          "openapi.json enumerates the 400 codes as invalid_request, invalid_json, invalid_cursor and " +
          `invalid_limit, and puts amount validation at 422. Observed: HTTP ${wrongType.status} ${shown(wrongType.json)}. ` +
          "Recorded as an advisory because the document resolves the ambiguity in favour of 422.",
        [wrongType],
      );
    }

    const extraField = await POST("/accounts", { headers: CA(), body: { owner: "extra-field-probe", currency: "USD", not_a_field: 1 } });
    if (extraField.status === 201) {
      adv(
        "an undocumented request-body property is accepted rather than refused",
        "CreateAccountRequest declares additionalProperties:false, and the one declared exception in " +
          "INVARIANTS.md §8 is scoped to unknown *query* parameters. POST /accounts with an extra body " +
          `property answered ${extraField.status}. Recorded as an advisory, not a failing check: the ` +
          "invariant statements never say an unknown body property must be refused.",
        [extraField],
      );
    }
  });

  // =====================================================================
  // 10. Lifecycle legality
  // =====================================================================
  await phase("lifecycle", async () => {
    const closeAc = await POST(`/accounts/${acc.AC}/close`, { headers: CA() });
    ck("life-close-succeeds", OB.LIFE,
      "an active account with no pending transfers can be closed, and the closure is recorded",
      closeAc.status === 200 && closeAc.json?.status === "closed" && typeof closeAc.json?.closed_at === "string",
      'HTTP 200 with status "closed" and a closed_at timestamp', rdesc(closeAc), [closeAc]);

    const probes = [
      ["transfer-from-pending", await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AP, destination_account_id: acc.A2, amount: 10 } }), "a transfer out of a never-activated account is rejected", 409],
      ["transfer-to-pending", await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: acc.AP, amount: 10 } }), "a transfer into a never-activated account is rejected", 409],
      ["deposit-pending", await POST("/deposits", { headers: CA(), body: { account_id: acc.AP, amount: 10 } }), "a deposit into a never-activated account is rejected", 409],
      ["activate-active", await POST(`/accounts/${acc.A2}/activate`, { headers: CA() }), "activating an already-active account is rejected", 409],
      ["transfer-from-closed", await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AC, destination_account_id: acc.A2, amount: 10 } }), "a transfer out of a closed account is rejected", 410],
      ["transfer-to-closed", await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: acc.AC, amount: 10 } }), "a transfer into a closed account is rejected", 410],
      ["deposit-closed", await POST("/deposits", { headers: CA(), body: { account_id: acc.AC, amount: 10 } }), "a deposit into a closed account is rejected", 410],
      ["activate-closed", await POST(`/accounts/${acc.AC}/activate`, { headers: CA() }), "a closed account is never activated again", 410],
      ["close-closed", await POST(`/accounts/${acc.AC}/close`, { headers: CA() }), "closing an already-closed account is rejected", 410],
    ];
    for (const [tag, r, title, want] of probes) {
      ck(`life-${tag}`, OB.LIFE, title, r.status >= 400 && r.status < 500,
        "a 4xx refusal", rdesc(r), [r]);
      split(`state-${tag}`, `${title}: ${want}`, r, want, want === 410 ? "account_closed" : "account_not_active/not_pending");
    }

    // Closure is terminal, and a soft delete.
    const readClosed = await GET(`/accounts/${acc.AC}`, { headers: CA() });
    split("410-tombstone", "reading a closed account answers 410 with the tombstone", readClosed, 410, "account_closed");
    ck("life-closure-terminal", OB.LIFE,
      "after a refused activation the account is still closed",
      readClosed.status === 410 && readClosed.json?.error?.details?.status === "closed",
      "HTTP 410 whose details still report status closed", rdesc(readClosed), [readClosed]);

    const closedEntries = await GET(`/accounts/${acc.AC}/entries?limit=100`, { headers: CA() });
    ck("life-closed-account-keeps-history", OB.LIFE,
      "a closed account is a soft delete: it still serves its ledger history",
      closedEntries.status === 200 && items(closedEntries).length === 1 && items(closedEntries)[0]?.amount === 500,
      "HTTP 200 carrying the deposit entry made before closure",
      `${closedEntries.status} with ${items(closedEntries).length} entries ${shown(items(closedEntries).map((e) => [e.kind, e.amount]))}`,
      [closedEntries]);

    // Nothing was created by any of the refused calls.
    const apTransfers = await GET(`/transfers?account_id=${acc.AP}&limit=100`, { headers: CA() });
    const apEntries = await GET(`/accounts/${acc.AP}/entries?limit=100`, { headers: CA() });
    const acTransfers = await GET(`/transfers?account_id=${acc.AC}&limit=100`, { headers: CA() });
    ck("life-refusals-create-nothing", OB.LIFE,
      "a transfer or deposit refused on lifecycle grounds creates no transfer and writes no entry",
      apTransfers.status === 200 && items(apTransfers).length === 0 &&
      apEntries.status === 200 && items(apEntries).length === 0 &&
      acTransfers.status === 200 && items(acTransfers).length === 0,
      "no transfers naming the pending or closed account and no entries on the pending account",
      `pending: ${items(apTransfers).length} transfers / ${items(apEntries).length} entries; closed: ${items(acTransfers).length} transfers`,
      [apTransfers, apEntries, acTransfers]);
  });

  // =====================================================================
  // 11. Fee schedule
  // =====================================================================
  const feeProbes = [];
  await phase("fee-schedule", async () => {
    const usdAmounts = [1, 333, 334, 666, 1000, 3000, 3333, 3334, 50000];
    const eurAmounts = [1000, 3000];
    const bad = [];
    for (const amount of usdAmounts) {
      const r = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AF, destination_account_id: acc.A2, amount } });
      feeProbes.push({ amount, currency: "USD", r, id: idOf(r, null) });
      if (r.json?.fee !== feeFor(amount)) bad.push(`USD ${amount}: expected ${feeFor(amount)}, got ${shown(r.json?.fee)} (HTTP ${r.status})`);
    }
    for (const amount of eurAmounts) {
      const r = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AE, destination_account_id: acc.BE, amount } });
      feeProbes.push({ amount, currency: "EUR", r, id: idOf(r, null) });
      if (r.json?.fee !== feeFor(amount)) bad.push(`EUR ${amount}: expected ${feeFor(amount)}, got ${shown(r.json?.fee)} (HTTP ${r.status})`);
    }
    ck("fee-schedule-at-creation", OB.FEE,
      "the declared fee is 25 + round_half_up(amount * 15 / 10000) at every probed amount, including the exact half cases",
      bad.length === 0,
      shown(usdAmounts.concat(eurAmounts).map((a) => `${a}->${feeFor(a)}`)),
      bad.length ? shown(bad) : shown(feeProbes.map((p) => `${p.currency} ${p.amount}->${p.r.json?.fee}`)),
      feeProbes.map((p) => p.r));

    const usdByAmount = new Map(feeProbes.filter((p) => p.currency === "USD").map((p) => [p.amount, p.r.json?.fee]));
    const crossCurrency = eurAmounts.every((a) => {
      const e = feeProbes.find((p) => p.currency === "EUR" && p.amount === a);
      return e && usdByAmount.get(a) !== undefined && e.r.json?.fee === usdByAmount.get(a);
    });
    ck("fee-one-schedule-both-currencies", OB.FEE,
      "the schedule is one schedule, not a per-currency table",
      crossCurrency,
      "the same amount costs the same fee in USD and in EUR",
      shown(eurAmounts.map((a) => `${a}: USD ${usdByAmount.get(a)} vs EUR ${feeProbes.find((p) => p.currency === "EUR" && p.amount === a)?.r.json?.fee}`)),
      feeProbes.map((p) => p.r));

    const feeAcctWrong = feeProbes.filter((p) => {
      const want = p.currency === "USD" ? FEE_USD : FEE_EUR;
      return p.r.json?.fee_account_id !== undefined && p.r.json.fee_account_id !== want;
    });
    ck("ref-fee-account-matches-currency", OB.REF,
      "a transfer's fee_account_id is the system fee account of the transfer's currency",
      feeAcctWrong.length === 0,
      `${FEE_USD} for USD transfers and ${FEE_EUR} for EUR transfers`,
      feeAcctWrong.length ? shown(feeAcctWrong.map((p) => [p.currency, p.r.json?.fee_account_id])) : `all ${feeProbes.length} transfers named the right fee account`,
      feeProbes.map((p) => p.r));
  });

  // =====================================================================
  // 12. Main transfers, cancellation, and close-with-pending
  // =====================================================================
  const T = {};
  await phase("transfers", async () => {
    T.usd = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: acc.B1, amount: 25000 } });
    T.usdId = idOf(T.usd, MISSING_TR);
    T.eur = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AE, destination_account_id: acc.BE, amount: 10000 } });
    T.eurId = idOf(T.eur, MISSING_TR);
    T.cancel = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.A1, destination_account_id: acc.B1, amount: 500 } });
    T.cancelId = idOf(T.cancel, MISSING_TR);

    ck("life-transfer-created-pending", OB.LIFE,
      "a transfer between two active same-currency accounts is created pending, with the fee declared up front",
      T.usd.status === 201 && T.usd.json?.status === "pending" && T.usd.json?.amount === 25000 &&
        T.usd.json?.fee === feeFor(25000) && T.usd.json?.settled_at == null,
      `HTTP 201 {status:"pending", amount:25000, fee:${feeFor(25000)}, settled_at:null}`, rdesc(T.usd), [T.usd]);

    ck("own-destination-need-not-be-owned", OB.OWN,
      "the destination of a transfer need not belong to the caller",
      T.usd.status === 201 && T.usd.json?.destination_account_id === acc.B1,
      "HTTP 201 paying an account owned by the other customer principal", rdesc(T.usd), [T.usd, created.B1]);

    const readTr = await GET(`/transfers/${T.usdId}`, { headers: CA() });
    ck("rt-transfer-create-vs-read", OB.RT,
      "the transfer returned by POST /transfers is the transfer GET /transfers/{id} returns, field for field",
      readTr.status === 200 && eqDeep(T.usd.json, readTr.json),
      "identical resource on both reads",
      readTr.status === 200 ? `diff ${shown(fieldDiff(T.usd.json, readTr.json))}` : rdesc(readTr), [T.usd, readTr]);

    // Close is refused while a transfer is pending against either side.
    const closeSrc = await POST(`/accounts/${acc.A1}/close`, { headers: CA() });
    const closeDst = await POST(`/accounts/${acc.B1}/close`, { headers: CB() });
    ck("life-no-close-with-pending", OB.LIFE,
      "an account with a pending transfer against it — sending or receiving — cannot be closed",
      closeSrc.status === 409 && closeDst.status === 409,
      "HTTP 409 on both the sending and the receiving side",
      `source ${rdesc(closeSrc)} / destination ${rdesc(closeDst)}`, [closeSrc, closeDst, T.usd]);
    split("state-close-with-pending-source", "closing an account that is sending a pending transfer is 409", closeSrc, 409, "account_has_pending_transfers");
    split("state-close-with-pending-destination", "closing an account that is receiving a pending transfer is 409", closeDst, 409, "account_has_pending_transfers");

    const srcStill = await GET(`/accounts/${acc.A1}`, { headers: CA() });
    ck("life-refused-close-leaves-account-active", OB.LIFE,
      "an account whose closure was refused is still active",
      srcStill.status === 200 && srcStill.json?.status === "active" && srcStill.json?.closed_at == null,
      'HTTP 200 with status "active" and closed_at null', rdesc(srcStill), [closeSrc, srcStill]);

    // Only the owner of the source account may cancel.
    const bReadsShared = await GET(`/transfers/${T.usdId}`, { headers: CB() });
    ck("own-transfer-visible-to-both-sides", OB.OWN,
      "a transfer is readable by the principals owning either of its two sides",
      bReadsShared.status === 200 && bReadsShared.json?.id === T.usdId,
      "HTTP 200 for the destination's owner", rdesc(bReadsShared), [T.usd, bReadsShared]);

    const bReadsPayer = await GET(`/accounts/${acc.A1}`, { headers: CB() });
    ck("own-visible-transfer-does-not-expose-payer", OB.OWN,
      "being paid by a stranger makes the transfer visible without making the payer's account visible",
      bReadsShared.status === 200 && bReadsPayer.status === 403,
      "the transfer reads 200 for the payee while the payer's account still reads 403",
      `transfer ${bReadsShared.status} / payer account ${bReadsPayer.status}`, [bReadsShared, bReadsPayer]);

    const bCancels = await POST(`/transfers/${T.cancelId}/cancel`, { headers: CB() });
    ck("own-only-source-owner-cancels", OB.OWN,
      "only the principal owning the source account may cancel a transfer",
      bCancels.status === 403, "HTTP 403 for the destination's owner", rdesc(bCancels), [bCancels]);
    split("forbidden-cancel-by-payee", "cancelling a transfer you do not send is 403", bCancels, 403, "forbidden");

    const canceled = await POST(`/transfers/${T.cancelId}/cancel`, { headers: CA() });
    ck("life-cancel-pending-transfer", OB.LIFE,
      "a pending transfer can be canceled by the owner of its source account",
      canceled.status === 200 && canceled.json?.status === "canceled" && typeof canceled.json?.canceled_at === "string",
      'HTTP 200 with status "canceled" and a canceled_at timestamp', rdesc(canceled), [canceled]);

    const recancel = await POST(`/transfers/${T.cancelId}/cancel`, { headers: CA() });
    split("state-cancel-canceled", "cancelling an already-canceled transfer is 409", recancel, 409, "transfer_not_pending");
    ck("life-cancel-is-terminal", OB.LIFE,
      "a transfer that is no longer pending cannot be canceled again",
      recancel.status === 409, "HTTP 409", rdesc(recancel), [canceled, recancel]);
  });

  // =====================================================================
  // 13. Settlement of everything created so far
  // =====================================================================
  const pendingBeforeTick = [
    ...feeProbes.map((p) => p.id),
    T.usdId,
    T.eurId,
  ].filter((x) => typeof x === "string" && x !== MISSING_TR);

  let tick1;
  await phase("settlement-tick", async () => {
    tick1 = await POST("/admin/tick", { headers: ADMIN(), body: {} });
    const settled = Array.isArray(tick1.json?.settled) ? tick1.json.settled : [];
    const failed = Array.isArray(tick1.json?.failed) ? tick1.json.failed : [];

    ck("settle-nothing-left-pending", OB.SETL,
      "a tick with no settle_limit leaves no transfer pending",
      tick1.status === 200 && tick1.json?.pending === 0,
      "HTTP 200 with pending 0", rdesc(tick1), [tick1]);

    const covered = new Set([...settled, ...failed]);
    const uncovered = pendingBeforeTick.filter((id) => !covered.has(id));
    ck("settle-every-pending-resolved", OB.SETL,
      "every transfer pending at the tick ends the tick either settled or failed",
      pendingBeforeTick.length > 0 && uncovered.length === 0,
      `all ${pendingBeforeTick.length} pending transfers named in settled ∪ failed`,
      uncovered.length ? `not resolved: ${shown(uncovered)}` : `settled ${settled.length}, failed ${failed.length}`,
      [tick1], { settled, failed });

    ck("settle-creation-order", OB.SETL,
      "a tick settles pending transfers in creation order",
      pendingBeforeTick.length > 0 && JSON.stringify(settled) === JSON.stringify(pendingBeforeTick),
      `settled in creation order ${shown(pendingBeforeTick)}`,
      shown(settled), [tick1, ...feeProbes.map((p) => p.r), T.usd, T.eur]);

    const cancelRead = await GET(`/transfers/${T.cancelId}`, { headers: CA() });
    ck("settle-canceled-not-settled", OB.SETL,
      "a transfer canceled before the tick is not settled by it",
      cancelRead.status === 200 && cancelRead.json?.status === "canceled" && cancelRead.json?.settled_at == null &&
        !settled.includes(T.cancelId),
      'status still "canceled", settled_at null, and absent from the tick\'s settled list',
      rdesc(cancelRead), [tick1, cancelRead]);
  });

  // =====================================================================
  // 14. Conservation, reference integrity and the settled fee
  // =====================================================================
  const ledger = {};
  await phase("conservation", async () => {
    const read = async (id, hdr) => {
      const r = await GET(`/accounts/${id}/entries?limit=100`, { headers: hdr() });
      ledger[id] = { r, items: items(r) };
      return ledger[id];
    };
    await read(acc.A1, CA);
    await read(acc.B1, CB);
    await read(acc.AE, CA);
    await read(acc.BE, CB);
    await read(FEE_USD, ADMIN);
    await read(FEE_EUR, ADMIN);
    const allEntries = Object.values(ledger).flatMap((x) => x.items);
    const evid = Object.values(ledger).map((x) => x.r);

    function conservationFor(tag, transferResp, transferId, srcId, dstId, feeAcct) {
      const amount = transferResp?.json?.amount;
      const fee = transferResp?.json?.fee;
      const rows = allEntries.filter((e) => e?.transfer_id === transferId);
      const debits = rows.filter((e) => e.kind === "transfer_debit");
      const credits = rows.filter((e) => e.kind === "transfer_credit");
      const fees = rows.filter((e) => e.kind === "fee");
      const sum = rows.reduce((s, e) => s + (typeof e.amount === "number" ? e.amount : NaN), 0);
      const ok =
        rows.length === 3 && debits.length === 1 && credits.length === 1 && fees.length === 1 &&
        debits[0].account_id === srcId && debits[0].amount === -(amount + fee) &&
        credits[0].account_id === dstId && credits[0].amount === amount &&
        fees[0].account_id === feeAcct && fees[0].amount === fee &&
        sum === 0;
      ck(`conservation-${tag}`, OB.CONS,
        `a settled ${transferResp?.json?.currency ?? tag} transfer writes exactly one debit, one credit and one fee row summing to zero`,
        ok,
        `debit ${-(amount + fee)} on ${srcId}, credit ${amount} on ${dstId}, fee ${fee} on ${feeAcct}, sum 0`,
        `${rows.length} rows ${shown(rows.map((e) => [e.kind, e.account_id, e.amount]))}, sum ${sum}`,
        evid.concat([transferResp]), { transfer: transferId, amount, fee });

      ck(`fee-settles-at-declared-value-${tag}`, OB.FEE,
        "the fee a transfer declares when it is created is the fee it settles at, credited to the currency's fee account",
        fees.length === 1 && fees[0].amount === fee && fees[0].account_id === feeAcct && fee === feeFor(amount),
        `one fee row of ${feeFor(amount)} on ${feeAcct}`,
        shown(fees.map((e) => [e.account_id, e.amount])), evid.concat([transferResp]));
    }

    conservationFor("usd", T.usd, T.usdId, acc.A1, acc.B1, FEE_USD);
    conservationFor("eur", T.eur, T.eurId, acc.AE, acc.BE, FEE_EUR);

    // The canceled transfer wrote nothing at all.
    const cancelRows = allEntries.filter((e) => e?.transfer_id === T.cancelId);
    ck("conservation-cancel-writes-nothing", OB.CONS,
      "a transfer canceled before settlement writes no ledger entries at all",
      T.cancelId !== MISSING_TR && cancelRows.length === 0, "no entry carries the canceled transfer's id",
      cancelRows.length ? shown(cancelRows) : "no rows found on either side or on the fee account",
      evid, { transfer: T.cancelId });

    // Every fee probe settled at its declared fee too.
    const probeRows = feeProbes.map((p) => {
      const rows = allEntries.filter((e) => e?.transfer_id === p.id);
      const fees = rows.filter((e) => e.kind === "fee");
      return { amount: p.amount, currency: p.currency, expected: feeFor(p.amount), got: fees.map((e) => e.amount) };
    });
    const feeMismatch = probeRows.filter((x) => x.got.length !== 1 || x.got[0] !== x.expected);
    ck("fee-every-probe-settles-at-schedule", OB.FEE,
      "every probed amount is credited to the fee account at exactly the scheduled fee",
      feeMismatch.length === 0,
      shown(probeRows.map((x) => `${x.currency} ${x.amount}->${x.expected}`)),
      feeMismatch.length ? shown(feeMismatch) : `all ${probeRows.length} fee rows matched the schedule`,
      evid.concat(feeProbes.map((p) => p.r)));

    // Reference integrity across resources.
    const depA1 = deposits.A1;
    const depEntryId = depA1?.json?.entry_id;
    const depEntry = (ledger[acc.A1]?.items ?? []).find((e) => e.id === depEntryId);
    ck("ref-deposit-entry", OB.REF,
      "a deposit's entry_id names a ledger entry on the deposit's own account, for its amount, whose deposit_id is that deposit",
      depEntryId == null ||
        (Boolean(depEntry) && depEntry.account_id === depA1.json.account_id &&
         depEntry.amount === depA1.json.amount && depEntry.deposit_id === depA1.json.id &&
         depEntry.kind === "deposit"),
      depEntryId == null ? "entry_id absent or null is permitted" : `an entry ${depEntryId} on ${depA1?.json?.account_id} of ${depA1?.json?.amount} with deposit_id ${depA1?.json?.id}`,
      depEntryId == null ? "entry_id was null" : shown(depEntry ?? "no such entry on the account"),
      [depA1, ledger[acc.A1]?.r]);

    const currencyOf = { [acc.A1]: "USD", [acc.B1]: "USD", [acc.AE]: "EUR", [acc.BE]: "EUR", [FEE_USD]: "USD", [FEE_EUR]: "EUR" };
    const wrongCcy = allEntries.filter((e) => currencyOf[e.account_id] && e.currency !== currencyOf[e.account_id]);
    ck("ref-entry-currency-matches-account", OB.REF,
      "a ledger entry's currency is the currency of the account it sits on",
      allEntries.length > 0 && wrongCcy.length === 0, "every entry carries its account's currency",
      wrongCcy.length ? shown(wrongCcy.map((e) => [e.id, e.account_id, e.currency])) : `${allEntries.length} entries checked`,
      evid);

    // A sample of transfer_id references must resolve.
    const withTransfer = allEntries.filter((e) => typeof e.transfer_id === "string");
    const sample = [...new Set(withTransfer.map((e) => e.transfer_id))].slice(0, 3);
    const resolutions = [];
    for (const id of sample) resolutions.push([id, await GET(`/transfers/${id}`, { headers: ADMIN() })]);
    const unresolved = resolutions.filter(([, r]) => r.status !== 200);
    ck("ref-entry-transfer-resolves", OB.REF,
      "a ledger entry's transfer_id, when present, names a transfer that exists",
      sample.length > 0 && unresolved.length === 0,
      `all ${sample.length} sampled transfer_id references resolve with HTTP 200`,
      sample.length === 0 ? "no entry carried a transfer_id" : unresolved.length ? shown(unresolved.map(([id, r]) => [id, r.status])) : `${sample.length} of ${sample.length} resolved`,
      evid.concat(resolutions.map(([, r]) => r)));
  });

  // =====================================================================
  // 15. A second tick does not settle anything again
  // =====================================================================
  await phase("second-tick", async () => {
    const balBefore = await GET(`/accounts/${acc.A1}`, { headers: CA() });
    const trBefore = await GET(`/transfers/${T.usdId}`, { headers: CA() });
    const tick2 = await POST("/admin/tick", { headers: ADMIN(), body: {} });
    const balAfter = await GET(`/accounts/${acc.A1}`, { headers: CA() });
    const entriesAfter = await GET(`/accounts/${acc.A1}/entries?limit=100`, { headers: CA() });
    const trAfter = await GET(`/transfers/${T.usdId}`, { headers: CA() });
    const settledTwice = Array.isArray(tick2.json?.settled) ? tick2.json.settled : ["<not an array>"];
    const failedTwice = Array.isArray(tick2.json?.failed) ? tick2.json.failed : ["<not an array>"];
    const entriesBefore = (ledger[acc.A1]?.items ?? []).length;
    const pass =
      tick2.status === 200 &&
      settledTwice.length === 0 &&
      failedTwice.length === 0 &&
      balBefore.status === 200 && balAfter.status === 200 &&
      balBefore.json?.balance === balAfter.json?.balance &&
      entriesBefore > 0 && items(entriesAfter).length === entriesBefore &&
      trAfter.status === 200 &&
      trBefore.json?.settled_at != null &&
      trAfter.json?.settled_at === trBefore.json?.settled_at &&
      trAfter.json?.status === "settled";
    ck("settle-once-only", OB.SETL,
      "a transfer settles once: a second tick settles nothing again and moves no money",
      pass,
      "an empty settled and failed list, an unchanged balance, an unchanged entry count and an unchanged settled_at",
      `settled ${shown(settledTwice)}, failed ${shown(failedTwice)}, balance ${shown(balBefore.json?.balance)} -> ${shown(balAfter.json?.balance)}, entries ${entriesBefore} -> ${items(entriesAfter).length}, settled_at ${shown(trBefore.json?.settled_at)} -> ${shown(trAfter.json?.settled_at)}`,
      [balBefore, trBefore, tick2, balAfter, entriesAfter, trAfter]);
  });

  // =====================================================================
  // 16. Idempotency
  // =====================================================================
  await phase("idempotency", async () => {
    const K1 = "suite-key-cancelled";
    const K2 = "suite-key-settled";
    const body1 = { source_account_id: acc.AK, destination_account_id: acc.B1, amount: 1000 };
    const hdrA = (k) => ({ ...CA(), "idempotency-key": k });
    const hdrB = (k) => ({ ...CB(), "idempotency-key": k });

    const first = await POST("/transfers", { headers: hdrA(K1), body: body1 });
    const replay = await POST("/transfers", { headers: hdrA(K1), body: body1 });
    const firstId = idOf(first, MISSING_TR);
    ck("idem-replay-returns-first", OB.IDEM,
      "a second POST /transfers with the same key and body returns the first transfer",
      replay.status === 200 && replay.json?.id === firstId && replay.json?.id !== undefined,
      "HTTP 200 carrying the transfer the first request created",
      `first ${firstId} -> replay ${rdesc(replay)}`, [first, replay]);
    ck("param-idempotency-replayed-header", OB.PARAM,
      "a replay is marked with the documented Idempotency-Replayed header",
      replay.headers?.["idempotency-replayed"] === "true",
      'Idempotency-Replayed: "true"', shown(replay.headers?.["idempotency-replayed"] ?? null), [replay]);

    const conflict = await POST("/transfers", { headers: hdrA(K1), body: { ...body1, amount: 1001 } });
    split("state-idempotency-conflict", "the same key with a different body is 409", conflict, 409, "idempotency_key_conflict");
    ck("idem-conflict-is-refused", OB.IDEM,
      "the same key with a different body is refused as a conflict, not answered with the earlier transfer",
      conflict.status === 409 && conflict.json?.id === undefined,
      "HTTP 409 and no transfer resource in the body", rdesc(conflict), [first, conflict]);

    const bSameKey = await POST("/transfers", { headers: hdrB(K1), body: { source_account_id: acc.B1, destination_account_id: acc.A2, amount: 60 } });
    ck("idem-scoped-per-principal", OB.IDEM,
      "two principals may use the same key for different transfers",
      bSameKey.status === 201 && idOf(bSameKey, null) !== null && idOf(bSameKey, null) !== firstId,
      "HTTP 201 creating a distinct transfer for the other principal",
      `${rdesc(bSameKey)} (first principal's transfer was ${firstId})`, [first, bSameKey]);

    const cancelled = await POST(`/transfers/${firstId}/cancel`, { headers: CA() });
    const afterCancel = await POST("/transfers", { headers: hdrA(K1), body: body1 });
    ck("idem-key-survives-cancellation", OB.IDEM,
      "cancelling the transfer does not release its idempotency key",
      afterCancel.status === 200 && afterCancel.json?.id === firstId && afterCancel.json?.status === "canceled",
      "HTTP 200 returning the same, now canceled, transfer — not a new one",
      rdesc(afterCancel), [first, cancelled, afterCancel]);

    const second = await POST("/transfers", { headers: hdrA(K2), body: { source_account_id: acc.AK, destination_account_id: acc.B1, amount: 2000 } });
    const secondId = idOf(second, MISSING_TR);
    const tick = await POST("/admin/tick", { headers: ADMIN(), body: {} });
    const afterSettle = await POST("/transfers", { headers: hdrA(K2), body: { source_account_id: acc.AK, destination_account_id: acc.B1, amount: 2000 } });
    ck("idem-key-survives-settlement", OB.IDEM,
      "settling the transfer does not release its idempotency key",
      afterSettle.status === 200 && afterSettle.json?.id === secondId && afterSettle.json?.status === "settled",
      "HTTP 200 returning the same, now settled, transfer",
      rdesc(afterSettle), [second, tick, afterSettle]);

    // Exactly one transfer and exactly one set of ledger effects per key.
    const akTransfers = await GET(`/transfers?account_id=${acc.AK}&limit=100`, { headers: CA() });
    const withK1 = items(akTransfers).filter((t) => t.idempotency_key === K1);
    const withK2 = items(akTransfers).filter((t) => t.idempotency_key === K2);
    ck("idem-one-transfer-per-key", OB.IDEM,
      "each key produced exactly one transfer despite four requests carrying it",
      withK1.length === 1 && withK2.length === 1,
      "exactly one transfer per idempotency key",
      `key1 ${withK1.length}, key2 ${withK2.length} out of ${items(akTransfers).length} transfers on the account`,
      [first, replay, afterCancel, second, afterSettle, akTransfers],
      { key1: withK1.map((t) => t.id), key2: withK2.map((t) => t.id) });

    const akEntries = await GET(`/accounts/${acc.AK}/entries?limit=100`, { headers: CA() });
    const b1Entries = await GET(`/accounts/${acc.B1}/entries?limit=100`, { headers: CB() });
    const feeEntries = await GET(`/accounts/${FEE_USD}/entries?limit=100`, { headers: ADMIN() });
    const rows = [...items(akEntries), ...items(b1Entries), ...items(feeEntries)].filter((e) => e.transfer_id === secondId);
    const k1rows = [...items(akEntries), ...items(b1Entries), ...items(feeEntries)].filter((e) => e.transfer_id === firstId);
    ck("idem-one-set-of-effects", OB.IDEM,
      "the replayed key produced exactly one set of ledger effects, and the canceled one produced none",
      rows.length === 3 && k1rows.length === 0 &&
        rows.reduce((s, e) => s + e.amount, 0) === 0,
      "3 rows summing to zero for the settled key, 0 rows for the canceled key",
      `settled key ${rows.length} rows ${shown(rows.map((e) => [e.kind, e.amount]))}, canceled key ${k1rows.length} rows`,
      [akEntries, b1Entries, feeEntries, second, afterSettle]);
  });

  // =====================================================================
  // 17. settle_limit, and settlement order
  // =====================================================================
  const G = [];
  await phase("settle-limit", async () => {
    for (const amount of [100, 200, 300]) {
      const r = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AG, destination_account_id: acc.A2, amount } });
      G.push({ amount, r, id: idOf(r, MISSING_TR) });
    }
    const partial = await POST("/admin/tick", { headers: ADMIN(), body: { settle_limit: 2 } });
    const settled = Array.isArray(partial.json?.settled) ? partial.json.settled : [];
    ck("param-settle-limit", OB.PARAM,
      "settle_limit settles at most that many transfers and leaves the rest pending on purpose",
      partial.status === 200 && settled.length === 2 && partial.json?.pending === 1,
      "HTTP 200 with 2 settled and 1 still pending", rdesc(partial), [G[0].r, G[1].r, G[2].r, partial]);
    ck("settle-limit-takes-oldest-first", OB.SETL,
      "a limited tick settles the oldest pending transfers first",
      JSON.stringify(settled) === JSON.stringify([G[0].id, G[1].id]),
      shown([G[0].id, G[1].id]), shown(settled), [G[0].r, G[1].r, G[2].r, partial]);

    const rest = await POST("/admin/tick", { headers: ADMIN(), body: {} });
    const restSettled = Array.isArray(rest.json?.settled) ? rest.json.settled : [];
    ck("settle-remainder-on-next-tick", OB.SETL,
      "the transfer a limited tick left pending settles on the next unlimited tick, and only it",
      rest.status === 200 && JSON.stringify(restSettled) === JSON.stringify([G[2].id]) && rest.json?.pending === 0,
      shown([G[2].id]), `settled ${shown(restSettled)}, pending ${shown(rest.json?.pending)}`, [partial, rest]);
  });

  // =====================================================================
  // 18. Settlement re-checks funds; a failed transfer writes nothing
  // =====================================================================
  const F = {};
  await phase("settlement-failure", async () => {
    // AS holds 60 000. Each of these is individually covered at creation
    // (40 085 <= 60 000) and together they are not.
    F.s1 = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AS, destination_account_id: acc.A2, amount: 40000 } });
    F.s2 = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AS, destination_account_id: acc.A2, amount: 40000 } });
    F.s1Id = idOf(F.s1, MISSING_TR);
    F.s2Id = idOf(F.s2, MISSING_TR);
    ck("settle-overcommit-accepted-at-creation", OB.SETL,
      "two transfers each covered by the balance are both accepted at creation",
      F.s1.status === 201 && F.s2.status === 201,
      "HTTP 201 twice from a 60 000 balance for 40 000 + fee each",
      `${F.s1.status}/${F.s2.status}`, [deposits.AS, F.s1, F.s2]);

    const tick = await POST("/admin/tick", { headers: ADMIN(), body: {} });
    const settled = Array.isArray(tick.json?.settled) ? tick.json.settled : [];
    const failed = Array.isArray(tick.json?.failed) ? tick.json.failed : [];
    ck("settle-recheck-funds", OB.SETL,
      "funds are re-checked at settlement: the transfer the balance can no longer cover ends failed",
      tick.status === 200 && settled.includes(F.s1Id) && failed.includes(F.s2Id) && tick.json?.pending === 0,
      `${F.s1Id} settled and ${F.s2Id} failed, nothing left pending`,
      `settled ${shown(settled)}, failed ${shown(failed)}, pending ${shown(tick.json?.pending)}`,
      [F.s1, F.s2, tick]);

    const s2 = await GET(`/transfers/${F.s2Id}`, { headers: CA() });
    ck("settle-failed-transfer-state", OB.SETL,
      'a transfer that could not be covered reads back "failed"',
      s2.status === 200 && s2.json?.status === "failed" && s2.json?.settled_at == null,
      'status "failed" with settled_at null', rdesc(s2), [tick, s2]);

    const asEntries = await GET(`/accounts/${acc.AS}/entries?limit=100`, { headers: CA() });
    const a2Entries = await GET(`/accounts/${acc.A2}/entries?limit=100`, { headers: CA() });
    const feeEntries = await GET(`/accounts/${FEE_USD}/entries?limit=100`, { headers: ADMIN() });
    const rows = [...items(asEntries), ...items(a2Entries), ...items(feeEntries)].filter((e) => e.transfer_id === F.s2Id);
    ck("conservation-failed-writes-nothing", OB.CONS,
      "a transfer that ends failed writes no ledger entries at all",
      F.s2Id !== MISSING_TR && rows.length === 0, "no entry on either side or on the fee account carries the failed transfer's id",
      rows.length ? shown(rows.map((e) => [e.account_id, e.kind, e.amount])) : "no rows found",
      [tick, asEntries, a2Entries, feeEntries], { transfer: F.s2Id });

    const asRead = await GET(`/accounts/${acc.AS}`, { headers: CA() });
    const expected = 60000 - (40000 + feeFor(40000));
    ck("settle-failed-costs-nothing", OB.SETL,
      "the failed transfer left the source balance untouched: only the settled one was debited",
      asRead.status === 200 && asRead.json?.balance === expected,
      `balance ${expected}`, `balance ${shown(asRead.json?.balance)}`, [deposits.AS, F.s1, F.s2, tick, asRead]);
  });

  // =====================================================================
  // 19. The daily limit
  // =====================================================================
  await phase("daily-limit", async () => {
    const d1 = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AD, destination_account_id: acc.A2, amount: 99999 } });
    const d2 = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AD, destination_account_id: acc.A2, amount: 1 } });
    ck("daily-boundary-inclusive", OB.DAILY,
      "an amount bringing the day's total exactly to 100 000 is accepted",
      d1.status === 201 && d2.status === 201,
      "HTTP 201 for 99 999 and then for the final 1", `${d1.status}/${d2.status}`, [d1, d2]);

    const d3 = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AD, destination_account_id: acc.A2, amount: 1 } });
    ck("daily-beyond-boundary-refused", OB.DAILY,
      "anything beyond the limit is refused, even by one minor unit",
      d3.status === 422 && d3.json?.error?.code === "daily_limit_exceeded",
      "HTTP 422 daily_limit_exceeded", rdesc(d3), [d1, d2, d3]);
    split("422-daily-limit", "a transfer over the daily limit is 422", d3, 422, "daily_limit_exceeded");

    const cancel = await POST(`/transfers/${idOf(d1, MISSING_TR)}/cancel`, { headers: CA() });
    const d4 = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AD, destination_account_id: acc.A2, amount: 1 } });
    ck("daily-cancellation-does-not-refund-usage", OB.DAILY,
      "cancelling a transfer does not give the day's room back",
      cancel.status === 200 && d4.status === 422 && d4.json?.error?.code === "daily_limit_exceeded",
      "HTTP 422 daily_limit_exceeded after cancelling 99 999 of the day's 100 000",
      `cancel ${cancel.status}, retry ${rdesc(d4)}`, [d1, cancel, d4]);

    // AS spent 80 000 today: 40 000 settled and 40 000 failed at settlement.
    const topUp = await POST("/deposits", { headers: CA(), body: { account_id: acc.AS, amount: 200000 } });
    const over = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AS, destination_account_id: acc.A2, amount: 20001 } });
    ck("daily-failure-does-not-refund-usage", OB.DAILY,
      "a transfer that failed at settlement still counts against the day: only 20 000 of room is left, not 60 000",
      over.status === 422 && over.json?.error?.code === "daily_limit_exceeded",
      "HTTP 422 daily_limit_exceeded for 20 001 against a well-funded account",
      rdesc(over), [F.s1, F.s2, topUp, over]);

    const exact = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AS, destination_account_id: acc.A2, amount: 20000 } });
    ck("daily-usage-counts-amounts-not-fees", OB.DAILY,
      "usage counts transfer amounts and not fees: 80 000 + 20 000 is exactly the limit and is accepted",
      exact.status === 201,
      "HTTP 201 — the 165 minor units of fees already charged do not consume the allowance",
      rdesc(exact), [F.s1, F.s2, over, exact]);

    const rollover = await POST("/admin/tick", { headers: ADMIN(), body: { advance_day: true } });
    ck("param-advance-day", OB.PARAM,
      "advance_day rolls the ledger day over",
      rollover.status === 200 && typeof rollover.json?.day === "number" && rollover.json.day === 1,
      "HTTP 200 with day 1", rdesc(rollover), [reset, rollover]);
    ck("settle-day-rolling-tick-still-settles", OB.SETL,
      "a tick that rolls the day over is still a tick: it settles what was pending",
      rollover.status === 200 && (rollover.json?.settled ?? []).includes(idOf(exact, MISSING_TR)) && rollover.json?.pending === 0,
      "the pending transfer named in settled, and pending 0", rdesc(rollover), [exact, rollover]);

    const nextDay = await POST("/transfers", { headers: CA(), body: { source_account_id: acc.AD, destination_account_id: acc.A2, amount: 1 } });
    ck("daily-rollover-resets-usage", OB.DAILY,
      "rolling the ledger day over starts the next day's count at zero",
      nextDay.status === 201,
      "HTTP 201 from an account that had exhausted the previous day's limit",
      rdesc(nextDay), [d3, rollover, nextDay]);

    const idemAcrossDay = await POST("/transfers", {
      headers: { ...CA(), "idempotency-key": "suite-key-settled" },
      body: { source_account_id: acc.AK, destination_account_id: acc.B1, amount: 2000 },
    });
    ck("idem-key-survives-day-rollover", OB.IDEM,
      "an idempotency key does not expire when the ledger day rolls over",
      idemAcrossDay.status === 200 && idemAcrossDay.json?.idempotency_key === "suite-key-settled" &&
        idemAcrossDay.json?.status === "settled",
      "HTTP 200 returning the transfer created on the previous day",
      rdesc(idemAcrossDay), [rollover, idemAcrossDay]);

    const finalTick = await POST("/admin/tick", { headers: ADMIN(), body: {} });
    ck("settle-final-quiesce", OB.SETL,
      "a final tick leaves the service with nothing pending",
      finalTick.status === 200 && finalTick.json?.pending === 0,
      "HTTP 200 with pending 0", rdesc(finalTick), [nextDay, finalTick]);
  });

  // =====================================================================
  // 20. Pagination — from here on the suite only reads
  // =====================================================================
  let accountsBaseline = null;
  await phase("pagination", async () => {
    accountsBaseline = await GET("/accounts?limit=100&include_closed=true", { headers: ADMIN() });
    const baseIds = items(accountsBaseline).map((x) => x.id);
    const accEnum = await enumerate("/accounts?include_closed=true", 3, ADMIN);
    paginationChecks("accounts", "GET /accounts", 3, accEnum.pages, accEnum.terminated, baseIds);

    const transfersBaseline = await GET("/transfers?limit=100", { headers: ADMIN() });
    const trEnum = await enumerate("/transfers", 4, ADMIN);
    paginationChecks("transfers", "GET /transfers", 4, trEnum.pages, trEnum.terminated, items(transfersBaseline).map((x) => x.id));

    const entriesBaseline = await GET(`/accounts/${acc.AF}/entries?limit=100`, { headers: CA() });
    const entEnum = await enumerate(`/accounts/${acc.AF}/entries`, 3, CA);
    paginationChecks("entries", "GET /accounts/{accountId}/entries", 3, entEnum.pages, entEnum.terminated, items(entriesBaseline).map((x) => x.id));

    // Filtered enumeration: account_id.
    const filtEnum = await enumerate(`/transfers?account_id=${acc.AF}`, 2, CA);
    const filtered = filtEnum.pages.flatMap((p) => items(p));
    const offFilter = filtered.filter((t) => t.source_account_id !== acc.AF && t.destination_account_id !== acc.AF);
    paginationChecks("transfers-filtered", `GET /transfers?account_id=${acc.AF}`, 2, filtEnum.pages, filtEnum.terminated, null);
    ck("page-filter-holds-on-every-page", OB.PAGE,
      "every item on every page of a filtered enumeration satisfies the filter",
      offFilter.length === 0 && filtered.length > 0,
      "every transfer names the filtered account on one side",
      offFilter.length ? shown(offFilter.map((t) => [t.id, t.source_account_id, t.destination_account_id])) : `${filtered.length} transfers over ${filtEnum.pages.length} pages, all naming ${acc.AF}`,
      filtEnum.pages);
    ck("param-account-id-filter", OB.PARAM,
      "account_id on GET /transfers restricts the collection to transfers naming that account on either side",
      offFilter.length === 0 && filtered.length === 9,
      "the 9 transfers sent from that account and nothing else",
      `${filtered.length} transfers, ${offFilter.length} of them off-filter`, filtEnum.pages);

    // The transfer collection is scoped to the principals owning either side.
    const bTransfers = await GET("/transfers?limit=100", { headers: CB() });
    const bOwned = new Set([acc.B1, acc.BE, acc.BX]);
    const strangers = items(bTransfers).filter(
      (t) => !bOwned.has(t.source_account_id) && !bOwned.has(t.destination_account_id),
    );
    ck("own-transfer-listing-is-scoped", OB.OWN,
      "GET /transfers shows a customer only the transfers naming one of its own accounts",
      bTransfers.status === 200 && items(bTransfers).length > 0 && strangers.length === 0,
      "every listed transfer names an account owned by the calling principal on one side",
      strangers.length
        ? shown(strangers.map((t) => [t.id, t.source_account_id, t.destination_account_id]))
        : `${items(bTransfers).length} transfers, all naming one of ${shown([...bOwned])}`,
      [bTransfers]);

    // Filtered enumeration: include_closed.
    const withClosed = items(accountsBaseline).map((x) => x.id);
    const withoutClosedResp = await GET("/accounts?limit=100", { headers: ADMIN() });
    const withoutClosed = items(withoutClosedResp);
    const closedLeak = withoutClosed.filter((x) => x.status === "closed");
    ck("param-include-closed", OB.PARAM,
      "include_closed=true includes closed accounts and its absence excludes them",
      withClosed.includes(acc.AC) && closedLeak.length === 0 && !withoutClosed.some((x) => x.id === acc.AC),
      "the closed account present with include_closed=true and absent without it",
      `with: ${withClosed.includes(acc.AC)}, without: ${withoutClosed.some((x) => x.id === acc.AC)}, closed items leaked without the flag: ${closedLeak.length}`,
      [accountsBaseline, withoutClosedResp]);
    ck("page-closed-filter-holds", OB.PAGE,
      "every item of the default (unfiltered-by-closed) accounts collection satisfies the filter",
      withoutClosed.length > 0 && closedLeak.length === 0, "no closed account without include_closed=true",
      closedLeak.length ? shown(closedLeak.map((x) => x.id)) : `${withoutClosed.length} items, none closed`,
      [withoutClosedResp]);
  });

  // =====================================================================
  // 21. Balance agreement — a quiescent read of every account
  // =====================================================================
  await phase("balance-agreement", async () => {
    const list = accountsBaseline ?? (await GET("/accounts?limit=100&include_closed=true", { headers: ADMIN() }));
    const rows = items(list);
    const disagreements = [];
    const evidence = [list];
    for (const a of rows) {
      const e = await GET(`/accounts/${a.id}/entries?limit=100`, { headers: ADMIN() });
      evidence.push(e);
      const es = items(e);
      const nextCursor = e.json?.next_cursor ?? null;
      const sum = es.reduce((s, x) => s + (typeof x.amount === "number" ? x.amount : NaN), 0);
      if (e.status !== 200) disagreements.push(`${a.id}: entries read failed with ${e.status}`);
      else if (nextCursor !== null) disagreements.push(`${a.id}: entry enumeration was incomplete at limit=100`);
      else if (sum !== a.balance) disagreements.push(`${a.id}: balance ${a.balance} vs entry sum ${sum} over ${es.length} entries`);
    }
    ck("balance-agrees-with-entries", OB.BAL,
      "every account's stored balance equals the sum of its ledger entry amounts",
      rows.length > 0 && disagreements.length === 0,
      `balance === Σ entries for all ${rows.length} accounts, read with no write in between`,
      disagreements.length ? shown(disagreements) : `${rows.length} accounts agreed exactly`,
      evidence, { accounts: rows.length });

    const feeUsd = rows.find((a) => a.id === FEE_USD);
    const feeEur = rows.find((a) => a.id === FEE_EUR);
    const feeEntriesUsd = await GET(`/accounts/${FEE_USD}/entries?limit=100`, { headers: ADMIN() });
    const feeEntriesEur = await GET(`/accounts/${FEE_EUR}/entries?limit=100`, { headers: ADMIN() });
    const sumUsd = items(feeEntriesUsd).reduce((s, x) => s + x.amount, 0);
    const sumEur = items(feeEntriesEur).reduce((s, x) => s + x.amount, 0);
    const allFees = [...items(feeEntriesUsd), ...items(feeEntriesEur)];
    ck("balance-fee-accounts", OB.BAL,
      "the system fee accounts' balances are exactly the fees they have collected",
      Boolean(feeUsd) && Boolean(feeEur) && feeUsd.balance === sumUsd && feeEur.balance === sumEur &&
        allFees.length > 0 && allFees.every((e) => e.kind === "fee" && e.amount > 0),
      "each fee account's balance equals the sum of its fee rows, and it holds only fee rows",
      `USD ${shown(feeUsd?.balance)} vs ${sumUsd} over ${items(feeEntriesUsd).length} rows; EUR ${shown(feeEur?.balance)} vs ${sumEur} over ${items(feeEntriesEur).length} rows`,
      [list, feeEntriesUsd, feeEntriesEur]);

    const nonInteger = rows.filter((a) => !Number.isInteger(a.balance));
    ck("balance-is-an-integer", OB.BAL,
      "every balance is an integer in minor units — no rounding anywhere",
      rows.length > 0 && nonInteger.length === 0, "Number.isInteger on every balance",
      nonInteger.length ? shown(nonInteger.map((a) => [a.id, a.balance])) : `${rows.length} integral balances`,
      [list]);
  });

  // =====================================================================
  // 22. Aggregate error-shape checks over everything the suite did
  // =====================================================================
  await phase("error-shape", async () => {
    const errors = traffic.filter((r) => r.status >= 400);
    const problems = [];
    for (const r of errors) {
      const p = envelopeProblem(r);
      if (p) problems.push({ ref: r.ref, path: r.path ?? r.url, status: r.status, problem: p });
    }
    ck("err-envelope-everywhere", OB.ERR,
      "every 4xx and 5xx body in this run is {\"error\":{code,message,details?}} with string code and message",
      errors.length > 0 && problems.length === 0,
      `the single error envelope on all ${errors.length} refusals`,
      problems.length ? shown(problems.slice(0, 12)) : `${errors.length} refusal bodies all matched the envelope`,
      problems.length ? problems.map((p) => p.ref) : errors.slice(0, 20),
      { refusals: errors.length, malformed: problems.length });

    const servererrors = traffic.filter((r) => r.status >= 500);
    ck("err-no-5xx", OB.ERR,
      "no operation answers 5xx",
      servererrors.length === 0,
      `no status >= 500 across all ${traffic.length} recorded exchanges`,
      servererrors.length ? shown(servererrors.slice(0, 10).map((r) => [r.method, r.path ?? r.url, r.status])) : `${traffic.length} exchanges, none 5xx`,
      servererrors.length ? servererrors.slice(0, 10) : traffic.slice(0, 5));

    const transportFailures = traffic.filter((r) => r.transportError || r.clientError || r.status === 0);
    ck("err-service-answered", OB.ERR,
      "the service answered every request the suite made",
      transportFailures.length === 0,
      "no transport failure and no unanswered request",
      transportFailures.length ? shown(transportFailures.slice(0, 8).map((r) => [r.method, r.path ?? r.url, r.transportError ?? r.clientError])) : `${traffic.length} exchanges answered`,
      transportFailures.length ? transportFailures.slice(0, 8) : traffic.slice(0, 3));

    const wrong2xx = refusals.filter((x) => x.r && x.r.status >= 200 && x.r.status < 300);
    ck("err-refusals-are-4xx", OB.ERR,
      "a request the service refuses is reported with a 4xx status, never a 2xx carrying the failure inside it",
      refusals.length > 0 && wrong2xx.length === 0,
      `all ${refusals.length} deliberately refused requests answered 4xx`,
      wrong2xx.length ? shown(wrong2xx.map((x) => [x.id, x.r.status])) : `${refusals.length} refusals, all 4xx`,
      refusals.map((x) => x.r).slice(0, 25));

    const wrongSplit = refusals.filter((x) => x.r && x.r.status !== x.wantStatus);
    ck("err-status-split", OB.ERR,
      "when the service refuses, the status says why: 400 malformed, 401 no credential, 403 wrong principal, 404 unknown id, 409 resource state, 410 closed, 422 business rule",
      refusals.length > 0 && wrongSplit.length === 0,
      `all ${refusals.length} refusals carried the status the split assigns them`,
      wrongSplit.length ? shown(wrongSplit.map((x) => `${x.id}: wanted ${x.wantStatus}, got ${x.r.status} ${shown(x.r.json?.error?.code)}`)) : `${refusals.length} refusals matched the split`,
      refusals.map((x) => x.r).slice(0, 25));

    const jsonCt = traffic.filter((r) => r.status > 0 && !(r.headers?.["content-type"] ?? "").includes("application/json"));
    ck("err-json-content-type", OB.ERR,
      "every answer, refusal included, is served as application/json",
      traffic.length > 0 && jsonCt.length === 0, "content-type application/json on every response",
      jsonCt.length ? shown(jsonCt.slice(0, 8).map((r) => [r.path ?? r.url, r.status, r.headers?.["content-type"]])) : `${traffic.length} responses`,
      jsonCt.length ? jsonCt.slice(0, 8) : [health, doc]);

    ck("err-health-and-document", OB.ERR,
      "the unauthenticated liveness probe and the OpenAPI document answer 200",
      health.status === 200 && health.json?.ok === true && doc.status === 200 && typeof doc.json === "object" && doc.json !== null,
      "HTTP 200 from GET /health and GET /openapi.json",
      `health ${health.status}, document ${doc.status}`, [health, doc]);
  });
}
