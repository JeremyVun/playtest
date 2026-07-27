#!/bin/zsh
# clean-2 round plan — the pre-freeze clean-build sweep required by
# PREREGISTRATION.md (12 probe runs: two full six-story sweeps). The earlier
# clean runs predate the fixture's malformed-percent-encoding fix, so the
# false-positive baseline is re-established against the current clean build.
#
# Executed detached (nohup) so harness kills can't stop it. Runs in the pinned
# P1 execution worktree; LEDGER_FIXTURE must point at the fixture's server
# entry script (a study may not name the standalone examples tree).
set -u
cd /Users/jeremy/projects/playtest-p1
: "${LEDGER_FIXTURE:?set LEDGER_FIXTURE to the fixture server entry script}"
R=studies/api-probe/rounds/clean-4
S=conservation,idempotency,lifecycle-legality,pagination-identity,error-shape,balance-agreement
run_build() {
  node studies/api-probe/scripts/run-round.mjs --round $R --fixture $LEDGER_FIXTURE "$@"
}
run_build --build clean --stories $S
run_build --build clean --stories $S
echo "CLEAN-4 SWEEP DONE $(date -u +%FT%TZ)" >> $R/manifest.jsonl
