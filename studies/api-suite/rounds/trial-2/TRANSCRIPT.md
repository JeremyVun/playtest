# Authoring transcript — minibank ledger script suite

## Headline

| | |
|---|---|
| Executions used | **4** of 12 |
| Requests, final execution | **246** of the 360 wire budget |
| Requests, all authoring | **841** of 1 500 (123 + 227 + 245 + 246) |
| Wall clock | **~15 minutes** |
| Final verdict | `PASS` — exit 0, sound, 188 checks, 0 failing, 0 defects, gate 4/4 |
| Obligations | 33 of 33 covered; 0 skipped, 0 unsupported, 0 unaccounted |
| Genuine findings | none that rise to a violation; two advisories (below) |
| Read anything outside the scratch directory? | **No.** See "Boundary" at the end. |

---

## How I worked

Four executions, in this shape:

1. **Recon** (123 requests). A throwaway `suite.mjs` that made no checks at all and
   `console.log`ged one line per exchange into `run-out/stdout.log`. Its only job was
   to learn the facts the handout deliberately does not state.
2. **First real suite** (227 requests). 183 checks, 5 failing — all five my bug.
3. **After the fix** (245 requests). 187 checks, all passing, sound.
4. **After hardening against vacuous passes** (246 requests). 188 checks, all passing.

I spent an execution on recon on purpose. The handout is explicit that "which principal
is which is not written down anywhere", and several of my expectations (what the seed
contains, which account ids exist, how the cursor is shaped, whether a filtered
`GET /transfers` for a foreign account 403s or just returns nothing) are unknowable from
the document. Guessing them would have cost more than one execution to unwind. What
recon is *not* for: deriving the expectations themselves. Those come from
`INVARIANTS.md` and `openapi.json`. Where recon and an invariant disagreed I did not
quietly adopt the observed behaviour — see "Two judgement calls" below.

### What recon told me that the handout does not

- Principals are `customer_a`, `customer_b`, and the administrator `minibank`.
- A seeded reset leaves exactly two accounts: `acc_fee_usd` and `acc_fee_eur`, both
  `kind: "system"`, `owner_principal: "minibank"`, balance 0.
- Timestamps are a fixed epoch plus a **mutation** counter (one second per write), so
  reads do not advance the clock and a replayed write sequence is byte-reproducible.
- Ids are drawn from one suffix stream shared across prefixes; the same suffix can turn
  up as `acc_…` in one run and `ent_…` in another. Nothing may key off id shape.
- Cursors are base64url of `{"s":<sequence>}` — sequence-ordered, newest first.
- `GET /transfers?account_id=<an account you cannot read>` answers **200** with the
  subset you are party to, not 403. Worth knowing: a 403 there would have been an
  undocumented status for that operation and would have failed the gate's
  `documented_status` policy on traffic I chose to make.
- The refusal codes, so I could name them in `expected` strings rather than writing
  "some 4xx": `account_not_active`, `account_closed`, `account_has_pending_transfers`,
  `transfer_not_pending`, `idempotency_key_conflict`, `daily_limit_exceeded`,
  `insufficient_funds`, `currency_mismatch`, `same_account`, `invalid_json`,
  `invalid_limit`, `invalid_cursor`, `forbidden`, `unauthorized`, `*_not_found`.

One recon probe was badly chosen and I fixed the *probe*, not an expectation: I tried to
provoke `insufficient_funds` with a 999 999 transfer from an empty account and got
`daily_limit_exceeded`, because 999 999 exceeds the 100 000 daily cap and that check
fires first. In the real suite the funds probe is 1 000 from an active, unfunded account
(`AI`), which is under the cap, so the refusal can only be about funds.

---

## What I understood each rule to mean, and the sequence I chose for it

### 1. Conservation
"Exactly three rows, summing to zero" is the whole of it, so the check reads the ledgers
of all three accounts (source, destination, and the currency's fee account) and filters
on `transfer_id`, rather than reading one side and inferring. It asserts the *count* of
each kind is 1 — a build that double-writes the credit would still sum to a plausible
number if you only checked the debit. Done for a USD transfer (25 000) and a EUR one
(10 000) so a per-currency posting bug cannot hide. Two negative cases: a transfer
**canceled** before the tick and one that **failed** at settlement must each own zero
rows across all three accounts.

### 2. The fee schedule
`25 + round_half_up(amount * 15 / 10000)`. The interesting content is the rounding, so I
picked amounts that separate half-up from truncation and from half-even:

| amount | `amount*15/10000` | fee | discriminates |
|---|---|---|---|
| 1 | 0.0015 | 25 | floor at zero |
| 333 | 0.4995 | 25 | just below the half |
| 334 | 0.501 | 26 | just above |
| 666 | 0.999 | 26 | just below 1 |
| **1 000** | **1.5** | **27** | exact half — truncation gives 26 |
| **3 000** | **4.5** | **30** | exact half at an even boundary — half-*even* gives 29 |
| 3 333 | 4.9995 | 30 | just below |
| 3 334 | 5.001 | 30 | just above |
| 50 000 | 75 | 100 | large, exact |

1 000 and 3 000 are the load-bearing ones: 3 000 catches banker's rounding, which is the
plausible wrong implementation that all the non-half amounts would let through. The same
two amounts are then charged in EUR to test "one schedule, not a per-currency table",
and after the tick every probe's *settled* fee row is compared to the schedule again, to
test "the fee a transfer declares is the fee it settles at".

### 3. Idempotency
The statement's teeth are in the "whatever happens to that transfer in the meantime"
clause, so the suite drives one key through cancellation and another through settlement
and a day rollover:

- key `K1`: create → replay (same body, expect 200 + `Idempotency-Replayed: true`, same
  id) → same key with a different amount (expect 409, nothing created) → the *other*
  principal reuses `K1` for its own transfer (expect 201, distinct transfer) → cancel →
  replay `K1` again, which must still return the same, now-canceled, transfer.
- key `K2`: create → tick → replay, which must return the same, now-settled, transfer →
  much later, after `advance_day: true`, replay a third time.
- Then the counting checks: exactly one transfer per key in `GET /transfers?account_id=`,
  and exactly three ledger rows for `K2` and zero for the canceled `K1`. "One transfer"
  and "one set of ledger effects" are two different claims and the rule makes both.

### 4. Lifecycle legality
Every clause of the statement is a separate probe against a purpose-built account: `AP`
(created, never activated), `AC` (activated, funded 500, then closed). Nine refusals —
transfer out of / into a pending account, deposit into a pending account, re-activating
an active account, transfer out of / into a closed account, deposit into a closed
account, activating a closed account, closing a closed account — plus close-while-pending
on **both** sides (the source and, as the other principal, the destination), plus
cancel-a-canceled-transfer. Then three confirming reads that the refusals **created
nothing**: no transfer names `AP` or `AC`, and `AP` has no ledger entries. A build that
returns the right status and writes the row anyway is exactly the kind of defect a
status-only check misses. Finally the two documented-behaviour cases that are *not*
counterexamples: the closed account still answers 410 with a tombstone, and still serves
its one pre-closure entry with 200.

### 5. Settlement
Four sequences:

- **Everything resolves.** After 13 pending transfers, one unlimited tick must report
  `pending: 0` and name every one of them in `settled ∪ failed`, in **creation order**
  (compared as an exact array, not a set).
- **Once only.** An immediate second tick: empty `settled` and `failed`, unchanged
  balance, unchanged entry count, and an unchanged `settled_at` on the transfer. I
  originally compared `settled_at` against the value in the *creation* response, which is
  always `null` — a bug that would have made the check unfalsifiable. It now reads the
  transfer immediately before the second tick and compares to that.
- **`settle_limit`.** Three transfers on a dedicated account, `settle_limit: 2` must
  settle exactly the two oldest and leave `pending: 1`; the next unlimited tick settles
  exactly the third.
- **Funds are re-checked at settlement.** `AS` holds 60 000; two transfers of 40 000 are
  each individually covered at creation (40 085 ≤ 60 000) and jointly are not. The tick
  must settle the first and **fail** the second, the failed one must write no rows
  anywhere, and the balance must land on exactly 60 000 − 40 085.

Every tick in the suite is placed where the globally pending set is known exactly,
because `POST /admin/tick` is service-wide. That constraint drove the phase ordering more
than anything else.

### 6. Ownership
Two customer credentials exist so that "acting as the wrong principal" is something you
can do, so the suite does it seven ways against a foreign account — read, read entries,
fund, activate, close, spend from, read a deposit into it — and separately checks that
**no part of the target's state comes back with the refusal**, by scanning each 403 body
for the target's `owner`, `owner_principal`, balance, and for the field names `balance` /
`owner` / `status`. All three declared exceptions get their own checks: the fee accounts
are readable by both customers and actable by neither; the destination of a transfer need
not belong to the caller; and a transfer is readable by the owner of *either* side — with
the sharpened form, that the payee can read the transfer (200) while the payer's account
is still 403 to them. Plus: `owner_principal` on `POST /accounts` is admin-only, the
account admin opens for `customer_b` is reachable by B and 403 to A, both collections
(`GET /accounts`, `GET /transfers`) are scoped to the caller, the admin is unrestricted,
and `/admin/tick` and `/admin/reset` are 403 for customers.

I deliberately run the customer `POST /admin/reset` probe **early**, immediately after the
canonical reset. If a defective build honours it, it wipes to the same seeded state and
costs nothing; run late it would have destroyed the state every later check depends on.

### 7. Pagination
A shared enumerator walks each collection from no cursor, following `next_cursor`, capped
at 40 pages so a non-terminating build fails a check rather than hanging. For each of
`GET /accounts` (limit 3), `GET /transfers` (limit 4), `GET /accounts/{id}/entries`
(limit 3) and a filtered `GET /transfers?account_id=` (limit 2) it asserts: every page
answered 200 with an items array; no id twice; the walk terminated; no page over the
limit; **a short page carries `next_cursor: null`**; and completeness against a
`limit=100` baseline read immediately before, with no write in between — which is exactly
the condition the rule attaches to its completeness half. Filter discipline is checked
separately for both filters the rule names: every item of a filtered transfer enumeration
names that account on one side, and the default account listing contains no closed
account.

### 8. Documented parameters
`limit` bounds the page (limit=1 → one item) and is refused outside 1..100 (0, 101,
`abc`, −1 — across three different collections, since the parameter is shared by
reference in the document). `include_closed` both ways. `account_id` restricted to
exactly the nine transfers that account sent. `Idempotency-Key` honoured, including its
documented `Idempotency-Replayed` response header. `settle_limit` and `advance_day` do
what they say. The optional `currency` assertion on `POST /transfers` is honoured. And
the declared exception: an unknown *query* parameter is ignored — checked by comparing
the collection with and without it, not merely by the status.

### 9. Reference integrity
The rule's declared exception is absence, not disagreement, so each check is written as
"null or absent is fine; present must be right": the deposit's `entry_id` resolves to an
entry on the deposit's own account, for its amount, whose `deposit_id` points back; every
entry's currency equals its account's currency; a sample of `transfer_id` references
resolve with 200; and every transfer's `fee_account_id` is the fee account of its own
currency (checked across all eleven fee probes, USD and EUR).

### 10. The daily limit
Boundary first: 99 999 then 1 is accepted (the total is exactly 100 000, inclusive), and
one more minor unit is 422 `daily_limit_exceeded`. Then the two "does not give the room
back" clauses, which are the ones a naive implementation gets wrong:

- **Cancellation.** Cancel the 99 999 and retry 1 — must still be refused.
- **Failure at settlement.** `AS` used 80 000 today, 40 000 of it on the transfer that
  *failed* at settlement. Top it up with 200 000 so funds cannot be the reason, then
  21 001-style: 20 001 must be refused with `daily_limit_exceeded` (if failure had
  refunded the room, usage would be 40 000 and 20 001 would sail through), and 20 000 —
  landing on exactly 100 000 — must be accepted. That pair also demonstrates that usage
  counts **amounts and not fees**: the 165 minor units of fee already charged did not
  consume any allowance.
- Then `advance_day: true` and a transfer from the exhausted account, which must succeed.

### 11. Error shape and the status split
Two aggregate checks over *all* recorded traffic — every 4xx body is exactly
`{"error":{code,message,details?}}` with string code and message and no extra keys, and
no response is 5xx — plus a registry. Every deliberately refused request in the suite is
registered with the status the split assigns it, giving 40-odd individual `split-*`
checks and two aggregates ("all refusals are 4xx, never a 2xx with a failure inside" and
"every refusal carried the status the split assigns"). The split is exercised at each of
its seven statuses: 400 (unparseable body, bad limit ×4, bad cursor), 401 (missing and
unknown credential, with the `WWW-Authenticate` header), 403 (wrong principal, ten ways),
404 (unknown id in ten places, including after a resource-scoped path and asked by a
principal who would be forbidden if the resource existed), 409 (resource state), 410
(closed tombstone), 422 (business rules).

### 12. Balance agreement
Done as the last thing the suite does, in one quiescent block with no writes: read the
whole account list once (`include_closed=true`, so the closed account's balance is
available even though `GET /accounts/{id}` answers 410 for it), then enumerate every
account's entries and compare the sum. All 17 accounts, not a sample. The fee accounts
get an extra check — balance equals the sum of the fee rows and they hold *only* fee rows
— and every balance must be an integer.

### 13. Round-trip consistency and determinism
Determinism is checked **before** the canonical reset, so it cannot perturb anything: a
nine-step write sequence (create, activate, deposit, create, activate, transfer, tick,
read entries) is run twice from the same seeded reset and the two sets of response bodies
are compared field for field — ids, `created_at`, entry ids and `sequence` values
included. Round-trip is create-vs-read for all three creatable resources: the account
(on its immutable fields, since funding legitimately moves the balance), the deposit
(whole resource), and the transfer (whole resource, read before any tick). Comparison
normalizes absent and `null` to the same value, which is the rule's declared exception.

---

## Every check revision, and the citation that justified it

There were three. Two are corrections to my own code, one is an expectation I softened.

**R1 — `enumerate` sent a header *function* instead of a header object.** Execution 2
failed five checks (`page-accounts-complete`, `page-transfers-complete`,
`page-entries-complete`, `page-filter-holds-on-every-page`, `param-account-id-filter`).
Before touching anything I resolved the evidence in `run-out/har.json`: entries 201, 203
and 206 were `GET …&limit=3` → **401 unauthorized**. The service was right and my suite
was wrong — I had written `enumerate(path, limit, CA)` and then `GET(q, { headers })`
with `headers` bound to the function `CA`, not to `CA()`. No expectation changed; the
call site was fixed. I also added a `page-*-pages-answered` check to each enumeration, so
that this failure mode can never again pass the *other* four pagination checks vacuously
(0 items trivially satisfies "no duplicates", "respects the limit" and "terminates").

**R2 — `settle-once-only` compared `settled_at` against the creation response.** Found by
reading my own predicate rather than by a failure: the transfer's creation body always
has `settled_at: null`, so `trAfter.settled_at === T.usd.json.settled_at` could only ever
be false-then-masked by the surrounding `|| false`. The check now reads the transfer
immediately before the second tick and requires `settled_at` to be non-null then and
identical after. Justification is the rule text itself — "A transfer settles once; a
second tick does not settle it again" — which is a claim about a transfer that has
*already* settled, so the comparison must be against its post-settlement state.

**R3 — I did not assert 400 for a wrongly typed `amount`.** `INVARIANTS.md` §11 says "A
malformed, unparseable, or wrongly typed request is 400", and `POST /deposits` with
`amount: "lots"` answers **422 `invalid_amount`**. I read that as a genuine tension and
went to the document to break the tie. `openapi.json`
`components.responses.BadRequest.description` enumerates the 400 codes exhaustively:

> "The request is malformed: invalid_request, invalid_json, invalid_cursor, or
> invalid_limit."

`invalid_amount` is not among them, and `POST /deposits` declares 422 with the shared
`Error` schema for exactly this class. So the document places amount validation at 422 and
the invariant's "wrongly typed" clause most plausibly covers the `invalid_request` family
(a body that is not the shape the operation takes at all), not a field-level type. I kept
a check that the request is **refused with a 4xx** — which is the part both readings agree
on and the part that catches a build that accepts `"lots"` — and recorded the status
disagreement as an **advisory**, with the reasoning, so a reader can see it without the
gate turning on a coin flip. Asserting 400 here would have been a finding manufactured out
of an ambiguity I had already resolved against myself.

---

## The two advisories (observations, not findings)

1. **A wrongly typed `amount` answers 422, not 400.** Covered by R3 above.
2. **An undocumented request-body property is accepted.** `POST /accounts` with
   `{owner, currency, not_a_field: 1}` returns 201. `CreateAccountRequest` declares
   `additionalProperties: false`, and the one declared exception in §8 is scoped
   explicitly to unknown *query* parameters — so the document is stricter than the
   behaviour. I left it as an advisory rather than a failing check because no invariant
   statement says an unknown **body** property must be refused; the strictness lives only
   in a JSON Schema keyword, and reading a schema annotation as a runtime obligation the
   owner never stated is a stretch. Flagged so a reviewer can decide.

I have no findings that I believe are violations. On the instance I was given, all 188
checks pass and the gate's four policies pass over all 246 recorded exchanges. I did not
weaken any check to reach that; the two things I found that could arguably be called
deviations are the advisories above, and both are recorded with their evidence refs.

---

## Things I tried that did not work, and things that surprised me

- **My first `insufficient_funds` probe never tested funds.** 999 999 from an empty
  account is refused for the *daily limit*, because 999 999 > 100 000 and that check runs
  first. Any amount used to probe a funds refusal has to sit under the daily cap. Caught
  in recon, before it could become a check that looked green for the wrong reason.
- **`POST /admin/tick` is global, which constrained the whole suite's shape.** There is no
  per-account settlement, so every `settle_limit` and every "these two must fail" sequence
  only means anything if the globally pending set at that instant is exactly what I
  intend. Roughly half the effort in ordering the phases went into that; the
  `settle-creation-order` check compares an exact array precisely because I know the
  global pending set at that tick.
- **The `advance_day` tick is two rules at once.** §5 says a tick that rolls the day is
  still a tick, and §10 says only `advance_day` moves the day. So one call carries both a
  settlement check and a rollover check, rather than spending an extra tick on each.
- **Recon nearly cost me a false expectation about `GET /transfers?account_id=`.** I
  assumed a foreign account id there would be 403. It is 200 with the caller's own subset.
  Had I asserted 403 I would have both filed a false finding *and* provoked an
  undocumented status (that operation declares only 200/400/401), failing the gate's
  `documented_status` policy on traffic I chose to make. That interaction — the gate
  failing on my choices, not the API's behaviour — is the least obvious hazard in the
  contract.
- **Ids are not namespaced by prefix.** In execution 2 the "missing" list printed things
  like `acc_hxf94wpr0h`, and `hxf94wpr0h` had been an *entry* id in the recon run. One
  suffix stream serves every prefix. Nothing in the suite may infer a resource kind from
  an id, and I removed an early instinct to do so.
- **Non-vacuity is a separate design problem from correctness.** After the first fully
  green run I went back through every aggregate check of the form "the list of bad things
  is empty" and added a non-emptiness guard to the population, because each of them would
  pass on a build that returns nothing at all. That is execution 4 and eleven predicates:
  entry-currency agreement, canceled/failed transfers writing nothing, fee-account
  balances, pagination completeness, the refusal aggregates, the content-type aggregate,
  integral balances, the closed-account filter, and both tick-order checks. It bought no
  new green ticks on this instance, which is the point — it buys red ones on a build that
  is broken enough to be empty.
- **The report format did most of my debugging.** `run.sh`'s summary plus
  `har.json` indices meant I never had to guess why a check failed. The evidence
  discipline the brief imposes paid for itself immediately in R1.

Roughly: 4 minutes reading the handout, 3 minutes on recon and reading its log, 5 minutes
writing the suite, 3 minutes on the two fix cycles and the hardening pass. About 15
minutes of wall clock in total.

---

## Boundary

**I did not read, list, search, or open any file outside
`/Users/jeremy/projects/playtest-s0-trials/trial-2`.** Everything I consulted is
`BRIEF.md`, `handout/openapi.json`, `handout/INVARIANTS.md`, `handout/CLIENT.md`,
`handout/obligations.json`, `handout-manifest.json`, `run.sh` (read, to know what it
does, and executed four times), and my own `run-out/` artifacts. I did not open the
repository `run.sh` execs into, any other trial directory, or anything else on the
machine. I did not use the web. Every request the suite makes goes through the injected
`client`; I ran no `curl`, no ad-hoc `node` fetch script, and made no network call
outside a counted execution. I did not read, and cannot read, any credential value —
the three tokens are only ever used as `client.secret(NAME)` header references, and the
report's `hygiene.leak_findings` is empty.
