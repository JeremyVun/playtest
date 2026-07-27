# Authoring record — minibank ledger script suite

**Arm:** statements-trial · **Target:** `http://127.0.0.1:4301` · **Date:** 2026-07-26

**Budgets used:** 6 executions of 12 · 1 184 requests of 1 500 · ~21 minutes of 3 hours
(15:16 → 15:37 AEST). Final execution: **214 requests of 360**, 0.4 s, exit 1 (sound,
one failing check), 85 checks, 33/33 obligations covered, 0 defects, 0 guard refusals,
0 leak findings, gate 4/4.

**Did I read anything outside my scratch directory?** No. I read only
`BRIEF.md`, `handout/{CLIENT.md,INVARIANTS.md,obligations.json,openapi.json}`,
`handout-manifest.json`, `run.sh`, and my own `run-out/` artifacts. I did not open,
list, search, or otherwise inspect the repository `run.sh` points into
(`/Users/jeremy/projects/playtest/studies/...`), any other trial directory, or
anything else on the machine. I made no network request outside the injected
`client`, and no web search. I never attempted to read a credential value.

---

## 1. How I read the rules

`handout/obligations.json` carries **no `approved_skip_reasons` on any of the 33
obligations**, so nothing could be skipped or declared unsupported: 13 rule
obligations each needed at least one exercised check, 16 operation obligations
needed traffic, and 4 policy obligations needed to be applicable. That fixed the
shape of the suite before I wrote a line — every endpoint gets exercised, and
every statement gets a check that reaches real state rather than inspecting a
response shape.

What each statement had to mean, operationally:

| Statement | What I decided it obliges me to demonstrate |
|---|---|
| 1 Conservation | For each **settled** transfer: exactly three rows carrying its id (debit on the source for `−(amount+fee)`, credit on the destination for `amount`, fee on the currency's system account for `fee`), summing to 0. Plus the two negative halves — a **failed** transfer and a **canceled** transfer must write nothing. |
| 2 Fee schedule | `25 + round_half_up(amount·15/10000)`, computed in exact integer arithmetic (`25 + floor((30a+10000)/20000)`), probed at the rounding boundaries and in both currencies; *and* that the declared fee is the settled fee and the fee row's amount. |
| 3 Idempotency | Replay returns the first transfer with 200 + `Idempotency-Replayed`; a different body under the same key is 409 and creates nothing; the key is **per principal**; the key record survives cancellation, settlement and a day rollover. |
| 4 Lifecycle | Refusals on both sides of a transfer for pending and closed accounts; deposits into non-active accounts; close blocked by a pending transfer whether **sending or receiving**; cancel blocked on settled/failed/canceled; closure terminal (and the soft-delete history still served, which is *not* a counterexample). |
| 5 Settlement | A no-limit tick leaves `pending: 0`, works in **creation order**, and re-checks funds — I deliberately over-commit a 10 000 balance with 9 000 then 1 000 so the second one *must* fail. A second tick settles nothing again. `settle_limit` is the declared exception. |
| 6 Ownership | Nine distinct reaches into another principal's account, all 403, **with no state in the refusal body**; collection scoping for both `/accounts` and `/transfers`; the three declared exceptions exercised positively (fee accounts readable by all, destination need not be yours, a transfer is readable by both sides); admin-only `owner_principal`; admin routes closed to customers. |
| 7 Pagination | Real multi-page walks at `limit=3`/`limit=4` over all three collections, checking no duplicate id, termination, no overfull page, no short page claiming more, and completeness against a single-page baseline taken with nothing writing in between. |
| 8 Documented parameters | `limit` bounds and refusals, `cursor` refusal, `include_closed` both ways, `account_id` filter sound **and** complete, `Idempotency-Key` honoured, `settle_limit`/`advance_day`, and the declared exception that an unknown *query* parameter is ignored. |
| 9 Reference integrity | Deposit `entry_id` → the entry, agreeing on account/amount/deposit_id/currency; every entry `transfer_id` resolves; entry currency matches its account; `fee_account_id` is the currency's system account. Absence is tolerated, disagreement is not. |
| 10 Daily limit | The inclusive boundary hit exactly (60000 + 39999 + 1 = 100000 accepted, the next unit refused), reservation not released by cancellation **or by a settlement failure**, usage counting amounts and not fees, and the day rollover zeroing it. |
| 11 Error shape / status split | A sweep over **every** 4xx/5xx exchange the run made, asserting the exact envelope; plus a single operation (`POST /deposits`) refused for five different reasons, each of which must produce its own status. |
| 12 Balance agreement | For **every** account in the world, including both system fee accounts: stored balance vs. a complete entry enumeration, in one quiescent window with no write in between. |
| 13 Round-trip / determinism | Three resources read back field-for-field (treating an omitted field and `null` as the same answer), and a second `POST /admin/reset` with the same seed followed by a byte-identical replay of the opening six-request prelude. |

## 2. Sequences I chose, and why

**Discovery first.** My first execution was a throwaway exploration suite (125
requests, zero checks, deliberately unsound) that logged ~90 probes to
`run-out/stdout.log`. I needed things the handout genuinely does not say: which
principal each secret reference is (`customer_a` / `customer_b`, learned by
creating an account under each and reading `owner_principal` back), what the
seeded world holds (exactly `acc_fee_usd` and `acc_fee_eur`, day 0), and which
status each refusal actually uses. Spending one execution on looking was the
cheapest way to avoid writing checks whose *expectations* were guesses.

**One long-lived world, ordered so state is legible.** The suite resets once,
runs a six-request determinism prelude, then builds fourteen accounts across
three principals — funded and unfunded, pending, active and closed, USD and
EUR, one opened by the administrator on `customer_b`'s behalf, one never
activated for the whole run, one dedicated to the daily limit and one to the
settlement funds re-check. Everything after that reaches into that world rather
than standing up a fresh fixture per check.

**Ordering constraints I had to respect:**

- The settlement phase runs a full tick *first*, so that the later
  `settle_limit: 1` probe has a known two-transfer queue and I can assert
  precisely which one it takes (the older). Without that, `settle_limit: 1`
  would have settled whichever transfer happened to be oldest in the world.
- The ledger snapshot (nine entry enumerations) and the transfer listing are
  taken in one window immediately after that tick, so conservation, the
  declared-vs-settled fee, and reference integrity all read a consistent world.
- Balance agreement, pagination and round-trip run in a strictly read-only tail:
  nothing writes between a balance read and its entry enumeration, and nothing
  writes during an enumeration, which is the condition statements 7 and 12
  attach to their completeness halves.
- The privileged-route probes (`/admin/*` with no credential and with a
  customer's) are the **last writes before the final reset**, on purpose: if a
  build were broken enough to let a customer call `POST /admin/reset {"seed":
  "hostile"}`, running that probe early would silently destroy the world under
  every later check and I would have reported a suite artefact as an API
  finding.
- The determinism replay is dead last, because it resets.

**Boundaries I picked deliberately.** Fee amounts 333/334 straddle the half-cent
point; 1 000 and 3 000 land *exactly* on `.5` (1.5 and 4.5 basis-point cents), so
they are the only amounts that can distinguish half-away-from-zero from
half-to-even or from truncation. 66 667 EUR checks the same schedule at scale in
the other currency. The daily limit is walked to exactly 100 000 and then pushed
one minor unit. The settlement failure is engineered so the shortfall is 66
minor units — small enough that only a real re-check catches it.

**Evidence.** Every check cites the exchanges that prove it, including the ones
that *built* the state: the conservation checks cite the transfer listing and
all nine entry enumerations; the funds-re-check cites the original deposit, both
creations, the mid-point balance and the tick.

## 3. Check revisions, and what justified them

**Revision 1 — `idem-key-survives-settlement-and-the-day-rollover`.**
First scored run: FAIL. Evidence (`har.json` entry 136) showed
`GET /transfers?account_id=<A's account>` returning **two** transfers carrying
the key `s0-idem-key`: A's own (canceled) and B's (settled, `bUSD → aUSD`). My
check counted every transfer carrying the key on that account and demanded
exactly one.

The expectation was wrong, not the API. INVARIANTS §3 applicability:

> "It applies to POST /transfers with an Idempotency-Key header, **per
> authenticated principal: two principals may use the same key for different
> transfers without violating anything**."

B's transfer is that declared allowance, and it appears on A's `account_id`
filter only because A is its *destination*. Revised the counter to
`t.idempotency_key === KEY && t.source_account_id === <A's account>`, i.e. to
count per principal, which is the scope the statement actually claims. Applied
the same fix to `idem-one-key-one-transfer`, which had passed only because it
ran before B's request. The check passes now — and it still fails if the service
ever creates a second transfer for the same key under the same principal, which
is the thing the rule prohibits.

**Revision 2 — `status-403-and-409-and-410-are-used-for-their-own-reasons`.**
Not a failure, a weakness I caught reading my own report: the check's `pass`
expression only re-asserted the 422 cases, so it could not fail for the reason
its title claimed. Replaced with `status-split-one-operation-five-reasons`,
which refuses the **same** operation (`POST /deposits`) five different ways —
unknown id, another principal's account, a pending account, a closed account,
an unparseable body — and requires 404 / 403 / 409 / 410 / 400 respectively.
That is the split as INVARIANTS §11 states it: a claim about *which* refusal you
get for a given reason. It passes.

**Three additions** after the first scored run, for detection power rather than
coverage: account-collection scoping under §6 (a customer's `GET /accounts` must
show only its own accounts plus the two public fee accounts), a no-overdrawn-
account assertion under §5 (a negative balance would prove funds were never
re-checked), and `Idempotency-Key` bound explicitly to §8.

No check was ever revised to make a failure go away.

## 4. Genuine finding I kept, failing

### `status-400-for-a-wrongly-typed-field` — the 400/422 split does not hold for wrongly typed fields

```
POST /transfers  {"source_account_id":"acc_…","destination_account_id":"acc_…","amount":"ten"}
  -> 422 {"error":{"code":"invalid_amount","message":"amount must be a positive integer in minor units","details":{"field":"amount"}}}
```

`amount` is documented as `Money`, `type: integer` (`CreateTransferRequest` →
`#/components/schemas/Money`). A JSON string in that field is not a well-formed
request refused by a business rule; it is a wrongly typed request. INVARIANTS
§11 is explicit:

> "A **malformed, unparseable, or wrongly typed request is 400**. A well-formed
> request refused by a business rule is 422."

The service has the 400 path and uses it elsewhere — the very next probe in the
same phase, an unparseable body, is `400 invalid_json`, and `limit=abc` is
`400 invalid_limit`, and `settle_limit: -1` is `400 invalid_request`. So this is
not "the service never emits 400"; it is specifically a type error on a body
field landing on the business-rule status. A client that routes on the status
class — retry-never on 400, surface-to-user on 422 — is told the wrong thing.

I considered and rejected the counter-reading that `invalid_amount` is a
business rule: the same code and message answer `amount: 0` and `amount: -100`,
which *are* well-formed integers refused by a rule, so the service is collapsing
two distinct reasons onto one status. Kept failing, with the passing
unparseable-body probe cited alongside it as the contrast.

**Recorded but not judged (advisories, 3):** three further request-conformance
observations I decided the statements do not clearly reach, so I did not stake a
check on them —

- `amount: 10.5` → 422 (a non-integer number; same collapse as above, but the
  word "wrongly typed" is arguably stretched by a numeric literal);
- `POST /accounts {"owner":"x"}` with the required `currency` absent → 422
  `unsupported_currency` (I read a missing required property as "malformed", but
  the service's answer is a coherent business message and §11's three words do
  not name omission);
- `POST /accounts {…,"not_a_field":1}` → **201**, despite
  `additionalProperties: false` on `CreateAccountRequest`. §8's declared
  tolerance for unknown input is scoped to *query* parameters, which implies
  body strictness, but §8 is about parameters having their documented effect,
  not about rejecting undocumented ones. A reviewer with the source may want to
  look at this one.

Nothing else failed. Both the HAR column (all four gate policies applicable and
passing — `no_server_error`, `documented_status`, `response_schema`,
`content_type`) and the other 84 checks are green: conservation balances to zero
across every settled transfer in both currencies, the fee schedule is exact at
every boundary I could construct, settlement order and the funds re-check behave
as stated, the daily limit's inclusive boundary and its non-release on
cancellation and on failure all hold, every account's balance equals its entry
sum, and the seeded replay is identical down to identifiers and timestamps.

## 5. What I tried that did not work, and what surprised me

- **`insufficient_funds` is hard to provoke naively.** My first attempt asked for
  999 999 999 from an account holding 500 000 and got `daily_limit_exceeded`, not
  `insufficient_funds` — the daily limit is evaluated before the balance. The
  real probe has to stay under 100 000 while exceeding the balance, so the suite
  spends 5 000 from an account holding 200. Useful ordering fact, and it is also
  what makes the "usage survives a failure" probe discriminating: retained usage
  gives `daily_limit_exceeded`, released usage would have given
  `insufficient_funds`.
- **Transfer creation does not reserve funds, but it does reserve daily usage.**
  Those two asymmetries are what make statements 5 and 10 testable at all: you
  can over-commit a balance (so a transfer can fail at settlement) but you cannot
  over-commit a day (so cancelling gives nothing back). I only trusted this after
  seeing it in the exploration log.
- **The transfer collection is visible across the ownership boundary in a way
  that is legitimate but easy to misread.** `GET /transfers?account_id=<someone
  else's account>` answers 200 rather than 403 — correctly, because §6 makes a
  transfer readable by *either* side and the filter returns only rows the caller
  is a party to. I nearly wrote a check demanding 403 there. Instead the check
  now creates a transfer between two of A's *own* accounts and asserts B can see
  it neither plainly nor through that filter, which is the leak that would
  actually matter.
- **A customer may pay into the system fee account.** `POST /transfers` with
  `destination_account_id: acc_fee_usd` is accepted and settles, crediting the
  fee account. §6 says fee accounts are "actable by none", but it also declares
  that a transfer's destination need not belong to the caller. I judged the
  destination exception to cover it and did not write a check; the fee account is
  instead checked for the thing §6 unambiguously claims — readable by every
  principal, and a customer deposit into it refused with the balance unmoved.
- **Cursors are transparent** (`eyJzIjoxOX0` decodes to `{"s":19}`), which is
  worth noting but is not a stated invariant, so it is not a check.
- **Determinism is total.** Two resets on the same seed produce identical
  identifiers *and* identical timestamps — timestamps are a mutation counter over
  a fixed epoch — so the replay comparison could be strict field-for-field with
  no allowances. Two consecutive scored executions produced a byte-identical
  check outcome vector.

## 6. Robustness notes

The suite is written so that a misbehaving build produces failing checks, not a
crash: every field access is optional-chained, every list is guarded through an
`arr()` helper, every cursor walk is bounded at 25 pages and reports
non-termination as a page-discipline problem rather than looping, a non-2xx page
inside an enumeration is recorded and breaks the walk, and each phase is wrapped
so that an unexpected throw becomes one clearly-named failing check bound to that
phase's obligation instead of an unhandled rejection. Evidence refs are filtered
to integers actually returned by the client, so a citation can never be
unresolvable. Every request goes through one `client.request` wrapper, which is
also what makes the end-of-run envelope sweep possible: it inspects **all** 4xx
responses the run happened to provoke, not a hand-picked few, so a build that
regresses the error envelope on any endpoint the suite touches is caught without
a bespoke check for that endpoint.

## 7. Time

Roughly 21 minutes end to end. About 6 minutes reading the handout, 5 writing and
running the exploration pass and reading its log, 6 writing the suite, and 2 on
the two revision cycles. Six executions: one exploration, one first scored run
(2 failures, one of them mine), one after the idempotency fix, one after the
status-split strengthening, one confirming rerun that reproduced the previous
outcome exactly, and one final verification after writing this record.
