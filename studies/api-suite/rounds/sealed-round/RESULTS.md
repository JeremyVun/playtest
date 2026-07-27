# S0 sealed round — results

Generated 2026-07-26T06:44:17.981Z by the sealed-round operator, offline, from the
round's artifacts alone. **No verdict against `PREREGISTRATION.md` §9's bars is
recorded here** — that is the orchestrator's call in `REPORT.md`. This file is
the numbers.

| | |
|---|---|
| Round | `s0-sealed-1` |
| Replay-order seed | `4adf038b88f9421c` (§8.1) |
| Sealed bundle | `sealed-set-v2.tar.gz` sha256 `842a4689d3486db1…` |
| Sealed patch | sha256 `2d7a0d2875b448bd…`, 68 863 bytes |
| Sealed faults | 14 (13 semantic-tier, 1 schema-reachable) |
| Inside the pinned oracles' vocabulary | 4 of 14 — the other 10 read *not covered by the pinned oracle*, never *miss* |
| Arms | 4 — three statements-trials and the proposal trial |
| Builds per arm | 31 (17 conforming + 14 fault) |
| Builds in the round | 124 |
| Infrastructure failures recorded in this attempt | 0 |
| Model calls in the verdict path | 0 |

**One arithmetic note on §5, reported and not corrected.** The frozen text
says "16 conforming builds per suite … 64 conforming builds in the round", but
the list it enumerates in the same sentence is 3 canonical clean + 4 variant
builds + 10 jittered repeats, which is **17**, and 4 arms × 17 = **68**. The
harness defaults §5 pins (`--clean-repeats 3`, three variants plus the combined
build, `--jitter-repeats 10`) produce the enumerated set, so the round ran 17
conforming builds per arm and 68 in total. Nothing was added or dropped: the
preregistration's summary integer disagrees with its own enumeration by one.

## 0. Reruns and infrastructure failures (§8.3)

One infrastructure failure is on the record, and it invalidated a whole
attempt rather than a build:

- **Attempt 1 — discarded, port collision.** An orphaned ledger fixture from an
  earlier session (started the previous evening, parent `init`, serving
  `/tmp/ledger-links/server.js`) held `127.0.0.1:4184`, the harness's default
  replay port. Every per-build fixture the harness started died with
  `EADDRINUSE`, and `waitHealthy` was satisfied by the stale listener, so the
  31 builds of arm `t1` and the first 8 of `t2` ran against a foreign,
  unfaulted, unvarianted, unjittered instance. The give-away was in the
  numbers before it was in the logs: every build, faulted or clean, jittered or
  not, returned exactly 205 requests in ~0.4 s. All 39 attempt-1 builds were
  discarded unscored; none of their artifacts is in this round directory.
  This is §8.3's *port collision*, at attempt 1 of 3.
- **Attempt 2 — the scored round.** The stale process was killed, the port
  asserted free before the first build, and all 124 builds completed with **0**
  infrastructure failures. Every build's fixture log was then read back and
  matched against the configuration its build id names (§8 below), which is the
  check the harness cannot do for itself.

No other rerun of any kind was performed. No build that produced a scored
result was re-run, and no result was re-scored (§8.5).

## 0.1 Instrument verification (§4.2)

`verify-instrument.mjs` before applying the patch: bench pins match the tree;
the P1 vendored oracle copy in sync; sealed set matches its committed digest
(`2d7a0d28…b406`, 68 863 bytes); sealed set still applies. **Instrument
verified.**

After `git apply -p1` and `npm run bench:pins -- --write`: bench pins match the
tree; the vendored copy still in sync; digest still matches. The
*still-applies* row fails, necessarily and only because the patch is now
applied — `git apply -R --check` reverses cleanly, which is the post-apply form
of the same assertion. `shared_oracle` is unchanged either side of the apply:
`lib/oracles.js` `04a3c69f…131c`, `lib/trace.js` `8d822ce6…df64`, byte-identical
to P1's freeze. Re-recorded `bench_scoring` digests: `lib/score.js`
`38565dde…54ed`, `lib/witnesses.js` `5924fb6e…6f78`, `../src/faults.js`
`3ef70436…2ae4`.

Fixture suite with the patch applied and the pins re-recorded: **132 tests, 132
pass, 0 fail, 0 skipped**, as the sealed author's manifest requires.

## 0.2 Substrate drift, in two parts

§3 pins 54 substrate files and a substrate digest, and a reader will check it,
so both ways this round's tree differs from the frozen one are recorded here.
Neither decision is adjudicated here; both predate this round.

**(a) The unpatched tree: exactly one file.** `fingerprints.mjs` on the tree the
suites replayed against, before the sealed patch, gives **`381caf11…6878`** and
not the frozen **`99dd1549…1b26e`**. The file *set* is unchanged (54) and one
digest moved:

| File | at the freeze | at this round |
|---|---|---|
| `$LEDGER_FIXTURE_DIR/src/ledger.js` | `9fc4dd23…0325a3` | `e9b2cf1b…1ab887c` |

That is `12cba1d`, *ledger-api: make page order total so a quiescent walk drops
nothing* — the D1 fix, taken after the freeze and recorded in `ROUND-LOG.md`
with the sealed set's rebase onto it. Every other substrate file is
byte-identical to the freeze: all seven oracles, both `shared_oracle` files, the
runner, the injected client, the report schema, the OpenAPI document,
`oracle-pins.json`, and all four briefs and handouts.

**(b) With the sealed patch applied, four pinned files differ, not three.**
§4.2 anticipates the patch extending `src/faults.js`, `bench/lib/witnesses.js`
and `bench/lib/score.js`, and instructs the operator to re-record them. The v2
patch also modifies **`src/ledger.js`** — necessarily, since that is where every
`[FAULT …]` branch lives — and `src/ledger.js` is one of the 54. The sealed
bundle's own manifest lists it; §4.2's `touches:` line does not. The measured
digests, all four reproducible by applying the patch to this tree:

| Pinned file | pre-seal (§3) | with the sealed patch applied |
|---|---|---|
| `src/ledger.js` | `e9b2cf1b…1ab887c` | `58435dc3…7e510b` |
| `src/faults.js` | `99224090…6e3d3e` | `3ef70436…2282ae4` |
| `bench/lib/witnesses.js` | `72a947d0…1304d8c9` | `5924fb6e…a9a8e6f78` |
| `bench/lib/score.js` | `a36caf69…93a9b10` | `38565dde…7a0bad54ed` |

`shared_oracle` — `lib/oracles.js` `04a3c69f…131c` and `lib/trace.js`
`8d822ce6…df64` — is untouched by the patch and byte-identical to P1's freeze,
which is the property the probe rematch depends on.

## 1. Per-fault detection, both columns

`n/c` = the fault's rule is outside the seven pinned oracles' vocabulary, so
column one **cannot speak to it** (§6.1). It is not a miss.

| # | Fault | Category | Tier | C1 covered | T1 c1/c2 | T2 c1/c2 | T3 c1/c2 | PROP c1/c2 |
|---|---|---|---|---|---|---|---|---|
| 1 | `f-activate-after-close` | state-machine | semantic | no | n/c / **yes** | n/c / **yes** | n/c / **yes** | n/c / no |
| 2 | `f-transfer-to-pending-destination` | state-machine | semantic | yes | **yes** / **yes** | **yes** / **yes** | **yes** / **yes** | **yes** / **yes** |
| 3 | `f-deposit-entry-mismatch` | cross-resource-invariant | semantic | no | n/c / no | n/c / no | n/c / **yes** | n/c / no |
| 4 | `f-fee-account-balance-untouched` | cross-resource-invariant | semantic | yes | no / **yes** | no / **yes** | no / **yes** | **yes** / **yes** |
| 5 | `f-eur-fee-flat` | conditional-branch | semantic | no | n/c / **yes** | n/c / **yes** | n/c / **yes** | n/c / **yes** |
| 6 | `f-include-closed-ignored` | conditional-branch | semantic | no | n/c / **yes** | n/c / **yes** | n/c / **yes** | n/c / **yes** |
| 7 | `f-transfers-filter-after-page` | pagination | semantic | no | n/c / no | n/c / **yes** | n/c / no | n/c / no |
| 8 | `f-idempotency-conflict-ignored` | idempotency | semantic | no | n/c / **yes** | n/c / **yes** | n/c / **yes** | n/c / **yes** |
| 9 | `f-idempotency-freed-by-cancel` | idempotency | semantic | yes | **yes** / **yes** | **yes** / **yes** | **yes** / **yes** | no / no |
| 10 | `f-day-usage-carryover` | temporal-boundary | semantic | no | n/c / **yes** | n/c / **yes** | n/c / **yes** | n/c / **yes** |
| 11 | `f-tick-day-skips-settlement` | temporal-boundary | semantic | no | n/c / **yes** | n/c / **yes** | n/c / **yes** | n/c / no |
| 12 | `f-entries-cross-principal` | authorization | semantic | no | n/c / **yes** | n/c / **yes** | n/c / **yes** | n/c / **yes** |
| 13 | `f-transfer-source-unowned` | authorization | semantic | no | n/c / **yes** | n/c / **yes** | n/c / **yes** | n/c / **yes** |
| 14 | `f-same-account-envelope-bare` | error-semantics | schema | yes | **yes** / **yes** | **yes** / **yes** | **yes** / **yes** | no / no |

### Totals per arm

| Arm | C1 detected / covered | C1 not covered | C2 detected /14 | C2 semantic /13 | C2 strict semantic /13 | reported-without-evidence |
|---|---|---|---|---|---|---|
| statements-trial 1 | 3 / 4 | 10 | 12 | 11 | 10 | 0 |
| statements-trial 2 | 3 / 4 | 10 | 13 | 12 | 11 | 0 |
| statements-trial 3 | 3 / 4 | 10 | 13 | 12 | 10 | 0 |
| proposal trial | 2 / 4 | 10 | 8 | 8 | 8 | 0 |

## 2. Per-category detection, both columns

A fault counts for its category once per arm, however many builds it appeared
in (§4.3, N12). `c1` is scored only over the faults the pinned oracles cover.

### statements-trial 1 (`t1`)

| Category | faults | semantic | C1 detected / covered | C2 detected | C2 semantic | missed on C2 |
|---|---|---|---|---|---|---|
| state-machine | 2 | 2 | 1 / 1 | 2 / 2 | 2 / 2 | — |
| cross-resource-invariant | 2 | 2 | 0 / 1 | 1 / 2 | 1 / 2 | `f-deposit-entry-mismatch` |
| conditional-branch | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| pagination | 1 | 1 | 0 / 0 | 0 / 1 | 0 / 1 | `f-transfers-filter-after-page` |
| idempotency | 2 | 2 | 1 / 1 | 2 / 2 | 2 / 2 | — |
| temporal-boundary | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| authorization | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| error-semantics | 1 | 0 | 1 / 1 | 1 / 1 | 0 / 0 | — |

### statements-trial 2 (`t2`)

| Category | faults | semantic | C1 detected / covered | C2 detected | C2 semantic | missed on C2 |
|---|---|---|---|---|---|---|
| state-machine | 2 | 2 | 1 / 1 | 2 / 2 | 2 / 2 | — |
| cross-resource-invariant | 2 | 2 | 0 / 1 | 1 / 2 | 1 / 2 | `f-deposit-entry-mismatch` |
| conditional-branch | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| pagination | 1 | 1 | 0 / 0 | 1 / 1 | 1 / 1 | — |
| idempotency | 2 | 2 | 1 / 1 | 2 / 2 | 2 / 2 | — |
| temporal-boundary | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| authorization | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| error-semantics | 1 | 0 | 1 / 1 | 1 / 1 | 0 / 0 | — |

### statements-trial 3 (`t3`)

| Category | faults | semantic | C1 detected / covered | C2 detected | C2 semantic | missed on C2 |
|---|---|---|---|---|---|---|
| state-machine | 2 | 2 | 1 / 1 | 2 / 2 | 2 / 2 | — |
| cross-resource-invariant | 2 | 2 | 0 / 1 | 2 / 2 | 2 / 2 | — |
| conditional-branch | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| pagination | 1 | 1 | 0 / 0 | 0 / 1 | 0 / 1 | `f-transfers-filter-after-page` |
| idempotency | 2 | 2 | 1 / 1 | 2 / 2 | 2 / 2 | — |
| temporal-boundary | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| authorization | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| error-semantics | 1 | 0 | 1 / 1 | 1 / 1 | 0 / 0 | — |

### proposal trial (`proposal`)

| Category | faults | semantic | C1 detected / covered | C2 detected | C2 semantic | missed on C2 |
|---|---|---|---|---|---|---|
| state-machine | 2 | 2 | 1 / 1 | 1 / 2 | 1 / 2 | `f-activate-after-close` |
| cross-resource-invariant | 2 | 2 | 1 / 1 | 1 / 2 | 1 / 2 | `f-deposit-entry-mismatch` |
| conditional-branch | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| pagination | 1 | 1 | 0 / 0 | 0 / 1 | 0 / 1 | `f-transfers-filter-after-page` |
| idempotency | 2 | 2 | 0 / 1 | 1 / 2 | 1 / 2 | `f-idempotency-freed-by-cancel` |
| temporal-boundary | 2 | 2 | 0 / 0 | 1 / 2 | 1 / 2 | `f-tick-day-skips-settlement` |
| authorization | 2 | 2 | 0 / 0 | 2 / 2 | 2 / 2 | — |
| error-semantics | 1 | 0 | 0 / 1 | 0 / 1 | 0 / 0 | `f-same-account-envelope-bare` |

## 3. The five-stage funnel, and every miss diagnosed

Stages: 1 obligation enumerated · 2 scenario executed · 3 fault manifested in
traffic · 4 assertion detected · 5 evidence correctly cited. `T`/`F`/`?`; the
first `F` is the diagnosis (§6.2). `?` is *the artifacts cannot answer*, never
a miss.

Two readings the tables below need, because the funnel is mechanical and the
first-false rule does not know whether the arm went on to succeed:

- **`reachability` covers two different failures.** A `F` at stage 2 means the
  suite never drove the API into the state the fault lives in. A `F` at stage 3
  means it *did* reach that state and the fault still did not manifest in the
  recorded traffic — the suite touched the surface but not the corner of it the
  fault occupies. The `first false stage` column separates them.
- **A row can be diagnosed and still be a detection.** The diagnosis is the
  first false stage whatever happens afterwards, so a fault whose stage 1 or 2
  reads `F` but whose stages 4–5 read `T` was detected with correct evidence and
  is credited on column two. Those rows are listed under "detected with an
  earlier stage false" rather than under misses.

### statements-trial 1 (`t1`)

| Fault | 1 | 2 | 3 | 4 | 5 | diagnosis | witness fired |
|---|---|---|---|---|---|---|---|
| `f-activate-after-close` | T | T | T | T | T | — (detected) | 1 |
| `f-transfer-to-pending-destination` | T | T | T | T | T | — (detected) | 1 |
| `f-deposit-entry-mismatch` | T | F | F | F | F | reachability | 0 |
| `f-fee-account-balance-untouched` | T | F | F | T | T | reachability | 0 |
| `f-eur-fee-flat` | T | T | T | T | T | — (detected) | 2 |
| `f-include-closed-ignored` | T | T | T | T | T | — (detected) | 5 |
| `f-transfers-filter-after-page` | T | T | F | F | F | reachability | 0 |
| `f-idempotency-conflict-ignored` | T | T | T | T | T | — (detected) | 1 |
| `f-idempotency-freed-by-cancel` | T | T | T | T | T | — (detected) | 2 |
| `f-day-usage-carryover` | F | T | T | T | T | enumeration | 1 |
| `f-tick-day-skips-settlement` | T | T | T | T | T | — (detected) | 2 |
| `f-entries-cross-principal` | T | T | T | T | T | — (detected) | 1 |
| `f-transfer-source-unowned` | T | T | T | T | T | — (detected) | 1 |
| `f-same-account-envelope-bare` | T | T | T | T | T | — (detected) | 1 |

Diagnosis counts: detected 10 · reachability 3 · enumeration 1

Misses in detail:

- `f-deposit-entry-mismatch` (cross-resource-invariant, semantic) — **reachability**, first false stage `scenario_executed`; witness not reached; column one not covered by the pinned oracle.
- `f-transfers-filter-after-page` (pagination, semantic) — **reachability**, first false stage `manifested_in_traffic`; witness reached, 0 manifestation(s); column one not covered by the pinned oracle.

Detected with an earlier stage false (credited on column two regardless):

- `f-fee-account-balance-untouched` — stage `scenario_executed` is false (diagnosis `reachability`), stages 4 and 5 true, strict column two not credited. The witness did not fire on this arm's traffic, so the bench cannot confirm the fault manifested in the exchanges the arm recorded, but the arm's own failing check is attributable and its citation resolves on target.
- `f-day-usage-carryover` — stage `obligation_enumerated` is false (diagnosis `enumeration`), stages 4 and 5 true. The suite's own rule tag for this check does not match the vocabulary the witness files the rule under, so the enumeration stage cannot see it; the check exists, ran, failed, and cited resolving evidence.

### statements-trial 2 (`t2`)

| Fault | 1 | 2 | 3 | 4 | 5 | diagnosis | witness fired |
|---|---|---|---|---|---|---|---|
| `f-activate-after-close` | T | T | T | T | T | — (detected) | 1 |
| `f-transfer-to-pending-destination` | T | T | T | T | T | — (detected) | 1 |
| `f-deposit-entry-mismatch` | T | T | T | F | F | assertion | 1 |
| `f-fee-account-balance-untouched` | T | T | F | T | T | reachability | 0 |
| `f-eur-fee-flat` | T | T | T | T | T | — (detected) | 3 |
| `f-include-closed-ignored` | T | T | T | T | T | — (detected) | 1 |
| `f-transfers-filter-after-page` | T | T | T | T | T | — (detected) | 9 |
| `f-idempotency-conflict-ignored` | T | T | T | T | T | — (detected) | 1 |
| `f-idempotency-freed-by-cancel` | T | T | T | T | T | — (detected) | 1 |
| `f-day-usage-carryover` | F | T | T | T | T | enumeration | 1 |
| `f-tick-day-skips-settlement` | T | T | T | T | T | — (detected) | 1 |
| `f-entries-cross-principal` | T | T | T | T | T | — (detected) | 1 |
| `f-transfer-source-unowned` | T | T | T | T | T | — (detected) | 1 |
| `f-same-account-envelope-bare` | T | T | T | T | T | — (detected) | 1 |

Diagnosis counts: detected 11 · assertion 1 · reachability 1 · enumeration 1

Misses in detail:

- `f-deposit-entry-mismatch` (cross-resource-invariant, semantic) — **assertion**, first false stage `assertion_detected`; witness reached, 1 manifestation(s); column one not covered by the pinned oracle.

Detected with an earlier stage false (credited on column two regardless):

- `f-fee-account-balance-untouched` — stage `manifested_in_traffic` is false (diagnosis `reachability`), stages 4 and 5 true, strict column two not credited. The witness did not fire on this arm's traffic, so the bench cannot confirm the fault manifested in the exchanges the arm recorded, but the arm's own failing check is attributable and its citation resolves on target.
- `f-day-usage-carryover` — stage `obligation_enumerated` is false (diagnosis `enumeration`), stages 4 and 5 true. The suite's own rule tag for this check does not match the vocabulary the witness files the rule under, so the enumeration stage cannot see it; the check exists, ran, failed, and cited resolving evidence.

### statements-trial 3 (`t3`)

| Fault | 1 | 2 | 3 | 4 | 5 | diagnosis | witness fired |
|---|---|---|---|---|---|---|---|
| `f-activate-after-close` | T | T | T | T | T | — (detected) | 1 |
| `f-transfer-to-pending-destination` | T | T | T | T | T | — (detected) | 1 |
| `f-deposit-entry-mismatch` | T | T | T | T | T | — (detected) | 1 |
| `f-fee-account-balance-untouched` | T | T | F | T | T | reachability | 0 |
| `f-eur-fee-flat` | T | T | T | T | T | — (detected) | 1 |
| `f-include-closed-ignored` | T | T | T | T | T | — (detected) | 5 |
| `f-transfers-filter-after-page` | T | T | F | F | F | reachability | 0 |
| `f-idempotency-conflict-ignored` | T | T | T | T | T | — (detected) | 1 |
| `f-idempotency-freed-by-cancel` | T | T | T | T | T | — (detected) | 2 |
| `f-day-usage-carryover` | F | T | T | T | T | enumeration | 1 |
| `f-tick-day-skips-settlement` | T | T | T | T | T | — (detected) | 1 |
| `f-entries-cross-principal` | T | T | T | T | T | — (detected) | 1 |
| `f-transfer-source-unowned` | T | T | T | T | T | — (detected) | 1 |
| `f-same-account-envelope-bare` | T | T | T | T | T | — (detected) | 1 |

Diagnosis counts: detected 11 · reachability 2 · enumeration 1

Misses in detail:

- `f-transfers-filter-after-page` (pagination, semantic) — **reachability**, first false stage `manifested_in_traffic`; witness reached, 0 manifestation(s); column one not covered by the pinned oracle.

Detected with an earlier stage false (credited on column two regardless):

- `f-fee-account-balance-untouched` — stage `manifested_in_traffic` is false (diagnosis `reachability`), stages 4 and 5 true, strict column two not credited. The witness did not fire on this arm's traffic, so the bench cannot confirm the fault manifested in the exchanges the arm recorded, but the arm's own failing check is attributable and its citation resolves on target.
- `f-day-usage-carryover` — stage `obligation_enumerated` is false (diagnosis `enumeration`), stages 4 and 5 true. The suite's own rule tag for this check does not match the vocabulary the witness files the rule under, so the enumeration stage cannot see it; the check exists, ran, failed, and cited resolving evidence.

### proposal trial (`proposal`)

| Fault | 1 | 2 | 3 | 4 | 5 | diagnosis | witness fired |
|---|---|---|---|---|---|---|---|
| `f-activate-after-close` | T | T | F | F | F | reachability | 0 |
| `f-transfer-to-pending-destination` | T | T | T | T | T | — (detected) | 1 |
| `f-deposit-entry-mismatch` | T | T | F | F | F | reachability | 0 |
| `f-fee-account-balance-untouched` | T | T | T | T | T | — (detected) | 4 |
| `f-eur-fee-flat` | T | T | T | T | T | — (detected) | 2 |
| `f-include-closed-ignored` | T | T | T | T | T | — (detected) | 2 |
| `f-transfers-filter-after-page` | T | T | F | F | F | reachability | 0 |
| `f-idempotency-conflict-ignored` | T | T | T | T | T | — (detected) | 1 |
| `f-idempotency-freed-by-cancel` | T | T | F | F | F | reachability | 0 |
| `f-day-usage-carryover` | F | T | T | T | T | enumeration | 1 |
| `f-tick-day-skips-settlement` | T | T | F | F | F | reachability | 0 |
| `f-entries-cross-principal` | T | T | T | T | T | — (detected) | 1 |
| `f-transfer-source-unowned` | T | T | T | T | T | — (detected) | 1 |
| `f-same-account-envelope-bare` | T | F | F | F | F | reachability | 0 |

Diagnosis counts: reachability 6 · detected 7 · enumeration 1

Misses in detail:

- `f-activate-after-close` (state-machine, semantic) — **reachability**, first false stage `manifested_in_traffic`; witness reached, 0 manifestation(s); column one not covered by the pinned oracle.
- `f-deposit-entry-mismatch` (cross-resource-invariant, semantic) — **reachability**, first false stage `manifested_in_traffic`; witness reached, 0 manifestation(s); column one not covered by the pinned oracle.
- `f-transfers-filter-after-page` (pagination, semantic) — **reachability**, first false stage `manifested_in_traffic`; witness reached, 0 manifestation(s); column one not covered by the pinned oracle.
- `f-idempotency-freed-by-cancel` (idempotency, semantic) — **reachability**, first false stage `manifested_in_traffic`; witness reached, 0 manifestation(s); column one did not confirm.
- `f-tick-day-skips-settlement` (temporal-boundary, semantic) — **reachability**, first false stage `manifested_in_traffic`; witness reached, 0 manifestation(s); column one not covered by the pinned oracle.
- `f-same-account-envelope-bare` (error-semantics, schema-reachable) — **reachability**, first false stage `scenario_executed`; witness not reached; column one did not confirm.

Detected with an earlier stage false (credited on column two regardless):

- `f-day-usage-carryover` — stage `obligation_enumerated` is false (diagnosis `enumeration`), stages 4 and 5 true. The suite's own rule tag for this check does not match the vocabulary the witness files the rule under, so the enumeration stage cannot see it; the check exists, ran, failed, and cited resolving evidence.

## 4. False positives on the 17 conforming builds (§5, §6.3)

Per arm: 3 canonical clean + `terse-optionals` + `trailing-page` + `wide-ids` +
`all-variants` + 10 jittered repeats = 17 conforming builds; 68 in the round.

| Arm | conforming builds | column-1 FP (oracle) | column-2 FP (failing checks) | distinct failing checks |
|---|---|---|---|---|
| statements-trial 1 | 17 | 0 | 17 | `status-400-for-a-wrongly-typed-field` |
| statements-trial 2 | 17 | 0 | 0 | — |
| statements-trial 3 | 17 | 0 | 0 | — |
| proposal trial | 17 | 0 | 0 | — |

Per conforming-build label:

| Arm | clean | clean.terse-optionals | clean.trailing-page | clean.wide-ids | clean.all-variants | clean.jitter |
|---|---|---|---|---|---|---|
| T1 | 0 / 3 (3) | 0 / 1 (1) | 0 / 1 (1) | 0 / 1 (1) | 0 / 1 (1) | 0 / 10 (10) |
| T2 | 0 / 0 (3) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (10) |
| T3 | 0 / 0 (3) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (10) |
| PROP | 0 / 0 (3) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (1) | 0 / 0 (10) |

Cells are `column-1 FP / column-2 FP (builds)`.

Every column-two false positive, by the check that produced it:

| Arm | check | rule | builds it failed on |
|---|---|---|---|
| T1 | `status-400-for-a-wrongly-typed-field` | — | 17 of 17 (clean×3, clean.all-variants×1, clean.jitter×10, clean.terse-optionals×1, clean.trailing-page×1, clean.wide-ids×1) |

`status-400-for-a-wrongly-typed-field` is **D2**, the verified clean-build
defect in `ROUND-LOG.md`: the fixture answers `422 invalid_amount` to a
wrongly-typed `amount` where statement §11 requires `400`. §6.3 says a real
fixture defect found on a conforming build is a true positive, not a false
positive, and the operator ruling that D2 is a defect predates this round. Both
counts are therefore given and neither is adjudicated here:

| Arm | column-2 FP as the bench counts them | excluding the D2 check |
|---|---|---|
| statements-trial 1 | 17 | 0 |
| statements-trial 2 | 0 | 0 |
| statements-trial 3 | 0 | 0 |
| proposal trial | 0 | 0 |

## 4.1 D1 at replay (the pagination tie-drop)

`ROUND-LOG.md` records D1 — a quiescent `GET /accounts?limit=1` walk dropping
`acc_fee_eur` — as a genuine clean-build defect found during authoring and fixed
publicly in `12cba1d`, and statements-trial 3 independently rediscovered it on
its pre-fix authoring instance. Its check is
`accounts-enumeration-is-complete`. At replay against the fixed build:

| | |
|---|---|
| Builds the check ran on | 31 of 31 (every build in t3's round) |
| Pass | 30 |
| Fail | 1 — `f-include-closed-ignored` |
| Fail on any conforming build | 0 |

It resolves green on all 17 conforming builds and on 13 of the 14 fault builds.
Its one failure is on `f-include-closed-ignored`, a sealed fault that makes
`?include_closed=true` filter closed accounts out — an incomplete enumeration by
construction, so that failure is a detection, not a regression. Trial 3's
authoring finding is therefore an authoring-time true positive that the fix
closed, exactly as the round log predicted.

## 5. Cross-trial variance (statements-trials only)

- Column-two semantic detections per trial: t1 11/13 · t2 12/13 · t3 12/13
- Range 11–12 (spread 1); mean 11.667; sd 0.471
- Detected by all three: `f-activate-after-close`, `f-transfer-to-pending-destination`, `f-fee-account-balance-untouched`, `f-eur-fee-flat`, `f-include-closed-ignored`, `f-idempotency-conflict-ignored`, `f-idempotency-freed-by-cancel`, `f-day-usage-carryover`, `f-tick-day-skips-settlement`, `f-entries-cross-principal`, `f-transfer-source-unowned`, `f-same-account-envelope-bare`
- Missed by all three: none
- Split (some trials only): `f-deposit-entry-mismatch` (t3); `f-transfers-filter-after-page` (t2)

## 6. CI-flake estimate from the jittered repeats

`LEDGER_JITTER_MS=250`, 10 repeats per arm (§5). An *outcome signature* is the
arm's failing-check set, its oracle-violation set, and its request count on that
build; a flake is any repeat whose signature differs from the others.

| Arm | jitter repeats | distinct signatures | canonical clean repeats | distinct | jitter ≡ canonical | flake rate |
|---|---|---|---|---|---|---|
| statements-trial 1 | 10 | 1 | 3 | 1 | yes | 0.0 % |
| statements-trial 2 | 10 | 1 | 3 | 1 | yes | 0.0 % |
| statements-trial 3 | 10 | 1 | 3 | 1 | yes | 0.0 % |
| proposal trial | 10 | 1 | 3 | 1 | yes | 0.0 % |

## 7. Economics — what a replay actually costs

| Arm | builds | requests | wall clock | mean/build | canonical clean build | jittered build | model calls | $ |
|---|---|---|---|---|---|---|---|---|
| statements-trial 1 | 31 | 6645 | 292.4 s | 9.43 s | 0.59 s | 28.05 s | 0 | $0.00 |
| statements-trial 2 | 31 | 7633 | 332.9 s | 10.74 s | 0.70 s | 31.93 s | 0 | $0.00 |
| statements-trial 3 | 31 | 6728 | 295.0 s | 9.52 s | 0.56 s | 28.30 s | 0 | $0.00 |
| proposal trial | 31 | 7105 | 309.3 s | 9.98 s | 0.60 s | 29.69 s | 0 | $0.00 |
| **round** | **124** | **28111** | **1229.6 s** | 9.92 s | | | **0** | **$0.00** |

Requests per build are inside the wire-enforced 360 ceiling on every build
(§7.2): T1 213–217, T2 245–254, T3 214–218, PROP 227–232.

The jittered builds are the only slow ones, and the delay is the fixture's, not
the suite's: `LEDGER_JITTER_MS=250` adds ~125 ms of server-side sleep per
response. With the 40 jittered builds excluded, the other 84 builds of the round
cost **49.9 s** of wall clock and
**19051** requests in total — a mean of
**0.59 s** per build:

| Arm | non-jittered builds | requests | wall clock | mean/build |
|---|---|---|---|---|
| statements-trial 1 | 21 | 4505 | 11.9 s | 0.57 s |
| statements-trial 2 | 21 | 5173 | 13.6 s | 0.65 s |
| statements-trial 3 | 21 | 4558 | 12.0 s | 0.57 s |
| proposal trial | 21 | 4815 | 12.4 s | 0.59 s |

That is the "replay is free" number: one authored suite, re-run against all 31
builds of a round, with **zero model calls and zero dollars of inference**. The
only per-round cost is CPU seconds, and there are fewer than twenty of them per
arm once the deliberately-slowed jitter builds are set aside.

## 8. Isolation audit

The harness cannot prove it started its own fixture — a stale listener on the
port would answer `/health` just as well — so every build's fixture log was
read back and matched against the configuration its build id names.

- 124 builds; 0 with `EADDRINUSE` in the fixture log.
- Every build's banner names exactly its own faults, variants and jitter (see `builds-digest.json`).
- Replay order: identical across all four arms, as §8.1 requires — the four
  `order.<arm>.json` files carry the same 31-entry sequence under the same seed.

## 9. What is in this directory, and what is not

| File | What it is |
|---|---|
| `order.<arm>.json` | the seeded replay order, written before the first build ran |
| `manifest.jsonl` | the append-only per-build row: status, exit, requests, wall time |
| `builds-digest.json` | per build: the HAR's sha256 and byte count, the script report's sha256, the fixture's boot banner, and the report's counters |
| `scores.round.json` / `.txt` | the bench's own output over all 124 builds, in one pass |
| `RESULTS.json` | this file's tables, machine-readable |
| `RESULTS.md` | this file |
| `tools/` | the three offline scripts that produced `builds-digest.json`, `RESULTS.json` and this file from the round's artifacts |

**The raw HARs and the 124 per-build `script-report.json` files are not
committed.** They are ~56 MB of run-local traffic recordings; `builds-digest.json`
carries a sha256 of every one of them, so a re-run can be checked against this
round byte for byte.

