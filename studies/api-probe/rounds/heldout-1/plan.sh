#!/bin/zsh
# NOTE (committed form): the operator's scripts hardcoded the fixture tree's
# path. A study may not name the standalone examples tree in a shell script
# (tests/repository/boundaries.test.js), so the committed copies take it from
# $LEDGER_FIXTURE_DIR — set to the ledger fixture's directory — and are
# otherwise byte-for-byte what ran. Set it before re-running:
#   export LEDGER_FIXTURE_DIR=<the fixture directory named in the study README>
# heldout-1 — THE MEASURED ROUND (PREREGISTRATION.md "Procedure" step 3).
#
# Run by the sealed-round operator in the pinned execution worktree
# (/Users/jeremy/projects/playtest-p1, detached at the freeze commit b76aa8f,
# instrument pin 9059797) with ~/playtest-sealed/heldout-faults.patch applied.
# Nothing here tunes the instrument: it only chooses which builds each arm
# faces, exactly as PREREGISTRATION.md "Budgets / Which builds each arm runs"
# assigns them.
#
#   probe        every one of the six stories against every held-out build.
#                NO fault-knowledge story selection — that is the whole reason
#                the dev-1 numbers are excluded from the go/no-go.
#                5 builds x 6 stories = 30 Playtest runs.
#                (The clean-build probe sweep is rounds/clean-4/; not re-run.)
#   comparators  every held-out build + every development fault + the clean
#                build, both arms, wire-enforced 360-request budget.
#                14 builds x 2 arms + a second clean session per arm = 30.
#
# Executed detached (nohup zsh plan.sh > plan.log 2>&1 &) so a harness kill
# cannot take the round with it. `set -u` but deliberately NOT `set -e`: a
# single failed build must not abort the remaining hours of the round. The
# manifests are append-only, so an interrupted round resumes at the next
# unrun build.
set -u
cd /Users/jeremy/projects/playtest-p1 || exit 2

: "${LEDGER_FIXTURE_DIR:?set LEDGER_FIXTURE_DIR to the ledger fixture directory}"
export LEDGER_FIXTURE="$LEDGER_FIXTURE_DIR/server.js"
R=studies/api-probe/rounds/heldout-1
S=conservation,idempotency,lifecycle-legality,pagination-identity,error-shape,balance-agreement

HELD_OUT=(f-cursor-error-bare f-close-pending-inbound f-settle-failed-debit f-idempotency-day-expiry f-fee-double-charged)
DEV=(f-error-200 f-undocumented-500 f-fee-rounding-drift f-idempotency-replay-double f-settle-cancel-race f-close-ghost f-pagination-dup f-balance-cache-stale)

# ---------------------------------------------------------------- preflight --
# Loud, before anything measured runs. A round that starts on the wrong tree or
# a drifted oracle is worthless, and it would not be obvious for seven hours.
[[ "$(git rev-parse HEAD)" == "b76aa8f3c33e4b61d6c355845de45f970273f5a3" ]] || { echo "PREFLIGHT FAIL: not the freeze commit"; exit 2; }
[[ "$(shasum -a 256 studies/api-probe/vendor/oracles.js | cut -d' ' -f1)" == "04a3c69f516fbced95b4dafc93ced3754249b89c191cf3a61660b435ce76131c" ]] || { echo "PREFLIGHT FAIL: vendored oracles.js drifted"; exit 2; }
[[ "$(shasum -a 256 studies/api-probe/vendor/trace.js   | cut -d' ' -f1)" == "8d822ce60f55f86a45ca15a7154cafca73bf76d9b00943a7f98a8590edf0df64" ]] || { echo "PREFLIGHT FAIL: vendored trace.js drifted"; exit 2; }
diff -q studies/api-probe/vendor/oracles.js "$LEDGER_FIXTURE_DIR/bench/lib/oracles.js" >/dev/null || { echo "PREFLIGHT FAIL: probe and bench oracles differ"; exit 2; }
diff -q studies/api-probe/vendor/trace.js   "$LEDGER_FIXTURE_DIR/bench/lib/trace.js"   >/dev/null || { echo "PREFLIGHT FAIL: probe and bench trace differ"; exit 2; }
node -e 'import(process.env.LEDGER_FIXTURE_DIR+"/src/faults.js").then(m=>process.exit(m.FAULT_IDS.length===13&&m.HELD_OUT_FAULT_IDS.length===5?0:1))' || { echo "PREFLIGHT FAIL: sealed patch not applied (expect 13 faults, 5 held out)"; exit 2; }
curl -sf -m 5 -o /dev/null http://127.0.0.1:8900/v1/models || { echo "PREFLIGHT FAIL: codex gateway not answering on :8900"; exit 2; }
echo "preflight OK  $(date -u +%FT%TZ)"

mkdir -p $R

# ------------------------------------------------------- arm: comparators ----
# Seconds per session, so they run exhaustively. Ordered first: if the probe
# arm dies overnight the comparison still has its cheap half on disk.
comparators() { node studies/api-probe/comparators/run-comparators.mjs --round "$1" --fixture $LEDGER_FIXTURE --build "$2"; }

echo "\n########## ARM: comparators — $(date -u +%FT%TZ)"
for b in clean ${HELD_OUT[@]} ${DEV[@]}; do
  echo "\n--- comparators / $b — $(date -u +%FT%TZ)"
  comparators $R $b
done
# The clean build gets two sessions per arm (PREREGISTRATION.md "Budgets"), in
# a sibling directory so the second does not overwrite the first's artifacts.
# The bench label stays `clean` for both.
echo "\n--- comparators / clean (session 2) — $(date -u +%FT%TZ)"
comparators $R/clean-b clean
echo "COMPARATOR ARMS DONE $(date -u +%FT%TZ)" >> $R/status.log

# ------------------------------------------------------------- arm: probe ----
# One build at a time, one run at a time, ever. run-round.mjs owns the fixture
# lifecycle and refuses to start while another playtest run is alive.
echo "\n########## ARM: probe — $(date -u +%FT%TZ)"
for b in ${HELD_OUT[@]}; do
  echo "\n--- probe / $b (six stories) — $(date -u +%FT%TZ)"
  node studies/api-probe/scripts/run-round.mjs --round $R --fixture $LEDGER_FIXTURE --build $b --stories $S
  echo "PROBE BUILD DONE $b $(date -u +%FT%TZ)" >> $R/status.log
done

echo "HELDOUT-1 ROUND DONE $(date -u +%FT%TZ)" >> $R/status.log
echo "\n########## HELDOUT-1 ROUND DONE — $(date -u +%FT%TZ)"
