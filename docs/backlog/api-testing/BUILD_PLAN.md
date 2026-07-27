# Playtest for APIs — script-authoring build plan

Implements [`DESIGN.md`](./DESIGN.md) (the 2026-07-26 direction, hosted-first,
after three corrections recorded in its provenance note). The previous
probe-first plan completed through P4/P7 and is preserved at
`git show 7e363b2:docs/backlog/api-testing/BUILD_PLAN.md`; its P1 study is the
evidence this plan stands on (`studies/api-probe/REPORT.md`), its P6 stays
closed, and its P5 stakeholder trial is superseded by S5 below.

Read first:

- `CLAUDE.md`
- `docs/CONTRACTS.md`; `docs/contracts/engine.md` (API driver, gate, Tier-1/2
  policies, custom assertions); `docs/contracts/artifacts.md` (HAR, drift
  report); `docs/contracts/hosted.md` (control plane / runner-agent / web
  boundaries)
- `docs/backlog/api-testing/DESIGN.md` — the spec; §/N refs below are into it
- `studies/api-probe/REPORT.md` and
  `studies/api-probe/comparators/agent-suite/` — the v0 of the product:
  handout brief, transcript discipline, script shape, report format

Standing rules:

- Do not start phase N+1 while phase N's exit gate is red. Exceptions per
  phase; the load-bearing one: **S1 may run in parallel with S0; S2 and
  beyond start only after S0 records proceed** (DESIGN §7). A failing S0
  stops the pivot and this plan gets a closing note.
- CI truth is deterministic only (N2). No model output reaches a verdict; no
  model review substitutes for human approval.
- **No script executes against any target without** a fingerprinted approval
  of that exact content or the target-authorization declaration of DESIGN §4
  step 2 (which is what licenses authoring-time execution). Binds all
  phases, tests included.
- **Authoring terminates on soundness, not success** (N5). No phase builds a
  loop that revises away a failing check without a transcript-recorded,
  spec-or-rule-citing justification.
- No agent SDK, no multi-tool agent loop, no interactive permission system
  (N4, N8). If a phase seems to need one, the design is wrong — stop and
  re-read DESIGN §5.
- Update the owning contract in the same change as behavior; prompt changes
  bump their owning pin.
- `npm test` stays hermetic, offline, Node-only, zero-skipped. Script
  execution in tests targets in-process/loopback fixtures; model-driven
  authoring and study rounds are manual steps, never in the gate.
- `studies/api-probe/` is frozen — read, never modify. S0 lives in
  `studies/api-suite/`. Boundary gotcha that bit twice in P1: `studies/**`
  source files may not contain the literal `examples/` path — parameterize
  via env (`tests/repository/boundaries.test.ts`).
- The stakeholder API is out of bounds for every phase except S5;
  S5 is maintainer-run (N14).
- Secrets: `PLAYTEST_SECRET_<NAME>` references only; the CLI never loads
  `.env`; the leak scan covers script text.

## Phase map

| Phase | Outcome |
|---|---|
| **S0** | Confirmation study (ledger-domain): ≥11 sealed held-out faults under a preregistered taxonomy; 3 authoring trials + 1 proposal-quality trial + the probe's final rematch arm; dual-column + funnel scoring on one frozen substrate; proceed/stop verdict |
| **S1** | Script substrate: client/check library, runner, report schema, gate wiring, mechanical risk profiler |
| **S2** | Authoring: handout generator, spec provisioning, the bounded retry loop, findings surfacing |
| **S3** | Invariant levels: Tier-1/2 as Level 0 defaults; rule-card proposal, approve/deny/edit/add/notes |
| **S4** | Hosted lifecycle: script artifact + approval states, script page, drift-as-revision, replay dispatch; CLI parity |
| **S5** | Maintainer-run stakeholder **pilot** with a frozen instrument |

Critical path: **S0** with **S1** in parallel (S1 is needed whatever S0
says; S0's prereg freezes exactly one substrate — S1's runner if it landed
before the freeze, else the study-local one, either way fingerprinted and
used for every measured trial); then S2 → S3 → S4 gated on S0; S5 after the
instrument freezes. S3's Level 1 headline is gated by S0's proposal-quality
trial; its Level 0 wiring has no S0 dependency. The probe rematch arm rides
inside S0 (N15).

---

## S0 — Confirmation study (ledger-domain)

Scope framing first (N12): this study's claims stop at the ledger fixture —
say so in the prereg and the report. The unbiased evidence is the sealed
set only; the 13 public faults are development data; suites replayed
against the same sealed faults are repeated measurements, not extra fault
samples. Cross-API generalisation is S5's question.

### Scope

1. **`studies/api-suite/`** on the preregistration pattern
   (`studies/api-probe/PREREGISTRATION.md` is the template): instrument
   pins, fault sets and taxonomy, budgets, scoring definitions, ordering
   and rerun rules, the numeric proceed/stop bar, tuning log. Committed
   before the sealed round.
2. **One frozen substrate.** Before the first measured trial, select and
   fingerprint in the prereg exactly one of everything the measurement
   touches: runner, client, report schema, prompts/briefs, model id,
   decoding configuration, retry policy. All measured trials use it — no
   "S1 if landed, else a mirror". Preregister execution ordering
   (randomized fault replay order), per-fault isolated seeded resets,
   infrastructure-failure handling, and rerun rules.
3. **The sealed set: ≥11 faults under a preregistered taxonomy** —
   state-machine, cross-resource invariant, conditional branch, pagination,
   idempotency, temporal boundary, authorization, error semantics — with
   ≥8 semantic-tier and ≥2 temporal, authored by an isolated agent, held
   outside the checkout under a sha256 commitment until freeze, applied
   only in the measured environment, committed to history after the round.
   Each fault: `LEDGER_FAULTS` toggle, deterministic manifestation test,
   detectable under the (extended-before-sealing, if needed) invariant
   statements. Results are reported **per category**; the temporal category
   gets an explicit disposition at verdict time — detected, or a named
   limitation with a concrete remediation item (e.g. a documented
   clock-advance affordance in the handout). Keep the bench's vendored
   oracle copy in sync — a missed sync caused a P1 false positive.
4. **Scoring: dual-column plus the funnel.** Per fault per trial:
   *oracle-confirmed-in-traffic* and *reported-with-correct-evidence*
   (cited ids resolve in the HAR), plus the five-stage funnel — obligation
   enumerated → scenario executed → fault manifested in traffic →
   assertion detected → evidence correctly cited — so every miss is
   diagnosed as enumeration, reachability, assertion, or reporting
   failure. The prereg names the bar's column (default:
   reported-with-evidence — it is what a user consumes).
5. **Three statements-trials:** fresh agent each, identical handout (served
   spec + invariant statements), scratchpad isolation and transcript
   discipline per `agent-suite/BRIEF.md`, authoring against the clean
   build only within a preregistered budget; suites then replay against
   every sealed-round build on the frozen substrate.
6. **One proposal-quality trial** (gates S3's headline — N6): spec but no
   invariant statements; the agent proposes rules first, then authors
   against its own proposals as adjudicated. Measured: **recall** of known
   rules; **precision** — unsupported or harmful proposal rate (the
   costlier failure: a wrong approved rule is a false positive forever);
   detection using only proposed-then-adjudicated rules; adjudication
   documented per rule with time spent. Its bar (default finalized in the
   prereg) decides whether S3's Level 1 ships as the zero-input headline
   or as assisted authoring.
7. **The probe rematch — a full third arm (N15).** The live probe runs
   against the entire sealed set: P1's frozen instrument, at most one
   declared tuning round against development faults only, re-frozen before
   the sealed round; same budgets, same oracles, per-category results.
   Preregistered question: **any category where the probe detects what all
   three authored suites miss?** Yes licenses the hybrid roadmap seam
   (DESIGN §10); no closes the live track with two studies of evidence.
   Expected cost ~$220 at P1 rates; run it detached (nohup), one Playtest
   run at a time.
8. **Conforming negative controls.** Clean scoring covers the canonical
   clean build **and ≥2 conforming-variant builds** — alternate valid
   statuses/optional fields the spec allows, empty and populated
   pagination, regenerated identifiers — plus repeated clean runs under a
   latency-jitter flag on the deterministic fixture. A check failing a
   conforming variant is a false positive (it snapshotted an
   implementation, not the contract); the repeat runs are the CI-flake
   estimate.
9. **Report + verdicts:** per-category detection per trial in both columns
   with funnels, false positives across clean and conforming builds,
   cross-trial variance, authoring time/cost, the proposal-quality table,
   and the probe arm's category comparison. Three recorded outcomes, each
   against its preregistered bar, in `DESIGN.md` in the same change: the
   **proceed/stop verdict** (default bar: every statements-trial ≥⅔ of
   sealed semantic faults on the reported column; zero false positives
   across all trials on clean and conforming builds), the **Level 1
   disposition** (headline vs assisted), and the **probe seam disposition**
   (hybrid licensed vs live track closed).

### Contract impact

None to the engine — fixture, bench, and study only.

### Exit gate

- [ ] Preregistration committed before the sealed round: substrate
      fingerprints, taxonomy, ordering/rerun rules, and all three bars;
      sealed-set sha256 commitment recorded before any trial sees
      anything.
- [ ] Every new fault toggles independently, leaves clean-build behavior
      untouched when off; manifestation tests join the hermetic suite
      after the round.
- [ ] Bench reports both columns and the funnel for every arm from
      artifacts alone, offline, no model calls.
- [ ] All measured trials ran on the single fingerprinted substrate; four
      trial transcripts show scratchpad isolation held; the probe's
      tuning round (if any) is logged and predates the re-freeze.
- [ ] Report committed; all three dispositions recorded in `DESIGN.md`.

## S1 — Script substrate

May run in parallel with S0; needed regardless of its outcome.

### Scope

1. **The script contract**, designed first, landed with its implementation
   in `docs/contracts/scripts.md` (or an `engine.md` section if it stays
   small): plain Node ESM, zero-dependency, default-exported async entry
   receiving `{ client, check, params }` (final shape is this phase's first
   decision; the agent-suite's `lib/api.mjs` + `lib/expect.mjs` is the
   working draft). Versioned from day one — humans edit these files.
2. **The injected client** (N7): base-URL-bound with egress-guard semantics
   (same-origin default, explicit allowlist), HAR 1.2 recording (seed:
   `har-proxy.mjs`), wire-enforced request budget, read-only mode
   (non-GET/HEAD refused at the client), secret injection from
   `PLAYTEST_SECRET_<NAME>` references such that the script can cause an
   authenticated request but never read the value.
3. **The runner:** subprocess, timeout, exactly three outputs — `har.json`
   (run-local, sensitive, untracked), the **script report** (per-check
   name, pass/fail, machine evidence keyed into the HAR, plus a
   script-defect channel distinct from check failures — N5 depends on the
   distinction), exit status. Verdict per N10: gate over HAR ∧ report
   clean. `DummyConfigError` for config/user-input failures.
   The report contract includes the **coverage-obligation manifest** (N5):
   obligation ids derived mechanically from the handout — approved rules ×
   applicability, the Level 0 policy set, operation coverage — every
   report entry tracing to one, every obligation covered, skipped with an
   approved reason, or marked unsupported. A suite leaving an obligation
   unaccounted is unsound regardless of how many checks it ran.
4. **The mechanical risk profiler** (DESIGN §5 item 5): from the static
   script and a recorded HAR, with no model — method histogram, endpoint
   and resource list, mutation classification (reads / writes / deletes),
   data created, secret-reference usage, out-of-origin attempts, request
   count. One module, consumed later by both the script page and the CLI.
5. **Leak scan on script save** (P2 machinery): a literal credential or
   redaction-list value in script text blocks before review.
6. **The hosted boundary as a contract with escape tests** (N8): hosted
   execution puts credentials in a separate secret-bearing proxy process;
   the script process holds no credential and is network-isolated except
   through that proxy. S1 ships the adversarial battery as acceptance
   tests of that contract: ambient `fetch`, `node:http`/`node:net`,
   alternate-origin/DNS access, `process.env` reads, filesystem escape,
   `child_process`, direct report fabrication, and credential
   exfiltration attempts via URLs, bodies, logs, and thrown exceptions.
   Locally the documented trust model stands — the client guards
   accident, review guards malice — stated plainly in the contract.
7. **Client mode default:** read-only unless the run's configuration
   carries the target's write grant (DESIGN §4 step 2); the flag flows
   from authorization, never from the script.
8. **HAR lifecycle policy**, one precise answer in the contract:
   known-secret scrub at write time (P2), body-size caps, declared
   retention/expiry, and which evidence survives payload deletion — check
   reports keep their obligation trace and cited entry metadata; raw
   bodies go.

### Contract impact

New `docs/contracts/scripts.md` (entry contract, client API, report schema,
runner semantics, enforcement tiers, risk-profile fields);
`docs/contracts/artifacts.md` (the script artifact bundle).

### Exit gate

Landed 2026-07-26. `docs/contracts/scripts.md` is the contract; the substrate is
`src/core/api-suite-scripts/` behind `src/core/public/api-suite-scripts.ts`.

- [x] A cross-origin request through the client is refused with no network
      I/O leaving the process (instrumented); an allow-listed origin
      passes; read-only mode refuses a POST; the budget stops execution at
      N requests at the wire (tests).
      — `tests/core/integration/script-client.test.ts`
- [x] A script driving the ledger fixture with a secret reference
      authenticates while the credential value is absent from
      script-visible state, the report, and every persisted artifact
      (grep-proof, P2 pattern).
      — `script-client.test.js` (loopback fixture that echoes its own
      Authorization header); the ledger fixture itself runs it in
      `studies/api-suite/substrate-parity/`
- [x] Script defects and check failures land in distinct report channels;
      a thrown script error cannot masquerade as a passing or failing
      check (tests).
      — `tests/core/integration/script-runner.test.ts`
- [x] A deliberately undersized suite — an obligation neither covered nor
      skipped-with-approved-reason — fails soundness no matter how many
      checks it ran; every report entry traces to an obligation id
      (tests).
      — `script-runner.test.js`, `tests/core/unit/script-obligations.test.ts`
- [x] The hosted-boundary escape battery passes: each adversarial attempt
      is blocked or provably credential-free, and report fabrication is
      detected (tests against the boundary contract).
— `src/platform/runner-agent/tests/unit/script-boundary.test.ts`
- [x] With no write grant in run config, the client refuses mutation; the
      grant cannot be set from script code (tests).
      — `script-client.test.js`
- [x] The P1 agent-suite scenarios, ported to the contract shape, run
      through the runner and the bench scores their HAR identically to the
      P1 result — the substrate does not distort the instrument.
      — `studies/api-suite/substrate-parity/RESULTS.md`: 285 requests per
      build, same oracle per fault, zero false positives, parity MATCH on
      all five labelled builds
- [x] The risk profiler classifies a read-only script and a mutating
      script correctly, lists endpoints, counts created resources, and
      flags a seeded out-of-origin attempt — no model call (tests).
      — `tests/core/unit/script-profile.test.ts`
- [x] Root gates stay green; everything in-process/loopback.

## S2 — Authoring *(starts only after S0 records proceed)*

### Scope

1. **Spec provisioning** (DESIGN §4 step 1): environment/suite config takes
   a spec URL, an uploaded/pasted document, or triggers auto-discovery at
   the conventional paths; resolution goes through P3's enrichment with its
   existing hermetic boundary rules. A missing or unresolvable spec is an
   actionable config error (`DummyConfigError` locally; the hosted
   equivalent per `ServerConfigError` conventions), never a degraded mode.
2. **The handout generator:** enriched spec + approved rule statements with
   their card notes (from S3; hand-written statements until then) + client
   docs + the authoring brief (maintained from `agent-suite/BRIEF.md`).
3. **The retry loop** (N4): on the existing model gateway, using the
   configured actor model; prompt(handout + current draft + last report) →
   full revised script → S1 runner → repeat. Budgets: iterations, wall
   clock, total requests — preregistered values from S0 productized.
   Termination on **soundness** (N5): no script defects, within budget,
   every check exercised, and **every obligation in the manifest accounted
   for** — the handout carries the obligation list, and the loop's job is
   to cover it, not to write "enough" checks. Failing checks are
   re-verified against the HAR and kept as findings; a check may be
   revised only with a transcript-recorded justification citing the spec
   or an approved rule. Transcript persisted.
4. **The artifact bundle** (N1): script + transcript + final HAR + final
   report, versioned.
5. **Authoring-time execution license:** the loop refuses to start without
   the target authorization (DESIGN §4 step 2) recorded for the exact
   resolved origin; an origin change invalidates it.
6. **Findings surfacing:** sound-but-failing checks presented as findings
   with evidence at the end of the job, ready for S4's approval screen (and
   printed by the CLI meanwhile).

### Contract impact

`docs/contracts/scripts.md` (handout, loop semantics, budgets, soundness,
bundle); config schema (spec provisioning, target authorization);
`docs/contracts/hosted.md` (the authoring job type in dispatch).

### Exit gate

Landed 2026-07-26. The loop is `src/core/api-suite-scripts/authoring.ts` behind
`src/core/public/api-suite-scripts.ts`; the hermetic subject is
`tests/fixtures/authoring-api/` (a widget registry with a seeded semantic fault
the HAR column cannot see), driven by the scripted gateway in
`tests/support/scripted-model.ts`.

- [x] End-to-end on the fixture: from spec + statements alone, the loop
      produces a sound suite — all obligations accounted for — that
      detects a seeded development fault, and the transcript shows every
      check revision carried a citing justification.
      — `tests/core/integration/script-authoring.test.ts`: 13/13 obligations
      covered, exit 1, one evidence-backed finding, one revision citing the
      spec
- [x] Against a fixture build with a fault enabled, the loop terminates
      sound with the genuine violation kept as an evidence-backed finding —
      not revised away (test with a scripted/stub model driving the loop;
      hermetic).
      — same file: a draft that widens the failing check without a citing
      justification is rejected and reverted, and the finding survives
- [x] The loop refuses to start without target authorization or when the
      resolved origin differs from the authorized one (tests).
      — same file, plus `tests/cli/script.test.ts`; no model call and no
      request reaches the target in either case
- [x] The bundle replays through S1 on a fresh fixture instance with
      identical verdicts.
      — same file: identical exit code, failing checks, per-check verdicts,
      gate column, and obligation summary; a tampered bundle is refused
- [x] Spec auto-discovery finds a served spec; an unexposed spec falls back
      to configured URL/upload; neither path silently degrades (tests).
      — `tests/core/integration/script-spec-source.test.ts`: conventional
      path, spec link header, configured URL, upload, paste, and an
      actionable `DummyConfigError` when nothing resolves

## S3 — Invariant levels and rule cards

Level 0 wiring has no S0 dependency and may land early. The proposal call
is **gated by S0's proposal-quality trial** (N6): it ships as the
zero-input headline experience only if that trial cleared its
preregistered bar on recall and precision; otherwise it ships as assisted
authoring — same cards, narrowed copy ("review and confirm your API's
rules"), no zero-knowledge claim.

### Scope

1. **Level 0:** Tier-1/2 spec-derived checks (P4 policies) on by default
   for script suites — documented statuses, response schemas,
   error-envelope consistency, idempotency, pagination, round-trip — so a
   user who answers nothing still gets a real suite.
2. **Level 1 — the proposal call**, on the shipped authoring assistant:
   input = enriched spec (+ optionally a read-only observation pass through
   the client); output = 5–8 candidate rules as plain-language cards, each
   with one-line provenance ("proposed from: POST /transfers · status
   enum"). Prompt informed by S0's proposal-quality trial; the Level 1
   disposition recorded in S0's report decides the shipped copy.
3. **The cards UX:** approve / deny / edit / add-your-own / per-card notes.
   Approved sentences + notes flow into the S2 handout. Denied cards are
   remembered (not re-proposed). Governance enforced structurally: only
   human-approved sentences reach the handout or any gate (N6).
4. **Statement storage:** rule statements, card states, provenance, and
   notes persisted with the suite in the control plane; the
   `INVARIANTS.md` handout shape is the serialization.

### Contract impact

`docs/contracts/hosted.md` (proposal call, card states, statement storage);
`docs/contracts/scripts.md` (handout composition).

### Exit gate

Landed 2026-07-26 as **assisted authoring** (S0's recorded disposition). The
engine owns the card shape, the shared proposal prompt and forced-tool schema, the
optional read-only observation pass, and `approvedCardRules` — the one function
that turns a card into a handout rule. The hosted side owns the `rule_cards`
table (migration `0012`), the assistant's proposal call, and
`/p/:key/suites/:slug/rules`.

- [x] A suite with zero approved cards still authors a Level 0 suite whose
      checks are exercised against the fixture.
      — `tests/core/integration/script-cards.test.ts`: `rules: []` authors sound
      against the widget fixture with the seeded fault live; all four Level 0
      policies applicable and passing, 12 of 12 obligations covered, and the
      semantic fault missed — the floor's honest limit, asserted
- [x] A denied or never-approved candidate rule provably cannot reach the
      handout or influence any verdict (test).
      — `tests/core/unit/script-proposals.test.ts` (no handout file, no `rule:`
      obligation) and the `GOVERNANCE` case in
      `src/platform/control-plane/tests/integration/rule-cards.test.ts` (the
      real table through the real endpoints, plus a re-proposal of a denied rule
      being dropped)
- [x] Card notes appear in the handout and are visible in the authoring
      transcript.
      — `script-cards.test.js`: **Owner's note** in `INVARIANTS.md` and
      `handout.statements` in `authoring-transcript.json`
- [x] Proposal output renders as cards with provenance; add-your-own
      produces a statement in the same shape.
      — `src/platform/control-plane/tests/unit/web-rule-cards.test.ts`
      (`provenanceLine`, `cardPayload`/`formFromCard` round trip) and the
      integration test's add-your-own case

The copy is governed by the disposition and pinned by
`web-rule-cards.test.ts`: "review and confirm your API's rules", no
zero-knowledge claim, and the cost of a wrong approval stated where the person
decides.

**Deviation recorded.** The hosted proposal call takes the OpenAPI document as
an upload or a paste; it does not fetch a spec URL and does not auto-discover.
Reaching a user's target belongs behind the runner-agent boundary, and hosted
spec provisioning from environment configuration is S4's. The observation pass
therefore ships as a tested engine capability (`observeApi`) that the CLI and
S4's authoring job can drive, and the hosted proposal call accepts its digest;
the console does not yet initiate one.

## S4 — Hosted lifecycle and CLI parity

### Scope

1. **The script artifact + approval lifecycle** (N9): versions, sha256
   fingerprints, approval records (approver, timestamp, review reference),
   states pending / approved / rejected — instantiating the existing
   review pattern (healed baselines, findings). Any edit — direct in the
   page or assistant-applied — invalidates to pending. Replay dispatch
   refuses unapproved versions.
2. **The script page:** source, diff since last approval, mechanical risk
   panel (S1 profiler), findings from authoring, run history, approve /
   reject, ask-for-review (assistant narrative, rendered as advisory and
   demonstrably outside every verdict path — N2), edit affordances.
   Live-updates via the feed; no polling; repaints preserve focus.
3. **Replay integration:** approved scripts run via dispatch on
   build/schedule; verdicts land in the existing run artifact shapes so
   runs/findings pages consume them (placement decided here with the
   hosted IA); evidence links resolve into HAR entries, reusing P7's
   step-linked pattern in the viewer.
4. **Drift-as-revision** (N11): failed replay → P4 triage; contract drift →
   proposed revision + drift report as a pending version on the script
   page (diff + narrative); regression → red, loudly, no revision proposed
   as a "fix". Open point resolved here: a pending revision validates
   against a disposable environment when the target authorization covers
   one, else it is approved-then-run.
5. **Test-data lifecycle** (DESIGN §6): created identifiers are
   run-namespaced (collision-proof across concurrent runs); cleanup policy
   declared per target — harness-owned reset where the authorization
   includes one, otherwise best-effort teardown plus an accumulation cap
   that fails the run loudly; a failed cleanup is reported, never silent.
   Dispatch enforces the read-only default: a mutating suite is refused
   against a target whose write grant is absent or expired. Scoped
   authorization (method/path scope, tenant scope, expiry, caps) is
   recorded as a roadmap seam, not built here.
6. **CLI parity** (DESIGN §8): `playtest script run` and
   `playtest script review`; fingerprint recorded beside the script;
   approval is the team's code review — no CLI approval framework.

### Contract impact

`docs/contracts/hosted.md` and `interfaces.md` (script page, approval
actions, review request, revision flow), `artifacts.md` (versions,
approval records, pending revisions), `scripts.md` (replay semantics), CLI
docs.

### Exit gate

- [ ] An unapproved or edited-since-approval script cannot be dispatched;
      a one-byte change invalidates; re-approval requires the current
      fingerprint (tests).
- [ ] End-to-end on the fixture: approve → scheduled replay green →
      introduce a contract change → red, triaged as drift → revision +
      drift report pending → approved in the page → green; the pending
      revision provably never executed against the target before approval
      (test).
- [ ] A seeded regression fault stays red with no revision proposed
      (test).
- [ ] A mutating suite is refused at dispatch against a target without a
      live write grant; created resources carry the run namespace; a
      simulated cleanup failure surfaces in the run result (tests).
- [ ] Verdicts are byte-identical with the narrative review absent (test);
      the risk panel renders from the profiler with no model call.
- [ ] Script page meets the console's existing keyboard/focus standards;
      updates arrive via the feed.

## S5 — Stakeholder pilot (maintainer-run)

Supersedes the old P5; its two-verdict discipline carries over with the
semantic verdict re-targeted at the authored suite. Honest scope: **one
stakeholder API is a pilot** — it validates feasibility and exposes UX
failures; it cannot validate the general product thesis. Run it on two or
three heterogeneous APIs if the opportunity exists; with one, the report
says "pilot" and claims accordingly. The old materials were folded here
when deleted; their substance:

### Scope

1. **Rule cards are the invariant interview.** The API owner works the
   cards — approving, denying, editing, adding — rather than being
   interviewed freeform; the declared-exceptions instinct still applies
   ("closure is a soft delete" is what prevents a false positive), and the
   notes field is where it lands. Record who decided each card and **time
   it** — authoring cost is part of the bar and the number most easily
   forgotten.
2. **Authoring from the handout alone** under S2's isolation; the target is
   staging or a disposable tenant with the owner's written authorization
   (DESIGN §4 step 2). If the environment cannot absorb mutation, scope
   down to the regression verdict and record that the suite verdict could
   not run.
3. **Freeze + preregister:** instrument pins (client/runner/loop versions,
   prompts, proposal prompt), thresholds informed by S0's numbers (that is
   legitimate; setting them after seeing the trial is not), freeze SHA
   recorded before the first trial run. Instrument changes the trial
   motivates come after the report, clearly separated.
4. **Two verdicts:**
   - *Regression verdict* (Stage 2 on trial): a journey suite of ≥3 real
     flows records and re-acts green twice with zero heals — and more than
     twice where schedule allows, since two green runs bound flakiness
     poorly; **one owner-designed controlled change**, preregistered and
     deployed to staging by the owner, is triaged with an accurate drift
     report (naturally occurring changes are recorded separately as bonus
     evidence — do not bet the verdict on one happening in the window);
     grep-proof secret hygiene with real credentials; no vacuous-gate
     heal.
   - *Suite verdict:* the authored suite exercises every owner-approved
     rule (all-not-exercised is an instrument failure, not an API pass);
     zero unresolved false positives — every reported violation reproduced
     by hand before the owner sees it; at least one finding the journey
     suite did not produce (a violation, or a substantiated "covered this
     space, holds"); authoring cost recorded honestly, card time included.
5. **Total cost of ownership**, measured across the pilot window — not
   just authoring and replay time: rule-card time, script-review time,
   false-positive triage, drift-revision effort, cleanup, and model cost.
   If the loop is cheap but the reviews are not, the report says so.
6. Pilot report with both verdicts against the preregistered bar;
   conclusions folded into `DESIGN.md`.

### Contract impact

None.

### Exit gate

- [ ] Freeze SHA and thresholds recorded before the first trial run.
- [ ] Pilot report committed with both verdicts and the TCO table
      computed against the preregistered bar; `DESIGN.md` updated with
      conclusions.
