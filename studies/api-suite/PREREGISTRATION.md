# S0 — agent-authored suite confirmation study: preregistration

> ## FROZEN — 2026-07-26
>
> **Everything in this file is binding from this commit onward**, and nothing in
> it — not a threshold, a budget, a seed, a prompt, a brief, an oracle, a
> variant, or a comparator configuration — changes until `REPORT.md` is
> committed. No placeholder remains: §11 is the checklist that was worked
> through, and a freeze with a placeholder still in it is not a freeze.
>
> **The instrument pin is the freeze commit's tree: `6aa5b75`.** It is recorded
> in §3 and in the tuning log's `freeze` row by the commit that immediately
> follows it — a commit cannot contain its own hash.
>
> No measured trial has been run and the study has made **no model call**.
> Everything below rests on apparatus evidence (`HARNESS-DRYRUN.md`,
> `substrate-parity/RESULTS.md`, `scripts/verify-instrument.mjs`) and on the
> sealed commitment in §4.2, whose contents the orchestrator has never read.

Implements `docs/backlog/api-testing/BUILD_PLAN.md` S0 and DESIGN §7, on the
pattern of `studies/api-probe/PREREGISTRATION.md` (frozen; read, never modify).

---

## 1. Question under test, and the limits of the answer

**Question.** Does an agent-authored, human-approvable executable suite detect
semantic faults in this API reliably enough — across independent authors, with
zero false positives on conforming builds — to justify building the
script-authoring product? Secondarily: can the platform *propose* the rules
(DESIGN N6, Level 1), or must a human supply them?

**Limits, preregistered so the report cannot quietly widen them (N12):**

- The claims stop at the ledger fixture. This is a ledger-domain confirmation
  study; cross-API generalisation belongs to S5 and S5 is a pilot.
- The unbiased evidence is the **sealed set only**. The 13 public faults are
  development data and are reported as such, never inside a bar.
- Three suites replayed against one sealed fault are **three measurements of one
  fault**. Every headline denominator is the sealed-fault count.
- The bar is an operational go/no-go for this team's next investment. It is not
  a measurement of "the detection rate of agent-authored suites".

## 2. Arms and trials

| Arm | Instance count | Handout | Authoring target |
|---|---|---|---|
| **statements-trial** | 3 | served OpenAPI document + the invariant statements (§2.1) + client docs + authoring brief | the **clean build only** |
| **proposal-quality trial** | 1 | served OpenAPI document + client docs + authoring brief, **no invariant statements** | the clean build only, after its proposals are adjudicated |
| **probe rematch** | 1 | P1's frozen probe instrument (persona, six stories, assertions) | n/a — the probe explores at round time |

Every statements-trial is a **fresh agent** with no access to another trial's
scratchpad, transcript, suite, or results, and no repository access: the same
isolation the P1 agent-suite arm ran under
(`studies/api-probe/comparators/agent-suite/BRIEF.md`). Each trial works in its
own scratch directory, is told that reading anything outside it invalidates the
measurement, and states in its transcript whether it did. A trial that read
outside its sandbox is discarded and re-run with a fresh agent; the discard is
logged.

Authoring happens against the **clean build** only. No trial ever sees a faulted
build, a variant build, or the fault catalog. Suites then replay against every
round build on the frozen substrate.

### 2.1 The invariant statements handout

The reference rule set is the invariant statements in the shape P1 used —
rule + applicability + declared exceptions
(`studies/api-probe/comparators/INVARIANTS.md`: conservation, idempotency,
lifecycle legality, pagination identity, error shape, balance agreement; seven
rules in six sections). It was **extended before sealing**, to the whole of the
service's obligation space, in tuning-log row `prep-2`; it is never extended
afterwards.

**The frozen statement set:**

```
file:     studies/api-suite/INVARIANTS.md
sha256:   ce0c94438ce0155432b869d50acdcc50481b71a81fa19ab01827387719012ccb
shape:    13 `##` sections carrying 16 distinct rules
```

Two counts, and they are different things:

- **16 rules** — the *reference rule set*, and the denominator of §9.2's recall
  bar. Eleven sections state one rule each; two state more, and say so in their
  own text — §3's declared exception is "a rule in its own right" and §11 is
  headed "(three rules)" — so 11 + 2 + 3 = 16 is checkable rather than a
  judgement call:

  | # | Rule | From |
  |---|---|---|
  | 1 | conservation of a settled transfer's entries | §1 |
  | 2 | the fee schedule | §2 |
  | 3 | one key + one body → one transfer and one set of effects | §3 |
  | 4 | the same key with a *different* body is refused and creates nothing ("a rule in its own right") | §3 |
  | 5 | lifecycle legality | §4 |
  | 6 | settlement completeness (a tick leaves nothing pending; funds re-checked; settle once) | §5 |
  | 7 | ownership | §6 |
  | 8 | pagination identity and page discipline | §7 |
  | 9 | documented parameters have their documented effect | §8 |
  | 10 | reference integrity | §9 |
  | 11 | the daily limit | §10 |
  | 12 | the error envelope, and a refusal is never a 2xx | §11 |
  | 13 | no operation answers 5xx | §11 |
  | 14 | the status split — which refusal you get for which reason | §11 |
  | 15 | balance agreement | §12 |
  | 16 | round-trip consistency and determinism | §13 |

- **13 rule obligations** — what the harness derives mechanically from the 13
  section headings, and what a suite's checks must account for. The derivation
  and the resolved ids are pinned in §3. The two numbers differ because the
  obligation manifest is derived from *headings*, deliberately, by a parser with
  no judgement in it; a section that argues for three rules still produces one
  obligation, and a suite covers it by exercising the section, not by splitting
  it. Recall (§9.2) is adjudicated against the 16, because a proposal trial is
  measured on the *rules* it recovers, not on a parser's section count.

The temporal affordance is documented in the handout: `INVARIANTS.md` states
that the service has no wall clock and that `POST /admin/tick
{"advance_day": true}` is the only thing that rolls the ledger day over (§4.4).

## 3. The substrate — one of everything

Exactly one execution substrate is selected and fingerprinted here before the
first measured trial. All measured trials use it. No "S1's runner if it landed,
else a mirror" (BUILD_PLAN S0 scope 2).

Produced by `node studies/api-suite/scripts/fingerprints.mjs` on the freeze tree
and pasted here verbatim. Re-running it on that tree reproduces every digest
below, including the single substrate digest.

```
instrument pin:     6aa5b75bb4e9d84c7169c00a3d50f983c6399817  (the freeze commit)
tree fingerprinted: that commit's tree — 5e2ff0e + the freeze commit's changes
substrate digest:   99dd15499b45c70be63f3c4c4ed3af43e91e37542662efc387416ec8a5a1b26e
substrate files:    54
```

| Component | Pin |
|---|---|
| Runner (suite execution: subprocess, timeout, outputs) | `src/core/scripts/runner.js` · sha256 `c3a0bc5f19db081a728873d5b7579ae531fd670abfef9c8ec760260a223ac5c0` |
| Injected client (origin lock, budget, HAR recording, read-only mode) | `src/core/scripts/{client,proxy,har,sandbox-hooks,child}.js` · engine group digest `c92c19e781558d66…` |
| Suite report schema | S1's **`script_report_version: 1`** — `src/core/schemas/script-report.schema.json` sha256 `160ec31b2acefdb4f2c5b42268a0e0bcb8417587db4e305eb2e1344e80a3fc00`. (`playtest.suite-report/v0` is *not* used by any S0 arm authored under this instrument; the bench still reads it, for the legacy-shape comparator traces only.) |
| Script contract (the handout's `CLIENT.md` is derived from it) | `docs/contracts/scripts.md` sha256 `eb609d6fc724fe9953fcefeb2bb372f8862ce6b8e14964aea53b5e9ac9328988` |
| Authoring brief | `studies/api-suite/BRIEF.md` sha256 `648f9029e0f8ed1c76c2a721e7aeeea80f032a18cf081e1a1849aae9097b6d8d` |
| Handout template (the script contract as a trial receives it) | `studies/api-suite/handout-src/CLIENT.md` sha256 `a290d223c6dc9cbb5b0584093d371db9fb46d8c366a3d4a715983f0ec8238f06` |
| Proposal-trial prompt | `studies/api-suite/PROPOSAL-BRIEF.md` sha256 `0deb7092b4a25d847b734d79be5a45319cd2fd087406b269be8712ba8b97248f` |
| Invariant statements (§2.1) | `studies/api-suite/INVARIANTS.md` sha256 `ce0c94438ce0155432b869d50acdcc50481b71a81fa19ab01827387719012ccb` |
| Target authorization record | `studies/api-suite/TARGET-AUTHORIZATION.md` sha256 `015d72967a94ffa0baf195c133c0a3dccdde4d2d58d8200a3b19bd0fc4988278` |
| Trial harness | `studies/api-suite/scripts/{make-handout,trial-run,replay-round,fingerprints,verify-instrument}.mjs` + `scripts/lib/handout.mjs` · harness group digest `76f8ef76f89074ba…`; per-file digests below |
| Declared credentials | three references, injected by name by the harness (`scripts/lib/handout.mjs` → `STUDY_SECRETS`): `LEDGER_ADMIN_TOKEN`, `LEDGER_CUSTOMER_TOKEN`, `LEDGER_CUSTOMER_B_TOKEN` — the administrator and **both** customer principals (§4.3) |
| Actor model id | **`claude-opus-5`** for every measured trial, run as a fresh Claude Code sub agent per trial (no shared context, no repository access, its own scratch directory) |
| Decoding configuration | **the platform default.** No temperature, top-p, or sampling override is available to the operator at this seam, so none is set and none is claimed. This is recorded as a limitation, not a configuration: cross-trial variance (§6.4) is therefore variance under the platform's own defaults. |
| Retry policy | **no automatic retries anywhere in the measured path.** A trial is not re-prompted, a suite execution is not re-run, and a build is re-run only under §8.3's preregistered infrastructure-failure rules, at most twice, with the failure recorded. Per-request transport timeout 15 000 ms (the client records a `transportError` rather than retrying); per-execution ceiling 600 000 ms (§7.2). |
| Fixture | `$LEDGER_FIXTURE_DIR` tree (the directory named in `README.md`) · fixture group digest `4a702bb666039f49…`; `LEDGER_SEED=ledger-dev-seed` |
| Bench pins | bench group digest `4f369ba80d44a2b8…`; `shared_oracle` `lib/oracles.js` `04a3c69f…131c`, `lib/trace.js` `8d822ce6…df64` — **byte-identical to P1's freeze**; `bench_scoring` covers `bench.js`, `lib/{funnel,report,score,sources,suite-report,witnesses}.js` and `../src/faults.js`. Verified by `scripts/verify-instrument.mjs` before every round. |
| Gate policy set (Level 0) | exactly the shipped default for a run that resolved a spec: **`no_server_error`, `documented_status`, `response_schema`, `content_type`** (`src/core/scripts/gate.js` → `defaultScriptPolicies`, `docs/contracts/scripts.md`). Four policies, four `policy:` obligations, no addition and no subtraction. |
| Recorder | runner-written HAR (`src/core/scripts/har.js`); no external proxy, no `$HAR_PROXY` |
| Probe rematch instrument | P1 tree at `9059797`, plus the re-freeze SHA if a tuning round happens (§9.3) |
| Replay-order seed | **`4adf038b88f9421c`** (§8.1) |
| Sealed set | §4.2's commitment: sha256 `5afba522…1131`, 20 540 bytes |

**The instrument pin.** `PREREGISTRATION.md` is deliberately *not* one of the 54
fingerprinted files: it is the document that records the fingerprint, so
including it would make the substrate digest wrong the instant it was pasted in.
The preregistration is pinned the only way a self-referential file can be — by
the freeze commit's SHA, recorded in the tuning log's `freeze` row and by the
commit that immediately follows this one.

**Why the gate policy set is pinned as shipped** (`HARNESS-DRYRUN.md` item 2).
The alternative was to pin `no_server_error` only. Pinning the four is what S1
ships, so S0 measures the product rather than a study-only configuration. One
consequence was real and is now fixed rather than tolerated: the harness dry run
found the clean build failing `documented_status`, because the fixture answers
`400` to a malformed identifier or an unparseable body on operations whose
OpenAPI document did not declare `400`. The document now declares it on every
operation that genuinely answers it (tuning-log row `spec-400`), so a *conforming*
build passes all four policies. A failing gate policy on a fault build, or on a
build where a trial provoked something the document does not cover, remains what
`CLIENT.md` §8 says it is: a column failing on a sound run, exit 1, never a
soundness failure and never a preregistered false positive (§6.3).

**Statements → rule obligations.** Rule ids come from `INVARIANTS.md` section
headings through `scripts/lib/handout.mjs` → `parseInvariantRules`: an explicit
`{#id}` or `` `rule:id` `` in the heading wins, otherwise the heading slug. A
sibling `INVARIANTS.rules.json` would override the prose; **there is none, and
none may be added** — which is what makes the following list exhaustive and
fixed:

```
rule:conservation                              rule:documented-parameters
rule:the-fee-schedule                          rule:reference-integrity
rule:idempotency                               rule:the-daily-limit
rule:lifecycle-legality                        rule:error-shape-and-the-status-split-three-rules
rule:settlement                                rule:balance-agreement
rule:ownership                                 rule:round-trip-consistency-and-determinism
rule:pagination-identity-and-page-discipline
```

Thirteen rule obligations, plus four `policy:` obligations and sixteen
`operation:` obligations — **33 in total** for a statements-trial handout
against this spec, written into every trial's `handout/obligations.json` so no
id has to be guessed. **No obligation carries `approved_skip_reasons`**, so no
`check.skip` and no `check.unsupported` is approvable: every obligation must be
covered outright or the run is unsound.

The bench's `shared_oracle` files (`lib/oracles.js`, `lib/trace.js`) are the
files a measured instrument vendors a copy of. `bench/oracle-pins.json` records
their digests and the status of every vendored copy;
`scripts/verify-instrument.mjs` re-checks both before every round. A missed
re-sync produced a false positive in P1 — the check exists so that failure mode
is mechanical rather than remembered.

### 3.1 The 54 fingerprinted files

`sha256  path`, sorted; the substrate digest is the sha256 of exactly these
lines, each newline-terminated. Reproduce with
`node studies/api-suite/scripts/fingerprints.mjs --files`.

```
4ff556d408991e7fa6e4dbde36d1232d3ca59124c5faef23ef03ef5cc629fba1  $LEDGER_FIXTURE_DIR/bench/bench.js
eb60077fced2e49b6ed724b36a201b236da7668d66ded8924abb7244bb006c3d  $LEDGER_FIXTURE_DIR/bench/lib/funnel.js
04a3c69f516fbced95b4dafc93ced3754249b89c191cf3a61660b435ce76131c  $LEDGER_FIXTURE_DIR/bench/lib/oracles.js
954bfb1eedbafa3a7c32d9aa4f70eb2af63d9d09343dfe8f1c8b3b7c1150902e  $LEDGER_FIXTURE_DIR/bench/lib/report.js
a36caf69d4d436a7b550464d8cc9ed9dc6f17c1fa5cf9cb03a4e14e0393a9b10  $LEDGER_FIXTURE_DIR/bench/lib/score.js
beba795aa5b7b25d62c58f8f19d2c1906001dd4c37a9cf74ba803d55499c7c83  $LEDGER_FIXTURE_DIR/bench/lib/sources.js
54967c862810dec7d446ef659af3e79cbac518e32e2591359b582d4dd42be28d  $LEDGER_FIXTURE_DIR/bench/lib/suite-report.js
8d822ce60f55f86a45ca15a7154cafca73bf76d9b00943a7f98a8590edf0df64  $LEDGER_FIXTURE_DIR/bench/lib/trace.js
72a947d07ddc7a6e746338155c0e76e9ec122ef33a444159a48d7f541304d8c9  $LEDGER_FIXTURE_DIR/bench/lib/witnesses.js
7310fcc5b4d8fce449c907abf3f0d18416d20eb32b1e6cbcaf4ccb9eb358589a  $LEDGER_FIXTURE_DIR/bench/oracle-pins.json
0f20cb4fe15327c12905c7f5d7fd955145b9b0c2972ac03cbef469730ed5c52a  $LEDGER_FIXTURE_DIR/bench/pins.js
419a8ad5f42b2e934f6f6cce5c3f1e23555a5d575cb056e989029247fd298c0b  $LEDGER_FIXTURE_DIR/openapi.json
1c00efa8ad6c82fd7055ec0dc02ebd14b5529b717a756d25e9e4d6c65ca3c5d8  $LEDGER_FIXTURE_DIR/package.json
f71a43aa1c0b8e97f71a5d1ccd15dcfba809776cccd990e53665b5162a74c4b1  $LEDGER_FIXTURE_DIR/server.js
99224090127b338ea28da1431f3fa4cca333b09a6723a3c40ad0e4d7ac6e3d3e  $LEDGER_FIXTURE_DIR/src/faults.js
097c12ab32ef89d754ee46eaebbb263b52bbb0598d889ab797878648710e1212  $LEDGER_FIXTURE_DIR/src/http.js
9fc4dd2302837d0254893c8545fe4c8fb30b37a275e8fe8a608e7c258e0325a3  $LEDGER_FIXTURE_DIR/src/ledger.js
e9cda860c1e2dd9984c47845c27abe970cef587c27fea14b06b4ce71f13fe8e3  $LEDGER_FIXTURE_DIR/src/rng.js
73ee40d2a455d16f4dbf2248b39f66d3215d617a282de5644ab344b2f6a70390  $LEDGER_FIXTURE_DIR/src/variants.js
eb609d6fc724fe9953fcefeb2bb372f8862ce6b8e14964aea53b5e9ac9328988  docs/contracts/scripts.md
25b6d0b6817d43259548b6c56c6e094e3700e1f955827c8a14abbba2dc4c49b8  src/core/assertions.js
9d8904d1da957b6bb8f430b5f40de4450375b41294b7bccb59fdf6436cc93863  src/core/baseline-scan.js
4b11cccfd6861260899108ec0b96c15aebe3f1ec7670c9f790bdc683b809af98  src/core/bindings.js
5efcf347bd1f396ffc4c7bc0345e5390914bc636a9e67bffbf8547c59dd7ab5c  src/core/config.js
7cd98e128dd09fafa88d3ecd5a7e30c0a924da7b89f161b3bf5dbe5169663d2d  src/core/drivers/har.js
60454f98dddbcc4b78d524398474e8bb89d35a9a72eeccf6e3b32f4343b51e1b  src/core/invariants.js
c1aea47217f3e8617e606e51877c0d8568196fb834ca83809711db57b050bc96  src/core/match.js
776065b11ed07d823648056f9fa95bc425c1e17d6a84b7ee92d6704d12b06117  src/core/openapi.js
de7eebb288ed9fe884fc61357f4db10f1396a70554f7dd45c52ce5dfe9c11b97  src/core/public/scripts.js
160ec31b2acefdb4f2c5b42268a0e0bcb8417587db4e305eb2e1344e80a3fc00  src/core/schemas/script-report.schema.json
9ee3354bae1fdd695ecca9636135b67bd99ac1cbcf997670251b23bde2844c78  src/core/scripts/check.js
c3fd8f64a758d30e3eec5f955b77bdc08bf8c6e55d54d001b67c23276245db83  src/core/scripts/child.js
f3ad73173db154c82dc5498130b59ea8ca123d3ee126a30e1d631b953953325c  src/core/scripts/client.js
e636fd9b47d0c17a68314d7e22228e632416374ec112e25848110201967c8621  src/core/scripts/gate.js
c44dfdbe929b52def31e8808d49c8c636b7822fab41c5523b7742ccae1ee7a27  src/core/scripts/har.js
cc108a1634eb1faf08f3236f62f5d4a597654d315cf8d865864e6a921b304bad  src/core/scripts/leak-scan.js
a5cc8d34c03e8b083bb58b26baf7aad506242d50ad5660badf283fc6c72b5598  src/core/scripts/obligations.js
11b92b8e06bbda143102a83cce94b274d02151507ab6e34f31503d162a1da82d  src/core/scripts/profile.js
24b13046e7c3c0939d0194f16d49af37978efbb84cfec96427ceea69cfd08d42  src/core/scripts/proxy.js
c3a0bc5f19db081a728873d5b7579ae531fd670abfef9c8ec760260a223ac5c0  src/core/scripts/runner.js
20183fa35a333450211642ab3b348b69a0bb17fe32b17d60d592fd67740c0ee9  src/core/scripts/sandbox-hooks.js
7d5768a04a3e433c9c261e9dd421cbc7277d22190113d9aec6765d08e96a080f  src/core/secrets.js
18fdd5c18e9f2c8e41244c795dacdd7eb27b78bc92f5ca13724b71e0854038ef  src/core/trajectory.js
648f9029e0f8ed1c76c2a721e7aeeea80f032a18cf081e1a1849aae9097b6d8d  studies/api-suite/BRIEF.md
a290d223c6dc9cbb5b0584093d371db9fb46d8c366a3d4a715983f0ec8238f06  studies/api-suite/handout-src/CLIENT.md
ce0c94438ce0155432b869d50acdcc50481b71a81fa19ab01827387719012ccb  studies/api-suite/INVARIANTS.md
0deb7092b4a25d847b734d79be5a45319cd2fd087406b269be8712ba8b97248f  studies/api-suite/PROPOSAL-BRIEF.md
c7486714f2a83a35d7b605e3a2b29db786b9c4f1f13fd7c68f559b8e5561dd2d  studies/api-suite/scripts/fingerprints.mjs
59e33941f01635f51fb1050d9fb720e53fc2a288e2adf3f5578715dcc7f4c758  studies/api-suite/scripts/lib/handout.mjs
50fd915b84e4fe09ee413ef202077f72ad8cb0d48dc7dfc7f5d414e8210e1cc5  studies/api-suite/scripts/make-handout.mjs
0b31507efeb365d1ae2a41638566f0b5c9f52e7ad2ef68c3d0e0bda9e620d0ba  studies/api-suite/scripts/replay-round.mjs
e238a6215f6f7bc94cbdc98da1952bb3d5936ce9a3c13c639aa94656676271d4  studies/api-suite/scripts/trial-run.mjs
d35e533e14ee6b4010f91404fb829b932050566545f79a004ec94e928d32a015  studies/api-suite/scripts/verify-instrument.mjs
015d72967a94ffa0baf195c133c0a3dccdde4d2d58d8200a3b19bd0fc4988278  studies/api-suite/TARGET-AUTHORIZATION.md

substrate digest  99dd15499b45c70be63f3c4c4ed3af43e91e37542662efc387416ec8a5a1b26e
```

## 4. Fault sets

### 4.1 Development set — 13 public faults

The eight development faults plus the five unsealed P1 held-out faults, now all
public in `$LEDGER_FIXTURE_DIR/src/faults.js`. Used to build and debug the
instrument, the briefs, the bench, and the variants. Development numbers are
reported in the report's development section and appear in **no bar**.

### 4.2 Sealed set — the measured evidence

Authored by an isolated agent, held outside the working checkout, committed to
by sha256 before any trial sees anything, applied only in the measured
environment by a sealed-round operator, and committed to history after the round
is scored.

Composition requirement (BUILD_PLAN S0 scope 3):

- **≥ 11 faults total.**
- **≥ 8 semantic-tier** (not reachable by schema-shape fuzzing alone).
- **≥ 2 temporal-boundary** — the category no P1 arm reached.
- Every fault: an independent `LEDGER_FAULTS` toggle, no clean-build behaviour
  change when off, a deterministic manifestation test, a declared witness in the
  bench's registry (`bench/lib/witnesses.js`) so the funnel can diagnose it, and
  detectability under the §2.1 statements.
- Distributed across the taxonomy below with **≥ 1 fault in ≥ 6 of the 8
  categories**, and the composition declared per category at freeze.

**The sealed-set commitment:**

```
patch:        $SEALED_PATCH — held outside the checkout; the orchestrator has
              never listed, opened, or read it, and does not know its contents
sha256:       5afba5226da2ae96950244199a91c7d2a8fa11c478168119b6509bcbbdf1a131
bytes:        20540
applies to:   HEAD 5e2ff0e, with `git apply -p1`
touches:      src/faults.js, bench/lib/witnesses.js, bench/lib/score.js
              (all three pinned in §3 under `bench_scoring`)
disclosure:   committed to history after the round is scored (§10 step 5)
composition:  14 total · 13 semantic-tier, 1 schema-reachable · 2 temporal
              state-machine 2 · cross-resource-invariant 2 · conditional-branch 2
              pagination 1 · idempotency 2 · temporal-boundary 2
              authorization 2 · error-semantics 1
```

The composition is the isolated author's declaration, recorded verbatim. It
satisfies every requirement above: 14 ≥ 11 total, 13 ≥ 8 semantic, 2 ≥ 2
temporal, and **8 of 8** taxonomy categories carry at least one fault (the
requirement was ≥ 6 of 8).

The same declaration states one more count, used by §6.1 and §9.3: **10 of the
14 faults lie outside the vocabulary of the seven pinned oracles**, so column
one can cover at most 4 of them. That is a coverage count, not a mechanism, and
recording it discloses nothing about any fault.

**Post-apply pin re-record.** The patch extends three files that §3 pins under
`bench_scoring` (`src/faults.js`, `bench/lib/witnesses.js`, `bench/lib/score.js`),
so §3 pins their **pre-seal** digests — the tree every trial authored against —
and the sealed-round operator re-records them **after applying**, with
`npm run bench:pins -- --write` in the fixture package, exactly as the sealed
author's manifest instructs. That re-record is expected, is not a tuning change,
and does not touch `shared_oracle`: `lib/oracles.js` and `lib/trace.js` stay
byte-identical to P1's freeze, which is what keeps the probe rematch comparable.
`scripts/verify-instrument.mjs` is run before and after, and both outputs go into
the round log.

### 4.3 The taxonomy

Results are reported **per category**, so many similar state faults cannot
obscure a total miss on one class of defect.

| Category | What reaching it demands |
|---|---|
| `state-machine` | drive a resource into a state and act on it illegally (close with a pending transfer, cancel after settlement) |
| `cross-resource-invariant` | relate two resources arithmetically (entries vs balance, debit vs credit vs fee) |
| `conditional-branch` | enumerate a parameter space — currency, boundary value, optional field — rather than reach one instance |
| `pagination` | run a real multi-page enumeration, with a write in flight |
| `idempotency` | replay a key across identical and differing bodies, and across state |
| `temporal-boundary` | cross a ledger-day rollover on purpose |
| `authorization` | act as the wrong principal on someone else's resource |
| `error-semantics` | check the envelope and the status split, including on refusals |

The public catalog covers all of these except `authorization`, which has no
public fault. That category is nonetheless **measured**, and the condition it
depends on is preregistered here so the report cannot claim it retroactively:

- The fixture has two customer principals with a bearer token each, and an
  account records its `owner_principal` (fixture commit `5e9e474`), so "act as
  the wrong principal on someone else's resource" is a state a suite can reach.
- **Both** customer credentials ship in every handout, declared by the harness
  as `LEDGER_CUSTOMER_TOKEN` and `LEDGER_CUSTOMER_B_TOKEN` alongside
  `LEDGER_ADMIN_TOKEN` (§3; `handout-src/CLIENT.md` §3). Which principal is
  which is not disclosed: a trial learns it only by acting.
- The sealed set declares two `authorization` faults (§4.2).

Had only one customer credential shipped, the category would have been
**not measured** — never a miss — and the report would have had to say so. It
ships two, so a miss in this category is a real miss.

### 4.4 The temporal category's disposition (BUILD_PLAN S0 scope 3)

At verdict time the temporal category gets an explicit disposition, and only
these two are available:

- **detected** — at least one statements-trial detects at least one of the two
  sealed temporal faults on the reported-with-evidence column; or
- **a named limitation with a concrete remediation item**, filed as a numbered
  item in the report and referenced from `DESIGN.md`.

The study may not record *proceed* while leaving the temporal result implicit.

**The affordance is not the excuse.** P1's plausible remediation — "the handout
never told the arm how to move the clock" — is already spent: the reading notes
at the head of `INVARIANTS.md` state that the service has no wall clock, that
`POST /admin/tick` is the only thing that moves time, and that
`POST /admin/tick {"advance_day": true}` is the only thing that rolls the ledger
day over; §10's applicability repeats it. Two of the sixteen rules — idempotency
surviving a day rollover (rule 3) and the daily limit resetting at one (rule 11)
— are stated in terms of that rollover. So a
temporal miss here is a miss with the affordance documented, and the named
limitation, if one is filed, has to be about something else.

## 5. Conforming negative controls

Clean scoring is not one build (DESIGN §7):

| Build label | Configuration | Why |
|---|---|---|
| `clean` ×3 | canonical, no variant, no jitter | the baseline |
| `clean.terse-optionals` | `LEDGER_VARIANT=terse-optionals` | optional nullable fields omitted instead of null — a suite that asserts `activated_at === null` snapshotted an implementation |
| `clean.trailing-page` | `LEDGER_VARIANT=trailing-page` | a full page always carries a cursor, so enumeration ends on an empty page |
| `clean.wide-ids` | `LEDGER_VARIANT=wide-ids` | regenerated identifier format inside the documented patterns |
| `clean.all-variants` | all three at once | interactions between them |
| `clean.jitter` ×10 | `LEDGER_JITTER_MS=250` | the CI-flake estimate |

A finding on any of these is a false positive. Both columns are scored on all of
them: an oracle finding here is a bench bug and is fixed before the freeze; a
suite check failing here is a product finding and is reported.

**Frozen:** `LEDGER_JITTER_MS=250` and **10** jittered repeats per suite. That
is **16 conforming builds per suite** — 3 canonical clean, 4 variant builds, 10
jittered — and with three statements-trials plus the proposal trial, 64
conforming builds in the round, every one of them scored in both columns. These
are the defaults `replay-round.mjs` already carries (`--jitter-ms 250`,
`--jitter-repeats 10`, `--clean-repeats 3`), so a measured round runs them
without a flag; passing a different value would be a post-freeze change and is
forbidden. 250 ms is the fixture's own documented example and is large enough to
reorder nothing — the jitter PRNG is seeded independently of the identifier
PRNG and delays only the response *write*, so content is byte-identical by
construction.

## 6. Scoring definitions

All deterministic, computed offline from artifacts alone by
`$LEDGER_FIXTURE_DIR/bench/bench.js` — no model call anywhere in the verdict
path (N2).

### 6.1 The two columns (N10)

**Column 1 — oracle-confirmed-in-traffic.** The shared oracles find a violation
in the arm's recorded HAR whose code is one the labelled fault can cause, whose
cited request index resolves in the trace, and whose citation lands on a request
of the kind the fault lives in. This is P1's rule, unchanged.

**Column 1 cannot speak to every sealed fault, and says so.** The seven pinned
oracles cover the seven declared invariants; the fault taxonomy describes what a
test author has to *do* and is deliberately wider. A fault whose rule no pinned
oracle owns scores `detected: null` with `column_one_covered: false` — *not
covered*, never *missed* — and the bench reports how many faults fell outside
the vocabulary so the reader sees the real denominator. **On the sealed set,
column one covers at most 4 of the 14 faults** (§4.2, §9.3); the other ten are
scorable only on column two and the witnesses. The bar (§9.1) is on column two
for exactly this reason.

**Column 2 — reported-with-correct-evidence.** The arm's own structured report —
S1's `script_report_version: 1` for every S0-authored arm (§3); the bench also
reads `playtest.suite-report/v0` and the P1 arm's own shape, for the legacy
comparator traces — contains a **failing check** that is

1. *attributable* to the fault — by rule name (across vocabularies:
   "errorshape" ≡ `error_shape`), or by citing an exchange of the kind the fault
   lives in, or by naming the resource the manifestation is about; **and**
2. *correctly evidenced* — at least one cited HAR entry **resolves in the
   recorded HAR**, and the citation lands on the fault (right route, or names the
   witnessed resource). A citation that resolves but describes a different
   exchange than it claims does not count: that is a plausible-looking
   reference, not evidence.

The bench also reports a **strict** variant of column 2 (the citation resolves
to an exchange the fault demonstrably manifested in). The bar uses the ordinary
column; the strict number is reported beside it.

**Why two columns:** in P1 the agent-suite caught `f-settle-failed-debit` and
named the offending ledger row, and the shared oracle refused to credit it
because its applicability window never opened (`REPORT.md` §3). A single-column
instrument that under-credits a correct report is biased, and it happened to be
biased toward the arm under test.

### 6.2 The five-stage funnel

Per fault, per trial:

| Stage | True when |
|---|---|
| 1 obligation enumerated | the report shows the rule was considered at all (an obligation manifest entry, or a check on that rule that passed) |
| 2 scenario executed | the traffic reached the state the fault lives in (the fault's declared `reach` predicate) |
| 3 fault manifested in traffic | the fault's declared witness fires — a contract-level predicate, independent of the oracle's applicability windows |
| 4 assertion detected | a failing check attributable to the fault exists |
| 5 evidence correctly cited | that check's citation resolves and is on target |

The first false stage is the diagnosis: **enumeration**, **reachability**,
**assertion**, or **reporting**. A stage the artifacts cannot answer is
**unknown**, never false — "the probe arm ships no structured report" is a
different fact from "the suite never enumerated the rule", and conflating them
would flatter or damn an arm for free.

### 6.3 False positives

- **Column 1 FP:** any oracle violation on a build in §5.
- **Column 2 FP:** any failing check on a build in §5.
- **Not a false positive:** an obligation the suite marked `unsupported`, or a
  check reported `not_exercised`. Those are **soundness** results (N5) and are
  reported separately: a suite leaving an obligation unaccounted for is unsound
  regardless of how many checks it ran.
- **Not a false positive:** a real defect in the fixture that a trial finds on
  the clean build. If a suite reports a violation on the canonical build that
  reproduces by hand and is a genuine fixture bug, it is a **true positive**,
  the fixture is fixed, and the fix is a tuning-log row before the freeze — this
  happened twice in P1 and both times the reporter was right.

### 6.4 Also recorded, not gated

Authoring wall clock and cost per trial; loop iterations used; requests spent
authoring; replay requests, wall time, and cost per build; suite size (checks,
obligations, operations touched); cross-trial variance; adjudication time in the
proposal trial; per-arm minimality of the reproducing evidence.

## 7. Budgets

Derived from what the P1 agent-suite arm actually used (~2.5 h of authoring
once; 285–290 requests per replay under a wire-enforced 360-request cap) and
from the probe arm's measured spend. **All frozen.** Every number below is the
value the harness already enforces — `scripts/lib/handout.mjs` → `STUDY`, which
§3 pins by digest — so a measured run does not need a flag, and the environment
overrides that module accepts (`S0_BUDGET`, `S0_TIMEOUT_MS`, …) exist for
development rounds only and may not be set in a measured one.

### 7.1 Authoring (per statements-trial)

| Budget | Frozen value | Reasoning |
|---|---|---|
| Loop iterations (executions of `./run.sh`) | **≤ 12** | P1's author converged in a handful of passes; 12 leaves room for a script defect and a recovery without licensing an unbounded loop |
| Wall clock | **≤ 3 h** | P1 spent ~2.5 h; the bound is the observed cost plus slack, not an aspiration |
| Requests during authoring | **≤ 1 500** against the clean build | development traffic is cheap and unmeasured; the cap exists so "author against the API" cannot become "fuzz the API" |
| Model cost | **≤ $25** | P1's probe arm cost $20.22 *per build*; an authoring pass that costs more than one probe build is a finding in itself |

These are `BRIEF.md`'s numbers and `CLIENT.md` §11's numbers, which is the point:
a trial is told its budget in the same words the study scores it against.

Termination is on **soundness, not success** (N5): no script defects, within
budget, every check exercised, every obligation accounted for. A failing check
is kept as an evidence-backed finding, never revised away without a
transcript-recorded justification citing the spec or a statement. Exit 0 is
**not** the termination condition — the gate column can fail on a sound run
(§3), and both `BRIEF.md` and `CLIENT.md` §8 say so.

### 7.2 Replay and one execution (per build, per arm)

- **360 requests, wire-enforced** — P1's budget verbatim, so the arms stay
  comparable across the two studies. A replay that exceeds it is truncated at
  the wire and the truncation is recorded.
- **600 000 ms (10 min) per execution**, wall clock (`STUDY.timeoutMs`). The
  process is killed at the ceiling and reports a `timeout` defect; the HAR
  flushed so far survives. This is ~1 000× the observed execution time
  (`HARNESS-DRYRUN.md`: 0.6 s for a 285-request suite), so it bounds a hang
  rather than a slow suite.
- **15 000 ms per request** (`STUDY.requestTimeoutMs`); the client records a
  `transportError` and does not retry (§3, retry policy).

### 7.3 Proposal trial

Authoring budget as §7.1, plus a read-only observation pass before proposing:
**≤ 60 requests, ≤ 30 min, GET/HEAD only**, with **no write grant at all** — a
mutation is refused at the wire, produces no HAR entry, and is recorded
(`HARNESS-DRYRUN.md` item 5; `TARGET-AUTHORIZATION.md`).

**Adjudication protocol.** The study maintainer adjudicates, alone, before
phase 2 begins and without having seen any statements-trial's suite:

1. Each proposal in `PROPOSALS.md` gets exactly one verdict — **approved**,
   **approved as edited** (the edited text is recorded verbatim), or **denied** —
   plus one line of reason and the **wall-clock time spent on that card**.
2. A verdict cites what it rests on: a spec fragment, a declared consistency
   note, or the reference rule (§2.1) it is equivalent in substance to. Recall
   is scored from those citations, so an approval with no citation is not a
   recall hit.
3. Denials are classified as *unsupported* or *harmful* (§9.2) at the same time,
   never afterwards.
4. Total adjudication is time-boxed to **≤ 45 min**; the actual per-rule times
   and the total are published with the report. Running out of time is recorded
   as a result, not as a reason to skip a card.
5. Phase 2 receives an `INVARIANTS.md` containing the approved cards as
   adjudicated and nothing else — no reference rule the trial did not propose,
   no editorial improvement beyond what step 1 recorded.

### 7.4 Probe rematch

P1's frozen budget, unchanged: 360 requests or 3 h wall clock per build,
whichever exhausts first; the six stories once each per build; one Playtest run
at a time, ever. Expected total ~$220 at P1 rates. Run detached (`nohup`), never
as an agent background task.

## 8. Execution ordering, isolation, and reruns

1. **Order.** Every build of a round — each fault build, the three canonical
   clean builds, the four conforming-variant builds, and the ten jittered
   repeats — is replayed in one **seeded random order**, so a drifting
   environment cannot systematically favour the faulted builds or the clean
   ones.

   ```
   REPLAY_ORDER_SEED = 4adf038b88f9421c
   generated at the freeze with:  openssl rand -hex 8
   ```

   The seed is passed as `--seed` (or `$REPLAY_ORDER_SEED`) to
   `replay-round.mjs`, which refuses to run without one, shuffles with the
   fixture's own mulberry32/FNV-1a PRNG, and writes the resulting order to
   `rounds/<round>/order.json` **before the first build runs**. Every arm in the
   round uses this one seed, so all four suites meet the builds in the same
   order and an ordering effect cannot masquerade as a between-arm difference.

2. **Isolation, per build and per fault.** One dedicated fixture instance per
   build on a private port; `LEDGER_SEED=ledger-dev-seed`; `LEDGER_FAULTS` set
   to **exactly one fault id** for a fault build (never a combination — 14
   sealed faults means 14 fault builds per arm, each isolated, so a per-fault
   funnel diagnosis is about that fault and nothing else); `LEDGER_VARIANT` /
   `LEDGER_JITTER_MS` set per conforming build; a seeded `POST /admin/reset`
   issued by the harness immediately before the suite starts; teardown after.
   No build inherits another's state and no arm is trusted to clean up after
   itself (the P1 rule: isolation is the harness's job). One row per build is
   appended to an append-only `manifest.jsonl`, so an interrupted round resumes
   at the next unrun build rather than restarting.

3. **Infrastructure failure** — the fixture failing to boot or answer `/health`,
   the recorder dying, a port collision, the host sleeping, the model platform
   erroring or rate-limiting *during authoring*, or a runner/harness crash
   outside the suite's own code (`trial-run.mjs` exit 3, or a throw from
   `replay-round.mjs` itself). Disposition: the build is discarded and re-run
   from a fresh instance and a fresh seeded reset; the failed attempt is
   recorded in the round log with its cause, its timestamp, and its attempt
   number. **At most two infrastructure re-runs per build** (three attempts
   total); a third failure stops the round, and the round log plus the failure
   are reported verbatim rather than the round being quietly restarted. A round
   with an honest infrastructure failure in it is worth more than a tidy one
   that dropped a build.

   During **authoring**, the same rule applies once, to the trial rather than
   the build: a platform failure that ends a trial before it produced a suite is
   an infrastructure failure and the trial is re-run with a fresh agent from the
   same handout, at most twice, each attempt logged. A trial that produced a
   suite is a result — a poor one is not infrastructure.
4. **A suite defect is not infrastructure.** A script that throws, hangs, or
   exhausts its budget is a *trial result*: it is reported in the suite-defect
   channel and counts against that trial's soundness. It is never re-run to get
   a better number.
5. **No other reruns.** A build that produced a scored result is never re-run.
   No partial re-scoring, no arm-specific re-scoring, no post-hoc relabelling.
6. **Post-freeze changes: none.** Not a prompt, a brief, a threshold, a budget,
   an oracle, a variant, or a seed.

## 9. The three preregistered bars

Each is computed strictly as written, and each is recorded in `DESIGN.md` in the
same change as the report.

### 9.1 Proceed / stop (the pivot decision)

Every fraction below is resolved to the integer it means, against the sealed
set's actual composition (§4.2: 14 faults, 13 semantic-tier) and the reference
rule set's actual size (§2.1: 16 rules). The integer governs.

**PROCEED requires both:**

- **(a) Detection.** **Every** statements-trial detects **≥ ⅔ of the sealed
  semantic-tier faults** on the **reported-with-correct-evidence** column.

  > 13 semantic faults · ⅔ × 13 = 8.67 → **≥ 9 of 13, per trial, in all three
  > trials.**

  "Every trial", not the best and not the mean, because the product ships one
  author's output. The denominator is the 13 semantic-tier faults, not 14: the
  one schema-reachable fault is reported beside the bar, never inside it.
- **(b) Zero false positives.** **0**, across all four trials' suites, in
  **both columns**, on every conforming build: the 3 canonical clean builds,
  the 4 conforming-variant builds, and the 10 jittered repeats (§5) — 16
  conforming builds per suite, 64 in the round. Not "few", not "none that
  reproduce": zero (§6.3 defines what does and does not count).

Judgment inputs, reported but not gated: authoring cost and time, suite size,
cross-trial variance, per-category results, the funnel diagnoses, and the
column-one numbers with their `column_one_covered` denominator.

A failing S0 stops the pivot after S1; the shipped journey track stands alone
and this plan gets a closing note.

### 9.2 The Level 1 disposition (gates S3's headline — N6)

Measured on the proposal-quality trial. **Level 1 ships as the zero-input
headline experience only if all three hold:**

- **Recall ≥ ⅔ of the reference rule set** (§2.1), each counted proposal
  adjudicated *equivalent in substance* to a reference rule by the maintainer.

  > 16 reference rules · ⅔ × 16 = 10.67 → **≥ 11 of 16.**

  One proposal may match at most one reference rule, and one reference rule may
  be matched by at most one proposal; a card that restates HTTP or the default
  policy set matches nothing.
- **Precision:** **zero harmful proposals**, and **≤ 20 % unsupported**.

  > The brief asks for 5–8 cards. ⌊0.2 n⌋ → **at most 1 unsupported** at any
  > n from 5 to 8 (and 0 if fewer than 5 cards are submitted).

  A proposal is *harmful* if approving it would make a conforming build fail —
  it contradicts the spec, the declared consistency model, or a declared
  exception. It is *unsupported* if nothing in the spec motivates it and it is
  not a rule of this domain. Harmful is the hard zero because a wrong approved
  rule is a false positive forever.
- **Detection with only its own proposed-then-adjudicated rules: ≥ ½ of the
  sealed semantic faults** on the reported column.

  > 13 semantic faults · ½ × 13 = 6.5 → **≥ 7 of 13.**

Otherwise Level 1 ships as **assisted authoring**: same cards, narrowed copy
("review and confirm your API's rules"), no zero-knowledge claim.

Adjudication follows §7.3's protocol and is published per rule — verdict,
one-line reason, citation, time spent — with the report.

### 9.3 The probe-seam disposition (N15)

**The question, and only this question:** *is there any taxonomy category where
the probe detects a sealed fault that all three authored suites miss?*
Detection is on the same reported/oracle columns and the same budgets; the
comparison is per category.

- **Yes** → the hybrid roadmap seam is licensed (DESIGN §10): the probe
  explores, findings distil into script checks through the ordinary
  card/revision flow. Never the generative engine (N14).
- **No** → the live track closes, with two studies of evidence behind the close.

Instrument: P1's frozen tree at `9059797`, with **at most one declared tuning
round against development faults only**, re-frozen before the sealed round. The
tuning round, if it happens, is a tuning-log row that names every change and
predates the re-freeze SHA. The probe arm ships no structured report, so its
column 2 is `null` by construction and its funnel stages 1, 4 and 5 are unknown
— stated here so nobody reads a blank as a miss.

**The coverage caveat, and it is the whole shape of this comparison.** The
probe's verdicts come from the frozen P1 oracles, whose vocabulary is the seven
declared invariants. **Ten of the fourteen sealed faults lie outside that
vocabulary** — declared by the sealed author alongside the composition in §4.2,
as a coverage count and nothing more, so recording it discloses no mechanism —
so column one can credit the probe on **at most 4 of 14**, and on
the other ten the probe's row is `detected: null` with
`column_one_covered: false`. Three consequences, all binding:

1. A blank in the probe's column one is **"not covered by the pinned oracle"**,
   never "the probe missed it". The bench emits exactly that distinction; the
   report reproduces it and never collapses the two.
2. The probe's denominator is stated as the covered subset (**/4**), beside the
   authored suites' **/14** and **/13**, never as a shared **/14** that would
   quietly halve the probe's rate.
3. The §9.3 question — *is there a category where the probe detects what all
   three suites miss?* — is therefore answerable in the probe's favour only
   within those 4, or through the witnesses. Where an authored suite's column
   two credits a fault column one cannot see, the comparison says so in those
   words rather than reading the probe's blank as a loss.

This asymmetry is not a defect of the sealed set: the taxonomy is about what a
test author must *do*, and it was always going to outrun a seven-oracle
vocabulary. It is recorded here, before the round, so it cannot be discovered
afterwards by whoever it favours.

## 10. Procedure

1. **Development rounds** (any number, each a tuning-log row): build the
   substrate, the briefs, the variants, and the bench against the 13 public
   faults. Everything is tunable here and nowhere else.
2. **Seal.** An isolated agent authors the sealed set outside the checkout; the
   orchestrator records its sha256 in §4.2 without reading it.
3. **Freeze.** ✅ *Done — this commit.* Every placeholder filled, the banner
   flipped to FROZEN, `verify-instrument.mjs` green, the root gate green, the
   fixture suite green, and the freeze SHA recorded in the tuning log by the
   commit that immediately follows.
4. **Measured trials.** Three statements-trials and the proposal trial author
   against the clean build under §7. Then the sealed-round operator applies the
   sealed patch in the measured environment, verifies its manifestation tests
   there, and replays every suite against every build per §8. The probe arm runs
   its rematch. All traffic and every report scored by the bench.
5. **Post-round.** No tuning of any kind. The operator discloses the sealed
   faults in full — the report needs their mechanisms to state evidence
   correctness — and the patch plus its manifestation tests are committed to
   history.
6. **Report.** `REPORT.md` with per-category detection per trial in both
   columns and funnels, false positives across clean and conforming builds,
   cross-trial variance, authoring time and cost, the proposal-quality table
   with adjudications, and the probe arm's category comparison. The three
   dispositions (§9) land in `DESIGN.md` in the same change.

## 11. The freeze checklist

- [x] §2.1 statement set and its sha256 — `INVARIANTS.md`, `ce0c9443…12ccb`,
      13 sections / 16 rules
- [x] §3 substrate fingerprints — every row, 54 files, substrate digest
      `99dd1549…1b26e`; model id, decoding and retry policy filled honestly
- [x] §3 Level 0 gate policy set pinned as shipped (four policies)
- [x] §3 statements → rule-obligation derivation pinned; 13 rule obligations,
      33 obligations in total, no approvable skip
- [x] §4.2 sealed-set sha256, byte count, and declared composition
- [x] §5 jitter value (250 ms) and repeat count (10)
- [x] §7 every budget frozen, including the 600 000 ms per-execution ceiling
      and the adjudication protocol
- [x] §9 every threshold resolved to an integer against the real counts
      (≥ 9 of 13 · ≥ 11 of 16 · ≥ 7 of 13 · ≤ 1 unsupported · 0 harmful · 0 FP)
- [x] §3/§8.1 replay-order seed — `4adf038b88f9421c`
- [x] Tuning log: `freeze` row — the instrument SHA lands in the commit that
      immediately follows this one

## 12. Tuning log

Every instrument change before the freeze is a row here — what changed, why, and
the commit. This is the discipline that made P1's negative result trustworthy:
three of its rows are cases where building the *comparison* revealed something
that would otherwise have flattered the arm under test, and the log is where
they were caught rather than buried.

Recording discipline: one row per declared round; the row states the change even
when the change is "none"; a false positive found on a clean build in a
development round is dispositioned in its row (fixed instrument, or accepted as
a real fixture defect with the fix's commit); nothing may be added after the
`freeze` row except the measured round's own rows.

| Round | Instrument change | Commit |
|---|---|---|
| prep-1 | Apparatus only, no measured trial. Added the bench's second column (`reported-with-correct-evidence`), the five-stage funnel, the per-fault witness registry, the fault taxonomy and per-category aggregation, the instrument pin file with its drift test, three conforming-variant builds plus a latency-jitter flag with their own fixture tests, and this study's scaffold and round scripts. The shared oracle (`lib/oracles.js`, `lib/trace.js`) is **byte-identical to P1's freeze** (`04a3c69f…131c`, `8d822ce6…df64`) so the probe rematch stays comparable. No fault added, no trial run, no model called. | `49302dd`, `66a2405`, `662bceb`, `49c1a3d` |
| prep-2 (substrate) | The S1 script substrate became the study's one execution substrate: the bench learned to read the runner's `script_report_version: 1` report and its nested obligation manifest natively, and the frozen P1 agent-suite arm was ported to the script contract and re-scored to prove the substrate does not distort the instrument — `parity: MATCH` on all five labelled builds, 285 requests per build as in P1 (`substrate-parity/RESULTS.md`). Three substrate differences the parity had to survive are recorded there; none of them is a scoring change. | `df18777`, `298ff61`, `480b85e`, `c8649da` |
| prep-3 (statements) | **The §2.1 statement set was extended before sealing**, as this file requires: P1's seven rules in six sections → 13 sections carrying 16 rules, covering the whole of the service's obligation space (fees, settlement, ownership, documented parameters, reference integrity, the daily limit, the status split, determinism). Extending it afterwards is forbidden; this row is the extension. Also the briefs and the trial handout/run-wrapper machinery. No fault added, no model called. | `7ec069f`, `6e33b3b`, `40f7360`, `6b60ceb` |
| prep-4 (principals) | **A fixture change, and an instrument change because of what it makes measurable.** The fixture had one customer principal, so `authorization` meant the admin/customer role split and nothing else — the taxonomy's eighth category was unreachable and would have had to be reported *not measured*. Accounts now record an `owner_principal`, there are two customer principals with a bearer token each, and authorization is evaluated after existence and before state (404 → 403 → 409/410). The document declares the ownership invariant and 403 on every operation that answers it. Clean-build tests extended; no fault added. | `5e9e474` |
| prep-5 (dry run) | Apparatus verification, no measured trial and no model call: `fingerprints.mjs` (the §3 table, filled mechanically) and an end-to-end harness dry run from handout assembly to a scored four-build round (`HARNESS-DRYRUN.md`). It surfaced five items for this freeze; all five are dispositioned in the rows below or in §3. | `34be87b` |
| prep-6 (column one) | The bench scored a fault-labelled trace as detected or *not detected*, with no third answer — so a fault whose rule no pinned oracle owns would have been scored as a miss by every arm, reddening rounds for a reason unrelated to any arm and inflating the denominator. A fault's expectation may now declare no codes: its traces score `detected: null`, the row carries `column_one_covered`, and the summary reports how many faults fell outside the vocabulary. No number changed — all 13 public faults declare codes — but §9.3's comparison depends on it, because 10 of the 14 sealed faults lie outside the P1 oracle vocabulary. | `398fb29` |
| prep-7 (pins) | Bench pins re-recorded against the tree (`HARNESS-DRYRUN.md` item 4: `lib/suite-report.js`, `lib/witnesses.js`, `src/faults.js` were stale from the fixture lane's own work). `shared_oracle` **unchanged** — `lib/oracles.js` `04a3c69f…131c`, `lib/trace.js` `8d822ce6…df64`, still byte-identical to P1's freeze. `verify-instrument.mjs` green afterwards. | `5e2ff0e` |
| spec-400 (freeze) | **A real defect in the document, found by the harness dry run and fixed rather than tolerated.** The fixture answers `400` in the standard envelope to a malformed percent-encoding in a path segment and to an unparseable JSON body — path decoding and body parsing both happen before routing — but the OpenAPI document declared `400` on only nine of its sixteen operations, so the Level 0 `documented_status` policy failed on the **clean** build (`HARNESS-DRYRUN.md` §3). Enumerated by exercising every operation's malformed-input paths against a running clean fixture, not by reading the router: seven operations answer `400` undeclared — `GET /accounts/{accountId}`, `POST /accounts/{accountId}/activate`, `POST /accounts/{accountId}/close`, `GET /deposits/{depositId}`, `GET /transfers/{transferId}`, `POST /transfers/{transferId}/cancel`, `POST /admin/reset`. Each now declares `400` via the existing `BadRequest` response component (21 lines; no new schema, no new prose, no other status added). **The gate was not weakened**: all four Level 0 policies stand exactly as shipped. Proof: the ported P1 suite through the trial harness on the clean build is now `gate pass — 4 of 4 policies applicable`, 27/27 obligations, 285 requests, **exit 0**; the full parity matrix still reports `parity: MATCH` on all five labelled builds; fixture suite 116/116 with a new regression test that exercises the malformed-input path of every operation. The 413 payload ceiling is *not* declared and does not need to be: the fixture destroys the socket, so no `413` response is ever recorded. | `6aa5b75` |
| creds-2 (freeze) | **Wiring the second customer credential through the trial harness**, without which prep-4's work would not have reached a trial. The harness now declares three credentials by name for every trial and every replay — `LEDGER_ADMIN_TOKEN`, `LEDGER_CUSTOMER_TOKEN`, `LEDGER_CUSTOMER_B_TOKEN` (`scripts/lib/handout.mjs` → `STUDY_SECRETS`, `resolveStudySecrets`) — resolving each from the operator's secrets file, then the environment, then the fixture's published default, always as a whole `Bearer …` header value. `handout-src/CLIENT.md` §3 documents all three and states explicitly that **which principal is which is learnable only by acting**; `TARGET-AUTHORIZATION.md` names them. `BRIEF.md` was left unchanged: "across principals" was already true and adding rule content to a brief is a knowledge change, not a wiring one. Verified on loopback with no model: both customer references inject and authenticate, open accounts under `customer_a` and `customer_b` respectively, are refused `403` on each other's account, and appear in the HAR only as `[secret:…]` placeholders. §4.3 now records the authorization category as **measured**, and why. | `6aa5b75` |
| pin-self (freeze) | `fingerprints.mjs` no longer fingerprints `PREREGISTRATION.md`. A file that records a digest set cannot be inside it: the recorded substrate digest would have been wrong the instant it was pasted in, and re-running the script on the frozen tree could never have reproduced it. The preregistration is pinned by the freeze commit's SHA instead (§3, and the row below). 54 files, substrate digest `99dd1549…1b26e`. | `6aa5b75` |
| freeze | **Instrument frozen.** Banner flipped DRAFT → FROZEN with every placeholder filled; `verify-instrument.mjs` green (bench pins match the tree, the P1 vendored oracle copies in sync); root `npm test` green; fixture suite 116/116; the harness dry run re-run end to end on the fixed spec (`gate pass`, exit 0 on clean); `substrate-parity` re-run, `parity: MATCH` 5/5. The sealed patch was **not** touched, read, or re-verified by this work — the spec change is confined to `openapi.json` plus tests and docs, so the sealed-round operator re-confirms applicability with `git apply --check` at round time. **Instrument pin: `6aa5b75`.** Everything after this row is the measured round. | `6aa5b75` |

---

## 13. Post-round errata

**Appended 2026-07-26, after the sealed round was scored** (`81553f8`,
`bb858f1`; `rounds/sealed-round/RESULTS.md`) and after the sealed set was
unsealed into history. **Nothing above this line is edited.** Everything §1–§12
says still binds exactly as frozen; this section only records where what that
text *says* and what is *true* came apart.

Three discrepancies, found by the round operator: a summary integer that
disagrees with its own enumeration, a substrate digest taken before a fix that
was then taken, and a list of touched files that is short by one. All three are
**recording errors, not post-freeze changes** — nothing was tuned, no threshold
moved, no build was added or dropped, and **none of them changed a measured
number**. Each entry below gives the correct value and says why the measurement
is unaffected.

`PREREGISTRATION.md` is deliberately not one of the 54 fingerprinted files (§3),
so appending this section leaves the substrate digest exactly where it was.

### (a) §5 and §9.1(b): "16 conforming builds … 64 in the round" should read 17 and 68

§5 says "**16 conforming builds per suite** — 3 canonical clean, 4 variant
builds, 10 jittered — and … **64 conforming builds in the round**", while the
enumeration in that same sentence is 3 + 4 + 10 = **17**, and 4 arms × 17 =
**68**. §9.1(b) repeats the same pair.

**Correct value: 17 conforming builds per suite, 68 in the round.** The
enumeration is what the harness implements — `replay-round.mjs`'s frozen
defaults `--clean-repeats 3`, the three conforming variants plus the combined
`all-variants` build, and `--jitter-repeats 10` — and passing anything else
would have been the forbidden post-freeze change. So the round ran the
enumerated set, 17 per arm and 68 in total, every one of them scored in both
columns. Nothing was added and nothing was dropped: the summary integer simply
disagrees with its own list by one.

**Why no measured number moved.** §9.1(b) is an absolute, not a rate: *zero*
false positives, in both columns, on every conforming build. Zero is zero at
either denominator, and a bar that cannot be expressed as a fraction cannot be
mis-set by a wrong denominator. The round's result is 0 column-one false
positives on all 68 and 0 column-two false positives on 51 of them; the
remaining 17 are statements-trial 1's `status-400-for-a-wrongly-typed-field`,
which is D2 and which §6.3 classifies as a true positive, reported both ways in
`RESULTS.md` §4 and adjudicated in `REPORT.md`. That disposition is the same at
16 builds or 17.

### (b) §3's substrate digest predates the D1 fix

§3 records `99dd15499b45c70be63f3c4c4ed3af43e91e37542662efc387416ec8a5a1b26e`
over 54 files, fingerprinted on the freeze tree `6aa5b75`. The round replayed
against `46c201b`, which fingerprints to
**`381caf119e83fc89a648342ae576df603ff7e94e6016e062924fe12b6fd86878`**. The
file *set* is unchanged — still exactly those 54 — and exactly one digest moved:

| File | at the freeze (§3) | at the round |
|---|---|---|
| `$LEDGER_FIXTURE_DIR/src/ledger.js` | `9fc4dd2302837d02…5e8fe8a608e7c258e0325a3` | `e9b2cf1b0bd1071c…25058f7061ab887c` |

That one file is `12cba1d`, the post-freeze fix of **D1** — the pagination
tie-drop where a quiescent `GET /accounts?limit=1` walk dropped `acc_fee_eur`,
found by the proposal trial's phase-1 observation pass, reproduced by hand, and
recorded in `rounds/ROUND-LOG.md` together with the sealed set's rebase onto it.
Every other one of the 54 is byte-identical to the freeze: all seven oracles,
both `shared_oracle` files, the runner, the injected client, the report schema,
the OpenAPI document, `oracle-pins.json`, and all four briefs and handouts.

**The error is not the fix.** §8 item 6 forbids post-freeze changes to the
*instrument*; D1 is a defect in the *subject*, found on a conforming build,
which is precisely the case §6.3 provides for — "a real defect in the fixture
that a trial finds on the clean build … is a true positive, the fixture is
fixed". The error is that §3, being frozen, still shows the pre-fix digest, and
a reader recomputing the digest would find a mismatch with no note here saying
which file and why.

**Why no measured number moved.** The fix landed before the replay and applies
identically to all four arms and to all 31 builds of each, so it cannot favour
an arm or a build class. Statements-trials 1–3 authored against pre-fix
instances, deliberately (`ROUND-LOG.md`), and the one arm that wrote a check for
it — statements-trial 3's `accounts-enumeration-is-complete` — passes on all 17
of its conforming builds at replay and fails only on the sealed fault
`f-include-closed-ignored`, where the failure is a detection. That is
`RESULTS.md` §4.1.

### (c) §4.2's `touches:` line is short by one, and by three more

§4.2 records the sealed patch as touching `src/faults.js`,
`bench/lib/witnesses.js` and `bench/lib/score.js`. Applying it also modifies
**`src/ledger.js`** — necessarily, because that is where every `[FAULT …]`
branch in this fixture lives — along with three test files:
`test/faults.test.js`, `test/columns.test.js`, and
`test/support/manifestations.js`. The sealed bundle's own manifest lists all
seven, and the patch is now public (`5886549`).

**Correct value: the patch touches seven files, four of which are pinned or
fingerprinted.** The `touches:` line was written for one purpose — to name the
files the operator must re-record with `bench:pins --write` — and those three
are exactly the pinned `bench_scoring` files. It reads, wrongly, as an
exhaustive list of the patch's contents. The four measured digests, all
reproducible by applying the patch to the round's tree:

| File | before the patch | with the patch applied |
|---|---|---|
| `src/ledger.js` (substrate, fingerprinted) | `e9b2cf1b0bd1071c…25058f7061ab887c` | `58435dc30a09b4f7…6c5b9cbc717e510b` |
| `src/faults.js` (`bench_scoring`) | `99224090127b338e…3c40ad0e4d7ac6e3d3e` | `3ef70436fe864d1d…e99f79573ed2282ae4` |
| `bench/lib/witnesses.js` (`bench_scoring`) | `72a947d07ddc7a6e…59a48d7f541304d8c9` | `5924fb6ed6f1c8db…41a1a41a9a8e6f78` |
| `bench/lib/score.js` (`bench_scoring`) | `a36caf69d4d436a7…cb03a4e14e0393a9b10` | `38565dde923d5206…41b5c577a0bad54ed` |

**Why no measured number moved.** The post-apply obligation §4.2 imposes is the
pin re-record, and it covers exactly the three `bench_scoring` files it names;
`src/ledger.js` is fingerprinted as substrate, not pinned as scoring, so no step
the operator owed was omitted and `verify-instrument.mjs` is green either side
of the apply. `shared_oracle` — `lib/oracles.js` `04a3c69f…131c`, `lib/trace.js`
`8d822ce6…df64` — is untouched by the patch and byte-identical to P1's freeze,
which is the one property the probe rematch depends on. What the short line
would have cost is a reader's time reconciling §3 against a patched tree, which
is why it is corrected here rather than left for them to find.
