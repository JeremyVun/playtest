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

# Acts are selected by their manifest mode (record / act / heal), never by
# run-id order: ids are minute-precision + random hex, so same-minute acts
# sort arbitrarily. Thought captions narrate acts 1 and 3 (the agent's
# story); act 2's replay gets action captions.
act_run() { # <mode> -> run id under $ROOT whose add-todo manifest has that mode
  node -e '
    const fs = require("fs"), path = require("path");
    const [root, mode] = process.argv.slice(1);
    for (const id of fs.readdirSync(root)) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(root, id, "todos/add-todo/manifest.json"), "utf8"));
        if (m.mode === mode) { console.log(id); process.exit(0); }
      } catch {}
    }
    console.error(`no ${mode} run under ${root}`); process.exit(1);
  ' "$ROOT" "$1"
}

i=0
for ACT in record:thought act:action heal:thought; do
  i=$((i + 1))
  MODE="${ACT%%:*}" STYLE="${ACT##*:}"
  RUN=$(act_run "$MODE")
  $PLAYTEST clip "$ROOT/$RUN/todos/add-todo" --captions "$STYLE" --burn \
    --out "$PWD/act$i-add-todo.webm"
done
echo "backup clips written to $PWD"
