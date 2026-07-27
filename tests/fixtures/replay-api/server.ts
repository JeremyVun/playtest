// A zero-dependency HTTP API whose identifiers are FRESH per instance.
//
// It exists so semantic replay can be proven rather than asserted: a journey
// recorded against one instance must act green against another whose ids differ
// end to end, which is impossible unless the recorded requests are a
// parameterized program rather than a replay of literal bytes.
//
// Deliberate properties:
//
//   * ids carry a per-instance prefix (`acc_A_1` vs `acc_B_1`), so a baseline
//     that re-sends a literal id 404s loudly against a fresh instance;
//   * `created_at`/`updated_at` are real wall-clock timestamps — volatile values
//     the response projection has to absorb without a heal;
//   * `notices` is volatile STRUCTURE (a list whose length differs per
//     instance), which shape projection alone cannot absorb — that is what
//     `match.exclude` is for;
//   * every drift the exit gate needs is an explicit option: `rename` renames a
//     response field, `entryStatus` changes one operation's status.
import http from "node:http";

function json(res: LegacyTestValue, status: LegacyTestValue, body: LegacyTestValue) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req: LegacyTestValue): Promise<LegacyTestValue> {
  return new Promise<LegacyTestValue>((resolve, reject) => {
    let data = "";
    req.on("data", (c: LegacyTestValue) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {{ prefix?: string, rename?: boolean, entryStatus?: number, notices?: number }} options
 *   prefix      distinguishes one instance's ids from another's (default "A")
 *   rename      GET /accounts/{id} answers `available_balance` instead of `balance`
 *   entryStatus the status POST /entries answers (201 by default)
 *   notices     how many volatile notice objects an account carries
 * @returns {Promise<{ url, requests, close }>}
 */
export async function startReplayApi({ prefix = "A", rename = false, entryStatus = 201, notices = 0 }: LegacyTestValue = {}) {
  const accounts = new Map();
  const entries: LegacyTestValue = [];
  const requests: LegacyTestValue = []; // what the server actually received, for assertions
  let nextAccount = 1;
  let nextEntry = 1;

  const noticeList = () => Array.from({ length: notices }, (_, i) => ({ code: `notice_${i + 1}`, level: "info" }));

  const view = (account: LegacyTestValue) => {
    const body: LegacyTestValue = {
      id: account.id,
      owner: account.owner,
      status: account.status,
      created_at: account.created_at,
      updated_at: account.updated_at,
      notices: noticeList(),
    };
    // The rename is the "real change" a match rule must never be able to mask.
    body[rename ? "available_balance" : "balance"] = account.balance;
    return body;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"); // TODO(ts): Node requests always carry a URL here
    const segments = url.pathname.split("/").filter(Boolean);
    const record: LegacyTestValue = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers } };
    requests.push(record);
    const now = () => new Date().toISOString();

    if (url.pathname === "/") return json(res, 200, { service: "replay-api", instance: prefix });

    if (req.method === "POST" && url.pathname === "/accounts") {
      const body = await readBody(req).catch(() => null);
      record.body = body;
      if (typeof body?.owner !== "string" || !body.owner) {
        return json(res, 422, { error: { code: "invalid", message: "owner is required" } });
      }
      const account = { id: `acc_${prefix}_${nextAccount++}`, owner: body.owner, status: "pending", balance: 0, created_at: now(), updated_at: now() };
      accounts.set(account.id, account);
      return json(res, 201, view(account));
    }

    if (req.method === "POST" && segments.length === 3 && segments[0] === "accounts" && segments[2] === "activate") {
      const account = accounts.get(segments[1]);
      if (!account) return json(res, 404, { error: { code: "not_found", message: `no account ${segments[1]}` } });
      account.status = "active";
      account.updated_at = now();
      return json(res, 200, { id: account.id, status: account.status, updated_at: account.updated_at });
    }

    if (req.method === "POST" && url.pathname === "/entries") {
      const body = await readBody(req).catch(() => null);
      record.body = body;
      const account = accounts.get(body?.account_id);
      if (!account) return json(res, 404, { error: { code: "not_found", message: `no account ${body?.account_id ?? "(none)"}` } });
      if (account.status !== "active") return json(res, 409, { error: { code: "not_active", message: "activate the account first" } });
      const entry = { id: `ent_${prefix}_${nextEntry++}`, account_id: account.id, amount: Number(body?.amount ?? 0), created_at: now() };
      entries.push(entry);
      account.balance += entry.amount;
      account.updated_at = now();
      return json(res, entryStatus, entry);
    }

    if (req.method === "GET" && url.pathname === "/entries") {
      const account = url.searchParams.get("account");
      const mine = entries.filter((e: LegacyTestValue) => e.account_id === account);
      return json(res, 200, { entries: mine, count: mine.length });
    }

    if (req.method === "GET" && segments.length === 2 && segments[0] === "accounts") {
      const account = accounts.get(segments[1]);
      if (!account) return json(res, 404, { error: { code: "not_found", message: `no account ${segments[1]}` } });
      return json(res, 200, view(account));
    }

    return json(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port }: LegacyTestValue = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
