# P1 — agentic invariant probe: measured result and verdict

**Verdict: NO-GO.** Computed 2026-07-26 against the thresholds frozen in
`PREREGISTRATION.md` at commit `9059797`, before the measured round ran.

The probe works. It finds real bugs, it does not cry wolf, and it produces
evidence a human can check. It is not differentially good enough at finding
*semantic* faults to license building a generative engine on top of it, which
is the only question P1 existed to answer.

---

## 1. The result

Five held-out faults — one schema-reachable, four semantic — authored by an
isolated agent, sealed outside the working checkout under a sha256 commitment,
and never seen by anyone who tuned the instrument. All six probe stories ran
against every one of them; both comparator arms ran against every one of them
at the same wire-enforced 360-request budget.

| Held-out fault | Tier | probe | agent-suite | schemathesis |
|---|---|---|---|---|
| `f-cursor-error-bare` — rejected cursor answers 400 with a bare `{message}` instead of the error envelope | schema-reachable | **found** (2 of 6 stories) | found | found |
| `f-close-pending-inbound` — the close guard only checks *outbound* transfers, so an account with an inbound pending transfer closes | semantic | **found** (1 of 6) | found | miss |
| `f-settle-failed-debit` — a transfer failing the funds re-check at settlement still writes its debit row | semantic | **found** (2 of 6) | found¹ | miss |
| `f-idempotency-day-expiry` — the ledger-day rollover drops idempotency keys, so a retry across it creates a second transfer | semantic | miss | miss | miss |
| `f-fee-double-charged` — on **EUR** settlements the fee is also deducted from the credit leg | semantic | miss | found | miss |
| | | **3 / 5** | **4 / 5**¹ | **1 / 5** |

¹ By its own assertions, with correct evidence. The shared oracle scored the
agent-suite 3/5 because it did not credit that finding — see §3.

### Against the frozen bar

| | Criterion | Result |
|---|---|---|
| **(a)** | ≥ ⅔ of held-out semantic faults detected with correct evidence (≥ 3 of 4) | **FAIL — 2 of 4** |
| **(b)** | ≥ 1 held-out semantic fault detected that **both** comparators miss | Passes mechanically; **fails in substance** (§3) |
| **(c)** | Zero unresolved false gate failures across clean-build runs | **PASS** — 12 of 12 clean, zero findings |

Go required all three. (a) fails outright, so the verdict does not turn on the
argument in §3 — but that argument matters for what anyone concludes next.

### What it cost

| Arm | Detection | Requests / build | Wall / build | Cost / build | Authoring |
|---|---|---|---|---|---|
| probe | 3 / 5 | 329 (6 runs) | ~80 min | $20.22 | six stories, one per rule |
| agent-suite | 4 / 5 | 285–290 | 0.26 s | $0 | ~2.5 h, once |
| schemathesis | 1 / 5 | 360 | 2.2 s | $0 | configuration only |

The probe arm's held-out round: 30 runs, 1645 requests, 6.7 hours, **$101.11**.

---

## 2. Why the probe missed the two it missed

This is the useful part of a negative result.

**`f-fee-double-charged` is currency-conditional.** The fee is double-deducted
only on EUR settlements. The probe worked in USD and never tried the other
currency; the agent-authored suite tested both currencies systematically
because its author enumerated the parameter space up front. This is the
clearest lesson in the study: a goal-directed search optimises for *reaching a
state*, and reaching one instance of a state feels like success. A test suite
optimises for *covering a space*, and covering it is cheap once written. The
fault lived in the second column of a two-column table nobody thought to widen.

**`f-idempotency-day-expiry` needs a temporal boundary crossed on purpose.** A
retry has to straddle a ledger-day rollover — create with a key, advance the
day, retry. No arm found it. It is not obviously a probe weakness; it is a
reminder that "state" includes time, and that neither an actor nor a test author
reaches for the clock unless something tells them to.

## 3. Criterion (b), and why I am not banking it

Under the frozen scoring rule, an arm detects a fault when the **shared oracle**
confirms a counterexample in that arm's recorded traffic. By that rule the probe
uniquely found `f-settle-failed-debit`, and (b) passes.

Reading the agent-suite's own log for that build, it caught the same fault and
reported it exactly:

```
VIOLATION  rule 1 conservation — a failed transfer wrote ledger entries
  expected: a transfer that ends "failed" writes no entries at all
  observed: tr_wczrq1mbd8 (failed) carries 1 entries:
            ent_rznz5f89v0[acc_8n36k615kk transfer_debit -9125]
```

That is the fault, named, with the offending row cited. The shared oracle did
not credit it because its balance-agreement rule requires a balance read and a
*complete* entry enumeration with no write in between, and the suite's traffic
never landed in that window. The conservation oracle, meanwhile, only checks
entries of *settled* transfers — and this transfer failed.

So criterion (b) passes on an applicability artifact of the measuring
instrument, not on a capability the probe has and the comparator lacks. Treating
it as a pass would be exactly the kind of self-serving reading preregistration
exists to prevent.

**This is also a finding about the bench.** A shared oracle that under-credits
an arm which correctly reported a violation is a biased instrument, and the bias
happened to favour the arm under test. Any future comparison should score
"violation reported with correct evidence, by any means" alongside
"oracle-confirmed in traffic", and report both.

## 4. What the probe is genuinely good at

The negative verdict should not erase what held up.

- **Zero false positives, twice measured.** 12 clean runs before the freeze and
  25 non-detecting held-out runs after it, with no spurious violation. A
  bug-finder that cries wolf is worse than none; this one does not.
- **Every verdict is re-derivable offline** from committed artifacts by a
  deterministic oracle, with no model in the verdict path. That property
  survived the whole study and is worth keeping regardless of P1's outcome.
- **It constructs state that enumeration does not.** `f-settle-failed-debit`
  required a transfer affordable at creation and unaffordable at settlement —
  the actor engineered that gap deliberately. `f-close-pending-inbound` required
  closing an account on the *receiving* end of a pending transfer.
- **Minimality.** In the development round a counterexample arrived in 18–45
  requests (median 28) against comparators spending 285–360 per build.

## 5. What it cost to be wrong in the other direction

Detection stability was low: of the 30 held-out runs, only 5 produced a
violation. A fault the probe *can* find is found by one or two of six stories,
not by most of them. At ~$3.40 and 40–60 minutes per run, a team would be paying
roughly $20 per build for a 3-in-5 chance, against a suite that answers in a
quarter of a second for nothing. Even had criterion (a) passed, the economics
would have needed a hard look.

## 6. Threats to this conclusion

Stated plainly, because a negative result deserves the same scepticism as a
positive one.

- **One fixture, five faults.** A sample of four semantic faults cannot
  distinguish a 50% detector from a 70% one. The bar was set knowing this; the
  result is "did not clear a preregistered bar", not "the detection rate is
  0.5".
- **The faults were authored to be oracle-detectable**, so they favour arms
  whose traffic the oracle can read. That constraint applied to every arm.
- **The comparator was strong, deliberately.** A weaker agent-authored suite
  would have made the probe look better and taught us less.
- **Story selection was honest here and was not in the development round.** The
  8/8 development figure used the public fault→invariant mapping and is excluded
  from the verdict. The gap between 8/8 (selected) and 3/5 (unselected) is
  itself the argument for having sealed the held-out set.
- **Three configuration faults in the Schemathesis arm were found and fixed
  before its 1/5 was accepted.** Its residual weakness is structural: this API
  carries resource references in request bodies, where OpenAPI links cannot
  reach.

## 7. What follows

- **Stage 3 (the stateful fuzzer engine) is not licensed.** `DESIGN.md` §7 is
  gated closed. Re-opening it needs a differently-designed experiment, not a
  re-run of this one.
- **Stage 2 is unaffected and shipped.** P2 (secrets and baseline hygiene), P3
  (bindings, match rules, spec enrichment), P4 (heal triage, drift reports,
  Tier-1/2 gate kinds) and P7 (cross-layer HAR assertions) were always
  unconditional, and they are the phases that carry M2's exit criteria.
- **The probe suite stays** as a worked example of custom assertions and as an
  exploratory tool. It is not a release gate and this report is the reason.
- **P5, the unbiased stakeholder trial, becomes the more important next step,**
  not less. Its semantic verdict was one of P6's three preconditions; with P1
  answered no, P5's value is now entirely about whether Stage 2 holds up on an
  API nobody designed it for. *(2026-07-26: the trial materials were folded
  into the script-authoring plan's S5 — `docs/backlog/api-testing/
  BUILD_PLAN.md` — when the direction pivoted on this report's result.)*
- **The bench's scoring should gain a second column** (§3) before it is used to
  compare arms again.

## 8. Reproducing this

```sh
# probe arm, held-out builds
node examples/ledger-api/bench/bench.js --quiet \
  $(node -e "…manifest rows as <build>=<runDir>…")   # rounds/heldout-1/manifest.jsonl

# comparator arms
node examples/ledger-api/bench/bench.js --quiet \
  rounds/heldout-1/comparators/<arm>-<build>.har
```

Committed evidence: `rounds/clean-4/` (12 clean runs + scores),
`rounds/dev-1/` (development round + scores), `rounds/heldout-1/`
(manifests, comparator HARs, bench scores). Run directories and `har.json`
files are not committed — they carry full request and response bodies.

Every number in this report is re-derivable offline from those artifacts with
no model call.
