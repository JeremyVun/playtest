// The minibank domain: accounts, deposits, transfers, and double-entry ledger
// rows (docs/backlog/api-testing/DESIGN.md §6.1).
//
// Everything here is in-memory, integer-valued, and deterministic:
//
//   * no wall clock — every mutation bumps a sequence counter and timestamps
//     are derived from a fixed epoch plus that counter, so two runs of the same
//     request sequence produce byte-identical resources;
//   * no background settlement — pending transfers settle only when an admin
//     calls `tick`, so there is no race between the harness and a timer;
//   * no `Math.random` — identifiers come from the seeded PRNG in `rng.js`, so
//     `POST /admin/reset` with the same seed rewinds the world exactly.
//
// Methods return `{ status, body, headers? }` results rather than throwing;
// the HTTP layer only serializes them. The single deliberate exception is the
// `f-undocumented-500` fault, which throws on purpose.
//
// Fault branches are marked `[FAULT <id>]` (see `faults.js`).

import { makeRng, token } from "./rng.js";
import { FaultSet } from "./faults.js";
import { VariantSet } from "./variants.js";

/** Supported settlement currencies. Transfers are same-currency only. */
export const CURRENCIES = Object.freeze(["USD", "EUR"]);

/** Fee schedule: a flat component plus basis points of the amount. */
export const FEE_FLAT = 25;
export const FEE_BPS = 15;

/** Per source account, per ledger day, in minor units. The boundary is inclusive. */
export const DAILY_LIMIT = 100_000;

/** All timestamps derive from this epoch plus the mutation sequence, in seconds. */
export const EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** System fee accounts have fixed ids so any client can enumerate their entries. */
export const FEE_ACCOUNT_IDS = Object.freeze({ USD: "acc_fee_usd", EUR: "acc_fee_eur" });

/** The principal recorded as the owner of the system fee accounts. */
export const SYSTEM_PRINCIPAL = "minibank";

/**
 * The principal every domain call is made on behalf of. The HTTP layer resolves
 * one from the bearer token before routing; the default here keeps in-process
 * callers (tests, the bench recorder) at the unrestricted role they had before
 * account ownership existed.
 */
export const ADMIN_PRINCIPAL = Object.freeze({ role: "admin", id: "admin" });

const ok = (status, body, headers) => ({ status, body, headers: headers ?? null });
const fail = (status, code, message, details) => ({
  status,
  body: { error: details === undefined ? { code, message } : { code, message, details } },
  headers: null,
});

/** Declared rounding for the basis-point fee component: half away from zero. */
export function roundHalfUp(value) {
  return Math.floor(value + 0.5);
}

/** The declared fee for an amount in minor units. Pure. */
export function feeFor(amount) {
  return FEE_FLAT + roundHalfUp((amount * FEE_BPS) / 10000);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// Newest-first page order, made total: rows sharing a sequence (only the two
// seeded fee accounts do) tie-break on id, descending, so a cursor can always
// name the exact position of the last returned row and a quiescent walk at any
// page size returns every row exactly once.
function byPageOrder(a, b) {
  if (b.sequence !== a.sequence) return b.sequence - a.sequence;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// The status split (README interpretation note 10) turns on the difference
// between these two predicates. A field of the wrong *type* — `"ten"`, `1.5`,
// `null`, absent — is a malformed request and answers 400; a well-typed value a
// business rule then refuses — `0`, `-100`, more than the daily limit, more
// than the balance — answers 422. Collapsing the first onto the second is the
// mistake this pair exists to prevent.
function isIntegerValue(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

// Request bodies are strict. Every request schema in the document declares
// `additionalProperties: false`, and the one declared exception to "documented
// parameters have their documented effect" is scoped to unknown *query*
// parameters — so an unrecognized body property is a malformed request rather
// than something to drop. Silently ignoring a field the client believed it sent
// is the worst failure mode available to a service that moves money: a typo, a
// header sent in the body, or a field from a newer client version all become
// invisible no-ops. (studies/api-suite/rounds/ROUND-LOG.md, defect D3.)
function unknownProperty(body, allowed) {
  if (!body || typeof body !== "object") return null;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      return fail(400, "invalid_request", `unknown property "${key}"`, { field: key, allowed });
    }
  }
  return null;
}

// 400 for a required field that is absent, or present with the wrong type.
function malformedAmount(value) {
  if (value === undefined || value === null) {
    return fail(400, "invalid_request", "amount is required", { field: "amount" });
  }
  if (!isIntegerValue(value)) {
    return fail(400, "invalid_request", "amount must be an integer in minor units", { field: "amount" });
  }
  return null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// [`terse-optionals`] Drop the named keys from a projection wherever their
// value is null, but only when the variant is enabled. Every key passed here
// must be optional (absent from the schema's `required` list) and nullable,
// so omitting it is still a document-conforming response.
function omitNullOptionals(record, keys, enabled) {
  if (!enabled) return record;
  for (const key of keys) {
    if (record[key] === null) delete record[key];
  }
  return record;
}

export class Ledger {
  #rng;
  #faults;
  #variants;

  constructor({ seed = "ledger-dev-seed", faults = [], variants = [] } = {}) {
    this.#faults = faults instanceof FaultSet ? faults : new FaultSet(faults);
    this.#variants = variants instanceof VariantSet ? variants : new VariantSet(variants);
    this.reset(seed);
  }

  get faults() {
    return this.#faults;
  }

  get variants() {
    return this.#variants;
  }

  get seed() {
    return this.state.seed;
  }

  /**
   * Full-state seeded reset. The harness owns per-run isolation (DESIGN §3):
   * a probe that stops the moment it reproduces a violation leaves state
   * behind by design, and this is how the next run starts from a known world.
   */
  reset(seed = this.state?.seed ?? "ledger-dev-seed") {
    this.#rng = makeRng(seed);
    this.state = {
      seed: String(seed),
      sequence: 0,
      day: 0,
      accounts: new Map(),
      transfers: new Map(),
      deposits: new Map(),
      entries: [],
      idempotency: new Map(),
      dailyUsage: new Map(),
    };
    for (const currency of CURRENCIES) {
      const id = FEE_ACCOUNT_IDS[currency];
      this.state.accounts.set(id, {
        id,
        kind: "system",
        owner: SYSTEM_PRINCIPAL,
        owner_principal: SYSTEM_PRINCIPAL,
        currency,
        status: "active",
        balance: 0,
        sequence: this.state.sequence,
        created_at: this.#now(),
        activated_at: this.#now(),
        closed_at: null,
      });
    }
    return { seed: this.state.seed, day: this.state.day };
  }

  // ---- deterministic clock and ids ----

  #tickSequence() {
    this.state.sequence += 1;
    return this.state.sequence;
  }

  #now() {
    return new Date(EPOCH_MS + this.state.sequence * 1000).toISOString();
  }

  #id(prefix) {
    // [`wide-ids`] A regenerated identifier format: the same seeded PRNG, a
    // longer token. The documented id patterns (`^acc_[0-9a-z_]+$` etc.) are
    // length-agnostic, and the fixed system fee-account ids never go through
    // this method at all, so this is a conforming re-draw, not a fault.
    const length = this.#variants.has("wide-ids") ? 26 : 10;
    return `${prefix}_${token(this.#rng, length)}`;
  }

  // ---- projections ----

  #account(account) {
    const projected = {
      id: account.id,
      kind: account.kind,
      owner: account.owner,
      owner_principal: account.owner_principal,
      currency: account.currency,
      status: account.status,
      balance: account.balance,
      created_at: account.created_at,
      activated_at: account.activated_at,
      closed_at: account.closed_at,
    };
    return omitNullOptionals(projected, ["activated_at", "closed_at"], this.#variants.has("terse-optionals"));
  }

  #transfer(transfer) {
    const projected = {
      id: transfer.id,
      status: transfer.status,
      source_account_id: transfer.source_account_id,
      destination_account_id: transfer.destination_account_id,
      fee_account_id: FEE_ACCOUNT_IDS[transfer.currency],
      amount: transfer.amount,
      fee: transfer.fee,
      currency: transfer.currency,
      idempotency_key: transfer.idempotency_key,
      failure_reason: transfer.failure_reason,
      created_at: transfer.created_at,
      settled_at: transfer.settled_at,
      canceled_at: transfer.canceled_at,
    };
    return omitNullOptionals(
      projected,
      ["idempotency_key", "failure_reason", "settled_at", "canceled_at"],
      this.#variants.has("terse-optionals"),
    );
  }

  #deposit(deposit) {
    // An explicit projection (rather than `{ ...deposit }`) so the
    // `terse-optionals` variant has a key list to act on. The internal
    // deposit record carries exactly these fields, in this order, so with the
    // variant off this emits exactly the same keys as the previous spread.
    const projected = {
      id: deposit.id,
      account_id: deposit.account_id,
      amount: deposit.amount,
      currency: deposit.currency,
      status: deposit.status,
      created_at: deposit.created_at,
      entry_id: deposit.entry_id,
    };
    return omitNullOptionals(projected, ["entry_id"], this.#variants.has("terse-optionals"));
  }

  #entry(entry) {
    const projected = {
      id: entry.id,
      account_id: entry.account_id,
      kind: entry.kind,
      amount: entry.amount,
      currency: entry.currency,
      transfer_id: entry.transfer_id,
      deposit_id: entry.deposit_id,
      sequence: entry.sequence,
      created_at: entry.created_at,
    };
    return omitNullOptionals(projected, ["transfer_id", "deposit_id"], this.#variants.has("terse-optionals"));
  }

  #tombstone(account) {
    return fail(410, "account_closed", `account ${account.id} is closed`, {
      id: account.id,
      status: "closed",
      closed_at: account.closed_at,
    });
  }

  // ---- authorization ----
  //
  // Every account records the principal that owns it. The admin role reaches
  // everything; a customer principal reaches the accounts it owns, and may
  // *read* the system fee accounts as well, because auditing the fee side of
  // one's own transfer is part of reading one's own ledger.
  //
  // Authorization is checked after the resource is known to exist (so a
  // mistyped id is still a 404) and before its state is examined (so a refusal
  // never discloses the state of a resource the caller may not reach).

  #mayRead(account, principal) {
    if (principal.role === "admin") return true;
    if (account.kind === "system") return true;
    return account.owner_principal === principal.id;
  }

  #mayAct(account, principal) {
    if (principal.role === "admin") return true;
    if (account.kind === "system") return false;
    return account.owner_principal === principal.id;
  }

  #forbidden(account) {
    return fail(403, "forbidden", `account ${account.id} does not belong to this principal`, { id: account.id });
  }

  // ---- accounts ----

  createAccount(body, { principal = ADMIN_PRINCIPAL } = {}) {
    if (!body || typeof body !== "object") return fail(400, "invalid_request", "a JSON object body is required");
    const unknown = unknownProperty(body, ["owner", "currency", "owner_principal"]);
    if (unknown) return unknown;
    const owner = body.owner;
    const currency = body.currency;
    if (typeof owner !== "string" || !owner.trim()) {
      return fail(400, "invalid_request", "owner must be a non-empty string", { field: "owner" });
    }
    if (body.owner_principal !== undefined) {
      if (typeof body.owner_principal !== "string" || !body.owner_principal.trim()) {
        return fail(400, "invalid_request", "owner_principal must be a non-empty string", {
          field: "owner_principal",
        });
      }
      if (principal.role !== "admin") {
        return fail(403, "forbidden", "only an administrator may open an account for another principal", {
          field: "owner_principal",
        });
      }
    }
    if (currency === undefined || currency === null) {
      return fail(400, "invalid_request", "currency is required", { field: "currency" });
    }
    if (typeof currency !== "string") {
      return fail(400, "invalid_request", "currency must be a string", { field: "currency" });
    }
    // A well-formed string naming a currency this ledger does not carry is a
    // business refusal, not a malformed request.
    if (!CURRENCIES.includes(currency)) {
      return fail(422, "unsupported_currency", `currency must be one of ${CURRENCIES.join(", ")}`, {
        field: "currency",
        supported: CURRENCIES,
      });
    }
    this.#tickSequence();
    const account = {
      id: this.#id("acc"),
      kind: "customer",
      owner: owner.trim(),
      owner_principal: (body.owner_principal ?? principal.id).trim(),
      currency,
      status: "pending",
      balance: 0,
      sequence: this.state.sequence,
      created_at: this.#now(),
      activated_at: null,
      closed_at: null,
    };
    this.state.accounts.set(account.id, account);
    return ok(201, this.#account(account));
  }

  getAccount(id, { principal = ADMIN_PRINCIPAL } = {}) {
    const account = this.state.accounts.get(id);
    if (!account) return fail(404, "account_not_found", `no account with id ${id}`, { id });
    if (!this.#mayRead(account, principal)) return this.#forbidden(account);
    if (account.status === "closed") return this.#tombstone(account);
    return ok(200, this.#account(account));
  }

  listAccounts({ limit, cursor, includeClosed = false, principal = ADMIN_PRINCIPAL } = {}) {
    const page = this.#pageSize(limit);
    if (page.error) return page.error;
    let all = [...this.state.accounts.values()].sort(byPageOrder);
    all = all.filter((account) => this.#mayRead(account, principal));
    // [FAULT f-include-closed-ignored] The include_closed flag is dropped on
    // the way through, so tombstones are never listed.
    if (!includeClosed || this.#faults.has("f-include-closed-ignored")) {
      all = all.filter((account) => account.status !== "closed");
    }
    return this.#paginate(all, page.size, cursor, (account) => this.#account(account));
  }

  activateAccount(id, { principal = ADMIN_PRINCIPAL } = {}) {
    const account = this.state.accounts.get(id);
    if (!account) return fail(404, "account_not_found", `no account with id ${id}`, { id });
    if (!this.#mayAct(account, principal)) return this.#forbidden(account);
    // [FAULT f-activate-after-close] Closure stops being terminal: activation
    // treats a tombstoned account as merely inactive and brings it back.
    if (account.status === "closed" && this.#faults.has("f-activate-after-close")) {
      this.#tickSequence();
      account.status = "active";
      account.closed_at = null;
      account.activated_at = this.#now();
      return ok(200, this.#account(account));
    }
    if (account.status === "closed") return this.#tombstone(account);
    if (account.status === "active") {
      return fail(409, "account_not_pending", `account ${id} is already active`, { id, status: account.status });
    }
    this.#tickSequence();
    account.status = "active";
    account.activated_at = this.#now();
    return ok(200, this.#account(account));
  }

  closeAccount(id, { principal = ADMIN_PRINCIPAL } = {}) {
    const account = this.state.accounts.get(id);
    if (!account) return fail(404, "account_not_found", `no account with id ${id}`, { id });
    if (!this.#mayAct(account, principal)) return this.#forbidden(account);
    if (account.kind === "system") {
      return fail(409, "account_not_closable", `account ${id} is a system account`, { id });
    }
    if (account.status === "closed") return this.#tombstone(account);
    const pending = [...this.state.transfers.values()].filter(
      (transfer) =>
        transfer.status === "pending" &&
        // [FAULT f-close-pending-inbound] The guard only considers transfers
        // the account is *sending*, so an account that is merely the
        // destination of an in-flight transfer closes while it is still
        // pending — the money then settles into a tombstoned account.
        (transfer.source_account_id === id ||
          (transfer.destination_account_id === id && !this.#faults.has("f-close-pending-inbound"))),
    );
    if (pending.length) {
      return fail(409, "account_has_pending_transfers", `account ${id} still has pending transfers`, {
        id,
        pending_transfer_ids: pending.map((transfer) => transfer.id),
      });
    }
    this.#tickSequence();
    account.status = "closed";
    account.closed_at = this.#now();
    return ok(200, this.#account(account));
  }

  // ---- deposits ----

  createDeposit(body, { principal = ADMIN_PRINCIPAL } = {}) {
    if (!body || typeof body !== "object") return fail(400, "invalid_request", "a JSON object body is required");
    const unknown = unknownProperty(body, ["account_id", "amount"]);
    if (unknown) return unknown;
    const accountId = body.account_id;
    if (typeof accountId !== "string" || !accountId) {
      return fail(400, "invalid_request", "account_id must be a string", { field: "account_id" });
    }
    const malformed = malformedAmount(body.amount);
    if (malformed) return malformed;
    if (!isPositiveInteger(body.amount)) {
      return fail(422, "invalid_amount", "amount must be a positive integer in minor units", { field: "amount" });
    }
    const account = this.state.accounts.get(accountId);
    if (!account) return fail(404, "account_not_found", `no account with id ${accountId}`, { id: accountId });
    if (!this.#mayAct(account, principal)) return this.#forbidden(account);
    if (account.status === "closed") return this.#tombstone(account);
    if (account.status !== "active") {
      return fail(409, "account_not_active", `account ${accountId} is not active`, {
        id: accountId,
        status: account.status,
      });
    }

    this.#tickSequence();
    const deposit = {
      id: this.#id("dep"),
      account_id: account.id,
      amount: body.amount,
      currency: account.currency,
      status: "settled",
      created_at: this.#now(),
      entry_id: null,
    };
    const entry = this.#appendEntry({
      account,
      kind: "deposit",
      amount: body.amount,
      transfer_id: null,
      deposit_id: deposit.id,
    });
    account.balance += body.amount;
    // [FAULT f-deposit-entry-mismatch] The receipt is filled in by looking the
    // row up again and taking the one before it, so a second deposit into the
    // same account points at the previous deposit's entry.
    const own = this.state.entries.filter((row) => row.account_id === account.id);
    deposit.entry_id =
      this.#faults.has("f-deposit-entry-mismatch") && own.length > 1 ? own[own.length - 2].id : entry.id;
    this.state.deposits.set(deposit.id, deposit);
    return ok(201, this.#deposit(deposit));
  }

  getDeposit(id, { principal = ADMIN_PRINCIPAL } = {}) {
    const deposit = this.state.deposits.get(id);
    if (!deposit) return fail(404, "deposit_not_found", `no deposit with id ${id}`, { id });
    const account = this.state.accounts.get(deposit.account_id);
    if (account && !this.#mayRead(account, principal)) return this.#forbidden(account);
    return ok(200, this.#deposit(deposit));
  }

  // ---- transfers ----

  createTransfer(body, { idempotencyKey = null, principal = ADMIN_PRINCIPAL } = {}) {
    if (!body || typeof body !== "object") return fail(400, "invalid_request", "a JSON object body is required");
    const unknown = unknownProperty(body, [
      "source_account_id",
      "destination_account_id",
      "amount",
      "currency",
    ]);
    if (unknown) return unknown;
    const sourceId = body.source_account_id;
    const destinationId = body.destination_account_id;
    if (typeof sourceId !== "string" || !sourceId) {
      return fail(400, "invalid_request", "source_account_id must be a string", { field: "source_account_id" });
    }
    if (typeof destinationId !== "string" || !destinationId) {
      return fail(400, "invalid_request", "destination_account_id must be a string", {
        field: "destination_account_id",
      });
    }
    if (body.currency !== undefined && typeof body.currency !== "string") {
      return fail(400, "invalid_request", "currency must be a string", { field: "currency" });
    }

    if (idempotencyKey) {
      const scoped = `${principal.id}:${idempotencyKey}`;
      const record = this.state.idempotency.get(scoped);
      if (record) {
        // [FAULT f-idempotency-conflict-ignored] The body fingerprint is
        // computed but the mismatch stops being a conflict, so a key reused
        // with a different request silently replays the earlier transfer.
        if (record.fingerprint !== stableStringify(body) && !this.#faults.has("f-idempotency-conflict-ignored")) {
          return fail(409, "idempotency_key_conflict", "this Idempotency-Key was used with a different request body", {
            idempotency_key: idempotencyKey,
          });
        }
        const original = this.state.transfers.get(record.transfer_id);
        // [FAULT f-idempotency-replay-double] The replay returns the original
        // transfer as it should, but also quietly enqueues a second transfer
        // with the same parameters, which settles into a second ledger effect.
        if (this.#faults.has("f-idempotency-replay-double") && original) {
          this.#insertTransfer({
            source: this.state.accounts.get(original.source_account_id),
            destination: this.state.accounts.get(original.destination_account_id),
            amount: original.amount,
            idempotencyKey: null,
          });
        }
        return ok(200, this.#transfer(original), { "idempotency-replayed": "true" });
      }
    }

    const malformed = malformedAmount(body.amount);
    if (malformed) return malformed;
    if (!isPositiveInteger(body.amount)) {
      return fail(422, "invalid_amount", "amount must be a positive integer in minor units", { field: "amount" });
    }
    const amount = body.amount;

    // [FAULT f-undocumented-500] The documented inclusive daily-limit boundary
    // throws instead of being accepted.
    if (this.#faults.has("f-undocumented-500") && amount === DAILY_LIMIT) {
      throw new Error("limit boundary calculation failed");
    }

    const source = this.state.accounts.get(sourceId);
    if (!source) return fail(404, "account_not_found", `no account with id ${sourceId}`, { id: sourceId });
    // Only the account being debited has to belong to the caller: paying an
    // account you cannot read is the ordinary case.
    if (!this.#mayAct(source, principal)) {
      // [FAULT f-transfer-source-unowned] The ownership test is widened to
      // "the caller is a party to this transfer", so owning the destination is
      // enough to pull money out of someone else's account.
      const party =
        this.#faults.has("f-transfer-source-unowned") &&
        this.#mayAct(this.state.accounts.get(destinationId) ?? { kind: "absent" }, principal);
      if (!party) return this.#forbidden(source);
    }
    const destination = this.state.accounts.get(destinationId);
    if (!destination) {
      return fail(404, "account_not_found", `no account with id ${destinationId}`, { id: destinationId });
    }
    if (source.id === destination.id) {
      // [FAULT f-same-account-envelope-bare] This one refusal is assembled by
      // hand instead of through the envelope helper.
      if (this.#faults.has("f-same-account-envelope-bare")) {
        return {
          status: 422,
          body: { error: "same_account", message: "source and destination must differ" },
          headers: null,
        };
      }
      return fail(422, "same_account", "source and destination must differ", { id: source.id });
    }

    for (const account of [source, destination]) {
      // [FAULT f-close-ghost] Closed accounts keep transacting.
      if (account.status === "closed" && !this.#faults.has("f-close-ghost")) {
        return this.#tombstone(account);
      }
      if (account.status === "pending") {
        // [FAULT f-transfer-to-pending-destination] The activation guard ends
        // up applied to the payer only, so money can be sent into an account
        // that was never activated.
        if (this.#faults.has("f-transfer-to-pending-destination") && account.id === destination.id) continue;
        return fail(409, "account_not_active", `account ${account.id} is not active`, {
          id: account.id,
          status: account.status,
        });
      }
    }
    if (body.currency !== undefined && body.currency !== source.currency) {
      return fail(422, "currency_mismatch", "currency must match the source account", {
        requested: body.currency,
        source_currency: source.currency,
      });
    }
    if (source.currency !== destination.currency) {
      return fail(422, "currency_mismatch", "transfers are same-currency only", {
        source_currency: source.currency,
        destination_currency: destination.currency,
      });
    }

    const usageKey = `${source.id}:${this.state.day}`;
    const used = this.state.dailyUsage.get(usageKey) ?? 0;
    if (used + amount > DAILY_LIMIT) {
      return fail(422, "daily_limit_exceeded", "the source account's daily transfer limit would be exceeded", {
        id: source.id,
        day: this.state.day,
        limit: DAILY_LIMIT,
        used,
        requested: amount,
      });
    }

    const fee = this.#feeFor(amount, source.currency);
    if (source.balance < amount + fee) {
      // [FAULT f-error-200] A business rejection is dressed up as success.
      if (this.#faults.has("f-error-200")) {
        this.#tickSequence();
        const transfer = {
          id: this.#id("tr"),
          status: "failed",
          source_account_id: source.id,
          destination_account_id: destination.id,
          amount,
          fee,
          currency: source.currency,
          idempotency_key: idempotencyKey,
          failure_reason: "insufficient_funds",
          sequence: this.state.sequence,
          created_at: this.#now(),
          settled_at: null,
          canceled_at: null,
        };
        this.state.transfers.set(transfer.id, transfer);
        return ok(200, this.#transfer(transfer));
      }
      return fail(422, "insufficient_funds", "the source account cannot cover the amount plus the fee", {
        id: source.id,
        balance: source.balance,
        required: amount + fee,
      });
    }

    const transfer = this.#insertTransfer({ source, destination, amount, idempotencyKey });
    this.state.dailyUsage.set(usageKey, used + amount);
    if (idempotencyKey) {
      this.state.idempotency.set(`${principal.id}:${idempotencyKey}`, {
        fingerprint: stableStringify(body),
        transfer_id: transfer.id,
      });
    }
    return ok(201, this.#transfer(transfer));
  }

  /**
   * The fee schedule, applied per transfer.
   *
   * [FAULT f-eur-fee-flat] The basis-point component is dropped for EUR, so
   * the EUR fee is the flat component alone. Everything downstream — the funds
   * check, the transfer's declared fee, the debit leg, and the fee row — reads
   * this one number, so the transfer stays internally consistent and only the
   * schedule itself is wrong.
   */
  #feeFor(amount, currency) {
    if (this.#faults.has("f-eur-fee-flat") && currency === "EUR") return FEE_FLAT;
    return feeFor(amount);
  }

  #insertTransfer({ source, destination, amount, idempotencyKey }) {
    this.#tickSequence();
    const transfer = {
      id: this.#id("tr"),
      status: "pending",
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount,
      fee: this.#feeFor(amount, source.currency),
      currency: source.currency,
      idempotency_key: idempotencyKey ?? null,
      failure_reason: null,
      sequence: this.state.sequence,
      created_at: this.#now(),
      settled_at: null,
      canceled_at: null,
    };
    this.state.transfers.set(transfer.id, transfer);
    return transfer;
  }

  /** A transfer is visible to the principals owning either of its two sides. */
  #transferParty(transfer, principal) {
    if (principal.role === "admin") return true;
    return [transfer.source_account_id, transfer.destination_account_id].some((accountId) => {
      const account = this.state.accounts.get(accountId);
      return account ? account.owner_principal === principal.id : false;
    });
  }

  getTransfer(id, { principal = ADMIN_PRINCIPAL } = {}) {
    const transfer = this.state.transfers.get(id);
    if (!transfer) return fail(404, "transfer_not_found", `no transfer with id ${id}`, { id });
    if (!this.#transferParty(transfer, principal)) {
      return fail(403, "forbidden", `transfer ${id} does not involve this principal`, { id });
    }
    return ok(200, this.#transfer(transfer));
  }

  listTransfers({ limit, cursor, accountId, principal = ADMIN_PRINCIPAL } = {}) {
    const page = this.#pageSize(limit);
    if (page.error) return page.error;
    let all = [...this.state.transfers.values()].sort(byPageOrder);
    all = all.filter((transfer) => this.#transferParty(transfer, principal));
    const involves = (transfer) =>
      transfer.source_account_id === accountId || transfer.destination_account_id === accountId;
    // [FAULT f-transfers-filter-after-page] The account filter is applied to
    // the page instead of to the collection, so a filtered page comes back
    // short while its cursor still promises another one.
    if (accountId && this.#faults.has("f-transfers-filter-after-page")) {
      const paged = this.#paginate(all, page.size, cursor, (transfer) => this.#transfer(transfer));
      if (paged.status === 200) paged.body.items = paged.body.items.filter(involves);
      return paged;
    }
    if (accountId) all = all.filter(involves);
    return this.#paginate(all, page.size, cursor, (transfer) => this.#transfer(transfer));
  }

  cancelTransfer(id, { principal = ADMIN_PRINCIPAL } = {}) {
    const transfer = this.state.transfers.get(id);
    if (!transfer) return fail(404, "transfer_not_found", `no transfer with id ${id}`, { id });
    // The payer cancels: cancellation returns the reserved funds to the source.
    const source = this.state.accounts.get(transfer.source_account_id);
    if (source && !this.#mayAct(source, principal)) return this.#forbidden(source);
    if (transfer.status !== "pending") {
      // [FAULT f-settle-cancel-race] A settled transfer can still be canceled,
      // and the reversal refunds the fee to the payer without clawing it back
      // out of the fee account, so the transfer's entries no longer net to zero.
      if (this.#faults.has("f-settle-cancel-race") && transfer.status === "settled") {
        const source = this.state.accounts.get(transfer.source_account_id);
        const destination = this.state.accounts.get(transfer.destination_account_id);
        this.#tickSequence();
        this.#appendEntry({
          account: source,
          kind: "transfer_credit",
          amount: transfer.amount + transfer.fee,
          transfer_id: transfer.id,
          deposit_id: null,
        });
        source.balance += transfer.amount + transfer.fee;
        this.#appendEntry({
          account: destination,
          kind: "transfer_debit",
          amount: -transfer.amount,
          transfer_id: transfer.id,
          deposit_id: null,
        });
        destination.balance -= transfer.amount;
        transfer.status = "canceled";
        transfer.canceled_at = this.#now();
        return ok(200, this.#transfer(transfer));
      }
      return fail(409, "transfer_not_pending", `transfer ${id} is ${transfer.status}`, {
        id,
        status: transfer.status,
      });
    }
    this.#tickSequence();
    transfer.status = "canceled";
    transfer.canceled_at = this.#now();
    // [FAULT f-idempotency-freed-by-cancel] Cancelling releases the key the
    // transfer was created with — "the request never happened" — so the next
    // retry of the very same request is treated as a first attempt.
    if (this.#faults.has("f-idempotency-freed-by-cancel") && transfer.idempotency_key) {
      for (const [scoped, record] of [...this.state.idempotency]) {
        if (record.transfer_id === transfer.id) this.state.idempotency.delete(scoped);
      }
    }
    return ok(200, this.#transfer(transfer));
  }

  // ---- ledger entries ----

  #appendEntry({ account, kind, amount, transfer_id, deposit_id }) {
    const entry = {
      id: this.#id("ent"),
      account_id: account.id,
      kind,
      amount,
      currency: account.currency,
      transfer_id,
      deposit_id,
      sequence: this.state.entries.length + 1,
      created_at: this.#now(),
    };
    this.state.entries.push(entry);
    return entry;
  }

  listEntries(accountId, { limit, cursor, principal = ADMIN_PRINCIPAL } = {}) {
    const account = this.state.accounts.get(accountId);
    if (!account) return fail(404, "account_not_found", `no account with id ${accountId}`, { id: accountId });
    // [FAULT f-entries-cross-principal] The history endpoint is treated as
    // public once the account is known to exist, so any principal can read any
    // account's ledger.
    if (!this.#mayRead(account, principal) && !this.#faults.has("f-entries-cross-principal")) {
      return this.#forbidden(account);
    }
    const page = this.#pageSize(limit);
    if (page.error) return page.error;

    // [FAULT f-cursor-error-bare] A rejected cursor on this endpoint answers
    // with a bare `{message}` payload rather than the declared
    // `{error:{code,message}}` envelope every other refusal uses.
    if (this.#faults.has("f-cursor-error-bare") && cursor !== undefined && cursor !== null && cursor !== "") {
      const decoded = decodeCursor(cursor);
      const usable = decoded && (typeof decoded.s === "number" || typeof decoded.o === "number");
      if (!usable) {
        return {
          status: 400,
          body: { message: "cursor is not a cursor previously returned by this endpoint" },
          headers: null,
        };
      }
    }

    // Newest first. The declared consistency model is cursor-monotone: a page
    // returns entries strictly older than the cursor, so writes that land
    // between pages append at the head and are simply not enumerated. No entry
    // id is ever returned twice within one enumeration.
    const rows = this.state.entries
      .filter((entry) => entry.account_id === accountId)
      .sort(byPageOrder);

    // [FAULT f-pagination-dup] The cursor degrades to a positional offset, so a
    // write between pages shifts the window and repeats the boundary entry.
    if (this.#faults.has("f-pagination-dup")) {
      let offset = 0;
      if (cursor !== undefined && cursor !== null && cursor !== "") {
        const decoded = decodeCursor(cursor);
        if (!decoded || typeof decoded.o !== "number") {
          return fail(400, "invalid_cursor", "cursor is not a cursor previously returned by this endpoint");
        }
        offset = decoded.o;
      }
      const items = rows.slice(offset, offset + page.size);
      const next = offset + page.size < rows.length ? encodeCursor({ o: offset + page.size }) : null;
      return ok(200, { items: items.map((entry) => this.#entry(entry)), next_cursor: next });
    }

    return this.#paginate(rows, page.size, cursor, (entry) => this.#entry(entry));
  }

  // ---- admin ----

  /**
   * Advance settlement. Pending transfers settle in creation order; funds are
   * re-checked at settlement time, and a transfer that can no longer be
   * covered ends `failed` with no ledger entries at all.
   */
  tick({ settleLimit = null, advanceDay = false } = {}) {
    const settled = [];
    const failed = [];
    // [FAULT f-balance-cache-stale] Only the first settlement per account in a
    // tick reaches the stored balance; the entries are all written, so the
    // stored balance drifts away from the entry sum.
    const balanceTouched = new Set();
    const applyBalance = (account, delta) => {
      if (
        this.#faults.has("f-balance-cache-stale") &&
        account.kind === "customer" &&
        balanceTouched.has(account.id)
      ) {
        return;
      }
      balanceTouched.add(account.id);
      account.balance += delta;
    };

    const pending = [...this.state.transfers.values()]
      .filter((transfer) => transfer.status === "pending")
      .sort((a, b) => a.sequence - b.sequence);
    // [FAULT f-tick-day-skips-settlement] A tick that rolls the ledger day
    // over is treated as an administrative call and returns without working
    // the pending queue at all.
    const rolloverOnly = advanceDay && this.#faults.has("f-tick-day-skips-settlement");
    const requested = settleLimit === null ? pending : pending.slice(0, Math.max(0, settleLimit));
    const batch = rolloverOnly ? [] : requested;

    for (const transfer of batch) {
      const source = this.state.accounts.get(transfer.source_account_id);
      const destination = this.state.accounts.get(transfer.destination_account_id);
      const feeAccount = this.state.accounts.get(FEE_ACCOUNT_IDS[transfer.currency]);
      this.#tickSequence();
      if (source.balance < transfer.amount + transfer.fee) {
        // [FAULT f-settle-failed-debit] The failure path posts the source's
        // debit row before abandoning the settlement. A transfer documented to
        // write no entries at all leaves one behind, and because the stored
        // balance is (correctly) untouched, the account's rows stop summing to
        // its balance.
        if (this.#faults.has("f-settle-failed-debit")) {
          this.#appendEntry({
            account: source,
            kind: "transfer_debit",
            amount: -(transfer.amount + transfer.fee),
            transfer_id: transfer.id,
            deposit_id: null,
          });
        }
        transfer.status = "failed";
        transfer.failure_reason = "insufficient_funds";
        failed.push(transfer.id);
        continue;
      }
      this.#appendEntry({
        account: source,
        kind: "transfer_debit",
        amount: -(transfer.amount + transfer.fee),
        transfer_id: transfer.id,
        deposit_id: null,
      });
      // [FAULT f-fee-double-charged] The EUR fee schedule is applied to the
      // credit leg as well as the debit leg, so the payee silently absorbs a
      // fee the payer has already paid on top and the transfer's three entries
      // sum to minus the fee instead of zero. USD settlements are unaffected.
      const creditAmount =
        this.#faults.has("f-fee-double-charged") && transfer.currency === "EUR"
          ? transfer.amount - transfer.fee
          : transfer.amount;
      this.#appendEntry({
        account: destination,
        kind: "transfer_credit",
        amount: creditAmount,
        transfer_id: transfer.id,
        deposit_id: null,
      });
      // [FAULT f-fee-rounding-drift] The fee leg truncates the basis-point
      // component while the debit leg rounds it half-up, so a half-minor-unit
      // fee leaves the transfer's entries one unit short of zero.
      const feeEntryAmount = this.#faults.has("f-fee-rounding-drift")
        ? FEE_FLAT + Math.floor((transfer.amount * FEE_BPS) / 10000)
        : transfer.fee;
      this.#appendEntry({
        account: feeAccount,
        kind: "fee",
        amount: feeEntryAmount,
        transfer_id: transfer.id,
        deposit_id: null,
      });
      applyBalance(source, -(transfer.amount + transfer.fee));
      applyBalance(destination, creditAmount);
      // [FAULT f-fee-account-balance-untouched] The fee row is posted but the
      // system account's stored balance is left where it was, so the fee
      // account's ledger and its balance drift apart by every fee collected.
      if (!this.#faults.has("f-fee-account-balance-untouched")) applyBalance(feeAccount, feeEntryAmount);
      transfer.status = "settled";
      transfer.settled_at = this.#now();
      settled.push(transfer.id);
    }

    if (advanceDay) {
      // [FAULT f-day-usage-carryover] The rollover re-keys the day's usage
      // onto the new day instead of starting the count at zero, so yesterday's
      // transfers keep consuming today's limit.
      const carried = this.#faults.has("f-day-usage-carryover") ? [...this.state.dailyUsage] : null;
      this.state.day += 1;
      this.state.dailyUsage.clear();
      for (const [key, used] of carried ?? []) {
        this.state.dailyUsage.set(`${key.slice(0, key.lastIndexOf(":"))}:${this.state.day}`, used);
      }
      // [FAULT f-idempotency-day-expiry] The day rollover clears the recorded
      // idempotency keys along with the daily usage, so a client retrying the
      // same key and the same body across a rollover is treated as a first
      // attempt and gets a second, independent transfer.
      if (this.#faults.has("f-idempotency-day-expiry")) this.state.idempotency.clear();
    }
    return ok(200, {
      settled,
      failed,
      pending: [...this.state.transfers.values()].filter((transfer) => transfer.status === "pending").length,
      day: this.state.day,
    });
  }

  adminReset(body) {
    const unknown = unknownProperty(body, ["seed"]);
    if (unknown) return unknown;
    const seed = body && typeof body === "object" && body.seed !== undefined ? String(body.seed) : this.state.seed;
    const result = this.reset(seed);
    return ok(200, { ok: true, ...result });
  }

  // ---- pagination helpers ----

  #pageSize(limit) {
    if (limit === undefined || limit === null || limit === "") return { size: DEFAULT_PAGE_SIZE };
    const parsed = Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      return {
        error: fail(400, "invalid_limit", `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`, {
          field: "limit",
          max: MAX_PAGE_SIZE,
        }),
      };
    }
    return { size: parsed };
  }

  /** Cursor-monotone descending pagination over a `sequence`-sorted list. */
  #paginate(rows, size, cursor, project) {
    let window = rows;
    if (cursor !== undefined && cursor !== null && cursor !== "") {
      const decoded = decodeCursor(cursor);
      if (!decoded || typeof decoded.s !== "number") {
        return fail(400, "invalid_cursor", "cursor is not a cursor previously returned by this endpoint");
      }
      // Strictly after the cursor position in the total page order. A cursor
      // carrying only `s` (the pre-tie-break shape) keeps the old strict
      // sequence filter.
      window = rows.filter((row) =>
        typeof decoded.i === "string"
          ? row.sequence < decoded.s || (row.sequence === decoded.s && String(row.id) < decoded.i)
          : row.sequence < decoded.s,
      );
    }
    const items = window.slice(0, size);
    // [`trailing-page`] A full page always carries a cursor, even when it
    // happens to be the last one — the caller then gets one empty trailing
    // page instead of ending on the last full page. Still conforming:
    // next_cursor is null on that trailing page (items.length < size there),
    // and no row is ever duplicated or displaced.
    const trailing = this.#variants.has("trailing-page");
    const hasNext = trailing ? items.length === size && items.length > 0 : window.length > size;
    const last = items[items.length - 1];
    const next = hasNext ? encodeCursor({ s: last.sequence, i: String(last.id) }) : null;
    return ok(200, { items: items.map(project), next_cursor: next });
  }
}
