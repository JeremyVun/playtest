# Detection study — Playtest vs a coding agent (web)

**Status:** designed 2026-07-29; not started. All pins, bars, and rubrics
below are defaults; they become binding at the G0 freeze commit and may not
move after any measured data exists. Failure against a bar is a result.
**Supersedes:** `docs/backlog/hillclimb-rerun.md` (deleted 2026-07-29;
preserved in git history). Prior evidence:
[`studies/archive/hillclimb-2026-07/`](../../../studies/archive/hillclimb-2026-07/).
**Study home when started:** `studies/detection-web/`.

## One sentence

Same app, same seeded bugs, same user stories — Playtest versus a frontier
coding agent driving a browser, two complete trials of up to three
fix-and-retest rounds, and we count who found what, at what cost, in how
much time.

## Motivation

The July 2026 hill-climb measured Playtest against ground truth (81% recall
on the v2 instrument) but never against the obvious alternative, so the
number had no "compared to what". This study supplies the comparison. It
deliberately studies **one thing**: the marginal detection value of Playtest,
used as a black box exactly as a customer would use the hosted product, over
a plain coding agent with a browser. No instrument development, no
persona/story lift matrix, no repair arm — those questions are answered
(archive) or out of scope. The deliverable is one headline table a skeptical
engineering leader can read in a minute.

## Research question and headline metrics

For a web app seeded with a known fault catalog, what does each method
deliver, per round and cumulatively?

| Metric | Definition |
|---|---|
| Seeded found | unique catalog faults correctly reported |
| Latent found | unique real issues reported that were not seeded (verified on the clean reference) |
| Invalid claims | normalized claims not credited; duplicates are broken out from claims judged not real |
| Cost | all-in dollars per arm (model + infra) |
| Wall time | clock time per round and total |
| Turns | arm P: recorded actor steps; arm C: agent messages + tool calls |
| Replication delta | trial 2 minus trial 1 for detections, noise, cost, and time |

## Method in brief

1. Build a fresh purpose-built subject app with a frozen `SPEC.md` and
   deterministic clean-reference tests.
2. Freeze the story suite. Then a fresh-context author seeds ~20 faults.
3. Freeze two identical full trials before either starts; trial 2 is a
   fresh-context replication, not an opportunity to tune after trial 1.
4. Two arms, identical subject inputs, independent copies of the injected app.
5. Up to three rounds per arm and trial: detect → judge → withdraw every
   correctly-reported fault ("assume fixed") → rebuild → run again.
6. An arm-blind judge scores every deliverable claim: **seeded / latent /
   invalid**.
7. Publish both trials side by side, their deltas, and per-round convergence.

Detection only. Nothing here generates, applies, or verifies fixes;
withdrawal simulates a fix, and the report must say so.

## Subject and fault catalog

- Zero-dependency local web app: several connected flows, state, validation,
  empty/error/success states, asynchronous feedback. **Not** Fern & Fog, a
  plant shop, or a copy of its information architecture — that corpus shaped
  the current prompts and skills.
- Frozen `SPEC.md`; deterministic clean tests; a reset hook; per-fault
  injection toggles.
- **18–22 faults** (exact count frozen at G0), quotas balanced across:
  scope (surface/copy, interaction, multi-step flow, missing capability),
  trigger (natural path, invalid/boundary, empty state, recovery,
  async/failure), and recognition (obvious breakage, silent no-op,
  contradiction, plausible-but-wrong value — the last only where `SPEC.md`
  carries an independent oracle).
- **Masked faults are classified up front.** A fault unreachable until
  another is withdrawn is scored only from the round it becomes reachable
  (July lesson: `f-receipt-eta-wrong` was masked by a removed order-history
  page; a round-1 "miss" of a masked fault is not a miss). The repeated
  rounds are the mitigation: reporting and withdrawing the blocker exposes
  the downstream fault in the next round. Masking chains may be at most two
  dependencies deep, so three rounds can expose every fault when each
  blocker is found on first availability. The report shows both
  masking-aware recall and raw recall against the full catalog, including
  faults still masked when an arm stops.
- Every fault ships a green-on-clean / red-on-broken manifestation test and
  a hidden server-side trigger probe. Trigger telemetry is **diagnostic
  only** — it distinguishes "never reached" from "reached but not
  recognized" for miss analysis and never appears in the headline. Neither
  arm can observe it.
- The catalog author works in a fresh context, sees the clean subject,
  `SPEC.md`, and the quotas — never the stories.

## Story suite (frozen before the catalog exists)

Story coverage is the established key to detection, so it gets the care:

- golden-path stories covering every flow in `SPEC.md`;
- one or two bug-hunt stories with the adversarial persona (the shipped
  `playtest-bughunt` skill), authored from the SPEC alone.

The identical story and persona text is given to both arms.

## Arms

**Arm P — Playtest, hosted, black box.** The hosted platform driven over its
HTTP API the way a customer's automation would: create the project,
application, and suite; launch cases (claim board → the supervised `local`
runner); wait on the feed; export run reports and findings. Its deliverable
is the **deduplicated findings list** — consolidation is part of the product
under test, so its dedup quality is inside the measurement. No human triage
anywhere in the loop; hosted finding states are left untouched.

**Arm C — control.** A frontier coding agent driving a real browser
(Playwright MCP or equivalent), **the same model as arm P's actor** —
default **gpt-5.5** for the Playtest actor, the Playtest grader, and the
control agent alike, so the study compares methods, not models — given the same
story/persona text and told to work the stories and report bugs with
reproduction steps. Its deliverable is its written report. The brief forbids
reading application source or fetched bundles — black-box symmetry — and the
transcript is audited for it. Abort rule: a round is cut off at 2× arm P's
wall time for the same round.

Both arms run against their own copy of the injected app, so each arm's
withdrawal path is independent.

This is deliberately a **product-level black-box comparison**, not an
attempt to give both arms identical tools. Each product keeps its native
prompts, browser tooling, orchestration, evidence capture, and consolidation;
genuine advantages and gaps in those capabilities are part of the result.
The controlled common ground is the actor model, subject build, starting
state, story/persona text, and prohibition on source or fetched-bundle
inspection. All tool and harness differences are pinned and reported, not
equalized.

## Trials and round loop

Two complete trials run sequentially. Trial 1 is the primary measurement;
trial 2 repeats the frozen protocol to reveal run-to-run variance. Trial 2
uses fresh agent contexts, application copies, and state, but the same
subject, catalog, stories, models, prompts, budgets, judge rubric, and stop
rules. **Each trial gets its own fresh hosted project.** All rounds within one
trial share that project, so project-wide findings consolidation remains part
of arm P; trial 2 inherits no findings, evidence, merges, or lifecycle state
from trial 1. Nothing may be tuned between trials. With only two trials,
variance is descriptive: the report does not claim a statistical confidence
interval, and it does not average away a reversed verdict.

Within each trial, each arm follows its own independent loop:

1. Round 1 against the full catalog build.
2. Export the deliverable; judge every claim (below).
3. Withdraw each fault the arm correctly reported; rebuild that arm's app.
4. Next round. Stop after round 3 or when a round yields zero new seeded
   detections, whichever comes first.

## Judge protocol

- **Model:** Fable 5 (default) — deliberately a different model family from
  the arms' shared gpt-5.5, so no arm is judged by its own model. G0 smokes
  the judge route for availability and freezes the exact route and version;
  if it is unavailable, G0 records a substitute that still differs from the
  arms' model. "Default" and "frozen" are distinct states: nothing in this
  document is frozen until the G0 commit.
- **Shape:** judging is two fresh-context **batched** passes over the round,
  normalization and then classification — not one agent per claim and not a
  panel of judges. A deterministic split is allowed only if a batch exceeds
  the frozen prompt limit.
- **Atomic normalization:** the judge's first, catalog-blind pass splits each
  raw deliverable into one-issue claims before scoring. A compound report is
  split; each normalized claim can credit at most one seeded fault; exact
  source text and evidence remain attached; repeat reports of the same issue
  are marked as duplicates rather than credited again. This normalized
  ledger is frozen before the classification pass sees the fault catalog.
- **Arm-blind:** claims are normalized (claim text + evidence excerpts),
  stripped of arm identity, and shuffled across arms before judging.
- **Inputs:** the fault cards (id, manifestation, trigger), `SPEC.md`, and
  clean-reference behavior.
- **Output per claim:** `seeded` (names the matched fault id), `latent`, or
  `invalid`, plus a one-line rationale and a confidence. Sub-labels on
  `invalid` (duplicate, soft-ux, harness-artifact, not-a-bug) are recorded
  for the appendix; the headline stays three buckets.
- **Latent claims** must reproduce on the clean reference and violate the
  SPEC or a reasonable-user expectation; otherwise invalid.
- **Human audit:** low-confidence and contested calls only; every override
  is logged in the ledger with a rationale. The (catalog-contaminated) lead
  orchestrates and audits; it never authors stories, faults, or fixes.

## Verdict bars (defaults; binding at G0)

- **B1 — detection floor:** arm P cumulative seeded ≥ 70% of faults that
  became reachable in that trial; full-catalog recall and faults still masked
  at stop are mandatory companion figures.
- **B2 — marginal value:** arm P unique seeded ≥ arm C unique seeded + 3.
- **B3 — noise ceiling:** invalid claims ≤ ⅓ of arm P's deliverable,
  per round.
- **B4 — budget:** defaults $75 and one working day per arm, per trial; exact
  per-trial and whole-study caps and abort rules are frozen at G0.

B1–B4 are evaluated separately for both trials. If arm C matches or beats
arm P in either trial, or a verdict reverses, that is published plainly
rather than hidden in an aggregate.

## Operations

- The top-level study harness is one **Claude Code session**. It orchestrates
  phases, services, driver commands, isolated agent contexts, and transcript
  capture. "One session" describes the harness boundary, not shared model
  context: every role marked fresh-context receives only its allowlisted
  inputs and never inherits catalog knowledge from the lead.
- All GPT-family calls — including the default gpt-5.5 Playtest actor,
  Playtest grader, and control agent — route through the Codex gateway at
  `http://localhost:8900`. Claude-family roles such as the default Fable 5
  judge are invoked from the study run as agents in that same Claude Code
  session. G0 smoke-tests and records the exact model ids, routes, Claude Code
  version, gateway version/configuration, and tool/MCP set.
- `npm run hosted` with a **fresh `PLAYTEST_DATA_DIR`** dedicated to the
  study; dev auth; the boot-registered `local` runner claims all launches.
  No console interaction in the measured loop. The data root is
  **disposable and is never archived or published wholesale** — it contains
  the dev runner credential, auth state, and raw artifacts. What survives
  the study is the scrubbed evidence export (Deliverable, below).
- Driver scripts live in `studies/detection-web/scripts/` and call the
  hosted HTTP API only.
- Metrics come from run artifacts (cost, steps, timing), driver timestamps,
  and arm C's transcript.
- One Playtest run process at a time; after any kill, loop `pgrep -f` until
  empty. Long-lived servers run detached via `nohup`, never as harness
  background tasks.
- `studies/**` source files must not contain the literal `examples/` path
  (repository boundary test) — parameterize via env.

## Phases and gates

| Phase | Work | Gate |
|---|---|---|
| G0 | Freeze what exists now: product repo SHA, experimental rules, both-trial protocol, Claude Code/Codex-gateway/tool pins, model routes after availability smokes (defaults: gpt-5.5 arms, Fable 5 judge), prompt pins, fault count band, quotas, bars, budget, judge rubric. Artifacts created later get their SHAs at their own gates — G0 never fingerprints a file that does not exist yet | prereg committed |
| G1 | Subject + `SPEC.md` + clean tests + reset hook | tests green, subject SHA frozen |
| G2 | Story suite authored from SPEC | suite SHA frozen before any catalog work |
| G3 | Catalog: faults, manifestation tests, trigger probes, injector | every fault mechanically live; telemetry invisible to both arms |
| G4 | Shakedown: one clean-subject round per arm (the runner refactor shipped 2026-07-29 — this flushes harness breakage) | accepted-quirks list adjudicated; harness green |
| G5 | Measured rounds | every claim judged; ledger complete; evidence links resolve |
| G6 | Report + verdicts against B1–B4 | static site published; archive |

## Deliverable

A curated static-site report under `studies/detection-web/report/`: both
headline tables, trial-to-trial deltas, per-round convergence, per-fault
matrix, evidence excerpts, and the machine-readable ledger, with an evidence
linter. The committed evidence is a **scrubbed export**: run and finding
records, timestamps and cost data, configuration pins, hashes of builds and
inputs, and evidence excerpts — never credentials, auth state, raw `runs/`
directories, or the data root.

## Out of scope

Fix generation or verification; persona/story-lift experiments; instrument
tuning of any kind mid-study; mobile; API (owned by
[`api.md`](./api.md)).
