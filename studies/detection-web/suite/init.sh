#!/bin/sh
# Reset the subject app to its exact seeded state before each case.
set -e
curl -fsS -X POST "$BASE_URL/__reset" -o /dev/null
