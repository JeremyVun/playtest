# API-testing work stream — session handoff

Written 2026-07-25 at the end of the P1 development round. Owner: whoever
picks this up next. The mandate from Jeremy: orchestrate
`docs/backlog/api-testing/BUILD_PLAN.md` to completion, **P1 first, then an
HTML report (method / observations / findings / recommendations) before any
decision to proceed to P2**.

## Standing rules (do not break these)

1. **Sub-agents are opus-5, never fable.** Always pass an explicit model.
2. **Never read `/Users/jeremy/playtest-sealed/`.** It holds the held-out
   fault patch and its operator notes. The go/no-go's credibility depends on
   whoever tunes the probe being blind to those faults. The measured round is
   driven by an *isolated operator agent* that applies the patch and reports
   results without disclosing fault content upward.
   - Patch: `~/playtest-sealed/heldout-faults.patch`
   - Content commitment (in PREREGISTRATION.md): sha256
     `7040d599c7489ef98d2779f818657ae5f30c6cbe339c58680f52f920bca04a23`
   - Composition (author-reported, safe to know): 5 faults, 1
     schema-reachable + 4 semantic, spanning 5 oracle categories.
3. **`examples/ledger-api/` edits invalidate nothing automatically — but
   always re-run `git apply --check -p1 ~/playtest-sealed/heldout-faults.patch`
   after touching it.** Two fixture edits have already happened safely
   (different files than the patch touches). If the check ever fails, the
   sealed set must be reissued by an isolated agent and the commitment
   updated.
4. **`studies/` may not name the `examples/` tree** — `tests/repository/`
   `boundaries.test.js` fails the root gate on the literal path in any
   `.js/.mjs/.json/.sh/.yaml/.yml` under `src/ scripts/ studies/ tests/`.
   That is why the oracles are vendored (`vendor/PROVENANCE.md`) and the round
   runner takes `--fixture`. Markdown is not scanned.
5. **One Playtest run at a time, ever.** The runner enforces it; the fixture is
   a single in-memory instance on :4180.
6. **Start long rounds detached** (`nohup zsh plan.sh &`), never as an agent
   background task — those get killed and take the round with them.

## Where the work stands

**P0: complete.**

| Piece | Commit |
|---|---|
| API driver egress guard (same-origin + `app.allowed_origins`) | `24f62e4` |
| Ledger fixture, OpenAPI 3.1, 8 dev faults, measurement bench | `a62814c` |
| `app.allowed_origins` reachable from YAML + HAR flushed before `gather()` | `b650c28` |
| Probe suite, oracle assertions, custom-assertion contract | `ff3f70d` |
| Sealed held-out fault set (outside the repo) | n/a — see above |

**P1: development round complete; measured round NOT started.**

| Piece | Commit |
|---|---|
| Preregistration (still **DRAFT**) | `679bf00`, `bc932ca`, `0406da2` |
| Comparator invariant handout | `bc932ca` |
| dev-1 round evidence + trace-parser fix | `59fdbea` |
| Fixture 500 fix found by the probe + round-runner docs | `bc7ac63` |

### Development-round results (probe arm only)

- **8/8 development faults detected**, every one with correct
  oracle-confirmed evidence citing the offending request. All six
  semantic-tier faults included. One 6–15 minute run per fault sufficed.
- **0 oracle false positives** on clean builds.
- **One true positive against the clean baseline**: the probe made the
  fixture answer 500 on `/accounts/%` (malformed percent-encoding reaching
  `decodeURIComponent`), violating its own declared "no 5xx" rule. Fixed in
  `bc7ac63` with a regression test. This is a headline finding for the
  report — the probe found a real, unseeded bug.
- Caveat recorded in the tuning log: dev-round story selection used the
  public fault→invariant mapping, so these numbers are **excluded from the
  go/no-go**, which is computed on held-out faults only.
- Cost/latency: ~$2–4 nominal and 6–16 min per 40–60 step run (subscription
  -backed, so nominal only). Aggregate so far ≈ $25 and ~3.5 hours.

Three codex-gateway defects were found and fixed gateway-side with **zero
instrument changes**: strict-schema rejection of untyped/enum-only tool
fields, `tool_choice: "required"` answered in prose instead of `tool_calls`,
and free-form header maps sanitized into un-emittable empty objects (caused a
60×401 run). Commits `c8d7b67`, `6010804`, `ca17ee3` in
`~/projects/codex-gateway`.

## Next steps, in order

### 1. Re-sweep the clean build (required before the freeze)

The clean-build runs predate the fixture 500 fix (`bc7ac63`), so the
false-positive baseline must be re-established. Twelve clean runs are
budgeted (two full six-story sweeps):

```sh
export LEDGER_FIXTURE=examples/ledger-api/server.js
# write rounds/clean-2/plan.sh looping the six stories twice, then:
nohup zsh studies/api-probe/rounds/clean-2/plan.sh > .../plan.log 2>&1 &
```

Expect ~2 hours. Any VIOLATED verdict on a clean build must be dispositioned
(assertion-scoping bug → fix and log; real fixture defect → fix and log, as
happened with the 500).

### 2. Freeze

Flip `PREREGISTRATION.md` from DRAFT to FROZEN in a commit that:
- records that commit's own SHA as the instrument pin (amend or record after),
- re-verifies `vendor/` sha256s equal the bench copies (currently oracles
  `dfcfd44c…80e4`, trace `8d822ce6…df64`),
- re-verifies the sealed patch applies.

After this commit: **no tuning of persona, stories, assertions, or oracles.**

### 3. Comparator arms (fast; do before the sealed round)

Both get **only** `comparators/INVARIANTS.md` + the served OpenAPI spec —
never repository access, never fault knowledge.

- **Schemathesis** (`.venv-schemathesis/bin/schemathesis`, 4.24.2): stateful
  phase, capped near 360 requests, HAR captured with
  `--report har --report-har-path <file>`. Record the exact CLI in the report.
- **Agent-authored suite**: an opus-5 agent with no repo access writes tests
  from the handout; keep the authoring transcript; its traffic is captured as
  HAR and scored by the same bench.

### 4. Measured round (isolated operator agent)

Spawn an opus-5 agent that: applies the sealed patch, verifies its
manifestation tests, then runs **all six stories against every held-out
build** (no fault-knowledge story selection) plus the clean sweeps, for all
three arms, per the frozen budgets — 360 requests or 3h per faulted build per
arm. It reports run directories and bench scores **without disclosing fault
content**. Afterwards the patch and its tests are committed to history.

### 5. Report and verdict

- Score everything with `examples/ledger-api/bench/bench.js` (labels = build
  ids).
- Compute the go/no-go strictly against the frozen thresholds: (a) ≥ ⅔ of
  held-out semantic faults detected with correct evidence, (b) ≥ 1 held-out
  semantic fault both comparators miss, (c) zero unresolved false gate
  failures on clean.
- Record the verdict in `docs/backlog/api-testing/DESIGN.md` (status line
  + §7 gate) and write the probe report.
- **Then the HTML report for Jeremy** — curated static site (method,
  observations, findings, recommendations), evidence embedded, raw `runs/`
  never committed. Follow the hill-climb report pattern
  (`studies/archive/hillclimb-2026-07/report/`). This is the decision gate before P2.

## Useful commands

```sh
# Fixture (clean or faulted)
node examples/ledger-api/server.js
LEDGER_FAULTS=f-close-ghost node examples/ledger-api/server.js

# One probe run
PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8900 PLAYTEST_LLM_API_KEY=subscription \
PLAYTEST_GPT5_5_MODEL=gpt-5.5 PLAYTEST_LLM_TIMEOUT_MS=305000 \
node src/cli/cli.js run ./studies/api-probe --id conservation --fresh --no-grade

# Tests
node --test "examples/ledger-api/test/**/*.test.js"   # 67
node --test "studies/api-probe/test/"*.test.js        # 32
npm test                                              # 260, must stay green
```

Gateway: `~/projects/codex-gateway` on :8900, launchd (`npm run
service:restart`). Deadline raised to 300s in its `.env` (Jeremy authorized
that edit). Never touch port 8787.
