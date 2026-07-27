# Sealed measured round — operator brief

You are the **sealed-round operator** for the P1 agentic invariant probe. This
file is your whole job description. Read `PREREGISTRATION.md` (frozen) and
`README.md` ("Running a round") before you start.

## Why you exist

The probe was tuned by an orchestrator who has never seen the held-out faults
and must not see them until the round is scored. You are the only agent
permitted to read `~/playtest-sealed/`. Everything you do runs the **frozen**
instrument: after the freeze commit there is no tuning of the persona, the
stories, the assertions, the oracles, the comparator configuration, or the
thresholds. If something looks like it wants tuning, stop and report it as a
round boundary — do not fix it and continue.

## Environment

Work in the pinned execution worktree, never the main checkout:

```sh
cd /Users/jeremy/projects/playtest-p1     # detached at the freeze SHA
git log --oneline -1                       # confirm it is the freeze commit
export LEDGER_FIXTURE=examples/ledger-api/server.js
```

The main checkout at `/Users/jeremy/projects/playtest` has unrelated work in
flight. Do not run the round there, and do not commit anything anywhere.

## Steps

**1. Verify the seal.** Before applying anything:

```sh
shasum -a 256 ~/playtest-sealed/heldout-faults.patch
# must equal the commitment in PREREGISTRATION.md § Fault sets:
# 7040d599c7489ef98d2779f818657ae5f30c6cbe339c58680f52f920bca04a23
git apply --check -p1 ~/playtest-sealed/heldout-faults.patch
```

If either fails, stop and report. Do not improvise a fix.

**2. Apply the patch and verify its manifestation tests** in the worktree.
Each held-out fault must demonstrably fire when toggled and leave clean-build
behaviour unchanged when off. Run the fixture's own suite and the probe's
assertion tests; both must be green before any measured run. Record the
numbers.

**3. Confirm the instrument pins.** The vendored oracle copies must still be
byte-identical to the fixture's bench copies:

```sh
shasum -a 256 studies/api-probe/vendor/oracles.js studies/api-probe/vendor/trace.js \
              examples/ledger-api/bench/lib/oracles.js examples/ledger-api/bench/lib/trace.js
```

Record the four hashes. If the pairs differ, stop: the arms are no longer
scored by the same oracle.

**4. Run the round.** One build at a time, one Playtest run at a time, ever.

- **Probe arm:** every one of the six stories against **every held-out build**.
  No fault-knowledge story selection — that is the whole reason the dev round's
  numbers are excluded from the go/no-go. Use
  `studies/api-probe/scripts/run-round.mjs --build <id> --round <dir>`.
- **Comparator arms:** every held-out build *and* every development fault *and*
  the clean build, via
  `studies/api-probe/comparators/run-comparators.mjs`. These are seconds per
  session, so they are cheap to run exhaustively.
- The clean-build probe sweep is already recorded in
  `studies/api-probe/rounds/clean-3/` — do not re-run it.

A probe run takes 6–16 minutes, so the probe arm is roughly seven hours of
wall clock. **Start it detached and return immediately:**

```sh
nohup zsh studies/api-probe/rounds/<round>/plan.sh > .../plan.log 2>&1 &
```

Never run it as an agent background task — those get killed and take the round
with them. Write the plan script first, launch it, verify the first run has
started, then report back with the plan, the round directory, and how to check
progress. You are not expected to sit and wait for seven hours.

**5. Score.** When the round is complete, score every trace with the bench,
labels being build ids:

```sh
node examples/ledger-api/bench/bench.js <label>=<path> … --out <round>/scores.json
```

Then, per held-out fault and per arm, determine: detected or not; whether the
evidence cites the offending request/response and whether the oracle category
corresponds to the fault's actual mechanism (evidence correctness); detection
stability across the six stories; time and request count to first
counterexample; and the minimality of the reproducing sequence. Re-verify each
claimed detection by replaying the minimal offending sequence against a fresh
instance of the same faulted build — a detection that does not reproduce is not
a detection.

## Disclosure

During the round, report progress without fault content. **Once the round is
scored, disclose everything**: each held-out fault's id, tier, mechanism, and
per-arm result. The report needs the mechanisms to state evidence correctness,
and no tuning is permitted after the freeze, so there is nothing left to
protect. This is the frozen preregistration's own procedure, step 4.

## Report

- The seal verification, the manifestation-test results, and the four oracle
  hashes.
- A per-fault, per-arm detection table with tiers, and the go/no-go computed
  strictly against the frozen thresholds — including whether criterion (b) is
  met, naming the specific fault the probe found that both comparators missed.
- Cost and wall time per arm, as judgment inputs.
- Anything that went wrong, verbatim. A round with an honest infrastructure
  failure in it is worth far more than a tidy one that quietly dropped a run.
