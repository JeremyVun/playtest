#!/usr/bin/env bash
# Direct developer entrypoint; configure DATABASE_URL and storage explicitly.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node packages/platform/control-plane/src/index.ts "$@"
