# S0 — the agent-authored suite confirmation study (ledger domain)

The study that decides whether Playtest builds the script-authoring product
(`docs/backlog/api-testing/DESIGN.md` §7, `BUILD_PLAN.md` S0 — that plan was
retired on 2026-07-29 with its unbuilt S4/S5 dropped; read it via
`git log --full-history -- docs/backlog/api-testing/`. Shipped substrate
behavior lives in `docs/contracts/scripts.md`; current study work is
`docs/backlog/detection-study/api.md`). P1 killed the
live-probe thesis and, in passing, produced a surprising winner: an agent given
only a served OpenAPI document and six plain-language rules wrote an executable
suite that out-detected the probe at zero marginal cost
(`studies/api-probe/REPORT.md`). That is **one author against five faults**.
S0 asks whether it holds up.

> Does an agent-authored, human-approvable executable suite detect semantic
> faults in this API reliably enough — across independent authors, with zero
> false positives on conforming builds — to justify building the product around
> it? And can the platform *propose* the rules, or must a human supply them?

## What this study can and cannot claim

Stated first because it is the easiest thing to lose (DESIGN N12):

- **The claims stop at this fixture.** S0 is a *ledger-domain confirmation
  study*. Nothing in it is evidence about APIs in general; cross-API
  generalisation is S5's job, and S5 is a pilot, not a proof.
- **The sealed set is the only unbiased evidence.** The 13 public faults of
  `$LEDGER_FIXTURE_DIR/src/faults.js` are development data: they are visible
  while the instrument, the briefs, and the bench are being built, so numbers
  measured against them are reported *as development numbers* and excluded from
  every bar.
- **Replays are repeated measurements, not extra samples.** Three authored
  suites replayed against the same sealed fault produce three measurements of
  one fault. The denominator of every headline number is the count of sealed
  faults, never the count of trials × faults. A suite replayed 40 times against
  40 builds is one instrument, cheaply observed.
- **A per-category miss is the finding, not the average.** Results are reported
  per taxonomy category, because "9 of 13" over a catalog weighted toward state
  faults can hide a total miss on temporal boundaries — which is exactly what
  P1 found.

## The arms

| Arm | Handout | What is measured |
|---|---|---|
| **statements-trials** ×3 | served spec + the invariant statements | per-fault detection in both columns, funnels, authoring cost, cross-trial variance |
| **proposal-quality trial** ×1 | served spec only; the agent proposes rules first, a maintainer adjudicates them | recall of known rules, precision (unsupported/harmful proposals), detection using only its own adjudicated rules — this gates S3's Level 1 headline |
| **probe rematch** ×1 | P1's frozen probe instrument | the one narrow question left open: is there any category where the live probe detects what all three authored suites miss (DESIGN N15)? |

All arms are scored by the same bench, offline, from artifacts alone.

## Layout

```text
studies/api-suite/
  README.md                 this file
  PREREGISTRATION.md        the instrument, bars, and budgets — FROZEN; nothing in it changes until REPORT.md
  INVARIANTS.md             the invariant statements every arm's handout carries
  BRIEF.md                  the statements-trial authoring brief
  PROPOSAL-BRIEF.md         the proposal-quality trial's two-phase brief
  TARGET-AUTHORIZATION.md   the DESIGN §4 step 2 write grant this study's runs cite
  HARNESS-DRYRUN.md         the pre-freeze end-to-end check of the machinery below
  handout-src/CLIENT.md     the script contract, as a trial agent receives it
  scripts/
    lib/handout.mjs         one place for the budgets, the rule parser, and the write grant
    make-handout.mjs        assemble a trial's scratch directory (handout + run.sh)
    trial-run.mjs           execute a trial's suite through the S1 runner — what run.sh calls
    replay-round.mjs        replay one suite against clean, variants, jitter repeats, and fault builds
    fingerprints.mjs        the §3 substrate table, filled: commit, per-file sha256, one digest
    verify-instrument.mjs   pre-round gate: bench pins, vendored-copy sync, sealed-set commitment
  rounds/<round>/           per-round artifacts: order.json, manifest.jsonl, builds/, scores.json
  trials/<trial>/           per-trial handout, transcript, suite artifact, authoring log
```

## Running a trial

A trial agent's whole world is one scratch directory outside the checkout. It
is assembled once and then never touched by the study again:

```sh
export LEDGER_BASE_URL=http://127.0.0.1:4180        # a clean fixture instance
export S0_TRIAL_DIR=/somewhere/outside/the/repo/t1
node studies/api-suite/scripts/make-handout.mjs                     # statements trial
node studies/api-suite/scripts/make-handout.mjs --proposal          # proposal, phase 1
node studies/api-suite/scripts/make-handout.mjs --proposal --statements   # phase 2
```

That writes the brief, `handout/{openapi.json,CLIENT.md,INVARIANTS.md,obligations.json}`,
and an executable `run.sh` carrying absolute paths and the target base URL — so
`./run.sh` inside the scratch directory needs no repository read, and no
credential is ever written into it. The agent runs `./run.sh`; the runner
records the HAR, enforces the 360-request budget at the wire, injects
credentials by name, and leaves `run-out/script-report.json` and
`run-out/har.json`.

Nothing here names the fixture's path: `studies/**` source files may not
mention the standalone examples tree
(`tests/repository/boundaries.test.js`), so every script takes it from the
environment. On this repository:

```sh
export LEDGER_FIXTURE_DIR="$PWD/examples/ledger-api"
```

## Running a round

```sh
# 1. The instrument has not drifted (do this before every measured round)
node studies/api-suite/scripts/verify-instrument.mjs

# 2. Replay one suite artifact against every build in the round
node studies/api-suite/scripts/replay-round.mjs \
  --suite "$S0_TRIAL_DIR/suite.mjs" --round studies/api-suite/rounds/heldout-1 \
  --arm t1 --seed "$REPLAY_ORDER_SEED"
```

`--recorder runner` (the default) replays a script-contract suite through the
same S1 runner the trial authored against, with the same spec, the same
statements, and the same wire-enforced budget, and writes `har.json` +
`script-report.json` per build — both of the bench's columns out of one pass.
`--recorder proxy` is the P1 v0 shape, kept for the legacy comparator arms.

`replay-round.mjs` owns the fixture lifecycle: one dedicated instance per
build on a private port, a seeded `POST /admin/reset` before the suite starts,
`LEDGER_FAULTS` / `LEDGER_VARIANT` / `LEDGER_JITTER_MS` set per build, the
fault builds visited in a **seeded random order** recorded in `order.json`
before the first one runs, and one row per build appended to an append-only
`manifest.jsonl` so an interrupted round resumes rather than restarts. It ends
by scoring every build with the bench into `scores.json`.

Replays are seconds each, so a whole round is minutes — unlike P1's probe arm,
which is hours and must be started detached (`nohup`), never as an agent
background task.

## Scoring: two columns and a funnel

The bench (`$LEDGER_FIXTURE_DIR/bench/`) reports, per fault per trial:

1. **oracle-confirmed-in-traffic** — the shared deterministic oracles found the
   violation in the recorded HAR. P1's instrument, unchanged.
2. **reported-with-correct-evidence** — the suite's own structured report
   claims the violation *and* the HAR entries it cites resolve in the recorded
   traffic and land on the fault. This column exists because P1's shared oracle
   under-credited the arm that reported a fault correctly
   (`studies/api-probe/REPORT.md` §3), and a biased instrument that happens to
   favour the arm under test is the failure preregistration exists to prevent.

plus the five-stage funnel — obligation enumerated → scenario executed → fault
manifested in traffic → assertion detected → evidence correctly cited — so
every miss is diagnosed as an enumeration, reachability, assertion, or
reporting failure instead of being left a mystery. A stage the artifacts cannot
answer is reported as unknown, never as a miss.

The bar is computed on the **reported-with-evidence** column: it is what a user
actually consumes.

## False positives, and why conforming variants matter

A check that fails a build which conforms to the contract is a false positive —
it snapshotted an implementation instead of encoding the contract. So clean
scoring is not one canonical build; it is the canonical build, each
conforming-variant build (`LEDGER_VARIANT`), the variants combined, and
repeated runs under latency jitter (`LEDGER_JITTER_MS`), which double as the
CI-flake estimate. Both columns are scored on all of them: an oracle finding on
a conforming build is a bench bug, and a suite check failing one is a product
bug.

## Discipline

- **`studies/api-probe/` is frozen.** Read it; never modify it. The probe
  rematch runs that instrument as it was frozen at `9059797`, with at most one
  declared tuning round against development faults only, re-frozen before the
  sealed round.
- **One substrate, fingerprinted before the first measured trial.** Runner,
  client, report schema, prompts and briefs, model id, decoding config, retry
  policy — one of each, recorded in the preregistration and frozen there:
  54 files, substrate digest `99dd1549…1b26e`.
  `node studies/api-suite/scripts/fingerprints.mjs` reproduces §3's table on the
  frozen tree; `--files` prints the digest lines the substrate digest is taken
  over. `PREREGISTRATION.md` is not one of the 54 — it is the document doing the
  pinning, so it is pinned by the freeze commit's SHA instead.
- **Three credentials, both customers among them.** Every trial and every
  replay declares `LEDGER_ADMIN_TOKEN`, `LEDGER_CUSTOMER_TOKEN` and
  `LEDGER_CUSTOMER_B_TOKEN` by name (`scripts/lib/handout.mjs` →
  `STUDY_SECRETS`). That is what makes the taxonomy's `authorization` category
  reachable rather than "not measured"; which principal is which is learnable
  only by acting.
- **The sealed set is authored in isolation** and committed to as a sha256 of
  its patch before any trial sees anything. The orchestrator never reads it;
  a sealed-round operator applies it in the measured environment and it lands
  in history after the round.
- **Nothing is tuned after the freeze** — not a prompt, not a threshold, not an
  oracle, not a budget. Every change before it is a row in the tuning log.
