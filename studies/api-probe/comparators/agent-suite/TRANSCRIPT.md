# Authoring record — minibank ledger invariant suite

## Did I read anything outside my working directory?

No. Everything I used came from `/tmp/comparator-agent-suite/handout/`
(`INVARIANTS.md`, `openapi.json`), from HTTP traffic to
`http://127.0.0.1:4181`, and from files I wrote myself under
`/tmp/comparator-agent-suite/`. I did not open, list, grep, or otherwise touch
any file outside that directory: no repository, nothing named `playtest`, no
source, tests, or fixtures belonging to the service under test. I did not use
web search or fetch. The only tools were a JSON reader for the two handout
files, `curl`/`node` against 127.0.0.1:4181, and an editor for my own files.

Roughly two and a half hours end to end: about 40 minutes reading and probing,
about an hour writing the suite, and the rest verifying that it fails when it
should.

## What I did first

I read the OpenAPI document before writing a line of test code, because the
rules' *exceptions* are where the traps are, and most of them are spelled out
in `x-ledger-consistency`, `x-ledger-fee-schedule` and `x-ledger-limits` rather
than in the invariant statements: entries are newest-first with a cursor that
means "strictly older than this position"; settlement only happens inside
`POST /admin/tick`; the daily limit is *reserved at creation* and is not
released by a cancel; the fee is `25 + round_half_away_from_zero(amount *
15/10000)` charged on top of the amount.

Then I spent five throwaway scripts (kept in `scratch/`) poking the live
instance to learn what the document does not say, in particular:

- Identifiers are a pure function of the seed but they are *not* stable across
  a differently-ordered request sequence, so nothing in the suite may hardcode
  an id. Only `acc_fee_usd` / `acc_fee_eur` are fixed.
- The daily-limit check runs *before* the funds check, so a "too big" transfer
  reports `daily_limit_exceeded`, not `insufficient_funds`. My first draft of
  the insufficient-funds probe was measuring the wrong thing until I noticed.
- Cursors are `base64url({"s":<sequence>})`. They are not bound to an endpoint
  or an account: a cursor from one account's entries is accepted on another's,
  and on `/accounts`. Forged in-range cursors are accepted; only unparseable
  ones are `invalid_cursor`. None of that violates rule 4, whose applicability
  is an enumeration that *starts without a cursor* — so I left it alone.
- A transfer may name a system fee account as its destination, so one settled
  transfer can put two entries on one account. My conservation check had to
  identify the debit/credit/fee triple structurally rather than by assuming
  three distinct accounts.
- Timestamps come from a mutation counter, so entries written by one settlement
  share a `created_at` while entries from different transfers in the same tick
  do not. A timestamp-keyed cursor would still be fragile, which is why the
  suite walks the fee account (the one account that accumulates entries from
  every transfer in the run) at a page size of 2 and destinations that receive
  two credits in one tick at a page size of 1.

## How I approached each rule

**1. Conservation.** The check is arithmetic, so the work is in reaching states
worth doing arithmetic on. The settlement scenario creates transfers at
amounts chosen to sit on every corner of the fee rounding rule (1 → fee 25,
333 → 25 as 0.4995 rounds down, 1000 → 27 as 1.5 rounds away from zero, 3333,
25000 → 63 as 37.5 rounds up, 50000), in both currencies, plus one whose
destination is a fee account. One transfer is canceled before the tick and one
is engineered to be affordable at creation and unaffordable at settlement, so
the run contains a genuine `failed` transfer as well as a `canceled` one —
the two declared exceptions. Then every account in the world is enumerated and
entries are grouped by `transfer_id`: settled transfers must sum to zero *and*
consist of exactly one debit of `-(amount+fee)` on the source, one credit of
`+amount` on the destination and one fee credit on the named fee account; non-
settled transfers must have no entries at all. On top of that the suite
compares the sum of every balance in the world against the sum of every deposit
the service acknowledged, which catches money appearing in accounts the
per-transfer checks never look at.

**2. Idempotency.** Testing this by only looking at response codes is exactly
the wrong instinct — a service can return a tidy 200 and still have written a
second row. So every idempotency check is followed by a read of state: the
transfer list is filtered by `idempotency_key` and must contain exactly one
row, and after settlement the source and destination entry listings must carry
exactly one entry each for that transfer. The suite sends the same key three
times serially, five times *concurrently* (the classic race, where a
check-then-insert service produces two transfers), once with the members of the
body reordered, once with a different body (the declared exception: must be a
409 that creates nothing — verified by diffing the transfer list before and
after), once with a fresh key and the same body (must create a second transfer;
collapsing it would silently swallow a payment), once after the transfer
settled, and once after it was canceled. Cross-principal scoping is checked but
only reported as an advisory, because the rule declares itself per principal.

**3. Lifecycle legality.** Every illegal operation is followed by a read that
proves nothing happened, because "refused with the right status but wrote
anyway" is the failure mode that actually costs money. Never-activated source
and destination; closed source and destination; closing an account that is the
source of a pending transfer and one that is its destination; cancelling a
transfer that is pending, then canceled, then settled, then failed. After each
refusal the suite re-reads the account status, the balance, the transfer list
and the entry listing. The cancel path also checks that a canceled transfer
survives a later tick without settling, and the closed-account path checks the
documented tombstone behaviour (410 on the account, history still served,
hidden from the listing unless `include_closed=true`) so a build that "fixed"
the soft delete into a hard delete would be caught by the money going missing.

**4. Pagination identity.** The enumeration helper is shared by every listing
walk in the suite — including the ~20 walks the two whole-world snapshots do —
so rule 4 is checked continuously rather than in one place. Within a walk it
fails on a repeated id, on a repeated cursor, and on a walk that runs away
(more rows than the suite ever wrote, or a run of empty pages). Nine entries
are enumerated at page sizes 1, 3 (an exact divisor, which is where off-by-one
"is there a next page" bugs live), 4 and the default; a walk is repeated with a
deposit landing between every page, and another with a whole settlement (three
entries at once, one of them on the account being walked) landing mid-walk. The
declared exception is respected: entries that appear after a walk starts may be
missed, and a short enumeration is only ever an advisory. Only seeing a row
twice is a violation. Closed accounts get walked too, since they keep serving
history.

**5. Error shape.** This one is not a scenario, it is the client: every
response the suite receives — all 285 of them — is audited for a 5xx, for the
exact `{"error":{"code","message","details"?}}` envelope with string members
and no extra members, for `WWW-Authenticate` on a 401, and for a failure
smuggled into a 2xx. The dedicated scenario's job is only to widen the *kinds*
of response the audit sees: one probe per documented refusal (400/401/403/404/
405/409/410/422) plus the inputs most likely to fall out of a hand-written
router — malformed percent-encoding, a null byte, a 2000-character path, a
Unicode path, `//accounts`, bodies that are `null`/a string/an array/120 levels
of nesting, `__proto__`, `1e400`, a 200KB owner, a 600-character
`Idempotency-Key`, seven bad `limit` values, five forged cursors. One judgement
call: when the service *accepts* something its own document says it refuses (a
zero-amount transfer, an unauthenticated read), that is a real defect but it is
not what rule 5 says, so the suite reports it under a separate "contract"
heading rather than filing it against a rule it does not break. It still fails
the run.

**6. Balance agreement.** Read consistently, as the rule demands: the snapshot
lists every account (including closed ones), walks every account's entries,
then re-lists the accounts and requires every balance to be byte-identical
before comparing. If a balance moved while the suite issued no write, that is
reported on its own rather than being blamed on the sum. The comparison covers
customer accounts, closed accounts and both system fee accounts, and runs twice
— once after settlement and once at the end of the run, when the world contains
canceled, failed, settled, pending, closed and never-activated states
simultaneously.

## What did not work, and what I changed

- **My first page cap was a false-positive generator.** I capped enumerations
  at four pages and called hitting the cap "does not terminate". A service that
  simply ignored `limit` would need more pages and still finish, and would have
  been reported as a rule 4 violation it did not commit. The cap is now a
  budget guard, and only a walk that has clearly run away (≥150 rows, or three
  empty pages) is called non-termination.
- **`status: "failed"` inside a 200 is legitimate.** My generic "refusal
  smuggled into a 2xx" audit originally flagged any 2xx body with a failure-ish
  `status`, which fires on a perfectly correct read of a transfer that failed at
  settlement. Creation-time status checks moved into the scenarios, where a
  *newly created* transfer must be `pending`.
- **The whole-world money sum needed a premise check.** It is only meaningful
  if the suite knows every deposit the service accepted, so accepted deposits
  are recorded from the responses themselves (not from what the suite intended
  to do), and the sum is skipped with a warning if any request went unanswered
  or a deposit came back with an unreadable body.
- **Amount sizing was fragile.** The "affordable at creation, unaffordable at
  settlement" pair originally used a fixed amount that collided with the daily
  limit once fees were counted. It is now derived from the balance read at that
  moment and clamped to the remaining daily allowance.

## How I convinced myself a pass means something

A suite that never fails is worthless, and I could not test it against a
defective build because I am not allowed to see the service at all. So I put a
mutating reverse proxy in front of the fixture (`scratch/proxy.mjs`) and ran
the suite through it with 20 different injected defects
(`scratch/verify.sh`): a fee entry off by one cent, a drifting balance, an
off-by-one cursor that repeats a row, a cursor chain that never ends, a replay
returning a different transfer, two rows carrying one idempotency key, a 409
turned into a 200, a 422 turned into a 200, an envelope without its `error`
wrapper, a non-string `code`, a 500, a missing `WWW-Authenticate`, an entry
belonging to no transfer, a dropped fee entry, a settled transfer reported as
failed, a transfer row whose fee disagrees with its entry, an entry attributed
to the wrong account, HTML instead of JSON, an empty 2xx body, and a server
that simply never answers `POST /transfers`.

All 20 were caught with the expected rule attribution, and the unmodified
service still passed. The hang case is the one I care most about for unattended
running: it produced transport violations and three setup failures, finished in
179 requests, and never threw.

## Numbers

- Clean run against `http://127.0.0.1:4181`: **285 HTTP requests, ~0.11s**,
  exit 0. Deterministic: repeated runs and different `SEED` values give the
  same count.
- Worst case observed against a broken build: 334 requests. A hard ceiling of
  350 (`MAX_REQUESTS`) stops the run with a clear report rather than letting a
  non-terminating listing burn thousands of requests, and 40 of those are
  reserved so the whole-world audit always runs.
- Every request goes through `BASE_URL` (default `http://127.0.0.1:4181`,
  trailing slashes trimmed); there is no hostname or port anywhere else in
  `suite/`.

## Things that surprised me

- The daily limit is checked before funds, and is reserved at creation and
  never released — so a canceled transfer permanently consumes allowance. It is
  documented, but it silently reshapes what amounts you can use in a test.
- `GET /accounts/{id}/entries` accepts a cursor issued for a *different*
  account and answers 200 with an empty page rather than 400.
- The request schemas say `additionalProperties: false`, but unknown members
  are accepted in practice (`{"wat":1}` on a transfer, `{"nope":1}` on a reset);
  `reset` even coerces `{"seed":5}` to the string `"5"`. Not a rule, so the
  suite does not fail on it.
- `Idempotency-Key` has a documented `maxLength: 255` that is not enforced.
- `HEAD /accounts` answers 405 with an empty body. I deliberately kept HEAD out
  of the suite: HTTP forbids a body on a HEAD response, so auditing that
  response against the error envelope would be an unfair test.

## What I could not test, and why

- **Anything requiring true concurrency against shared state.** The five
  simultaneous keyed requests are the only real race the suite runs. The
  service is single-threaded and deterministic with no wall clock or background
  workers, so a read-modify-write window that needs two overlapping settlements
  cannot be opened from the outside.
- **Skips.** Rule 4 explicitly declines to offer a no-skip guarantee, so a
  build that silently drops entries from an enumeration is invisible to rule 4.
  The suite reports it as an advisory, and picks it up indirectly through rule
  6 only when the *stored* balance and the *complete* enumeration disagree — if
  a build dropped entries from both the balance and the listing consistently,
  the whole-world deposit sum is the last line of defence.
- **Durability and restarts.** There is no documented way to make the service
  restart or flush, so "does the ledger survive a process restart" is out of
  reach.
- **The fee schedule as a hard assertion.** A build that mis-rounds the fee
  *consistently* (charging and crediting the same wrong number) breaks no
  invariant in the handout — the entries still sum to zero and the balances
  still agree. The suite reports a mismatch against the published schedule as
  an advisory rather than failing on it, because failing would be asserting a
  rule I was not given. A fee that is mis-rounded *asymmetrically* does break
  conservation, and that is caught.
- **Whether the cursor encoding is stable.** The suite never decodes a cursor:
  it treats every `next_cursor` as opaque and only ever hands it straight back.
  (It does *construct* a handful of deliberately malformed cursor strings as
  hostile input, to see whether a bad cursor can be turned into a 500.) A build
  that changed the cursor format entirely would pass, which is correct — the
  format is not one of the six rules.
