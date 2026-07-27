// The seeded fault catalog (docs/backlog/api-testing/DESIGN.md §6.3).
//
// Faults are OFF unless explicitly enabled, individually toggleable, and never
// observable except through the behaviour they change: no endpoint, header, or
// log line reports which faults are active, because the probe under
// measurement must not be able to read the answer key off the wire.
//
// Every fault branch in `ledger.js` is marked with a `[FAULT <id>]` comment so
// the branches are greppable for maintenance and excludable from any future
// code-mining (Tier-4) experiment.

/** The development set: the eight faults of DESIGN §6.3, visible during tuning. */
export const DEVELOPMENT_FAULT_IDS = Object.freeze([
  "f-error-200",
  "f-undocumented-500",
  "f-fee-rounding-drift",
  "f-idempotency-replay-double",
  "f-settle-cancel-race",
  "f-close-ghost",
  "f-pagination-dup",
  "f-balance-cache-stale",
]);

/**
 * The sealed held-out set (DESIGN §6.3). Authored before the P1 evaluation
 * round, applied only in the measured-round environment, and never referenced
 * by probe-tuning material. Each one is different *in kind* from a development
 * fault — a different domain rule broken by a different mechanism — so the
 * measured round reports generalization rather than tuning. Every held-out
 * fault manifests as a violation the frozen bench oracles can confirm from a
 * request/response trace; the oracles themselves are unchanged.
 */
export const HELD_OUT_FAULT_IDS = Object.freeze([
  "f-cursor-error-bare",
  "f-close-pending-inbound",
  "f-settle-failed-debit",
  "f-idempotency-day-expiry",
  "f-fee-double-charged",
]);

/**
 * S0's sealed set (BUILD_PLAN S0 scope 3, `studies/api-suite/PREREGISTRATION.md`
 * §4.2). Authored by an isolated agent outside the checkout, committed to by
 * sha256 before any trial saw anything, applied only in the measured
 * environment, and landed in history after the round was scored.
 *
 * The thirteen public faults above are development data — every instrument in
 * the study could see them while it was being built. These are the unbiased
 * evidence: a different domain rule broken by a different mechanism, spread
 * across the taxonomy so a per-category miss is visible, and each one the kind
 * of regression an implementation actually produces — a guard applied to one
 * side of a pair, a filter run after the page instead of before it, a rollover
 * that carries state it should have cleared.
 */
export const SEALED_FAULT_IDS = Object.freeze([
  "f-activate-after-close",
  "f-transfer-to-pending-destination",
  "f-deposit-entry-mismatch",
  "f-fee-account-balance-untouched",
  "f-eur-fee-flat",
  "f-include-closed-ignored",
  "f-transfers-filter-after-page",
  "f-idempotency-conflict-ignored",
  "f-idempotency-freed-by-cancel",
  "f-day-usage-carryover",
  "f-tick-day-skips-settlement",
  "f-entries-cross-principal",
  "f-transfer-source-unowned",
  "f-same-account-envelope-bare",
]);

/** Every toggleable fault id, development set first. */
export const FAULT_IDS = Object.freeze([
  ...DEVELOPMENT_FAULT_IDS,
  ...HELD_OUT_FAULT_IDS,
  ...SEALED_FAULT_IDS,
]);

/**
 * The fault taxonomy (BUILD_PLAN S0 scope 3). Results are reported per category
 * so that many similar state faults cannot obscure a total miss on one class of
 * defect — the failure mode a flat "detected 9 of 13" number hides.
 *
 * A category answers "what does a test author have to *do* to reach this?", not
 * "which oracle catches it": that is what makes a per-category miss actionable.
 */
export const CATEGORY_IDS = Object.freeze([
  "state-machine",
  "cross-resource-invariant",
  "conditional-branch",
  "pagination",
  "idempotency",
  "temporal-boundary",
  "authorization",
  "error-semantics",
]);

/**
 * Category per fault. Where a fault could be filed under two categories the
 * choice is the one that describes the *reaching* work, because that is what a
 * per-category miss diagnoses:
 *
 *   - `f-undocumented-500` is a 5xx, but finding it means sending the exact
 *     inclusive daily-limit boundary value — a conditional branch.
 *   - `f-fee-double-charged` breaks conservation, but only on EUR: the author
 *     who enumerates the currency parameter finds it and the one who works in
 *     one currency does not (`studies/api-probe/REPORT.md` §2).
 *   - `f-idempotency-day-expiry` is an idempotency defect reachable only by
 *     crossing a ledger-day rollover on purpose, so it is temporal.
 *
 * The `authorization` category has no fault in the 13 public ones. The fixture
 * does have an authorization surface — principals own accounts (README
 * interpretation note 9) — but it is exercised only by the clean-build suite.
 */
export const FAULT_CATEGORIES = Object.freeze({
  "f-error-200": "error-semantics",
  "f-undocumented-500": "conditional-branch",
  "f-fee-rounding-drift": "cross-resource-invariant",
  "f-idempotency-replay-double": "idempotency",
  "f-settle-cancel-race": "state-machine",
  "f-close-ghost": "state-machine",
  "f-pagination-dup": "pagination",
  "f-balance-cache-stale": "cross-resource-invariant",
  // held-out set
  "f-cursor-error-bare": "error-semantics",
  "f-close-pending-inbound": "state-machine",
  "f-settle-failed-debit": "cross-resource-invariant",
  "f-idempotency-day-expiry": "temporal-boundary",
  "f-fee-double-charged": "conditional-branch",
  // S0 sealed set
  "f-activate-after-close": "state-machine",
  "f-transfer-to-pending-destination": "state-machine",
  "f-deposit-entry-mismatch": "cross-resource-invariant",
  "f-fee-account-balance-untouched": "cross-resource-invariant",
  "f-eur-fee-flat": "conditional-branch",
  "f-include-closed-ignored": "conditional-branch",
  "f-transfers-filter-after-page": "pagination",
  "f-idempotency-conflict-ignored": "idempotency",
  "f-idempotency-freed-by-cancel": "idempotency",
  "f-day-usage-carryover": "temporal-boundary",
  "f-tick-day-skips-settlement": "temporal-boundary",
  "f-entries-cross-principal": "authorization",
  "f-transfer-source-unowned": "authorization",
  "f-same-account-envelope-bare": "error-semantics",
});

/** Tier per DESIGN §6.3: what class of tool is expected to reach the fault. */
export const FAULT_TIERS = Object.freeze({
  "f-error-200": "schema-reachable",
  "f-undocumented-500": "schema-reachable",
  "f-fee-rounding-drift": "semantic",
  "f-idempotency-replay-double": "semantic",
  "f-settle-cancel-race": "semantic",
  "f-close-ghost": "semantic",
  "f-pagination-dup": "semantic",
  "f-balance-cache-stale": "semantic",
  // held-out set
  "f-cursor-error-bare": "schema-reachable",
  "f-close-pending-inbound": "semantic",
  "f-settle-failed-debit": "semantic",
  "f-idempotency-day-expiry": "semantic",
  "f-fee-double-charged": "semantic",
  // S0 sealed set. All but one are semantic: the bar is computed on the
  // semantic tier, and P1 established that the schema-reachable tier is found
  // by every arm including the ones that read nothing but the document.
  "f-activate-after-close": "semantic",
  "f-transfer-to-pending-destination": "semantic",
  "f-deposit-entry-mismatch": "semantic",
  "f-fee-account-balance-untouched": "semantic",
  "f-eur-fee-flat": "semantic",
  "f-include-closed-ignored": "semantic",
  "f-transfers-filter-after-page": "semantic",
  "f-idempotency-conflict-ignored": "semantic",
  "f-idempotency-freed-by-cancel": "semantic",
  "f-day-usage-carryover": "semantic",
  "f-tick-day-skips-settlement": "semantic",
  "f-entries-cross-principal": "semantic",
  "f-transfer-source-unowned": "semantic",
  "f-same-account-envelope-bare": "schema-reachable",
});

/** One-line description per fault, for `--help` style output and the bench report. */
export const FAULT_DESCRIPTIONS = Object.freeze({
  "f-error-200": "insufficient funds returns 200 with {status:\"failed\"} instead of the 422 envelope",
  "f-undocumented-500": "a transfer amount exactly equal to the daily limit throws",
  "f-fee-rounding-drift": "half-cent fees round differently on the fee leg, so entries no longer sum to zero",
  "f-idempotency-replay-double": "a replayed Idempotency-Key posts a second, hidden ledger effect",
  "f-settle-cancel-race": "cancel after settlement is accepted and appends reversal entries",
  "f-close-ghost": "closed accounts still accept transfers",
  "f-pagination-dup": "entry pagination uses an offset cursor, so a write between pages duplicates the boundary entry",
  "f-balance-cache-stale": "the stored balance misses an account's second settlement in one tick",
  // held-out set
  "f-cursor-error-bare":
    "a rejected entry cursor answers 400 with a bare {message} payload instead of the error envelope",
  "f-close-pending-inbound":
    "the close guard only looks at outbound transfers, so an account with an inbound pending transfer closes",
  "f-settle-failed-debit":
    "a transfer that fails the funds re-check at settlement still writes its debit row, so the stored balance stops agreeing with the account's entries",
  "f-idempotency-day-expiry":
    "the ledger-day rollover drops recorded idempotency keys, so a retry across it creates a second transfer",
  "f-fee-double-charged":
    "on EUR settlements the fee is also deducted from the credit leg, so the transfer's entries sum to minus the fee",
  // S0 sealed set
  "f-activate-after-close": "activating a closed account revives it instead of answering with the tombstone",
  "f-transfer-to-pending-destination":
    "the activation guard is applied to the payer only, so money can be sent into a never-activated account",
  "f-deposit-entry-mismatch":
    "a deposit's entry_id names the account's previous ledger row rather than the one the deposit wrote",
  "f-fee-account-balance-untouched":
    "the fee row is written but the system fee account's stored balance is not advanced with it",
  "f-eur-fee-flat": "EUR transfers are charged the flat fee component only, dropping the basis-point part",
  "f-include-closed-ignored": "GET /accounts?include_closed=true still filters closed accounts out",
  "f-transfers-filter-after-page":
    "the account_id filter on GET /transfers runs after the page slice, so a short page still promises more",
  "f-idempotency-conflict-ignored":
    "an Idempotency-Key reused with a different body returns the earlier transfer instead of refusing the conflict",
  "f-idempotency-freed-by-cancel":
    "cancelling a transfer releases its Idempotency-Key, so the next retry creates a second transfer",
  "f-day-usage-carryover": "the ledger-day rollover carries the day's transfer usage over instead of clearing it",
  "f-tick-day-skips-settlement": "a tick that advances the ledger day settles nothing and leaves the queue pending",
  "f-entries-cross-principal": "GET /accounts/{id}/entries skips the ownership check, so any principal can read it",
  "f-transfer-source-unowned":
    "the transfer ownership test admits a caller who owns either side, so a payee can pull from the payer",
  "f-same-account-envelope-bare":
    "the self-transfer refusal answers 422 with {error:\"same_account\"} instead of the error envelope",
});

/**
 * Parse a `LEDGER_FAULTS` style specification: a comma (or whitespace)
 * separated list of fault ids. Returns `{ ids, unknown }`; the caller decides
 * whether an unknown id is fatal (the server treats it as a startup error so a
 * typo never silently measures the clean build).
 */
export function parseFaults(spec) {
  const parts = String(spec ?? "")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const ids = [];
  const unknown = [];
  for (const part of parts) {
    if (FAULT_IDS.includes(part)) {
      if (!ids.includes(part)) ids.push(part);
    } else if (!unknown.includes(part)) {
      unknown.push(part);
    }
  }
  return { ids, unknown };
}

/** An immutable, order-independent set of enabled faults. */
export class FaultSet {
  #ids;

  constructor(ids = []) {
    const list = Array.isArray(ids) ? ids : parseFaults(ids).ids;
    const unknown = list.filter((id) => !FAULT_IDS.includes(id));
    if (unknown.length) {
      throw new Error(`unknown fault id(s): ${unknown.join(", ")}. Known ids: ${FAULT_IDS.join(", ")}`);
    }
    this.#ids = new Set(list);
  }

  has(id) {
    return this.#ids.has(id);
  }

  get size() {
    return this.#ids.size;
  }

  list() {
    return FAULT_IDS.filter((id) => this.#ids.has(id));
  }
}
