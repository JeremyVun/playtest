# Playtest for APIs — Design (script-authoring direction)

**Status:** Approved direction (2026-07-26): agent-authored, human-approved
executable suites as the API trajectory, hosted-first.
**Supersedes:** the probe-first design of 2026-07-24, preserved with its P1
verdict at `git show 7e363b2:docs/backlog/api-testing/DESIGN.md`. Its Stage 2
shipped in full and is unaffected.
**Scope:** What Playtest's API-testing product becomes after the P1 study:
the hosted user journey, the architecture, what is deliberately *not* built,
and the evidence bar before heavy investment.
**Provenance:** Written from `studies/api-probe/REPORT.md` (preregistration
frozen at `9059797`) and three design corrections made with the user on
2026-07-26: hosted-first (the web UI is the front door; there is no user git
flow to lean on), no embedded agent SDK (the authoring loop is a bounded
retry loop on the existing model gateway), and invariants arrive as
approve/deny rule cards, not as user-authored statements. The build order is
[`BUILD_PLAN.md`](./BUILD_PLAN.md).

---

## 1. The evidence and the pivot

P1 asked whether a goal-directed live actor, given a natural-language
invariant and a deterministic oracle, finds semantic API faults that cheaper
approaches miss. Preregistered, sealed held-out faults, three arms with
equal knowledge (served OpenAPI document + six invariant statements), all
traffic scored by the same deterministic oracles at the same wire-enforced
360-request budget:

| Arm | Held-out detection | Cost / build | Wall / build | Authoring |
|---|---|---|---|---|
| probe (live actor) | 3/5 — 2 of 4 semantic, bar was 3 | $20.22 | ~80 min | six stories |
| agent-authored suite | 4/5 (5/5 by its own correct report¹) | $0 | 0.26 s | ~2.5 h, once |
| Schemathesis | 1/5 | $0 | 2.2 s | config only |

¹ It also caught `f-settle-failed-debit` and named the offending ledger row;
the shared oracle's applicability window failed to credit it
(`REPORT.md` §3).

**Verdict: NO-GO** on the live-probe/fuzzer thesis. The winning arm wrote an
executable test suite from the spec and invariant statements alone —
black-box, no repository access — and then replayed it for free. Two lessons
drive the new design: **enumeration beats search for coverage** (the fault
the probe uniquely missed was currency-conditional; the suite tested both
currencies because its author enumerated the space), and **the economics are
not close** ($20.22/80 min per build vs $0/0.26 s after one authoring pass,
with better detection).

What survived and is kept: deterministic oracles over recorded HAR with no
model in the verdict path; zero false positives across 37 clean runs; the
entire Stage 2 substrate (§3).

### The thesis

> The platform authors an executable test suite for the user's API — from
> the spec and a set of plain-language rules the user *approved rather than
> wrote* — inside the runner-agent sandbox, through a bounded model retry
> loop. A human reviews the script with an evidence-backed risk profile and
> approves it. The approved script — plus the HAR and structured report each
> execution produces — **is the trajectory**: replayed deterministically for
> free on every build, with drift returning as a proposed revision card the
> human approves or rejects.

### "Aren't these just functional tests we should have written ourselves?"

Yes — and the product answers that honestly instead of dodging it. The
scripts are plain files; a team can export them into their own repository
and keep them (CLI path, §8) — the artifact is deliberately not proprietary.
What Playtest sells is everything around the file that repos don't provide:

- **The tests most teams never write.** Semantic invariant checks
  (conservation, lifecycle legality, idempotency-across-state) authored
  from owner-approved rules — not the happy-path CRUD tests that already
  exist in their repo.
- **The maintenance loop.** Drift triaged, revisions proposed with a diff
  and a drift report, approvals fingerprinted — a committed suite rots; this
  one comes back as a card.
- **Black-box against deployed environments.** The suite runs against
  staging/production-like targets on a schedule, with HAR evidence and the
  dual-column gate — not in-repo unit tests against a mock.
- **Governance a repo test lacks:** who approved which rule, which exact
  script content is licensed to run, what its mutation surface is.
- **And the thing no committed suite can do** — construct novel states by
  live exploration. That capability is the probe, and it stays a live seam
  (N15) rather than a closed chapter.

## 2. Decision record

| # | Decision |
|---|---|
| N1 | The API trajectory is a **script artifact**: the authored program, its execution HAR, its structured report, and the authoring transcript. A new versioned artifact family, not a step-envelope retrofit. The shipped API journey track remains; convergence is roadmap (§10). |
| N2 | *(carried)* CI truth is deterministic only. A model may author, propose rules, propose revisions, review, or narrate; it never decides a verdict, and its review never substitutes for human approval. |
| N3 | **Hosted-first.** The web UI is the front door: spec provisioning, rule cards, script review/approval, and drift revisions are platform surfaces. The CLI path (scripts as plain files, review by git) falls out secondarily; nothing depends on the user having a git flow. |
| N4 | **No agent SDK, no bespoke multi-tool harness.** Authoring is a bounded retry loop on the existing model gateway — prompt(handout + draft + last report) → full revised script → execute → repeat — using whatever actor model the user configured. One tool means the "harness" degenerates to a loop simpler than the existing web actor. |
| N5 | **Authoring terminates on soundness, not success — and soundness includes sufficiency.** Sound = the script executes without defects, within budget, every check is exercised (applicability, the P4 rule), **and every entry in the coverage-obligation manifest is accounted for** — covered, skipped with an approved reason, or marked unsupported. Obligations derive mechanically from the handout: approved rules × their applicability, the Level 0 policy set, and operation coverage; each report entry traces to its obligation. Without this, "every authored check exercised" would certify a vacuously small suite. A failing check is a **candidate finding**, not a revision trigger: the loop re-verifies its evidence against the HAR and keeps it annotated. The human judges findings at approval: real bug, or wrong rule (deny/edit the card and re-author). The API being broken is a supported — desirable — day-one outcome. |
| N6 | **Invariants are approved, never demanded.** Level 0: spec-derived Tier-1/2 checks, on by default, zero user input. Level 1: the platform proposes plain-language **rule cards** (approve / deny / edit / add-your-own / notes); notes flow into the authoring handout as steering. Only human-approved sentences are enforced — observed behavior never silently becomes a rule (carried governance). Level 1's zero-input headline ships only if S0's proposal trial clears its bar on **recall and precision** (§7); otherwise Level 1 ships as assisted authoring with narrowed copy. **Settled 2026-07-26 (§7.1): assisted authoring.** Precision and detection both cleared; the recall bar turned out to be arithmetically unreachable (one-to-one matching of 5–8 cards against 16 rules), so the disposition rests instead on the measured detection gap — 8 of 13 against the statements arms' 11–12 — and on the arm driving too shallowly into rules it had proposed. The zero-input claim is not made. Honest limit either way: the owner never writes test code, but must be able to *recognize* their business rules — approval cannot conjure knowledge the owner lacks, and a wrong approved rule creates false positives forever. |
| N7 | Scripts get **no ambient network or credentials**: the harness-injected client is the only path to the target — origin-locked (P0 egress semantics), budgeted, HAR-recording, read-only-capable, secret-injecting (a script can cause an authenticated request, never read the credential). |
| N8 | **Capability pre-bounding replaces a permission system.** The authoring job's world is the runner-agent sandbox filesystem plus the injected client aimed at a target the owner declared safe to write test data to. When the session cannot exceed its authorization, there is nothing to prompt for. Interactive per-action permissioning is explicitly not built. Two hardenings: **targets are read-only by default** — mutation requires the explicit write grant of §4 step 2; and hosted, the boundary is a **contract with escape tests, not an assumption** — credentials live in a separate secret-bearing proxy process, the script process holds no credential and is network-isolated except through that proxy, and S1 ships an adversarial battery (ambient `fetch`, `node:http`/`net`, `process.env`, filesystem escape, `child_process`, report fabrication) proving it. Locally the documented trust model stands: the client guards accident, review guards malice. |
| N9 | **Approval is an artifact lifecycle state**, the platform's third instance of an existing pattern (healed baselines held for review; findings review): sha256 content fingerprint, approver, timestamp, review reference; any edit — direct or agent-applied — invalidates back to pending. Not a permission framework. |
| N10 | Verdicts are **two-column**: deterministic oracles over the recorded HAR, and the script's own check report. The P1 shared-oracle applicability bias (`REPORT.md` §3) is why one column is not enough. |
| N11 | Drift is a **revision, not a heal-in-place**: failed replay → P4 triage; contract drift → proposed script revision + drift report, pending until re-approved; regression → red, loudly. A script never silently modifies itself. |
| N12 | A **confirmation study (S0) precedes heavy product build** with a preregistered bar. Honest framing: the unbiased evidence is the **sealed set of ≥11 faults only** — the 13 public faults are development data, and three suites replayed against the same sealed faults are repeated measurements, not extra samples. S0 is explicitly a **ledger-domain confirmation study**; cross-API generalisation is S5's job, not a claim S0 can support. Faults are preregistered against a taxonomy with per-category reporting, one exact execution substrate is frozen and fingerprinted before the first measured trial, clean-build scoring includes conforming-variant builds (false-positive resistance, not just one canonical implementation), and the proposal trial measures precision as well as recall. |
| N13 | Script mode is **API-only**. Web and mobile keep the live actor: scripts win where the contract is machine-readable and stable (OpenAPI) and rot where it is implicit and drifting — the problem stories + heal already solve. |
| N14 | *(carried)* The stakeholder API stays withheld for a maintainer-run trial with a frozen instrument (S5). The fuzzer engine (old P6) stays closed. |
| N15 | **The live-probe seam stays open.** "Why not just commit these tests to your repo?" is a fair question (§1), and the part of the answer no committed suite can supply is live state construction — the one capability P1 credited to the probe. The probe therefore remains a supported exploratory capability, and S0 runs it as a **full third arm — one final preregistered rematch** against the improved sealed fixture: same budgets, same oracles, per-category results. A probe-unique detection in a named category licenses a **hybrid roadmap item** (probe explores, findings distill into script checks — §10), never the generative engine (N14). No unique detection closes the live track for good, with two studies of evidence behind the close. **Superseded 2026-07-26 (§7.1): the rematch was not run and the seam stays open.** The frozen oracles can score the probe on only 4 of the 14 sealed faults, so the arm could not answer its own question; a study that was not run closes nothing. Answering it needs a purpose-built instrument, deferred until there is a reason to build one. |

## 3. What exists and is reused (verified 2026-07-26)

| Asset | State | Role |
|---|---|---|
| Egress guard | shipped (P0) | The injected client applies the same origin semantics to scripts. |
| `examples/ledger-api/` | shipped; 13 public faults (8 dev + 5 unsealed held-out) | S0's subject, extended with a new sealed set. Editable again post-unseal (`7e363b2`). |
| Bench + oracles | shipped (`examples/ledger-api/bench/`) | Offline scoring of any run dir or HAR; S0 adds the second column (N10). |
| Secrets + leak scan | shipped (P2) | Secret references resolve into the client; the leak scan runs over script text on save. |
| Bindings, match rules, OpenAPI enrichment | shipped (P3) | Enrichment powers the handout and Tier-1 checks; the enrichment boundary rules (no network refs under hermetic execution) apply to spec provisioning. |
| Heal triage, drift reports, Tier-1/2 policies | shipped (P4) | Triage classification and drift-report artifact reused verbatim for revisions; Tier-1/2 policies are the Level 0 checks and gate script HAR. |
| Cross-layer HAR gate | shipped (P7) | Same machinery evaluates script executions. |
| Hosted review surfaces + feed | shipped | Healed-baseline review and findings review are the approval pattern (N9); the feed pushes script/run state — no polling. |
| Authoring assistant | shipped (`control-plane/src/authoring/assistant.ts`) | The "help me draft it" pattern; rule-card proposal and on-demand narrative review are new calls on this surface. |
| Runner-agent | shipped | The sandbox: authoring jobs and replay jobs both run here. Its isolation is the hard boundary. |
| `studies/api-probe/comparators/` | study assets | `har-proxy.mjs` seeds the client's recorder; `agent-suite/` is the v0 script shape, report format, and handout protocol; `INVARIANTS.md` is the rule-statement shape. |
| API journey track | shipped | Unchanged. |

`studies/api-probe/` is frozen — read, never modify. S0 lives in
`studies/api-suite/`.

## 4. The hosted journey

The bar: a user who knows nothing about their API's internals — not its
invariants, not what its endpoints do — gets a real suite. Counted in human
actions:

```
1  Paste base URL (+ credentials as $secret refs).
   Platform auto-discovers the spec (/openapi.json, /swagger.json, spec
   link headers); if unexposed, the environment config takes a URL,
   an upload, or pasted JSON. Missing spec = actionable config error.

2  "Safe to write test data to this environment?"          [ yes ]
   (targets are read-only until this grant — N8; the answer records
    the target authorization: origin + the owner's word, and it is
    what licenses authoring-time mutations)

3  Rule cards (optional — skipping still yields Level 0):
   ┌─────────────────────────────────────────────────────┐
   │ "A transfer that ends 'failed' writes no ledger     │
   │  entries."                                          │
   │  proposed from: POST /transfers · status enum       │
   │  [ ✓ applies ] [ ✗ not a rule ] [ edit ] [ note… ]  │
   └─────────────────────────────────────────────────────┘
   … 5–8 cards, plus [ + add your own rule ]

4  Authoring job runs (minutes, user's configured model).

5  "Your suite: 23 checks across 9 endpoints · reads + writes ·
    ~38 requests · 0.4 s — and 2 checks are FAILING with evidence."
                                       [ view findings ] [ Approve ]
   A failing check at approval is judged by the human: file it as a
   bug, or deny/edit the rule card it came from and re-author (N5).

6  Every build/schedule: replay. Green — or a drift card:
   "response field renamed; proposed revision + drift report"
                                       [ view diff ] [ Approve ]
```

Two confirmations, optional taps, and approvals. Every approval doubles as
the safety gate.

### Lifecycle

```
spec + approved rules ──▶ AUTHORING (runner-agent job)
                            retry loop: prompt → script → execute → report
                            terminates on SOUNDNESS (N5)
                              │
                              ▼  bundle: script + transcript + HAR + report
                          PENDING ── human review: risk profile,
                              │      findings, source, notes
                              ▼  approve (fingerprinted, N9)
                          APPROVED ──▶ REPLAY every build ($0, <1 s)
                              │            gate: oracles(HAR) ∧ report (N10)
                              │ red
                              ▼
                          TRIAGE (P4): regression → RED, loudly
                                       contract drift → revision + drift
                                       report → PENDING (re-approval)
        any edit, direct or assistant-applied ────────▶ PENDING
```

## 5. Architecture — what gets built

```
BROWSER (web UI)            CONTROL PLANE                 RUNNER-AGENT (sandbox)
 environment config          SQLite + object store         AUTHORING JOB
 rule cards                  script artifact:               retry loop on the
 script page:                 versions · fingerprints       model gateway (N4)
  source · diff since         approval records              fs = scratchpad
  approval · risk panel       pending revisions             net = injected client
  findings · run history     rule statements + notes            │
  approve/reject             dispatch · gate · feed        REPLAY JOB
  ask-for-review                                            runner + client ──▶ user's API
        ▲                                                   har + report
        └── feed (push) ◀── verdicts, drift cards
```

The complete build list — everything else in this document is reuse:

1. **The client/check library** — the load-bearing invention. Origin lock,
   request budget, HAR recording, read-only mode, secret injection, and the
   `check()` report channel. Seeds: `har-proxy.mjs`, the agent-suite's
   `lib/`.
2. **The handout generator** — enriched spec (P3) + approved rule
   statements and card notes + client docs + the authoring brief.
3. **The authoring retry loop** — bounded iterations on the model gateway,
   model-agnostic, soundness termination, transcript persisted.
4. **Runner + gate wiring** — subprocess in; HAR, report, exit out;
   two-column verdict through shipped oracle machinery. Includes the
   **coverage-obligation manifest** (N5): obligations derived from the
   handout, every report entry tracing to one, statuses covered /
   skipped-with-approved-reason / unsupported. This is product, not just
   study apparatus — it is what makes the approval screen honest
   ("23 checks covering 9 of 9 operations, 6 of 6 rules", not "23 checks").
5. **The mechanical risk profiler** — no model: method histogram, endpoints
   and resources touched, mutation classification (reads / writes /
   deletes), data created, secret-reference usage, out-of-origin attempts,
   request count. Renders in the risk panel and the CLI.
6. **Rule cards** — Level 0 wiring (Tier-1/2 on by default) and the Level 1
   proposal call on the authoring assistant, with approve / deny / edit /
   add / notes.
7. **The script artifact + approval lifecycle + script page** — N9's state
   machine on the existing review pattern, plus drift-as-revision (N11).
8. **The authoring skill/brief** — the protocol text (from
   `agent-suite/BRIEF.md`) as a maintained asset.

Deliberately not built: an agent SDK integration, a multi-tool agent loop,
an interactive permission system, an approval framework beyond the artifact
states, OS-level sandbox research (the runner-agent is the boundary; locally
the client guards accident and review guards malice — the same trust model
as any test suite a team commits, made explicit and legible).

## 6. Safety model

Layered, outside in: (1) **read-only by default; target authorization** —
the owner's declaration in step 2, scoped to one origin, required before any
mutation; (2) **approval gate** on script content, fingerprint-invalidated
on any change; (3) **client-enforced confinement** (N7), and hosted, the
**escape-tested proxy boundary** (N8) — the script process holds no
credential and reaches nothing except through the secret-bearing proxy;
(4) **leak scan** on script save; (5) **review legibility** — the mechanical
risk profile makes the mutation surface plain before a human approves.
Prompts and personas remain defense-in-depth, never the guard.

Two lifecycles the contract must answer precisely (S1/S4 own the details):

- **Test data.** Mutating suites create resources on every replay: created
  identifiers are run-namespaced (collision-proof across concurrent runs),
  cleanup policy is declared per target (harness-owned reset where the
  authorization includes one; otherwise best-effort teardown plus an
  accumulation cap that fails the run loudly rather than silting up the
  environment), and a failed cleanup is reported, never silent.
- **HAR.** It is evidence, part of the bundle, and sensitive at once — so
  one precise policy: known-secret scrub at write time (P2), body-size
  caps, declared retention/expiry, and a statement of which evidence
  remains usable after sensitive payloads are deleted (check reports keep
  their obligation trace and cited entry metadata; raw bodies go).

## 7. The confirmation study (S0)

P1's result is one author against five faults — enough to kill the fuzzer
thesis, not enough to size this one. S0 is explicitly a **ledger-domain
confirmation study** (N12): its claims stop at this fixture, and cross-API
generalisation belongs to S5. What it answers, cheaply because the suite arm
costs ~nothing per run:

- **Sample.** The fixture catalog grows to a ~24-fault catalog, but the
  unbiased evidence is the **new sealed set of ≥11** (≥8 semantic, ≥2
  temporal — the boundary that beat every P1 arm), authored in isolation
  under the sha256-commitment discipline. The 13 public faults are
  development data and are reported as such. Sealed faults are
  preregistered against a **taxonomy** (state-machine, cross-resource
  invariant, conditional branch, pagination, idempotency, temporal
  boundary, authorization, error semantics) with per-category results, so
  many similar state faults cannot obscure a total miss on one category.
  The **temporal category gets an explicit disposition at verdict time**:
  detected, or recorded as a named limitation with a concrete remediation
  item (e.g. a documented clock-advance affordance in the handout) — the
  study cannot "proceed" past the known weakness silently.
- **Authoring variance:** three independent statements-trials, fresh agent
  each, identical handout, no shared state.
- **Proposal quality (the Level 1 gate):** one additional trial receives
  the spec but **no invariant statements** and proposes rules first.
  Measured on **recall** of known rules, **precision** (unsupported or
  harmful proposals — the costlier failure, since a wrong approved rule is
  a false positive forever), and detection achieved using only its own
  proposed-then-adjudicated rules; the maintainer's per-rule adjudication
  is documented. This trial **gates S3's headline**: Level 1 ships as the
  zero-input experience only if it clears the bar set in the prereg;
  otherwise Level 1 ships as assisted authoring (N6).
- **The probe rematch (N15):** the live probe runs as a full third arm
  against the entire sealed set — not a cost anchor, a real final study.
  Instrument: P1's frozen instrument, with at most one declared tuning
  round against development faults only, re-frozen before the sealed
  round. Same budgets, same oracles, per-category results. Its
  preregistered question is narrow: **is there any category where the
  probe detects what all three authored suites miss?** Yes licenses the
  hybrid seam (§10); no closes the live track with two studies of
  evidence. Expected cost ~$220 at P1 rates — the price of answering the
  question for good.
- **False-positive resistance, not just one clean build:** clean scoring
  includes **conforming-variant builds** — alternate valid statuses and
  optional fields the spec allows, empty and populated pagination,
  regenerated identifiers, a latency-jitter flag on the deterministic
  fixture — plus repeated clean runs. A check that fails a conforming
  variant is a false positive: it snapshotted an implementation instead of
  encoding the contract. This is also the CI-flake estimate.

**Method discipline** (P1's lesson, hardened): exactly **one execution
substrate** — runner, client, report schema, prompts, model id, decoding
config, retry policy — is selected and fingerprinted in the prereg before
the first measured trial; all measured trials use it. Fault replay order is
randomized; every replay starts from an isolated seeded reset;
infrastructure-failure and rerun rules are preregistered. Scoring is
dual-column (N10) plus the **five-stage funnel** per fault per trial —
obligation enumerated → scenario executed → fault manifested in traffic →
assertion detected it → report cited correct evidence — so a miss is
diagnosed as enumeration, reachability, assertion, or reporting failure,
not left a mystery.

Preregistered proceed bar — defaults, finalized only in the prereg commit:
every statements-trial detects ≥⅔ of sealed semantic faults on the
reported-with-evidence column; zero false positives across all trials on
the clean build **and its conforming variants**. The bar is an operational
go/no-go for this team's next investment, and is not claimed as evidence of
generalisation beyond the fixture. A failing S0 stops the pivot after S1;
the shipped journey track stands alone.

### 7.1 Outcome (2026-07-26) — the three recorded dispositions

Executed against the preregistration frozen at `6aa5b75` (pin `36d1af8`);
full evidence in [`studies/api-suite/REPORT.md`](../../../studies/api-suite/REPORT.md)
and its round log. Fourteen sealed faults across all eight taxonomy
categories, three statements-trials, one proposal trial, 124 scored builds,
zero model calls in any verdict path.

**1. Proceed / stop → PROCEED.** Every statements-trial cleared the bar of
≥9 of 13 sealed semantic faults on the reported-with-evidence column:
**11, 12, 12**, with twelve faults found by all three and none missed by
all three (sd 0.47). False positives were zero on the oracle column across
all 68 conforming builds, and zero on the reported column for trials 2 and
3 and the proposal arm. Trial 1's one persistently failing check is ruled a
**true positive** under §6.3: it enforces handout statement §11 against a
fixture that answers 422 where the statement requires 400. The ruling is
arguable and the stake is the whole study — §9.1(b) is written round-wide
("0, across all four trials' suites, in both columns"), so under the
spec-governs reading S0 records **STOP**, not merely a disqualified arm.
The report argues both sides; a reader who rejects the ruling should
reject the verdict with it. Note the arms split three ways on this, which
is itself the finding: trial 1 reported it, trial 2 reasoned itself out of
reporting it on the spec's enumeration, and trial 3 accepted either status
for `amount` while keeping a strict 400 assertion on a wrongly-typed
non-amount field — which passes, localizing the fixture's collapse to
`amount` alone. Replay economics held: 84 non-jitter builds in 49.9 s
total, ~0.6 s per build, $0.

**2. Level 1 → assisted authoring, not the zero-input headline.** The
proposal trial's precision was clean — 8 cards, 0 harmful, 0 unsupported,
all approved unedited — and its detection on its own adjudicated rules
(8 of 13) cleared the ≥7 bar. Two of three conditions passed.

**The recall condition was unmeasurable, because the bar was broken at the
freeze.** §9.2 matches proposals to reference rules one-to-one, and the
proposal brief asks for 5–8 cards against 16 reference rules — so no
conforming submission could ever have reached 11. The arm scored 8 of 16
under that rule (10 by substance, since two cards each carry two rules),
and both counts are in the report. A bar that cannot be cleared says
nothing about the arm that failed it, so **the disposition does not rest on
recall.** It rests on evidence that is measured: detection on self-proposed
rules ran 8 of 13 against the statements arms' 11–12; the trial's transcript
names four rules it failed to propose, one of which its own card structure
made unenforceable; and — the most product-relevant finding — only two of
its six misses sit on rules it never proposed. Three sit on rules it *did*
propose but drove too shallowly. Fewer approved rules build a shallower
world, which then hides faults on the rules you do have. Rule cards ship as
**"review and confirm your API's rules"**, not as a zero-knowledge claim.
N6's honest limit is now measured rather than asserted, and §9.2's recall
definition needs repair before any future study reuses it.

**3. Probe seam → open and unanswered; the rematch was not run.** The
frozen P1 oracles can credit the probe on at most 4 of the 14 sealed faults
— the other 10 lie outside their vocabulary, and the probe has no
self-report column — so the rematch could only have answered its
preregistered question across a quarter of the evidence, and rewriting the
referees after the fact is what the freeze forbids. N15 said a null result
closes the live track; **a study that was not run closes nothing**. The
seam stays open as a deferred question needing a purpose-built instrument,
and the hybrid roadmap item in §10 remains unlicensed rather than refuted.

Scope, unchanged by the result: this is a ledger-domain confirmation study
on one fixture with one model. The sealed 14 are the only unbiased
evidence. Cross-API generalisation is S5's question, and nothing here
claims it.

## 8. CLI surface (secondary)

Scripts are plain files, so the CLI path falls out: `playtest script run`
(runner + gate), `playtest script review` (mechanical profile to the
terminal), fingerprint recorded beside the script, approval by the team's
own code review. No CLI-side approval framework; git is the review surface
there, the script page is the review surface hosted.

## 9. Out of scope

- **Web/mobile script mode** (N13) — each modality gets the tool its drift
  rate demands; not revisited here.
- **The fuzzer engine** (N14) — closed by P1, not reopened.
- **Interactive authoring chat** — the loop is batch with a transcript; a
  conversational authoring surface is a UX layer for later, not v1.

## 10. Roadmap seams

Named seams so later work slots in without changing the UX or governance:

- **Invariant discovery uplift.** Level 1 v1 proposes from the spec (and a
  read-only look at the running API). Behind the *same card UI*: mining
  docs, historical traffic, or code for candidate rules. The card is the
  contract; discovery quality improves behind it, and the governance rule
  (only approved sentences are enforced) never moves.
- **Hybrid probe + script mode** *(licensed only by an S0 probe-unique
  detection — N15)*: the live probe explores on a schedule or on demand,
  constructing states enumeration does not reach; anything it finds is
  distilled into script checks through the ordinary card/revision flow, so
  the durable asset stays deterministic and approved. Exploration proposes;
  the suite remembers.
- **Scoped target authorization.** v1 authorization is origin-wide with a
  read-only default. Later: method/path scope, tenant or namespace scope,
  expiry, write and request caps — worth building when a production-adjacent
  target first asks for it.
- **Journey-mode convergence.** A recorded API journey exporting to a
  script (the roadmap's existing "api-driver export to `node --test`" item)
  would unify the tracks.
- **Suite maintenance at scale.** Spec-diff-triggered proactive revision
  proposals ("your spec added an endpoint; extend the suite?") — the same
  pending-revision card, upstream of failure.

## 11. Open questions

Each with a recommended default for the implementing session:

- **Loop revision policy for failing checks.** N5 says re-verify and keep;
  the subtle case is a check failing because the *expectation* is wrong
  (script defect, not API bug). Default: the loop may revise a check only
  with a transcript-recorded justification citing the spec or an approved
  rule; everything else is a finding for the human.
- **Authoring budget shape.** Iterations vs wall clock vs total requests.
  Default: all three, generous, preregistered in S0 and productized from
  what the trials actually used.
- **Client API surface.** Minimal (request + check) vs helpers (pagination
  walkers, idempotency retries). Default: start minimal; promote helpers
  the S0 trials write independently more than once.
- **Where replay verdicts surface.** Existing runs/findings pages vs the
  script page only. Decide in S4 with the hosted IA.
- **Rule-card provenance display.** How much "proposed from: …" evidence a
  card shows. Default: the spec fragments that motivated it, one line.
