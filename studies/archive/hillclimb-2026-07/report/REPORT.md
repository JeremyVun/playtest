# Can an AI user-tester hill-climb a broken app to seamless — and can it become a release oracle?

*Playtest hill-climb evidence study (M1.5) — the single synthesized report. One
deliberately broken storefront, 26 seeded faults, two fix strategies, bets placed before
the data existed. This report merges the primary analysis, the two independent gpt-5.6-sol
reads (a general second opinion and a trajectory-grounded blindness analysis), and the
practitioner questions that followed. Every number traces to the archived
`../ledger/`; the pre-registration is [`../PREREGISTRATION.md`](../PREREGISTRATION.md)
(sha `1989ad9`). Primary analysis authored on Opus 4.8; fact-checked and challenged by an
independent gpt-5.6-sol pass (which caught a real error, corrected here).*

---

## 1. Executive summary

We pointed an AI user-tester at a deliberately broken storefront and let an automated fix
loop climb it to two consecutive clean rounds — twice, from an identical baseline, under a
brute-force "fix everything" strategy and a disciplined evidence-gated one. Three things are
true at once:

- **Hill-climbing works as a mechanism.** In two single runs — one per fix strategy — the loop
  drove the app to a stable two-clean-round fixed point (the naive arm regressed mid-climb before
  recovering; the disciplined arm did not), with a git-provable chain of custody. This is one
  realization of each of two bundled strategies, not a replicated experiment.
- **The summit is "clean under this suite", not "seamless".** Detection recall topped out at
  **~54%** (14 of 26 faults ever surfaced), well short of the pre-registered 75% bet. Both
  finished apps still contained known seeded faults: **6 in policy and 10 in naive** (naive's
  9 missed faults plus 1 detected-but-accepted residual). A real user would still hit bugs — on
  the edges, not the core journey.
- **The blindness is mostly diagnosable as fixable.** Of the 12 faults no tester surfaced, only
  ~1 is a structural ceiling (a plausible-but-wrong value with no ground truth); the rest are
  coverage (8) and actor-recognition (3) gaps that deterministic story authoring, contract
  oracles, and an adversarial testing mode should target. "Release oracle" looks reachable for the
  encoded surface — but note that fix is *diagnosed from the trajectories here, not yet
  demonstrated*.

**Four of the five pre-registered bets lost.** H1–H4 are all refuted *as registered* (H2 outright;
H1/H3/H4 were conjunctive and their load-bearing conjunct failed), and H5 is inconclusive. Per the
pre-registration's own rule, we report the lost bets as loudly as any win — they are the map of
where an AI user-tester's blind spots actually are, which is the study's real payload.

**Usefulness, on a 0–100 scale: ~65 overall** — but the number is meaningless without the job
it's hired for. **As an exploratory scout / regression-loop driver: ~75.** **As a standalone
"is my app good enough to ship?" oracle today: ~35.** Both the primary analysis and the
independent read converged on the same phrase from opposite directions: *a useful scout, not
a release oracle.*

The single most important structural result: the disciplined fix policy introduced **zero
fix-induced regressions across the whole climb, versus 11 for the brute-force arm.** The loop
is not just useful — it is *safely* useful when you gate fixes on evidence and pin a
regression per fix.

**Investment decision — BUILD, with a narrower target.** Here “build” means continue investing
in Playtest; “buy” means replace it with an off-the-shelf alternative; “hold” means keep using it
but freeze development; and “sell” means stop using it. The evidence supports build because the
policy loop removed 20 of 26 known faults without introducing a regression, and 11 of the 12
detection misses map to testable coverage or recognition interventions. It does **not** support
buy (no alternatives were compared), hold (the measured gaps have actionable interventions), or
sell (the current scout and repair-loop value is real). This is a targeted build decision, not a
case for larger models or autonomous release approval.

---

## 2. What was tested

`Playtest` role-plays a user: an LLM **actor** drives a real browser toward a persona's goal,
and an LLM **grader** reads the trajectory and scores whether the app let the journey succeed.
This study wraps that instrument in a closed fix loop and asks how far it can climb.

The subject, "Fern & Fog", is a zero-dependency plant storefront with a frozen `SPEC.md`. A
discovery shakedown on its clean form found and fixed one real reference defect, and the next
calibration round came back clean under that suite (a reasonable seamlessness bar, not an
exhaustive proof — the same coverage limits in §7 apply). We injected **26 catalogued faults**
across four levels:

| Level | Kind | Examples |
|---|---|---|
| **L1** | surface (copy, contrast) | faint price text; "In stock" on an out-of-stock item; empty cart shows "Cart collection returned 0 rows" |
| **L2** | interaction (dead controls, no receipt, bad validation) | Add-to-cart updates nothing; sort wired to nothing; postcode validator rejects the shop's own postcode |
| **L3** | flow (lost input, misrouted links, edge cases) | a validation trip wipes the card fields; "Clear search" reloads the same failed search; can't buy the last unit |
| **L4** | absence (capability / navigation removed) | search box gone; order history gone; cart quantity editing gone |

Three faults are deliberately *masked* (reachable only after another fault is fixed), so the
baseline has 23 reachable faults, all 26 reachable by end of climb. Every fault has a
red-on-broken / green-on-clean manifestation test proving it is live.

Two arms climbed from the **identical** broken baseline, run on the subscription gateway with a
`gpt-5.4-mini` actor and `gpt-5.5` grader, **vision enabled**, plus an axe accessibility scan:

- **Arm A — "naive":** a blind fixer reads the findings report and fixes everything it
  plausibly can. Run-everything loop.
- **Arm B — "policy":** a blind operator applies a frozen six-point discipline (see §5).

Both fixers are **blind** — never the fault catalog, tests, or study docs; only the findings
report and the app's own `SPEC.md`. The catalog-aware lead stays mechanical and adjudicates.
Stop rule: **two consecutive clean rounds.**

### How the experiment was executed

1. **Calibrate the instrument on the clean reference.** Five shakedown runs tested whether the
   stories produced false alarms on a good app. They found one real reference defect; it was
   fixed, and the next calibration round was clean. This prevents dirty ground truth from being
   mistaken for injected-fault detection.
2. **Freeze stories before creating faults.** Eight stories were authored only from `SPEC.md`
   and assigned to the personas relevant to each journey, producing **15 story–persona cells** per
   full round. The stories and personas were committed before `faults.json`; git history is the
   control against writing tests that already know the answers.
3. **Inject and verify the challenge.** The injector created identical broken copies for the
   naive and policy arms. Manifestation tests proved every one of the 26 mutations was red in the
   broken copy and green in the reference. Three faults were initially masked behind another
   removed capability, leaving 23 reachable at baseline.
4. **Measure the broken baseline twice.** All 15 cells ran in two rounds: **30 browser runs,
   377 raw findings, and 13 distinct seeded faults detected**. The actor drove the app; the grader
   reviewed each trajectory; the catalog-aware adjudicator mapped findings to known faults,
   duplicates, false positives, and new issues. The two rounds estimate repeatability, not 30
   independent users.
5. **Repair two separate copies.** The naive fixer applied broad plausible fixes from the report.
   The policy operator deduplicated issue classes, probed ambiguity, pinned a regression story per
   fix, rotated personas toward marginal coverage, and gated changes on evidence. Neither could see
   the catalog or manifestation tests.
6. **Rerun focused journeys until the stop rule.** The naive climb used **60 ledgered runs** and
   the policy climb **61**. Each round combined stories covering prior findings with the growing
   pinned regression suite. Both executed three rounds; only the naive arm introduced emergent
   breakage during the climb.
7. **Account for every seeded fault.** A final catalog-aware pass separated detected-and-fixed,
   fixed-without-detection, detected-but-accepted, and missed faults. Across shakedown, baseline,
   and both arms, the committed ledgers contain **156 runs and $40.99 of actor/grader cost**.
   Fixer/operator reasoning time is not included.

Key terms: a **finding** is one reported observation and may be duplicate or wrong; a **fault** is
one known injected bug; **detection recall** asks whether the tester named the fault; **resolution**
asks whether the fault was removed by any route; an **oracle** is an independent source of exact
truth; and a **clean round** means this exercised suite produced no registered blocking finding
with regressions green — not that the whole app is correct.

### The policy climb, as an experiment record

The sequence below is the observed run, not the analysis derived from it. The HTML report's
[state-by-state record](index.html#results) adds the screenshots and a step-level checkout example.

| State / transition | What actually happened | Resulting app state | Primary evidence |
|---|---|---|---|
| **S0 — injected app** | The injector copied the clean subject and inserted 26 catalogued faults. Manifestation tests proved every mutation was present; 23 faults were reachable and 3 were masked. | 0/26 removed. Both arms started from this state. | [Fault catalog](../faults.json); [manifestation tests](../tests/manifestation.test.js); [SPEC](../subject/SPEC.md) |
| **R0 — broken baseline** | The same 15 story–persona cells ran twice: 30 runs, 192 + 185 findings, 13 distinct seeded faults named. | The app was unchanged. Findings plus the SPEC became the blind repair input. | [Baseline ledger 1](../ledger/baseline/round-01.json); [baseline ledger 2](../ledger/baseline/round-02.json); [human-readable round](rounds/baseline-01.html) |
| **S1 — first policy repair** | Commit `6e75923` applied 16 repair packages that removed 17 seeded faults and attached a regression story to every fix entry. Probe-led commit `564bac8` also preserved catalog state across a product round trip. | 17/26 seeded faults removed; the repaired capabilities made the three masked states reachable. | [Accepted-fix record](../arms/policy-workspace/fixes-r1.json); [verification plan](../arms/policy-workspace/PLAN-r1.md); [regression suite](../arms/policy-regression/playtest.yaml) |
| **R1 — first verification** | Nineteen verification cells and two probes produced 213 findings. The repairs held, but the newly reachable empty cart said `Cart collection returned 0 rows.` | Round not clean; `f-empty-cart-jargon` returned to the operator. | [Policy ledger 1](../ledger/policy/round-01.json); [round with screenshots](rounds/policy-01.html); [unmasking story](../arms/policy-regression/stories/empty-cart-and-back-link.yaml) |
| **S2 — class repair** | Commit `c3fd1d1` fixed the reported empty-cart copy. Inspecting the same implementation-speak class also found and fixed two unreported faults: no-results jargon and a clear-search self-loop. | 20/26 seeded faults removed. One detected fault produced three removals. | [Policy ledger 2](../ledger/policy/round-02.json); [three-obligation regression](../arms/policy-regression/stories/empty-states-are-warm.yaml) |
| **R2 / R3 — confirmation** | The unchanged app hash `3061d6de…` produced 201 then 203 findings. Adjudication found no in-scope true positive and no emergent regression in either round. | Stop rule met: two clean rounds, 20 faults removed, 6 known faults still live. | [Policy ledger 2](../ledger/policy/round-02.json); [policy ledger 3](../ledger/policy/round-03.json); [final 26-fault accounting](index.html#ledger) |

The **naive branch** shared S0 and R0, then diverged. Commit `22ce8b9` removed 16 seeded
faults, but its first 18-run verification produced 11 emergent regression observations: eight
from a short-lived cart toast, two from silent checkout no-ops, and one from stale validation
feedback. The ledger's raw `clean_round` flag was nevertheless true because the stop rule did not
count emergent regressions—an observed flaw in the gate, not evidence that the regressions were
absent. Commit `6755871` repaired those three classes; two later rounds were clean under the suite.
The final naive app still contained 10 known faults: nine missed and one detected-but-accepted.
Sources: [naive round 1](../ledger/naive/round-01.json),
[round 2](../ledger/naive/round-02.json), and [round 3](../ledger/naive/round-03.json).

One baseline run makes the abstraction concrete. In
[`checkout-hiccup@cautious-first-timer`](../suite/checkout-hiccup.yaml), run
`2026-07-10T1415-934f`, the actor completed 19 browser steps. A valid four-digit postcode was
rejected and the payment fields were erased ([step 10 screen](assets/2026-07-10T1415-934f-checkout-hiccup@cautious-first-timer-010.png)).
After padding the postcode and re-entering payment, the declining card left the same checkout
page visible with no error and an active submit button ([step 16 screen](assets/2026-07-10T1415-934f-checkout-hiccup@cautious-first-timer-016.png)); the actor submitted again before
switching cards. The goal eventually succeeded with backup card and order `FF-1053`, but the
grader separately reported the lost input, silent decline, and duplicate-attempt uncertainty.
After repair, the equivalent policy run showed “Your card was declined. No charge was made” while
retaining the other fields ([policy step 11](assets/2026-07-11T1249-5bf8-checkout-hiccup@cautious-first-timer-011.png)). The exact pinned contract is
[`checkout-recovery.yaml`](../arms/policy-regression/stories/checkout-recovery.yaml).

---

## 3. The five bets, called

The pre-registration fixed five hypotheses before any data existed, with the rule that *a lost
bet is reported as loudly as a won one.*

### H1 — "It converges." — **REFUTED as registered** (converged, but the 75%-found conjunct failed).

> *"…two consecutive clean rounds within budget, finding at least three-quarters of the seeded
> faults, every residual accounted for by name."*

H1 is a conjunctive bet. Two of its conjuncts held — both arms converged, and every residual is
named (§4) — but the load-bearing one failed: testers surfaced only **14 of 26 faults (54%)** as
true positives (recall against the 23 baseline-reachable faults was **57%**). Three-quarters was
not close, so *as registered* H1 is refuted. The reason is the study's core insight: **the loop
resolves far more than it detects** — the naive arm *fixed* 16/26, the policy arm 20/26 — because
the fixers resolve faults through static reasoning (class generalization *and* adjacent code
inspection), not because testers saw them. Detection is the weak axis; fixer inspection is the
strong one.

### H2 — "The scale gradient." — **REFUTED, and inverted — the most useful finding.**

> *"…L1/L2 more reliably than L3, which beat L4… testers should be better at seeing breakage
> than absence."*

| Level | Predicted | Observed recall |
|---|---|---|
| L1 surface | high | 60% (3/5) |
| L2 interaction | high | 62% (5/8) |
| **L4 absence** | **lowest** | **80% (4/5) — highest** |
| **L3 flow** | middle | **20% (1/5) — lowest** |

The predicted order was L1/L2 > L3 > L4; the observed order is **L4 > L2 ≈ L1 > L3**. A
goal-directed actor is *excellent* at noticing a capability it expects is missing (no search
box, no order history) and *poor* at flow defects — a link to the wrong place, a receipt with a
wrong date — which require noticing a second-order wrongness while the journey still completes.
**An agentic tester is a strong absence-detector and a weak flow-detector.**

The trajectory read sharpens *why*, and it is not really about level: **goal-cued absence is
easy, uncued transitions are hard.** Three of the four detected L4 faults were capabilities
central to an explicit goal (you can't miss that search is gone when your task is to search); the
one *missed* L4 (`f-cart-continue-removed`) was an optional, routable convenience link the goal
never depended on. Level labels don't predict detection — *whether the persona's goal forces the
actor through the exact broken state* does. That reframing is what drives §7.

### H3 — "The panel beats its best member." — **REFUTED as registered** (diversity helps; the precision-filter conjunct failed).

> *"A diverse persona panel finds faults no single persona finds, by a margin worth its cost —
> and when several personas independently converge… it's almost always real, making convergence
> an automatic precision filter."*

H3 bundled two claims. The first is partly supported: the four-persona panel found **14 distinct
faults** vs the best single persona's **10** (a 40% lift), and **3 faults were each found by
exactly one persona** — so diversity does add coverage. But the panel is **over-provisioned**: a
*two*-persona set (cautious-first-timer + weekend-browser) already reached 13 of 14, so "worth its
cost" is doubtful for the full four. And the second claim — convergence as an automatic precision
filter — **fails**: the dominant false positives converge just as hard ("the cart badge is small"
from every persona), so multi-persona agreement is a de-flake filter, not a truth oracle. As
registered, H3 is refuted; run three personas, not four, and don't trust convergence as truth.

### H4 — "Orchestration beats brute force." — **REFUTED as registered** (its efficiency measures lost; regression safety is a separate win).

> *"…reaches clean in fewer rounds and at lower cost… wasting fewer fixes on false positives."*

Each of H4's three registered measures went against it or was not its measure:
- **Fewer rounds: no.** Both arms took three executed rounds with the same shape — *two*
  fix-bearing rounds (initial fixes, then a repair/second-fix round) followed by one no-fix
  confirmation round. (The raw metric shows naive=2, policy=3, an artifact of the stop rule's
  blind spot to fix-induced regressions; see §9.)
- **Lower cost: no.** Near-identical *ledgered actor/grader run* cost: **naive $12.24 over 60
  runs, policy $12.76 over 61** — policy 4% *more* expensive. (This is run cost only; fixer/operator
  model work, probe authoring, and belief-table reasoning are not in the manifests, so total
  strategy cost is unknown and would widen the gap against policy.)
- **"Wasting fewer fixes on false positives": not measured.** Neither arm's FP-targeted fix
  count was computed, so the registered waste metric is untested — and both arms did discretionary
  work anyway (naive skipped four report themes; policy made the above-clean unseeded B17 change).

So H4 as registered is refuted. But a genuinely important *separate* result stands: the naive
arm's round-1 fixes introduced **11 fix-induced "emergent" regressions** — **8** from a
too-short-lived "View cart" toast, **2** from a checkout submit that could still silently no-op,
**1** from a stuck validation message (three distinct defects, not one — the independent read
caught the "single toast" shorthand) — while the policy arm introduced **zero** across the whole
climb and resolved more (20/26 vs 16/26, 6 missed vs 9). **The policy's demonstrated advantage is
regression safety and resolution coverage, not the speed or cost the hypothesis bet on** — though
with one run per arm this is an association, not a causal decomposition of the six policy elements.

### H5 — "Detection is actor-limited, precision is grader-limited." — **INCONCLUSIVE (deferred).**

The whole climb ran on one tier pairing, so there is no within-study contrast to test this on,
and the tier axis was descoped for quota discipline. Recorded inconclusive. What the single tier
shows is that a cheap `gpt-5.4-mini` actor sustained the full climb — consistent with "recall
survives a cheap actor", but one point, not a gradient.

---

## 4. The fault accounting

Every seeded fault, by arm. "fixed (undetected)" = the fixer resolved it without any tester
ever surfacing it — the class-generalization effect. Full interactive table:
[accounting.html](accounting.html).

|  | Naive | Policy |
|---|---|---|
| found and fixed | 12 | 14 |
| **fixed without detection** | 4 | 6 |
| found but accepted (unfixed) | 1 | 0 |
| **missed** | **9** | **6** |
| **resolved (fixed, any route)** | **16 / 26 (62%)** | **20 / 26 (77%)** |

**Missed by both arms — the hard core, and the most valuable rows in the study:**
- `f-oos-says-in-stock` (L1): an out-of-stock product's stock line reads *"In stock — more
  arriving daily"* above a disabled "Out of stock" button. Actors noted the dead end, never the
  contradiction.
- `f-receipt-eta-wrong` (L1): a shipped order's receipt says "arrives in 3–5 days." Actors
  quoted the wrong ETA verbatim as if correct.
- `f-continue-shopping-loop` (L3): "Continue shopping" on a receipt bounces to checkout →
  empty cart. Never caught.
- `f-cart-continue-removed` (L4): the cart's continue-shopping link is gone; global nav
  substitutes, so the goal was never blocked.

The pattern in the misses is exactly H2's inverted gradient: **misleading copy and broken flows
survive, and so does absence the goal doesn't force you through** (the missed L4
`f-cart-continue-removed`) — while *goal-central* missing capabilities do not.

---

## 5. Naive vs "disciplined policy" — what the arms establish

**What a "disciplined policy" is.** Arm B's operator followed a frozen six-point discipline for
the *fixing* loop: (1) dedup findings into a **belief table** of issue-classes; (2) **probe
before fixing** anything ambiguous — spend a run to disambiguate; (3) pin a **regression story
per fix**; (4) rotate personas toward marginal yield; (5) escalate the actor tier only for
genuinely hard judgments; (6) promote proven paths to pinned journeys.

**The critical distinction: the policy fixed the *fix* side, not the *detection* side.** It
detected essentially the same faults as the naive arm (14 vs 13). What it bought was
*safe, non-regressive fixing* — 0 vs 11 emergent regressions — and probe-before-fix plus
regression-per-fix are the plausible reason (verifying each fix against a pinned journey rather
than fixing blind), though with one fixer run per arm this is an association, not a proven cause of
which policy element mattered. **Discipline is not the lever for release-oracle detection** —
coverage is (§7).

**The honest counter-weight.** The naive fire-hose blindly fixed two account faults
(`f-account-error-swallowed`, `f-account-form-resets`) that the policy arm's evidence-gating
left untouched — it had no finding pointing at them, so it left them alone, and they stayed
broken. A genuine precision/recall trade in *fixing*: disciplined fixing wastes less and breaks
less, but blind fixing occasionally hits an undetected fault by sheer coverage. If your cost of
a missed fault is high and your cost of a regression is low, brute force has a case.

---

## 6. The ratchet — do the pinned regression stories actually bite?

We re-injected a fixed fault, one each from L2/L3/L4, and ran that fault's pinned story. The
pre-registration is explicit that a single green re-injection *"falsifies the whole ratchet story"*
— so the honest headline is that **the preregistered ratchet was falsified on one of its three
cases.** Four attempts were made in total, three red and one green:

| Level | Re-injected fault | Pinned story | Outcome |
|---|---|---|---|
| **L2** | `f-add-cart-silent` | add-to-cart-feedback | **RED** — cart count stayed 0, actor re-clicked, ended with a duplicate. |
| **L3 (preregistered)** | `f-validation-wipes-payment` | checkout-recovery | **GREEN — falsifying.** The actor entered valid data and never tripped the validation error the fault depends on, so it never fired. |
| **L3 (deterministic substitute)** | `f-checkout-empty-guard-gone` | empty-cart-and-back-link | **RED** — "visiting /checkout with an empty cart bypassed the guard and showed a live payment form, no redirect." |
| **L4** | `f-order-history-removed` | account-order-history | **RED (hard case)** — actor **gave up** (score 20): "no orders list… dead-ended on those forms." |

The green result is the *more instructive* one, and it is not a footnote: a regression story
gated on a specific error path is a **probabilistic guard, not a deterministic one** — it can pass
while the fault is present if the actor doesn't happen to hit the precondition. Substituting the
deterministic `f-checkout-empty-guard-gone` story (which always forces its precondition) demonstrates
that a *deterministically-forced* story does bite at L3 — but that is a different story than the one
the ratchet registered, and it does not convert the preregistered result into a pass. The takeaway:
pin stories that *force* the exact broken transition every run, or the guard fires only some of the
time. This is the ratchet's own evidence for the coverage argument in §7.

---

## 7. Why it was blind — and the path to "release oracle"

The ~54% recall is not one failure, and — grounded in a trajectory-by-trajectory read of every
missed fault (the independent gpt-5.6-sol analysis, [blindness-analysis-gpt56sol.md](blindness-analysis-gpt56sol.md))
— the decomposition is sharper and more encouraging than "the actor isn't a good tester."
**Of the 12 faults no tester ever surfaced: 8 are coverage failures, 3 are actor-recognition
failures, 1 is a structural oracle gap.**

The load-bearing distinction: **a story naming a behavior in its report questions is not
coverage. Only an executed precondition plus an observed postcondition is coverage.** The
`checkout-recovery` story *asks* "were your card fields wiped after a validation error?" — but the
actor entered valid data, never tripped validation, and the fault never fired. Naming the check
did nothing; the state that exposes the fault was never reached.

**1. Coverage / unforced preconditions — 8 of 12 (the dominant lever).** Most misses are faults
whose triggering state+action the suite never deterministically forced, so the actor — correctly
following a happy-path story — sailed past:
- The account faults (`f-account-error-swallowed`, `f-account-form-resets`) fire only on an
  *invalid* email; the story supplied a valid one.
- `f-card-spaces-validation` rejects an *unspaced* card; the story dictated a spaced number.
- `f-cant-buy-last-unit` needs someone to add exactly the last unit; no story forced the boundary.
- `f-checkout-empty-guard-gone` needs a GET `/checkout` on an *empty* cart; every journey entered
  checkout with items. (The deterministic ratchet re-injection hit this path and went red —
  confirming it was a zero-probability path in the suite, not a perception miss.)
- `f-no-results-jargon` / `f-clear-search-self-link` need an *unmatched* query and a click on
  "Clear the search"; actors searched terms that matched.
- `f-continue-shopping-loop` needs the receipt's "Continue shopping" clicked and its destination
  checked; the story ended once the purchase was proven.

**2. Actor recognition — 3 of 12.** Here the actor *reached* the fault surface but misread it:
`f-sort-inert` (it predicted the cheapest item would move, saw the identical order, and rationalized
success anyway — a *false verification*), `f-oos-says-in-stock` (it saw both "In stock" and the
disabled "Out of stock" and never compared them), and `f-cart-continue-removed` (it normalized the
missing local link because global nav still completed the goal). These are the cases a
consistency-checking QA mode would catch.

**3. The oracle gap — 1 of 12 (the hard ceiling).** `f-receipt-eta-wrong` is a *plausible-but-wrong
value*: "arrives in 3–5 days" is believable on its face, and the actor has no status-to-copy rule
to know a *shipped* order shouldn't say that. **No amount of better acting or forcing catches
this** — it requires an external contract. And more production faults share this shape: tax,
totals, inventory, dates, entitlements, localization. This is the structural ceiling of
journey-only testing.

**Ruled out with evidence.** **Not vision** — vision + axe were active and caught both contrast
faults, and for the faults the actor actually *reached* (inert sort, the OOS contradiction, the
cart-local link, the receipt ETA) the relevant text is present verbatim in the snapshot, so the
failure there was *interpreting* visible information, not seeing it. (The other 8 misses never
reached their manifestation state at all — a coverage failure, not a vision one.) Either way,
better pixels would not have helped. **Not primarily the grader** — it was a material second line
of failure on two reached cases
(`sort`, OOS: it summarized the actor's concern instead of independently comparing co-located
claims), but no miss is grader-only, and `gpt-5.5` already had the relevant snapshots, so a higher
grader tier is not the leading bet.

**The road to "release oracle", ordered by leverage per effort (model escalation ranks *last*):**
*(Effectiveness note: the 8/3/1 diagnosis is grounded in the trajectories, but the interventions
below were not run in this study. They are targeted recommendations — expected to address the
mapped misses — not measured closure rates.)*

1. **Build a deterministic risk matrix and make it the release gate.** For every critical route,
   enumerate happy path, validation failure, retry/retention, exact boundary, empty state, and
   recovery CTA. Seed server state explicitly, and **fail a run as "not covered" if any required
   action was skipped.** This targets the 8 coverage misses directly.
2. **Add contract oracles beside the journeys.** Assert status-to-copy mappings, cart/total
   arithmetic, redirect destinations, required page-local affordances, and persisted values via
   DOM/API checks where exact truth exists. The release decision becomes **"deterministic contracts
   green AND required transitions covered AND no unresolved high-severity LLM findings"** — never an
   LLM cleanliness score alone. This is the only fix for the oracle class.
3. **Make the actor switch modes** — keep personas for realistic discovery, but add an *adversarial*
   pass (one invalid value per form; formatted/unformatted equivalents; `0/1/N/N+1` boundaries;
   retry after errors; click every terminal/recovery control) and a *semantic-audit* pass. Give it
   a checklist of *obligations*, not expected fault answers, to force coverage without leaking the
   catalog. Targets the 3 recognition misses.
4. **Make semantic comparison a first-class grader job** — independently reconcile the actor's
   stated expectation against the next snapshot, compare co-located claims and totals, and flag
   "worked" claims unsupported by a changed result. Require a structured per-obligation verdict
   (executed / observed-delta / oracle-source / pass-fail-**unknown**), where **"unknown" must not
   become green.**
5. **Change the stop and reporting semantics** — report detection recall, deterministic obligation
   coverage, assertion pass-rate, repair-by-inspection, and live residuals *separately*. "Two clean
   rounds" may stop exploration spend, but *release* requires the deterministic gate. And count
   emergent regressions in the clean definition (§9).

### Actor and grader prompt changes

Prompt improvement matters for the **3 recognition misses**, not the 8 unvisited states or the 1
missing oracle. In release mode, the actor should receive obligations rather than hints about likely
bugs. For each obligation it must: record the relevant before-state; execute the specified action;
record the after-state; identify the observed delta; and return `unknown` or `not_covered` if the
action or observation did not happen. It must not infer success from the absence of an error, treat a
click as proof of mutation, or use overall goal completion as proof that every transition worked.
Exploratory persona mode should remain separate so realistic behaviour is not replaced by checklist
execution.

The grader must independently inspect raw trajectory evidence. The actor's narrative is a claim,
not evidence. Grade each obligation separately and require a structured result such as:
`{executed, observed_delta, verdict, evidence_refs, oracle_source, contradiction, rationale}`.
Compare before/after values, URLs, totals, controls, and co-located claims; flag a claimed success
when nothing changed; and return `unknown` when exact business truth has no oracle. Separate user
experience from correctness — a frustrating pass and a pleasant-looking failure are different
results.

### Better Playtest story skills

One broad natural-language “write a story” skill should become four explicit skills:

1. **Journey discovery:** create realistic goals and persona context to find unknown friction. Its
   output is qualitative evidence, not a release gate.
2. **Risk-matrix authoring:** inspect the specification, diff, route map, incidents, and contracts;
   enumerate happy path, invalid input, retry, retention, empty state, permissions, interruption,
   recovery controls, and `0/1/N/N+1` boundaries for every changed critical surface.
3. **Deterministic regression authoring:** compile one risk into explicit fixture, precondition,
   required action, observable postcondition, oracle, and failure state. Critical actions cannot be
   optional natural language.
4. **Contract-oracle authoring:** extract exact expected redirects, calculations, status/copy
   mappings, entitlements, inventory rules, and persisted values from authoritative sources and
   implement them outside LLM judgment.

The harness should lint story contracts before running. Reject a release story with an unseeded
precondition, optional critical action, unobservable postcondition, absent oracle source, success
defined only by goal completion, or report question about a behaviour the story never forces. A
minimum compiled obligation looks like:

```yaml
obligation: checkout-empty-redirect
precondition: cart.items = 0
action: navigate("/checkout")
observe: [url, heading, payment_form]
expect: { url: "/cart", payment_form: absent }
oracle: contract.checkout.empty_redirect
if_action_skipped: NOT_COVERED
if_oracle_missing: UNKNOWN
```

### Product acceptance test for the next investment

Rerun this frozen fault instrument after implementing the coverage layer. A reasonable next gate is
**≥85% reachable seeded-fault recall, 100% execution of critical obligations, zero unknown critical
contracts, and zero emergent regressions in a clean round**. Then add a second application and repeat
each repair strategy; one subject and one strategy realization cannot establish product-level
reliability. These are proposed acceptance thresholds, not results already achieved.

The honest ceiling: even done perfectly, you get **"release-oracle for the surface you've
encoded"** — release-grade confidence on exactly the transitions and contracts you author. Use the
LLM tester to *discover* journeys and qualitative harm; put business truth and transition
correctness in deterministic assertions gated by the disciplined fix policy. The release-oracle gap
is **primarily an instrumentation and specification problem — not a vision problem, and not yet a
model-upgrade decision.**

*(§7 is the independent gpt-5.6-sol trajectory analysis, integrated. It sharpens the primary read
on two points: the dominant lever is coverage, not persona quality; and the receipt-ETA miss is not
fixable by "another forced compare journey" — forcing the receipt open already happened repeatedly —
but only by a status/content oracle. Full per-fault table with trajectory citations:
[blindness-analysis-gpt56sol.md](blindness-analysis-gpt56sol.md).)*

---

## 8. Would a real human still hit bugs?

Yes — but calibrated. **The ordinary happy-path purchase trunk was substantially repaired**
(add-to-cart, cart editing, checkout, payment, confirmation, order history all made to work — some
via tester detection, several fixed only through the fixer's code inspection). A human doing the
plain in-stock, ordinary-quantity purchase would mostly have a clean experience. **The residual
bugs live on the edges, the error paths, and the fine print:** a shipped order whose receipt
promises "arrives in 3–5 days", an out-of-stock page that claims "In stock", a "Continue shopping"
link that loops to an empty cart, a missing cart-local continuation link — and, in the policy-clean
app, a silently-dropped invalid email and an account form that resets your edits. A careful or
unlucky user, or anyone on a validation/empty/boundary path, hits them. Crucially, **"clean" is not
a statement that the journey works** — its registered meaning is only *"no blocking finding under
that round's exercised suite, with the regression suite green."* The study itself shows clean flags
coexisting with known live faults. Clean means *the suite found nothing new*, not *the app is
correct*.

---

## 9. The false-positive floor, the persona signal, and threats to validity

**False-positive floor.** On the broken baseline, precision was ~48%. On the fixed app precision
falls to ~0 simply because there are **no seeded true-positives left to find** — not because every
finding is literally false (the taxonomy still admits `new-real-issue` and `emergent` verdicts;
naive round 1 is even flagged "clean" while carrying 11 emergent). So the meaningful clean-app
metric is the absolute **adjudicated-FP floor**, stable at **~190–197 findings/round**
in four durable buckets: **visual prominence** ("the button is small" — the largest), **below the
fold**, **out-of-SPEC scope** (policy pages, comparison, quick-add), and a **harness-timing
artifact** (the actor's "View cart" toast click fails because its step latency exceeds the toast's
20-second lifetime). **Reading a clean report as clean requires pre-classifying and suppressing
these four**, or every run looks alarming.

**Persona signal.** Highest-yield: cautious-first-timer (10 faults) and weekend-browser
(unique: empty-cart, breadcrumb). returning-regular is the *only* persona that exercises order
history. gift-rusher was dead weight outside a narrow fast-click role — demote it. **Run
cautious-first-timer + weekend-browser + returning-regular as the core panel.**

**Threats to validity.**
- **The stop-rule hole.** The pre-registered "clean round" counts only true-positives +
  regression-green — it does *not* count fix-induced (emergent) regressions, so the naive arm's
  round-1 registered "clean" while carrying 11 self-inflicted regressions. We did not silently
  patch the definition (that would be post-hoc goalpost-moving); we report both readings. **Any
  future run should define clean as "zero true-positive AND zero emergent AND regression green."**
- **Three latent subject quirks.** The reference app itself carries three behaviors that look
  like defects but are present identically in the clean subject and are not seeded faults: a cart
  badge stale after browser Back (bfcache), sort resetting on the header "Shop" link (bare `/`),
  and the cart quantity input committing on blur. All drew tester complaints; none are faults.
- **Single subject, single tier, catalog-aware adjudication.** One storefront, one SPEC, one
  actor/grader pairing; the direction of findings should generalize, the exact rates should not.

---

## 10. Where Playtest belongs in the SDLC — especially with coding agents

**Playtest's highest-value position today is as the behavioural critic between deterministic CI
and human acceptance.** The practical sequence is: product intent → coding agent or developer →
unit/integration/security/contract checks → Playtest against a preview environment → human risk
review → merge and release. Coding agents can already take an issue, change a branch, and open or
update a pull request; protected branches can already require status checks before merge
([GitHub coding-agent overview](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents),
[protected-branch checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)).
Playtest can connect those established mechanisms with realistic browser evidence. It should not
replace either deterministic checks or human release authority.

The strongest near-term use is **PR-level behavioural review of a bounded change**. Map a diff to
affected surfaces, run a small risk-selected story set, attach trajectories and structured
obligation results to the PR, then let a coding agent repair only evidence-backed failures. Every
repair must add or strengthen a pinned regression and rerun both the affected journey and its
deterministic contracts. This is where the study's two positive results compound: the actor finds
journey friction that ordinary tests do not express, while the disciplined fix policy prevents the
repair agent from turning qualitative findings into unsafe broad edits.

### Can it close the build–test–repair loop?

**Mechanically, yes; evidentially, not unattended yet.** A safe build-system integration would:

1. trigger after a preview environment is healthy;
2. run deterministic build, unit, integration, security, and contract checks first;
3. select Playtest journeys from changed surfaces and risk metadata;
4. emit structured findings with evidence, severity, obligation coverage, observed delta, and
   oracle source;
5. give a branch-isolated coding agent only verified findings plus repository context;
6. require a pinned regression per repair, then rerun the narrow story and deterministic suite;
7. stop after a small retry budget, repeated failure, scope expansion, or any unknown high-risk
   obligation, and escalate to a human; and
8. publish **separate** status checks for contracts, coverage, unresolved high-severity findings,
   and emergent regressions.

The current `clean_round` flag is not suitable as that status check: this study shows it can be
green with known live faults and, under the registered definition, even with fix-induced
regressions. The CI-facing output must therefore distinguish *nothing new was found* from *required
behaviour was covered* and *exact truth was asserted*.

**Brownfield is the recommended first target.** Existing journeys, incidents, telemetry,
contracts, feature flags, and production behaviour constrain both the tester and repair agent.
Start with narrow, high-risk changes such as checkout recovery, account persistence, permissions,
or migration paths. Run Playtest as a non-blocking PR check first; promote only deterministic
obligations with measured stability into required checks.

**Greenfield hill-climbing has real potential, with a sharper circularity risk.** A product brief
can seed journeys, the coding agent can implement, and Playtest can expose missing capabilities and
poor interaction feedback while the UI remains fluid. But an agent cannot safely author the
feature, infer its own acceptance truth, test it, and approve it from the same ambiguous prompt.
Humans must own intent and risk; business contracts must be independently specified; and the loop
must stop rather than rationalise an uncovered or plausible-but-wrong result. The sensible adoption
sequence is: **brownfield PR check → feature-level repair loop → greenfield acceptance loop →
release gate only after the coverage and oracle interventions are validated.**

This placement is a product recommendation inferred from the study, not an outcome the study ran:
the experiment demonstrated a closed repair mechanism on one controlled app. It did not demonstrate
an unattended CI service, multi-repository generality, or autonomous merge safety.

---

## 11. Bottom line

**Hill-climbing works as a mechanism; the summit it reaches is "clean under the suite", not
"fault-free".** The investment decision is **BUILD**: fund the deterministic coverage, contract
oracle, adversarial-mode, and CI-packaging work needed to turn the useful mechanism into a bounded
product. As shipped, Playtest is a **~65/100** tool — a strong exploratory scout and a
*safe* automated-fix driver (~75), a weak standalone release oracle today (~35). The gap between
those two numbers is a roadmap, diagnosed here though not yet demonstrated: force coverage with a
deterministic risk matrix as the release gate, add a consistency-checking adversarial mode, and
backstop the plausible-but-wrong class with spec/contract assertions. Do that and you would be
aiming at release-oracle confidence **on the surface you encode** — which, hardened into pinned
regressions and gated by the disciplined fix policy, is the durable regression net this study was
built to evaluate. The four of five pre-registered bets that lost (H1–H4) are not a verdict against
the tool; they are the map of where an AI user-tester's blind spots actually are.

*Committed evidence: `studies/hillclimb/ledger/{baseline,naive,policy}/round-*.json`; detection
matrix [matrix.html](matrix.html); per-fault accounting [accounting.html](accounting.html).
Independent reads that fed this synthesis: [writeup-gpt56sol.md](writeup-gpt56sol.md) (general
second opinion) and the trajectory-grounded blindness analysis (§7).*
