// Shared helpers for the minibank ledger suite.
// No dependencies; only the injected client is used for traffic.

export const ADMIN = "LEDGER_ADMIN_TOKEN";
export const CUST_A = "LEDGER_CUSTOMER_TOKEN";
export const CUST_B = "LEDGER_CUSTOMER_B_TOKEN";

export const FEE_USD = "acc_fee_usd";
export const FEE_EUR = "acc_fee_eur";
export const DAILY_LIMIT = 100000;

/** fee = 25 + round_half_away_from_zero(amount * 15 / 10000), integer minor units. */
export function expectedFee(amount) {
  const num = Math.abs(amount) * 15;
  const q = Math.floor(num / 10000);
  const r = num % 10000;
  return 25 + (r * 2 >= 10000 ? q + 1 : q);
}

export function makeHarness({ client, check }) {
  const seenIds = new Set();
  const thrown = [];

  function record(entry) {
    let id = entry.id;
    if (seenIds.has(id)) id = id + "~dup" + seenIds.size;
    seenIds.add(id);
    check({ ...entry, id });
  }

  /** Evidence builder: accepts response records, refs, arrays; drops anything unresolvable. */
  function ev(list, subject) {
    const requests = [];
    const push = (x) => {
      if (x === null || x === undefined) return;
      if (Array.isArray(x)) return x.forEach(push);
      if (Number.isInteger(x)) return void requests.push(x);
      if (Number.isInteger(x.ref)) return void requests.push(x.ref);
    };
    push(list);
    const out = { requests };
    if (subject !== undefined) out.subject = subject;
    return out;
  }

  /**
   * One request. Never throws: a guard refusal or a transport problem comes back
   * as a synthetic record with ref undefined so a check can still report on it.
   */
  async function call(method, path, opts = {}) {
    const { as, body, rawBody, headers, idemKey } = opts;
    const h = {};
    if (as) h.authorization = client.secret(as);
    if (idemKey) h["idempotency-key"] = idemKey;
    if (headers) Object.assign(h, headers);
    const req = {};
    if (Object.keys(h).length) req.headers = h;
    if (body !== undefined) req.body = body;
    if (rawBody !== undefined) req.rawBody = rawBody;
    try {
      return await client[method](path, req);
    } catch (e) {
      const msg = String((e && e.message) || e);
      thrown.push({ method, path, msg });
      return {
        ref: undefined,
        method,
        path,
        status: -1,
        headers: {},
        text: "",
        json: null,
        ok: false,
        clientThrew: msg,
      };
    }
  }

  const get = (p, o) => call("get", p, o);
  const post = (p, o) => call("post", p, o);

  /** Terse description of a response for `observed` strings. */
  function d(r) {
    if (!r) return "no response";
    if (r.clientThrew) return `client refused: ${r.clientThrew}`;
    if (r.transportError) return `transport error: ${String(r.transportError)}`;
    const code = r.json && r.json.error && r.json.error.code;
    return `status ${r.status}${code ? ` code ${JSON.stringify(code)}` : ""}`;
  }

  const errCode = (r) => (r && r.json && r.json.error && r.json.error.code) || null;
  const idOf = (r) => (r && r.json && typeof r.json.id === "string" ? r.json.id : null);

  /**
   * Follow next_cursor to termination. Returns pages, flattened items, and whether
   * the walk terminated on a null cursor rather than on the page cap.
   */
  async function walk(basePath, as, limit, maxPages) {
    const sep = basePath.includes("?") ? "&" : "?";
    const pages = [];
    let cursor = null;
    let terminated = false;
    let stalled = false;
    for (let n = 0; n < maxPages; n++) {
      const p =
        basePath + sep + "limit=" + limit + (cursor === null ? "" : "&cursor=" + encodeURIComponent(cursor));
      const r = await get(p, { as });
      pages.push(r);
      const next = r.json && Object.prototype.hasOwnProperty.call(r.json, "next_cursor") ? r.json.next_cursor : null;
      if (next === null || next === undefined || next === "") {
        terminated = true;
        break;
      }
      if (next === cursor) {
        stalled = true;
        break;
      }
      cursor = next;
    }
    const items = [];
    for (const p of pages) {
      if (p.json && Array.isArray(p.json.items)) items.push(...p.json.items);
    }
    return {
      pages,
      items,
      ids: items.map((x) => (x && typeof x.id === "string" ? x.id : null)),
      terminated,
      stalled,
    };
  }

  /** Run a block; if it throws, fail one check per obligation it was meant to cover. */
  async function section(name, obligations, fn) {
    try {
      await fn();
    } catch (e) {
      const detail = String((e && e.stack) || e);
      for (const obligation of obligations) {
        record({
          id: `section-${name}-completed-${obligation.replace(/[^a-z0-9]+/gi, "-")}`,
          obligation,
          title: `suite section "${name}" ran to completion`,
          pass: false,
          expected: "the section builds its state and evaluates its checks",
          observed: `the section threw: ${String((e && e.message) || e)}`,
          evidence: { requests: [], subject: { stack: detail.slice(0, 1200) } },
        });
      }
    }
  }

  const dupes = (arr) => {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      if (seen.has(x)) out.push(x);
      seen.add(x);
    }
    return out;
  };

  const setDiff = (a, b) => a.filter((x) => !b.includes(x));

  return { record, ev, call, get, post, d, errCode, idOf, walk, section, dupes, setDiff, thrown, check };
}
