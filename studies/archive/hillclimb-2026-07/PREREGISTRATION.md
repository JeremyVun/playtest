# Hill-climb evidence study — can Playtest hill-climb a broken app?

The core product claim is that Playtest can drive a UX hill climb: point it at a
flawed app, and the discover → fix → re-run loop converges on a seamless
experience. Today that claim rests on the viewer-ux and hosted-ux studies —
real, but unverifiable: we don't know the ground-truth defect set of our own
app, so "the report came back clean" cannot be distinguished from "the
instrument is blind to what's left."

**This study exists to produce an observable, auditable chain of evidence** that
answers five questions:

1. **Can it?** Does the loop take a deliberately broken app from N known defects
   to zero, with every residual accounted for?
2. **How?** Every step of the climb — finding → evidence → fix → verification —
   recorded and replayable.
3. **How effectively?** Recall and precision against ground truth, rounds and
   cost to converge, wasted work on false positives.
4. **What carries signal?** Which personas, modes (discovery vs journey), actor
   tiers, and grader settings detect the most per unit cost — so future studies
   run the configurations that earn their quota.
5. **Does orchestration beat brute force?** A naive "run everything, fix the
   grader's list" loop versus an intelligent climb policy that decides what to
   run next and why — measured on the same broken baseline.

It is *not* primarily a calibration exercise, though calibration falls out of
it: the deliverable is the demonstration itself, usable as validation evidence
(and marketing material) for the tool.

## The story, and the bets

Told to a stranger, the study is one sentence: *we seeded a working app with
a couple dozen known defects — from bad contrast to entire missing features —
pointed AI user-testers at it blind, and measured exactly what they caught,
what they missed, and what it cost to climb back to seamless.* Nobody has
published ground-truth recall numbers for agentic UX testing; that gap is
what makes the result worth sharing beyond this repo, whichever way it comes
out.

For the ending to be earned rather than curated, the bets go on record before
any data exists (fixed at the Phase 2 instrument freeze; a lost bet is a
finding, reported with the same prominence as a won one):

- **H1 — it converges.** The loop takes the app to two consecutive clean
  rounds within budget, finding at least three-quarters of the seeded faults,
  every residual accounted for by name.
- **H2 — the scale gradient.** Recall falls as fault scope rises: surface and
  interaction defects (L1/L2) get caught more reliably than flow defects
  (L3), which beat missing capabilities (L4). Agentic testers should be
  better at seeing breakage than absence. If L4 recall is high, that surprise
  leads the write-up; if it's near zero, that's the warning label the
  community needs.
- **H3 — the panel beats its best member.** A diverse persona panel finds
  faults no single persona finds, by a margin worth its cost — and when
  several personas independently converge on the same finding, it's almost
  always real, making convergence an automatic precision filter.
- **H4 — orchestration beats brute force.** The frozen intelligent policy
  reaches clean in fewer rounds and at lower cost than the naive
  run-everything loop, wasting fewer fixes on false positives.
- **H5 — detection is actor-limited, precision is grader-limited.** A cheaper
  actor tier keeps most of the recall at a fraction of the cost; raising the
  grader tier moves precision more than recall.

The shape of the final story is fixed the same way: the report site leads
with the climb trajectory — faults remaining per round, both arms on one
chart — backed by the detection heatmap (fault × persona), recall by level,
the convergence-vs-truth curve, cost per detected fault, and the full
accounting table where every fault ends as found-and-fixed, accepted, or
missed, each with its evidence links. Deciding the figure list before the
data arrives is what keeps the narrative honest. A standalone write-up,
distilled from the site and readable without it, is part of the deliverable.

## Subject: a purpose-built flawed app (decided 2026-07-10)

An earlier draft said "generate a broken variant of `examples/todo-app`." Two
investigations killed that:

- **The todo app is too thin.** One page, five controls, ~286 lines. It hosts
  stale-state / dead-control / a11y / edge-case faults credibly (~12–14 sites)
  but has *nowhere* for async/loading, error-surface, validation, navigation,
  or multi-step-flow defects to live — roughly a third of a diverse catalog.
  Its copy, testids, `variant:"b"` heal mechanism, and endpoint paths are also
  pinned across `tests/`, `examples/todos`, and the hosted server suite.
- **No standard OSS teaching app fits** (survey 2026-07-10). Documented-defect
  apps are thin, account-gated, or a11y-only with unofficial catalogs (Sauce
  Swag Labs, W3C Before-After Demo); deliberately-bad-UX apps can't be
  fixed-until-clean because the badness is the product (User Inyerface); rich
  clean baselines are heavy framework/JVM apps that break "fix a defect in
  minutes" (RealWorld, Juice Shop, ParaBank). Authoritative ground truth +
  minutes-to-fix only coexist when we author both the app and the catalog.

**So: `studies/hillclimb/subject/` — a new zero-dep fixture app**, built in the
todo-app style (single-process Node server, server-rendered pages + vanilla
client JS, in-memory state, `POST /api/reset` seed hook, no build step) but
with a real UX surface. Recommended domain: a small storefront — browse →
item detail → cart → checkout (validated multi-field form) → confirmation —
plus a lightweight account/settings view. That shape natively hosts every
defect class: multiple routes, a multi-step flow that carries state, async
loading states, an error/toast surface, CRUD, list + detail. Target roughly
800–1500 lines; every seeded fault must be honestly fixable in minutes.

The committed app is the **clean reference** — complete and seamless, the top
of the hill. It ships `studies/hillclimb/subject/SPEC.md`, the product spec:
what the app does, for whom, every intended capability and flow. The spec is
what "seamless" *means*, the source stories and personas are authored from,
and what makes L4 adjudication crisp — a missing feature is a defect relative
to the spec, not a matter of taste. Constraints (mirrors the codex-gateway
precedent): no imports to/from `src/**`, not in the npm tarball, not in root
`npm test` (the study has its own offline test file, run standalone).
`examples/todo-app` is untouched; root golden bytes must not move.

## Fault catalog: multi-scale

`studies/hillclimb/faults.json` — the ground-truth catalog, ~20–25 seeded
defects: `{id, level, class, severity, surface, oracle, injection}` where
`oracle` is one sentence ("a user trying X hits Y") and `injection` names the
file and the nature of the mutation. **Faults span four levels of scale** —
the climb must be tested at all of them, not just widget-level breakage:

- **L1 polish** — contrast/a11y, misleading copy, wrong label, confusing
  empty-state text.
- **L2 interaction** — dead control, action-without-receipt, stale state after
  mutation, broken validation, double-submit, swallowed error.
- **L3 flow** — a step loses earlier input, misrouted link, error dead-end
  mid-journey, broken edge case inside a journey (long input, empty cart).
- **L4 capability** — a feature *removed entirely* (search deleted, no way to
  edit a cart quantity, no route back from confirmation). From the actor's
  view the app simply never had it: this tests whether the loop detects
  absence, not just breakage — the thing no prior study could probe.

Every class ≥ 2 instances; classes drawn from recognized taxonomies (Nielsen
heuristics, W3C BAD's barrier catalog, Swag Labs' seeded-bug patterns,
deceptive-pattern classes) so seeds are grounded, not invented.

Each fault also records **reachability**: `masked_by: [fault-ids]` when
another fault gates access to its surface (a dead add-to-cart button hides
every checkout fault behind it). Without this, early-round recall is
confounded — the loop gets blamed for not finding faults it could not reach.
Per-round recall is computed against *reachable* faults (masking resolved by
the adjudicator from the catalog's annotations), with unmasked-total recall
reported alongside. Manifestation tests must prove every fault is live **in
the fully-broken baseline**, so masking is documented, never accidental.

`studies/hillclimb/inject-faults.mjs` — deterministic: copies `subject/` into
a per-arm app directory and applies each fault as a **real code mutation**
(removal counts as mutation — that's how L4 works). Faults must be honest code
defects, because fixing them must be honest work. Per-fault **manifestation
tests** (offline, deterministic DOM/API assertion) prove each fault is live in
the broken copy and absent from the clean reference; a byte-identity check
proves injection touched only what the catalog says.

**Blindness rules** (what makes the evidence credible):

- **Authoring order is a control, not a convenience:** stories and personas
  are authored from `SPEC.md` and **frozen (committed) before `faults.json`
  is written**. The catalog author knows the stories; the stories must not
  know the catalog — otherwise story wording can steer actors toward the
  seeds and recall is inflated. Any story added later (Arm B probes excepted,
  they're part of the policy) is an amendment logged in the ledger.
- Personas, stories, and the actor never see `faults.json` or the clean
  reference. They see only the running broken app.
- **Roles are separated by contamination.** Whoever authors the catalog is
  contaminated for life: they adjudicate, they never fix. Fixes are made by
  fresh-context agents that receive **only the findings report and the arm's
  app directory** — their prompts forbid reading `subject/` (the clean
  reference), `faults.json`, and the ledger; their transcripts are retained
  and spot-audited for peeking. Otherwise the climb is circular and
  demonstrates nothing.
- Only the adjudicator consults the catalog, to map findings ↔ faults after
  each round.

## The climb policy: two arms

Both arms start from the **identical broken baseline** (the injector is
deterministic) in separate committed app copies (`studies/hillclimb/arms/naive/`,
`arms/policy/`), so fix commits land in this repo's history — the chain of
custody. Both use the instrument frozen in Phase 2 and the same stop rule:
**two consecutive clean rounds**.

**Arm A — naive loop** (the control): a fixed suite of discovery stories ×
personas every round; fix everything the grader reports; re-run. No probes,
no prioritization, no mode mixing.

**Arm B — intelligent climb policy.** The policy is frozen *here, before any
round runs* (mid-climb policy edits contaminate the comparison):

1. Maintain a belief table: every open finding with a confidence level and
   the evidence for/against.
2. Before spending a fix on an ambiguous finding, author a **targeted probe
   story** (journey or narrow discovery case) to confirm or kill it.
3. Pin a **regression journey per fix** and run the full regression set every
   round — the ratchet is cheap and deterministic.
4. Allocate discovery spend adaptively: rotate personas toward those with the
   best marginal detection in the matrix so far; retire personas that only
   duplicate others' findings.
5. Escalate actor/grader tier only where evidence is ambiguous or the actor
   seems to be the bottleneck (couldn't operate the UI vs. UI is broken).
6. Promote validated discovery paths into journeys (the promotion path the
   skills prescribe but no study has stress-tested).

Compared on: rounds-to-clean, cost per detected fault, recall, precision, and
wasted fixes (fixes addressing false positives). No cross-arm learning: each
arm has its own blind fixers; the adjudication rubric is frozen before either
arm starts. **Quota guard:** Arm A alone still delivers the core evidence
chain (questions 1–4); Arm B answers question 5 and runs second — if the
subscription quota gets tight it becomes a fast-follow, not a blocker.

## Study bench (built before any round runs)

The audit (2026-07-10) confirmed the harness has a strong single-run substrate
— `grade.json` (findings with severity+step, report Q&A with `evidence_steps`,
harness-computed axe counts), `manifest.json` with per-run token/cost totals,
viewer `?run=…&step=N` deep links — and **nothing cross-run**: prior studies
hand-assembled every round table, convergence ranking, and noise label in
`study-report.md`, including hand-caught contaminated runs. For a study whose
deliverable is an auditable evidence chain, the synthesis layer cannot be
hand-assembled prose.

`studies/hillclimb/bench/` — zero-dep Node scripts, study-local, outside the
contracts:

- `ledger.schema.json` + validator — the round-entry contract (below).
- `preflight.mjs` — run before every round: resets app state, verifies the
  arm's app copy is at the expected commit and the injected fault-set hash
  matches, checks gateway health and greps its log for usage-limit hits, and
  records an **environment fingerprint** (subject sha, fault hash, gateway
  version, model ids) into the round's ledger entry. Prior studies caught a
  non-reseeded, contaminated run by hand; here exclusion happens only by
  these pre-declared criteria, and every exclusion is logged, never silent.
- `collect.mjs` — walks a round's `runs/<id>/…` dirs, harvests every
  `grade.json` finding and report answer plus `manifest.totals`
  (tokens/cost), and emits normalized finding records with
  run/case/persona/step references. Replaces hand-assembly.
- `adjudicate.mjs` — records the finding ↔ fault mapping with rationale per
  judgment (true-positive / false-positive / new-real-issue / duplicate-of /
  emergent), writes the ledger entry, validates it against the schema.
  Unmapped findings are carried explicitly, never dropped. **Emergent** is
  for defects a fixer introduced while fixing: they join a supplementary
  catalog annex with provenance (which fix commit created them) and are
  tracked to resolution, but stay out of the seeded-recall denominator.
- `matrix.mjs` — detection matrix (fault × persona × mode × tier), recall by
  class and by level (L1–L4), precision, convergence counts, cost per
  detected fault, round-over-round deltas, arm comparison.
- `lint-evidence.mjs` — every ledger claim must resolve to an artifact on
  disk (run dir, step file, commit sha); a dangling link fails the round.
- `site.mjs` — builds the report site (below) from the ledger + curated
  assets.

**Ledger.** One entry per round per arm, committed:
`studies/hillclimb/ledger/<arm>/round-NN.json` — instrument config (personas,
stories, `actor_model`/`grader_model` as actually run — the gateway routes GPT
tier pins per request as of 2026-07-10, manifests are truthful), run ids,
normalized findings, the adjudicated mapping with rationale, fixes applied
(commit shas, each linked to its motivating finding), re-run verification
results, and the regression story pinned per fix. Cost figures come from
`manifest.totals` (the gateway does not log tokens — confirmed).

## Deliverable: a static research-report site

Raw `runs/` stay gitignored and machine-local — they are **not** committed.
Instead the headline artifact is a **self-contained static site** (the same
zero-dep discipline as `src/run-viewer/web`): the study narrative, per-round pages,
detection-matrix and convergence visualizations, the arm comparison, and the
signal table — with the **curated evidence embedded**: cited step screenshots,
trajectory excerpts (the give-up moments, the wrong turns), fix diffs. Every
claim links down its chain: finding → run/step evidence → adjudication
rationale → fix commit → green re-run. `lint-evidence.mjs` enforces that at
build time; `site.mjs` copies exactly the cited artifacts into the site's
assets, nothing else.

Generated into `studies/hillclimb/report/` and committed; hostable anywhere
static (it is the validation-evidence and marketing artifact). The old
hand-written `study-report.md` format is retired for this study — prose lives
in the site, numbers live in the ledger, and nothing is hand-tabulated.

## Metrics

Definitions first, because the stop rule depends on them. A **clean round** =
zero new true-positive findings (adjudicated) *and* the full regression suite
green. False positives don't block cleanliness — they count against precision.
A **found** fault = at least one finding adjudicated to it; **accepted**
requires a written trade-off note in the ledger and is only available to
L1 faults of minor/info severity — anything else unfound is a **miss**. This
acceptance rule is pre-declared precisely so misses can't be laundered as
accepted after the fact.

- **Recall** per defect class *and per level L1–L4* (the headline — especially
  L4: does the loop see what's missing?), computed against reachable faults,
  with unmasked-total recall alongside.
- **Detection probability, not just detection**: actors are stochastic and
  the gateway offers no seed control, so replication is the only variance
  control. Phase 2 runs each story × persona cell ≥2 times; per-fault
  detection probability per round is what turns the stop rule into a
  quantified claim (a fault with per-run detection probability p that
  survives two clean rounds of k runs each did so with probability
  ≈ (1−p)^(2k) — report that number, don't imply zero).
- **Precision**: findings mapped to real faults / all findings. The Phase 1
  clean-reference shakedown establishes the false-positive floor.
- **Rounds-to-clean** and **cost per detected fault** (tokens/quota from
  manifests; marginal cost ≈ quota on the gateway, report both).
- **Convergence**: how many independent runs/personas hit each fault — this
  calibrates "how many runs before a clean report means clean."
- **Ratchet integrity**: after the climb, re-inject three fixed faults — one
  each from L2, L3, L4 — and the pinned regression suite must go red on each
  (the L4 re-injection tests whether a pinned journey catches a feature
  *disappearing*, the hardest case). A green re-injection falsifies the whole
  ratchet story, so run it.
- **Arm delta**: naive vs policy on every metric above. Harness cost comes
  from manifests for both arms, but Arm B also spends **orchestration
  tokens** (probe authoring, belief-table reasoning) that manifests never
  see — report rounds, harness cost, and wall-clock as the primary
  comparison, and estimate orchestration overhead explicitly rather than
  letting Arm B look artificially cheap.
- **Signal table**: persona × defect-class detection rates; same for actor
  tier and mode. Within an arm, vary one axis at a time.

## Sequencing

**Phase 0 — instrument readiness.** Commit the gateway per-request model
routing (landed 2026-07-10, verify it's in history before round 1 — chain of
custody starts clean). Build the **study bench** and ledger schema; wire
`lint-evidence` into the round procedure. Quota discipline: grep the gateway
log for usage-limit hits before each round; rounds run serially.

**Phase 1 — subject, stories, then catalog (order is load-bearing).** Build
the clean reference app + `SPEC.md`. **Shakedown:** run one discovery round
against the *clean* app — every finding there is either an instrument false
positive (calibration data, sets the precision floor) or a real defect in the
reference (fix it before freeze; the reference must be genuinely seamless or
ground truth is dirty). Then author and **commit the stories and personas
from `SPEC.md`**. Only after they are frozen, author `faults.json`
(multi-scale, class/level coverage and masking annotations reviewed), write
`inject-faults.mjs`, and the per-fault manifestation tests. Exit: reference
shakedown clean; stories frozen before catalog authorship (verifiable in git
order); every fault's manifestation test red-on-broken / green-on-clean;
root `npm test` untouched and green.

**Phase 2 — baseline detection (no fixing).** Blind discovery rounds against
the broken baseline across all personas, **≥2 repeats per story × persona
cell** so the matrix holds detection probabilities, not coin flips; build the
first detection matrix with `collect`/`adjudicate`/`matrix`. This is the
"before" evidence and the instrument calibration: if recall is poor here,
tune personas/grader/prompts and re-baseline **before** climbing — tuning
mid-climb contaminates the effectiveness numbers. Use Phase 2 actuals to
project quota per climb round and right-size the suite (fewer, higher-signal
personas beats more). Exit: detection matrix committed; instrument frozen;
**this doc's commit sha recorded in the ledger as the pre-registration** —
every later deviation is an amendment logged in the ledger, not a silent
edit.

**Phase 3 — the climb, Arm A (naive).** Closed loop: run → collect →
adjudicate → blind fixer works from the findings report only → pin a
regression story per fix → commit ledger + app → re-run (regression suite +
fresh discovery). Repeat until two consecutive clean rounds. Exit: clean ×2,
ledger complete, every fault accounted for as found-and-fixed,
found-and-accepted, or missed (missed rows are the most valuable in the
report — say so, don't bury them).

**Phase 3b — the climb, Arm B (policy).** Same broken baseline, fresh app
copy, the frozen policy above, its own blind fixers and ledger. Exit: same.

**Phase 4 — signal analysis + report site.** `matrix.mjs` over both arms; a
**verdict on each hypothesis H1–H5** (supported / refuted / inconclusive,
with the pre-registered prediction quoted next to the observed number); the
signal table; concrete instrument recommendations (which personas/modes/tiers
future studies should run, which are dead weight); ratchet re-injection
demonstrated red. Build and commit the report site and the standalone
community write-up. Re-run the actor-tier axis here if the climbs ran on one
tier (H5 needs it).

**Phase 5 — apply the calibrated instrument.** Re-run `studies/hosted-ux`
with the Phase 4 configuration. Now a clean report supports the hosted UX
exit criteria with evidence behind it: "verified seamless," not "nothing
found."

## Threats to validity — named, each with its control

The design choices above exist to defeat specific threats; naming them keeps
the final report honest and lets a skeptical reader check each one:

- **Fault masking** → catalog `masked_by` annotations; recall against
  reachable faults; manifestation tests prove liveness in the fully-broken
  baseline.
- **Oracle leakage** (story author knows the seeds) → stories/personas frozen
  from `SPEC.md` before the catalog exists; git order proves it.
- **Circular fixing** (fixer sees ground truth) → blind fresh-context fixers,
  findings report only; transcripts retained and spot-audited.
- **Correlated blindness** (grader misses what the actor misses, same model
  family) → grader tier ≠ actor tier; on a sample of rounds, an independent
  second grader (different family via the gateway) re-grades and the
  agreement rate is reported.
- **Adjudicator bias** (the contaminated author maps findings generously) →
  written rationale per judgment; a sampled second-opinion adjudication pass
  by an independent model; disagreements resolved manually and noted.
- **Acceptance laundering** (misses reclassified as "accepted") → acceptance
  pre-restricted to L1 minor/info with a written trade-off note.
- **Fixer-introduced regressions** → emergent-defect annex with provenance;
  regression ratchet runs every round.
- **Stochastic actors / underpowered claims** → ≥2 repeats per cell in
  Phase 2; stop-rule strength reported as a probability, not implied zero.
- **Contaminated rounds** (stale seed, wrong fault set, quota exhaustion
  mid-round) → `preflight.mjs` fingerprint per round; pre-declared exclusion
  criteria; every exclusion logged.
- **Silent model drift** (subscription backend changes mid-study) → per-round
  environment fingerprint records model ids; a drift event breaks
  comparability at that boundary — noted, never averaged across.
- **Arm-comparison unfairness** → identical broken baseline via deterministic
  injector; policy frozen pre-run; per-arm fixers; orchestration overhead
  reported, not hidden.

## Relationship to other work

- **Hosted UX**: finish the in-flight fix round first; this study then closes
  its evidence gate (Phase 5).
- **M3 (bug-hunting funnel)**: shipped; its gate was met against the frozen
  seeded corpus (`tests/core/findings/README.md`). The catalog + injector +
  manifestation-test *pattern* built here remains the seam for re-measuring
  candidate recall on a live subject.
- **Gateway routing** (`tools/codex-gateway/README.md` "Model routing"): the
  prerequisite that makes tier comparisons and truthful manifests possible;
  landed 2026-07-10, must be committed before round 1.

## Non-goals

- Not a benchmark of LLMs; the subject app and catalog are fixed, tiers are
  one analysis axis.
- No changes to `examples/todo-app`, prompts on the journey control path, or
  golden bytes; the subject, bench, and site stay outside the contracts and
  the tarball.
- No CI integration — this is a maintainer-run study on the subscription
  gateway.
