# Invariant statements — S0 handout

The equal-knowledge handout for every S0 arm (`PREREGISTRATION.md` §2.1). These
are the rules of this API, stated as a human owner of it would state them:
rule + applicability + declared exceptions. They extend the six statements P1
used (`studies/api-probe/comparators/INVARIANTS.md`) to the whole of the
service's obligation space — the same rules, plus the ones P1 had no reason to
write down.

Nothing here describes how to test anything. Tactics are the instrument under
test; the invariant knowledge is what every arm gets. Give this file, plus the
service's own OpenAPI document and the client documentation, to an arm —
nothing else.

Two reading notes that apply throughout:

- Money is always a signed integer in minor units. Ledger entry amounts are
  signed — debits negative, credits positive — so comparisons are exact and no
  rounding normalization is ever required.
- The service has no wall clock. Nothing settles, expires, or advances on its
  own; `POST /admin/tick` is the only thing that moves time, and
  `POST /admin/tick {"advance_day": true}` is the only thing that rolls the
  ledger day over.

## 1. Conservation

For a settled transfer, the ledger entries carrying its transfer id — the
source debit, the destination credit, and the fee credit — sum to exactly
zero. There is exactly one row of each of those three kinds, the debit is the
amount plus the fee taken from the source, the credit is the amount given to
the destination, and the fee credit is the fee, on the currency's system fee
account.

It applies to transfers whose status is "settled". Deposits are a declared
exception: external funding has no counter-entry and is excluded. A transfer
that ends "failed", or that is canceled before it settles, writes no entries at
all, so it is not a counterexample either.

## 2. The fee schedule

The fee for a transfer is `25 + round_half_up(amount * 15 / 10000)` minor
units — a flat component plus fifteen basis points of the amount, rounded half
away from zero. It is charged to the source account on top of the amount, and
credited to the system fee account of the transfer's currency.

It applies to every transfer, in every currency: the schedule is one schedule,
not a per-currency table. The fee a transfer declares when it is created is the
fee it settles at. There are no declared exceptions.

## 3. Idempotency

Two POST /transfers requests carrying the same Idempotency-Key and the same
request body produce exactly one transfer and exactly one set of ledger
effects. The second request returns the first transfer. This holds for as long
as the service is running and whatever happens to that transfer in the
meantime — the record of a key is not released by cancelling, failing, or
settling the transfer it created, and it does not expire when the ledger day
rolls over.

It applies to POST /transfers with an Idempotency-Key header, per authenticated
principal: two principals may use the same key for different transfers without
violating anything. There is one declared exception, and it is a rule in its
own right: the same key with a *different* body is refused as a conflict and
creates nothing at all. Returning the earlier transfer for a request that asked
for something else is not idempotency; it is a lost write.

## 4. Lifecycle legality

Only active accounts transact. A transfer naming an account that has never been
activated is rejected, on either side of the transfer. A transfer naming a
closed account is rejected. A deposit into an account that is not active is
rejected. An account with a pending transfer against it — sending or
receiving — cannot be closed. A transfer that has already settled, or failed,
cannot be canceled. Closure is terminal: a closed account is never activated,
reopened, or brought back to any other state.

It applies to POST /transfers, POST /deposits,
POST /accounts/{accountId}/activate, POST /accounts/{accountId}/close, and
POST /transfers/{transferId}/cancel. There are no declared exceptions. Note
that closure is a soft delete, so a closed account still answers with a
tombstone and still serves its entry history: that is documented behaviour and
is not a counterexample.

## 5. Settlement

A tick settles every pending transfer, in creation order, and each one ends the
tick either "settled" or "failed" — never still pending. Funds are re-checked
at settlement time against the current balance, and a transfer that can no
longer be covered ends "failed" and writes no entries at all. A transfer
settles once; a second tick does not settle it again.

It applies to POST /admin/tick with no `settle_limit`, whether or not the same
call also advances the ledger day: a tick that rolls the day over is still a
tick. The declared exception is `settle_limit`, which asks for at most that
many settlements and leaves the rest pending on purpose.

## 6. Ownership

Every account belongs to the principal named in its `owner_principal`, fixed
when the account is created. A customer principal reaches only its own
accounts: reading one, funding it, activating it, closing it, spending from it,
and cancelling a transfer that spends from it. Reaching any other principal's
account — its representation, its ledger entries, or its money — is refused,
and no part of that account's state comes back with the refusal. Only the
principal that owns the source account may create a transfer from it or cancel
one; only the administrator may open an account on another principal's behalf.

It applies to every account-scoped and transfer-scoped operation, for
principals whose role is customer; the administrator is unrestricted. The
declared exceptions are three. The system fee accounts are readable by every
principal, because the fee side of your own transfer has to be auditable, and
actable by none. The *destination* of a transfer need not belong to the caller:
paying an account you cannot read is the ordinary case. And a transfer is
readable by the principals owning either of its two sides, so being paid by a
stranger makes the transfer visible without making the payer's account visible.

## 7. Pagination identity and page discipline

Within one cursor enumeration, no item id is ever returned twice, and following
next_cursor terminates. A page never carries more items than the requested
limit, and a page carrying *fewer* items than the requested limit is the last
page of that enumeration: its next_cursor is null. When a collection is filtered
— by account, or by whether closed accounts are included — every item on every
page satisfies the filter, and, provided nothing is written to that collection
while the enumeration is in flight, every item that satisfied the filter when
the enumeration began is returned by the time it ends.

It applies to every cursor-paginated collection the service exposes —
GET /accounts, GET /transfers, GET /accounts/{accountId}/entries — to an
enumeration that starts *without* a cursor and then follows the next_cursor
values the service hands back. The exceptions are declared and generous: items
written after an enumeration begins may be missed entirely, so the completeness
half of this rule is only claimed for an enumeration nothing wrote into.
Missing a concurrently written item is not a violation. Seeing one twice is,
and so is a short page that claims there is more to come.

## 8. Documented parameters

Every documented request parameter has its documented effect. `limit` bounds
the page size and is refused outside its documented range. `include_closed=true`
on GET /accounts includes closed accounts, and its absence excludes them.
`account_id` on GET /transfers restricts the collection to transfers naming
that account on either side. An `Idempotency-Key` header is honoured.
`settle_limit` and `advance_day` on POST /admin/tick do what they say.

It applies to every operation the document declares a parameter for. There is
one declared exception: an unknown or unsupported *query* parameter is ignored
rather than refused.

## 9. Reference integrity

An identifier one resource carries resolves to the resource it names, and the
two agree. A deposit's entry_id names a ledger entry on the deposit's own
account, for the deposit's own amount, whose deposit_id is that deposit. A
ledger entry's transfer_id, when it has one, names a transfer that exists, and
the entry's currency is the currency of the account it sits on. A transfer's
fee_account_id is the system fee account of the transfer's currency.

It applies wherever one resource names another. The declared exception is
absence, not disagreement: these reference fields are optional and nullable,
and a resource may legitimately omit them or return them as null. A reference
that is *present* must be right.

## 10. The daily limit

A source account may create at most 100 000 minor units of transfers per ledger
day. The boundary is inclusive: an amount bringing the day's total exactly to
the limit is accepted, and anything beyond it is refused. Usage counts transfer
amounts — not fees — and is reserved when the transfer is created, so
cancelling a transfer or having it fail at settlement does not give the room
back. Rolling the ledger day over starts the next day's count at zero.

It applies per source account, per ledger day, to POST /transfers. The ledger
day advances only via POST /admin/tick with `advance_day: true`; there is no
other clock. There are no declared exceptions.

## 11. Error shape and the status split (three rules)

Every 4xx and 5xx response body is `{"error":{"code","message","details"?}}`,
with code and message both strings, and a request the service refuses is always
reported with a 4xx status — never a 2xx carrying a failure inside it.

The plainer one: no operation answers 5xx at all.

And the split — when the service refuses, the status says why. A malformed,
unparseable, or wrongly typed request is 400. A well-formed request refused by
a business rule is 422. A request refused because of the state a resource is in
is 409. A closed account's tombstone is 410. A principal that may not reach the
resource is 403, and a missing credential is 401. An identifier that names
nothing is 404 — including after a resource-scoped path, and whichever
principal asks.

They apply to every operation. The only declared exception is that 401
responses additionally carry a WWW-Authenticate header, which is fine. The
split is a statement about *which* refusal you get for a given reason, not an
exhaustive list of the statuses the service may ever emit.

## 12. Balance agreement

An account's stored balance equals the sum of the amounts of all its ledger
entries. Entry amounts are signed and every money field is an integer in minor
units, so the two sides should agree exactly, with no rounding. Every effect
the service records for an account moves both together: an entry without the
balance, or a balance without the entry, is the violation.

It applies to every account, including the system fee accounts (acc_fee_usd,
acc_fee_eur), whose balances are the fees they have collected. The one declared
condition is on how you read it: the comparison is only meaningful between a
balance read and a *complete* entry enumeration with no write in between. A
number that moved because you moved it is not a counterexample.

## 13. Round-trip consistency and determinism

A resource returned by the request that created it is the same resource a later
read returns, field for field, as long as nothing has changed it in between.
And the service is deterministic: after `POST /admin/reset` with a given seed,
the same sequence of requests produces the same identifiers, the same
timestamps, and the same resources, every time.

It applies to every resource the service creates, and to any request sequence
replayed from a reset. The declared exception is optionality: a field the
document marks optional and nullable may be returned as null or omitted
entirely, and the two are the same answer — a resource is not inconsistent for
choosing one of them.
