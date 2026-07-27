# Minibank — the ledger API fixture

A small double-entry ledger service, built as the purpose-built subject for
Playtest's API work: the agentic invariant probe, its comparator arms, and the
API journey-regression demo all point at this fixture rather than at anyone's
real API (`docs/backlog/api-testing/DESIGN.md` §6, `BUILD_PLAN.md` P0).

It is deliberately non-trivial. A todo-style CRUD API cannot carry domain
invariants; this one has money, fees, rounding, a settlement lifecycle,
idempotency, limits, soft deletes, and cursor pagination — so reaching a state
where an invariant can be *violated* takes real work, which is exactly what the
probe is being measured on.

- Zero dependencies. Node 20+, ESM, `node:http` only.
- Fully in-memory and deterministic: seeded identifiers, a mutation-counter
  clock, settlement only on an explicit admin tick, and a full-state seeded
  reset endpoint so the harness owns per-run isolation.
- An OpenAPI 3.1 document shipped in the repo and served by the app.
- Twenty-seven individually toggleable seeded faults for measurement, each
  tagged with a taxonomy category.
- **Conforming variants** and a latency-jitter flag: alternative implementations
  that stay inside the contract, so a test suite that snapshotted *this*
  implementation can be told apart from one that encoded the contract.
- An offline measurement bench that scores any arm's traffic with the same
  deterministic oracles, in two columns — what the oracles confirm, and what the
  arm's own report claims with evidence that resolves.

## Start it

```sh
node examples/ledger-api/server.js
# ledger-api listening on http://127.0.0.1:4180
#   openapi: http://127.0.0.1:4180/openapi.json
#   seed:    ledger-dev-seed
#   faults:  (none — clean build)
```

```sh
curl -s http://127.0.0.1:4180/health
curl -s http://127.0.0.1:4180/openapi.json | head
curl -s -H 'Authorization: Bearer customer-token-dev' http://127.0.0.1:4180/accounts
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4180` | Listen port. `0` picks a free one. |
| `HOST` | `127.0.0.1` | Listen address. |
| `LEDGER_SEED` | `ledger-dev-seed` | PRNG seed for identifiers. |
| `LEDGER_FAULTS` | *(empty)* | Comma-separated fault ids to enable. |
| `LEDGER_VARIANT` | *(empty)* | Comma-separated conforming-variant ids to enable. |
| `LEDGER_JITTER_MS` | `0` | Upper bound on the pseudo-random delay before each response is written. Content is unaffected. |
| `LEDGER_JITTER_SEED` | `<LEDGER_SEED>:jitter` | Seed for the jitter PRNG, which is independent of the identifier PRNG. |
| `LEDGER_ADMIN_TOKEN` | `admin-token-dev` | Bearer token for the `admin` principal. |
| `LEDGER_CUSTOMER_TOKEN` | `customer-token-dev` | Bearer token for the `customer_a` principal. |
| `LEDGER_CUSTOMER_B_TOKEN` | `customer-b-token-dev` | Bearer token for the `customer_b` principal. |

The tokens are throwaway fixture credentials with published defaults on
purpose: this service is a target for adversarial exploration, not a place to
keep a secret. The fixture never reads a `.env`. An unknown `LEDGER_FAULTS` id
or a bad `PORT` refuses to start with an actionable message rather than
silently running the clean build.

## The surface

Bearer auth on everything except `GET /health` and `GET /openapi.json`. One
token per **principal**: `admin`, `customer_a`, and `customer_b`. The admin
token may call `/admin/*` and reaches every account; a customer token may not
(`403`) and reaches only the accounts whose `owner_principal` is that
principal. Every failure — auth, routing, parsing, business rules — is the same
envelope:

```json
{ "error": { "code": "insufficient_funds", "message": "…", "details": { } } }
```

| Operation | Notes |
|---|---|
| `POST /accounts` | Created `pending`; cannot transact until activated. Owned by the calling principal; an admin may pass `owner_principal` to open one for a customer. |
| `GET /accounts` | Newest-first, cursor-paginated. `?include_closed=true` to see tombstones. Scoped to the principal's own accounts (plus the system accounts). |
| `GET /accounts/{id}` | `410` + tombstone once closed. `403` for another principal's account. |
| `POST /accounts/{id}/activate` | `pending → active`. `409` if already active. |
| `POST /accounts/{id}/close` | Soft delete. `409` while any transfer naming the account is pending. |
| `GET /accounts/{id}/entries` | Append-only double-entry rows, newest-first, cursor-paginated. Still served after closure. |
| `POST /deposits` | External funding; settles immediately; the declared conservation exception. |
| `POST /transfers` | Same-currency, active accounts only. Created `pending`. Honours `Idempotency-Key`. The **source** must belong to the caller; the destination may be any account. |
| `GET /transfers`, `GET /transfers/{id}` | Listing is newest-first and filterable by `account_id`. Visible to the principals owning either side. |
| `POST /transfers/{id}/cancel` | Legal only while `pending`; writes no entries. The payer cancels. |
| `POST /admin/tick` | **The only way time moves.** Settles pending transfers in creation order. `{"advance_day":true}` also rolls the ledger day over. |
| `POST /admin/reset` | Full-state seeded reset. `{"seed":"…"}` to change the seed. |

Money is always an integer in minor units. Fees are `25 + round_half_up(amount
* 15 / 10000)`, charged to the source account on top of the amount and credited
to the per-currency system fee account (`acc_fee_usd`, `acc_fee_eur`).

### Approvable invariants

The OpenAPI document declares these under `x-ledger-invariants`, each with its
applicability and its exceptions, and the consistency model they depend on
under `x-ledger-consistency`. They are what a probe, a fuzzer, or a comparator
arm gets pointed at:

1. **Conservation** — a settled transfer's entries (debit, credit, fee) sum to zero.
2. **Idempotency** — one key + one body → one transfer and one ledger effect.
3. **Lifecycle legality** — only active accounts transact; no close with pending transfers; no cancel after settlement.
4. **Pagination identity** — no duplicate entry id within one enumeration.
5. **Ownership** — a customer principal reaches only the accounts it owns; the system fee accounts are readable by all.
6. **Error-shape consistency** — every 4xx/5xx is the envelope, and a refusal is never a 2xx.
7. **Balance agreement** — stored balance equals the sum of the account's entries.

## Seeded faults

Enable any subset; each fault is one clearly marked `[FAULT <id>]` branch in
`src/ledger.js`. Nothing over HTTP ever discloses which are enabled — the
operator's terminal is the only place they are named.

```sh
LEDGER_FAULTS=f-close-ghost,f-pagination-dup node examples/ledger-api/server.js
```

| Fault | Tier | Category | Behaviour |
|---|---|---|---|
| `f-error-200` | schema-reachable | error-semantics | Insufficient funds answers `200` with `{"status":"failed"}` instead of the `422` envelope. |
| `f-undocumented-500` | schema-reachable | conditional-branch | A transfer amount exactly equal to the daily limit throws. |
| `f-fee-rounding-drift` | semantic | cross-resource-invariant | The fee leg truncates a half-minor-unit fee while the debit leg rounds it up, so entries sum to `-1`. |
| `f-idempotency-replay-double` | semantic | idempotency | A replayed `Idempotency-Key` returns the original transfer *and* enqueues a hidden second one. |
| `f-settle-cancel-race` | semantic | state-machine | A settled transfer can still be canceled; the reversal refunds the fee to the payer without clawing it back. |
| `f-close-ghost` | semantic | state-machine | Closed accounts keep transacting. |
| `f-pagination-dup` | semantic | pagination | The entry cursor degrades to an offset, so a write between pages repeats the boundary entry. |
| `f-balance-cache-stale` | semantic | cross-resource-invariant | Only the first settlement per account in a tick reaches the stored balance. |
| `f-cursor-error-bare` | schema-reachable | error-semantics | A rejected entry cursor answers `400` with a bare `{message}` instead of the envelope. |
| `f-close-pending-inbound` | semantic | state-machine | The close guard only checks *outbound* transfers, so an account with an inbound pending transfer closes. |
| `f-settle-failed-debit` | semantic | cross-resource-invariant | A transfer that fails the funds re-check at settlement still writes its debit row. |
| `f-idempotency-day-expiry` | semantic | temporal-boundary | The ledger-day rollover drops idempotency keys, so a retry across it creates a second transfer. |
| `f-fee-double-charged` | semantic | conditional-branch | On **EUR** settlements the fee is also deducted from the credit leg. |

The first eight were P1's **development set**; the last five were its sealed
held-out set, unsealed with the P1 report (`studies/api-probe/REPORT.md`). All
thirteen are now public, which makes all thirteen **development data**: a study
measuring against them is measuring against faults its instrument could see.

### S0's sealed set — fourteen more, unsealed after the round

Authored in isolation, committed to by sha256 before any S0 trial saw anything,
and disclosed once the sealed round was scored
(`studies/api-suite/PREREGISTRATION.md` §4.2, §10 step 5;
`studies/api-suite/rounds/sealed-round/RESULTS.md`). They are the same kind of
object as the thirteen above — one toggle, one `[FAULT …]` branch, one
manifestation test, one witness — and being public now makes them development
data too.

| Fault | Tier | Category | Behaviour |
|---|---|---|---|
| `f-activate-after-close` | semantic | state-machine | Activating a closed account revives it — `active`, `closed_at` cleared — instead of answering with the tombstone. |
| `f-transfer-to-pending-destination` | semantic | state-machine | The activation guard is applied to the payer only, so money can be sent into a never-activated account. |
| `f-deposit-entry-mismatch` | semantic | cross-resource-invariant | A deposit's `entry_id` names the account's previous ledger row rather than the row the deposit wrote. |
| `f-fee-account-balance-untouched` | semantic | cross-resource-invariant | The fee row is written but the system fee account's stored balance is not advanced with it. |
| `f-eur-fee-flat` | semantic | conditional-branch | **EUR** transfers are charged the flat fee component only; the basis-point part is dropped. Internally consistent, so conservation still holds. |
| `f-include-closed-ignored` | semantic | conditional-branch | `GET /accounts?include_closed=true` still filters closed accounts out. |
| `f-transfers-filter-after-page` | semantic | pagination | The `account_id` filter on `GET /transfers` runs after the page slice, so a filtered page comes back short while its cursor still promises another. |
| `f-idempotency-conflict-ignored` | semantic | idempotency | A key reused with a *different* body replays the earlier transfer instead of refusing the conflict — a lost write. |
| `f-idempotency-freed-by-cancel` | semantic | idempotency | Cancelling a transfer releases its `Idempotency-Key`, so the next retry creates a second transfer. |
| `f-day-usage-carryover` | semantic | temporal-boundary | The ledger-day rollover carries the day's transfer usage over instead of clearing it, so yesterday's transfers consume today's limit. |
| `f-tick-day-skips-settlement` | semantic | temporal-boundary | A tick that advances the ledger day returns without working the pending queue. |
| `f-entries-cross-principal` | semantic | authorization | `GET /accounts/{id}/entries` skips the ownership check, so any principal can read any account's history. |
| `f-transfer-source-unowned` | semantic | authorization | The transfer ownership test admits a caller who owns *either* side, so a payee can pull money out of the payer's account. |
| `f-same-account-envelope-bare` | schema-reachable | error-semantics | The self-transfer refusal is assembled by hand: `422 {"error":"same_account","message":…}` instead of the envelope. |

Twenty-seven faults in all: `DEVELOPMENT_FAULT_IDS` (8) and
`HELD_OUT_FAULT_IDS` (5) from P1, `SEALED_FAULT_IDS` (14) from S0. The eighth
taxonomy category, `authorization`, is populated by the sealed set.

**Categories** are the S0 taxonomy (`src/faults.js`), and they answer "what does
a test author have to *do* to reach this?" rather than "which oracle catches
it" — which is what makes a per-category miss actionable. Until the S0 unseal
the eighth category, `authorization`, had no fault at all: the fixture's
ownership surface (interpretation note 9) was exercised by the clean-build suite
only. The sealed set's two authorization faults populate it.

## Conforming variants and jitter

A *variant* is not a fault. It is a different, equally legal implementation of
the same contract — so a test suite that fails against a variant has snapshotted
this implementation instead of encoding the contract, which is a false positive
on the suite's part. That distinction is what the S0 study's clean-build scoring
rests on (`docs/backlog/api-testing/DESIGN.md` §7): clean is not one build, it is
the canonical build plus every variant plus jittered repeats.

```sh
LEDGER_VARIANT=terse-optionals,wide-ids LEDGER_JITTER_MS=250 \
  node examples/ledger-api/server.js
```

| Variant | What changes, and why it still conforms |
|---|---|
| `terse-optionals` | Optional nullable properties are **omitted** rather than emitted as `null` (`activated_at`, `closed_at`, `idempotency_key`, `failure_reason`, `settled_at`, `canceled_at`, `transfer_id`, `deposit_id`, `entry_id`). None of them is in its schema's `required` list. Catches `assert(account.activated_at === null)`. |
| `trailing-page` | A page that comes back exactly full always carries a `next_cursor`, so an enumeration ends on one **empty trailing page** instead of on the last full page. `next_cursor` is still null on the last page and no row is duplicated or displaced. Catches "the enumeration is over when `items.length < limit`". |
| `wide-ids` | Identifiers are 26-character tokens instead of 10, from the same seeded PRNG and still matching the documented patterns (`^acc_[0-9a-z_]+$` and friends). The fixed system fee-account ids are unchanged. Catches a hardcoded seeded id or an assumed id length. |

Enable any subset; ids are comma-separated and an unknown one refuses to start,
exactly like `LEDGER_FAULTS`. Variants are orthogonal to faults and to the
identifier seed, and the canonical build (no variant) is byte-for-byte what it
was before variants existed.

`LEDGER_JITTER_MS=<n>` delays each response's **write** by a pseudo-random
`0..n` ms drawn from a PRNG seeded independently of the identifier PRNG. Response
*content* is unchanged — the same request sequence produces byte-identical
bodies, ids and timestamps — because the delay is applied after the domain call
has already run. Repeated jittered runs are the study's CI-flake estimate.

One honest caveat: `Deposit.entry_id` is in the `terse-optionals` key list for
symmetry, but the fixture always populates it before serializing a deposit, so
that particular omission is never observable.

## Tests

```sh
node --test "examples/ledger-api/test/**/*.test.js"
# or, equivalently, through the fixture's own private manifest:
npm --prefix examples/ledger-api test
```

Hermetic, Node-only, loopback or in-process, zero skipped, no external network
and no model calls. They cover:

| Suite | What it holds |
|---|---|
| `test/clean.test.js` | Clean-build behaviour: auth, ownership, lifecycle, fees, limits, idempotency, settlement, pagination, determinism, error envelope. |
| `test/faults.test.js` | One manifestation test per fault, plus the **full 28 × 27 on/off matrix**: every fault fires when enabled, and no fault perturbs any other probe's behaviour when off. |
| `test/variants.test.js` | Each variant is observably different from canonical, still validates against the document's schemas, and is **oracle-clean with every oracle actually applicable**; jitter changes timing and nothing else; bad configuration refuses to start. |
| `test/openapi.test.js` | The document is served, resolves, declares the invariants, leaks no fault, every documented operation answers a documented status, and every operation that answers `400` on malformed input declares it. |
| `test/server.test.js` | The documented `node examples/ledger-api/server.js` command really boots, honours its environment, and refuses bad configuration. |
| `test/oracles.test.js` | Bench oracle branches and applicability rules over synthetic traces. |
| `test/bench.test.js` | The bench end to end over traffic recorded from the real fixture. |
| `test/columns.test.js` | The second column and the funnel: citation resolution, per-fault witnesses (exhaustively sound over every fault's clean traffic), the four funnel diagnoses, reported false positives on conforming builds, per-category aggregation. |
| `test/pins.test.js` | The instrument pins match the tree, cover every scoring module, and cannot let a vendored oracle copy diverge silently. |

**Why this is not part of root `npm test`.** `tests/repository/boundaries.test.ts`
asserts that no file under `src/`, `scripts/`, `studies/`, `tests/`, or the root
`package.json` mentions the examples directory at all — standalone examples are
never a build, product, test, or study dependency. A root `npm run ledger:test`
script would itself break that rule, so the fixture owns its command (and its
own private `package.json`) instead. Run it directly, as above; the root gate
stays untouched.

## The measurement bench

```sh
node examples/ledger-api/bench/bench.js [options] [label=]<path>...
```

Scores traces from any arm with the *same* deterministic oracles and reports
detection in **two columns**, the five-stage funnel per fault, false positives on
clean and conforming-variant builds, request and step counts, wall time, and
cost. Offline, no model calls, no dependencies.

**Inputs** (auto-detected):

| Input | Shape |
|---|---|
| Playtest run directory | `manifest.json` + `har.json`. Steps, wall time, and cost come from the manifest (`totals.executed_steps`, `duration_ms`, `totals.cost_usd`). |
| A directory of them | Walked recursively; every run directory and `.har` file under it is scored. |
| Plain HAR file | HAR 1.2 (`log.entries[]`, `headers` as `[{name,value}]`, `postData.text`, `content.text`). The flattened shape Playtest's api driver writes is also accepted. |
| Schemathesis cassette | The HAR cassette from `--cassette-path out.har --cassette-format har`. Recognised by `log.creator.name`. |
| **Suite report** | The arm's own named checks and their evidence, in any of three shapes: `playtest.suite-report/v0`, Playtest's script report (`script_report_version: 1`, `packages/core/src/schemas/script-report.schema.json`), or the P1 agent-suite's own data model. Found automatically at `suite-report.json` / `script-report.json` / `report.json` in a run directory or `<name>.report.json` beside a HAR, or attached with `--report <traceId\|label>=<file>`. |

The Schemathesis HAR cassette is the format the bench expects because it is the
one machine-readable Schemathesis output that carries full request *and*
response bodies, which every semantic oracle needs; JUnit/summary output carries
verdicts only, and the VCR cassette is YAML, which a zero-dependency reader
should not try to parse. Handing the bench a VCR cassette produces an
actionable error telling you which flag to re-run with.

**Labels** tell the bench which build a trace came from — `clean`, a fault id,
or `clean.<variant>` for a conforming-variant or jittered build (still a clean
build for scoring: any finding on it is a false positive). Give one inline
(`clean=path`), in a `bench-meta.json` inside a run directory, or in a
`<name>.meta.json` beside a HAR file. The sidecar can also supply an arm name
and the arm's own `steps` / `wall_ms` / `cost_usd` for tools whose traces do not
carry them.

```sh
# a probe round: every run directory under runs/, plus two comparator traces
node examples/ledger-api/bench/bench.js \
  runs/2026-07-25T0900-ab12 \
  clean=comparators/agent-suite-clean.har \
  f-close-ghost=comparators/schemathesis-close-ghost.har

# machine-readable, for a study report
node examples/ledger-api/bench/bench.js --json runs/2026-07-25T0900-ab12 > bench.json
node examples/ledger-api/bench/bench.js --out bench.json runs/2026-07-25T0900-ab12
```

Output is a per-trace table, the evidence for every finding, per-fault
detection broken down by arm, and the clean-build false-positive count:

```
trace                 source        label                 req  steps  wall_ms  cost    oracles  detect  evid  findings
--------------------  ------------  --------------------  ---  -----  -------  ------  -------  ------  ----  --------
clean-f-fee-rounding  playtest-run  clean                 11   11     7        0.0125  6/7      -       -     0
f-fee-rounding-drift  playtest-run  f-fee-rounding-drift  11   11     19       0.0125  6/7      yes     ok    1

f-fee-rounding-drift [f-fee-rounding-drift]
  - [on-label] conservation/transfer_entries_nonzero at #8 GET /accounts/acc_gr88xz9854/entries -> 200: the ledger entries for transfer tr_t93087fk7w sum to -1, not 0
      support #8: ent_rxy16k9720 transfer_debit -1027 on acc_gr88xz9854
      support #9: ent_jk6myhv6c4 transfer_credit 1000 on acc_jfrhrkfn7d
      support #10: ent_wwx4n0cddk fee 26 on acc_fee_usd
```

Exit code `0` when every fault-labelled trace was detected and no clean or
conforming trace produced a finding in either column; `1` otherwise; `2` for a
usage or input error.

### The two columns

| Column | Credited when |
|---|---|
| **oracle-confirmed-in-traffic** | an oracle violation whose code is one the labelled fault can cause, whose cited request resolves in the trace, and whose citation lands on a request of the kind the fault lives in |
| **reported-with-correct-evidence** | the arm's own report has a *failing check* attributable to the fault (by rule name across vocabularies, by cited route, or by naming the witnessed resource) **and** at least one cited HAR entry resolves in the recorded traffic and is on target |

One column is not enough, and P1 is the proof: the agent-authored suite caught
`f-settle-failed-debit` and named the offending ledger row, and the shared oracle
refused to credit it because its applicability window never opened
(`studies/api-probe/REPORT.md` §3). A citation that resolves but *describes* a
different exchange than it claims is not evidence and is not credited — that is
the failure mode a model-authored report is most likely to have.

### The funnel

Per fault per trace: **obligation enumerated → scenario executed → fault
manifested in traffic → assertion detected → evidence correctly cited**. The
first false stage is the diagnosis: `enumeration`, `reachability`, `assertion`,
or `reporting`. A stage the artifacts cannot answer is *unknown*, never false —
an arm that ships no structured report has not "missed" the reporting stage.

Stages 2 and 3 come from the per-fault **witnesses** in
`bench/lib/witnesses.js`: a contract-level predicate saying whether the fault
manifested in this traffic at all, independent of the oracles' applicability
windows. A witness must never fire on a conforming build (`test/columns.test.js`
proves that exhaustively over every fault's clean traffic), and it never decides
a verdict — it only diagnoses the funnel and scopes what "correct evidence"
means. A new fault must arrive with a witness or its funnel stages read
*unknown*.

### False positives, applicability, and pins

A *false positive* is any oracle violation (column 1) or failing check (column 2)
on a trace labelled `clean` or `clean.<variant>`. Every oracle also reports
*applicability*: a trace that never reached the state a rule talks about is
neither a pass nor a violation, so an arm cannot look good by exploring less.

**Oracles** (`bench/lib/oracles.js`), one per declared invariant plus a protocol
check: `protocol` (no unexpected 5xx), `error_shape`, `conservation`,
`idempotency` (key divergence and phantom effects), `lifecycle`, `pagination`,
`balance_agreement`.

**Pins.** `bench/oracle-pins.json` records a sha256 of every file that can change
a measured verdict, separating the two `shared_oracle` files that measured
instruments vendor a copy of from the rest of the scoring substrate, and
recording whether each known vendored copy is in sync. `npm run bench:pins`
verifies, `npm run bench:pins -- --write` re-records deliberately, and
`test/pins.test.js` fails until the pins and the tree agree. P1 lost a clean run
to a missed re-sync; this is that lesson, mechanized.

## Layout

```
examples/ledger-api/
  server.js               entry point; env parsing and startup errors
  package.json            private, dependency-free manifest (start/test/bench)
  openapi.json            the OpenAPI 3.1 document, served at /openapi.json
  src/
    http.js               routing, bearer auth, body parsing, error envelope, jitter
    ledger.js             the domain, including every [FAULT …] branch
    faults.js             the catalog, tiers, categories, LEDGER_FAULTS parsing
    variants.js           the conforming-variant catalog and LEDGER_VARIANT parsing
    rng.js                seeded PRNG and identifier tokens
  bench/
    bench.js              CLI
    pins.js               instrument pins: verify / re-record
    oracle-pins.json      the recorded digests and vendored-copy statuses
    lib/trace.js          the common trace form and route classification
    lib/sources.js        run-directory, HAR, Schemathesis, and report adapters
    lib/oracles.js        the deterministic oracles
    lib/suite-report.js   the playtest.suite-report/v0 reader and normalizer
    lib/witnesses.js      per-fault manifestation witnesses (funnel stages 2–3)
    lib/funnel.js         column two, citation resolution, the five-stage funnel
    lib/score.js          both columns, per-category aggregation, false positives
    lib/report.js         plain-text report
  test/
    support/              in-process harness, manifestation probes, recorders, schema validator
    *.test.js             the suites above
```

## Interpretation notes

Where DESIGN §6 leaves a rule open, the fixture takes the most testable
deterministic reading. These are the choices, so a probe author, a comparator,
and a reviewer all read the same contract:

1. **Fee rounding** is half away from zero on the basis-point component only
   (`25 + round_half_up(amount * 15 / 10000)`), charged to the source on top of
   the amount and credited to a per-currency system fee account with the fixed
   ids `acc_fee_usd` / `acc_fee_eur` — fixed so any client can enumerate the fee
   side of a transfer without discovery.
2. **The daily limit** is 100 000 minor units per source account per ledger
   day, and the boundary is *inclusive*: an amount bringing the day's total
   exactly to the limit is accepted. Usage is reserved at creation and is not
   released by a cancellation or a failed settlement. The ledger day advances
   only via `POST /admin/tick {"advance_day":true}`, because a wall-clock day
   would reintroduce the race the fixture exists to avoid.
3. **Settlement re-checks funds.** A transfer whose source can no longer cover
   it ends `failed` and writes *no* entries, so conservation is stated over
   settled transfers only and failed ones are not a counterexample.
4. **Deposits** require an active account, settle immediately, and are the
   declared conservation exception (a deposit entry has no counter-entry).
5. **Closure is a soft delete.** `GET /accounts/{id}` answers `410` with a
   tombstone; the account disappears from listings unless
   `include_closed=true`; `GET /accounts/{id}/entries` keeps serving history, so
   a closed account's ledger can still be audited. System fee accounts cannot be
   closed.
6. **Idempotency** is scoped to `(principal, key)`. A replay of the same body
   returns the original transfer with `200` and `Idempotency-Replayed: true`;
   the same key with a different body is `409` and creates nothing. Keys are
   recorded only for transfers that were actually created, so a rejected request
   does not burn its key.
7. **Pagination** is newest-first with a cursor over the entry sequence. The
   declared model is cursor-monotone, not snapshot-consistent: a page returns
   entries strictly older than the cursor, so a write during an enumeration may
   be *missed* but can never be duplicated. "No skips" and exact totals are
   explicitly not promised, and the pagination invariant is stated as identity
   only.
8. **Determinism** comes from a mutation counter, not a clock: timestamps are
   `2026-01-01T00:00:00Z` plus the counter in seconds, and identifiers are a
   pure function of the seed. The same request sequence after the same reset
   produces byte-identical resources, which is what makes a reproduced
   counterexample re-verifiable.
9. **Principals own accounts.** There are three principals — `admin`,
    `customer_a`, `customer_b` — one bearer token each. An account records the
    principal that opened it in `owner_principal`, and ownership never
    transfers. A customer principal may read, fund, activate, close, spend
    from, and cancel against only its own accounts; anything else is `403`
    with the standard envelope. The system fee accounts are readable by every
    principal (the fee side of a transfer is public) and actable by none. A
    transfer is readable by the principals owning either side, so being paid
    by a stranger reveals the transfer without revealing the payer's account.
    Authorization is evaluated **after** existence and **before** state: an
    unknown id is `404`, another principal's account is `403`, and only a
    reachable account's state yields `409`/`410`.
10. **Status-code split**: `400` for a malformed or wrongly typed request
    (`invalid_request`, `invalid_json`, `invalid_cursor`, `invalid_limit`),
    `422` for a business rule refusing an otherwise well-formed request
    (`invalid_amount`, `same_account`, `currency_mismatch`,
    `insufficient_funds`, `daily_limit_exceeded`, `unsupported_currency`),
    `409` for a state conflict, `410` for a tombstone. Path decoding and body
    parsing happen before routing, so a malformed percent-encoding in an id
    segment or an unparseable JSON body makes *any* operation but the two
    public ones answer `400` — and the document declares `400` on each of
    them, because a status the service really answers and the document omits
    would fail a spec-driven gate on a correct build.
    The sharp edge is `amount`, and the two sides are decided by *type* and
    not by value: `"ten"`, `1.5`, `true`, `null` and an absent `amount` are
    wrongly typed and answer `400 invalid_request`, while `0` and `-100` are
    perfectly well-typed integers the business declines and answer
    `422 invalid_amount`. The same rule governs `currency`: absent or
    non-string is `400`, a string naming a currency this ledger does not carry
    is `422 unsupported_currency`. The `400` code list is a list of *codes*,
    not of fields — any wrongly typed field answers `invalid_request`.
11. **Faults are configuration, not API.** They can only be set through the
    environment (or the in-process constructor used by tests). There is no
    endpoint, header, or response field that reveals them, because a probe under
    measurement must not be able to read the answer key off the wire.
12. **Variants are configuration too, and they are not faults.** Like faults they
    are environment-only and never disclosed over HTTP. Unlike faults they must
    keep every declared invariant and every documented schema true: the fixture's
    own suite proves each variant is oracle-clean *with the relevant oracles
    actually applicable*, because a variant that quietly stopped exercising an
    oracle would be a silent hole in the study's false-positive scoring rather
    than a conforming build.
13. **The bench's trace boundary.** A trace is one arm's HTTP traffic in wire
    order. Oracles that need a known starting world — the phantom-effect rule —
    require the trace to contain a successful `POST /admin/reset`; without that
    anchor they report *not applicable* rather than guessing. Balance agreement
    likewise requires a balance read and a complete enumeration with no write in
    between.
14. **Bodies are strict; query strings are not.** Every request schema declares
    `additionalProperties: false`, so an unrecognized body property is
    `400 invalid_request` with `details.field` naming it — a typo, a header
    sent in the body, or a field from a newer client is refused rather than
    silently dropped. An unknown *query* parameter is ignored, which is the one
    declared exception to "documented parameters have their documented effect".
    `POST /admin/tick` enforces its two properties' types the same way rather
    than coercing them.
