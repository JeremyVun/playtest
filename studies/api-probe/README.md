# The agentic invariant probe

The cheapest experiment that can license — or kill — the semantic API fuzzer
thesis (`docs/backlog/api-testing/DESIGN.md` §4, `BUILD_PLAN.md` P1).

Six stories, one per approvable invariant of the ledger fixture. Each states a
business rule in plain language and asks an actor to find a sequence of legal
requests that breaks it. Each ends in a deterministic assertion that re-runs the
same oracle the study's measurement bench scores every arm with. The model
searches; it never decides.

> The go/no-go question: can a goal-directed actor, given a natural-language
> invariant and a deterministic assertion, discover important violating
> sequences that schema fuzzing and an agent-authored functional suite miss?

## Layout

```text
studies/api-probe/
  playtest.yaml            suite config: api driver, budgets, isolation
  reset.mjs                app.init — seeded reset before every case
  personas/
    api-fuzzer.yaml        the disposition: falsification, not task completion
  stories/
    conservation.yaml          settled transfer entries sum to zero
    idempotency.yaml           one key, one ledger effect
    lifecycle-legality.yaml    only active accounts transact
    pagination-identity.yaml   no duplicate entry id in one enumeration
    error-shape.yaml           every refusal is a 4xx envelope; nothing 5xx
    balance-agreement.yaml     stored balance equals the entry sum
  assertions/
    ledger-*/assertion.js  one deterministic oracle per invariant
  lib/
    oracle-gate.js         the bridge: har.json -> trace -> oracle -> verdict
  vendor/                  byte-for-byte copies from the fixture (PROVENANCE.md)
  test/
    assertions.test.js     hermetic: every assertion over synthetic traces
```

## Run it

### 1. A fresh fixture

The probe targets the ledger API fixture at `examples/ledger-api/`. Start it
clean, on its default port:

```sh
node examples/ledger-api/server.js
# ledger-api listening on http://127.0.0.1:4180
```

Leave it running. Nothing in this suite names a fault, a fault tier, or
`LEDGER_FAULTS` — which build the probe faces is a property of the process you
start here and of nothing committed in this directory. That is what lets the
same instrument run unchanged against the clean build, the development faults,
and the sealed held-out set.

### 2. A model gateway

Both models are `gpt5_5` through the local gateway (`../codex-gateway`, port
8900):

```sh
export PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8900
export PLAYTEST_LLM_API_KEY=subscription
export PLAYTEST_GPT5_5_MODEL=claude-gpt-5.5
export PLAYTEST_LLM_TIMEOUT_MS=305000
```

The long client timeout matters: a reasoning actor's turns run long, and a
timeout mid-search burns the run's budget without producing evidence.

### 3. The probe

```sh
playtest ./studies/api-probe --fresh --no-grade
# or, without linking the CLI:
node packages/cli/src/cli.ts run ./studies/api-probe --fresh --no-grade
```

- `--fresh` forces a fresh agentic run every time. A passing first run may write
  an incidental baseline into `results/`; later `--fresh` runs ignore it.
- `--no-grade` skips the grader. The gate still runs — the gate is the whole
  point, and the grader has nothing to add to a deterministic verdict.

One story at a time, when you are iterating:

```sh
node packages/cli/src/cli.ts run ./studies/api-probe --id conservation --fresh --no-grade
```

Validate the suite without running anything (offline, no model):

```sh
node packages/cli/src/cli.ts list ./studies/api-probe
node packages/cli/src/cli.ts lint ./studies/api-probe
```

### 4. Score the traces

The in-run gate is the stop signal. The study's numbers come from the bench,
which scores every arm's traffic — probe runs, Schemathesis cassettes, the
agent-authored suite's HAR — with the same oracles:

```sh
node examples/ledger-api/bench/bench.js runs/<run-id>
```

## Isolation is the harness's job, not the actor's

A probe run stops the instant it reproduces a violation. It does not tear down,
and it must not: the state it leaves behind is the evidence. So isolation cannot
be something the actor is trusted to uphold.

`app.init: ./reset.mjs` runs before **every** case and POSTs `/admin/reset` with
a fixed seed, however the previous run ended. The fixture's identifiers are a
pure function of that seed, so the same request sequence after the same reset
produces byte-identical resources — which is what makes a reproduced
counterexample re-verifiable by hand.

The persona also asks the actor to open its own run with `POST /admin/reset`.
That is belt and braces, and it earns its keep: one oracle (the phantom
ledger-effect half of idempotency) can only distinguish "a transfer this run
created" from "a transfer that appeared from nowhere" when the reset is inside
the recorded trace.

`parallel: 1` for the same reason — six cases sharing one fixture instance would
destroy each other's state.

## Reading a verdict

Every assertion detail starts with a stable token, so a round's results can be
split without reading prose:

| Token | Means |
|---|---|
| `VIOLATED` | A counterexample, with the oracle, the violation code, and the request index it happened on. The run is red and the trajectory is kept. |
| `HELD` | The rule was exercised and survived. |
| `NOT_EXERCISED` | The actor never reached a state where the rule is testable. Red, on purpose: an invariant that was never challenged has not held, and a green run that proved nothing is worse than a red one that says so. |
| `INCONCLUSIVE` | The gate saw an incomplete trace (see below) and found no violation in the part it could see. Re-score the finished run with the bench. |
| `NO_EVIDENCE` | The observing phase did not run for that assertion. A harness problem, not a product one. |

### Trace integrity

The harness forces `har.json` to flush before the observing phase, so
`gather()` sees every request entry recorded at that point. The assertions also
compare the HAR entries against the request indices in the trajectory as a
defensive check for synthetic, legacy, or otherwise incomplete traces.

An incomplete trace drops a suffix, so a violation found in its visible prefix
is still real and `VIOLATED` still fails. Only the "nothing found" branch
softens to `INCONCLUSIVE`; absent evidence cannot prove that a rule held or was
never exercised. The bench independently reads `har.json` after the run closes.

## Notes for a measured round

- **Freeze before measuring.** Persona, story text, and assertions are the
  instrument. Tune them only between declared rounds, only against the
  development faults, and never after exposure to the held-out set.
- **Re-sync the vendored copies** (`vendor/PROVENANCE.md`) before every round
  and record the result. If the probe's oracle and the bench's oracle have
  drifted apart, the arms are no longer comparable.
- **Credentials are throwaway.** The fixture's static bearer tokens appear
  verbatim in the persona. That is fine for a disposable local fixture with
  published defaults, and it is exactly what P2's secret references exist to fix
  before any authenticated real API is a target.
- **`results/` stays untracked.** An API baseline today persists request headers
  and bodies and the previous response body, which the artifact contract does
  not yet allow; the suite-local `.gitignore` keeps them out of history until P2
  lands.

## Running a round

`scripts/run-round.mjs` runs one build (clean or a single fault id) through a
set of stories, owning the fixture lifecycle: it refuses to start while another
Playtest run is alive, boots a dedicated fixture instance with the right
`LEDGER_FAULTS` toggle, runs the stories sequentially with `--fresh
--no-grade`, appends one row per run to the round's `manifest.jsonl`, and tears
the fixture down.

The fixture's entry script is passed in, never hardcoded: `studies/` may not
name the standalone examples tree (`tests/repository/boundaries.test.js`). On
this repository the path is `examples/ledger-api/server.js`:

```sh
export LEDGER_FIXTURE=examples/ledger-api/server.js

node studies/api-probe/scripts/run-round.mjs \
  --build clean --round studies/api-probe/rounds/<round> \
  --fixture "$LEDGER_FIXTURE" [--stories conservation,idempotency]
```

Runs take 6–16 minutes each, so a multi-build round is hours long. Start it
**detached** (`nohup zsh <plan>.sh &`), never as an agent background task — the
latter gets killed and takes the round with it. A round plan is a small shell
script beside its `manifest.jsonl`; see `rounds/dev-1/plan.sh`. The manifest is
append-only, so an interrupted round resumes at the next unrun build.

Score a round with the bench (labels are the build ids):

```sh
node examples/ledger-api/bench/bench.js \
  f-close-ghost=runs/<runId> clean=runs/<runId> …
```
