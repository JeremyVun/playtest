# Brief: author a script suite for the minibank ledger API

You are testing an HTTP API you have never seen the source of. Your job is to
write one script suite that tries to prove the stated business rules wrong —
and that accounts for every obligation the rules and the API surface create.

This brief is part of a frozen study instrument. Follow it exactly; where it
is silent, `handout/CLIENT.md` is the authority on the script contract.

## What you are given, and nothing else

- `handout/openapi.json` — the service's OpenAPI document (also served live at
  `GET /openapi.json`).
- `handout/INVARIANTS.md` — the invariant statements: the rule, where it
  applies, and its declared exceptions.
- `handout/CLIENT.md` — the script contract: the entry shape, the injected
  `client`, the `check` API, the report, and the obligation manifest.
- A live instance to develop against, at the base URL in `$TRIAL_BASE_URL`.
- A run command, `./run.sh` in your scratch directory: it executes your
  `suite.mjs` through the study's runner and leaves `run-out/script-report.json`
  and `run-out/har.json` for you to read. The runner, not your code, records
  traffic and enforces the budget.
- Credentials exist only as secret references (see `CLIENT.md`); the admin
  reference unlocks `/admin/*`. You can cause an authenticated request; you can
  never read the credential value, and trying to is a defect.

## Hard rules

1. **Do not read, list, search, or open any file outside your scratch
   directory** (the directory containing this brief). The service's source,
   its tests, and the study that commissioned this suite live in a repository
   you must not look at. Executing `./run.sh` is allowed; reading what it
   points at is not. If you are unsure whether a path is in bounds, it is not.
2. Do not search the web.
3. All traffic goes through the injected `client`. Ambient `fetch`,
   `node:http`, and friends are blocked by the runner and recorded as defects.
4. You may iterate freely against the dev instance within your authoring
   budget (below). Start every execution from a known state:
   `POST /admin/reset` with body `{"seed":"ledger-dev-seed"}` through the
   client. The service is deterministic under a seed.

## What to build

`suite.mjs` — plain Node 20+ ESM, zero dependencies, default-exporting the
contract entry:

```js
export default async function suite({ client, check, params }) { … }
```

Requirements:

- **Soundness is the termination condition, not green checks.** The runner
  derives an obligation manifest from the handout: every invariant statement
  where it applies, the default policy set, and every spec operation. Your
  suite must leave nothing unaccounted — each obligation is covered by an
  exercised check, or explicitly skipped with a reason a reviewer would
  accept. An unaccounted obligation makes the run unsound (exit 2) no matter
  how many checks passed.
- **A failing check is a finding, not a bug in your suite.** When a check
  fails, re-read its evidence in `run-out/har.json`. Revise the check only if
  the expectation was wrong, and record in `TRANSCRIPT.md` the exact spec
  fragment or invariant statement that justifies the revision. A genuine
  violation stays in the suite, failing, with its evidence — the API being
  broken is a supported outcome.
- Budget: one execution must stay under the runner's wire-enforced request
  budget of **360**; print nothing yourself — the report carries the count.
  Authoring in total: at most **12 executions** and the wall-clock and request
  ceilings in `handout/CLIENT.md`.
- Every check cites its evidence (`har_entries`) so a reader can resolve the
  exact exchanges that prove it. A failing check that cites nothing scores as
  nothing.
- Prefer checks that reach real state (create, activate, fund, transfer,
  settle, close, paginate — in both currencies, at boundaries, across
  principals) over checks that only inspect the shape of one response. The
  suite runs unattended against builds you have never seen, some deliberately
  defective: write it so a failure is informative and a pass means something.
- Deterministic ordering; no check depends on another beyond the initial
  reset. Robust to a misbehaving service: a 500, a malformed body, a missing
  field, or a hang must produce a clear check failure, never an unhandled
  crash.

## Also write

`TRANSCRIPT.md` — the authoring record, and study evidence that gets
published: what you understood each rule to mean, the sequences you chose and
why, every check revision with its citing justification, what you tried that
did not work, roughly how long it took, and anything that surprised you.
State explicitly whether you read anything outside your scratch directory.

## Done means

`./run.sh` on the instance you were given exits sound — every obligation
accounted for, no script defects — with your genuine findings (if any) left
failing with evidence, and `TRANSCRIPT.md` exists. Report the execution count
you used, the final request count, and the wall-clock time.
