# Can an AI user-tester hill-climb a broken shop to seamless? A pre-registered study

*Playtest hill-climb evidence study (M1.5). Two fix strategies, one deliberately broken
storefront, 26 seeded faults, bets placed before the data existed. Analysis authored on
Opus 4.8; an independent second read by gpt-5.6-sol ships alongside this
([writeup-gpt56sol.md](writeup-gpt56sol.md)). Every number here traces to a committed
ledger under `../ledger/`; the pre-registration is
[`../PREREGISTRATION.md`](../PREREGISTRATION.md) (sha `1989ad9`).*

---

## Executive summary

We took one deliberately broken storefront ("Fern & Fog", 26 seeded faults across four
severity levels), pointed an AI user-tester at it, and let an automated fix loop climb it
to two consecutive clean rounds — twice over, from an identical starting point, under two
different fix strategies. The headline results:

- **It converges, but it does not "find three-quarters of the faults."** Both arms reached
  the two-clean stop rule. But detection recall topped out around **54%** (14 of 26 faults
  ever surfaced by a tester), well short of the pre-registered 75% bet. The gap between
  *detection* and *resolution* is the story: the fixers **resolved** far more than they
  **detected**, because good fixers generalize a detected fault to its whole class.
- **The scale gradient ran backwards.** The pre-registration bet that testers see breakage
  better than absence. The opposite held: **L4 "missing capability" faults were the easiest
  to catch (80%) and L3 "flow" faults the hardest (20%)**. A goal-directed actor notices a
  missing search box instantly and sails straight past a misrouted link.
- **The disciplined policy arm's real win was not speed — it was collateral.** It reached
  clean in the same number of real rounds as the brute-force arm, but introduced **zero
  fix-induced regressions across the entire climb, versus 11 for the naive arm.** It also
  resolved more faults (20/26 vs 16/26). The catch: the naive fire-hose blindly fixed two
  account faults the disciplined arm's evidence-gating left untouched.
- **A four-persona panel beat its best single member by 40%** (14 distinct faults vs 10),
  and 3 faults were each caught by exactly one persona. Diversity paid.
- **On a fixed app, ~95% of what the tester reports is noise** — a stable floor of
  "the button is small", "it's below the fold", out-of-scope wishes, and one harness-timing
  artifact. Knowing that floor's shape is what lets you read a clean report as clean.

If you are deciding whether to trust an agentic UX tester: trust it to tell you when a
capability is **gone** or an action gives **no receipt**; do not trust it to notice a link
that goes to the wrong place, a receipt that lies about a delivery date, or copy that
contradicts a button. And budget for a fixer that resolves more than the tester sees.

---

## What was tested

`Playtest` role-plays a user: an LLM **actor** drives a real browser against a real app
pursuing a persona's goal, and an LLM **grader** scores whether the app let the journey
succeed and writes up what broke. This study wraps that instrument in a closed fix loop and
asks how far it can climb.

The subject, "Fern & Fog", is a zero-dependency plant storefront with a frozen `SPEC.md`.
Its clean form passed a discovery shakedown (the reference is genuinely seamless — that
matters, or ground truth is dirty). We then injected **26 catalogued faults** spanning four
levels:

| Level | Kind | Examples |
|---|---|---|
| **L1** | surface (copy, contrast) | price text too faint; "In stock" on an out-of-stock item; empty-cart shows "Cart collection returned 0 rows" |
| **L2** | interaction (dead controls, no receipt, bad validation) | Add-to-cart updates nothing; sort dropdown wired to nothing; postcode validator rejects the shop's own postcode |
| **L3** | flow (lost input, misrouted links, edge cases) | a validation trip wipes the card fields; "Clear search" reloads the same failed search; can't buy the last unit in stock |
| **L4** | absence (capability / navigation removed) | search box gone; order history gone; cart quantity editing gone |

Three faults are deliberately *masked* (reachable only after another fault is fixed), so the
baseline has 23 reachable faults, all 26 reachable by end of climb. Every fault has a
red-on-broken / green-on-clean manifestation test proving it is live.

Two arms climbed from the **identical** broken baseline:

- **Arm A — "naive":** a blind fixer reads the findings report and fixes everything it
  plausibly can. Run-everything loop.
- **Arm B — "policy":** a blind operator applies a frozen six-point policy — dedup findings
  into a **belief table** of issue-classes; **probe before fixing** anything ambiguous (spend
  a run to disambiguate); pin a **regression story per fix**; **rotate personas** toward
  marginal yield; **escalate the actor tier** only where a judgment is genuinely hard; and
  **promote** proven paths to pinned journeys.

Both fixers are **blind** — they never see the fault catalog, the tests, or the study docs;
they work only from the findings report and the app's own `SPEC.md`. The lead (catalog-aware)
stays mechanical and adjudicates. Both arms ran on the subscription gateway with a
`gpt-5.4-mini` actor and `gpt-5.5` grader. Stop rule: **two consecutive clean rounds.**

---

## The five bets, called

The pre-registration fixed five hypotheses before any data existed, with the explicit rule
that *a lost bet is reported as loudly as a won one.* Here is each, with the prediction
quoted against the observed number.

### H1 — "It converges." — **Split: converged, but the 75% recall bet is LOST.**

> *"The loop takes the app to two consecutive clean rounds within budget, finding at least
> three-quarters of the seeded faults, every residual accounted for by name."*

Convergence: **yes**, both arms. Every residual accounted for by name: **yes** (see the
accounting table below — all 26 faults land as fixed, accepted, or missed).

But "finding at least three-quarters": **no.** Across every round of both arms, testers
surfaced **14 of 26 faults (54%)** as true positives — 13 at baseline, plus one
(`f-empty-cart-jargon`) that only became reachable mid-climb. Detection recall against the
23 baseline-reachable faults was **57%**. Three-quarters was not close.

The honest resolution: **the loop resolved far more than it detected.** The naive arm
*fixed* 16/26 and the policy arm *fixed* 20/26 — because a competent fixer, handed one
"empty cart says 'Cart collection returned 0 rows'", greps for the same implementation-speak
and fixes the *no-results* message too, without ever being told it was broken. Detection is
the loop's weak axis; class-generalizing repair is its strong one. If you read H1 as "does
the loop *resolve* three-quarters", the policy arm clears it (77%); if you read it as "does
the tester *see* three-quarters", it is a clean miss.

### H2 — "The scale gradient." — **REFUTED, and the refutation is the most useful finding.**

> *"Recall falls as fault scope rises: surface and interaction defects (L1/L2) get caught
> more reliably than flow defects (L3), which beat missing capabilities (L4). Agentic testers
> should be better at seeing breakage than absence. If L4 recall is high, that surprise leads
> the write-up."*

It leads the write-up. Baseline recall by level:

| Level | Predicted rank | Observed recall |
|---|---|---|
| L1 surface | high | 60% (3/5 reachable) |
| L2 interaction | high | 62% (5/8) |
| **L4 absence** | **lowest** | **80% (4/5)** — highest of all |
| **L3 flow** | middle | **20% (1/5)** — lowest of all |

The predicted ordering was L1/L2 > L3 > L4. The observed ordering is **L4 > L2 ≈ L1 > L3** —
absence at the top, flow at the bottom. This inverts the core intuition. A goal-directed
actor is *excellent* at noticing that a capability it expects is simply not there: no search
box, no order history, no way to edit the cart are all glaring to something trying to
accomplish a task. What it sails straight past are **flow defects** — a "Clear search" link
that reloads the same failed search, a "Continue shopping" button that loops to an empty
cart, a receipt that quietly quotes the wrong delivery window. These require the tester to
*notice a second-order wrongness while the primary journey still completes*, and it usually
doesn't.

Practitioner takeaway: **an agentic tester is a good detector of missing features and a poor
detector of subtly-wrong flows.** Point it at "did we remove/break something" with
confidence; supplement it with assertions or human review for "does this link/message/date
actually go where it should."

### H3 — "The panel beats its best member." — **SUPPORTED.**

> *"A diverse persona panel finds faults no single persona finds, by a margin worth its cost
> — and when several personas independently converge on the same finding, it's almost always
> real, making convergence an automatic precision filter."*

The four-persona panel found **14 distinct faults**; the best single persona
(cautious-first-timer) found **10**. That is a **40% lift** for the panel, and **3 faults
were each found by exactly one persona** — drop any single persona and you lose coverage.
The margin is real: `f-order-history-removed` came only from returning-regular (the only
persona that checks past orders), `f-empty-cart-jargon` and `f-product-crumb-removed` only
from weekend-browser.

The **second half of H3 is weaker than predicted.** Convergence does flag real faults (11 of
14 were seen by ≥2 personas), but it is *not* a clean precision filter, because the dominant
false positives converge just as hard: every persona independently complains "the cart badge
is small" and "the payment button is below the fold." Multi-persona agreement separates
*signal from single-run noise*, but it does **not** separate real faults from the systemic
FP floor — those are convergent too. Treat convergence as a de-flake filter, not a
truth oracle.

*(The independent second read grades H3 "refuted as written" and makes a sharper point worth
weighing: a two-persona set — cautious-first-timer + weekend-browser — already reached 13 of
the 14 faults, so the full four-persona panel is **over-provisioned**, not the efficient frontier.
I read the same numbers as "panel beats its best single member" (14 > 10) — a genuinely different
emphasis. Both are true, and the practical instruction is the same one both write-ups reach:
run three well-chosen personas, not four. This is exactly the kind of divergence the two-POV
setup exists to surface — see [writeup-gpt56sol.md](writeup-gpt56sol.md).)*

### H4 — "Orchestration beats brute force." — **Split: efficiency claims LOST, safety claim WON.**

> *"The frozen intelligent policy reaches clean in fewer rounds and at lower cost than the
> naive run-everything loop, wasting fewer fixes on false positives."*

**Fewer rounds: not supported.** Both arms took the same real shape — one fix-bearing round,
then two clean rounds — reaching the stop rule at round 3. (The raw metric shows naive=2,
policy=3, but that is an artifact of the stop rule's blind spot to fix-induced regressions;
see "The stop-rule hole" below. On an even footing, it's 3 rounds each.)

**Wasting fewer fixes / lower collateral: strongly supported, and this is the real result.**
The naive arm's round-1 fixes introduced **11 fix-induced "emergent" regressions** —
**8** from a too-short-lived "View cart" toast, **2** from a checkout submit path that could
still silently no-op, and **1** from a validation message left stuck on screen (three distinct
fix-introduced defects, not one; the independent read below flagged the "single toast" shorthand
and it is corrected here). Clearing them took an entire extra repair pass before the arm could
go clean. The policy arm introduced **zero emergent regressions across the whole climb.** Its
*probe-before-fix* and *regression-story-per-fix* discipline is exactly what caught the
would-be regressions before they shipped — it verified each fix against a pinned journey
instead of fixing blind. Net resolution also favored policy: **20/26 faults resolved vs
16/26**, and **6 missed vs 9.**

**But the honest counter-weight:** the naive fire-hose blindly fixed two account faults
(`f-account-error-swallowed`, `f-account-form-resets`) that the policy arm's evidence-gating
declined to touch — it had no finding pointing at them, so it left them alone, and they stayed
broken. This is a genuine **precision/recall trade in *fixing*, not just detecting**:
disciplined fixing wastes less and breaks less, but blind fixing occasionally hits an
undetected fault by sheer coverage. If your cost of a missed fault is high and your cost of a
regression is low, brute force has a case.

**Cost: also not lower — refuted.** The two arms spent almost exactly the same compute
(token-estimated harness cost): **naive $12.24 over 60 runs, policy $12.76 over 61** — policy
**4% more expensive**, not cheaper. (Had the literal stop rule halted naive at round 2 it would
have looked ~50% cheaper — but only by banking a round that carried 11 real regressions as
"clean", so that saving is an artifact of the stop-rule hole, not a real efficiency.) On top of
the equal harness cost, Arm B also spends **orchestration overhead** manifests never see —
belief-table reasoning, probe authoring, two probe runs. So H4's efficiency half (fewer rounds,
lower cost) is **refuted on both counts**; its safety half (fewer wasted fixes, less collateral)
is **strongly supported**. The policy's case is regression safety and resolution coverage, not
speed or price.

### H5 — "Detection is actor-limited, precision is grader-limited." — **INCONCLUSIVE (deferred).**

> *"A cheaper actor tier keeps most of the recall at a fraction of the cost; raising the
> grader tier moves precision more than recall."*

The entire climb ran on a single tier pairing (`gpt-5.4-mini` actor / `gpt-5.5` grader), so
there is no within-study tier contrast to test this on, and re-running the tier axis was
descoped (subscription-quota discipline). **H5 is recorded inconclusive, not supported or
refuted.** What the single tier *does* show is that a cheap `gpt-5.4-mini` actor sustained
the full climb to two clean rounds — consistent with "recall survives a cheap actor" — but
that is one point, not a gradient. A future study should vary actor and grader tiers
independently on this same frozen instrument; the harness already supports per-case tier
pins, so the experiment is cheap to run when quota allows.

---

## The fault accounting

Every seeded fault, by arm. "fixed (undetected)" = the fixer resolved it without any tester
ever surfacing it — the class-generalization effect. Full interactive table:
[accounting.html](accounting.html).

|  | Naive | Policy |
|---|---|---|
| found and fixed | 12 | 14 |
| **fixed without detection** | **4** | **6** |
| found but accepted (unfixed) | 1 | 0 |
| **missed** | **9** | **6** |
| **resolved (fixed, any route)** | **16 / 26 (62%)** | **20 / 26 (77%)** |

**Fixed without ever being detected** — the loop's quiet superpower:
- Both arms: `f-sort-inert` (dead sort dropdown), `f-card-spaces-validation` (over-strict card
  validator). Fixed as neighbors of detected faults on the same surface.
- Policy only: `f-no-results-jargon` and `f-clear-search-self-link` (both generalized from the
  detected empty-cart jargon and the restored search box), plus `f-cant-buy-last-unit` and
  `f-checkout-empty-guard-gone` (edge cases the operator hardened while fixing checkout).
- Naive only: `f-account-error-swallowed`, `f-account-form-resets` (blind coverage of the
  account form).

**Missed by both arms — the hard core, and the most valuable rows in the study:**
- `f-oos-says-in-stock` (L1): an out-of-stock product's stock line reads *"In stock — more
  arriving daily"* directly above a disabled "Out of stock" button. Testers repeatedly opened
  the page, noted the dead end, and **never flagged the contradiction.** A near-miss every time.
- `f-receipt-eta-wrong` (L1): a shipped order's receipt says "arrives in 3–5 days." Testers
  quoted the wrong ETA verbatim in their reports as if it were correct.
- `f-continue-shopping-loop` (L3): "Continue shopping" on a receipt bounces to checkout, which
  bounces to the now-empty cart. A pure flow defect — never caught.
- `f-cart-continue-removed` (L4): the cart's "continue shopping" link is gone; only global nav
  remains. The one L4 miss, because global nav is an adequate substitute for the goal.

The pattern in the misses is exactly H2's inverted gradient: **misleading copy and broken
flows survive; missing capabilities do not.**

---

## The ratchet — do the pinned regression stories actually bite?

A pinned regression story is only worth its cost if it goes **red** when the fault it guards
comes back. We tested this directly: re-inject a fixed fault into the reference app, one each
from L2, L3, L4, and run that fault's pinned story. A green re-injection would falsify the whole
ratchet. Results:

| Level | Re-injected fault | Pinned story | Outcome |
|---|---|---|---|
| **L2** | `f-add-cart-silent` | add-to-cart-feedback | **RED** — actor saw the cart count stay at 0, re-clicked, and ended with an accidental duplicate ("quantity 2, had to decrement to 1"). |
| **L4** | `f-order-history-removed` | account-order-history | **RED (hard case)** — the actor **gave up** (score 20): "scrolled… before giving up because no orders list appeared… dead-ended on those forms." The disappearing capability was caught decisively. |
| **L3** | `f-checkout-empty-guard-gone` | empty-cart-and-back-link | **RED** — major finding: "Directly visiting `/checkout` with an empty cart bypassed the guard and showed a live payment form with Place order — $6.00, no redirect." |

All three levels go red — including the L4 "feature disappearing" case the pre-registration
flagged as hardest. The ratchet holds.

**But one re-injection came back green, and that is the more instructive result.** The first
L3 fault we tried was `f-validation-wipes-payment`, guarded by the checkout-recovery story. It
came back **green (score 94)** — *not* because the guard is broken, but because the actor
entered a valid card and a valid postcode and **never tripped the validation error the fault
depends on**, so the payment-wipe never fired ("No validation message occurred in this run, so
persistence after validation was not tested"). We swapped in the deterministic
`f-checkout-empty-guard-gone` (whose story always GETs an empty `/checkout`) to complete the L3
demonstration, and kept this result because it is a real warning: **a regression story gated on
a specific error path is a probabilistic guard, not a deterministic one.** If the story does not
*force* the fault's precondition every run, it can pass while the fault is present. Pin stories
that deterministically exercise the exact broken transition — or accept that the guard will only
fire some fraction of the time.

## The false-positive floor and the persona signal

On the broken baseline, precision was **~48%** (66 real of 139 non-duplicate findings). Once
the app is fixed, precision collapses to ~0 **by construction** — on a clean app every finding
is a false positive — so the meaningful clean-app metric is the **absolute FP floor**, which
held stable at **~190–197 findings per round** in both arms, in four durable categories:

1. **Visual prominence** — "the cart badge is small / the button is understated." By far the
   largest bucket. The affordance works; the tester wants it bigger.
2. **Below-the-fold** — "I had to scroll to reach Place order." A 1280×720 viewport artifact.
3. **Out-of-SPEC scope** — wishes the SPEC explicitly excludes: shipping/returns policy pages,
   product comparison, grid quick-add. (The trust-content wish was probed and held as a real
   but out-of-contract SPEC gap — see the policy round-1 ledger.)
4. **Harness-timing artifact** — the actor's "View cart" click on the post-add toast fails
   because the actor's step latency exceeds the toast's 20-second lifetime. The toast is fine;
   the tester was too slow. Identical helper in the clean subject confirms it.

**Reading a clean report as clean requires knowing this floor.** A team adopting Playtest
should pre-classify these four buckets once and suppress them, or every clean run will look
alarming.

**Persona signal** (detections by persona × defect class, all rounds):

| persona | yield | strongest at | unique catches |
|---|---|---|---|
| cautious-first-timer | highest (10 faults) | contrast, no-receipt, validation, trust | — |
| weekend-browser | 9 | capability-removed, no-receipt, empty-states | `f-empty-cart-jargon`, `f-product-crumb-removed` |
| returning-regular | 9 | account, order-history, validation | `f-order-history-removed` |
| gift-rusher | 9 (mostly duplicative) | fast-click add-to-cart stress | — |

`gift-rusher` earned its PLAN-r1 demotion: high overlap, no unique catches. The account-heavy
`returning-regular` is the *only* persona that ever exercises order history — drop it and an
entire capability class goes dark. `confusing-empty-state` and `navigation-removed` were only
ever caught by `weekend-browser`. **Recommendation: keep cautious-first-timer, weekend-browser,
and returning-regular as the core panel; run gift-rusher only as a targeted fast-click stress
on the add-to-cart path, not as a general discovery persona.**

---

## Threats to validity and honest caveats

- **The stop-rule hole.** The pre-registered "clean round" is defined as *zero true-positives
  + regression green* — it **does not count fix-induced (emergent) regressions.** The naive
  arm's round-1 therefore registered "clean" by the literal metric while carrying 11 self-inflicted
  regressions. We did **not** silently patch the definition after seeing this (that would be
  post-hoc goalpost-moving); we report both readings and flag it. **Any future run of this loop
  should define clean as "zero true-positives AND zero emergent AND regression green."** This is
  the single most important instrument fix the study surfaced.
- **Latent subject quirks (3 catalogued).** The reference app itself carries three behaviors
  that look like defects but are present identically in the clean subject and are not seeded
  faults: a cart badge that goes stale after a browser Back (bfcache restoring a pre-add page),
  sort resetting when you use the header "Shop" link (a bare `/`), and the cart quantity input
  committing on blur rather than per-keystroke. All three drew tester complaints; all three are
  clean-reference matches, not faults. A reference app is never perfectly seamless, and these
  are the residue.
- **Single subject, single instrument.** One storefront, one SPEC, one actor/grader tier
  pairing. The L4>L3 gradient and the ~190 FP floor are this subject's; the *direction* of the
  findings should generalize, the exact rates should not be quoted as universal.
- **Adjudication is catalog-aware.** The lead mapping findings to faults knows the catalog. The
  fixers are blind and the ordering is git-provable, but the true-positive/false-positive calls
  are one informed judge's, not a blind panel's.
- **One voided round.** The policy arm's first round-1 execution ran against stale server code
  (started between two commits) and was caught by a pinned sort regression story, voided, and
  cleanly re-run — logged in the round-01 ledger amendment. The catch is itself a small vote of
  confidence in the pinned-regression discipline.

---

## What to take away

For a practitioner weighing an agentic UX tester:

1. **It is a strong absence detector and a weak flow detector.** Trust it on "did a capability
   disappear / does an action give no receipt"; supplement it with assertions or human review on
   "does this link/date/message actually say the right thing." That is not a tuning problem; it
   is the shape of what a goal-directed actor perceives.
2. **The fixer resolves more than the tester sees** — budget for and *welcome* class-generalizing
   repair, but pin a regression story per fix, because that discipline is what separated the
   zero-regression climb from the eleven-regression one.
3. **A small diverse panel beats a big homogeneous one.** Three well-chosen personas covered
   more than any single persona could, and the fourth (gift-rusher) was dead weight outside one
   narrow stress role.
4. **Know your false-positive floor before you read a clean report.** ~95% of findings on a
   fixed app are prominence/layout/scope/timing noise; classify them once or drown.
5. **Count fix-induced regressions in your stop rule.** The loop can reach "clean" while quietly
   breaking things if you only count faults it was looking for.

*Committed evidence: `studies/hillclimb/ledger/{baseline,naive,policy}/round-*.json`;
detection matrix [matrix.html](matrix.html); per-fault accounting [accounting.html](accounting.html);
per-round detail under [rounds/](rounds/). Independent second read:
[writeup-gpt56sol.md](writeup-gpt56sol.md).*
