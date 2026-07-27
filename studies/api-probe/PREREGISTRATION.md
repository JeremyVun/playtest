# P1 agentic invariant probe — preregistration

Status: **FROZEN.** The instrument pin is this commit's tree; its SHA is
recorded in the tuning log's `freeze` row, which lands immediately after (a
commit cannot contain its own hash). From this commit onward, no threshold,
budget, seed, comparator configuration, or instrument change is permitted
until the probe report is committed. Implements `docs/backlog/api-testing/`
`BUILD_PLAN.md` P1 item 3 and DESIGN §4 "Measurement design", on the
hill-climb preregistration pattern.

## Question under test

Can a goal-directed actor, given a natural-language invariant and a
deterministic assertion, discover important violating sequences — with
acceptable false-positive and maintenance cost — that schema fuzzing and an
agent-authored functional suite miss? (DESIGN §4 Go/no-go.)

## Arms

| Arm | What runs | Knowledge given |
|---|---|---|
| **probe** | This suite (`studies/api-probe/`) via the Playtest CLI: `--fresh --no-grade`, api driver, `api-fuzzer` persona | The served OpenAPI spec + the six invariant stories (natural-language statements) |
| **schemathesis** | Schemathesis 4.24.2 (`.venv-schemathesis`), fuzzing + stateful phases, one session per build through the recording proxy; exact CLI recorded in `comparators/run-comparators.mjs` and in the report | The same served OpenAPI spec (which declares the §6.2 invariants as consistency notes, and the operation links) |
| **agent-suite** | A coding agent (Claude Opus, model recorded at freeze) with NO repository access, given only the served spec and the same six invariant statements, asked to write tests exercising them; authoring transcript kept; its tests run once per build | Spec + the same invariant statements |

All arms' traffic is scored by the same frozen oracles via the P0 bench
(`examples/ledger-api/bench/`). No arm gets a privileged oracle.

## Instrument pins (recorded at freeze)

- Probe suite instrument (persona, stories, assertions, vendored oracles):
  the freeze commit's tree. Vendored oracle equivalence is REQUIRED at round
  time: `studies/api-probe/vendor/oracles.js` and `vendor/trace.js` sha256s
  must equal the fixture's `bench/lib/` copies. Current values, after the
  `oracle-fix-1` round below: oracles
  `04a3c69f516fbced95b4dafc93ced3754249b89c191cf3a61660b435ce76131c`, trace
  `8d822ce60f55f86a45ca15a7154cafca73bf76d9b00943a7f98a8590edf0df64`.
- Actor and grader model: `gpt5_5` resolved to wire model `gpt-5.5` through
  the codex gateway (`PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8900`,
  `PLAYTEST_GPT5_5_MODEL=gpt-5.5`, `PLAYTEST_LLM_TIMEOUT_MS=305000`). The
  grader is not in the probe path (`--no-grade`); the pin exists so any
  incidental grading is attributable.
- Fixture: `examples/ledger-api/` at the freeze commit, `LEDGER_SEED`
  default (`ledger-dev-seed`), one dedicated instance per run, reset via the
  suite's `app.init` seeded `POST /admin/reset` — harness-owned isolation
  regardless of how the actor stopped.

## Fault sets

- **Development set (tuning):** the eight public faults of DESIGN §6.3,
  `examples/ledger-api/src/faults.js`.
- **Held-out set (measured):** the sealed patch at
  `~/playtest-sealed/heldout-faults.patch`, authored by an isolated agent,
  never read by the orchestrator or any probe-tuning agent. Content
  commitment: **sha256
  `7040d599c7489ef98d2779f818657ae5f30c6cbe339c58680f52f920bca04a23`**
  (21903 bytes). Author-reported composition: 5 faults — 1 schema-reachable,
  4 semantic — each detectable by the frozen oracles, collectively spanning
  5 oracle categories. The patch is applied only in the measured-round
  environment by a sealed-round operator agent, and committed to history
  after the round.

## Budgets (arm-neutral, per faulted build per arm)

Finalized from development-round measurements (a 60-step probe run takes
6–15 minutes wall — BUILD_PLAN's illustrative "5 runs inside 30 minutes"
default is physically impossible for the probe arm and is replaced here, as
BUILD_PLAN P1 explicitly allows: "Defaults, finalized only in that commit").

- **360 requests or 3 hours wall-clock per faulted build per arm, whichever
  exhausts first.** No arm may use fault knowledge to allocate its budget.
- The probe spends its budget as **one fresh run of each of the six stories**
  (max_steps 60 → ≤ 360 requests). Detection stability is reported per-story
  (which stories' runs detected the fault), not by repeated identical runs.
- Both comparator arms send their traffic through the recording proxy
  (`comparators/har-proxy.mjs`), which **counts requests at the wire and stops
  forwarding at 360**. The budget is enforced rather than trusted: Schemathesis
  has no request cap, and is not reproducible run to run even under a fixed
  `--seed` (measured: 393 then 430 requests for byte-identical arguments), so
  tuning `--max-examples` to land under the cap cannot hold a budget. Its
  generation database is disabled so no build inherits what the previous build
  taught it.
- The agent-suite arm runs its authored suite once per build under the same
  wire-enforced cap.
- **Clean-build runs (probe): 12** — two full six-story sweeps against the
  clean build. Comparators: two sessions/executions each.
- **Which builds each arm runs.** The probe arm runs the held-out builds and
  the clean build; its development-fault results come from the development
  round recorded in this file's tuning log, where story selection USED the
  public fault→invariant mapping — reported with that caveat and excluded from
  the go/no-go, which is held-out only as §Go defines. The comparator arms are
  seconds per session, so they additionally run every development fault: their
  development-set numbers cost nothing and carry no selection advantage,
  because a comparator arm has no story to select.
- One run at a time, ever (`--parallel 1`); a run and its fixture instance
  are torn down before the next starts.

## Scoring definitions (all deterministic, via the bench)

- **Detected (per fault, per arm):** at least one oracle-confirmed
  counterexample in the arm's traffic whose reproduction — replaying the
  minimal offending sequence against a fresh instance of the same faulted
  build — re-verifies deterministically. Evidence must cite the offending
  request/response pair(s) and the oracle category must correspond to the
  fault's actual mechanism (evidence correctness).
- **False positive:** a VIOLATED oracle verdict on a clean-build trace. A
  clean-run `NOT_EXERCISED` gate failure is NOT a false positive; it is
  recorded separately as an exploration shortfall (the assertion's
  applicability rule working as designed). "Unresolved false gate failure"
  in the go criteria means a VIOLATED-on-clean verdict not dispositioned as
  a reproducible assertion-scoping bug and fixed during development rounds;
  any held-out-round false positive stands as recorded.
- **Detection stability:** fraction of the arm's budgeted runs that
  independently detect the fault — for the probe, how many of the six stories'
  runs against that build found it. A fault that only one story's run can
  reach is reported as such rather than counted as a stable detection.
- Also recorded per arm: time and cost to first counterexample, minimality
  of the reproducing sequence (request count), authoring effort.

## Go / no-go (computed on the held-out set only)

**Go** requires ALL of:

- (a) detected, with correct evidence, at least **two-thirds of the held-out
  semantic-tier faults** (with 4 semantic faults: ≥ 3);
- (b) at least **1 held-out semantic fault detected that BOTH comparator
  arms miss**;
- (c) **zero unresolved false gate failures** (as defined above) across the
  probe's clean-build runs.

Cost and wall time are reported as judgment inputs, not gated. The verdict
is recorded in DESIGN.md (status line + §7 gate) in the same change as the
probe report.

## Procedure

1. Development rounds (any number, declared in the tuning log below): probe
   runs against development faults and clean builds; persona/story/assertion
   tuning allowed ONLY between declared rounds; every change noted.
2. Freeze: this file flips to FROZEN in the freeze commit; instrument SHA
   recorded.
3. Measured round: the sealed-round operator (an isolated agent; the
   orchestrator never reads the patch) applies the sealed patch in a
   detached environment, verifies its manifestation tests there, and runs
   every arm per the budgets on the builds §Budgets assigns it. All traffic
   scored by the bench.
4. After the round: **no tuning of any kind** — persona, stories, assertions,
   oracles, comparator configuration, or thresholds. The seal exists to keep
   the instrument honest while it is being tuned, so once the round is scored
   the operator may disclose the held-out faults in full; the report needs
   their mechanisms to state evidence correctness. The sealed patch and its
   manifestation tests are committed to history; the probe report and
   go/no-go land in the same change as the DESIGN.md status update.

## Tuning log

| Round | Instrument change | Commit |
|---|---|---|
| smoke-1 | none — pipeline validation on the clean fixture found THREE gateway-side defects (strict-schema rejection of the step tool's untyped/enum-only fields; `tool_choice: "required"` answered in content instead of `tool_calls`; free-form headers map sanitized to an un-emittable empty object, causing a 60×401 run). All fixed in the codex-gateway repo (c8d7b67, 6010804, ca17ee3); zero instrument change. The failed smoke runs are infra, not clean-run false positives. | — |
| dev-1 | 8/8 development faults detected with correct evidence (matched-story selection, public mapping); 0 false positives across the clean runs. One run per fault sufficed (6–15 min, 40–60 steps); budgets above finalized from these measurements. No persona/story change. ONE declared oracle fix: the clean error-shape run went INFRA because `trace.js route()` crashed on a deliberately malformed percent-encoded path the actor sent (`/accounts/%E0%A4%A`) — `decodeURIComponent` now falls back to the raw segment (fixture + vendored copy synced, sha `8d822ce6…df64`; fixture suite 66/66; sealed patch verified still applying). The INFRA run is excluded as infra, and the story was rerun post-fix. | — |
| dev-2 | The post-fix clean error-shape rerun went RED — correctly. The probe found a **real, unseeded defect in the clean fixture**: a malformed percent-encoding in a path (`/accounts/%`) reached `decodeURIComponent` in the fixture's router and threw, so the service answered 500, violating its own declared "no operation answers 5xx" rule. This is a TRUE positive against the baseline, not an oracle false positive. Fixed in the fixture (400 in the envelope) with a regression test (67/67); the sealed patch was re-verified as still applying, so its sha256 commitment stands. Clean-build runs must be re-swept post-fix before the freeze. | bc7ac63 |
| comparator-setup | No probe instrument change. Building the comparator arms surfaced three problems with the *comparison*, all fixed before the freeze and all recorded here because each one, left alone, would have flattered the probe. (1) The fixture's OpenAPI document declared **no links at all**, so Schemathesis' stateful phase had nothing to chain — in a 360-request session it created 19 accounts, completed zero deposits and zero transfers, and reached none of the states the invariants live in. 22 links now span the account/deposit/transfer lifecycle; path-parameter transitions chain correctly as a result, and the links are invisible to the probe (the api driver lists operations by method, path and summary only — still 16). (2) Generated security parameters plus the `ignored_auth` and `missing_required_header` checks spent 136 of 360 requests re-proving the fixture's 401 path; all three are off, so the arm spends its budget where the comparison is. (3) The budget is now enforced at the wire by the recording proxy rather than by tuning `--max-examples`, because Schemathesis is not reproducible run to run under a fixed seed. **Known limitation, to be reported:** across three link configurations (`requestBody` expressions, the `body.<field>` parameter form, and `merge_body: false`) Schemathesis never constructed a valid deposit or transfer body, because on this API the resource reference lives in the request body rather than the path. That is a real limit of schema-driven stateful fuzzing here, not a harness defect, and the report states it as such. | `16f711e` |
| clean-2 | Aborted after 2 of 12 runs (both green) when the missing-links gap above was found. Restarted against the re-pinned fixture so that every clean run and every measured run faces one fixture. | — |
| oracle-fix-1 | **A declared oracle fix, and the last one: the idempotency oracle reported a violation on a CLEAN build.** One key produced two transfers — but under two different credentials. The invariant is scoped "per authenticated principal" and the service scopes its own records the same way (`${principal}:${key}`); the oracle keyed on the bare header. It now keys on the credential too, opaquely. This is the disposition this file prescribes for a VIOLATED-on-clean verdict in a development round, and it had to land pre-freeze: the probe's persona holds both tokens, so a held-out-round clean run could have recorded a false positive that by the frozen rules would have stood and failed criterion (c). Detection is unchanged (agent-suite 6/8 development faults before and after); fixture suite 68/68 with a regression test for both directions; vendored copy re-synced, **oracles sha256 `04a3c69f…131c`**, trace unchanged `8d822ce6…df64`. Found by the agent-suite comparator arm, not the probe — reported as such. | `d59e049` |
| clean-3 | Aborted after 13 minutes (0 of 12 runs recorded) when the oracle fix above landed. Restarted as **clean-4**, the sweep of record, against the fixed instrument. | — |
| clean-4 | **The clean-build sweep of record: 12 runs, two full six-story sweeps, every run green.** Zero VIOLATED verdicts in the gate and **zero findings at the bench** across all twelve traces (`rounds/clean-4/scores.json`), so go criterion (c) has nothing outstanding against it going into the measured round. 689 requests, 12 runs at 60 steps apiece bar two that stopped earlier, $43.61 and 3.2 hours in total — a clean run costs more than a detection precisely because nothing stops it early. No instrument change. | — |
| freeze | **Instrument frozen.** Preregistration flipped DRAFT → FROZEN with the clean-4 sweep green, the vendored oracles byte-identical to the bench copies (oracles `04a3c69f…131c`, trace `8d822ce6…df64`), and the sealed patch verified as still applying. **Instrument pin: `9059797`.** Everything after this row is the measured round. | `9059797` |
