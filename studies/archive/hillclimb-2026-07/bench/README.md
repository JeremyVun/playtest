# Hill-climb Bench

Zero-dependency ESM scripts for turning Playtest run artifacts into an auditable hill-climb study ledger, matrix, evidence lint, and static report site. The bench is study-local and does not import from `src/**`.

## Scripts

- `preflight.mjs` records the round fingerprint: app reset, fault-set hash, gateway health, usage-limit log hits, git state, and model pins.
- `collect.mjs` walks run artifact directories and emits normalized `runs` and `findings`.
- `adjudicate.mjs` creates or merge-updates `ledger/<arm>/round-NN.json`, preserving unmapped findings and enforcing judgment rules.
- `validate.mjs` validates ledger entries and `faults.json`.
- `lint-evidence.mjs` verifies that run dirs, cited step screenshots, fix commits, regression stories, and fault ids resolve.
- `matrix.mjs` computes detection counts, masking-aware recall, precision, convergence, cost, clean-round, signal, and accounting tables.
- `site.mjs` builds the self-contained static report site and copies only cited screenshots.
- `evidence-bundle.mjs` snapshots the ledgers, specification, stories, and repair records into the report's self-contained evidence reader.

## Round Procedure

```sh
node studies/hillclimb/bench/preflight.mjs --arm naive --round 1 --app-dir studies/hillclimb/arms/naive --base-url http://127.0.0.1:3000 --gateway http://127.0.0.1:8900 --gateway-log "${CODEX_GATEWAY_ROOT:-../codex-gateway}/gateway.log" --out /tmp/naive-r01-fp.json

# Run the frozen Playtest suite for the round.

node studies/hillclimb/bench/collect.mjs --runs-root /path/to/runs --run <run-id> --out /tmp/naive-r01-collected.json
node studies/hillclimb/bench/adjudicate.mjs --arm naive --round 1 --collected /tmp/naive-r01-collected.json --fingerprint /tmp/naive-r01-fp.json --judgments /tmp/naive-r01-judgments.json --fixes /tmp/naive-r01-fixes.json --verification /tmp/naive-r01-verification.json --instrument /tmp/instrument.json --ledger-dir studies/hillclimb/ledger
node studies/hillclimb/bench/lint-evidence.mjs --ledger-dir studies/hillclimb/ledger --runs-root /path/to/runs --repo .
node studies/hillclimb/bench/matrix.mjs --ledger-dir studies/hillclimb/ledger --faults studies/hillclimb/faults.json --out /tmp/matrix.json --md /tmp/matrix.md
node studies/hillclimb/bench/site.mjs --ledger-dir studies/hillclimb/ledger --faults studies/hillclimb/faults.json --runs-root /path/to/runs --out studies/hillclimb/report
node studies/hillclimb/bench/evidence-bundle.mjs --study-dir studies/hillclimb --out studies/hillclimb/report/evidence-data.js
```

## Clean-round definition (BUILD_PLAN P3 / DESIGN.md §6)

`adjudicate.mjs` writes `clean_round` via `computeCleanRound` in `lib/contracts.mjs`.
Validation re-derives the same value — **documented definition must match the writer.**

| Arms | Definition |
|---|---|
| **v1** (`shakedown`, `baseline`, `naive`, `policy`) | Zero `true-positive` and zero `new-real-issue`, and `verification.regression_green`. **Does not** count `emergent`. Historical `clean_round` flags are **not** retro-rewritten. |
| **v2+** (`v2-baseline`, `v2-policy`, and later climb arms) | Zero `true-positive`, zero `new-real-issue`, **zero `emergent`**, and regressions green. |

Stop rule for climbs under instrument v2: two consecutive clean rounds under the **v2** definition.

## Accounting taxonomy (not one “FP” dump)

Matrix `by_arm.<arm>.accounting_summary` (and the site accounting page) separates:

| Field | Meaning |
|---|---|
| `detected` | Distinct catalog faults with ≥1 true-positive in the arm |
| `found_and_fixed` / `found_and_accepted` | Detected and repaired (or ACCEPTED) |
| `fixed_without_detection` | Fix recorded in the arm with **no** true-positive in that arm (class-generalization / inspection) |
| `residual` | Still live (`missed` after clean, or `not-yet`) |
| `label_counts` | DESIGN.md §3.2 labels from verdict + `[label]` in rationale: `seeded-tp`, `emergent`, `spec-gap`, `soft-ux`, `subject-quirk`, `harness-artifact`, `false` |

Per-round `label_counts` live on each `by_arm.<arm>.rounds[]` entry.

## Rule

No hand-assembled synthesis: numbers, tables, charts, and evidence links come from `collect`, `adjudicate`, `lint-evidence`, `matrix`, and `site`. Prose may explain the result, but it must not replace ledger-backed accounting.
