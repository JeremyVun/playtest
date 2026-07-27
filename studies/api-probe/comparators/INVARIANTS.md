# Invariant statements — comparator handout

The equal-knowledge handout for the P1 comparator arms (PREREGISTRATION.md).
These are the six invariant statements, word-for-word as the probe's stories
state them (rule + applicability + declared exceptions). The probe's
exploration tactics are deliberately NOT included: tactics are the instrument
under test, the invariant knowledge is what every arm gets. Give this file,
plus the fixture's served OpenAPI document, to a comparator arm — nothing
else.

## 1. Conservation

For a settled transfer, the ledger entries carrying its transfer id — the
source debit, the destination credit, and the fee credit — sum to exactly
zero.

It applies to transfers whose status is "settled". Deposits are a declared
exception: external funding has no counter-entry and is excluded. A transfer
that ends "failed", or that is canceled before it settles, writes no entries
at all, so it is not a counterexample either.

## 2. Idempotency

Two POST /transfers requests carrying the same Idempotency-Key and the same
request body produce exactly one transfer and exactly one set of ledger
effects. The second request returns the first transfer.

It applies to POST /transfers with an Idempotency-Key header, per
authenticated principal. There is one declared exception: the same key with a
*different* body is a conflict and creates nothing — that is correct
behaviour, not a violation.

## 3. Lifecycle legality

Only active accounts transact. A transfer naming an account that has never
been activated is rejected. A transfer naming a closed account is rejected.
An account with a pending transfer against it cannot be closed. A transfer
that has already settled — or failed — cannot be canceled.

It applies to POST /transfers, POST /accounts/{accountId}/close, and
POST /transfers/{transferId}/cancel. There are no declared exceptions. Note
that closure is a soft delete, so a closed account still answers with a
tombstone and still serves its entry history: that is documented behaviour
and is not a counterexample.

## 4. Pagination identity

Within one cursor enumeration of GET /accounts/{accountId}/entries, no ledger
entry id is ever returned twice, and following next_cursor terminates.

It applies to an enumeration that starts *without* a cursor and then follows
the next_cursor values the service hands back. The exceptions are declared
and generous: entries written after an enumeration begins may be missed
entirely, and no "no skips" or exact-total guarantee is offered. Missing an
entry is not a violation. Seeing one twice is.

## 5. Error shape (two rules)

Every 4xx and 5xx response body is {"error":{"code","message","details"?}},
with code and message both strings, and a request the service refuses is
always reported with a 4xx status — never a 2xx carrying a failure inside it.

And, the plainer one: no operation answers 5xx at all.

They apply to every operation. The only declared exception is that 401
responses additionally carry a WWW-Authenticate header, which is fine.

## 6. Balance agreement

An account's stored balance equals the sum of the amounts of all its ledger
entries. Entry amounts are signed — debits negative, credits positive — and
every money field is an integer in minor units, so the two sides should agree
exactly, with no rounding.

It applies to every account, including the system fee accounts (acc_fee_usd,
acc_fee_eur). The one declared condition is on how you read it: the
comparison is only meaningful between a balance read and a *complete* entry
enumeration with no write in between. A number that moved because you moved
it is not a counterexample.
