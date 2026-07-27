// Per-fault manifestation witnesses: did this fault actually appear in this
// traffic, and which exchanges show it?
//
// This is stage 2 and stage 3 of the five-stage funnel (BUILD_PLAN S0 scope 4).
// The oracles answer "does the shared instrument confirm a violation"; a witness
// answers the narrower, prior question "was the fault even *in* this trace" —
// so a miss can be diagnosed as reachability rather than left a mystery, and so
// a suite that reported a fault the oracle's applicability window missed can
// still be credited (`studies/api-probe/REPORT.md` §3).
//
// Two rules keep this honest:
//
//   1. **A witness must be sound.** It may never fire on a conforming build. It
//      is therefore written against the *documented* contract, never against
//      the fault's implementation: "a transfer that ends failed writes no
//      entries" is a contract statement, and any entry belonging to a failed
//      transfer is a witness regardless of which code path wrote it.
//   2. **A witness never decides a verdict.** Column 1 is the oracles and
//      column 2 is the suite's own report. The witness only diagnoses the funnel
//      and scopes "correct evidence"; it is not a third detector.
//
// Where a fault admits no shortcut over the oracle's own rule, the witness
// reuses the oracle's violations rather than inventing a second, weaker copy of
// them (`fromOracle`). Where it does admit one — the four fee/settlement faults
// whose entries are visible without a balance-read window — the shortcut is
// written out, because those are exactly the cases where the shared oracle
// under-credited an arm in P1.
//
// Adding a fault means adding its witness here, next to its `LEDGER_FAULTS`
// toggle and its manifestation test. A fault with no witness scores `unknown`
// for stages 2 and 3, which the bench reports rather than hides.

import { route, isOk } from "./trace.js";
import { FEE_BPS, FEE_ACCOUNT_IDS, DAILY_LIMIT, feeFor } from "../../src/ledger.js";

/** Cite an exchange as a witness, carrying the subject ids it is about. */
const at = (exchange, subject = {}) => ({
  index: exchange.index,
  method: exchange.method,
  path: exchange.path,
  status: exchange.status,
  subject,
});

/** Witnesses taken from the oracle's own findings, for a given violation code. */
const fromOracle = (codes) => (ctx) =>
  ctx.violations
    .filter((violation) => codes.includes(violation.code))
    .map((violation) => ({
      index: violation.evidence.request.index,
      method: violation.evidence.request.method,
      path: violation.evidence.request.path,
      status: violation.evidence.request.status,
      subject: violation.evidence.subject ?? {},
      via: `oracle:${violation.oracle}/${violation.code}`,
    }));

const exchanges = (ctx, kind) => ctx.trace.exchanges.filter((exchange) => route(exchange).kind === kind);

/** Every ledger entry the trace saw, grouped by the transfer it belongs to. */
function entriesByTransfer(ctx) {
  const groups = new Map();
  for (const sighting of ctx.facts.entries.values()) {
    const { entry } = sighting;
    if (!entry.transfer_id) continue;
    if (!groups.has(entry.transfer_id)) groups.set(entry.transfer_id, []);
    groups.get(entry.transfer_id).push(sighting);
  }
  return groups;
}

/** The half-minor-unit fee boundary: `amount * 15 / 10000` ends in exactly .5. */
const halfUnitFee = (amount) => Number.isInteger(amount) && (amount * FEE_BPS) % 10000 === 5000;

const settledOrFailed = (ctx, status) =>
  [...ctx.facts.transfers.entries()].filter(([, transfer]) => transfer.status === status);

// ---- shared walks for the sealed set ------------------------------------
//
// The oracles' model (`ctx.facts`) was built for the seven pinned invariants
// and does not carry ownership, receipts, or page shape. These witnesses walk
// the trace themselves rather than widening the frozen oracle, which must stay
// byte-identical to P1's copy for the probe rematch to be comparable.

/** Every account representation in the trace, in wire order. */
function accountSightings(ctx) {
  const found = [];
  for (const exchange of ctx.trace.exchanges) {
    const target = route(exchange);
    const body = exchange.responseJson;
    const push = (account) => {
      if (account && typeof account.id === "string") found.push({ index: exchange.index, exchange, account });
    };
    if (!isOk(exchange)) {
      // The tombstone is a sighting too: it says the account is closed.
      if (target.kind === "account_get" && exchange.status === 410 && target.accountId) {
        push({ id: target.accountId, status: "closed" });
      }
      continue;
    }
    if (["accounts_create", "account_get", "account_activate", "account_close"].includes(target.kind)) push(body);
    if (target.kind === "accounts_list" && Array.isArray(body?.items)) for (const item of body.items) push(item);
  }
  return found;
}

/** Every deposit representation in the trace. */
function depositSightings(ctx) {
  const found = [];
  for (const exchange of ctx.trace.exchanges) {
    const kind = route(exchange).kind;
    if (!isOk(exchange) || (kind !== "deposits_create" && kind !== "deposit_get")) continue;
    const deposit = exchange.responseJson;
    if (deposit && typeof deposit.id === "string") found.push({ index: exchange.index, exchange, deposit });
  }
  return found;
}

const lastResetBefore = (ctx, index) => ctx.facts.resetIndices.filter((reset) => reset < index).pop() ?? -1;

/** owner_principal (and kind) per account id, as the trace saw it. */
function ownersOf(sightings) {
  const owners = new Map();
  for (const { account } of sightings) {
    if (typeof account.owner_principal !== "string") continue;
    owners.set(account.id, { principal: account.owner_principal, kind: account.kind ?? null });
  }
  return owners;
}

/**
 * Bearer credential -> principal id, learned only where a principal opened an
 * account for itself: the response's owner_principal is then the caller's own
 * principal. Nothing else on this surface tells a client who it is, so a
 * suite that never opens an account under a credential cannot attribute
 * anything to it — and neither can this.
 */
function principalsByCredential(ctx) {
  const map = new Map();
  for (const exchange of ctx.trace.exchanges) {
    if (route(exchange).kind !== "accounts_create" || !isOk(exchange)) continue;
    if (exchange.requestJson?.owner_principal !== undefined) continue;
    const credential = exchange.requestHeaders["authorization"];
    const principal = exchange.responseJson?.owner_principal;
    if (credential && typeof principal === "string") map.set(credential, principal);
  }
  return map;
}

/** The caller's principal and the account's owner, when the trace knows both. */
function crossPrincipal(ctx, exchange, accountId, owners, credentials) {
  const caller = credentials.get(exchange.requestHeaders["authorization"]);
  const owner = owners.get(accountId);
  if (!caller || !owner || owner.kind === "system") return null;
  if (owner.principal === caller) return null;
  return { caller, owner: owner.principal };
}

/** The page size a request asked for, documented default included. */
const requestedLimit = (exchange) => {
  const raw = exchange.query.get("limit");
  const parsed = raw === null || raw === "" ? 20 : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const isFeeAccount = (id) => Object.values(FEE_ACCOUNT_IDS).includes(id);

/** Idempotent transfer attempts grouped by credential and key, in wire order. */
function idempotentAttempts(ctx) {
  const groups = new Map();
  for (const exchange of exchanges(ctx, "transfers_create")) {
    const key = exchange.requestHeaders["idempotency-key"];
    if (!key) continue;
    const scoped = `${exchange.requestHeaders["authorization"] ?? "(anonymous)"} ${key}`;
    if (!groups.has(scoped)) groups.set(scoped, []);
    groups.get(scoped).push({
      index: exchange.index,
      exchange,
      key,
      body: JSON.stringify(exchange.requestJson ?? null),
      transferId: isOk(exchange) ? (exchange.responseJson?.id ?? null) : null,
      status: exchange.status,
    });
  }
  return groups;
}

/**
 * The registry. Per fault:
 *   `oracles`  which oracle vocabularies a correct report would file it under —
 *              used to attribute a reported check to this fault by rule name.
 *   `reach`    did the traffic execute the scenario the fault lives in?
 *   `witness`  which exchanges show it having manifested (empty = it did not).
 */
export const WITNESSES = Object.freeze({
  "f-error-200": {
    oracles: ["error_shape"],
    // An underfunded transfer was attempted: refused with 422 on a clean build,
    // dressed up as a 2xx by the fault.
    reach: (ctx) =>
      exchanges(ctx, "transfers_create").some(
        (exchange) =>
          (exchange.status === 422 && exchange.responseJson?.error?.code === "insufficient_funds") ||
          (isOk(exchange) && exchange.responseJson?.status === "failed"),
      ),
    witness: (ctx) =>
      exchanges(ctx, "transfers_create")
        .filter((exchange) => isOk(exchange) && exchange.responseJson?.status === "failed")
        .map((exchange) => at(exchange, { transfer_id: exchange.responseJson?.id ?? null })),
  },

  "f-undocumented-500": {
    oracles: ["protocol"],
    // The documented inclusive boundary was actually sent.
    reach: (ctx) =>
      exchanges(ctx, "transfers_create").some((exchange) => exchange.requestJson?.amount === DAILY_LIMIT),
    witness: (ctx) =>
      exchanges(ctx, "transfers_create")
        .filter((exchange) => exchange.status >= 500)
        .map((exchange) => at(exchange, { amount: exchange.requestJson?.amount ?? null })),
  },

  "f-fee-rounding-drift": {
    oracles: ["conservation"],
    // A transfer whose basis-point fee lands on the half-unit boundary settled,
    // and its rows were read back.
    reach: (ctx) =>
      [...entriesByTransfer(ctx).entries()].some(([transferId, rows]) => {
        const known = ctx.facts.transfers.get(transferId);
        return rows.some(({ entry }) => entry.kind === "fee") && halfUnitFee(known?.amount);
      }),
    // Shortcut over the oracle: the declared fee is on the transfer resource, so
    // a fee row that disagrees with it is a manifestation even if the credit or
    // debit row was never enumerated.
    witness: (ctx) => {
      const found = [];
      for (const [transferId, rows] of entriesByTransfer(ctx)) {
        const known = ctx.facts.transfers.get(transferId);
        if (!Number.isInteger(known?.fee)) continue;
        for (const { entry, index } of rows) {
          if (entry.kind !== "fee" || entry.account_id !== FEE_ACCOUNT_IDS[entry.currency]) continue;
          if (entry.amount === known.fee) continue;
          found.push({
            index,
            subject: { transfer_id: transferId, entry_id: entry.id, declared_fee: known.fee, posted: entry.amount },
            via: "fee row disagrees with the fee declared on the transfer",
          });
        }
      }
      return found;
    },
  },

  "f-idempotency-replay-double": {
    oracles: ["idempotency"],
    // The same key was replayed with the same body.
    reach: (ctx) => [...ctx.facts.idempotency.values()].some((history) => history.length > 1),
    witness: fromOracle(["phantom_ledger_effect", "idempotency_key_diverged"]),
  },

  "f-settle-cancel-race": {
    oracles: ["lifecycle", "conservation"],
    // A cancel was attempted on a transfer already observed non-pending.
    reach: (ctx) =>
      exchanges(ctx, "transfer_cancel").some((exchange) => {
        const known = ctx.facts.transfers.get(route(exchange).transferId);
        return known && known.status !== "pending";
      }),
    witness: fromOracle(["cancel_after_settlement", "transfer_entries_nonzero"]),
  },

  "f-close-ghost": {
    oracles: ["lifecycle"],
    // A transfer was attempted naming an account already observed closed.
    reach: (ctx) =>
      exchanges(ctx, "transfers_create").some((exchange) => {
        const request = exchange.requestJson ?? {};
        return ["source_account_id", "destination_account_id"].some(
          (role) => ctx.facts.accounts.get(request[role])?.status === "closed",
        );
      }),
    witness: fromOracle(["transfer_on_closed_account"]),
  },

  "f-pagination-dup": {
    oracles: ["pagination"],
    // An enumeration the trace itself started ran to a second page.
    reach: (ctx) =>
      ctx.facts.enumerations.some(
        (enumeration) => enumeration.anchored && enumeration.endIndex > enumeration.startIndex,
      ),
    witness: fromOracle(["duplicate_entry_in_enumeration"]),
  },

  "f-balance-cache-stale": {
    oracles: ["balance_agreement"],
    // A single tick settled two or more transfers, and an account's balance was
    // read back afterwards.
    reach: (ctx) =>
      exchanges(ctx, "admin_tick").some((exchange) => (exchange.responseJson?.settled?.length ?? 0) > 1) &&
      ctx.facts.balanceReads.length > 0,
    witness: fromOracle(["stored_balance_diverged"]),
  },

  "f-cursor-error-bare": {
    oracles: ["error_shape"],
    // A cursor this endpoint never handed out was actually offered to it.
    reach: (ctx) =>
      exchanges(ctx, "account_entries").some((exchange) => exchange.query.get("cursor") && exchange.status >= 400),
    witness: fromOracle(["error_envelope_violation"]),
  },

  "f-close-pending-inbound": {
    oracles: ["lifecycle"],
    // A close was attempted on the *receiving* end of a pending transfer.
    reach: (ctx) =>
      exchanges(ctx, "account_close").some((exchange) => {
        const accountId = route(exchange).accountId;
        return [...ctx.facts.transfers.values()].some(
          (transfer) => transfer.status === "pending" && transfer.destination === accountId,
        );
      }),
    witness: fromOracle(["close_with_pending_transfers"]),
  },

  "f-settle-failed-debit": {
    oracles: ["balance_agreement", "conservation"],
    // A settlement tick failed a transfer, and that account's rows were read.
    reach: (ctx) => settledOrFailed(ctx, "failed").length > 0 && ctx.facts.entries.size > 0,
    // The shortcut P1 needed. The contract says a transfer that ends "failed"
    // writes no entries at all, so any row citing a failed transfer is a
    // manifestation — no balance read, no complete enumeration, no applicability
    // window required. This is the fault the shared oracle refused to credit the
    // agent-suite for (`REPORT.md` §3).
    witness: (ctx) => {
      const found = [];
      for (const [transferId, rows] of entriesByTransfer(ctx)) {
        if (ctx.facts.transfers.get(transferId)?.status !== "failed") continue;
        for (const { entry, index } of rows) {
          found.push({
            index,
            subject: { transfer_id: transferId, entry_id: entry.id, account_id: entry.account_id, amount: entry.amount },
            via: "a transfer observed failed carries ledger entries",
          });
        }
      }
      return found;
    },
  },

  "f-idempotency-day-expiry": {
    oracles: ["idempotency"],
    // A ledger-day rollover happened between two uses of one key: the temporal
    // boundary no P1 arm crossed on purpose.
    reach: (ctx) => {
      const rollovers = exchanges(ctx, "admin_tick")
        .filter((exchange) => isOk(exchange) && exchange.requestJson?.advance_day === true)
        .map((exchange) => exchange.index);
      if (rollovers.length === 0) return false;
      return [...ctx.facts.idempotency.values()].some(
        (history) =>
          history.length > 1 &&
          rollovers.some((index) => index > history[0].index && index < history[history.length - 1].index),
      );
    },
    witness: fromOracle(["idempotency_key_diverged"]),
  },

  "f-fee-double-charged": {
    oracles: ["conservation"],
    // A EUR settlement was observed at all: the second column of the currency
    // table the P1 probe never widened.
    reach: (ctx) =>
      [...entriesByTransfer(ctx).values()].some((rows) =>
        rows.some(({ entry }) => entry.currency === "EUR" && entry.kind === "transfer_credit"),
      ),
    // Shortcut over the oracle: the payee is credited the transfer's amount, and
    // the amount is on the transfer resource, so a short credit row is a
    // manifestation without needing the debit and fee rows as well.
    witness: (ctx) => {
      const found = [];
      for (const [transferId, rows] of entriesByTransfer(ctx)) {
        const known = ctx.facts.transfers.get(transferId);
        if (!Number.isInteger(known?.amount)) continue;
        for (const { entry, index } of rows) {
          if (entry.kind !== "transfer_credit" || entry.amount === known.amount) continue;
          found.push({
            index,
            subject: { transfer_id: transferId, entry_id: entry.id, credited: entry.amount, amount: known.amount },
            via: "the credit row is not the transfer's amount",
          });
        }
      }
      return found;
    },
  },

  // ---- the S0 sealed set --------------------------------------------------
  //
  // Seven of these live outside the frozen oracles' vocabulary — ownership,
  // the fee schedule, receipts, page shape, documented parameters — so their
  // witnesses are written from the handout's statements against the trace
  // itself. `oracles` still names the rule a correct report would file the
  // finding under, which is how column two attributes a check by name; where
  // no pinned oracle owns the rule, the closest one is named and the
  // attribution falls back to the cited exchange and the witnessed resource.

  "f-activate-after-close": {
    oracles: ["lifecycle"],
    reach: (ctx) => {
      const closed = new Set();
      for (const { index, account } of accountSightings(ctx)) {
        if (account.status === "closed") closed.add(account.id);
        void index;
      }
      return exchanges(ctx, "account_activate").some((exchange) => closed.has(route(exchange).accountId));
    },
    // Closure is terminal, so an account observed closed can never be observed
    // in any other state again — unless a reset rewound the world in between.
    witness: (ctx) => {
      const found = [];
      const closed = new Map();
      let anchor = -1;
      for (const { index, exchange, account } of accountSightings(ctx)) {
        const reset = lastResetBefore(ctx, index);
        if (reset > anchor) {
          closed.clear();
          anchor = reset;
        }
        if (account.status === "closed") {
          closed.set(account.id, index);
          continue;
        }
        if (!closed.has(account.id)) continue;
        found.push({
          index,
          subject: { account_id: account.id, status: account.status ?? null },
          via: `an account observed closed at #${closed.get(account.id)} is ${account.status} here`,
        });
        void exchange;
      }
      return found;
    },
  },

  "f-transfer-to-pending-destination": {
    oracles: ["lifecycle"],
    reach: (ctx) =>
      exchanges(ctx, "transfers_create").some(
        (exchange) => ctx.facts.accounts.get(exchange.requestJson?.destination_account_id)?.status === "pending",
      ),
    witness: fromOracle(["transfer_on_inactive_account"]),
  },

  "f-deposit-entry-mismatch": {
    oracles: ["conservation"],
    reach: (ctx) => depositSightings(ctx).some(({ deposit }) => deposit.entry_id) && ctx.facts.entries.size > 0,
    // A present reference resolves and agrees: the row a deposit names is a row
    // of that deposit, on that account, for that amount.
    witness: (ctx) => {
      const found = [];
      for (const { index, deposit } of depositSightings(ctx)) {
        if (!deposit.entry_id) continue;
        const named = ctx.facts.entries.get(deposit.entry_id)?.entry;
        const own = [...ctx.facts.entries.values()].find(({ entry }) => entry.deposit_id === deposit.id)?.entry;
        const wrong = named
          ? named.deposit_id !== deposit.id || named.account_id !== deposit.account_id
          : Boolean(own) && own.id !== deposit.entry_id;
        if (!wrong) continue;
        found.push({
          index,
          subject: {
            deposit_id: deposit.id,
            account_id: deposit.account_id,
            entry_id: deposit.entry_id,
            belongs_to: named?.deposit_id ?? null,
          },
          via: "the entry a deposit names is not that deposit's row",
        });
      }
      return found;
    },
  },

  "f-fee-account-balance-untouched": {
    oracles: ["balance_agreement"],
    reach: (ctx) =>
      ctx.facts.balanceReads.some((read) => isFeeAccount(read.accountId)) &&
      [...ctx.facts.entries.values()].some(({ entry }) => entry.kind === "fee"),
    // Fee rows are credits, so the rows a trace has already seen can never sum
    // to more than the balance the account reports afterwards. No complete
    // enumeration and no quiet window required — the inequality is one-sided.
    witness: (ctx) => {
      const found = [];
      for (const read of ctx.facts.balanceReads) {
        if (!isFeeAccount(read.accountId)) continue;
        const anchor = lastResetBefore(ctx, read.index);
        const rows = [...ctx.facts.entries.values()].filter(({ entry, index }) => {
          if (entry.account_id !== read.accountId || index <= anchor) return false;
          // A row seen after the read counts only if nothing was written in
          // between, exactly as the balance oracle's window requires.
          const lo = Math.min(index, read.index);
          const hi = Math.max(index, read.index);
          return !ctx.facts.mutationIndices.some((mutation) => mutation > lo && mutation < hi);
        });
        if (rows.length === 0) continue;
        const observed = rows.reduce((total, { entry }) => total + entry.amount, 0);
        if (observed <= read.balance) continue;
        found.push({
          index: read.index,
          subject: {
            account_id: read.accountId,
            stored: read.balance,
            observed_rows: observed,
            entry_ids: rows.map(({ entry }) => entry.id),
          },
          via: "the fee rows already seen exceed the balance the account reports",
        });
      }
      return found;
    },
  },

  "f-eur-fee-flat": {
    oracles: ["conservation"],
    reach: (ctx) =>
      exchanges(ctx, "transfers_create").some((exchange) => exchange.responseJson?.currency === "EUR"),
    // One schedule, every currency: the fee a transfer declares is the fee the
    // published formula gives for its amount.
    witness: (ctx) => {
      const found = [];
      const seen = new Set();
      for (const exchange of ctx.trace.exchanges) {
        const transfer = exchange.responseJson;
        if (!isOk(exchange) || !transfer || typeof transfer.id !== "string") continue;
        const kind = route(exchange).kind;
        const rows =
          kind === "transfers_list" && Array.isArray(transfer.items)
            ? transfer.items
            : ["transfers_create", "transfer_get", "transfer_cancel"].includes(kind)
              ? [transfer]
              : [];
        for (const row of rows) {
          if (!row || seen.has(row.id)) continue;
          if (!Number.isInteger(row.amount) || !Number.isInteger(row.fee)) continue;
          seen.add(row.id);
          if (row.fee === feeFor(row.amount)) continue;
          found.push({
            index: exchange.index,
            subject: { transfer_id: row.id, currency: row.currency ?? null, declared: row.fee, schedule: feeFor(row.amount) },
            via: "the transfer's fee is not the published schedule for its amount",
          });
        }
      }
      return found;
    },
  },

  "f-include-closed-ignored": {
    oracles: ["lifecycle"],
    reach: (ctx) =>
      exchanges(ctx, "accounts_list").some((exchange) => exchange.query.get("include_closed") === "true") &&
      accountSightings(ctx).some(({ account }) => account.status === "closed"),
    // A single complete page of include_closed=true is the whole collection, so
    // an account the trace has already seen closed has to be in it.
    witness: (ctx) => {
      const sightings = accountSightings(ctx);
      const found = [];
      for (const exchange of exchanges(ctx, "accounts_list")) {
        if (!isOk(exchange) || exchange.query.get("include_closed") !== "true") continue;
        if (exchange.query.get("cursor")) continue;
        const body = exchange.responseJson;
        if (!Array.isArray(body?.items) || body.next_cursor) continue;
        const listed = new Set(body.items.map((item) => item?.id));
        const reset = lastResetBefore(ctx, exchange.index);
        const closed = new Set();
        for (const sighting of sightings) {
          if (sighting.index <= reset || sighting.index >= exchange.index) continue;
          if (sighting.account.status === "closed") closed.add(sighting.account.id);
          else closed.delete(sighting.account.id);
        }
        const missing = [...closed].filter((id) => !listed.has(id));
        if (missing.length === 0) continue;
        found.push({
          index: exchange.index,
          subject: { account_ids: missing, listed: body.items.length },
          via: "a complete include_closed listing omits an account observed closed",
        });
      }
      return found;
    },
  },

  "f-transfers-filter-after-page": {
    oracles: ["pagination"],
    reach: (ctx) => exchanges(ctx, "transfers_list").some((exchange) => exchange.query.get("account_id")),
    // Page discipline: a page shorter than the limit is the last page, so it
    // cannot hand back a cursor promising another one.
    witness: (ctx) => {
      const found = [];
      for (const exchange of exchanges(ctx, "transfers_list")) {
        if (!isOk(exchange)) continue;
        const body = exchange.responseJson;
        const limit = requestedLimit(exchange);
        if (!Array.isArray(body?.items) || limit === null) continue;
        if (body.items.length >= limit || !body.next_cursor) continue;
        found.push({
          index: exchange.index,
          subject: { returned: body.items.length, limit, account_id: exchange.query.get("account_id") },
          via: "a short page still promises another one",
        });
      }
      return found;
    },
  },

  "f-idempotency-conflict-ignored": {
    oracles: ["idempotency"],
    reach: (ctx) =>
      [...idempotentAttempts(ctx).values()].some((history) =>
        history.some((attempt, position) => position > 0 && attempt.body !== history[0].body),
      ),
    // The declared exception is a rule: a key reused with a different body
    // creates nothing and is refused. Returning the earlier transfer instead
    // silently drops the request the client actually made.
    witness: (ctx) => {
      const found = [];
      for (const history of idempotentAttempts(ctx).values()) {
        for (let position = 1; position < history.length; position += 1) {
          const attempt = history[position];
          const earlier = history.slice(0, position).find((previous) => previous.transferId);
          if (!earlier || attempt.body === earlier.body) continue;
          if (!attempt.transferId || attempt.transferId !== earlier.transferId) continue;
          found.push({
            index: attempt.index,
            subject: { idempotency_key: attempt.key, transfer_id: attempt.transferId },
            via: "a key reused with a different body replayed the earlier transfer",
          });
        }
      }
      return found;
    },
  },

  "f-idempotency-freed-by-cancel": {
    oracles: ["idempotency"],
    reach: (ctx) =>
      exchanges(ctx, "transfer_cancel").length > 0 &&
      [...idempotentAttempts(ctx).values()].some((history) => history.length > 1),
    // One key, one transfer — for as long as the service is running, and
    // whatever happened to that transfer in between.
    witness: (ctx) => {
      const cancels = exchanges(ctx, "transfer_cancel")
        .filter((exchange) => isOk(exchange))
        .map((exchange) => exchange.index);
      const found = [];
      for (const history of idempotentAttempts(ctx).values()) {
        for (let position = 1; position < history.length; position += 1) {
          const attempt = history[position];
          const earlier = history.slice(0, position).find((previous) => previous.transferId);
          if (!earlier || !attempt.transferId) continue;
          if (attempt.body !== earlier.body || attempt.transferId === earlier.transferId) continue;
          if (!cancels.some((index) => index > earlier.index && index < attempt.index)) continue;
          found.push({
            index: attempt.index,
            subject: {
              idempotency_key: attempt.key,
              transfer_ids: [earlier.transferId, attempt.transferId],
            },
            via: "the key was reusable again once its transfer was canceled",
          });
        }
      }
      return found;
    },
  },

  "f-day-usage-carryover": {
    oracles: ["protocol"],
    reach: (ctx) =>
      exchanges(ctx, "admin_tick").some(
        (exchange) => isOk(exchange) && exchange.requestJson?.advance_day === true,
      ) && exchanges(ctx, "transfers_create").length > 0,
    // The refusal is self-incriminating: it reports the usage it counted, and
    // after a rollover that usage can only be transfers created since the
    // rollover — which this trace created, so it can be added up.
    witness: (ctx) => {
      const rollovers = exchanges(ctx, "admin_tick")
        .filter((exchange) => isOk(exchange) && exchange.requestJson?.advance_day === true)
        .map((exchange) => exchange.index);
      if (rollovers.length === 0) return [];
      const found = [];
      for (const exchange of exchanges(ctx, "transfers_create")) {
        const error = exchange.responseJson?.error;
        if (exchange.status !== 422 || error?.code !== "daily_limit_exceeded") continue;
        const used = error.details?.used;
        const sourceId = error.details?.id ?? exchange.requestJson?.source_account_id;
        if (!Number.isInteger(used) || used <= 0 || !sourceId) continue;
        const rollover = rollovers.filter((index) => index < exchange.index).pop();
        if (rollover === undefined) continue;
        const sinceRollover = exchanges(ctx, "transfers_create")
          .filter(
            (candidate) =>
              isOk(candidate) &&
              candidate.index > rollover &&
              candidate.index < exchange.index &&
              candidate.responseJson?.source_account_id === sourceId,
          )
          .reduce((total, candidate) => total + (candidate.responseJson?.amount ?? 0), 0);
        if (used <= sinceRollover) continue;
        found.push({
          index: exchange.index,
          subject: { account_id: sourceId, counted: used, created_since_rollover: sinceRollover, limit: DAILY_LIMIT },
          via: "the day's usage counts transfers created before the rollover",
        });
      }
      return found;
    },
  },

  "f-tick-day-skips-settlement": {
    oracles: ["lifecycle"],
    reach: (ctx) =>
      exchanges(ctx, "admin_tick").some(
        (exchange) => isOk(exchange) && exchange.requestJson?.advance_day === true,
      ) && exchanges(ctx, "transfers_create").some((exchange) => isOk(exchange)),
    // A tick with no settle_limit leaves nothing pending, and the tick result
    // reports the queue it left behind, so the response indicts itself.
    witness: (ctx) => {
      const found = [];
      for (const exchange of exchanges(ctx, "admin_tick")) {
        if (!isOk(exchange)) continue;
        const request = exchange.requestJson ?? {};
        if (request.settle_limit !== undefined && request.settle_limit !== null) continue;
        const pending = exchange.responseJson?.pending;
        if (!Number.isInteger(pending) || pending === 0) continue;
        found.push({
          index: exchange.index,
          subject: {
            pending,
            settled: exchange.responseJson?.settled?.length ?? 0,
            advanced_day: request.advance_day === true,
          },
          via: "an unlimited tick left transfers pending",
        });
      }
      return found;
    },
  },

  "f-entries-cross-principal": {
    oracles: ["error_shape"],
    reach: (ctx) => {
      const owners = ownersOf(accountSightings(ctx));
      const credentials = principalsByCredential(ctx);
      return exchanges(ctx, "account_entries").some((exchange) =>
        Boolean(crossPrincipal(ctx, exchange, route(exchange).accountId, owners, credentials)),
      );
    },
    // Attribution needs two facts the trace has to contain: the account's
    // owner_principal, and which principal the calling credential belongs to —
    // learnable only where that credential opened an account for itself.
    witness: (ctx) => {
      const owners = ownersOf(accountSightings(ctx));
      const credentials = principalsByCredential(ctx);
      const found = [];
      for (const exchange of exchanges(ctx, "account_entries")) {
        if (!isOk(exchange)) continue;
        const accountId = route(exchange).accountId;
        const parties = crossPrincipal(ctx, exchange, accountId, owners, credentials);
        if (!parties) continue;
        found.push({
          index: exchange.index,
          subject: { account_id: accountId, owner: parties.owner, read_by: parties.caller },
          via: "one principal read another principal's ledger history",
        });
      }
      return found;
    },
  },

  "f-transfer-source-unowned": {
    oracles: ["error_shape"],
    reach: (ctx) => {
      const owners = ownersOf(accountSightings(ctx));
      const credentials = principalsByCredential(ctx);
      return exchanges(ctx, "transfers_create").some((exchange) =>
        Boolean(crossPrincipal(ctx, exchange, exchange.requestJson?.source_account_id, owners, credentials)),
      );
    },
    witness: (ctx) => {
      const owners = ownersOf(accountSightings(ctx));
      const credentials = principalsByCredential(ctx);
      const found = [];
      for (const exchange of exchanges(ctx, "transfers_create")) {
        if (!isOk(exchange)) continue;
        const sourceId = exchange.requestJson?.source_account_id ?? exchange.responseJson?.source_account_id;
        const parties = crossPrincipal(ctx, exchange, sourceId, owners, credentials);
        if (!parties) continue;
        found.push({
          index: exchange.index,
          subject: {
            account_id: sourceId,
            owner: parties.owner,
            spent_by: parties.caller,
            transfer_id: exchange.responseJson?.id ?? null,
          },
          via: "a principal spent from an account it does not own",
        });
      }
      return found;
    },
  },

  "f-same-account-envelope-bare": {
    oracles: ["error_shape"],
    reach: (ctx) =>
      exchanges(ctx, "transfers_create").some(
        (exchange) =>
          exchange.requestJson?.source_account_id &&
          exchange.requestJson.source_account_id === exchange.requestJson.destination_account_id,
      ),
    // Every refusal is {error:{code,message,details?}}. This one is not.
    witness: (ctx) => {
      const found = [];
      for (const exchange of exchanges(ctx, "transfers_create")) {
        if (exchange.status < 400) continue;
        const body = exchange.responseJson;
        if (!body) continue;
        const error = body.error;
        const shaped =
          error && typeof error === "object" && typeof error.code === "string" && typeof error.message === "string";
        if (shaped) continue;
        found.push({
          index: exchange.index,
          subject: { status: exchange.status, body: exchange.responseBody?.slice(0, 200) ?? null },
          via: "a refusal is not the declared error envelope",
        });
      }
      return found;
    },
  },
});

/**
 * Evaluate a fault's witness against a scored trace.
 * `ctx` is `{ trace, facts, violations }` — the trace, the oracle walk's model,
 * and the oracle's violations.
 */
export function witnessFor(fault, ctx) {
  const spec = WITNESSES[fault];
  if (!spec) return { known: false, reached: null, witnesses: [], oracles: [] };
  const witnesses = spec.witness(ctx) ?? [];
  return {
    known: true,
    reached: spec.reach(ctx) === true || witnesses.length > 0,
    witnesses,
    oracles: spec.oracles,
  };
}

/** Every resource id a witness names — what a correct report should be about. */
export function witnessSubjectIds(witnesses) {
  const ids = new Set();
  for (const item of witnesses) {
    for (const value of Object.values(item.subject ?? {})) {
      if (typeof value === "string" && /^(acc|tr|dep|ent)_/.test(value)) ids.add(value);
      if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string" && /^(acc|tr|dep|ent)_/.test(entry)) ids.add(entry);
    }
  }
  return [...ids];
}
