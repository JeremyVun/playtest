# Hill-climb rerun — current harness, fresh blind holdout

**Status:** designed; not started.  
**Archive:** [`studies/archive/hillclimb-2026-07/`](../../studies/archive/hillclimb-2026-07/).  
**First action:** P0, audit and freeze the current instrument before building a
new subject or catalog.

## Decision

Rerun the web hill-climb study as a new experiment, not as round 3 of the July
2026 work.

The old Fern & Fog corpus is calibration-only. Its fault manifestations shaped
the forced-risk stories, adversarial persona, actor-raise prompts, and
`playtest-bughunt` skill. A headline rerun against those same 26 faults would
measure how well Playtest remembers its training exercise, not how well the
current product generalizes.

The new study will:

1. test the current shipped discovery and findings workflow;
2. use a different subject or materially different product surface;
3. freeze stories and personas before a separately authored hidden catalog;
4. record whether each fault's trigger state was actually exercised;
5. measure detection before starting a single evidence-gated repair climb.

Web is the primary scope. Mobile and API have different drivers and evidence
contracts and need their own seeded evaluations; mixing them would make this
study too expensive and its conclusions ambiguous.

## Questions and pre-registered bets

| ID | Question | Bet |
|---|---|---|
| R1 | How many fresh seeded faults does the current default workflow detect? | At least 75% of reachable faults across two frozen rounds |
| R2 | Is remaining blindness coverage or recognition? | Forced-risk authoring raises trigger coverage; adversarial persona raises conditional recognition |
| R3 | What does each intervention buy? | Natural+adversarial beats natural+exploratory; risk+adversarial adds unique recall worth its extra cells |
| R4 | Can the findings-driven repair loop converge safely? | One evidence-gated arm reaches two live clean rounds with no emergent regression |
| R5 | Is the result operationally affordable? | Report cost, wall time, and cost per unique seeded TP; set the dollar cap before the freeze |

Failure is a result. Do not revise thresholds, catalog membership, matrix cells,
or labels after seeing detection data.

## Experimental controls

### Fresh subject and holdout

- Use a zero-dependency local web app with several connected flows, state,
  validation, empty/error/success states, and asynchronous feedback. Do not use
  a plant shop or copy Fern & Fog's information architecture.
- Freeze a plain-language `SPEC.md` and prove the clean reference with
  deterministic tests plus a discovery calibration round.
- Freeze the discovery matrix before catalog authorship.
- Have a fresh-context catalog author see the clean subject, SPEC, and the
  pre-registered fault quotas, but not the frozen story files.
- Seed roughly 24–32 independently identifiable faults. Final count is frozen
  before injection and chosen from the budget set in P0.
- Every fault needs a green-on-clean/red-on-broken manifestation test, an
  injection seam, a reachability classification, and a hidden trigger probe.

The old 26-fault catalog may run once as a non-headline compatibility check. It
must never be pooled into the new recall number.

### Fault dimensions

Balance the catalog across both product scope and failure mechanism:

| Dimension | Values |
|---|---|
| Scope | surface/copy, interaction, multi-step flow, missing capability |
| Trigger | natural path, invalid/boundary, empty state, recovery, state/history, async/failure |
| Recognition | obvious breakage, silent no-op, contradiction, plausible-but-wrong value |
| Reachability | initially reachable, deliberately masked |

Plausible-but-wrong faults require an independent oracle in the subject contract;
otherwise they are unscorable taste claims.

### Hidden trigger telemetry

Each injected fault records, outside the actor-visible UI, whether its exact
precondition and manifestation were reached. The collector stores only fault
id, run/cell id, trigger timestamp, and probe version.

This yields three separate measures:

- **trigger coverage:** triggered faults / reachable faults;
- **conditional recognition:** detected faults / triggered faults;
- **end-to-end recall:** detected faults / reachable faults.

The actor, grader, story author, and fixer never receive trigger telemetry or
catalog ids.

### Frozen detection matrix

Use the same natural stories for the first two blocks so persona lift is
identifiable:

| Block | Stories | Persona | Purpose |
|---|---|---|---|
| A | Natural, goal-level discovery trunk | `exploratory` | Current realistic-user baseline |
| B | Same trunk | `adversarial` | Persona-only marginal lift |
| C | Portable forced-risk stories authored from the clean SPEC | `adversarial` | Story/precondition lift |

Add a careful domain persona only to a small, pre-registered set of
recognition-heavy cells. Do not run a full persona Cartesian product.

Run two complete frozen repeats with fresh app state and separate run ids.
Infrastructure failures are excluded and rerun under the same pins. The model
comparison is optional and must be a matched subset with its own hypothesis;
do not silently change actor or grader between blocks.

### Instrument freeze

The P0 freeze records:

- repository and suite commit SHAs;
- exact actor and grader route ids plus a gateway route smoke;
- `STEP_SCHEMA_VERSION`, per-driver snapshot format, harness
  version, vision setting, settle policy, and timeout;
- case ids/personas, repeats, seeds where supported, concurrency, and budget;
- finding/raise/consolidation schema versions;
- adjudication rubric and clean-round computation.

Any post-freeze change is an amendment with a new comparison label. It cannot be
described as the same instrument.

## Accounting

Adjudicate deduplicated claims, while retaining raw finding counts for cost and
noise analysis:

| Label | Meaning |
|---|---|
| `seeded-tp` | Correctly identifies a live holdout fault |
| `emergent` | Real regression introduced during repair |
| `new-real-issue` | Real issue in the clean subject or repair, outside the catalog |
| `spec-gap` | Real harm not settled by the frozen SPEC |
| `subject-quirk` | Pre-existing accepted behavior of the clean reference |
| `soft-ux` | Taste, prominence, or polish rather than correctness |
| `harness-artifact` | Timing, snapshot, gateway, or runner behavior misattributed to the app |
| `false` | Claim contradicted by recorded evidence |

Report seeded detection, fixed-without-detection, residual live faults,
emergent faults, and every non-catalog class separately. Never collapse the
last six labels into one “false-positive” number.

Primary metrics:

- recall overall and by scope/trigger/recognition class;
- trigger coverage and conditional recognition;
- deduplicated catalog precision;
- repeat stability and unique yield by block/persona;
- cost and wall time per cell and per unique seeded TP.

## Repair climb

After detection accounting is frozen, make one injected copy for an
evidence-gated policy arm. Repeating the old naive arm would spend heavily to
re-establish a result already observed; add it only under a new, funded
hypothesis.

The blind fixer receives only the current product's findings output, cited run
evidence, the arm's source, and `SPEC.md`. It cannot read the catalog,
manifestation tests, trigger telemetry, clean subject, archive, or ledgers.

For each accepted issue class:

1. state the evidence and repair belief;
2. fix the smallest coherent class;
3. add a deterministic regression that forces the precondition;
4. run the regression before the next discovery round;
5. account separately for sibling faults found through code inspection.

A live round is clean only when it has zero seeded TP, zero emergent, zero
new-real-issue, and every regression is green. Stop after two consecutive clean
rounds on an unchanged app hash. Then reveal manifestation tests and report
every residual; “clean under this suite” is never called seamless or bug-free.

## Phases and gates

### P0 — Current-instrument audit and budget

- Inventory product changes since the archived freeze, including prompts,
  schemas, snapshot formats, raises, findings consolidation, personas, skills,
  model routing, and viewer evidence.
- Decide the exact primary actor/grader routes after text and vision smokes.
- Audit the archived bench for reusable ideas, not source compatibility.
- Freeze the research questions, fault count band, matrix size, repeat count,
  concurrency, maximum spend, and abort rules.

**Gate:** commit `studies/hillclimb/CURRENT_INSTRUMENT.md` and a passing smoke
manifest before subject or story work.

### P1 — New clean subject

- Build the subject and `SPEC.md`.
- Add deterministic clean-reference tests and reset hooks.
- Run natural discovery calibration; fix genuine subject defects or catalogue
  accepted quirks before proceeding.

**Gate:** clean tests and a frozen subject commit.

### P2 — Blind suite freeze

- Author natural trunk stories from the SPEC.
- Author portable risk stories with `playtest-bughunt`; no catalog knowledge.
- Freeze blocks A–C, personas, report questions, repeats, and cost projection.

**Gate:** suite freeze SHA exists before any catalog author sees the subject.

### P3 — Holdout catalog and bench

- A fresh-context author creates faults to the frozen quotas without reading
  stories.
- Implement injector, manifestation tests, hidden trigger probes, ledger
  schema, collector, adjudicator, and evidence lint.
- Prove clean/broken behavior and actor invisibility of telemetry.

**Gate:** every fault is mechanically live and scorable; no ledgered detection
round has run.

### P4 — Detection experiment

- Run two complete repeats of A–C.
- Curate adjudication against trajectory evidence.
- Publish the frozen recall/coverage/recognition matrix before repairs.

**Gate:** every fault is classified for every repeat and all evidence links
resolve.

### P5 — Evidence-gated repair climb

- Run the single blind policy arm to two consecutive live clean rounds or stop
  at the pre-registered budget.
- Reveal the hidden tests only after the stop and account for every fault.

**Gate:** convergence or abandonment is evidenced; no residual is unnamed.

### P6 — Synthesis and adoption

- Publish one concise report, machine-readable ledger, and regenerable evidence
  bundle.
- Compare the new holdout to July 2026 only as separate experiments.
- Adopt product or skill changes only when a measured failure class justifies
  them; update owning contracts and tests.
- Move this plan into the dated study archive when complete.

**Gate:** the roadmap links results, not a completed backlog plan.

## Exit criteria

The rerun is complete when the fresh catalog is fully accounted for, detection
is decomposed into coverage and recognition, the policy arm has converged or
hit its registered stop, all claims resolve to committed evidence, and the
current product recommendations follow from the new holdout rather than the old
Fern & Fog catalog.

The hosted-console UX rerun is separate work. It measures current product
usability, not seeded-fault recall, and should not be used as this study's final
phase.
