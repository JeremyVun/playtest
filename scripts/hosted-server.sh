#!/usr/bin/env bash
# Local boot for the hosted control plane, the packaged web console, and one
# peer runner. One command, no prerequisites beyond
# `npm install`: no database service, no container, no cloud.
#
#   scripts/hosted-server.sh            # API + console on http://127.0.0.1:4177
#   scripts/hosted-server.sh migrate    # apply SQL migrations and exit
#   npm run hosted                      # the same thing through npm
#
# There is ONE placement model, so local development does not get a private one:
# a launch posts to the claim board and a runner claims it, here exactly as on a
# build box or in CI. This script therefore supervises `runner-agent pool` beside
# the server, against the site-scoped `local` runner the control plane registers
# under dev auth. The server never starts it per job and never connects to it —
# the agent dials out, like every other runner.
#
# What it does for you, in order:
#   1. checks Node is new enough for node:sqlite,
#   2. installs missing dependencies and emits browser JavaScript,
#   3. loads the repo-root .env (gitignored) without letting it clobber anything
#      you set on the command line,
#   4. keeps one durable data root, one local KMS key, and one runner config file,
#   5. takes port 4177 back from a Playtest server left running by an earlier
#      session (and refuses to touch anything that is not one),
#   6. prints what is switched on — including whether the model gateway is
#      configured, which is the difference between "Help me draft" working and
#      answering 503 not_configured,
#   7. starts the control plane and the peer runner, and stops both together.
#
# Everything is an override: `PORT=4188 scripts/hosted-server.sh` wins over .env,
# which wins over the defaults here. PLAYTEST_DATA_DIR is the single storage
# knob — it holds playtest.sqlite, the object store, and the dev KMS key.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${PLAYTEST_ENV_FILE:-$REPO/.env}"

case "${1:-}" in
  -h|--help)
    awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
    exit 0
    ;;
esac

# ---- 1. Node ---------------------------------------------------------------
# The repository runs on Node 24 LTS. A
# server that boots and then dies on its first query is a worse failure than
# refusing here with the version you have.
node_ver="$(node --version 2>/dev/null || echo none)"
if [ "$node_ver" = none ]; then
  echo "hosted-server: Node is not on PATH. Install Node 24.18 or newer." >&2
  exit 2
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);
  if (a<24 || (a===24 && b<18)) { console.error(`hosted-server: Playtest needs Node >= 24.18; this is ${process.version}.`); process.exit(2); }'

# ---- 2. dependencies -------------------------------------------------------
if [ ! -d "$REPO/node_modules" ] || [ ! -e "$REPO/node_modules/@playtest/control-plane" ]; then
  echo "hosted-server: installing dependencies (first run only)…" >&2
  (cd "$REPO" && npm install)
fi

# Build both Vite applications on every entry so the hosted console and its
# embedded viewer can never be stale relative to their sources.
(cd "$REPO" && npm run build:web)

# ---- 3. .env ---------------------------------------------------------------
# Sourced, not hand-parsed, so quoted and multi-line values survive intact.
# Anything already exported by the caller is re-applied afterwards, so an inline
# override on the command line still beats the file.
if [ -f "$ENV_FILE" ]; then
  pre_set="$(export -p | grep -E '^(declare -x|export) (PLAYTEST_|PORT=|HOST=|PUBLIC_URL=|LOG_LEVEL=|OBJECT_STORE_)' || true)"
  set -a +u
  # shellcheck disable=SC1090
  . "$ENV_FILE" || {
    echo "hosted-server: could not load $ENV_FILE — it must be shell-sourceable KEY=value lines." >&2
    exit 2
  }
  set +a -u
  if [ -n "$pre_set" ]; then eval "$pre_set"; fi
  env_note="$ENV_FILE"
else
  env_note="(none — create $ENV_FILE for local secrets)"
fi

# ---- 4. settings -----------------------------------------------------------
DATA_DIR="${PLAYTEST_DATA_DIR:-$REPO/.playtest-data}"
KMS_FILE="${PLAYTEST_KMS_FILE:-$DATA_DIR/kms.b64}"
# Written by the control plane at boot (src/dev-runner.ts), read by the agent.
RUNNER_CRED_FILE="$DATA_DIR/local-runner.credential"
RUNNER_CONFIG_FILE="$DATA_DIR/runner.yaml"
RUNNER_WORK_DIR="$DATA_DIR/runner-work"

export PLAYTEST_DATA_DIR="$DATA_DIR"
export PLAYTEST_AUTH="${PLAYTEST_AUTH:-dev}"
export PORT="${PORT:-4177}"
export HOST="${HOST:-127.0.0.1}"

mkdir -p "$DATA_DIR"
# The KMS key encrypts stored secrets, so it has to be the SAME key next boot or
# every environment secret in the database becomes undecryptable. It lives with
# the data it protects, and is generated once.
if [ -z "${PLAYTEST_KMS_KEY:-}" ]; then
  if [ ! -f "$KMS_FILE" ]; then
    (umask 077 && openssl rand -base64 32 > "$KMS_FILE")
    echo "hosted-server: wrote a new local KMS key → $KMS_FILE" >&2
  fi
  PLAYTEST_KMS_KEY="$(cat "$KMS_FILE")"
  export PLAYTEST_KMS_KEY
fi

# The peer runner's config file. Seeded COMMENTED-OUT and left alone forever
# after: a web or API ring needs nothing in here, because its URL is evaluated
# from this machine's own network position and travels with the job. What only
# this machine can know — a mobile build's path, its Appium backend, its device —
# is what the file is for, and uncommenting three lines is the whole of mobile
# setup. An all-comments file is a valid empty configuration.
if [ ! -f "$RUNNER_CONFIG_FILE" ]; then
  cat > "$RUNNER_CONFIG_FILE" <<'RUNNER_CONFIG'
# Playtest runner configuration — this machine's own facts, never uploaded.
#
# Nothing here is needed for web or API runs: a ring carries its own URL, and
# this runner evaluates it from where it is standing, so "http://127.0.0.1:4173"
# means a server on THIS machine.
#
# What belongs here is what no platform record may hold: where a mobile build
# lives on this disk, which Appium backend runs it, and which device it targets,
# bound to the project, application, and environment keys you see in the console.
#
# To run a mobile suite, uncomment everything below and set `app` to your build.
# version: 1
#
# targets:
#   - project: acme                 # the project key in the console URL
#     application: todo-ios         # the application key
#     environment: local            # the environment key
#     platform: ios                 # ios | android
#     app: /Users/you/build/Todo.app
#     backend: local-ios
#     # device: iPhone 16           # optional; Appium's default otherwise
#
# mobile:
#   backends:
#     local-ios:
#       platform: ios
#       appium:
#         mode: managed             # this runner starts and stops Appium itself
#         # mode: external          # …or dial one you already run:
#         # url: http://127.0.0.1:4723
#         # credential_file: /path/to/credential   # never a literal value here
#
# labels: [macbook, ios]            # optional; replaces --labels, never merged
RUNNER_CONFIG
  echo "hosted-server: seeded a runner config file → $RUNNER_CONFIG_FILE" >&2
fi

# ---- 5. the port -----------------------------------------------------------
# A server left running by an earlier session otherwise turns every restart into
# an EADDRINUSE stack trace, and — worse — leaves you testing yesterday's code
# against today's source. Reclaim the port when what holds it is a Playtest
# control plane from THIS checkout; never touch anything else.
looks_like_playtest() {
  local pid="$1" cwd
  # Its own console answers on /: the SPA shell, before any authentication.
  if curl -fsS -m 2 "http://$HOST:$PORT/" 2>/dev/null | grep -q "Loading Playtest"; then
    return 0
  fi
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  case "$cwd" in "$REPO"|"$REPO"/*) return 0 ;; esac
  return 1
}

if command -v lsof >/dev/null 2>&1; then
  holders="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$holders" ]; then
    for pid in $holders; do
      if ! looks_like_playtest "$pid"; then
        echo "hosted-server: port $PORT is held by pid $pid, which is not a Playtest server from this checkout:" >&2
        ps -o pid=,command= -p "$pid" >&2 || true
        echo "hosted-server: stop it yourself, or run with a different PORT." >&2
        exit 1
      fi
    done
    echo "hosted-server: replacing the Playtest server already on port $PORT (pid $(echo "$holders" | tr '\n' ' ' | sed 's/ $//'))…" >&2
    # shellcheck disable=SC2086
    kill $holders 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      still="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
      [ -z "$still" ] && break
      sleep 0.5
    done
    still="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    # shellcheck disable=SC2086
    [ -n "$still" ] && kill -9 $still 2>/dev/null || true
  fi
fi

# ---- 6. say what is on -----------------------------------------------------
cmd="${1:-serve}"
if [ "$cmd" = "serve" ]; then
  {
    echo
    echo "  Playtest console  http://$HOST:$PORT"
    echo "  env file          $env_note"
    echo "  data root         $DATA_DIR"
    echo "  auth              $PLAYTEST_AUTH"
    if [ "$PLAYTEST_AUTH" = dev ]; then
      echo "  placement         the claim board — a peer runner starts beside the server"
      echo "  runner config     $RUNNER_CONFIG_FILE"
    else
      echo "  placement         the claim board — register a runner and start runner-agent pool"
    fi
    if [ -n "${PLAYTEST_LLM_BASE_URL:-}" ]; then
      if [ -n "${PLAYTEST_LLM_API_KEY:-}" ]; then
        echo "  model gateway     $PLAYTEST_LLM_BASE_URL (key set)"
      else
        echo "  model gateway     $PLAYTEST_LLM_BASE_URL — no PLAYTEST_LLM_API_KEY set"
      fi
    else
      echo "  model gateway     off — Help me draft, study synthesis and consolidation"
      echo "                    will answer 503 not_configured. Set PLAYTEST_LLM_BASE_URL"
      echo "                    and PLAYTEST_LLM_API_KEY in $ENV_FILE to switch them on."
    fi
    echo
  } >&2
fi

cd "$REPO/packages/platform/control-plane"
if [ "$cmd" != "serve" ]; then
  exec node src/index.ts "$@"
fi

# ---- 7. the two processes --------------------------------------------------
# The control plane and one peer runner, started together and stopped together.
# Only under dev auth: site scope is a trust grant, and the credential the agent
# below reads is one the control plane only mints when the dev admin bypass has
# already handed the same reader admin over every project.
node src/index.ts &
SERVER_PID=$!
RUNNER_PID=""

stop_all() {
  trap - INT TERM EXIT
  if [ -n "$RUNNER_PID" ]; then kill "$RUNNER_PID" 2>/dev/null || true; fi
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  if [ -n "$RUNNER_PID" ]; then wait "$RUNNER_PID" 2>/dev/null || true; fi
}
trap 'stop_all; exit 0' INT TERM
trap stop_all EXIT

if [ "$PLAYTEST_AUTH" = dev ]; then
  mkdir -p "$RUNNER_WORK_DIR"
  (
    # The agent's own backoff covers a control plane that is not listening yet,
    # but not a credential that does not exist yet — reading one is a startup
    # error by design, so the file is what this waits for. The server writes it
    # before it listens, so on every boot after the first this returns at once.
    child=""
    trap 'if [ -n "${child:-}" ]; then kill "$child" 2>/dev/null || true; fi; exit 0' INT TERM
    tries=0
    while [ ! -s "$RUNNER_CRED_FILE" ] && [ "$tries" -lt 120 ]; do
      kill -0 "$SERVER_PID" 2>/dev/null || exit 0
      sleep 0.5
      tries=$((tries + 1))
    done
    if [ ! -s "$RUNNER_CRED_FILE" ]; then
      echo "hosted-server: the control plane never wrote $RUNNER_CRED_FILE, so no runner started — launches will sit unclaimed." >&2
      exit 0
    fi
    while kill -0 "$SERVER_PID" 2>/dev/null; do
      node "$REPO/packages/platform/runner-agent/src/cli.ts" pool \
        --server "http://$HOST:$PORT" \
        --credential-file "$RUNNER_CRED_FILE" \
        --config "$RUNNER_CONFIG_FILE" \
        --work-dir "$RUNNER_WORK_DIR" &
      child=$!
      wait "$child" 2>/dev/null || true
      child=""
      kill -0 "$SERVER_PID" 2>/dev/null || exit 0
      echo "hosted-server: the local runner stopped — restarting it in 2s" >&2
      sleep 2
    done
  ) &
  RUNNER_PID=$!
fi

# The server is the process this script IS: when it exits, so does everything.
status=0
wait "$SERVER_PID" || status=$?
stop_all
exit "$status"
