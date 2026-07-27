#!/bin/zsh
# NOTE (committed form): the operator's scripts hardcoded the fixture tree's
# path. A study may not name the standalone examples tree in a shell script
# (tests/repository/boundaries.test.js), so the committed copies take it from
# $LEDGER_FIXTURE_DIR — set to the ledger fixture's directory — and are
# otherwise byte-for-byte what ran. Set it before re-running:
#   export LEDGER_FIXTURE_DIR=<the fixture directory named in the study README>
# heldout-1, probe arm — relaunch after an operator-side infrastructure failure.
#
# WHAT HAPPENED (recorded here because the round's honesty depends on it):
# plan.sh ran both comparator arms to completion (30 sessions) and then refused
# all five probe builds within the same second, each with
#
#     another playtest run is alive (pids: 18340); refusing to start
#
# No Playtest run was alive. run-round.mjs's exclusivity guard is
# `pgrep -f "cli.js run"`, which matches ANY process whose command line contains
# that substring — including the operator's own progress-check shell, which was
# literally `pgrep -fl "cli.js run"` and was alive across the whole window.
# Verified afterwards: `zsh -c "sleep 6; : cli.js run"` is matched by the same
# pgrep. Zero probe runs were consumed (no manifest.jsonl was even created), so
# nothing measured was lost or contaminated; the comparator data on disk stands.
#
# The instrument is frozen, so run-round.mjs is NOT modified. The fix is
# operator-side and lives here, in the round plan:
#   1. the guard is treated as retryable — a refused build is re-attempted
#      rather than silently skipped, so no assigned build can go unrun;
#   2. the operator monitors this round through files only, never with a
#      command containing the guard's pattern.
#
# Probe arm, per PREREGISTRATION.md "Budgets / Which builds each arm runs":
# every one of the six stories against every held-out build, no fault-knowledge
# story selection. 5 builds x 6 stories = 30 Playtest runs, ~6-16 min each.
# The clean-build probe sweep is rounds/clean-4/ and is not re-run.
#
# Detached: nohup zsh plan-probe.sh > plan-probe.log 2>&1 &
set -u
cd /Users/jeremy/projects/playtest-p1 || exit 2

: "${LEDGER_FIXTURE_DIR:?set LEDGER_FIXTURE_DIR to the ledger fixture directory}"
export LEDGER_FIXTURE="$LEDGER_FIXTURE_DIR/server.js"
R=studies/api-probe/rounds/heldout-1
S=conservation,idempotency,lifecycle-legality,pagination-identity,error-shape,balance-agreement
HELD_OUT=(f-cursor-error-bare f-close-pending-inbound f-settle-failed-debit f-idempotency-day-expiry f-fee-double-charged)

# ---------------------------------------------------------------- preflight --
[[ "$(git rev-parse HEAD)" == "b76aa8f3c33e4b61d6c355845de45f970273f5a3" ]] || { echo "PREFLIGHT FAIL: not the freeze commit"; exit 2; }
[[ "$(shasum -a 256 studies/api-probe/vendor/oracles.js | cut -d' ' -f1)" == "04a3c69f516fbced95b4dafc93ced3754249b89c191cf3a61660b435ce76131c" ]] || { echo "PREFLIGHT FAIL: vendored oracles.js drifted"; exit 2; }
[[ "$(shasum -a 256 studies/api-probe/vendor/trace.js   | cut -d' ' -f1)" == "8d822ce60f55f86a45ca15a7154cafca73bf76d9b00943a7f98a8590edf0df64" ]] || { echo "PREFLIGHT FAIL: vendored trace.js drifted"; exit 2; }
diff -q studies/api-probe/vendor/oracles.js "$LEDGER_FIXTURE_DIR/bench/lib/oracles.js" >/dev/null || { echo "PREFLIGHT FAIL: probe and bench oracles differ"; exit 2; }
diff -q studies/api-probe/vendor/trace.js   "$LEDGER_FIXTURE_DIR/bench/lib/trace.js"   >/dev/null || { echo "PREFLIGHT FAIL: probe and bench trace differ"; exit 2; }
node -e 'import(process.env.LEDGER_FIXTURE_DIR+"/src/faults.js").then(m=>process.exit(m.FAULT_IDS.length===13&&m.HELD_OUT_FAULT_IDS.length===5?0:1))' || { echo "PREFLIGHT FAIL: sealed patch not applied"; exit 2; }
curl -sf -m 5 -o /dev/null http://127.0.0.1:8900/v1/models || { echo "PREFLIGHT FAIL: codex gateway not answering on :8900"; exit 2; }
echo "preflight OK  $(date -u +%FT%TZ)"

mkdir -p $R

# One build at a time, one run at a time, ever. A build that is refused by the
# exclusivity guard is retried, not skipped: skipping would leave a hole in the
# measured set, which is exactly the failure this round just survived.
run_build() {
  local b=$1 attempt=1 log
  while (( attempt <= 30 )); do
    log=$R/probe-$b-attempt$attempt.log
    echo "\n--- probe / $b (six stories), attempt $attempt — $(date -u +%FT%TZ)"
    node studies/api-probe/scripts/run-round.mjs --round $R --fixture $LEDGER_FIXTURE --build $b --stories $S 2>&1 | tee $log
    if grep -q "refusing to start" $log; then
      echo "!! exclusivity guard tripped on $b (attempt $attempt) — waiting 120s and retrying"
      echo "GUARD TRIPPED $b attempt=$attempt $(date -u +%FT%TZ)" >> $R/status.log
      sleep 120
      (( attempt++ ))
      continue
    fi
    echo "PROBE BUILD DONE $b $(date -u +%FT%TZ)" >> $R/status.log
    return 0
  done
  echo "!! GIVING UP on $b after $attempt attempts"
  echo "PROBE BUILD ABANDONED $b $(date -u +%FT%TZ)" >> $R/status.log
  return 1
}

echo "\n########## ARM: probe — $(date -u +%FT%TZ)"
for b in ${HELD_OUT[@]}; do
  run_build $b
done

echo "HELDOUT-1 PROBE ARM DONE $(date -u +%FT%TZ)" >> $R/status.log
echo "\n########## HELDOUT-1 PROBE ARM DONE — $(date -u +%FT%TZ)"
