# Hill-climb evidence study

Can Playtest hill-climb a deliberately broken app back to seamless — and what
does it catch, miss, and cost? **Pre-registration (read first, in full):
[`PREREGISTRATION.md`](./PREREGISTRATION.md).** This is the historical
operator manual; commands retain the original `studies/hillclimb/` paths and
must be run from the recorded worktree.

## Layout

```
subject/     the clean reference app (Fern & Fog) + SPEC.md — the top of the hill
bench/       measurement bench: collect / adjudicate / matrix / preflight /
             lint-evidence / site + ledger schema (its README has per-script docs)
shakedown/   Phase 1 suite: discovery vs the CLEAN reference (precision floor)
suite/       instrument: v1 trunk (8 stories) + v2 risk/ + MATRIX-v2.md freeze
             (personas: core 3 + gift-rusher stress + adversarial-tester)
faults.json  ground-truth fault catalog (authored only AFTER the v1 suite freeze)
inject-faults.mjs  deterministic injector: subject/ + faults.json → arms/<arm>/
tests/       manifestation tests: every fault red-on-broken, green-on-clean
arms/        per-arm app copies (created by the injector; committed per round)
ledger/      one entry per round per arm — the auditable chain of evidence
report/      the static research-report site (built by bench/site.mjs, Phase 4)
```

## Standing rules (non-negotiable)

Pre-registration blindness and freeze rules still hold. Instrument-v2 protocol
additions, summarized in [`README.md`](./README.md), are also standing rules:

- **Blindness:** fixers are fresh-context agents that see ONLY the findings
  report and the arm's app dir. Their prompts must forbid reading `subject/`,
  `faults.json`, `tests/`, `ledger/`, and this study's docs. Whoever authored
  `faults.json` adjudicates and never fixes. Actors/personas/stories never see
  the catalog. Blind fixers still never see `faults.json` / manifestation tests.
- **Instrument frozen:** stories, personas, models, gateway, repeats as
  committed. Any instrument change after freeze = ledger amendment + new freeze
  sha; never silent.
- **Clean round (v2 definition):** zero catalog true-positives (`seeded-tp`),
  zero `emergent`, zero `new-real-issue`, and all pinned regressions green.
  First-study (`shakedown` / `baseline` / `naive` / `policy`) `clean_round`
  flags used the old gate (emergent not counted) and are **not** retro-rewritten;
  only v2+ arms use the new definition. See `bench/README.md`.
- **Report separately** (never one “FP” dump): detected · fixed-without-detection ·
  residual live · emergent · `spec-gap` / `soft-ux` / `subject-quirk` /
  `harness-artifact` counts (DESIGN.md §3.2 labels; matrix `accounting_summary`).
- **Regression pins** must force the precondition they protect (authoring
  discipline; optional harness lint later).
- **Rounds run serially**, one arm at a time. No cross-arm learning.
- **No hand-assembled synthesis:** numbers come from the ledger via the bench;
  prose lives in the report site.
- Raw `runs/` stay local and uncommitted; the ledger + curated site assets are
  the committed evidence.

## Running the app

```
PORT=4183 node studies/hillclimb/subject/server.js     # clean reference
PORT=4183 node studies/hillclimb/arms/naive/server.js  # an arm's broken copy
```

One app at a time on 4183 — both suites point there. State is in-memory;
`POST /api/reset` reseeds (each suite's `reset.mjs` init hook does this before
every case).

**One run process per app instance — no exceptions.** The app is a single
global in-memory state; two runs sharing one port cross-contaminate *every*
overlapping case in *both* runs (each case's init resets the shared cart;
actors then shop over each other — this silently corrupted three overlapping
runs on 2026-07-10 and cost most of a baseline round). Preflight fails
(`exclusive-run`) if any `src/cli/cli.js` process is alive at round
start. After killing a run, **verify it died** (`pgrep -f
"src/cli/cli.js"` until empty) — a pkill that reports the process still
running seconds later has not done its job, and the orphan will keep driving
the app for hours.

**Sharding (the standard way to run a round).** Serial cases at codex-gateway
speeds cost 15–60 min each; a full round serially is ~5 h. Instead: start one
app instance per shard (`PORT=418X node studies/hillclimb/arms/<arm>/server.js`),
then one `playtest run` per shard with `--base-url http://127.0.0.1:418X` and
a disjoint set of `--id case@persona`. The frozen suite is untouched
(`--base-url` is a CLI override; the init hook resets whichever instance the
run points at), every shard is fully isolated, and round wall-clock collapses
to the slowest single case. Shards of one cell each are fine. Launch all
shards only after the round's single preflight passes. **Concurrency cap: 3
shards on a 24 GB machine** — 6 concurrent Playwright browsers exhausted
memory and all six crashed with "browser has been closed" within 3 minutes
(2026-07-10); crashed cells are INFRA exclusions, re-queue them.

## Model plumbing

Runs go through the **standalone** codex-gateway sibling repo
(`../codex-gateway`, not Playtest `tools/codex-gateway` as the primary path)
on **port 8900** (the gateway default). Do not document or use 8899.

**Grok (instrument v2) cheatsheet** — you should not need to memorize OAuth:

```bash
./scripts/ensure-grok.sh status   # healthz + Grok text probe
./scripts/ensure-grok.sh fix      # restart; re-login xAI only if still dead
./scripts/ensure-grok.sh smoke    # one real Playtest vision cell
./scripts/ensure-grok.sh login    # force interactive xAI browser OAuth
./scripts/ensure-grok.sh restart  # bounce gateway + CLIProxy container
```

```
export CODEX_GATEWAY_ROOT=${CODEX_GATEWAY_ROOT:-../codex-gateway}

# Preferred: launchd service (starts CLIProxy + gateway on 8900)
#   npm --prefix "$CODEX_GATEWAY_ROOT" run service:install   # once
#   npm --prefix "$CODEX_GATEWAY_ROOT" run service:status
#   npm --prefix "$CODEX_GATEWAY_ROOT" run service:restart

# Or foreground (port 8900 default; do not run alongside the service):
CODEX_GATEWAY_LOG=1 CODEX_GATEWAY_DEADLINE_MS=180000 \
  npm --prefix "$CODEX_GATEWAY_ROOT" start 2>> "$CODEX_GATEWAY_ROOT/gateway.log"

# Every Playtest run — all three:
export PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8900
export PLAYTEST_LLM_API_KEY=subscription
export PLAYTEST_LLM_TIMEOUT_MS=185000
```

Gateway log location: when using the launchd service, lifecycle logs are
`~/Library/Logs/codex-gateway.error.log` (and `.log`). When starting with
`npm start` and `CODEX_GATEWAY_LOG=1`, append stderr to
`$CODEX_GATEWAY_ROOT/gateway.log` and pass that path to preflight
(`--gateway-log`). Preflight greps the log for usage-limit hits.

Both timeouts matter, and the harness's must exceed the gateway's. At the
gateway's default 55s deadline, big-snapshot actor steps and whole-trajectory
grader calls 500 with "gateway deadline exceeded" (hit twice in shakedown,
2026-07-10). And the harness's own per-attempt cap defaults to 60s
(`src/core/llm.js` `ATTEMPT_TIMEOUT_MS`): without `PLAYTEST_LLM_TIMEOUT_MS`
above the gateway deadline, any codex turn over 60s is aborted client-side and
after 3 retries the case dies as INFRA "The operation was aborted" (killed 4 of
the first 6 cases of the first baseline attempt, 2026-07-10 — run
2026-07-10T0601-786d, discarded). Keep study rounds at
`CODEX_GATEWAY_DEADLINE_MS=180000` / `PLAYTEST_LLM_TIMEOUT_MS=185000`.

**Instrument v2** (archived follow-on): frozen in
`suite/playtest.yaml` + `suite/MATRIX-v2.md` + `suite/risk/` + study-local
`adversarial-tester` persona. Pass-through `actor_model: grok-4.5` (gateway
allowlists it and routes Playtest chat completions to CLIProxy/xAI). Grader
pinned to `grader_model: gpt5_5` via the Codex adapter on the same `:8900`
host. **28 cells** (15 trunk continuity + 13 forced-risk). v1 ledgers used
`gpt5_4_mini` / 8899 — do not mix those defaults into v2 rounds. Do not start
a ledgered v2 detection round until the MATRIX-v2 freeze commit is recorded
(BUILD_PLAN P1). Before any round, check the gateway log for `usage limit`;
if the subscription quota is burned, wait for the stated reset (preflight
checks this too).

## The round procedure (every round, both arms)

```
B=studies/hillclimb/bench
export CODEX_GATEWAY_ROOT=${CODEX_GATEWAY_ROOT:-../codex-gateway}
# Prefer service log if launchd is running; else $CODEX_GATEWAY_ROOT/gateway.log
GW_LOG=${GATEWAY_LOG:-$HOME/Library/Logs/codex-gateway.error.log}
node $B/preflight.mjs --arm <arm> --round <NN> --app-dir studies/hillclimb/arms/<arm> \
  --base-url http://127.0.0.1:4183 --gateway http://127.0.0.1:8900 \
  --gateway-log "$GW_LOG" --out /tmp/fp.json   # must pass
PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8900 PLAYTEST_LLM_API_KEY=subscription \
PLAYTEST_LLM_TIMEOUT_MS=185000 \
  node src/cli/cli.js studies/hillclimb/suite/ --parallel 1     # note the run id
node $B/collect.mjs --runs-root runs --run <run-id> --out /tmp/collected.json
# adjudicate: author judgments (verdict + rationale per finding), then:
node $B/adjudicate.mjs --arm <arm> --round <NN> --collected /tmp/collected.json \
  --fingerprint /tmp/fp.json --judgments <j.json> --ledger-dir studies/hillclimb/ledger
node $B/lint-evidence.mjs --ledger-dir studies/hillclimb/ledger --runs-root runs  # must pass
node $B/matrix.mjs --ledger-dir studies/hillclimb/ledger --faults studies/hillclimb/faults.json \
  --out /tmp/matrix.json --md /tmp/matrix.md
```

Then (climb rounds): hand the findings to a **blind fixer** on the arm's app
dir, pin a regression story per fix (story must force the precondition), commit
ledger + app changes, re-run. **Stop rule (v2):** two consecutive clean rounds
under the P3 clean definition (zero seeded-tp, zero emergent, regressions green).

### Instrument v2 policy climb (BUILD_PLAN P4)

- Arm app: `arms/v2-policy/` (start from full inject; climb in place).
- Workspace: `arms/v2-policy-workspace/` (findings pack, BELIEFS, fixes manifest).
- Regression suite: `arms/v2-policy-regression/` (pinned stories; `actor_model: grok-4.5`).
- Ledger arm name: `v2-policy` (v2 clean definition). Write-up:
  `report/WRITEUP-v2-policy.md`.
- **2026-07-14 status:** fix phase complete (manifestation residual 0/26);
  live clean rounds abandoned until Grok/xAI auth on `:8900` is restored —
  do not claim the two-clean stop rule from offline manifestation alone.

## Status / progress

Deliverable checklist lives in `docs/ROADMAP.md` M1.5 (D0–D8). Ledger entries
under `ledger/` are the per-round source of truth for what has actually run.
