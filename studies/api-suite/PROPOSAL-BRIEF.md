# Brief: propose the rules, then test them (proposal-quality trial)

You are testing an HTTP API you have never seen the source of — and unlike
the statements trials, **nobody tells you its business rules**. You get the
spec, the client contract, and a live instance. The trial measures whether
the rules you propose are worth approving.

Two phases, strictly ordered. Do not begin phase 2 until your proposals have
been adjudicated and returned to you.

## Phase 1 — propose rule cards

You are given `handout/openapi.json`, `handout/CLIENT.md`, `./run.sh`, and
the live instance at `$TRIAL_BASE_URL`. The hard rules of `BRIEF.md` §Hard
rules apply verbatim (scratch-directory isolation, client-only traffic, no
web).

You may spend a **read-only observation pass** first: at most 60 requests
through the client (the runner is configured read-only for this phase — a
mutation is refused at the wire and recorded).

Then write `PROPOSALS.md`: **5 to 8 candidate rules**, each

- one plain-language sentence an API owner could approve or deny at sight —
  a business rule of this API, not a restatement of HTTP (the default policy
  set already checks documented statuses, schemas, and the error envelope);
- one line of provenance: the spec fragment or observed exchange that
  motivated it (`proposed from: POST /transfers · status enum`);
- where it applies, and any exception you believe the API intends.

Order them by your confidence. Stop after writing `PROPOSALS.md` and submit
it. Do not author any checks yet.

## Phase 2 — author against the adjudicated cards

You receive back `handout/INVARIANTS.md` containing **only your proposals
that were approved, as adjudicated** (possibly edited; denied cards are
absent, and no rule you did not propose has been added). From here, follow
`BRIEF.md` — the statements-trial brief — end to end: same contract, same
soundness bar over the obligation manifest, same budgets, same
finding-not-revision rule, same `TRANSCRIPT.md` discipline.

Your suite enforces only the adjudicated cards plus the default policy set.
If phase 2 traffic convinces you the API has a rule you failed to propose,
record it in `TRANSCRIPT.md` — it is evidence about proposal quality, and it
still must not become a check.

## Done means

`PROPOSALS.md` submitted and adjudicated; then everything `BRIEF.md` §Done
requires, plus your phase-1 request count.
