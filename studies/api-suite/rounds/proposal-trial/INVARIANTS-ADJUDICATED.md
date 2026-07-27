# Invariant statements — proposal trial, as adjudicated

These are your phase-1 proposals, adjudicated: all eight approved, none
edited, none denied, two carrying an adjudication note. They are now the rule
set your suite enforces, alongside the default policy set. Nothing you did
not propose has been added.

## 1. The fee schedule {#fee-schedule}

Every transfer's `fee` is exactly `25 + round_half_away_from_zero(amount ×
15 / 10000)` minor units, the source account is debited `amount + fee` —
never just `amount` — and the fee is credited to the system fee account for
the transfer's own currency.

It applies to `POST /transfers` at creation (the `fee` field of the returned
transfer) and to the fee entry written at settlement, in both currencies.
There are no exceptions: rounding is half away from zero (an exact `.5`
basis-point component rounds up), and deposits carry no fee at all.

## 2. Ledger arithmetic {#ledger-arithmetic}

Every account's stored `balance` — including the system fee accounts —
equals the sum of the amounts of all its ledger entries, and the entries
carrying a settled transfer's `transfer_id` are exactly three (source debit
`−(amount + fee)`, destination credit `+amount`, fee credit `+fee`) which
sum to exactly zero.

It applies to every account after every settled movement, read as a
`GET /accounts/{accountId}` balance against a complete entry enumeration.
Exceptions: a deposit writes one `deposit` entry of `+amount` with no
counter-entry; a transfer ending `canceled` or `failed` writes no entries
and must move nothing. Compare balance and entries with no intervening
write.

## 3. Ownership {#ownership}

A customer principal may read, fund, activate, close, spend from, and cancel
against only the accounts whose `owner_principal` is that principal —
anything else is refused `403` with no representation of the resource — and
only the administrator may call `/admin/*` or open an account for someone
else via `owner_principal`.

It applies to every account-scoped and transfer-scoped operation for
customer principals; the administrator is unrestricted. Exceptions: the
system fee accounts and their entries are readable by every principal and
actable by none; a transfer's destination need not belong to the caller; a
transfer is readable by the owner of either side. Ownership is fixed at
creation.

## 4. Lifecycle legality {#lifecycle-legality}

Money moves only between `active` accounts — a transfer or deposit naming a
`pending` account is refused `409` and one naming a `closed` account is
refused `410` — an account with pending transfers cannot be closed (`409`),
and a closed account keeps serving its ledger history while
`GET /accounts/{accountId}` answers `410` with a tombstone.

It applies to `POST /transfers`, `POST /deposits`,
`POST /accounts/{accountId}/close`, `GET /accounts/{accountId}`,
`GET /accounts/{accountId}/entries`, and `GET /accounts` (closed accounts
omitted unless `include_closed=true`). The history-after-closure behavior is
deliberate, not an exception to legality.

## 5. Idempotency {#idempotency}

Two `POST /transfers` requests from the same principal carrying the same
`Idempotency-Key` and the same body produce exactly one transfer and exactly
one set of ledger effects, the second answering `200` with the first
transfer; the same key with a different body is refused `409` and creates
nothing.

It applies to `POST /transfers`, scoped per authenticated principal: two
principals sharing a key string each get their own transfer. A replay is a
genuine replay — no second debit, no second fee, and balance and daily usage
move exactly once.

## 6. Settlement {#settlement}

A pending transfer changes state only during `POST /admin/tick`, which
settles pending transfers in creation order, re-checks at settlement time
that the source still covers `amount + fee`, and marks a transfer that no
longer does as `failed` with a `failure_reason` and no ledger entries.

It applies to `POST /transfers` (creation leaves `pending` and writes
nothing), `POST /admin/tick`, and the resulting transfer and entries.
Exceptions: `settle_limit` bounds how many transfers a tick settles and
leaves the rest pending, in order; a canceled transfer is never picked up by
a later tick.

## 7. The daily limit {#daily-limit}

The sum of the amounts of the transfers a source account creates in the
current ledger day may not exceed 100 000 minor units — exactly reaching the
limit is accepted, anything beyond is refused `422 daily_limit_exceeded` —
and cancelling a transfer or having it fail at settlement does not return
its amount to the allowance.

It applies per source account, per ledger day, to `POST /transfers`,
measured against `amount` only. **Adjudication note: your reading is
ruled correct — the fee is charged to the balance but does not consume the
allowance.** The allowance resets only via `POST /admin/tick` with
`advance_day: true`; the limit is per source account.

## 8. Pagination completeness {#pagination-completeness}

Starting without a cursor and following `next_cursor` to termination returns
every item that was present when the walk began, exactly once, regardless of
the page size chosen.

It applies to `GET /accounts`, `GET /transfers`, and
`GET /accounts/{accountId}/entries`, for an enumeration during which nothing
is written to the collection; items appended after the enumeration begins
may be missed, and that is not a violation. **Adjudication note: the
anomaly your observation pass found was confirmed by hand as a genuine
defect and has been fixed — quiescent completeness is intended, your rule
stands as proposed, and the environment you author against now honors it.**
