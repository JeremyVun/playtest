# Proposed rule cards — Minibank Ledger

Eight candidate business rules, ordered by my confidence that an API owner
would approve them. Provenance cites either a fragment of
`handout/openapi.json` or an exchange from the read-only observation pass
(42 requests over two executions; the instance's world held only the two
system fee accounts, no customer accounts, transfers or deposits, so every
money-movement card is proposed from the spec and is unverified by
observation).

Each card is written as one rule an owner can approve or deny at sight. I have
deliberately not proposed the error-envelope / documented-status / schema
rules: the default policy set already carries them.

---

## 1. `fee-schedule` — the fee is a published formula, charged on top and credited to the currency's fee account

**Rule.** Every transfer's `fee` is exactly `25 + round_half_away_from_zero(amount × 15 / 10000)` minor units, the source account is debited `amount + fee` (never just `amount`), and the fee is credited to the system fee account for the transfer's own currency.

- **proposed from:** `openapi.json · x-ledger-fee-schedule` (`flat: 25`, `basis_points: 15`, `formula`, `rounding: half away from zero`, `charged_to`, `credited_to`) and `x-ledger-limits.fee_accounts` (`USD → acc_fee_usd`, `EUR → acc_fee_eur`).
- **applies to:** `POST /transfers` at creation (the `fee` field of the returned transfer) and the fee entry written at settlement, in both currencies.
- **exception I believe the API intends:** none. Rounding is half *away from zero* rather than banker's rounding, so an amount whose basis-point component lands on exactly `.5` (e.g. `amount = 1000` → `25 + 2 = 27`) rounds up; deposits carry no fee at all.

## 2. `ledger-arithmetic` — the ledger adds up, in both directions

**Rule.** Every account's stored `balance` — including the system fee accounts — equals the sum of the amounts of all its ledger entries, and the entries carrying a settled transfer's `transfer_id` are exactly three (source debit `−(amount + fee)`, destination credit `+amount`, fee credit `+fee`) which sum to exactly zero.

- **proposed from:** `openapi.json · x-ledger-invariants#balance-agreement` and `#conservation`; `LedgerEntry.kind` enum (`deposit`, `transfer_debit`, `transfer_credit`, `fee`); `x-ledger-consistency.normalization` ("debits are negative, credits are positive").
- **applies to:** every account after every settled movement, read as a `GET /accounts/{accountId}` balance against a complete `GET /accounts/{accountId}/entries` enumeration.
- **exception I believe the API intends:** deposits are the declared exception to conservation — a deposit writes one `deposit` entry of `+amount` and no counter-entry, so it moves total ledger value; and a transfer that ends `canceled` or `failed` writes no entries at all, so it must move nothing. Balance and entries must be compared with no intervening write.

## 3. `ownership` — a customer stays inside the accounts it owns, and only the administrator holds administrator authority

**Rule.** A customer principal may read, fund, activate, close, spend from and cancel against only the accounts whose `owner_principal` is that principal — anything else is refused `403` with no representation of the resource in the body — and only the administrator may call `/admin/*` or open an account for someone else via `owner_principal`.

- **proposed from:** `openapi.json · x-ledger-invariants#ownership`; `CreateAccountRequest.owner_principal` ("Administrator only; a customer principal supplying it is refused 403"); `components.securitySchemes.bearerAuth`. Observed: `GET /accounts` as each of the two customer tokens returned only the public fee accounts and never each other's world; `GET /accounts/acc_zzz_nope` as a customer answered `404 account_not_found`, i.e. existence is resolved before ownership.
- **applies to:** every account-scoped and transfer-scoped operation for customer principals; the administrator is unrestricted.
- **exception I believe the API intends:** the system fee accounts and their entries are readable by every principal (observed: `GET /accounts/acc_fee_usd` and `/entries` both `200` under either customer token), and a transfer is readable by the owner of *either* side — being paid by a stranger reveals the transfer without revealing the payer's account. Ownership is fixed at creation and never transfers.

## 4. `lifecycle-legality` — only active accounts transact, and closure is a soft delete

**Rule.** Money moves only between accounts that are `active` — a transfer or deposit naming a `pending` account is refused `409` and one naming a `closed` account is refused `410` — an account with pending transfers cannot be closed (`409`), and a closed account keeps serving its ledger history at `GET /accounts/{accountId}/entries` while `GET /accounts/{accountId}` answers `410` with a tombstone.

- **proposed from:** `openapi.json · x-ledger-invariants#lifecycle-legality`; `x-ledger-consistency.closed-accounts`; `POST /accounts/{accountId}/close` description; `info.description` §Lifecycle; `Account.status` enum.
- **applies to:** `POST /transfers`, `POST /deposits`, `POST /accounts/{accountId}/close`, `GET /accounts/{accountId}`, `GET /accounts/{accountId}/entries`, and `GET /accounts` (a closed account is omitted from the listing unless `include_closed=true`).
- **exception I believe the API intends:** none for transacting. The history exception is deliberate — closure must not destroy or hide entries, and the fee accounts (always `active`) are never closable in practice.

## 5. `idempotency` — a repeated transfer key creates one transfer, per principal

**Rule.** Two `POST /transfers` requests from the same principal carrying the same `Idempotency-Key` and the same body produce exactly one transfer and exactly one set of ledger effects, with the second answering `200` and returning the first transfer; the same key with a *different* body is refused `409` and creates nothing.

- **proposed from:** `openapi.json · x-ledger-invariants#idempotency`; `POST /transfers · Idempotency-Key` parameter ("Replay protection, scoped to the authenticated principal … repeating it with a different body is 409") and its documented `200` response plus `Idempotency-Replayed` header.
- **applies to:** `POST /transfers` only, scoped per authenticated principal.
- **exception I believe the API intends:** the scoping is per principal, so two different customers using the *same* key string must each get their own transfer — one principal's key must never replay another's. The replay must also be a genuine replay: no second debit, no second fee, and the source balance and daily usage must move exactly once.

## 6. `settlement` — nothing settles except at a tick, in order, and re-checked

**Rule.** A pending transfer changes state only during `POST /admin/tick`, which settles pending transfers in creation order, re-checks at settlement time that the source still covers `amount + fee`, and marks a transfer that no longer does as `failed` with a `failure_reason` and no ledger entries.

- **proposed from:** `openapi.json · x-ledger-consistency.settlement`; `info.description` §Determinism ("no wall clock and no background workers"); `POST /admin/tick` description and `TickResult` (`settled`, `failed`, `pending`, `day`); `Transfer.status` enum and `failure_reason`.
- **applies to:** `POST /transfers` (creation leaves `pending` and writes nothing), `POST /admin/tick`, and the resulting `Transfer` and ledger entries.
- **exception I believe the API intends:** `settle_limit` bounds how many pending transfers a tick settles, and the ones it leaves behind must stay `pending` and be reported in `TickResult.pending` — a bounded tick must still respect creation order. A canceled transfer is never picked up by a later tick.

## 7. `daily-limit` — the daily allowance is reserved at creation and never given back

**Rule.** The sum of the `amount`s of the transfers a source account *creates* in the current ledger day may not exceed 100 000 minor units — a request that brings the running total exactly to the limit is accepted and anything beyond it is refused `422 daily_limit_exceeded` — and cancelling a transfer or having it fail at settlement does not return its amount to the allowance.

- **proposed from:** `openapi.json · x-ledger-consistency.daily-limit` ("reserved at creation: cancelling or failing a transfer does not release it… exactly to the limit is accepted"); `x-ledger-limits.daily_transfer_limit: 100000`; `POST /transfers · 422` description (`daily_limit_exceeded`); `TickRequest.advance_day`.
- **applies to:** `POST /transfers`, measured per source account, per ledger day, against `amount` only (the fee is charged to the balance but I read it as *not* consuming the allowance — worth the adjudicator's ruling).
- **exception I believe the API intends:** the allowance resets only when `POST /admin/tick` is called with `advance_day: true`; there is no wall clock, so it never resets on its own. The limit is per source account, so an account near its limit must not be blocked by an unrelated account's spending.

## 8. `pagination-completeness` — a cursor walk over an unchanging collection loses nothing

**Rule.** Starting without a cursor and following `next_cursor` to termination returns every item that was present when the walk began, exactly once, regardless of the page size chosen.

- **proposed from:** observed exchange — `GET /accounts?limit=1` returned `[acc_fee_usd]` with `next_cursor: "eyJzIjowfQ"` (base64 `{"s":0}`), and `GET /accounts?limit=1&cursor=eyJzIjowfQ` returned `[]` with `next_cursor: null`, terminating the walk; `GET /accounts?limit=2` on the same quiescent, write-free instance returned both `acc_fee_usd` and `acc_fee_eur`. The two accounts share `created_at: 2026-01-01T00:00:00.000Z`, so the sequence-valued cursor cannot separate them and the page-size-1 walk silently drops one. Rule text also grounded in `x-ledger-invariants#pagination-identity` and `x-ledger-consistency.account-pagination` / `.entry-pagination`.
- **applies to:** `GET /accounts`, `GET /transfers`, and `GET /accounts/{accountId}/entries`, for an enumeration during which nothing is written.
- **exception I believe the API intends:** the documented concurrency carve-out — items appended *after* an enumeration begins may be missed, since pages are strictly-older-than-cursor. I am proposing only the quiescent case, which that carve-out does not cover; I flag that `pagination-identity` also states flatly that "no-skip … guarantees are NOT offered", so if the owner intends ties at the same sequence to be droppable, this card should be denied rather than edited.
