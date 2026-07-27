// Test harness: boot the fixture on an ephemeral loopback port and talk to it
// over real HTTP. No external network, no dependencies, no fixtures on disk.
//
// The client records every exchange in the same HAR shape Playtest's api driver
// writes (`src/core/drivers/har.js`), so a test can hand its own traffic
// straight to the bench without a second recording path.

import { startServer } from "../../src/http.js";

export const ADMIN_TOKEN = "admin-token-test";
/** Two distinct customer principals: `customer_a` and `customer_b`. */
export const CUSTOMER_TOKEN = "customer-token-test";
export const CUSTOMER_B_TOKEN = "customer-b-token-test";

export class Client {
  constructor(baseUrl, { token = ADMIN_TOKEN } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    /** HAR entries in Playtest's api-driver shape. */
    this.har = [];
  }

  async request(method, path, { body, headers = {}, token = this.token } = {}) {
    const url = new URL(path, this.baseUrl).href;
    const requestHeaders = { ...headers };
    if (token !== null) requestHeaders.authorization = `Bearer ${token}`;
    const hasBody = body !== undefined && body !== null;
    const text = hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    if (hasBody && typeof body !== "string" && !Object.keys(requestHeaders).some((h) => h.toLowerCase() === "content-type")) {
      requestHeaders["content-type"] = "application/json";
    }

    const entry = {
      startedDateTime: new Date().toISOString(),
      time: -1,
      request: { method, url, headers: requestHeaders, body: text },
      response: { status: 0, bodySize: -1, mimeType: "", headers: null, body: null },
      _failed: false,
    };
    this.har.push(entry);

    const started = Date.now();
    const response = await fetch(url, { method, headers: requestHeaders, body: text });
    const raw = await response.text();
    const responseHeaders = Object.fromEntries(response.headers.entries());
    entry.time = Date.now() - started;
    entry.response = {
      status: response.status,
      bodySize: Buffer.byteLength(raw),
      mimeType: (responseHeaders["content-type"] ?? "").split(";")[0].trim(),
      headers: responseHeaders,
      body: raw,
    };

    let parsed = null;
    try {
      parsed = raw === "" ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: responseHeaders, body: parsed, raw };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }
  post(path, body, options) {
    return this.request("POST", path, { ...options, body: body ?? {} });
  }

  // ---- convenience flows used across the suites ----

  async reset(seed) {
    return this.post("/admin/reset", seed === undefined ? {} : { seed });
  }

  async tick(options = {}) {
    return this.post("/admin/tick", options);
  }

  /** Create + activate an account, returning the account resource. */
  async openAccount(owner, currency = "USD") {
    const created = await this.post("/accounts", { owner, currency });
    if (created.status !== 201) throw new Error(`openAccount: create failed with ${created.status}`);
    const activated = await this.post(`/accounts/${created.body.id}/activate`);
    if (activated.status !== 200) throw new Error(`openAccount: activate failed with ${activated.status}`);
    return activated.body;
  }

  /** Open an account and fund it in one step. */
  async fundedAccount(owner, amount, currency = "USD") {
    const account = await this.openAccount(owner, currency);
    const deposit = await this.post("/deposits", { account_id: account.id, amount });
    if (deposit.status !== 201) throw new Error(`fundedAccount: deposit failed with ${deposit.status}`);
    return account;
  }

  /** Enumerate every ledger entry of an account by following next_cursor. */
  async allEntries(accountId, limit = 100) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const query = cursor ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}` : `?limit=${limit}`;
      const response = await this.get(`/accounts/${accountId}/entries${query}`);
      if (response.status !== 200) throw new Error(`allEntries: ${response.status}`);
      items.push(...response.body.items);
      cursor = response.body.next_cursor;
      if (!cursor) break;
    }
    return items;
  }
}

/**
 * Start a fixture instance for one test. Returns the client plus a `close()`;
 * pass `faults` to enable development-set faults for this instance only.
 */
export async function startFixture({ faults = [], seed = "test-seed" } = {}) {
  const started = await startServer({
    port: 0,
    host: "127.0.0.1",
    seed,
    faults,
    tokens: { admin: ADMIN_TOKEN, customer: CUSTOMER_TOKEN, customerB: CUSTOMER_B_TOKEN },
  });
  const client = new Client(started.url);
  return {
    url: started.url,
    ledger: started.ledger,
    client,
    customer: new Client(started.url, { token: CUSTOMER_TOKEN }),
    customerB: new Client(started.url, { token: CUSTOMER_B_TOKEN }),
    close: started.close,
  };
}

/** Run `body(fixture)` against a fresh instance and always shut it down. */
export async function withFixture(options, body) {
  const fixture = await startFixture(options);
  try {
    return await body(fixture);
  } finally {
    await fixture.close();
  }
}
