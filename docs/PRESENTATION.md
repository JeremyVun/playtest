# Playtest — presentation working doc

Slide-by-slide working notes. Each slide has the on-slide text, the talk
track, and open items. Evidence sources:
`studies/detection-web/report/index.html` and
`studies/detection-api/report/index.html` (both complete).

---

## Slide 1 — WHAT

**Slide text:** "Does it work?"

**Talk track:** This is the whole job, and it has two readings we tend to
treat separately:

- **Design sense** — does the UX work? Are we building the right thing?
- **Technical sense** — is it buggy in the hands of users?

Every practice on the next slides is an attempt to answer one of these,
and the split between them is where things fall through.

---

## Slide 2 — WHY

**Slide text:** Generating product code with AI is now cheap.
Verification and attestation is not.

**Talk track:** The cost of *producing* code has collapsed. The cost of
*knowing it works* — and being able to show someone that it works — has
not moved. That asymmetry is the gap this product sits in: as generation
gets cheaper, unverified surface area grows, and verification becomes the
bottleneck and the value.

---

## Slide 3 — HOW (status quo)

**Slide text:** four quadrants / rows, one line each:

| Practice | The problem |
|---|---|
| BVT — testing in prod after release | Basic smoke tests. Expensive, error-prone, low coverage. |
| Programmatic tests | Who wrote them? Not a human, and not from the user's perspective. "You are not the user." |
| Live user testing — pilots, canaries | Low volume, expensive, risky. |
| ACs | QA was the chain of custody. We fired the testers and expected devs to fill the gap — now there is no chain of custody. |

**Talk track:** Walk each row. The AC point is the one to land hardest:
acceptance criteria used to be *owned* — a tester signed off that the
built thing matched the agreed thing. That hand-off chain is gone, and
nothing replaced it. (This sets up slide 5, where the story *becomes* the
AC.)

---

## Slide 4 — humour beat

**Slide text:**

> "Don't make me click."
> A dev's definition of tested: *"it compiled."*

*("Don't make me click" is the headline — riff on Krug's "Don't Make Me
Think", ties back to slide 1's design sense. "It compiled" lands second as
the technical-sense twin.)*

**Talk track:** One beat, self-deprecating — devs will do anything to
avoid manually clicking through their own app, including shipping. Which
is fine, because clicking through the app is exactly the thing we should
be delegating.

---

## Slide 5 — paved roads in a world of slop

**Slide text:** the real config surface, built one concept at a time —
three small files with filename captions, YAML shown verbatim:

> **Persona** — `personas/busy-parent.yaml` — prose `description:` of who the user is
> **Goal** — `stories/add-todo.yaml` — the plain-language `story:`
> **Assertions** — same file — `success:` mixing LLM asserts with deterministic gates
> **Target\*** — `playtest.yaml` — `persona:` by slug + `driver:` web · mobile · api

\* asterisk on api is deliberate — "we'll come back to that" (slide 10).

**Talk track:** the slide *is* the files, not a diagram of them. The
punchline for slide 3's AC row: **the story *is* the AC.** One-to-one
mapping between the acceptance criterion and the executable test-case
artifact — the chain of custody comes back, and it's written from the
user's perspective by construction.

---

## Slide 6 — the feedback loop

**Slide text:** one diagram:

```text
                 ┌─────────── Story (Persona · Goal · Assertions) ──────────┐
                 │                                                          │
                 ▼                                                          ▼
             ┌───────┐        acts on         ┌───────┐   trajectory   ┌─────────┐
             │ Actor │ ─────────────────────▶ │ World │ ─────────────▶ │  Judge  │
             └───────┘                        └───────┘                │ (gates + │
                                                  ▲                    │  grader) │
                                                  │                    └─────────┘
                                              ┌───────┐    findings         │
                                              │ Build │ ◀──────────────────┘
                                              └───────┘
```

**Talk track:** The actor (persona + goal) acts on the world and produces
a trajectory. The judge — deterministic gates plus an LLM grader — turns
the trajectory into findings. Findings feed the build process; the build
changes the world; the loop closes.

The one structural detail worth the extra arrow: **the story feeds both
the actor and the judge.** The same artifact drives the acting *and* the
grading — that's what makes "the story is the AC" (slide 5) a mechanical
fact rather than a slogan, and it's the thing that distinguishes this from
"agent wanders around and writes a report."

Closing beat is the segue to slide 7: iterations of the loop get cheaper —
recorded runs replay and self-heal.

---

## Slide 7 — record · replay · heal

**Slide text:** headline "Every run is a recording." then three rows of
the same 12-step journey, revealed one at a time (filled dot = model
step, hollow = deterministic):

> **Record** — ●●●●●●●●●●●● — $0.25 *(the actor explores once — every step is saved)*
> **Replay** — ○○○○○○○○○○○○ — $0.00 *(the saved path re-runs deterministically — no model calls)*
> **Heal** — ○○○○○○●●○○○○ — $0.04 *(the app changed — only the drifted steps re-engage the model)*

Final fragment: **"25¢ to record. Free to replay. Heals only what
breaks."** + sub-line *"And the same path every run — reproducible by
construction."*

**Talk track:** cost control and reproducibility — the two things
everyone is asking of AI tooling — come from the same mechanism. The
first green run is saved as the case's baseline path. Later runs replay
it deterministically: no model calls, $0, and the *same path every time*,
which is what makes runs comparable and CI-gateable. When the app
legitimately changes, healing re-records only the drifted steps and saves
the repaired path. Pay to explore once; pay for drift; never pay for
repetition. Sets up the demo — the checked replays you're about to see
live.

---

## Slide 8 — demo

Slides mostly empty; live drive. Run sheet:

1. **Web suite** — create a suite; "help me draft" to generate multiple
   stories; run; live view; context representation.
2. **Pre-recorded and checked runs** — the regression/replay side, live.
   Slide 7 made the economics point; here the audience sees a checked
   replay actually run.
3. **Findings system** — and real findings already caught in production
   systems.
4. **Mobile** — short: a suite and a pre-recorded run.
5. **API\*** — no demo. "One tool for everything?" — tease it, answer on
   slide 10: no, and we tested our way to that answer.

**Fallback (planned move, not an apology):** pre-recorded checked runs
ready for both web and mobile. If the live run flakes, switching to the
replay *is* a product beat — "this is exactly what a checked replay is
for."

---

## Slide 9 — proof, not vibes: the web detection study

**Slide text (five lines):**

> Same app, 20 seeded bugs: Playtest vs a coding agent with a browser.
> Both found 8 — **not the same 8.** Playtest caught the bugs that *look* correct.
> It also found bugs we didn't plant.
> Two independent trials, identical results. 35% cheaper. Converged by round 2.
> The misses? Roads the stories never paved.

**Setup (talk track, 30 seconds):** if we can *detect*, we can
hill-climb — detection is what makes the slide-6 loop real. So we
pre-registered success bars and tried to *fail* our own product: a
rental app with 20 seeded bugs, Playtest vs a coding agent with a
browser, same gpt-5.5 actor, 3 fix-and-retest rounds, arm-blind judge,
frozen scoring, run twice. Some bars failed; we publish those too — a
deck that shows its failed bars is the one worth trusting.

**Talk track per line:**

1. *Not the same 8:* Playtest's unique finds were the arithmetic faults —
   plausible-but-wrong values, caught because gates pin spec numbers like
   $35.10. An agent sees a reasonable number and moves on. (Agent's
   uniques: two interaction edges.)
2. *Bugs we didn't plant:* 5 latent issues credited per trial (agent: 4)
   — we accidentally shipped 3 real validation bugs in our own subject;
   both methods kept finding them.
3. *Identical results:* same fault sets, round by round, across trials —
   repeatable enough to gate CI. ~$22.50/trial vs ~$35 (counterweight:
   ~2× wall clock). Round 3 added zero for anyone — two rounds is the
   recipe.
4. *Roads never paved:* of the 10 bugs neither found, 4 were never even
   reached — all misses concentrate off-road (empty states, boundaries,
   calendar edges). On the paved surfaces, detection was strong and
   immediate. Widening coverage is story authoring, not a detector
   rebuild — callback to slide 5.

---

## Slide 10 — the API detection study

**Slide text (four lines, nothing else):**

> The API layer sees what browsers can't — 4 bugs no web arm ever found.
> Free fuzzing: triggered every bug, reported zero.
> A coding agent with the spec: 10/10, $11, 12 minutes.
> **No user → no user story. Playtest stops where the user does.**

**Talk track:** Same app, this time its JSON API — the 10 API-observable
seeded faults, three black-box testers: a coding agent holding the
OpenAPI spec, the Playtest probe, and Schemathesis as the free floor.
Walk the three result lines, then land the conclusion:

- The layers are genuinely complementary — the faults browser testing
  missed are exactly the ones API testing caught. API testing matters.
- But fuzzing can't do it (no oracle for "plausible but wrong" — it hit
  the wrong total 55 times and said nothing), and it turns out the right
  intelligent tool for it is *a coding agent, not Playtest*. The agent
  swept the catalog. Playtest's entire advantage is the user's
  perspective — persona, goal, journey — and an API has no user-facing
  component. Take that away and stories are just a worse way to write
  programmatic tests.
- Supporting API testing properly would mean giving the product an
  execution workspace for authored test code — at which point we're
  reinventing Claude Code, badly. We looked at that road in July and
  closed it then too. The product answer isn't "one tool for
  everything"; it's Playtest for every surface a user touches, your
  coding agent for the ones they don't.

**Why this lands well:** it's a scope boundary drawn by our own
published experiment, not a retreat — and a vendor who tells you where
*not* to use their product earns the claims on slide 9.

---

## Slide 11 — wrap-up: the callback

**Slide text:** "Generating the app took an afternoon. Proving anything
about it took a study."

**Talk track:** Callback to slide 2, now with a concrete instance the
audience has just seen: the study's subject app — 20 seeded bugs, stories,
catalog — was AI-generated in an afternoon; the pre-registered study to
*attest* anything about it took two trials over two days. That's the
asymmetry, lived. The resolution: we paid the expensive attestation cost
**once** — the studies are what license trusting the instrument — so that
per-release verification becomes cheap and repeatable: a full three-round
bug hunt for ~$22, and in steady state 25¢ to record a journey, free to
replay, healing paid only when things drift.

**Final spoken line (the slide-1 bookend, delivered, not shown):**
"So — does it work? You can now ask that question of every story, on
every release, and get an answer with evidence attached."

---

## Slide 12 — Q&A

Backup facts for likely questions (disclose if asked; don't lead with
them):

- All pre-registered detection bars (B1, B2) **failed for both methods
  identically** — neither cleared 40% recall; union 50%. Fair summary:
  the choice moves *which* bugs you catch, cost, and wall time — not the
  count.
- The noise bar (B3) failed every round — but almost nothing was
  fabricated, and **~40% of the "noise" is design-sense UX findings the
  defect bar couldn't credit** (contrast, below-fold friction,
  discoverability). The bar measured defect precision; the product was
  also answering slide 1's *other* question. Fix: separate defect claims
  from observations in the feed.
- "Fixed" in the web study means the fault was withdrawn from the next
  build; no real fixes were generated or verified.
- API study, if pressed on fairness: the probe got 7/10 and worked from
  story text alone while the agent held the OpenAPI spec — that's logged
  in the report itself, and a spec-wired probe would likely close some of
  the gap. It wouldn't change the conclusion: where there's no user
  journey, story-driven testing has no structural advantage to offer, so
  the scope boundary stands regardless.
