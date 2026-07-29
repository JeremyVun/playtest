# Detection study — coding agent vs Playtest probe vs fuzzer (API)

**Status:** designed 2026-07-29; not started. Defaults below become binding
at the G0 freeze commit; nothing moves after measured data exists. Failure
against a bar is a result.
**Supersedes:** the script-authoring plan (`docs/backlog/api-testing/`
DESIGN.md + BUILD_PLAN.md, deleted 2026-07-29; preserved in git history —
`git log --full-history -- docs/backlog/api-testing/`). **The
script-authoring direction is dropped:** the unbuilt remainder (S4 hosted
lifecycle, S5 pilot) is abandoned, because executing agent-authored scripts
on runner agents carries a sandbox-and-approval burden out of proportion to
the value demonstrated. The shipped S1–S3 substrate stands and remains
recorded in [`docs/contracts/scripts.md`](../../contracts/scripts.md); no
further build on it.
**Prior evidence:** [`studies/api-probe/`](../../../studies/api-probe/) (P1,
frozen) and [`studies/api-suite/`](../../../studies/api-suite/) (S0).
**Study home when started:** `studies/detection-api/`.

## One sentence

Same API, same seeded bugs, same spec — a coding agent writing its own
black-box tests, Playtest's turn-based probe, and an off-the-shelf fuzzer;
two frozen trials each, with a clean build hidden among the broken ones;
count who found what at what cost.

## Motivation

Two open questions, one instrument:

1. **The fair probe re-test.** P1 scored the probe 3/5 through shared
   deterministic oracles whose applicability window its own report shows
   undercounted it (`studies/api-probe/REPORT.md` §3), and the S0 rematch
   was never run because those oracles could score the probe on only 4 of 14
   sealed faults. Scoring free-text reports by blind adjudication removes
   the oracle-vocabulary bias entirely — this is the clean reading the probe
   never had.
2. **The positioning question, head-on.** "Why not just have an agent write
   black-box tests from your API contract?" gets measured directly:
   agent-authored contract tests vs pointing Playtest at the API, with free
   fuzzing as the floor both must clear. The in-repo, source-visible variant
   of that question is a different study (code review vs testing) and is
   explicitly out of scope — every arm here is black-box.

Playtest is a black box; there is no instrument tuning in this study.

## Arms

Equal knowledge for all arms: base URL + the served OpenAPI document + one
short plain-language rules brief (the `INVARIANTS.md` statement shape) +
the same named credential set — opaque bearer tokens whose roles are
deliberately undisclosed, so discovering what each identity may do is part
of the testing (the prior instrument used three; G0 freezes the exact set).
No arm sees source. Fault-set knowledge: none. Every arm × build execution
starts from the same seeded reset state on a dedicated fixture instance.

- **Arm C — coding agent.** Authors its tests once per trial, in a fresh
  context, from spec + brief against the declared clean reference instance;
  the resulting test artifact is then **frozen**, and each measured build is
  executed and reported by a **fresh context that sees only that build** —
  no agent context ever compares builds, so the hidden clean build cannot
  be inferred by contrast. Same model as arm P's actor — default
  **gpt-5.5** for the probe actor, the grader, and the control agent alike.
- **Arm P — Playtest probe.** The shipped turn-based API actor, run through
  the hosted platform as a customer would (claim board → `local` runner).
  Stories are authored from the brief and frozen at G0, before any fault
  exists. **Each build gets its own hosted project**: findings consolidation
  deduplicates project-wide, and per-build projects stop it merging
  evidence across builds.
- **Arm F — Schemathesis**, spec only (it cannot consume the brief, and
  credential roles beyond a configured auth header are beyond it — inherent
  properties of the tool, reported as such). Run with its example/generation
  database disabled so nothing learned on one build carries to another. The
  free floor.

## Subject and sealed faults

- Subject: the frozen ledger fixture (`examples/ledger-api`), referenced
  from study sources via env only (repository boundary rule).
- **Contamination audit at G0:** enumerate every probe prompt/skill change
  since P1 and check whether any derives from ledger-specific behavior. If
  any does, the pre-registered escape hatch is a fresh purpose-built subject
  instead; the audit outcome is recorded either way.
- **Sealed set: 12–15 semantic faults** across the eight-category taxonomy
  (state-machine, cross-resource invariant, conditional branch, pagination,
  idempotency, temporal boundary, authorization, error semantics), authored
  by a fresh-context agent under the sha256-commitment discipline (held
  outside the checkout until the G1 freeze). Per-category results are
  reported as **descriptive only** — n per category is too small for
  per-category claims.
- **Builds:** 3–4 broken builds of 3–5 faults each, plus one clean build.
  **Every fault appears in exactly one broken build and never in the clean
  build.** Liveness of composed builds is proven mechanically, not argued:
  the G1 gate runs the full manifestation-test suite against every build —
  every assigned fault's test red, every unassigned fault's test green — so
  per-fault toggles are proven not to mask each other in combination. Build
  order is randomized per arm and **the clean build is not identified** —
  any claim against it is a false positive unless it reproduces on the
  clean reference as a genuine latent issue.
- Every fault: an independent toggle plus a deterministic green-on-clean /
  red-on-broken manifestation test. The P1-era bench oracles are **not**
  part of this instrument and must not be extended for it.

## Trials and procedure

**Two complete trials**, under the web study's replication rules: trial 2
re-runs the frozen protocol with fresh agent contexts and fixture state —
same builds, stories, brief, models, prompts, budgets, and rubric; nothing
is tuned between trials; with two trials variance is descriptive, and a
reversed verdict is published, never averaged away. The clean build runs in
both trials, so B3 rests on more than one clean execution per arm.

Within a trial, each arm is single-shot per build (no hill-climb — the
withdraw-and-retest question is owned by the web study): arm C's frozen
tests plus its per-build fresh-context analysis; arm P's frozen stories;
arm F with its frozen configuration. Every execution starts from the seeded
reset.

## Scoring

The web study's judge protocol applies verbatim
([`web.md` § Judge protocol](./web.md#judge-protocol)): arm-blind Fable 5 by
default, and its catalog-blind **atomic normalization pass** runs first —
raw deliverables are split into one-issue claims with duplicates marked
before the classification pass sees the catalog. That pass matters most
here for arm F, which can emit many generated examples of one underlying
failure. Two API-specific overrides:

- a **latent** claim must violate the OpenAPI document or the rules brief —
  the web rubric's reasonable-user-expectation standard is too subjective
  for an API;
- claims are judged per build, and a seeded fault is creditable only in the
  build that carries it.

Each arm's deliverable is judged as handed over: arm P's deduplicated
findings, arm C's per-build reports, arm F's failure output. Repeats of an
already-credited fault within one deliverable are that arm's noise.

## Headline metrics

Per arm and trial: seeded found (of N), latent found, invalid claims (with
invalid-on-clean-build broken out), all-in dollars, wall time, turns
(arm C: agent turns; arm P: actor steps; arm F: n/a), request counts, and
the trial-2-minus-trial-1 replication delta.

Cost accounting is frozen with the metrics: all-in cost **includes** arm
P's story authoring, arm C's test authoring, each arm's configuration
effort, and all model execution; shared benchmark construction (subject,
faults, judge) is **excluded** and reported separately.

## Verdict bars (defaults; binding at G0)

- **B1 — value floor:** any arm claimed to add value must strictly exceed
  arm F's seeded count.
- **B2 — marginal value:** the headline "Playtest adds API detection value
  over a coding agent" requires arm P seeded ≥ arm C seeded + 2. If arm C
  matches or wins, that is the published result, stated plainly.
- **B3 — trust:** arm P invalid claims on the clean build = 0.
- **B4 — operating envelope and budget:** per-arm, per-build limits are
  frozen at G0. Defaults carry the prior instrument's cap of 360 requests
  or 3 hours per arm × build (Schemathesis is not reproducible even with a
  fixed seed, so its limits are wall-clock and request bounds, not a seed),
  with retry and infrastructure-failure rules stated per arm. Probe history
  says ≈$20 and ≈80 minutes per build; the whole-study cap defaults to
  $250 across both trials, abort rules frozen at G0. Runs are serial — one
  Playtest run at a time — so wall time is the binding constraint; build
  count may be reduced at G0, never after data.

B1–B3 are evaluated separately for both trials. If arm C or arm F matches
or beats arm P in either trial, or a verdict reverses between trials, that
is published plainly rather than hidden in an aggregate.

## Operations and integrity

- Execution topology mirrors the web study
  ([`web.md` § Operations](./web.md#operations)): one Claude Code session
  as the study harness; all GPT-family calls (probe actor, grader, control
  agent) through the Codex gateway at `http://localhost:8900`;
  Claude-family roles (the judge, the fault author) invoked as isolated
  fresh-context agents receiving only their allowlisted inputs; exact
  Claude Code, gateway, model, tool, and MCP pins frozen at G0.
- Hosted platform on a **fresh `PLAYTEST_DATA_DIR`** dedicated to the study
  (shared convention with the web study; disposable, never archived or
  published wholesale — it holds the dev runner credential and auth state;
  the committed evidence is the same scrubbed-export shape as the web
  study's); driver scripts under `studies/detection-api/scripts/` call the
  hosted HTTP API only.
- One frozen instrument at G0: probe route/model/prompt pins, arm C model
  and harness, judge model and rubric (defaults: gpt-5.5 arms, Fable 5
  judge), Schemathesis version and configuration — all after availability
  smokes.
- Brief and stories frozen before fault authoring; the fault author sees
  the clean fixture and spec, never the arms' materials.
- Long rounds detached via `nohup`; kills verified with `pgrep -f` until
  empty.

## Phases and gates

| Phase | Work | Gate |
|---|---|---|
| G0 | Freeze: model/route/tool pins after availability smokes, both-trial protocol, operating envelope, credential set, bars, brief, stories, budget, judge rubric, contamination audit (subject decision recorded) | prereg committed |
| G1 | Sealed faults + build allocation + manifestation tests; sha256 commitment recorded | allocation gate green on every composed build (assigned faults red, all others green); clean build untouched with toggles off |
| G2 | Shakedown: each arm once against one **public dev fault** (never the sealed set) | pipeline proven end to end for all three arms |
| G3 | Measured trials: two frozen trials, all arms × all builds, order randomized per arm and trial | every claim judged; ledger complete |
| G4 | Report + verdicts against B1–B4 | static site at `studies/detection-api/report/` published; sealed set committed to history |

## Out of scope

The script-authoring arm (direction dropped, header note); a
source-visible / in-repo control arm (a code-review study, not this one);
hill-climb rounds; cross-API generalization claims; per-category claims;
any change to `studies/api-probe/` (frozen) or to the shipped script
substrate.
