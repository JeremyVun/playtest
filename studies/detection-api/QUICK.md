# QUICK — rigor deviations from the designed protocol

This study ran under an explicit ≤2.5-hour wall-clock brief (2026-07-31):
produce **indicative** findings, sacrificing rigor where needed, and log
every deviation from [`docs/backlog/detection-study/api.md`](../../docs/backlog/detection-study/api.md)
here. This file replaces a full PREREG. The web study's frozen protocol
([`../detection-web/PREREG.md`](../detection-web/PREREG.md), `SCORING.md`)
supplies all vocabulary and scoring rules not overridden below. Whatever was
measured is reported exactly.

## Deviations (what was cut vs the design, and why)

1. **Subject and faults are reused, not authored.** The design calls for the
   ledger fixture plus a fresh sealed 12–15-fault set under sha256
   commitment. Instead the web study's frozen Loanpoint subject (`7f45ff3`)
   and fault catalog (`cb6692b`) are reused, filtered to the faults whose
   manifestation is observable purely over the JSON API. Selection was
   mechanical: a catalog manifestation check that touches only `/api/*`
   (never a served `/views/*.js`) is API-observable — exactly the 10 faults
   with `check_note: null` in `catalog.json`. Saves ~2 h of authoring +
   audit; the faults were sealed against the *web* arms, and no arm context
   in this study has seen them.
2. **One trial, one round, one build.** The design wants two frozen trials
   over 3–4 broken builds of 3–5 faults each plus a hidden clean build.
   Here: a single build carrying all 10 faults, one measured round per arm,
   no withdrawal loop. Justification: the web study's gpt-5.5 arms were
   strikingly deterministic across its two trials (identical fault sets), so
   a second trial buys little for its cost; the 10 selected faults have no
   masking chains among them, so a single round loses almost nothing.
3. **No hidden clean build → B3 as designed is unevaluable.** The design's
   trust bar (zero invalid claims on the unidentified clean build) needs the
   clean build among the measured ones. Instead: invalid-claim counts per
   arm are reported (web-study B3 style), and the judge's classification
   pass still verifies every latent claim against the running clean
   reference.
4. **Subject has no auth**, so the design's undisclosed-credential-roles
   probe is dropped with it (Loanpoint models a single desk supervisor).
5. **No served OpenAPI document existed**, so one was authored for the study
   by a fresh-context opus agent that saw only the clean subject source and
   `SPEC.md` (never the catalog or any arm material). It is the shared
   API-surface input of the design: arm P's story author consumed it, arm C
   receives it verbatim in its brief, arm F consumes it mechanically.
   Knowledge note: arm P's *actor* sees only the frozen stories (its normal
   operating mode), while arm C holds the full document — an asymmetry in
   arm C's favor, reported as such.
6. **Arm F (Schemathesis) is best-effort.** Included because the design
   names it the free floor, but it runs from the study-authored OpenAPI
   document (none is served) and its failure output is itemized for the
   judge by a small parser. Its version and configuration are recorded in
   the report rather than pre-frozen.
7. **Caps.** Per arm: 45 min wall, 360 requests (design's per-build request
   cap), arm C additionally 200 model messages. Arms P and C ran their
   rounds concurrently on independent app copies (:4620/:4621) — the web
   study's P-first ordering existed only to derive arm C's 2×-wall cap,
   replaced here by the flat 45-min cap.
8. **Shakedown reduced** to a 2-case smoke of the API suite against the
   clean subject; the hosted pipeline and judge were battle-tested by the
   web study days earlier.
9. **Human audit of the judge ledger** limited to low-confidence and
   contested rows.
10. **Bars as applied:** B1 (beat arm F's seeded count) and B2 (arm P ≥ arm
    C + 2 seeded) as designed, single trial; B3 replaced per (3); B4 =
    the caps in (7) plus a $60 whole-study priced-equivalent ceiling.

11. **Arm C message cap 150** (web study used 200): the arm C brief embeds
    the full 111 KB OpenAPI document (~34k tokens per model message, gateway
    caching only partial), so the cap bounds worst-case cost. The web arm C
    self-finished at 98 messages; the 45-min deadline binds first.
12. **Arm F configuration** (frozen pre-measurement): schemathesis 4.24.3,
    `run openapi.json --url <build> --checks all --max-examples 8 --seed
    20260731 --workers 1`, all phases — measured 382 generated cases on the
    clean calibration run, the closest whole-phase configuration to the
    design's 360-request cap (6% over, reported). Deliverable = JUnit
    failures itemized one item per failure block by `parse-arm-f.mjs`.
13. **Pre-freeze instrument fix:** the first Schemathesis smoke on the clean
    app exposed 8 doc-accuracy bugs (responses documented as abridged
    Summary schemas where the server returns full detail shapes); a
    fresh-context agent aligned the document to observed clean behavior
    before any measured run. The same smoke found a genuine clean-app
    latent (HTTP 500 on a literal JSON `null` body to two POST routes),
    left in place — arms may rediscover it; the judge scores it latent.
    The fixer agent flagged a fourth schema (`ApprovalItem`) carrying the
    identical unsatisfiable-`allOf` bug just outside its stated scope and
    prescribed the same flattening; the lead applied that prescription
    mechanically and the Schemathesis re-smoke verified it (zero
    response-schema violations on clean). Doc frozen after that re-smoke.

## Post-measurement log (nothing above changed after data existed)

- **B4 breach, arm P:** the round ran 90.1 min wall (88.0 min group) against
  the 45-min cap frozen above — no abort mechanism was wired for the hosted
  round and the single-round structure means the design's own abort rule
  ("stop at the end of the current round") changes nothing. Reported as a
  breach; it is within the design's original 3-hour envelope.
- **Arm F volume:** 443 generated cases on the measured (injected) run vs
  382 on the clean calibration — same frozen config, generation varies with
  app responses. 23% over the 360 cap, reported.
- **Confound (arm P's disfavor), discovered during the audit:** the frozen
  `playtest.yaml` sets no `app.openapi`, so the probe actor worked from
  story text alone and had to discover request shapes by trial; its three
  misses (bundle-threshold, saturday-roll, available-filter) are all
  journeys the actor failed to carry to the gated step after burning its
  budget on draft-creation contract discovery — its deliverable contains no
  claim about those three behaviors (verified by keyword sweep). Arm C held
  the full OpenAPI document in its brief. The product supports `app.openapi`
  suite config; a customer testing an API would plausibly set it. This is
  the study's main fairness caveat and the obvious follow-up experiment.
- **Human audit:** all low-confidence rows (C023, C027, C045) and every
  non-seeded arm P primary reviewed against the deliverables and clean
  reference; zero overrides. Judge duplicate chains for arm C's two
  latent-looking claims (C061, C067) verified as correct flip-sides of
  seeded faults.
- **Servers/judging:** classify pass verified latents against the clean
  reference at :4622 and reset it after use.

## Frozen artifact hashes (sha256/12)

| artifact | sha |
|---|---|
| work/openapi.json (arm input, post-fix freeze) | `9a34d31a8858` |
| suite/ tree (13 cases + config, aggregate, excl. smoke results/) | `fbd481f8ca3f` |
| work/stories-rendered.md (arm C stories doc) | `c33c5f510ee2` |
| prompts/arm-c-brief.md | `6c3269055bec` |
| prompts/judge-normalize.md (verbatim web-study text) | `9e782e9e021a` |
| prompts/judge-classify.md (API overrides) | `4f17695bd63a` |
| scripts/arm-c-agent-api.mjs | `d326b9a6cb0c` |
| scripts/parse-arm-f.mjs | `ba47bef2c9f9` |
| work/fault-cards.json (judge catalog) | `e426c94e7362` |

## Instrument notes

- Allocation gate (single build `a30cd991e92f`): all 10 selected faults red,
  all 10 withdrawn faults green on the injected build; all 20 checks green
  on the clean build. One benign interaction: the withdrawn
  `f-cancel-confirm-noop`'s check is un-evaluable on the injected build
  because active `f-cancel-button-missing` removes its precondition (their
  catalogued masker relationship); the noop fault itself is client-side and
  not present in the build.
- Selected faults: f-available-filter-ignored, f-bundle-threshold-off-by-one,
  f-cancel-button-missing, f-charges-late-fee, f-equipment-missing-message,
  f-extend-limit-off-by-one, f-late-fee-day-count, f-out-filter-drops-overdue,
  f-overview-units-total, f-saturday-roll-short.
- Masking note: `f-extend-limit-off-by-one` was masked in the web study by
  the (client-side) missing extension block; over the raw API the extend
  endpoint is directly callable, so all 10 faults are reachable in round 1.
