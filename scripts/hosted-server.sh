#!/usr/bin/env bash
# Local boot for the hosted control plane (src/platform/control-plane + the
# static console in src/platform/web). One command, no prerequisites beyond
# `npm install`: no database service, no container, no cloud.
#
#   scripts/hosted-server.sh            # API + console on http://127.0.0.1:4177
#   scripts/hosted-server.sh migrate    # apply SQL migrations and exit
#   npm run hosted                      # the same thing through npm
#
# What it does for you, in order:
#   1. checks Node is new enough for node:sqlite,
#   2. installs missing dependencies and emits browser JavaScript,
#   3. loads the repo-root .env (gitignored) without letting it clobber anything
#      you set on the command line,
#   4. keeps one durable data root and one local KMS key,
#   5. takes port 4177 back from a Playtest server left running by an earlier
#      session (and refuses to touch anything that is not one),
#   6. prints what is switched on — including whether the model gateway is
#      configured, which is the difference between "Help me draft" working and
#      answering 503 not_configured.
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
# The control plane's metadata store is node:sqlite, which landed in 22.5. A
# server that boots and then dies on its first query is a worse failure than
# refusing here with the version you have.
node_ver="$(node --version 2>/dev/null || echo none)"
if [ "$node_ver" = none ]; then
  echo "hosted-server: Node is not on PATH. Install Node 22.5 or newer." >&2
  exit 2
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);
  if (a<22 || (a===22 && b<5)) { console.error(`hosted-server: the control plane needs Node >= 22.5 for node:sqlite; this is ${process.version}.`); process.exit(2); }'

# ---- 2. dependencies -------------------------------------------------------
if [ ! -d "$REPO/node_modules" ] || [ ! -e "$REPO/node_modules/@jeremyvun/playtest-control-plane" ]; then
  echo "hosted-server: installing dependencies (first run only)…" >&2
  (cd "$REPO" && npm install)
fi

# Browser code is authored in TypeScript. Build on every entry so the console
# bundle and viewer modules can never be stale relative to their sources.
(cd "$REPO" && npm run build:web)

# ---- 3. .env ---------------------------------------------------------------
# Sourced, not hand-parsed, so quoted and multi-line values (a GitHub App private
# key) survive intact. Anything already exported by the caller is re-applied
# afterwards, so an inline override on the command line still beats the file.
if [ -f "$ENV_FILE" ]; then
  pre_set="$(export -p | grep -E '^(declare -x|export) (PLAYTEST_|PORT=|HOST=|PUBLIC_URL=|LOG_LEVEL=|OBJECT_STORE_|GITHUB_)' || true)"
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

export PLAYTEST_DATA_DIR="$DATA_DIR"
export PLAYTEST_AUTH="${PLAYTEST_AUTH:-dev}"
export PORT="${PORT:-4177}"
export HOST="${HOST:-127.0.0.1}"

# Launches execute on this machine: the server spawns the real runner-agent
# instead of dispatching a GitHub workflow that a local checkout has no
# credentials for, so "▶ Run" in the console does something. The control plane
# refuses this outside dev auth, so only default it there.
if [ "$PLAYTEST_AUTH" = "dev" ]; then
  export PLAYTEST_DISPATCH="${PLAYTEST_DISPATCH:-local}"
fi

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
    echo "  launches          ${PLAYTEST_DISPATCH:-github dispatch}"
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

cd "$REPO/src/platform/control-plane"
if [ "$cmd" = "serve" ]; then
  exec node src/index.ts
fi
exec node src/index.ts "$@"
