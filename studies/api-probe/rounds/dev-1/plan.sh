#!/bin/zsh
# dev-1 round plan — executed detached (nohup) so harness kills can't stop it.
# LEDGER_FIXTURE must point at the ledger fixture's server entry script; a
# study may not name the standalone examples tree (repository boundary), so the
# caller supplies it. See ../../README.md for the concrete path.
set -u
cd /Users/jeremy/projects/playtest
: "${LEDGER_FIXTURE:?set LEDGER_FIXTURE to the fixture server entry script}"
R=studies/api-probe/rounds/dev-1
RUN="node studies/api-probe/scripts/run-round.mjs --round $R --fixture $LEDGER_FIXTURE"
$RUN --build f-error-200 --stories error-shape
$RUN --build f-undocumented-500 --stories error-shape
$RUN --build f-fee-rounding-drift --stories conservation
$RUN --build f-idempotency-replay-double --stories idempotency
$RUN --build f-settle-cancel-race --stories lifecycle-legality
$RUN --build f-close-ghost --stories lifecycle-legality
$RUN --build f-pagination-dup --stories pagination-identity
$RUN --build f-balance-cache-stale --stories balance-agreement
$RUN --build clean --stories idempotency,lifecycle-legality,pagination-identity,error-shape,balance-agreement
echo "DEV ROUND DONE $(date -u +%FT%TZ)" >> $R/manifest.jsonl
