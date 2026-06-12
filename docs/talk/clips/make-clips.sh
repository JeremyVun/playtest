#!/usr/bin/env bash
# Regenerate the talk's backup clips (VERSION_1.1 item 2): one burned,
# self-contained webm per demo act, cut from the todos/add-todo run.
# The execution order is explicit: never present without the recording.
#
# Needs a full ffmpeg (subtitles+drawtext). Slim builds (Homebrew's default
# formula) won't do: brew install ffmpeg-full, then
#   PLAYTEST_FFMPEG="$(brew --prefix ffmpeg-full)/bin/ffmpeg" ./make-clips.sh
#
# Usage: ./make-clips.sh [existing-demo-runs-root]
# Without an argument, runs `playtest demo --keep` first (~30s, no keys).
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(git rev-parse --show-toplevel)"
PLAYTEST="node $REPO/src/harness/cli.js"

ROOT="${1:-}"
if [ -z "$ROOT" ]; then
  KEEP_DIR=$($PLAYTEST demo --keep | tee /dev/stderr | sed -n 's/^demo directory retained (--keep): //p')
  [ -n "$KEEP_DIR" ] || { echo "could not find the demo's retained directory in its output" >&2; exit 1; }
  ROOT="$KEEP_DIR/runs"
fi

# Acts in started_at order: 1 record, 2 act/checked, 3 heal. Thought captions
# narrate acts 1 and 3 (the agent's story); act 2's replay gets action captions.
i=0
for STYLE in thought action thought; do
  i=$((i + 1))
  RUN=$(ls "$ROOT" | sort | sed -n "${i}p")
  $PLAYTEST clip "$ROOT/$RUN/todos/add-todo" --captions "$STYLE" --burn \
    --out "$PWD/act$i-add-todo.webm"
done
echo "backup clips written to $PWD"
