# substrate-parity

The S1 exit-gate check that cannot be a unit test: the P1 agent-authored suite,
ported to the script contract (`docs/contracts/scripts.md`) and executed through
the new runner, must be scored by the bench the way P1 scored it. If it is not,
the substrate changed the instrument and no S0 measurement taken on it means
what it says.

- `suite/` — the ported arm. `lib/api.mjs`, `lib/expect.mjs`, `lib/ledger.mjs`
  and `scenarios/*` are byte-for-byte the frozen P1 arm; `lib/client.mjs`,
  `lib/report.mjs` and `index.mjs` are the adaptation, each documented in place.
- `run-parity.mjs` — boots the fixture per build, runs the suite through the
  runner, scores both columns with the bench, and compares against the recorded
  P1 result.
- `RESULTS.md` — the recorded outcome, its pins, and the three substrate
  differences the result had to survive.
- `out/` — generated, gitignored.

This directory is study apparatus for S1. It is not the S0 study: S0's
preregistration and rounds live beside it under `studies/api-suite/`.
