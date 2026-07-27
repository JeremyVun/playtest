# Hill-climb study archive — July 2026

This is the immutable record of the original Fern & Fog seeded-fault study and
its instrument-v2 follow-on. It originally lived at `studies/hillclimb/`.
Current work is specified in
[`docs/backlog/hillclimb-rerun.md`](../../../docs/backlog/hillclimb-rerun.md).

Do not treat this directory as the current study or run its old operator
commands against today's harness. Reproduce an old round from its recorded
freeze commit in a separate worktree.

## What was tested

The study injected 26 known faults into a purpose-built plant shop, ran
Playtest blind against the broken app, adjudicated findings against the hidden
catalog, and let blind fixers repair separate copies. The follow-on changed the
instrument from natural-path discovery with `gpt5_4_mini` to Grok 4.5,
forced-risk stories, an adversarial persona, gateway `:8900`, actor raises, and
stricter accounting.

| Result | Outcome |
|---|---|
| Original detection | 14/26 faults, 54% |
| Instrument v2 round 1 | 19/26, 73% |
| Instrument v2 round 2 | 21/26, 81%; cleared the 75% target |
| Original naive repair arm | 16/26 resolved; 11 emergent regression findings |
| Original policy repair arm | 20/26 resolved; zero emergent regression findings |
| V2 policy repair attempt | All 26 manifestations fixed, but two live clean rounds were not completed after gateway authentication failed |

The main causal lesson was coverage: most misses occurred because a story never
entered the state that exposed the fault. Forced-risk authoring and the
adversarial persona generalized that result into the shipped
`playtest-bughunt` skill. The study also established that:

- “clean” means clean under the exercised suite, never bug-free;
- catalog false positives must be separated from real spec gaps, soft UX,
  subject quirks, harness artifacts, and contradicted claims;
- detected faults, fixes found through code inspection, and emergent
  regressions need separate accounting;
- evidence-gated repair with a forced regression pin per fix was safer than
  fixing every plausible complaint.

## Why this cannot be the new benchmark

The old 26 faults are now known to the repository's risk taxonomy, personas,
stories, reports, and authoring skill. Re-running them remains useful as a
calibration check, but using them as the headline benchmark would reward the
product for lessons explicitly derived from their manifestations.

The redesigned study therefore uses a new subject or materially new surface, a
fresh blind holdout catalog, and hidden trigger telemetry that separates
“never exercised” from “exercised but not recognized.”

## Evidence map

| Artifact | Purpose |
|---|---|
| [`PREREGISTRATION.md`](./PREREGISTRATION.md) | Original hypotheses and freeze rules |
| [`OPERATOR.md`](./OPERATOR.md) | Original operating procedure and protocol amendments |
| [`report/REPORT.md`](./report/REPORT.md) | Full v1 synthesis |
| [`report/WRITEUP-v2-r02.md`](./report/WRITEUP-v2-r02.md) | Final 81% detection rerun |
| [`report/WRITEUP-v2-policy.md`](./report/WRITEUP-v2-policy.md) | Incomplete v2 repair climb |
| [`ledger/`](./ledger/) | Committed per-round evidence |
| [`suite/`](./suite/) | Frozen v1/v2 stories and personas |
| [`subject/`](./subject/) and [`faults.json`](./faults.json) | Clean subject and old calibration catalog |
| [`bench/`](./bench/) | Historical collection/adjudication/report tooling |

Generated screenshot galleries remain ignored because they can be regenerated
from the original local runs. Git history remains the authority for deleted
planning commentary and exact original paths.
