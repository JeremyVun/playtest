# Pre-registration — Detection study: Playtest vs a coding agent (web)

**G0 freeze.** This document freezes the protocol of
[`docs/backlog/detection-study/web.md`](../../docs/backlog/detection-study/web.md)
(design of 2026-07-29). The commit introducing this file is the G0 commit; the
design doc at that commit is the protocol, with the defaults below promoted to
**binding**. Nothing here may change after any measured data exists. Failure
against a bar is a result, not a reason to move the bar. Artifacts that do not
exist yet (subject, stories, catalog, harness prompts) get their SHAs at their
own gates — G1, G2, G3, G4 — recorded in `PINS.md` beside this file as each
gate closes.

Frozen on 2026-07-30. Repo state at freeze: parent commit
`d928b74a9d4f9f558044b4f4002b09d8476e3ed6` (clean tree).

## Roles and contamination matrix

| Role | Context | May see | Must never see |
|---|---|---|---|
| Lead (orchestrator/auditor) | this Claude Code session (Fable 5) | everything | — (contaminated; never authors stories, faults, subject code, or fixes) |
| Subject author | fresh subagent, **opus-5** | subject requirements below | stories, fault catalog |
| Story author | fresh subagent, **opus-5** | `SPEC.md` only (+ shipped `playtest-bughunt` skill text) | subject source, fault catalog |
| Catalog author | fresh subagent, **opus-5** | clean subject, `SPEC.md`, quotas | stories |
| Judge | fresh subagent, **Fable 5** (`claude-fable-5` via Claude Code Agent tool; smoked 2026-07-30, availability confirmed) | pass 1: raw deliverables only; pass 2: normalized ledger, fault cards, `SPEC.md`, clean-reference behavior | arm identity, arm transcripts, this prereg's bars |
| Arm P | hosted Playtest product, black box | story/persona text, app URL | subject source, catalog, telemetry |
| Arm C | gpt-5.5 agent loop + Playwright browser | story/persona text, app URL, its own transcript | subject source, fetched bundles (audited), catalog, telemetry |

Fable-as-subagent permission for the judge role was granted explicitly by
Jeremy (2026-07-29). Author-role models are harness choices, pinned for
reproducibility; they are not measured arms.

## Model routes (smoked 2026-07-30, all green)

| Role | Model | Route |
|---|---|---|
| Arm P actor | `gpt5_5` alias → wire `claude-gpt-5.5` | Codex gateway `http://127.0.0.1:8900` |
| Arm P grader | `gpt5_5` (engine default) | same gateway |
| Arm C agent | `claude-gpt-5.5`, chat completions + function tools | same gateway (forced-tool smoke green) |
| Judge | `claude-fable-5` | Claude Code Agent tool, no gateway |

Suites must set `actor_model: gpt5_5` explicitly (engine default is
`gpt5_4_mini`, and only the alias form is priced by `estimateCost`).

## Environment pins

- Product repo: this repository at the G0 commit; later gates may add
  study-only files under `studies/detection-web/` but must not modify
  `packages/**`. If a product bug blocks the study, the fix commit and its
  reason are logged in `PINS.md` before any further measured round.
- Claude Code 2.1.220; Node v25.8.2 (repo floor 24.18); Playwright 1.60.0
  with its Chromium; codex-gateway repo `ca17ee3` (launchd service, port
  8900, concurrency 2, 300 s deadline).
- Hosted env for arm P: `npm run hosted` on :4177, `PLAYTEST_AUTH=dev`,
  fresh `PLAYTEST_DATA_DIR` under `studies/detection-web/.data/` (gitignored,
  disposable, **never archived or published**),
  `PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8900`,
  `PLAYTEST_LLM_API_KEY=subscription`, `PLAYTEST_LLM_TIMEOUT_MS=305000`,
  runs `--parallel 1` (gateway queue wait counts against its deadline).
- Subject app ports: arm P copy :4620, arm C copy :4621. One Playtest run
  process at a time; after any kill, loop `pgrep -f` until empty. Long-lived
  servers via detached `nohup`, never harness background tasks.
- `studies/**` source never contains the literal `examples/` path.

## Fault catalog freeze

- **Exact count: 20 faults.** Each fault carries exactly one label per axis;
  every axis sums to 20.
- Scope: surface/copy 5, interaction 5, multi-step flow 6, missing
  capability 4.
- Trigger: natural path 6, invalid/boundary 4, empty state 3, recovery 3,
  async/failure 4.
- Recognition: obvious breakage 6, silent no-op 5, contradiction 5,
  plausible-but-wrong value 4 (each of the 4 only where `SPEC.md` carries an
  independent oracle).
- Masking: chains at most 2 deep; at most 6 faults masked in round 1 (≥14
  reachable at start); masked faults classified up front and scored only from
  first reachability. Both masking-aware and raw recall are reported.
- Every fault: green-on-clean / red-on-broken manifestation test + hidden
  server-side trigger probe (diagnostic only, never in the headline, invisible
  to both arms).

## Trials and rounds

Two frozen trials, sequential; trial 2 is a fresh-context replication (fresh
hosted project, fresh app copies, fresh agent contexts; identical everything
else; nothing tuned between trials). Within a trial each arm runs its own
independent loop: up to 3 rounds; stop early when a round yields zero new
seeded detections. Round order within a trial: **arm P's round completes
first, then arm C's same-numbered round** (needed for the abort rule). After
judging, every correctly-reported seeded fault is withdrawn from that arm's
copy and the app rebuilt ("assume fixed" — the report must say withdrawal
simulates the fix).

## Arm C brief (frozen intent; exact prompt text SHA-frozen at G4)

Same story/persona text as arm P; work the stories in a real browser; report
bugs with reproduction steps; reading application source or fetched bundles
is forbidden and the transcript is audited for it. Hard caps per round: 200
model messages, and wall-clock abort at 2× arm P's wall time for the
same-numbered round. Deliverable: its written bug report.

## Judge protocol (frozen)

Two fresh-context batched passes per round, arm-blind:

1. **Normalization (catalog-blind):** split raw deliverables into atomic
   one-issue claims; mark repeat reports as duplicates; keep exact source
   text and evidence excerpts attached. The normalized ledger is frozen
   before pass 2.
2. **Classification:** for each claim — `seeded` (names exactly one matched
   fault id; a normalized claim credits at most one fault), `latent`, or
   `invalid` — plus one-line rationale and confidence (high/medium/low).
   Invalid sub-labels (duplicate, soft-ux, harness-artifact, not-a-bug) go to
   the appendix; the headline stays three buckets.

Latent bar: must reproduce on the clean reference AND violate `SPEC.md` or a
reasonable-user expectation; otherwise invalid. Claims are stripped of arm
identity and shuffled with deterministic seed `trial*1000 + round` before
judging. Batch limit 150,000 characters of prompt; if exceeded, deterministic
split in normalized-claim order. Human audit (the lead) touches only
low-confidence and contested calls; every override is logged in the ledger
with a rationale.

## Metrics and cost accounting

Headline metrics as in the design doc: seeded found, latent found, invalid
claims (duplicates broken out), cost, wall time, turns (arm P: recorded actor
steps; arm C: model messages + tool calls), replication delta.

The gateway is subscription-billed, so **all dollars are priced-equivalents**
computed from token usage at the price table pinned in
`packages/core/src/llm.ts` at the G0 commit (gpt-5.5 tier: $5/M input, $30/M
output, $0.50/M cache-read). Arm P cost sums run-artifact costs (alias-priced)
plus any driver-visible authoring calls; arm C cost sums gateway `usage`
fields across its transcript at the same table. Judge and author tokens are
reported separately as shared study overhead and excluded from arm cost
(symmetric across arms). Infra cost is $0 (local machine) and reported as
such.

## Verdict bars (binding)

- **B1 — detection floor:** arm P cumulative seeded ≥ 70% of faults reachable
  in that trial; full-catalog recall and still-masked counts are mandatory
  companions.
- **B2 — marginal value:** arm P unique seeded ≥ arm C unique seeded + 3.
- **B3 — noise ceiling:** invalid claims ≤ ⅓ of arm P's deliverable, per
  round.
- **B4 — budget:** ≤ $75 priced-equivalent and ≤ 8 h wall clock per arm per
  trial. Whole-study model-spend cap: $350 priced-equivalent including
  overhead roles. Abort rule: an arm exceeding its cap stops at the end of
  the current round; the stop reason is published.

B1–B4 are evaluated per trial. A reversed or split verdict is published
plainly, never averaged away.

## Deliverable and scrubbing

Curated static-site report under `studies/detection-web/report/` with both
trials side by side, per-round convergence, per-fault matrix, evidence
excerpts, machine-readable ledger, and an evidence linter. Committed evidence
is a scrubbed export only: run/finding records, timestamps, token/cost data,
pins, hashes, excerpts. Never: credentials, auth state, raw `runs/`
directories, or any part of the data root.
