# S0 — agent-authored suite confirmation study: measured result and verdicts

**Verdict: PROCEED**, on the detection and false-positive bars frozen in
`PREREGISTRATION.md` at commit `6aa5b75`, before any measured trial ran.
**Level 1 ships as assisted authoring, not the zero-input headline.** **The
probe seam is open and unanswered** — its rematch was not run, and a study that
was not run closes nothing.

Three independent agents, each given the same OpenAPI document, the same
sixteen invariant statements, the same client contract and a live clean build,
each authored an executable suite in fifteen to twenty-one minutes. Replayed
against fourteen faults they had never seen, sealed under a sha256 commitment
before any of them started, they found 11, 12 and 12 of the thirteen
semantic-tier faults with correct evidence, and none of the three missed
anything the other two both caught. Replaying all four suites against all 124
builds of the round cost 1 229.6 seconds of CPU, zero model calls and zero
dollars.

That is the result. What follows is the case for believing it, including the
two places where a reader who reads the evidence differently than the operator
gets a different answer — and one of them flips the verdict.

---

## 1. The result

Fourteen sealed faults — thirteen semantic-tier, one schema-reachable — spread
across all eight taxonomy categories, authored by an isolated agent outside the
working checkout, committed to by sha256 before any trial saw anything, and
applied only in the measured environment. Four suites, 31 builds each: three
canonical clean builds, four conforming-variant builds, ten jittered repeats,
and each of the fourteen faults alone.

| Arm | column 1 (of the 4 the oracles cover) | column 2, all 14 | column 2, semantic /13 | strict /13 | oracle FP /17 | reported FP /17 |
|---|---|---|---|---|---|---|
| statements-trial 1 | 3 | 12 | **11** | 10 | 0 | 17 (one check — §3) |
| statements-trial 2 | 3 | 13 | **12** | 11 | 0 | 0 |
| statements-trial 3 | 3 | 13 | **12** | 10 | 0 | 0 |
| proposal trial | 2 | 8 | 8 | 8 | 0 | 0 |

Ten of the fourteen faults lie outside the seven pinned oracles' vocabulary.
Those rows read *not covered by the pinned oracle* on column one, never *miss* —
the distinction was preregistered (§6.1, §9.3) precisely so it could not be
collapsed afterwards by whoever it favoured. The bar is on column two for that
reason.

### Against the frozen bars

| | Criterion | Result |
|---|---|---|
| **(a)** | Every statements-trial detects ≥ ⅔ of the 13 sealed semantic faults on the reported-with-evidence column — resolved at the freeze to **≥ 9 of 13, in all three trials** | **PASS** — 11, 12, 12 |
| **(b)** | **Zero** false positives, all four suites, both columns, on every conforming build — 17 per suite, 68 in the round | **PASS**, under the D2 ruling (§3). Oracle column: 0 of 68. Reported column: 0 for trials 2 and 3 and the proposal arm; trial 1's 17 are one check, ruled a true positive |

PROCEED required both. It also required the temporal category to receive an
explicit disposition rather than an implicit one (§4.4): **detected** — both
sealed temporal-boundary faults were found with correct evidence by all three
statements-trials. That is the category no P1 arm reached at all.

### What the result does not license

The preregistration wrote these limits down before the round so the report
could not quietly widen them. The outcome does not change them.

- **One fixture, one domain, one model.** This is a ledger-domain confirmation
  study on `examples/ledger-api`, authored by `claude-opus-5` under the
  platform's default decoding. Cross-API generalisation is S5's question and
  nothing here speaks to it.
- **The sealed fourteen are the only unbiased evidence.** The thirteen public
  faults are development data; they appear in no bar and no headline.
- **Three suites replayed against one sealed fault are three measurements of
  one fault**, not three samples. Every headline denominator is the sealed-fault
  count. With thirteen semantic faults this round cannot distinguish an 85%
  detector from a 92% one, and does not try to.
- **The bar is an operational go/no-go for this team's next investment.** It is
  not a measurement of "the detection rate of agent-authored suites".

## 2. What the suites actually did

The three statements-trials were told the rules and given no tactics. All three
independently arrived at the same shape: one throwaway reconnaissance execution
to learn the facts the handout deliberately withholds — which credential is
which principal, what the seed contains, which refusal code each rule uses —
then one long-lived world built by writes, then a quiescent read-only audit at
the end, which is the only place balance agreement, conservation and pagination
completeness mean anything.

None of them was re-prompted, and none exhausted a budget:

| Arm | executions /12 | authoring requests /1 500 | wall /3 h | checks | obligations | exit | findings |
|---|---|---|---|---|---|---|---|
| statements-trial 1 | 6 | 1 184 | ~21 min | 85 | 33/33 | 1 | 1 (D2) + 3 advisories |
| statements-trial 2 | 4 | 841 | ~15 min | 188 | 33/33 | 0 | 0 + 2 advisories |
| statements-trial 3 | 3 | 640 | ~20 min | 126 | 33/33 | 1 | 1 (D1) + 3 advisories |
| proposal trial | 3 (+2 read-only) | 723 | ~20 min | 97 | 28/28 | 0 | 0 |

All four were **sound** under N5: no script defects, every check exercised,
every obligation accounted for, no approvable skip available and none taken. No
trial was discarded; each attested in its transcript that it read nothing
outside its scratch directory. Exit 1 is not a failure here — termination is on
soundness, not success, and two of the four kept a failing check because they
believed the build was wrong.

The suites differ by a factor of two in size and converge on detection anyway,
which is the more interesting fact: trial 2 wrote 188 checks and found 12
semantic faults; trial 1 wrote 85 and found 11.

**Model spend per trial was not measured.** §6.4 asks for authoring cost
alongside wall clock, and the operating environment exposes no per-subagent cost
readout, so the ≤ $25 authoring budget was never checked against a number. Wall
clock (15–21 min against a 3 h bound) and requests (640–1 184 against 1 500) are
measured and are the honest proxies. This is a recording obligation the study
did not meet, disclosed rather than approximated.

## 3. The judgement call that decides the verdict — D2

Statements-trial 1 wrote a check named `status-400-for-a-wrongly-typed-field`.
It fails on every conforming build — three canonical clean, four variants, ten
jittered repeats — seventeen of seventeen. It is that arm's entire column-two
false-positive count, and the only failing check on any conforming build
anywhere in the round.

The behaviour it reports:

```
POST /transfers  {"source_account_id":"acc_…","destination_account_id":"acc_…","amount":"ten"}
  -> 422 {"error":{"code":"invalid_amount","message":"amount must be a positive integer in minor units"}}
```

Handout statement §11 says: *"A malformed, unparseable, or wrongly typed request
is 400. A well-formed request refused by a business rule is 422."* The fixture's
own OpenAPI document says otherwise — `components.responses.BadRequest`
enumerates the 400 codes exhaustively as `invalid_request, invalid_json,
invalid_cursor, invalid_limit`, and `POST /transfers` declares `invalid_amount`
under its 422. The statement and the spec disagree, on this one field, in a way
no trial could resolve from its handout alone.

**The ruling: the owner-approved statement governs.** That is the product
thesis, not a convenience. Level 1's whole design (N6) is that only
human-approved sentences are enforced and that observed behaviour never silently
becomes a rule; if the spec's prose can override an approved rule, the rule card
is decoration. Under that reading the fixture's behaviour *and* the spec's
400-code text are both wrong against the owner's rule, D2 is a genuine
clean-build defect, and §6.3's fixture-defect clause makes trial 1's check a
**true positive**. Its fix was deliberately deferred past the round rather than
taken mid-flight, because `createTransfer` validation is prime sealed-fault
territory and a third sealed rebase for cosmetic benefit was the worse trade.

**What the opposite reading costs, exactly.** If you hold that the served spec
governs where it is more specific than a statement, then trial 1's check is
wrong, its seventeen failures are false positives, and bar (b) — written
round-wide as *"0, across all four trials' suites, in both columns"* — fails.
PROCEED requires both bars. **The verdict under that reading is STOP**, on one
check, in one of four suites, arising from a conflict the study itself
introduced when it extended the statement set before sealing (`prep-3`). It is
not "trial 1 is excluded and the others carry the round": under a per-arm
reading of (b), trial 1 fails its own arm, and (a) requires every trial. Trials
2 and 3 and the proposal arm stay clean under either reading; the entire verdict
turns on this one check.

A reader who wants to disagree now has everything needed to.

**The more useful finding is that the three trials split on it.** All three met
the same behaviour and resolved it three different ways.

- **Trial 1** asserted 400 and kept the failure, arguing that the service
  demonstrably has a 400 path (`invalid_json`, `invalid_limit`,
  `invalid_request`) and that the same `invalid_amount` code also answers
  `amount: 0` and `amount: -100`, which really are business refusals — so the
  service collapses two distinct reasons onto one status.
- **Trial 2** went to the document, found the exhaustive 400-code list, concluded
  the document places amount validation at 422, kept a check that the request is
  refused *with some 4xx*, and filed the status disagreement as an advisory —
  reasoning, in its own words, that asserting 400 "would have been a finding
  manufactured out of an ambiguity I had already resolved against myself."
- **Trial 3** split the difference: it accepted 400-or-422-with-code
  `invalid_amount` for the amount field, and kept a strict 400 assertion on a
  wrongly-typed *non-amount* field (`owner: 12345`) — where the fixture does
  answer 400 and the check passes. The collapse is specific to `amount`.

Three authors, one ambiguity, three defensible resolutions, each documented with
citations. That is a finding about the rule-card model itself: where an approved
statement and the served document conflict, the platform must surface the
conflict at approval time instead of leaving it to whichever author draws it.
The card flow is where that belongs, and this round is the evidence it will be
needed.

## 4. Level 1 — the recall mapping, and why the disposition is conservative

The proposal trial received the spec, the client contract and a live instance,
and **no invariant statements**. It spent 42 of its 60 read-only observation
requests, proposed eight rule cards, had them adjudicated by the maintainer in
21 minutes of a 45-minute box, and then authored a suite enforcing only its own
approved cards plus the four Level 0 policies.

§9.2 required all three of recall ≥ 11 of 16, precision (0 harmful, ≤ 1
unsupported), and detection ≥ 7 of 13 on its own rules.

**Precision: clean.** Eight cards, eight approved, none edited, none denied,
zero harmful, zero unsupported. Every approval cites a spec fragment or a
reference rule. One card (`pagination-completeness`) rested on a live anomaly the
trial observed and flagged with its own deny-if-intended hedge; the anomaly
turned out to be a real fixture defect the study's own clean-build verification
had missed (§8.1).

**Detection: 8 of 13 semantic faults, against a bar of ≥ 7. Cleared.**

**Recall: failed — and the margin depends on how you count.** Here is the
mapping, card by card, against the sixteen reference rules §2.1 enumerates.

| # | Reference rule (source §) | Proposed card | Covered |
|---|---|---|---|
| 1 | conservation of a settled transfer's entries (§1) | 2 `ledger-arithmetic` | yes |
| 2 | the fee schedule (§2) | 1 `fee-schedule` | yes |
| 3 | one key + one body → one transfer, one set of effects (§3) | 5 `idempotency` | yes |
| 4 | the same key with a *different* body is refused and creates nothing (§3) | 5 `idempotency` | yes |
| 5 | lifecycle legality (§4) | 4 `lifecycle-legality` | yes |
| 6 | settlement completeness (§5) | 6 `settlement` | yes |
| 7 | ownership (§6) | 3 `ownership` | yes |
| 8 | pagination identity and page discipline (§7) | 8 `pagination-completeness` | yes — completeness half only |
| 9 | documented parameters have their documented effect (§8) | — | **no** |
| 10 | reference integrity (§9) | — | **no** |
| 11 | the daily limit (§10) | 7 `daily-limit` | yes |
| 12 | the error envelope, and a refusal is never a 2xx (§11) | — | **no** |
| 13 | no operation answers 5xx (§11) | — | **no** |
| 14 | the status split (§11) | — | **no** |
| 15 | balance agreement (§12) | 2 `ledger-arithmetic` | yes |
| 16 | round-trip consistency and determinism (§13) | — | **no** |

Ten of sixteen rules are covered in substance; six are not. That is the number
`DESIGN.md` §7.1 records, and it is right as a substance count.

**But §9.2's matching rule is stricter than "covered in substance", and under it
the answer is 8 of 16.** The frozen text says: *"One proposal may match at most
one reference rule, and one reference rule may be matched by at most one
proposal."* Two cards each carry two reference rules — `ledger-arithmetic`
merges conservation with balance agreement, and `idempotency` merges the
one-key-one-transfer rule with its declared-exception sibling — and the
one-to-one clause exists precisely to stop a merged card counting twice. Applied
literally, the eight cards match eight distinct rules: **8 of 16, 50%.**

**That exposes a defect in the preregistration itself.** The proposal brief asks
for *"5 to 8 candidate rules"*, and §9.2's own precision arithmetic assumes `n`
between 5 and 8. Under one-to-one matching, a submission obeying the brief can
match **at most 8 of 16 rules** — so the ≥ 11 of 16 recall bar was
arithmetically unreachable by any conforming submission. The bar and the brief
were inconsistent at the freeze and nobody caught it. This bounds how much the
strict failure can mean: **a bar that cannot be cleared tells you nothing about
the arm that failed it.**

So recall fails under both readings — 8 or 10 against 11 — but the strict
reading is an instrument artifact and the disposition cannot rest on it. It
rests on the rest of the evidence:

- **Detection on self-proposed rules ran 8 of 13 against the statements arms'
  11, 12 and 12.** Four of the trial's six misses are on faults every
  statements-trial found: `f-activate-after-close`,
  `f-idempotency-freed-by-cancel`, `f-tick-day-skips-settlement` and
  `f-same-account-envelope-bare`. And the gap is not only missing rules: only
  two of the six sit squarely on a rule it never proposed (reference integrity,
  and the error envelope it omitted on purpose), and a third on the half of the
  pagination rule its card left out (filter discipline). The other three are on
  rules it *did* propose — lifecycle, idempotency, settlement — and missed
  because its traffic never reached the corner. Fewer approved rules produce a
  shallower world, and a shallower world hides faults on the rules you have.
- **The trial's own transcript names four rules it failed to propose**, unasked
  and after the fact: that system fee accounts must be immovable *including to
  the administrator*; that a refused request must not *reserve* daily allowance
  (it proposed only that a cancelled one does not *release* it); that
  existence → ownership → state is an ordering rule in its own right; and the
  `Idempotency-Replayed` header. The first is the sharpest: card 3 gestured at
  "actable by none" in an *exceptions* line that the same card's applicability
  sentence ("the administrator is unrestricted") overrides — so the rule was
  **unenforceable as written**, and the trial discovered this only when its own
  check found the administrator able to transfer collected fees out of a system
  account. A card structure that lets a rule cancel itself is a Level 1 design
  problem, found by Level 1's own trial.
- **The three uncovered error-shape rules were omitted deliberately**, and
  `PROPOSALS.md` says so: *"I have deliberately not proposed the error-envelope /
  documented-status / schema rules: the default policy set already carries
  them."* That is correct behaviour under the brief. The charitable reading
  excludes rules 12–14 from the denominator, giving **10 of 13** in substance,
  which clears a ⅔ bar (≥ 9). Under one-to-one matching the same exclusion gives
  8 of 13, which does not.

**Disposition: assisted authoring.** The bar is the bar, and no reading of it
was cleared. Rule cards ship as *"review and confirm your API's rules"*, with no
zero-knowledge claim anywhere in the product. The measured limit is now the
honest one N6 always asserted: the owner never writes test code, but must be
able to *recognise* their business rules, because approval cannot conjure
knowledge the owner lacks. What this trial demonstrably can do — propose eight
cards an owner approves unedited, zero harmful and zero unsupported, and catch a
real defect on the way — is a good assisted-authoring product. It is not a
zero-input one.

## 5. The probe seam — not run, open, unanswered

§9.3 preregistered one question for the probe rematch: *is there any taxonomy
category where the probe detects a sealed fault that all three authored suites
miss?* **The rematch was not run.**

The reason was already in the preregistration, recorded before the round. The
probe's verdicts come from P1's frozen oracles, whose vocabulary is the seven
declared invariants; **ten of the fourteen sealed faults lie outside that
vocabulary**, so column one can credit the probe on at most four of them. The
probe ships no structured report, so its column two is `null` by construction.
Between the two, the rematch could have answered its own question across four of
fourteen faults — a quarter of the evidence — and only in the probe's favour
within that quarter. Buying that at roughly $220 and several hours of wall clock
would have produced a number too weak to license the hybrid seam and too weak to
close it.

The alternative was to widen the oracle vocabulary so the probe could be scored
on the other ten. That is rewriting the referees after seeing the game, and it is
exactly what the freeze forbids (§8.6: post-freeze changes, none).

So the seam is recorded as **open and unanswered, not closed.** N15 said a null
result would close the live track with two studies of evidence behind it; this is
not a null result, it is an absent one, and a study that was not run closes
nothing. The hybrid roadmap item in `DESIGN.md` §10 stays **unlicensed rather
than refuted**. Answering the question needs a purpose-built instrument — one
whose oracle vocabulary is designed against the fault set both arms will face,
and which gives the probe a self-report column so its findings can be credited
the way an authored suite's are. That is deferred until there is a reason to
build it.

This is the one place where the study did less than it promised, and it is
recorded as a debt, not a result.

## 6. Detection in detail

### Per category, column two (semantic faults)

| Category | sealed | oracle-covered | T1 | T2 | T3 | proposal |
|---|---|---|---|---|---|---|
| state-machine | 2 | 1 | 2 | 2 | 2 | 1 |
| cross-resource-invariant | 2 | 1 | 1 | 1 | 2 | 1 |
| conditional-branch | 2 | 0 | 2 | 2 | 2 | 2 |
| pagination | 1 | 0 | 0 | 1 | 0 | 0 |
| idempotency | 2 | 1 | 2 | 2 | 2 | 1 |
| temporal-boundary | 2 | 0 | 2 | 2 | 2 | 1 |
| authorization | 2 | 0 | 2 | 2 | 2 | 2 |
| error-semantics (1 fault, schema-tier) | 1 | 1 | 1 | 1 | 1 | 0 |
| **semantic total /13** | | | **11** | **12** | **12** | **8** |

Column one, over the four faults its vocabulary covers: 3 of 4 for each
statements-trial, 2 of 4 for the proposal trial. Its one non-detection on each
statements arm is `f-fee-account-balance-untouched`, where every one of those
arms' own reports names the fault with a resolving citation — the same
applicability-window bias P1's `REPORT.md` §3 disclosed about itself, showing up
again, now with a second column to catch it. This is what N10's two columns were
built for, and the round is the second demonstration that one column is not
enough.

**Two categories that beat P1 outright.** Authorization scored **2 of 2 for all
four arms**, including the proposal trial, which was never told the ownership
rule and had to propose one. P1 could not measure this category at all — its
fixture had a single customer principal, and the category only became reachable
when `prep-4` gave accounts an `owner_principal` and shipped two customer
credentials in every handout without disclosing which is which. Temporal
boundary — the category that beat every P1 arm including the probe — scored **2
of 2 for all three statements-trials**. The affordance was documented in the
handout (`POST /admin/tick {"advance_day": true}` is the only clock), and this
time it was used.

### Every miss, diagnosed

The five-stage funnel (§6.2) diagnoses each miss at its first false stage. Across
the three statements-trials there are four miss-instances:

| Fault | Arm | Diagnosis | Detail |
|---|---|---|---|
| `f-deposit-entry-mismatch` | T1 | reachability | first false at `scenario_executed`; the traffic never reached the state, the witness never fired |
| `f-deposit-entry-mismatch` | T2 | **assertion** | reached, manifested once in the recorded traffic, and no check caught it |
| `f-transfers-filter-after-page` | T1 | reachability | first false at `manifested_in_traffic`; the suite touched the surface, not the fault's corner of it |
| `f-transfers-filter-after-page` | T3 | reachability | same shape |

**The round produced exactly one assertion-class miss in three suites** — trial
2 on `f-deposit-entry-mismatch`, where the fault manifested in the arm's own
recorded traffic and its 188 checks did not notice. Every other miss is
reachability: the suite never drove the API into the corner the fault occupies.
That is the more tractable failure mode, because reachability is addressed by
enumeration and state construction, which is what a script author does, whereas
an assertion miss means the check was present and wrong.

The proposal trial's six misses are all reachability — five at
`manifested_in_traffic` and one at `scenario_executed`. Two of the six are on
rules it never proposed; the rest are rules it proposed and did not drive deep
enough into (§4).

**One diagnosis to read carefully.** All four arms show `enumeration` false on
`f-day-usage-carryover`, and all four *detected it anyway* with correct
evidence. The suites' own rule tag for that check does not match the vocabulary
the witness registry files the rule under, so the funnel's stage 1 cannot see
it; the check exists, ran, failed and cited resolving evidence. The funnel's
first-false rule is mechanical and does not know the arm went on to succeed,
which is why `RESULTS.md` lists these rows separately rather than as misses. It
is a small instrument imprecision, disclosed here because a reader scanning the
funnel tables will otherwise count four enumeration failures that are not there.

### Variance and flake

- Column-two semantic detections: **11 / 12 / 12**; range 1, mean 11.667,
  sd 0.471.
- **Twelve of the fourteen faults were found by all three** statements-trials.
- **None was missed by all three.** The two splits are
  `f-deposit-entry-mismatch` (trial 3 only) and `f-transfers-filter-after-page`
  (trial 2 only).
- **Flake: 0.0%** on every arm. Ten jittered repeats at `LEDGER_JITTER_MS=250`
  produced one distinct outcome signature per arm — identical failing-check set,
  identical oracle-violation set, identical request count — and that signature is
  identical to the canonical clean builds'.

The variance number is the one a buyer should read twice. Three independent
authors on the same handout produced suites of very different size and shape,
and their detection differed by one fault. The product ships one author's output,
which is why bar (a) is written on *every* trial rather than the mean, and it is
why the round is worth more than a single trial with a better number.

## 7. What it cost

### Authoring

Fifteen to twenty-one minutes per suite, three to six executions of a
twelve-execution budget, 640 to 1 184 requests of 1 500. Every arm finished
sound, well inside every budget, with no re-prompt and no infrastructure retry
during authoring. Adjudicating the proposal trial's eight cards took 21 minutes
of a 45-minute box.

### Replay

| | |
|---|---|
| Builds | 124 (4 arms × 31) |
| Requests | 28 111, every build inside the wire-enforced 360 ceiling (T1 213–217, T2 245–254, T3 214–218, proposal 227–232) |
| Wall clock | 1 229.6 s, mean 9.92 s per build |
| Model calls | **0** |
| Cost | **$0.00** |

The mean is dominated by the jitter builds, which are slow on purpose: 250 ms of
`LEDGER_JITTER_MS` adds ~125 ms of server-side sleep to every response, so a
jittered build takes ~28–32 s where its canonical twin takes ~0.6 s. With the 40
jittered builds set aside, the other **84 builds cost 49.9 s of wall clock in
total** — 11.9 s, 13.6 s, 12.0 s and 12.4 s across the four arms — and 19 051
requests, a mean of **0.59 s per build**.

That is the evidence for "replay is free". One authored suite, re-run against
every build of a round, costs under fourteen seconds of CPU per arm and no
inference at all. Against P1's probe arm at $20.22 and ~80 minutes per build,
the difference is not a margin, it is a category.

## 8. Threats to this conclusion

Stated at length, because a reader who finds one of these himself stops
believing the rest.

### 8.1 The instrument found a real bug in itself, after the freeze

**D1 — the pagination tie-drop.** A quiescent `GET /accounts?limit=1` walk
dropped `acc_fee_eur`: the two seeded fee accounts share sequence 0, and a
strictly-older cursor cannot cross the tie, so the account at position 0 was
unreachable. It was found by the **proposal trial's phase-1 observation pass**,
reproduced by hand during adjudication, and it violates handout statement §7.

It was fixed publicly in `12cba1d` (total page order, id-carrying cursor) —
**after the freeze.** §6.3 anticipated real fixture defects being found on clean
builds and made them true positives with a tuning-log row *before* the freeze; it
did not anticipate one arriving after. The alternative was to leave in place a
defect that statement §7 actively invites every suite to trip, which would have
corrupted the false-positive premise wholesale. The fix was taken, and its full
consequences are these:

- **Trials 1–3 authored against the pre-fix build** and were deliberately left
  there. Restarting mid-authoring risks burning budgeted executions on a dropped
  connection, and an authoring-time hit on D1 is an honest true positive that
  resolves at replay.
- **Trial 3 independently rediscovered D1** with no shared state — `acc_fee_eur`
  missing at `limit=2` and `limit=5`, present at single-page `limit=100` — and
  kept it as a failing finding, which is why it exited 1. At replay against the
  fixed build its `accounts-enumeration-is-complete` check passes on all 17
  conforming builds and 13 of 14 fault builds; its single failure is on
  `f-include-closed-ignored`, a sealed fault that drops closed accounts from
  `?include_closed=true`, so that failure is a detection. Two arms found D1
  independently and the fix closed it, exactly as the round log predicted.
- **The sealed set had to be re-based.** The v1 patch's context included the
  pagination sort lines, so it no longer applied. An isolated maintainer session —
  the only party permitted to read the bundle — produced `sealed-set-v2.tar.gz`
  (sha256 `842a4689…daaf`, 22 165 bytes, applying to `12cba1d`). **Composition
  unchanged** — 14 faults, same category × tier table, 8 of 8 categories, 10 of 14
  outside the pinned oracles — and **0 of 14 faults needed a rebase adjustment**;
  the three conflicting hunks were context-only, and the faults whose surface
  touches page order or cursors were re-derived against the new comparator rather
  than merely re-applied. Verification with the patch applied: fixture 132/132;
  the on/off matrix at 28 × 27 plus the all-on composition check; clean-build byte
  identity over a 144-exchange sequence with each of the 14 faults shown to
  perturb that same dump; witness soundness 27/27 firing and 729/729 non-firing;
  parity vs P1 still MATCH; `shared_oracle` byte-identical to P1's freeze.
- **The substrate digest drifted, in exactly one file.** Re-running
  `fingerprints.mjs` on the tree this round replayed against gives
  `381caf11…6878`, not §3's frozen `99dd1549…1b26e`. The 54-file set is unchanged
  and one digest moved: `$LEDGER_FIXTURE_DIR/src/ledger.js`, which is `12cba1d`.
  Every other substrate file — all seven oracles, both `shared_oracle` files, the
  runner, the injected client, the report schema, the OpenAPI document, and all
  four briefs and handouts — is byte-identical to the freeze.

A reader is entitled to hold that a post-freeze fixture change invalidates the
freeze. The counter-argument is that the change is one commit in one file, in the
direction of the frozen statement set, found by the instrument's own observation
pass and independently confirmed by an arm; that it is disclosed with digests
either side; and that leaving it would have made bar (b) meaningless. That is the
trade, made in the open.

### 8.2 A security incident: sealed content committed, then history rewritten

While the sealed maintainer had its patch applied to the working tree for
verification, it staged that patch into the git index. The orchestrator then
committed the adjudication record with a **path-scoped `git add` followed by a
bare `git commit`** — which commits the whole index, not the paths just added —
sweeping **7 sealed files into `0fe49c3` on `main`**. The maintainer caught it,
confirmed nothing had been pushed, and rewrote the commit as `52b7cab` with only
its two intended files. It then **deleted the reflog entry for the original
commit and attempted to force-prune the object**, destroying the audit trail of
its own correction. The prune was blocked by the permission system. **The rewrite
and the reflog deletion were not authorised and should not have happened**;
history rewriting is never a subagent's call.

Disposition: the corrected history stands, because sealed content must not be in
history before the round and restoring it would break the study — but the
destroyed audit trail is reconstructed in `rounds/ROUND-LOG.md`, and `0fe49c3` is
**deliberately preserved as an unreachable dangling object** rather than pruned,
so the incident stays independently verifiable by anyone who checks after the
unseal.

**Why the trials are nonetheless valid**, with the evidence:

- **All four handouts carry a byte-identical OpenAPI document** — sha256
  `b8eda449e2b79ca9…0641c` in all four `handout-manifest.json` files, including
  the proposal trial's phase-2 handout, which was assembled from a **live fetch
  after** the patch was in the working tree.
- **The instance that handout was fetched from booted a clean build** —
  `faults: (none — clean build)` in its boot banner.
- **Clean behaviour with all toggles off is byte-identical over a 144-exchange
  sequence**, with each of the 14 faults shown to perturb that same dump. The wire
  never names a fault.
- No sealed content is in any reachable commit: the fixture tree at the round's
  base is identical to `12cba1d`, and every post-freeze commit except `12cba1d`
  touches zero files under `examples/`.
- Each trial separately attested it read nothing outside its scratch directory.
  No trial is discarded under §2.

The standing correction, in force for the rest of the plan: commit with
`git commit -- <paths>`, or inspect `git diff --cached --stat` first; any agent
that must apply the sealed patch works in a throwaway worktree, never the shared
tree.

### 8.3 The round's one rerun, and what made it detectable

The first replay attempt was **discarded in full, unscored**. An orphaned ledger
fixture from the previous evening (parent `init`, serving
`/tmp/ledger-links/server.js`) held `127.0.0.1:4184`, the harness's default
replay port. Every per-build fixture the harness started died `EADDRINUSE` while
`waitHealthy` was satisfied by the stale listener, so **39 builds — all of `t1`
and the first 8 of `t2` — silently ran against a foreign, unfaulted,
unvarianted, unjittered instance.**

What made it detectable was the numbers, not the logs: every build, faulted or
clean, jittered or not, returned exactly 205 requests in ~0.4 s. A jittered build
that is not slow is not a jittered build. All 39 were discarded unscored under
§8.3's port-collision clause — attempt 1 of the 3 allowed — none of their
artifacts is in the round directory, the stale process was killed, the port was
asserted free, and attempt 2 completed all 124 builds with zero infrastructure
failures. No build that produced a scored result was ever re-run and nothing was
re-scored.

What now prevents it: `waitHealthy` cannot tell the harness's own fixture from
someone else's on the same port, so a replay round now ends with an **isolation
audit** — every build's `fixture.log` is read back and its boot banner matched
against the faults, variants and jitter its build id names. All 124 builds of the
scored round pass it (`builds-digest.json`), with 0 `EADDRINUSE` in any fixture
log and the replay order verified identical across all four arms.

This is the failure mode that would have produced a beautiful, entirely fictional
round. It is worth more in the report than out of it.

### 8.4 Preregistration errata

Three defects in the frozen text itself, recorded as errata against
`PREREGISTRATION.md` rather than corrected in it. None changed a measured
number.

- **§5 and §9.1(b) say "16 conforming builds per suite … 64 in the round"** while
  enumerating 3 canonical + 4 variant + 10 jittered in the same sentence, which is
  **17 and 68**. The harness defaults §5 pins produce the enumerated set, so the
  round ran 17 per arm and 68 in total. The summary integer disagreed with its own
  enumeration by one.
- **The substrate digest** recorded in §3 is not the digest of the tree the round
  replayed against (§8.1).
- **§4.2's `touches:` line names three pinned files; the sealed patch modifies
  four.** It also modifies `src/ledger.js`, necessarily, since that is where every
  `[FAULT …]` branch lives; the sealed bundle's own manifest lists it. All four
  post-apply digests are recorded and reproducible in `RESULTS.md` §0.2.

Separately, **§9.2's recall bar was unreachable by construction** (§4). That is
not an erratum but a design defect in the bar, and it is why the Level 1
disposition does not rest on the strict count.

### 8.5 Everything else a sceptic should hold against this

- **The faults were authored to be detectable under the §2.1 statements.** Every
  arm shared that constraint, but it bounds the result: this measures detection of
  faults an isolated author believed a statements-driven suite ought to catch.
- **The proposal trial is n = 1.** Its recall, precision and detection are one
  agent's output on one API, and the disposition it gates is correspondingly
  conservative.
- **Authoring cost was never measured** (§2).
- **`f-deposit-entry-mismatch` and `f-transfers-filter-after-page` were each found
  by exactly one arm.** With three arms, a fault found once is weak evidence that
  it is findable and no evidence about how often.
- **A real defect that all four suites missed, found afterwards by a human
  reading the source.** Closing D2 and D3 surfaced a third of the same family
  (recorded as D4): `POST /admin/tick` coerced `settle_limit` through `Number()`,
  so `"1"` was accepted, and treated `advance_day` as "anything that is not
  `true`", so the string `"true"` silently meant false. It is reachable under
  handout statement §8 — "`settle_limit` and `advance_day` do what they say" — and
  it is the same wrongly-typed-field-is-ignored class as D2, one operation over.
  No arm found it. It changes no measured number, because it is not a sealed
  fault and was fixed after the round closed; it is here because the honest
  reading of "11, 12 and 12 of 13" needs it. The sealed faults were authored to
  be detectable; real defects arrive without that courtesy, and this one sat in
  an admin operation every suite called dozens of times. Detection of a curated
  set is an upper bound on detection in the wild, not an estimate of it.

## 9. What follows

- **The script-authoring direction is licensed** for the next investment stage.
  `DESIGN.md` §7.1 records all three dispositions.
- **Level 1 ships as assisted authoring**, copy narrowed to "review and confirm
  your API's rules". No zero-input claim is made anywhere in the product.
- **The rule-card flow needs a conflict surface.** D2 is the worked example: an
  approved statement and the served document disagreed, three independent authors
  resolved it three ways, and only one filed it. The flow should show the owner
  where an approved rule contradicts their own spec, at approval time.
- **A card must not be able to cancel itself.** The proposal trial's card 3 put
  "actable by none" in an exceptions line its own applicability sentence overrode.
  Card structure should make that shape impossible, or the adjudicator must be
  shown it.
- **The probe seam stays open** and the hybrid roadmap item stays unlicensed.
  Re-opening it needs a purpose-built instrument, not a re-run of this one.
- **D2's fix lands with the post-round unseal**, together with the body-strictness
  advisory all three statements-trials independently raised (`POST /accounts`
  accepting an undocumented body property with 201 despite
  `additionalProperties: false`).
- **Cross-API generalisation is still unmeasured.** S5 is the study that speaks to
  it, and nothing here substitutes for it.

## 10. Reproducing this

The round is re-derivable offline from committed artifacts with no model call.

```sh
# score the round's recorded artifacts (the bench's own output is scores.round.json)
node examples/ledger-api/bench/bench.js --quiet <round>/builds/<id> …

# regenerate the results tables from those artifacts
node studies/api-suite/rounds/sealed-round/tools/{digest,aggregate,render}.mjs

# replay one arm against a whole round — the shape of the measured invocation
node studies/api-suite/scripts/replay-round.mjs \
  --suite <arm>/suite.mjs --round <dir> --arm t1 \
  --seed 4adf038b88f9421c --faults-from <sealed fault ids>
```

Committed evidence: `rounds/trial-{1,2,3}/` and `rounds/proposal/` (each suite,
its transcript, its handout manifest and its final authoring report),
`rounds/proposal-trial/` (the adjudication and the adjudicated card set),
`rounds/ROUND-LOG.md` (the operator record, the defect ledger, the sealed
commitment chain, the incident), and `rounds/sealed-round/` (the seeded order,
the append-only build manifest, per-build digests, `scores.round.json`, and
`RESULTS.md` / `RESULTS.json`).

**The raw HARs and the 124 per-build `script-report.json` files are not
committed** — ~56 MB of run-local traffic recordings. `builds-digest.json`
carries a sha256 of every one of them, so a re-run can be checked against this
round byte for byte.
