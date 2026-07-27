# Script fixtures

Each file is a Playtest script written against
`docs/contracts/scripts.md#the-entry-contract` and drives the loopback
`../script-api/server.ts`. They exist to prove one behaviour of the substrate
each — a passing suite, a failing check, a script defect, a fabricated citation,
an under-covered manifest, a guard refusal — so the tests assert against real
executions rather than against a mocked runner.

`obligations` ids used here: `rule:health`, `rule:items`, `rule:auth`,
`rule:mutation`, and the derived `policy:*` entries.
