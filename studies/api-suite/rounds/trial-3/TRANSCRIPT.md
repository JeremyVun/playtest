# Authoring transcript — minibank ledger script suite

## Scope statement

I read only files inside `/Users/jeremy/projects/playtest-s0-trials/trial-3`:
`BRIEF.md`, `handout/CLIENT.md`, `handout/INVARIANTS.md`,
`handout/obligations.json`, `handout/openapi.json`, `run.sh`, and my own
`run-out/` artifacts. **I did not read, list, search, or open any file outside
this directory** — in particular not the repository `run.sh` execs into, not
the service's source or tests, and not any other trial. I did not search the
web. Every request to the service was made by `suite.mjs` through the injected
`client`; I ran no `curl`, no ad-hoc fetch script, and nothing else that could
reach the network.

## Result

| | |
|---|---|
| Executions used | **3** of 12 |
| Requests, final execution | **217** of the 360 wire budget |
| Requests, total while authoring | **640** of 1 500 (211 + 212 + 217) |
| Wall clock | **~20 minutes** of the 3 hours |
| Checks | 126, all exercised, all citing evidence |
| Obligations | 33 of 33 covered; 0 skipped, 0 unsupported, 0 unaccounted |
| Defects | 0 |
| Gate | pass — 4 of 4 policies applicable and holding |
| Verdict | **exit 1: sound, with one genuine finding left failing** |

## What I understood each rule to mean, and how I went after it

The suite is one deterministic sequence against a world built from
`POST /admin/reset {"seed":"ledger-dev-seed"}`. It is deliberately shaped so
that most claims are settled by *reaching state* — funding, transferring,
ticking, closing, rolling the day — and audited at the end against a quiescent
ledger, rather than by inspecting the shape of one response.

**1 Conservation.** Every settled transfer must write exactly three rows —
source debit `-(amount+fee)`, destination credit `+amount`, fee credit `+fee`
on the currency's system account — summing to zero. I audit this over *every*
settled transfer in the final sweep (18 transfers, 14 settled), not a sample,
by grouping all ledger entries in the service by `transfer_id`. The declared
exceptions are tested as their own claim: canceled and failed transfers must
carry zero rows, which is checked over all four of them.

**2 The fee schedule.** `25 + round_half_up(amount * 15 / 10000)`. The rounding
mode is the whole content of this rule, so I picked amounts that sit on the
boundary: 1 and 333 round down (`.0015`, `.4995`), 334 rounds up (`.501`), and
**1000 and 3000 are the exact `.5` cases** — half *away from zero* makes them 27
and 30, not 26 and 29. A truncating or banker's-rounding implementation fails
on 1000 and 3000 specifically. I then check the schedule again over every
transfer in the collection, and check that the two system fee accounts hold
exactly the sum of the fees of the settled transfers in their currency —
which is what proves the fee was *charged*, not merely declared.

**3 Idempotency.** Beyond "same key, same body returns the first transfer with
the replay header and creates nothing", the statement makes three durability
claims that only a sequence can test: the key is not released by *cancelling*,
by *settling*, or by the *day rolling over*. I replay the key after each of
those three events and require the original transfer back each time. The
declared exception — same key, different body — is checked as a 409
`idempotency_key_conflict` **plus** a follow-up listing proving no transfer of
the second amount exists, because "returned the earlier transfer instead" and
"created a second transfer" are both failures the status alone would not
distinguish. Per-principal scoping is checked by having customer B reuse
customer A's key for a different transfer and expecting a new one.

**4 Lifecycle legality.** Twenty-one checks. A never-activated account is
refused on both sides of a transfer and as a deposit target; a closed account is
refused on both sides, as a deposit target, as an activation target and as a
close target; closure is terminal; a closed account still answers with a
tombstone *and* still serves its entry history. The "pending transfer blocks
closure" claim is tested on both sides separately — a sending account and, using
an account the administrator opened for customer B, a purely *receiving*
account — and then I cancel the blocker and show the 409 lifts.

**5 Settlement.** The interesting half is the settlement-time re-check. I fund
an account with 60 000 and create a 50 000 and a 40 000 transfer: each clears the
creation-time balance check on its own, together they exceed the balance, and
both stay inside the daily limit. The tick must settle the first and *fail* the
second, and the failed one must write no entries. I also check the settled list
equals the pending set in creation order, that a second tick settles nothing
again (same transfer body, same entry count), and that a tick which also rolls
the day still settles.

**6 Ownership.** The brief is right that which principal is which is only
learnable by acting, so the suite learns it: it opens an account under each
customer reference, reads `owner_principal` off each, and asserts the two
differ before anything downstream depends on it. Then every reach across the
boundary is exercised — read, entries, fund, activate, close, spend from,
cancel — and the cross-principal read is additionally checked for *leakage*:
the 403 body must not contain the owner name, the owning principal, or the
balance. The three declared exceptions are tested positively: the system fee
accounts are readable by both customers (and *not* actable — a customer deposit
into one is refused and moves nothing), paying an account you cannot read is the
ordinary case, and a transfer is readable from both sides while the payer's
account stays 403. I also check the *collection*: a customer's `GET /accounts`
must contain only its own accounts and system accounts, since a listing that
leaked another principal's account would be the same disclosure by another
route. The administrator's authority is probed at the very start, before any
state exists, so that a wrongly-granted `POST /admin/reset` could not destroy
the run it was discovered in.

**7 Pagination.** Both halves, on three collections, on a ledger nothing is
writing to. This is where the finding is; see below.

**8 Documented parameters.** `limit` at 1, at its documented maximum 100, and
refused at 0 and 101; a cursor the service never issued; `include_closed` both
ways compared like-for-like; `account_id` on `GET /transfers` checked against
the unfiltered collection rather than against my own bookkeeping;
`settle_limit` at 0, at 2 and refused at −1; `advance_day`; and the declared
exception that an unknown *query* parameter is ignored and changes nothing.

**9 Reference integrity.** Checked over the whole final sweep rather than one
resource: every deposit's `entry_id` resolves to an entry on the deposit's own
account for the deposit's own amount whose `deposit_id` points back; every
entry's `transfer_id`, when present, names a transfer that exists; every
entry's currency matches the currency of the account it sits on; every
transfer's `fee_account_id` is the fee account of its currency. Absence is the
declared exception, so only present references are checked.

**10 The daily limit.** Three separate claims. Inclusive boundary: a first
transfer of exactly 100 000 is accepted. Reservation at creation: I cancel that
transfer and a further 1 is still refused. And the harder one — *failing*
does not return the room either — using the settlement-failure account, where
50 000 settled plus 40 000 failed plus 10 000 lands the day's usage on exactly
100 000 and one more minor unit is refused. I deposit 200 000 into that account
first, precisely so that "insufficient funds" cannot be an alternative
explanation for the refusal. Then the day rolls and the account that was
refused at the limit transfers again.

**11 Error shape and the status split.** Thirty checks. The envelope and the
"no 5xx" and "no 2xx carrying a failure" claims are evaluated in aggregate over
*every* response the execution recorded, not over a sample, and cite the
offenders when they fail. The split is exercised case by case: 400 for
unparseable, missing-required and wrongly-typed input; 422 for `same_account`,
`currency_mismatch`, `insufficient_funds`, `daily_limit_exceeded`; 409 for
state; 410 for the tombstone; 403 for the wrong principal; 401 (with
`WWW-Authenticate`, checked on every 401 recorded) for no credential; and 404
for an unknown identifier across ten endpoints, including after a
resource-scoped path and for both the administrator and a customer.

**12 Balance agreement.** Every account in the service, fee accounts and closed
accounts included, is audited: balances are read from one `include_closed=true`
listing and then each account's entries are fully enumerated, with no write
anywhere in between, which is the condition the rule states. Closed accounts
answer 410 on a direct read, so their balances come from that listing.

**13 Round-trip and determinism.** Account, deposit and transfer are each read
back and compared field for field, treating an absent field and a null field as
the same answer (the declared exception). Determinism is tested by replaying a
six-request sequence from two identical resets and requiring every id, every
timestamp and every field to match.

## Deliberate structure choices

- **The operation sweep runs first.** Immediately after the main reset, ten
  unknown-identifier probes touch every remaining spec operation. This makes
  all 16 operation obligations covered by traffic before any complex logic can
  fail, and the probes are not waste — they *are* the "an identifier that names
  nothing is 404" checks.
- **Nothing throws.** Every request goes through a wrapper that never rejects:
  a transport failure, a refused guard, or an exhausted budget returns a
  synthetic record instead, and the dependent check fails with a legible
  message. The whole sequence sits inside one `try`, and a tail emits a failing
  check for any rule obligation the sequence never reached. A misbehaving
  service therefore produces findings, never a script defect — the run stays
  interpretable either way.
- **Counts are asserted, not assumed.** 13 accounts, 18 transfers, 10 pending
  at the big tick, 2 closed. Against a build that silently loses or invents a
  resource these fail loudly.
- **The audit is one sweep.** Conservation, balance agreement, reference
  integrity and the fee schedule all read the same quiescent end-state, which
  is both cheap and the only reading under which balance agreement is
  meaningful.

## The finding

**`accounts-enumeration-is-complete` — a cursor enumeration of `GET /accounts`
never returns the oldest account.**

> `limit=2: 12 of 13, missing ["acc_fee_eur"] across 7 pages (last page empty,
> next_cursor null). limit=5: 10 of 11, missing ["acc_fee_eur"] across 3 pages`
>
> Evidence: HAR entries 168–179.

Mechanism, read off the HAR: the cursor is base64 `{"s":N}` and a page carries
items strictly older than position `N`. The final page of the `limit=2`
enumeration is served for cursor `{"s":0}` and comes back **empty** with
`next_cursor: null` — position 0 is unreachable, so the account sitting there
is dropped. The same account is missing at `limit=5`, so it is not a page-size
artefact, and the single-page read at `limit=100` (HAR 168) *does* list it, so
it is not a filter or a visibility rule.

Rule 7 says every item that satisfied the filter when the enumeration began is
returned by the time it ends, provided nothing is written to the collection
in flight. Nothing was: this runs at the end, on a quiescent ledger, read-only.
The declared exception covers items written *after* the enumeration begins;
`acc_fee_eur` is created by the reset, long before. So this is a violation of
the completeness half.

Two things it is *not*, which I checked so the report would not overstate it:
the page discipline half is intact (`accounts-enumeration-is-disciplined`
passes — no duplicate, no oversized page, no short page claiming more to come,
and it terminates), and the cursor scheme is not broken in general
(`earliest-entries-survive-a-cursor-enumeration` and the transfer and entry
enumerations all pass at small page sizes). The defect is specific to the
account collection, whose first item sits at position 0.

## Check revisions, with the fragment that justifies each

Five checks failed on execution 1. Four were my expectation being wrong; one
was my arithmetic. None were revised to make a genuine violation go away.

1. **`missing-required-field-is-400`** — observed `422 unsupported_currency`.
   I had omitted `currency`, and the service reports an absent enum value as an
   unsupported one. That conflates two questions. *Revision:* the check now
   omits `owner` instead — a plain required string with no enum to hide behind
   — and still demands 400. Currency validation became its own check requiring
   only a refusal (400 or 422), because the split is genuinely open there:
   `#/components/responses/BadRequest` enumerates the 400 codes as
   "invalid_request, invalid_json, invalid_cursor, or invalid_limit", which does
   not include `unsupported_currency`, while `POST /accounts` declares 422
   ("A business rule refuses the request") and has essentially no other business
   rule to declare it for. The status actually chosen is recorded as an
   advisory so a reviewer can see it.

2 and 3. **`deposit-/transfer-wrongly-typed-amount-is-400`** — observed
   `422 invalid_amount` on both. *Revision:* both now accept 400, or 422 whose
   code is `invalid_amount`. The justifying fragment is the `422` response
   description on `POST /transfers` in `handout/openapi.json`: *"The transfer is
   refused by a business rule: invalid_amount, same_account, currency_mismatch,
   insufficient_funds, or daily_limit_exceeded."* The document itself allocates
   `invalid_amount` to 422, so amount validation is a documented business rule
   rather than only a type check. The "wrongly typed request is 400" clause of
   rule 11 is still tested strictly, on a non-amount field (`owner: 12345`),
   where it passes — so the revision narrows the claim rather than dropping it.

4. **`accounts-enumeration-…` expected 13 accounts, saw 14.** My arithmetic:
   a probe that posted an undeclared body member to `POST /accounts` was
   *accepted*, creating a fourteenth account. *Revision:* I moved that probe to
   `POST /admin/tick` on a quiescent ledger, where whichever way it goes it
   cannot change the resource counts every other check depends on. It stays an
   advisory, not a check — `CreateAccountRequest` and `TickRequest` both declare
   `additionalProperties: false`, and rule 8's leniency exception is scoped to
   unknown *query* parameters, but rule 8 is a statement about the parameters it
   names and makes no claim about undeclared body members. I did not want a
   contestable reading counted as a finding, so it is recorded and visible
   instead. **This is a real observation a reviewer should see: the service
   accepts and ignores undeclared request-body members.**

5. **`balance-equals-the-sum-of-its-entries`** — "all 14 accounts agree" yet
   failing. Same arithmetic: only the hardcoded `13` was wrong, the balances
   themselves all agreed. Fixed by removing the stray account.

On execution 2 the pagination failure resolved into two failing checks, one of
which — `include-closed-filters-both-ways` — was failing for the *other*
check's reason. My filter check compared a cursor enumeration against a
single-page read, so the dropped account made the filter look broken.
*Revision:* the filter is now measured like-for-like between two single-page
reads, which isolates it from cursor behaviour, and it passes. The completeness
failure is reported once, by the check that owns it. This is a revision of
attribution, not of the finding.

## What I tried that did not work, and what surprised me

- **Provoking `insufficient_funds` on a well-funded account is impossible**
  within the daily limit: the limit (100 000) is below the balance, so any
  amount large enough to exceed the funds is refused for the limit first. I had
  to move that probe to a thinly funded EUR account so the refusal has exactly
  one available explanation. The same trap sits in the "failing does not return
  daily room" check, which is why it deposits 200 000 before asking for one more
  minor unit — otherwise a `daily_limit_exceeded` and an `insufficient_funds`
  would be indistinguishable and the check would prove nothing.
- **Arranging a settlement-time failure is tighter than it looks.** It needs two
  transfers that each pass the creation-time balance check, together exceed the
  balance, and together stay under the daily limit. 60 000 funded, 50 000 + 40 000
  is the smallest arrangement I found that satisfies all three.
- **I nearly asserted the wrong status in three places.** Deposit of 0, deposit
  of a negative amount, and an out-of-enum currency are all cases where 400 and
  422 are both defensible under rule 11. All three now assert only that the
  request is *refused*, with the chosen status recorded as an advisory. That is
  the honest boundary: a build that silently accepts a zero or negative amount
  still fails; a build that picks the other defensible status does not generate
  a false finding.
- **Surprising: `settle_limit` really does settle oldest-first**, and the
  ordering is observable, so the creation-order claim in rule 5 is checkable
  without a full tick. Also surprising: the service is genuinely deterministic
  down to timestamps — the two replayed sequences matched field for field on
  the first attempt, which made the rest of the suite safe to write around
  fixed expected counts.
- **Surprising: closing an account with a non-zero balance is allowed.** No rule
  forbids it, so it is not a finding, but it means a closed account keeps money
  the ledger still counts — which the balance-agreement sweep confirms it does
  consistently.
- **Cheap and worth it:** putting the ten unknown-identifier 404 probes first.
  They cover every operation obligation up front *and* discharge one of rule
  11's clauses, so the soundness floor costs ten requests and no waste.

## Cost

217 requests for a full pass, against a 360 ceiling and the ~270–300 the client
documentation estimates — the audit-once-at-the-end structure is most of the
saving. Three executions, ~20 minutes.
