// Minibank ledger — script suite.
// Tries to prove the INVARIANTS.md statements wrong against real ledger state,
// and accounts for every obligation in handout/obligations.json.

import {
  ADMIN, CUST_A, CUST_B, SYNTHETIC,
  expectedFee, sameResource, diffKeys, qs, refs, short, bodySnippet,
  errorShapeProblem, pageDiscipline, sumAmounts,
} from "./lib.mjs";

const SEED = "ledger-dev-seed";
const NO_ACC = "acc_zzz404";
const NO_ACC2 = "acc_zzz405";
const NO_DEP = "dep_zzz404";
const NO_TR = "tr_zzz404";
const FEE_USD = "acc_fee_usd";
const FEE_EUR = "acc_fee_eur";

const RULE = {
  conservation: "rule:conservation",
  fee: "rule:the-fee-schedule",
  idem: "rule:idempotency",
  lifecycle: "rule:lifecycle-legality",
  settlement: "rule:settlement",
  ownership: "rule:ownership",
  pagination: "rule:pagination-identity-and-page-discipline",
  params: "rule:documented-parameters",
  refint: "rule:reference-integrity",
  daily: "rule:the-daily-limit",
  errors: "rule:error-shape-and-the-status-split-three-rules",
  balance: "rule:balance-agreement",
  roundtrip: "rule:round-trip-consistency-and-determinism",
};

export default async function suite({ client, check }) {
  const traffic = [];
  const usedIds = new Set();
  const coveredRules = new Set();
  const problems = [];

  const authFor = (as) => {
    if (as === "admin") return { authorization: client.secret(ADMIN) };
    if (as === "a") return { authorization: client.secret(CUST_A) };
    if (as === "b") return { authorization: client.secret(CUST_B) };
    return {};
  };

  // Every request in this suite goes through here: it records traffic for the
  // aggregate checks and it never throws, so a misbehaving service or an
  // exhausted budget produces a failing check rather than a script defect.
  async function req(method, path, opts = {}) {
    const as = "as" in opts ? opts.as : "admin";
    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating && client.mode === "read-only") return SYNTHETIC;
    const remaining = client.budget && client.budget.remaining;
    if (typeof remaining === "number" && remaining <= 2) return SYNTHETIC;
    const options = { headers: { ...authFor(as), ...(opts.headers || {}) } };
    if ("body" in opts) options.body = opts.body;
    if ("rawBody" in opts) options.rawBody = opts.rawBody;
    if (opts.contentType) options.contentType = opts.contentType;
    let res;
    try {
      res = await client.request(method, path, options);
    } catch (err) {
      problems.push(`${method} ${path}: ${err && err.message ? err.message : String(err)}`);
      return SYNTHETIC;
    }
    traffic.push(res);
    return res;
  }

  const GET = (p, o) => req("GET", p, o);
  const POST = (p, o) => req("POST", p, o);

  function ck(spec) {
    let id = spec.id;
    let n = 2;
    while (usedIds.has(id)) id = `${spec.id}-${n++}`;
    usedIds.add(id);
    coveredRules.add(spec.obligation);
    const record = {
      id,
      obligation: spec.obligation,
      title: spec.title || spec.id,
      pass: spec.pass === true,
      evidence: { requests: spec.evidence || [] },
    };
    if (spec.expected !== undefined) record.expected = String(spec.expected);
    if (spec.observed !== undefined) record.observed = String(spec.observed);
    if (spec.note !== undefined) record.note = String(spec.note);
    if (spec.subject !== undefined) record.evidence.subject = spec.subject;
    check(record);
  }

  const advise = (title, detail, evidence) =>
    check.advisory({ title, detail: String(detail), evidence: { requests: evidence || [] } });

  /** Status-split helper: one check that the service refused with the named status. */
  function ckStatus(id, obligation, title, res, status, opts = {}) {
    const codeOk = opts.code ? res && res.json && res.json.error && res.json.error.code === opts.code : true;
    ck({
      id,
      obligation,
      title,
      pass: !!res && res.status === status && codeOk,
      expected: `HTTP ${status}${opts.code ? ` with error.code "${opts.code}"` : ""}`,
      observed: short(res) + (res && res.synthetic ? "" : ` — ${bodySnippet(res, 140)}`),
      note: opts.note,
      evidence: refs(res, opts.extra || []),
    });
    return res;
  }

  async function enumerateAll(basePath, opts = {}) {
    const as = "as" in opts ? opts.as : "admin";
    const limit = opts.limit === undefined ? 100 : opts.limit;
    const extra = opts.extra || [];
    const pages = [];
    const items = [];
    let cursor = null;
    let guard = 0;
    let terminated = false;
    const maxPages = opts.maxPages || 30;
    while (guard < maxPages) {
      guard += 1;
      const pairs = [...extra];
      if (limit !== null) pairs.push(["limit", limit]);
      if (cursor) pairs.push(["cursor", cursor]);
      const res = await GET(basePath + qs(pairs), { as });
      pages.push(res);
      const page = res && res.json;
      const its = Array.isArray(page && page.items) ? page.items : [];
      items.push(...its);
      const next = page ? page.next_cursor ?? null : null;
      if (!next || res.synthetic || !res.ok) { terminated = !next && !!res.ok; break; }
      cursor = next;
    }
    return { pages, items, terminated, limit };
  }

  // Shared world state; every consumer guards against nulls.
  const W = {
    principalA: null, principalB: null,
    acc: {}, dep: {}, tr: {},
    dayAfterBigTick: null, dayAfterRoll: null,
    createdAccountBodies: {},
  };
  const id = (name) => (W.acc[name] && W.acc[name].id) || `${NO_ACC}_${name}`;
  const trId = (name) => (W.tr[name] && W.tr[name].id) || NO_TR;

  async function openAccount(name, as, owner, currency, extraBody) {
    const body = { owner, currency, ...(extraBody || {}) };
    const res = await POST("/accounts", { as, body });
    if (res && res.status === 201 && res.json && res.json.id) {
      W.acc[name] = res.json;
      W.createdAccountBodies[name] = { res, body: res.json };
    }
    return res;
  }

  async function activate(name, as) {
    const res = await POST(`/accounts/${id(name)}/activate`, { as });
    if (res && res.ok && res.json && res.json.id) W.acc[name] = res.json;
    return res;
  }

  async function deposit(name, as, amount, key) {
    const res = await POST("/deposits", { as, body: { account_id: id(name), amount } });
    if (res && res.status === 201 && res.json && res.json.id) W.dep[key || name] = res.json;
    return res;
  }

  async function transfer(key, as, from, to, amount, extra) {
    const body = { source_account_id: id(from), destination_account_id: id(to), amount, ...(extra && extra.body ? extra.body : {}) };
    const opts = { as, body };
    if (extra && extra.idempotencyKey) opts.headers = { "idempotency-key": extra.idempotencyKey };
    const res = await POST("/transfers", opts);
    if (res && (res.status === 201 || res.status === 200) && res.json && res.json.id && key) W.tr[key] = res.json;
    return res;
  }

  // =====================================================================
  async function main() {
    // ---------- T0: known state, service metadata, admin authority ----------
    const reset0 = await POST("/admin/reset", { as: "admin", body: { seed: SEED } });
    ck({
      id: "reset-establishes-known-state",
      obligation: RULE.roundtrip,
      title: "POST /admin/reset with the study seed returns the seeded world",
      pass: !!reset0 && reset0.status === 200 && reset0.json && reset0.json.ok === true && reset0.json.seed === SEED
        && Number.isInteger(reset0.json.day),
      expected: `200 {ok:true, seed:"${SEED}", day:<int>}`,
      observed: `${short(reset0)} — ${bodySnippet(reset0, 160)}`,
      evidence: refs(reset0),
    });

    const health = await GET("/health", { as: "none" });
    ck({
      id: "health-is-public-and-well-formed",
      obligation: RULE.errors,
      title: "GET /health answers 200 with the documented shape and needs no credential",
      pass: !!health && health.status === 200 && health.json && typeof health.json.ok === "boolean"
        && typeof health.json.service === "string",
      expected: "200 {ok:boolean, service:string}",
      observed: `${short(health)} — ${bodySnippet(health, 160)}`,
      evidence: refs(health),
    });

    const doc = await GET("/openapi.json", { as: "none" });
    ck({
      id: "openapi-document-is-served",
      obligation: RULE.roundtrip,
      title: "the live document matches the handout's identity (title and version)",
      pass: !!doc && doc.status === 200 && doc.json && doc.json.info
        && doc.json.info.title === "Minibank Ledger" && doc.json.info.version === "1.0.0",
      expected: 'info.title "Minibank Ledger", info.version "1.0.0"',
      observed: `${short(doc)} — title ${JSON.stringify(doc && doc.json && doc.json.info && doc.json.info.title)}, version ${JSON.stringify(doc && doc.json && doc.json.info && doc.json.info.version)}`,
      note: "the suite is written against the handout document; a live document that differs invalidates every other expectation.",
      evidence: refs(doc),
    });

    // Admin authority, probed before any state exists so a wrongly-granted
    // reset cannot destroy the rest of the run.
    const custReset = await POST("/admin/reset", { as: "a", body: { seed: "hostile-seed" } });
    ckStatus("admin-reset-refuses-customer", RULE.ownership,
      "a customer principal may not call POST /admin/reset", custReset, 403);
    const custTick = await POST("/admin/tick", { as: "a", body: {} });
    ckStatus("admin-tick-refuses-customer", RULE.ownership,
      "a customer principal may not call POST /admin/tick", custTick, 403);
    const anonTick = await POST("/admin/tick", { as: "none", body: {} });
    ckStatus("admin-tick-requires-credential", RULE.errors,
      "POST /admin/tick without a credential is 401", anonTick, 401);
    const anonList = await GET("/accounts", { as: "none" });
    ckStatus("accounts-list-requires-credential", RULE.errors,
      "GET /accounts without a credential is 401", anonList, 401);

    // ---------- T1: determinism, by replaying one sequence from a reset ----------
    async function detSequence() {
      const out = {};
      out.reset = await POST("/admin/reset", { as: "admin", body: { seed: SEED } });
      out.src = await POST("/accounts", { as: "a", body: { owner: "det-source", currency: "USD" } });
      const srcId = (out.src.json && out.src.json.id) || NO_ACC;
      out.act = await POST(`/accounts/${srcId}/activate`, { as: "a" });
      out.dep = await POST("/deposits", { as: "a", body: { account_id: srcId, amount: 5000 } });
      out.dst = await POST("/accounts", { as: "b", body: { owner: "det-dest", currency: "USD" } });
      const dstId = (out.dst.json && out.dst.json.id) || NO_ACC2;
      out.dstAct = await POST(`/accounts/${dstId}/activate`, { as: "b" });
      out.tr = await POST("/transfers", { as: "a", body: { source_account_id: srcId, destination_account_id: dstId, amount: 1000 } });
      return out;
    }
    const runA = await detSequence();
    const runB = await detSequence();
    const detKeys = ["src", "act", "dep", "dst", "dstAct", "tr"];
    const detDiffs = [];
    for (const k of detKeys) {
      if (runA[k].status !== runB[k].status) detDiffs.push(`${k}: status ${runA[k].status} vs ${runB[k].status}`);
      const d = diffKeys(runA[k].json, runB[k].json);
      if (d.length) detDiffs.push(`${k}: ${d.join(", ")}`);
    }
    ck({
      id: "determinism-replay-from-seed",
      obligation: RULE.roundtrip,
      title: "the same request sequence after the same reset yields identical ids, timestamps and resources",
      pass: detDiffs.length === 0 && runA.tr.status === 201,
      expected: "every resource in the replay is field-for-field identical to the first run",
      observed: detDiffs.length ? detDiffs.slice(0, 8).join(" | ") : "6 resources identical across both replays",
      note: "sequence: create+activate+fund a USD account as customer A, create+activate a USD account as customer B, then transfer 1000 between them.",
      evidence: refs(detKeys.map((k) => [runA[k], runB[k]])),
    });

    // ---------- T2: the world every later phase builds on ----------
    await POST("/admin/reset", { as: "admin", body: { seed: SEED } });

    // Operation sweep: every spec operation is exercised here, up front, so
    // that a later failure cannot leave an operation obligation unaccounted.
    // Each probe doubles as the "an identifier that names nothing is 404" case.
    const miss = {};
    miss.accAdmin = await GET(`/accounts/${NO_ACC}`, { as: "admin" });
    miss.accCust = await GET(`/accounts/${NO_ACC}`, { as: "a" });
    miss.activate = await POST(`/accounts/${NO_ACC}/activate`, { as: "a" });
    miss.close = await POST(`/accounts/${NO_ACC}/close`, { as: "a" });
    miss.entries = await GET(`/accounts/${NO_ACC}/entries`, { as: "a" });
    miss.deposit = await POST("/deposits", { as: "a", body: { account_id: NO_ACC, amount: 100 } });
    miss.depGet = await GET(`/deposits/${NO_DEP}`, { as: "a" });
    miss.transfer = await POST("/transfers", { as: "a", body: { source_account_id: NO_ACC, destination_account_id: NO_ACC2, amount: 100 } });
    miss.trGet = await GET(`/transfers/${NO_TR}`, { as: "a" });
    miss.cancel = await POST(`/transfers/${NO_TR}/cancel`, { as: "a" });
    const missAll = Object.values(miss);
    const notFourOhFour = Object.entries(miss).filter(([, r]) => !r || r.status !== 404);
    ck({
      id: "unknown-identifier-is-404-everywhere",
      obligation: RULE.errors,
      title: "an identifier that names nothing is 404, including after a resource-scoped path",
      pass: notFourOhFour.length === 0,
      expected: "404 on all 10 unknown-identifier probes (account, activate, close, entries, deposit target, deposit, transfer endpoints, cancel)",
      observed: notFourOhFour.length
        ? notFourOhFour.map(([k, r]) => `${k}: ${short(r)}`).join("; ")
        : "all 10 probes answered 404",
      evidence: refs(missAll),
    });
    ck({
      id: "unknown-identifier-404-for-any-principal",
      obligation: RULE.ownership,
      title: "an unknown account id is 404 whichever principal asks (existence is decided before authorization)",
      pass: !!miss.accAdmin && !!miss.accCust && miss.accAdmin.status === 404 && miss.accCust.status === 404,
      expected: "404 for both the administrator and a customer",
      observed: `admin ${short(miss.accAdmin)}, customer ${short(miss.accCust)}`,
      evidence: refs(miss.accAdmin, miss.accCust),
    });

    const emptyTransfers = await GET("/transfers?limit=100", { as: "admin" });
    ck({
      id: "reset-drops-every-transfer",
      obligation: RULE.roundtrip,
      title: "after a reset the transfer collection is empty",
      pass: !!emptyTransfers && emptyTransfers.status === 200 && Array.isArray(emptyTransfers.json && emptyTransfers.json.items)
        && emptyTransfers.json.items.length === 0 && (emptyTransfers.json.next_cursor ?? null) === null,
      expected: "200 with items [] and next_cursor null",
      observed: `${short(emptyTransfers)} — ${(emptyTransfers.json && Array.isArray(emptyTransfers.json.items) ? emptyTransfers.json.items.length : "?")} items, next_cursor ${JSON.stringify(emptyTransfers.json && emptyTransfers.json.next_cursor)}`,
      evidence: refs(emptyTransfers),
    });

    // ---------- T3: open the accounts the rest of the run uses ----------
    const created = {};
    created.AU1 = await openAccount("AU1", "a", "ada-usd-main", "USD");
    created.BU1 = await openAccount("BU1", "b", "bob-usd-main", "USD");
    W.principalA = W.acc.AU1 && W.acc.AU1.owner_principal;
    W.principalB = W.acc.BU1 && W.acc.BU1.owner_principal;
    created.AU2 = await openAccount("AU2", "a", "ada-usd-second", "USD");
    created.AE1 = await openAccount("AE1", "a", "ada-eur", "EUR");
    created.BE1 = await openAccount("BE1", "b", "bob-eur", "EUR");
    created.APEND = await openAccount("APEND", "a", "ada-never-activated", "USD");
    created.ACLOSE = await openAccount("ACLOSE", "a", "ada-to-close", "USD");
    created.ADL2 = await openAccount("ADL2", "a", "ada-limit-cancel", "USD");
    created.ADL3 = await openAccount("ADL3", "a", "ada-limit-fail", "USD");
    created.AFEE = await openAccount("AFEE", "a", "ada-fee-lab", "USD");
    created.ADMB = await openAccount("ADMB", "admin", "opened-for-bob", "USD", { owner_principal: W.principalB || "unknown" });

    ck({
      id: "new-account-is-pending-and-owned-by-its-creator",
      obligation: RULE.lifecycle,
      title: "an account opens in status pending, zero balance, owned by the calling principal",
      pass: !!W.acc.AU1 && W.acc.AU1.status === "pending" && W.acc.AU1.balance === 0
        && W.acc.AU1.kind === "customer" && typeof W.acc.AU1.owner_principal === "string" && W.acc.AU1.owner_principal.length > 0,
      expected: 'status "pending", balance 0, kind "customer", a non-empty owner_principal',
      observed: `${short(created.AU1)} — ${bodySnippet(created.AU1, 200)}`,
      evidence: refs(created.AU1),
    });
    ck({
      id: "two-customer-credentials-are-different-principals",
      obligation: RULE.ownership,
      title: "the two customer references authenticate two distinct principals",
      pass: !!W.principalA && !!W.principalB && W.principalA !== W.principalB,
      expected: "owner_principal differs between accounts opened under the two customer references",
      observed: `A=${JSON.stringify(W.principalA)} B=${JSON.stringify(W.principalB)}`,
      note: "everything downstream that calls a cross-principal refusal a violation depends on this.",
      evidence: refs(created.AU1, created.BU1),
    });
    ck({
      id: "admin-may-open-on-another-principals-behalf",
      obligation: RULE.ownership,
      title: "the administrator may open an account whose owner_principal is another principal",
      pass: !!created.ADMB && created.ADMB.status === 201 && created.ADMB.json
        && created.ADMB.json.owner_principal === W.principalB,
      expected: `201 with owner_principal ${JSON.stringify(W.principalB)}`,
      observed: `${short(created.ADMB)} — owner_principal ${JSON.stringify(created.ADMB && created.ADMB.json && created.ADMB.json.owner_principal)}`,
      evidence: refs(created.ADMB, created.BU1),
    });

    const custOnBehalf = await POST("/accounts", { as: "a", body: { owner: "ada-impersonating", currency: "USD", owner_principal: W.principalB || "unknown" } });
    ckStatus("customer-may-not-open-for-another-principal", RULE.ownership,
      "a customer principal supplying owner_principal is refused 403", custOnBehalf, 403,
      { extra: refs(created.BU1) });

    const badJsonAccount = await POST("/accounts", { as: "a", rawBody: '{"owner":"broken",', contentType: "application/json" });
    ckStatus("malformed-json-is-400", RULE.errors,
      "an unparseable request body is 400", badJsonAccount, 400);
    const missingField = await POST("/accounts", { as: "a", body: { currency: "USD" } });
    ckStatus("missing-required-field-is-400", RULE.errors,
      "a request missing a required field is 400", missingField, 400,
      { note: 'the omitted field is `owner`, a plain required string, so no enum reading can turn the omission into a business-rule refusal.' });
    const missingCurrency = await POST("/accounts", { as: "a", body: { owner: "no-currency" } });
    const badCurrency = await POST("/accounts", { as: "a", body: { owner: "gbp-please", currency: "GBP" } });
    ck({
      id: "unsupported-or-absent-currency-is-refused",
      obligation: RULE.errors,
      title: "an account cannot be opened without a currency, or in a currency the service does not support",
      pass: !!missingCurrency && (missingCurrency.status === 400 || missingCurrency.status === 422)
        && !!badCurrency && (badCurrency.status === 400 || badCurrency.status === 422),
      expected: "both refused with 400 or 422, and no account created",
      observed: `missing currency ${short(missingCurrency)}; currency "GBP" ${short(badCurrency)}`,
      note: 'the split between "wrongly typed" (400) and "business rule" (422) is genuinely open for an out-of-enum currency, so this check only requires a refusal; the status actually chosen is recorded as an advisory.',
      evidence: refs(missingCurrency, badCurrency),
    });
    advise("status chosen for currency validation",
      `POST /accounts without a currency answered ${short(missingCurrency)}; with currency "GBP" it answered ${short(badCurrency)}. The document lists 400 codes as invalid_request/invalid_json/invalid_cursor/invalid_limit and declares 422 on POST /accounts for a business-rule refusal, which is where unsupported_currency fits.`,
      refs(missingCurrency, badCurrency));
    const wrongTypeAccount = await POST("/accounts", { as: "a", body: { owner: 12345, currency: "USD" } });
    ckStatus("wrongly-typed-field-is-400", RULE.errors,
      "a wrongly typed request field is 400", wrongTypeAccount, 400);
    const anonAccount = await POST("/accounts", { as: "none", body: { owner: "anon", currency: "USD" } });
    ckStatus("account-create-requires-credential", RULE.errors,
      "POST /accounts without a credential is 401", anonAccount, 401);

    // ---------- T4: activation ----------
    const acts = {};
    for (const [name, as] of [["AU1", "a"], ["AU2", "a"], ["AE1", "a"], ["ACLOSE", "a"], ["ADL2", "a"],
      ["ADL3", "a"], ["AFEE", "a"], ["BU1", "b"], ["BE1", "b"], ["ADMB", "b"]]) {
      acts[name] = await activate(name, as);
    }
    const badActivations = Object.entries(acts).filter(([, r]) => !r || r.status !== 200 || !r.json || r.json.status !== "active");
    ck({
      id: "activation-moves-pending-to-active",
      obligation: RULE.lifecycle,
      title: "activating a pending account returns it active with activated_at set",
      pass: badActivations.length === 0 && Object.values(acts).every((r) => r.json && typeof r.json.activated_at === "string"),
      expected: "10 accounts answer 200 with status active and a non-null activated_at",
      observed: badActivations.length
        ? badActivations.map(([k, r]) => `${k}: ${short(r)}`).join("; ")
        : `all 10 active; activated_at present on ${Object.values(acts).filter((r) => r.json && r.json.activated_at).length}`,
      evidence: refs(Object.values(acts)),
    });
    ck({
      id: "admin-opened-account-is-activated-by-its-owner",
      obligation: RULE.ownership,
      title: "the principal named in owner_principal owns the account the administrator opened for it",
      pass: !!acts.ADMB && acts.ADMB.status === 200 && acts.ADMB.json && acts.ADMB.json.owner_principal === W.principalB,
      expected: "customer B can activate the account the administrator opened on B's behalf",
      observed: `${short(acts.ADMB)} — owner_principal ${JSON.stringify(acts.ADMB && acts.ADMB.json && acts.ADMB.json.owner_principal)}`,
      evidence: refs(created.ADMB, acts.ADMB),
    });
    const crossActivate = await POST(`/accounts/${id("APEND")}/activate`, { as: "b" });
    ckStatus("cross-principal-activate-is-403", RULE.ownership,
      "customer B may not activate customer A's pending account", crossActivate, 403);

    // ---------- T5: funding ----------
    const deps = {};
    for (const [name, as, amount] of [["AU1", "a", 250000], ["AU2", "a", 10000], ["AE1", "a", 250000],
      ["ACLOSE", "a", 5000], ["ADL2", "a", 300000], ["ADL3", "a", 60000], ["AFEE", "a", 100000],
      ["BU1", "b", 50000], ["BE1", "b", 10000]]) {
      deps[name] = await deposit(name, as, amount);
    }
    const badDeposits = Object.entries(deps).filter(([, r]) => !r || r.status !== 201 || !r.json || r.json.status !== "settled");
    ck({
      id: "deposit-settles-immediately",
      obligation: RULE.lifecycle,
      title: "a deposit into an active account is created 201 and settles immediately",
      pass: badDeposits.length === 0,
      expected: '9 deposits answer 201 with status "settled"',
      observed: badDeposits.length ? badDeposits.map(([k, r]) => `${k}: ${short(r)}`).join("; ") : "all 9 settled",
      evidence: refs(Object.values(deps)),
    });
    const afterFunding = await GET(`/accounts/${id("AU1")}`, { as: "a" });
    ck({
      id: "deposit-moves-the-balance",
      obligation: RULE.balance,
      title: "a settled deposit raises the funded account's balance by its amount",
      pass: !!afterFunding && afterFunding.status === 200 && afterFunding.json && afterFunding.json.balance === 250000,
      expected: "balance 250000 after a single 250000 deposit into a fresh account",
      observed: `${short(afterFunding)} — balance ${JSON.stringify(afterFunding && afterFunding.json && afterFunding.json.balance)}`,
      evidence: refs(deps.AU1, afterFunding),
    });

    const depPending = await POST("/deposits", { as: "a", body: { account_id: id("APEND"), amount: 1000 } });
    ckStatus("deposit-into-pending-account-is-409", RULE.lifecycle,
      "a deposit into an account that was never activated is refused for its state", depPending, 409);
    const depCross = await POST("/deposits", { as: "b", body: { account_id: id("AU1"), amount: 1000 } });
    ckStatus("cross-principal-deposit-is-403", RULE.ownership,
      "customer B may not fund customer A's account", depCross, 403);
    const depZero = await POST("/deposits", { as: "a", body: { account_id: id("AU1"), amount: 0 } });
    ck({
      id: "deposit-amount-zero-is-refused",
      obligation: RULE.errors,
      title: "a deposit of 0 is refused (the schema requires minimum 1)",
      pass: !!depZero && (depZero.status === 400 || depZero.status === 422),
      expected: "400 (out-of-range input) or 422 (business rule)",
      observed: `${short(depZero)} — ${bodySnippet(depZero, 140)}`,
      note: "the status split allows either reading here; accepting it as a 2xx would not be allowed.",
      evidence: refs(depZero),
    });
    const depNeg = await POST("/deposits", { as: "a", body: { account_id: id("AU1"), amount: -100 } });
    ck({
      id: "deposit-negative-amount-is-refused",
      obligation: RULE.errors,
      title: "a negative deposit is refused, so money cannot be removed through the funding path",
      pass: !!depNeg && (depNeg.status === 400 || depNeg.status === 422),
      expected: "400 or 422",
      observed: `${short(depNeg)} — ${bodySnippet(depNeg, 140)}`,
      evidence: refs(depNeg),
    });
    const depStr = await POST("/deposits", { as: "a", body: { account_id: id("AU1"), amount: "1000" } });
    ck({
      id: "deposit-wrongly-typed-amount-is-refused",
      obligation: RULE.errors,
      title: "a string amount on POST /deposits is refused as malformed input or as invalid_amount",
      pass: !!depStr && (depStr.status === 400
        || (depStr.status === 422 && depStr.json && depStr.json.error && depStr.json.error.code === "invalid_amount")),
      expected: "400, or 422 with error.code invalid_amount",
      observed: `${short(depStr)} — ${bodySnippet(depStr, 140)}`,
      note: "the document allocates the code invalid_amount to 422, so amount validation is a documented business rule rather than only a type check.",
      evidence: refs(depStr),
    });
    const depAnon = await POST("/deposits", { as: "none", body: { account_id: id("AU1"), amount: 100 } });
    ckStatus("deposit-requires-credential", RULE.errors,
      "POST /deposits without a credential is 401", depAnon, 401);

    const feeBefore = await GET(`/accounts/${FEE_USD}`, { as: "admin" });
    const depFee = await POST("/deposits", { as: "a", body: { account_id: FEE_USD, amount: 1000 } });
    const feeAfter = await GET(`/accounts/${FEE_USD}`, { as: "admin" });
    ck({
      id: "system-fee-account-is-not-actable",
      obligation: RULE.ownership,
      title: "a customer cannot fund a system fee account, and the attempt moves nothing",
      pass: !!depFee && depFee.status >= 400 && depFee.status < 500
        && !!feeBefore && !!feeAfter && feeBefore.json && feeAfter.json
        && feeBefore.json.balance === feeAfter.json.balance,
      expected: "a 4xx refusal and an unchanged fee-account balance",
      observed: `${short(depFee)}; fee balance ${JSON.stringify(feeBefore && feeBefore.json && feeBefore.json.balance)} -> ${JSON.stringify(feeAfter && feeAfter.json && feeAfter.json.balance)}`,
      note: 'the invariant says the fee accounts are "readable by every principal, and actable by none" without fixing the status, so this checks refusal plus no effect.',
      evidence: refs(feeBefore, depFee, feeAfter),
    });
    advise("status chosen for acting on a system fee account", `POST /deposits to ${FEE_USD} as a customer answered ${short(depFee)}.`, refs(depFee));

    // ---------- T6: round-trip reads and ownership boundaries ----------
    const depGet = await GET(`/deposits/${(W.dep.AU1 && W.dep.AU1.id) || NO_DEP}`, { as: "a" });
    ck({
      id: "deposit-round-trips",
      obligation: RULE.roundtrip,
      title: "the deposit returned by its creation is the deposit a later read returns",
      pass: !!depGet && depGet.status === 200 && sameResource(deps.AU1 && deps.AU1.json, depGet.json),
      expected: "GET /deposits/{id} is field-for-field identical to the creation response",
      observed: !depGet || depGet.status !== 200
        ? short(depGet)
        : (diffKeys(deps.AU1 && deps.AU1.json, depGet.json).join("; ") || "identical"),
      evidence: refs(deps.AU1, depGet),
    });
    const depGetCross = await GET(`/deposits/${(W.dep.AU1 && W.dep.AU1.id) || NO_DEP}`, { as: "b" });
    ckStatus("cross-principal-deposit-read-is-403", RULE.ownership,
      "customer B may not read a deposit into customer A's account", depGetCross, 403);

    const accGet = await GET(`/accounts/${id("AU1")}`, { as: "a" });
    ck({
      id: "account-round-trips-after-activation",
      obligation: RULE.roundtrip,
      title: "the account returned by activation is the account a later read returns, except for the balance the deposit moved",
      pass: !!accGet && accGet.status === 200 && !!acts.AU1
        && sameResource({ ...(acts.AU1.json || {}), balance: 0 }, { ...(accGet.json || {}), balance: 0 })
        && accGet.json && accGet.json.balance === 250000,
      expected: "every field identical to the activation response apart from balance, which is 250000",
      observed: !accGet || accGet.status !== 200
        ? short(accGet)
        : `${diffKeys({ ...(acts.AU1.json || {}), balance: 0 }, { ...(accGet.json || {}), balance: 0 }).join("; ") || "identical apart from balance"}; balance ${JSON.stringify(accGet.json.balance)}`,
      evidence: refs(acts.AU1, deps.AU1, accGet),
    });

    const accCross = await GET(`/accounts/${id("AU1")}`, { as: "b" });
    const leaked = [];
    if (accCross && accCross.text) {
      const hay = accCross.text;
      for (const needle of ["ada-usd-main", String(W.principalA || " "), "250000"]) {
        if (needle && needle !== " " && hay.includes(needle)) leaked.push(needle);
      }
    }
    ck({
      id: "cross-principal-account-read-is-403-and-leaks-nothing",
      obligation: RULE.ownership,
      title: "reading another principal's account is 403 and returns no part of its state",
      pass: !!accCross && accCross.status === 403 && leaked.length === 0,
      expected: "403 whose body contains neither the owner, the owning principal, nor the balance",
      observed: `${short(accCross)}${leaked.length ? `; body discloses ${leaked.join(", ")}` : "; no owner/principal/balance in the body"} — ${bodySnippet(accCross, 160)}`,
      evidence: refs(accCross, accGet),
    });
    const entriesCross = await GET(`/accounts/${id("AU1")}/entries`, { as: "b" });
    ckStatus("cross-principal-entries-read-is-403", RULE.ownership,
      "reading another principal's ledger entries is 403", entriesCross, 403);
    const adminRead = await GET(`/accounts/${id("AU1")}`, { as: "admin" });
    ck({
      id: "administrator-is-unrestricted",
      obligation: RULE.ownership,
      title: "the administrator reads an account it does not own",
      pass: !!adminRead && adminRead.status === 200 && adminRead.json && adminRead.json.id === id("AU1"),
      expected: `200 for ${id("AU1")}`,
      observed: short(adminRead),
      evidence: refs(adminRead, accCross),
    });

    const feeA = await GET(`/accounts/${FEE_USD}`, { as: "a" });
    const feeB = await GET(`/accounts/${FEE_USD}`, { as: "b" });
    const feeEntriesA = await GET(`/accounts/${FEE_USD}/entries`, { as: "a" });
    ck({
      id: "system-fee-accounts-are-readable-by-every-principal",
      obligation: RULE.ownership,
      title: "both customer principals may read a system fee account and its entries",
      pass: !!feeA && feeA.status === 200 && !!feeB && feeB.status === 200
        && !!feeEntriesA && feeEntriesA.status === 200
        && feeA.json && feeA.json.kind === "system",
      expected: `200 on GET /accounts/${FEE_USD} for both customers and 200 on its entries`,
      observed: `A ${short(feeA)}, B ${short(feeB)}, entries ${short(feeEntriesA)}, kind ${JSON.stringify(feeA && feeA.json && feeA.json.kind)}`,
      evidence: refs(feeA, feeB, feeEntriesA),
    });

    // ---------- T7: the fee schedule at its rounding boundaries ----------
    // 1 -> .0015 down; 333 -> .4995 down; 334 -> .501 up; 1000 -> exactly 1.5,
    // the half case; 3000 -> exactly 4.5, the other half case.
    const feeLab = [];
    for (const amount of [1, 333, 334, 1000, 3000]) {
      const res = await transfer(`fee${amount}`, "a", "AFEE", "BU1", amount);
      feeLab.push({ amount, res, want: expectedFee(amount) });
    }
    const feeWrong = feeLab.filter((f) => !f.res || f.res.status !== 201 || !f.res.json || f.res.json.fee !== f.want);
    ck({
      id: "fee-schedule-at-rounding-boundaries",
      obligation: RULE.fee,
      title: "the fee a USD transfer declares is 25 + round-half-away-from-zero(amount * 15 / 10000)",
      pass: feeWrong.length === 0,
      expected: feeLab.map((f) => `${f.amount}->${f.want}`).join(", "),
      observed: feeLab.map((f) => `${f.amount}->${f.res && f.res.json ? f.res.json.fee : short(f.res)}`).join(", "),
      note: "1000 and 3000 are the exact .5 cases: half away from zero makes them 27 and 30, not 26 and 29.",
      evidence: refs(feeLab.map((f) => f.res)),
    });

    // ---------- T8: settle_limit ----------
    const badLimitTick = await POST("/admin/tick", { as: "admin", body: { settle_limit: -1 } });
    ckStatus("negative-settle-limit-is-400", RULE.params,
      "settle_limit outside its documented range (minimum 0) is 400", badLimitTick, 400);
    const tickZero = await POST("/admin/tick", { as: "admin", body: { settle_limit: 0 } });
    ck({
      id: "settle-limit-zero-settles-nothing",
      obligation: RULE.params,
      title: "a tick with settle_limit 0 settles nothing and leaves every transfer pending",
      pass: !!tickZero && tickZero.status === 200 && tickZero.json
        && Array.isArray(tickZero.json.settled) && tickZero.json.settled.length === 0
        && Array.isArray(tickZero.json.failed) && tickZero.json.failed.length === 0
        && tickZero.json.pending === 5,
      expected: "200 {settled: [], failed: [], pending: 5}",
      observed: `${short(tickZero)} — ${bodySnippet(tickZero, 200)}`,
      evidence: refs(tickZero, feeLab.map((f) => f.res)),
    });
    const tickTwo = await POST("/admin/tick", { as: "admin", body: { settle_limit: 2 } });
    const wantFirstTwo = [W.tr.fee1 && W.tr.fee1.id, W.tr.fee333 && W.tr.fee333.id];
    ck({
      id: "settle-limit-settles-at-most-that-many-oldest-first",
      obligation: RULE.params,
      title: "settle_limit 2 settles exactly the two oldest pending transfers and leaves the rest pending",
      pass: !!tickTwo && tickTwo.status === 200 && tickTwo.json
        && Array.isArray(tickTwo.json.settled) && tickTwo.json.settled.length === 2
        && JSON.stringify(tickTwo.json.settled) === JSON.stringify(wantFirstTwo)
        && tickTwo.json.pending === 3,
      expected: `settled ${JSON.stringify(wantFirstTwo)}, pending 3`,
      observed: `${short(tickTwo)} — ${bodySnippet(tickTwo, 220)}`,
      note: "the declared exception to the settlement rule: settle_limit deliberately leaves the rest pending.",
      evidence: refs(tickTwo, feeLab.map((f) => f.res)),
    });

    // ---------- T9: the transfers whose ledger effects get audited ----------
    const consUsd = await transfer("consUsd", "a", "AU1", "BU1", 25000);
    ck({
      id: "transfer-is-created-pending-with-its-fee-declared",
      obligation: RULE.lifecycle,
      title: "a transfer between two active same-currency accounts is created pending with amount, fee and fee account declared",
      pass: !!consUsd && consUsd.status === 201 && consUsd.json && consUsd.json.status === "pending"
        && consUsd.json.amount === 25000 && consUsd.json.fee === expectedFee(25000)
        && consUsd.json.currency === "USD" && consUsd.json.settled_at == null,
      expected: `201 pending, amount 25000, fee ${expectedFee(25000)}, currency USD, settled_at null`,
      observed: `${short(consUsd)} — ${bodySnippet(consUsd, 240)}`,
      evidence: refs(consUsd),
    });
    const consEur = await transfer("consEur", "a", "AE1", "BE1", 20000);
    ck({
      id: "fee-schedule-is-one-schedule-across-currencies",
      obligation: RULE.fee,
      title: "a EUR transfer is charged by the same schedule as a USD transfer of the same amount",
      pass: !!consEur && consEur.status === 201 && consEur.json && consEur.json.fee === expectedFee(20000)
        && consEur.json.currency === "EUR" && consEur.json.fee_account_id === FEE_EUR,
      expected: `fee ${expectedFee(20000)} on a 20000 EUR transfer, credited to ${FEE_EUR}`,
      observed: `${short(consEur)} — fee ${JSON.stringify(consEur && consEur.json && consEur.json.fee)}, fee_account_id ${JSON.stringify(consEur && consEur.json && consEur.json.fee_account_id)}`,
      evidence: refs(consEur, consUsd),
    });
    const trGet = await GET(`/transfers/${trId("consUsd")}`, { as: "a" });
    ck({
      id: "transfer-round-trips",
      obligation: RULE.roundtrip,
      title: "the transfer returned by its creation is the transfer a later read returns",
      pass: !!trGet && trGet.status === 200 && sameResource(consUsd && consUsd.json, trGet.json),
      expected: "GET /transfers/{id} is field-for-field identical to the creation response",
      observed: !trGet || trGet.status !== 200 ? short(trGet) : (diffKeys(consUsd.json, trGet.json).join("; ") || "identical"),
      evidence: refs(consUsd, trGet),
    });

    // ---------- T10: idempotency ----------
    const KEY1 = "s0-trial3-key-1";
    const KEY2 = "s0-trial3-key-2";
    const idemBody = { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: 500 };
    const idem1 = await POST("/transfers", { as: "a", body: idemBody, headers: { "idempotency-key": KEY1 } });
    if (idem1 && idem1.json && idem1.json.id) W.tr.idem1 = idem1.json;
    ck({
      id: "keyed-transfer-is-created-once",
      obligation: RULE.idem,
      title: "the first POST /transfers carrying an Idempotency-Key creates the transfer",
      pass: !!idem1 && idem1.status === 201 && idem1.json && idem1.json.idempotency_key === KEY1,
      expected: `201 with idempotency_key ${JSON.stringify(KEY1)}`,
      observed: `${short(idem1)} — idempotency_key ${JSON.stringify(idem1 && idem1.json && idem1.json.idempotency_key)}`,
      evidence: refs(idem1),
    });
    const replay1 = await POST("/transfers", { as: "a", body: idemBody, headers: { "idempotency-key": KEY1 } });
    ck({
      id: "same-key-same-body-replays-the-first-transfer",
      obligation: RULE.idem,
      title: "repeating the key with the same body returns the original transfer, with the replay header, and creates nothing",
      pass: !!replay1 && replay1.status === 200 && replay1.json && idem1 && idem1.json
        && replay1.json.id === idem1.json.id
        && replay1.headers && replay1.headers["idempotency-replayed"] === "true"
        && sameResource(idem1.json, replay1.json),
      expected: `200, id ${JSON.stringify(idem1 && idem1.json && idem1.json.id)}, Idempotency-Replayed: true, identical body`,
      observed: `${short(replay1)} — id ${JSON.stringify(replay1 && replay1.json && replay1.json.id)}, replayed header ${JSON.stringify(replay1 && replay1.headers && replay1.headers["idempotency-replayed"])}`,
      evidence: refs(idem1, replay1),
    });
    const conflict = await POST("/transfers", { as: "a", body: { ...idemBody, amount: 600 }, headers: { "idempotency-key": KEY1 } });
    const afterConflict = await GET(`/transfers${qs([["account_id", id("AU1")], ["limit", 100]])}`, { as: "a" });
    const conflictCreated = Array.isArray(afterConflict && afterConflict.json && afterConflict.json.items)
      ? afterConflict.json.items.filter((t) => t && t.amount === 600)
      : [];
    ck({
      id: "same-key-different-body-is-409-and-creates-nothing",
      obligation: RULE.idem,
      title: "the same Idempotency-Key with a different body is refused as a conflict and creates nothing",
      pass: !!conflict && conflict.status === 409
        && conflict.json && conflict.json.error && conflict.json.error.code === "idempotency_key_conflict"
        && conflictCreated.length === 0,
      expected: '409 idempotency_key_conflict, and no transfer of amount 600 exists afterwards',
      observed: `${short(conflict)}; transfers of amount 600 afterwards: ${conflictCreated.length}`,
      note: "returning the earlier transfer here would be a lost write, not idempotency.",
      evidence: refs(idem1, conflict, afterConflict),
    });
    const idemOtherPrincipal = await POST("/transfers", {
      as: "b",
      body: { source_account_id: id("BU1"), destination_account_id: id("AU1"), amount: 700 },
      headers: { "idempotency-key": KEY1 },
    });
    if (idemOtherPrincipal && idemOtherPrincipal.json && idemOtherPrincipal.json.id) W.tr.idemB = idemOtherPrincipal.json;
    ck({
      id: "idempotency-keys-are-scoped-per-principal",
      obligation: RULE.idem,
      title: "a second principal may reuse the same key for a different transfer",
      pass: !!idemOtherPrincipal && idemOtherPrincipal.status === 201 && idemOtherPrincipal.json
        && idem1 && idem1.json && idemOtherPrincipal.json.id !== idem1.json.id
        && idemOtherPrincipal.json.amount === 700,
      expected: "201 with a new transfer id, distinct from customer A's transfer under the same key",
      observed: `${short(idemOtherPrincipal)} — id ${JSON.stringify(idemOtherPrincipal && idemOtherPrincipal.json && idemOtherPrincipal.json.id)} vs A's ${JSON.stringify(idem1 && idem1.json && idem1.json.id)}`,
      evidence: refs(idem1, idemOtherPrincipal),
    });
    const cancelIdem1 = await POST(`/transfers/${trId("idem1")}/cancel`, { as: "a" });
    ck({
      id: "pending-transfer-cancels",
      obligation: RULE.lifecycle,
      title: "a pending transfer cancels, and cancellation records canceled_at",
      pass: !!cancelIdem1 && cancelIdem1.status === 200 && cancelIdem1.json
        && cancelIdem1.json.status === "canceled" && typeof cancelIdem1.json.canceled_at === "string",
      expected: '200 with status "canceled" and a canceled_at timestamp',
      observed: `${short(cancelIdem1)} — ${bodySnippet(cancelIdem1, 200)}`,
      evidence: refs(idem1, cancelIdem1),
    });
    const replayAfterCancel = await POST("/transfers", { as: "a", body: idemBody, headers: { "idempotency-key": KEY1 } });
    ck({
      id: "cancelling-does-not-release-the-idempotency-key",
      obligation: RULE.idem,
      title: "after the keyed transfer is canceled the key still replays it rather than creating a second one",
      pass: !!replayAfterCancel && replayAfterCancel.status === 200 && replayAfterCancel.json
        && idem1 && idem1.json && replayAfterCancel.json.id === idem1.json.id
        && replayAfterCancel.json.status === "canceled",
      expected: `200 returning ${JSON.stringify(idem1 && idem1.json && idem1.json.id)} in status canceled`,
      observed: `${short(replayAfterCancel)} — id ${JSON.stringify(replayAfterCancel && replayAfterCancel.json && replayAfterCancel.json.id)}, status ${JSON.stringify(replayAfterCancel && replayAfterCancel.json && replayAfterCancel.json.status)}`,
      evidence: refs(idem1, cancelIdem1, replayAfterCancel),
    });
    const idem2 = await POST("/transfers", {
      as: "a",
      body: { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: 800 },
      headers: { "idempotency-key": KEY2 },
    });
    if (idem2 && idem2.json && idem2.json.id) W.tr.idem2 = idem2.json;
    W.keys = { KEY1, KEY2, idemBody };

    // ---------- T11: the daily limit ----------
    const atLimit = await transfer("dl2Full", "a", "ADL2", "BU1", 100000);
    ck({
      id: "daily-limit-boundary-is-inclusive",
      obligation: RULE.daily,
      title: "an amount bringing the day's total exactly to 100000 is accepted",
      pass: !!atLimit && atLimit.status === 201 && atLimit.json && atLimit.json.amount === 100000
        && atLimit.json.fee === expectedFee(100000),
      expected: `201 for a first transfer of exactly 100000, fee ${expectedFee(100000)}`,
      observed: `${short(atLimit)} — ${bodySnippet(atLimit, 200)}`,
      note: "the fee is charged on top of the amount and does not count against the limit; the source holds 300000.",
      evidence: refs(atLimit),
    });
    const cancelAtLimit = await POST(`/transfers/${trId("dl2Full")}/cancel`, { as: "a" });
    const afterCancelLimit = await transfer(null, "a", "ADL2", "BU1", 1);
    ck({
      id: "cancelling-does-not-return-daily-room",
      obligation: RULE.daily,
      title: "usage is reserved at creation: cancelling the transfer does not give the room back",
      pass: !!cancelAtLimit && cancelAtLimit.status === 200
        && !!afterCancelLimit && afterCancelLimit.status === 422
        && afterCancelLimit.json && afterCancelLimit.json.error
        && afterCancelLimit.json.error.code === "daily_limit_exceeded",
      expected: "after cancelling a 100000 transfer, a further 1 is 422 daily_limit_exceeded",
      observed: `cancel ${short(cancelAtLimit)}; next transfer ${short(afterCancelLimit)} — ${bodySnippet(afterCancelLimit, 140)}`,
      evidence: refs(atLimit, cancelAtLimit, afterCancelLimit),
    });

    // ADL3 holds 60000: both of these clear the creation-time balance check and
    // stay inside the daily limit, but together they exceed the balance, so the
    // second must fail at settlement.
    const dl3a = await transfer("dl3a", "a", "ADL3", "BU1", 50000);
    const dl3b = await transfer("dl3b", "a", "ADL3", "BU1", 40000);
    ck({
      id: "creation-time-funds-check-is-against-the-current-balance",
      obligation: RULE.settlement,
      title: "two transfers each covered by the current balance are both created, even though together they exceed it",
      pass: !!dl3a && dl3a.status === 201 && !!dl3b && dl3b.status === 201,
      expected: "201 for 50000 and 201 for 40000 from an account holding 60000",
      observed: `50000 -> ${short(dl3a)}; 40000 -> ${short(dl3b)}`,
      note: "sets up the settlement-time re-check: the second must end failed, not settled.",
      evidence: refs(deps.ADL3, dl3a, dl3b),
    });

    // ---------- T12: closure ----------
    const closed = await POST(`/accounts/${id("ACLOSE")}/close`, { as: "a" });
    ck({
      id: "close-soft-deletes-the-account",
      obligation: RULE.lifecycle,
      title: "closing an account with no pending transfers returns it closed with closed_at set",
      pass: !!closed && closed.status === 200 && closed.json && closed.json.status === "closed"
        && typeof closed.json.closed_at === "string",
      expected: '200 with status "closed" and a closed_at timestamp',
      observed: `${short(closed)} — ${bodySnippet(closed, 200)}`,
      evidence: refs(closed),
    });
    const closedGet = await GET(`/accounts/${id("ACLOSE")}`, { as: "a" });
    ck({
      id: "closed-account-reads-410-with-a-tombstone",
      obligation: RULE.errors,
      title: "a closed account answers 410 and the error details carry the tombstone",
      pass: !!closedGet && closedGet.status === 410 && closedGet.json && closedGet.json.error
        && typeof closedGet.json.error.code === "string"
        && closedGet.json.error.details && typeof closedGet.json.error.details === "object",
      expected: "410 with error.details carrying the tombstone",
      observed: `${short(closedGet)} — ${bodySnippet(closedGet, 200)}`,
      evidence: refs(closed, closedGet),
    });
    const closedEntries = await GET(`/accounts/${id("ACLOSE")}/entries${qs([["limit", 100]])}`, { as: "a" });
    ck({
      id: "closed-account-still-serves-its-history",
      obligation: RULE.lifecycle,
      title: "closure is a soft delete: the closed account still serves its ledger entries",
      pass: !!closedEntries && closedEntries.status === 200 && closedEntries.json
        && Array.isArray(closedEntries.json.items) && closedEntries.json.items.length === 1
        && closedEntries.json.items[0] && closedEntries.json.items[0].amount === 5000,
      expected: "200 with the single 5000 deposit entry still present",
      observed: `${short(closedEntries)} — ${(closedEntries.json && Array.isArray(closedEntries.json.items) ? closedEntries.json.items.length : "?")} entries`,
      evidence: refs(deps.ACLOSE, closed, closedEntries),
    });
    const reactivate = await POST(`/accounts/${id("ACLOSE")}/activate`, { as: "a" });
    ckStatus("closure-is-terminal", RULE.lifecycle,
      "a closed account is never activated again", reactivate, 410, { extra: refs(closed) });
    const recloseRes = await POST(`/accounts/${id("ACLOSE")}/close`, { as: "a" });
    ckStatus("closing-a-closed-account-is-410", RULE.lifecycle,
      "closing an already closed account is refused with the tombstone status", recloseRes, 410, { extra: refs(closed) });
    const depClosed = await POST("/deposits", { as: "a", body: { account_id: id("ACLOSE"), amount: 100 } });
    ckStatus("deposit-into-closed-account-is-410", RULE.lifecycle,
      "a deposit into a closed account is rejected", depClosed, 410, { extra: refs(closed) });
    const fromClosed = await POST("/transfers", { as: "a", body: { source_account_id: id("ACLOSE"), destination_account_id: id("BU1"), amount: 100 } });
    ckStatus("transfer-from-closed-account-is-410", RULE.lifecycle,
      "a transfer naming a closed account as source is rejected", fromClosed, 410, { extra: refs(closed) });
    const toClosed = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), destination_account_id: id("ACLOSE"), amount: 100 } });
    ckStatus("transfer-to-closed-account-is-410", RULE.lifecycle,
      "a transfer naming a closed account as destination is rejected", toClosed, 410, { extra: refs(closed) });
    const crossClose = await POST(`/accounts/${id("AU1")}/close`, { as: "b" });
    ckStatus("cross-principal-close-is-403", RULE.ownership,
      "customer B may not close customer A's account", crossClose, 403);

    // pending transfers block closure on both sides
    const blockSend = await transfer("blockSend", "a", "AU2", "BU1", 500);
    const closeSender = await POST(`/accounts/${id("AU2")}/close`, { as: "a" });
    ckStatus("close-blocked-by-a-pending-outgoing-transfer", RULE.lifecycle,
      "an account with a pending transfer it is sending cannot be closed", closeSender, 409,
      { extra: refs(blockSend) });
    const blockRecv = await transfer("blockRecv", "a", "AU1", "ADMB", 300);
    const closeReceiver = await POST(`/accounts/${id("ADMB")}/close`, { as: "b" });
    ckStatus("close-blocked-by-a-pending-incoming-transfer", RULE.lifecycle,
      "an account with a pending transfer it is receiving cannot be closed", closeReceiver, 409,
      { extra: refs(blockRecv) });
    const unblock = await POST(`/transfers/${trId("blockSend")}/cancel`, { as: "a" });
    const closeSender2 = await POST(`/accounts/${id("AU2")}/close`, { as: "a" });
    ck({
      id: "close-succeeds-once-the-pending-transfer-is-gone",
      obligation: RULE.lifecycle,
      title: "the 409 lifts as soon as the blocking transfer is cancelled",
      pass: !!unblock && unblock.status === 200 && !!closeSender2 && closeSender2.status === 200
        && closeSender2.json && closeSender2.json.status === "closed",
      expected: "cancel 200, then close 200 with status closed",
      observed: `cancel ${short(unblock)}; close ${short(closeSender2)}`,
      evidence: refs(blockSend, closeSender, unblock, closeSender2),
    });

    // ---------- T13: transfers that must be refused ----------
    const fromPending = await POST("/transfers", { as: "a", body: { source_account_id: id("APEND"), destination_account_id: id("BU1"), amount: 100 } });
    ckStatus("transfer-from-never-activated-account-is-409", RULE.lifecycle,
      "a transfer naming a never-activated account as source is rejected for its state", fromPending, 409);
    const toPending = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), destination_account_id: id("APEND"), amount: 100 } });
    ckStatus("transfer-to-never-activated-account-is-409", RULE.lifecycle,
      "a transfer naming a never-activated account as destination is rejected for its state", toPending, 409);
    const sameAccount = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), destination_account_id: id("AU1"), amount: 100 } });
    ckStatus("self-transfer-is-422", RULE.errors,
      "a well-formed transfer refused by a business rule is 422 (same_account)", sameAccount, 422, { code: "same_account" });
    const crossCurrency = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), destination_account_id: id("BE1"), amount: 100 } });
    ckStatus("cross-currency-transfer-is-422", RULE.errors,
      "a transfer between accounts of different currencies is 422 currency_mismatch", crossCurrency, 422, { code: "currency_mismatch" });
    const wrongAssert = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: 100, currency: "EUR" } });
    ckStatus("currency-assertion-mismatch-is-422", RULE.params,
      "the optional currency assertion is honoured: asserting EUR on a USD source is 422", wrongAssert, 422, { code: "currency_mismatch" });
    const broke = await POST("/transfers", { as: "b", body: { source_account_id: id("BE1"), destination_account_id: id("AE1"), amount: 50000 } });
    ckStatus("underfunded-transfer-is-422", RULE.errors,
      "a transfer the source cannot cover at creation is 422 insufficient_funds", broke, 422, { code: "insufficient_funds", extra: refs(deps.BE1) });
    const zeroAmount = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: 0 } });
    ck({
      id: "zero-amount-transfer-is-refused",
      obligation: RULE.errors,
      title: "a transfer of 0 is refused rather than created",
      pass: !!zeroAmount && (zeroAmount.status === 400 || zeroAmount.status === 422),
      expected: "400 or 422",
      observed: `${short(zeroAmount)} — ${bodySnippet(zeroAmount, 140)}`,
      evidence: refs(zeroAmount),
    });
    const negAmount = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: -5000 } });
    ck({
      id: "negative-amount-transfer-is-refused",
      obligation: RULE.errors,
      title: "a negative transfer is refused, so a transfer cannot be used to pull money the other way",
      pass: !!negAmount && (negAmount.status === 400 || negAmount.status === 422),
      expected: "400 or 422",
      observed: `${short(negAmount)} — ${bodySnippet(negAmount, 140)}`,
      evidence: refs(negAmount),
    });
    const strAmount = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: "100" } });
    ck({
      id: "transfer-wrongly-typed-amount-is-refused",
      obligation: RULE.errors,
      title: "a string amount on POST /transfers is refused as malformed input or as invalid_amount",
      pass: !!strAmount && (strAmount.status === 400
        || (strAmount.status === 422 && strAmount.json && strAmount.json.error && strAmount.json.error.code === "invalid_amount")),
      expected: "400, or 422 with error.code invalid_amount",
      observed: `${short(strAmount)} — ${bodySnippet(strAmount, 140)}`,
      note: 'the 422 description for this operation enumerates invalid_amount, so the service is entitled to route amount validation there; the "wrongly typed is 400" clause is exercised separately on a non-amount field.',
      evidence: refs(strAmount, wrongTypeAccount),
    });
    const badTransferJson = await POST("/transfers", { as: "a", rawBody: "{not json at all", contentType: "application/json" });
    ckStatus("transfer-unparseable-body-is-400", RULE.errors,
      "an unparseable POST /transfers body is 400", badTransferJson, 400);
    const missingDest = await POST("/transfers", { as: "a", body: { source_account_id: id("AU1"), amount: 100 } });
    ckStatus("transfer-missing-required-field-is-400", RULE.errors,
      "a POST /transfers missing destination_account_id is 400", missingDest, 400);
    const anonTransfer = await POST("/transfers", { as: "none", body: { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: 100 } });
    ckStatus("transfer-requires-credential", RULE.errors,
      "POST /transfers without a credential is 401", anonTransfer, 401);
    const crossSpend = await POST("/transfers", { as: "b", body: { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: 100 } });
    ckStatus("spending-from-another-principals-account-is-403", RULE.ownership,
      "only the principal owning the source account may create a transfer from it", crossSpend, 403);

    const recancel = await POST(`/transfers/${trId("idem1")}/cancel`, { as: "a" });
    ckStatus("cancelling-a-canceled-transfer-is-409", RULE.lifecycle,
      "a transfer that was already canceled cannot be canceled again", recancel, 409,
      { extra: refs(cancelIdem1) });
    const crossCancel = await POST(`/transfers/${trId("idem2")}/cancel`, { as: "b" });
    ckStatus("cancelling-another-principals-transfer-is-403", RULE.ownership,
      "only the principal owning the source account may cancel a transfer, even though the destination owner can read it", crossCancel, 403,
      { extra: refs(idem2) });
    const anonCancel = await POST(`/transfers/${trId("idem2")}/cancel`, { as: "none" });
    ckStatus("cancel-requires-credential", RULE.errors,
      "POST /transfers/{id}/cancel without a credential is 401", anonCancel, 401);
    const readAsDestination = await GET(`/transfers/${trId("idem2")}`, { as: "b" });
    ck({
      id: "transfer-is-readable-by-the-destination-owner",
      obligation: RULE.ownership,
      title: "being paid by a stranger makes the transfer visible without making the payer's account visible",
      pass: !!readAsDestination && readAsDestination.status === 200 && readAsDestination.json
        && readAsDestination.json.id === trId("idem2")
        && !!accCross && accCross.status === 403,
      expected: "200 on the transfer for the destination owner, while the source account itself stays 403",
      observed: `transfer read ${short(readAsDestination)}; source account read ${short(accCross)}`,
      evidence: refs(idem2, readAsDestination, accCross),
    });
    const readAsSourceOfOther = await GET(`/transfers/${trId("idemB")}`, { as: "a" });
    ck({
      id: "transfer-is-readable-by-the-source-owner-too",
      obligation: RULE.ownership,
      title: "customer A can read the transfer customer B sent to A's account",
      pass: !!readAsSourceOfOther && readAsSourceOfOther.status === 200,
      expected: "200",
      observed: short(readAsSourceOfOther),
      evidence: refs(idemOtherPrincipal, readAsSourceOfOther),
    });

    // ---------- T14: the tick that settles everything ----------
    const pendingOrder = ["fee334", "fee1000", "fee3000", "consUsd", "consEur", "idemB", "idem2", "dl3a", "dl3b", "blockRecv"];
    const pendingIds = pendingOrder.map((k) => trId(k));
    const expectSettled = pendingOrder.filter((k) => k !== "dl3b").map((k) => trId(k));
    const beforeTick = await GET(`/transfers${qs([["limit", 100]])}`, { as: "admin" });
    const pendingBefore = Array.isArray(beforeTick && beforeTick.json && beforeTick.json.items)
      ? beforeTick.json.items.filter((t) => t && t.status === "pending").map((t) => t.id)
      : [];
    const bigTick = await POST("/admin/tick", { as: "admin", body: {} });
    W.dayAfterBigTick = bigTick && bigTick.json ? bigTick.json.day : null;
    const tickSettled = (bigTick && bigTick.json && bigTick.json.settled) || [];
    const tickFailed = (bigTick && bigTick.json && bigTick.json.failed) || [];
    ck({
      id: "a-tick-leaves-nothing-pending",
      obligation: RULE.settlement,
      title: "a tick with no settle_limit ends every pending transfer as settled or failed",
      pass: !!bigTick && bigTick.status === 200 && bigTick.json && bigTick.json.pending === 0
        && tickSettled.length + tickFailed.length === pendingBefore.length
        && pendingBefore.length === 10,
      expected: `all 10 pending transfers resolved, pending 0 (pending before the tick: ${pendingBefore.length})`,
      observed: `${short(bigTick)} — settled ${tickSettled.length}, failed ${tickFailed.length}, pending ${JSON.stringify(bigTick && bigTick.json && bigTick.json.pending)}`,
      evidence: refs(beforeTick, bigTick),
    });
    ck({
      id: "settlement-runs-in-creation-order",
      obligation: RULE.settlement,
      title: "the tick settles pending transfers in creation order",
      pass: JSON.stringify(tickSettled) === JSON.stringify(expectSettled),
      expected: JSON.stringify(expectSettled),
      observed: JSON.stringify(tickSettled),
      note: "creation order is the order the ten transfers were posted; the one that can no longer be covered drops out into failed.",
      evidence: refs(bigTick, beforeTick),
    });
    ck({
      id: "funds-are-rechecked-at-settlement-time",
      obligation: RULE.settlement,
      title: "a transfer that can no longer be covered when its turn comes ends failed",
      pass: JSON.stringify(tickFailed) === JSON.stringify([trId("dl3b")]),
      expected: `failed exactly [${trId("dl3b")}] — the 40000 transfer from an account left holding 9900 after the 50000 one settled`,
      observed: `failed ${JSON.stringify(tickFailed)}`,
      evidence: refs(dl3a, dl3b, bigTick),
    });
    const failedTransfer = await GET(`/transfers/${trId("dl3b")}`, { as: "a" });
    const dl3Entries = await enumerateAll(`/accounts/${id("ADL3")}/entries`, { as: "a", limit: 100 });
    const dl3bEntries = dl3Entries.items.filter((e) => e && e.transfer_id === trId("dl3b"));
    ck({
      id: "a-failed-transfer-writes-no-entries",
      obligation: RULE.conservation,
      title: "a transfer that ends failed writes no ledger entries at all",
      pass: !!failedTransfer && failedTransfer.status === 200 && failedTransfer.json
        && failedTransfer.json.status === "failed"
        && typeof failedTransfer.json.failure_reason === "string"
        && dl3bEntries.length === 0,
      expected: 'status "failed" with a failure_reason, and zero ledger entries carrying its transfer id',
      observed: `status ${JSON.stringify(failedTransfer && failedTransfer.json && failedTransfer.json.status)}, failure_reason ${JSON.stringify(failedTransfer && failedTransfer.json && failedTransfer.json.failure_reason)}, entries ${dl3bEntries.length}`,
      evidence: refs(dl3b, bigTick, failedTransfer, dl3Entries.pages),
    });
    const cancelFailed = await POST(`/transfers/${trId("dl3b")}/cancel`, { as: "a" });
    ckStatus("cancelling-a-failed-transfer-is-409", RULE.lifecycle,
      "a transfer that has failed cannot be canceled", cancelFailed, 409, { extra: refs(bigTick) });
    const cancelSettled = await POST(`/transfers/${trId("consUsd")}/cancel`, { as: "a" });
    ckStatus("cancelling-a-settled-transfer-is-409", RULE.lifecycle,
      "a transfer that has already settled cannot be canceled", cancelSettled, 409, { extra: refs(bigTick) });

    const settledOnce = await GET(`/transfers/${trId("consUsd")}`, { as: "a" });
    const entriesOnce = await enumerateAll(`/accounts/${id("AU1")}/entries`, { as: "a", limit: 100 });
    const secondTick = await POST("/admin/tick", { as: "admin", body: {} });
    const settledTwice = await GET(`/transfers/${trId("consUsd")}`, { as: "a" });
    const entriesTwice = await enumerateAll(`/accounts/${id("AU1")}/entries`, { as: "a", limit: 100 });
    ck({
      id: "a-transfer-settles-only-once",
      obligation: RULE.settlement,
      title: "a second tick settles nothing again: no new effects, no changed timestamps",
      pass: !!secondTick && secondTick.status === 200 && secondTick.json
        && Array.isArray(secondTick.json.settled) && secondTick.json.settled.length === 0
        && Array.isArray(secondTick.json.failed) && secondTick.json.failed.length === 0
        && secondTick.json.pending === 0
        && sameResource(settledOnce && settledOnce.json, settledTwice && settledTwice.json)
        && entriesOnce.items.length === entriesTwice.items.length,
      expected: "settled [], failed [], pending 0; the settled transfer and the source account's entry count unchanged",
      observed: `${short(secondTick)} — settled ${JSON.stringify(secondTick && secondTick.json && secondTick.json.settled)}, entries ${entriesOnce.items.length} -> ${entriesTwice.items.length}, transfer diff ${diffKeys(settledOnce && settledOnce.json, settledTwice && settledTwice.json).join("; ") || "none"}`,
      evidence: refs(settledOnce, entriesOnce.pages, secondTick, settledTwice, entriesTwice.pages),
    });
    const replayAfterSettle = await POST("/transfers", {
      as: "a",
      body: { source_account_id: id("AU1"), destination_account_id: id("BU1"), amount: 800 },
      headers: { "idempotency-key": KEY2 },
    });
    ck({
      id: "settling-does-not-release-the-idempotency-key",
      obligation: RULE.idem,
      title: "after the keyed transfer settles the key still replays it rather than moving money again",
      pass: !!replayAfterSettle && replayAfterSettle.status === 200 && replayAfterSettle.json
        && replayAfterSettle.json.id === trId("idem2") && replayAfterSettle.json.status === "settled",
      expected: `200 returning ${trId("idem2")} in status settled`,
      observed: `${short(replayAfterSettle)} — id ${JSON.stringify(replayAfterSettle && replayAfterSettle.json && replayAfterSettle.json.id)}, status ${JSON.stringify(replayAfterSettle && replayAfterSettle.json && replayAfterSettle.json.status)}`,
      evidence: refs(idem2, bigTick, replayAfterSettle),
    });

    // ---------- T15: the daily limit does not reopen when a transfer fails ----------
    const refund = await deposit("ADL3", "a", 200000, "ADL3b");
    const dl3Top = await transfer("dl3Top", "a", "ADL3", "BU1", 10000);
    ck({
      id: "daily-usage-tops-out-at-exactly-the-limit",
      obligation: RULE.daily,
      title: "50000 settled plus 40000 failed plus 10000 brings the day's usage to exactly 100000, and the 10000 is accepted",
      pass: !!refund && refund.status === 201 && !!dl3Top && dl3Top.status === 201,
      expected: "201 for the transfer that lands exactly on the limit",
      observed: `deposit ${short(refund)}; transfer ${short(dl3Top)} — ${bodySnippet(dl3Top, 140)}`,
      evidence: refs(dl3a, dl3b, refund, dl3Top),
    });
    const overLimit = await transfer(null, "a", "ADL3", "BU1", 1);
    ck({
      id: "failing-does-not-return-daily-room",
      obligation: RULE.daily,
      title: "a transfer that failed at settlement still counts against the day, so one more minor unit is refused",
      pass: !!overLimit && overLimit.status === 422 && overLimit.json && overLimit.json.error
        && overLimit.json.error.code === "daily_limit_exceeded",
      expected: "422 daily_limit_exceeded for an amount of 1 once the day's total is 100000",
      observed: `${short(overLimit)} — ${bodySnippet(overLimit, 160)}`,
      note: "the account holds ~199860 at this point, so funds cannot be the reason for the refusal.",
      evidence: refs(dl3a, dl3b, refund, dl3Top, overLimit),
    });

    // ---------- T16: the ledger day rolls over ----------
    const preRoll = await transfer("preRoll", "a", "AU1", "BU1", 250);
    const rollTick = await POST("/admin/tick", { as: "admin", body: { advance_day: true } });
    W.dayAfterRoll = rollTick && rollTick.json ? rollTick.json.day : null;
    const rollSettled = (rollTick && rollTick.json && rollTick.json.settled) || [];
    ck({
      id: "a-day-rolling-tick-is-still-a-tick",
      obligation: RULE.settlement,
      title: "a tick that advances the day also settles every pending transfer",
      pass: !!rollTick && rollTick.status === 200 && rollTick.json && rollTick.json.pending === 0
        && rollSettled.length === 2
        && rollSettled.includes(trId("preRoll")) && rollSettled.includes(trId("dl3Top")),
      expected: `settled both pending transfers (${trId("dl3Top")}, ${trId("preRoll")}) and pending 0`,
      observed: `${short(rollTick)} — settled ${JSON.stringify(rollSettled)}, pending ${JSON.stringify(rollTick && rollTick.json && rollTick.json.pending)}`,
      evidence: refs(dl3Top, preRoll, rollTick),
    });
    ck({
      id: "advance-day-increments-the-ledger-day",
      obligation: RULE.params,
      title: "advance_day rolls the ledger day over by exactly one, and a tick without it does not",
      pass: Number.isInteger(W.dayAfterBigTick) && Number.isInteger(W.dayAfterRoll)
        && W.dayAfterRoll === W.dayAfterBigTick + 1
        && !!secondTick && secondTick.json && secondTick.json.day === W.dayAfterBigTick,
      expected: `day ${W.dayAfterBigTick} -> ${W.dayAfterBigTick === null ? "?" : W.dayAfterBigTick + 1}, and the plain tick in between leaves it at ${W.dayAfterBigTick}`,
      observed: `big tick day ${W.dayAfterBigTick}, plain tick day ${JSON.stringify(secondTick && secondTick.json && secondTick.json.day)}, advance_day tick day ${W.dayAfterRoll}`,
      evidence: refs(bigTick, secondTick, rollTick),
    });
    const afterRollLimit = await transfer("postRoll", "a", "ADL2", "BU1", 1);
    ck({
      id: "rolling-the-day-resets-the-usage-to-zero",
      obligation: RULE.daily,
      title: "an account that was refused at the limit yesterday can transfer again after the day rolls",
      pass: !!afterRollLimit && afterRollLimit.status === 201,
      expected: "201 from the account that answered 422 daily_limit_exceeded before the roll",
      observed: `${short(afterRollLimit)} — ${bodySnippet(afterRollLimit, 140)}`,
      evidence: refs(afterCancelLimit, rollTick, afterRollLimit),
    });
    const replayAfterRoll = await POST("/transfers", { as: "a", body: idemBody, headers: { "idempotency-key": KEY1 } });
    ck({
      id: "the-idempotency-key-survives-the-day-roll",
      obligation: RULE.idem,
      title: "the record of a key does not expire when the ledger day rolls over",
      pass: !!replayAfterRoll && replayAfterRoll.status === 200 && replayAfterRoll.json
        && replayAfterRoll.json.id === trId("idem1"),
      expected: `200 still returning ${trId("idem1")}`,
      observed: `${short(replayAfterRoll)} — id ${JSON.stringify(replayAfterRoll && replayAfterRoll.json && replayAfterRoll.json.id)}`,
      evidence: refs(idem1, rollTick, replayAfterRoll),
    });
    const finalTick = await POST("/admin/tick", { as: "admin", body: {} });
    ck({
      id: "the-world-comes-to-rest",
      obligation: RULE.settlement,
      title: "a final tick leaves nothing pending, so every later read is of a quiescent ledger",
      pass: !!finalTick && finalTick.status === 200 && finalTick.json && finalTick.json.pending === 0
        && Array.isArray(finalTick.json.settled) && finalTick.json.settled.length === 1
        && finalTick.json.settled[0] === trId("postRoll"),
      expected: `settled [${trId("postRoll")}], pending 0`,
      observed: `${short(finalTick)} — ${bodySnippet(finalTick, 160)}`,
      evidence: refs(afterRollLimit, finalTick),
    });
    // Probed here, on a quiescent ledger, so that whichever way it goes it
    // cannot change the resources every later count depends on.
    const unknownProp = await POST("/admin/tick", { as: "admin", body: { totally_unknown: true } });
    advise("unknown body property",
      `TickRequest declares additionalProperties:false; POST /admin/tick with an undeclared member answered ${short(unknownProp)}. The invariant statement's leniency exception is scoped to unknown *query* parameters, so an undeclared body member is arguably out of contract — recorded, not gated, because the rule makes no claim about body members it never names.`,
      refs(unknownProp));

    // ---------- T17: pagination, on a ledger nothing is writing to ----------
    const accountsFull = await enumerateAll("/accounts", { as: "admin", limit: 100, extra: [["include_closed", "true"]] });
    const accountsPaged = await enumerateAll("/accounts", { as: "admin", limit: 2, extra: [["include_closed", "true"]], maxPages: 20 });
    const accD = pageDiscipline(accountsPaged.pages, 2);
    const fullIds = new Set(accountsFull.items.map((a) => a && a.id));
    const missingFromPaged = [...fullIds].filter((x) => !accD.seen.has(x));
    ck({
      id: "accounts-enumeration-is-disciplined",
      obligation: RULE.pagination,
      title: "enumerating GET /accounts at limit=2 terminates, never repeats an id, and never overfills or short-changes a page",
      pass: accountsPaged.terminated && accD.duplicates.length === 0 && accD.oversize.length === 0
        && accD.shortWithNext.length === 0,
      expected: "termination, no duplicate id, no page over the limit, no short page claiming there is more to come",
      observed: `${accountsPaged.pages.length} pages; terminated ${accountsPaged.terminated}; duplicates ${JSON.stringify(accD.duplicates)}; oversize ${JSON.stringify(accD.oversize)}; short-with-next ${JSON.stringify(accD.shortWithNext)}`,
      evidence: refs(accountsPaged.pages),
    });
    const closedIds = new Set(accountsFull.items.filter((a) => a && a.status === "closed").map((a) => a.id));
    // Compared like-for-like on two single-page reads, so that the filter is
    // measured independently of how cursor enumeration behaves.
    const openOnePage = await GET(`/accounts${qs([["limit", 100]])}`, { as: "admin" });
    const openOneIds = Array.isArray(openOnePage && openOnePage.json && openOnePage.json.items)
      ? openOnePage.json.items.map((a) => a && a.id) : [];
    const expectedOpenIds = accountsFull.items.map((a) => a && a.id).filter((x) => !closedIds.has(x));
    const accountsOpen = await enumerateAll("/accounts", { as: "admin", limit: 5, maxPages: 20 });
    const openD = pageDiscipline(accountsOpen.pages, 5);
    const closedLeaked = accountsOpen.items.filter((a) => a && (a.status === "closed" || closedIds.has(a.id)));
    ck({
      id: "include-closed-filters-both-ways",
      obligation: RULE.params,
      title: "include_closed=true includes closed accounts and its absence excludes them",
      pass: closedIds.size === 2 && closedLeaked.length === 0
        && JSON.stringify(openOneIds) === JSON.stringify(expectedOpenIds),
      expected: `the two closed accounts appear only with the flag: ${accountsFull.items.length} accounts with it, ${expectedOpenIds.length} without`,
      observed: `closed with the flag: ${closedIds.size} (${[...closedIds].join(", ")}); without the flag ${openOneIds.length} accounts, ${closedLeaked.length} closed leaking into the paged listing`,
      evidence: refs(accountsFull.pages, openOnePage, accountsOpen.pages, closed, closeSender2),
    });
    const missingFromOpen = expectedOpenIds.filter((x) => !openD.seen.has(x));
    ck({
      id: "accounts-enumeration-is-complete",
      obligation: RULE.pagination,
      title: "a cursor enumeration of GET /accounts returns every account that satisfied the filter when it began",
      pass: missingFromPaged.length === 0 && missingFromOpen.length === 0 && fullIds.size === 13,
      expected: `all ${fullIds.size} accounts at limit=2, and all ${expectedOpenIds.length} open accounts at limit=5; nothing was written to the collection during either enumeration`,
      observed: `limit=2: ${accD.seen.size} of ${fullIds.size}, missing ${JSON.stringify(missingFromPaged)} across ${accountsPaged.pages.length} pages (last page empty, next_cursor null). limit=5: ${openD.seen.size} of ${expectedOpenIds.length}, missing ${JSON.stringify(missingFromOpen)} across ${accountsOpen.pages.length} pages`,
      note: 'the cursor is a base64 {"s":N} position and a page carries items strictly older than N, so the account at position 0 is unreachable: the last cursor the service hands out always yields an empty page and that account is dropped at every page size. The single-page read at limit=100 does list it. The declared exception does not apply — both enumerations ran on a quiescent ledger with no concurrent write.',
      evidence: refs(accountsFull.pages, accountsPaged.pages, openOnePage, accountsOpen.pages),
    });
    ck({
      id: "filtered-enumeration-satisfies-its-filter-on-every-page",
      obligation: RULE.pagination,
      title: "every item on every page of the unfiltered-for-closed enumeration satisfies the filter",
      pass: closedLeaked.length === 0 && accountsOpen.terminated && openD.oversize.length === 0,
      expected: "no closed account on any page, enumeration terminates, no page over the requested limit of 5",
      observed: `${accountsOpen.pages.length} pages, ${accountsOpen.items.length} items, closed present ${closedLeaked.length}, oversize ${JSON.stringify(openD.oversize)}`,
      evidence: refs(accountsOpen.pages),
    });

    const limitOne = await GET(`/accounts${qs([["limit", 1], ["include_closed", "true"]])}`, { as: "admin" });
    ck({
      id: "limit-bounds-the-page-size",
      obligation: RULE.params,
      title: "limit=1 returns at most one item and still offers a cursor while more remain",
      pass: !!limitOne && limitOne.status === 200 && limitOne.json && Array.isArray(limitOne.json.items)
        && limitOne.json.items.length === 1 && typeof limitOne.json.next_cursor === "string",
      expected: "200 with exactly 1 item and a non-null next_cursor",
      observed: `${short(limitOne)} — ${(limitOne.json && Array.isArray(limitOne.json.items) ? limitOne.json.items.length : "?")} items, next_cursor ${JSON.stringify(limitOne.json && limitOne.json.next_cursor)}`,
      evidence: refs(limitOne),
    });
    const limitZero = await GET("/accounts?limit=0", { as: "admin" });
    ckStatus("limit-below-range-is-400", RULE.params, "limit=0 is outside the documented range and is refused", limitZero, 400);
    const limitBig = await GET("/accounts?limit=101", { as: "admin" });
    ckStatus("limit-above-range-is-400", RULE.params, "limit=101 is outside the documented maximum of 100 and is refused", limitBig, 400);
    const limitMax = await GET(`/accounts${qs([["limit", 100], ["include_closed", "true"]])}`, { as: "admin" });
    ck({
      id: "limit-at-its-documented-maximum-is-accepted",
      obligation: RULE.params,
      title: "limit=100, the documented maximum, is accepted",
      pass: !!limitMax && limitMax.status === 200,
      expected: "200",
      observed: short(limitMax),
      evidence: refs(limitMax, limitBig),
    });
    const limitJunk = await GET("/accounts?limit=abc", { as: "admin" });
    ckStatus("non-numeric-limit-is-400", RULE.errors, "a non-numeric limit is a malformed request, so 400", limitJunk, 400);
    const cursorJunk = await GET("/accounts?cursor=not-a-real-cursor", { as: "admin" });
    ckStatus("garbage-cursor-is-400", RULE.errors, "a cursor the service did not issue is 400", cursorJunk, 400);
    const unknownQuery = await GET(`/accounts${qs([["limit", 100], ["include_closed", "true"], ["totally_unknown", "1"]])}`, { as: "admin" });
    ck({
      id: "unknown-query-parameter-is-ignored",
      obligation: RULE.params,
      title: "an unsupported query parameter is ignored rather than refused, and changes nothing",
      pass: !!unknownQuery && unknownQuery.status === 200 && unknownQuery.json
        && JSON.stringify((unknownQuery.json.items || []).map((a) => a && a.id)) === JSON.stringify(accountsFull.items.map((a) => a && a.id)),
      expected: "200 returning the same accounts, in the same order, as the request without it",
      observed: `${short(unknownQuery)} — ${(unknownQuery.json && Array.isArray(unknownQuery.json.items) ? unknownQuery.json.items.length : "?")} items vs ${accountsFull.items.length}`,
      note: "the one declared exception to the documented-parameters rule.",
      evidence: refs(accountsFull.pages, unknownQuery),
    });

    const listA = await enumerateAll("/accounts", { as: "a", limit: 100, extra: [["include_closed", "true"]] });
    const listB = await enumerateAll("/accounts", { as: "b", limit: 100, extra: [["include_closed", "true"]] });
    const foreignToA = listA.items.filter((a) => a && a.kind !== "system" && a.owner_principal !== W.principalA);
    const foreignToB = listB.items.filter((a) => a && a.kind !== "system" && a.owner_principal !== W.principalB);
    ck({
      id: "account-listing-never-discloses-another-principals-account",
      obligation: RULE.ownership,
      title: "the account collection shows a customer only its own accounts and the system fee accounts",
      pass: foreignToA.length === 0 && foreignToB.length === 0 && listA.items.length > 0 && listB.items.length > 0,
      expected: "every listed account is owned by the caller or has kind system",
      observed: `A sees ${listA.items.length} (${foreignToA.length} foreign: ${foreignToA.map((a) => a.id).join(",")}); B sees ${listB.items.length} (${foreignToB.length} foreign: ${foreignToB.map((a) => a.id).join(",")})`,
      evidence: refs(listA.pages, listB.pages),
    });

    const transfersFull = await enumerateAll("/transfers", { as: "admin", limit: 100 });
    const transfersPaged = await enumerateAll("/transfers", { as: "admin", limit: 5, maxPages: 20 });
    const trD = pageDiscipline(transfersPaged.pages, 5);
    const trFullIds = new Set(transfersFull.items.map((t) => t && t.id));
    const trMissing = [...trFullIds].filter((x) => !trD.seen.has(x));
    ck({
      id: "transfers-enumeration-is-disciplined-and-complete",
      obligation: RULE.pagination,
      title: "enumerating GET /transfers at limit=5 terminates, never repeats an id, and returns every transfer",
      pass: transfersPaged.terminated && trD.duplicates.length === 0 && trD.oversize.length === 0
        && trD.shortWithNext.length === 0 && trMissing.length === 0 && trFullIds.size === 18,
      expected: "18 distinct transfers across pages of at most 5, last page short with next_cursor null",
      observed: `${transfersPaged.pages.length} pages, ${trD.ids.length} items, ${trD.seen.size} distinct; terminated ${transfersPaged.terminated}; duplicates ${JSON.stringify(trD.duplicates)}; oversize ${JSON.stringify(trD.oversize)}; short-with-next ${JSON.stringify(trD.shortWithNext)}; missing ${JSON.stringify(trMissing)}; single-page total ${trFullIds.size}`,
      evidence: refs(transfersFull.pages, transfersPaged.pages),
    });
    const byAccount = await enumerateAll("/transfers", { as: "a", limit: 100, extra: [["account_id", id("AFEE")]] });
    const offFilter = byAccount.items.filter((t) => t && t.source_account_id !== id("AFEE") && t.destination_account_id !== id("AFEE"));
    const expectedForFee = transfersFull.items.filter((t) => t && (t.source_account_id === id("AFEE") || t.destination_account_id === id("AFEE")));
    ck({
      id: "account-id-filter-restricts-to-either-side",
      obligation: RULE.params,
      title: "account_id on GET /transfers restricts the collection to transfers naming that account on either side",
      pass: offFilter.length === 0 && byAccount.items.length === expectedForFee.length && expectedForFee.length === 5,
      expected: `all 5 fee-lab transfers and nothing else (${expectedForFee.length} name ${id("AFEE")} in the unfiltered collection)`,
      observed: `${byAccount.items.length} items, ${offFilter.length} not naming the account`,
      evidence: refs(byAccount.pages, transfersFull.pages),
    });

    const entriesPaged = await enumerateAll(`/accounts/${id("BU1")}/entries`, { as: "b", limit: 4, maxPages: 20 });
    const entriesFull = await enumerateAll(`/accounts/${id("BU1")}/entries`, { as: "b", limit: 100 });
    const entD = pageDiscipline(entriesPaged.pages, 4);
    const entFullIds = new Set(entriesFull.items.map((e) => e && e.id));
    const entMissing = [...entFullIds].filter((x) => !entD.seen.has(x));
    ck({
      id: "entries-enumeration-is-disciplined-and-complete",
      obligation: RULE.pagination,
      title: "enumerating a busy account's ledger entries at limit=4 terminates, never repeats an entry, and returns all of them",
      pass: entriesPaged.terminated && entD.duplicates.length === 0 && entD.oversize.length === 0
        && entD.shortWithNext.length === 0 && entMissing.length === 0 && entFullIds.size > 4,
      expected: "every entry exactly once across pages of at most 4, matching the single-page enumeration",
      observed: `${entriesPaged.pages.length} pages, ${entD.ids.length} items, ${entD.seen.size} distinct vs ${entFullIds.size} on one page; terminated ${entriesPaged.terminated}; duplicates ${JSON.stringify(entD.duplicates)}; oversize ${JSON.stringify(entD.oversize)}; short-with-next ${JSON.stringify(entD.shortWithNext)}; missing ${JSON.stringify(entMissing)}`,
      evidence: refs(entriesPaged.pages, entriesFull.pages),
    });

    // The account holding the earliest ledger entry in the whole run, to see
    // whether the dropped-oldest-item behaviour is specific to /accounts.
    const oldestPaged = await enumerateAll(`/accounts/${id("AU1")}/entries`, { as: "a", limit: 2, maxPages: 12 });
    const oldestFull = await enumerateAll(`/accounts/${id("AU1")}/entries`, { as: "a", limit: 100 });
    const oldD = pageDiscipline(oldestPaged.pages, 2);
    const oldMissing = oldestFull.items.map((e) => e && e.id).filter((x) => !oldD.seen.has(x));
    ck({
      id: "earliest-entries-survive-a-cursor-enumeration",
      obligation: RULE.pagination,
      title: "enumerating the entries of the account holding the run's earliest ledger entry returns all of them",
      pass: oldMissing.length === 0 && oldestPaged.terminated && oldD.duplicates.length === 0
        && oldestFull.items.length > 2,
      expected: `all ${oldestFull.items.length} entries returned across pages of at most 2`,
      observed: `${oldD.seen.size} of ${oldestFull.items.length} across ${oldestPaged.pages.length} pages; missing ${JSON.stringify(oldMissing)}; duplicates ${JSON.stringify(oldD.duplicates)}`,
      note: "companion to the GET /accounts completeness check: it isolates whether the unreachable-position-0 behaviour is a property of the cursor scheme generally or only of the account collection.",
      evidence: refs(oldestPaged.pages, oldestFull.pages),
    });

    W.accountsFull = accountsFull;
    W.transfersFull = transfersFull;

    // ---------- T18: the ledger audit, over a world nothing is writing to ----------
    // Balances were read in accountsFull above; the enumerations below follow
    // with no intervening write, which is the condition the invariant states.
    const byAccountEntries = new Map();
    const entryPages = [];
    const allEntries = [];
    for (const account of accountsFull.items) {
      if (!account || !account.id) continue;
      const e = await enumerateAll(`/accounts/${account.id}/entries`, { as: "admin", limit: 100, maxPages: 6 });
      byAccountEntries.set(account.id, e);
      entryPages.push(...e.pages);
      allEntries.push(...e.items);
    }

    const balanceProblems = [];
    for (const account of accountsFull.items) {
      if (!account || !account.id) continue;
      const e = byAccountEntries.get(account.id);
      if (!e || !e.terminated) { balanceProblems.push(`${account.id}: entry enumeration did not terminate cleanly`); continue; }
      const sum = sumAmounts(e.items);
      if (!Number.isInteger(account.balance)) balanceProblems.push(`${account.id}: balance ${JSON.stringify(account.balance)} is not an integer`);
      else if (sum !== account.balance) balanceProblems.push(`${account.id}: balance ${account.balance} but entries sum to ${sum} over ${e.items.length} rows`);
    }
    ck({
      id: "balance-equals-the-sum-of-its-entries",
      obligation: RULE.balance,
      title: "every account's stored balance equals the sum of its ledger entry amounts, fee accounts included",
      pass: balanceProblems.length === 0 && accountsFull.items.length === 13,
      expected: `all ${accountsFull.items.length} accounts agree exactly (signed integer minor units, no rounding)`,
      observed: balanceProblems.length ? balanceProblems.join(" | ") : `all ${accountsFull.items.length} accounts agree; ${allEntries.length} entries audited`,
      evidence: refs(accountsFull.pages, entryPages),
    });

    const feeUsdAcct = accountsFull.items.find((a) => a && a.id === FEE_USD);
    const feeEurAcct = accountsFull.items.find((a) => a && a.id === FEE_EUR);
    const settledTransfers = transfersFull.items.filter((t) => t && t.status === "settled");
    const unsettled = transfersFull.items.filter((t) => t && (t.status === "canceled" || t.status === "failed"));
    const entriesByTransfer = new Map();
    for (const e of allEntries) {
      if (!e || !e.transfer_id) continue;
      if (!entriesByTransfer.has(e.transfer_id)) entriesByTransfer.set(e.transfer_id, []);
      entriesByTransfer.get(e.transfer_id).push(e);
    }

    const conservationProblems = [];
    for (const t of settledTransfers) {
      const rows = entriesByTransfer.get(t.id) || [];
      const debits = rows.filter((r) => r.kind === "transfer_debit");
      const credits = rows.filter((r) => r.kind === "transfer_credit");
      const fees = rows.filter((r) => r.kind === "fee");
      const problems = [];
      if (rows.length !== 3) problems.push(`${rows.length} rows (want 3)`);
      if (debits.length !== 1 || credits.length !== 1 || fees.length !== 1) {
        problems.push(`kinds debit/credit/fee = ${debits.length}/${credits.length}/${fees.length}`);
      }
      if (debits[0]) {
        if (debits[0].amount !== -(t.amount + t.fee)) problems.push(`debit ${debits[0].amount} != -(amount+fee) ${-(t.amount + t.fee)}`);
        if (debits[0].account_id !== t.source_account_id) problems.push(`debit sits on ${debits[0].account_id}, not the source ${t.source_account_id}`);
      }
      if (credits[0]) {
        if (credits[0].amount !== t.amount) problems.push(`credit ${credits[0].amount} != amount ${t.amount}`);
        if (credits[0].account_id !== t.destination_account_id) problems.push(`credit sits on ${credits[0].account_id}, not the destination ${t.destination_account_id}`);
      }
      if (fees[0]) {
        if (fees[0].amount !== t.fee) problems.push(`fee row ${fees[0].amount} != fee ${t.fee}`);
        const wantFeeAcct = t.currency === "EUR" ? FEE_EUR : FEE_USD;
        if (fees[0].account_id !== wantFeeAcct) problems.push(`fee row sits on ${fees[0].account_id}, not ${wantFeeAcct}`);
      }
      const total = sumAmounts(rows);
      if (total !== 0) problems.push(`rows sum to ${total}, not 0`);
      if (problems.length) conservationProblems.push(`${t.id} (${t.currency} ${t.amount}+${t.fee}): ${problems.join("; ")}`);
    }
    ck({
      id: "settled-transfer-entries-sum-to-zero",
      obligation: RULE.conservation,
      title: "each settled transfer writes exactly one source debit, one destination credit and one fee credit, summing to zero",
      pass: conservationProblems.length === 0 && settledTransfers.length >= 12,
      expected: `all ${settledTransfers.length} settled transfers balance: debit -(amount+fee) on the source, credit +amount on the destination, +fee on the currency's system account`,
      observed: conservationProblems.length ? conservationProblems.slice(0, 6).join(" | ") : `all ${settledTransfers.length} settled transfers balance`,
      evidence: refs(transfersFull.pages, entryPages),
    });
    const strayEntries = unsettled.filter((t) => (entriesByTransfer.get(t.id) || []).length > 0);
    ck({
      id: "canceled-and-failed-transfers-write-no-entries",
      obligation: RULE.conservation,
      title: "a transfer that ends canceled or failed leaves no ledger entries behind",
      pass: strayEntries.length === 0 && unsettled.length >= 4,
      expected: `zero entries for all ${unsettled.length} canceled/failed transfers`,
      observed: strayEntries.length
        ? strayEntries.map((t) => `${t.id} (${t.status}) has ${(entriesByTransfer.get(t.id) || []).length} entries`).join("; ")
        : `${unsettled.length} canceled/failed transfers, none carrying an entry`,
      evidence: refs(transfersFull.pages, entryPages),
    });

    const feeProblems = [];
    for (const t of transfersFull.items) {
      if (!t) continue;
      const want = expectedFee(t.amount);
      if (t.fee !== want) feeProblems.push(`${t.id}: amount ${t.amount} declares fee ${t.fee}, schedule says ${want}`);
    }
    ck({
      id: "every-transfer-charges-the-scheduled-fee",
      obligation: RULE.fee,
      title: "every transfer in the collection, in either currency and at every status, carries the scheduled fee",
      pass: feeProblems.length === 0 && transfersFull.items.length === 18,
      expected: `all ${transfersFull.items.length} transfers satisfy fee = 25 + round_half_up(amount * 15 / 10000)`,
      observed: feeProblems.length ? feeProblems.slice(0, 6).join(" | ") : `all ${transfersFull.items.length} transfers match the schedule`,
      evidence: refs(transfersFull.pages),
    });
    const feeCollected = { USD: 0, EUR: 0 };
    for (const t of settledTransfers) feeCollected[t.currency === "EUR" ? "EUR" : "USD"] += t.fee;
    ck({
      id: "fee-accounts-hold-exactly-the-fees-collected",
      obligation: RULE.fee,
      title: "each system fee account's balance is the sum of the fees of the settled transfers in its currency",
      pass: !!feeUsdAcct && !!feeEurAcct && feeUsdAcct.balance === feeCollected.USD && feeEurAcct.balance === feeCollected.EUR
        && feeCollected.USD > 0 && feeCollected.EUR > 0,
      expected: `${FEE_USD} = ${feeCollected.USD}, ${FEE_EUR} = ${feeCollected.EUR}`,
      observed: `${FEE_USD} = ${JSON.stringify(feeUsdAcct && feeUsdAcct.balance)}, ${FEE_EUR} = ${JSON.stringify(feeEurAcct && feeEurAcct.balance)}`,
      evidence: refs(accountsFull.pages, transfersFull.pages),
    });

    const entryById = new Map(allEntries.map((e) => [e && e.id, e]));
    const accountById = new Map(accountsFull.items.map((a) => [a && a.id, a]));
    const transferById = new Map(transfersFull.items.map((t) => [t && t.id, t]));
    const refProblems = [];
    for (const t of transfersFull.items) {
      if (!t || t.fee_account_id == null) continue;
      const want = t.currency === "EUR" ? FEE_EUR : FEE_USD;
      if (t.fee_account_id !== want) refProblems.push(`${t.id}.fee_account_id ${t.fee_account_id} != ${want}`);
      else if (!accountById.has(t.fee_account_id)) refProblems.push(`${t.id}.fee_account_id ${t.fee_account_id} resolves to no account`);
    }
    for (const e of allEntries) {
      if (!e) continue;
      const acct = accountById.get(e.account_id);
      if (!acct) refProblems.push(`entry ${e.id} sits on unknown account ${e.account_id}`);
      else if (e.currency !== acct.currency) refProblems.push(`entry ${e.id} currency ${e.currency} != account ${acct.id} currency ${acct.currency}`);
      if (e.transfer_id != null && !transferById.has(e.transfer_id)) refProblems.push(`entry ${e.id}.transfer_id ${e.transfer_id} names no transfer`);
    }
    const depositChecks = [];
    for (const [key, dep] of Object.entries(W.dep)) {
      if (!dep || dep.entry_id == null) continue;
      depositChecks.push(key);
      const e = entryById.get(dep.entry_id);
      if (!e) { refProblems.push(`deposit ${dep.id}.entry_id ${dep.entry_id} names no ledger entry`); continue; }
      if (e.account_id !== dep.account_id) refProblems.push(`deposit ${dep.id} entry sits on ${e.account_id}, not ${dep.account_id}`);
      if (e.amount !== dep.amount) refProblems.push(`deposit ${dep.id} amount ${dep.amount} but entry ${e.amount}`);
      if (e.deposit_id !== dep.id) refProblems.push(`entry ${e.id}.deposit_id ${JSON.stringify(e.deposit_id)} != ${dep.id}`);
    }
    ck({
      id: "identifiers-resolve-and-the-two-resources-agree",
      obligation: RULE.refint,
      title: "every present cross-reference resolves and agrees: deposit entry_id, entry transfer_id and currency, transfer fee_account_id",
      pass: refProblems.length === 0 && depositChecks.length >= 8,
      expected: `all present references resolve (${depositChecks.length} deposits with an entry_id, ${allEntries.length} entries, ${transfersFull.items.length} transfers)`,
      observed: refProblems.length ? refProblems.slice(0, 6).join(" | ") : `all references resolve and agree across ${allEntries.length} entries`,
      note: "absence is the declared exception; only references that are present are checked.",
      evidence: refs(accountsFull.pages, transfersFull.pages, entryPages),
    });
  }

  try {
    await main();
  } catch (err) {
    problems.push(`sequence aborted: ${err && err.message ? err.message : String(err)}`);
  }

  // ---- tail: aggregate checks over recorded traffic ---------------------
  try {
    const real = traffic.filter((r) => r && !r.synthetic);
    const serverErrors = real.filter((r) => r.status >= 500);
    ck({
      id: "no-5xx-anywhere",
      obligation: RULE.errors,
      title: "no operation answers 5xx over the whole execution",
      pass: serverErrors.length === 0,
      expected: "0 responses with status >= 500",
      observed: serverErrors.length
        ? `${serverErrors.length}: ${serverErrors.slice(0, 8).map((r) => `${r.method} ${r.path} -> ${r.status}`).join("; ")}`
        : `0 of ${real.length} recorded responses`,
      evidence: serverErrors.length ? refs(serverErrors) : refs(real.slice(0, 20)),
    });

    const clientErrors = real.filter((r) => r.status >= 400 && r.status < 600);
    const malformed = [];
    for (const r of clientErrors) {
      const problem = errorShapeProblem(r);
      if (problem) malformed.push(`${r.method} ${r.path} -> ${r.status}: ${problem}`);
    }
    ck({
      id: "error-envelope-shape",
      obligation: RULE.errors,
      title: 'every 4xx/5xx body is {"error":{"code","message","details"?}} with string code and message',
      pass: malformed.length === 0 && clientErrors.length > 0,
      expected: `all ${clientErrors.length} error responses carry the documented envelope`,
      observed: clientErrors.length === 0
        ? "no error responses were recorded, so the envelope was never exercised"
        : malformed.length
          ? `${malformed.length} malformed: ${malformed.slice(0, 6).join(" | ")}`
          : `all ${clientErrors.length} error responses conform`,
      evidence: malformed.length
        ? refs(clientErrors.filter((r) => errorShapeProblem(r)))
        : refs(clientErrors.slice(0, 25)),
    });

    const falseSuccess = real.filter((r) => {
      if (r.status < 200 || r.status >= 300) return false;
      const j = r.json;
      return !!(j && typeof j === "object" && !Array.isArray(j) && j.error);
    });
    ck({
      id: "no-2xx-carrying-a-failure",
      obligation: RULE.errors,
      title: "a refusal is never reported as a 2xx carrying an error inside it",
      pass: falseSuccess.length === 0,
      expected: "no 2xx response body contains an `error` member",
      observed: falseSuccess.length
        ? falseSuccess.map((r) => `${r.method} ${r.path} -> ${r.status}`).join("; ")
        : `0 of ${real.filter((r) => r.ok).length} successful responses`,
      evidence: falseSuccess.length ? refs(falseSuccess) : refs(real.filter((r) => r.ok).slice(0, 15)),
    });

    const unauthorized = real.filter((r) => r.status === 401);
    const missingChallenge = unauthorized.filter((r) => !(r.headers && r.headers["www-authenticate"]));
    ck({
      id: "401-carries-www-authenticate",
      obligation: RULE.errors,
      title: "every 401 additionally carries a WWW-Authenticate header",
      pass: unauthorized.length > 0 && missingChallenge.length === 0,
      expected: "every 401 response carries WWW-Authenticate",
      observed: unauthorized.length === 0
        ? "no 401 responses were recorded"
        : missingChallenge.length
          ? `${missingChallenge.length} of ${unauthorized.length} 401s lack the header`
          : `all ${unauthorized.length} 401s carry it`,
      evidence: refs(missingChallenge.length ? missingChallenge : unauthorized),
    });
  } catch (err) {
    problems.push(`aggregate checks: ${err && err.message ? err.message : String(err)}`);
  }

  // ---- tail: soundness net --------------------------------------------
  // Any rule obligation the sequence never reached is reported as a failing
  // check rather than left unaccounted, so the run stays interpretable.
  for (const obligation of Object.values(RULE)) {
    if (coveredRules.has(obligation)) continue;
    ck({
      id: `unreached-${obligation.replace(/[^a-z0-9]+/gi, "-")}`,
      obligation,
      title: `${obligation} was not reached by this execution`,
      pass: false,
      expected: "the sequence covering this rule ran to completion",
      observed: problems.length ? problems.join(" | ").slice(0, 500) : "the sequence did not reach this rule",
      evidence: [],
    });
  }

  if (problems.length) {
    advise("suite encountered a problem while sequencing", problems.join(" | ").slice(0, 2000), []);
  }
  const b = client.budget;
  advise("budget", `used ${b && b.used} of ${b && b.limit}; mode ${client.mode}; ${traffic.length} recorded responses`, []);
}
