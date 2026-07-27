# Authoring transcript — minibank ledger suite (proposal trial, phase 2)

## Scope statement

I did not read, list, search, or open any file outside
`/Users/jeremy/projects/playtest-s0-trials/proposal`. The only things I read
were `BRIEF.md`, `PROPOSAL-BRIEF.md`, `handout-manifest.json`, the four handout
files, `run.sh`, and my own phase-1 leftovers (`PROPOSALS.md`, the previous
`suite.mjs`, `run-out/stdout.log`, `run-out/script-report.json`). All API
traffic went through the injected `client`; I ran no `curl`, no ad-hoc scripts,
and made no web searches. I never attempted to read a credential value.

## Budget actually spent

| | |
|---|---|
| Phase-1 observation requests | 42 (two read-only executions) |
| Phase-2 executions | 3 |
| Phase-2 requests | 226 + 226 + 229 = 681 |
| Total requests against the dev instance | 723 of 1500 |
| Wall clock, phase 2 | ~20 minutes |
| Final run | 229 of 360 requests, 97 checks, 28/28 obligations covered, 0 defects, gate 4/4, exit 0 |

## What I took each adjudicated card to mean, and how I attacked it

The suite is one deterministic pass in two phases. **Phase A** resets to
`ledger-dev-seed` and builds a real world — twelve accounts across two
principals and two currencies, seven deposits, twenty-four transfers, seven
ticks, one closure — checking the rules that are only legible while state is
moving. **Phase B** then reads that settled world with no intervening write:
ownership reach, balance-versus-entries agreement, fee routing, and a quiescent
pagination walk. Splitting it this way is what makes card 2's "compare balance
and entries with no intervening write" clause literally true rather than
approximately true, and it means the pagination walk in card 8 is genuinely
quiescent.

**1. Fee schedule.** Read as an exact integer formula, so I implemented
`25 + round_half_away_from_zero(amount × 15 / 10000)` with integer arithmetic
(`r*2 >= 10000` on the remainder) rather than floats, and picked nine USD
amounts that sit on the interesting side of every boundary: `1` and `333`
(basis-point component rounds to zero, fee is the flat 25), `334` (first amount
that rounds up to 1), `1000` and `3000` (exact `.5`, the half-away-from-zero
case the card calls out), `1667` (`.5005`, just above), `3333` (`.9995`, just
below the next unit), `3334` (`.001`, just above), `10000` (exact 15). Both EUR
transfers additionally assert `fee_account_id == acc_fee_eur`. The card has
three clauses, not one, so the fee is checked in three places: the `fee` field
at creation, the persisted `fee` re-read from `GET /transfers` after
settlement (a build that computes the fee correctly at creation and stores
something else would pass the first and fail the second), and the settlement
entries — source debit `−(amount+fee)`, fee entry `+fee` on the currency's fee
account. Finally each fee account's whole balance is reconciled against the sum
of the fees of the settled transfers in that currency, which catches a fee that
is charged to the payer but never credited anywhere.

**2. Ledger arithmetic.** Two independent claims, checked independently.
Balance-versus-entries is checked per account for all thirteen readable
accounts including both system fee accounts, each as a `GET /accounts/{id}`
immediately followed by a complete `limit=100` enumeration. Conservation is
checked by grouping every entry collected across every account by
`transfer_id`: for each of the twenty settled transfers, exactly three entries
summing to zero, with the debit on the source, the credit on the destination,
and the fee on the fee account. The declared exceptions are checked as
exceptions rather than skipped: each deposit must write exactly one `deposit`
entry of `+amount` and nothing else, and the four canceled/failed transfers
must carry no entries at all.

**3. Ownership.** The card is a reach statement, so I tested reach in both
directions rather than only the refusals. The two customer tokens turn out to
be distinct principals (learned by creating an account under each and reading
`owner_principal` back — nothing in the handout says who they are). Refusals
cover read, entries, activate, close, spend-from, cancel, and deposit-into;
the "no representation of the resource" clause is checked by asserting the 403
body carries no `balance`, `owner_principal`, or `activated_at`. The
administrator-only clauses are checked on both sides: the admin *can* open an
account naming the other customer's `owner_principal` (and that customer, and
only that customer, can then read it — which is the only way to prove the
assignment actually took effect), a customer supplying `owner_principal` is
refused 403, and `/admin/tick` and `/admin/reset` are refused to customers. The
declared exceptions are checked positively: both fee accounts and their entries
are readable by both customers, a cross-principal transfer is readable by the
owners of *both* sides while the payer's account stays 403 to the payee, and an
unknown id answers 404 rather than 403 (existence before ownership).

**4. Lifecycle legality.** Every clause has its own check. Pending: a transfer
naming a pending account as destination *or* as source is refused 409, and a
deposit into one is refused 409. Closed: I close an account that has a real
deposit entry in its history so the soft-delete clause is testable, then assert
410 on the account read with a tombstone in `error.details`, 200 with the
surviving `+1000` deposit entry on its `/entries`, absence from `GET /accounts`
and presence with `include_closed=true`, and 410 for depositing into it,
sending from it, and receiving into it. The close-blocked clause is built
properly: I create a pending transfer *from* the account, get the 409, cancel
the transfer, and only then does the close succeed.

**5. Idempotency.** Four requests plus a before/after census of
`GET /transfers?account_id=…`, because "produces exactly one transfer" is a
claim about the collection, not about the response body. Same key + same body
returns 200 with the first transfer's id; same key + different amount is 409;
the census shows exactly one new transfer across all three; and the second
customer using the same key string gets its own transfer, which is the
per-principal scoping clause. The "exactly one set of ledger effects" clause is
checked later in phase B, after settlement, as "exactly three entries carry the
replayed transfer's id".

**6. Settlement.** Creation must leave the world untouched, so with three
transfers pending I assert the source balance is still exactly the deposited
`100000` and that no entry carries any of the three ids, then re-read the first
transfer after several intervening non-tick requests to show only a tick moves
it. Creation order and `settle_limit` are proved together: three pending, tick
with `settle_limit: 2`, and the assertion is on the *ordered list* —
`settled == [first, second]` — with `pending == 1` and the third still pending;
the next unbounded tick settles exactly the third. The re-check clause is built
so that both transfers pass the creation-time check and only one can pass the
settlement-time check: an account funded `60000` creates two transfers of
`50000` (each needs `50100`, and the balance is unmoved while they are pending),
so the first settles and the second must fail against the remaining `9900`,
with a non-empty `failure_reason` and no entries. "A canceled transfer is never
picked up by a later tick" is checked twice, once with a tick immediately after
the cancel and once with the big end-of-phase tick.

**7. Daily limit.** Boundary-first: `60000` accepted, `40001` refused (would be
`100001`), `40000` accepted (exactly `100000`), a further `1` refused — all
against an account funded `200000` so that a `422` can only be
`daily_limit_exceeded` and never `insufficient_funds`. The adjudicated note
that the allowance is measured on `amount` only is checked directly: those two
accepted transfers debit `100200` including fees, which would have tripped the
limit had the fee counted. The two non-release clauses use two different
accounts so they cannot mask each other — cancelling the `40000` and then being
refused a further `1` on one account, and the account whose second `50000`
*failed at settlement* still being refused a further `1` on the other. Per-
account scoping is shown by a different account of the same principal
transferring successfully while the first is capped, and the reset clause by
`advance_day: true` (asserting `day` increments) followed by the capped account
transferring again.

**8. Pagination completeness.** Run last, when nothing else writes. For each of
the three collections the card names I take a `limit=100` walk as the baseline
census and then re-walk at a small page size — 1 and 3 for accounts, 1 and 7 for
transfers, 1 and 5 for entries — asserting the same id set, no duplicates, and
termination on a null cursor. Page size 1 is the case my phase-1 pass found
broken, and the accounts collection still contains the two fee accounts that
share `created_at`, which is the tie that caused it. The walker is capped at
`baseline + 5` pages so a non-terminating cursor becomes a clear check failure
rather than a budget blowout.

## Check revisions

One, on the first phase-2 execution.

- **`system-fee-accounts-are-actable-by-nobody` → split into
  `system-fee-accounts-are-not-actable-by-customers` (check) and an advisory
  for the administrator probe.** The original check asserted 403 for a customer
  closing a fee account, a customer spending from one, *and the administrator
  spending from one*. The first two answered 403; the third answered **201**
  (HAR entry 225 of execution 1).

  Justification for revising, cited from the card itself: card 3's applicability
  sentence is "It applies to every account-scoped and transfer-scoped operation
  **for customer principals; the administrator is unrestricted**." The
  "actable by none" clause sits in that card's *Exceptions* line, and an
  exception carves out of a rule — it cannot extend the rule to a principal the
  applicability sentence has just exempted. The same reading is in the spec's
  `info.description` ("The administrator is unrestricted") and in
  `x-ledger-invariants#ownership`, whose `applies_to` is "…for principals whose
  role is customer. The administrator is unrestricted", and whose fee-account
  exception mentions readability only. So the *expectation* was wrong: my card,
  correctly scoped, says nothing about what the administrator may do to a fee
  account. The customer clauses stay as a gating check; the administrator
  observation is recorded as an advisory with its evidence, not gated away
  silently.

  I want to be clear that this is a revision of an over-reaching check and not
  of a genuine violation. Whether an administrator *should* be able to spend a
  fee account down is a real question — see below.

Nothing else needed revising: the remaining 96 checks passed on their first
execution.

## Rules this phase's traffic suggests I should have proposed

Per the brief these are recorded here and deliberately kept out of the suite.

1. **System fee accounts are immovable, including to the administrator.**
   `POST /transfers` with `source_account_id: acc_fee_usd` under the admin token
   answers **201** and creates a pending transfer that spends collected fees out
   of the system account. My card 3 gestured at this with "actable by none", but
   buried it in an exceptions line that the same card's applicability sentence
   overrides, so it is unenforceable as written. The rule I should have proposed
   is a separate card: *no principal, including the administrator, may transfer
   from, close, or deposit into a system fee account; the fee accounts change
   only as a side effect of transfer settlement.* That is a standalone
   statement an owner could approve or deny at sight, and it would not have
   collided with "the administrator is unrestricted".

2. **Refused requests must not consume the daily allowance.** I proposed that
   cancelling or failing does not *release* allowance, and that is what the card
   says. I never proposed the converse: that a request refused at creation
   (`422 daily_limit_exceeded`, `403`, `409`, `410`) must not *reserve* any
   allowance. The suite makes six such refused attempts and the accounting stays
   consistent, but nothing in my card set would have caught a build that
   silently charged allowance for a rejected transfer. It belongs in card 7 as a
   clause: "only a transfer the service actually created consumes allowance".

3. **Existence-before-ownership-before-state as a stated ordering.** I checked
   404-before-403 as evidence *for* card 3, but the ordering is really its own
   rule (`x-ledger-consistency.ownership` states all three levels), and it is
   the rule that makes every other refusal status meaningful — a build that
   answered 403 for unknown ids, or 409 before 403, would still satisfy every
   card I proposed. I should have proposed it as card 9.

4. **The `Idempotency-Replayed` header on a replay.** My card 5 covers the
   status and the returned transfer but not the header, which the spec declares
   with `const: "true"`. It is observed (`"true"`) and recorded as an advisory.
   Minor, but it is a clause I dropped when compressing the card.

## What I tried that did not work, and what surprised me

- **`HEAD` is unusable here.** My phase-1 pass found `HEAD /health` and
  `HEAD /openapi.json` both answer `405` with a `null` body, and `405` is not a
  documented status for either operation. So a `HEAD` probe would have failed
  the `documented_status` gate policy on traffic I chose to make, for no
  return. The suite uses `GET` exclusively. Same reasoning kept me off unrouted
  paths.
- **A pending account can never be funded**, which makes "a transfer *from* a
  pending account is refused 409" impossible to test cleanly: the account's
  balance is necessarily 0, so `409` and `422 insufficient_funds` are both
  defensible answers and only the service's internal check order decides. I
  kept the check (my card says 409, and the spec's consistency note says state
  is evaluated before the business rules) but I made the destination-side probe
  the primary one, since a well-funded source removes the ambiguity entirely.
  The service answers 409 for both.
- **There is no third customer principal**, so the clause of card 3 that a
  transfer is visible to the owners of *either* side cannot be paired with a
  proof that it is invisible to everyone else. I checked what is checkable — the
  payee sees the transfer but is still 403 on the payer's account — and note the
  gap here rather than pretending to cover it.
- **Ownership is fixed at creation** is not falsifiable through this surface:
  there is no update operation on an account at all, and `CreateAccountRequest`
  is `additionalProperties: false`. I did not author a check that would have
  passed vacuously.
- **The pagination anomaly is genuinely gone.** My phase-1 walk of `/accounts`
  at `limit=1` dropped `acc_fee_eur` — the two fee accounts share
  `created_at: 2026-01-01T00:00:00.000Z` and the sequence cursor could not
  separate them. The adjudication says it was confirmed and fixed. It is: with
  fourteen accounts including that tie, the `limit=1` walk now returns all
  fourteen exactly once, and so do the transfer and entry walks at sizes 1, 3, 5
  and 7. This is the one result I was most prepared to see fail.
- **Everything else passed first time**, which I did not expect from a suite
  this size. The honest reading is that the development instance is the correct
  build and the cards describe it accurately; the suite's value is what it would
  say about a build that is *not* this one, which is why I spent the extra
  execution turning the creation-order check from "of two pending, the older
  one settled" into "of three pending, the ordered list is exactly the two
  oldest".

## Robustness notes

A misbehaving service should produce failing checks, never a crash. Every
request goes through one helper that catches and returns a synthetic record
rather than throwing; every field access is guarded, so a missing field, a
malformed body, or a `transportError` lands in the check's `observed` string
instead of an exception. Each of the eleven sections runs inside its own
guard: if a section throws, one failing check is emitted per obligation that
section was responsible for, so a partial collapse still leaves every
obligation accounted for and visibly failing rather than silently unaccounted.
Cursor walks are page-capped and detect a non-advancing cursor. Prerequisite
failures (an account that could not be created) degrade into failing checks
that cite the request that failed, never into `check.defect` — a defect would
be a claim about my suite, and an API that cannot open an account is a claim
about the API.

The three probes that would be destructive if the API answered them wrongly —
a customer closing a fee account, a customer calling `/admin/reset`, and the
administrator spending a fee account down — all run in the final section, after
the verification and pagination passes, so that a success cannot contaminate
any earlier evidence. That ordering is what let the administrator result be
recorded cleanly instead of poisoning the ledger checks.

## Files

- `suite.mjs` — entry point; wires the harness and runs the two phases.
- `lib.mjs` — request helper, evidence builder, cursor walker, section guard.
- `phase-a.mjs` — state construction plus settlement, lifecycle, idempotency,
  daily-limit and fee-creation checks.
- `phase-b.mjs` — ownership, ledger arithmetic and fee routing, pagination, and
  the final hostile probes.
