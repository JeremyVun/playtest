// A zero-dependency ledger-shaped HTTP API whose every P4 behaviour is an
// explicit option.
//
// It exists so the Tier-1/2 invariant policies and the heal triage can be proven
// rather than asserted. Each policy needs two fixtures — one where the property
// is genuinely violated and one where the API's declared behaviour only LOOKS
// like a violation (a soft delete, an eventual-consistency page boundary, a
// refreshed timestamp on an idempotent replay) — so every fault below has a
// legitimate twin the policy must not fail.
//
// Deliberate properties:
//
//   * ids carry a per-instance prefix (`acc_A_1`), so a recorded journey only
//     replays if it is a parameterized program (P3);
//   * a CLOSED account refuses new entries with 409 — the refusal `closeGhost`
//     takes away, which is the shape of a seeded semantic regression;
//   * `POST /entries` honours `Idempotency-Key`: a replay returns the SAME entry
//     with a refreshed `created_at`, so an idempotency policy needs `ignore` to
//     pass — exactly the declared exception the design calls for;
//   * `GET /entries` is cursor-paginated, so a pagination policy has a real
//     enumeration to walk;
//   * `GET /admin/metrics` answers a bare 401, so error-shape's default
//     exclusion of auth responses is exercised.
import http from "node:http";

function json(res: LegacyTestValue, status: LegacyTestValue, body: LegacyTestValue, mime = "application/json; charset=utf-8") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": mime, "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req: LegacyTestValue): Promise<LegacyTestValue> {
  return new Promise<LegacyTestValue>((resolve) => {
    let data = "";
    req.on("data", (c: LegacyTestValue) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

const envelope = (code: LegacyTestValue, message: LegacyTestValue) => ({ error: { code, message } });

/**
 * @param {object} options
 *   prefix              per-instance id prefix (default "A")
 *   pageSize            entries per page of GET /entries (default 2)
 *   closeGhost          a CLOSED account still accepts entries (semantic regression)
 *   softDelete          DELETE marks the account deleted; GET answers 200 with status "deleted"
 *   deleteGhost         DELETE reports success but the account is untouched
 *   paginationDup       page 2 repeats the boundary entry
 *   idempotencyDouble   a replayed Idempotency-Key mints a NEW entry
 *   errorShapeDrift     422 answers a bare { message } instead of the error envelope
 *   ownerDrift          GET /accounts/{id} answers a mangled owner (round-trip violation)
 *   serverError         GET /accounts/{id} answers 500
 *   undocumentedStatus  POST /accounts answers 202, which the spec does not declare
 *   textResponse        GET /accounts/{id} answers text/plain
 *   rename              GET /accounts/{id} answers `available_balance` instead of `balance`
 *   renameTimestamp     the ACCOUNT view answers `opened_at` instead of `created_at` —
 *                       a real surface change that breaks no declared expectation,
 *                       which is what an ACCEPTABLE contract drift looks like
 * @returns {Promise<{ url, requests, close }>}
 */
export async function startInvariantApi(options: LegacyTestValue = {}) {
  const {
    prefix = "A",
    pageSize = 2,
    closeGhost = false,
    softDelete = false,
    deleteGhost = false,
    paginationDup = false,
    idempotencyDouble = false,
    errorShapeDrift = false,
    ownerDrift = false,
    serverError = false,
    undocumentedStatus = false,
    textResponse = false,
    rename = false,
    renameTimestamp = false,
  } = options;

  const accounts = new Map();
  const entries: LegacyTestValue = [];
  const idempotency = new Map(); // key -> entry id
  const requests: LegacyTestValue = [];
  let nextAccount = 1;
  let nextEntry = 1;

  const view = (account: LegacyTestValue) => {
    const body: LegacyTestValue = {
      id: account.id,
      owner: ownerDrift ? String(account.owner).toUpperCase() : account.owner,
      status: account.status,
      [renameTimestamp ? "opened_at" : "created_at"]: account.created_at,
      updated_at: account.updated_at,
    };
    body[rename ? "available_balance" : "balance"] = account.balance;
    return body;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"); // SAFETY: Node requests always carry a URL here
    const segments = url.pathname.split("/").filter(Boolean);
    const record: LegacyTestValue = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers } };
    requests.push(record);
    const now = () => new Date().toISOString();

    if (url.pathname === "/") return json(res, 200, { service: "invariant-api", instance: prefix });

    // An auth refusal with NO error envelope: error_shape excludes 401 by
    // default, so this must not fail the policy.
    if (url.pathname === "/admin/metrics") return json(res, 401, {});

    if (req.method === "POST" && url.pathname === "/accounts") {
      const body = await readBody(req);
      record.body = body;
      if (typeof body?.owner !== "string" || !body.owner) {
        return errorShapeDrift ? json(res, 422, { message: "owner is required" }) : json(res, 422, envelope("invalid", "owner is required"));
      }
      const account = { id: `acc_${prefix}_${nextAccount++}`, owner: body.owner, status: "active", balance: 0, created_at: now(), updated_at: now() };
      accounts.set(account.id, account);
      return json(res, undocumentedStatus ? 202 : 201, view(account));
    }

    if (req.method === "POST" && segments.length === 3 && segments[0] === "accounts" && segments[2] === "close") {
      const account = accounts.get(segments[1]);
      if (!account) return json(res, 404, envelope("not_found", `no account ${segments[1]}`));
      account.status = "closed";
      account.updated_at = now();
      return json(res, 200, { id: account.id, status: account.status, updated_at: account.updated_at });
    }

    if (req.method === "DELETE" && segments.length === 2 && segments[0] === "accounts") {
      const account = accounts.get(segments[1]);
      if (!account) return json(res, 404, envelope("not_found", `no account ${segments[1]}`));
      if (deleteGhost) {
        // Reports success and changes nothing: the resource outlives its delete.
      } else if (softDelete) {
        account.status = "deleted";
        account.updated_at = now();
      } else {
        accounts.delete(segments[1]);
      }
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/entries") {
      const body = await readBody(req);
      record.body = body;
      const key = req.headers["idempotency-key"];
      const account = accounts.get(body?.account_id);
      if (!account) return json(res, 404, envelope("not_found", `no account ${body?.account_id ?? "(none)"}`));
      if (account.status === "closed" && !closeGhost) {
        return json(res, 409, envelope("account_closed", "a closed account cannot post entries"));
      }
      if (account.status === "deleted") return json(res, 404, envelope("not_found", `no account ${account.id}`));
      if (typeof body?.amount !== "number") {
        return errorShapeDrift ? json(res, 422, { message: "amount is required" }) : json(res, 422, envelope("invalid", "amount is required"));
      }
      // An idempotent replay reaches the same state; only `created_at` moves,
      // which is what an `ignore:` rule exists to absorb.
      if (key && idempotency.has(key) && !idempotencyDouble) {
        const prior = entries.find((e: LegacyTestValue) => e.id === idempotency.get(key));
        return json(res, 201, { ...prior, created_at: now() });
      }
      const entry = { id: `ent_${prefix}_${nextEntry++}`, account_id: account.id, amount: body.amount, created_at: now() };
      entries.push(entry);
      if (key) idempotency.set(key, entry.id);
      account.balance += entry.amount;
      account.updated_at = now();
      return json(res, 201, entry);
    }

    if (req.method === "GET" && url.pathname === "/entries") {
      const account = url.searchParams.get("account");
      const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
      const mine = entries.filter((e: LegacyTestValue) => e.account_id === account);
      // A degraded cursor re-reads the boundary item: the classic duplicate a
      // pagination policy catches under a snapshot consistency model.
      const from = paginationDup && cursor > 0 ? cursor - 1 : cursor;
      const page = mine.slice(from, from + pageSize);
      const next = cursor + pageSize < mine.length ? cursor + pageSize : null;
      return json(res, 200, { entries: page, count: page.length, next_cursor: next });
    }

    if (req.method === "GET" && segments.length === 2 && segments[0] === "accounts") {
      const account = accounts.get(segments[1]);
      if (!account) return json(res, 404, envelope("not_found", `no account ${segments[1]}`));
      if (serverError) return json(res, 500, envelope("boom", "the ledger fell over"));
      if (textResponse) return json(res, 200, `account ${account.id}`, "text/plain; charset=utf-8");
      return json(res, 200, view(account));
    }

    return json(res, 404, envelope("not_found", `${req.method} ${url.pathname}`));
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
